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
 *   取消登录/选档废弃暂存播放意图(不自动播放);退出/换档(身份键变化)废弃在途
 *   播放与会话(服务端同事务终态化,前端补发幂等 stop 仅作卫生清理);
 * - playing 态由协调器全屏挂载播放器(features/playback/player-view),不另建路由面;
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
import { SettingsPinForm } from '../features/settings/settings-unlock-gate';
import { useSettingsAccess } from '../features/settings/settings-access-provider';

export interface AuthActionApi {
  /** 弹层是否打开 */
  isOpen: boolean;
  step: AuthStep;
  /** 游客登录入口(未初始化时先走 initialize;状态未知显示重试,不开放配置) */
  startLogin: (returnTo?: string | null) => void;
  /** 已登录未选档:选择 Profile 入口(bootstrapRequired 时先首建) */
  startProfileSelection: (returnTo?: string | null) => void;
  /** 主 Profile 设置入口:未解锁走 settingsPin 弹层,已解锁直达目标(ui.md §3/§7) */
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

/** 统一登录/选档动作入口(US3 播放等继续经同一协调器扩展) */
export function useAuthAction(): AuthActionApi {
  const value = useContext(AuthActionContext);
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
  const settingsAccess = useSettingsAccess();
  const navigate = useNavigate();
  /** selectionPin 展示用的目标档案摘要(id 同时进 reducer 供代次守卫/测试) */
  const [targetProfile, setTargetProfile] = useState<ProfileSummary | null>(null);
  /** picker 直选(无 PIN)失败提示 */
  const [selectError, setSelectError] = useState<string | null>(null);

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

  /** 幂等废弃已接受的播放会话(换目标/超时/关闭时的客户端卫生;服务端语义兜底) */
  const abandonSession = useCallback((sessionId: string): void => {
    void privateFetch<void>(`/playback/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: 'POST',
      body: {},
    }).catch(() => undefined);
  }, []);

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
        let dto: PlaybackDto;
        try {
          dto = await privateFetch<PlaybackDto>('/playback/resolve', {
            method: 'POST',
            body: { mediaId: target.mediaId, startMode: target.startMode },
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
          patch: { phase: 'preparing', sessionId: dto.id, playbackGeneration: dto.generation },
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

  /** 发起播放意图:游客/未选档 → 暂存并进入登录选档意图(完成后续跑);已选档 → 直接 authorize */
  const play = useCallback(
    (request: PlayActionRequest): void => {
      const target: PlayTarget = {
        mediaId: request.mediaId,
        title: request.title,
        startMode: request.startMode ?? 'beginning',
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
      runPlayback(intentId, target);
    },
    [session, runPlayback, startLogin],
  );

  /**
   * 关闭播放面:废弃当前意图并补发幂等 stop(用户主动退出)。
   * T104(US4):playing 相位的 stop 由 PlayerView 卸载时的进度队列承担
   * (携 finalProgress / 未确认时空 stop + 未保存提示),本处不再并发空 stop ——
   * 空 stop 先到终态化会话会让 final 成为无害 no-op,丢失最终保存。其余相位
   * (authorizing/preparing/unavailable)仍保留幂等清理;换档/退出路径同样保留
   * (服务端身份变化事务已终态化并 flush,客户端补发仅作卫生清理)。
   */
  const close = useCallback((): void => {
    const current = stateRef.current.playback;
    if (current === null) {
      return;
    }
    dispatchWithMirror({ type: 'playEnd', intentId: current.intentId });
    if (current.sessionId !== null && current.phase !== 'playing') {
      abandonSession(current.sessionId);
    }
  }, [abandonSession]);

  // 退出/换档/会话撤销(身份键变化)→ 废弃在途播放意图与会话(T055;服务端同事务
  // 已终态化并撤票,此处保证 UI 即时停止且在途请求凭代次丢弃)
  // 观看身份观察(T055):仅「已有观看档案 → 另一档案/无档案」才废弃在途播放
  // (换档/档案停用/退出/会话撤销)。''→档案(登录/选档完成)是身份获得而非变化 ——
  // 选档完成恰恰是暂存播放续跑的起点,不得误杀;档案间切换或失档才终止播放。
  const activeProfileId = session.session?.activeProfile?.id ?? '';
  const activeProfileRef = useRef(activeProfileId);
  useEffect(() => {
    const previous = activeProfileRef.current;
    if (previous !== '' && previous !== activeProfileId) {
      const current = stateRef.current.playback;
      if (current !== null) {
        dispatchWithMirror({ type: 'playEnd', intentId: current.intentId });
        if (current.sessionId !== null) {
          abandonSession(current.sessionId);
        }
      }
    }
    activeProfileRef.current = activeProfileId;
  }, [activeProfileId, abandonSession]);

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

  /** 主 Profile 设置入口(T087):已解锁直达目标,否则经 settingsPin 弹层验证 */
  const startSettings = useCallback(
    (returnTo?: string | null) => {
      const target = sanitizeReturnTarget(returnTo ?? currentPathTarget());
      if (settingsAccess.beginUnlock(target) === 'unlocked') {
        void navigate(target);
        return;
      }
      dispatchWithMirror({ type: 'start', step: 'settingsPin', returnTo: target, entry: 'identity-menu' });
    },
    [settingsAccess, navigate],
  );

  /** settingsPin 提交(T087):成功后回原目标;旧回调不得重开已取消的设置 */
  const handleSettingsPinSubmit = useCallback(
    async (pin: string) => {
      const generation = stateRef.current.generation;
      await settingsAccess.unlock(pin); // 403/423 由步骤内展示
      if (isStaleIntent(stateRef.current, generation)) {
        return;
      }
      dispatchWithMirror({ type: 'complete' });
      void navigate(sanitizeReturnTarget(stateRef.current.returnTo));
    },
    [settingsAccess, navigate],
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
    settingsPin: '输入设置 PIN',
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
      case 'settingsPin':
        return <SettingsPinForm submitLabel="验证并进入设置" onSubmit={handleSettingsPinSubmit} onCancel={cancel} />;
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
            要求底层内容仍可点击,新目标即时取代旧意图;playing/unavailable 才全屏挂载
            (播放器/稳定拒绝面)。退出即废弃在途请求与票据;不另建路由(见最终报告)。 */}
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
        {playback !== null && (playback.phase === 'playing' || playback.phase === 'unavailable') ? (
          <div
            data-testid="playback-surface"
            role="dialog"
            aria-label={`播放 ${playback.target.title}`}
            className="fixed inset-0 z-50 flex flex-col bg-black text-foreground"
          >
            <header className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-3">
              <h2 className="min-w-0 truncate text-base font-medium">{playback.target.title}</h2>
              <Button size="sm" variant="ghost" onPress={close} aria-label="退出播放">
                退出
              </Button>
            </header>
            <div className="flex min-h-0 flex-1 items-center justify-center">
              {playback.phase === 'playing' && playback.playbackUrl !== null && playback.sessionId !== null ? (
                <PlayerView
                  sessionId={playback.sessionId}
                  generation={playback.playbackGeneration ?? 1}
                  playbackUrl={playback.playbackUrl}
                  ticketExpiresAt={playback.ticketExpiresAt ?? ''}
                  delivery={playback.delivery}
                  presentationStartSeconds={playback.presentationStartSeconds ?? 0}
                  onTerminated={(message) => {
                    dispatchWithMirror({ type: 'playPatch', intentId: playback.intentId, patch: { phase: 'unavailable', message } });
                  }}
                  onRenew={(url, expiresAt) => {
                    // 续期换装:URL/到期时间更新(意图面收口;URL 不落任何持久存储)
                    dispatchWithMirror({
                      type: 'playPatch',
                      intentId: playback.intentId,
                      patch: { playbackUrl: url, ticketExpiresAt: expiresAt },
                    });
                  }}
                />
              ) : (
                <div className="flex max-w-md flex-col items-center gap-3 px-6 text-center">
                  <p role="alert" className="text-sm text-white/80">
                    {playback.message ?? '该内容当前不可播放。'}
                  </p>
                  <Button size="sm" variant="ghost" onPress={close}>
                    关闭
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </PlayActionContext.Provider>
    </AuthActionContext.Provider>
  );
}
