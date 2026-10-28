// T025-C comparator — normalizes volatile values and diffs the two sampler outputs.
// Usage: node compare.mjs <old.json> <new.json> <outReport.json>
import fs from 'node:fs';

const [, , oldPath, newPath, outPath] = process.argv;
const oldRun = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
const newRun = JSON.parse(fs.readFileSync(newPath, 'utf8'));

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
const MS_RE = /\b1[0-9]{12}\b/g; // 13-digit epoch millis
const TOKEN_KEYS = /token|secret|cookie/i;

function maskStr(s) {
  return s.replace(UUID_RE, '<uuid>').replace(ISO_RE, '<ts>').replace(MS_RE, '<ms>');
}
function normalize(v, key = '') {
  if (typeof v === 'string') {
    let s = maskStr(v);
    if (TOKEN_KEYS.test(key)) s = '<token>';
    return s;
  }
  if (typeof v === 'number') return Number.isInteger(v) && v > 1e12 ? '<ms>' : v;
  if (Array.isArray(v)) return v.map((x) => normalize(x, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = normalize(v[k], k);
    return o;
  }
  return v;
}
function canon(entry) {
  return {
    status: entry.status,
    contentType: entry.contentType,
    body: entry.body === null || entry.body === undefined ? null
      : typeof entry.body === 'string' ? maskStr(entry.body)
      : normalize(entry.body),
  };
}

const oldByName = new Map(oldRun.steps.map((s) => [s.name, s]));
const newByName = new Map(newRun.steps.map((s) => [s.name, s]));
const names = [...new Set([...oldRun.steps.map((s) => s.name), ...newRun.steps.map((s) => s.name)])];

const report = [];
let mismatches = 0;
for (const name of names) {
  const o = oldByName.get(name);
  const n = newByName.get(name);
  if (!o || !n) { report.push({ name, match: false, reason: 'missing-side' }); mismatches++; continue; }
  const co = canon(o); const cn = canon(n);
  const so = JSON.stringify(co); const sn = JSON.stringify(cn);
  const match = so === sn && !o.error && !n.error;
  if (!match) mismatches++;
  report.push({
    name, method: o.method, path: maskStr(o.path),
    oldStatus: o.status, newStatus: n.status,
    match,
    oldBody: co.body, newBody: cn.body,
  });
}
const summary = {
  oldBase: oldRun.base, newBase: newRun.base,
  steps: report.length, mismatches,
  pass: mismatches === 0,
  comparedAt: new Date().toISOString(),
};
fs.writeFileSync(outPath, JSON.stringify({ summary, routes: report }, null, 1));
console.log(JSON.stringify(summary));
for (const r of report.filter((x) => !x.match)) {
  console.log(`MISMATCH ${r.name} ${r.method} ${r.path} old=${r.oldStatus} new=${r.newStatus}`);
  if (r.oldBody !== undefined && r.newBody !== undefined) {
    console.log('  old: ' + JSON.stringify(r.oldBody).slice(0, 400));
    console.log('  new: ' + JSON.stringify(r.newBody).slice(0, 400));
  }
}
