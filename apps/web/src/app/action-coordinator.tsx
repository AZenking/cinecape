/**
 * ActionCoordinator(T043/T053;ui.md §3 统一受控 Modal 意图状态机)。
 *
 * - 应用内唯一受控 Modal:uninitialized/initialize→login→bootstrap→picker→
 *   selectionPin 分步切换内容,不同时叠出多个弹层;
 * - 每动作保存 intentId/原目标(returnTo)/入口(entry);新动作递增代次(generation),
 *   旧登录/选档回调凭 isStaleIntent 失效 —— 不可重开已取消弹层、不可回填旧身份;
 * - US3 播放分支(T053):play → authorize → prepare → playing 与登录/选档共用同一
 *   状态机与代次语义 —— 游客播放先进入登录/选档意图(选档完成前零 /playback/ 请求),
 *   选档完成后继续原目标;已选档直接 authorize。播放意图绑定独立 intentId
 *   (playbackIntentSeq),reducer 内做意图守卫:准备中换目标/重复点击仅最新 intentId
 *   可 authorize→prepare→playing,旧回调与旧准备结果结构上不能起播其它内容(FR-013);
 *   取消登录/选档废弃暂存播放意图(不自动播放);退出/换档/关闭播放面统一收口
 *   (T079 唯一调用点 terminatePlaybackIntent:意图废弃 → 播放面卸载 → 进度泵
 *   stopOnce 唯一命令,playing 相位不并发第二份空 stop;身份撤销不被保存阻塞,
 *   旧身份零补报);
 * - playing 态由协调器以全局 Modal 挂载播放器(features/playback/player-view;009:非全屏、
 *   路由切换不掉、遮罩/Esc 不关闭),不另建路由面;
 * - 选档成功回到原业务目标或首页(白名单内);取消清凭据与意图、返回原页面、
 *   不自动重开、不重复弹窗;返回目标仅接受本应用内部路径白名单,拒绝外部跳转
 *   (FR-010 防开放重定向);
 * - useAuthAction 供布局层(登录按钮/身份菜单)发起意图;usePlayAction(T054)是
 *   所有播放入口的唯一发起面(PlayButton/use-play-action 均经此消费)。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router';
import { Alert, AlertContent, AlertDescription, AlertTitle, Button, Modal, Spinner } from '@heroui/react';
import type { PlaybackDto, TicketReply } from '@hmp/shared';
import { isFetchApiError, privateFetch, publicFetch } from '../shared/fetch';
import { useSession } from './session-provider';
import type { AccountSession, ProfileSummary, SetupStatus } from './session-types';
import {
  coordinatorReducer,
  createInitialCoordinatorState,
  isStaleIntent,
  sanitizeReturnTarget,
  selectNextLine,
  type AuthStep,
  type CoordinatorAction,
  type PlaybackIntentState,
  type PlayTarget,
} from './action-coordinator-core';
import { SetupStep } from '../features/auth/setup-step';
import { LoginStep } from '../features/auth/login-step';
import { BootstrapStep } from '../features/auth/bootstrap-step';
import { PinRecoveryStep } from '../features/auth/pin-recovery-step';
import { ProfilePickerStep } from '../features/profiles/profile-picker-step';
import { SelectionPinStep } from '../features/profiles/selection-pin-step';
import { PlayerView } from '../features/playback/player-view';
import { useVodTransition } from '../features/playback/use-vod-transition';
import { VodSourceSwitcher } from '../features/playback/vod-source-switcher';
import { PlayerLineSwitcher } from '../features/live/components/PlayerLineSwitcher';
import { useAppToast } from '../shared/ui';
import {
  VodAutoplayPreferenceProvider,
  useVodAutoplayPreference,
} from '../features/playback/vod-autoplay-preference';

export interface AuthActionApi {
  /** 弹层是否打开 */
  isOpen: boolean;
  step: AuthStep;
  /** 游客登录入口(未初始化时先走 initialize;状态未知显示重试,不开放配置) */
  startLogin: (returnTo?: string | null) => void;
  /** 已登录未选档:选择 Profile 入口(bootstrapRequired 时先首建) */
  startProfileSelection: (returnTo?: string | null) => void;
  /** 设置入口:直达目标(管理路由由 AdminRouteGuard 拦截;ADR-0017 无门禁) */
  startSettings: (returnTo?: string | null) => void;
  /** 取消当前意图(清凭据、返回原页面、不自动重开) */
  cancel: () => void;
}

/** 统一播放动作面(T054;所有播放入口仅经此发起,禁止旁路第二个状态机) */
export interface PlayActionRequest {
  readonly mediaId: string;
  readonly title: string;
  /** 缺省 beginning;进度数据与继续/从头按钮语义由 US4 补全 */
  readonly startMode?: 'beginning' | 'resume';
  /**
   * 指定物理线路(016 T020/T021;api.md §2.1 可选 lineId):OSD 手动换线与自动
   * 容灾续接时携带并透传 resolve 请求体;缺省由服务端按 priority ASC/isDefault 优选。
   */
  readonly lineId?: string;
}

export interface PlayActionApi {
  /** 发起统一受控播放:游客→登录选档意图(完成后续跑原目标);已选档→直接 authorize */
  play: (request: PlayActionRequest) => void;
  /** 关闭播放面(废弃当前播放意图;对已接受会话补发幂等 stop) */
  close: () => void;
  /** 当前播放意图(只读;null = 无播放面) */
  playback: PlaybackIntentState | null;
}

const AuthActionContext = createContext<AuthActionApi | null>(null);
const PlayActionContext = createContext<PlayActionApi | null>(null);

export function useOptionalAuthAction(): AuthActionApi | null {
  return useContext(AuthActionContext);
}

/** 统一登录/选档动作入口(US3 播放等继续经同一协调器扩展) */
export function useAuthAction(): AuthActionApi {
  const value = useOptionalAuthAction();
  if (value === null) {
    throw new Error('useAuthAction 必须在 <ActionCoordinator> 内使用');
  }
  return value;
}

/** 统一播放入口(T054;features/playback 的 PlayButton/use-play-action 经此消费) */
export function usePlayAction(): PlayActionApi {
  const value = useContext(PlayActionContext);
  if (value === null) {
    throw new Error('usePlayAction 必须在 <ActionCoordinator> 内使用');
  }
  return value;
}

function currentPathTarget(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** 准备轮询节奏与起播时限(沿用 004:probe 共享总期限 30 秒;60 秒失联容忍轮询间隙) */
const PREPARE_POLL_MS = 500;
const PREPARE_BUDGET_MS = 30_000;

/** recover_switch 恢复窗口(010 T075;api.md §5「failed 可恢复来源仅 60s」/§6):
 *  客户端媒体故障时刻起算的 UI 镜像(服务端 failed+60s 为权威),过期收口为
 *  「重新播放」普通播放 —— 不自动携带过期 carry/意图,不自动循环尝试来源。 */
const RECOVER_WINDOW_MS = 60_000;

/** 换源恢复窗口相位(T075):idle=无故障;window=60s 内可 recover_switch;expired=过期 */
type RecoverPhase = 'idle' | 'window' | 'expired';

/** 稳定拒绝 → 面向观看者的提示(不含策略细节/源位置/票据等内部信息) */
function stableRejectMessage(error: unknown): string {
  if (isFetchApiError(error)) {
    if (error.status === 401) {
      return '登录状态已失效,请重新登录后再播放。';
    }
    if (error.status === 403) {
      return '当前档案暂不能播放该内容,请切换档案或稍后重试。';
    }
    if (error.status === 429) {
      return '操作过于频繁,请稍后重试。';
    }
    if (error.status === 400) {
      return '播放请求无效,请返回重试。';
    }
  }
  return '该内容当前不可播放。';
}

/** 服务端会话失败码 → 稳定提示(仅公开失败语义,不含诊断) */
function failureMessage(failureCode: string | null | undefined): string {
  if (failureCode === 'PLAYBACK_PREPARE_TIMEOUT' || failureCode === 'PLAYBACK_SEEK_TIMEOUT') {
    return '准备超时,请稍后重试。';
  }
  if (failureCode === 'PLAYBACK_FORMAT_UNSUPPORTED') {
    return '该内容的编码格式不受支持,无法播放。';
  }
  return '该内容当前不可播放。';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 连播开关入口(010 T065;ui.md §3 关闭连播可键盘操作):播放面头部非阻塞开关 ——
 *  关闭即本地门(收口倒计时/零意图,见 vod-autoplay-preference),消费时服务端
 *  偏好仍重验(api.md §5);开关值持久 localStorage,状态经 Provider 全局一致。 */
function AutoplayNextToggle(): ReactNode {
  const { autoplayNextEnabled, setAutoplayNextEnabled } = useVodAutoplayPreference();
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label="自动连播开关"
      aria-pressed={autoplayNextEnabled}
      onPress={() => setAutoplayNextEnabled(!autoplayNextEnabled)}
    >
      {autoplayNextEnabled ? '连播:开' : '连播:关'}
    </Button>
  );
}

/**
 * 换源恢复面板(010 T075;ui.md §4「媒体故障 60s recover_switch 路径」、api.md §5):
 * unavailable 相位的 recover_switch 候选流宿主 —— 复用 T074 换源串行流与抽屉面
 * (不退出播放器重搜),仅 action 换为 recover_switch(仅故障 failed 后 60s,窗口
 * 归协调器)。源会话已故障终止、播放面已卸载:无存活进度泵可复用 —— 暂停确认以
 * 「未接受」事实收口(恢复流不做 carry 暂停确认,不建第二泵、零 /progress;真要
 * carry 时由显式确认面提交并受服务端 ledger 校验/409 SOURCE_PROGRESS_PENDING
 * 兜底重新确认),源停止由 failed 终态与消费路径既有收口承担。
 */
function RecoverSwitchPanel({ sessionId, generation }: { readonly sessionId: string; readonly generation: number }): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const transition = useVodTransition({
    sessionId,
    generation,
    videoRef,
    action: 'recover_switch',
    pauseAndFlush: () =>
      Promise.resolve({ sessionAccepted: false, acceptedGeneration: 1, acceptedSampleSeq: 1, acceptedPositionSeconds: null }),
    stopOnce: () => Promise.resolve(),
  });
  const openRef = useRef(transition.openDrawer);
  openRef.current = transition.openDrawer;
  useEffect(() => {
    openRef.current(); // 挂载即打开恢复候选面(60s 窗口内)
  }, []);
  return <VodSourceSwitcher transition={transition} />;
}

export function ActionCoordinator({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(coordinatorReducer, undefined, createInitialCoordinatorState);
  // 镜像 ref:每次 dispatch 同步推进,使异步回调的代次/意图守卫读到「最新」状态,
  // 不受 React 批处理渲染时序影响(播放链 alive() 与 play() 的意图号读取都依赖它)
  const stateRef = useRef(state);
  const dispatchWithMirror = useCallback((action: CoordinatorAction): void => {
    stateRef.current = coordinatorReducer(stateRef.current, action);
    dispatch(action);
  }, []);
  const session = useSession();
  const navigate = useNavigate();
  /** selectionPin 展示用的目标档案摘要(id 同时进 reducer 供代次守卫/测试) */
  const [targetProfile, setTargetProfile] = useState<ProfileSummary | null>(null);
  /** picker 直选(无 PIN)失败提示 */
  const [selectError, setSelectError] = useState<string | null>(null);
  // 换源恢复窗口(010 T075;F1/F2):媒体故障(onMediaFailure)注册 60s recover_switch
  // 入口,过期收口为「重新播放」新普通播放;窗口随播放面关闭/新播放意图/身份撤销终止。
  const [recoverPhase, setRecoverPhase] = useState<RecoverPhase>('idle');
  const [recoverPanelOpen, setRecoverPanelOpen] = useState(false);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 容灾尝试追踪(016 T020;跨容灾意图累积,ref 不随意图替换重建):
  // - attempted:已尝试线路(含刚失败线路)—— selectNextLine 跳过,全尽返回 null 防死循环;
  // - toasted:已提示过的目标线路 —— Toast 单次/去重,同一线路连续失败只提示一次。
  // 清零时机:手动新播放(play)/播放面收口(terminatePlaybackIntent)。
  const lineFailoverRef = useRef<{ attempted: Set<string>; toasted: Set<string> }>({
    attempted: new Set<string>(),
    toasted: new Set<string>(),
  });
  const resetLineFailoverTracking = useCallback((): void => {
    lineFailoverRef.current = { attempted: new Set<string>(), toasted: new Set<string>() };
  }, []);

  const closeRecoverWindow = useCallback((): void => {
    if (recoverTimerRef.current !== null) {
      clearTimeout(recoverTimerRef.current);
      recoverTimerRef.current = null;
    }
    setRecoverPhase('idle');
    setRecoverPanelOpen(false);
  }, []);

  /** 注册恢复窗口(媒体故障客户端时刻起算;重复故障重挂 60s,不叠加计时器) */
  const armRecoverWindow = useCallback((): void => {
    if (recoverTimerRef.current !== null) {
      clearTimeout(recoverTimerRef.current);
    }
    setRecoverPhase('window');
    setRecoverPanelOpen(false);
    recoverTimerRef.current = setTimeout(() => {
      recoverTimerRef.current = null;
      // 过期:recover 入口收口,「重新播放」承载新普通播放(api.md §6 过期明确新播放)
      setRecoverPhase('expired');
      setRecoverPanelOpen(false);
    }, RECOVER_WINDOW_MS);
  }, []);

  // 启动期(anonymous)自动检查一次 /setup/status:未初始化弹窗配置(FR-006);
  // 状态未知(503)不自动弹窗 —— 不误判为未初始化而开放配置。
  useEffect(() => {
    if (session.status !== 'anonymous' || stateRef.current.autoOpenChecked) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const status = await publicFetch<SetupStatus>('/setup/status');
        if (!cancelled) {
          dispatchWithMirror({ type: 'autoOpen', wantsInitialize: !status.initialized });
        }
      } catch {
        if (!cancelled) {
          dispatchWithMirror({ type: 'autoOpen', wantsInitialize: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.status]);

  const cancel = useCallback(() => {
    dispatchWithMirror({ type: 'cancel' });
    setTargetProfile(null);
    setSelectError(null);
  }, []);

  const startLogin = useCallback((returnTo?: string | null) => {
    const generation = stateRef.current.generation;
    const target = sanitizeReturnTarget(returnTo ?? currentPathTarget());
    void (async () => {
      try {
        const status = await publicFetch<SetupStatus>('/setup/status');
        if (isStaleIntent(stateRef.current, generation)) {
          return; // 期间已有新动作/取消:旧回调不得重开弹层
        }
        dispatchWithMirror({
          type: 'start',
          step: status.initialized ? 'login' : 'initialize',
          returnTo: target,
          entry: 'header-login',
        });
      } catch (error) {
        if (isStaleIntent(stateRef.current, generation)) {
          return;
        }
        // /setup/status 503:显示重试,不误判为未初始化而开放配置(T041)
        if (!(isFetchApiError(error) && error.status === 503)) {
          void error;
        }
        dispatchWithMirror({ type: 'start', step: 'setup-unavailable', returnTo: target, entry: 'header-login' });
      }
    })();
  }, []);

  // ---------------------------------------------------------------------------
  // 播放管线(T053):abandon / runPlayback / close
  // ---------------------------------------------------------------------------

  /**
   * 幂等废弃「无进度泵」会话(010 T079 收口:仅 authorizing/preparing/unavailable
   * 等 PlayerView 未挂载相位 —— 客户端从未安装进度泵,空 stop 即唯一清理)。
   * playing 相位一律由泵统一收口(stopOnce 唯一 Promise:携 final/未确认空 stop),
   * 协调器绝不并发第二个 /stop —— 空 stop 先到终态化会话会让泵 final 成为无害
   * no-op,丢失最终保存(T104 同款守卫,经 terminatePlaybackIntent 统一)。
   */
  const abandonSession = useCallback((sessionId: string): void => {
    void privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
      body: {},
    }).catch(() => undefined);
  }, []);

  /**
   * 播放会话统一收口(010 T079;ui.md §2「退出按钮/hook 清理不各生成一份」/
   * playback-state §4):关闭播放面、退出登录、切档三条路径的**唯一调用点** ——
   * 一律先废弃意图(playEnd → PlayerView 随意图面卸载 → 进度泵统一收口 stopOnce:
   * abort 在途 + 立即 /stop,不被保存阻塞);仅「泵尚不存在」的相位才由
   * abandonSession 补发幂等空 stop 卫生清理。身份撤销路径(退出/切档)在 playing
   * 相位不再并发空 stop:旧实现于此双发 /stop,空 stop 先到会令泵 final 成 no-op
   * 丢失最终保存;身份撤销后旧身份零补报(泵 stopped 后不入队/不派发/不重试,
   * 离线无补报队列可重放 —— 服务端身份撤销事务+watchdog 兜底)。
   */
  const terminatePlaybackIntent = useCallback((): void => {
    const current = stateRef.current.playback;
    if (current === null) {
      return;
    }
    closeRecoverWindow(); // 播放面收口即撤销换源恢复窗口(T075;60s 窗随意图生命周期)
    resetLineFailoverTracking(); // 容灾尝试记录随播放面收口清零(016 T020;新一轮观看完整顺位)
    dispatchWithMirror({ type: 'playEnd', intentId: current.intentId });
    if (current.sessionId !== null && current.phase !== 'playing') {
      abandonSession(current.sessionId);
    }
  }, [abandonSession, closeRecoverWindow, resetLineFailoverTracking]);

  /**
   * 关闭播放面(用户主动退出):统一收口唯一入口(terminatePlaybackIntent)。
   * playing 相位的 stop 由 PlayerView 卸载时的进度泵承担(携 finalProgress /
   * 未确认时空 stop + 未保存提示),本处不并发空 stop(T104;vod-autoplay B2 钉
   * 播放面即时收口);authorizing/preparing/unavailable 仍走无泵幂等清理。
   */
  const close = useCallback((): void => {
    terminatePlaybackIntent();
  }, [terminatePlaybackIntent]);

  /**
   * 播放执行链:authorize(resolve)→ prepare(轮询,30 秒预算)→ playing(换票安装)。
   * 每一步前双重校验「当前播放意图」:playback.intentId === 捕获 intentId 且协调器代次
   * 未变 —— 换目标/取消/身份变化后,旧链路的迟到结果既不改写状态(reducer 守卫),
   * 也不再发起后续请求;已被 resolve 接受的会话补发幂等 stop。
   */
  const runPlayback = useCallback(
    (intentId: number, target: PlayTarget): void => {
      const capturedGeneration = stateRef.current.generation;
      const alive = (): boolean =>
        stateRef.current.playback?.intentId === intentId &&
        !isStaleIntent(stateRef.current, capturedGeneration);
      void (async () => {
        // 1. authorize:仅已选档会话才会走到这里(游客路径在 play() 内已进入登录意图)
        // 016 T020/T021:target.lineId(OSD 手动换线/容灾续接)透传 resolve 请求体
        let dto: PlaybackDto;
        try {
          dto = await privateFetch<PlaybackDto>('/playback/resolve', {
            method: 'POST',
            body: {
              mediaId: target.mediaId,
              startMode: target.startMode,
              ...(target.lineId !== undefined ? { lineId: target.lineId } : {}),
            },
          });
        } catch (error) {
          if (!alive()) {
            return;
          }
          dispatchWithMirror({ type: 'playPatch', intentId, patch: { phase: 'unavailable', message: stableRejectMessage(error) } });
          return;
        }
        if (!alive()) {
          abandonSession(dto.id);
          return;
        }
        dispatchWithMirror({
          type: 'playPatch',
          intentId,
          patch: {
            phase: 'preparing',
            sessionId: dto.id,
            playbackGeneration: dto.generation,
            // 016 T020:多线路投影落 state(resolve 201;OSD 与容灾顺位的事实面)
            lines: dto.lines ?? [],
            selectedLineId: dto.selectedLineId ?? null,
          },
        });
        // 2. prepare:轮询会话状态直到 ready/playing 或稳定失败(准备时限沿用 004 预算)
        const deadline = Date.now() + PREPARE_BUDGET_MS;
        while (Date.now() < deadline) {
          await delay(PREPARE_POLL_MS);
          if (!alive()) {
            abandonSession(dto.id);
            return;
          }
          let status: PlaybackDto | null = null;
          try {
            status = await privateFetch<PlaybackDto>(`/playback/sessions/${encodeURIComponent(dto.id)}`);
          } catch {
            continue; // 单次查询失败不终止准备(下一拍重试;总体仍受 30 秒预算约束)
          }
          if (!alive()) {
            abandonSession(dto.id);
            return;
          }
          if (status.state === 'ready' || status.state === 'playing') {
            // 3. playing:换票并安装受控网关入口(绑定当前 intentId;URL 不落 localStorage)
            try {
              const ticket = await privateFetch<TicketReply>(`/playback/sessions/${encodeURIComponent(dto.id)}/renew`, {
                method: 'POST',
                body: { expectedGeneration: status.generation },
              });
              if (!alive()) {
                abandonSession(dto.id);
                return;
              }
              dispatchWithMirror({
                type: 'playPatch',
                intentId,
                patch: {
                  phase: 'playing',
                  delivery: status.delivery,
                  playbackGeneration: ticket.generation,
                  playbackUrl: ticket.playbackUrl,
                  ticketExpiresAt: ticket.ticketExpiresAt,
                  // T101:resume 由服务端冻结的起播位置(US4;beginning/无有效进度恒 0)
                  presentationStartSeconds: status.presentationStartSeconds,
                },
              });
            } catch (error) {
              if (!alive()) {
                abandonSession(dto.id);
                return;
              }
              dispatchWithMirror({ type: 'playPatch', intentId, patch: { phase: 'unavailable', message: stableRejectMessage(error) } });
            }
            return;
          }
          if (status.state === 'failed') {
            dispatchWithMirror({ type: 'playPatch', intentId, patch: { phase: 'unavailable', message: failureMessage(status.failureCode) } });
            return;
          }
          if (status.state === 'ended' || status.state === 'interrupted') {
            dispatchWithMirror({ type: 'playPatch', intentId, patch: { phase: 'unavailable', message: '播放已终止,请重新发起。' } });
            return;
          }
          // preparing:继续下一拍
        }
        // 起播时限(30 秒)耗尽:废弃会话并稳定提示
        if (!alive()) {
          return;
        }
        abandonSession(dto.id);
        dispatchWithMirror({ type: 'playPatch', intentId, patch: { phase: 'unavailable', message: '准备超时,请稍后重试。' } });
      })();
    },
    [abandonSession],
  );

  /**
   * 播放启动(016 T020 拆分):play() 的原始链路体,供两类调用方共享 ——
   * 手动入口(play/重试/重新播放/选档续跑)与播放面换线(容灾续接/OSD 手动换线)。
   * 目标 lineId 缺省时由服务端优选;携带时透传 resolve(新 session 契约语义)。
   */
  const launchPlayback = useCallback(
    (request: PlayActionRequest): void => {
      const target: PlayTarget = {
        mediaId: request.mediaId,
        title: request.title,
        startMode: request.startMode ?? 'beginning',
        ...(request.lineId !== undefined ? { lineId: request.lineId } : {}),
      };
      const intentId = stateRef.current.playbackIntentSeq + 1;
      const current = session;
      const needsAuth =
        current.status !== 'authenticated' || current.session === null || current.session.activeProfile === null;
      if (needsAuth) {
        // 游客/未选档:登录选档完成前零 /playback/ 请求(FR-011;选档完成后由协调器续跑)
        dispatchWithMirror({ type: 'playDefer', intentId, target });
        if (current.status !== 'authenticated' || current.session === null) {
          startLogin(currentPathTarget());
        } else {
          dispatchWithMirror({
            type: 'start',
            step: current.session.bootstrapRequired ? 'bootstrap' : 'picker',
            returnTo: sanitizeReturnTarget(currentPathTarget()),
            entry: 'play',
          });
        }
        return;
      }
      dispatchWithMirror({ type: 'playStart', intentId, target });
      closeRecoverWindow(); // 新播放意图即撤销恢复窗口(T075;过期后唯一出路是显式重播)
      runPlayback(intentId, target);
    },
    [session, runPlayback, startLogin, closeRecoverWindow],
  );

  // ---------------------------------------------------------------------------
  // 播放面自动容灾换线(016 T020;research.md R4 / data-model.md §3.1 Failover 状态机)
  // ---------------------------------------------------------------------------

  /**
   * 容灾致命错误入口所用的 Toast(单独声明于容灾小节;useAppToast 引用稳定)。
   */
  const lineFailoverToast = useAppToast();

  /**
   * 播放面致命错误统一入口(016 T020 自动容灾;容灾优先裁决):
   *
   * - 仅 playing 相位响应(意图面守卫):非 playing 相位的迟到错误事件(PlayerView
   *   卸载边界/引擎残留回调)一律忽略;
   * - 该频道 lines ≥2 时按 priority ASC 选**未尝试过的下一线路**(selectNextLine,
   *   attempted 含刚失败线路),以 {…target, lineId} 发起新 resolve —— 复用「新意图
   *   取代旧意图」机制,resolve 重复调用 = 新 session 为现行契约语义(016 api.md
   *   §2.1;与 010「就地换流」transition-intents 是两条通道:换线跨物理源会话,
   *   不携带 transitionIntentId);Toast 单次提示(去重见 lineFailoverRef);
   * - **与 010 recover 面关系(二选一裁决,容灾优先)**:只要有未尝试线路,容灾
   *   直接接管,不落 unavailable、不 arm recover 窗口、不重复弹 recover 面板;
   *   全部线路试尽(selectNextLine = null)或无多线路语义(lines < 2)时,才落回
   *   既有通道:onMediaFailure 通道 → armRecoverWindow(60s recover_switch 语义
   *   不变),onTerminated 通道 → unavailable 稳定提示(消息面不变)—— 不另建
   *   第二错误屏,全尽后的缺省错误面与手动换源/重试出口完全复用现状;
   * - 双通道不双发:引擎 onFatalError 先后触发 onMediaFailure 与 onTerminated
   *   (player-view.tsx onFatalError 同步两连发),首个动作已将意图推进出新播放链
   *   (phase 离开 playing),迟到回调被相位守卫拦截,容灾至多触发一次。
   */
  const handlePlaybackFatalError = useCallback(
    (message: string | null): void => {
      const current = stateRef.current.playback;
      if (current === null || current.phase !== 'playing') {
        return; // 容灾只从 playing 相位发起;旧意图/非播放相位的错误事件不响应
      }
      if (current.lines.length >= 2) {
        const tracking = lineFailoverRef.current;
        if (current.selectedLineId !== null) {
          tracking.attempted.add(current.selectedLineId);
        }
        const next = selectNextLine(current.lines, current.selectedLineId, tracking.attempted);
        if (next !== null) {
          if (!tracking.toasted.has(next.lineId)) {
            tracking.toasted.add(next.lineId);
            lineFailoverToast.warning(`当前线路异常,已自动切换至「${next.label}」`);
          }
          launchPlayback({
            mediaId: current.target.mediaId,
            title: current.target.title,
            startMode: current.target.startMode,
            lineId: next.lineId,
          });
          return; // 容灾接管:不进入 unavailable/recover 通道
        }
      }
      // 容灾不可用/全线路试尽:落回既有缺省通道(016 R4「全部失败才进缺省错误屏」)
      if (message === null) {
        armRecoverWindow();
      } else {
        dispatchWithMirror({
          type: 'playPatch',
          intentId: current.intentId,
          patch: { phase: 'unavailable', message },
        });
      }
    },
    [armRecoverWindow, dispatchWithMirror, launchPlayback, lineFailoverToast],
  );

  /** OSD 手动换线(016 T021):以 {…target, lineId} 发起新 resolve(新 session 契约语义);
   *  容灾追踪不清零 —— 从指定线路继续顺位(R4:手动选择后容灾仍可用) */
  const handleManualLineSelect = useCallback(
    (lineId: string): void => {
      const current = stateRef.current.playback;
      if (current === null || current.phase !== 'playing') {
        return;
      }
      launchPlayback({
        mediaId: current.target.mediaId,
        title: current.target.title,
        startMode: current.target.startMode,
        lineId,
      });
    },
    [launchPlayback],
  );

  /**
   * 发起播放意图(手动入口):游客/未选档 → 暂存并进入登录选档意图(完成后续跑);
   * 已选档 → 直接 authorize。容灾尝试记录清零 —— 手动新播放不继承上一轮失败顺位。
   */
  const play = useCallback(
    (request: PlayActionRequest): void => {
      resetLineFailoverTracking();
      launchPlayback(request);
    },
    [resetLineFailoverTracking, launchPlayback],
  );

  /**
   * 换源恢复过期出路(T075 F2):「重新播放」= 新普通播放 —— resolve 带 startMode,
   * 不借过期 intent/carry(零 transitionIntentId),不自动循环尝试来源。
   */
  const replayAfterRecoverExpired = useCallback((): void => {
    const current = stateRef.current.playback;
    closeRecoverWindow();
    if (current === null) {
      return;
    }
    play({ mediaId: current.target.mediaId, title: current.target.title, startMode: 'beginning' });
  }, [closeRecoverWindow, play]);

  // 退出/换档/会话撤销(身份键变化)= 身份撤销(T055 观察 + T079 统一收口):
  // 废弃在途播放意图 → 播放面卸载 → 进度泵统一收口 stopOnce(唯一 /stop,abort
  // 在途、不被保存阻塞;服务端身份变化事务已终态化并 flush,客户端卫生清理恰一次,
  // 不并发第二份空 stop)。旧身份零补报:泵 stopped 后零入队/零派发/零重试(T048
  // 守卫),本组件亦不缓存任何旧身份重放队列。
  // 观看身份观察(T055):仅「已有观看档案 → 另一档案/无档案」才废弃在途播放
  // (换档/档案停用/退出/会话撤销)。''→档案(登录/选档完成)是身份获得而非变化 ——
  // 选档完成恰恰是暂存播放续跑的起点,不得误杀;档案间切换或失档才终止播放。
  const activeProfileId = session.session?.activeProfile?.id ?? '';
  const activeProfileRef = useRef(activeProfileId);
  useEffect(() => {
    const previous = activeProfileRef.current;
    if (previous !== '' && previous !== activeProfileId) {
      // identity-revoked:泵统一收口(playing 相位零并发空 stop,T079)
      terminatePlaybackIntent();
    }
    activeProfileRef.current = activeProfileId;
  }, [activeProfileId, terminatePlaybackIntent]);

  // ---------------------------------------------------------------------------
  // 意图入口(布局层调用)
  // ---------------------------------------------------------------------------

  const startProfileSelection = useCallback(
    (returnTo?: string | null) => {
      if (session.status !== 'authenticated' || session.session === null) {
        startLogin(returnTo); // 未登录先登录
        return;
      }
      dispatchWithMirror({
        type: 'start',
        step: session.session.bootstrapRequired ? 'bootstrap' : 'picker',
        returnTo: sanitizeReturnTarget(returnTo ?? currentPathTarget()),
        entry: 'identity-menu',
      });
    },
    [session, startLogin],
  );

  /** 设置入口(013 T087 演进,ADR-0017):直达目标,零 PIN/门禁;管理路由由 AdminRouteGuard 拦截 */
  const startSettings = useCallback(
    (returnTo?: string | null) => {
      const target = sanitizeReturnTarget(returnTo ?? currentPathTarget());
      void navigate(target);
    },
    [navigate],
  );

  // ---------------------------------------------------------------------------
  // 意图推进(异步回调全部带代次守卫)
  // ---------------------------------------------------------------------------

  const handleInitialized = useCallback(() => {
    // 201 仅建家庭与账号 → 显式登录(不自动登录,FR-007)
    dispatchWithMirror({ type: 'goto', step: 'login' });
  }, []);

  const handleLoginSuccess = useCallback(
    (next: AccountSession) => {
      session.applySession(next);
      dispatchWithMirror({ type: 'goto', step: next.bootstrapRequired ? 'bootstrap' : 'picker' });
    },
    [session],
  );

  const handleBootstrapSuccess = useCallback(() => {
    // 首建成功:刷新会话事实(bootstrapRequired 翻转、activeProfile 仍 null)→ 选档
    const generation = stateRef.current.generation;
    void session.refresh().then(() => {
      if (isStaleIntent(stateRef.current, generation)) {
        return;
      }
      dispatchWithMirror({ type: 'goto', step: 'picker' });
    });
  }, [session]);

  /** select 并完成意图:回原业务目标或首页,不停留在选档界面;暂存播放意图随后续跑 */
  const performSelect = useCallback(
    async (profileId: string, generation: number): Promise<void> => {
      const dto = await privateFetch<AccountSession>(`/profiles/${profileId}/select`, {
        method: 'POST',
        body: {},
      });
      if (isStaleIntent(stateRef.current, generation)) {
        return; // 旧回调:不回填身份、不导航
      }
      session.applySession(dto);
      void navigate(sanitizeReturnTarget(stateRef.current.returnTo));
      const pending = stateRef.current.pendingPlay;
      dispatchWithMirror({ type: 'complete' });
      setTargetProfile(null);
      // US3 场景 1:选档完成 → 继续原目标起播(服务端届时按最新策略/资源重判,场景 5)。
      // 延后到状态提交后续跑:播放链的代次守卫必须捕获 complete 之后的最新代次,
      // 否则本链会被自己的 complete 视为过期而废弃。
      if (pending !== null) {
        window.setTimeout(() => {
          const current = stateRef.current;
          // 续跑守卫:暂存意图未被取消/替代(cancel 清空、新意图换号)才起播
          if (current.pendingPlay?.intentId !== pending.intentId) {
            return;
          }
          dispatchWithMirror({ type: 'playStart', intentId: pending.intentId, target: pending.target });
          runPlayback(pending.intentId, pending.target);
        }, 0);
      }
    },
    [session, navigate, runPlayback],
  );

  const handlePick = useCallback(
    (profile: ProfileSummary) => {
      setSelectError(null);
      const generation = stateRef.current.generation;
      if (profile.pinProtected) {
        setTargetProfile(profile);
        dispatchWithMirror({ type: 'targetProfile', profileId: profile.id });
        dispatchWithMirror({ type: 'goto', step: 'selectionPin' });
        return;
      }
      void performSelect(profile.id, generation).catch((error) => {
        if (isStaleIntent(stateRef.current, generation)) {
          return;
        }
        setSelectError(isFetchApiError(error) && error.status === 401 ? '登录状态已失效,请重新登录' : '选档失败,请重试');
      });
    },
    [performSelect],
  );

  /** 选档 PIN 解锁 → 选档(错误抛回步骤展示:423 锁定 / 403 剩余次数) */
  const handleUnlockSubmit = useCallback(
    async (pin: string): Promise<void> => {
      const generation = stateRef.current.generation;
      const profileId = stateRef.current.targetProfileId;
      if (profileId === null) {
        return;
      }
      await privateFetch<{ unlocked: boolean }>(`/profiles/${profileId}/unlock`, {
        method: 'POST',
        body: { pin },
      });
      if (isStaleIntent(stateRef.current, generation)) {
        return; // 已取消/新意图:旧解锁结果不得继续选档
      }
      try {
        await performSelect(profileId, generation);
      } catch (error) {
        if (!isStaleIntent(stateRef.current, generation)) {
          throw error; // 未失效才由步骤展示错误
        }
      }
    },
    [performSelect],
  );

  const handlePinRecovered = useCallback(() => {
    // 恢复成功(204):回到选档 PIN 验证,用新 PIN 重新验证(不直接打开设置;
    // 服务端重设 PIN 已撤销一切旧选档授予,旧 PIN 不再可用)
    dispatchWithMirror({ type: 'goto', step: 'selectionPin' });
  }, []);

  // ---------------------------------------------------------------------------
  // 程序化意图入口(集成桥):`window.dispatchEvent(new CustomEvent('hmp:auth-intent',
  // { detail: { action: 'login' | 'profile-selection' | 'logout', returnTo? } }))`。
  // PublicLayout 正式接线(useAuthAction / <IdentityMenu />)由 lead 完成前,
  // e2e 与嵌入方经此触发同一协调器代码路径;接线后仍可作为非 UI 触发面保留。
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function onIntent(event: Event): void {
      const detail = (event as CustomEvent<{ action?: string; returnTo?: string | null }>).detail;
      if (detail?.action === 'login') {
        startLogin(detail.returnTo ?? null);
      } else if (detail?.action === 'profile-selection') {
        startProfileSelection(detail.returnTo ?? null);
      } else if (detail?.action === 'settings') {
        startSettings(detail.returnTo ?? null);
      } else if (detail?.action === 'logout') {
        void session.logout();
      }
    }
    window.addEventListener('hmp:auth-intent', onIntent);
    return () => {
      window.removeEventListener('hmp:auth-intent', onIntent);
    };
  }, [startLogin, startProfileSelection, startSettings, session]);

  // ---------------------------------------------------------------------------
  // 渲染:唯一受控 Modal + 分步内容;playing 态全屏挂载播放器(T055,无路由面)
  // ---------------------------------------------------------------------------

  const stepTitles: Record<Exclude<AuthStep, 'idle'>, string> = {
    'setup-unavailable': '初始化状态未知',
    initialize: '配置家庭主账号',
    login: '登录',
    bootstrap: '创建主档案',
    picker: '选择 Profile',
    selectionPin: '输入档案 PIN',
    pinRecovery: '重设主档案 PIN',
  };

  function renderStep(): ReactNode {
    switch (state.step) {
      case 'setup-unavailable':
        return (
          <div className="flex flex-col gap-4">
            <Alert status="warning">
              <AlertContent>
                <AlertTitle>初始化状态未知</AlertTitle>
                <AlertDescription>无法确认部署是否已初始化,请稍后重试。</AlertDescription>
              </AlertContent>
            </Alert>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onPress={cancel}>
                取消
              </Button>
              <Button variant="primary" size="sm" onPress={() => startLogin(state.returnTo)}>
                重试
              </Button>
            </div>
          </div>
        );
      case 'initialize':
        return <SetupStep formEpoch={state.formEpoch} onSuccess={handleInitialized} onCancel={cancel} />;
      case 'login':
        return <LoginStep formEpoch={state.formEpoch} onSuccess={handleLoginSuccess} onCancel={cancel} />;
      case 'bootstrap':
        return <BootstrapStep formEpoch={state.formEpoch} onSuccess={handleBootstrapSuccess} onCancel={cancel} />;
      case 'picker':
        return (
          <div className="flex flex-col gap-3">
            <ProfilePickerStep onPick={handlePick} onCancel={cancel} />
            {selectError !== null ? (
              <p role="alert" className="text-sm text-danger">
                {selectError}
              </p>
            ) : null}
          </div>
        );
      case 'selectionPin':
        return targetProfile === null ? null : (
          <SelectionPinStep
            profile={targetProfile}
            onSubmit={handleUnlockSubmit}
            onForgotPin={() => dispatchWithMirror({ type: 'goto', step: 'pinRecovery' })}
            onCancel={cancel}
          />
        );
      case 'pinRecovery':
        return <PinRecoveryStep formEpoch={state.formEpoch} onSuccess={handlePinRecovered} onCancel={cancel} />;
      case 'idle':
        return null;
    }
  }

  const open = state.step !== 'idle';
  const playback = state.playback;

  return (
    <AuthActionContext.Provider
      value={{
        isOpen: open,
        step: state.step,
        startLogin,
        startProfileSelection,
        startSettings,
        cancel,
      }}
    >
      <PlayActionContext.Provider value={{ play, close, playback }}>
        {/* 连播开关 Provider(T065):全局播放唯一协调器挂载(ui.md §2 惯例处);
            播放面头部开关与 PlayerView 本地门同源消费,状态全局一致 */}
        <VodAutoplayPreferenceProvider>
        {children}
        <Modal.Root
          isOpen={open}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              cancel(); // Esc/点击遮罩 = 取消:清凭据与意图,返回原页面
            }
          }}
        >
          {/* RAC 组合:Backdrop(Overlay)内嵌 Container(Modal);随 open 条件挂载,
              保证关闭后遮罩彻底卸载、不拦截公共区点击(ui.md §3 单受控 Modal) */}
          {open ? (
            <Modal.Backdrop>
              <Modal.Container placement="center" scroll="inside" size="md">
                <Modal.Dialog aria-label={stepTitles[state.step as Exclude<AuthStep, 'idle'>]}>
                  <Modal.Header>
                    <Modal.Heading>{stepTitles[state.step as Exclude<AuthStep, 'idle'>]}</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body>{renderStep()}</Modal.Body>
                </Modal.Dialog>
              </Modal.Container>
            </Modal.Backdrop>
          ) : null}
        </Modal.Root>
        {/* 播放面(T055):authorize/prepare 为非阻塞浮动面板 —— FR-013「准备中换目标」
            要求底层内容仍可点击,新目标即时取代旧意图(见最终报告)。 */}
        {playback !== null && (playback.phase === 'authorizing' || playback.phase === 'preparing') ? (
          <div
            data-testid="playback-preparing"
            role="status"
            className="fixed bottom-4 end-4 z-40 flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-lg"
          >
            <Spinner aria-label="正在准备播放" />
            <span className="text-sm text-foreground">
              {playback.phase === 'authorizing' ? '正在请求播放授权…' : `正在准备「${playback.target.title}」…`}
            </span>
            <Button size="sm" variant="ghost" onPress={close} aria-label="取消播放">
              取消
            </Button>
          </div>
        ) : null}
        {/* 播放面(T055;009 非模态浮层):playing/unavailable 为 fixed 居中浮层 ——
            与 preparing 浮动面板同一先例(fixed div + HeroUI Button + 语义 token)。
            组件裁决(spec 009 修正留档):HeroUI Modal 族与本场景语义错配——
            Modal.Root 是 DialogTrigger 型(带触发器包装/Pressable 警告,不适配无触发器
            常驻浮层);Modal.Backdrop 模态链会把弹层外全部内容 aria-hidden + inert
            (useModalOverlay,首版「设置入口没了」根因:遮罩劫持点击 + 页面级禁用);
            Modal.Container 类型层面 Exclude 掉 isOpen(假定 state 来自 Root context)。
            故浮层壳用语义 token 样式 + role="dialog",页面在播放期间全部可点可用;
            路由切换不掉不变(协调器位于路由树之外);无遮罩/Esc dismiss 通道(防误关),
            关闭仅经「退出」走 close() 统一路径。 */}
        {/* 010 回归修复(009「播放期间页面全部可点」):宽度以视口可用高度反推 16:9 上限,
            防止浮层在矮视口(≤720p)遮蔽头部公共导航/身份菜单(T082 Q9 导航 e2e 实测阻塞点);
            注释原位于 section 属性列表内,为非法 JSX(T090 lint/typecheck 实测),移至合法子节点位。 */}
        {playback !== null && (playback.phase === 'playing' || playback.phase === 'unavailable') ? (
          <section
            role="dialog"
            aria-modal="false"
            aria-label={`播放 ${playback.target.title}`}
            data-testid="playback-surface"
            className="pointer-events-auto fixed left-1/2 top-1/2 z-50 flex w-[min(94vw,1120px,calc((100vh-12rem)*16/9))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-black shadow-2xl"
          >
            <header className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-2">
              <h2 className="min-w-0 truncate text-base font-medium text-foreground">{playback.target.title}</h2>
              <div className="flex shrink-0 items-center gap-2">
                {/* OSD 线路切换(T021;ui-experience §3;playing 相位且 lines ≥2 才有换线面,
                    组件内单线路/空清单自行返回 null):手动换线 = 新 resolve/新 session 契约语义 */}
                {playback.phase === 'playing' ? (
                  <PlayerLineSwitcher
                    lines={playback.lines}
                    selectedLineId={playback.selectedLineId}
                    onSelect={handleManualLineSelect}
                  />
                ) : null}
                <AutoplayNextToggle />
                <Button size="sm" variant="ghost" onPress={close} aria-label="退出播放">
                  退出
                </Button>
              </div>
            </header>
            {playback.phase === 'playing' && playback.playbackUrl !== null && playback.sessionId !== null ? (
              <div className="aspect-video w-full bg-black">
                <PlayerView
                  sessionId={playback.sessionId}
                  generation={playback.playbackGeneration ?? 1}
                  playbackUrl={playback.playbackUrl}
                  ticketExpiresAt={playback.ticketExpiresAt ?? ''}
                  delivery={playback.delivery}
                  presentationStartSeconds={playback.presentationStartSeconds ?? 0}
                  // 016 T020:致命错误统一经容灾入口(自动换线优先;全尽后落回
                  // recover 窗口/unavailable 既有通道,见 handlePlaybackFatalError 裁决)
                  onMediaFailure={() => handlePlaybackFatalError(null)}
                  onTerminated={handlePlaybackFatalError}
                  onRenew={(url, expiresAt) => {
                    // 续期换装:URL/到期时间更新(意图面收口;URL 不落任何持久存储)
                    dispatchWithMirror({
                      type: 'playPatch',
                      intentId: playback.intentId,
                      patch: { playbackUrl: url, ticketExpiresAt: expiresAt },
                    });
                  }}
                />
              </div>
            ) : (
              <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-3 bg-black px-6 text-center">
                <p role="alert" className="text-sm text-white/80">
                  {playback.message ?? '该内容当前不可播放。'}
                </p>
                {/* 换源恢复(T075 F1;ui.md §4 媒体故障 60s recover_switch 路径):
                    窗口内提供恢复入口,复用换源候选流(不退出播放器重搜) */}
                {recoverPhase === 'window' && !recoverPanelOpen && playback.sessionId !== null ? (
                  <Button size="sm" variant="ghost" onPress={() => setRecoverPanelOpen(true)}>
                    换源恢复
                  </Button>
                ) : null}
                {/* 恢复候选流宿主(recover_switch;面板挂同一 unavailable 浮层内) */}
                {recoverPhase === 'window' && recoverPanelOpen && playback.sessionId !== null ? (
                  <RecoverSwitchPanel sessionId={playback.sessionId} generation={playback.playbackGeneration ?? 1} />
                ) : null}
                {/* 60s 过期(T075 F2):recover 入口收口,「重新播放」承载新普通播放 */}
                {recoverPhase === 'expired' ? (
                  <Button size="sm" variant="ghost" onPress={replayAfterRecoverExpired}>
                    重新播放
                  </Button>
                ) : null}
                {/* 授权拒绝/准备失败的重试出口(012 T013;FR-007、ui.md §1.3「展示原因 +
                    重试/返回详情」):换源窗口外(idle)的 unavailable —— authorize 稳定
                    拒绝、prepare 失败/超时等 —— 复用同一「新普通播放」路径:play() 以
                    新意图取代旧意图(旧回调经代次守卫废弃,旧会话已由收口清理),同一
                    目标重新 authorize,不产生并行会话;窗口内由「换源恢复」、过期后由
                    「重新播放」承接,不重复提供重试入口。 */}
                {recoverPhase === 'idle' ? (
                  <Button size="sm" variant="ghost" onPress={replayAfterRecoverExpired} aria-label="重试播放">
                    重试
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onPress={close}>
                  关闭
                </Button>
              </div>
            )}
          </section>
        ) : null}
        </VodAutoplayPreferenceProvider>
      </PlayActionContext.Provider>
    </AuthActionContext.Provider>
  );
}
