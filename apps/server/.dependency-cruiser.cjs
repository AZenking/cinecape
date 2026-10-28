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
 * | domain           | ✅     | ❌          | ❌             | ❌        | ❌           | ❌       | 仅类型契约  |
 * | application      | ✅     | ✅          | ❌（经端口）   | ❌        | ❌           | ❌       | 仅类型契约  |
 * | infrastructure   | ✅     | ✅          | ✅             | ❌        | ❌           | ✅       | ✅          |
 * | interface        | ✅     | ✅          | ❌（经端口）   | ✅        | 仅发布入口   | ✅       | ✅          |
 *
 * 实现说明：
 * - 依赖项矩阵「同一上下文」约束用 from 的捕获组在 to 中以 $1 回引表达
 *   （dependency-cruiser 支持 from → to 的 $N 组替换）。
 * - to.path / to.pathNot 匹配的是「解析后的落点路径」，node_modules 一律不深入
 *   （options.doNotFollow），依赖边本身仍参与规则匹配。
 * - @hmp/shared 为 workspace 包，pnpm 下 realpath 落点可能是 ../packages/shared/**
 *   或 node_modules 之下的 @hmp/shared（含 .pnpm 硬链接布局），SHARED_PACKAGE 同时兼容两种形态。
 */

/** @hmp/shared（类型契约包）的解析落点：workspace 源码或 node_modules 内。
 *  注意：dependency-cruiser 用 safe-regex 校验规则（禁止嵌套量词），
 *  因此 .pnpm 形态必须平铺为独立分支，不得写成可选项内含 [^/]+ 的形式。 */
const SHARED_PACKAGE =
	"^(?:\\.\\./)*(?:packages/shared|node_modules/@hmp/shared|node_modules/\\.pnpm/[^/]+/node_modules/@hmp/shared)/";

/** R3 框架渗漏禁令针对的外部包（contracts 审计映射 + rxjs）在 node_modules 的落点。
 *  平铺两个分支以规避 safe-regex 的嵌套量词禁令：
 *  1) 常规/保留 symlink 形态 node_modules/<pkg>/
 *  2) pnpm 硬链接形态 node_modules/.pnpm/<pkg>@ver.../node_modules/<pkg>/ */
const FRAMEWORK_PKGS = "(?:@nestjs/|drizzle-orm|better-sqlite3|express|rxjs)";
const FRAMEWORK_PACKAGES =
	"^(?:\\.\\./)*node_modules/(?:\\.pnpm/[^/]+/node_modules/" +
	FRAMEWORK_PKGS +
	"|" +
	FRAMEWORK_PKGS +
	")";

/** 门禁强度开关（007 编排修正 2026-10-28）：
 *  - 默认 enforce（severity:"error"，违规即非零退出）——T024 起与 verify:release ④b 使用默认值；
 *  - US1 迁移步（T008–T019）以 `AUDIT_ENFORCE=0` 运行 → 全部规则降级为 info（报告模式，exit 0）：
 *    此时已迁移上下文仍存在指向旧树（src/modules|common 等）的跨上下文边，
 *    这些边按计划在 US2（T022）统一收口，故 US1 仅记录违规数、不阻断。
 *  证据留档：docs/specs/007-backend-ddd-restructure/evidence/boundary-audit.md 汇总趋势。 */
const ENFORCE = process.env.AUDIT_ENFORCE !== "0";
const RULE_SEVERITY = ENFORCE ? "error" : "info";

// CommonJS 导出为本工具配置的唯一形态;本文件经 eslint projectService 的
// allowDefaultProject 以 JS 规则集检查,Node 全局(module)未声明。
// eslint-disable-next-line no-undef
module.exports = {
	forbidden: [
		// ---------------------------------------------------------------- R1a
		// data-model.md §3「domain」行（严格版）：domain 仅可 import 自身上下文
		// 的 domain/** 与 @hmp/shared（仅类型契约）。其余一律违规（含其他上下文
		// domain、本上下文其他层、platform、一切框架/外部包）。
		{
			name: "r1-domain-only-own-domain-and-shared",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/domain/" },
			to: {
				pathNot: [
					"^src/contexts/$1/domain/",
					SHARED_PACKAGE,
				],
			},
		},
		// ---------------------------------------------------------------- R1b
		// data-model.md §3「application」行：application 仅可 import 自身
		// domain/**、自身 application/**、@hmp/shared（仅类型契约）。
		{
			name: "r1-application-only-own-domain-application-and-shared",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/application/" },
			to: {
				pathNot: [
					"^src/contexts/$1/domain/",
					"^src/contexts/$1/application/",
					SHARED_PACKAGE,
				],
			},
		},
		// ---------------------------------------------------------------- R1c
		// data-model.md §3「infrastructure」行：infrastructure 可 import 自身
		// domain/application/infrastructure、src/platform/**、@hmp/shared；
		// 不得 import 任何 src/contexts/*/interface/**，也不得跨上下文。
		{
			name: "r1-infrastructure-own-layers-platform-and-shared-only",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/([^/]+)/infrastructure/" },
			to: {
				pathNot: [
					"^src/contexts/$1/(domain|application|infrastructure)/",
					"^src/platform/",
					SHARED_PACKAGE,
				],
			},
		},
		// ---------------------------------------------------------------- R1d
		// data-model.md §3「interface」行：interface 可 import 自身上下文全部层、
		// 其他上下文的发布入口 index.ts、src/platform/**、@hmp/shared；
		// 不得 import 其他上下文的非 index 文件（内部实现）。
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
				],
			},
		},
		// ---------------------------------------------------------------- R2
		// 深导入禁令（contracts「审计映射」第 1 条）：跨上下文 import 的落点必须是
		// 目标上下文的 index.ts（发布入口），落点为其他上下文任何非 index 文件即违规。
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
		// 框架渗漏禁令（contracts「审计映射」第 3 条 + rxjs）：domain 与
		// application 必须保持纯 TS（经端口/令牌间接使用框架），不得 import
		// @nestjs/*、drizzle-orm、better-sqlite3、express、rxjs。
		{
			name: "r3-no-framework-leakage-into-domain-and-application",
			severity: RULE_SEVERITY,
			from: { path: "^src/contexts/[^/]+/(domain|application)/" },
			to: { path: FRAMEWORK_PACKAGES },
		},
		// ---------------------------------------------------------------- R4
		// platform 中立性（data-model.md §1）：platform 被所有上下文依赖，
		// 自身不得依赖任何业务上下文。
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
