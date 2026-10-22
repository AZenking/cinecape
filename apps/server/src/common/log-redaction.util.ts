/**
 * 日志脱敏(T041/FR-007):任何进入日志的结构化数据必须先经 redactForLog。
 * 规则:键名命中敏感词(password/pin/token/secret/authorization/cookie)→ '[REDACTED]';
 * 深遍历,循环引用安全(WeakSet),深度封顶防爆炸。
 */

const SENSITIVE_KEY = /pass(word)?|pin|token|secret|authorization|cookie/i;
const MAX_DEPTH = 8;

export function redactForLog<T>(value: T, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH || seen.has(value as object)) {
    return '[TRUNCATED]';
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactForLog(val, depth + 1, seen);
  }
  return out;
}
