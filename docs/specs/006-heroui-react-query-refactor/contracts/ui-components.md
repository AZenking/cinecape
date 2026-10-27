# Contract: UI 组件与共享 Hooks（呈现层）

**Feature**: `006-heroui-react-query-refactor` | **Date**: 2026-10-27
**约束来源**: spec FR-001–004/030–033、宪法 v1.3.0 技术约束 5

## HeroUI v3 使用契约

依据本地核验记录 `apps/web/src/shared/theme/HEROUI-NOTES.md`（@heroui/react@3.2.6，
node_modules `.d.ts` 逐项核验）与主题现状（`tokens.css`：固定暗色 `html.dark`）：

1. **v3 复合组件结构**：一律 `X` / `X.Root` + 命名空间子组件
   （如 `Select.Root/Trigger/Value/Indicator/Popover`）；**禁止**扁平 props 写法
   与 v2 记忆（无 Provider 需求、无 framer-motion）。
2. **事件**：可交互组件用 `onPress`（React Aria 语义），不用 `onClick`。
3. **变体**：语义化变体（primary/secondary/tertiary/danger/ghost/outline），
   **禁止**裸色值绕过主题；主题变量经 `tokens.css`（oklch）定制。
4. **固定暗色**：不引入主题切换；`tokens.css` 已对齐 `@heroui/styles`
   default 主题 `.dark` 变量块。
5. **样式边界**：页面样式经主题令牌/Tailwind 工具类；**禁止**为绕开组件库
   手写控件样式（FR-004）。

## 原生控件替换映射（全站扫描 = 0 的依据）

| 现存位置 | 原生用法 | 替换为 | 等价性要求 |
| --- | --- | --- | --- |
| settings-epg-page.tsx:280 | `<select>` | `Select` | 选项/当前值/onChange 语义等价 |
| settings-policy-page.tsx:139,167 | `<select>` ×2 | `Select` | 同上 |
| settings-profiles-page.tsx:520 | `window.alert` | `AlertDialog`（确认语义）+ `Toast`（结果反馈） | 文案不变、阻断式确认保留 |
| settings-sources-page.tsx:478 | `<select>` | `Select` | 同上 |
| GuidePage.tsx:263,286 | `<select>` ×2 | `Select` | 日期/频道筛选行为不变 |

通用补充：加载态用 `Skeleton`/`Spinner`/`Progress*`；错误态用 `Alert`+重试封装
（重写 `shared/ui/retryable-alert.tsx` 为 HeroUI 基座）；空态 `EmptyState`；
轻反馈 `Toast`。三态组件统一收敛到 `shared/ui/`，全站复用（FR-011）。

**无障碍基线**（Q4 澄清）：键盘导航、焦点管理、读屏标签不劣于调整前，
随组件库默认能力获得；全站 WCAG AA 专项审计不在本次范围。

## 共享 Hooks 契约

- 唯一入口目录：`apps/web/src/shared/hooks/`；页面**禁止**自带通用逻辑实现。
- `source` 分两类并标注：开源库 re-export（优先）／自研（必须附
  "为何不采用现成库"理由 + vitest 单测）（FR-030/031/033）。
- 首批清单（按需启用，允许增补）：`useDebounce`、`useThrottle`、
  `useInterval`、`useMediaQuery`（收编 `features/settings/use-media-query.ts`）、
  `useElementSize`、`useEventListener`、`useLocalStorage`、`useDocumentVisibility`。
- 直播 30s 轮询、EPG 窗口计算：业务语义保留，实现改经共享 hooks/数据层
  （`features/live/hooks/use-live-refresh.ts` 的 interval 语义收编）。
- 具体开源库选型见 research.md 决策 D1；选型结论必须回填本契约的清单来源列。

## 迁移工程约束

- 渐进迁移：每次合入保持 `pnpm typecheck / lint / test / test:e2e` 绿
  （FR-040/042）；替换原生控件后同步修正测试选择器，禁止依赖脆弱实现细节断言（FR-041）。
- E2E 断言以用户可见角色/文本为主；为稳定定位补充 `data-testid` 时集中登记。
- 构建体积：首屏关键路径传输体积较基线增幅 ≤ 15%（SC-009）；组件按需引入，
  生产排除 devtools。基线与测量方法见 quickstart.md。
