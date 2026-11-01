# Contract: 查询键工厂（Query Key Factory）

**Feature**: `006-heroui-react-query-refactor` | **Date**: 2026-10-27
**约束来源**: spec FR-016/020/021、data-model.md §1–2、宪法原则二/三

前端缓存键是本次重构引入的核心内部契约：键首段决定身份缓存域，
是"公共/个人/设置分域、切档清域"全链路行为的基础。所有数据访问
**必须**经键工厂创建键，**禁止**页面内手写字符串键。

## 键命名空间

```ts
// apps/web/src/shared/query/keys.ts —— 唯一键工厂（示意，实现期定稿）
export const queryKeys = {
  // ── public 域：匿名可读、身份无关（publicFetch, credentials:'omit'）
  public: {
    context: ()          => ['public', 'context'],
    catalog: (f: CatalogFilters) => ['public', 'catalog', f],  // CatalogFilters 含可选 type
    media:   (id: string) => ['public', 'media', id],
    guide:   (q: GuideQuery) => ['public', 'guide', q],   // 日期/频道窗口
    live:    ()          => ['public', 'live'],           // 直播分区（30s 轮询契约不变）
    epg:     (q: EpgQuery) => ['public', 'epg', q],
  },
  // ── profile 域：个人数据，键必须携带 profileId（privateFetch）
  profile: (profileId: string) => ({
    favorites: ()      => ['profile', profileId, 'favorites'],
    history:   (p: Page) => ['profile', profileId, 'history', p],
    progress:  (id: string) => ['profile', profileId, 'progress', id],
  }),
  // ── settings 域：管理数据，每次进入请求最新（privateFetch）
  settings: {
    account:  () => ['settings', 'account'],
    profiles: () => ['settings', 'profiles'],
    policy:   () => ['settings', 'policy'],
    sources:  () => ['settings', 'sources'],
    devices:  () => ['settings', 'devices'],
    epg:      () => ['settings', 'epg'],
  },
} as const;
```

## 契约规则

1. **域 = 键首段**：`public` / `profile` / `settings` 三段式前缀是硬约束，
   域级清除（`profile` 切档/登出/401）按首段前缀匹配执行。
2. **个人键必须含 `profileId`**：由经验证的当前身份注入（session provider 提供），
   不得以裸资源路径作个人缓存键（FR-021）。
3. **键可序列化**：参数对象放末位元素；不含函数、类实例、时间戳瞬态值
   （日期用 `YYYY-MM-DD` 字符串）；保证同参同键、异参异键。
4. **不含敏感凭据**：任何键与缓存值不得包含播放票据、源地址、来源凭据
   （宪法原则三；播放解析走一次性动作，非查询，见 data-model §2）。
5. **新增资源必须扩键工厂**：不新开第二套键机制；键结构变更属于本契约变更，
   需同步更新本文件。
6. **契约不变式**：键命名空间的增删不影响服务端 API 契约；`@hmp/shared`
   类型仍以 type-only 引用，不反向依赖前端（宪法技术约束 4）。

## 域级行为绑定

| 域 | staleTime 语义 | 挂载行为 | 清除时机 |
| --- | --- | --- | --- |
| `public` | 过期即显 + 后台刷新 | 命中缓存立即渲染 | 会话结束 |
| `profile` | 过期即显 + 后台刷新 | 命中缓存立即渲染 | 切档 / 登出 / 401 → 取消并移除 |
| `settings` | 恒过期（每次最新） | 挂载必取、加载态呈现 | 登出 / 401 → 取消并移除 |

（具体数值参数与库内 API 映射见 research.md 决策 D2、D4。）

## 补记（T089，2026-10-31）：010 在线点播键（T034/T080 遗留同步）

010 实施在键工厂追加了以下键（实现见 `apps/web/src/shared/query/keys.ts`，契约规则 1–6 全部适用；此处补记本文件遗漏）：

```ts
// ── public 域 ──
public: {
  // 010 在线点播搜索(T034 收编内联键;api.md §2 两组参数互斥):
  // input=null 落 {idle:true} 占位,活跃期键只含 q ——「写 searchId 不改变取数输入」
  vodSearch:   (input: VodSearchInput | null) => ['public', 'vod', 'search', input ?? { idle: true }],
  // 010 临时预览(titleRef 为服务端 opaque ref)
  vodPreview:  (titleRef: string)            => ['public', 'vod', 'preview', titleRef],
  // 010 稳定父详情分集(修订绑定 cursor;缺 cursor=第一页)
  vodEpisodes: (parentMediaId: string, query: VodEpisodesQuery)
                                            => ['public', 'media', 'episodes', parentMediaId, query],
},
// ── profile 域(个人键携带 profileId;010 api.md §3 GET /me/vod/titles/:parentId/progress)──
profile: (profileId: string) => ({
  // TitleProgress={latest,resumeCandidate,nextEpisodeAction};身份恒由服务端推导,
  // 切档域清除按 'profile' 首段前缀覆盖
  vodTitleProgress: (parentMediaId: string) => ['profile', profileId, 'vod', 'title-progress', parentMediaId],
}),
```

键面行为有组件级钉面：`apps/web/test/vod-identity-guards.spec.tsx`（游客零个人键/普通路由不清理全局会话）、`apps/web/test/online-vod-catalog.spec.tsx`（经键工厂消费 vod 键）。
