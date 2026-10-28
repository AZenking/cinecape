/**
 * epg 仓储端口（008-repository-extraction T007，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/epg-store.drizzle.ts，由 epg.module.ts
 * 装配期绑定（useFactory），单元测试 rig 经 bindEpgStore 自行绑定。
 *
 * - 行类型经 `import type` 取自 @platform/database/schema（type-only 导入不产生
 *   依赖边，schema 保持单一事实源；depcruise 与 audit:purity 均放行）；
 * - 事务经 withTransaction 端口形态表达，事务句柄（tx）不越出 infrastructure；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：SQL 构造与谓词逐字迁移，
 *   含 manual-epg-binding.service 的 better-sqlite3 原生 SQL 段——文本逐字保留，
 *   位置参数 `?` 由 drizzle sql 模板参数绑定等价承接，与 policy 试点同模式）；
 * - getBindingState/saveBinding/unbindBinding 原以 db 参数传递句柄（ADR-0015 D2
 *   收敛为无 db 签名），事务外纯读/写路径无可见性耦合，句柄由 seam 惰性解析。
 */
import type {
  device,
  deviceSession,
  epgProgramme,
  mediaSource,
} from '@platform/database/schema';

export type SessionRow = typeof deviceSession.$inferSelect;
export type DeviceRow = typeof device.$inferSelect;
export type MediaSourceRow = typeof mediaSource.$inferSelect;
export type EpgProgrammeRow = typeof epgProgramme.$inferSelect;

/** 零档案兜底的家庭候选媒体投影（loadProgrammeReadContext 装载形态，列集与迁移前一致） */
export interface HouseholdMediaCandidateRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  contentLevel: number | null;
  version: number;
}

/** 节目投影（getMediaProgrammes 窗口判定消费，列集与迁移前一致） */
export interface ProgrammeProjectionRow {
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
}

/** guide 批量窗口行（guide-window.service 消费；蛇形别名与迁移前 select 逐字一致） */
export interface GuideProgrammeWindowRow {
  id: string;
  source_id: string;
  xmltv_channel_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
}

/** manual 绑定原始行（raw SQL 蛇形列；getBindingState 快照装载形态） */
export interface ManualBindingRawRow {
  mode: string;
  epg_source_id: string | null;
  xmltv_channel_id: string | null;
  version: number;
  updated_at: string;
}

/** 事务作用域内的绑定写入（saveBinding/unbindBinding 的事务块形态） */
export interface EpgTxStore {
  /** upsert 当前行（manual 锁定 / auto 墓碑不删行；SQL 逐字迁移自 upsertBinding） */
  upsertManualBinding(
    householdId: string,
    mediaId: string,
    mode: 'manual' | 'auto',
    target: { epgSourceId: string | null; xmltvChannelId: string | null },
    nextVersion: number,
    nowIso: string,
  ): void;
  /** catalog_state.revision+1（US6 T114 唯一写入实现自 catalog-revision.service 平移；SQL 逐字，须在调用方事务内执行） */
  incrementCatalogRevision(householdId: string): void;
}

/** epg 上下文仓储端口（读路径 + 事务入口） */
export interface EpgStore extends EpgTxStore {
  /* —— epg.service（零档案兜底 / 自动关联 / 手动优先 / 窗口判定）—— */
  findAnyProfileId(householdId: string): { id: string } | undefined;
  findSessionRow(sessionId: string): SessionRow | undefined;
  findDeviceRow(deviceId: string): DeviceRow | undefined;
  listMediaCandidateRows(householdId: string): HouseholdMediaCandidateRow[];
  listPresentSourceEntries(householdId: string, mediaId: string): Array<{ sourceId: string; upstreamChannelId: string | null }>;
  findMediaSourceRow(householdId: string, sourceId: string): MediaSourceRow | undefined;
  findEpgChannelConflictedRow(householdId: string, sourceId: string, xmltvChannelId: string): { conflicted: number } | undefined;
  findManualBindingTarget(householdId: string, mediaId: string): { mode: string; epgSourceId: string | null; xmltvChannelId: string | null } | undefined;
  findMediaSourceEnabledRow(householdId: string, sourceId: string): { enabled: number } | undefined;
  listProgrammeRowsByChannel(householdId: string, sourceId: string, xmltvChannelId: string): ProgrammeProjectionRow[];

  /* —— manual-epg-binding.service（写入前置重验 / 校验矩阵 / 管理读取；raw SQL 蛇形列）—— */
  findWriterSessionRow(
    sessionId: string,
    householdId: string,
  ): { session_revoked_at: string | null; expires_at: string; device_revoked_at: string | null } | undefined;
  findAccountRow(accountId: string, householdId: string): { id: string } | undefined;
  findMediaItemTypeRow(mediaId: string, householdId: string): { type: string } | undefined;
  hasIptvSourceEntry(householdId: string, mediaId: string): boolean;
  findBindingVersionRow(householdId: string, mediaId: string): { version: number } | undefined;
  findManualBindingRow(householdId: string, mediaId: string): ManualBindingRawRow | undefined;
  findSourceEnabledRowById(epgSourceId: string, householdId: string): { enabled: number } | undefined;
  findChannelConflictedRawRow(householdId: string, sourceId: string, xmltvChannelId: string): { conflicted: number } | undefined;
  findBindingTargetSourceRow(epgSourceId: string, householdId: string): { kind: string; enabled: number; epg_generation: number } | undefined;

  /* —— manual-epg-binding.service 候选查询（listEpgCandidates）—— */
  listNonConflictedChannelRows(householdId: string, sourceId: string): Array<{ xmltvChannelId: string; displayName: string }>;
  listLiveChannelIdRows(householdId: string, sourceId: string, nowIso: string): Array<{ xmltvChannelId: string }>;
  listProgrammeRowsForChannels(householdId: string, sourceId: string, xmltvChannelIds: readonly string[]): EpgProgrammeRow[];

  /* —— guide-window.service（整页一次批量节目窗口）—— */
  listProgrammeWindowRows(
    householdId: string,
    fromIso: string,
    toIso: string,
    pairKeys: readonly string[],
    limit: number,
  ): GuideProgrammeWindowRow[];

  withTransaction<T>(fn: (tx: EpgTxStore) => T): T;
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: EpgStore | null = null;

export function bindEpgStore(store: EpgStore): void {
  boundStore = store;
}

export function epgStore(): EpgStore {
  if (boundStore === null) {
    throw new Error(
      'EPG_STORE 未绑定：epg 仓储端口需在模块装配（epg.module.ts）或测试 rig 中经 bindEpgStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
