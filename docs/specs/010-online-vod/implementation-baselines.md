# 010 Online VOD 实现基线（Implementation Baselines）

- 任务来源: `docs/specs/010-online-vod/tasks.md` T004
- 记录日期: 2026-10-30
- 性质: 文档 + 设计 token 基线，不改业务代码。后续证据任务（T035/T066 等）引用本文档作为
  明暗主题 / 键盘可达性 / 响应式验证的核对基线。
- 版本号纪律: 本文所有版本号均附文件证据；找不到证据的项如实写"未找到"，不编造。

---

## 1. Skill 规则来源与版本

### 1.1 仓库内位置核查结果（如实记录）

| 检查位置 | 结果 |
| --- | --- |
| 仓库内 `.agents/skills/` | 仅含 speckit-* 技能（specify/clarify/constitution/checklist/plan/tasks/analyze/implement/converge/taskstoissues），**无** nestjs-best-practices、**无** heroui-react |
| 仓库内 `.claude/skills/` | 同上，仅 speckit-* 技能 |

结论: 两个 skill 不在仓库内，实际位于用户级目录（macOS 本机）。
本节以下路径与版本声明均以实际文件为准。

### 1.2 nestjs-best-practices —— 固定 1.2.0

| 项 | 值 |
| --- | --- |
| 实际路径（canonical） | `/Users/charles/.agents/skills/nestjs-best-practices/` |
| 符号链接 | `/Users/charles/.claude/skills/nestjs-best-practices` → `../../.agents/skills/nestjs-best-practices`（2026-10-30 实测 `ls -la`） |
| 版本声明文件 | `SKILL.md` frontmatter `metadata.version: "1.2.0"`（文件第 5–8 行，第 7 行为版本行）；作者 `Kadajett`（第 6 行） |
| 规则体量 | `SKILL.md` 第 12 行声明 "40 rules across 10 categories"；实测 `rules/` 目录 40 个规则文件（不含 `_sections.md`、`_template.md`），与声明一致 |
| 上游仓库 | `SKILL.md` 第 128–131 行引用 `https://github.com/Kadajett/agent-nestjs-skills`（AGENTS.md 全量编译文档） |

规则分类与优先级（`SKILL.md` 第 27–38 行表）: arch-/di- 为 CRITICAL，error-/security-/perf- 为 HIGH，
test-/db- 为 MEDIUM-HIGH，api-/micro- 为 MEDIUM，devops- 为 LOW-MEDIUM。

本功能（010，涉及 T006 后端上下文骨架、T029/T031 服务与控制器、T007 迁移测试）将重点引用的规则条目:

- `arch-feature-modules` / `arch-avoid-circular-deps` / `arch-module-sharing` —— online-vod 独立 context 模块装配（T006 明确要求不引入循环依赖）
- `di-use-interfaces-tokens` / `di-prefer-constructor-injection` —— T006 的 `online-vod.tokens.ts` 注入 token 模式
- `arch-use-repository-pattern` —— 端口/store 分层（与 007/008 重构一致）
- `db-use-transactions` / `db-use-migrations` —— 短事务工作集与 `0007_online_vod` 迁移（T002/T007）
- `error-use-exception-filters` / `error-throw-http-exceptions` —— 控制器错误形态（T031）
- `security-validate-all-input` / `security-rate-limiting` —— 来源配置/播放 intent 入参校验与限流（T031）
- `api-use-dto-serialization` / `api-use-pipes` —— 白名单输出与 DTO（T031）
- `test-use-testing-module` / `test-e2e-supertest` / `test-mock-external-services` —— T007/T008 测试形态

### 1.3 heroui-react —— 固定 3.0.1

| 项 | 值 |
| --- | --- |
| 实际路径（canonical，本会话可用） | `/Users/charles/.agents/skills/heroui-react/`（`SKILL.md` + `scripts/*.mjs` + `LICENSE.txt`） |
| 另一副本 | `/Users/charles/.cc-switch/skills/heroui-react/`；`/Users/charles/.claude/skills/heroui-react` 符号链接指向该副本。两份 `SKILL.md` 正文有少量差异（2026-10-30 `diff` 实测），但 frontmatter **同为** `metadata.version: "3.0.1"`、`author: heroui` |
| 版本声明文件 | `SKILL.md` frontmatter `metadata.version: "3.0.1"`（canonical 副本第 4–7 行，第 6 行为版本行） |
| 文档抓取脚本 | `scripts/get_component_docs.mjs`、`get_theme.mjs`、`get_styles.mjs`、`get_docs.mjs`、`get_source.mjs`、`list_components.mjs`（API 基址 `https://mcp-api.heroui.com`，回退 `https://heroui.com`） |

关键规则条目（`SKILL.md` 全文要点，实现期强制）:

- **v3 专属，忽略 v2 知识**: 无 `HeroUIProvider`、无 framer-motion（CSS 动画）、compound components
  （`<Card><Card.Header>`）、Tailwind CSS v4 + `@heroui/styles`（包为 `@heroui/react` + `@heroui/styles`，弃用 `@heroui/system`/`@heroui/theme`）。
- **事件用 `onPress` 而非 `onClick`**（React Aria 可访问性语义）。
- **语义变体**: `primary`（每上下文至多一个主行动）/ `secondary` / `tertiary` / `danger` / `ghost` / `outline`；
  "Don't use raw colors"——禁止裸色值，语义变体随主题与可访问性自适应。
- **主题**: CSS 变量 + oklch；无后缀变量为背景色（如 `--accent`），`-foreground` 后缀为该背景上的文字色；
  明暗切换 `<html class="dark" data-theme="dark">`。
- **实现前必须抓取 v3 官方文档**（"Always fetch v3 docs before implementing"）——本文 §3 即为该要求的执行记录。

---

## 2. 运行时安装版本核对（skill 规则版本 ≠ 运行时安装版本，两行分列，不得混淆）

| 维度 | 版本 | 文件证据 |
| --- | --- | --- |
| **skill 规则版本** | heroui-react skill **3.0.1** | `/Users/charles/.agents/skills/heroui-react/SKILL.md` frontmatter（两份副本一致） |
| **运行时安装版本** | `@heroui/react` **3.2.6**、`@heroui/styles` **3.2.6** | 见下列三重证据 |

安装版本三重证据:

1. `apps/web/package.json` 第 16–17 行: `"@heroui/react": "3.2.6"`、`"@heroui/styles": "3.2.6"`（精确 pin，无 `^`）。
2. `pnpm-lock.yaml` 第 100–107 行（importer `apps/web`）: 两包 specifier 与解析 version 均为 `3.2.6`；
   第 555、567 行 snapshots 同为 `@heroui/react@3.2.6`、`@heroui/styles@3.2.6`。
3. 实际安装产物: `node_modules/.pnpm/@heroui+react@3.2.6_*/node_modules/@heroui/react/package.json` 与
   `node_modules/.pnpm/@heroui+styles@3.2.6_tailwindcss@4.3.3/.../package.json` 实测 `"version": "3.2.6"`。

其他运行时事实:

- Tailwind CSS: lock 中 `tailwindcss@4.3.3`（heroui v3 强制 Tailwind ≥4，两包 peerDependency `tailwindcss: '>=4.0.0'`，见 lock 第 565、570 行）。
- React 19.3.1 / react-aria 3.53.1 / react-aria-components 1.22.1（lock 第 104 行 peer 解析串）。

**偏差说明（如实记录）**:

- skill 规则版本（3.0.1）与安装版本（3.2.6）不一致。处理约定: skill 规则作为**编码纪律**固定引用；
  组件 API/主题行为以**安装的 3.2.6 及其随包主题 CSS**（`apps/web/node_modules/@heroui/styles/dist/themes/default/variables.css`）为运行时真源，与根 `DESIGN.md` 末行约定一致（"When this file and the current package disagree, follow the installed HeroUI version and its theme CSS"）。
- skill 文档脚本 `get_theme.mjs` 输出头标注 `Version: v3.2.7`（联机主题变量源略新于本地安装 3.2.6）。
  该差异仅影响联机参考值；本地随包 CSS 才是运行时依据。已核对两份主题变量的关键语义值一致
  （如 `--radius: 0.5rem`、`--disabled-opacity: 0.5`、`--ring-offset-width: 2px`、暗色 `--background: oklch(12% 0.005 285.823)`）。

---

## 3. HeroUI v3 官方文档获取记录（访问日期均为 2026-10-30）

### 3.1 获取方式说明（网络限制如实记录）

`web_fetch` 直连 `heroui.com` 被当前会话网络策略拒绝（"resolves to a non-public IP address"）。
改经 heroui-react skill 自带脚本（`get_component_docs.mjs` / `get_docs.mjs` / `get_theme.mjs`，
API 基址 `https://mcp-api.heroui.com`）抓取，返回内容为官方 MDX：每页头部自带官方页面 URL 与
GitHub v3 分支源文件路径（`https://raw.githubusercontent.com/heroui-inc/heroui/refs/heads/v3/apps/docs/content/docs/en/react/...`），
据此确认内容官方性。原始抓取存于 `/tmp/heroui-docs-20261030/`（会话临时区，未入库）。

### 3.2 文档 URL 清单

| 文档 | URL（官方页面） | 对应 GitHub v3 源（页面头部声明） |
| --- | --- | --- |
| Button | https://heroui.com/en/docs/react/components/button | `.../(buttons)/button.mdx` |
| Modal | https://heroui.com/en/docs/react/components/modal | `.../(overlays)/modal.mdx` |
| TextField（v3 输入类入口，`Input` 为其子组件） | https://heroui.com/en/docs/react/components/text-field | `.../(forms)/text-field.mdx` |
| Table | https://heroui.com/en/docs/react/components/table | `.../(data-display)/table.mdx` |
| Tabs | https://heroui.com/en/docs/react/components/tabs | `.../(navigation)/tabs.mdx` |
| Theming 指南 | https://heroui.com/en/docs/react/getting-started/theming | `.../getting-started/(handbook)/theming.mdx` |
| 主题变量全集（skill `get_theme.mjs` 输出；真源为随包 CSS） | https://github.com/heroui-inc/heroui/blob/v3/packages/styles/themes/default/variables.css | 本地随包: `apps/web/node_modules/@heroui/styles/dist/themes/default/variables.css` |

### 3.3 要点摘录（后续实现的规则依据）

**语义 token 用法**（Theming 指南 + 主题变量）:

- 颜色变量无后缀 = 背景色（`--accent`、`--surface`），`-foreground` 后缀 = 该背景上的文字色
  （`--accent-foreground`）；hover/soft/secondary 派生由 `color-mix()` 在主题内完成，业务代码只用语义工具类
  （`bg-surface-secondary`、`text-muted`、`border-border` 等），不裸写色值。
- 页面根应用语义画布色: `<body class="bg-background text-foreground">`。
- 主题无关的全局量定义在 `:root`: `--spacing: 0.25rem`、`--radius: 0.5rem`、
  `--field-radius: calc(var(--radius) * 1.5)`（=12px）、`--disabled-opacity: 0.5`、`--ring-offset-width: 2px`。

**明暗主题切换**（Theming 指南 + 随包 CSS 选择器实证）:

- 切换写法: `<html class="light" data-theme="light">` ↔ `<html class="dark" data-theme="dark">`；
  程序化切换可用 next-themes（`attribute="class"`）。
- 随包 CSS 选择器实证: `variables.css` 第 57–62 行 `[data-theme="light"]`/`[data-theme="default"]`（+:host 形式）、
  第 193–195 行 `[data-theme="dark"]`；`class` 与 `data-theme` 双写以同时命中两种选择器。
- 暗色主题行为: 表面/字段阴影移除（`--surface-shadow`、`--field-shadow` 置为透明 inset），
  overlay 获得细微 inset 描边（`--overlay-shadow: 0 0 1px 0 rgba(255,255,255,0.3) inset`）。

**焦点/键盘行为**（各组件文档 + 主题变量）:

- 焦点态约定: `:focus-visible` 或 `[data-focus-visible="true"]`（Tabs 文档状态节明示）；焦点色 `--focus: var(--accent)`，
  焦点环 offset `--ring-offset-width: 2px`；禁用态 `[aria-disabled="true"]`、不透明度 `--disabled-opacity: 0.5`、
  禁用光标 not-allowed（主题变量 `--cursor-disabled`）。
- Button: 变体 `primary`（默认）/`secondary`/`tertiary`/`outline`/`ghost`/`danger`/`danger-soft`；尺寸 `sm`/`md`/`lg`；
  事件用 `onPress`（React Aria）。
- Modal: 结构 `Modal.Backdrop > Modal.Container > Modal.Dialog`（+`Header/Body/Footer`、`CloseTrigger`）；
  实现 WAI-ARIA Dialog 模式——**焦点圈闭（focus trap）、`ESC` 关闭（可启用时）、`Tab` 循环、滚动锁定、ARIA 属性**；
  尺寸行为: 移动端所有尺寸近乎全宽，`cover` 尺寸全屏留边（移动 16px / 桌面 40px），`full` 完全全屏（无边距/圆角/阴影）。
- TextField: 组合式 `TextField > Label + Input (+Description + FieldError)`，RAC 自动关联 aria。
- Table: 行列结构化数据，支持排序、选择、列宽调整、无限滚动。
- Tabs: 结构 `Tabs > ListContainer > List > Tab（内含可选 Separator、Indicator）+ Panel`；
  变体 `primary`（填充指示条）/`secondary`（下划线）；`orientation: horizontal|vertical`；受控 `selectedKey`/`onSelectionChange`。

---

## 4. 明暗主题 / 键盘可达性 / 响应式验证基线

后续证据任务（T035 us1-browse、T066 us3-autoplay、e2e 与截图证据）按下述基线核对；
基线本身源自本文 §1–§3 的文件与官方文档证据。

### 4.1 明暗主题核对基线

- 切换机制: `class` + `data-theme` 双写（§3.3 主题切换依据）。
- 项目现状（如实记录）: 当前 `apps/web/index.html` 固定 `<html class="dark">`，`tokens.css` 注明
  "主题切换不在本轮范围（005 T011）"。010 若按 spec 引入亮色模式，须在证据中补两主题核对；
  切换实现不得新增第二套颜色变量，只能依赖 HeroUI 语义变量在两主题下的解析差异。
- token 消费纪律: 组件层只允许 HeroUI 语义 token + 本仓库 `--hmp-*` 别名
  （`apps/web/src/shared/theme/tokens.css`）+ 根 `DESIGN.md` §"010 Online VOD 项目媒体尺度 token" 新增媒体 token；
  两主题核对 = 核对**同一 token 的解析值**，不是在组件里按主题分支或写裸值。
- 核对内容最低集: 画布/表面层级、accent 与状态色、边框/分隔、焦点环可见性、backdrop 遮罩、
  卡片阴影（暗色下主题自动移除 surface/field 阴影——这是预期行为，不是缺陷）。

### 4.2 键盘可达性基线

- 焦点可见: 全局基线 `apps/web/src/shared/theme/a11y.css` 的 `:focus-visible` outline
  （宽 `--hmp-focus-ring-width: 2px`、offset 2px、色 `var(--focus)` = 品牌 accent）；组件自带
  `data-focus-visible` 焦点环优先。任何交互元素不得移除焦点指示。
- 键盘交互: 全部可按 Tab 到达且顺序合理；Button 用 `onPress`；Modal 依赖组件内建
  focus trap / `ESC` / `Tab` 循环 / 滚动锁定（§3.3），不自建替代；Tabs/播放器控制条等复合组件用 HeroUI/React Aria 内建键盘行为。
- 非颜色提示与减动效: 错误/状态不仅靠颜色（`.hmp-sr-only` 辅助文本、`FieldError`、`role="alert"`）；
  `prefers-reduced-motion` 由 a11y.css 全局收敛；时间/进度数字用 `.hmp-tabular-nums`。
- 证据引用格式: 键盘走查记录须含"控件 → 按键 → 焦点可见证据（两主题各一次）"。

### 4.3 响应式断点策略

- 断点真源: Tailwind v4 默认（随包 `tailwindcss@4.3.3/theme.css` 第 327–331 行实证）:
  `sm 40rem / md 48rem / lg 64rem / xl 80rem / 2xl 96rem`；项目不自定义断点。
- 项目媒体断点 token（定义于根 `DESIGN.md` 新增节）: 播放器紧凑/展开布局切换
  `--hmp-media-player-breakpoint: 48rem`（对齐 Tailwind `md`）；海报网格最小列宽 `--hmp-media-poster-grid-min: 9rem`
  （`auto-fill` 网格用）；播放器容器下限 `--hmp-media-player-min-height: 13.5rem`。
- 官方组件自带响应行为直接复用: Modal 移动端近全宽、`cover` 全屏留边 16px（移动）/40px（桌面）（§3.3）。
- 验证最低集: 证据任务至少在 40rem、48rem、64rem 三个视口宽度核对布局与焦点可达，
  并记录在 `docs/specs/010-online-vod/evidence/` 对应文件。

---

## 5. 本次任务触碰文件声明（硬性约束核对）

- 新建: 本文件 `docs/specs/010-online-vod/implementation-baselines.md`。
- 修改: 根 `DESIGN.md`（仅追加一节，既有内容未改动；该文件在 git 中为未跟踪新文件，保持未跟踪状态）。
- 未执行任何 git commit/push/branch；工作区既有 dirty 改动（`.specify/memory/constitution.md`、
  `apps/web/src/**`、`pin-field.*` 等 2026-10-30 `git status` 所列 18 项）全部原样保留。
