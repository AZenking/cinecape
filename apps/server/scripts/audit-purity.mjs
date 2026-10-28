#!/usr/bin/env node
/**
 * 008-repository-extraction — application/domain 层符号级纯度门禁（audit:purity）。
 *
 * 事实来源：ADR-0015 D3 / 规格 008 FR-005。
 * 动机：depcruise 工作在模块粒度——`getDb` 经 identity-access 发布面（index.ts）
 * 导入时产生的边是合法「发布面导入」，模块级规则无法按符号识别走私；本脚本在
 * 符号/说明符粒度弥补该盲区。
 *
 * 规则：扫描 src/contexts 各上下文的 application 与 domain 目录全部 .ts 文件，
 * 禁止以下「值形态」引用（import type / type-only 一律放行——depcruise 亦不为
 * import type 产生边，schema 行类型保留单一事实源，见 ADR-0015 事实 4）：
 *   1) 值导入 drizzle-orm / drizzle-orm/*（含运算符 eq/and/inArray/sql 与表 API）
 *   2) 值导入 better-sqlite3
 *   3) 值导入 @platform/database/**（schema 表对象、Database 类、migrate 等）
 *   4) 命名导入 getDb / Database 符号（无论来源面——含发布面走私）
 *
 * 模式开关：PURITY_ENFORCE=0 → 报告模式（仅计数，exit 0；迁移期 T002–T013 用）；
 *           默认 enforce（违规即 exit 1；T014 起接入 verify:release）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src/contexts');
const ENFORCE = process.env.PURITY_ENFORCE !== '0';

/** 值导入判定：import 语句中未被 `import type` 前缀修饰的说明符命中 */
const FORBIDDEN_MODULE_PATTERNS = [
  /^drizzle-orm(\/.*)?$/,
  /^better-sqlite3$/,
  /^@platform\/database(\/.*)?$/,
];
/** 无论来源模块的符号名禁令（发布面走私拦截） */
const FORBIDDEN_SYMBOLS = new Set(['getDb', 'Database']);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith('.ts')) files.push(full);
  }
})(SRC_ROOT);

const layerRe = /\/(application|domain)\//;
const violations = [];

for (const file of files) {
  const rel = file.slice(join(process.cwd(), 'src/contexts').length + 1);
  if (!layerRe.test(rel)) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // import type ... / export type ... 一律放行
    if (/^\s*(import|export)\s+type\b/.test(line)) continue;
    const m = line.match(/^\s*import\s+([^'"]*)from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    const [, clause, specifier] = m;
    const stripped = clause.replace(/^type\s+/, '').replace(/,\s*type\s+/g, ', ').replace(/\btype\s+/g, '');
    const symbols = stripped
      .replace(/[{}]/g, ' ')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const moduleHit = FORBIDDEN_MODULE_PATTERNS.some((p) => p.test(specifier));
    const symbolHits = symbols.filter((s) => FORBIDDEN_SYMBOLS.has(s));
    if (moduleHit || symbolHits.length > 0) {
      violations.push({
        file: `src/contexts/${rel}`,
        line: i + 1,
        text: line.trim(),
        reason: moduleHit ? `值导入禁用模块 ${specifier}` : `值引用禁用符号 ${symbolHits.join('/')}`,
      });
    }
  }
}

if (violations.length === 0) {
  console.log(ENFORCE ? '✔ purity gate: no forbidden value-imports in application/domain' : `purity gate (report): 0 hits`);
  process.exit(0);
}
for (const v of violations) {
  console.log(`${ENFORCE ? 'error' : 'info'} purity: ${v.file}:${v.line} — ${v.reason}\n    ${v.text}`);
}
console.log(`\n${ENFORCE ? '✖' : 'ℹ'} ${violations.length} purity violation(s)${ENFORCE ? '' : ' (report mode)'}`);
process.exit(ENFORCE ? 1 : 0);
