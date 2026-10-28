import { eq } from 'drizzle-orm';
import { createDomainError, type DomainError } from '@platform/http-common/domain-error';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { getDb } from '@contexts/identity-access';
import { deviceSession, playbackSession } from '@platform/database/schema';
import type { PlaybackAuthorizationService, PlaybackResourceCandidate } from '@contexts/playback/application/playback-authorization.service';
import type { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import type { PlaybackProgressBindPort, PlaybackResumePositionPort } from '@contexts/personal-data';
import type {
  MarkPlayingInput,
  PlaybackDelivery,
  PlaybackErr,
  PlaybackErrorCode,
  PlaybackSessionState,
  PlaybackSessionView,
  PlaybackResult,
} from '@contexts/playback/domain/playback.types';
import type { PlaybackConversionMode } from '@contexts/playback/domain/playback.types';

/**
 * 播放解析服务(T019,spec 004)—— 可用资源稳定选择与 preparing 会话:
 *
 * - 同步段(resolve):authorizeResolve(认证→当前档案/PIN→最新策略→家庭可用资源)通过后
 *   才创建 preparing session —— 授权拒绝不建 session(服务顺序保证,data-model:同步鉴权
 *   拒绝不创建 session);建档即 generation=version=1、position=0、desired_paused=0,
 *   source/delivery 为空(preparing 允许为空,CHECK 活动态必非空由 markReady 落实);
 * - 探测前不猜 delivery(data-model:不在 probe 前猜测 delivery):session.source/
 *   playback_source_id 与 delivery 保持空直到 probe 计划完成。probe 能力经 ProbePort
 *   接口注入(本文件定义接口;T023 media-probe.service 提供真实实现,单测用 fake);
 * - 异步段(prepare,fire-and-forget):resolve 不等待完整 probe(api.md:201 仅表示接受);
 *   probeFirstAvailable 收到全部候选与共享总期限(30 秒,data-model:probe 失败/不支持
 *   可尝试下一候选,共用首次 30 秒期限)——候选已按授权管线排序(成本→source_id→
 *   playback_source_id 二进制升序,无 priority 字段),端口内部逐候选尝试;
 *   成功 → 仓储迁移 preparing→ready(写入选定 source/delivery;facts 派生的 duration 与
 *   轨道占位:轨道事实由 probe 提供,本任务先落 duration 与 delivery/source,轨道 ID 结构
 *   按 data-model/契约,默认音轨/字幕选择留给 T029/T030);
 *   失败 → preparing→failed + 稳定 failure_code(format_unsupported→PLAYBACK_FORMAT_UNSUPPORTED、
 *   resource_unavailable→PLAYBACK_RESOURCE_UNAVAILABLE、timeout→PLAYBACK_PREPARE_TIMEOUT);
 *   **只更新 session,不建 failure_event** —— failure_event 仅记录同步鉴权拒绝,
 *   属审计任务 T043 语义(data-model:异步 probe/转换失败记录在已有 session);
 * - 竞态安全:prepare 全程以建档时的 (version,generation) 作 CAS 基准;若 probe 完成前
 *   会话已被 stop/seek/生命周期接管(CAS 失败),静默丢弃本次结果,不覆盖新状态;
 * - GET 状态视图 toDto:preparing 时 delivery/ticket/duration/tracks 空;结构上不含
 *   playback_source_id/location(contracts/api.md:GET 不泄漏源 ID/位置);playbackUrl/
 *   ticketExpiresAt 恒为 null —— GET 不重签也不复现旧票,票据仅经 T018 renew 的
 *   TicketReply 携带,而 ready 前无票由 T018 仓储门槛保证(衔接:T019 preparing 会话
 *   在 issueOrRenew 处 409 PLAYBACK_NOT_READY);
 * - 交付衔接:probe 结束 → ready;首次交付 playing 由流层(T031)调 markPlaying(本服务
 *   暴露方法委托仓储,started_at 一次设置之后不重置)。
 */

/** probe 轨道事实:音频轨(id 为服务器轨道 ID 结构,label/language 来自 probe,default 标记默认轨) */
export interface PlaybackProbeAudioTrackFact {
  readonly id: string;
  readonly label: string;
  readonly language: string | null;
  readonly default: boolean;
}

/** probe 轨道事实:字幕轨 */
export interface PlaybackProbeSubtitleTrackFact {
  readonly id: string;
  readonly label: string;
  readonly language: string | null;
}

/** 可信 probe 事实(data-model 运行时值对象「PlaybackPlan」的输入面):duration/轨道 */
export interface PlaybackProbeFacts {
  /** 原影片逻辑时长秒;直播为 null(契约:直播 duration=null 且不提供影片 seek) */
  readonly durationSeconds: number | null;
  readonly audioTracks: readonly PlaybackProbeAudioTrackFact[];
  readonly subtitleTracks: readonly PlaybackProbeSubtitleTrackFact[];
}

/** probe 失败分类(端口内全部候选尝试尽后的稳定归类) */
export type PlaybackProbeFailureKind = 'format_unsupported' | 'resource_unavailable' | 'timeout';

/** 转换族交付(需要启动 ffmpeg 产出滚动 HLS 的交付模式;direct/hls_proxy 不在此列) */
export type PlaybackConversionDelivery = Exclude<PlaybackDelivery, 'direct' | 'hls_proxy'>;

/** 转换族交付判定(缺口1:plan 为转换/remux 时进入「启动转换」阶段) */
export function isConversionDelivery(delivery: PlaybackDelivery): delivery is PlaybackConversionDelivery {
  return delivery === 'remux' || delivery === 'audio_transcode' || delivery === 'video_transcode';
}

/**
 * 交付模式 + 音频事实 → 监督者启动输入的计划面(值语义与 T024 计划输出一致):
 * mode 与 delivery 同名同值;视频编码 copy(remux/audio_transcode)或 h264(video_transcode);
 * 音频编码按「是否有音轨」取 copy/aac,静音合法视频为 'none'(监督者据其落 -an)。
 */
export function conversionPlanForDelivery(
  delivery: PlaybackConversionDelivery,
  hasAudioTrack: boolean,
): {
  readonly mode: PlaybackConversionMode;
  readonly outputVideoCodec: string;
  readonly outputAudioCodec: string;
  readonly reason: string;
} {
  switch (delivery) {
    case 'remux':
      return {
        mode: 'remux',
        outputVideoCodec: 'copy',
        outputAudioCodec: hasAudioTrack ? 'copy' : 'none',
        reason: '编码全兼容且容器不兼容,转封装保留原始音视频编码',
      };
    case 'audio_transcode':
      return {
        mode: 'audio_transcode',
        outputVideoCodec: 'copy',
        outputAudioCodec: hasAudioTrack ? 'aac' : 'none',
        reason: '视频兼容且音频编码浏览器不兼容,仅转码音频为 AAC,视频直通复制',
      };
    case 'video_transcode':
      return {
        mode: 'video_transcode',
        outputVideoCodec: 'h264',
        outputAudioCodec: hasAudioTrack ? 'aac' : 'none',
        reason: '视频编码/位深/像素格式浏览器不兼容,转换为 H.264 8bit yuv420p(保持原分辨率,不降级)',
      };
  }
}

export interface PlaybackProbeSuccess {
  readonly playbackSourceId: string;
  readonly delivery: PlaybackDelivery;
  readonly facts: PlaybackProbeFacts;
}

export interface PlaybackProbeFailure {
  readonly error: PlaybackProbeFailureKind;
}

export type PlaybackProbeOutcome = PlaybackProbeSuccess | PlaybackProbeFailure;

/**
 * 探测端口(依赖注入;T023 media-probe.service 实现真实 ffprobe 版):
 * 收到全部排序候选与共享总期限(ms),端口内部按序逐候选尝试(失败/不支持切下一候选,
 * 不重置期限);全部不可用返回 {error}。实现不得抛异常之外的方式报告失败。
 */
export interface PlaybackProbePort {
  probeFirstAvailable(
    candidates: readonly PlaybackResourceCandidate[],
    deadlineMs: number,
  ): Promise<PlaybackProbeOutcome>;
}

/* ------------------------------------------------------------------ */
/* 转码交付启动端口(缺口1/缺口2 接线;T031 装配桥接实现)                   */
/* ------------------------------------------------------------------ */

/** 转换启动请求:phase 决定硬超时映射(prepare→PREPARE_TIMEOUT / seek→SEEK_TIMEOUT) */
export interface PlaybackConversionLaunchRequest {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly delivery: PlaybackConversionDelivery;
  /** 会话选定源(resolver 视图不携带;markReady 与源定位都必需) */
  readonly playbackSourceId: string;
  readonly phase: 'prepare' | 'seek';
  /** 相对期限(毫秒;deadlineAtMs 由实现按注入时钟换算绝对值) */
  readonly deadlineMs: number;
  /** 计划面(conversionPlanForDelivery 输出;监督者 reserve/spawn 参数权威) */
  readonly plan: {
    readonly mode: PlaybackConversionMode;
    readonly outputVideoCodec: string;
    readonly outputAudioCodec: string;
    readonly reason: string;
  };
}

/**
 * 转换启动端口(装配层 PlaybackConversionBridge 适配实现):reserve(满→BUSY)→ 真实
 * ffmpeg 启动(产物写 ConversionStorageService 任务目录)→ 等待首产物事实(首输出事件/
 * 产物目录事实)→ ok;失败(启动即败/看门狗裁决/任务行终态)→ 稳定 err。实现不得抛出
 * 领域失败之外的异常;资产登记(本地产物窗口)由实现内完成。
 */
export interface PlaybackConversionLaunchPort {
  startAndWaitFirstOutput(
    request: PlaybackConversionLaunchRequest,
  ): Promise<PlaybackResult<{ readonly conversionId: string }>>;
}

/** 会话源引用端口(换代重建读取「同源」事实;playback_session→playback_source 只读投影) */
export interface PlaybackSessionSourcePort {
  locateSessionSource(sessionId: string): Promise<{ readonly playbackSourceId: string; readonly location: string } | null>;
}

/** resolver 可选装配端口(缺位时转换族 fail-closed 于 RESOURCE_UNAVAILABLE,绝不假 ready) */
export interface PlaybackResolverPorts {
  readonly conversionLaunch?: PlaybackConversionLaunchPort;
  readonly sessionSource?: PlaybackSessionSourcePort;
  /**
   * 点播 resolve 的进度绑定端口(T099,005 US4):点播 resolve 接受时在短事务分配
   * epoch 并创建 playback_progress_state(不写可见历史);直播不调用。缺位(单测
   * 装配)时跳过绑定,不影响既有解析链路。
   */
  readonly progressBind?: PlaybackProgressBindPort;
  /**
   * 续播冻结读取端口(T101):resume 在可信 probe 完成后、任何转换输出启动或 direct
   * 输出安装之前,由服务端重读当前 Profile 历史冻结 presentationStartSeconds;
   * 缺位时恒为 0(从头)。
   */
  readonly resumePosition?: PlaybackResumePositionPort;
}

/** probe 失败分类 → 稳定失败码(映射表集中一处) */
export function probeFailureToCode(kind: PlaybackProbeFailureKind): PlaybackErrorCode {
  switch (kind) {
    case 'format_unsupported':
      return 'PLAYBACK_FORMAT_UNSUPPORTED';
    case 'resource_unavailable':
      return 'PLAYBACK_RESOURCE_UNAVAILABLE';
    case 'timeout':
      return 'PLAYBACK_PREPARE_TIMEOUT';
  }
}

/** 播放状态 DTO(contracts/api.md 公共数据类型 PlaybackDto;不含源 ID/位置) */
export interface PlaybackDto {
  readonly id: string;
  readonly state: PlaybackSessionState;
  readonly version: number;
  readonly generation: number;
  readonly desiredPaused: boolean;
  /** 探测完成前为 null */
  readonly delivery: PlaybackDelivery | null;
  readonly positionSeconds: number;
  /** null 或有限非负数;探测未完成/换代后未知为 null;直播为 null */
  readonly durationSeconds: number | null;
  readonly timelineOffsetSeconds: number;
  readonly presentationStartSeconds: number;
  /** 恒 nullable;除 renew 响应外为空(GET 不重签也不复现旧票) */
  readonly ticketExpiresAt: string | null;
  readonly playbackUrl: string | null;
  readonly tracks: {
    readonly audio: readonly PlaybackProbeAudioTrackFact[];
    readonly subtitles: readonly PlaybackProbeSubtitleTrackFact[];
  };
  /** 仅 failed 态出现(契约 failureCode?) */
  readonly failureCode?: string;
}

export interface PlaybackDtoOptions {
  /**
   * 是否面向「含票据字段」的响应装配。GET 状态恒 false:GET 不重签也不复现旧票,
   * playbackUrl/ticketExpiresAt 仍为 null;renew 的票据字段由 T018 TicketReply 携带。
   */
  readonly includeTicketFields?: boolean;
}

export interface ResolveOptions {
  /** 建档时刻(UTC ISO-8601;缺省 now。测试注入确定时钟) */
  readonly at?: string;
  /** probe 总期限覆盖(缺省 budgets.watchdog.prepareTimeoutSeconds×1000 = 30s) */
  readonly deadlineMs?: number;
  /**
   * 起播模式透传(005 api.md §5;默认 beginning):resume 仅点播,频道请求 resume
   * → 400 PLAYBACK_SEEK_UNSUPPORTED。resume 的位置冻结与进度协议属 US4 —— 本阶段只做
   * 参数校验与透传,不改变 preparing 建档路径。
   */
  readonly startMode?: 'beginning' | 'resume';
}

export interface ResolveOutcome {
  /** 刚建立的 preparing 会话视图 */
  readonly session: PlaybackSessionView;
  /** preparing 形态的 GET 状态视图(delivery/ticket/duration/tracks 全空) */
  readonly dto: PlaybackDto;
}

/** 仓储领域失败 → 稳定 DomainError(DOMAIN_PROBLEM_REGISTRY 集中携带 status) */
function playbackErrToDomainError(result: PlaybackErr): DomainError {
  return createDomainError(result.code, result.detail);
}

/** probe 成功判别(in 成 narrowing 对齐 outcome 联合) */
function isProbeSuccess(outcome: PlaybackProbeOutcome): outcome is PlaybackProbeSuccess {
  return 'playbackSourceId' in outcome;
}

export class PlaybackResolverService {
  /** 会话 probe 事实缓存(内存私有;key=sessionId,记录建档代以失效换代后的事实) */
  private readonly factsBySession = new Map<string, { generation: number; facts: PlaybackProbeFacts }>();
  /** 会话起播模式(005 §5:beginning|resume;resume 在 probe 后冻结起播位置) */
  private readonly startModeBySession = new Map<string, 'beginning' | 'resume'>();
  /** 已冻结的起播位置(按代失效;ready 提交仅重验,不改已冻结输出) */
  private readonly presentationStartBySession = new Map<string, { generation: number; seconds: number }>();

  constructor(
    private readonly repository: PlaybackRepository,
    private readonly authorization: PlaybackAuthorizationService,
    private readonly probePort: PlaybackProbePort,
    private readonly budgets: PlaybackBudgets,
    /** 可选装配端口(T031 桥接;单测装配缺位时转换族 fail-closed,见 prepareConversionDelivery) */
    private readonly ports: PlaybackResolverPorts = {},
  ) {}

  /**
   * 解析(POST /playback/resolve 语义):授权 → 建 preparing session → fire-and-forget
   * 异步准备。返回即表示请求被接受(201),不等 probe;授权拒绝抛稳定 DomainError
   * 且不建 session(MEDIA_NOT_FOUND 对不存在/跨家庭/不可见/无源同形)。
   * 005(T050):startMode 透传校验(频道 resume → 400 PLAYBACK_SEEK_UNSUPPORTED);
   * 建档捕获授权时刻 DeviceSession 的 profile_context_version(005 data-model §2,
   * 服务端事实,不接受客户端身份/位置声明);resume 位置冻结属 US4,不在本路径实现。
   */
  async resolve(context: SessionContext, mediaId: string, options: ResolveOptions = {}): Promise<ResolveOutcome> {
    // 1. 授权(同步,不等待 probe);拒绝在此抛出 —— 之后才允许建 session
    const grant = await this.authorization.authorizeResolve(context, mediaId);
    // 1.5 startMode 透传校验(005 api.md §5:resume 仅点播;频道请求 resume 稳定 400)
    if (options.startMode === 'resume' && grant.mediaType === 'channel') {
      throw createDomainError('PLAYBACK_SEEK_UNSUPPORTED', '直播频道不支持续播定位');
    }
    // 2. 建 preparing session(身份绑定取授权快照的服务端事实,非请求声明;
    //    profile_context_version 一次性捕获 —— 此后不可变,由控制链路每次重验)
    const created = this.repository.createSession({
      householdId: grant.snapshot.householdId,
      deviceSessionId: grant.snapshot.deviceSessionId,
      deviceId: grant.snapshot.deviceId,
      profileId: grant.snapshot.profileId,
      mediaId: grant.snapshot.mediaId,
      profileContextVersion: grant.snapshot.profileContextVersion,
      at: options.at,
    });
    if (!created.ok) {
      throw playbackErrToDomainError(created);
    }
    const session = created.value;
    // 2.5 进度绑定(T099,005 US4):点播 resolve 接受时在短事务分配递增 epoch 并创建
    // playback_progress_state(candidate_epoch/content_revision/profile_context_version),
    // 不写可见历史 —— 历史仅首次有效 started 后产生;直播(channel)不分配不绑定。
    if (grant.mediaType !== 'channel' && this.ports.progressBind !== undefined) {
      this.ports.progressBind.bindVodResolveCandidate({
        householdId: grant.snapshot.householdId,
        profileId: grant.snapshot.profileId,
        mediaId: grant.snapshot.mediaId,
        playbackSessionId: session.id,
        profileContextVersion: grant.snapshot.profileContextVersion,
      });
    }
    // 2.6 起播模式记录(resume 冻结在 probe 后;本会话生命周期内不再改变)
    this.startModeBySession.set(session.id, options.startMode ?? 'beginning');
    // 3. fire-and-forget 异步准备(总期限共享:单次端口调用携带全部候选与同一 30s 期限)
    const deadlineMs = options.deadlineMs ?? this.budgets.watchdog.prepareTimeoutSeconds * 1000;
    void this.prepare(grant.snapshot.householdId, grant.snapshot.profileId, session.id, session.generation, session.version, grant.candidates, deadlineMs, options.at);
    // 4. 返回 preparing 形态(delivery/源为空:不猜 delivery)
    return { session, dto: this.toDto(session) };
  }

  /**
   * 异步准备(probe → ready/failed)。fire-and-forget:任何路径不得向调用方抛出
   * (resolve 已返回);会话被接管(CAS 失败/终态)时静默丢弃结果。
   * T051:markReady 提交前复查 playback_session.profile_context_version 仍等于当前
   * DeviceSession 版本 —— probe 窗口内的换档/清空/撤销不得让旧上下文播放被推至 ready
   * (005 data-model §2「异步准备提交也复查该版本,避免 A→B→A 复活旧播放」)。
   */
  private async prepare(
    householdId: string,
    profileId: string,
    sessionId: string,
    generation: number,
    version: number,
    candidates: readonly PlaybackResourceCandidate[],
    deadlineMs: number,
    at?: string,
  ): Promise<void> {
    try {
      const outcome = await this.probePort.probeFirstAvailable(candidates, deadlineMs);
      // CAS 基准 = 建档时刻:probe 窗口内发生 stop/seek/换轨(换代)则本结果作废
      const cas = { expectedVersion: version, expectedGeneration: generation };
      if (isProbeSuccess(outcome)) {
        // resume 冻结(T101):可信 probe 完成后、任何转换输出启动或 direct 输出安装之前,
        // 服务端重读当前 Profile 最新有效历史,按资源修订与可信 duration 冻结本次
        // presentationStartSeconds(无有效位置则 0;不删除旧历史)。ready 提交仅重验
        // 身份/修订/generation,不改变已冻结输出;冻结后另一设备的后续观看不悄悄改位置。
        if ((this.startModeBySession.get(sessionId) ?? 'beginning') === 'resume' && this.ports.resumePosition !== undefined) {
          const seconds = this.ports.resumePosition.readResumeFreeze({
            householdId,
            profileId,
            mediaId: this.sessionMediaIdOf(sessionId),
            probeDurationSeconds: outcome.facts.durationSeconds,
          });
          this.presentationStartBySession.set(sessionId, { generation, seconds });
        }
        if (isConversionDelivery(outcome.delivery)) {
          // 缺口1:plan 为转换/remux → probe 完成后进入「启动转换」阶段(30 秒共享总期限
          // 顺延为转换首帧期限;首产物前保持 preparing —— ready 前无票语义不变)
          await this.prepareConversionDelivery({
            householdId,
            sessionId,
            generation,
            version,
            delivery: outcome.delivery,
            playbackSourceId: outcome.playbackSourceId,
            phase: 'prepare',
            deadlineMs,
            facts: outcome.facts,
            at,
          });
          return;
        }
        if (!this.identityContextCurrent(sessionId)) {
          // 版本复查失败 → 稳定失败落会话(不虚报就绪;终态行 CAS 失败为无害 no-op)
          this.repository.failSession(sessionId, { cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at });
          this.factsBySession.delete(sessionId);
          return;
        }
        const marked = this.repository.markReady(sessionId, {
          cas,
          playbackSourceId: outcome.playbackSourceId,
          delivery: outcome.delivery,
          at,
        });
        if (marked.ok) {
          // facts 派生的 duration 与轨道占位:轨道事实由 probe 提供;本任务先落
          // duration 与 delivery/source(轨道 ID 结构按 data-model/契约;
          // 默认音轨/字幕的会话选择写入属 T029/T030 语义,此处不猜)
          this.factsBySession.set(sessionId, { generation, facts: outcome.facts });
        }
        // marked 失败 = 会话已被生命周期/换代接管:静默丢弃,不覆盖新状态
        return;
      }
      // probe 全候选失败 → preparing→failed + 稳定 failure_code;
      // 只更新 session,不建 failure_event(异步失败记录在已有 session —— data-model;
      // failure_event 仅同步拒绝,属审计任务 T043 语义)
      this.repository.failSession(sessionId, { cas, failureCode: probeFailureToCode(outcome.error), at });
      // 失败后事实缓存不保留(无事实)
      this.factsBySession.delete(sessionId);
    } catch {
      // 防御:端口异常/仓储意外错误不得成为未处理拒绝;会话停留 preparing,
      // 由生命周期(T028)的失联/超时兜底回收
    }
  }

  /** 会话媒体 ID 只读投影(resume 冻结读取需要;行缺失回退空串,冻结为 0) */
  private sessionMediaIdOf(sessionId: string): string {
    const row = getDb()
      .select({ mediaId: playbackSession.mediaId })
      .from(playbackSession)
      .where(eq(playbackSession.id, sessionId))
      .get();
    return row?.mediaId ?? '';
  }

  /**
   * 上下文版本复查(T051):playback_session 捕获的 profile_context_version 必须仍等于
   * 其 DeviceSession 当前版本。不等(或行已缺失)→ false。直查 getDb()(与
   * authorization/lifecycle 同一先例,不扩仓储 API 面)。
   */  private identityContextCurrent(sessionId: string): boolean {
    const row = getDb()
      .select({
        sessionContextVersion: playbackSession.profileContextVersion,
        deviceSessionId: playbackSession.deviceSessionId,
      })
      .from(playbackSession)
      .where(eq(playbackSession.id, sessionId))
      .get();
    if (row === undefined) {
      return false;
    }
    const device = getDb()
      .select({ profileContextVersion: deviceSession.profileContextVersion })
      .from(deviceSession)
      .where(eq(deviceSession.id, row.deviceSessionId))
      .get();
    if (device === undefined) {
      return false;
    }
    return row.sessionContextVersion === device.profileContextVersion;
  }

  /**
   * 转换族交付准备(缺口1/缺口2 共用管线):启动转换(reserve→ffmpeg→产物目录)→
   * 首产物事实 → markReady(delivery=plan 模式)。失败(额度忙/启动失败/看门狗超时裁决)
   * → preparing→failed + 同码;CAS 失败(会话已被接管)静默丢弃 —— 在途转换由换代协同
   * (cancelSupersededGeneration)与生命周期回收,本方法不重复取消。
   */
  private async prepareConversionDelivery(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly version: number;
    readonly delivery: PlaybackConversionDelivery;
    readonly playbackSourceId: string;
    readonly phase: 'prepare' | 'seek';
    readonly deadlineMs: number;
    readonly facts: PlaybackProbeFacts;
    readonly at?: string;
  }): Promise<void> {
    const cas = { expectedVersion: input.version, expectedGeneration: input.generation };
    const launch = this.ports.conversionLaunch;
    if (launch === undefined) {
      // 装配缺位 fail-closed:转码会话「假 ready」会让流网关对转码交付稳定 503
      // (T033 runtime 冒烟暴露的现状缺陷),宁可稳定失败也不虚报就绪
      this.repository.failSession(input.sessionId, { cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at: input.at });
      return;
    }
    const launched = await launch.startAndWaitFirstOutput({
      householdId: input.householdId,
      sessionId: input.sessionId,
      generation: input.generation,
      delivery: input.delivery,
      playbackSourceId: input.playbackSourceId,
      phase: input.phase,
      deadlineMs: input.deadlineMs,
      plan: conversionPlanForDelivery(input.delivery, input.facts.audioTracks.length > 0),
    });
    if (!launched.ok) {
      // BUSY/PREPARE_TIMEOUT/SEEK_TIMEOUT/RESOURCE_UNAVAILABLE:稳定码原样落会话
      // (看门狗裁决路径会话已被 lifecycle.markFailure 置终态,此处 CAS 失败为无害 no-op)
      this.repository.failSession(input.sessionId, { cas, failureCode: launched.code, at: input.at });
      return;
    }
    if (!this.identityContextCurrent(input.sessionId)) {
      // 转换首产物后的 ready 提交同样复查上下文版本(T051;A→B→A 不得复活旧播放)
      this.repository.failSession(input.sessionId, { cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at: input.at });
      return;
    }
    const marked = this.repository.markReady(input.sessionId, {
      cas,
      playbackSourceId: input.playbackSourceId,
      delivery: input.delivery,
      at: input.at,
    });
    if (marked.ok) {
      // 同代事实缓存(轨道词表/时长):与 direct 同语义,换代后由 carryFactsForward 迁移
      this.factsBySession.set(input.sessionId, { generation: input.generation, facts: input.facts });
    }
  }

  /**
   * 换代重建准备(缺口2;selection 换代提交并取消旧代后经端口 fire-and-forget 调用):
   * - 同源同代事实:probe 事实缓存按代迁移(carryFactsForward)——无需重跑 ffprobe;
   * - 交付决策位置无关:沿用上一代 delivery —— direct/hls_proxy 直接 markReady(delivery
   *   不变,ready 前无票语义保持);转换族经与首次准备相同的「启动转换→首产物→ready」管线;
   * - 期限用 seek 15 秒预算(budgets.watchdog.seekTimeoutSeconds),超期由监督者/看门狗
   *   映射 PLAYBACK_SEEK_TIMEOUT;任何路径不得抛出(调用方已返回)。
   */
  async prepareRebuild(householdId: string, sessionId: string, generation: number): Promise<void> {
    try {
      const loaded = this.repository.getSession(householdId, sessionId);
      if (!loaded.ok) {
        return;
      }
      const session = loaded.value;
      if (session.state !== 'preparing' || session.generation !== generation || session.delivery === null) {
        // 防御:已被接管(换代嵌套/终态)或上一代从未完成准备 —— 静默丢弃
        return;
      }
      const cas = { expectedVersion: session.version, expectedGeneration: generation };
      const delivery = session.delivery;
      const facts = this.carryFactsForward(sessionId, generation);
      if (delivery === 'direct' || delivery === 'hls_proxy') {
        // 位置无关:交付与产物不变,同源直接重回 ready(旧票已因换代失效,renew 取新票)
        const source = await this.locateSessionSource(sessionId);
        if (source === null) {
          this.repository.failSession(sessionId, { cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE' });
          return;
        }
        if (!this.identityContextCurrent(sessionId)) {
          // 换代重建 ready 提交同样复查上下文版本(T051;身份已变的会话不得重回 ready)
          this.repository.failSession(sessionId, { cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE' });
          return;
        }
        const marked = this.repository.markReady(sessionId, {
          cas,
          playbackSourceId: source.playbackSourceId,
          delivery,
        });
        if (marked.ok && facts !== undefined) {
          this.factsBySession.set(sessionId, { generation, facts });
        }
        return;
      }
      // 转换族:seek 相位 15 秒预算;事实缺失(上一代亦未缓存)fail-closed
      if (facts === undefined) {
        this.repository.failSession(sessionId, { cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE' });
        return;
      }
      const source = await this.locateSessionSource(sessionId);
      if (source === null) {
        this.repository.failSession(sessionId, { cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE' });
        return;
      }
      await this.prepareConversionDelivery({
        householdId,
        sessionId,
        generation,
        version: session.version,
        delivery,
        playbackSourceId: source.playbackSourceId,
        phase: 'seek',
        deadlineMs: this.budgets.watchdog.seekTimeoutSeconds * 1000,
        facts,
      });
    } catch {
      // 防御:换代准备不得产生未处理拒绝;会话停留 preparing 由生命周期兜底回收
    }
  }

  /** 同源事实代际迁移:上一代缓存迁入当前代(同 session 跨代源不变,词表代内稳定) */
  private carryFactsForward(sessionId: string, generation: number): PlaybackProbeFacts | undefined {
    const cached = this.factsBySession.get(sessionId);
    if (cached === undefined) {
      return undefined;
    }
    if (cached.generation === generation) {
      return cached.facts;
    }
    if (cached.generation < generation) {
      this.factsBySession.set(sessionId, { generation, facts: cached.facts });
      return cached.facts;
    }
    return undefined;
  }

  /** 会话源引用(换代重建;端口缺位/异常 → null,fail-closed 由调用方落稳定码) */
  private async locateSessionSource(sessionId: string): Promise<{ readonly playbackSourceId: string; readonly location: string } | null> {
    const port = this.ports.sessionSource;
    if (port === undefined) {
      return null;
    }
    try {
      return await port.locateSessionSource(sessionId);
    } catch {
      return null;
    }
  }

  /**
   * GET 状态视图(contracts/api.md PlaybackDto):preparing 时 delivery/ticket/duration/
   * tracks 空;结构不含 playback_source_id/location;probe 事实仅同代有效(换代后
   * duration/tracks 回落空,直至新代 probe 完成)。
   */
  toDto(session: PlaybackSessionView, options: PlaybackDtoOptions = {}): PlaybackDto {
    void options.includeTicketFields;
    const cached = this.factsBySession.get(session.id);
    const facts = cached !== undefined && cached.generation === session.generation ? cached.facts : undefined;
    // 冻结起播位置(resume:T101;按代有效 —— 换代后回落 0,由新代重新冻结或从头)
    const frozen = this.presentationStartBySession.get(session.id);
    const presentationStartSeconds =
      frozen !== undefined && frozen.generation === session.generation ? frozen.seconds : 0;
    const dto: PlaybackDto = {
      id: session.id,
      state: session.state,
      version: session.version,
      generation: session.generation,
      desiredPaused: session.desiredPaused,
      delivery: session.delivery,
      positionSeconds: session.positionSeconds,
      durationSeconds: facts?.durationSeconds ?? null,
      timelineOffsetSeconds: 0,
      presentationStartSeconds,
      // GET 不重签也不复现旧票:票据字段恒空,仅 renew 的 TicketReply 携带(T018)
      ticketExpiresAt: null,
      playbackUrl: null,
      tracks: {
        audio: facts ? [...facts.audioTracks] : [],
        subtitles: facts ? [...facts.subtitleTracks] : [],
      },
      ...(session.failureCode !== null ? { failureCode: session.failureCode } : {}),
    };
    return dto;
  }

  /**
   * 只读事实查询(T031 装配桥接;PlaybackTrackFactsPort 的实现源):
   * 按 (sessionId, generation) 读取 probe 事实缓存 —— 换代后旧代事实不可见(与 toDto
   * 同一代校验),无缓存返回 undefined。只读,不改变 factsBySession 任何状态;
   * selection(T029)/subtitles(T030)经模块装配的端口桥接至此,单一事实源不重复缓存。
   */
  factsFor(sessionId: string, generation: number): PlaybackProbeFacts | undefined {
    const cached = this.factsBySession.get(sessionId);
    if (cached === undefined || cached.generation !== generation) {
      return undefined;
    }
    return cached.facts;
  }

  /**
   * 首次交付进 playing(流层 T031 调;委托仓储):ready→playing,started_at 一次设置
   * 之后不重置;CAS 失败(换代/终态)以领域结果返回,由流层决定终止交付。
   */
  markPlaying(sessionId: string, input: MarkPlayingInput): PlaybackResult<PlaybackSessionView> {
    return this.repository.markPlaying(sessionId, input);
  }
}
