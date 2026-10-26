# HeroUI v3 组件写法核验记录(HEROUI-NOTES)

- 任务来源:docs/specs/005-pc-browsing-flow/tasks.md **T005**;约束依据:docs/specs/005-pc-browsing-flow/delivery-constraints.md §2。
- 核验日期:**2026-10-26**。
- 核验对象:`apps/web` 实际安装的 `@heroui/react@3.2.6` + `@heroui/styles@3.2.6`(经 `pnpm list --depth 0 --filter @hmp/web` 与 `node_modules` 内 package.json 双重确认;配套 tailwindcss@4.3.3、@tailwindcss/vite@4.3.3、vite@7.3.7、react@19.3.1、tailwind-variants@3.3.1)。
- **文档可达性声明**:核验当日本环境对 heroui.com / github.com / raw.githubusercontent.com / cdn.jsdelivr.net / unpkg.com 等域名直连均失败(域名解析到非公网 IP),官方文档页面全文不可达;`web_search` 仅确认官方文档 URL 结构存在(如 heroui.com/docs/react/components/button.mdx、getting-started/quick-start.mdx、getting-started/dark-mode、getting-started/colors、migration,以及官方仓库 heroui-inc/heroui 的 apps/docs/content/docs/react/… 文档源与 v3 分支 skills/heroui-migration/SKILL.md),无法读取全文。**因此本记录以本地 node_modules 包内类型定义(.d.ts)、随包 README 与实际 CSS 为第一核验依据**(它们是官方 npm 发布产物),不编造文档结论。后续若网络恢复,应按 §7 补核。

---

## 1. 逐项核验结论

### ① v3 复合组件结构 — 成立(置信度:高)

v3 组件普遍为「`X` 可调用 + `X.Root` 及命名空间子组件」的复合结构,`X` 即 `X.Root` 的别名。

实测 3.2.6 各组件命名空间(`node_modules/@heroui/react/dist/components/<c>/index.d.ts`):

| 组件 | 命名空间成员 |
| --- | --- |
| `Modal` | `Root`、`Trigger`、`Backdrop`、`Container`、`Dialog`、`Header`、`Icon`、`Heading`、`Body`、`Footer`、`CloseTrigger` |
| `Select` | `Root`(`T extends object`、`mode: "single" \| "multiple"`)、`Trigger`、`Value`、`Indicator`、`ClearButton`、`Popover` |
| `Tabs` | `Root`、`List`、`ListContainer`、`Tab`、`Indicator`、`Panel`、`Separator` |
| `Alert` | `Root`、`Title`、`Description`、`Indicator`、`Content` |
| `Menu` | `Root`、`Item`、`ItemIndicator`、`Section` |
| `Table` | `Root`、`Column`、`ColumnResizer`、`Row`、`Cell`、`Header`、`Body`、`Footer`、`SortableColumnHeader`、`ScrollContainer`、`Collection`、`LoadMore`、`LoadMoreContent`、`ResizableContainer` |
| `Tooltip` | `Root`、`Trigger`、`Content`、`Arrow` |
| `Checkbox` / `Switch` | `Root`、`Control`、`Indicator`、`Content`(+ Switch 另有 `Thumb`、`Icon`) |
| `ListBox` | `Root`、`Item`、`ItemIndicator`、`Section`(另有顶层 `ListBoxItem`) |
| `TextField` | **仅 `Root`**;`Label`、`Input`、`FieldError` 是**顶层独立组件**(见 §3 坑 2) |
| `Form` | **仅 `Root`**(薄包装,继承 react-aria-components `Form` props) |
| `Spinner` | 仅 `Root`(实为单组件 + Root 别名,非复合) |

- 来源:`apps/web/node_modules/@heroui/react/dist/components/*/index.d.ts`(_modal、select、tabs、alert、menu、table、tooltip、checkbox、switch、list-box、textfield、form、spinner_);随包 `apps/web/node_modules/@heroui/react/README.md`("ships a clean compound component API (`Card.Header`, `Card.Content`, `Select.Item`, …)")。
- **差异标注(文档/README vs 实际包)**:README 提到 `Select.Item`,但 3.2.6 的 `Select` 命名空间**不存在 `Item` 成员**;选项须用 `ListBox`(含 `ListBox.Item`)或顶层 `ListBoxItem` 在 `Select.Popover` 内组合。以本地类型为准:**不要写 `<Select.Item>`**。

### ② 交互组件用 `onPress`,不用 `onClick` — 成立(置信度:高)

- `Button` 的 props 继承自 react-aria-components 的 Button:`interface ButtonRootProps extends ComponentPropsWithRef<typeof ButtonPrimitive>, ButtonVariants`,其中 `ButtonPrimitive` 来自 `"react-aria-components/Button"`(`apps/web/node_modules/@heroui/react/dist/components/button/button.d.ts`)。
- RAC(实测版本 1.22.1)`ButtonProps` 显式 **Omit 掉 DOM 的 `onClick`**:`Omit<GlobalDOMAttributes<HTMLButtonElement>, 'onClick'>`,同时经 `AriaButtonProps` 获得 `PressEvents`(`node_modules/.pnpm/react-aria-components@1.22.1_*/node_modules/react-aria-components/dist/types/src/Button.d.ts`)。
- `PressEvents` 定义(`node_modules/.pnpm/@react-types+shared@3.36.1_react@19.3.1/node_modules/@react-types/shared/src/events.d.ts`):`onPress / onPressStart / onPressEnd / onPressChange / onPressUp`,且对 `onClick` 的官方注释为 "**Not recommended – use `onPress` instead.** `onClick` is an alias for `onPress` provided for compatibility with other libraries."
- 同样模式覆盖其他交互件:RAC `TabProps` 亦为 `PressEvents` + `Omit<GlobalDOMAttributes<HTMLDivElement>, 'onClick'>`。
- 事件对象类型是 `PressEvent`(非 React 的 `MouseEvent`),可从 `@heroui/react` 主入口导入(见 §3 坑 3)。

### ③ 无 `HeroUIProvider` — 成立(置信度:高)

- 在 `@heroui/react@3.2.6` 整个 `dist/` 中 grep `HeroUIProvider` **零命中**(无此导出)。
- 随包 `apps/web/node_modules/@heroui/react/README.md`:"requires no `<Provider>` wrapper (unlike Chakra, MUI)"。
- 结论:v2 的 `<HeroUIProvider>` 包裹属于废弃概念,v3 无需任何 Provider;也不要寻找替代的 provider 组件。

### ④ Tailwind CSS v4 样式先于 `@heroui/styles` 导入 — 成立,附包内结构事实(置信度:高/中)

- `@heroui/styles@3.2.6` 的 CSS 主入口 `dist/index.css` 的实际结构(逐行核对):
  ```css
  @layer theme, base, components, utilities;
  @import "tailwindcss";
  @import "tw-animate-css";
  @import "./base/base.css" layer(base);
  @import "./base/scrollbar.css" layer(base);
  @import "./components/index.css" layer(components);
  @import "./themes/default/index.css" layer(theme);
  @import "./utilities/index.css";
  @import "./variants/index.css";
  ```
  即 **`@import "@heroui/styles"` 自身已包含 `@import "tailwindcss"`、组件样式、默认主题、utilities、variants 与 tw-animate-css**,一站式入口。
- 随包 `apps/web/node_modules/@heroui/styles/README.md` 的按需导入示例将 `@import "tailwindcss";` 置于最前,再导入 `@heroui/styles/utilities` → `/variants` → `/themes/default`(layer(theme))→ 各 `components/*.css`(layer(components)),并注明"component CSS 依赖 utilities/variants 前置,不是自包含"。
- **本仓库约定**:应用级 CSS(如 `apps/web/src` 下的全局样式)保持 `@import "tailwindcss";` 在最前、`@import "@heroui/styles";` 紧随其后。
- 置信度说明:导入顺序要求本身为高置信(README + 包内 CSS 结构);但"应用里 `@import "tailwindcss"` 与 `@heroui/styles` 内嵌的 `@import "tailwindcss"` 重复导入时 Tailwind v4/@tailwindcss/vite 的去重行为"未运行验证(中置信),由 T006+ 样式骨架冒烟确认(见 §3 坑 6)。

### ⑤ oklch 语义 token 与 CSS 变量命名 — 成立(置信度:高)

- 全部主题色以 `oklch()` 定义:`apps/web/node_modules/@heroui/styles/dist/themes/default/variables.css`(例:`--accent: oklch(0.6204 0.195 253.83)`、`--background: oklch(0.9702 0 0)`、`--danger: oklch(0.6532 0.2328 25.74)`)。
- 命名约定(实测变量清单):**无后缀 = 背景色,`-foreground` 后缀 = 该背景上的文字色**。可用语义 token 包括:`--background/--foreground`、`--surface`(及 `--surface-secondary/--surface-tertiary` 与各自 `-foreground`)、`--accent/--accent-foreground`、`--success/--warning/--danger`(及各自 `-foreground`)、`--muted`、`--default`、`--border`、`--field-border`、`--overlay` 等;另有布局 token:`--spacing`、`--radius`、`--field-radius`、`--border-width`、`--field-border-width`、`--disabled-opacity`、`--ring-offset-width`、`--cursor-interactive` 等。
- 暗色模式(包内 CSS + README 实证):`:root` 默认 light(`[data-theme="light"]` / `[data-theme="default"]`);暗色用 **`<html class="dark">` 或 `<html data-theme="dark">`**,变量文件对两种选择器(含 `:host` 变体)都定义了暗色覆盖。本仓库默认暗色媒体界面,根元素需带 `dark` 类(后续骨架任务落实)。
- 主题入口另支持 `data-vibrant-palette="true"` 附加变量(variables.css 内实测),本轮不使用。
- 组件类名遵循 BEM 风格(styles README + `dist/components/button.css` 实测,如 `.button`、`.button--primary`、`.button--sm`、`.button--icon-only`);variants 由 `tailwind-variants` 导出(`buttonVariants` 等,随包 d.ts 实证)。

### ⑥ 常用组件清单(本仓库将用) — 全部存在(置信度:高)

`dist/components/` 共 84 个组件目录,任务点名组件全部在列并已核对命名空间(§1①):

`Button` ✅ `TextField` ✅ `Form` ✅ `Modal` ✅ `Select` ✅ `Tabs` ✅ `Tooltip` ✅ `Spinner` ✅ `Alert` ✅ `Menu` ✅ `Checkbox` ✅ `Switch` ✅ `Table` ✅

另有可用:`Card`、`Toast`、`Drawer`、`AlertDialog`、`Popover`、`Pagination`、`Skeleton`、`Autocomplete`、`ComboBox`、`SearchField`、`NumberField`、`DateField`/`DatePicker`、`Link`、`Chip`、`Badge`、`Avatar`、`Breadcrumbs`、`Separator`、`ProgressBar`、`Kbd`、`Disclosure`、`Toolbar`、`EmptyState` 等。表单配套顶层原语:`Label`、`Input`、`Textarea`、`FieldError`、`Fieldset`、`ErrorMessage`、`InputGroup`、`Description`。
- 来源:`apps/web/node_modules/@heroui/react/dist/components/` 目录清单 + `apps/web/node_modules/@heroui/react/package.json` 的 per-component `exports` 子路径(如 `./button`),支持按组件 tree-shaking 导入。

---

## 2. 本仓库前端组件任务的实现约定(必须遵守)

1. **事件一律 `onPress`**(交互组件:Button、MenuItem、Tab、Trigger、CloseTrigger 等);不写 `onClick`,类型层面 Button 已 Omit `onClick`,写了会编译报错。需要事件对象时用从 `@heroui/react` 导入的 `PressEvent` 类型。
2. **样式导入顺序**:全局 CSS 中 `@import "tailwindcss";` 必须在最前,`@import "@heroui/styles";` 紧随其后;不改动/不绕过 `@heroui/styles` 的 layer 结构(theme/base/components/utilities)。
3. **复合组件写法**:一律 `X.Root / X.Trigger / X.Body …` 或 `X` 直接当 Root 用;不发明不存在的子组件成员(写前按 §1 表核对或查 `node_modules/@heroui/react/dist/components/<c>/index.d.ts`)。
4. **颜色/焦点/间距只用语义 token**:`var(--accent)`、`var(--surface-secondary)`、`-foreground` 后缀规则、`--radius` 等;禁止在页面/组件里硬编码 hex/hsl/oklch 字面量颜色,禁止每页自建焦点环与禁用态规则(约束 §2"统一语义 token")。
5. **禁止事项(v2 经验不适用)**:
   - 不引入 `<HeroUIProvider>`(v3 无此导出);
   - 不安装或引用 `@heroui/theme`、`@heroui/system`(v2 包,v3 是 `@heroui/react` + `@heroui/styles`);
   - 不引入 `framer-motion` 做组件动画(v3 动画走 CSS/tw-animate-css);
   - 不使用 v2 的平铺 props 写法(如 `<Card title=…>`)或 v2 组件 API(`isOpen` 之外的 v2 专属用法、`classNames` slot 覆盖等)凭记忆套用;
   - 不直接依赖 `react-aria-components` / `react-aria`(未在 `apps/web/package.json` 声明,是 `@heroui/react` 的 peer 依赖;底层 API 经 `@heroui/react` 的 re-export 获取,见 §3 坑 3);
   - 不写 `<Select.Item>`(3.2.6 无此成员,用 `ListBox`/`ListBoxItem`)。
6. **变体使用语义值**:`Button` 的 `variant` 实际取值为 `primary | secondary | tertiary | danger | danger-soft | ghost | outline`,`size` 为 `sm | md | lg`,另有 `isIconOnly`、`fullWidth`(`@heroui/styles/dist/components/button/button.styles.d.ts` 实证);`TextField` 的 `variant` 为 `primary | secondary`。新页面按语义选 variant,不选颜色。
7. **暗色**:`apps/web` 保持暗色媒体界面,根元素带 `class="dark"`(或 `data-theme="dark"`);主题切换不在本轮范围。

---

## 3. 需要后续前端任务特别注意的坑

1. **`apps/web/package.json` 用 `"latest"` 而非固定版本**:当前锁文件定在 3.2.6;任何重新安装都可能漂移。后续任务实现前先 `pnpm list --filter @hmp/web` 复核实际版本,与本记录偏差大时重新核验。(本任务边界禁止改 package.json,是否 pin 由后续决策。)
2. **`TextField` 只有 `Root`**:`Label`/`Input`/`FieldError` 是顶层独立组件,靠 react-aria-components 的 `TextField` 上下文自动关联(id/描述/错误),不要找 `TextField.Label`、也不要手工传 id 关联;错误提示用 `FieldError`(配合 RAC `Form`/`TextField` 的 `validationBehavior`/`ValidationError`)。
3. **RAC 类型从 `@heroui/react` 主入口拿**:`PressEvent`、`Selection`、`Key`、`SortDescriptor`、`ValidationResult` 等经 `dist/components/index.d.ts` 第 85 行 `export * from "./rac"` 对外导出;`apps/web` 未声明 react-aria-components 依赖(pnpm 严格布局下直接 import 会失败)。
4. **`Select` 的选项写法**:README 示例的 `Select.Item` 与 3.2.6 实际导出不符;正确组合是 `Select.Root > Select.Trigger/Select.Value/Select.Indicator + Select.Popover > ListBox > ListBox.Item`(数据多时用 `items` prop + 渲染函数)。实现时以 `tsc` 结果为准。
5. **`Modal` 是 trigger/state 双模式**:`Modal.Root` props 继承 RAC `DialogTrigger`(支持 `isOpen/onOpenChange` 等),并额外接受 `state?: UseOverlayStateReturn`(配套导出 `useOverlayState` hook,`dist/hooks/use-overlay-state.d.ts`);弹层结构必须含 `Modal.Container > Modal.Dialog` 两层,Backdrop 的 `isDismissable` 默认 true。
6. **Tailwind 双入口待冒烟**:`@heroui/styles` 内嵌 `@import "tailwindcss"`,而 `apps/web` 同时启用 `@tailwindcss/vite@4.3.3`;两者组合的内容扫描/去重行为需在 T006 样式骨架中实际构建验证,若有问题优先调整为"按需导入"(README 的 utilities/variants/theme/components 顺序)。
7. **变体名与技能文档不完全同集**:除 `primary/secondary/tertiary/danger/ghost/outline` 外,3.2.6 还有 `danger-soft`;`size` 只有 `sm/md/lg`(无 xl)。
8. **`Spinner`/`Form`/`TextField` 不是复合结构**(仅 Root 别名),不要套用 `X.Y` 写法;`Tooltip`/`Alert`/`Menu` 的内容成员名各异(`Content` vs `Body`),以 §1 表为准。

---

## 4. 官方文档与本地包的差异清单

| 项 | 文档/README 说法 | 本地包实际(以包为准) |
| --- | --- | --- |
| `Select.Item` | react README 提及 | `Select` 命名空间无 `Item`;用 `ListBox`/`ListBoxItem` 组合 |
| 语义 variant 举例(技能文档) | primary/secondary/tertiary/danger/ghost/outline | 另有 `danger-soft`;`size` 无 lg 以上档位 |
| 安装文档(heroui-react 技能) | `npm i @heroui/styles @heroui/react tailwind-variants` | 本仓库由 package.json/锁文件管理,已含 tailwind-variants@3.3.1,不得另行安装 |

## 5. 官方文档可达性记录(2026-10-26)

- 直连失败域名(错误均为 "URL hostname … resolves to a non-public IP address"):`heroui.com`、`www.heroui.com`、`raw.githubusercontent.com`、`api.github.com`、`cdn.jsdelivr.net`、`unpkg.com`、`deepwiki.com`。
- `web_search` 可用,确认以下官方入口存在(未取得全文):[quick-start.mdx](https://heroui.com/docs/react/getting-started/quick-start.mdx)、[button.mdx](https://heroui.com/docs/react/components/button.mdx)、[Dark Mode](https://heroui.com/en/docs/react/getting-started/dark-mode)、[migration/index.mdx(GitHub 源)](https://github.com/heroui-inc/heroui/blob/88a86bd2618cbd58459f3418de9bc23ac7afd7b4/apps/docs/content/docs/react/migration/index.mdx)、[v3 分支 skills/heroui-migration/SKILL.md](https://github.com/heroui-inc/heroui/blob/v3/skills/heroui-migration/SKILL.md)。
- 结论:本记录的"官方文档"依据降级为 **官方 npm 发布产物内的 README 与类型定义**(等价官方材料,随 3.2.6 分发),符合任务第 6 步回退要求;未编造任何文档页结论。

## 6. 来源索引(node_modules 锚点,均相对 `apps/web/`)

- `node_modules/@heroui/react/package.json`、`node_modules/@heroui/styles/package.json` — 版本 3.2.6 与 exports 结构
- `node_modules/@heroui/react/dist/components/*/index.d.ts` — 各组件命名空间(§1① 表)
- `node_modules/@heroui/react/dist/components/button/button.d.ts`、`select/select.d.ts`、`textfield/textfield.d.ts`、`tabs/tabs.d.ts`、`modal/modal.d.ts` — props 继承关系
- `node_modules/@heroui/react/README.md` — 复合 API、无 Provider、React 19、Tailwind v4 声明
- `node_modules/@heroui/react/dist/components/index.d.ts:85` — `export * from "./rac"`(RAC 类型 re-export)
- `node_modules/@heroui/styles/dist/index.css` — 一站式入口与 layer 结构
- `node_modules/@heroui/styles/dist/themes/default/variables.css` — oklch 语义 token、明暗选择器
- `node_modules/@heroui/styles/README.md` — 导入顺序示例、BEM 类名、暗色开关、布局 token
- `node_modules/@heroui/styles/dist/components/button/button.styles.d.ts`、`dist/components/button.css` — variant/size 取值
- `node_modules/.pnpm/react-aria-components@1.22.1_*/dist/types/src/Button.d.ts`、`Tabs.d.ts` — `Omit<…, 'onClick'>` + `PressEvents`
- `node_modules/.pnpm/@react-types+shared@3.36.1_*/src/events.d.ts` — `onPress` 定义与 onClick "Not recommended" 注释

## 7. 补核待办(网络恢复时)

按 heroui-react 技能指引用 `node scripts/get_component_docs.mjs <组件>` 或直接抓取 `https://heroui.com/docs/react/components/<component>.mdx` 与 `getting-started/{theming,dark-mode,installation}.mdx`,重点复核:①官方示例中 Select 选项的推荐写法;②Modal 官方推荐受控/非受控模式;③应用级 CSS 的官方推荐导入组合(一站式 vs 按需);④RAC Tabs 的 Tab/Panel id 约定(RAC 集合惯例可能要求显式 `id`,本地类型未强制,低置信度,实现时以 `tsc` 为准)。
