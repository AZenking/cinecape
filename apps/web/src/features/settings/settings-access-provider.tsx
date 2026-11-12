/**
 * SettingsAccessProvider (013 T006, 角色差异化设置体系上下文)
 *
 * 废除 15 分钟 Ticket 轮询与复杂的客户端定时器锁状态(ADR-0017):
 * - 直接从 SessionProvider 获取当前会话事实 (唯一信任源: session.activeProfile.isMain)；
 * - 透传 isMainProfile 判定,提供 isUnlocked (= isMainProfile) 兼容别名；
 * - 403 FORBIDDEN (新契约) 与 403 SETTINGS_ACCESS_* (旧契约,过渡期兼容) 经
 *   isSettingsAccessLostError 统一识别,由各管理页接线 handleAccessLost；
 * - session 处于 restoring 时 status 为 checking,否则按 isMainProfile 给出 unlocked/locked。
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
import { useOptionalSession } from '../../app/session-provider';
import { isFetchApiError } from '../../shared/fetch';

export type SettingsAccessStatus = 'checking' | 'locked' | 'unlocked';

export interface SettingsAccessApi {
  /** 当前 Profile 是否为主管理员档案 (013 统一鉴权事实源) */
  isMainProfile: boolean;
  /** 兼容既有引用: isUnlocked = isMainProfile */
  isUnlocked: boolean;
  /** 服务端核验状态;checking=会话恢复中,unlocked=主管理员,locked=非主管理员/未登录 */
  status: SettingsAccessStatus;
  /** 管理主体请求得到 403 时调用:标记编辑未保存提示 */
  handleAccessLost: () => void;
  /** 授权丢失提示(FR-041) */
  unsavedNotice: boolean;
  /** 重新解锁后递增;管理模块以它为依赖重读最新现值 */
  reloadEpoch: number;
}

const SettingsAccessContext = createContext<SettingsAccessApi | null>(null);

export function useOptionalSettingsAccess(): SettingsAccessApi | null {
  return useContext(SettingsAccessContext);
}

export function useSettingsAccess(): SettingsAccessApi {
  const value = useOptionalSettingsAccess();
  if (value === null) {
    throw new Error('useSettingsAccess 必须在 <SettingsAccessProvider> 内使用');
  }
  return value;
}

export function SettingsAccessProvider({ children }: { children: ReactNode }): ReactNode {
  const sessionContext = useOptionalSession();
  const [unsavedNotice, setUnsavedNotice] = useState(false);
  // reloadEpoch 现为常量占位(013 后重读语义由挂载即清硬请求承担);保留契约字段供消费方读取
  const [reloadEpoch] = useState(0);

  // 授权事实单一信任源 = SessionProvider;无 SessionProvider 上下文(独立测试/孤页渲染)
  // 兼容:按主管理员渲染(与 SettingsShell 的缺省口径一致),避免测试夹具全量回锁
  const isMainProfile = sessionContext === null ? true : Boolean(sessionContext.session?.activeProfile?.isMain);
  const isUnlocked = isMainProfile;

  const status: SettingsAccessStatus = useMemo(() => {
    if (sessionContext === null) {
      return 'unlocked';
    }
    if (sessionContext.status === 'restoring') {
      return 'checking';
    }
    return isMainProfile ? 'unlocked' : 'locked';
  }, [sessionContext, isMainProfile]);

  const handleAccessLost = useCallback((): void => {
    setUnsavedNotice(true);
  }, []);

  // 授权恢复即清除提示:013 语义是「重新解锁后重挂硬请求重读最新现值」——主体与数据
  // 已按主管理员口径重读,FR-041 提示完成使命。此前该提示无任何清除路径(仅布局卸载
  // 重置),切回主档案后会与正常渲染的管理主体长期同屏,提示与现状自相矛盾。
  const prevStatusRef = useRef<SettingsAccessStatus>(status);
  useEffect(() => {
    if (prevStatusRef.current !== 'unlocked' && status === 'unlocked') {
      setUnsavedNotice(false);
    }
    prevStatusRef.current = status;
  }, [status]);

  const value = useMemo<SettingsAccessApi>(
    () => ({
      isMainProfile,
      isUnlocked,
      status,
      handleAccessLost,
      unsavedNotice,
      reloadEpoch,
    }),
    [isMainProfile, isUnlocked, status, handleAccessLost, unsavedNotice, reloadEpoch],
  );

  return <SettingsAccessContext.Provider value={value}>{children}</SettingsAccessContext.Provider>;
}

/** 判断管理主体响应错误是否为「设置授权丢失」(供管理模块统一接线) */
export function isSettingsAccessLostError(error: unknown): boolean {
  return isFetchApiError(error) && error.status === 403 && isAccessLostErrorCode(error.code);
}

/** 013 新契约 403 FORBIDDEN;旧契约 SETTINGS_ACCESS_* 过渡期兼容(ADR-0011 遗留端点) */
export function isAccessLostErrorCode(code: string | null | undefined): boolean {
  return code === 'FORBIDDEN' || code === 'SETTINGS_ACCESS_REQUIRED' || code === 'SETTINGS_ACCESS_EXPIRED';
}
