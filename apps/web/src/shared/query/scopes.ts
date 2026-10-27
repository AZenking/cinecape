/**
 * 身份域缓存清除(T029/T030;006 contracts/data-access.md「身份切换」行,
 * 依据 ADR-0013 与 research D4)。
 *
 * `purgePersonalData` 固定顺序:`cancelQueries(非 public)` → `removeQueries(同谓词)`
 * → `mutationCache.clear()`,且调用方(SessionProvider)**同步先于**身份状态更新执行:
 * - 先 cancel:中止全部在途个人请求(signal 经 queryFn 透传至 fetch,产生原生
 *   AbortError)。removeQueries 只删缓存条目、不影响在途 fetch,若先 remove,
 *   迟到响应到达时可能把条目重新写回缓存;先 cancel 才能兑现 FR-020「中止在途
 *   个人请求」与 US3 验收场景 2「旧在途请求返回后被丢弃」。AbortError 由
 *   client.ts 重试策略豁免(取消不计重试、原样上抛不包装 FetchApiError)。
 * - 再 remove:仅删除缓存条目、不触发重取。对比:resetQueries 会立即重取——
 *   401/切档场景下重取只会再次 401 或以旧身份取数,故否决(research D4)。
 * - mutationCache.clear():丢弃 pending 变更与乐观残留,防止身份切换后迟到
 *   的 onSettled 对账/乐观回滚把旧身份数据写回查询缓存。
 * - 谓词 `q.queryKey[0] !== 'public'`:公共域匿名可读、与身份无关(键工厂
 *   keys.ts 三域前缀硬约束),保留公共缓存使切档/登出/会话失效后公共浏览
 *   零中断(US3 验收场景 3;宪法原则二/三:公共响应永不进入个人缓存域,
 *   个人清除也不得波及公共域)。
 * - 登出场景允许整库 `purgeAll(qc.clear())`(公共缓存廉价可重取,契约注明
 *   「登出可整库 clear()」);但默认两种场景都用 purgePersonalData——谓词版
 *   既满足安全底线又零成本保留公共域,公共浏览无需重新取数。
 */
import type { Query, QueryClient } from '@tanstack/react-query';

/**
 * 个人域谓词:键首段非 `public` 的查询即个人数据域(profile/settings)。
 * 与 keys.ts 的三域前缀硬约束一一对应;登出/切档/401 三条路径共用同一谓词。
 */
const isPersonalQuery = (query: Query): boolean => query.queryKey[0] !== 'public';

/**
 * 清空个人数据缓存域(切档/登出/会话失效/401 通用入口):
 * cancel 在途 → remove 缓存条目 → 清 mutation 缓存。同步函数,无 await,
 * 保证调用方可以在同一同步段内「先清除、后更新身份状态」(契约固定顺序)。
 */
export function purgePersonalData(qc: QueryClient): void {
  // cancelQueries 同步下发 abort(signal 即刻中止),其返回的 Promise 仅等在途
  // handler 收尾——域清除必须保持同步语义,故显式 fire-and-forget。
  void qc.cancelQueries({ predicate: isPersonalQuery });
  qc.removeQueries({ predicate: isPersonalQuery });
  qc.getMutationCache().clear();
}

/**
 * 整库清空(含 public 域)。仅供登出等「不再需要任何缓存」的场景选用;
 * 切档必须用 purgePersonalData(谓词保留公共域,公共浏览不中断)。
 */
export function purgeAll(qc: QueryClient): void {
  qc.clear();
}
