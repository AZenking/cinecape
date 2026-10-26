/**
 * SettingsAccessProvider(T087,005 contracts/ui.md §7 + contracts/api.md §6/§7 +
 * data-model §3/§9 + FR-031/FR-041 + ADR-0011)。
 *
 * Provider 仅缓存「服务器 expiresAt 状态」,不是权限事实:
 * - 首次进入 /settings/* 先 GET /api/settings/access(独立入口,仅 Session);
 *   未解锁只渲染 PIN 输入(由 SettingsUnlockGate 承载),不预取来源/设备/策略等
 *   管理主体;
 * - POST 成功进入布局;15 分钟固定 TTL 由服务端签发,客户端定时器只控制「到期
 *   提示」并触发一次服务端重验,绝不当成权限事实,更不续期;
 * - 403(过期/撤销/版本失配)立即回到锁定态:隐藏管理主体、终止定时重验、
 *   提示「编辑未保存」(FR-041),重新验证成功后 reloadEpoch 递增 —— 管理模块以
 *   reloadEpoch 为依赖重读最新现值,不自动提交任何草稿;
 * - PIN 仅表单内存(解锁门组件 state),关闭/卸载即清,不写 localStorage;
 * - 意图协调器 settings→settingsPin→settingsPage 分支(lead 接线,见模块尾部
 *   「接线契约」注释)经 beginUnlock/unlock/lock 三入口使用本 Provider;
 * - 普通 Profile 隐藏入口是前端表现;全部校验仍在服务端(本 Provider 对未授权
 *   的 POST 结果原样呈现服务端 403/423,不做本地放行)。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { privateFetch, isFetchApiError } from '../../shared/fetch';

/** 契约 SettingsAccess(data-model §9:仅 unlocked/expiresAt 元数据) */
interface SettingsAccessDto {
  unlocked: boolean;
  expiresAt: string | null;
}

export type SettingsAccessStatus = 'checking' | 'locked' | 'unlocked';

export interface SettingsAccessApi {
  /** 服务端核验状态;checking=首次 GET 未返回(不渲染管理主体) */
  status: SettingsAccessStatus;
  /** 服务器签发的到期时间;锁定时 null。客户端定时器仅作提示 */
  expiresAt: string | null;
  /**
   * 意图协调器 settings 分支入口:已解锁(缓存服务器事实)→ 'unlocked'(协调器
   * 直接导航到 returnTo);未解锁 → 'needs-pin'(协调器打开 settingsPin 弹层)。
   */
  beginUnlock: (returnTo: string) => 'unlocked' | 'needs-pin';
  /** settingsPin 弹层提交:POST /api/settings/access;失败抛 FetchApiError(403/423) */
  unlock: (pin: string) => Promise<void>;
  /** 主动撤销(取消/离开设置):DELETE /api/settings/access,204 幂等 */
  lock: () => Promise<void>;
  /** 管理主体请求得到 403 SETTINGS_ACCESS_* 时调用:立即锁定 + 编辑未保存提示 */
  handleAccessLost: () => void;
  /** 授权丢失提示(FR-041);重新验证成功后自动清除 */
  unsavedNotice: boolean;
  /** 重新解锁后递增;管理模块以它为依赖重读最新现值 */
  reloadEpoch: number;
}

const SettingsAccessContext = createContext<SettingsAccessApi | null>(null);

export function useSettingsAccess(): SettingsAccessApi {
  const value = useContext(SettingsAccessContext);
  if (value === null) {
    throw new Error('useSettingsAccess 必须在 <SettingsAccessProvider> 内使用');
  }
  return value;
}

export function SettingsAccessProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SettingsAccessStatus>('checking');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [unsavedNotice, setUnsavedNotice] = useState(false);
  const [reloadEpoch, setReloadEpoch] = useState(0);
  /** 前端代次:锁定/解锁/卸载递增,在途响应凭捕获值丢弃 */
  const generationRef = useRef(0);

  const applyServerState = useCallback((next: SettingsAccessDto): 'unlocked' | 'locked' => {
    if (next.unlocked && next.expiresAt !== null) {
      setStatus('unlocked');
      setExpiresAt(next.expiresAt);
      return 'unlocked';
    }
    setStatus('locked');
    setExpiresAt(null);
    return 'locked';
  }, []);

  // 首次进入(及每次挂载/刷新)经服务端核验:不读管理主体、不延长有效期
  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const dto = await privateFetch<SettingsAccessDto>('/settings/access');
        if (!cancelled && generation === generationRef.current) {
          applyServerState(dto);
        }
      } catch {
        if (!cancelled && generation === generationRef.current) {
          // 网络失败/会话失效按未解锁处理(fail-closed;401 由 SessionProvider 全局呈现)
          setStatus('locked');
          setExpiresAt(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyServerState]);

  // 客户端到期提示定时器:只触发一次服务端重验,不是权限事实(TTL 权威在服务端)
  useEffect(() => {
    if (status !== 'unlocked' || expiresAt === null) {
      return undefined;
    }
    const remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0) {
      // 本地时钟判定已到期 → 立即重验(服务端说还活着就继续,客户端只是提示)
      const generation = ++generationRef.current;
      void (async () => {
        try {
          const dto = await privateFetch<SettingsAccessDto>('/settings/access');
          if (generation === generationRef.current) {
            applyServerState(dto);
          }
        } catch {
          if (generation === generationRef.current) {
            handleAccessLostRef.current();
          }
        }
      })();
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const generation = ++generationRef.current;
      void (async () => {
        try {
          const dto = await privateFetch<SettingsAccessDto>('/settings/access');
          if (generation === generationRef.current) {
            applyServerState(dto);
          }
        } catch {
          if (generation === generationRef.current) {
            handleAccessLostRef.current();
          }
        }
      })();
    }, remaining);
    return () => {
      window.clearTimeout(timer);
    };
  }, [status, expiresAt, applyServerState]);

  const handleAccessLost = useCallback((): void => {
    generationRef.current += 1; // 在途响应全部作废,终止到期的定时重验
    setStatus('locked');
    setExpiresAt(null);
    setUnsavedNotice(true); // FR-041:授权失效明确提示,不自动保存
  }, []);

  const handleAccessLostRef = useRef(handleAccessLost);
  handleAccessLostRef.current = handleAccessLost;

  const beginUnlock = useCallback(
    (_returnTo: string): 'unlocked' | 'needs-pin' => {
      void _returnTo;
      return status === 'unlocked' ? 'unlocked' : 'needs-pin';
    },
    [status],
  );

  const unlock = useCallback(
    async (pin: string): Promise<void> => {
      const generation = generationRef.current;
      const dto = await privateFetch<SettingsAccessDto>('/settings/access', {
        method: 'POST',
        body: { pin },
      });
      if (generation !== generationRef.current) {
        return; // 期间已取消/失效:旧回调不得重开已取消的设置
      }
      const next = applyServerState(dto);
      if (next === 'unlocked') {
        setUnsavedNotice(false);
        setReloadEpoch((epoch) => epoch + 1); // 管理模块据此重读最新现值
      }
    },
    [applyServerState],
  );

  const lock = useCallback(async (): Promise<void> => {
    generationRef.current += 1; // 先作废在途响应再撤销:取消后旧回调不得重开
    setStatus('locked');
    setExpiresAt(null);
    try {
      await privateFetch<void>('/settings/access', { method: 'DELETE' });
    } catch {
      // 幂等 204;网络失败本地仍回到锁定态(服务端授权不因本地失败延长)
    }
  }, []);

  const value = useMemo<SettingsAccessApi>(
    () => ({
      status,
      expiresAt,
      beginUnlock,
      unlock,
      lock,
      handleAccessLost,
      unsavedNotice,
      reloadEpoch,
    }),
    [status, expiresAt, beginUnlock, unlock, lock, handleAccessLost, unsavedNotice, reloadEpoch],
  );

  return <SettingsAccessContext.Provider value={value}>{children}</SettingsAccessContext.Provider>;
}

/** 判断管理主体响应错误是否为「设置授权丢失」(供 US8 管理模块统一接线) */
export function isSettingsAccessLostError(error: unknown): boolean {
  return (
    isFetchApiError(error) &&
    error.status === 403 &&
    (error.code === 'SETTINGS_ACCESS_REQUIRED' || error.code === 'SETTINGS_ACCESS_EXPIRED')
  );
}

/**
 * ── 意图协调器接线契约(供 lead 接入;本任务不改 action-coordinator/providers)──
 *
 * settings→settingsPin→settingsPage 分支(ui.md §3),精确接线行:
 *
 * 1) apps/web/src/app/providers.tsx(把 Provider 提升到协调器外层,settings 路由
 *    与弹层共用同一缓存;SettingsLayout 内的挂载随之移除,避免重复 GET):
 *      import { SettingsAccessProvider } from '../features/settings/settings-access-provider';
 *      <SessionProvider>
 *        <SettingsAccessProvider>
 *          <ActionCoordinator>{children}</ActionCoordinator>
 *        </SettingsAccessProvider>
 *      </SessionProvider>
 *
 * 2) apps/web/src/app/action-coordinator-core.ts
 *    - AuthStep 联合类型(第 24 行起)追加成员:`| 'settingsPin'`;
 *    - 无需新 action:'start'/'goto'/'complete' 已覆盖弹层内推进与完成。
 *
 * 3) apps/web/src/app/action-coordinator.tsx
 *    - import { useSettingsAccess } from '../features/settings/settings-access-provider';
 *    - 组件体内:`const settingsAccess = useSettingsAccess();`
 *    - AuthActionApi 增加成员 `startSettings: (returnTo?: string | null) => void;`
 *      并在 Provider value 传入;
 *    - 意图入口(与 startProfileSelection 同型,置于其后):
 *        const startSettings = useCallback(
 *          (returnTo?: string | null) => {
 *            const target = sanitizeReturnTarget(returnTo ?? currentPathTarget());
 *            if (settingsAccess.beginUnlock(target) === 'unlocked') {
 *              void navigate(target); // 有效期内返回设置:无需再输 PIN
 *              return;
 *            }
 *            dispatch({ type: 'start', step: 'settingsPin', returnTo: target, entry: 'identity-menu' });
 *          },
 *          [settingsAccess, navigate],
 *        );
 *    - 弹层提交回调(代次守卫与 performSelect 同型):
 *        const handleSettingsPinSubmit = useCallback(
 *          async (pin: string) => {
 *            const generation = stateRef.current.generation;
 *            await settingsAccess.unlock(pin); // 403/423 抛回步骤展示
 *            if (isStaleIntent(stateRef.current, generation)) return;
 *            dispatch({ type: 'complete' });
 *            void navigate(sanitizeReturnTarget(stateRef.current.returnTo));
 *          },
 *          [settingsAccess, navigate],
 *        );
 *    - stepTitles 增加 `settingsPin: '输入设置 PIN';`
 *    - renderStep() switch 增加分支(SelectionPinStep 之后):
 *        case 'settingsPin':
 *          return (
 *            <SettingsPinStep
 *              formEpoch={state.formEpoch}
 *              onSubmit={handleSettingsPinSubmit}
 *              onCancel={cancel}   // 取消:清凭据回原页面,旧回调不得重开
 *            />
 *          );
 *      (SettingsPinStep 可由 features/settings/settings-unlock-gate.tsx 的
 *       SettingsPinForm 复用:props { onSubmit(pin), onCancel }。)
 *
 * 4) apps/web/src/features/profiles/identity-menu.tsx
 *    - 主 Profile 设置入口由链接改为意图(隐藏入口不替代服务端校验):
 *        onAction 的 if/else 链中追加:
 *          } else if (key === 'settings') {
 *            auth.startSettings('/settings/account');
 *          }
 *      并把 <Dropdown.Item id="settings" href="/settings/account">设置</Dropdown.Item>
 *      改为 <Dropdown.Item id="settings">设置</Dropdown.Item>(去掉 href)。
 */
