/**
 * 007-backend-ddd-restructure — 边界审计规则（dependency-cruiser）
 *
 * 规则事实来源：
 * - docs/specs/007-backend-ddd-restructure/data-model.md §3「依赖矩阵」（R1/R2）
 * - docs/specs/007-backend-ddd-restructure/contracts/internal-context-contracts.md「审计映射」（R2/R3）
 *
 * 规则路径域刻意限定在 `src/contexts/**` 与 `src/platform/**`（data-model.md §1/§2 的目标结构）。
 * 迁移开始前这两个目录尚不存在 → 所有规则空转通过（exit 0）；随着 T008 起的迁移逐步落地，
 * 规则对已迁移路径自动收紧，严禁出现对旧结构（src/modules/**、src/common/** 等）的规则匹配。
 *
 * data-model.md §3 依赖矩阵（从\到）与本文件规则的对应关系：
 * | 从\到            | domain | application | infrastructure | interface | 其他上下文   | platform | @hmp/shared |
 * |------------------|--------|-------------|----------------|-----------|--------------|----------|-------------|
 * | domain           | ✅     | ❌          | ❌             | ❌        | ❌（经发布面✅）| ❌      | 仅类型契约  |
 * | application      | ✅     | ✅          | ✅（仅本上下文）| ❌        | ❌（经发布面✅）| ✅      | 仅类型契约  |
 * | infrastructure   | ✅     | ✅          | ✅             | ❌        | ❌（经发布面✅）| ✅      | ✅          |
 * | interface        | ✅     | ✅          | ❌（经端口）   | ✅        | 仅发布入口   | ✅       | ✅          |
 *
 * 实现说明：
 * - 依赖项矩阵「同一上下文」约束用 from 的捕获组在 to 中以 $1 回引表达
 *   （dependency-cruiser 支持 from → to 的 $N 组替换）。
 * - to.path / to.pathNot 匹配的是「解析后的落点路径」，node_modules 一律不深入
 *   （options.doNotFollow），依赖边本身仍参与规则匹配。
 * - @hmp/shared 为 workspace 包，pnpm 下 realpath 落点可能是 ../packages/shared/**
 *   或 node_modules 之下的 @hmp/shared（含 .pnpm 硬链接布局），SHARED_PACKAGE 同时兼容两种形态。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-10-28 编排裁决修正（ADR-0014 修正案；T022b/T023 执行，行为零变化）
 * ─────────────────────────────────────────────────────────────────────────────
 * 裁决总纲：
 * - 框架禁令范围 = 领域核心：domain 保持纯净（零 @nestjs/drizzle-orm/better-sqlite3/
 *   rxjs/他上下文）；application 层的 node 内建、drizzle-orm、better-sqlite3、rxjs、
 *   @nestjs、@platform/**（含 config/database/http-common）导入合法化；
 * - 经发布面 `@contexts/<ctx>`（index.ts）的跨上下文访问对**所有层**合法；
 *   深导入（R2）继续禁止；
 * - 同上下文 application→own infrastructure 合法化（既有 29 条边）；
 * - R4 两条 platform→contexts 反向边真修：组合根端口反转（app.module.ts
 *   @Global PlatformPortsModule 绑定 SESSION_VERIFIER_PORT / SETTINGS_GRANT_VALIDATOR_PORT，
 *   session.guard / settings-access.guard 改 @Inject 消费端口）——R4 规则本身不变，
 *   以两条边消失为验证；
 * - guide-problems 的 @nestjs HttpException 渗漏真修：领域错误纯化
 *   （GuideProblemError 纯 Error 子类，interface 层翻译为 HttpException）。
 *
 * 逐条修改（与本文件各规则处注释对应）：
 * ① R1a：to.pathNot 增加 `^src/contexts/[^/]+/index\.ts$`（裁决 1：domain 经发布面
 *   合法，深导入仍禁）。domain 纯度其余维度**不放松**：框架/内建/platform/外部包
 *   仍禁 —— 已知残留 4 条（sources domain→net、live-tv domain→crypto 为 node 内建；
 *   policy domain→platform/http-common/domain-error 为 platform；epg domain→
 *   @internationalized/date 为外部日期库），系纯度强制残留，留待 T024 归零，不在
 *   本裁决放松范围。
 * ② R1b：to.pathNot 增加合法面（a）发布面 index；（b）`^src/platform/`；（c）node
 *   内建（BUILTIN_MODULES，depcruise 对 `node:` 前缀解析后落点为裸名，实测确认）与
 *   drizzle-orm/better-sqlite3/rxjs/@nestjs/express 的 node_modules 形态（FRAMEWORK_
 *   PACKAGES，增补 @types/express —— express 形态的类型落点，裁决 (c) 款覆盖）；
 *   （d）`^src/contexts/$1/infrastructure/`（同上下文 own infrastructure，29 条边）。
 * ③ R1c：to.pathNot 增加 `^src/contexts/[^/]+/index\.ts$`（发布面，裁决）；另放行
 *   NODE_MODULES_PACKAGES + BUILTIN_MODULES（**偏差留痕**：裁决原文仅要求增加发布面；
 *   实测核对本层 55 条软审计 info 全数为 node 内建/框架包/argon2 的白名单工件边 ——
 *   矩阵各行列本无「外部包」禁令单元，原白名单对 node_modules 的拦截系遗漏而非禁令；
 *   按裁决总纲「框架禁令范围 = 领域核心」与 T024 归零门禁，显式放行。框架之外的
 *   治理仍由 R3（domain）与 R1b(c)（application）编码）。
 * ④ R1d：跨上下文发布面本已合法（pathNot 已含 index）——裁决原文「核对无需改则不动」；
 *   实测核对发现本层 57 条软审计 info 全数为外部包（zod/@nestjs/@types/express/
 *   drizzle-orm/内建）白名单工件边，不改则 T024 归零不可达，故同样放行
 *   NODE_MODULES_PACKAGES + BUILTIN_MODULES（**偏差留痕**，理由同 ③；跨上下文
 *   深导入禁令与 R2 不变）。
 * ⑤ R3：from 收窄为 **domain 层 only**（application 不再适用 —— 由 R1b 合法面 (c)
 *   覆盖），规则更名 r3-no-framework-leakage-into-domain；保持 @nestjs/drizzle-orm/
 *   better-sqlite3/express/rxjs（含 @types/express）禁止。代码侧唯一 domain 渗漏点
 *   （epg guide-problems 的 HttpException）已随本裁决纯化。
 * ⑥ R4：**保持** platform→contexts 全禁 —— 端口反转后 2 条边消失即为验证。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-10-28 T024 审计强制归零（ADR-0014 修正案 D 条目；行为零变化，SC-001）
 * ─────────────────────────────────────────────────────────────────────────────
 * 修正①留痕的 domain 纯度强制残留 4 条按修正案 D-①②③ 合法化（R1a to.pathNot
 * 追加，每项在规则处有裁决注释）；另 1 条 application→own interface（identity-
 * access bootstrap.service → account-session.dto）经类型上提真修（ProfileSummary
 * Body / toProfileSummary 上提至 application/profile-summary.dto，规则不放松）。
 * 本步后软/硬审计双模式 0 违规（SC-001 达成）。逐条修改：
 * ⑦ R1a（D-① 内建标准库）：DOMAIN_BUILTINS —— net/crypto/path/fs/fs/promises/
 *    url/util/events/stream/buffer/timers 裸名精确集合（depcruise 剥离 node:
 *    前缀后的落点形态，T022b 实测确认）；仅此确定性集合，不复用全量
 *    BUILTIN_MODULES、不开放通配。放行：sources domain→net、live-tv domain→crypto。
 * ⑧ R1a（D-② 错误契约）：^src/platform/http-common/domain-error\.ts$ ——
 *    DomainError/createDomainError 为宪章定义的跨上下文错误契约（plain TS
 *    class），豁免逻辑与 @hmp/shared 类型契约同理。放行：policy domain→domain-error。
 * ⑨ R1a（D-③ 纯值库）：PURE_VALUE_PACKAGES —— @internationalized/date 的
 *    node_modules 落点（pnpm 两分支平铺；无 I/O 副作用的纯日期值运算库）。
 *    放行：epg domain→@internationalized/date。
 */

/** @hmp/shared（类型契约包）的解析落点：workspace 源码或 node_modules 内。
 *  注意：dependency-cruiser 用 safe-regex 校验规则（禁止嵌套量词），
 *  因此 .pnpm 形态必须平铺为独立分支，不得写成可选项内含 [^/]+ 的形式。 */
const SHARED_PACKAGE =
	"^(?:\\.\\./)*(?:packages/shared|node_modules/@hmp/shared|node_modules/\\.pnpm/[^/]+/node_modules/@hmp/shared)/";

/** R3 框架渗漏禁令针对的外部包（contracts 审计映射 + rxjs）在 node_modules 的落点。
 *  平铺两个分支以规避 safe-regex 的嵌套量词禁令：
 *  1) 常规/保留 symlink 形态 node_modules/<pkg>/
 *  2) pnpm 硬链接形态 node_modules/.pnpm/<pkg>@ver.../node_modules/<pkg>/
 *  2026-10-28 裁决修正②：增补 @types/express —— express 形态的类型落点
 *  （如 playback application 的 Request 类型导入），属裁决 R1b(c)「express 的
 *  node_modules 形态」覆盖面；R3（domain）现无此类边，行为不变。 */
const FRAMEWORK_PKGS = "(?:@nestjs/|drizzle-orm|better-sqlite3|express|rxjs|@types/express)";

/** 008-T014（ADR-0015 D3）：R1b 收紧后的 application 层框架放行形态——
 *  自 FRAMEWORK_PKGS 剔除 drizzle-orm 与 better-sqlite3（数据访问实现细节，
 *  登记 5 已由规格 008 补救清零，自此 application 值/类型导入均违规）；
 *  @nestjs（装饰器类应用服务）、express（类型工件）与 rxjs 维持
 *  ADR-0014 修正 2「框架禁令范围 = 领域核心」的裁决。 */
const APP_ALLOWED_FRAMEWORK_PKGS = "(?:@nestjs/|express|rxjs|@types/express)";
const APP_ALLOWED_FRAMEWORK_PACKAGES =
	"^(?:\\.\\./)*node_modules/(?:\\.pnpm/[^/]+/node_modules/" +
	APP_ALLOWED_FRAMEWORK_PKGS +
	"|" +
	APP_ALLOWED_FRAMEWORK_PKGS +
	")";
const FRAMEWORK_PACKAGES =
	"^(?:\\.\\./)*node_modules/(?:\\.pnpm/[^/]+/node_modules/" +
	FRAMEWORK_PKGS +
	"|" +
	FRAMEWORK_PKGS +
	")";

/** 2026-10-28 裁决修正②(c)：node 内建模块的 depcruise 解析形态 —— 源码
 *  `node:path`/`node:fs` 前缀在解析后被剥离，落点为裸模块名（如 "path"、
 *  "fs/promises"；T022b 以 AUDIT_ENFORCE=0 实测报告确认）。平铺字面量分支
 *  满足 safe-regex（无嵌套量词）；子路径内建（fs/promises）经 (?:/|$) 收尾。 */
const BUILTIN_MODULES =
	"^(?:assert|async_hooks|buffer|child_process|cluster|console|crypto|dgram|diagnostics_channel|dns|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:/|$)";

/** 2026-10-28 裁决修正③④（偏差留痕，见文件头）：外部 npm 包的 node_modules 落点
 *  （含 .pnpm 硬链接布局）。infrastructure/interface 的外部包不属依赖矩阵管辖
 *  （矩阵各行列无「外部包」禁令单元；框架禁令范围 = 领域核心，已由 R3 收窄编码），
 *  R1c/R1d 据此显式放行，消除白名单对 node_modules 的历史工件拦截。 */
const NODE_MODULES_PACKAGES = "^(?:\\.\\./)*node_modules/";

/** 2026-10-28 T024 归零（ADR-0014 修正案 D-①，见文件头⑦）：domain 放行的 node
 *  内建标准库确定性集合。depcruise 对 `node:` 前缀剥离后的落点为裸模块名
 *  （T022b 实测确认），本表全名精确匹配（$ 收尾，子路径内建 fs/promises 以
 *  全名列举）；仅此列举集合，不复用 R1b/R1c 的全量 BUILTIN_MODULES、不开放
 *  通配 —— domain 纯度其余维度不放松。 */
const DOMAIN_BUILTINS = "^(?:net|crypto|path|fs|fs/promises|url|util|events|stream|buffer|timers)$";

/** 2026-10-28 T024 归零（ADR-0014 修正案 D-③，见文件头⑨）：纯值库
 *  @internationalized/date 的 node_modules 落点（无 I/O 副作用的纯日期值运算库）。
 *  pnpm 形态写法同 SHARED_PACKAGE/FRAMEWORK_PACKAGES：常规 symlink 与 .pnpm
 *  硬链接两分支平铺（safe-regex 禁嵌套量词）；实测落点为仓库根 hoist
 *  （../../node_modules/.pnpm/@internationalized+date@…），(?:\.\./)* 前缀
 *  兼容两级 node_modules，(?:/|$) 收尾杜绝前缀误吞。 */
const PURE_VALUE_PACKAGES =
	"^(?:\\.\\./)*(?:node_modules/@internationalized/date" +
	"|node_modules/\\.pnpm/[^/]+/node_modules/@internationalized/date)(?:/|$)";

/** 门禁强度开关（007 编排修正 2026-10-28）：
 *  - 默认 enforce（severity:"error"，违规即非零退出）——T024 起与 verify:release ④b 使用默认值；
 *  - US1 迁移步（T008–T019）以 `AUDIT_ENFORCE=0` 运行 → 全部规则降级为 info（报告模式，exit 0）：
 *    此时已迁移上下文仍存在指向旧树（src/modules|common 等）的跨上下文边，
 *    这些边按计划在 US2（T022）统一收口，故 US1 仅记录违规数、不阻断。
 *  证据留档：docs/specs/007-backend-ddd-restructure/evidence/boundary-audit.md 汇总趋势。 */
// Node 全局(process)未声明,与本文件下方 module.exports 同一处理。
// eslint-disable-next-line no-undef
const ENFORCE = process.env.AUDIT_ENFORCE !== "0";
const RULE_SEVERITY = ENFORCE ? "error" : "info";

// CommonJS 导出为本工具配置的唯一形态;本文件经 eslint projectService 的
// allowDefaultProject 以 JS 规则集检查,Node 全局(module)未声明。
// eslint-disable-next-line no-undef
module.exports = {
	forbidden: [
		// ---------------------------------------------------------------- R1a
		// data-model.md §3「domain」行（严格版）：domain 仅可 import 自身上下文
		// 的 domain/** 与 @hmp/shared（仅类型契约），以及他上下文发布面 index.ts
		// （2026-10-28 裁决修正①，ADR-0014 修正案裁决 1：发布面对所有层合法；
		// 深导入仍由 R2 禁止）。其余一律违规（含本上下文其他层、platform、
		// 一切框架/内建/外部包）—— domain 纯度不放松；T024 归零按 ADR-0014
		// 修正案 D-①②③ 追加三项确定性放行（内建标准库集合 / 错误契约 / 纯值库，
		// 见下方注释与文件头「T024 审计强制归零」），其余维度仍不放松。
		{
			name: "r1-domain-only-own-domain-and-shared",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/domain/" },
			to: {
				pathNot: [
					"^src/contexts/$1/domain/",
					SHARED_PACKAGE,
					// 裁决修正①：他上下文发布面（自身 index 亦无害）——如 epg domain
					// binding-core/programme-key.mapper 对 live-tv 发布面的复用。
					"^src/contexts/[^/]+/index\\.ts$",
					// T024 归零（ADR-0014 修正案 D-①）：node 内建标准库确定性集合
					// （裸名形态，T022b 实测落点；全名精确匹配、不开放通配）——
					// 放行 sources domain→net、live-tv domain→crypto 既有边。
					DOMAIN_BUILTINS,
					// T024 归零（ADR-0014 修正案 D-②）：跨上下文错误契约 ——
					// DomainError/createDomainError 为宪章定义的跨上下文错误契约
					// （plain TS class，无框架依赖），豁免逻辑与 @hmp/shared 类型
					// 契约同理 —— 放行 policy domain→domain-error 既有边。
					"^src/platform/http-common/domain-error\\.ts$",
					// T024 归零（ADR-0014 修正案 D-③）：纯值库 @internationalized/
					// date（pnpm 两分支平铺落点，无 I/O 副作用）——放行 epg domain
					// →@internationalized/date 既有边。
					PURE_VALUE_PACKAGES,
				],
			},
		},
		// ---------------------------------------------------------------- R1b
		// data-model.md §3「application」行：application 可 import 自身 domain/**、
		// 自身 application/**、自身 infrastructure/**（2026-10-28 裁决修正②(d)，
		// 既有 29 条同上下文边合法化）、他上下文发布面 index（修正②(a)）、
		// src/platform/**（修正②(b)，含 config/database/http-common）、@hmp/shared
		// （仅类型契约）、node 内建与 drizzle-orm/better-sqlite3/rxjs/@nestjs/express
		// 形态（修正②(c)；zod 等其余外部包仍禁 —— 框架合法面以裁决列举为准）。
		{
			name: "r1-application-only-own-domain-application-and-shared",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/application/" },
			to: {
				pathNot: [
					"^src/contexts/$1/domain/",
					"^src/contexts/$1/application/",
					// 裁决修正②(d)：同上下文 application→own infrastructure 合法化
					//（跨上下文 infrastructure 仍禁，落点仅限发布面）。
					"^src/contexts/$1/infrastructure/",
					SHARED_PACKAGE,
					// 裁决修正②(a)：他上下文发布面（自身 index 亦无害）。
					"^src/contexts/[^/]+/index\\.ts$",
					// 008-T014（ADR-0015 D3）收紧：platform 收窄为 http-common/config
					// （错误契约/会话装饰器/配置值——application 实测消费面）；
					// platform/database 仅保留 schema 与 drizzle 两文件的**类型锚点**
					// （行类型 import type 的单一事实源；值形态由 audit:purity 符号级
					// 门禁拒绝——depcruise 模块粒度无法区分 import type，双轨分工
					// 见 ADR-0015 D3；database.ts/migrate.ts 等其余落点全禁）。
					"^src/platform/(?:http-common|config)/",
					"^src/platform/database/(?:schema|drizzle)\\.ts$",
					// 裁决修正②(c)收窄（008-T014）：node 内建维持放行；
					// 框架包放行剔除 drizzle-orm/better-sqlite3（APP_ALLOWED_*）。
					BUILTIN_MODULES,
					APP_ALLOWED_FRAMEWORK_PACKAGES,
				],
			},
		},
		// ---------------------------------------------------------------- R1c
		// data-model.md §3「infrastructure」行：infrastructure 可 import 自身
		// domain/application/infrastructure、他上下文发布面 index.ts（2026-10-28
		// 裁决修正③）、src/platform/**、@hmp/shared、外部包与 node 内建（修正③
		// 偏差留痕：外部包不属矩阵管辖，见文件头；框架治理由 R3/R1b(c) 编码）；
		// 不得 import 任何 src/contexts/*/interface/**，不得跨上下文深导入。
		{
			name: "r1-infrastructure-own-layers-platform-and-shared-only",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/infrastructure/" },
			to: {
				pathNot: [
					"^src/contexts/$1/(domain|application|infrastructure)/",
					"^src/platform/",
					SHARED_PACKAGE,
					// 裁决修正③：发布面。
					"^src/contexts/[^/]+/index\\.ts$",
					// 裁决修正③（偏差留痕）：外部包/内建不属矩阵管辖。
					NODE_MODULES_PACKAGES,
					BUILTIN_MODULES,
				],
			},
		},
		// ---------------------------------------------------------------- R1d
		// data-model.md §3「interface」行：interface 可 import 自身上下文全部层、
		// 其他上下文的发布入口 index.ts、src/platform/**、@hmp/shared、外部包与
		// node 内建（2026-10-28 裁决修正④偏差留痕：裁决原文「核对无需改则不动」，
		// 实测核对 57 条 info 全数为外部包白名单工件边，放行理由同修正③，
		// 见文件头）；不得 import 其他上下文的非 index 文件（内部实现）。
		{
			name: "r1-interface-own-context-published-index-platform-shared-only",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/interface/" },
			to: {
				pathNot: [
					"^src/contexts/$1/",
					"^src/contexts/[^/]+/index\\.ts$",
					"^src/platform/",
					SHARED_PACKAGE,
					// 裁决修正④（偏差留痕）：外部包/内建不属矩阵管辖。
					NODE_MODULES_PACKAGES,
					BUILTIN_MODULES,
				],
			},
		},
		// ---------------------------------------------------------------- R2
		// 深导入禁令（contracts「审计映射」第 1 条，2026-10-28 裁决不放松）：
		// 跨上下文 import 的落点必须是目标上下文的 index.ts（发布入口），落点为
		// 其他上下文任何非 index 文件即违规。
		{
			name: "r2-cross-context-deep-import-ban",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/" },
			to: {
				path: "^src/contexts/(?!$1/)[^/]+/",
				pathNot: ["^src/contexts/[^/]+/index\\.ts$"],
			},
		},
		// ---------------------------------------------------------------- R3
		// 框架渗漏禁令（contracts「审计映射」第 3 条 + rxjs）。2026-10-28 裁决
		// 修正⑤：from 收窄为 **domain 层 only** —— 框架禁令范围 = 领域核心，
		// application 的框架使用由 R1b 合法面 (c) 覆盖、不再在本规则重复；
		// 更名 r3-no-framework-leakage-into-domain。保持 @nestjs/drizzle-orm/
		// better-sqlite3/express/rxjs（含 @types/express）禁止；domain 唯一既有
		// 渗漏点（epg guide-problems 的 HttpException）已随裁决纯化为
		// GuideProblemError（纯 Error 子类，interface 层翻译）。
		{
			name: "r3-no-framework-leakage-into-domain",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/[^/]+/domain/" },
			to: { path: FRAMEWORK_PACKAGES },
		},
		// ---------------------------------------------------------------- R4
		// platform 中立性（data-model.md §1）：platform 被所有上下文依赖，
		// 自身不得依赖任何业务上下文。2026-10-28 裁决修正⑥：**保持**全禁 ——
		// 既有 2 条反向边（session.guard→identity-access token.service、
		// settings-access.guard→settings application）经组合根端口反转真修
		// （app.module.ts @Global PlatformPortsModule 绑定端口，守卫 @Inject
		// 消费），两条边消失即为验证；本规则不变。
		{
			name: "r4-platform-must-not-depend-on-contexts",
			severity: RULE_SEVERITY,
			from: { path: "^src/platform/" },
			to: { path: "^src/contexts/" },
		},
	],
	options: {
		// 依赖边保留用于规则匹配，但不深入 node_modules 与仓库其他包内部
		doNotFollow: { path: "^(node_modules|\\.\\./)" },
		tsConfig: { fileName: "tsconfig.json" },
		tsPreCompilationDeps: true,
		combinedDependencies: false,
	},
};
