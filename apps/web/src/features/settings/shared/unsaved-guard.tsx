/**
 * 未保存编辑拦截(T135,005 contracts/ui.md §7 + FR-041):
 *
 * - UnsavedGuardProvider 挂在 SettingsLayout 解锁门内(Outlet 外层):子模块切换时
 *   Provider 不卸载,因此在检测到「脏状态下的离开导航」时立即以全屏遮罩 + 确认弹层
 *   覆盖目标页面 —— 用户不会看到新模块数据,编辑不自动保存、不自动提交(FR-041);
 * - 「继续编辑」返回原模块;「放弃编辑并离开」解除拦截并停留在目标位置(保留登录状态);
 * - 刷新/关闭标签页经 beforeunload 原生拦截;
 * - 各页面经 useUnsavedGuard(isDirty) 把编辑态登记到 Provider,并取得程序化
 *   confirmDiscard 入口(自定义离开动作用);
 * - 授权过期的「重读现值再显式继续」由 SettingsAccessProvider(reloadEpoch)承担:
 *   重新解锁后页面重读服务端现值,草稿保持编辑态,绝不自动提交。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Button } from '@heroui/react';

export interface UnsavedGuardApi {
  /** 当前是否存在未保存编辑(任一登记页面的脏状态) */
  isDirty: boolean;
  /** 程序化确认(自定义离开入口):resolve true = 用户同意放弃编辑离开 */
  confirmDiscard: () => Promise<boolean>;
  /** 由 Provider 渲染的确认弹层(挂在布局级;页面无需重复渲染) */
  dialog: ReactNode;
  /** 页面登记入口(useUnsavedGuard 内部使用) */
  setDirty: (dirty: boolean) => void;
}

const UnsavedGuardContext = createContext<UnsavedGuardApi | null>(null);

/** 判断目标路径是否离开当前页面(跨模块/离开站点均算;同地址不算) */
export function isLeavingCurrentModule(currentPathname: string, targetPath: string | null): boolean {
  if (targetPath === null) {
    return false;
  }
  const normalize = (path: string): string => path.replace(/\/+$/, '') || '/';
  return normalize(currentPathname) !== normalize(targetPath);
}

/**
 * 布局级未保存监视:脏状态下导航到非受保护地址 → 全屏遮罩 + 确认弹层拦截
 * (目标页在遮罩之后,用户不可见、不可交互;草稿不自动保存)。
 */
export function UnsavedGuardProvider({ children }: { children: ReactNode }): ReactNode {
  const location = useLocation();
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const resolveRef = useRef<((leave: boolean) => void) | null>(null);
  /** 受保护地址(用户正在编辑的页面;「继续编辑」的返回目标) */
  const returnPathRef = useRef(location.pathname);
  /** 放行闸:用户已显式放弃编辑,监视不再干预 */
  const disarmedRef = useRef(false);
  const message = '当前模块有未保存的编辑。离开不会自动保存,授权过期后需重新读取现值再显式继续。';

  // 受保护地址跟随:非脏且无确认流程时同步到当前路由(渲染期同步 ref,安全)
  if (!dirty && pendingTarget === null) {
    returnPathRef.current = location.pathname;
    disarmedRef.current = false;
  }

  // 拦截监视:脏状态下导航到非受保护地址 → 记录目标并弹确认遮罩;
  // 「继续编辑」返回受保护地址后解除拦截(pending 与返回导航同批提交,不能提前清,
  // 否则清除先于路由落地会立即对旧地址二次拦截)。
  useEffect(() => {
    if (pendingTarget !== null && pendingTarget !== '__programmatic__' && location.pathname === returnPathRef.current) {
      setPendingTarget(null);
      return;
    }
    if (!dirty || disarmedRef.current) {
      return;
    }
    if (pendingTarget === null && location.pathname !== returnPathRef.current) {
      setPendingTarget(location.pathname);
    }
  }, [location.pathname, dirty, pendingTarget]);

  const openConfirm = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setPendingTarget('__programmatic__');
    });
  }, []);

  // 刷新/关闭标签页经浏览器原生确认(仅脏状态)
  useEffect(() => {
    if (!dirty) {
      return undefined;
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);

  const settle = useCallback(
    (leave: boolean) => {
      const target = pendingTarget;
      const resolver = resolveRef.current;
      resolveRef.current = null;
      resolver?.(leave);
      if (!leave) {
        if (target === '__programmatic__') {
          setPendingTarget(null);
          return;
        }
        // 继续编辑:返回原模块;pending 由 effect 在抵达受保护地址后清除
        void navigate(returnPathRef.current);
        return;
      }
      // 显式放弃编辑:解除拦截,停留在目标位置(保留登录状态)
      disarmedRef.current = true;
      setPendingTarget(null);
      if (target !== null && target !== '__programmatic__') {
        returnPathRef.current = target;
      }
    },
    [pendingTarget, navigate],
  );


  const value = useMemo<UnsavedGuardApi>(
    () => ({
      isDirty: dirty,
      confirmDiscard: openConfirm,
      dialog:
        pendingTarget === null ? null : (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="unsaved-overlay">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label="未保存的编辑"
              className="max-w-md rounded border border-border bg-surface p-4 shadow-lg"
            >
              <h2 className="text-base font-semibold text-foreground">未保存的编辑</h2>
              <p role="alert" className="mt-2 text-sm text-warning">{message}</p>
              <div className="mt-4 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onPress={() => settle(false)} data-testid="unsaved-continue" autoFocus>
                  继续编辑
                </Button>
                <Button variant="danger" size="sm" onPress={() => settle(true)} data-testid="unsaved-discard">
                  放弃编辑并离开
                </Button>
              </div>
            </div>
          </div>
        ),
      setDirty,
    }),
    [dirty, pendingTarget, openConfirm, settle, message],
  );

  // 拦截遮罩/弹层由 Provider 自身渲染(布局级,随页面切换保持挂载;FR-041)
  return (
    <UnsavedGuardContext.Provider value={value}>
      {value.dialog}
      {children}
    </UnsavedGuardContext.Provider>
  );
}

/**
 * 页面登记 hook:把编辑态同步到布局级 Provider;返回确认入口。
 * 弹层与遮罩由 Provider 渲染(布局级),页面无需渲染 dialog。
 */
export function useUnsavedGuard(isDirty: boolean, _options: { message?: string } = {}): UnsavedGuardApi {
  const guard = useContext(UnsavedGuardContext);
  const setDirtyRef = useRef(guard?.setDirty ?? null);
  setDirtyRef.current = guard?.setDirty ?? null;
  useEffect(() => {
    setDirtyRef.current?.(isDirty);
    // 注意:不注册卸载清理重置 —— 拦截路径中页面会先行卸载,若此处重置脏状态会
    // 打断拦截;新页面挂载时以其自身编辑态覆盖登记(disarm 放行路径由 Provider 管理)。
  }, [isDirty]);
  if (guard === null) {
    // 未挂 Provider(理论上布局已保证):退化为无拦截直通,保持页面可用
    return { isDirty, confirmDiscard: () => Promise.resolve(true), dialog: null, setDirty: () => undefined };
  }
  // dialog 已由 Provider 自身渲染;页面无需(也不应)重复渲染,此处恒为 null
  return { isDirty: guard.isDirty, confirmDiscard: guard.confirmDiscard, dialog: null, setDirty: guard.setDirty };
}
