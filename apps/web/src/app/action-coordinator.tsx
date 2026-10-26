/**
 * ActionCoordinator(T043;ui.md §3 统一受控 Modal 意图状态机)。
 *
 * - 应用内唯一受控 Modal:uninitialized/initialize→login→bootstrap→picker→
 *   selectionPin 分步切换内容,不同时叠出多个弹层;
 * - 每动作保存 intentId/原目标(returnTo)/入口(entry);新动作递增代次(generation),
 *   旧登录/选档回调凭 isStaleIntent 失效 —— 不可重开已取消弹层、不可回填旧身份、
 *   不可触发后续动作(US3 播放经同一代次语义扩展);
 * - 选档成功回到原业务目标或首页(白名单内);取消清凭据与意图、返回原页面、
 *   不自动重开、不重复弹窗;返回目标仅接受本应用内部路径白名单,拒绝外部跳转
 *   (FR-010 防开放重定向);
 * - useAuthAction 供布局层(登录按钮/身份菜单)发起意图。
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
import { Alert, AlertContent, AlertDescription, AlertTitle, Button, Modal } from '@heroui/react';
import { isFetchApiError, privateFetch, publicFetch } from '../shared/fetch';
import { useSession } from './session-provider';
import type { AccountSession, ProfileSummary, SetupStatus } from './session-types';
import {
  coordinatorReducer,
  createInitialCoordinatorState,
  isStaleIntent,
  sanitizeReturnTarget,
  type AuthStep,
} from './action-coordinator-core';
import { SetupStep } from '../features/auth/setup-step';
import { LoginStep } from '../features/auth/login-step';
import { BootstrapStep } from '../features/auth/bootstrap-step';
import { PinRecoveryStep } from '../features/auth/pin-recovery-step';
import { ProfilePickerStep } from '../features/profiles/profile-picker-step';
import { SelectionPinStep } from '../features/profiles/selection-pin-step';

export interface AuthActionApi {
  /** 弹层是否打开 */
  isOpen: boolean;
  step: AuthStep;
  /** 游客登录入口(未初始化时先走 initialize;状态未知显示重试,不开放配置) */
  startLogin: (returnTo?: string | null) => void;
  /** 已登录未选档:选择 Profile 入口(bootstrapRequired 时先首建) */
  startProfileSelection: (returnTo?: string | null) => void;
  /** 取消当前意图(清凭据、返回原页面、不自动重开) */
  cancel: () => void;
}

const AuthActionContext = createContext<AuthActionApi | null>(null);

/** 统一登录/选档动作入口(US3 播放等继续经同一协调器扩展) */
export function useAuthAction(): AuthActionApi {
  const value = useContext(AuthActionContext);
  if (value === null) {
    throw new Error('useAuthAction 必须在 <ActionCoordinator> 内使用');
  }
  return value;
}

function currentPathTarget(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function ActionCoordinator({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(coordinatorReducer, undefined, createInitialCoordinatorState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const session = useSession();
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
          dispatch({ type: 'autoOpen', wantsInitialize: !status.initialized });
        }
      } catch {
        if (!cancelled) {
          dispatch({ type: 'autoOpen', wantsInitialize: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.status]);

  const cancel = useCallback(() => {
    dispatch({ type: 'cancel' });
    setTargetProfile(null);
    setSelectError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // 意图入口(布局层调用)
  // ---------------------------------------------------------------------------

  const startLogin = useCallback((returnTo?: string | null) => {
    const generation = stateRef.current.generation;
    const target = sanitizeReturnTarget(returnTo ?? currentPathTarget());
    void (async () => {
      try {
        const status = await publicFetch<SetupStatus>('/setup/status');
        if (isStaleIntent(stateRef.current, generation)) {
          return; // 期间已有新动作/取消:旧回调不得重开弹层
        }
        dispatch({
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
        dispatch({ type: 'start', step: 'setup-unavailable', returnTo: target, entry: 'header-login' });
      }
    })();
  }, []);

  const startProfileSelection = useCallback(
    (returnTo?: string | null) => {
      if (session.status !== 'authenticated' || session.session === null) {
        startLogin(returnTo); // 未登录先登录
        return;
      }
      dispatch({
        type: 'start',
        step: session.session.bootstrapRequired ? 'bootstrap' : 'picker',
        returnTo: sanitizeReturnTarget(returnTo ?? currentPathTarget()),
        entry: 'identity-menu',
      });
    },
    [session, startLogin],
  );

  // ---------------------------------------------------------------------------
  // 意图推进(异步回调全部带代次守卫)
  // ---------------------------------------------------------------------------

  const handleInitialized = useCallback(() => {
    // 201 仅建家庭与账号 → 显式登录(不自动登录,FR-007)
    dispatch({ type: 'goto', step: 'login' });
  }, []);

  const handleLoginSuccess = useCallback(
    (next: AccountSession) => {
      session.applySession(next);
      dispatch({ type: 'goto', step: next.bootstrapRequired ? 'bootstrap' : 'picker' });
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
      dispatch({ type: 'goto', step: 'picker' });
    });
  }, [session]);

  /** select 并完成意图:回原业务目标或首页,不停留在选档界面 */
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
      dispatch({ type: 'complete' });
      setTargetProfile(null);
    },
    [session, navigate],
  );

  const handlePick = useCallback(
    (profile: ProfileSummary) => {
      setSelectError(null);
      const generation = stateRef.current.generation;
      if (profile.pinProtected) {
        setTargetProfile(profile);
        dispatch({ type: 'targetProfile', profileId: profile.id });
        dispatch({ type: 'goto', step: 'selectionPin' });
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
    dispatch({ type: 'goto', step: 'selectionPin' });
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
      } else if (detail?.action === 'logout') {
        void session.logout();
      }
    }
    window.addEventListener('hmp:auth-intent', onIntent);
    return () => {
      window.removeEventListener('hmp:auth-intent', onIntent);
    };
  }, [startLogin, startProfileSelection, session]);

  // ---------------------------------------------------------------------------
  // 渲染:唯一受控 Modal + 分步内容
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
            onForgotPin={() => dispatch({ type: 'goto', step: 'pinRecovery' })}
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

  return (
    <AuthActionContext.Provider
      value={{
        isOpen: open,
        step: state.step,
        startLogin,
        startProfileSelection,
        cancel,
      }}
    >
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
    </AuthActionContext.Provider>
  );
}
