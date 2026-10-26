import { createHash } from 'node:crypto';

/**
 * 目录刷新差异/异常判定纯函数(T025;对照 FR-005/research R5/R6,满足 T017):
 * - 身份派生:同一 IPTV 来源先 tvg-id 原文(大小写敏感),缺失回退完整播放 URL
 *   (不删 query、不脱敏);NAS 用授权根内 POSIX 相对路径原文。无 URL 拒绝,
 *   无名称兜底(research R6「重复身份拒绝、无 URL 拒绝」);
 * - identity_digest = SHA-256(类型标签 + '\u0000' + 标识原文) 输出 64 位小写 hex;
 *   entry_key = identity_kind + ':' + identity_digest,作为暂存表主键成分与差异比较键;
 * - 重复身份:同一批次重复 entry_key 整批抛 IDENTITY_DUPLICATED,不以最后一条覆盖;
 *   错误消息只含序号与 entry_key(哈希),绝不携带 URL/tvg-id/路径原文(凭据脱敏,R3);
 * - snapshot_digest:对全部条目的 entry_key + payload 规范化 JSON(键递归排序)后
 *   SHA-256,顺序无关——输入顺序与对象键插入顺序均不影响结果;
 * - diffSnapshot/evaluateExceptions 为纯计数与判定:baseline 传「已发布 source_entry 的
 *   present=true 投影」;异常分母 = 当前 present 条目数(不是历史所有行),恰好 25% 触发;
 *   首次导入(baseline 空)不触发任何确认。
 * 本模块不做任何 IO/持久化;写入 refresh_stage_entry 见 refresh-staging.service.ts。
 */

/** 稳定错误码:身份/摘要阶段失败类别(日志与 DTO 只透出 code) */
export const IDENTITY_MISSING_URL = 'IDENTITY_MISSING_URL' as const;
export const IDENTITY_DUPLICATED = 'IDENTITY_DUPLICATED' as const;
/** 防御性扩展:NAS 扫描记录契约保证 relativePath 非空,此码仅兜底编程错误 */
export const IDENTITY_MISSING_PATH = 'IDENTITY_MISSING_PATH' as const;
/** 防御性扩展:payload 含不可 JSON 序列化的值(实际 payload 来自 JSON 文本,不可达) */
export const DIGEST_PAYLOAD_UNSERIALIZABLE = 'DIGEST_PAYLOAD_UNSERIALIZABLE' as const;

export type CatalogDiffErrorCode =
  | typeof IDENTITY_MISSING_URL
  | typeof IDENTITY_DUPLICATED
  | typeof IDENTITY_MISSING_PATH
  | typeof DIGEST_PAYLOAD_UNSERIALIZABLE;

/** 身份/摘要失败:code 稳定可区分;message 不含 URL/凭据/路径原文 */
export class CatalogDiffFailure extends Error {
  readonly code: CatalogDiffErrorCode;

  constructor(code: CatalogDiffErrorCode, message: string) {
    super(message);
    this.name = 'CatalogDiffFailure';
    this.code = code;
  }
}

/** 身份种类(与 source_entry.identity_kind 的 CHECK 一致) */
export type IdentityKind = 'tvg_id' | 'url' | 'path';

/** 参与身份派生的来源种类(EPG 走窗口发布,不经条目身份) */
export type IdentitySourceKind = 'iptv' | 'nas';

/** IPTV 条目输入(形状与 parseM3U 输出的 M3UEntry 一致) */
export interface IptvEntryInput {
  /** EXTINF tvg-id 原文;解析器对缺失/空值输出 null,空串同缺失处理 */
  tvgId: string | null;
  title: string;
  /** 完整播放地址原文:保留大小写/query/凭据,身份按原文派生 */
  url: string;
}

/** NAS 条目输入(形状与 scanNasRoot 输出的 NasFileEntry 一致) */
export interface NasEntryInput {
  /** 授权根内相对路径,POSIX「/」分隔,大小写敏感 */
  relativePath: string;
  sizeText: string;
  mtimeNsText: string;
}

/** 单条目的身份四元组 */
export interface EntryIdentity {
  identityKind: IdentityKind;
  /** 标识原文(tvg-id / 完整 URL / 相对路径),大小写敏感、不归一化 */
  identityValue: string;
  /** SHA-256(类型标签 + '\u0000' + 标识原文),64 位小写 hex */
  identityDigest: string;
  /** identity_kind + ':' + identity_digest */
  entryKey: string;
}

/** 删除比例确认阈值:missing / baselinePresentCount ≥ 25% 触发(规格固定) */
export const DELETION_RATIO_THRESHOLD = 0.25;

/** 摘要输入的规范化条目:身份键 + 任意可 JSON 序列化的 payload */
export interface SnapshotDigestItem {
  entryKey: string;
  payload: unknown;
}

/** 已发布 source_entry 行投影(present 标志防御性保留;执行器约定只传 present=true 行) */
export interface BaselineEntryProjection {
  entryKey: string;
  present: boolean;
}

/** 本次快照条目投影 */
export interface StagedEntryProjection {
  entryKey: string;
}

/** 差异计数(资源级变化由发布事务判定,此处按身份集合) */
export interface DiffCounts {
  /** staged 中 baseline 没有的条目数 */
  added: number;
  /** staged 中 baseline 有且 present 的条目数(身份存在即视为 updated) */
  updated: number;
  /** baseline 中 present=true 而 staged 缺席的条目数 */
  missing: number;
}

export interface DiffSnapshotResult {
  counts: DiffCounts;
}

/** 异常原因:合法空快照 / 缺失比例超阈值 */
export type RefreshExceptionReason = 'empty_snapshot' | 'deletion_ratio_exceeded';

export interface ExceptionEvaluation {
  requiresConfirmation: boolean;
  /** requiresConfirmation=false 时恒为 null */
  reason: RefreshExceptionReason | null;
}

export interface EvaluateExceptionsInput {
  counts: DiffCounts;
  /** 当前 present 条目数(分母;不是历史所有行) */
  baselinePresentCount: number;
  /** 首次导入(baseline 空):不触发任何确认 */
  isFirstImport: boolean;
  /** 调用方显式允许空快照(如确认清空)时豁免 empty_snapshot */
  emptySnapshotAllowed: boolean;
}

/** 身份摘要:SHA-256(类型标签 + NUL + 标识原文) 小写 hex */
function digestOf(kindTag: IdentityKind, identityValue: string): string {
  return createHash('sha256').update(`${kindTag}\u0000${identityValue}`, 'utf8').digest('hex');
}

function buildIdentity(kindTag: IdentityKind, identityValue: string): EntryIdentity {
  const identityDigest = digestOf(kindTag, identityValue);
  return { identityKind: kindTag, identityValue, identityDigest, entryKey: `${kindTag}:${identityDigest}` };
}

/**
 * 单条目身份派生的内部实现(kind 决定材料规则;供重载外壳与批量函数共用):
 * - iptv:tvgId 非空 → tvg_id 身份;否则回退完整 URL;两者皆缺抛 IDENTITY_MISSING_URL;
 * - nas:relativePath 原文 → path 身份(扫描契约保证非空,空值兜底 IDENTITY_MISSING_PATH)。
 */
function identityOf(kind: IdentitySourceKind, item: IptvEntryInput | NasEntryInput): EntryIdentity {
  if (kind === 'iptv') {
    const { tvgId, url } = item as IptvEntryInput;
    // 「非空」按字面判断:空串同缺失;不做 trim/大小写归一化(原文即身份)
    if (typeof tvgId === 'string' && tvgId !== '') {
      return buildIdentity('tvg_id', tvgId);
    }
    if (typeof url === 'string' && url !== '') {
      return buildIdentity('url', url);
    }
    throw new CatalogDiffFailure(IDENTITY_MISSING_URL, 'IPTV 条目缺少 tvg-id 且缺少播放地址,无法派生身份');
  }
  const { relativePath } = item as NasEntryInput;
  if (typeof relativePath === 'string' && relativePath !== '') {
    return buildIdentity('path', relativePath);
  }
  throw new CatalogDiffFailure(IDENTITY_MISSING_PATH, 'NAS 条目缺少相对路径,无法派生身份');
}

/** 计算单条目身份(重载按 kind 收紧条目类型;iptv↔M3U 条目,nas↔NAS 扫描记录) */
export function computeEntryIdentity(kind: 'iptv', item: IptvEntryInput): EntryIdentity;
export function computeEntryIdentity(kind: 'nas', item: NasEntryInput): EntryIdentity;
export function computeEntryIdentity(kind: IdentitySourceKind, item: IptvEntryInput | NasEntryInput): EntryIdentity {
  return identityOf(kind, item);
}

/**
 * 批量身份计算 + 重复身份整批拒绝(写前检查):
 * 任一 entry_key 重复即抛 IDENTITY_DUPLICATED(不以最后一条覆盖);
 * 无重复时按输入顺序返回逐条身份,供暂存层与 payload 一一对齐。
 */
export function computeBatchEntryIdentities(kind: 'iptv', items: readonly IptvEntryInput[]): EntryIdentity[];
export function computeBatchEntryIdentities(kind: 'nas', items: readonly NasEntryInput[]): EntryIdentity[];
export function computeBatchEntryIdentities(
  kind: IdentitySourceKind,
  items: readonly (IptvEntryInput | NasEntryInput)[],
): EntryIdentity[] {
  const firstSeenIndex = new Map<string, number>();
  const identities: EntryIdentity[] = [];
  items.forEach((item, index) => {
    const identity = identityOf(kind, item);
    const seenAt = firstSeenIndex.get(identity.entryKey);
    if (seenAt !== undefined) {
      // 消息只含序号与 entry_key(哈希),不携带标识原文(可能带凭据,research R3)
      throw new CatalogDiffFailure(
        IDENTITY_DUPLICATED,
        `第 ${index + 1} 条与第 ${seenAt + 1} 条身份重复(${identity.entryKey}),拒绝以最后一条覆盖`,
      );
    }
    firstSeenIndex.set(identity.entryKey, index);
    identities.push(identity);
  });
  return identities;
}

/**
 * 规范化 JSON:对象键递归按 UTF-16 码元排序、无空白,数组保持顺序。
 * 用于 payload 的确定性序列化(摘要与存储形态稳定,与键插入顺序无关)。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== undefined);
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`).join(',')}}`;
  }
  throw new CatalogDiffFailure(DIGEST_PAYLOAD_UNSERIALIZABLE, '快照 payload 含不可 JSON 序列化的值,无法计算规范化摘要');
}

/**
 * 顺序无关快照摘要(research R5「内容摘要按顺序无关规范化条目计算」):
 * 每条目规约为 entry_key + '\u0000' + 规范化 JSON,按字典序排序后以 '\n' 连接
 * 再取 SHA-256(64 位小写 hex)。输入顺序/键插入顺序无关;任一条目变化即摘要不同。
 * 空集为 SHA-256 空输入,确定且不抛错(空快照的合法性由 evaluateExceptions 判定)。
 */
export function computeSnapshotDigest(items: readonly SnapshotDigestItem[]): string {
  const lines = items.map((item) => `${item.entryKey}\u0000${canonicalJson(item.payload)}`);
  lines.sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * 差异计数(baseline=已发布 present 投影,staged=本次快照):
 * - added:staged 中 baseline 没有的;
 * - updated:staged 中 baseline 有且 present(身份存在即视为 updated——资源级变化
 *   由发布事务判定,此处按身份集合);
 * - missing:baseline 中 present=true 而 staged 无的。
 */
export function diffSnapshot(
  baseline: readonly BaselineEntryProjection[],
  staged: readonly StagedEntryProjection[],
): DiffSnapshotResult {
  const presentByKey = new Map<string, boolean>();
  for (const row of baseline) {
    presentByKey.set(row.entryKey, row.present);
  }
  const stagedKeys = new Set<string>();
  let added = 0;
  let updated = 0;
  for (const item of staged) {
    if (stagedKeys.has(item.entryKey)) {
      continue; // 暂存层已拒绝重复;此处防御性去重,不重复计数
    }
    stagedKeys.add(item.entryKey);
    const baselinePresent = presentByKey.get(item.entryKey);
    if (baselinePresent === undefined) {
      added += 1;
    } else if (baselinePresent) {
      updated += 1;
    }
  }
  let missing = 0;
  for (const [entryKey, present] of presentByKey) {
    if (present && !stagedKeys.has(entryKey)) {
      missing += 1;
    }
  }
  return { counts: { added, updated, missing } };
}

/**
 * 异常判定(research R5/data-model「发布事务」前置):
 * - 首次导入(baseline 空)不触发任何确认;
 * - staged 为空且 baselinePresentCount>0(且未被显式允许)→ empty_snapshot;
 * - staged 非空且 missing/baselinePresentCount ≥ 25% → deletion_ratio_exceeded
 *   (分母=当前 present 条目数,不是历史所有行;恰好 25% 触发);
 * - 其余 requiresConfirmation=false、reason=null。
 */
export function evaluateExceptions(input: EvaluateExceptionsInput): ExceptionEvaluation {
  // staged 规模 = added + updated(调用约定:baseline 传 present=true 投影,两者之和即快照大小)
  const stagedCount = input.counts.added + input.counts.updated;
  if (input.isFirstImport) {
    return { requiresConfirmation: false, reason: null };
  }
  if (stagedCount === 0 && input.baselinePresentCount > 0 && !input.emptySnapshotAllowed) {
    return { requiresConfirmation: true, reason: 'empty_snapshot' };
  }
  if (stagedCount > 0 && input.baselinePresentCount > 0) {
    const deletionRatio = input.counts.missing / input.baselinePresentCount;
    if (deletionRatio >= DELETION_RATIO_THRESHOLD) {
      return { requiresConfirmation: true, reason: 'deletion_ratio_exceeded' };
    }
  }
  return { requiresConfirmation: false, reason: null };
}
