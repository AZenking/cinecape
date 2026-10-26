import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { IMPORT_BUDGETS } from '../../config/import-budgets';

/**
 * M3U 流式解析器(T022;对照 research R2/R6):
 * - UTF-8 流式逐行状态机:逐块经 TextDecoder(stream 模式)解码并按行切分,
 *   支持 \n 与 \r\n(含被块边界拆开的 \r\n),禁止整文件拼接字符串,内存有界
 *   (任一时刻仅持有:单行缓冲 ≤ 单行预算、结果条目 ≤ 条目预算);
 * - 只支持明确的 Extended M3U 字段:#EXTM3U、#EXTINF:<duration> 属性区 + 逗号后标题,
 *   后随一行播放地址收口为条目;未知 #EXT 指令/普通注释忽略;#EXT-X-*(HLS 分片清单)
 *   不是频道列表,立即以 NOT_CHANNEL_LIST 拒绝(research R2);
 * - 预算逐项执行(T010 IMPORT_BUDGETS,直接 import 不复制数值):
 *   流中累计字节数 / 条目数 / 单行字节,任一超限整次失败,不截断不跳过(FR-005);
 * - 失败语义:抛 M3UParseFailure(稳定 code,见下方常量);message 只含行号与语义,
 *   绝不携带 URL/凭据/行原文(research R3:地址可能带密钥,日志与错误不得回显);
 * - 解析层只输出原始身份材料:tvgId 原文(或 null)与完整 url 原样保留,
 *   SHA-256 摘要与重复身份冲突判定由后续 staging/catalog-diff 任务负责(research R6)。
 */

/** 稳定错误码:M3U 解析失败类别(测试断言与日志只允许携带 code,不携带原文) */
export const M3U_FORMAT_INVALID = 'M3U_FORMAT_INVALID' as const;
export const M3U_ENTRY_MISSING_URL = 'M3U_ENTRY_MISSING_URL' as const;
export const M3U_BUDGET_EXCEEDED = 'M3U_BUDGET_EXCEEDED' as const;
export const M3U_NOT_CHANNEL_LIST = 'M3U_NOT_CHANNEL_LIST' as const;
export const M3U_DECODE_FAILED = 'M3U_DECODE_FAILED' as const;

export type M3UErrorCode =
  | typeof M3U_FORMAT_INVALID
  | typeof M3U_ENTRY_MISSING_URL
  | typeof M3U_BUDGET_EXCEEDED
  | typeof M3U_NOT_CHANNEL_LIST
  | typeof M3U_DECODE_FAILED;

/** M3U 解析失败:code 稳定可区分;message 不含 URL/凭据/行原文 */
export class M3UParseFailure extends Error {
  readonly code: M3UErrorCode;

  constructor(code: M3UErrorCode, message: string) {
    super(message);
    this.name = 'M3UParseFailure';
    this.code = code;
  }
}

/** 单条频道条目 —— 解析层输出的原始身份材料,不做摘要/归一化(research R6) */
export interface M3UEntry {
  /** EXTINF tvg-id 属性原文;缺失(含空值)为 null,由下游以完整播放地址派生身份 */
  tvgId: string | null;
  /** 标题:取 EXTINF 逗号后文本,缺失回退 tvg-name,两者皆缺属非法(不用 URL 兜底) */
  title: string;
  /** 完整播放地址原文:保留大小写/query/凭据,脱敏是展示层责任 */
  url: string;
}

export interface M3UParseResult {
  entries: M3UEntry[];
}

/** 单个 #EXTINF 行的待收口信息(等待后随播放地址行) */
interface PendingEntryInfo {
  tvgId: string | null;
  tvgName: string | null;
  /** EXTINF 逗号后的原始标题文本;空串表示缺失 */
  title: string;
  /** 记录 EXTINF 所在行号,供标题缺失报错定位 */
  lineNumber: number;
}

/** #EXTINF: 后属性区取 key="value" 原文;缺失或空值返回 null(空值等同缺失) */
function attrValue(section: string, name: string): string | null {
  // name 为固定字面量,拼接正则安全;(?:^|\s) 防止匹配 xxx-tvg-id 之类的键名
  const match = section.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  const value = match?.[1];
  return value !== undefined && value !== '' ? value : null;
}

/** 逐行状态机:消费解码后的文本行,产出条目;全部预算与失败语义集中在此 */
class M3UStreamParser {
  private readonly entries: M3UEntry[] = [];
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private pending: PendingEntryInfo | null = null;
  /** 未遇到换行符的行内缓冲(字符) */
  private lineBuffer = '';
  /** 行内缓冲已累计的 UTF-8 字节数(与字符数可能不同) */
  private lineBytes = 0;
  /** 已提交的行号(错误信息定位用,不含行原文) */
  private lineNumber = 0;
  /** 流中累计的原始字节数(含换行/BOM) */
  private totalBytes = 0;

  /** 消费一个原始字节块:先执行总字节预算,再流式解码为文本并按行推进状态机 */
  consumeChunk(chunk: Buffer): void {
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > IMPORT_BUDGETS.M3U_MAX_BYTES) {
      throw new M3UParseFailure(M3U_BUDGET_EXCEEDED, `M3U 总字节超过 ${IMPORT_BUDGETS.M3U_MAX_BYTES} 字节预算`);
    }
    let text: string;
    try {
      // stream: true 保留跨块的多字节序列;fatal: true 使非法 UTF-8 立即抛错
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      throw new M3UParseFailure(M3U_DECODE_FAILED, `第 ${this.lineNumber + 1} 行附近存在非法 UTF-8 字节,解码失败`);
    }
    this.feedText(text);
  }

  /** 流结束:冲刷解码器(截断的多字节序列在此报错)与最后一行,执行收尾校验 */
  finish(): M3UParseResult {
    try {
      // 无参调用冲刷内部状态:流在多字节字符中间结束时此处抛错
      this.decoder.decode();
    } catch {
      throw new M3UParseFailure(M3U_DECODE_FAILED, '文件在多字节字符中间结束,UTF-8 解码失败');
    }
    if (this.lineBuffer !== '') {
      const raw = this.lineBuffer;
      const rawBytes = this.lineBytes;
      this.lineBuffer = '';
      this.lineBytes = 0;
      this.commitLine(raw, rawBytes);
    }
    if (this.pending !== null) {
      throw new M3UParseFailure(
        M3U_ENTRY_MISSING_URL,
        `第 ${this.pending.lineNumber} 行的 #EXTINF 缺少后随播放地址行(文件已结束)`,
      );
    }
    if (this.entries.length === 0) {
      // research R2:M3U8 在本期是频道列表输入,HLS 分片清单/空内容不是频道目录
      throw new M3UParseFailure(M3U_NOT_CHANNEL_LIST, '内容不含任何 #EXTINF 频道记录,不是频道列表');
    }
    return { entries: this.entries };
  }

  /** 按行切分解码文本:\n 为行结束符;行尾 \r 在提交时剥离(覆盖 \r\n 跨块场景) */
  private feedText(text: string): void {
    let index = 0;
    while (index < text.length) {
      const newlineIndex = text.indexOf('\n', index);
      if (newlineIndex === -1) {
        this.appendLineSegment(text.slice(index), false);
        return;
      }
      this.appendLineSegment(text.slice(index, newlineIndex), true);
      index = newlineIndex + 1;
    }
  }

  private appendLineSegment(segment: string, terminated: boolean): void {
    if (segment !== '') {
      this.lineBuffer += segment;
      this.lineBytes += Buffer.byteLength(segment, 'utf8');
      // +1 容忍被块边界拆开的行尾 \r(\r\n 场景提交时扣除);超限即刻失败,内存有界
      if (this.lineBytes > IMPORT_BUDGETS.M3U_MAX_LINE_BYTES + 1) {
        throw new M3UParseFailure(
          M3U_BUDGET_EXCEEDED,
          `第 ${this.lineNumber + 1} 行超过单行 ${IMPORT_BUDGETS.M3U_MAX_LINE_BYTES} 字节预算`,
        );
      }
    }
    if (terminated) {
      const raw = this.lineBuffer;
      const rawBytes = this.lineBytes;
      this.lineBuffer = '';
      this.lineBytes = 0;
      this.commitLine(raw, rawBytes);
    }
  }

  private commitLine(raw: string, rawBytes: number): void {
    this.lineNumber += 1;
    let line = raw;
    let bytes = rawBytes;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
      bytes -= 1;
    }
    // 单行预算按「行内容(不含行结束符)」计:恰等预算值通过,严格大于失败
    if (bytes > IMPORT_BUDGETS.M3U_MAX_LINE_BYTES) {
      throw new M3UParseFailure(
        M3U_BUDGET_EXCEEDED,
        `第 ${this.lineNumber} 行超过单行 ${IMPORT_BUDGETS.M3U_MAX_LINE_BYTES} 字节预算`,
      );
    }
    this.handleLine(line);
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (line === '') {
      return; // 空行/纯空白行忽略
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#EXTINF:')) {
        this.beginEntry(line);
        return;
      }
      if (line.startsWith('#EXT-X-')) {
        throw new M3UParseFailure(M3U_NOT_CHANNEL_LIST, `第 ${this.lineNumber} 行为 HLS 分片清单指令,不是频道列表`);
      }
      return; // #EXTM3U、普通注释与其他未知 #EXT 指令:忽略,不算非法
    }
    this.completeEntry(line);
  }

  /** #EXTINF 行:记录 tvg-id/tvg-name/标题,等待后随播放地址行收口 */
  private beginEntry(line: string): void {
    if (this.pending !== null) {
      throw new M3UParseFailure(
        M3U_ENTRY_MISSING_URL,
        `第 ${this.pending.lineNumber} 行的 #EXTINF 缺少后随播放地址行`,
      );
    }
    const body = line.slice('#EXTINF:'.length);
    // 标题 = 属性区之后第一个不在引号内的逗号之后的全部文本(标题自身可含逗号/引号)
    let commaIndex = -1;
    let inQuotes = false;
    for (let index = 0; index < body.length; index += 1) {
      const char = body.charAt(index);
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        commaIndex = index;
        break;
      }
    }
    const attrSection = commaIndex === -1 ? body : body.slice(0, commaIndex);
    const rawTitle = commaIndex === -1 ? '' : body.slice(commaIndex + 1).trim();
    this.pending = {
      tvgId: attrValue(attrSection, 'tvg-id'),
      tvgName: attrValue(attrSection, 'tvg-name'),
      title: rawTitle,
      lineNumber: this.lineNumber,
    };
  }

  /** 播放地址行:与前置 #EXTINF 收口为条目,并执行条目数预算 */
  private completeEntry(url: string): void {
    const pending = this.pending;
    if (pending === null) {
      // message 不携带地址原文:地址可能携带凭据(research R3)
      throw new M3UParseFailure(M3U_FORMAT_INVALID, `第 ${this.lineNumber} 行播放地址缺少前置 #EXTINF 行`);
    }
    let title = pending.title;
    if (title === '') {
      title = pending.tvgName ?? '';
    }
    if (title === '') {
      // 无名称兜底、不用 URL 兜底名称:标题与 tvg-name 皆缺失即非法
      throw new M3UParseFailure(
        M3U_FORMAT_INVALID,
        `第 ${pending.lineNumber} 行的 #EXTINF 缺少标题(标题与 tvg-name 均未提供)`,
      );
    }
    this.pending = null;
    this.entries.push({ tvgId: pending.tvgId, title, url });
    if (this.entries.length > IMPORT_BUDGETS.M3U_MAX_ENTRIES) {
      throw new M3UParseFailure(M3U_BUDGET_EXCEEDED, `条目数超过 ${IMPORT_BUDGETS.M3U_MAX_ENTRIES} 预算`);
    }
  }
}

/**
 * 解析 M3U 播放列表(T022 对外入口):
 * 消费 Readable 或任意 AsyncIterable<Buffer>,逐块解码推进状态机,
 * 成功返回全部条目;任一预算超限/条目非法/解码失败抛 M3UParseFailure(整次失败)。
 * 流读取本身的传输错误原样向上传播(网络读取与预算由 safe-http-reader 任务负责)。
 */
export async function parseM3U(input: Readable | AsyncIterable<Buffer>): Promise<M3UParseResult> {
  const parser = new M3UStreamParser();
  for await (const chunk of input) {
    // Readable 在对象模式下可能给出 string;统一归一为 Buffer(契约输入为二进制块)
    parser.consumeChunk(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return parser.finish();
}
