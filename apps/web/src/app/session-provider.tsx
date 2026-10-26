/**
 * SessionProvider(T040;005 contracts/ui.md §2 + FR-009/FR-019)。
 *
 * - 启动恢复会话为轻量 `restoring` 状态:children 始终渲染,公共区不被遮挡;
 * - 缓存服务端事实(唯一信任源):householdId、账号摘要、当前 Profile、
 *   bootstrapRequired、profileContextVersion(GET /auth/session);
 * - 个人缓存键 `household:profile:contextVersion`(data-model §10):Profile 失效
 *   清空个人展示并置 needsReselection(提示重新选档),公共区不中断;
 * - 登出/换档先清旧个人展示并递增 generation,在途的迟到 /auth/session 响应
 *   凭代次丢弃,不回填旧身份;
 * - 密码/PIN/会话令牌不进入本 Provider(令牌在 httpOnly Cookie),不写 localStorage。
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
import { privateFetch } from '../shared/fetch';
import type { AccountSession } from './session-types';

export type SessionStatus = 'restoring' | 'anonymous' | 'authenticated';

export interface SessionContextValue {
  status: SessionStatus;
  /** 服务端会话事实(anonymous 时为 null) */
  session: AccountSession | null;
  /** FR-009:当前 Profile 失效(由非空变空)后提示重新选档;重新选档成功即复位 */
  needsReselection: boolean;
  /** 个人数据缓存键:household:profile:contextVersion(未选档/未登录为 null) */
  personalCacheKey: string | null;
  /** 重新拉取 /auth/session(代次保护) */
  refresh: () => Promise<void>;
  /** 登录/首建/选档成功后回填服务端 DTO(同代次内) */
  applySession: (next: AccountSession) => void;
  /** 幂等登出:无论服务端结果如何都清空本地展示并递增代次 */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession 必须在 <SessionProvider> 内使用');
  }
  return value;
}

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('restoring');
  const [session, setSession] = useState<AccountSession | null>(null);
  const [needsReselection, setNeedsReselection] = useState(false);
  /** 前端代次:登出/换档递增;在途响应凭捕获值失效 */
  const generationRef = useRef(0);

  const applySession = useCallback((next: AccountSession) => {
    generationRef.current += 1; // 身份变化(登录/首建/选档)推进代次,废弃在途旧响应
    setSession((previous) => {
      // FR-009:当前 Profile 由非空变空(失效回落)→ 清个人展示并提示重选
      if ((previous?.activeProfile ?? null) !== null && next.activeProfile === null) {
        setNeedsReselection(true);
      } else if (next.activeProfile !== null) {
        setNeedsReselection(false);
      }
      return next;
    });
    setStatus('authenticated');
  }, []);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    try {
      const next = await privateFetch<AccountSession>('/auth/session');
      if (generation !== generationRef.current) {
        return; // 迟到响应:期间已登出/换档,不得回填旧身份
      }
      applySession(next);
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      // 401(无会话/已失效)→ anonymous;其他错误同样不保留不可信的旧展示
      setSession(null);
      setStatus('anonymous');
      void error;
    }
  }, [applySession]);

  const logout = useCallback(async () => {
    generationRef.current += 1; // 先递增代次:在途个人/会话响应全部作废
    try {
      // 契约幂等 204:无论网络结果如何本地一律清空(不阻断退出)
      await privateFetch<void>('/auth/logout', { method: 'POST' });
    } catch {
      // 忽略网络错误:本地清理照常
    }
    setSession(null);
    setNeedsReselection(false);
    setStatus('anonymous');
  }, []);

  // 启动恢复:轻量状态,不阻塞公共区(失败即游客)
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const personalCacheKey = useMemo(() => {
    if (status !== 'authenticated' || session === null) {
      return null;
    }
    return `${session.householdId}:${session.activeProfile?.id ?? '-'}:${session.profileContextVersion}`;
  }, [status, session]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      session,
      needsReselection,
      personalCacheKey,
      refresh,
      applySession,
      logout,
    }),
    [status, session, needsReselection, personalCacheKey, refresh, applySession, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
