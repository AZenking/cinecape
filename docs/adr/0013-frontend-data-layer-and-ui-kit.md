# ADR-0013：前端统一数据层（react-query v5）与共享 Hooks / HeroUI 落地

- 状态：Accepted（2026-10-28 维护者随规格006实施指令显式接受；`lib/api.ts` 退役关系自此生效，实施与证据见 specs/006 tasks.md）
- 依据：维护者选型指令（HeroUI 宪章 v1.3.0 技术约束5、react-query、hooks 库优先、尽量少实现）；宪章原则一/二/三/五、技术约束3/4；规格006 研究 D1–D5。
- 关联：[规格006](../specs/006-heroui-react-query-refactor/spec.md)、[研究](../specs/006-heroui-react-query-refactor/research.md)、[键契约](../specs/006-heroui-react-query-refactor/contracts/query-keys.md)、[数据访问契约](../specs/006-heroui-react-query-refactor/contracts/data-access.md)、[UI 契约](../specs/006-heroui-react-query-refactor/contracts/ui-components.md)、[HEROUI-NOTES](../../apps/web/src/shared/theme/HEROUI-NOTES.md)、ADR-0012（相邻交付，无替代关系）。

## Context

`apps/web` 已声明 `@heroui/react`+`@heroui/styles` 3.2.6 但 0 处导入；现存 8 处原生交互控件（7 `<select>`、1 `window.alert`）；各页手写加载/错误状态机（设置页 9–24 个 useState）；存在双数据访问入口（`shared/fetch.ts` 统一底座 + 遗留 `lib/api.ts`）；无任何查询/缓存库。服务端契约（OpenAPI、problem+json、幂等语义）不变。

## Proposed Decision

1. **数据层**：引入 `@tanstack/react-query@^5.105.0` 为唯一服务端数据访问层；`shared/fetch.ts` 保留为唯一传输底座（problem+json → FetchApiError、AbortSignal 透传）；`lib/api.ts` 迁移完成后删除，不双轨。
2. **三域键控与身份隔离**：查询键首段定域 `public`/`profile`/`settings`；`profile` 键强制携带经验证的 `profileId`；切档/登出/401 执行 `cancelQueries(非public) → removeQueries(非public) → mutationCache.clear()`，同步先于身份状态更新；公共域显式豁免于清除谓词。播放票据/凭据不入缓存，解析为一次性动作。
3. **新鲜度分档**：浏览型 stale-while-revalidate（staleTime 30s/EPG 60s、gcTime 5min、分页 keepPreviousData）；设置型 `gcTime:0 + staleTime:0` 且以 `isPending` 门控渲染（保证每次进入必取最新、不以旧值先行，规格澄清 Q2）。
4. **变更反馈分档**（规格澄清 Q1）：收藏/进度/状态类 = 乐观更新（onMutate 快照 → onError 回滚+Toast → onSettled 失效对账）；表单保存/PIN/管理变更 = confirmed 等待态；`mutations retry:0`，查询重试 ≤1（429 一次、其余 4xx 不重试）。
5. **共享 Hooks**：`@mantine/hooks@^9.7.4` 为通用客户端 hooks 首选来源（禁用其 `useFetch`；轮询一律 `refetchInterval`）；自研仅限库未覆盖缺口并附理由与单测；全部收敛 `apps/web/src/shared/hooks/`。
6. **UI 组件**：HeroUI v3 复合组件写法落地（本地核验见 HEROUI-NOTES），原生交互控件清零；依赖仅进 `apps/web/package.json`（宪法技术约束4）；devtools 生产排除。

## Alternatives and consequences

- hooks 库：ahooks（否决：`useRequest` 系服务端状态架构级竞争、缺 clipboard、拖 lodash 系依赖）、usehooks-ts（21 个月未发版）、react-use（673 积压/年更）；SWR/RTK Query（用户已指定 react-query）。
- 设置型"每次最新"备选 `staleTime:Infinity`（永不重取）与 `refetchOnMount:'always'`（仍先渲染旧值）均不满足 Q2，弃用。
- 不引入 `@tanstack/react-query-persist-client`（无离线需求，避免个人数据落盘）。
- 切档用谓词保留公共缓存（登出可整库 `clear()`）：公共目录/EPG 不因身份切换闪断，这是体验取舍，不影响授权边界（授权始终服务端裁决）。

## Migration and rollback

按 tasks.md 泳道渐进交付：US1（组件）∥US2（数据层）→ US3（身份清除）→ US4（hooks 收编）→ Polish；每步 `typecheck/lint/test` 保持绿。无服务端/存储/契约变更，无数据迁移。回滚 = git 逐泳道 revert；US2 泳道回滚时 `lib/api.ts` 已删，需随该泳道整体恢复（tasks.md 已将删除排在迁移之后）。若 `@mantine/hooks` 个别 hook 出现 React 19 运行时问题，按研究 D1 逃生通道单点自研替换（附理由+单测），不回退整体选型。

## Acceptance and evidence

- SC-001 原生控件计数=0（grep 复扫）；SC-002 重复数据访问代码 −60% 且入口唯一；SC-003 缓存即显+1 往返后台刷新；SC-004 失败 100% 统一错误态；SC-005 切档/登出跨身份零泄漏（负向单测+E2E）；SC-006 重复通用逻辑 −50%；SC-007 端到端回归 100%；SC-008 样板代码对照演示；SC-009 首屏传输体积增幅 ≤15%（基线对比）。
- 证据：quickstart.md 场景 0–6 执行记录；负向用例（跨档案泄漏/未认证/过期响应不回写）归档于规格006 目录。
