/**
 * 日志脱敏(T041/FR-007):任何进入日志的结构化数据必须先经 redactForLog。
 * 规则:键名命中敏感词(password/pin/token/secret/authorization/cookie)→ '[REDACTED]';
 * 深遍历,循环引用安全(WeakSet),深度封顶防爆炸。
 *
 * 阶段 4(004/T012,research R6「日志不记录原路径、URL、query ticket 或 FFmpeg 原始 stderr,
 * 只保留稳定码/脱敏技术摘要」)新增:
 * - redactQueryTicket:任意文本/URL 中 query 参数 ticket 的值 → '[REDACTED]'(参数名保留);
 *   redactForLog 对所有字符串值统一过这道闸(访问日志含票据 URL 也不落原文);
 * - redactSourcePaths / summarizeSourcePath:源文件绝对路径/目录路径 → 占位符,
 *   仅保留扩展名(容器提示),父目录层级与文件名去除;
 * - summarizeFfmpegStderr:FFmpeg stderr → 稳定码 + 单行技术摘要。只做"脱敏压缩",
 *   不做失败分类 —— 稳定码由调用方(转换监管 T016+)按失败矩阵判定后传入;
 *   输出仅由稳定码与白名单技术关键字构成,原文任何路径/URL/主机名/票据不进入输出。
 *
 * 落位说明:放在 common 而非 playback 域 —— query ticket 出现在任何含 URL 的日志里
 * (导入源/访问日志同受 004 contracts/api.md「日志过滤 query ticket」约束),
 * 与 T041"任何进入日志的数据先经本文件"的单一入口口径一致,避免两套脱敏入口。
 */

const SENSITIVE_KEY = /pass(word)?|pin|token|secret|authorization|cookie/i;
const MAX_DEPTH = 8;

/** 统一占位符(与键名脱敏同口径) */
export const REDACTED = '[REDACTED]';

/**
 * query ticket 参数(参数名大小写不敏感;值取到 &/#/空白/引号/括号/行尾为止,
 * 因此含 %20、+、=、/ 等特殊字符的值整段脱敏,URL fragment 不受影响)。
 * 前缀锚定(? & 空白 引号 括号 行首)避免误伤普通单词(如 myticket=x)。
 */
const TICKET_QUERY = /(^|[?&\s"'(])ticket=[^&#\s"')]*/gi;

/** 把文本中所有 query ticket 的值替换为 '[REDACTED]',其余内容原样保留 */
export function redactQueryTicket(text: string): string {
  return text.replace(TICKET_QUERY, (_match, separator: string) => `${separator}ticket=${REDACTED}`);
}

/** 快速预判(避免对每条字符串都跑正则替换) */
function mayContainTicket(value: string): boolean {
  return /ticket=/i.test(value);
}

/* ---------------- 源路径/URL 脱敏(004 R6) ---------------- */

/** 带引号的路径('/Volumes/x y/f.mp4'、"D:\a\b.mkv")—— 空格安全 */
const QUOTED_PATH = /(["'])(?:\\\\|\/|[A-Za-z]:\\)[^"']*\1/g;
/** file: URL(file:// 与 file:/ 单斜杠形态,FFmpeg 输入回显常见) */
const FILE_URL = /\bfile:[\\/]{1,3}[^\s"']+/gi;
/** http(s) URL(含票据/凭据/主机,整体不落日志) */
const HTTP_URL = /\bhttps?:\/\/[^\s"']+/gi;
/** Windows UNC 路径 \\server\share\... */
const UNC_PATH = /\\\\[^\s"']+/g;
/** Windows 盘符路径 X:\... */
const WIN_PATH = /\b[A-Za-z]:\\[^\s"']*/g;
/** POSIX 绝对路径(锚定行首/空白/引号/括号/等号/冒号后,避免误伤 kbits/s 这类单位) */
const POSIX_PATH = /(?<=^|[\s"'(=:[,;])\/[^\s"']+/g;

/** 从路径 token 提取扩展名(容器提示);无扩展名或扩展名不可信时返回空串 */
function extensionHintOf(token: string): string {
  const basename = token.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const dot = basename.lastIndexOf('.');
  if (dot > 0) {
    const ext = basename.slice(dot + 1);
    if (/^[A-Za-z0-9]{1,8}$/.test(ext)) return ext.toLowerCase();
  }
  return '';
}

/** 路径 token → 占位符,保留扩展名提示(完整路径与父目录层级去除) */
function toPathPlaceholder(token: string): string {
  const ext = extensionHintOf(token);
  return ext ? `[REDACTED-PATH:${ext}]` : '[REDACTED-PATH]';
}

/**
 * 把文本中的源路径与 URL 整体替换为占位符:
 * 路径 → '[REDACTED-PATH:ext]' / '[REDACTED-PATH]';file:/http(s) URL → '[REDACTED-URL]'。
 * 用于播放失败摘要/技术消息;普通业务文本不含锚定形态的路径时保持原样。
 */
export function redactSourcePaths(text: string): string {
  let out = redactQueryTicket(text);
  out = out.replace(FILE_URL, '[REDACTED-URL]');
  out = out.replace(HTTP_URL, '[REDACTED-URL]');
  out = out.replace(QUOTED_PATH, (match) => toPathPlaceholder(match));
  out = out.replace(UNC_PATH, toPathPlaceholder);
  out = out.replace(WIN_PATH, toPathPlaceholder);
  out = out.replace(POSIX_PATH, toPathPlaceholder);
  return out;
}

/**
 * 单个源文件/目录路径 → 稳定技术摘要(R6):完整路径与父目录层级去除,
 * 仅保留扩展名作为容器提示。供失败事件/日志记录 NAS 源位置时使用。
 */
export function summarizeSourcePath(path: string): string {
  const ext = extensionHintOf(path);
  return ext ? `源路径已脱敏(容器提示:${ext})` : '源路径已脱敏';
}

/* ---------------- FFmpeg stderr 脱敏(004 R6) ---------------- */

/**
 * 白名单技术关键字:输出仅由这些模式的匹配构成,原文其余片段(含路径/URL/主机)
 * 一律不进入摘要 —— 泄漏面按构造归零。codec/容器、像素格式、分辨率、
 * duration/fps/bitrate 与 FFmpeg 通用失败短语(无任何定位信息)。
 */
const TECHNICAL_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\b(?:h264|h265|hevc|av1|vp8|vp9|mpeg2video|mpeg4|mjpeg|aac|ac3|eac3|dts|truehd|mp3|opus|flac|vorbis|mp4|mov|matroska|mkv|mpegts|avi|webm|hls|dash)\b/gi,
  /\byuv420p(?:10le|le)?\b/gi,
  /\b\d{3,5}x\d{2,4}\b/g,
  /\bduration[:= ]\s*[\d:.,]+/gi,
  /\bfps\b[:= ]?\s*\d+(?:\.\d+)?|\b\d+(?:\.\d+)?\s*fps\b/gi,
  /\bbitrate[:= ]\s*\d+(?:\.\d+)?/gi,
  /\b(?:invalid data|permission denied|operation not permitted|no such file|timed out|timeout|connection refused|connection reset|end of file|moov atom not found|invalid argument|protocol not found|immediate exit requested)\b/gi,
];

/** 归一化:小写、压缩空白、去尾部标点,保证多行输入不产生多行输出 */
function normalizeKeyword(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[,.;:]+$/, '');
}

/** 最多保留的关键字数(防异常输入撑爆摘要) */
const MAX_KEYWORDS = 12;

/** 缺省摘要最大长度 */
const DEFAULT_STDERR_SUMMARY_MAX_LENGTH = 200;

/**
 * FFmpeg stderr → 稳定码 + 单行技术摘要(004 R6)。
 * - stableCode 由调用方判定后传入(失败分类属 T016+ 转换监管,本函数不推断);
 * - 摘要只含稳定码与白名单关键字(codec/分辨率/duration/fps/通用失败短语),
 *   原文路径/URL/query ticket/主机名/堆栈不出现;多行压缩为单行;
 * - 超 maxLength 截断(保留省略号)。
 */
export function summarizeFfmpegStderr(stderr: string, stableCode: string, maxLength = DEFAULT_STDERR_SUMMARY_MAX_LENGTH): string {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const pattern of TECHNICAL_KEYWORD_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(stderr)) !== null) {
      const keyword = normalizeKeyword(match[0]);
      if (keyword && !seen.has(keyword)) {
        seen.add(keyword);
        keywords.push(keyword);
        if (keywords.length >= MAX_KEYWORDS) break;
      }
    }
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  const summary =
    keywords.length > 0 ? `${stableCode}; 技术摘要: ${keywords.join(', ')}` : `${stableCode}; 技术摘要: 无`;
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}…` : summary;
}

/* ---------------- 结构化日志深遍历(既有行为 + 字符串票据闸) ---------------- */

export function redactForLog<T>(value: T, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    // R6:字符串值统一过 query ticket 闸(含票据 URL 的日志/消息不落票据原文)
    if (typeof value === 'string' && mayContainTicket(value)) {
      return redactQueryTicket(value);
    }
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
