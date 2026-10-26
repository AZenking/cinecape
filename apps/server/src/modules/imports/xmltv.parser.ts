import { StringDecoder } from 'node:string_decoder';
import { createGunzip, type Gunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { IMPORT_BUDGETS } from '../../config/import-budgets';

/**
 * XMLTV 流式解析器(T024,research R2/R6):
 * - sax strict(strictEntities)流式解析,拒绝 DOCTYPE/外部实体声明/未知实体/畸形 XML/过深嵌套;
 * - 输入为 gzip 字节流(magic 1f 8b)时自动经 zlib 解压,压缩前后字节独立计数,不递归解压;
 * - XMLTV 时间必须携带时区,统一转 UTC;窗口缺省不过滤,传入窗口时仅保留相交节目(闭区间);
 * - channel id 重复、同频道节目时间重叠 → 该频道标记 conflicted;
 * - 缺必要字段/非法时间/预算超限 → 整次失败(抛 XMLTVParseFailure,稳定 code),
 *   不截断、不跳过(FR-005);错误信息只含稳定描述,不含原始 XML 片段与 URL(脱敏要求)。
 */

/** 稳定错误码:解析失败原因的唯一标识(导入任务 error_code、HTTP Problem Details 复用)。 */
export const FORMAT_INVALID = 'FORMAT_INVALID';
export const DOCTYPE_DENIED = 'DOCTYPE_DENIED';
export const UNKNOWN_ENTITY = 'UNKNOWN_ENTITY';
export const DEPTH_EXCEEDED = 'DEPTH_EXCEEDED';
export const BUDGET_TRANSFER = 'BUDGET_TRANSFER';
export const BUDGET_DECOMPRESSED = 'BUDGET_DECOMPRESSED';
export const BUDGET_ENTRIES = 'BUDGET_ENTRIES';
export const FIELD_TOO_LONG = 'FIELD_TOO_LONG';
export const TIME_INVALID = 'TIME_INVALID';
export const TIMEZONE_MISSING = 'TIMEZONE_MISSING';
export const REQUIRED_FIELD_MISSING = 'REQUIRED_FIELD_MISSING';
export const DUPLICATE_DECLINED = 'DUPLICATE_DECLINED';

/** 错误码集合(便于上层校验/穷举)。 */
export const XMLTV_ERROR = {
  FORMAT_INVALID,
  DOCTYPE_DENIED,
  UNKNOWN_ENTITY,
  DEPTH_EXCEEDED,
  BUDGET_TRANSFER,
  BUDGET_DECOMPRESSED,
  BUDGET_ENTRIES,
  FIELD_TOO_LONG,
  TIME_INVALID,
  TIMEZONE_MISSING,
  REQUIRED_FIELD_MISSING,
  DUPLICATE_DECLINED,
} as const;

export type XMLTVErrorCode = (typeof XMLTV_ERROR)[keyof typeof XMLTV_ERROR];

/** 解析失败:携带稳定 code;message 已脱敏(不含原文片段、URL、用户数据)。 */
export class XMLTVParseFailure extends Error {
  readonly code: XMLTVErrorCode;

  constructor(code: XMLTVErrorCode, message: string) {
    super(message);
    this.name = 'XMLTVParseFailure';
    this.code = code;
  }
}

/** 单个 XMLTV 频道声明(展示名可选,缺省为 null)。 */
export interface XMLTVChannel {
  xmltvChannelId: string;
  displayName: string | null;
}

/** 单个节目(时间已归一 UTC;描述可选,缺省为 null)。 */
export interface XMLTVProgramme {
  xmltvChannelId: string;
  title: string;
  description: string | null;
  startsAtUtc: Date;
  endsAtUtc: Date;
}

/** 解析结果:conflictedChannelIds 为冲突频道 id 列表(重复声明或节目时间重叠)。 */
export interface XMLTVParseResult {
  channels: XMLTVChannel[];
  programmes: XMLTVProgramme[];
  conflictedChannelIds: Set<string> | string[];
}

/** 解析选项:窗口两端均可独立缺省;全部缺省 = 不过滤。 */
export interface XMLTVParseOptions {
  windowStartUtc?: Date;
  windowEndUtc?: Date;
}

/** sax@1.4.1 未随包发布类型声明,且不允许新增 @types 依赖:此处内联本解析器用到的最小 API 面。 */
interface SaxTagInfo {
  name: string;
  attributes: Record<string, string>;
}

interface SaxProcessingInstruction {
  name: string;
  body: string;
}

interface SaxParser {
  write(input: string): SaxParser;
  close(): void;
  onerror: ((error: Error) => void) | undefined;
  onopentag: ((tag: SaxTagInfo) => void) | undefined;
  onclosetag: ((tag: SaxTagInfo | string) => void) | undefined;
  ontext: ((text: string) => void) | undefined;
  ondoctype: ((doctype: string) => void) | undefined;
  onprocessinginstruction: ((pi: SaxProcessingInstruction) => void) | undefined;
}

type SaxModule = {
  parser: (strict: boolean, opt: { strictEntities: boolean }) => SaxParser;
};

let saxModulePromise: Promise<SaxModule> | null = null;

/**
 * 以非字面量动态导入加载 sax(绕过 TS 对无类型包的解析报错),结果缓存复用。
 * sax 是 CJS 包:ESM 运行时(tsx watch / node dist)的互操作把包主对象放在
 * `default` 上;vitest 的转换互操作则直接暴露在命名空间。两种形态都要兼容,
 * 否则运行时出现 `sax.parser is not a function`(vitest 单测不可见的偏差)。
 */
function loadSaxModule(): Promise<SaxModule> {
  saxModulePromise ??= (async () => {
    const mod = (await import('sax' as string)) as unknown as Record<string, unknown> & {
      default?: unknown;
    };
    const candidate = (mod.default ?? mod) as Partial<SaxModule> | undefined;
    if (candidate && typeof candidate.parser === 'function') {
      return candidate as SaxModule;
    }
    // 兜底:再探一层命名空间属性(某些互操作的双层包装)
    const nested = (mod.default as Record<string, unknown> | undefined)?.default as
      | Partial<SaxModule>
      | undefined;
    if (nested && typeof nested.parser === 'function') {
      return nested as SaxModule;
    }
    throw new Error('sax 模块加载失败:未找到 parser 工厂(运行时互操作形态未知)');
  })();
  return saxModulePromise;
}

/** 解析栈帧:channel/programme 载体帧与文本字段帧(title/desc/display-name)。 */
type Frame =
  | { kind: 'other' }
  | {
      kind: 'field';
      field: 'display-name' | 'title' | 'desc';
      textParts: string[];
      textBytes: number;
    }
  | {
      kind: 'channel';
      channelId: string;
      displayName: string | null;
      displayNameLocked: boolean;
    }
  | {
      kind: 'programme';
      channelId: string;
      startsAtUtc: Date;
      endsAtUtc: Date;
      title: string | null;
      description: string | null;
      titleCommitted: boolean;
      descCommitted: boolean;
    };

/** XMLTV 时间:YYYYMMDDHHmmss [+-]HHMM(或 Z);必须带时区,输出 UTC。 */
function parseXmltvTime(
  raw: string,
  failOnce: (code: XMLTVErrorCode, message: string) => void,
): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}|Z))?$/.exec(raw);
  if (match === null) {
    failOnce(TIME_INVALID, 'XMLTV 时间格式非法,应为 YYYYMMDDHHmmss 加时区(+HHMM/-HHMM 或 Z)');
    return null;
  }
  const tz = match[7];
  if (tz === undefined) {
    failOnce(TIMEZONE_MISSING, 'XMLTV 时间必须携带时区(+HHMM/-HHMM 或 Z)');
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  let offsetMinutes = 0;
  if (tz !== 'Z') {
    const sign = tz.startsWith('-') ? -1 : 1;
    const offsetHour = Number(tz.slice(1, 3));
    const offsetMinute = Number(tz.slice(3, 5));
    if (
      !Number.isInteger(offsetHour) ||
      offsetHour < 0 ||
      offsetHour > 23 ||
      !Number.isInteger(offsetMinute) ||
      offsetMinute < 0 ||
      offsetMinute > 59
    ) {
      failOnce(TIME_INVALID, 'XMLTV 时间的时区偏移非法');
      return null;
    }
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  // 日历溢出检测(如 20260230、25 时):先对未加偏移的 UTC 原值回读比对各分量。
  const rawMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const rawDate = new Date(rawMs);
  if (
    rawDate.getUTCFullYear() !== year ||
    rawDate.getUTCMonth() !== month - 1 ||
    rawDate.getUTCDate() !== day ||
    rawDate.getUTCHours() !== hour ||
    rawDate.getUTCMinutes() !== minute ||
    rawDate.getUTCSeconds() !== second
  ) {
    failOnce(TIME_INVALID, 'XMLTV 时间不是日历中存在的时刻');
    return null;
  }
  // 再应用时区偏移换算为 UTC 时刻。
  return new Date(rawMs - offsetMinutes * 60 * 1000);
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  // Uint8Array 视图(含裸 Buffer 被逐字节迭代后的 number 等)按视图字节重建,
  // 避免把「字节数值」误转为十进制文本(曾致 sax 收到 "60" 而非 "<")。
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return Buffer.from(String(value), 'utf8');
}

/** 把 Readable/AsyncIterable 归一为 Buffer 异步生成器;提前终止时向上关闭底层流。
 *  注意:Buffer/Uint8Array 本身是同步可迭代(逐字节),必须整体视为单个 chunk,
 *  只有真正的流/异步可迭代才逐块展开。 */
async function* toBufferIterator(
  input: Readable | AsyncIterable<Buffer> | Buffer,
): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(input)) {
    yield input;
    return;
  }
  if (ArrayBuffer.isView(input)) {
    yield toBuffer(input);
    return;
  }
  for await (const chunk of input as AsyncIterable<unknown>) {
    yield toBuffer(chunk);
  }
}

async function closeIterator(iterator: AsyncGenerator<Buffer>): Promise<void> {
  try {
    await iterator.return(undefined);
  } catch {
    // 关闭失败不影响主失败语义
  }
}

/** 等待 gunzip 背压释放;error/close 时同样放行以免悬挂。 */
function waitForDrain(stream: Gunzip): Promise<void> {
  return new Promise<void>((resolve) => {
    const release = (): void => {
      stream.off('drain', release);
      stream.off('close', release);
      resolve();
    };
    stream.once('drain', release);
    stream.once('close', release);
  });
}

/**
 * 解析 XMLTV 流。
 * @param input 明文或 gzip 压缩的 XMLTV 字节流(Readable 或 AsyncIterable<Buffer>)
 * @param opts 刷新窗口(缺省不过滤);仅保留与 [windowStartUtc, windowEndUtc] 闭区间相交的节目
 * @throws XMLTVParseFailure 任一安全/预算/格式/字段条件不满足时整次失败
 */
export async function parseXMLTV(
  input: Readable | AsyncIterable<Buffer> | Buffer,
  opts: XMLTVParseOptions = {},
): Promise<XMLTVParseResult> {
  const sax = await loadSaxModule();
  const parser = sax.parser(true, { strictEntities: true });

  // —— 失败通道:首个失败生效,后续事件全部短路 ——
  let failure: XMLTVParseFailure | null = null;
  const failOnce = (code: XMLTVErrorCode, message: string): void => {
    if (failure === null) {
      failure = new XMLTVParseFailure(code, message);
    }
  };

  // —— 收集状态 ——
  const channels: XMLTVChannel[] = [];
  const channelDisplayNames = new Map<string, string | null>();
  const collectedProgrammes: XMLTVProgramme[] = [];
  const conflictedChannelIds = new Set<string>();
  const stack: Frame[] = [];
  let depth = 0;
  let sawRoot = false;
  let programmeCount = 0;

  parser.onerror = (error: Error): void => {
    // sax strict 的未知实体错误消息含 entity 字样;其余按畸形 XML 处理。
    if (/entity/i.test(error?.message ?? '')) {
      failOnce(UNKNOWN_ENTITY, 'XMLTV 文档包含未声明的实体');
    } else {
      failOnce(FORMAT_INVALID, 'XMLTV 文档不是合法的 XML');
    }
  };
  parser.ondoctype = (): void => {
    // 内部子集与外部 SYSTEM/PUBLIC DTD 都会触发;一律拒绝以禁外部实体解析。
    failOnce(DOCTYPE_DENIED, 'XMLTV 文档不允许包含 DOCTYPE/DTD 声明');
  };
  parser.onprocessinginstruction = (pi: SaxProcessingInstruction): void => {
    // `<?xml ...?>` 文档声明同样走 PI 事件,必须放行;其余处理指令按声明类结构拒绝。
    if (pi.name.toLowerCase() !== 'xml') {
      failOnce(DOCTYPE_DENIED, 'XMLTV 文档不允许包含处理指令');
    }
  };

  parser.onopentag = (tag: SaxTagInfo): void => {
    if (failure !== null) return;
    depth += 1;
    if (depth > IMPORT_BUDGETS.XMLTV_MAX_DEPTH) {
      failOnce(DEPTH_EXCEEDED, `XMLTV 元素嵌套超过 ${IMPORT_BUDGETS.XMLTV_MAX_DEPTH} 层上限`);
      return;
    }
    if (stack.length === 0) {
      sawRoot = true;
    }
    const parent = stack[stack.length - 1];

    if (tag.name === 'channel') {
      const channelId = (tag.attributes['id'] ?? '').trim();
      if (channelId === '') {
        failOnce(REQUIRED_FIELD_MISSING, 'channel 缺少 id 属性');
        return;
      }
      stack.push({ kind: 'channel', channelId, displayName: null, displayNameLocked: false });
      return;
    }

    if (tag.name === 'programme') {
      programmeCount += 1;
      if (programmeCount > IMPORT_BUDGETS.XMLTV_MAX_PROGRAMMES) {
        failOnce(BUDGET_ENTRIES, `XMLTV 节目数量超过 ${IMPORT_BUDGETS.XMLTV_MAX_PROGRAMMES} 上限`);
        return;
      }
      const channelId = (tag.attributes['channel'] ?? '').trim();
      const startRaw = (tag.attributes['start'] ?? '').trim();
      const stopRaw = (tag.attributes['stop'] ?? '').trim();
      const missing: string[] = [];
      if (channelId === '') missing.push('channel');
      if (startRaw === '') missing.push('start');
      if (stopRaw === '') missing.push('stop');
      if (missing.length > 0) {
        failOnce(REQUIRED_FIELD_MISSING, `programme 缺少 ${missing.join('/')} 属性`);
        return;
      }
      const startsAtUtc = parseXmltvTime(startRaw, failOnce);
      if (startsAtUtc === null) return;
      const endsAtUtc = parseXmltvTime(stopRaw, failOnce);
      if (endsAtUtc === null) return;
      if (endsAtUtc.getTime() <= startsAtUtc.getTime()) {
        failOnce(TIME_INVALID, 'programme 的 stop 必须严格晚于 start');
        return;
      }
      stack.push({
        kind: 'programme',
        channelId,
        startsAtUtc,
        endsAtUtc,
        title: null,
        description: null,
        titleCommitted: false,
        descCommitted: false,
      });
      return;
    }

    // 文本字段帧:仅 channel 下的 display-name、programme 下的 title/desc 参与收集与限额。
    const field =
      parent !== undefined && parent.kind === 'channel' && tag.name === 'display-name'
        ? ('display-name' as const)
        : parent !== undefined && parent.kind === 'programme' && (tag.name === 'title' || tag.name === 'desc')
          ? (tag.name as 'title' | 'desc')
          : null;
    stack.push(
      field === null
        ? { kind: 'other' }
        : { kind: 'field', field, textParts: [], textBytes: 0 },
    );
  };

  parser.ontext = (text: string): void => {
    if (failure !== null) return;
    const top = stack[stack.length - 1];
    if (top === undefined || top.kind !== 'field') return;
    top.textParts.push(text);
    top.textBytes += Buffer.byteLength(text, 'utf8');
    if (top.textBytes > IMPORT_BUDGETS.XMLTV_MAX_FIELD_BYTES) {
      failOnce(FIELD_TOO_LONG, `${top.field} 字段超过单字段字节上限`);
    }
  };

  parser.onclosetag = (): void => {
    if (failure !== null) return;
    const frame = stack.pop();
    if (frame === undefined) return;
    depth -= 1;

    if (frame.kind === 'field') {
      const text = frame.textParts.join('').trim();
      const parent = stack[stack.length - 1];
      if (parent === undefined || text === '') return;
      if (frame.field === 'display-name' && parent.kind === 'channel' && !parent.displayNameLocked) {
        parent.displayName = text;
        parent.displayNameLocked = true;
      } else if (frame.field === 'title' && parent.kind === 'programme' && !parent.titleCommitted) {
        parent.title = text;
        parent.titleCommitted = true;
      } else if (frame.field === 'desc' && parent.kind === 'programme' && !parent.descCommitted) {
        parent.description = text;
        parent.descCommitted = true;
      }
      return;
    }

    if (frame.kind === 'channel') {
      const existing = channelDisplayNames.get(frame.channelId);
      if (existing === undefined) {
        channelDisplayNames.set(frame.channelId, frame.displayName);
        channels.push({ xmltvChannelId: frame.channelId, displayName: frame.displayName });
      } else if (existing !== frame.displayName) {
        // 同一 id 重复声明但展示名不一致:声明存在歧义,整次拒绝。
        failOnce(DUPLICATE_DECLINED, 'channel id 重复声明且 display-name 不一致,存在歧义');
      } else {
        // 完全一致的重复声明:按规格标记冲突频道,不失败。
        conflictedChannelIds.add(frame.channelId);
      }
      return;
    }

    if (frame.kind === 'programme') {
      if (frame.title === null) {
        failOnce(REQUIRED_FIELD_MISSING, 'programme 缺少 title 字段');
        return;
      }
      collectedProgrammes.push({
        xmltvChannelId: frame.channelId,
        title: frame.title,
        description: frame.description,
        startsAtUtc: frame.startsAtUtc,
        endsAtUtc: frame.endsAtUtc,
      });
    }
  };

  // —— 流驱动:字节计数 → gzip 探测/解压 → UTF-8 解码 → sax ——
  let transferBytes = 0;
  let decompressedBytes = 0;
  const decoder = new StringDecoder('utf8');
  const feed = (text: string): void => {
    if (failure !== null || text === '') return;
    parser.write(text);
  };
  const consumePlain = (chunk: Buffer): boolean => {
    decompressedBytes += chunk.length;
    if (decompressedBytes > IMPORT_BUDGETS.XMLTV_MAX_DECOMPRESSED_BYTES) {
      failOnce(BUDGET_DECOMPRESSED, `XMLTV 解压后字节超过 ${IMPORT_BUDGETS.XMLTV_MAX_DECOMPRESSED_BYTES} 上限`);
      return false;
    }
    feed(decoder.write(chunk));
    return failure === null;
  };

  const iterator = toBufferIterator(input);
  try {
    // gzip 魔数探测:至少积累 2 字节再判定;判定一次后不再改变(不递归解压)。
    let pending: Buffer | null = null;
    let gzipMode: boolean | null = null;
    let gunzip: Gunzip | null = null;
    let outputPump: Promise<void> | null = null;

    for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
      const chunk = toBuffer(step.value);
      transferBytes += chunk.length;
      if (transferBytes > IMPORT_BUDGETS.XMLTV_MAX_TRANSFER_BYTES) {
        failOnce(BUDGET_TRANSFER, `XMLTV 传输字节超过 ${IMPORT_BUDGETS.XMLTV_MAX_TRANSFER_BYTES} 上限`);
        break;
      }

      if (gzipMode === null) {
        pending = pending === null ? chunk : Buffer.concat([pending, chunk]);
        if (pending.length < 2) continue;
        gzipMode = pending[0] === 0x1f && pending[1] === 0x8b;
        if (!gzipMode) {
          const head = pending;
          pending = null;
          if (!consumePlain(head)) break;
          continue;
        }
        // gzip 分支:解压输出独立计数并喂给 sax;输入侧继续按压缩字节计入传输预算。
        gunzip = createGunzip();
        const gz = gunzip;
        outputPump = (async (): Promise<void> => {
          try {
            for await (const out of gz) {
              if (failure !== null) return;
              if (!consumePlain(toBuffer(out))) return;
            }
          } catch {
            failOnce(FORMAT_INVALID, 'XMLTV 的 gzip 数据无法解压');
          }
        })();
        const first = pending;
        pending = null;
        try {
          if (!gunzip.write(first)) await waitForDrain(gunzip);
        } catch {
          break;
        }
        if (failure !== null) break;
        continue;
      }

      if (gzipMode) {
        const gz = gunzip;
        if (gz === null) break;
        try {
          if (!gz.write(chunk)) await waitForDrain(gz);
        } catch {
          break;
        }
        if (failure !== null) break;
      } else {
        if (!consumePlain(chunk)) break;
      }
    }

    // 输入流在魔数判定前结束(总量不足 2 字节):按明文残留处理。
    if (gzipMode === false && pending !== null) {
      consumePlain(pending);
    }
    pending = null;

    if (gunzip !== null && outputPump !== null) {
      gunzip.end();
      await outputPump;
    }
  } catch (error) {
    if (error instanceof XMLTVParseFailure) throw error;
    failOnce(FORMAT_INVALID, 'XMLTV 输入流读取失败');
  } finally {
    await closeIterator(iterator);
  }

  if (failure !== null) throw failure;
  feed(decoder.end()); // 冲刷跨块多字节残尾
  parser.close(); // 触发未闭合标签等 strict 收尾错误
  if (failure !== null) throw failure;
  if (!sawRoot) {
    throw new XMLTVParseFailure(FORMAT_INVALID, 'XMLTV 文档缺少根元素');
  }

  // —— 后处理:窗口过滤(闭区间相交)→ 完全相同去重 → 同频道重叠扫描 ——
  const windowStartMs = opts.windowStartUtc?.getTime() ?? null;
  const windowEndMs = opts.windowEndUtc?.getTime() ?? null;
  const retained = collectedProgrammes.filter((programme) => {
    if (windowStartMs !== null && programme.endsAtUtc.getTime() < windowStartMs) return false;
    if (windowEndMs !== null && programme.startsAtUtc.getTime() > windowEndMs) return false;
    return true;
  });

  // 身份键 = 频道 + 起止时间:完全相同(含 title/desc)去重不算冲突;同键不同记录为重叠冲突。
  const seenByKey = new Map<string, XMLTVProgramme>();
  const programmes: XMLTVProgramme[] = [];
  for (const programme of retained) {
    const key = `${programme.xmltvChannelId}\u0000${programme.startsAtUtc.getTime()}\u0000${programme.endsAtUtc.getTime()}`;
    const previous = seenByKey.get(key);
    if (previous === undefined) {
      seenByKey.set(key, programme);
      programmes.push(programme);
      continue;
    }
    if (previous.title !== programme.title || previous.description !== programme.description) {
      conflictedChannelIds.add(programme.xmltvChannelId);
    }
  }

  // 逐频道按开始时间扫描:任两条区间相交(相邻不算)即标记冲突;窗口外已丢弃的节目不参与。
  const byChannel = new Map<string, XMLTVProgramme[]>();
  for (const programme of programmes) {
    const list = byChannel.get(programme.xmltvChannelId);
    if (list === undefined) {
      byChannel.set(programme.xmltvChannelId, [programme]);
    } else {
      list.push(programme);
    }
  }
  for (const [channelId, list] of byChannel) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(
      (a, b) =>
        a.startsAtUtc.getTime() - b.startsAtUtc.getTime() ||
        a.endsAtUtc.getTime() - b.endsAtUtc.getTime(),
    );
    const first = sorted[0];
    if (first === undefined) continue;
    let maxEndMs = first.endsAtUtc.getTime();
    for (const item of sorted.slice(1)) {
      if (item.startsAtUtc.getTime() < maxEndMs) {
        conflictedChannelIds.add(channelId);
      }
      if (item.endsAtUtc.getTime() > maxEndMs) {
        maxEndMs = item.endsAtUtc.getTime();
      }
    }
  }

  return { channels, programmes, conflictedChannelIds: Array.from(conflictedChannelIds) };
}
