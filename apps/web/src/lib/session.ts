/**
 * 会话上下文(T014;T036 静默回落)。
 *
 * - 启动时 GET /auth/session 恢复服务端会话(research D5:服务端会话是唯一信任源),
 *   `restoring` 状态用于首屏防闪烁:恢复完成前受保护路由不重定向。
 * - 通道策略:Cookie(hmp_session,httpOnly)为主;登录响应中的一次性
 *   sessionToken 存 localStorage `hmp_bearer`,仅作 Bearer 备用通道。
 * - T036 静默回落:refresh() 检测 activeProfile 由非空变 null(档案被停用,
 *   FR-016 级联)→ 置 `profileFallbackAt` 时间戳并在上下文暴露,AppShell
 *   据此展示 5 秒轻提示「原观看档案已停用,请重新选择」。
 * - 契约类型经工作区依赖 `@hmp/shared`(`workspace:*`)引入,仅作 type import。
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, storeBearer } from './api';
import type { components } from '@hmp/shared';

/** SessionDto(components.schemas.SessionDto);sessionToken 仅登录响应出现 */
export type SessionDto = components['schemas']['SessionDto'];

export type SessionStatus =
  /** 正在恢复会话(启动期,防闪烁) */
  | 'restoring'
  /** 未登录 */
  | 'anonymous'
  /** 已登录 */
  | 'authenticated';

export interface SessionContextValue {
  status: SessionStatus;
  /** 已登录时的会话上下文;其余状态为 null */
  session: SessionDto | null;
  /** 是否处于启动恢复期(等价 status === 'restoring') */
  loading: boolean;
  /** 重新拉取 /auth/session(登录/选档后刷新上下文) */
  refresh: () => Promise<void>;
  /** POST /auth/logout 后清空本地状态(Bearer 备用通道一并清除) */
  logout: () => Promise<void>;
  /**
   * T036 静默回落:refresh() 前后 activeProfile 由非空变为 null 的时刻
   * (epoch ms,Date.now());无回落时为 null。AppShell 据此展示 5 秒轻提示。
   */
  profileFallbackAt: number | null;
  /** 手动清除回落提示时间戳(轻条关闭用,非必须) */
  clearProfileFallback: () => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function useSessionController(): SessionContextValue {
  const [status, setStatus] = useState<SessionStatus>('restoring');
  const [session, setSession] = useState<SessionDto | null>(null);
  /** T036:静默回落时间戳(见 SessionContextValue.profileFallbackAt) */
  const [profileFallbackAt, setProfileFallbackAt] = useState<number | null>(null);
  /**
   * 上一次会话的 activeProfile,用于跨 refresh 比较检测「非空 → null」回落。
   * 用 ref 而非依赖 state,避免 refresh 回调因闭包变化而失去引用稳定性。
   */
  const prevActiveProfileRef = useRef<SessionDto['activeProfile']>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const dto = await api.get('/auth/session');
      if (dto.sessionToken) {
        storeBearer(dto.sessionToken);
      }
      // T036:此前 activeProfile 非空、本次变为 null(如档案被停用,FR-016 级联)
      // → 记录回落时刻;反之(已选档案)清除回落提示。
      const previousProfile = prevActiveProfileRef.current ?? null;
      prevActiveProfileRef.current = dto.activeProfile ?? null;
      if (previousProfile !== null && dto.activeProfile == null) {
        setProfileFallbackAt(Date.now());
      } else if (dto.activeProfile != null) {
        setProfileFallbackAt(null);
      }
      setSession(dto);
      setStatus('authenticated');
    } catch (error) {
      // 401 = 未登录/过期(预期);其余错误(网络等)同样按未登录处理,但留一条告警
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.warn('[session] 会话恢复失败,按未登录处理:', error);
      }
      storeBearer(null);
      prevActiveProfileRef.current = null;
      setSession(null);
      setStatus('anonymous');
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      // 幂等:重复 logout 同样 204;401(会话已失效)视为成功
      await api.post('/auth/logout');
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.warn('[session] logout 请求失败,仍清除本地会话:', error);
      }
    }
    storeBearer(null);
    prevActiveProfileRef.current = null;
    setProfileFallbackAt(null);
    setSession(null);
    setStatus('anonymous');
  }, []);

  const clearProfileFallback = useCallback((): void => {
    setProfileFallbackAt(null);
  }, []);

  // 启动恢复一次;refresh 引用稳定,不会循环
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      status,
      session,
      loading: status === 'restoring',
      refresh,
      logout,
      profileFallbackAt,
      clearProfileFallback,
    }),
    [status, session, refresh, logout, profileFallbackAt, clearProfileFallback],
  );
}

/**
 * 会话 Provider。以 createElement 实现(而非 JSX)以保持文件为 .ts;
 * 语义与 <SessionContext.Provider value={value}>{children}</SessionContext.Provider> 一致。
 */
export function SessionProvider(props: { children: ReactNode }): ReactNode {
  const value = useSessionController();
  return createElement(SessionContext.Provider, { value }, props.children);
}

/** 读取会话上下文;必须在 <SessionProvider> 内使用 */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession 必须在 <SessionProvider> 内使用');
  }
  return ctx;
}
