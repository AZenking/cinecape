# UI Contract: 020-tmdb-programme-posters

日期：2026-11-13。遵循 `DESIGN.md`、HeroUI v3 语义 token；图片为装饰/内容媒体，不使用原生交互控件。

## 1. 展示点

| 位置 | 形态 | 规则 |
| --- | --- | --- |
| 节目单墙 `GuideWall` | 块内左侧 2:3 缩略图 | 仅 `posterRef != null` 且块宽 ≥110px、块高足够；窄块/多泳道压缩块纯文字 |
| 节目单列表 `GuideChannelList` | 每行左侧 `w-9` 2:3 缩略图 | 当前/即将/已结束都有；窄屏可隐藏（`hidden sm:block`） |
| 详情抽屉 `ProgrammeDetailPanel` | 2:3 海报 `w-28` | 有节目海报时与标题/简介并排；无海报时保持现有 16:9 频道 Logo 区域 |
| 公共布局 `PublicLayout` footer | TMDB logo + 声明 | 全公共页面常驻；`fill` 页面用 `shrink-0` |

## 2. 回退链

```text
节目海报（programme.posterRef）
  → 加载失败 / ref 为 null
  → 频道 Logo（channel.posterRef 或 channel.logo）
  → 频道首字/既有渐变底板
```

- 任何回退都不得造成布局位移或裂图图标。
- 墙/列表的海报失败只隐藏图片，文字、时间、LIVE 角标、进度条、点击区域不变。
- 详情海报失败回退到现有频道身份区域，不关闭抽屉、不阻塞播放/收藏/关闭。

## 3. 加载与性能

- `loading="lazy"`、`decoding="async"`；仅渲染可视/近可视块（墙已有横向窗口化 + `content-visibility`）。
- HTTP 缓存：代理 `Cache-Control: public, max-age=86400`；组件不做内存缓存，按 `posterRef` 稳定 key 重置失败状态。
- 图片不参与布局流（墙内绝对/固定尺寸容器），任何相位容器尺寸零变化。

## 4. 可访问性

- 墙/列表：图片 `alt=""` + `aria-hidden="true"`；可读名由既有按钮/行的 `aria-label` 承担（包含节目标题、时间、LIVE 状态）。
- 详情：海报 `alt="{节目标题} 海报"`；失败回退后不保留空 img。
- footer：TMDB logo `alt="TMDB"`；声明为普通文本，链接可键盘聚焦；不改变页面标题层级。
- 不以颜色作为唯一状态区分（LIVE/当前/已结束沿用既有文字/徽章）。

## 5. 视觉 token

- 容器圆角/边框/背景使用 HeroUI 语义 token（`border-border`、`bg-surface-secondary`、`text-muted` 等）。
- 2:3 比例使用标准 `aspect-[2/3]` 媒体比例工具类；不做硬编码颜色。
- 海报宽度/高度为媒体展示尺寸，记录于本契约与 `DESIGN.md` 的媒体尺寸节；业务组件不复制裸色值。

## 6. TMDB 署名

footer 文案：

> 本应用使用 TMDB 与 TMDB API，但未获 TMDB 认可、认证或批准。

- 链接 `https://www.themoviedb.org/`，`target="_blank"` + `rel="noreferrer"`。
- TMDB logo 使用官方蓝色短标（`apps/web/public/brand/tmdb.svg`），尺寸不高于应用品牌；不得暗示 TMDB 背书。
- 署名常驻，不因是否配置 Key 隐藏（功能已内置）；README 同时说明关闭方式。

## 7. 范围守护

- 不改变节目块点击语义（仍打开详情，不直接播放；直播主操作在详情内）。
- 不改变节目单时间轴坐标、NOW 线、泳道、分页、筛选、URL 状态。
- 不把海报作为播放授权/身份判断依据；游客与登录展示一致。