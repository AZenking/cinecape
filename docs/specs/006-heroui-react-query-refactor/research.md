# Research: 006-heroui-react-query-refactor

**Date**: 2026-10-27 | **Status**: 全部决策已定（无遗留 NEEDS CLARIFICATION）
**环境说明**: 本环境对部分域名（registry.npmjs.org / tanstack.com / pkgpulse /
ask.csdn.net 等）存在 DNS 污染（解析到非公网 IP，同 `apps/web/src/shared/theme/
HEROUI-NOTES.md` 2026-10-26 记录）。本研究以①本地 `pnpm view`（npmmirror 镜像，
与 npm registry 同源）核实包元数据；②TanStack 官方文档/仓库（经研究代理直取成功）
为准；个别无法直取的页面以搜索摘要标注置信度。

## D1 通用 Hooks 库选型

**Decision**: 采用 **@mantine/hooks@^9.7.4**（v9 线，peer `react ^19.2`，项目
React 19.3.1 满足；若未来 React 降至 <19.2 则回退 v8 线 peer `^18‖^19`）。
落地约定：① 服务端状态 100% 归 react-query，**禁用** @mantine/hooks 的
`useFetch`（唯一重叠面）；② 轮询服务端数据一律 `refetchInterval`，不用库内
interval 直连服务端；③ 从 `@mantine/hooks` 根路径导入（exports map 未暴露子路径）。

**Rationale**（版本/维护/包结构均为 2026-10-27 实时抓取，另有本机 esbuild 实测 bundle）:

| 候选 | 版本/最近发布 | 维护健康度 | React 19 | tree-shaking | 实测 gzip（等价 8–9 hooks） | 覆盖缺口 |
| --- | --- | --- | --- | --- | --- | --- |
| **@mantine/hooks** | 9.7.4 / 2026-10-25（近周持续发版） | **仅 20 open issues** ✅ | peer `^19.2` 原生 | 零运行时依赖+每 hook 独立 .mjs | **2.62KB**（含 clipboard+throttle） | 无（8 类基础工具全覆盖，focus 三件套） |
| ahooks | 3.11.0 / 2026-10-27（活跃） | 138 open ✅ | `^19` in peer；#2670 已关闭(2025-06) | sideEffects:false+ESM，但拖 lodash/dayjs/js-cookie 等 | 6.26KB（且无 clipboard） | clipboard ✗ |
| usehooks-ts | 3.1.1 / 2025-02-05（≈21 个月未发） | 主分支停更 ⚠️ | `^19` | 单打包文件，无模块粒度保证 | 2.78KB（无 throttle） | throttle ✗、focus ✗ |
| react-use | 17.6.1 / ≈一年一发 | 673 open issues ⚠️ | peer `*`（未深查） | 传递依赖多 | 2.94KB | — |

- **决定性理由**：① 全需求覆盖 + 零依赖 + 最小体积 = "尽量少实现"与 SC-009
  双达标；② 与 react-query 边界最干净——ahooks 的 `useRequest`/
  `useInfiniteScroll`/`usePagination` 是服务端状态的架构级竞争者，正是本次
  重构要消灭的模式（团队纪律风险）；③ 维护健康度唯一全绿。
- **仍需少量自研的缺口**（FR-031 路径，各约 15 行 + 单测）：倒计时、
  WebSocket/SSE（如直播更新需要长连接）、body 滚动锁定（v9 导出核实无独立
  useScrollLock，置信度中高；HeroUI 弹层若自带锁定则无需）、播放器领域 hooks
  （buffering/PiP/全屏状态机——通用库本就不覆盖，属合理自研范围）。

**Alternatives considered**: ahooks（最强备选：维护活跃，但覆盖缺 clipboard、
体积 2.4×、服务端状态竞争面大）；usehooks-ts / react-use（否决：21 个月未发 /
积压 673 issues，不满足"成熟且活跃维护"）；全自研（否决：违背 FR-030/033）。
环境说明：研究代理经 bash curl 直连 npm registry / GitHub API 绕过 DNS 污染
获取实时数据；bundle 数字为可复现的 esbuild 实测（react external, gzip）。

## D2 react-query 版本与全局默认

**Decision**: `@tanstack/react-query@^5.105.0`（peer `react ^18‖^19`，
query-core 同版锁定；TS 5.8 在其类型测试矩阵内，显式支持）。全局默认：

- 浏览型 SWR：`staleTime` 30s（目录/直播）/ 60s（EPG 慢变），`gcTime` 5min，
  `refetchOnMount/Focus/Reconnect: true`；分页列表 `placeholderData:
  keepPreviousData`（设置类禁用）。
- 设置型强制最新：**`gcTime: 0 + staleTime: 0` + 无 placeholderData**，
  UI 以 `isPending` 门控骨架——`staleTime: Infinity`（永不重取）与
  `refetchOnMount:'always'`（后台重取但先渲染旧值）均被否决。
- 重试：查询 ≤1 次（5xx/网络错误 1 次、429 1 次、其余 4xx 0 次）；
  `mutations: { retry: 0 }`。
- 体积：数据层 gzip ≈ 13.2KB（bundlephobia 实测 5.105.0），预算计入 SC-009；
  不引入 persist-client（无离线需求）；devtools 独立包、生产默认排除。

**Rationale**: 官方 Important Defaults / Caching 指南语义（staleTime=新鲜窗口、
gcTime=不活跃驻留；缓存存在即先渲染）；settings 配方机制经文档确认（无缓存 →
`isPending` 硬加载），为组合惯用法而非具名模式（置信度中高）。
**Alternatives**: SWR/RTK Query（否决：用户已指定 react-query；生态与 v5 能力最匹配）。

## D3 乐观更新统一封装（Q1 落地）

**Decision**: 共享 `useAppMutation` 封装按 `feedback` 分档：
- `optimistic`（收藏/星标、观看状态、进度类）：官方模式——`onMutate`
  先 `cancelQueries` 防竞态 → 快照 → `setQueryData`；`onError` 回滚快照 +
  `toast` 统一提示；`onSettled` 返回 `invalidateQueries` Promise 对账。
  单表面积简单变更优先"UI variables + isPending"变体（零回滚代码）。
- `confirmed`（表单保存、PIN、来源/策略等）：无乐观写，等待态 + 成功后失效。

**Rationale**: 官方 Optimistic Updates 指南；toast 置于 per-mutation `onError`
（持快照上下文），全局 `MutationCache.onError` 仅留给会话失效，避免双弹。
**Alternatives**: 全局自动乐观（否决：管理类操作误反馈风险，见 spec 选项 C 否决理由）。

## D4 身份切换 / 401 的缓存清除

**Decision**: `purgePersonalData(qc)` 固定顺序：
`cancelQueries(谓词: 键[0] !== 'public')` → `removeQueries(同谓词)` →
`mutationCache.clear()` → **同步先于** `profileId` 状态更新执行。
挂载点：登出处理器、切档处理器、`QueryCache.onError` 的 401 分支（每轮去重）。
登出场景可简化为 `qc.clear()`（公共缓存廉价可重取）；**切档必须用谓词**保留公共域。

**Rationale**: 官方 QueryClient 语义核验——`cancelQueries` 中止在途且默认
`revert`；`removeQueries` 仅删缓存不触发重取；`resetQueries` 会重取（401 场景
只会再 401，否决）。AbortError 原样上抛、不包 `FetchApiError`（取消不计重试）。
**Alternatives**: 仅靠键含 profileId 隔离（否决：不满足"清空"的显式验收 SC-005）。

## D5 遗留 `lib/api.ts` 退役路径

**Decision**: 三步：①盘点消费方 → ②逐个迁至 `shared/query/` 封装
（键工厂 + queryFn 包装 `publicFetch`/`privateFetch`）→ ③删除
`apps/web/src/lib/api.ts`，不留兼容层、不双轨（FR-018）。
替代关系按宪法原则五记录于新 ADR（与规格一同接受）。

**Rationale**: `shared/fetch.ts` 注释（T040）已标记其为遗留实现；
唯一入口不变式要求收敛。**Alternatives**: 保留为薄 re-export（否决：双轨滋生旁路）。

## 附：组件映射事实基线（本地核验）

- `@heroui/react@3.2.6` 本地含 89 个组件目录，替换所需全覆盖：
  `select`、`alert-dialog`、`toast`、`modal`、`skeleton`、`spinner`、
  `progress-bar`/`progress-circle`、`empty-state`、`table`、`tabs`、`switch`、
  `tooltip` 等（`apps/web/node_modules/@heroui/react/dist/components/`）。
- v3 写法核验记录：`apps/web/src/shared/theme/HEROUI-NOTES.md`
  （复合组件结构、`onPress`、无 Provider、固定暗色 `html.dark`）。
- 现存原生控件清单（grep 实测 8 处）：settings-epg 1、settings-policy 2、
  settings-profiles alert 1、settings-sources 1、GuidePage 2（另 profiles 页
  `window.alert` 计入上数）。

## 来源

- 包元数据（本地 npmmirror 直取，权威）：`pnpm view ahooks/usehooks-ts/react-use/@mantine/hooks/@tanstack/react-query`
- TanStack Query v5 官方文档（研究代理直取）：[Important Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults) · [Caching](https://tanstack.com/query/latest/docs/framework/react/guides/caching) · [Query Keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys) · [Optimistic Updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates) · [Invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation) · [Cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation) · [QueryClient API](https://tanstack.com/query/latest/docs/framework/react/reference/classes/QueryClient.md) · [QueryCacheConfig.onError](https://tanstack.com/query/latest/docs/framework/react/reference/interfaces/QueryCacheConfig.md) · [Devtools](https://tanstack.com/query/latest/docs/framework/react/devtools) · [Migrating to v5](https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5)
- TkDodo：[Effective React Query Keys](https://tkdodo.eu/blog/effective-react-query-keys)
- React 19 兼容：[TanStack/query PR #9310](https://github.com/TanStack/query/pull/9310) · [PR #11598](https://github.com/TanStack/query/pull/11598) · [Issue #9440](https://github.com/TanStack/query/issues/9440)
- 体积：[Bundlephobia API（react-query@5.105.0）](https://bundlephobia.com/api/size?package=@tanstack/react-query@5.105.0)（min 45.9KB / gzip ≈13.2KB）
- hooks 库对比（**2026-10-27 实时抓取**，研究代理经 curl 直连 npm registry/GitHub API + 本机 esbuild 实测）：[alibaba/hooks](https://api.github.com/repos/alibaba/hooks) · [ahooks React 19 issue #2670（已解决）](https://github.com/alibaba/hooks/issues/2670) · [mantinedev/mantine](https://api.github.com/repos/mantinedev/mantine) · [juliencrn/usehooks-ts](https://api.github.com/repos/juliencrn/usehooks-ts) · [streamich/react-use](https://api.github.com/repos/streamich/react-use) · 各包 npm latest 元数据与 tarball 结构实测
- 本地：`apps/web/src/shared/theme/HEROUI-NOTES.md`、`apps/web/src/shared/fetch.ts`、grep 扫描记录

**置信度总评**: D1–D5 全部高。D2/D3/D4 依据官方文档直取；D1 版本/维护/包结构
为实时 API 抓取、bundle 为可复现 esbuild 实测（ahooks React 19 长尾担忧已被
issue #2670 关闭记录消解）；D5 基于仓库内注释与迁移路径约定。标注的低置信项：
@mantine/hooks v9 无独立 useScrollLock（tarball 导出核实，实现期复核）、react-use
React 19 运行时未深审（已否决，不影响决策）。
