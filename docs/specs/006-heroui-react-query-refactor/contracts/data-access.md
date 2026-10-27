# Contract: 数据访问层（Query/Mutation 与 fetch 底座的集成）

**Feature**: `006-heroui-react-query-refactor` | **Date**: 2026-10-27
**约束来源**: spec FR-010–018、宪法原则一/二/三、技术约束 3

## 分层不变式

```text
组件/页面（features/*）
   │  useQuery/useMutation（仅经 shared/query 的封装 hook）
shared/query/          数据层：client 配置、键工厂、身份域、401 处理、错误映射
shared/fetch.ts        传输底座：publicFetch / privateFetch（保留，唯一 fetch 入口）
@hmp/shared            契约类型（type-only 引用，零运行时依赖反向注入）
```

1. `shared/fetch.ts` 保留为**唯一** HTTP 传输底座（含 RFC 9457 problem+json →
   `FetchApiError` 映射、`AbortSignal` 透传、凭据档位）；数据层在其上组合，
   **不得**出现第二个裸 `fetch` 封装。
2. 遗留 `apps/web/src/lib/api.ts` 迁移完成后**删除**，不双轨并存（FR-018）。
3. `@tanstack/react-query` 及 hooks 库依赖仅存在于 `apps/web/package.json`；
   `apps/server`、`packages/shared` **不得**引入（宪法技术约束 4）。

## queryFn 集成契约

- `queryFn` = 对 `publicFetch`/`privateFetch` 的薄包装；**必须**把库提供的
  `signal` 透传给 fetch（键变化/卸载自动取消，FR-015）。
- 域 → 凭据档位映射：`public` → `publicFetch`；`profile`/`settings` → `privateFetch`。
- 错误对象保持 `FetchApiError` 原样抛出，不得在数据层吞错或转字符串；
  UI 文案由统一错误态组件按 `status/code/detail` 映射（FR-011/017）。

## 全局行为契约（client 默认配置）

| 项 | 契约 | 依据 |
| --- | --- | --- |
| 浏览型新鲜度 | 默认 `staleTime 30s`（目录/直播）、`60s`（EPG 慢变）；`refetchOnMount/Focus/Reconnect: true`；分页列表 `placeholderData: keepPreviousData`（设置类禁用） | FR-012、US2 |
| 设置型强制最新 | `gcTime: 0 + staleTime: 0` 且**不设** placeholderData：条目卸载即弃、进入必硬请求、以 `isPending` 门控渲染骨架（缓存旧值无处可显） | FR-012、Q2 澄清 |
| 重试 | 查询整体 ≤1 次：5xx/网络错误重试 1 次、429 重试 1 次、其余 4xx 不重试；变更（mutation）`retry: 0` | FR-014 幂等保险 + Q1 |
| 401 处理 | `QueryCache.onError` 全局捕获 `FetchApiError(401)`（每轮去重一次）：清空 `profile`+`settings` 域 → 引导重新登录；公共域不受影响 | FR-017、US3 |
| 身份切换 | 顺序固定：`cancelQueries(非 public)` → `removeQueries(非 public)` → `mutationCache.clear()` → **再**更新身份状态；切档用谓词移除保留公共缓存，登出可整库 `clear()` | FR-020、宪法原则二 |
| 取消语义 | `signal` 透传至 `fetch`；AbortError **必须**原样上抛、不得包装为 `FetchApiError`（库据此回退查询状态而非计错误/重试） | FR-015 |
| 错误文案映射 | `errors.{code}` → `detail` → `title` → 通用兜底；`type`（URI）不得直接展示 | FR-011/017 |
| 乐观更新 | 文档模式：`onMutate` 快照 + `onError` 回滚并 toast + `onSettled` 失效对账；单表面积简单变更优先"UI variables + isPending"变体；重复触发以 `isPending` 门控 | FR-013、Q1 |
| Devtools | 独立包 `@tanstack/react-query-devtools`，生产构建默认排除 | SC-009 |

依赖版本锚点：`@tanstack/react-query@^5.105.0`（peer react ^18‖^19、query-core 同版；
React 19/TS 5.8 显式支持）；不引入 persist-client（无离线需求，数据层 gzip ≈13KB）。

## mutation 契约

- 变更统一经共享 mutation 封装：`feedback` 分档（`optimistic`/`confirmed`）
  在封装处声明（data-model §3）；乐观路径必须实现 快照→失败回滚→统一 toast 提示。
- 成功后按声明的 `invalidates` 集合失效相关查询；**禁止**整页刷新替代失效。
- pending 期间重复触发：去重或禁用触发源（FR-014、Edge Cases）。
- 播放解析、PIN 验证等敏感动作一律 `confirmed` 且不经查询缓存保留凭据。

## 测试契约（与 tasks 阶段对接）

- 单测：数据层封装（域清除、401 回调、乐观回滚）用内存 QueryClient + 假 fetch。
- 集成：`FetchApiError` 映射、signal 取消、去重行为。
- E2E（Playwright）：US1–US3 验收场景 + 新增负向用例（跨档案缓存泄漏、
  未认证拒绝、过期响应不回写）。
