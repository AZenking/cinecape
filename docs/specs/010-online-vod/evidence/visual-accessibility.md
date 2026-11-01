# 010 证据:视觉与可访问性(visual-accessibility)——T087

> 状态:**已执行(层1 Playwright 真实交互 6/6 通过;层2 静态核对完成;发现 3 枚真实缺陷 + 1 枚 DESIGN.md token 接线缺口,如实记录)**。
> 最后更新:2026-10-31T16:10+08:00(Asia/Shanghai)。基准依据:`implementation-baselines.md`(T004)、根 `DESIGN.md`、`tasks.md` T087/T035/T066 口径。
> 诚实纪律:本文所有 Verified 均对应 §8 命令与时间点的真实输出;Not-run 不计完成;不以静态截图替代交互证据。

## 0. 结论速览

| 项 | 层 | 状态 | 依据 |
| --- | --- | --- | --- |
| HeroUI v3 官方文档日期 / 固定 skill 版本 / 运行时版本核对 | 静态 | ✅ Verified(与 T004 基线一致,2026-10-31 独立复核) | §2 |
| 播放面挂载(DOM 状态断言)+ 非阻塞入口(导航/连播开关/换源/退出/设置 PIN 门) | 层1 | ✅ Verified | §3.2 |
| 换源抽屉:候选/置信徽标/测速延迟/超时/版本警告/conflict 禁用 | 层1 | ✅ Verified | §3.3 |
| 键盘可达:Tab 顺序、焦点环实测、HeroUI `data-focus-visible`、Esc 取消连播(零 intent) | 层1 | ✅ Verified(但焦点**可见性**缺陷 D-B) | §3.3/§3.4/§5 |
| 两主题 token 解析(dark 钉面原态 ↔ light 文档切换机制)+ `emulateMedia` 行为 | 层1 | ✅ Verified | §3.3/§3.4/§5 |
| 响应式三视口(40/48/64rem)无横向溢出、播放面宽度随缩 | 层1 | ✅ Verified | §3.3 |
| 连播倒计时面:结构(tabular-nums/aria-hidden)/finish→receipt→计划→倒计时链 | 层1 | ✅ Verified | §3.4 |
| 历史询问面:倒计时暂停、显式选择即 positionMode(恰一次 intent) | 层1 | ✅ Verified | §3.5 |
| 倒计时到期自动建意图(恰一次,载荷钉面) | 层1 | ✅ Verified | §3.6 |
| awaitingGesture 手势面(NotAllowedError)真实交互证据 | 层1 | ⏳ Not-run(环境无法构造前置,见 §3.7 诊断;组件级由 `test/vod-autoplay.spec.tsx` 钉面) | §3.7 |
| DESIGN.md `--hmp-media-*` token 接线核对 | 层2 | ❌ **缺口:全仓库 0 处定义**,12 处 `var()` 消费悬空 | §4.1/§5 |
| 010 媒体面裸值扫描 | 层2 | ⚠️ 部分裸值(bg-black/70、bg-black、white/10 等,含 009 既有面) | §4.2 |
| HeroUI 语义类 / role-aria 钉面清单 | 层2 | ✅ Verified | §4.3 |
| 屏幕阅读器真实播报 | — | ➖ Not-run(无真实 SR;role/aria 结构已钉,如实分列) | §6 |
| web vitest 回归 | 验证 | ✅ 265/265(执行前后各一轮,未改实现/测试) | §8 |

## 1. 执行环境与工作区状态

- 时间:2026-10-31 14:50–16:10(Asia/Shanghai);macOS(darwin,arm64),Node v24.19.0,pnpm 11.28.5。
- 浏览器:Playwright Chromium(headless shell,ms-playwright 缓存 chromium-1208/1248);A 组以 `--autoplay-policy=no-user-gesture-required` 顶层注入(T082 同口径),G1 探针用独立无豁免浏览器实例。
- 双服务基建:`scripts/e2e-servers.sh`(独立 DATA_DIR + 迁移 + Nest:3000 + vite:5173)+ `E2E_SEED_SCALE=1` 种子夹具(200 频道/500 点播),Playwright webServer 自动托管;登录/选档/目录读取走**真实本地服务与库**。
- 上游分层(T082 §6 VPN fake-IP DNS 限制的如实执行):本任务**不发起任何 SafeUpstream 上游抓取**——播放协议面(resolve/renew/progress/finish/next-plans/transition-intents/switch-candidates/switch-probes/materializations 等)用 Playwright `page.route` 受控 mock 承接(响应体按 `@hmp/shared` vod-schema DTO 形态构造),媒体本体为本机 ffmpeg 生成的真实 MP4(6s,h264+aac,Chromium 媒体管线真实消费)。因此本证据不受 SafeUpstream 503 影响;依赖真实上游的面不属于 T087 范围(T088)。
- 工作区:010 实现为未提交变更(与 T082 记录一致);本任务未改动任何实现/既有测试代码。

## 2. HeroUI v3 文档日期 / 固定 skill 版本 / 运行时版本

| 维度 | 值 | 证据 |
| --- | --- | --- |
| heroui-react skill 规则版本 | **3.0.1**(固定引用为编码纪律) | `~/.agents/skills/heroui-react/SKILL.md` frontmatter `metadata.version: "3.0.1"`;2026-10-31 本任务独立重读确认,与 T004 基线 §1.3 一致 |
| 运行时安装版本 | `@heroui/react` **3.2.6**、`@heroui/styles` **3.2.6**(精确 pin) | `apps/web/node_modules/.pnpm/@heroui+react@3.2.6_*/node_modules/@heroui/react/package.json` `"version": "3.2.6"`;2026-10-31 独立复核 |
| 官方文档 URL + 访问日期 | Button/Modal/TextField/Table/Tabs/Theming/主题变量全集,**访问日期均为 2026-10-30**(经 skill 脚本取官方 MDX,页面头带 GitHub v3 分支源路径) | T004 `implementation-baselines.md` §3.2 清单(本任务不重复抓取,引用之) |
| 主题选择器实证(本任务复核,2026-10-31) | `variables.css` L55–62 `:root,.light,.default,[data-theme="light"],…`;L192–195 `.dark,[data-theme="dark"],…`(class 与 data-theme 双写命中) | `@heroui/styles@3.2.6/dist/themes/default/variables.css`(运行时真源,基线 §2 约定) |
| 焦点环机制(与 §5 D-B 相关) | `components/button.css` L30–34 `:focus-visible:not([data-focused]), &[data-focus-visible="true"] { @apply status-focused }` → `utilities/index.css` `status-focused { @apply focus-ring }` → `focus-ring { @apply ring-2 ring-focus ring-offset-0 ring-offset-background outline-none }`;`themes/shared/theme.css` L28 `--color-focus: var(--focus)` | 同上安装包(2026-10-31 复核) |

skill 规则版本(3.0.1)≠ 运行时版本(3.2.6)的偏差处理沿用 T004 §2 约定:skill 为纪律,组件/主题行为以安装版随包 CSS 为运行时真源。

## 3. 层1:Playwright 真实交互证据(canonical 运行:run22,2026-10-31T16:00–16:02,6/6 passed)

辅助 spec 为本任务临时文件(已按任务约束删除,要点与断言面存档于 §8.2)。用例结构:A1–A5(自动播放豁免上下文,串行)+ G1(独立无豁免实例探针)。所有测试在**同一真实播放面**上进行:真实登录/选档 → `/live` 种子频道卡「播放」→ mock resolve/ renew → 真实 `<video>` 消费本机 MP4 → 进度泵真实 running。

### 3.1 「真实 playing」判定口径(如实声明)

进度泵保证 `started` 样本仅在媒体真实 playing 后发出(progress-controller started 门),故以 `startedSamples ≥ 1` 为协议级起播事实;辅以媒体元素 DOM 探针(videoTagCount/connected/paused/readyState)。canonical 运行实测:`videoTagCount=1, connected=[true], paused=false, readyState=4, src=/e2e-media/t087-clip.mp4?r=1`。

### 3.2 A1 播放面挂载与非阻塞入口(暗色钉面)✅

| 断言/实测 | 结果 |
| --- | --- |
| resolve 恰一次 → renew 恰一次(换票 URL `/e2e-media/t087-clip.mp4?r=1`) | ✅ |
| 播放面 `role="dialog"` + **`aria-modal="false"`**(009 非模态浮层语义) | ✅ |
| 播放面盒尺寸 @1280×720 | 1120×679.88(居中,`min(94vw,1120px)`) |
| 播放期间公共导航(首页/点播/直播)可见且 enabled | ✅ |
| 连播开关(播放面头部):`aria-label="自动连播开关"`、`aria-pressed` 双向 true→false→true、文案「连播:开/关」 | ✅ |
| 「换源」「退出播放」入口存在 | ✅ |
| 身份菜单 → 「设置」入口播放期间可打开 → 设置 PIN 门(受控 Modal)出现,**焦点落入弹层=true**;`Esc` 取消后播放面仍在 | ✅ |
| PIN 门打开期间播放面 `aria-hidden/inert` 实测 | `{ariaHidden:null, inert:false}`(未变;PIN 门为独立受控 Modal,未劫持播放面 DOM 属性——009 修正面保持) |
| 暗色画布(钉面原态)| body 计算背景 `oklch(0.12 0.005 285.823)`;根元素 `{class:"dark", dataTheme:null}`(index.html 原样) |

### 3.3 A2 换源抽屉:呈现/键盘/版本警告 + 双主题 + 响应式 ✅

**抽屉内容(mock 候选 3 行:high/ambiguous/conflict;测速 reachable 120ms / timeout / unavailable):**

- `vod-switch-candidates` 容器 + 3 行 `vod-switch-candidate`;候选恰一次拉取、默认 ≤3 候选恰一次测速(mock 计数实证)。
- `vod-switch-confidence` 文本 = 枚举值 `["high","ambiguous","conflict"]`(不只靠颜色);`vod-switch-latency` = `"120 ms"`(仅可达行,tabular-nums);timeout 行显示「超时」不可达态。
- 选中 ambiguous → `vod-switch-version-warning` 出现:`role="alert"`,文本「版本信息需确认:年份不一致(2023≠2024),确认后才能继续」,计算色 `oklch(0.8203 0.1388 76.34)`(暗色 `--warning` 解析值)。
- 选中 conflict → 「接当前播放位置」禁用(HeroUI v3 实际机制为**原生 `disabled` + `data-disabled="true"`**,非 aria-disabled——与基线 §3.3 引用的 `[aria-disabled]` 词面不同,如实记录)。

**键盘走查(触发钮 → 真实 Tab ×4):**

| 步 | 元素 | outline | data-focus-visible |
| --- | --- | --- | --- |
| 1–3 | 三行候选(原生 button,`focus-visible:outline-2`) | **`2px solid oklch(0.6 0.22 25)`**(暗色品牌 accent)✅ 可见 | null(非 RAC 组件,正常) |
| 4 | 「取消换源」(HeroUI Button) | outline `2px none`(不可见);box-shadow 全层透明 | **true** |

- `aria-pressed` 随选中态翻转(行级 `aria-pressed:border-separator` 选中可视化)。
- **焦点可见性缺陷(D-B,确定性复现 ×3 runs)**:HeroUI Button 键盘焦点时 `data-focus-visible="true"` 已设置,但计算样式 `outline-style: none` 且 box-shadow 全部图层透明(HeroUI `focus-ring` 的 ring-2/ring-focus 未产生可见 ring)——详见 §5 D-B。

**双主题核对(同一活页面,抽屉面板计算样式):**

| 量 | dark(钉面原态) | light(`class="light" data-theme="light"` 文档切换机制) |
| --- | --- | --- |
| 面板背景(`color-mix(--overlay 88%)`) | `oklab(0.2103 0.0016 / -0.0057 / 0.88)` | `oklab(1 0 0 / 0.88)`(白) |
| 文字(--foreground) | `oklch(0.9911 0 0)` | `oklch(0.2103 0.0059 285.89)` |
| 面板描边(--separator) | `oklch(0.25 0.006 286.033)` | `oklch(0.92 0.004 286.32)` |
| --accent / --focus | `oklch(0.6 0.22 25)`(仓库品牌红覆盖) | `oklch(0.6204 0.195 253.83)`(heroui 默认蓝;仓库仅在 `.dark` 覆盖 accent,tokens.css L35) |
| --backdrop | `rgba(0, 0, 0, 0.6)` | `rgba(0, 0, 0, 0.5)` |
| **--hmp-media-card-radius** | **空(未定义)** | **空(未定义)** |
| **面板 borderRadius** | **`0px`**(契约应为 `calc(var(--radius)*1.5)`=12px) | **`0px`** |
| **面板 boxShadow** | **`none`**(契约应为 `var(--overlay-shadow)`) | **`none`** |

- 同一 token 两主题解析差异符合 DESIGN.md 色表 ⇒ 组件未按主题分支、无第二套颜色变量 ✅;但 `--hmp-media-*` 系列在应用侧无定义,`var()` 无 fallback 回退初值(borderRadius 0px / boxShadow none)——**D-A(token 接线缺口),见 §4.1/§5**。
- `emulateMedia({colorScheme:'light'})` 探针:应用钉 class 主题,模拟后 `--background` 解析不变(`oklch(0.9702 0 0)` 为 light 值系因当时已切 light;`color-scheme` 计算值仍 `dark` 来自 tokens.css `:root{color-scheme:dark}`)——**`prefers-color-scheme` 不驱动本应用主题**,两主题核对须走根元素 class+data-theme 切换(baseline §4.1 机制),如实记录。

**响应式(40/48/64rem 视口,baselines §4.3 最低集):**

| 视口 | 横向溢出 | 播放面宽(min(94vw,1120px)) |
| --- | --- | --- |
| 640px(40rem) | 无(640/640) | 601.59px |
| 768px(48rem = `--hmp-media-player-breakpoint` 对齐值) | 无(768/768) | 721.91px |
| 1024px(64rem) | 无(1024/1024) | 962.55px |

抽屉(`w-80`,`max-h-[80%]`)在三角口均正常呈现,候选行焦点可达。

### 3.4 A3 连播倒计时面:结构 + Esc 取消(零意图)+ 双主题 + 键盘走查 ✅

- 全链(真实 6s MP4 自然播完):`ended` → 恰一次 `finish` → 回执 `autoNextEligible=true` → 偏好门(mock `autoplayNext:true`)→ `next-plans` → **倒计时面出现**(finish:1, started:1)。
- 面结构:`role="group"` + `aria-label="自动连播"`;文本含绑定目标「测试影片 第2集」;剩余秒行 `autoplay-countdown-seconds`:`aria-hidden="true"`(防读屏每秒重复)+ **tabular-nums** + 「5 秒后自动开始」;「立即播放下一集」(`aria-label`)、「取消连播」(`aria-label`)。
- **Esc = 取消连播**:面隐藏,轮询 1.2s 后 **transition-intents 恰 0 次**(终态零意图)✅。
- 双主题指标:面板背景暗 `oklab(0.2103…/0.82)` ↔ 亮 `oklab(1 0 0 / 0.82)`;`borderRadius 0px` / `boxShadow none` 两主题同现(D-A 同 §3.3)。
- 键盘走查(换源钮锚点 + 真实 Tab ×12):**第 1–2 步即倒计时两钮**(覆盖层位于播放面 DOM 尾部),`data-focus-visible="true"` 正确;但 outline/shadow 实测不可见(D-B,§5)。Tab 继续环绕回页面顶部(品牌链接/导航/身份菜单/搜索框/频道卡),顺序符合 DOM 序。

### 3.5 A4 历史询问面:倒计时暂停,显式选择即 positionMode ✅

- 计划 `historyChoiceRequired=true`(mock 历史 60s/100s)→ `autoplay-history-choice` 面(`aria-label="连播播放位置确认"`),文本含「上次看到 1 分钟(共 1 分钟)」;**无倒计时秒行、无 countdown 面**(倒计时暂停钉面)。
- 点击「从头播放」→ 面隐藏,**transition-intents 恰 1 次**,载荷钉面:`{action:"next", positionMode:"beginning", expectedSlotRevision:0, fromSessionId:<当前会话>, expectedGeneration:2, operationKey:<UUID>}` ✅。

### 3.6 A5 倒计时到期自动建意图 ✅

- 无交互等待:5s 倒计时到期 → 面隐藏,**transition-intents 恰 1 次**,`positionMode:"beginning"`、一次性 `operationKey`(UUID)✅(与 A4 的显式路径互为对照)。

### 3.7 G1 awaitingGesture 手势面:Not-run(环境无法构造前置;诊断留档)⏳

执行过的事实链(独立无豁免 Chromium 实例 + 页面零可信交互 + 非可信合成指针事件触发播放入口):

- CDP `Page.setAutoplayEnabled`/`Emulation.setAutoplayEnabled` 在本 Chromium 构建**不存在**(2026-10-31 探针),无法以协议强制关闭自动播放。
- **零用户激活 + 无豁免参数下,媒体仍然真实起播**(canonical run 实测 `startedSamples=1`,媒体元素 connected/readyState 4)——本 headless 环境的默认策略不拦截该场景的 play(),`NotAllowedError` 前置不可构造 → 手势面无法呈现。
- 结论:awaitingGesture 面的**真实浏览器交互证据 Not-run**;该面组件级行为(渲染/点击播放恢复/Esc 语义)由 `apps/web/test/vod-autoplay.spec.tsx`(L831/844/856)钉面。有头浏览器 + 系统自动播放策略受阻场景留待复跑(需非 headless 环境)。

## 4. 层2:静态核对

### 4.1 DESIGN.md `--hmp-media-*` token 接线核对 ❌ 缺口

```
grep -rn -- "--hmp-media-[a-z-]*:" apps/web packages --include="*.css" --include="*.tsx" --include="*.ts" --include="*.html" | grep -v node_modules
→ 0 处(DESIGN.md 本身除外)
```

- DESIGN.md §「010 Online VOD 项目媒体尺度 token」声明 11 枚 token,但 `apps/web`(tokens.css/index.html/组件)**零定义**;组件以 `var(--hmp-media-*)` 消费 **12 处、6 枚**:`card-radius`(×4:autoplay-overlay/switcher/online-search-section×1/OnlineVodDetailPage)、`overlay-shadow`(×2)、`ratio-poster`(×2)、`poster-placeholder`(×2)、`card-shadow`(×1)、`poster-grid-min`(×1)。CSS 自定义属性未定义且无 fallback ⇒ 计算值回退初值:`border-radius→0px`、`box-shadow→none`、`aspect-ratio→auto`、占位背景→透明、grid `minmax(→0,1fr)`(层1 已实测 borderRadius/boxShadow 两主题回退值)。
- 其余 5 枚(`ratio-video`/`player-min-height`/`player-breakpoint`/`letterbox`/`scrim`)当前无消费:播放器 16:9 由 Tailwind `aspect-video` 承担、letterbox/scrim 以裸值承担(§4.2)。
- 修复归属:非 T087(证据任务不改实现);建议接线点 `apps/web/src/shared/theme/tokens.css`(DESIGN.md 同值定义),交协调方排期。

### 4.2 裸值扫描(零裸值纪律核对)⚠️

- 010 T049 播放面状态提示条 6 处 `bg-black/70 … text-white`(`player-view.tsx` L517–545,resume-applied/failed/degraded、progress-unsavable/sync-failed/notice):遮罩语义本应是 `--hmp-media-scrim`/`--backdrop` + `text-foreground`。
- 009 既有播放面浮层(`action-coordinator.tsx` L876/878/888/911/912):`bg-black`、`border-white/10`、`text-white/80`、`shadow-2xl/shadow-lg`(非 010 引入,如实分列)。
- `video-player.tsx` L185 `bg-black`(引擎容器底色)与 `video-player-skin.css` L113 `box-shadow: 0 8px 24px rgb(0 0 0 / 0.4)`(vjs 菜单阴影;皮肤其余全部 token 派生)。
- 对照组 ✅:`vod-autoplay-overlay.tsx` / `vod-source-switcher.tsx` 面板样式全部 token 派生(`--overlay`/`--foreground`/`--separator`/`--hmp-media-*`),无裸色值;目录面卡片/占位全部走 `--hmp-media-*` + 语义变量(但因 D-A 缺口实际回退)。

### 4.3 HeroUI 语义类 / role-aria 钉面清单(010 媒体面)

- 语义工具类(出现次数):`text-foreground`×18、`text-muted`×11、`text-danger`×5、`focus-visible:ring-2`/`ring-focus`×3、`text-warning`×2、`text-success`×2、`text-accent`×2、`border-border`×2、`bg-surface`×2、`hover:border-separator`×1、`aria-pressed:border-separator`×1、`focus-visible:outline-2/offset-1`×1、`border-accent`×1 —— 语义变体随主题解析,无主题分支代码 ✅。
- role/aria:`role="status"`×10、`role="alert"`×9、`role="group"`×3(自动连播/换源/连播位置确认,均带 aria-label)、`role="dialog"`×2(播放面 aria-modal=false + 受控 Modal)、`aria-pressed`×2(连播开关/候选行)、`aria-hidden`×1(倒计时秒数)、`aria-label` 钉面(立即播放下一集/取消连播/换源/取消换源/退出播放/自动连播开关/播放器)。
- 非颜色提示 ✅:置信徽标/测速状态/版本警告均为「文字 + 语义色」双通道;`prefers-reduced-motion` 全局基线(a11y.css)+ PIN 抖动豁免收敛;`tabular-nums` 用于倒计时秒与测速延迟。

### 4.4 两主题变量引用链

`index.html <html class="dark">`(钉面;无运行时切换,005 T011 范围外)→ `@heroui/styles` `themes/default/variables.css` `.dark/[data-theme="dark"]`(L192–195)定义全部语义变量 → `apps/web/src/shared/theme/tokens.css` `.dark` 覆盖品牌 accent(`oklch(0.6 0.22 25)`)+ `--focus: var(--accent)` + `--hmp-focus-ring-*` → `a11y.css` `:focus-visible` outline 基线(基线层,实际被 utilities 层 `focus:outline-none` 压制,见 D-B)→ 组件仅消费语义 token。light 侧仅 heroui 默认变量(无仓库覆盖),层1 实测两主题解析值见 §3.3 表(与 DESIGN.md 色表一致)。

## 5. 缺陷与偏差清单(移交协调方;T087 不改实现)

| 编号 | 级别 | 事实(实测) | 复现 |
| --- | --- | --- | --- |
| **D-A(token 接线缺口)** | 高(视觉契约) | `--hmp-media-*` 11 枚 token 全仓库 0 定义,12 处消费悬空;实测海报/面板 `border-radius:0px`、`box-shadow:none`,比例/占位/网格同样回退 | 层1 计算样式 + §4.1 grep,100% 复现 |
| **D-B(焦点指示不可见)** | 高(可访问性;违反 baselines §4.2/DESIGN.md「Every interactive element needs a visible focus indicator」) | 键盘焦点落在 **HeroUI Button**(立即播放下一集/取消连播/取消换源/主档案触发钮/频道卡播放钮)与 **PublicLayout 原生链接**(首页/点播/直播/进入节目单)上:`data-focus-visible="true"` 已设置,但 `outline-style:none` + box-shadow 全层透明 ⇒ **无可见焦点指示**;HeroUI `focus-ring`(ring-2 ring-focus outline-none)在本应用构建中未产生可见 ring(`--color-focus → var(--focus)` 映射链存在于安装包,构建产物未生效,根因需构建链定位);a11y.css 基线 outline 被 utilities 层 `focus:outline-none` 压制。**对照组**:换源候选原生按钮(`focus-visible:outline-2`)实测 `2px solid oklch(0.6 0.22 25)` 可见 | run20/21/22 三轮一致 |
| **D-C(媒体元素脱离文档,间歇)** | 中(dev StrictMode;T082 §5.2 修复不彻底) | run3–6 时点实测 `videoTagCount=0`(播放面仍在、链路照常:媒体脱离文档仍起播/ended/finish);伴随 `VIDEOJS WARN: The element supplied is not included in the DOM`。run19–22 未复现(connected=true)——间歇性,疑 StrictMode 重挂载时容器被替换后旧 host 兜底失效 | run3–6 时点 30s 持续复现;后 4 轮未复现 |
| **D-D(React removeChild 崩溃,间歇)** | 中(dev;与 D-C 同区域) | run6 G1 时点:`NotFoundError: Failed to execute 'removeChild' on 'Node'` → React 错误边界告警 → 播放面卸载 + `POST /stop`;与 video.js dispose/re-append 和 React DOM 归属竞争一致 | run6 一次;后 4 轮未复现 |

## 6. 屏幕阅读器提示(诚实标注)

- **已钉结构(静态+DOM 断言实证)**:三面均有 `role`+`aria-label`(`role="group"` 自动连播/换源/连播位置确认);倒计时秒数 `aria-hidden="true"`(防每秒播报,数值变化由面级文本承载);失败/警告 `role="alert"`、进度/状态 `role="status"`;播放面 `role="dialog" aria-modal="false"`;开关类 `aria-pressed`;禁用为原生 `disabled`(+`data-disabled`);文字与语义色双通道,不单靠颜色。
- **未执行**:真实屏幕阅读器(VoiceOver/NVDA)播报验证——本环境无真实 SR;**「提示结构已钉,真实 SR 播报未执行」**,不作为 Verified 计入。倒计时每秒数值对 SR 的实际播报表现(aria-hidden 是否足够)留待真实 SR 走查。

## 7. 依赖与范围声明(分层如实)

- 本任务**不含**受控上游真实链路(SafeUpstream 面,VPN fake-IP DNS 下 503,见 T082 §6):播放协议面以 page.route 受控 mock 承接,媒体本体为真实 MP4 经真实 Chromium 媒体管线消费;登录/选档/目录/设置 PIN 门为真实本地服务链路。该分层与任务书「视觉证据优先用不依赖上游抓取的面」一致。
- 不以静态截图替代交互证据:全部结论来自页面交互(点击/键盘/主题切换/视口变更)+ DOM/计算样式断言 + 网络请求计数,无截图比对项。
- awaitingGesture 手势面与真实 SR 播报两项 Not-run(§3.7/§6),不勾选完成语义。

## 8. 可复现命令与存档

### 8.1 层1(canonical:run22,2026-10-31T16:00–16:02,`6 passed (1.1m)`)

```sh
# 双服务由 Playwright webServer 托管(scripts/e2e-servers.sh:独立 DATA_DIR+迁移+种子+双端口)
cd apps/web && E2E_SEED_SCALE=1 pnpm exec playwright test test/e2e/t087-visual-a11y.evidence.spec.ts --project=chromium
# 结果(6/6):A1 播放面挂载与非阻塞入口 / A2 换源抽屉+键盘+双主题+响应式 / A3 倒计时+Esc+双主题+键盘走查
#            / A4 历史询问面 / A5 倒计时到期 / G1 手势面可达性探针 —— 全部 passed
```

临时 spec 已按任务约束删除(新文件仅 evidence 文档)。其结构存档:A 组顶层 `test.use({launchOptions:{args:['--autoplay-policy=no-user-gesture-required']}})`;`installMocks(page, planSpec)` 按 vod-schema DTO 形态 mock(正则路由 `/\/api\/vod\/switch-(candidates|probes|materializations)($|\?)/` 等——**注意 glob 不匹配带 query 的 URL**,曾致 mock 旁路 404,run7–8 诊断留档);`apiLoginAndSelectMain`(fixtureadmin/password-123,主档案,unlock PIN 135790);`startPlayback`(/live 首个「播放 … 当前直播」卡钮);断言助手 `collectMetrics`(token 解析值+面板计算样式)/`activeFocusInfo`(outline 三值+boxShadow+dfv)/`tabWalk`/`mediaDomProbe`/`setTheme`(dark 恢复钉面原态仅 class;light 为 class+data-theme 双写)。

### 8.2 层2(verbatim 命令,结果见 §4)

```sh
grep -rn -- "--hmp-media-[a-z-]*:" apps/web packages --include="*.css" --include="*.tsx" --include="*.ts" --include="*.html" | grep -v node_modules   # → 0 处
grep -rn "var(--hmp-media-" apps/web/src --include="*.tsx" --include="*.ts" --include="*.css"                                                        # → 12 处/6 枚
grep -nE "#[0-9a-fA-F]{3,8}|rgba?\(|oklch\(|bg-black|text-white|border-white|shadow-2xl" apps/web/src/features/playback/*.tsx apps/web/src/app/action-coordinator.tsx
```

### 8.3 回归

```sh
pnpm --filter @hmp/web test:vitest
# 2026-10-31 14:56(任务开始基线)与 16:10(证据执行后)各一轮:
# Test Files 36 passed (36) / Tests 265 passed (265) —— 实现与既有测试零改动
```

## 9. 诚实性声明

- 本文所有 Verified 对应 §8 命令与时间点的真实输出;Not-run(手势面交互证据、真实 SR 播报)不计入完成。
- 层1 的播放协议面为受控 mock(§7 分层声明),mock 响应按 `@hmp/shared` vod-schema 形态构造;媒体播放/进度泵/finish/连播链/键盘/主题/视口均为真实浏览器行为。
- D-A/D-B/D-C/D-D 为真实缺陷证据,均未在本任务内修复(任务边界:不改实现/测试);建议 T087 后由协调方派生修复任务。
- 执行期间发现并修正的**测试自身**问题(mock 旁路、选择器歧义、Number('2px') 断言错误、退出后 stop 计数契约误设)均以多轮运行留档(run7–run15),不影响实现零改动承诺。
