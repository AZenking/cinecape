/**
 * 010 T025 — Apple CMS JSON adapter 解析层:wire 对象 + 预算 → 解析值(纯函数)。
 *
 * 纯函数边界:输入 wire 对象(test/fixtures/online-vod/fixture-upstream.ts T005 形态:
 * vod_play_from 以 `$$$` 分隔多线;vod_play_url 按 `$$$` 对应每线、集间 `#` 分隔、
 * 单集 `名称$地址`)+ 解析预算,输出纯值;零网络请求、零 Node API、零运行时依赖 ——
 * HTTP/字节预算属 T018 SafeUpstream 传输层,不在本文件钉面内。src 不 import test/,
 * wire 类型在本文件自足定义(结构与夹具 AppleCmsVodItem/AppleCmsListDocument 逐字段
 * 镜像,字段全部可选:上游缺字段属完整性校验输入,由解析层整体拒绝而非类型层假设)。
 *
 * 来源标注:
 * - docs/specs/010-online-vod/tasks.md T025(行为定义;「upstreamVodId/lineKey/
 *   episodeKey 1–255,NFC+trim 不得截断身份」「简介纯文本<=4096」「预算和完整性校验
 *   失败整体拒绝」逐字保留);
 * - 行为仲裁面:apps/server/test/unit/online-vod/provider-parser.spec.ts(010 T023,
 *   24 用例;文件头钉死:导出面/键推导/身份字符串级/unsupported 判定/整体拒绝错误码/
 *   预算边界/G 组 token 语义,T025 以使其全绿为完成定义);
 * - docs/specs/010-online-vod/data-model.md §1(NFC+trim/1–255/简介纯文本<=4096)、
 *   §2(vod_line「(title_id,line_key)唯一;重复/空 key 详情显示 unsupported」、
 *   vod_episode「(line_id,episode_key)唯一」)、§3(URL token 变化不加 catalogRevision、
 *   不因签名 URL 变化单独推进 sequenceRevision;失败/截断不发布);
 * - docs/specs/010-online-vod/contracts/api.md §2(「超限 422 整次失败」→ budget_exceeded;
 *   源根「只接受 http(s) 并校验」同口径延伸到上游定位地址 → protocol_unsupported)。
 *
 * 键推导(T023 文件头钉死的唯一自洽推导):
 * - upstreamVodId = NFC+trim(String(vod_id))(wire 数值 → 字符串身份);
 * - lineKey       = NFC+trim(vod_play_from `$$$` 段显示名);空 → null(该线 unsupported);
 * - episodeKey    = NFC+trim(`名称$地址` 的名称段,按**首个** `$` 分割,地址含 `$`
 *   不被吞进 label);空 → null(该集 unsupported/identity_ambiguous);
 * - 身份字符串级:'第01集' ≠ '第1集',绝不数值化;NFC 之外零折叠(不做 NFKC 宽度
 *   折叠/大小写折叠);
 * - 同一语义键归一相等:分解/组合归一相等 → 判重复;宽度异形是不同键(不误判重复);
 * - URL 不参与身份:locatorUrl 逐字透传(G 组:sign token 变化只体现为 locator)。
 *
 * 失败语义(整体拒绝 = 抛 ProviderParseError,错误码五值见 provider-model.ts):
 * 检查顺序为 完整性(envelope/play 字段/段数/`$` 分隔/url 非空)→ 身份有效性
 * (id/name 1–255 非空)→ 预算(线数/单线集数/合计集数)→ 逐段协议(http(s))→
 * 逐项身份与显示级 unsupported。显示级 unsupported(解析成功、仅条目标记):
 * - 线:空 key 或归一后重复 key 的镜像段(第 2+ 次出现)→ 整线 unsupported,
 *   其全部集 unsupported/identity_ambiguous;不合并、保序;首现保持 candidate;
 * - 集:label 空(episodeKey=null)或同线归一后重复 key(**两处都标**)→
 *   unsupported/identity_ambiguous;特典等非重复项不牵连;重复作用域=线;
 * - format_unsupported 在解析层不产生(留给上层定位/probe 阶段)。
 */

import {
  IDENTITY_KEY_MAX_LENGTH,
  POSTER_URL_MAX_LENGTH,
  SYNOPSIS_MAX_LENGTH,
  normalizeIdentity,
  ProviderParseError,
  type ParsedVodEntryStatus,
  type ParsedVodEpisode,
  type ParsedVodLine,
  type ParsedVodSearchItem,
  type ParsedVodTitleDetail,
  type ParsedVodUnsupportedReason,
  type ProviderParseErrorCode,
  type ProviderTitleIdentity,
} from '../domain/provider-model';

/* ------------------------------------------------------------------ */
/* wire 输入类型(与 test/fixtures/online-vod/fixture-upstream.ts 结构镜像) */
/* ------------------------------------------------------------------ */

/** Apple CMS v10 JSON 单条影片 wire(detail 形态;brief 形态播放字段为空串);
 *  字段全部可选 —— 上游缺字段按契约判 integrity_violation,不做类型层假设 */
export interface AppleCmsVodItemWire {
  vod_id?: number;
  type_id?: number;
  type_name?: string;
  vod_name?: string;
  vod_sub?: string;
  vod_en?: string;
  vod_letter?: string;
  vod_remarks?: string;
  vod_year?: string;
  vod_area?: string;
  vod_lang?: string;
  vod_version?: string;
  vod_actor?: string;
  vod_director?: string;
  vod_blurb?: string;
  vod_content?: string;
  vod_pubdate?: string;
  vod_total?: number;
  vod_serial?: string;
  vod_time?: string;
  vod_time_add?: number;
  /** 海报地址(展示级;解析层丢弃规则见 parsePosterUrl,不参与身份/完整性) */
  vod_pic?: string;
  vod_play_from?: string;
  vod_play_url?: string;
  vod_play_note?: string;
}

/** Apple CMS v10 JSON 列表信封 wire(code=1 成功) */
export interface AppleCmsListDocumentWire {
  code?: number;
  msg?: string;
  page?: number;
  pagecount?: number;
  limit?: string;
  total?: number;
  list?: readonly AppleCmsVodItemWire[];
}

/** 解析层预算入参(T023 钉面形态 { budgets: VOD_BUDGETS.detail };字节预算属
 *  T018 传输层不在解析层;宽化 number 形态兼容契约快照与运行期收紧配置) */
export interface VodParseDetailBudgets {
  readonly budgets: {
    readonly maxLines: number;
    readonly maxEpisodesPerLine: number;
    readonly maxEpisodesTotal: number;
  };
}

/* ------------------------------------------------------------------ */
/* 公开解析入口(全纯函数:输入 wire 对象 + 预算,不发请求)               */
/* ------------------------------------------------------------------ */

/** 搜索列表解析:信封完整性 → 逐条目身份(brief 形态播放字段为空不影响);
 *  任何条目身份/完整性失败整体拒绝(绝不截断/静默丢条目) */
export function parseSearchList(document: AppleCmsListDocumentWire): readonly ParsedVodSearchItem[] {
  const list = requireEnvelopeList(document);
  return list.map((item) => {
    const identity = buildIdentity(item);
    return {
      identity,
      title: identity.name,
      year: identity.year,
      remarks: toNullableText(readOptionalString(item.vod_remarks)),
      posterUrl: parsePosterUrl(item),
    };
  });
}

/** 详情信封解包:详情响应必须恰含所请求一部影片(空 list/多条目整体拒绝),
 *  正常信封解包与直接条目解析等值 */
export function parseDetailDocument(document: AppleCmsListDocumentWire, input: VodParseDetailBudgets): ParsedVodTitleDetail {
  const list = requireEnvelopeList(document);
  if (list.length !== 1) {
    reject('integrity_violation', `详情响应必须恰含所请求一部影片,实际 ${list.length} 条`);
  }
  const item = list[0];
  if (item === undefined) {
    reject('integrity_violation', '详情响应 list 首条缺失');
  }
  return parseDetail(item, input);
}

/** 详情条目解析:身份/播放字段完整性 → 预算 → 逐线逐集(见文件头检查顺序);
 *  基础证据恒 unverified;不含 ref/previewRevision/fetchedAt/sourceLabel(T028 职责) */
export function parseDetail(item: AppleCmsVodItemWire, input: VodParseDetailBudgets): ParsedVodTitleDetail {
  const identity = buildIdentity(item);
  const lines = extractLines(item, input);
  return {
    identity,
    title: identity.name,
    year: identity.year,
    synopsis: parseSynopsis(item),
    posterUrl: parsePosterUrl(item),
    evidence: 'unverified',
    lines,
  };
}

/** 线/集定位解析(`$$$` 拆线、`#` 拆集、首个 `$` 分割名称/地址;含预算与
 *  显示级 unsupported 判定):与 parseDetail 的 lines 部分完全同语义 */
export function extractLines(item: AppleCmsVodItemWire, input: VodParseDetailBudgets): readonly ParsedVodLine[] {
  const budgets = input.budgets;
  const segments = parsePlaySegments(item);
  if (segments.length > budgets.maxLines) {
    reject('budget_exceeded', `线数 ${segments.length} 超 detail.maxLines(${budgets.maxLines}),422 语义整体拒绝`);
  }

  const rawLines: RawVodLine[] = [];
  let totalEpisodes = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      reject('integrity_violation', `vod_play_from 第 ${index + 1} 段缺失(段数错位,截断形态)`);
    }
    const nameKey = normalizeIdentity(segment.name);
    if (nameKey.length > IDENTITY_KEY_MAX_LENGTH) {
      reject('identity_key_invalid', `线显示名 NFC+trim 后 ${nameKey.length} > ${IDENTITY_KEY_MAX_LENGTH},不得截断身份`);
    }
    const episodeSegments = segment.playUrl.split('#');
    if (episodeSegments.length > budgets.maxEpisodesPerLine) {
      reject(
        'budget_exceeded',
        `第 ${index + 1} 线集数 ${episodeSegments.length} 超 detail.maxEpisodesPerLine(${budgets.maxEpisodesPerLine}),422 语义整体拒绝`,
      );
    }
    totalEpisodes += episodeSegments.length;
    if (totalEpisodes > budgets.maxEpisodesTotal) {
      reject(
        'budget_exceeded',
        `合计集数 ${totalEpisodes} 超 detail.maxEpisodesTotal(${budgets.maxEpisodesTotal}),422 语义整体拒绝`,
      );
    }
    rawLines.push({ nameKey, episodes: episodeSegments.map(parseEpisodeSegment) });
  }
  return finalizeLines(rawLines);
}

/* ------------------------------------------------------------------ */
/* 内部:信封/身份/播放字段                                              */
/* ------------------------------------------------------------------ */

/** 整体拒绝(纯 Error 子类;interface 层负责翻译为 HTTP 语义) */
function reject(code: ProviderParseErrorCode, message: string): never {
  throw new ProviderParseError(code, message);
}

/** 信封完整性:code 必须恰为 1,list 必须为数组(缺截/伪造信封整体拒绝) */
function requireEnvelopeList(document: AppleCmsListDocumentWire): readonly AppleCmsVodItemWire[] {
  if (document === null || typeof document !== 'object') {
    reject('integrity_violation', '列表信封非对象(上游完整性受损)');
  }
  if (document.code !== 1) {
    reject('integrity_violation', `列表信封 code!==1(实际 ${String(document.code)}),整体拒绝`);
  }
  if (!Array.isArray(document.list)) {
    reject('integrity_violation', '列表信封缺 list 字段(截断形态),整体拒绝');
  }
  return document.list;
}

/** 可选字符串字段读法:缺失/非字符串按空串(是否完整性失败由字段语义决定) */
function readOptionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 归一文本 → 展示值:空 → null(上游未给不制造),非空逐字保留 */
function toNullableText(raw: string): string | null {
  const text = normalizeIdentity(raw);
  return text.length > 0 ? text : null;
}

/**
 * 海报地址解析(vod_pic,展示级):NFC+trim;空 → null(上游未给不制造);
 * 非 http(s) 或超 POSTER_URL_MAX_LENGTH → null(丢弃海报,不影响条目身份/解析,
 * 与播放地址 protocol_unsupported 整体拒绝的语义刻意区分——海报缺失只降级展示)。
 * 逐字透传不重编码;私有定位,公共面只见 posterRef。
 */
function parsePosterUrl(item: AppleCmsVodItemWire): string | null {
  const url = normalizeIdentity(readOptionalString(item.vod_pic));
  if (url.length === 0) {
    return null;
  }
  if (!ABSOLUTE_HTTP_URL_RE.test(url) || url.length > POSTER_URL_MAX_LENGTH) {
    return null;
  }
  return url;
}

/** 标题身份构建:vod_id/vod_name 缺失 → integrity_violation;归一后空/超长 →
 *  identity_key_invalid;年份/版本为身份分量(空 → null,不制造) */
function buildIdentity(item: AppleCmsVodItemWire): ProviderTitleIdentity {
  if (item === null || typeof item !== 'object') {
    reject('integrity_violation', '条目非对象(上游完整性受损)');
  }
  const rawId = item.vod_id;
  if (rawId === undefined || rawId === null) {
    reject('integrity_violation', '条目缺 vod_id(上游完整性受损,整体拒绝)');
  }
  if (typeof rawId !== 'number' && typeof rawId !== 'string') {
    reject('integrity_violation', `vod_id 类型非法(实际 ${typeof rawId})`);
  }
  const upstreamVodId = normalizeIdentity(typeof rawId === 'number' ? String(rawId) : rawId);
  if (upstreamVodId.length < 1 || upstreamVodId.length > IDENTITY_KEY_MAX_LENGTH) {
    reject(
      'identity_key_invalid',
      `upstreamVodId NFC+trim 后长度越界(1–${IDENTITY_KEY_MAX_LENGTH},实际 ${upstreamVodId.length}),不得截断身份`,
    );
  }
  const rawName = item.vod_name;
  if (typeof rawName !== 'string') {
    reject('integrity_violation', '条目缺 vod_name(上游完整性受损,整体拒绝)');
  }
  const name = normalizeIdentity(rawName);
  if (name.length < 1 || name.length > IDENTITY_KEY_MAX_LENGTH) {
    reject(
      'identity_key_invalid',
      `标题名 NFC+trim 后为空或超 ${IDENTITY_KEY_MAX_LENGTH}(实际 ${name.length}),标题身份无空形态且不得截断`,
    );
  }
  return {
    upstreamVodId,
    name,
    year: toNullableText(readOptionalString(item.vod_year)),
    version: toNullableText(readOptionalString(item.vod_version)),
  };
}

/** 单线 wire 段(线名段 + 对应播放段) */
interface PlayLineSegment {
  readonly name: string;
  readonly playUrl: string;
}

/** 详情播放字段完整性:`$$$` 拆段且 from/url 段数一致(错位=截断形态,整体拒绝) */
function parsePlaySegments(item: AppleCmsVodItemWire): readonly PlayLineSegment[] {
  const playFrom = item.vod_play_from;
  const playUrl = item.vod_play_url;
  if (
    typeof playFrom !== 'string' || playFrom.trim().length === 0 ||
    typeof playUrl !== 'string' || playUrl.trim().length === 0
  ) {
    reject('integrity_violation', '详情条目缺播放字段(vod_play_from/vod_play_url 空),不判 missing、不产出空线详情');
  }
  const nameSegments = playFrom.split('$$$');
  const urlSegments = playUrl.split('$$$');
  if (nameSegments.length !== urlSegments.length) {
    reject(
      'integrity_violation',
      `线格式段错位:vod_play_from ${nameSegments.length} 段 vs vod_play_url ${urlSegments.length} 段(截断形态)`,
    );
  }
  return nameSegments.map((name, index) => {
    const playSegment = urlSegments[index];
    if (playSegment === undefined) {
      reject('integrity_violation', `vod_play_url 第 ${index + 1} 段缺失(段数错位,截断形态)`);
    }
    return { name, playUrl: playSegment };
  });
}

/* ------------------------------------------------------------------ */
/* 内部:集段/线状态/unsupported 判定                                     */
/* ------------------------------------------------------------------ */

/** 单集 wire 段解析中间态(状态判定前的归一内容) */
interface RawVodEpisode {
  readonly labelKey: string;
  readonly locatorUrl: string;
}

/** 单线解析中间态 */
interface RawVodLine {
  readonly nameKey: string;
  readonly episodes: readonly RawVodEpisode[];
}

/** 绝对 http(s) 地址判定(api §2「只接受 http(s)」同口径;其余 ftp/相对/伪协议
 *  一律 protocol_unsupported 整体拒绝) */
const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//i;

/** 单集段解析:按**首个** `$` 分割名称/地址(地址含 `$` 不被吞进 label);
 *  无 `$` → integrity_violation;地址空 → integrity_violation(不标 unsupported);
 *  非绝对 http(s) → protocol_unsupported;名称归一后超 255 → identity_key_invalid */
function parseEpisodeSegment(segment: string): RawVodEpisode {
  const separatorIndex = segment.indexOf('$');
  if (separatorIndex < 0) {
    reject('integrity_violation', `单集段缺 $ 分隔符(wire 语法坏): ${segment.slice(0, 64)}`);
  }
  const labelPart = segment.slice(0, separatorIndex);
  const locatorUrl = segment.slice(separatorIndex + 1);
  if (locatorUrl.length === 0) {
    reject('integrity_violation', '单集地址缺失(label$url 空 url 段),不标 unsupported');
  }
  if (!ABSOLUTE_HTTP_URL_RE.test(locatorUrl)) {
    reject('protocol_unsupported', `播放地址非绝对 http(s),整体拒绝: ${locatorUrl.slice(0, 64)}`);
  }
  const labelKey = normalizeIdentity(labelPart);
  if (labelKey.length > IDENTITY_KEY_MAX_LENGTH) {
    reject('identity_key_invalid', `集 label NFC+trim 后 ${labelKey.length} > ${IDENTITY_KEY_MAX_LENGTH},不得截断身份`);
  }
  return { labelKey, locatorUrl };
}

/** 显示级 unsupported 判定(解析成功、仅条目标记;data-model §2「重复/空 key 详情
 *  显示 unsupported」):
 * - 线:空 key → null/unsupported;归一后重复 key 的镜像段(第 2+ 次出现)→
 *   整线 unsupported;不合并、保序、首现保持 candidate;
 * - 集:line unsupported 连带全集 unsupported;label 空 → episodeKey=null;
 *   同线归一后重复 key → **两处都标** unsupported/identity_ambiguous(全出现次),
 *   特典等非重复项不牵连;重复作用域=线(跨线同 key 互不影响)。 */
function finalizeLines(rawLines: readonly RawVodLine[]): ParsedVodLine[] {
  const seenLineKeys = new Set<string>();
  return rawLines.map((rawLine, index) => {
    const lineKey = rawLine.nameKey.length > 0 ? rawLine.nameKey : null;
    const mirrorLine = lineKey !== null && seenLineKeys.has(lineKey);
    if (lineKey !== null) {
      seenLineKeys.add(lineKey);
    }
    const lineUnsupported = lineKey === null || mirrorLine;

    const keyCounts = new Map<string, number>();
    for (const rawEpisode of rawLine.episodes) {
      if (rawEpisode.labelKey.length > 0) {
        keyCounts.set(rawEpisode.labelKey, (keyCounts.get(rawEpisode.labelKey) ?? 0) + 1);
      }
    }
    const episodes: ParsedVodEpisode[] = rawLine.episodes.map((rawEpisode) => {
      const episodeKey = rawEpisode.labelKey.length > 0 ? rawEpisode.labelKey : null;
      const duplicated = episodeKey !== null && (keyCounts.get(episodeKey) ?? 0) > 1;
      const unsupported = lineUnsupported || episodeKey === null || duplicated;
      const status: ParsedVodEntryStatus = unsupported ? 'unsupported' : 'candidate';
      const reason: ParsedVodUnsupportedReason | null = unsupported ? 'identity_ambiguous' : null;
      return {
        episodeKey,
        label: rawEpisode.labelKey,
        status,
        reason,
        locatorUrl: rawEpisode.locatorUrl,
      };
    });

    return {
      lineKey,
      displayName: rawLine.nameKey,
      sortOrder: index + 1,
      status: lineUnsupported ? 'unsupported' : 'candidate',
      episodes,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 内部:简介纯文本(剥 HTML;超限整体拒绝不截断)                          */
/* ------------------------------------------------------------------ */

/** HTML 标签(移除,不替换占位:<p>X</p> → X) */
const HTML_TAG_RE = /<[^>]*>/g;
/** 基础命名/十进制字符实体(纯文本化最小面;未覆盖实体逐字保留,不猜测) */
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp);/g;
const HTML_ENTITY_TABLE: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** 剥 HTML 为纯文本:去标签 + 解码基础实体 + 首尾 trim(data-model §1「简介纯文本」) */
function stripHtml(input: string): string {
  if (!input.includes('<') && !input.includes('&')) {
    return input.trim();
  }
  return input
    .replace(HTML_TAG_RE, '')
    .replace(HTML_ENTITY_RE, (entity) => HTML_ENTITY_TABLE[entity] ?? entity)
    .trim();
}

/** 简介解析:vod_blurb 优先、空则 vod_content 剥 HTML(T023 钉面:两源同文,
 *  解析结果一致);均空 → null;纯文本 >4096 → field_length_exceeded 整体拒绝,
 *  恰界合法、绝不截断 */
function parseSynopsis(item: AppleCmsVodItemWire): string | null {
  const plain = stripHtml(readOptionalString(item.vod_blurb)).length > 0
    ? stripHtml(readOptionalString(item.vod_blurb))
    : stripHtml(readOptionalString(item.vod_content));
  if (plain.length === 0) {
    return null;
  }
  if (plain.length > SYNOPSIS_MAX_LENGTH) {
    reject(
      'field_length_exceeded',
      `简介纯文本 ${plain.length} > ${SYNOPSIS_MAX_LENGTH},拒绝超限不截断(data-model §1)`,
    );
  }
  return plain;
}
