/**
 * 播放领域类型(T011,spec 004)—— 状态机枚举、合法迁移表、稳定失败码与领域结果类型。
 *
 * - 字段/约束/状态机的单一权威:docs/specs/004-playback-resolver/data-model.md
 *   「## playback_session」「## playback_ticket」「## playback_conversion」「## playback_failure_event」;
 * - 稳定错误码清单:docs/specs/004-playback-resolver/contracts/api.md 错误节(PLAYBACK_* 前缀);
 * - 本文件只承载类型与纯函数,不依赖 env / 数据库,可被仓储与后续服务层共享;
 * - shared 的 ProblemCode 尚未包含 PLAYBACK_*(T012 接入),此处先以本联合类型为准,
 *   T012 接入时值逐一对照,不新增不改名。
 */

/** 会话状态(playback_session.state;DDL CHECK 同枚举) */
export type PlaybackSessionState =
  | 'preparing'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'failed'
  | 'interrupted';

/** 活动态:尚未进入终态,可继续迁移/签票 */
export const PLAYBACK_ACTIVE_SESSION_STATES = ['preparing', 'ready', 'playing', 'paused'] as const;
/** 终态:不可复活(data-model:终态不可复活) */
export const PLAYBACK_TERMINAL_SESSION_STATES = ['ended', 'failed', 'interrupted'] as const;

export type PlaybackActiveSessionState = (typeof PLAYBACK_ACTIVE_SESSION_STATES)[number];
export type PlaybackTerminalSessionState = (typeof PLAYBACK_TERMINAL_SESSION_STATES)[number];

export function isPlaybackActiveSessionState(state: string): state is PlaybackActiveSessionState {
  return (PLAYBACK_ACTIVE_SESSION_STATES as readonly string[]).includes(state);
}

export function isPlaybackTerminalSessionState(state: string): state is PlaybackTerminalSessionState {
  return (PLAYBACK_TERMINAL_SESSION_STATES as readonly string[]).includes(state);
}

/** 交付模式(playback_session.delivery;direct 不建转换行、不占转换额度) */
export const PLAYBACK_DELIVERIES = ['direct', 'hls_proxy', 'remux', 'audio_transcode', 'video_transcode'] as const;
export type PlaybackDelivery = (typeof PLAYBACK_DELIVERIES)[number];

export function isPlaybackDelivery(value: string): value is PlaybackDelivery {
  return (PLAYBACK_DELIVERIES as readonly string[]).includes(value);
}

/** 转换模式(playback_conversion.mode;remux 与转码共用全局额度) */
export const PLAYBACK_CONVERSION_MODES = ['remux', 'audio_transcode', 'video_transcode'] as const;
export type PlaybackConversionMode = (typeof PLAYBACK_CONVERSION_MODES)[number];

/** 转换状态(playback_conversion.state) */
export type PlaybackConversionState =
  | 'reserved'
  | 'probing'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'ended'
  | 'failed'
  | 'interrupted';

/** 计入全局转换额度的状态:全部 reserved～stopping(data-model:BEGIN IMMEDIATE 内按此集合计数) */
export const PLAYBACK_CONVERSION_ACTIVE_STATES = [
  'reserved',
  'probing',
  'starting',
  'running',
  'stopping',
] as const;

/**
 * 会话合法迁移表 —— 唯一权威:data-model「## playback_session」:
 * preparing→ready/failed/ended/interrupted;ready→playing/paused;playing↔paused;
 * ready/playing/paused→preparing(seek/需重建输出的换轨);任一活动态→ended/failed/interrupted;
 * 终态空表(不可复活)。preparing 拒绝第二次 seek/selection(不迁 preparing 自身)。
 * 不入表的状态对(如 preparing→playing 直跳、ready→ready)一律拒绝。
 */
export const PLAYBACK_SESSION_TRANSITIONS: Readonly<
  Record<PlaybackSessionState, readonly PlaybackSessionState[]>
> = {
  preparing: ['ready', 'failed', 'ended', 'interrupted'],
  ready: ['playing', 'paused', 'preparing', 'ended', 'failed', 'interrupted'],
  playing: ['paused', 'preparing', 'ended', 'failed', 'interrupted'],
  paused: ['playing', 'preparing', 'ended', 'failed', 'interrupted'],
  ended: [],
  failed: [],
  interrupted: [],
};

export function isPlaybackSessionTransition(from: PlaybackSessionState, to: PlaybackSessionState): boolean {
  return PLAYBACK_SESSION_TRANSITIONS[from].includes(to);
}

/**
 * 转换合法迁移表(spawn 前可选 probing;退出必须先 stopping 再 ended;失败/中断可从任一
 * 非终态直接进入;终态空表)。SIGTERM 后确认退出才标 ended(T025/T028 语义)。
 */
export const PLAYBACK_CONVERSION_TRANSITIONS: Readonly<
  Record<PlaybackConversionState, readonly PlaybackConversionState[]>
> = {
  reserved: ['probing', 'starting', 'failed', 'interrupted'],
  probing: ['starting', 'failed', 'interrupted'],
  starting: ['running', 'failed', 'interrupted'],
  running: ['stopping', 'failed', 'interrupted'],
  stopping: ['ended', 'failed', 'interrupted'],
  ended: [],
  failed: [],
  interrupted: [],
};

export function isPlaybackConversionTransition(from: PlaybackConversionState, to: PlaybackConversionState): boolean {
  return PLAYBACK_CONVERSION_TRANSITIONS[from].includes(to);
}

/**
 * 稳定失败码(contracts/api.md 错误节):既用于 409/422/503/504 响应映射(T012),
 * 也作为 playback_session.failure_code / playback_conversion.failure_code /
 * playback_failure_event.stable_code 的唯一合法词表。
 */
export const PLAYBACK_STABLE_ERROR_CODES = [
  'PLAYBACK_NOT_READY',
  'PLAYBACK_VERSION_CONFLICT',
  'PLAYBACK_GENERATION_STALE',
  'PLAYBACK_ENDED',
  'PLAYBACK_CONVERSION_BUSY',
  'PLAYBACK_STORAGE_LIMIT',
  'PLAYBACK_PERFORMANCE_INSUFFICIENT',
  'PLAYBACK_RESOURCE_UNAVAILABLE',
  'PLAYBACK_PREPARE_TIMEOUT',
  'PLAYBACK_SEEK_TIMEOUT',
  'PLAYBACK_FORMAT_UNSUPPORTED',
  'PLAYBACK_NOT_FOUND',
  'PLAYBACK_TICKET_INVALID',
  'PLAYBACK_TICKET_EXPIRED',
  'PLAYBACK_SELECTION_INVALID',
  'PLAYBACK_SEEK_UNSUPPORTED',
  'PLAYBACK_RATE_LIMITED',
] as const;

export type PlaybackErrorCode = (typeof PLAYBACK_STABLE_ERROR_CODES)[number];

export function isPlaybackStableErrorCode(value: string): value is PlaybackErrorCode {
  return (PLAYBACK_STABLE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * 领域结果类型:ok/err 判别联合。仓储层不抛领域异常 —— 调用方(服务层)据 code
 * 映射 contracts/api.md 稳定错误;编程性错误(违反内部约定,如非稳定失败码)仍抛 Error。
 */
export interface PlaybackOk<T> {
  readonly ok: true;
  readonly value: T;
}

export interface PlaybackErr {
  readonly ok: false;
  readonly code: PlaybackErrorCode;
  /** 仅含稳定业务语义的补充说明;禁止携带源 URL/物理路径/凭据等内部信息 */
  readonly detail?: string;
}

export type PlaybackResult<T> = PlaybackOk<T> | PlaybackErr;

export function playbackOk<T>(value: T): PlaybackOk<T> {
  return { ok: true, value };
}

export function playbackErr(code: PlaybackErrorCode, detail?: string): PlaybackErr {
  return { ok: false, code, detail };
}

/**
 * 终态守卫的稳定拒绝码映射(集中一处):
 * ended → PLAYBACK_ENDED(优雅结束);failed/interrupted → PLAYBACK_NOT_READY(会话不可恢复交付)。
 */
export function terminalGuardCode(state: PlaybackSessionState): PlaybackErrorCode | null {
  if (state === 'ended') return 'PLAYBACK_ENDED';
  if (state === 'failed' || state === 'interrupted') return 'PLAYBACK_NOT_READY';
  return null;
}

/** 会话 CAS 基准:expectedVersion 必填;expectedGeneration 在换代敏感路径(renew/seek)必填 */
export interface PlaybackCas {
  readonly expectedVersion: number;
  readonly expectedGeneration?: number;
}

/**
 * 会话对外视图:刻意排除 playback_source_id —— 内部源标识不外泄
 * (contracts/api.md:GET 状态不泄漏源 ID/位置;仓储绝不返回内部位置信息)。
 * profileContextVersion 仅供服务层重验(T051 上下文绑定),不进入对外 DTO。
 */
export interface PlaybackSessionView {
  readonly id: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly state: PlaybackSessionState;
  readonly delivery: PlaybackDelivery | null;
  readonly generation: number;
  readonly version: number;
  readonly positionSeconds: number;
  readonly audioTrackId: string | null;
  readonly subtitleTrackId: string | null;
  readonly desiredPaused: boolean;
  /** resolve 时捕获的 DeviceSession 身份上下文版本(005 §5;DTO 不下发) */
  readonly profileContextVersion: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly lastHeartbeatAt: string;
  readonly failureCode: string | null;
}

/** 票据视图:只含元数据;明文 ticket 与 hash 均不回传(hash 由签发方自持) */
export interface PlaybackTicketView {
  readonly id: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly generation: number;
  readonly revokedAt: string | null;
}

/** 转换记录视图:输入/输出路径本就不入行,不存在泄漏面 */
export interface PlaybackConversionView {
  readonly id: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly mode: PlaybackConversionMode;
  readonly state: PlaybackConversionState;
  readonly hardwareBackend: string | null;
  readonly outputVideoCodec: string;
  readonly outputAudioCodec: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly failureCode: string | null;
  readonly cleanupState: string;
  readonly bytesOnDisk: number;
  readonly lastProgressAt: string | null;
}

/** 失败事件视图 */
export interface PlaybackFailureEventView {
  readonly id: string;
  readonly householdId: string;
  readonly occurredAt: string;
  readonly stableCode: PlaybackErrorCode;
}

/**
 * createSession 输入:身份绑定四元组一经写入不可变;家庭内启用资源预校验由调用方负责。
 * profileContextVersion(005 data-model §2):resolve 时从可信 DeviceSession 捕获,
 * 服务端事实(005 契约:不接受客户端身份/位置声明);此后不可变。
 */
export interface CreateSessionInput {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly mediaId: string;
  /** 授权时刻 DeviceSession 的 profile_context_version(≥1;捕获即冻结;缺省 1 = 初始上下文) */
  readonly profileContextVersion?: number;
  /** 缺省由仓储生成 crypto.randomUUID()(服务端生成 ID) */
  readonly id?: string;
  /** 缺省 now(UTC ISO-8601);测试/服务层可注入确定时钟 */
  readonly at?: string;
}

/** heartbeat 输入:位置推进与暂停意图随心跳更新;绝不递增 version/generation */
export interface HeartbeatInput {
  readonly cas: PlaybackCas;
  readonly positionSeconds?: number;
  readonly desiredPaused?: boolean;
  readonly at?: string;
}

/** preparing→ready:必须同时确定源与交付模式(CHECK 活动态非空;禁止补造) */
export interface MarkReadyInput {
  readonly cas: PlaybackCas;
  readonly playbackSourceId: string;
  readonly delivery: PlaybackDelivery;
  readonly audioTrackId?: string;
  readonly subtitleTrackId?: string;
  readonly at?: string;
}

export interface MarkPlayingInput {
  readonly cas: PlaybackCas;
  readonly at?: string;
}

export interface MarkPausedInput {
  readonly cas: PlaybackCas;
  readonly at?: string;
}

/** seek/需重建输出的换轨:generation 与 version 各 +1,保留 desired_paused 与已选定源 */
export interface BeginRebuildInput {
  readonly cas: PlaybackCas;
  readonly positionSeconds?: number;
  readonly audioTrackId?: string;
  readonly subtitleTrackId?: string;
  readonly at?: string;
}

/** 纯字幕切换:仅 version +1(generation/状态不变,不重建输出) */
export interface SubtitleSwitchInput {
  readonly cas: PlaybackCas;
  readonly subtitleTrackId: string;
  readonly at?: string;
}

export interface EndSessionInput {
  readonly cas: PlaybackCas;
  readonly at?: string;
}

export interface FailSessionInput {
  readonly cas: PlaybackCas;
  readonly failureCode: PlaybackErrorCode;
  readonly at?: string;
}

export interface MarkInterruptedInput {
  readonly cas: PlaybackCas;
  readonly at?: string;
}

/** 签票输入:仅收 hash(明文 256bit ticket 不入库);TTL 由票据服务按预算计算 */
export interface IssueTicketInput {
  readonly expectedGeneration: number;
  readonly tokenHash: string;
  /** 正整数秒;expires_at = issued_at + ttl(CHECK expires_at > issued_at) */
  readonly ttlSeconds: number;
  readonly id?: string;
  readonly at?: string;
}

/** 过期票清理输入(24h 保留期内不清,契约:过期票 24 小时内清除) */
export interface DeleteExpiredTicketsInput {
  readonly now: string;
  readonly retentionSeconds: number;
}

/** reserve 输入:预留前计划必须已完成(mode/输出编码确定) */
export interface ReserveConversionInput {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly mode: PlaybackConversionMode;
  /** 非空服务器输出编码标识;'none' 合法(静音合法视频),不设枚举 */
  readonly outputVideoCodec: string;
  readonly outputAudioCodec: string;
  readonly id?: string;
  readonly at?: string;
}

export interface MarkConversionInput {
  readonly conversionId: string;
  readonly householdId: string;
  readonly state: PlaybackConversionState;
  /** 硬件后端标识:probe/启动阶段确定后可补记 */
  readonly hardwareBackend?: string;
  /** 仅 state='failed' 时必填且必须为稳定码 */
  readonly failureCode?: PlaybackErrorCode;
  readonly at?: string;
}

/** 确认退出后的释放路径:仅允许落入终态(额度自 state 离开 reserved～stopping 起释放) */
export type PlaybackTerminalConversionState = Extract<PlaybackConversionState, 'ended' | 'failed' | 'interrupted'>;

export interface ReleaseOnExitInput {
  readonly finalState: PlaybackTerminalConversionState;
  readonly failureCode?: PlaybackErrorCode;
  readonly at?: string;
}

export interface RecordFailureEventInput {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId?: string;
  /** 媒体不属于该家庭或不可见时省略(不存客户端原始目标 ID) */
  readonly mediaId?: string;
  readonly stableCode: PlaybackErrorCode;
  readonly id?: string;
  readonly at?: string;
}
