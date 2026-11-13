---
name: HeroUI Default Theme
library: "@heroui/react"
styles: "@heroui/styles"
modes:
  - light
  - dark
source: "https://github.com/heroui-inc/heroui/blob/v3/packages/styles/themes/default/variables.css"
---

# HeroUI Default Theme

Use this file as the visual implementation contract when building a product with HeroUI v3. It describes the default HeroUI theme for designers and coding agents. The theme CSS remains the source of truth.

## Setup

Install `@heroui/react` and import HeroUI after Tailwind CSS:

```css
@import "tailwindcss";
@import "@heroui/styles";
```

Apply the semantic canvas colors at the application root:

```tsx
<body className="bg-background text-foreground">{children}</body>
```

Use `class="light"` or `data-theme="light"` for light mode and `class="dark"` or `data-theme="dark"` for dark mode. The `default` theme is the light theme.

## Design Direction

- Build calm, modern interfaces with a clear content hierarchy.
- Prefer whitespace, typography, and surface levels over decoration.
- Use one strong accent for primary actions and reserve status colors for meaning.
- Compose interfaces from HeroUI components before creating custom primitives.
- Keep interactions accessible, keyboard friendly, and visibly focused.
- Let semantic tokens adapt the interface between light and dark modes.

## Colors

Use semantic HeroUI tokens and Tailwind utilities in product code. Raw values are included for design handoff and visual QA only. Do not branch component code by color mode.

| Role | Tailwind utilities | CSS variables | Light | Dark | Purpose |
| --- | --- | --- | --- | --- | --- |
| Canvas | `bg-background text-foreground` | `--background`, `--foreground` | `oklch(0.9702 0 0)`, `oklch(0.2103 0.0059 285.89)` | `#141318` = `oklch(0.1902 0.0101 294.59)`, `#F3F1F7` = `oklch(0.9614 0.0082 301.36)` | Page background and primary content (石墨黑 + 柔白) |
| Surface | `bg-surface text-surface-foreground` | `--surface`, `--surface-foreground` | white, foreground | `oklch(0.2103 0.0059 285.89)`, foreground | Cards and non-floating containers |
| Secondary surface | `bg-surface-secondary` | `--surface-secondary` | `oklch(0.9524 0.0013 286.37)` | `oklch(0.257 0.0037 286.14)` | Nested or lower-emphasis regions |
| Tertiary surface | `bg-surface-tertiary` | `--surface-tertiary` | `oklch(0.9373 0.0013 286.37)` | `oklch(0.2721 0.0024 247.91)` | Stronger surface separation |
| Overlay | `bg-overlay text-overlay-foreground` | `--overlay`, `--overlay-foreground` | white, foreground | `oklch(0.2103 0.0059 285.89)`, foreground | Popovers, menus, dialogs, and tooltips |
| Backdrop | `bg-backdrop` | `--backdrop` | black at 50% | black at 60% | Content dimming behind overlays |
| Muted content | `text-muted` | `--muted` | `oklch(0.5517 0.0138 285.94)` | `oklch(70.5% 0.015 286.067)` | Supporting text and secondary icons |
| Neutral action | `bg-default text-default-foreground` | `--default`, `--default-foreground` | `oklch(94% 0.001 286.375)`, eclipse | `oklch(27.4% 0.006 286.033)`, snow | Neutral controls and selected states |
| Accent | `bg-accent text-accent-foreground` | `--accent`, `--accent-foreground` | `#8B7AE6` = `oklch(0.6438 0.1573 288.40)`, `#141318` | same as light | Primary actions, focus, and emphasis (鸢尾紫;悬停 `#A99AF2`) |
| Success | `bg-success text-success-foreground` | `--success`, `--success-foreground` | `oklch(0.7329 0.1935 150.81)`, eclipse | same as light | Positive outcomes and completed states |
| Warning | `bg-warning text-warning-foreground` | `--warning`, `--warning-foreground` | `oklch(0.7819 0.1585 72.33)`, eclipse | `oklch(0.8203 0.1388 76.34)`, eclipse | Caution and attention |
| Danger | `bg-danger text-danger-foreground` | `--danger`, `--danger-foreground` | `oklch(0.6532 0.2328 25.74)`, snow | `oklch(0.594 0.1967 24.63)`, snow | Errors and destructive actions |
| Field | `bg-field text-field-foreground` | `--field-background`, `--field-foreground` | white, eclipse | eclipse, foreground | Inputs and interactive fields |
| Border | `border-border` | `--border` | `oklch(90% 0.004 286.32)` | `oklch(28% 0.006 286.033)` | Component boundaries |
| Separator | `border-separator` | `--separator` | `oklch(92% 0.004 286.32)` | `oklch(25% 0.006 286.033)` | Quiet structural dividers |

Hover, focus, soft, inverse, and secondary or tertiary border colors are derived with `color-mix()`. Use utilities such as `bg-accent-hover`, `bg-accent-soft`, `text-accent-soft-foreground`, `border-border-secondary`, and `border-separator-secondary` instead of recreating those formulas.

## Typography

HeroUI inherits the application's font family and uses Tailwind's type scale. Preserve the component defaults unless the product has its own type system.

- Use concise, descriptive headings in sentence case.
- Use `text-foreground` for primary content and `text-muted` for supporting content.
- Keep body copy readable with a comfortable line height and constrained line length.
- Use tabular numbers for changing metrics, prices, counters, and aligned numeric data.
- Avoid all-caps labels except for short, established conventions.

## Layout

The spacing base is `--spacing: 0.25rem`, giving the system a 4px rhythm through Tailwind spacing utilities.

- Use consistent Tailwind gaps and padding rather than one-off values.
- Keep related controls and content visually grouped.
- Constrain wide reading layouts and size containers to their content.
- Avoid doubling parent and child padding in the same direction.
- Align sibling cards, controls, labels, and metrics to shared visual anchors.

## Shapes

The base radius is `--radius: 0.5rem` (8px). The default field radius is `--field-radius: calc(var(--radius) * 1.5)` (12px).

| Utility | Formula | Default value |
| --- | --- | --- |
| `rounded-xs` | `calc(var(--radius) * 0.25)` | 2px |
| `rounded-sm` | `calc(var(--radius) * 0.5)` | 4px |
| `rounded-md` | `calc(var(--radius) * 0.75)` | 6px |
| `rounded-lg` | `calc(var(--radius) * 1)` | 8px |
| `rounded-xl` | `calc(var(--radius) * 1.5)` | 12px |
| `rounded-2xl` | `calc(var(--radius) * 2)` | 16px |
| `rounded-3xl` | `calc(var(--radius) * 3)` | 24px |
| `rounded-4xl` | `calc(var(--radius) * 4)` | 32px |

Use the scale consistently. Inner media and nested surfaces should have a visibly related, usually smaller, radius than their parent.

## Elevation and Depth

- Use `shadow-surface` for cards and raised page content.
- Use `shadow-overlay` for floating layers such as dialogs, menus, and popovers.
- Use `shadow-field` for form controls when the component applies it.
- Dark mode intentionally removes surface and field shadows and gives overlays a subtle inset edge.
- Do not stack custom shadows on HeroUI components that already provide elevation.

## Components

- **Buttons:** Use semantic variants. `primary` is the main action, `secondary` is an alternative, `tertiary` is dismissive or low emphasis, `outline` is a bordered low-emphasis action, `ghost` is an unbordered low-emphasis action, `danger` is destructive, and `danger-soft` is a quieter destructive action. Prefer one primary action per context and reach for an existing variant instead of restyling a button.
- **Cards and surfaces:** Use `Card`, `Surface`, and semantic surface utilities. Create hierarchy with surface levels and spacing before adding borders.
- **Forms:** Use HeroUI field components so background, foreground, placeholder, border, focus, radius, validation, and disabled states stay consistent.
- **Status:** Use success, warning, and danger only for their semantic meanings. Pair color with text or an accessible label.
- **Overlays:** Use HeroUI `Modal`, `Popover`, `Dropdown`, and `Tooltip` components so focus management, dismissal, and keyboard behavior remain accessible.
- **Compound components:** Compose exported parts instead of replacing component behavior with custom divs. Preserve labels, roles, and keyboard interactions.

## Interaction

- Use HeroUI and React Aria states, including `data-hovered`, `data-pressed`, `data-focus-visible`, `data-disabled`, and `data-invalid`.
- Every interactive element needs a visible focus indicator. The default focus color is the accent, with a 2px ring offset.
- The default disabled opacity is `0.5`; disabled controls use a not-allowed cursor.
- Use motion to clarify state changes, not as decoration. Respect reduced-motion preferences.
- Keep icon-only and touch controls large enough to target and give them accessible labels.

## Do

- Use HeroUI components and their documented variants before writing custom primitives.
- Use semantic tokens as implementation handles and raw values only for reference or migration.
- Use the same token in light and dark modes and let CSS resolve the current value.
- Establish hierarchy with content order, spacing, type, and surface level.
- Reserve accent for meaningful emphasis and keep status colors semantic.
- Use separators sparingly; prefer spacing for ordinary grouping.
- Keep active, selected, loading, invalid, and disabled states visible and accessible.

## Don't

- Don't hardcode colors, shadows, radii, or spacing when a HeroUI token or Tailwind utility exists.
- Don't use raw neutral palette classes such as `gray-*` where a semantic surface or content token applies.
- Don't use color alone to communicate state or hierarchy.
- Don't mix unrelated radius, padding, or elevation systems in one view.
- Don't make static content look interactive with hover or pressed effects.
- Don't overuse cards, borders, badges, icons, accent color, or nested heavy surfaces.
- Don't bypass HeroUI interaction behavior with inaccessible custom markup.

## Source of Truth

- Default theme variables: https://github.com/heroui-inc/heroui/blob/v3/packages/styles/themes/default/variables.css
- Tailwind token mappings: https://github.com/heroui-inc/heroui/blob/v3/packages/styles/themes/shared/theme.css
- Component documentation: https://heroui.com/docs/react/components
- Colors: https://heroui.com/docs/react/getting-started/colors
- Theming: https://heroui.com/docs/react/getting-started/theming
- Design principles: https://heroui.com/docs/react/getting-started/design-principles

When this file and the current package disagree, follow the installed HeroUI version and its theme CSS.

## 项目补充设计 token（HMP）

以下尺度是 HeroUI 默认主题未覆盖、但本项目高密度媒体界面必需的补充项。按宪章技术约束 8，
集中定义于 `apps/web/src/shared/theme/tokens.css`（`@theme` 块），业务组件只引用 token，
不得再写任意值类。

### 文本尺度（紧凑元信息）

| Token | 值 | 用途 | 禁止场景 |
| --- | --- | --- | --- |
| `text-3xs` | 10px / lh 14px | EPG 时间轴刻度、频道序号、LIVE 徽章、播放面头部小字 | 正文、可点击标签主文字 |
| `text-2xs` | 11px / lh 15px | 节目块时间行、控制栏时间、设置面板分段标签 | 正文、按钮主标签 |

> 标准档位 `text-xs`(12px) 仍是正文下界；10/11px 仅用于高密度元信息，且必须保证
> 与所在表面有足够对比度（暗色主题下用 `text-muted`/`text-foreground` 语义 token）。

### 媒体与布局尺寸（常量，非主题色）

这些是布局/媒体尺寸，不是颜色，因此不进入主题 token 表；当前以组件内常量或一次性任意值
表达，用途固定、不得被复制成"随手编的数值"。新增同类尺寸必须先在此登记用途。

| 尺寸 | 值 | 用途 | 位置 |
| --- | --- | --- | --- |
| EPG 频道列宽 | 176px | 节目单墙固定频道列 | `features/epg/GuideWall.tsx` `CHANNEL_COL_PX` |
| EPG 行高 | 56px | 节目单墙频道行 | 同上 `ROW_HEIGHT_PX` |
| EPG 像素/分钟 | 2px | 时间轴横向比例（全天 2880px） | `features/epg/guide-time.ts` `PX_PER_MINUTE` |
| 播放面 mini | 300×200 | 右下角悬浮播放器（宽 300，含控制栏总高约 200） | `app/action-coordinator.tsx` `MINI_WIDTH_PX`/`MINI_HEIGHT_PX` |
| 播放面最大宽 | `min(94vw, 1120px, (100vh-12rem)*16/9)` | 大窗播放器，保证矮视口不遮挡顶栏 | `app/action-coordinator.tsx` |
| 设置侧栏宽 | 220px / 256px | 宽/窄两档侧栏面板 | `layouts/SettingsLayout.tsx` |
| 设置内容最大宽 | 960px / 1216px | 内容列约束 | `layouts/SettingsLayout.tsx` |
| 设置来源面板宽 | 320px / 880px | 来源列表/编辑面板 | `features/settings/*` |
| 播放设置面板 | 288px(`w-72`)，限高 `min(70vh,420px)` | 控制栏上浮设置面板 | `playback-settings-overlay.tsx` |
| 直播切台面板 | 288px(`w-72`)，最大 85% | 播放器内右下覆盖面板 | `features/live/components/LiveGuidePanel.tsx` |
