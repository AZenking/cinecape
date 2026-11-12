/**
 * 播放器视图(T055;005 US3/T104 US4;010 T049 续播定位与降级面):
 *
 * - 交付分派:`delivery === 'direct'` 为 NAS 文件直读入口(媒体文件本体)→ 原生
 *   `<video src>`;其余(hls_proxy/remux/audio_transcode/video_transcode)入口是同源
 *   HLS 清单 → video.js 内置 VHS 消费(ADR-0009:不新增转码承诺,仅消费受控网关产物);
 * - 安装绑定:本组件只以 props 收到当前 intentId 代次批准的会话面(协调器守卫),
 *   组件随意图面卸载,旧代次结果不可能安装到新播放器;
 * - 续播安装(US4 T101;010 T049 按 seekCapability 执行):presentationStartSeconds > 0
 *   时首次安装即定位 —— seekCapability=client 用媒体 API 定位(落点校验:定位后实际
 *   位置不在允许容差 → 显示「从头播放/重新选择」出路提示,绝不显示「已续播」;
 *   seekCapability=server_rebuild 走既有 POST /seek CAS 换代接口,按逻辑输出 offset
 *   定位,不以媒体时间轴判落点;none 隐藏拖动入口并提示进度不可保存,api.md §7 I4);
 * - probe 后降级面(B4):状态探针(会话 Mount 后一次 GET,旧响应守卫)读取
 *   resumeReason —— 非 null 降级从头时播放继续并显示具体降级原因(如「内容已变化」),
 *   绝不显示「已续播」成功语义(playback-state §3);started 门不变:未实际 playing
 *   不发 started(泵保证,本组件不提前触发);
 * - 存活保持:15 秒 heartbeat(位置取自媒体元素、暂停意图随拍上报;暂停心跳照发,
 *   004 R5:paused ≠ 失联);授权/会话/上下文失效(401/403/404)→ onTerminated 稳定
 *   提示,由协调器落 unavailable 面 —— 不展示内部策略或源位置;
 * - 进度上报(US4 T104):usePlaybackProgress 挂接 —— 首次实际 playing 上报 started
 *   (ACK 前同 seq/payload 重试、禁用 seek 与重建输出的音轨切换)、10 秒周期 + 暂停
 *   立即、卸载携 finalProgress 停止(未确认时空 stop + 未保存提示);断网保留最后
 *   成功值并提示同步失败;换档/退出废弃在途请求;
 * - 票据续期:到期前 60 秒 renew(004 TicketReply 语义),成功经 onRenew 上报协调器
 *   换装新入口 URL:direct 保存当前位置换 src 后恢复;video.js 换源续装
 *   (媒体元素不动);旧票按原有效期失效、不撤销(004);
 * - 连播(010 T064/T065):useVodAutoplay 意图 hook(receipt 资格 → 偏好门 →
 *   倒计时开始前取计划 → 5s 倒计时/到期建意图)+ 完整 UI 面(vod-autoplay-overlay:
 *   倒计时/目标历史询问/NotAllowedError 手势面,键盘可达,Esc=取消连播);
 *   本地连播开关(vod-autoplay-preference,localStorage 持久)在回执入口做本地门 ——
 *   关闭即不启动倒计时,服务端偏好消费时仍重验(api.md §5);awaitingGesture 不发
 *   started(泵保证),服务端 readyAt+60s 为回收准时源,UI 只展示不自毁;
 * - URL/票据不写入 localStorage,页面不向第三方发送 referrer(全局 no-referrer);
 * - 播放设置浮层(012 T028 修补;FR-020 第 4 项/FR-023):音轨/字幕经既有 PUT
 *   selection 当前值控制(重建音轨同会话换代换票,零第二会话),清晰度为探测交付
 *   只读展示(无质量端点,红线不新增);浮层开关不触媒体元素,播放零中断;
 * - 直播状态徽标(FR-020 第 2 项):探针确认时长 null(直播契约)即呈现「正在直播」
 *   文字状态(不仅靠颜色,FR-030);进度对齐节目时间窗的数据不在播放面承载(缺口
 *   登记:入口目标为频道语义,节目窗归详情面)。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@heroui/react';
import { ListVideo, Repeat2 } from 'lucide-react';
import type { Vod } from '@hmp/shared';
import { isFetchApiError, privateFetch } from '../../shared/fetch';
import { usePlaybackProgress } from './use-playback-progress';
import { usePlaybackTrackSelection } from './use-playback-track-selection';
import { useVodAutoplay } from './use-vod-autoplay';
import { useOptionalAutoplayNextEnabled } from './vod-autoplay-preference';
import { useVodTransition } from './use-vod-transition';
import { VodAutoplayOverlay } from './vod-autoplay-overlay';
import { VodSourceSwitcher } from './vod-source-switcher';
import { PlayerControls } from './player-controls';
import { PlayerLineSwitcher } from '../live/components/PlayerLineSwitcher';
import { LiveGuidePanel } from '../live/components/LiveGuidePanel';
import type { StreamLineDto } from '@hmp/shared';
import { VideoPlayer } from './video-player';
import { PlaybackSettingsOverlay } from './playback-settings-overlay';

/** 心跳节拍(004 lifecycle.heartbeatIntervalSeconds;前端发起) */
const HEARTBEAT_MS = 15_000;
/** 提前续期秒数(004 PLAYBACK_RENEW_LEAD_SECONDS 同值) */
const RENEW_LEAD_SECONDS = 60;
/** setTimeout 单程延迟上限(2^31-1ms;超出会 ToInt32 回绕为立即触发) */
const RENEW_TIMER_MAX_DELAY_MS = 2 ** 31 - 1;
/** 续播落点允许容差秒(api.md §7 I4「允许误差」;±3s 与 US2 恢复精度验收口径一致) */
const RESUME_LANDING_TOLERANCE_SECONDS = 3;

/** 010 PlaybackDto(I4/U2 事实面;004/005 基座字段按需取用,交集扩展兼容缺省) */
type PlaybackStatusDto = Vod.components['schemas']['PlaybackDto'];
type SeekCapability = PlaybackStatusDto['seekCapability'];
type ResumeReason = PlaybackStatusDto['resumeReason'];

/** 状态探针快照(Mount/会话换档各一次 GET;换档即弃,迟到响应不回写) */
interface SessionStatusSnapshot {
  readonly version: number;
  readonly durationSeconds: number | null;
  readonly seekCapability: SeekCapability | null;
  readonly resumeReason: ResumeReason;
  /** 已探测轨道(012 T028:播放设置浮层的当前值事实;探测未完成为空数组) */
  readonly tracks: PlaybackStatusDto['tracks'] | null;
}

/**
 * probe 后降级从头原因的稳定文案(playback-state §3:降级必须显示具体 resumeReason;
 * B4 以「内容已变化」词面钉 content_changed,其余按 api.md §1 枚举语义;
 * accepted/requested_beginning/no_history 非降级,不映射、不显示成功或失败语义)。
 */
const RESUME_REASON_NOTICES: Partial<Record<Exclude<ResumeReason, null>, string>> = {
  content_changed: '内容已变化,本次将从头播放;观看历史已保留。',
  continuity_changed: '内容线路连续性已变化,本次将从头播放;观看历史已保留。',
  duration_changed: '内容时长已变化,本次将从头播放;观看历史已保留。',
  completed: '上次已看完,本次从头播放。',
  invalid_position: '上次播放位置无效,本次从头播放。',
  duration_unknown: '内容时长未知,本次从头播放。',
};

/** 续播落点判定:pending=定位进行中(待 seeked 复核);applied=落入允许误差;
 *  failed=媒体拒绝定位/落点越界(绝不显示「已续播」,按出路提示呈现) */
type LandingState = 'pending' | 'applied' | 'failed';

export interface PlayerViewProps {
  readonly sessionId: string;
  readonly generation: number;
  readonly playbackUrl: string;
  readonly ticketExpiresAt: string;
  readonly delivery: string | null;
  /** 服务端冻结的起播位置秒(US4 resume;beginning/无有效进度为 0) */
  readonly presentationStartSeconds?: number;
  /** 服务端拒绝心跳/换票(授权、会话或上下文失效)时的稳定终止回调 */
  readonly onTerminated: (message: string) => void;
  /** 媒体致命故障(010 T075;引擎 error→onFatalError)通知:协调器据此注册 60s
   *  recover_switch 恢复窗口(过期收口为「重新播放」普通播放,api.md §5/§6) */
  readonly onMediaFailure?: () => void;
  /** 续期成功换装(协调器更新意图面 → 新 URL props 重新安装,位置保持) */
  readonly onRenew: (url: string, expiresAt: string) => void;
  /** 010 I4 seek 能力(可选;缺省由状态探针补全 —— client=媒体 API 定位,
   *  server_rebuild=CAS 换代定位,none=隐藏拖动入口) */
  readonly seekCapability?: SeekCapability;
  /** 010 probe 后降级原因(可选;缺省由状态探针补全) */
  readonly resumeReason?: ResumeReason;
  /** 影片逻辑时长秒(可选;null=未知 → 进度不可保存;缺省由状态探针补全) */
  readonly durationSeconds?: number | null;
  /** 016 T021:直播线路清单(resolve 投影;≥2 条时控制栏呈现换线菜单) */
  readonly lines?: readonly StreamLineDto[];
  /** 当前线路(与 lines 同源) */
  readonly selectedLineId?: string | null;
  /** 手动换线:仅上报 lineId,由协调器决定是否原地换装 */
  readonly onSelectLine?: (lineId: string) => void;
  /** mini 播放器状态与切换(控制栏最小化按钮;宿主负责悬浮/拖动) */
  readonly minimized?: boolean;
  readonly onToggleMinimize?: () => void;
  /** 直播频道切换(节目单面板内点击某频道当前节目) */
  readonly onZapChannel?: (mediaId: string, title: string, posterRef: string | null) => void;
  /** 当前播放频道 mediaId(节目单面板标记「当前」用) */
  readonly currentChannelId?: string | null;
}

export function PlayerView({
  sessionId,
  generation,
  playbackUrl,
  ticketExpiresAt,
  delivery,
  presentationStartSeconds = 0,
  onTerminated,
  onMediaFailure,
  onRenew,
  seekCapability: seekCapabilityProp,
  resumeReason: resumeReasonProp,
  durationSeconds: durationSecondsProp,
  lines = [],
  selectedLineId = null,
  onSelectLine,
  minimized = false,
  onToggleMinimize,
  onZapChannel,
  currentChannelId = null,
}: PlayerViewProps): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** 换装(续期)时待恢复的位置(direct 换 src 后回填;VHS 换源续装回填) */
  const resumeAtRef = useRef<number | null>(null);
  /** 续播安装是否已应用(仅首次安装定位;换装/续期不重复定位) */
  const presentationAppliedRef = useRef(false);
  /** 未保存提示(未确认 started 即停止;进度同步失败提示) */
  const [notice, setNotice] = useState<string | null>(null);
  /** 直播节目单面板(控制栏 icon 呼出;播放器内部覆盖层) */
  const [guideOpen, setGuideOpen] = useState(false);

  // 010 T049:probe 后播放事实面(可选 props 优先 —— 供协调器直传;缺省状态探针补全)
  const [status, setStatus] = useState<SessionStatusSnapshot | null>(null);
  /** 续播落点判定(B5:未落入允许误差不得显示「已续播」) */
  const [landing, setLanding] = useState<LandingState | null>(null);
  /** 落点复核监听清理(seeked once;换装/卸载时摘除) */
  const landingRecheckRef = useRef<(() => void) | null>(null);
  /** server_rebuild CAS seek 已用的会话 version(恰一次定位;重试不重复换代) */
  const rebuildSeekVersionRef = useRef<number | null>(null);

  // seek 能力/降级原因/时长:props 未携带时取探针快照(交集扩展兼容缺省)
  const seekCapability = seekCapabilityProp ?? status?.seekCapability ?? null;
  const resumeReason = resumeReasonProp !== undefined ? resumeReasonProp : (status?.resumeReason ?? null);
  const durationSeconds = durationSecondsProp !== undefined ? durationSecondsProp : (status?.durationSeconds ?? null);
  const degradedNotice = resumeReason !== null ? (RESUME_REASON_NOTICES[resumeReason] ?? null) : null;
  // 进度不可保存面(ui.md §6/api.md §7 I4):能力 none 或时长未知(能力已知时)
  const progressUnsavable = seekCapability === 'none' || (seekCapability !== null && durationSeconds === null);

  // 稳定回调面:父层回调以 ref 转发,定时器/安装效果不因父层重渲染重排
  const terminatedRef = useRef(onTerminated);
  terminatedRef.current = onTerminated;
  /** 媒体故障通知(T075 recover 窗口准时源;ref 转发避免引擎回调随渲染重排) */
  const mediaFailureRef = useRef(onMediaFailure);
  mediaFailureRef.current = onMediaFailure;
  const renewRef = useRef(onRenew);
  renewRef.current = onRenew;
  /** 落点判定读取的最新能力(server_rebuild 时不按媒体时间轴判落点) */
  const capabilityRef = useRef<SeekCapability | null>(null);
  capabilityRef.current = seekCapability;

  // 连播意图(T064;状态面+动作回调见 use-vod-autoplay):receipt 资格 → 偏好门 →
  // 倒计时开始前取计划 → 5s 倒计时/到期建意图;UI 面由 vod-autoplay-overlay 承担
  // (T065:倒计时/历史询问/手势面,键盘可达)。
  const autoplay = useVodAutoplay({ sessionId, generation, videoRef });

  // 连播本地门(T065):全局开关(播放面头部,localStorage 持久)关闭时回执不进入
  // hook —— 不倒计时/不取计划/零意图;服务端偏好在消费时仍由 hook 重验(api.md §5)
  const autoplayNextEnabled = useOptionalAutoplayNextEnabled();

  // 手势面状态(T065):引擎 play() NotAllowedError → awaitingGesture;真实 playing
  // 媒体事件即恢复(泵 started/playing 观测同源,拒绝期零伪造);会话换档重置
  const [awaitingGesture, setAwaitingGesture] = useState(false);
  /** 引擎 play() 注册面(video-player 挂载即注册;「点击播放」唯一入口,零第二播放器) */
  const manualPlayRef = useRef<(() => void) | null>(null);
  const handlePlayGestureRequired = useCallback((): void => {
    setAwaitingGesture(true);
  }, []);
  const handleManualPlayReady = useCallback((play: (() => void) | null): void => {
    manualPlayRef.current = play;
  }, []);
  const resumeGesture = useCallback((): void => {
    manualPlayRef.current?.();
  }, []);

  // 进度上报队列(US4 T104;started ACK 前禁用 seek 与重建输出的音轨切换)
  const progress = usePlaybackProgress({
    sessionId,
    generation,
    videoRef,
    // 连播回执接出带本地门:开关关闭时回执止步于此(不倒计时/零意图);
    // usePlaybackProgress 经 ref 读取本回调,内联闭包每渲染刷新,读取的是最新开关值
    onFinishReceipt: (receipt) => {
      if (!autoplayNextEnabled) {
        return;
      }
      autoplay.onReceipt(receipt);
    },
    onUnsavedProgress: () => {
      setNotice('播放进度未保存,本次观看不会进入观看历史。');
    },
    onRejected: (message) => {
      terminatedRef.current(message);
    },
  });

  // 播放设置浮层轨道选择(012 T028;FR-020 第 4 项/FR-023):音轨/字幕经既有
  // PUT selection 当前值控制(重建音轨同会话换代换票,零第二会话);generationRef
  // 由 hook 追踪推进,续期定时器读它避免重建换轨后携旧代 renew。
  const trackSelection = usePlaybackTrackSelection({
    sessionId,
    generation,
    version: status?.version ?? null,
    tracks: status?.tracks ?? null,
    canSwitchTracks: progress.canSwitchTracks,
    getPositionSeconds: () => videoRef.current?.currentTime ?? 0,
    onTicket: (url, expiresAt) => {
      // 换装(重建音轨换票):位置捕获回填语义与续期换装一致;URL/到期上报协调器
      resumeAtRef.current = videoRef.current?.currentTime ?? null;
      renewRef.current(url, expiresAt);
    },
    onStatusPatch: (patch) => {
      // 提交/冲突刷新后回写探针快照(版本/轨道;后续 CAS 不读旧值)
      setStatus((previous) =>
        previous === null
          ? { version: patch.version, durationSeconds: null, seekCapability: null, resumeReason: null, tracks: patch.tracks }
          : { ...previous, version: patch.version, tracks: patch.tracks },
      );
    },
  });

  // 手势面恢复事实(T065):真实 playing 媒体事件即解除 awaitingGesture —— 与泵的
  // started/playing 观测同一事实源,不在点击时伪造「已恢复」(<video> 节点跨换装稳定)
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const onPlaying = (): void => {
      setAwaitingGesture(false);
    };
    video.addEventListener('playing', onPlaying);
    return () => {
      video.removeEventListener('playing', onPlaying);
    };
  }, []);

  // 换源/过渡串行流(T074):复用上方既有进度泵(pauseAndFlush/stopOnce,勿建第二泵);
  // 状态机与网络编排见 use-vod-transition,UI 抽屉见 vod-source-switcher(播放器内,
  // 不退出播放器重搜)。入口按钮挂播放面内,与本连播 overlay 共存。
  const transition = useVodTransition({
    sessionId,
    generation,
    videoRef,
    pauseAndFlush: progress.pauseAndFlush,
    stopOnce: progress.stopOnce,
  });

  // 连播共存(010 T065×换源;ui.md 连播/换源语义):换源一旦开始(抽屉打开/候选面
  // 激活)即取消进行中的连播倒计时/询问 —— 防止「倒计时到期建意图」与「换源串行流」
  // 双流程竞争同一 slot。取消为终态收口(零意图);换源 done 后由 T075 后继会话接管,
  // 连播随新会话的 PlayerView/泵生命周期重新评估。已停/无倒计时不动作。
  useEffect(() => {
    const transitionActive =
      transition.state.phase !== 'idle' && transition.state.phase !== 'done' && transition.state.phase !== 'failed';
    if (
      transitionActive &&
      (autoplay.state.phase === 'preparing' ||
        autoplay.state.phase === 'countdown' ||
        autoplay.state.phase === 'awaiting_history_choice')
    ) {
      autoplay.cancel();
    }
  }, [transition.state.phase, autoplay.state.phase, autoplay.cancel]);

  // 会话身份变化(B3 切档语义):手势面随会话重置;新会话安装 src 后由引擎重新起播,
  // 仍被拒绝则回调再次置位(新会话的 awaitingGesture 事实重新呈现)
  useEffect(() => {
    setAwaitingGesture(false);
  }, [sessionId]);

  // 本地连播开关关闭即终止进行中的倒计时/询问(cancel 终态:收口定时器、零意图;
  // 后续回执经上方本地门不再进入)
  useEffect(() => {
    if (
      !autoplayNextEnabled &&
      (autoplay.state.phase === 'preparing' ||
        autoplay.state.phase === 'countdown' ||
        autoplay.state.phase === 'awaiting_history_choice')
    ) {
      autoplay.cancel();
    }
  }, [autoplayNextEnabled, autoplay.state.phase, autoplay.cancel]);

  // 1. 源安装与引擎生命周期由 <VideoPlayer> 承担(video.js 初始化/换源/销毁;
  //    换装(续期)时的位置捕获在 onRenew 回调内完成,回填仍由下方 restore 监听执行)

  // 2. 位置恢复与续播安装(换装完成即回填,不回零;首次安装按服务端冻结位置定位,
  //    并按 I4 做落点校验 —— 实际位置不在允许容差:绝不显示「已续播」,按出路呈现)
  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const withinTolerance = (actual: number, target: number): boolean =>
      Number.isFinite(actual) && Math.abs(actual - target) <= RESUME_LANDING_TOLERANCE_SECONDS;
    const evaluateLanding = (target: number): void => {
      if (capabilityRef.current === 'server_rebuild') {
        // server_rebuild:服务端按逻辑输出 offset 重排输出,媒体时间轴非影片逻辑时间轴,
        // 不以 currentTime 判落点(定位由下方 CAS seek 效果承担)
        return;
      }
      if (withinTolerance(video.currentTime, target)) {
        setLanding('applied');
        return;
      }
      if (video.seeking === true) {
        // 引擎异步定位进行中:seeked 观测复核真实落点(once;换装/卸载即摘除)
        setLanding('pending');
        const recheck = (): void => {
          landingRecheckRef.current = null;
          setLanding(withinTolerance(video.currentTime, target) ? 'applied' : 'failed');
        };
        landingRecheckRef.current = (): void => {
          video.removeEventListener('seeked', recheck);
        };
        video.addEventListener('seeked', recheck, { once: true });
        return;
      }
      // 媒体拒绝定位(落点未变且无在途 seek):落点失败 → 出路提示,绝不显示成功
      setLanding('failed');
    };
    const restore = (): void => {
      const resumeAt = resumeAtRef.current;
      if (resumeAt !== null && Number.isFinite(resumeAt) && resumeAt > 0) {
        video.currentTime = resumeAt;
      } else if (!presentationAppliedRef.current && Number.isFinite(presentationStartSeconds) && presentationStartSeconds > 0) {
        // 续播安装(T101/T049):服务端冻结位置(direct/VHS 同一影片逻辑时间轴)+ 落点校验
        video.currentTime = presentationStartSeconds;
        evaluateLanding(presentationStartSeconds);
      }
      presentationAppliedRef.current = true;
      resumeAtRef.current = null;
    };
    video.addEventListener('loadedmetadata', restore, { once: true });
    return () => {
      video.removeEventListener('loadedmetadata', restore);
      landingRecheckRef.current?.();
      landingRecheckRef.current = null;
    };
    // presentationStartSeconds 随首次安装面冻结;换装(续期)不重读;
    // capabilityRef/landingRecheckRef 为稳定 ref,落点判定仅依赖 DOM 事实与 setState
  }, [playbackUrl, presentationStartSeconds]);

  // 2b. 010 状态探针(probe 后原因/seek 能力/时长,api.md §7 I4):会话 Mount 一次 GET;
  // 旧响应守卫(换档 abort + alive,迟到响应不回写);探针失败不阻塞播放(能力未知
  // → 不显示能力相关提示,续播定位仍按媒体事实判落点)。探针回写用 flushSync 同步
  // 成形:降级原因(B4)随播放面首帧呈现,不因并发调度晚一拍。
  useEffect(() => {
    if (sessionId === '') {
      return;
    }
    let alive = true;
    const abort = new AbortController();
    privateFetch<PlaybackStatusDto>(`/playback/sessions/${encodeURIComponent(sessionId)}`, {
      signal: abort.signal,
    })
      .then((dto) => {
        if (!alive || dto === null || typeof dto !== 'object') {
          return; // 会话已换/无状态体(204):不回写(playback-state §8)
        }
        flushSync(() => {
          setStatus({
            version: dto.version,
            durationSeconds: typeof dto.durationSeconds === 'number' ? dto.durationSeconds : null,
            seekCapability: dto.seekCapability ?? null,
            resumeReason: dto.resumeReason ?? null,
            tracks:
              dto.tracks !== null && typeof dto.tracks === 'object'
                ? { audio: dto.tracks.audio ?? [], subtitles: dto.tracks.subtitles ?? [] }
                : null,
          });
        });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      abort.abort();
    };
    // 探针随会话身份;generation/URL 换装不重探(同会话 probe 后事实已冻结)
  }, [sessionId]);

  // 2c. server_rebuild 定位(010 I4):走既有 POST /seek CAS 换代接口(推进 generation、
  // 绑定同输入),按逻辑输出 offset 定位;恰一次(重试不重复换代),失败按落点失败
  // 呈现「从头播放/重新选择」出路。client/none 不经此路径(client 由媒体 API 定位)。
  useEffect(() => {
    if (seekCapability !== 'server_rebuild' || presentationStartSeconds <= 0) {
      return;
    }
    const version = status?.version;
    if (typeof version !== 'number' || rebuildSeekVersionRef.current !== null) {
      return;
    }
    rebuildSeekVersionRef.current = version;
    let alive = true;
    privateFetch<PlaybackStatusDto>(`/playback/sessions/${encodeURIComponent(sessionId)}/seek`, {
      method: 'POST',
      body: { expectedVersion: version, positionSeconds: presentationStartSeconds },
    })
      .then((dto) => {
        if (!alive) {
          return;
        }
        const landed =
          dto === null || typeof dto !== 'object' || typeof dto.positionSeconds !== 'number'
            ? true // 服务端已受理定位(CAS 成功即换代生效)
            : Math.abs(dto.positionSeconds - presentationStartSeconds) <= RESUME_LANDING_TOLERANCE_SECONDS;
        setLanding(landed ? 'applied' : 'failed');
      })
      .catch(() => {
        if (alive) {
          setLanding('failed');
        }
      });
    return () => {
      alive = false;
    };
  }, [seekCapability, presentationStartSeconds, status, sessionId]);

  // 2d. server_rebuild 收窄 client 落点语义:能力确认为 server_rebuild 时清空 client
  // 判定残态(loadedmetadata 时能力可能尚未抵达,先按媒体事实判、后按能力收口)
  useEffect(() => {
    if (seekCapability === 'server_rebuild') {
      landingRecheckRef.current?.();
      landingRecheckRef.current = null;
      setLanding(null);
    }
  }, [seekCapability]);

  // 3. 心跳(15 秒节拍;失效即终止)
  useEffect(() => {
    if (sessionId === '' || ticketExpiresAt === '') {
      return;
    }
    const timer = setInterval(() => {
      const video = videoRef.current;
      void privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/heartbeat`, {
        method: 'POST',
        body: {
          positionSeconds: Number.isFinite(video?.currentTime) ? Math.max(0, video?.currentTime ?? 0) : 0,
          paused: video?.paused ?? false,
        },
      }).catch((error: unknown) => {
        if (isFetchApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404)) {
          terminatedRef.current('播放已终止,请重新发起播放。');
        }
        // 网络抖动:下一拍自然重试(失联阈值 45 秒容忍缺拍)
      });
    }, HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
    };
    // 稳定回调经 ref 转发(见下);会话身份变化时本组件随意图面卸载
    // 依赖面刻意收窄:稳定回调经 ref 转发;playbackUrl/generation 变化即换装
  }, [sessionId]);

  // 4. 票据续期(到期前 60 秒;成功经 onRenew 上报协调器换装)
  useEffect(() => {
    if (sessionId === '' || ticketExpiresAt === '') {
      return;
    }
    const expiresAtMs = Date.parse(ticketExpiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      const fireIn = Math.max(expiresAtMs - RENEW_LEAD_SECONDS * 1000 - Date.now(), 0);
      // setTimeout 延迟经 ToInt32 收窄:超过 2^31-1ms(≈24.8 天)会回绕为负值(立即触发
      // —— 远期票曾因此首轮即续期)。长票分程安装:提前到点未进续期窗则下一程重装。
      timer = setTimeout(
        () => {
          if (expiresAtMs - RENEW_LEAD_SECONDS * 1000 - Date.now() > 0) {
            arm();
            return;
          }
          void privateFetch<{ playbackUrl: string; ticketExpiresAt: string; generation: number }>(
            `/playback/sessions/${encodeURIComponent(sessionId)}/renew`,
            { method: 'POST', body: { expectedGeneration: trackSelection.generationRef.current } },
          )
            .then((ticket) => {
              resumeAtRef.current = videoRef.current?.currentTime ?? null;
              renewRef.current(ticket.playbackUrl, ticket.ticketExpiresAt);
            })
            .catch((error: unknown) => {
              if (isFetchApiError(error) && (error.status === 401 || error.status === 403 || error.status === 404)) {
                terminatedRef.current('播放授权已失效,请重新发起播放。');
              }
              // 其余失败:旧票在原有效期前仍可交付,不终止播放
            });
        },
        Math.min(fireIn, RENEW_TIMER_MAX_DELAY_MS),
      );
    };
    arm();
    return () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
    // 稳定回调经 ref 转发(见下)
    // 依赖面刻意收窄:稳定回调经 ref 转发;playbackUrl/generation 变化即换装
  }, [sessionId, generation, ticketExpiresAt]);return (
    <div className="relative h-full w-full">
      <VideoPlayer
        videoRef={videoRef}
        src={playbackUrl}
        mimeType={delivery === 'direct' ? null : 'application/x-mpegURL'}
        onFatalError={() => {
          // T075:先通知协调器注册 60s recover_switch 窗口,再落 unavailable 终局面
          mediaFailureRef.current?.();
          terminatedRef.current('播放流中断,请重新发起播放。');
        }}
        // 自绘 HeroUI 控制栏(原生控件关闭;媒体语义不变)
        nativeControls={false}
        // 010 I4:能力不满足(none)不显示可用拖动入口(未知能力不冒进禁用)
        controlsEnabled={seekCapability !== 'none'}
        // 010 T065:自动播放策略拒绝 → awaitingGesture 面;「点击播放」经注册的引擎 play() 恢复
        onPlayGestureRequired={handlePlayGestureRequired}
        onManualPlayReady={handleManualPlayReady}
      />
      {/* 直播状态徽标(012 T028;FR-020 第 2 项):探针确认时长 null(直播契约)
          即文字状态呈现,不仅靠颜色(FR-030);探针未回/失败不虚构状态 */}
      {status !== null && durationSeconds === null ? (
        <p role="status" data-testid="live-status" className="absolute start-4 top-3 z-10 rounded bg-black/70 px-2 py-1 text-xs text-white">
          正在直播
        </p>
      ) : null}
      {/* 控制栏(自绘 HeroUI):基础播放控件 + 右侧业务动作区。
          换源/播放设置/线路/节目单全部收拢于此(产品要求:不再四角浮动)。 */}
      <PlayerControls
        videoRef={videoRef}
        isLive={durationSeconds === null}
        canSeek={seekCapability !== 'none'}
        minimized={minimized}
        onToggleMinimize={onToggleMinimize}
      >
        {/* 播放设置(012 T028;FR-023):音轨/字幕/清晰度当前值控制;开关不触
            媒体元素(播放零中断),浮层内无跳转完整设置页入口 */}
        <PlaybackSettingsOverlay settings={trackSelection} delivery={delivery} />
        {/* 换源入口(T074;ui.md §4 播放面内,不退出播放器重搜) */}
        <Button size="sm" variant="ghost" isIconOnly aria-label="换源" className="text-white" onPress={transition.openDrawer}>
          <Repeat2 aria-hidden="true" className="size-4" />
        </Button>
        {/* OSD 线路切换(016 T021):≥2 条线路才呈现;仅上报 lineId */}
        {onSelectLine !== undefined ? (
          <PlayerLineSwitcher lines={lines} selectedLineId={selectedLineId} onSelect={onSelectLine} />
        ) : null}
        {/* 直播节目单(切台器):点击在播放器内呼出正在直播列表 */}
        {durationSeconds === null && onZapChannel !== undefined ? (
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            aria-label="节目单"
            aria-expanded={guideOpen}
            className="text-white"
            onPress={() => {
              setGuideOpen((value) => !value);
            }}
          >
            <ListVideo aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
      </PlayerControls>
      {/* 播放器内节目单面板(不拦截视频播放;点击行即切台) */}
      <LiveGuidePanel
        open={guideOpen}
        onClose={() => {
          setGuideOpen(false);
        }}
        currentChannelId={currentChannelId}
        onZap={(mediaId, title, posterRef) => {
          onZapChannel?.(mediaId, title, posterRef);
        }}
      />
      {transition.state.drawerOpen ? <VodSourceSwitcher transition={transition} /> : null}
      {/* 续播落点面(T049):成功仅按实际落点承认;失败给显式出路,绝不显示成功语义 */}
      {landing === 'applied' && presentationStartSeconds > 0 ? (
        <p role="status" data-testid="resume-applied" className="absolute bottom-28 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          已续播,已恢复到上次位置。
        </p>
      ) : null}
      {landing === 'failed' ? (
        <p role="alert" data-testid="resume-failed" className="absolute bottom-28 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          未能定位到上次播放位置,可从头播放或重新选择。
        </p>
      ) : null}
      {/* probe 后降级面(B4):播放继续 + 具体降级原因,不显示「已续播」成功语义 */}
      {degradedNotice !== null ? (
        <p role="status" data-testid="resume-degraded" className="absolute bottom-32 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          {degradedNotice}
        </p>
      ) : null}
      {/* 进度不可保存面(B7b/I4):时长未知或能力 none —— 不虚构可保存进度 */}
      {progressUnsavable ? (
        <p role="status" data-testid="progress-unsavable" className="absolute bottom-36 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          此来源暂不支持进度保存:进度不可保存,不进入观看历史。
        </p>
      ) : null}
      {/* 进度协议状态提示(未保存/同步失败;不遮挡控制条,错误不只靠颜色) */}
      {progress.syncFailed ? (
        <p role="alert" data-testid="progress-sync-failed" className="absolute bottom-16 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          进度同步失败,已保留上次成功保存的位置,网络恢复后自动重试。
        </p>
      ) : null}
      {notice !== null ? (
        <p role="status" data-testid="progress-notice" className="absolute bottom-24 start-4 rounded bg-black/70 px-2 py-1 text-xs text-white">
          {notice}
        </p>
      ) : null}
      {/* 连播 UI 面(T065;ui.md §3):倒计时(目标+剩余秒+取消/立即)、目标历史
          询问(暂停倒计时,选择即 positionMode)、NotAllowedError 手势面(点击播放;
          60s 服务端回收为准,UI 只展示不自毁)。键盘可达(HeroUI/React Aria 焦点,
          Esc=取消连播),样式全 token 派生。 */}
      <VodAutoplayOverlay
        phase={autoplay.state.phase}
        plan={autoplay.state.plan}
        countdownDeadline={autoplay.state.countdownDeadline}
        requireExplicitConfirm={autoplay.state.requireExplicitConfirm}
        awaitingGesture={awaitingGesture}
        onCancel={autoplay.cancel}
        onConfirmImmediate={autoplay.confirmImmediate}
        onChoosePosition={autoplay.choosePosition}
        onResumeGesture={resumeGesture}
      />
    </div>
  );
}
