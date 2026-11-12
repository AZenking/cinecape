import { createDomainError, type DomainError } from '@platform/http-common/domain-error';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { playbackStore, type PlaybackLineRow } from '@contexts/playback/application/playback-store.port';
import type { StreamLineDto } from '@hmp/shared';
// 016 T019(US3 多线路):线路公开标签与导入派生共用同一形态(经 sources 发布面合法跨上下文,
// 单一事实源,禁第二份「线路 N [差异段|来源名]」模板)
import { buildLineLabel } from '@contexts/sources';
import type { PlaybackAuthorizationService, PlaybackResourceCandidate } from '@contexts/playback/application/playback-authorization.service';
import type { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import type { PlaybackProgressBindPort, PlaybackResumePositionPort } from '@contexts/personal-data';
import type { InputBindingRow, StartBasis } from '@contexts/playback/application/playback-work-set.port';
import type {
  VodFrozenStartPoint,
  VodResumeDispositionReason,
  VodRequestedStartMode,
  VodStartPointDecision,
  VodStartPositionContext,
  VodTransitionCarrySnapshot,
} from '@contexts/playback/application/vod-start-position.service';
import { nearEndHintOf } from '@contexts/playback/application/vod-start-position.service';
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

/**
 * VOD 固定输入修订期望面(ready 重验输入;省略维度不参与失配判定。
 * 与 T042 store 的 VodInputRevisionExpectation 结构镜像,application 不深导 infrastructure)
 */
export interface PlaybackVodInputRevisionExpectation {
  readonly locatorRevision?: number;
  readonly detailRevision?: number | null;
  readonly contentRevision?: number;
  readonly continuityRevision?: number | null;
}

/**
 * 固定输入绑定端口(T042 playback-input-store 的 resolver 消费子集;装配桥接归
 * playback.module/providers)。语义即 data-model §6:每 session/generation 最多一有效
 * 绑定;frozen_start_seconds NULL 直到 probe;start_basis 三值;解析事实在事务外。
 */
export interface PlaybackResolverVodInputPort {
  /**
   * 幂等固定输入绑定:解析事实恰一次(同一闭包)→ resolveVodInput 幂等固定 →
   * bindFixedInput 确认 start_basis(冻结前可修正,冻结后绑定行事实不可变)。
   */
  bindFixedInput(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly mediaId: string;
    readonly playbackSourceId: string;
    readonly sourceId: string;
    readonly startBasis: StartBasis;
  }): Promise<{ readonly bindingId: string }>;
  /** ready 重验:固定输入四维修订失配检测(绑定冻结修订 × 期望修订 × 目录当前修订) */
  assertCurrent(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly expected: PlaybackVodInputRevisionExpectation;
  }): void;
  /** 修订失配终止:撤交付 + failed 同提交(data-model §3「准备转failed,需新resolve」) */
  failOnRevisionMismatch(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly reason: string;
  }): void;
}

/**
 * 事务建档工作集端口(internal-ports §2;装配桥接归 playback.module/providers):
 * 普通 resolve 的 session + epoch/ledger 同用例事务(避免 createSession 先成功而后
 * bind 失败的半建档)+ FR-021 冻结一次接缝 + 绑定行回读。
 */
export interface PlaybackResolveWorkSetPort {
  /** 事务建档:preparing session + epoch 分配 + 完整 ledger 首次建档(同 commit;失败整体回滚) */
  createSessionWithLedger(input: {
    readonly householdId: string;
    readonly deviceSessionId: string;
    readonly deviceId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly profileContextVersion: number;
    readonly at?: string;
  }): { readonly sessionId: string; readonly generation: number; readonly version: number };
  /** 冻结一次(FR-021):freezeOnce 经事务工作集 InputBindingTx(frozen_at 守卫,仅首冻结落值) */
  freezeStartOnce(input: {
    readonly householdId: string;
    readonly bindingId: string;
    readonly decision: VodStartPointDecision;
  }): void;
  /** 绑定行回读(冻结值/start_basis 透传与重验期望基准);无行 undefined */
  findActiveBinding(householdId: string, sessionId: string, generation: number): InputBindingRow | undefined;
}

/** vod 起点决策跟踪面(DTO 起点形态;T041 决策 + 绑定行冻结回读的代内视图) */
interface PlaybackSessionStartView {
  readonly generation: number;
  readonly startBasis: 'beginning' | 'target_history' | 'transition_carry';
  readonly resumeDisposition: 'pending' | 'resume' | 'beginning';
  readonly resumeReason: VodResumeDispositionReason | null;
}

/** vod 会话 finalize 上下文(resolve 建档产物;prepare 消费) */
interface PlaybackVodFinalizeContext {
  readonly generation: number;
  readonly bindingId: string;
  readonly mediaId: string;
  readonly requestedMode: 'beginning' | 'resume';
  readonly deviceSessionId: string;
}

/**
 * 过渡后继 finalize 上下文(T061;消费事务提交后由 prepareTransitionSuccessor 登记,
 * probe 后消费,按代失效):
 * - positionMode 即用户对计划快照的显式选择:probe 后唯一重验 = 目标历史 revision
 *   (expectedHistoryRevision,intent 冻结的计划快照)vs 当前历史(T041
 *   computeStartPosition 带 expectedHistoryRevision,内部经 compareTargetHistoryRevision)
 *   —— 漂移即准备失败:会话 failed(注册词表修订冲突族,客户端/HTTP 面映射
 *   NEXT_PLAN_CHANGED;不复活源、不用新位置替换用户确认,I3 全语义);
 * - 冻结值(FR-021 冻结一次,frozen_at 守卫):beginning 恒 0;target_history 为消费
 *   时刻目标历史位置 —— 重验通过(revision 相等)即与 probe 时刻历史读取一致,冻结后
 *   历史更新不改起点;不以 T039 资格降级覆盖显式选择(资格降级属普通 resolve resume
 *   语义,过渡消费不复用,避免以资格降级覆盖用户选择)。
 */
interface PlaybackTransitionFinalizeContext {
  readonly generation: number;
  readonly bindingId: string;
  readonly mediaId: string;
  readonly profileId: string;
  readonly startBasis: 'beginning' | 'target_history' | 'transition_carry';
  /** 消费时刻冻结起点(target_history=目标历史位置;transition_carry=intent 冻结的 carry 快照位置;beginning 恒 0) */
  readonly frozenStartSeconds: number;
  /** 计划冻结历史 revision(target_history probe 后重验基准;undefined = 非计划路径不比对) */
  readonly expectedHistoryRevision?: number;
  /**
   * US4 carry 快照透传(T073;T072 消费事务的 intent 冻结快照 —— positionMode=carry
   * 时经后继准备端口透传,probe 后由过渡终段原样交 T041 computeStartPosition 入口;
   * 缺省 = 端口面仅透传 frozenStartSeconds(T072 定稿形态),终段以派生最小快照进
   * 入口 —— checkpoint 精确性已由 T072 消费事务复核,身份字段不参与任何裁决)。
   */
  readonly carry?: VodTransitionCarrySnapshot;
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
  /**
   * VOD 起点计算端口(T041/T073,US2/US4):beginning/resume/target_history 唯一起点
   * 决策入口(T039 裁决经端口注入)+ transition_carry(carry 快照在场判别,T072 消费
   * 事务的 intent 冻结快照消费);与 resolveWorkSet/vodInput 联合缺位时回退既有 T101
   * 静态冻结路径。
   */
  readonly startPosition?: {
    computeStartPosition(
      context: VodStartPositionContext,
      command: {
        readonly mediaId: string;
        readonly requestedMode: VodRequestedStartMode;
        readonly probeDurationSeconds?: number | null;
        readonly expectedHistoryRevision?: number;
        readonly carry?: VodTransitionCarrySnapshot;
        readonly frozen?: VodFrozenStartPoint | null;
      },
    ): VodStartPointDecision;
  };
  /** 固定输入绑定端口(T042 store 桥;见 PlaybackResolverVodInputPort) */
  readonly vodInput?: PlaybackResolverVodInputPort;
  /** 事务建档工作集端口(§2;见 PlaybackResolveWorkSetPort) */
  readonly resolveWorkSet?: PlaybackResolveWorkSetPort;
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

/* ------------------------------------------------------------------ */
/* 016 T019(US3 多线路):线路投影与顺位(纯函数,导入侧单测共用)              */
/* ------------------------------------------------------------------ */

/** 字节序(二进制)字符串比较 —— 线路同权重的确定性决胜口径(与授权候选排序一致) */
function compareBinaryStrings(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * 线路顺位比较(priority ASC;同权重以 lineId 二进制升序决胜 —— 确定性投影,
 * 两次解析同目录事实恒同序)。停用线路不入投影(读取谓词已过滤启用源×present 条目)。
 */
export function comparePlaybackLines(a: PlaybackLineRow, b: PlaybackLineRow): number {
  const priorityDelta = a.linePriority - b.linePriority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return compareBinaryStrings(a.lineId, b.lineId);
}

/**
 * 线路公开投影(016 data-model §2.1/api.md §2.1 StreamLine):按线路顺位映射 ——
 * isDefault = 顺位首条(至多一条 true),isEnabled 恒 true(读取谓词仅含启用线路),
 * label = 「线路 N [来源名]」(resolve 侧原始名不入库,差异段走来源名回退 ——
 * 模板单一事实源经 sources 发布面 buildLineLabel)。输出恰七键,绝无源地址/凭据/位置。
 */
export function buildStreamLines(rows: readonly PlaybackLineRow[]): StreamLineDto[] {
  return [...rows].sort(comparePlaybackLines).map((row, index) => ({
    lineId: row.lineId,
    sourceId: row.sourceId,
    sourceTitle: row.sourceTitle,
    label: buildLineLabel(index + 1, '', row.sourceTitle),
    priority: row.linePriority,
    isDefault: index === 0,
    isEnabled: true,
  }));
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
  /**
   * 010 起点形态(api.md §1 追加字段;T043/T041 决策面):仅本会话存在起点跟踪
   * (在线 vod resolve)时下发 —— preparing 未冻结 = pending;冻结后透传绑定行
   * start_basis 与决策处置。NAS/IPTV/直播会话不携带,既有 DTO 面零变化。
   */
  readonly startBasis?: 'beginning' | 'target_history' | 'transition_carry';
  readonly resumeDisposition?: 'pending' | 'resume' | 'beginning';
  readonly resumeReason?: VodResumeDispositionReason | null;
  /**
   * 016 api.md §2.1 增量(经父代理裁决走现行 POST /playback/resolve 入口):本次解析
   * 实际选中的物理线路 ID(不透明,= source_entry.id)。仅直播频道的多线路/指定线路
   * resolve 下发;单线路频道保持既有键面(无多线路语义不携带,契约字段可选)。
   */
  readonly selectedLineId?: string;
  /**
   * 016 api.md §2.1 增量:该频道可用线路公开投影(StreamLine 七键:lineId/sourceId/
   * sourceTitle/label/priority/isDefault/isEnabled;按 priority ASC,绝无源地址/凭据/
   * 位置)。下发条件同 selectedLineId(多线路直播 resolve);单线路/非直播缺省既有键面。
   */
  readonly lines?: readonly StreamLineDto[];
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
  /**
   * 016 api.md §2.1 增量(经父代理裁决走现行 POST /playback/resolve 请求体):指定收看的
   * 物理线路 ID(= lines[].lineId 回传)。缺省由系统按权重(priority ASC)选默认线路;
   * 指定线路不存在 → 404 MEDIA_NOT_FOUND 同形(在建 session 之前拒绝,不悬挂半建档);
   * 仅直播频道受理,非直播媒体携带按线路不存在同形 404。授权(策略/白名单裁决)恒先于
   * 线路选择 —— 换线不得成为越权通道(授权链在 authorizeResolve 内已完整执行)。
   */
  readonly lineId?: string;
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
  /** 起点决策视图(010 T043:DTO startBasis/resumeDisposition/resumeReason;按代失效) */
  private readonly startViewBySession = new Map<string, PlaybackSessionStartView>();
  /** vod finalize 上下文(resolve 建档产物;prepare 消费,按代失效) */
  private readonly vodFinalizeBySession = new Map<string, PlaybackVodFinalizeContext>();
  /** 过渡后继 finalize 上下文(T061;prepareTransitionSuccessor 登记,probe 后消费,按代失效) */
  private readonly transitionFinalizeBySession = new Map<string, PlaybackTransitionFinalizeContext>();

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
    // 1. 授权(同步,不等待 probe);拒绝在此抛出 —— 之后才允许建 session。
    //    T043:授权内已按序完成「身份/档案/PIN → 最新策略 → 在线父子有效策略门 →
    //    父项 400 VOD_EPISODE_REQUIRED(选集错误,不尝试找父播放资源)」
    const grant = await this.authorization.authorizeResolve(context, mediaId);
    // 1.5 startMode 透传校验(005 api.md §5:resume 仅点播;频道请求 resume 稳定 400)
    if (options.startMode === 'resume' && grant.mediaType === 'channel') {
      throw createDomainError('PLAYBACK_SEEK_UNSUPPORTED', '直播频道不支持续播定位');
    }
    // 1.6 多线路裁决(016 T019,api.md §2.1 增量):授权已完整通过(身份/档案/PIN/策略/
    //    白名单全链)之后才读线路事实 —— 换线(lineId)不得先于或绕过授权管线(硬约束)。
    //    指定线路不存在/已停用/非直播媒体 → 404 MEDIA_NOT_FOUND 同形,在建 session 之前
    //    拒绝(不悬挂半建档);缺省由系统按权重选默认线路。
    const lineRows =
      grant.mediaType === 'channel' ? playbackStore().listPlaybackLineRows(grant.snapshot.householdId, grant.snapshot.mediaId) : [];
    if (options.lineId !== undefined && !lineRows.some((row) => row.lineId === options.lineId)) {
      throw createDomainError('MEDIA_NOT_FOUND');
    }
    const hasMultiLine = grant.mediaType === 'channel' && lineRows.length >= 2;
    // probe 候选顺位(授权排序在多线路直播上按线路权重精化;其余场景零变化):
    // - 指定线路:收敛为该线路(用户显式换线按其选择探测,不再顺位尝试他线);
    // - 多线路缺省:默认线路(权重最高)首 probe,其余按顺位容灾(排序稳定,非线路候选保位);
    // - 单线路/非直播:授权原序(既有行为)。
    let candidatesForProbe = grant.candidates;
    if (options.lineId !== undefined) {
      const target = lineRows.find((row) => row.lineId === options.lineId) as PlaybackLineRow;
      const targeted = grant.candidates.filter((candidate) => candidate.playbackSourceId === target.playbackSourceId);
      if (targeted.length > 0) {
        candidatesForProbe = targeted;
      }
    } else if (hasMultiLine) {
      const rowByPlaybackSource = new Map(lineRows.map((row) => [row.playbackSourceId, row] as const));
      candidatesForProbe = [...grant.candidates].sort((left, right) => {
        const leftRow = rowByPlaybackSource.get(left.playbackSourceId);
        const rightRow = rowByPlaybackSource.get(right.playbackSourceId);
        if (leftRow === undefined || rightRow === undefined) {
          return 0; // 防御:无线路事实的候选保持原相对序(stable sort)
        }
        return comparePlaybackLines(leftRow, rightRow);
      });
    }
    // T043:在线 vod 判别(服务端目录事实;授权快照面不携带角色 —— NAS/IPTV/直播与
    // 未装配场景走既有路径零变化)
    const mediaRole =
      playbackStore().findMediaItemRowInHousehold(grant.snapshot.householdId, grant.snapshot.mediaId)?.mediaRole ?? 'standalone';
    const isVodEpisode = mediaRole === 'vod_episode' && grant.mediaType !== 'channel';
    const requestedMode: 'beginning' | 'resume' = options.startMode ?? 'beginning';
    // 2. 建 preparing session(身份绑定取授权快照的服务端事实,非请求声明;
    //    profile_context_version 一次性捕获 —— 此后不可变,由控制链路每次重验)。
    //    T043(internal-ports §2):在线 vod resolve 以「session + epoch/ledger 同用例
    //    事务」建档,避免 createSession 先成功而后绑定失败的半建档;NAS/IPTV/直播
    //    与未装配场景走既有路径(行为零变化)。
    let session: PlaybackSessionView;
    if (isVodEpisode && this.ports.resolveWorkSet !== undefined) {
      const created = this.ports.resolveWorkSet.createSessionWithLedger({
        householdId: grant.snapshot.householdId,
        deviceSessionId: grant.snapshot.deviceSessionId,
        deviceId: grant.snapshot.deviceId,
        profileId: grant.snapshot.profileId,
        mediaId: grant.snapshot.mediaId,
        profileContextVersion: grant.snapshot.profileContextVersion,
        at: options.at,
      });
      const loaded = this.repository.getSession(grant.snapshot.householdId, created.sessionId);
      if (!loaded.ok) {
        throw playbackErrToDomainError(loaded);
      }
      session = loaded.value;
    } else {
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
      session = created.value;
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
    }
    // 2.6 起播模式记录(resume 冻结在 probe 后;本会话生命周期内不再改变)
    this.startModeBySession.set(session.id, requestedMode);
    // 2.7 固定输入绑定(T042 store;data-model §6):在线 vod resolve 建唯一有效绑定
    // (start_basis 随请求落座,frozen_start_seconds NULL 直到 probe);绑定不可建
    // (定位/来源缺失)时会话转 failed(不悬挂半建档)并稳定上抛,需新 resolve。
    if (isVodEpisode && this.ports.vodInput !== undefined) {
      const candidate = grant.candidates[0];
      try {
        const bound = await this.ports.vodInput.bindFixedInput({
          householdId: grant.snapshot.householdId,
          sessionId: session.id,
          generation: session.generation,
          mediaId: grant.snapshot.mediaId,
          playbackSourceId: candidate?.playbackSourceId ?? '',
          sourceId: candidate?.sourceId ?? '',
          startBasis: requestedMode === 'resume' ? 'target_history' : 'beginning',
        });
        this.vodFinalizeBySession.set(session.id, {
          generation: session.generation,
          bindingId: bound.bindingId,
          mediaId: grant.snapshot.mediaId,
          requestedMode,
          deviceSessionId: grant.snapshot.deviceSessionId,
        });
      } catch (error) {
        this.repository.failSession(session.id, {
          cas: { expectedVersion: session.version, expectedGeneration: session.generation },
          failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE',
          at: options.at,
        });
        throw error;
      }
    }
    // 2.8 起点形态跟踪(010 api.md §1:preparing 未冻结 = pending;冻结后透传决策)
    if (isVodEpisode) {
      this.startViewBySession.set(session.id, {
        generation: session.generation,
        startBasis: requestedMode === 'resume' ? 'target_history' : 'beginning',
        resumeDisposition: 'pending',
        resumeReason: null,
      });
    }
    // 3. fire-and-forget 异步准备(总期限共享:单次端口调用携带全部候选与同一 30s 期限;
    //    候选顺位见 1.6 —— 指定线路收敛/多线路按权重精化/其余授权原序)
    const deadlineMs = options.deadlineMs ?? this.budgets.watchdog.prepareTimeoutSeconds * 1000;
    void this.prepare(grant.snapshot.householdId, grant.snapshot.profileId, session.id, session.generation, session.version, candidatesForProbe, deadlineMs, options.at);
    // 4. 返回 preparing 形态(delivery/源为空:不猜 delivery);016 多线路直播增量下发
    //    线路投影与选中线路 —— 下发条件:多线路频道,或请求显式指定 lineId(单线路指定
    //    亦回应选中事实);其余保持既有 DTO 键面(契约字段可选,004/005 契约回归)。
    const baseDto = this.toDto(session);
    if (!hasMultiLine && options.lineId === undefined) {
      return { session, dto: baseDto };
    }
    const lines = buildStreamLines(lineRows);
    return {
      session,
      dto: { ...baseDto, lines, selectedLineId: options.lineId ?? lines[0]?.lineId },
    };
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
        // 起点冻结:probe 成功后、任何转换输出启动或 direct 输出安装之前完成。
        // T043 vod 会话:computeStartPosition(T041/T039 唯一裁决)→ FR-021 freezeOnce
        // (事务工作集;frozen_at 守卫只冻结一次)→ ready 重验(Profile/context/locator/
        // content/continuity 经 assertFixedInputCurrent + 绑定行回读,CAS 由 markReady
        // 承担)—— 失败不默默重绑、不二次历史覆盖;静态会话沿用既有 T101 冻结读取
        // (静态媒体原续播行为零变化)。
        const finalize = this.vodFinalizeBySession.get(sessionId);
        if (
          finalize !== undefined &&
          finalize.generation === generation &&
          this.ports.startPosition !== undefined &&
          this.ports.resolveWorkSet !== undefined &&
          this.ports.vodInput !== undefined
        ) {
          const finalized = await this.finalizeVodStart({
            householdId,
            profileId,
            sessionId,
            generation,
            version,
            cas,
            at,
            facts: outcome.facts,
            playbackSourceId: outcome.playbackSourceId,
            finalize,
          });
          if (!finalized) {
            return;
          }
        } else if ((this.startModeBySession.get(sessionId) ?? 'beginning') === 'resume' && this.ports.resumePosition !== undefined) {
          // resume 冻结(T101):可信 probe 完成后,服务端重读当前 Profile 最新有效历史,
          // 按资源修订与可信 duration 冻结本次 presentationStartSeconds(无有效位置则 0;
          // 不删除旧历史)。ready 提交仅重验身份/修订/generation,不改变已冻结输出;
          // 冻结后另一设备的后续观看不悄悄改位置。
          const seconds = this.ports.resumePosition.readResumeFreeze({
            householdId,
            profileId,
            mediaId: this.sessionMediaIdOf(sessionId),
            probeDurationSeconds: outcome.facts.durationSeconds,
          });
          this.presentationStartBySession.set(sessionId, { generation, seconds });
        }
        // T061 过渡后继起点终段:probe 成功后、转换输出启动/direct 输出安装之前 ——
        // target_history 以计划快照历史 revision 重验当前历史(漂移 → 会话 failed,
        // NEXT_PLAN_CHANGED 语义)+ FR-021 冻结一次(beginning 冻结 0 / target_history
        // 冻结消费时刻位置)。失败(已稳定 failed)即静默返回,不继续 ready。
        const transitionFinalize = this.transitionFinalizeBySession.get(sessionId);
        if (transitionFinalize !== undefined && transitionFinalize.generation === generation) {
          const finalized = await this.finalizeTransitionStart({
            householdId,
            sessionId,
            generation,
            cas,
            at,
            facts: outcome.facts,
            finalize: transitionFinalize,
          });
          if (!finalized) {
            return;
          }
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
          const readyFinalize = this.vodFinalizeBySession.get(sessionId);
          if (
            readyFinalize !== undefined &&
            this.ports.vodInput !== undefined &&
            this.ports.resolveWorkSet !== undefined
          ) {
            // T043 ready 固定输入重验(markReady 后会话已携带选定源,目录 JOIN 完整):
            // 期望 = 绑定行冻结修订回读(授权基线),当前 = 目录实时修订 —— 定位/详情/
            // 内容/连续性任一漂移即撤交付 + failed 同提交(不静默重绑、不复活旧源,
            // 需新 resolve;data-model §3);CAS 由 markReady 承担。
            try {
              const binding = this.ports.resolveWorkSet.findActiveBinding(householdId, sessionId, generation);
              this.ports.vodInput.assertCurrent({
                householdId,
                sessionId,
                generation,
                expected:
                  binding === undefined
                    ? {}
                    : {
                        locatorRevision: binding.locatorRevision,
                        detailRevision: binding.detailRevision,
                        contentRevision: binding.contentRevision,
                        continuityRevision: binding.continuityRevision,
                      },
              });
            } catch {
              this.ports.vodInput.failOnRevisionMismatch({
                householdId,
                sessionId,
                generation,
                reason: 'ready re-verify: fixed input revision mismatch',
              });
              this.factsBySession.delete(sessionId);
              this.vodFinalizeBySession.delete(sessionId);
              this.transitionFinalizeBySession.delete(sessionId);
              return;
            }
          }
          this.factsBySession.set(sessionId, { generation, facts: outcome.facts });
          this.vodFinalizeBySession.delete(sessionId);
          this.transitionFinalizeBySession.delete(sessionId);
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
      this.vodFinalizeBySession.delete(sessionId);
      this.transitionFinalizeBySession.delete(sessionId);
    } catch {
      // 防御:端口异常/仓储意外错误不得成为未处理拒绝;会话停留 preparing,
      // 由生命周期(T028)的失联/超时兜底回收
    }
  }

  /** 会话媒体 ID 只读投影(resume 冻结读取需要;行缺失回退空串,冻结为 0) */
  private sessionMediaIdOf(sessionId: string): string {
    const row = playbackStore().findSessionMediaId(sessionId);
    return row?.mediaId ?? '';
  }

  /**
   * 事件循环让渡(准备段 fire-and-forget 持久化与 201 接受响应的排序纪律):
   * 在线候选 probe 即时成功时,本 prepare 与 resolve 的响应写在同一事件循环轮内
   * 完成于微任务相位 —— 让渡两个 setImmediate 相位,使「201 接受形态」先于冻结
   * 持久化对客户端可观察(frozen_start_seconds NULL 直到 probe 的可观察面;准备段
   * 本就不在 resolve 响应路径上,不延迟接受)。
   */
  private yieldAfterAcceptedResponse(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(() => {
        setImmediate(resolve);
      });
    });
  }

  /**
   * vod 会话起点终段(T043;probe 成功后、ready 提交前的 fire-and-forget 段):
   * 1. Profile/context 重验(revalidate 全链 + T051 上下文版本)—— 失败稳定码落会话;
   * 2. computeStartPosition(T041 唯一入口;probe facts 为本次可信时长,线上 duration
   *    不从历史兜底)—— history-changed → 会话 failed(HTTP 409 NEXT_PLAN_CHANGED
   *    映射归过渡消费面 T061,本失败码为已注册词表内的修订冲突族);carry-not-wired →
   *    RESOURCE_UNAVAILABLE 稳定失败(防御面:普通 resolve 只产 beginning/resume,
   *    carry 走过渡后继 finalizeTransitionStart 的快照透传,T073);
   * 3. 冻结前最终 start_basis 校正(幂等;冻结后绑定行事实不可变)→ freezeOnce
   *    (FR-021;frozen_at 守卫仅首冻结落值,NULL 起点亦属合法冻结);
   * 4. 绑定行回读透传(frozen_start_seconds/start_basis;已冻结值不再被第二次历史
   *    读取覆盖,另一设备后续观看/偏好/时长微漂移不改变已冻结起点)。
   * 任何失败路径不抛出(调用方已返回);返回 false 表示会话已稳定失败,调用方静默返回。
   */
  private async finalizeVodStart(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly version: number;
    readonly cas: { readonly expectedVersion: number; readonly expectedGeneration: number };
    readonly at?: string;
    readonly facts: PlaybackProbeFacts;
    readonly playbackSourceId: string;
    readonly finalize: PlaybackVodFinalizeContext;
  }): Promise<boolean> {
    const startPosition = this.ports.startPosition;
    const resolveWorkSet = this.ports.resolveWorkSet;
    const vodInput = this.ports.vodInput;
    // 编译期窄化(调用方已判非空;防御性早退保持调用形态单一)
    if (startPosition === undefined || resolveWorkSet === undefined || vodInput === undefined) {
      return true;
    }
    await this.yieldAfterAcceptedResponse();
    // 1. Profile 重验(授权链全量:会话/档案/PIN/策略/资源当前事实)——失败不虚报就绪
    try {
      await this.authorization.revalidate(input.finalize.deviceSessionId, input.profileId, input.finalize.mediaId);
    } catch {
      this.repository.failSession(input.sessionId, { cas: input.cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at: input.at });
      this.factsBySession.delete(input.sessionId);
      this.vodFinalizeBySession.delete(input.sessionId);
      return false;
    }
    // 2. Context 重验(T051:绑定档案上下文版本必须仍等于 DeviceSession 当前版本)
    if (!this.identityContextCurrent(input.sessionId)) {
      this.repository.failSession(input.sessionId, { cas: input.cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at: input.at });
      this.factsBySession.delete(input.sessionId);
      this.vodFinalizeBySession.delete(input.sessionId);
      return false;
    }
    // 3. 起点决策(T041/T039 唯一裁决;expectedHistoryRevision 为计划路径入参 ——
    //    普通 resolve 无计划不比对,T061 过渡消费接线)
    const decision = startPosition.computeStartPosition(
      { householdId: input.householdId, profileId: input.profileId },
      {
        mediaId: input.finalize.mediaId,
        requestedMode: input.finalize.requestedMode,
        probeDurationSeconds: input.facts.durationSeconds,
      },
    );
    if (decision.kind === 'history-changed') {
      // 计划目标历史已变化:会话 failed,不复活源、不用新位置替换用户确认(T041 审查补充)
      this.repository.failSession(input.sessionId, { cas: input.cas, failureCode: 'PLAYBACK_VERSION_CONFLICT', at: input.at });
      this.factsBySession.delete(input.sessionId);
      this.vodFinalizeBySession.delete(input.sessionId);
      return false;
    }
    if (decision.kind === 'carry-not-wired') {
      // 防御:普通 resolve 不产 transition_carry 请求(carry 走过渡后继快照透传,T073);
      // 非预期直呼按稳定失败收口,不猜 carry 起点
      this.repository.failSession(input.sessionId, { cas: input.cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at: input.at });
      this.factsBySession.delete(input.sessionId);
      this.vodFinalizeBySession.delete(input.sessionId);
      return false;
    }
    // 4. 冻结前最终 basis 校正(幂等;probe 冻结前可修正,冻结后绑定行事实不可变)
    try {
      await vodInput.bindFixedInput({
        householdId: input.householdId,
        sessionId: input.sessionId,
        generation: input.generation,
        mediaId: input.finalize.mediaId,
        playbackSourceId: input.playbackSourceId,
        sourceId: '',
        startBasis: decision.startBasis,
      });
    } catch {
      this.repository.failSession(input.sessionId, { cas: input.cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at: input.at });
      this.factsBySession.delete(input.sessionId);
      this.vodFinalizeBySession.delete(input.sessionId);
      return false;
    }
    // 5. 冻结一次(FR-021):仅 computed 决策产生冻结;frozen_at 守卫重复调用吸收
    resolveWorkSet.freezeStartOnce({
      householdId: input.householdId,
      bindingId: input.finalize.bindingId,
      decision,
    });
    // 6. 绑定行回读透传(frozen_start_seconds/start_basis;不二次历史覆盖)
    const binding = resolveWorkSet.findActiveBinding(input.householdId, input.sessionId, input.generation);
    this.startViewBySession.set(input.sessionId, {
      generation: input.generation,
      startBasis: (binding?.startBasis ?? decision.startBasis) as PlaybackSessionStartView['startBasis'],
      resumeDisposition: decision.disposition,
      resumeReason: decision.resumeReason,
    });
    this.presentationStartBySession.set(input.sessionId, {
      generation: input.generation,
      seconds: binding?.frozenStartSeconds ?? decision.startSeconds,
    });
    return true;
  }

  /**
   * 上下文版本复查(T051):playback_session 捕获的 profile_context_version 必须仍等于
   * 其 DeviceSession 当前版本。不等(或行已缺失)→ false。经本上下文仓储端口直查(与
   * authorization/lifecycle 同一先例,不扩仓储 API 面)。
   */  private identityContextCurrent(sessionId: string): boolean {
    const row = playbackStore().findSessionContextBinding(sessionId);
    if (row === undefined) {
      return false;
    }
    const device = playbackStore().findDeviceSessionContextVersion(row.deviceSessionId);
    if (device === undefined) {
      return false;
    }
    return row.profileContextVersion === device.profileContextVersion;
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
   * T061 过渡后继准备(消费事务提交后由 transition.service 经装配端口 fire-and-forget
   * 调用;T060 最小接线的精化面)——
   * 1. 登记 201 形态起点视图(positionMode 即 startBasis;preparing 未冻结 = pending,
   *    冻结移至 probe 后,对齐 data-model §6「frozen_start_seconds NULL 直到 probe」);
   * 2. 登记过渡 finalize 上下文(probe 后消费:target_history 以计划快照历史 revision
   *    重验当前历史,漂移即准备失败;beginning 冻结 0);
   * 3. 复用既有 fire-and-forget prepare 管线(probe→ready/failed;CAS 基准=建档代/版;
   *    不进 vodFinalize 复审 —— 普通续播资格裁决属普通 resolve 语义,过渡不复用)。
   * 不重消费旧槽/不建第二会话:会话行由消费事务创建,本方法只做准备编排;任何失败路径
   * 不向调用方抛出(fire-and-forget)。
   */
  async prepareTransitionSuccessor(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly version: number;
    readonly bindingId: string;
    readonly mediaId: string;
    readonly deviceSessionId: string;
    readonly candidates: readonly PlaybackResourceCandidate[];
    readonly startBasis: 'beginning' | 'target_history' | 'transition_carry';
    /** 消费时刻冻结起点(target_history=目标历史位置;transition_carry=intent 冻结 carry 快照位置;beginning 恒 0) */
    readonly frozenStartSeconds?: number;
    /**
     * US4 carry 快照透传(T073;T072 消费事务的 intent 冻结快照,positionMode=carry
     * 时必携):probe 后原样交 T041 computeStartPosition carry 路径(三互斥入参判别,
     * 直构决策面由此消除);缺省时过渡终段以 frozenStartSeconds 派生最小快照(见
     * PlaybackTransitionFinalizeContext.carry)。
     */
    readonly carry?: VodTransitionCarrySnapshot;
    /** 计划冻结历史 revision(T061 I3:probe 后对当前历史重验;undefined = 非计划路径) */
    readonly expectedHistoryRevision?: number;
    readonly deadlineMs?: number;
    readonly at?: string;
  }): Promise<void> {
    this.startViewBySession.set(input.sessionId, {
      generation: input.generation,
      startBasis: input.startBasis,
      resumeDisposition: 'pending',
      resumeReason: null,
    });
    this.transitionFinalizeBySession.set(input.sessionId, {
      generation: input.generation,
      bindingId: input.bindingId,
      mediaId: input.mediaId,
      profileId: input.profileId,
      startBasis: input.startBasis,
      frozenStartSeconds: input.frozenStartSeconds ?? 0,
      ...(input.startBasis === 'target_history' && input.expectedHistoryRevision !== undefined
        ? { expectedHistoryRevision: input.expectedHistoryRevision }
        : {}),
      ...(input.startBasis === 'transition_carry' && input.carry !== undefined ? { carry: input.carry } : {}),
    });
    const deadlineMs = input.deadlineMs ?? this.budgets.watchdog.prepareTimeoutSeconds * 1000;
    await this.prepare(
      input.householdId,
      input.profileId,
      input.sessionId,
      input.generation,
      input.version,
      input.candidates,
      deadlineMs,
      input.at,
    );
  }

  /**
   * 过渡后继起点终段(T061;probe 成功后、转换输出启动或 direct 输出安装前的
   * fire-and-forget 段,时序复用 T043 finalizeVodStart 先例)——
   * 1. target_history 漂移重验(I3「target_history 在 probe 后仍读取当前历史」):
   *    T041 computeStartPosition 带 expectedHistoryRevision(过渡快照,经
   *    compareTargetHistoryRevision)—— 漂移 → 会话 failed(注册词表修订冲突族
   *    PLAYBACK_VERSION_CONFLICT;HTTP/客户端面映射 409 NEXT_PLAN_CHANGED:会话 failed
   *    不复活源、不用新位置替换用户确认,api §7 I3/ui.md「probe后历史变化导致失败,
   *    提示重新选择」),不冻结、不 ready;probe 未知 duration 按 E1 语义透传(未知不作
   *    失败、不从历史兜底,冻结值与时长无关)。beginning 不重验(T041 同语义:显式从头
   *    不受计划历史变化影响)。
   * 2. 唯一起点决策 + FR-021 冻结一次(frozen_at 守卫,重复调用吸收):beginning 经
   *    T041 computeStartPosition 冻结 0;target_history 冻结消费时刻目标历史位置
   *    (重验通过 = revision 相等 = 与 probe 时刻读取一致);transition_carry 自 T073
   *    起同样经 T041 唯一入口(intent 冻结 carry 快照透传,直构决策面消除);三者皆
   *    不以 T039 资格降级覆盖用户显式选择。
   * 3. 绑定行回读透传(frozen_start_seconds/start_basis;已冻结值不被第二次读取覆盖)。
   * 任何失败路径不抛出(调用方已返回);返回 false 表示会话已稳定失败,调用方静默返回。
   */
  private async finalizeTransitionStart(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly cas: { readonly expectedVersion: number; readonly expectedGeneration: number };
    readonly at?: string;
    readonly facts: PlaybackProbeFacts;
    readonly finalize: PlaybackTransitionFinalizeContext;
  }): Promise<boolean> {
    const startPosition = this.ports.startPosition;
    const resolveWorkSet = this.ports.resolveWorkSet;
    // 编译期窄化(调用方已判非空;装配缺位时按既有管线继续,不冻结 —— 单测装配面)
    if (startPosition === undefined || resolveWorkSet === undefined) {
      return true;
    }
    await this.yieldAfterAcceptedResponse();
    const finalize = input.finalize;
    let currentHistoryRevision = 0;
    if (finalize.startBasis === 'target_history' && finalize.expectedHistoryRevision !== undefined) {
      // 1. probe 后历史重验(T041 唯一入口;内部 compareTargetHistoryRevision 经过渡快照)
      const gate = startPosition.computeStartPosition(
        { householdId: input.householdId, profileId: finalize.profileId },
        {
          mediaId: finalize.mediaId,
          requestedMode: 'target_history',
          // E1:probe 未知 duration 恒原样透传(不做历史时长兜底;重验只看 revision)
          probeDurationSeconds: input.facts.durationSeconds,
          expectedHistoryRevision: finalize.expectedHistoryRevision,
        },
      );
      if (gate.kind === 'history-changed') {
        // 计划目标历史在消费后、probe 后已变化:会话 failed(NEXT_PLAN_CHANGED 语义),
        // 不冻结、不用新位置替换用户确认、不复活源(源保持 ended 终态)
        this.repository.failSession(input.sessionId, { cas: input.cas, failureCode: 'PLAYBACK_VERSION_CONFLICT', at: input.at });
        this.factsBySession.delete(input.sessionId);
        this.transitionFinalizeBySession.delete(input.sessionId);
        return false;
      }
      if (gate.kind === 'computed') {
        currentHistoryRevision = gate.historyRevision;
      }
    }
    // 2. 唯一起点决策 + 冻结一次(FR-021):beginning 经 T041 冻结 0(显式从头);
    //    target_history 冻结消费时刻位置(重验已通过,起点与 probe 时刻历史读取一致);
    //    transition_carry 改经 T041 computeStartPosition 唯一入口(T073 直构决策面消除:
    //    intent 冻结 carry 快照透传,入参判别一途 —— 快照在场即 carry 路径,T072 消费事务
    //    已复核 checkpoint 精确性,起点=精确接受游标位置原样透出;不读目标历史、不做容差
    //    降级、不以 T039 资格裁决覆盖,与既有直构决策逐字段同形 → 行为零变化,e2e C1/C4
    //    frozen=240 钉面保持)
    const decision: VodStartPointDecision =
      finalize.startBasis === 'target_history'
        ? {
            kind: 'computed',
            startBasis: 'target_history',
            disposition: 'resume',
            resumeReason: 'accepted',
            startSeconds: finalize.frozenStartSeconds,
            nearEnd: nearEndHintOf(finalize.frozenStartSeconds, input.facts.durationSeconds),
            historyRevision: currentHistoryRevision,
          }
        : finalize.startBasis === 'transition_carry'
          ? startPosition.computeStartPosition(
              { householdId: input.householdId, profileId: finalize.profileId },
              {
                mediaId: finalize.mediaId,
                requestedMode: 'transition_carry',
                // E1 语义同规:probe 未知 duration 恒原样透传(nearEnd 提示面,不资格判定)
                probeDurationSeconds: input.facts.durationSeconds,
                // carry 快照透传(T072 intent 冻结快照):端口面未透传全快照(T072 定稿面仅
                // frozenStartSeconds)时以派生最小快照进入口 —— 位置即消费时刻冻结值;
                // checkpoint 身份缺省 null,不参与任何裁决(精确性归 T072 消费事务)
                carry:
                  finalize.carry ??
                  {
                    carryPositionSeconds: finalize.frozenStartSeconds,
                    carryDurationSeconds: null,
                    sourceCheckpoint: null,
                  },
              },
            )
          : startPosition.computeStartPosition(
              { householdId: input.householdId, profileId: finalize.profileId },
              {
                mediaId: finalize.mediaId,
                requestedMode: 'beginning',
                probeDurationSeconds: input.facts.durationSeconds,
              },
            );
    if (decision.kind !== 'computed') {
      // 防御:beginning/carry(快照在场)决策不受计划历史影响,不产出 history-changed
      // (T041 语义;carry 快照缺席时入口以 carry-not-wired 稳定拒绝,本路径恒携快照);
      // 非预期信号按稳定失败收口,不悬挂 preparing
      this.repository.failSession(input.sessionId, { cas: input.cas, failureCode: 'PLAYBACK_RESOURCE_UNAVAILABLE', at: input.at });
      this.factsBySession.delete(input.sessionId);
      this.transitionFinalizeBySession.delete(input.sessionId);
      return false;
    }
    resolveWorkSet.freezeStartOnce({
      householdId: input.householdId,
      bindingId: finalize.bindingId,
      decision,
    });
    // 3. 绑定行回读透传(frozen_start_seconds/start_basis;不二次历史覆盖)
    const binding = resolveWorkSet.findActiveBinding(input.householdId, input.sessionId, input.generation);
    this.startViewBySession.set(input.sessionId, {
      generation: input.generation,
      startBasis: (binding?.startBasis ?? decision.startBasis) as PlaybackSessionStartView['startBasis'],
      resumeDisposition: decision.disposition,
      resumeReason: decision.resumeReason,
    });
    this.presentationStartBySession.set(input.sessionId, {
      generation: input.generation,
      seconds: binding?.frozenStartSeconds ?? decision.startSeconds,
    });
    this.transitionFinalizeBySession.delete(input.sessionId);
    return true;
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
    // 010 起点形态(api.md §1;T043/T041):仅起点受跟踪的会话(在线 vod resolve)下发
    // —— preparing 未冻结 = pending,冻结后透传绑定行 basis 与决策处置;NAS/IPTV/直播
    // 会话不携带,既有 DTO 键面零变化(004/005 契约回归)
    const startView = this.startViewBySession.get(session.id);
    const startViewFields =
      startView !== undefined && startView.generation === session.generation
        ? {
            startBasis: startView.startBasis,
            resumeDisposition: startView.resumeDisposition,
            resumeReason: startView.resumeReason,
          }
        : {};
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
      ...startViewFields,
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
