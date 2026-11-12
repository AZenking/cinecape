/**
 * 010 T025 — VOD 上游解析值模型:身份规范化/解析值类型/整体拒绝错误(纯领域)。
 *
 * 纯 TS:零依赖、零 import(.dependency-cruiser.cjs R1a 对 domain 层的框架/内建/
 * platform/外部包硬禁令 + audit:purity 符号级门禁;本文件连类型 import 都没有)。
 * 失败语义为纯 Error 子类,interface 层负责翻译为 HTTP 语义(对齐 vod-budgets.ts 惯例)。
 *
 * 来源标注(实现侧不自创语义,契约冻结面):
 * - docs/specs/010-online-vod/tasks.md T025:Apple CMS JSON 搜索/详情/多线 HLS 定位
 *   解析,基础证据 unverified;逐字保留「upstreamVodId/lineKey/episodeKey 1–255,
 *   NFC+trim 不得截断身份」「简介纯文本<=4096」「预算和完整性校验失败整体拒绝」;
 * - docs/specs/010-online-vod/data-model.md §1(通用约束:展示名 1–255、简介纯文本
 *   <=4096、upstreamVodId/lineKey/episodeKey 1–255 + NFC+trim 不得截断身份)、
 *   §2(vod_line「(title_id,line_key)唯一;重复/空 key 详情显示 unsupported」、
 *   vod_episode「(line_id,episode_key)唯一」)、§3(URL token/采集时间变化不加
 *   catalogRevision、不因签名 URL 变化单独推进 sequenceRevision;失败/截断不发布);
 * - 行为仲裁面:apps/server/test/unit/online-vod/provider-parser.spec.ts(010 T023
 *   测试先行,24 用例;文件头钉死导出面/键推导/身份字符串级/unsupported 判定/
 *   整体拒绝错误码/预算边界/G 组 token 语义,T025 以使其全绿为完成定义);
 * - docs/specs/010-online-vod/contracts/api.md §2(「超限 422 整次失败」由
 *   budget_exceeded 承载 422 语义)。
 *
 * 导出面即 T023 测试 import 面:normalizeIdentity / providerIdentityEquals /
 * ProviderParseError / ProviderParseErrorCode / ProviderTitleIdentity /
 * ParsedVodSearchItem / ParsedVodLine / ParsedVodEpisode / ParsedVodTitleDetail。
 * T028 服务层职责的 ref/previewRevision/fetchedAt/sourceLabel 不在本模型(逐字钉面)。
 */

/* ------------------------------------------------------------------ */
/* 契约常量                                                            */
/* ------------------------------------------------------------------ */

/** 身份键长度上界(data-model §1「upstreamVodId/lineKey/episodeKey 1–255」;
 *  按 NFC+trim 归一后的 UTF-16 码元计,归一后超界整体拒绝、绝不截断冒充合法) */
export const IDENTITY_KEY_MAX_LENGTH = 255;

/** 简介纯文本长度上界(data-model §1「简介纯文本<=4096」逐字;恰界合法,超限整体拒绝不截断) */
export const SYNOPSIS_MAX_LENGTH = 4096;

/**
 * 海报 URL 长度上界(展示级字段,非身份):归一后超界**丢弃海报置 null**,
 * 不整体拒绝(海报缺失只影响展示;身份/播放字段语义不受影响)。
 */
export const POSTER_URL_MAX_LENGTH = 2048;

/* ------------------------------------------------------------------ */
/* 解析值类型(与 T023 测试 import 面逐字对齐;全部 readonly 纯值)         */
/* ------------------------------------------------------------------ */

/** 解析条目状态:candidate=定位资格有效;unsupported=身份歧义(仅显示级标记) */
export type ParsedVodEntryStatus = 'candidate' | 'unsupported';

/** unsupported 唯一原因(data-model §2「重复/空 key 详情显示 unsupported」;
 *  format_unsupported 属上层定位/probe 阶段枚举值,解析层不产生——格式/协议问题一律整体拒绝) */
export type ParsedVodUnsupportedReason = 'identity_ambiguous';

/**
 * 上游标题身份(恰四分量;字符串级身份,不含 URL/采集时间 —— data-model §3
 * continuitySignature「规范身份/已知年份季度语言版本,不含 URL/采集时间」的解析侧投影)。
 */
export interface ProviderTitleIdentity {
  /** NFC+trim(String(vod_id)):wire 数值 → 字符串身份 */
  readonly upstreamVodId: string;
  /** NFC+trim(vod_name);归一后为空或超 255 → identity_key_invalid 整体拒绝 */
  readonly name: string;
  /** NFC+trim(vod_year);上游未给(空)→ null,不自动制造 */
  readonly year: string | null;
  /** NFC+trim(vod_version);上游未给(空)→ null,不自动制造 */
  readonly version: string | null;
}

/** 解析后的单集(显示级;locatorUrl 为上游定位地址逐字透传,不参与身份) */
export interface ParsedVodEpisode {
  /** NFC+trim(`名称$地址` 的名称段);label 空 → null(该集 unsupported) */
  readonly episodeKey: string | null;
  /** 归一后的集显示名(暴露归一结果;空 label → 空串) */
  readonly label: string;
  readonly status: ParsedVodEntryStatus;
  /** candidate 恒 null;unsupported 恒 identity_ambiguous */
  readonly reason: ParsedVodUnsupportedReason | null;
  /**
   * 上游定位地址逐字透传(G 组:sign token 变化只体现为本字段)。
   * 可选性说明:解析层恒产出该字段;类型可选仅为 T023 测试侧剥 locator 投影
   * (withoutLocators 解构 rest)的编译期兼容 —— Omit 剥除后须可赋值回本类型。
   */
  readonly locatorUrl?: string;
}

/** 解析后的单线(vod_line 显示级投影;sortOrder=wire 位置 1 起,不合并保序) */
export interface ParsedVodLine {
  /** NFC+trim(vod_play_from `$$$` 段显示名);空线名 → null(该线 unsupported) */
  readonly lineKey: string | null;
  /** 归一后的线显示名(暴露归一结果;空线名 → 空串) */
  readonly displayName: string;
  /** wire 位置序(1 起),重复/空 key 线也占位 */
  readonly sortOrder: number;
  readonly status: ParsedVodEntryStatus;
  readonly episodes: readonly ParsedVodEpisode[];
}

/** 搜索条目解析值(brief 形态;播放字段为空不影响搜索级解析) */
export interface ParsedVodSearchItem {
  readonly identity: ProviderTitleIdentity;
  /** = identity.name(归一后标题名) */
  readonly title: string;
  readonly year: string | null;
  /** NFC+trim(vod_remarks);上游未给(空)→ null */
  readonly remarks: string | null;
  /**
   * NFC+trim(vod_pic) 海报地址;上游未给/空/非 http(s)/超 2048 → null(展示级
   * 丢弃,不整体拒绝)。私有定位:绝不进入公共 DTO,公共面只见 posterRef。
   */
  readonly posterUrl: string | null;
}

/** 详情解析值(基础证据恒 unverified;不含 ref/previewRevision/fetchedAt/sourceLabel) */
export interface ParsedVodTitleDetail {
  readonly identity: ProviderTitleIdentity;
  /** = identity.name(归一后标题名) */
  readonly title: string;
  readonly year: string | null;
  /** 简介纯文本(剥 HTML 后);上游未给 → null;超 4096 整体拒绝不截断 */
  readonly synopsis: string | null;
  /** NFC+trim(vod_pic) 海报地址;丢弃规则同 ParsedVodSearchItem.posterUrl */
  readonly posterUrl: string | null;
  /** T025:基础 adapter 证据恒 unverified(verified 需完整证据,data-model §2 vod_episode) */
  readonly evidence: 'unverified';
  readonly lines: readonly ParsedVodLine[];
}

/* ------------------------------------------------------------------ */
/* 整体拒绝错误(纯 Error 子类;interface 层翻译为 HTTP 语义)              */
/* ------------------------------------------------------------------ */

/**
 * 解析整体拒绝错误码(恰五值;T023 钉面):
 * - identity_key_invalid   键/标题名 NFC+trim 后 >255 或标题名空(绝不截断身份);
 * - integrity_violation    信封 code!==1 / list 缺失 / 条目缺 vod_id|vod_name /
 *                          详情缺 play 字段 / from-url 段数错位 / 单集地址空;
 * - protocol_unsupported   播放地址非绝对 http(s)(api §2「只接受 http(s)」同口径);
 * - budget_exceeded        超 detail.maxLines(20)/maxEpisodesPerLine(2000)/
 *                          maxEpisodesTotal(5000)—— api §2「超限 422 整次失败」载体;
 * - field_length_exceeded  简介纯文本 >4096(不截断)。
 */
export type ProviderParseErrorCode =
  | 'identity_key_invalid'
  | 'integrity_violation'
  | 'protocol_unsupported'
  | 'budget_exceeded'
  | 'field_length_exceeded';

/** 解析整体拒绝错误(失败/截断不发布,data-model §3;绝不静默降级为 unsupported) */
export class ProviderParseError extends Error {
  readonly code: ProviderParseErrorCode;

  constructor(code: ProviderParseErrorCode, message: string) {
    super(message);
    this.name = 'ProviderParseError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 身份规范化                                                           */
/* ------------------------------------------------------------------ */

/**
 * 身份规范化:仅 NFC 归一 + 首尾 trim(data-model §1)。
 * 不做 NFKC 宽度折叠/大小写折叠等任何其他折叠('Ｍain' ≠ 'Main','１' ≠ '1');
 * 不截断:归一后长度即原字符串归一长度,超界由调用方整体拒绝。
 */
export function normalizeIdentity(input: string): string {
  return input.normalize('NFC').trim();
}

/** 身份相等:四分量逐一严格相等(字符串级;'第01集' ≠ '第1集') */
export function providerIdentityEquals(a: ProviderTitleIdentity, b: ProviderTitleIdentity): boolean {
  return (
    a.upstreamVodId === b.upstreamVodId &&
    a.name === b.name &&
    a.year === b.year &&
    a.version === b.version
  );
}
