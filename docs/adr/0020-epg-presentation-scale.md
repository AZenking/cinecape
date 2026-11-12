# ADR-0020：EPG 节目单的呈现尺度与详情形态

- 状态：Accepted
- 日期：2026-11-12
- 适用版本：V1.0+
- 依据：项目宪章核心原则七（频道中心制）、技术约束 5/8（HeroUI v3 + 语义 token）
- 关联：[019-player-control-experience](../specs/019-player-control-experience/spec.md)（同为播放/观看面体验）

## Context

节目单（`/live/guide`）此前存在三个体验问题（产品评审）：

1. **时间轴过密**：`PX_PER_MINUTE = 2`，半小时节目块仅 60px，标题几乎必然截断成「新闻专…」，无法扫读；
2. **节目块像色条**：无圆角层次、块间无缝隙，密集排列时难以区分相邻节目；
3. **详情是居中弹窗**：节目详情用 `Modal` 居中弹出，遮住整个时间轴——而用户看详情时通常还想对照前后排期；
4. **布局宽度不一致**：只有节目单铺满、其他页 1120px 窄栏，观感割裂。

## Decision

1. **时间轴尺度 2px/min → 6px/min**（1 小时 360px、30 分钟 180px、全天 8640px），与参考站同档；横向由墙内滚动承担，DST 日按真实日长、比例不变。
2. **行高 56px → 72px**，为双行卡片留出呼吸感；多泳道重叠仍按 `MAX_LANES` 压缩。
3. **节目块卡片化**：`rounded-lg` + 边框 + `shadow-xs` + 块间留缝（left+1/width-2/top+4/height-8），hover 抬升；语义仍是 `<button>` + `aria-label`（HeroUI `Card` 不是可按压组件，直接套用会丢失键盘/读屏语义）。
4. **节目详情改右侧抽屉**：`Modal` → HeroUI `Drawer`（`placement="right"`，面板宽 420px / `max-w-92vw`），保留原有可访问名「节目详情:频道」与动作按钮；宽度加在 `Drawer.Dialog` 上而非 `Content`（加在 Content 会把定位容器压窄并贴左，已踩坑）。
5. **布局壳统一铺满**：`PublicLayout` 不再整体限宽，顶栏与内容区一律 100%；阅读型内容（首页等）在页面内自行 `max-w-6xl`。壳宽一致、内容易读，两者不互相牺牲。

## Consequences

**正**
- 节目名可显示 6–10 个汉字，扫读效率提升；6px/min 与 30 分钟 180px 与参考站一致。
- 卡片化后相邻节目边界清晰，当前/选中态层次更强。
- 抽屉不遮挡时间轴其余部分，符合「就地查看上下文」；作品页与节目单共享同一面板，形态统一。
- 壳宽一致，页面切换无「忽宽忽窄」。

**负 / 风险**
- 全天内容宽 8640px，横向滚动距离变长；依赖「回到现在」与 ±2h 平移，窄屏更需要横向滚动。
- 卡片留缝依赖 inline 计算的 ±px 偏移，泳道压缩（3 道）时块高可能不足 2 行，已由 `showTimeLine` 回落单行。
- 抽屉在窄屏（<420px）以 `92vw` 呈现，接近全屏，仍保持右侧滑入语义。
- 详情形态变更影响 `/live` 首页与节目单两处宿主；e2e 若按 `[data-slot="modal-dialog"]` 定位详情需改为 `role=dialog` + 可访问名（登录弹层不受影响）。

## Verification

- 单测：`test/guide-detail-panel-host.spec.tsx`、`test/epg/*`、`test/live-upcoming-ended-no-play.spec.tsx`、`test/epg-channel-watch.spec.tsx` 全绿（详情仍按可访问名与按钮断言）。
- 浏览器实测：30 分钟块 178–181px（6px/min）、块高 64px、圆角 8px；详情抽屉 `x=1276, w=420, right=1696, h=975`（右侧贴边满高）。
- 全量：85 文件 / 570 通过 / 1 跳过。
