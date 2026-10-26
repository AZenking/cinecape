/**
 * 播放会话状态机 hook(T053,US3)——自 MediaPlayer 抽取的会话核心。
 *
 * 职责(docs/specs/004-playback-resolver/tasks.md T053 + contracts/api.md「异步失败与兼容」
 * + research.md R8/R9):
 * - 起播链:resolvePlayback → 每 1s 轮询 GET session(abortable)至 ready/终态 → ready 后
 *   立即 renewPlayback 取首票(playbackUrl 携带 opaque ticket,同源相对路径)→ 经 videoRef
 *   指向的媒体元素交付分派(direct 原生 / hls.js 完整构建 / Safari 原生 HLS,轮换见 R8);
 * - 续期:距 ticketExpiresAt 前 PLAYBACK_RENEW_LEAD_SECONDS(60s)renew,
 *   expectedGeneration=当前 generation;成功同 session/generation 换票不断流;稳定失败
 *   (GENERATION_STALE/ENDED/授权失效)→ 停止并显示 PLAYBACK_ERROR_LABELS 文案,不无限重试;
 * - 心跳:15s 间隔 heartbeatPlayback(positionSeconds=影片逻辑时间,paused),暂停继续;
 *   停止/失败/卸载即停;连续多次瞬时网络失败有界停止(心跳即活性信号,不无限重试);
 * - stop/cancel/unmount(T053):fire-and-forget stopPlayback(幂等 204)+ 本地资源释放
 *   (abort 在途、清全部定时器、销毁 hls、移除媒体 src),全部随 hook 生命周期清理;
 * - seek/selection(T053,US3-05/US3-07):mediaApi.seek/selectTracks 意图 → 发送前递增
 *   本地 operationEpoch → api 调用(expectedVersion=当前 version CAS)→ 受理响应
 *   preparing(挂起:停 hls 分片加载、抑制旧票媒体错误)→ 轮询接回 ready → 以新
 *   generation renew 新代票继续;409 竞态族(GENERATION_STALE/VERSION_CONFLICT/
 *   PLAYBACK_ENDED/NOT_READY)与其余稳定码/网络失败一律丢弃意图,不破坏当前播放
 *   (会话真终态由心跳/续期既有失败链按稳定码收敛);纯字幕切换(不换代)现票仍有效,
 *   仅刷新会话核心不中断播放;
 * - operationEpoch 守卫(契约权威:api.md「异步失败与兼容」):每次发起 seek/selection
 *   前先递增本地 epoch;响应(含 renew)只有「请求发起时的 epoch 仍等于当前 epoch 且
 *   session/generation 链一致」才可安装——旧请求即便返回 200/新 generation 也整体丢弃,
 *   不落会话核心、不驱动轮询/续期参数,停止成功或失权后旧响应不能复活播放;
 * - 安全:ticket/playbackUrl/ticketExpiresAt 只存本 hook 内存 ref,不写 localStorage/
 *   sessionStorage/日志;播放地址不含源信息(契约保证同源相对路径)。
 *
 * runId 代次守卫(retry/mediaId 变化/卸载)与 operationEpoch 守卫分层:runId 作废整个
 * 旧会话语境的全部在途响应(US3-05 档案切换销毁);operationEpoch 只串代同一会话内的
 * seek/selection 操作(US3-07 seek 交错)。hook 不持有 React 渲染树,媒体元素由消费方
 * (MediaPlayer)经返回的 videoRef 挂载,媒体事件由 hook 自行监听驱动相位迁移。
 *
 * T048 浏览器场景对照(quickstart.md「US3 浏览器场景清单」):
 * - US3-01 起播全链:resolve 201 → 1s 轮询 → ready → renew 取票 → 入口带 ticket(run());
 * - US3-03 准备/取消/超时:preparing 相位与轮询;controller.stop() 取消(stop 204 幂等);
 * - US3-04 失败重试:failed + failureCode → PLAYBACK_ERROR_LABELS 文案;不自动重试,
 *   controller.retry()/mediaApi.retry() 重开新 resolve(新 session id);
 * - US3-05 档案切换销毁:mediaId 变化/卸载 → stopNow()(abort+清定时器+hls.destroy+
 *   移除媒体+补发 stop),旧 runId 的在途响应(含旧 epoch 的 renew/seek)一律丢弃;
 * - US3-06 续期连续性:到期前 60s renew;hls.js loadSource(新入口)+startLoad(当前位置)
 *   续载;原生 HLS/direct 换 src + loadedmetadata 恢复 currentTime(R8 轮换);
 * - US3-07 seek:mediaApi.seek → epoch++ → 200 preparing+新 generation(无票)→ 轮询
 *   ready → 新代 renew;恢复点=目标位置换算媒体时间(positionSeconds-timelineOffset,
 *   不闪回目标前画面);交错 seek/换轨按 epoch 丢弃旧响应;
 * - US3-08 字幕/音轨:mediaApi.selectTracks(未提供的轴回落最近意图→default→首个已探测);
 * - US3-10 停止/失联:卸载/自然结束 fire-and-forget stopPlayback;15s 心跳为活性信号,
 *   连续失败有界停止,旧响应不复活任何播放。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import Hls from 'hls.js';
import { ApiError, PLAYBACK_ERROR_LABELS, PLAYBACK_RENEW_LEAD_SECONDS, api } from '../../lib/api';
import type { PlaybackDto, PlaybackDelivery, PlaybackTracks, TicketReply } from '@hmp/shared';

/* ---------------------------------- 常量 ---------------------------------- */

/** 会话准备轮询间隔:1 秒(任务约束;abortable,卸载/换代即止) */
const SESSION_POLL_INTERVAL_MS = 1000;

/** 播放心跳间隔:15 秒(契约「每 15 秒一次」;暂停期间继续) */
const HEARTBEAT_INTERVAL_MS = 15000;

/** 到期前提前续期毫秒(自 api.ts 契约常量换算) */
const RENEW_LEAD_MS = PLAYBACK_RENEW_LEAD_SECONDS * 1000;

/** 票默认 TTL 兜底毫秒(契约默认 5 分钟;ticketExpiresAt 解析失败时的防御值) */
const DEFAULT_TICKET_TTL_MS = 300_000;

/**
 * preparing 轮询防御上限:180 秒。服务端预算(R8)为初始化 30s/seek 15s,正常远早于
 * 此返回;此上限仅防服务端回归导致的无限「准备中」,超限按 PLAYBACK_PREPARE_TIMEOUT 停止。
 */
const PREPARING_POLL_BUDGET_MS = 180_000;

/** 续期瞬时网络失败的立即重试上限:1 次(旧票到期前仍有效;再失败即停止,不无限重试) */
const RENEW_TRANSIENT_RETRY_DELAY_MS = 2000;

/** 心跳连续瞬时失败容忍上限:达到即停止(≈45s 失联,与 FR-019 服务端有界回收同量级) */
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 3;

/** 未知/无稳定码时的兜底文案(不含技术细节/源信息) */
const PLAYBACK_FALLBACK_MESSAGE = '播放出现问题，请重新开始播放。';

/* ---------------------------------- 对外类型 ---------------------------------- */

/** 播放器可理解状态(UI 视角;与服务端 PlaybackSessionState 解耦的六态) */
export type MediaPlayerPhase = 'preparing' | 'ready' | 'playing' | 'paused' | 'failed' | 'ended';

/** 实际使用的交付通道(经 delivery 与浏览器能力判定;null=尚未交付) */
export type MediaPlayerEngine = 'direct' | 'native-hls' | 'hls.js';

/** 状态快照(随 phase 变化经 onStateChange 抛给父级;不含 ticket/playbackUrl) */
export interface MediaPlayerState {
  phase: MediaPlayerPhase;
  /** 服务端播放会话 id(对照记录用;不含票) */
  sessionId: string | null;
  /** 会话编辑 version(CAS;selection/seek 请求由 hook 内部携带) */
  version: number | null;
  /** 会话代次 generation */
  generation: number | null;
  /** 契约交付模式(探测完成前 null) */
  delivery: PlaybackDelivery;
  /** 实际播放通道 */
  engine: MediaPlayerEngine | null;
  /** 影片逻辑时长(直播为 null) */
  durationSeconds: number | null;
  /** 当前影片逻辑位置(秒;timelineOffsetSeconds 换算后) */
  positionSeconds: number;
  /** 目标前跳过区间(秒;>0 表示当前交付需跳过目标前画面,seek 提示判定用) */
  presentationStartSeconds: number;
  /** 服务器保留的暂停意图 */
  desiredPaused: boolean;
  /** 已探测轨道(供字幕关闭/选择与音轨切换菜单) */
  tracks: PlaybackTracks;
  /** 失败稳定码(仅 failed) */
  failureCode: string | null;
  /** 失败友好文案(PLAYBACK_ERROR_LABELS 映射;仅 failed/ended) */
  failureMessage: string | null;
}

/** 命令句柄(挂载后经 onController 交给消费方;控件层播放/暂停/取消/重试) */
export interface MediaPlayerController {
  /** 失败后重试:重新 resolve 新会话(组件自身不自动重试;US3-04) */
  retry(): void;
  /** 主动停止/取消:fire-and-forget stopPlayback + 本地释放(US3-03/US3-10) */
  stop(): void;
  /** 当前影片逻辑位置(秒;进度条/seek 入参换算用) */
  getLogicalPosition(): number;
  /** 继续播放(媒体元素 play;仅 ready/playing/paused 有效) */
  play(): void;
  /** 暂停播放(媒体元素 pause;仅 ready/playing/paused 有效) */
  pause(): void;
}

/**
 * 播放操作面(T053):seek/selection 竞态接线由本 hook 实现——发送前递增
 * operationEpoch、expectedVersion CAS、受理 preparing 挂起与轮询接回、409 竞态族
 * 丢弃意图。消费方(详情页)只需转发控件层意图,不再自行调 api/记账 version。
 */
export interface PlaybackMediaApi {
  /** seek 意图:目标影片逻辑秒(直播不支持由服务端 400 稳定码兜底) */
  seek(logicalPositionSeconds: number): void;
  /** 换轨/字幕意图:未提供的轴保持现值;字幕 null=关闭 */
  selectTracks(audioTrackId?: string, subtitleTrackId?: string | null): void;
  /** 主动停止/取消(同 controller.stop) */
  stop(): void;
  /** 失败后重试(同 controller.retry) */
  retry(): void;
}

export interface UsePlaybackSessionOptions {
  /** 状态变化回调(phase 迁移与失败原因;不随 timeupdate 高频触发) */
  onStateChange?: (state: MediaPlayerState) => void;
  /** 命令句柄回调:挂载后交出 controller,卸载时交出 null */
  onController?: (controller: MediaPlayerController | null) => void;
  /** 播放操作面回调:挂载后交出 mediaApi,卸载时交出 null(T053) */
  onMediaApi?: (mediaApi: PlaybackMediaApi | null) => void;
}

export interface UsePlaybackSessionResult {
  /** 当前状态快照(渲染用;随相位迁移更新) */
  state: MediaPlayerState;
  /** 命令句柄(恒定实例) */
  controller: MediaPlayerController;
  /** 播放操作面(恒定实例;T053) */
  mediaApi: PlaybackMediaApi;
  /** 媒体元素挂载点:消费方渲染 <video ref={videoRef}>,hook 负责交付与事件监听 */
  videoRef: RefObject<HTMLVideoElement | null>;
}

/* ---------------------------------- 内部类型 ---------------------------------- */

/** 会话核心(仅内存;version/generation/轨道/时间轴随轮询刷新) */
interface SessionCore {
  sessionId: string;
  version: number;
  generation: number;
  delivery: PlaybackDelivery;
  durationSeconds: number | null;
  timelineOffsetSeconds: number;
  presentationStartSeconds: number;
  positionSeconds: number;
  desiredPaused: boolean;
  tracks: PlaybackTracks;
}

/** 当前票(仅内存 ref;禁止写 localStorage/sessionStorage 或日志) */
interface ActiveTicket {
  playbackUrl: string;
  expiresAtMs: number;
  generation: number;
}

/** 定时器槽位(轮询休眠/续期/心跳;卸载与失败统一清理) */
interface PlaybackTimers {
  poll?: ReturnType<typeof setTimeout>;
  renew?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setTimeout>;
}

/**
 * 操作语境(seek/selection 请求发起时的快照;T053 epoch 守卫依据):
 * 响应可安装的条件=epoch 仍为当前、会话 id 与发起时代次链一致。
 */
interface OperationContext {
  /** 发送前递增后的本地 operationEpoch */
  epoch: number;
  /** 发起时的会话 id */
  sessionId: string;
  /** 发起时的会话代次(链一致性基准) */
  generation: number;
}

/** 空轨道表(tracks 探测未完成时契约即为空数组) */
const EMPTY_TRACKS: PlaybackTracks = { audio: [], subtitles: [] };

/* ---------------------------------- 纯工具 ---------------------------------- */

/** 稳定码 → 友好文案;未知码/无码统一兜底,不显示技术细节 */
function friendlyPlaybackMessage(code: string | null): string {
  if (code !== null && code in PLAYBACK_ERROR_LABELS) {
    return PLAYBACK_ERROR_LABELS[code as keyof typeof PLAYBACK_ERROR_LABELS];
  }
  return PLAYBACK_FALLBACK_MESSAGE;
}

/** fetch 在途中止抛出的 AbortError(取消按静默处理,不算失败) */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** PlaybackDto → 会话核心(轮询各拍增量刷新) */
function coreFromDto(dto: PlaybackDto): SessionCore {
  return {
    sessionId: dto.id,
    version: dto.version,
    generation: dto.generation,
    delivery: dto.delivery,
    durationSeconds: dto.durationSeconds,
    timelineOffsetSeconds: dto.timelineOffsetSeconds,
    presentationStartSeconds: dto.presentationStartSeconds,
    positionSeconds: dto.positionSeconds,
    desiredPaused: dto.desiredPaused,
    tracks: dto.tracks,
  };
}

/** 相位是否可发起 seek/selection 等播放操作(preparing/终态一律不可) */
function isPlayablePhase(phase: MediaPlayerPhase): boolean {
  return phase === 'ready' || phase === 'playing' || phase === 'paused';
}

/**
 * 交付形态判定(任务约束的确定性顺序):
 * direct → MP4 原生;HLS 系四态 → Hls.isSupported() 优先 hls.js 完整构建;
 * 否则 Safari 原生 HLS 探测;均不可用返回 null(调用方按 PLAYBACK_FORMAT_UNSUPPORTED 停止)。
 */
function resolveEngine(delivery: PlaybackDelivery): MediaPlayerEngine | null {
  if (delivery === null) {
    return null;
  }
  if (delivery === 'direct') {
    return 'direct';
  }
  if (Hls.isSupported()) {
    return 'hls.js';
  }
  const probe = document.createElement('video');
  if (probe.canPlayType('application/vnd.apple.mpegurl') !== '') {
    return 'native-hls';
  }
  return null;
}

/* ---------------------------------- hook ---------------------------------- */

export function usePlaybackSession(
  mediaId: string,
  options: UsePlaybackSessionOptions = {},
): UsePlaybackSessionResult {
  const { onStateChange, onController, onMediaApi } = options;

  /* ---- DOM/实例引用 ---- */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  /* ---- 会话/票核心(仅内存) ---- */
  const sessionRef = useRef<SessionCore | null>(null);
  const ticketRef = useRef<ActiveTicket | null>(null);
  const engineRef = useRef<MediaPlayerEngine | null>(null);

  /* ---- 运行控制 ---- */
  /** 会话代次:retry/mediaId 变化/卸载即 +1,旧代次全部在途响应作废(US3-05) */
  const runIdRef = useRef(0);
  const disposedRef = useRef(false);
  /** 当前代次在途请求的取消信号 */
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<PlaybackTimers>({});
  /** 本地是否仍有活动会话(决定卸载/重试时是否补发 stop) */
  const activeRef = useRef(false);
  /** 媒体元素入口轮换中(抑制 load() 引发的 pause 事件误报为用户暂停) */
  const rotatingRef = useRef(false);
  /** 原生 HLS/direct 轮换的待恢复位置(R8:恢复逻辑位置) */
  const pendingRestoreRef = useRef<{ time: number; resumePlayback: boolean } | null>(null);
  /** hls.js 媒体错误限一次恢复(R8:已开始交付后不做隐藏无限重试) */
  const mediaErrorRecoveredRef = useRef(false);
  const renewRetriedRef = useRef(false);
  const heartbeatInFlightRef = useRef(false);
  const heartbeatFailuresRef = useRef(0);
  /**
   * seek/selection 受理后的准备挂起标记(T053):旧票已废、新票未到,期间旧入口的
   * 媒体错误(旧 ticket 分片 401/404)按预期竞态抑制,失败链由轮询/心跳收敛。
   */
  const transitioningRef = useRef(false);
  /** seek/换轨受理响应指定的轮换恢复点(目标位置换算的媒体时间;轮换时消费) */
  const operationRestoreRef = useRef<number | null>(null);
  /**
   * 本地 operationEpoch(T053 契约权威):每次发送 seek/selection 前递增;renew 请求
   * 发起时快照;响应只有 epoch 仍匹配且 session/generation 链一致才可安装。
   */
  const operationEpochRef = useRef(0);
  /** 续期在途标记与发起时 epoch(防止重复签发/安装交错响应) */
  const renewInFlightRef = useRef(false);
  const renewEpochRef = useRef(0);
  /** 最近一次换轨意图(SelectionRequest 双轴必填:未变化的轴回落该值;新会话即作废) */
  const lastAudioTrackIdRef = useRef<string | null>(null);
  const lastSubtitleTrackIdRef = useRef<string | null | undefined>(undefined);
  /** seek/selection 实现(主 effect 内装配;经稳定句柄转发) */
  const opsRef = useRef<{
    seek(logicalPositionSeconds: number): void;
    selectTracks(audioTrackId?: string, subtitleTrackId?: string | null): void;
  } | null>(null);

  /* ---- 渲染状态 ---- */
  const [phase, setPhase] = useState<MediaPlayerPhase>('preparing');
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const phaseRef = useRef<MediaPlayerPhase>('preparing');
  const failureCodeRef = useRef<string | null>(null);
  const failureMessageRef = useRef<string | null>(null);
  /** retry 令牌:驱动主 effect 重开新会话 */
  const [startToken, setStartToken] = useState(0);

  /* ---- 回调镜像(避免 effect/定时器闭包依赖回调身份) ---- */
  const onStateChangeRef = useRef(onStateChange);
  const onControllerRef = useRef(onController);
  const onMediaApiRef = useRef(onMediaApi);
  useEffect(() => {
    onStateChangeRef.current = onStateChange;
    onControllerRef.current = onController;
    onMediaApiRef.current = onMediaApi;
  });

  /** 影片逻辑位置:媒体时间 + timelineOffsetSeconds,已知 duration 时夹紧(契约「时间轴」) */
  const logicalPosition = useCallback((): number => {
    const session = sessionRef.current;
    const video = videoRef.current;
    const mediaTime =
      video !== null && Number.isFinite(video.currentTime)
        ? video.currentTime
        : (session?.positionSeconds ?? 0);
    const raw = mediaTime + (session?.timelineOffsetSeconds ?? 0);
    const clamped = Math.max(raw, 0);
    if (session?.durationSeconds != null) {
      return Math.min(clamped, session.durationSeconds);
    }
    return clamped;
  }, []);

  /** 构建状态快照(不含 ticket/playbackUrl 等敏感值) */
  const buildState = useCallback(
    (nextPhase: MediaPlayerPhase): MediaPlayerState => {
      const session = sessionRef.current;
      return {
        phase: nextPhase,
        sessionId: session?.sessionId ?? null,
        version: session?.version ?? null,
        generation: session?.generation ?? null,
        delivery: session?.delivery ?? null,
        engine: engineRef.current,
        durationSeconds: session?.durationSeconds ?? null,
        positionSeconds: logicalPosition(),
        presentationStartSeconds: session?.presentationStartSeconds ?? 0,
        desiredPaused: session?.desiredPaused ?? false,
        tracks: session?.tracks ?? EMPTY_TRACKS,
        failureCode: failureCodeRef.current,
        failureMessage: failureMessageRef.current,
      };
    },
    [logicalPosition],
  );

  /** 状态发射:同步 React 渲染态 + 快照回调 */
  const emit = useCallback(
    (next: MediaPlayerPhase): void => {
      phaseRef.current = next;
      setPhase(next);
      onStateChangeRef.current?.(buildState(next));
    },
    [buildState],
  );

  /** 释放本地资源:abort 在途请求、清全部定时器、销毁 hls、移除媒体、清票(不动 phase) */
  const releaseLocal = useCallback((): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    const timers = timersRef.current;
    for (const slot of ['poll', 'renew', 'heartbeat'] as const) {
      const timer = timers[slot];
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timers[slot] = undefined;
    }
    const hls = hlsRef.current;
    hlsRef.current = null;
    if (hls !== null) {
      hls.destroy();
    }
    ticketRef.current = null;
    engineRef.current = null;
    rotatingRef.current = false;
    pendingRestoreRef.current = null;
    operationRestoreRef.current = null;
    transitioningRef.current = false;
    renewInFlightRef.current = false;
    heartbeatInFlightRef.current = false;
    const video = videoRef.current;
    if (video !== null) {
      try {
        video.pause();
      } catch {
        // 元素已分离等场景:释放失败可忽略
      }
      // 移除入口并复位媒体元素:解码器/缓冲随元素释放(会话已终/将重开)
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // 无 src 的 load() 个别实现抛错:释放路径忽略
      }
    }
  }, []);

  /**
   * 终态收敛(失败/结束):停轮询/心跳/续期 + 释放,显示稳定码友好文案。
   * 幂等:已处于终态时忽略(多个失败源并发只收敛一次)。
   * 不补发 stop:稳定失败时会话已终态;瞬时失联交由服务端有界回收(FR-019)。
   */
  const fail = useCallback(
    (code: string | null, asEnded: boolean): void => {
      if (phaseRef.current === 'failed' || phaseRef.current === 'ended') {
        return;
      }
      activeRef.current = false;
      releaseLocal();
      const message = asEnded ? PLAYBACK_ERROR_LABELS.PLAYBACK_ENDED : friendlyPlaybackMessage(code);
      failureCodeRef.current = asEnded ? 'PLAYBACK_ENDED' : code;
      failureMessageRef.current = message;
      setFailureMessage(message);
      emit(asEnded ? 'ended' : 'failed');
    },
    [emit, releaseLocal],
  );

  /** 本地停止 + 补发 stop(fire-and-forget,幂等;卸载/重试清理/用户停止共用) */
  const stopNow = useCallback((): void => {
    const session = sessionRef.current;
    const wasActive = activeRef.current;
    activeRef.current = false;
    releaseLocal();
    if (session !== null && wasActive) {
      void api.stopPlayback(session.sessionId).catch(() => undefined);
    }
  }, [releaseLocal]);

  /** 用户主动停止/取消(控件取消与关闭播放器;US3-03 取消与 US3-10 停止) */
  const stopPlaybackSession = useCallback((): void => {
    if (phaseRef.current === 'failed' || phaseRef.current === 'ended') {
      return;
    }
    stopNow();
    failureCodeRef.current = 'PLAYBACK_ENDED';
    failureMessageRef.current = PLAYBACK_ERROR_LABELS.PLAYBACK_ENDED;
    setFailureMessage(failureMessageRef.current);
    emit('ended');
  }, [emit, stopNow]);

  /** 媒体元素播放/暂停(控件;仅活动会话且非 preparing/终态有效;play 被自动播放
   *  策略拦截时按现有 paused 事件收敛,不额外处理) */
  const controlPlayback = useCallback((action: 'play' | 'pause'): void => {
    const video = videoRef.current;
    if (video === null || !activeRef.current) {
      return;
    }
    const current = phaseRef.current;
    if (current === 'preparing' || current === 'failed' || current === 'ended') {
      return;
    }
    if (action === 'pause') {
      video.pause();
      return;
    }
    void video.play().catch(() => undefined);
  }, []);

  /* ---- 命令句柄与操作面(一次性创建;方法读 ref 恒取最新状态) ---- */
  const controllerRef = useRef<MediaPlayerController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = {
      retry: () => setStartToken((token) => token + 1),
      stop: () => stopPlaybackSession(),
      getLogicalPosition: () => logicalPosition(),
      play: () => controlPlayback('play'),
      pause: () => controlPlayback('pause'),
    };
  }
  const mediaApiRef = useRef<PlaybackMediaApi | null>(null);
  if (mediaApiRef.current === null) {
    mediaApiRef.current = {
      seek: (logicalPositionSeconds) => opsRef.current?.seek(logicalPositionSeconds),
      selectTracks: (audioTrackId, subtitleTrackId) =>
        opsRef.current?.selectTracks(audioTrackId, subtitleTrackId),
      stop: () => stopPlaybackSession(),
      retry: () => setStartToken((token) => token + 1),
    };
  }

  /** 挂载后交出句柄;卸载收回 */
  useEffect(() => {
    const controller = controllerRef.current;
    const mediaApi = mediaApiRef.current;
    if (controller !== null) {
      onControllerRef.current?.(controller);
    }
    if (mediaApi !== null) {
      onMediaApiRef.current?.(mediaApi);
    }
    return () => {
      onControllerRef.current?.(null);
      onMediaApiRef.current?.(null);
    };
  }, []);

  /* ------------- 主流程:resolve → 轮询 → 首票 → 交付 → 续期/心跳/操作 ------------- */
  useEffect(() => {
    disposedRef.current = false;
    const runId = ++runIdRef.current;
    abortRef.current = new AbortController();
    mediaErrorRecoveredRef.current = false;
    renewRetriedRef.current = false;
    renewInFlightRef.current = false;
    renewEpochRef.current = 0;
    heartbeatFailuresRef.current = 0;
    heartbeatInFlightRef.current = false;
    transitioningRef.current = false;
    operationRestoreRef.current = null;
    // 新会话:旧会话的换轨意图一并作废(SelectionRequest 双轴回落语义重置)
    lastAudioTrackIdRef.current = null;
    lastSubtitleTrackIdRef.current = undefined;
    sessionRef.current = null;
    ticketRef.current = null;
    failureCodeRef.current = null;
    failureMessageRef.current = null;
    setFailureMessage(null);
    emit('preparing');

    /** 代次守卫:非当前代次(已被 retry/换 id/卸载作废)一律丢弃 */
    const isCurrent = (): boolean => runId === runIdRef.current && !disposedRef.current;
    const signal = (): AbortSignal | undefined => abortRef.current?.signal;
    const clearSlot = (slot: keyof PlaybackTimers): void => {
      const timer = timersRef.current[slot];
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timersRef.current[slot] = undefined;
    };
    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        timersRef.current.poll = setTimeout(resolve, ms);
      });

    /** 失败收敛为 ApiError 稳定码/通用文案 */
    const failWith = (error: unknown): void => {
      fail(error instanceof ApiError ? (error.code ?? null) : null, false);
    };

    /* ---- 续期(到期前 60s;US3-06;T053 epoch 守卫) ---- */
    function renewTicket(force = false): Promise<void> {
      return (async () => {
        const session = sessionRef.current;
        if (session === null || !isCurrent()) {
          return;
        }
        // 准备挂起期(seek/换轨受理后)不接受例行续期:旧票已废,链由挂起流程自己续
        if (!force && transitioningRef.current) {
          return;
        }
        // 同代续期已在途:不重复签发(其自身会安装并调度下一轮)
        if (renewInFlightRef.current && renewEpochRef.current === operationEpochRef.current) {
          return;
        }
        const epoch = operationEpochRef.current;
        renewInFlightRef.current = true;
        renewEpochRef.current = epoch;
        try {
          const ticket = await api.renewPlayback(session.sessionId, {
            expectedGeneration: session.generation,
          });
          if (!isCurrent()) {
            return;
          }
          // epoch 守卫(T053):请求后被新 seek/selection 打断 → 响应整体作废
          // (不安装、不调度;新操作流程会以新语境自行续期)
          if (epoch !== operationEpochRef.current) {
            return;
          }
          // 契约守卫:不能只按响应 generation 判断;本地核心不一致即按代次过期停止
          if (ticket.generation !== sessionRef.current?.generation) {
            fail('PLAYBACK_GENERATION_STALE', false);
            return;
          }
          const hadTicket = ticketRef.current !== null;
          installTicket(ticket);
          deliver(ticket.playbackUrl, hadTicket);
          scheduleRenew();
          if (!hadTicket) {
            // 首票:会话已开始占用服务资源,立即起心跳 + 尝试起播(US3-10 活性信号)
            startHeartbeat();
            void attemptPlay();
          }
        } catch (error) {
          if (!isCurrent() || isAbortError(error)) {
            return;
          }
          if (error instanceof ApiError) {
            // 稳定失败(GENERATION_STALE/ENDED/授权失效/404):停止并显示原因,不无限重试
            fail(error.code ?? null, error.code === 'PLAYBACK_ENDED');
            return;
          }
          // 瞬时网络失败:旧票在到期前仍有效,限一次立即重试;再失败即停
          if (!renewRetriedRef.current) {
            renewRetriedRef.current = true;
            clearSlot('renew');
            timersRef.current.renew = setTimeout(() => {
              if (isCurrent()) {
                void renewTicket(true);
              }
            }, RENEW_TRANSIENT_RETRY_DELAY_MS);
            return;
          }
          fail(null, false);
        } finally {
          renewInFlightRef.current = false;
        }
      })();
    }

    /** 安装新票:仅内存 ref + 依到期时间调度下一次续期 */
    function installTicket(ticket: TicketReply): void {
      const expiresAtMs = Date.parse(ticket.ticketExpiresAt);
      ticketRef.current = {
        playbackUrl: ticket.playbackUrl,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + DEFAULT_TICKET_TTL_MS,
        generation: ticket.generation,
      };
      renewRetriedRef.current = false;
    }

    function scheduleRenew(): void {
      const ticket = ticketRef.current;
      if (ticket === null) {
        return;
      }
      clearSlot('renew');
      const delay = Math.max(0, ticket.expiresAtMs - Date.now() - RENEW_LEAD_MS);
      timersRef.current.renew = setTimeout(() => {
        if (isCurrent()) {
          void renewTicket();
        }
      }, delay);
    }

    /* ---- seek/selection 操作流程(T053;US3-07/US3-08) ---- */

    /**
     * 进入准备挂起:受理响应即权威新代,旧票立即失效——停 hls.js 分片加载(旧 ticket
     * 请求就此打住,已缓冲内容继续),计算轮换恢复点(目标位置换算媒体时间),抑制旧
     * 入口媒体错误直至新票交付;例行续期定时器同步撤销(挂起中 renew 必 409 NOT_READY)。
     */
    function enterTransition(): void {
      const session = sessionRef.current;
      transitioningRef.current = true;
      operationRestoreRef.current =
        session === null
          ? null
          : Math.max(
              session.positionSeconds - session.timelineOffsetSeconds,
              session.presentationStartSeconds,
            );
      clearSlot('renew');
      const hls = hlsRef.current;
      if (hls !== null) {
        hls.stopLoad();
      }
    }

    /**
     * seek/selection 受理响应安装(T053 权威守卫):仅当「请求发起时的 epoch 仍等于
     * 当前 epoch 且 session/generation 链一致」才写会话核心并驱动后续轮询/续期;
     * 旧请求即便返回 200/新 generation 也整体丢弃。
     */
    function installOperationResponse(dto: PlaybackDto, context: OperationContext): void {
      if (context.epoch !== operationEpochRef.current || !isCurrent()) {
        return; // 已有更新意图/会话已换代:本响应为旧代,不落任何状态
      }
      const session = sessionRef.current;
      if (
        session === null ||
        session.sessionId !== context.sessionId ||
        session.generation !== context.generation
      ) {
        return; // 会话/代次链不一致:不安装
      }
      // 安装:权威新 version/generation/时间轴/轨道/保留的暂停意图
      sessionRef.current = coreFromDto(dto);
      if (dto.state === 'preparing') {
        // seek/重建音轨:进入准备挂起,轮询接回 ready 后以新 generation renew
        enterTransition();
        emit('preparing');
        void resumeAfterOperation(session.sessionId);
        return;
      }
      // 不换代响应(纯字幕切换):现票仍有效,仅刷新快照,不中断播放
      emit(phaseRef.current);
    }

    /**
     * seek/selection 被拒(T053):409 竞态族(GENERATION_STALE/VERSION_CONFLICT/
     * PLAYBACK_ENDED/NOT_READY)与其余稳定码、网络瞬时失败一律丢弃意图,不在此直接
     * 终止播放;会话真终态(自然到期/失权)由心跳/续期的既有失败链按稳定码收敛。
     * 仅补排一张例行续期,归还被递增 epoch 可能打断的在途 renew(其响应必被 epoch
     * 守卫丢弃,不补排则票链断裂、到期后静默失流);补排走例行续期路径,失败语义与
     * US3-06 既有收敛一致。
     */
    function dropOperation(error: unknown, context: OperationContext): void {
      if (!isCurrent() || isAbortError(error)) {
        return;
      }
      if (context.epoch !== operationEpochRef.current) {
        return; // 已有更新意图接管,静默丢弃
      }
      if (!isPlayablePhase(phaseRef.current)) {
        return; // 非可播相(挂起/终态):续期链由挂起流程或终态收敛负责
      }
      if (!renewInFlightRef.current && timersRef.current.renew === undefined) {
        timersRef.current.renew = setTimeout(() => {
          if (isCurrent()) {
            void renewTicket();
          }
        }, 0);
      }
    }

    /** 挂起收敛:轮询至 ready/终态 → ready 后以新 generation renew 新代票继续 */
    async function resumeAfterOperation(sessionId: string): Promise<void> {
      const final = await pollUntilReady(sessionId);
      if (final === null || !isCurrent()) {
        return; // 轮询已按稳定码收敛失败,或代次已作废
      }
      if (final.state === 'failed') {
        // 失败终态(含 PLAYBACK_SEEK_TIMEOUT):稳定 failureCode → 友好文案
        fail(final.failureCode ?? null, false);
        return;
      }
      if (final.state !== 'ready') {
        // ended/interrupted(取消竞态):不签票,按结束处理
        fail(null, true);
        return;
      }
      emit('ready');
      await renewTicket(true);
    }

    /* ---- 交付(direct / 原生 HLS / hls.js;US3-01 首播与 US3-06 轮换) ---- */
    function deliver(url: string, rotate: boolean): void {
      // 新票交付即视为接管入口:旧入口的挂起期错误抑制窗口结束(此后错误均为新代
      // 真实错误);先行复位,保证任何分支都不遗留挂起态阻塞例行续期
      transitioningRef.current = false;
      const session = sessionRef.current;
      const video = videoRef.current;
      if (session === null || video === null) {
        return;
      }
      const engine = engineRef.current;
      if (engine === 'direct' || engine === 'native-hls') {
        if (rotate) {
          // 轮换(R8):优先采用操作(seek/换轨)指定的恢复点,续期沿用当前媒体时间;
          // 换入口 src 并在 loadedmetadata 恢复逻辑位置(US3-06 Safari 复验项)
          const operationTime = operationRestoreRef.current;
          operationRestoreRef.current = null;
          const resumeAt =
            operationTime ??
            (Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0);
          const resumePlayback = !video.paused && !video.ended;
          rotatingRef.current = true;
          pendingRestoreRef.current = { time: resumeAt, resumePlayback };
          video.src = url;
          video.load();
        } else {
          // 首播:入口 URL 即当前票(同源相对路径;响应头已有 no-referrer)
          video.src = url;
        }
      } else if (engine === 'hls.js') {
        let instance = hlsRef.current;
        if (instance === null) {
          // 完整构建默认入口(禁 hls.js/light,R1:音轨/字幕能力依赖完整版)
          instance = new Hls({ enableWorker: true, lowLatencyMode: false });
          hlsRef.current = instance;
          instance.attachMedia(video);
          instance.on(Hls.Events.ERROR, (_event, data) => {
            if (!isCurrent() || transitioningRef.current || !data.fatal) {
              return; // 非致命交给 hls.js 内部恢复;挂起期旧票错误按预期竞态抑制
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaErrorRecoveredRef.current) {
              // 媒体错误限一次 recoverMediaError,不无限重试(R8)
              mediaErrorRecoveredRef.current = true;
              instance?.recoverMediaError();
              return;
            }
            // 致命网络/其他错误:停止并显示通用原因;由 UI 层 retry 重开(US3-04)
            fail(null, false);
          });
        }
        // hls.js 1.7.x:loadSource 内部会先 stopLoad(loadingEnabled=false),
        // 之后必须显式 startLoad 才会恢复分片加载——轮换连续性即依赖此两点(US3-06)。
        const operationTime = operationRestoreRef.current;
        operationRestoreRef.current = null;
        const resumeAt = rotate
          ? (operationTime ?? (Number.isFinite(video.currentTime) ? video.currentTime : -1))
          : -1;
        instance.loadSource(url);
        instance.startLoad(resumeAt);
      }
      // engine === null 已在 ready 分支按 PLAYBACK_FORMAT_UNSUPPORTED 拦截,不达此处
    }

    /* ---- 心跳(15s;暂停继续;US3-10 活性信号) ---- */
    async function beat(): Promise<void> {
      const session = sessionRef.current;
      const video = videoRef.current;
      if (session === null || heartbeatInFlightRef.current) {
        return;
      }
      heartbeatInFlightRef.current = true;
      try {
        await api.heartbeatPlayback(session.sessionId, {
          positionSeconds: logicalPosition(),
          paused: video?.paused ?? true,
        });
        if (!isCurrent()) {
          return;
        }
        heartbeatFailuresRef.current = 0;
      } catch (error) {
        if (!isCurrent() || isAbortError(error)) {
          return;
        }
        if (error instanceof ApiError) {
          // 终态不可复活(409 PLAYBACK_ENDED)/会话失效(404):按稳定码停止并显示原因
          fail(error.code ?? null, error.code === 'PLAYBACK_ENDED');
          return;
        }
        // 瞬时网络失败:有界容忍,连续超限即停止(≈45s 失联,等同播放失败;不无限重试)
        heartbeatFailuresRef.current += 1;
        if (heartbeatFailuresRef.current >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES) {
          fail(null, false);
        }
      } finally {
        heartbeatInFlightRef.current = false;
      }
    }

    function startHeartbeat(): void {
      clearSlot('heartbeat');
      void beat();
      timersRef.current.heartbeat = setTimeout(() => {
        if (isCurrent()) {
          startHeartbeat();
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    /** 起播尝试:浏览器自动播放策略拦截(无近期手势)落为 paused,不算失败 */
    async function attemptPlay(): Promise<void> {
      const video = videoRef.current;
      if (video === null) {
        return;
      }
      try {
        await video.play();
      } catch (error) {
        if (!isCurrent() || isAbortError(error)) {
          return;
        }
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          if (phaseRef.current === 'ready') {
            emit('paused');
          }
        }
        // 其余 play() 异常(AbortError 等)由 hls/video error 事件统一处理
      }
    }

    /* ---- 准备轮询(1s;abortable;US3-01/US3-03/US3-07) ---- */
    function pollUntilReady(sessionId: string): Promise<PlaybackDto | null> {
      return (async () => {
        const deadline = Date.now() + PREPARING_POLL_BUDGET_MS;
        for (;;) {
          let dto: PlaybackDto;
          try {
            dto = await api.getPlaybackSession(sessionId, signal());
          } catch (error) {
            if (!isCurrent() || isAbortError(error)) {
              return null;
            }
            // 轮询失败:显示原因并停止,不无限重试(US3-03 超时/US3-04 失败)
            failWith(error);
            return null;
          }
          if (!isCurrent()) {
            return null;
          }
          // 每拍刷新会话核心(version/generation/tracks/duration 随探测增量就绪)
          sessionRef.current = coreFromDto(dto);
          if (dto.state !== 'preparing') {
            return dto;
          }
          if (Date.now() > deadline) {
            fail('PLAYBACK_PREPARE_TIMEOUT', false);
            return null;
          }
          await sleep(SESSION_POLL_INTERVAL_MS);
          if (!isCurrent()) {
            return null;
          }
        }
      })();
    }

    /* ---- 主流程(US3-01) ---- */
    function run(): Promise<void> {
      return (async () => {
        if (mediaId === '') {
          fail('MEDIA_NOT_FOUND', false);
          return;
        }
        try {
          const { dto } = await api.resolvePlayback(mediaId, signal());
          if (!isCurrent()) {
            return;
          }
          // 会话已建立(201 仅表示接受):立即记账,取消/卸载即可补发 stop(US3-03/05/10)
          sessionRef.current = coreFromDto(dto);
          activeRef.current = true;
          const final = await pollUntilReady(dto.id);
          if (final === null || !isCurrent()) {
            return;
          }
          if (final.state === 'failed') {
            // 失败终态:稳定 failureCode → 友好文案,不自动重试(US3-04)
            fail(final.failureCode ?? null, false);
            return;
          }
          if (final.state !== 'ready') {
            // ended/interrupted(如取消竞态):不签票,按结束处理
            fail(null, true);
            return;
          }
          const engine = resolveEngine(final.delivery);
          if (engine === null) {
            fail(final.delivery === null ? null : 'PLAYBACK_FORMAT_UNSUPPORTED', false);
            return;
          }
          engineRef.current = engine;
          emit('ready');
          // 首票:ready 后立即申请(契约),成功后经 deliver/scheduleRenew/startHeartbeat 收尾
          await renewTicket(true);
        } catch (error) {
          if (!isCurrent() || isAbortError(error)) {
            return;
          }
          failWith(error);
        }
      })();
    }

    /* ---- 操作入口(T053):发送前递增 epoch,语境快照随请求走 ---- */

    opsRef.current = {
      seek(logicalPositionSeconds: number): void {
        const session = sessionRef.current;
        if (session === null || !isCurrent() || !isPlayablePhase(phaseRef.current)) {
          return;
        }
        if (!Number.isFinite(logicalPositionSeconds)) {
          return;
        }
        // 目标夹紧到已知 duration(服务端对越界 position 返回 400 VALIDATION_FAILED)
        let target = Math.round(logicalPositionSeconds);
        target = Math.max(0, target);
        if (session.durationSeconds !== null && Number.isFinite(session.durationSeconds)) {
          target = Math.min(target, Math.max(session.durationSeconds, 0));
        }
        const context: OperationContext = {
          epoch: ++operationEpochRef.current,
          sessionId: session.sessionId,
          generation: session.generation,
        };
        api
          .seekPlayback(session.sessionId, {
            expectedVersion: session.version,
            positionSeconds: target,
          })
          .then((dto) => {
            installOperationResponse(dto, context);
          })
          .catch((error: unknown) => {
            dropOperation(error, context);
          });
      },
      selectTracks(audioTrackId?: string, subtitleTrackId?: string | null): void {
        const session = sessionRef.current;
        if (session === null || !isCurrent() || !isPlayablePhase(phaseRef.current)) {
          return;
        }
        if (audioTrackId !== undefined) {
          lastAudioTrackIdRef.current = audioTrackId;
        }
        if (subtitleTrackId !== undefined) {
          lastSubtitleTrackIdRef.current = subtitleTrackId;
        }
        // 双轴必填:未变化的轴回落「最近意图 → default → 首个已探测」(与控件层推断一致)
        const effectiveAudioId =
          lastAudioTrackIdRef.current ??
          session.tracks.audio.find((track) => track.default)?.id ??
          session.tracks.audio[0]?.id ??
          null;
        if (effectiveAudioId === null) {
          return; // 无已探测音轨可供引用(契约 400 防御;控件菜单为空时不可发起)
        }
        const context: OperationContext = {
          epoch: ++operationEpochRef.current,
          sessionId: session.sessionId,
          generation: session.generation,
        };
        api
          .selectTracks(session.sessionId, {
            expectedVersion: session.version,
            positionSeconds: logicalPosition(),
            audioTrackId: effectiveAudioId,
            subtitleTrackId: lastSubtitleTrackIdRef.current ?? null,
          })
          .then((dto) => {
            installOperationResponse(dto, context);
          })
          .catch((error: unknown) => {
            dropOperation(error, context);
          });
      },
    };

    void run();

    return () => {
      // 操作面随会话语境失效:旧代次意图无从发出(US3-05)
      opsRef.current = null;
      disposedRef.current = true;
      // 卸载/mediaId 变化/retry:停 + 补发 stop(US3-05/US3-10),旧代次在途响应作废
      stopNow();
    };
  }, [mediaId, startToken, emit, fail, stopNow]);

  /* ---------------- 媒体元素事件:phase 迁移与轮换恢复(hook 自行监听) ---------------- */

  /** 轮换恢复 + presentationStart 守卫(US3-06 恢复逻辑位置 / US3-07 跳过目标前区间) */
  const handleLoadedMetadata = useCallback((): void => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const floor = sessionRef.current?.presentationStartSeconds ?? 0;
    const restore = pendingRestoreRef.current;
    if (restore !== null) {
      pendingRestoreRef.current = null;
      rotatingRef.current = false;
      video.currentTime = Math.max(restore.time, floor);
      if (restore.resumePlayback) {
        void video.play().catch(() => undefined);
      }
      return;
    }
    if (floor > 0 && video.currentTime < floor) {
      video.currentTime = floor;
    }
  }, []);

  const handlePlaying = useCallback((): void => {
    // preparing(含 seek/换轨挂起)期间的迁移事件不覆盖挂起相位
    if (
      activeRef.current &&
      !rotatingRef.current &&
      phaseRef.current !== 'preparing' &&
      phaseRef.current !== 'failed' &&
      phaseRef.current !== 'ended'
    ) {
      emit('playing');
    }
  }, [emit]);

  const handlePause = useCallback((): void => {
    // load() 轮换、挂起相位与终态后的 pause 不视为用户暂停
    if (
      activeRef.current &&
      !rotatingRef.current &&
      phaseRef.current !== 'preparing' &&
      phaseRef.current !== 'failed' &&
      phaseRef.current !== 'ended'
    ) {
      emit('paused');
    }
  }, [emit]);

  /** 自然播完:补发 stop(会话收敛为 ended)后落终态(US3-10) */
  const handleEnded = useCallback((): void => {
    if (!activeRef.current) {
      return;
    }
    stopNow();
    failureCodeRef.current = 'PLAYBACK_ENDED';
    failureMessageRef.current = PLAYBACK_ERROR_LABELS.PLAYBACK_ENDED;
    setFailureMessage(failureMessageRef.current);
    emit('ended');
  }, [emit, stopNow]);

  /** 媒体元素错误(原生 HLS/direct 解码/加载失败):停止并显示通用原因,不自动重试;
   *  挂起期(seek/换轨已受理、旧票已废)旧入口错误按预期竞态抑制,失败链由轮询收敛 */
  const handleError = useCallback((): void => {
    if (
      activeRef.current &&
      !transitioningRef.current &&
      phaseRef.current !== 'preparing' &&
      phaseRef.current !== 'failed' &&
      phaseRef.current !== 'ended'
    ) {
      fail(null, false);
    }
  }, [fail]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);
    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
    };
  }, [handleEnded, handleError, handleLoadedMetadata, handlePause, handlePlaying]);

  /** 渲染快照:相位/失败文案变化时按当前会话核心重建(onStateChange 已在 emit 时抛出) */
  const state = useMemo<MediaPlayerState>(
    () => buildState(phase),
    [buildState, failureMessage, phase],
  );

  const controller = controllerRef.current as MediaPlayerController;
  const mediaApi = mediaApiRef.current as PlaybackMediaApi;

  return { state, controller, mediaApi, videoRef };
}
