import type { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import { LOGO_URL_MAX_LENGTH, normalizeLogoUrl } from '@contexts/sources/infrastructure/logo-url';
// 016 T018(US3 多线路聚合):归一键复用 live-tv 领域纯函数 normalizeChannelKey
// (research R1「命中相同规范化 key 的流合并为同一逻辑频道的备用线路」)。
// 跨上下文只读 import 领域纯函数(零 IO/零框架依赖,无行为副作用);落点为
// live-tv/domain 深路径,属 dependency-cruiser R2「跨上下文落点仅限发布面 index」
// 的豁免申请点 —— 待 live-tv 所有权代理在 index.ts 再导出后应收口为
// `import { normalizeChannelKey } from '@contexts/live-tv'`(功能与本注释同步移除)。
import { normalizeChannelKey } from '@contexts/live-tv/domain/channel-normalizer';

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
 *   SHA-256 摘要与重复身份冲突判定由后续 staging/catalog-diff 任务负责(research R6);
 * - 014 T014:EXTINF 额外捕获 tvg-logo 属性并做解析层归一化(沿 group_title 先例,
 *   research R1):trim 后 9~2048 字符且仅 http/https scheme,不满足一律归 null ——
 *   Logo 是装饰性证据,坏数据按缺失处理(FR-010),绝不让解析失败或抛错;
 *   值域与 0009 source_entry.logo_url CHECK(NULL 或 http(s) 且 9~2048)一致,
 *   保证发布层永不写入会撞 CHECK 的地址。
 */

/** 稳定错误码:M3U 解析失败类别(测试断言与日志只允许携带 code,不携带原文) */
export const M3U_FORMAT_INVALID = 'M3U_FORMAT_INVALID' as const;
export const M3U_ENTRY_MISSING_URL = 'M3U_ENTRY_MISSING_URL' as const;
export const M3U_BUDGET_EXCEEDED = 'M3U_BUDGET_EXCEEDED' as const;
export const M3U_NOT_CHANNEL_LIST = 'M3U_NOT_CHANNEL_LIST' as const;
export const M3U_DECODE_FAILED = 'M3U_DECODE_FAILED' as const;
/** T146:group-title trim 后超长(>100,存储值域上限)→ 按既定验证失败整次拒绝,不截断伪造 */
export const M3U_GROUP_TITLE_INVALID = 'M3U_GROUP_TITLE_INVALID' as const;

export type M3UErrorCode =
  | typeof M3U_FORMAT_INVALID
  | typeof M3U_ENTRY_MISSING_URL
  | typeof M3U_BUDGET_EXCEEDED
  | typeof M3U_NOT_CHANNEL_LIST
  | typeof M3U_DECODE_FAILED
  | typeof M3U_GROUP_TITLE_INVALID;

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
  /**
   * T146(005 data-model §2):EXTINF group-title,存储值域已归一化 ——
   * trim 后 1~100 字符;属性缺失/空白归 NULL(字段省略,规范化 JSON 不写入);
   * trim 后超长(>100)→ M3U_GROUP_TITLE_INVALID 整次失败,不截断伪造分组。
   */
  groupTitle?: string | null;
  /**
   * 014 T014(014 data-model §1):EXTINF tvg-logo 归一化产物 ——
   * trim 后 9~2048 字符且仅 http/https scheme(原文保留,大小写/query 不改写);
   * 属性缺失/空值/trim 超长/非法 scheme 一律 null(按缺失处理,FR-010 不失败)。
   */
  tvgLogo: string | null;
}

/** group-title 存储值域上界(与 source_entry_group_title_check 一致;T146) */
export const M3U_GROUP_TITLE_MAX_LENGTH = 100;

/**
 * 014 T014:tvg-logo 存储值域上界(与 0009 source_entry.logo_url_check 的 2048 上界一致);
 * trim 后超长不失败不截断,直接归 null 丢弃(FR-010:Logo 数据质量绝不阻塞导入)。
 * 数值唯一事实源已收敛至 logo-url.ts 的 LOGO_URL_MAX_LENGTH(014 T032 起 XMLTV icon
 * 共用同一归一化实现);本常量为既有发布面的再导出别名(测试与既有引用不破)。
 */
export const M3U_LOGO_MAX_LENGTH = LOGO_URL_MAX_LENGTH;

export interface M3UParseResult {
  entries: M3UEntry[];
}

/** 单个 #EXTINF 行的待收口信息(等待后随播放地址行) */
interface PendingEntryInfo {
  tvgId: string | null;
  tvgName: string | null;
  /** group-title 属性原文;缺失/空值(null)等同无分组 */
  groupTitle: string | null;
  /** tvg-logo 属性原文(未归一化);缺失/空值(null)等同无 Logo */
  tvgLogo: string | null;
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

/**
 * 014 T014:tvg-logo 解析层归一化(research R1;沿 group_title 的 trim 先例):
 * trim 后 9~2048 字符且仅 http/https scheme(大小写不敏感,与 0009 CHECK 的 LIKE
 * 口径一致),原文保留不转小写;不满足一律归 null(非法输入按缺失处理,绝不抛错
 * —— FR-010:解析含坏 logo 的整份文件不失败)。
 * 014 T032 起实现收敛至 logo-url.ts 的 normalizeLogoUrl(M3U/XMLTV 唯一共享实现)。
 */

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

  /** #EXTINF 行:记录 tvg-id/tvg-name/group-title/tvg-logo/标题,等待后随播放地址行收口 */
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
      groupTitle: attrValue(attrSection, 'group-title'),
      tvgLogo: attrValue(attrSection, 'tvg-logo'),
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
    // T146:group-title 归一化(trim;空白/缺失省略字段 = NULL;超长整次失败不截断)
    let groupTitle: string | null | undefined;
    if (pending.groupTitle !== null) {
      const trimmed = pending.groupTitle.trim();
      if (trimmed === '') {
        groupTitle = undefined; // 空白归 NULL:payload 不写字段
      } else if (trimmed.length > M3U_GROUP_TITLE_MAX_LENGTH) {
        throw new M3UParseFailure(
          M3U_GROUP_TITLE_INVALID,
          `第 ${pending.lineNumber} 行的 group-title 超过 ${M3U_GROUP_TITLE_MAX_LENGTH} 字符上限,拒绝截断伪造分组`,
        );
      } else {
        groupTitle = trimmed;
      }
    }
    // 014 T014:tvg-logo 归一化(trim;9~2048 且仅 http/https;非法一律 null,绝不失败 —— FR-010)
    const tvgLogo = normalizeLogoUrl(pending.tvgLogo);
    this.pending = null;
    this.entries.push({ tvgId: pending.tvgId, title, url, groupTitle, tvgLogo });
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

/* ------------------------------------------------------------------ */
/* 016 T018(US3 多线路聚合):线路属性派生纯函数                            */
/* ------------------------------------------------------------------ */
/* 016 research R1/data-model §2.1:同名流(归一键相同)聚合为单 media_item 的多条  */
/* 线路(source_entry);线路元数据 label/priority 为派生属性,本节集中其确定性公式: */
/* - channelKeyOf:复用 live-tv normalizeChannelKey(单点复用,聚合与投影共用同键);   */
/* - extractLineDifferenceLabel:线路差异段 = 括注段原文,缺省回退清晰度噪音词;      */
/* - deriveLinePriority:来源 priority(越小越优)+ 清晰度罚分(越清晰罚分越小);     */
/* - buildLineLabel:「线路 N [差异段|来源名]」公开投影形态(resolve 组装共用)。      */
/* 全部为零 IO 纯函数,导入发布事务与播放解析只读消费,规则改动一处生效。            */

/**
 * 频道归一键(016 R1 聚合键):委托 live-tv normalizeChannelKey 的单点薄封装。
 * 空串语义与上游一致 = 「无法归一化」,调用方(发布聚合)按不同名不合并处理。
 */
export function channelKeyOf(rawTitle: string): string {
  return normalizeChannelKey(rawTitle);
}

/** 清晰度规则表(罚分升序 = 清晰度降序;词边界判定与 channel-normalizer 同口径):
 *  - 字母开头 ASCII 词(hd/sd/fhd/uhd)仅被字母前邻阻挡(允许紧邻数字,cctv-1hd → hd);
 *  - 数字开头 ASCII 词(4k/8k/1080p/720p/1080i)仅被数字前邻阻挡(允许紧邻字母,cctv4k 不算);
 *  - CJK 词无词边界概念,直接命中(超高清 先于 高清 由规则序与整词保证)。 */
const LINE_CLARITY_RULES: ReadonlyArray<{
  readonly penalty: number;
  readonly ascii: readonly string[];
  readonly cjk: readonly string[];
}> = [
  { penalty: 0, ascii: ['8k', 'uhd'], cjk: ['超高清'] },
  { penalty: 2, ascii: ['4k'], cjk: [] },
  { penalty: 4, ascii: ['1080p', '1080i', 'fhd'], cjk: ['蓝光'] },
  { penalty: 8, ascii: ['720p', 'hd'], cjk: ['高清', '超清'] },
  { penalty: 16, ascii: ['sd'], cjk: ['标清'] },
];

/** ASCII 词边界判定(与 channel-normalizer isRemovableNoise 同口径的正则形):
 *  字母开头词前邻禁 [a-z](防 shenzhen 误伤);数字开头词前邻禁 [0-9](防 2048 误伤);
 *  后邻一律禁 [a-z0-9](防词内片段)。 */
function asciiClarityPattern(token: string): RegExp {
  const digitLed = /^[0-9]/.test(token);
  const before = digitLed ? '(?<![0-9])' : '(?<![a-z])';
  return new RegExp(`${before}${token}(?![a-z0-9])`, 'i');
}

/** 逐规则命中清晰度词,返回原文(大小写不折损)命中列表(规则序即清晰度序,去重) */
function matchedClarityTokens(rawTitle: string): string[] {
  const lower = rawTitle.toLowerCase();
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const rule of LINE_CLARITY_RULES) {
    for (const token of rule.cjk) {
      if (lower.includes(token) && !seen.has(token)) {
        seen.add(token);
        tokens.push(token);
      }
    }
    for (const token of rule.ascii) {
      const match = asciiClarityPattern(token).exec(rawTitle);
      if (match !== null && !seen.has(match[0].toLowerCase())) {
        seen.add(match[0].toLowerCase());
        tokens.push(match[0]);
      }
    }
  }
  return tokens;
}

/** 括注段提取(与 channel-normalizer 的包裹段同形:[]/()/【】;取内文原文) */
const LINE_BRACKET_PATTERN = /\[[^\][]*\]|\([^()]*\)|【[^【】]*】/g;

/**
 * 线路差异段提取(016 T018,保守规则):
 * 1) 优先取原始名中的括注段内文([1080P]/(备用)/【超清】;多段以空格连接,原文保留);
 * 2) 无括注时回退清晰度噪音词原文(1080P/4K/高清…);
 * 3) 两者皆无 → 空串(调用方以来源名兜底,即 buildLineLabel 的回退语义)。
 * 刻意不做:语义词识别(「备用/主源/联通」等)—— 无可靠判据,误标风险高(保守不做项)。
 */
export function extractLineDifferenceLabel(rawTitle: string): string {
  const bracketContents: string[] = [];
  for (const match of rawTitle.matchAll(LINE_BRACKET_PATTERN)) {
    const inner = match[0].slice(1, -1).trim();
    if (inner !== '') {
      bracketContents.push(inner);
    }
  }
  if (bracketContents.length > 0) {
    return bracketContents.join(' ');
  }
  return matchedClarityTokens(rawTitle).join(' ');
}

/**
 * 线路排序权重(016 T018 确定性公式,写明供测试与评审核对):
 *   priority = 来源 priority(media_source.priority,缺省 100)+ 清晰度罚分
 * 清晰度罚分:8K/UHD/超高清 0 → 4K 2 → 1080P/1080i/FHD/蓝光 4 → 720P/HD/高清/超清 8
 * → SD/标清 16;未标注 = 0(中性 —— 不改变来源顺序,既有无标注导入行为零变化)。
 * 数值越小越优先(priority ASC);同分由调用方以 lineId 二进制升序决胜(确定性投影)。
 * sourcePriority 非有限数值(部分迁移库缺列的 SELECT * 读取)按缺省 100 兜底。
 */
export function deriveLinePriority(sourcePriority: number | undefined, rawTitle: string): number {
  const base = typeof sourcePriority === 'number' && Number.isFinite(sourcePriority) && sourcePriority >= 0 ? sourcePriority : 100;
  const lower = rawTitle.toLowerCase();
  for (const rule of LINE_CLARITY_RULES) {
    if (rule.cjk.some((token) => lower.includes(token))) {
      return base + rule.penalty;
    }
    if (rule.ascii.some((token) => asciiClarityPattern(token).test(rawTitle))) {
      return base + rule.penalty;
    }
  }
  return base;
}

/**
 * 线路公开标签(016 data-model §2.1/api.md §2.1:「线路 1 [1080P]」形态):
 * 差异段优先(导入侧可由原始名提取),缺失回退来源名;两者皆缺省略方括号。
 * resolve 侧受「原始名不入库(无持久化列)」所限,差异段恒走来源名回退(任务书
 * 「优先用清洗差异/来源名」的保守分支);导入侧纯函数面已由 extractLineDifferenceLabel 承载。
 */
export function buildLineLabel(ordinal: number, differenceLabel: string, fallbackSourceTitle: string): string {
  const suffix = differenceLabel !== '' ? differenceLabel : fallbackSourceTitle;
  return suffix === '' ? `线路 ${ordinal}` : `线路 ${ordinal} [${suffix}]`;
}
