import { createHash } from 'node:crypto';

/**
 * 来源主分组解析核心(T058/T064;005 data-model §2 逐字语义、FR-023、research R8):
 * - `source_entry.group_title TEXT NULL,trim 后 1~100 字符,空白为 NULL`;
 * - 「对多来源可用频道,按启用 present 关联 (source_id, entry_id) 升序选第一项
 *   非空 group_title;无分组为其他」;
 * - 「公开返回仅分组显示名及不透明 groupKey,不带来源身份或源 URL」;
 * - FR-023「优先采用频道来源的类型或分组,缺失归入其他,不按标题臆测类型」。
 *
 * 本模块为纯函数;可用性/present 过滤由调用方(批量投影)完成后再进入本核心。
 */

/** 存储值域上界(与 source_entry_group_title_check 一致) */
export const GROUP_TITLE_MAX_LENGTH = 100;

/** 无分组频道的固定归属分组显示名(「缺失归入其他」) */
export const OTHER_GROUP_LABEL = '其他';

/** 参与主分组选取的来源条目投影(仅启用来源 × present 条目) */
export interface GroupTitleSource {
  readonly sourceId: string;
  readonly entryId: string;
  /** source_entry.group_title 存储原文(NULL/未归一化原文均可,选取前归一化) */
  readonly groupTitle: string | null;
}

/**
 * group_title 存储值域归一化:trim;空白(含全空白)→ null;
 * 超长(>100,trim 后)→ null(防御;写入侧由导入链路校验失败拦截,不截断伪造)。
 * 非字符串输入按缺失处理;上游占位字面量「undefined」(大小写不敏感)→ null。
 */
export function normalizeGroupTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > GROUP_TITLE_MAX_LENGTH) {
    return null;
  }
  // 上游 iptv-org 的 cn.m3u 对未分类频道写 group-title="Undefined"(占位,不是分组名);
  // 按 FR-023「缺失归入其他」视同缺失,避免公开分组列表出现字面量 Undefined。
  if (trimmed.toLowerCase() === 'undefined') {
    return null;
  }
  return trimmed;
}

/**
 * 稳定主分组:按 (source_id, entry_id) 升序扫描,取第一项「归一化后非空」的
 * group_title;全部缺失返回 null(调用方归入其他)。输入顺序无关(内部排序)。
 */
export function pickMainGroupLabel(entries: readonly GroupTitleSource[]): string | null {
  const ordered = [...entries].sort((left, right) => {
    if (left.sourceId !== right.sourceId) {
      return left.sourceId < right.sourceId ? -1 : 1;
    }
    return left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0;
  });
  for (const entry of ordered) {
    const label = normalizeGroupTitle(entry.groupTitle);
    if (label !== null) {
      return label;
    }
  }
  return null;
}

/**
 * 不透明 groupKey:由分组显示名经单向映射生成(sha256 截断)。
 * - 稳定:同一显示名跨请求/重启恒同 key;
 * - 不透明:不包含来源 ID、条目 ID、源 URL 或路径;不同显示名不同 key;
 * - key 字符集限定 [a-z0-9-],可直接作为 URL 查询参数。
 */
export function groupKeyOf(label: string): string {
  const digest = createHash('sha256').update(`hmp-live-group\u0000${label}`, 'utf8').digest('hex');
  return `grp-${digest.slice(0, 20)}`;
}
