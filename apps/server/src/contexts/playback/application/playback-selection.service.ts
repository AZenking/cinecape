import { eq } from 'drizzle-orm';
import { createDomainError, DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import { ProblemCode } from '@hmp/shared';
import { getDb } from '@contexts/identity-access';
import { playbackTicket } from '@platform/database/schema';
import type { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import type { PlaybackDto, PlaybackProbeFacts } from '@contexts/playback/application/playback-resolver.service';
import type { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import {
  terminalGuardCode,
  type PlaybackDelivery,
  type PlaybackErr,
  type PlaybackSessionView,
} from '@contexts/playback/domain/playback.types';

/**
 * 播放选择/定位服务(T029,spec 004)—— selection/seek 的版本 CAS、单槽串行 generation 替换
 * 与时间轴元数据。
 *
 * 权威依据(先读后写):
 * - tasks.md T029:selection/seek 版本 CAS 与单槽串行 generation 替换,保留 session/逻辑位置;
 *   ready/playing/paused→preparing,保留 desiredPaused、旧票失效,ready 后 renew 取票;
 *   纯字幕只增 version,返回 duration/timelineOffset/presentationStart,处理关键帧前区间,
 *   直播 seek 400、旧代 409,不瞬时双占额度;
 * - data-model.md「## playback_session」:seek/需重建输出的换轨同时递增 generation 与 version
 *   (仓储 beginRebuild 短事务,单一权威);纯字幕切换只递增 version(applySubtitleSwitch);
 *   desired_paused 保留(seek 保持暂停意图);preparing 拒绝第二次 seek/selection 为 409
 *   PLAYBACK_NOT_READY;「## playback_ticket」:换代后旧 generation 无论 TTL 不可用 ——
 *   根修为票校验的实时 generation 绑定(T037 裁决 ③:ticket.validateStreamTicket 以
 *   票代 === 会话当前代拒绝旧代票,api.md seek 行「旧票立即失效」);本服务叠加卫生层:
 *   换代提交成功后撤销该会话全部未撤销票行(经 getDb() 枚举 + 仓储既有单票 revokeTicket,
 *   lifecycle/authorization 同款「不扩仓储 API 面」先例),保持票行生命周期一致性;
 *   撤销失败不阻断换代响应(票代绑定已独立兜底)。
 * - contracts/api.md selection/seek 行为:「时间轴及请求预算」节(timelineOffsetSeconds/presentationStartSeconds
 *   语义:转换清单本地时间+偏移=影片时间,presentationStart 指定需跳过的目标前区间)与稳定错误节
 *   (409 PLAYBACK_NOT_READY/VERSION_CONFLICT/GENERATION_STALE、400 SELECTION_INVALID/
 *   SEEK_UNSUPPORTED);seek/selection 最终提交前重验授权(revalidate);
 * - research.md R8:保留完整影片 duration 与逻辑 position;滚动 HLS 只代表当前生产窗口;
 *   从目标位置之前的关键帧开始时返回 offset 与前置区间;进度控件由应用时间轴驱动;
 * - research.md R4/R6:选轨只接受服务器返回 ID;直播 duration=null 禁止 seek。
 *
 * 与装配层(T031)的边界:
 * - probe 事实(时长/轨道词表)经 PlaybackTrackFactsPort 注入:resolver 的同代事实缓存属其
 *   私有状态,本服务不重复缓存,只按 (sessionId, generation) 读取 —— 换代后旧事实自然失效;
 * - 字幕可选词表(内嵌 + 合法旁车)经 PlaybackSubtitleCatalogPort 注入(T030 字幕服务实现),
 *   纯 probe 词表无法表达旁车字幕的「可选」事实;
 * - 换代额度协同经 PlaybackRebuildCoordinator 注入:ConversionSupervisorService.cancel 以
 *   conversionId 为键且 (session,generation)→conversionId 映射属装配层,故本服务以
 *   (sessionId, 被替代 generation) 表达「取消旧代转换」意图,T031 桥接到 supervisor.cancel ——
 *   端口缺失时额度不双占仍由仓储 BEGIN IMMEDIATE 内全局活跃行计数兜底(新预留将得到
 *   PLAYBACK_CONVERSION_BUSY 而非双占),因此该端口为可选但强烈建议装配。
 *
 * 服务内校验顺序(先授权 → 状态门 → 请求/领域校验 → 提交前重验 → 单短事务提交):
 * 1. authorizeControl(归属/绑定档案/策略/家庭资源)—— 非本设备统一 404;
 * 2. 状态门:preparing → 409 NOT_READY(单槽串行:换代窗口内不接收第二个换代,先于 CAS,
 *    使该语义与客户端版本新鲜度无关);终态 → 409 ENDED/NOT_READY(terminalGuardCode 集中映射);
 * 3. 请求校验:position 非有限/负数 → 400 VALIDATION_FAILED(契约 e2e 同判);
 *    直播(duration=null 或 delivery=hls_proxy,注释见 assertSeekable)→ 400 SEEK_UNSUPPORTED;
 *    position>已探测 duration → 400 SEEK_UNSUPPORTED(data-model:position<=已探测 duration);
 *    轨道不属于已探测事实/字幕可选词表 → 400 SELECTION_INVALID(事实缺失时 fail-closed);
 * 4. revalidate(提交前重验,防异步授权窗口变更);
 * 5. 仓储短事务提交:CAS(version 必填 + generation 以读取时值强化)失败 409 且零写入。
 */

/* ------------------------------------------------------------------ */
/* 注入端口                                                              */
/* ------------------------------------------------------------------ */

/**
 * 可信 probe 事实端口:按 (sessionId, generation) 读取当前代事实(时长权威 + 轨道词表)。
 * 换代后新代事实由新代准备流程建立,旧代事实对本服务不可见(同代事实不可变 —— 同 session
 * 跨代源不变,时长/轨道词表在代内稳定)。
 */
export interface PlaybackTrackFactsPort {
  factsFor(sessionId: string, generation: number): PlaybackProbeFacts | undefined;
}

/**
 * 字幕可选词表端口(内嵌 + 合法旁车):T030 字幕服务实现;缺省时仅内嵌 probe 词表可选。
 * 返回词表(非对象列表):selection 只需「可选性」判定,描述符列表属字幕资产端点(T030)。
 */
export interface PlaybackSubtitleCatalogPort {
  subtitleTrackIds(sessionId: string, generation: number): Promise<readonly string[]> | readonly string[];
}

/**
 * 换代额度协同端口(单槽串行的「不瞬时双占」面):换代提交成功后、新代准备开始前,取消被
 * 替代代次的在途转换任务(supervisor.cancel → SIGTERM 5s 宽限 → SIGKILL,确认退出后额度
 * 才释放 —— R4/R5)。实现方抛错不阻断换代响应(额度兜底见文件头)。
 */
export interface PlaybackRebuildCoordinator {
  cancelSupersededGeneration(sessionId: string, supersededGeneration: number): void | Promise<void>;
}

/**
 * 换代重回准备端口(缺口2):换代提交(且旧代取消已发出)后触发 resolver.prepareRebuild ——
 * 同源事实复用 + 交付决策位置无关,direct/hls_proxy 直接重回 ready,转换族经
 * 「启动转换→首产物→ready」管线(seek 15 秒预算)。实现方 fire-and-forget,不得抛出。
 */
export interface PlaybackRepreparePort {
  prepareRebuild(householdId: string, sessionId: string, generation: number): void;
}

/* ------------------------------------------------------------------ */
/* 时间轴纯函数(R8 关键帧前区间;确定性,无时钟/随机)                       */
/* ------------------------------------------------------------------ */

/** 时间轴元数据(PlaybackDto 的 duration/offset/presentationStart 三元组) */
export interface PlaybackTimelineMetadata {
  /** 原影片逻辑时长;直播为 null(契约),事实缺失时亦为 null */
  readonly durationSeconds: number | null;
  /** 清单本地时间 + 该偏移 = 影片逻辑时间(R8) */
  readonly timelineOffsetSeconds: number;
  /** 需跳过的目标前区间(清单本地时间 [0, presentationStart) 不展示) */
  readonly presentationStartSeconds: number;
}

/**
 * seek/重建换代的时间轴计算:
 * - direct 交付:字节流自目标位置起交付,清单本地时间即影片时间 → offset=目标位置、
 *   presentationStart=0(无前置区间);
 * - HLS 族(remux/audio_transcode/video_transcode/hls_proxy):转换自目标位置之前的关键帧
 *   起播(HLS 分片以关键帧对齐)。probe 事实不含关键帧索引,按滚动窗口分片时长
 *   (budgets.timeline.targetSegmentSeconds,分片边界即关键帧栅格)做确定性对齐估计:
 *   offset = floor(position/K)*K,presentationStart = position - offset ∈ [0,K);
 *   测试断言区间不变量(offset≤position<offset+K)而非猜测具体栅格值 —— 关键帧索引一旦
 *   进入 probe 事实,仅需替换本函数对齐来源,调用方语义不变;
 * - duration 原样透传(null=直播):本函数不做直播判定(直播 seek 在 assertSeekable 已拒),
 *   对 hls 族保持同一对齐规则、无 null 特例,保证纯函数语义单一。
 */
export function computeSeekTimeline(input: {
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly delivery: PlaybackDelivery | null;
  readonly keyframeIntervalSeconds: number;
}): PlaybackTimelineMetadata {
  const duration =
    input.durationSeconds !== null && Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0
      ? input.durationSeconds
      : null;
  const position = Number.isFinite(input.positionSeconds) ? Math.max(0, input.positionSeconds) : 0;
  if (input.delivery === 'direct') {
    return { durationSeconds: duration, timelineOffsetSeconds: position, presentationStartSeconds: 0 };
  }
  const interval = Number.isFinite(input.keyframeIntervalSeconds) && input.keyframeIntervalSeconds > 0
    ? input.keyframeIntervalSeconds
    : 1;
  const aligned = Math.floor(position / interval) * interval;
  return { durationSeconds: duration, timelineOffsetSeconds: aligned, presentationStartSeconds: position - aligned };
}

/* ------------------------------------------------------------------ */
/* 输入/输出形状                                                          */
/* ------------------------------------------------------------------ */

/** POST seek 请求体(contracts/api.md seek 行:{expectedVersion,positionSeconds}) */
export interface SeekInput {
  readonly expectedVersion: number;
  readonly positionSeconds: number;
  /** 提交时刻(UTC ISO-8601;缺省 now。测试注入确定时钟) */
  readonly at?: string;
}

/** PUT selection 请求体({expectedVersion,positionSeconds,audioTrackId,subtitleTrackId:null|id}) */
export interface SelectTracksInput {
  readonly expectedVersion: number;
  /** 当前逻辑位置(非授权遥测);缺省不动 */
  readonly positionSeconds?: number;
  /** 缺省 = 保持当前音轨 */
  readonly audioTrackId?: string;
  /** 缺省 = 保持当前字幕;null = 关闭字幕(合法,api.md selection 行) */
  readonly subtitleTrackId?: string | null;
  readonly at?: string;
}

/** 换代/选择结果:更新后的会话视图 + PlaybackDto 形态(T031 控制器直接渲染) */
export interface SelectionOutcome {
  readonly session: PlaybackSessionView;
  readonly dto: PlaybackDto;
}

export interface PlaybackSelectionServiceDeps {
  readonly repository: PlaybackRepository;
  readonly authorization: PlaybackAuthorizationService;
  readonly facts: PlaybackTrackFactsPort;
  readonly subtitleCatalog?: PlaybackSubtitleCatalogPort;
  readonly rebuildCoordinator?: PlaybackRebuildCoordinator;
  /** 换代重回准备(resolver.prepareRebuild;缺位 = 无重回路径,会话停留 preparing) */
  readonly reprepare?: PlaybackRepreparePort;
  readonly budgets: PlaybackBudgets;
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                              */
/* ------------------------------------------------------------------ */

/** 仓储领域失败 → 稳定 DomainError(DOMAIN_PROBLEM_REGISTRY 集中携带 status) */
function playbackErrToDomainError(result: PlaybackErr): DomainError {
  return createDomainError(result.code, result.detail);
}

export class PlaybackSelectionService {
  constructor(private readonly deps: PlaybackSelectionServiceDeps) {}

  /* ---------------------------------------------------------------- */
  /* seek:单槽串行 generation 替换                                       */
  /* ---------------------------------------------------------------- */

  /**
   * 定位(POST /playback/sessions/{id}/seek 语义):CAS 校验 → 直播/越界拒绝 → 提交前重验 →
   * 仓储短事务换代(generation+1 version+1、preparing、desiredPaused 保留、position 落目标)
   * → 取消被替代代次的在途转换(不瞬时双占)→ 返回更新后 DTO 视图(含时间轴元数据,无票 ——
   * preparing 不签票,ready 后客户端以新代 renew 取票,旧票因 generation CAS 失效)。
   */
  async seek(sessionId: string, input: SeekInput, context: SessionContext): Promise<SelectionOutcome> {
    const session = await this.authorizedActiveSession(context, sessionId, input.expectedVersion);
    this.validatePositionInput(input.positionSeconds);
    // 时长权威 = 当前代已探测事实;缺失即无法验证 position<=duration,fail-closed 拒绝
    const facts = this.requireFactsForSeek(sessionId, session);
    this.assertSeekable(session, facts, input.positionSeconds);
    // 提交前重验(api.md:seek 最终提交前重验授权,防异步授权窗口变更)
    await this.revalidate(context, session);
    const rebuilt = this.deps.repository.beginRebuild(sessionId, {
      cas: { expectedVersion: input.expectedVersion, expectedGeneration: session.generation },
      positionSeconds: input.positionSeconds,
      at: input.at,
    });
    if (!rebuilt.ok) {
      throw playbackErrToDomainError(rebuilt);
    }
    // 换代卫生层(T037 裁决 ③(a)):提交成功即撤销会话全部未撤销票(api.md「旧票立即失效」;
    // 根修在票校验的实时 generation 绑定,本撤销保持票行生命周期一致性)
    this.revokeSessionTickets(rebuilt.value.householdId, sessionId);
    // 单槽串行:旧代转换任务在新代准备开始前取消;cancel 意图发出后才返回(T031 以此保证
    // 「取消先于新 reserve」的顺序,避免瞬时双占全局转换额度)
    await this.cancelSuperseded(sessionId, session.generation);
    // 缺口2:换代提交后触发重回准备(resolver.prepareRebuild;fire-and-forget,
    // 不阻塞响应 —— 客户端按契约轮询 GET 至 ready)
    this.triggerReprepare(rebuilt.value);
    const timeline = computeSeekTimeline({
      positionSeconds: input.positionSeconds,
      durationSeconds: facts.durationSeconds,
      delivery: session.delivery,
      keyframeIntervalSeconds: this.deps.budgets.timeline.targetSegmentSeconds,
    });
    return { session: rebuilt.value, dto: this.buildDto(rebuilt.value, facts, timeline) };
  }

  /* ---------------------------------------------------------------- */
  /* selectTracks:纯字幕 version 通道 / 音轨换代通道                      */
  /* ---------------------------------------------------------------- */

  /**
   * 换轨(PUT selection 语义):授权后原子换轨/字幕 ——
   * - 音轨变化(需重建输出)→ 同 seek 的换代路径(generation+1 version+1、preparing、
   *   desiredPaused 保留、无票);同一请求内的 subtitleTrackId 一并落库(单次 CAS,不拆两次);
   * - 仅字幕变化(含 null 关闭)→ 仓储 applySubtitleSwitch:仅 version+1,状态/generation/
   *   started_at 全不变(不重启视频);请求携带 positionSeconds 时先经 heartbeat 写入
   *   (非授权遥测、不递增 version),字幕短事务自身的 version CAS 保持选择原子性 ——
   *   仓储无「字幕+位置」复合入口且本任务禁止扩仓储 API,拆分仅影响遥测写点;
   * - 无有效变更(音轨等于当前且字幕未变)→ 幂等 no-op:返回现状态,不递增任何版本
   *   (避免无意义 CAS 推进打断客户端并发)。
   */
  async selectTracks(sessionId: string, input: SelectTracksInput, context: SessionContext): Promise<SelectionOutcome> {
    const session = await this.authorizedActiveSession(context, sessionId, input.expectedVersion);
    if (input.positionSeconds !== undefined) {
      this.validatePositionInput(input.positionSeconds);
    }
    // 轨道可选性以当前代已探测事实为唯一权威;事实缺失即 fail-closed(无可选词表)
    const facts = this.requireFactsForSelection(sessionId, session);

    const audioChanged = input.audioTrackId !== undefined && input.audioTrackId !== session.audioTrackId;
    const subtitleProvided = input.subtitleTrackId !== undefined;
    const subtitleChanged = subtitleProvided && input.subtitleTrackId !== session.subtitleTrackId;
    if (audioChanged) {
      this.assertAudioTrackKnown(facts, input.audioTrackId as string);
    }
    if (subtitleChanged && input.subtitleTrackId !== null) {
      await this.assertSubtitleTrackKnown(sessionId, session.generation, facts, input.subtitleTrackId as string);
    }

    if (!audioChanged && !subtitleChanged) {
      const timeline: PlaybackTimelineMetadata = {
        durationSeconds: facts.durationSeconds,
        timelineOffsetSeconds: 0,
        presentationStartSeconds: 0,
      };
      return { session, dto: this.buildDto(session, facts, timeline) };
    }

    await this.revalidate(context, session);

    if (audioChanged) {
      const rebuilt = this.deps.repository.beginRebuild(sessionId, {
        cas: { expectedVersion: input.expectedVersion, expectedGeneration: session.generation },
        ...(input.positionSeconds !== undefined ? { positionSeconds: input.positionSeconds } : {}),
        audioTrackId: input.audioTrackId as string,
        // 「null=关闭字幕」与音轨重建同请求时必须一并落库(单次换代,CAS 一次推进)。
        // BeginRebuildInput.subtitleTrackId 声明为 string,但仓储 patch 运行时语义接受
        // null(列可空,undefined=保持)—— 此处窄化传 null,不新增仓储写入口。
        subtitleTrackId:
          input.subtitleTrackId === null ? (null as unknown as string) : (input.subtitleTrackId as string),
        at: input.at,
      });
      if (!rebuilt.ok) {
        throw playbackErrToDomainError(rebuilt);
      }
      // 换代卫生层(同 seek:api.md「旧票立即失效」;根修在票校验实时 generation 绑定)
      this.revokeSessionTickets(rebuilt.value.householdId, sessionId);
      await this.cancelSuperseded(sessionId, session.generation);
      // 缺口2:音轨换代同样触发重回准备(与 seek 同管线)
      this.triggerReprepare(rebuilt.value);
      const timeline = computeSeekTimeline({
        positionSeconds: input.positionSeconds ?? session.positionSeconds,
        durationSeconds: facts.durationSeconds,
        delivery: session.delivery,
        keyframeIntervalSeconds: this.deps.budgets.timeline.targetSegmentSeconds,
      });
      return { session: rebuilt.value, dto: this.buildDto(rebuilt.value, facts, timeline) };
    }

    // 纯字幕通道:位置(若携带)先行落库(heartbeat 不递增 version),随后字幕短事务 CAS version+1
    if (input.positionSeconds !== undefined) {
      const beat = this.deps.repository.heartbeat(sessionId, {
        cas: { expectedVersion: input.expectedVersion },
        positionSeconds: input.positionSeconds,
        at: input.at,
      });
      if (!beat.ok) {
        throw playbackErrToDomainError(beat);
      }
    }
    const switched = this.deps.repository.applySubtitleSwitch(sessionId, {
      cas: { expectedVersion: input.expectedVersion },
      subtitleTrackId: input.subtitleTrackId as string,
      at: input.at,
    });
    if (!switched.ok) {
      throw playbackErrToDomainError(switched);
    }
    // 纯字幕不重建清单:无新时间轴语义(0/0 与 GET 基线一致),客户端沿用换代响应的映射
    const timeline: PlaybackTimelineMetadata = {
      durationSeconds: facts.durationSeconds,
      timelineOffsetSeconds: 0,
      presentationStartSeconds: 0,
    };
    return { session: switched.value, dto: this.buildDto(switched.value, facts, timeline) };
  }

  /* ---------------------------------------------------------------- */
  /* 内部管线(顺序固定,勿调换)                                           */
  /* ---------------------------------------------------------------- */

  /** 授权 + 会话装载 + 预检(与仓储短事务同序:终态 → CAS → preparing,先于领域校验) */
  private async authorizedActiveSession(
    context: SessionContext,
    sessionId: string,
    expectedVersion: number,
  ): Promise<PlaybackSessionView> {
    await this.deps.authorization.authorizeControl(context, sessionId);
    const loaded = this.deps.repository.getSession(context.session.householdId, sessionId);
    if (!loaded.ok) {
      // authorizeControl 已做归属校验;此处为防御性同形(不泄漏存在性)
      throw playbackErrToDomainError(loaded);
    }
    this.preFlightGuard(loaded.value, expectedVersion);
    return loaded.value;
  }

  /**
   * 预检(与仓储 transitionSession 判定顺序逐一对应:终态守卫 → version CAS → preparing 拒绝;
   * 提交短事务将原子复核全部三道闸,读/提交间隙的并发推进由提交侧 CAS 收口)。
   * 顺序即契约语义:CAS 过期先于 preparing(409 VERSION_CONFLICT 优先,旧请求不可覆盖新代),
   * preparing 先于领域校验(换代窗口内不接收第二个 seek/selection —— data-model:preparing
   * 拒绝第二次 seek/selection 为 409 PLAYBACK_NOT_READY;单槽串行)。
   */
  private preFlightGuard(session: PlaybackSessionView, expectedVersion: number): void {
    const terminal = terminalGuardCode(session.state);
    if (terminal !== null) {
      throw createDomainError(terminal);
    }
    if (expectedVersion !== session.version) {
      throw createDomainError('PLAYBACK_VERSION_CONFLICT', `version 已推进为 ${session.version},请基于最新状态重试`);
    }
    if (session.state === 'preparing') {
      throw createDomainError('PLAYBACK_NOT_READY', '会话正在准备(换代进行中),请等待新代就绪');
    }
  }

  /** 提交前重验(api.md:renew/seek/selection 最终提交前重验授权) */
  private async revalidate(context: SessionContext, session: PlaybackSessionView): Promise<void> {
    await this.deps.authorization.revalidate(session.deviceSessionId, session.profileId, session.mediaId);
  }

  /** seek 的时长权威:事实缺失 → SEEK_UNSUPPORTED(fail-closed,无法验证 position<=duration) */
  private requireFactsForSeek(sessionId: string, session: PlaybackSessionView): PlaybackProbeFacts {
    const facts = this.deps.facts.factsFor(sessionId, session.generation);
    if (facts === undefined) {
      throw createDomainError('PLAYBACK_SEEK_UNSUPPORTED', '探测事实不可用,无法建立时长权威');
    }
    return facts;
  }

  /** selection 的可选词表权威:事实缺失 → SELECTION_INVALID(fail-closed,无可验证词表) */
  private requireFactsForSelection(sessionId: string, session: PlaybackSessionView): PlaybackProbeFacts {
    const facts = this.deps.facts.factsFor(sessionId, session.generation);
    if (facts === undefined) {
      throw createDomainError('PLAYBACK_SELECTION_INVALID', '轨道事实不可用,无法验证轨道选择');
    }
    return facts;
  }

  /**
   * 直播判定(两个独立分支,任一命中即拒):
   * - delivery === 'hls_proxy':LAN IPTV/上游 HLS 直播代理(R3)本身就是直播语义,不存在
   *   「影片逻辑时间轴」,定位无意义;
   * - 已探测 duration === null:契约口径「直播 duration=null 且不提供影片 seek」(api.md
   *   时间轴节)—— probe 事实层与交付层二选一即可表达直播,双分支兜底防事实缺失口径漂移。
   */
  private assertSeekable(
    session: PlaybackSessionView,
    facts: PlaybackProbeFacts,
    positionSeconds: number,
  ): void {
    const duration = facts.durationSeconds;
    if (session.delivery === 'hls_proxy' || duration === null || !Number.isFinite(duration)) {
      throw createDomainError('PLAYBACK_SEEK_UNSUPPORTED', '直播内容不提供影片定位');
    }
    if (positionSeconds > duration) {
      // data-model「验证与恢复」:position<=已探测 duration
      throw createDomainError('PLAYBACK_SEEK_UNSUPPORTED', '目标位置超出影片时长');
    }
  }

  /** 选轨只接受服务器返回 ID(R4/R6):音轨必须属于已探测音轨词表 */
  private assertAudioTrackKnown(facts: PlaybackProbeFacts, audioTrackId: string): void {
    if (!facts.audioTracks.some((track) => track.id === audioTrackId)) {
      throw createDomainError('PLAYBACK_SELECTION_INVALID', '音轨不属于已探测轨道');
    }
  }

  /** 字幕属于「已探测内嵌 ∪ 字幕目录端口(含合法旁车)」;两者皆否 → SELECTION_INVALID */
  private async assertSubtitleTrackKnown(
    sessionId: string,
    generation: number,
    facts: PlaybackProbeFacts,
    subtitleTrackId: string,
  ): Promise<void> {
    if (facts.subtitleTracks.some((track) => track.id === subtitleTrackId)) {
      return;
    }
    const catalog = this.deps.subtitleCatalog;
    if (catalog !== undefined) {
      const ids = await catalog.subtitleTrackIds(sessionId, generation);
      if (Array.from(ids).includes(subtitleTrackId)) {
        return;
      }
    }
    throw createDomainError('PLAYBACK_SELECTION_INVALID', '字幕轨不属于可选字幕(内嵌与合法旁车)');
  }

  /** 请求校验:position 非有限/负数 → 400 VALIDATION_FAILED(契约 e2e 同判) */
  private validatePositionInput(positionSeconds: number): void {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '播放位置必须为有限非负数');
    }
  }

  /** 换代协同:取消被替代代次的在途转换;投递失败不阻断换代(额度由仓储全局计数兜底) */
  private async cancelSuperseded(sessionId: string, supersededGeneration: number): Promise<void> {
    const coordinator = this.deps.rebuildCoordinator;
    if (coordinator === undefined) {
      return;
    }
    try {
      await coordinator.cancelSupersededGeneration(sessionId, supersededGeneration);
    } catch {
      // 协同桥接异常不回滚已提交的换代(CAS 已落库):不瞬时双占仍由 reserve 的
      // BEGIN IMMEDIATE 全局活跃行计数保证 —— 新代准备至多得到 PLAYBACK_CONVERSION_BUSY
    }
  }

  /**
   * 触发重回准备(缺口2):端口违约(抛错)不阻断换代响应 —— 会话停留 preparing 时由
   * 生命周期失联/超时兜底;fire-and-forget 语义由实现方(resolver)保证。
   */
  private triggerReprepare(rebuilt: PlaybackSessionView): void {
    const reprepare = this.deps.reprepare;
    if (reprepare === undefined) {
      return;
    }
    try {
      reprepare.prepareRebuild(rebuilt.householdId, rebuilt.id, rebuilt.generation);
    } catch {
      // 端口违约防御:换代响应已可返回,准备管线异常不外溢
    }
  }

  /**
   * 换代票撤销卫生层(T037 裁决 ③(a)):撤销该会话全部未撤销票行,保持「换代后旧票失效」
   * 的票行生命周期一致性(api.md seek 行「旧票立即失效」)。仓储无「按会话撤销」原子入口
   * 且其 API 面被 repository.spec 钉死(T011),故按 authorization/lifecycle 同款先例经
   * getDb() 只读枚举票行 + 组合仓储既有单票 revokeTicket 完成,不新增仓储方法。
   * 撤销失败不阻断换代响应:E3 的根修是票校验的实时 generation 绑定
   * (ticket.validateStreamTicket,票代 === 会话当前代),本层为一致性卫生层。
   */
  private revokeSessionTickets(householdId: string, sessionId: string): void {
    try {
      const rows = getDb()
        .select({ id: playbackTicket.id, revokedAt: playbackTicket.revokedAt })
        .from(playbackTicket)
        .where(eq(playbackTicket.sessionId, sessionId))
        .all();
      for (const row of rows) {
        if (row.revokedAt !== null) {
          continue; // 已撤销幂等跳过(revokeTicket 自身亦幂等,此处省去短事务开销)
        }
        this.deps.repository.revokeTicket(householdId, row.id);
      }
    } catch {
      // 卫生层尽力而为:换代已提交(CAS 已落库),票代绑定校验独立兜底旧票拒绝
    }
  }

  /**
   * PlaybackDto 装配(contracts/api.md 公共数据类型;不含源 ID/位置,无票字段 ——
   * GET 不重签也不复现旧票,renew 的 TicketReply 由票据服务携带)。换代响应携带同源
   * 稳定事实(duration/轨道词表:同 session 跨代源不变,音轨/字幕必属同一输入)与本次
   * 操作的时间轴语义,供客户端立即重建进度条与轨道菜单;tracks 的「新代重探测」刷新
   * 由新代准备完成后经 GET/服务端事实缓存呈现。
   */
  private buildDto(
    session: PlaybackSessionView,
    facts: PlaybackProbeFacts | undefined,
    timeline: PlaybackTimelineMetadata,
  ): PlaybackDto {
    return {
      id: session.id,
      state: session.state,
      version: session.version,
      generation: session.generation,
      desiredPaused: session.desiredPaused,
      delivery: session.delivery,
      positionSeconds: session.positionSeconds,
      durationSeconds: timeline.durationSeconds,
      timelineOffsetSeconds: timeline.timelineOffsetSeconds,
      presentationStartSeconds: timeline.presentationStartSeconds,
      ticketExpiresAt: null,
      playbackUrl: null,
      tracks: {
        audio: facts ? [...facts.audioTracks] : [],
        subtitles: facts ? [...facts.subtitleTracks] : [],
      },
      ...(session.failureCode !== null ? { failureCode: session.failureCode } : {}),
    };
  }
}
