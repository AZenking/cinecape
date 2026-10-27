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
 * - 密码/PIN/会话令牌不进入本 Provider(令牌在 httpOnly Cookie),不写 localStorage;
 * - 数据访问(T026):会话恢复/登出经 features/auth/auth-api(privateFetch 档)
 *   统一端点出口。有意不取 queryClient.fetchQuery 路径(记录,避免后人误改):
 *   ① shared/query/keys.ts 键工厂只读且无会话键,手写键违反「唯一键来源」;
 *   ② fetchQuery 会把会话 DTO 落入共享缓存(staleTime 30s)——refresh() 须每次
 *      硬请求以翻转 bootstrapRequired/检测档案失效,缓存回显会破坏该语义,且
 *      会话作用域数据在缓存中滞留有跨身份残留风险(原则三/六);
 *   ③ 本组件是函数组件但会话为命令式代次守卫流(登录/选档回填),query 生命周期
 *      语义与之不匹配,直接薄包装保持恢复流程逐字不变。
 * - 身份切换缓存隔离(T030/T031;006 US3/FR-020):切档/失档、登出、会话失效
 *   三条路径都在身份状态更新**之前**同步调用 purgePersonalData(queryClient)
 *   (shared/query/scopes.ts;cancel→remove→mutationCache.clear,谓词保留
 *   public 域,公共浏览零中断);401 handler(T031)注册为 handleSessionLost
 *   ——清个人域 + 收敛 anonymous,登录引导由 ActionCoordinator 依 anonymous 态
 *   承接,每轮去重(2s)由 client.ts notifyUnauthorized 承担,无重定向循环。
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
import { fetchSession, logoutRequest } from '../features/auth/auth-api';
import { queryClient, setUnauthorizedHandler } from '../shared/query/client';
import { purgePersonalData } from '../shared/query/scopes';
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

/**
 * 个人身份键:household:profileId:contextVersion(data-model §10)。
 * purgePersonalData 的触发判定与对外暴露的 personalCacheKey 共用同一口径:
 * 该键由非 null 变为另一值(或归 null)即个人身份变化,须先清个人缓存域。
 */
function personalIdentityKey(session: AccountSession | null): string | null {
  if (session === null) {
    return null;
  }
  return `${session.householdId}:${session.activeProfile?.id ?? '-'}:${session.profileContextVersion}`;
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
      // T030(US3/FR-020):个人身份键变化(切档/失档/contextVersion 失效)→
      // 同步清空个人缓存域(cancel→remove→mutationCache.clear,谓词保留 public 域)
      // **再**落入新身份状态(契约固定顺序)。updater 在新状态 commit 前执行,
      // 任何按新身份取数的观察端看到的一定是已清空的缓存,不会命中旧身份数据;
      // 首次登录(previous 为 null)不触发——匿名/未选档态下个人域按不变式已空
      // (登出/会话失效/401 路径均已清除),无需波及任何域。
      const previousKey = personalIdentityKey(previous);
      if (previousKey !== null && previousKey !== personalIdentityKey(next)) {
        purgePersonalData(queryClient);
      }
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
      // T026:经 auth-api 统一会话恢复端点(每次硬请求,凭代次丢弃迟到响应)
      const next = await fetchSession();
      if (generation !== generationRef.current) {
        return; // 迟到响应:期间已登出/换档,不得回填旧身份
      }
      applySession(next);
    } catch (error) {
      if (generation !== generationRef.current) {
        return;
      }
      // 会话失效(FR-020):同步清空个人缓存域后再收敛 anonymous(谓词保留
      // public 域,公共浏览不中断)。恢复失败 401 有意不经全局 401 通道
      // (见 auth-api fetchSession 注释),此处即其域清除落点。
      purgePersonalData(queryClient);
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
      // T026:经 auth-api 统一登出端点
      await logoutRequest();
    } catch {
      // 忽略网络错误:本地清理照常
    }
    // T030(US3):同步先于身份状态更新清空个人缓存域(谓词保留 public 域);
    // 服务端登出成功与否都执行——网络失败路径同样不得残留旧身份数据
    purgePersonalData(queryClient);
    setSession(null);
    setNeedsReselection(false);
    setStatus('anonymous');
  }, []);

  /**
   * 会话丢失(T031/FR-017):注册为全局 401 handler(client.ts QueryCache.onError
   * 的 FetchApiError(401) 分流调用)。每轮 2s 去重已在 notifyUnauthorized 内实现,
   * 此处只做收敛:递增代次(作废在途会话响应,防迟到回填)→ 清个人缓存域 →
   * 收敛 anonymous。登录引导不经本组件路由:ActionCoordinator/identity-menu 依
   * anonymous 态承接登录入口,401→purge→anonymous 不再发起新的认证请求,无循环。
   */
  const handleSessionLost = useCallback((): void => {
    generationRef.current += 1;
    purgePersonalData(queryClient);
    setSession(null);
    setNeedsReselection(false);
    setStatus('anonymous');
  }, []);

  // 注册全局 401 handler(覆盖式注册;卸载复位 no-op,避免操作已卸载实例的状态)
  useEffect(() => {
    setUnauthorizedHandler(handleSessionLost);
    return () => {
      setUnauthorizedHandler(() => undefined);
    };
  }, [handleSessionLost]);

  // 启动恢复:轻量状态,不阻塞公共区(失败即游客)
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 个人数据缓存键:household:profileId:contextVersion(与 purge 判定同口径,
  // 经 personalIdentityKey 单点计算,避免两处口径漂移)
  const personalCacheKey = useMemo(
    () => (status === 'authenticated' ? personalIdentityKey(session) : null),
    [status, session],
  );

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
