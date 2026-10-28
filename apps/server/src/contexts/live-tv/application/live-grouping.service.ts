import type { GroupDto } from '@hmp/shared';
import { groupKeyOf, OTHER_GROUP_LABEL } from '@contexts/live-tv/domain/live-grouping';
import { loadLiveChannelWindows } from '@contexts/live-tv/application/live-projection.service';

/**
 * 直播分组列表(T064;005 data-model §2、contracts/api.md §2):
 * - 读取 source_entry.group_title 经稳定主分组算法(pickMainGroupLabel:
 *   「按启用 present 关联 (source_id, entry_id) 升序选第一项非空 group_title;
 *   无分组为其他」),仅统计可用频道(可用性由来源条目集合决定,与 EPG 无关);
 * - 返回 {items:[{key,label}],now,timezone,catalogRevision}:仅含可用频道实际所属分组,
 *   无空分组;分组显示名 + 不透明 groupKey,绝不下发来源 ID/条目 ID/源 URL;
 * - 排序按显示名(UTF-16 码元序,跨请求/重启稳定);同频道的归属与列表区一致。
 *
 * timezone/catalogRevision 由调用方(控制器)在同一同步快照内注入。
 */

/** 从频道投影收集分组(去重、稳定排序;「其他」为普通分组参与同一排序) */
export function collectGroups(
  channels: ReadonlyArray<{ readonly mainGroupLabel: string | null }>,
): GroupDto[] {
  const labels = new Set<string>();
  for (const channel of channels) {
    labels.add(channel.mainGroupLabel ?? OTHER_GROUP_LABEL);
  }
  return [...labels]
    .map((label) => ({ key: groupKeyOf(label), label }))
    .sort((left, right) =>
      left.label !== right.label ? (left.label < right.label ? -1 : 1) : left.key < right.key ? -1 : 1,
    );
}

/** GET /public/live/groups 编排(分组不需要节目窗口,跳过两次节目集合查询) */
export function loadLiveGroups(householdId: string, nowMs: number): { items: GroupDto[] } {
  const channels = loadLiveChannelWindows(householdId, nowMs, { includeProgrammes: false });
  return { items: collectGroups(channels) };
}
