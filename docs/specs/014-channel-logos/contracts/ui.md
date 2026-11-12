# UI Contract: 014-channel-logos（呈现面）

日期：2026-11-07。Proposed 设计。视觉基线：DESIGN.md（HeroUI 官方默认主题契约）+ 语义 token；实施前按宪章技术约束 8 取 heroui-react 固定基线 3.0.1 的组件/主题文档并记录获取日期。

## 1a. 实施期呈现修订（2026-11-08，维护者指令）

**修订内容**：卡片主视觉取消「底板大首字」；频道身份改为**右上角角标** `ChannelIdentityBadge`（channel-identity-badge.tsx）：

- `posterRef` 非空 → Logo 衬底盒（加载中/失败回退**频道名 chip**）；`posterRef` null → 恒名称 chip；
- 名称 chip：`hmp-truncate` 截断 + HeroUI Tooltip 全名（`placement="bottom"`；宪章技术约束 5「提示」组件走 HeroUI；文档依据 components/(overlays)/tooltip.mdx 与 demos/cn/tooltip/{basic,placement}.tsx，获取日期 2026-11-08，实装 3.2.6。**必须显式 `Tooltip.Trigger`**——v3 无 Trigger 包装时不挂任何 hover 事件，jsdom 实测探针结论）；
- 宿主定位：ChannelTile `absolute right-2 top-2`、NowHero `absolute right-4 top-4 md:right-6 md:top-6`（与其左上状态签对称）；
- 不变量延续：身份任一相位不缺位（无裂图/无空白）、零布局位移、播放/收藏/详情操作不受影响、同 ref 跨刷新不闪变、SC-006 照旧；
- ChannelLogo（§1）保留给小尺寸身份盒（GuideChannelList/personal-area），其首字回退契约不变；
- 应用范围：ChannelTile/NowHero 替换为角标；§2 接入点表其余行不变。

**测试口径**：HeroUI Tooltip 的悬浮展开属 overlay 管理器行为，jsdom 不可模拟（react-aria useHover onMouseEnter 布线已核、focus 通道需键盘 modality，均不触发渲染）——自动化断言「Tooltip 布线存在」（触发层 `data-slot="tooltip-trigger"` + `aria-describedby`），实际展开归运行时证据（quickstart §4）。

## 1. 共享组件：ChannelLogo（暂名 `channel-logo.tsx`）

> 本节为 ChannelLogo（小尺寸身份盒）契约；卡片右上角身份角标见 §1a。

**定位**：纯装饰性频道 Logo 渲染 + 统一回退链；**非交互控件**（不接收焦点、不响应点击），不触宪章技术约束 5 的 HeroUI 交互组件禁令；因 HeroUI 未提供「错误即隐形」的装饰图能力而自定义，偏离记录于此（约束 5 要求的记录面）。

**Props**：

| Prop | 类型 | 语义 |
| --- | --- | --- |
| `posterRef` | `string \| null` | 直播/目录 DTO 原样回传的引用；null = 直接回退层 |
| `channelTitle` | `string` | 仅用于回退层首字与容器 aria-label 组合；不进 img alt |

**渲染状态机**：

```text
posterRef === null            → 回退层（不渲染 img）
posterRef 非空，img loading    → 回退层在下层持续渲染；img onLoad 后淡入（respect reduced-motion）
img onError / timeout 隐式失败  → 卸载 img，仅回退层（无裂图图标、无错误文案、无占位框）
img loaded                    → Logo 覆盖回退层；底板渐变保留为衬底
```

**不变量（SC-002/FR-007/FR-008 的组件化表达）**：

1. 任何路径不出现裂图图标、空白主视觉或布局位移（img 绝对定位于底板层内，不参与布局流）。
2. 回退层 = 现有 ChannelTile 渐变底板 + 频道首字实现**原样保留**，跨刷新稳定不闪变（FR-008）。
3. 有 Logo 时首字不显示，两者互斥（spec Edge Cases）。
4. 图片加载中与失败不阻塞卡片任何操作（播放/收藏/详情入口与文字信息先行可用）。
5. img 无可读 alt（`alt=""` + `aria-hidden="true"`）；可读名由宿主容器承担（ChannelTile 现有 aria-label 模式）。
6. 不做内存缓存：HTTP 缓存交给 `Cache-Control`（api.md §1）；组件按 posterRef 稳定 key 复用 React 状态即可。
7. 路径前缀（实施注记，2026-11-07）：web 端实际请求 `/api/public/media/logos/{posterRef}`（server `setGlobalPrefix('api')` + vite 仅代理 `/api`，010 海报先例同构）；api.md/ui.md 中的 `/public/media/logos/...` 均指服务端路由（不含全局前缀）。

## 2. 接入点（5 处）

| 接入点 | 呈现形态 | 备注 |
| --- | --- | --- |
| `live/components/ChannelTile.tsx` | 16:9 底板中心，Logo 最大占位 | 主视觉；状态签/进度线/操作入口 z 序在 Logo 之上 |
| `live/components/NowHero.tsx` | 正在播大卡底板 | 复用 progressOf/底板既有结构，仅加 Logo 层 |
| `epg/GuideChannelList.tsx` | 频道列头小尺寸身份标识 | 行高与布局不因 Logo 有无而变化（US3-1）；列头文字仍保留；数据面 `GuideWindowDto.channels[].media.posterRef` 既有，零服务端改动 |
| `home/personal-area.tsx`（收藏频道卡 + 收藏列表条目） | 卡片/条目小 Logo | 实施注记（2026-11-07）：全仓无独立 /favorites 路由页，收藏频道列表唯一渲染面即 personal-area 的 FavoritesSection——ui.md 原接入点 4/5 在此同一组件一并落地 |

**范围守护（FR-012/SC-006）**：`GuideWall`/`GuideScrollContainer` 时间轴节目格**禁止**引入任何 `img`——组件测试加一条断言：时间轴渲染结果中 `img` 元素数为 0。

## 3. 视觉与 token

- Logo 层背景透明，直接叠于既有底板渐变之上；不加工图片（无裁剪/去底/遮罩——spec Assumptions）。
- 淡入动效用既有过渡工具类与语义 token；`prefers-reduced-motion` 下直接显示（全局 a11y 基线）。
- 不新增设计常量；底板渐变/圆角/间距全部沿用现有实现值与 token。

## 4. 组件测试清单（实现后必须存在，现不存在——不伪造）

1. posterRef=null → 断言无 img、回退层（首字）可见。
2. img 加载成功 → Logo 可见、首字隐藏、容器尺寸不变。
3. img 加载失败（模拟 onError）→ Logo 层卸载、无裂图痕迹、回退层完整。
4. 加载中 → 播放/收藏/详情按钮可交互（fireEvent 不被 pending img 阻塞）。
5. 同一 posterRef 重渲染 → 不闪变（key 稳定，无卸载重挂）。
6. GuideWall 时间轴 img 数量为 0（范围守护）。
