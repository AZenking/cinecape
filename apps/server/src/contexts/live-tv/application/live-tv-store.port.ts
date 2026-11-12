/**
 * live-tv 仓储端口（008-repository-extraction T008，ADR-0015 D1）。
 *
 * 应用层数据访问的唯一合法形态：本文件定义纯 TS 端口接口 + 模块级 seam 槽；
 * Drizzle 实现位于 infrastructure/live-tv-store.drizzle.ts，由 live-tv.module.ts
 * 装配期绑定（useFactory），单元测试 rig 经 bindLiveTvStore 自行绑定。
 *
 * - 行类型为查询装载形态（投影列集与迁移前一致；本上下文全部为自定义投影，
 *   无全行 select，故按 policy 试点 HouseholdMediaCandidateRow 同款手写接口，
 *   schema 仍为列语义单一事实源）；
 * - 本上下文全部查询为事务外纯读（频道/来源/绑定/节目窗口集合查询），
 *   无事务端口（withTransaction 不需要）；
 * - 家庭真实可用性集合不经本端口重复建设：复用 policy 发布面的
 *   loadAvailableMediaIdSet（join 链一致、无政策语义，008 D2 已收敛为无 db 签名）；
 * - 方法签名与实现逐字对应既有查询（008 FR-002：join 链与谓词逐字迁移）。
 */

/** 频道元数据行(不含播放地址/来源身份;guide 墙与直播列表共用同一投影) */
export interface ChannelMetaRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly posterRef: string | null;
  readonly contentLevel: number | null;
}

/** 启用 IPTV 来源 × present 条目投影(mediaId 已过滤非空;同时供主分组与关联解析) */
export interface SourceEntryRow {
  sourceId: string;
  entryId: string;
  mediaId: string;
  upstreamChannelId: string | null;
  groupTitle: string | null;
}

/** 家庭来源行投影(关联解析的来源链两端判定输入;016 T014 起含 priority 级联排序输入) */
export interface MediaSourceRow {
  id: string;
  kind: string;
  enabled: number;
  epgSourceId: string | null;
  /** 016 US2:级联优先级(数值越小越优先;0010 迁移默认 100;仅 kind='epg' 参与级联裁决) */
  priority: number;
}

/** manual 模式 EPG 绑定行(手动优先关联解析输入) */
export interface ManualEpgBindingRow {
  mediaId: string;
  epgSourceId: string | null;
  xmltvChannelId: string | null;
}

/** EPG 频道标识行(自动精确匹配的 upstream 标识落点;016 T014 起含显示名供 L4 别名索引) */
export interface EpgChannelRow {
  sourceId: string;
  xmltvChannelId: string;
  conflicted: number;
  /** 016 US2:显示名(normalizeChannelName 归一化后作 L4 别名匹配键;0004 起非空列) */
  displayName: string;
}

/** 节目窗口行(判定视图形态;snake_case 查询列经 infrastructure 行映射产出) */
export interface ProgrammeRow {
  id: string;
  sourceId: string;
  xmltvChannelId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
}

/** live-tv 上下文仓储端口(全部为事务外纯读的集合查询) */
export interface LiveTvStore {
  /** 家庭频道元数据集合(含不可用;mediaIds 缺省 = 全家庭 channel,提供时按其过滤) */
  listChannelRows(householdId: string, mediaIds?: readonly string[]): ChannelMetaRow[];
  /** 启用 IPTV 来源 × present 条目(source_entry ⋈ media_source,mediaId 非空) */
  listPresentIptvEntryRows(householdId: string): SourceEntryRow[];
  /** 家庭全部来源行(不分 kind;来源链两端启用判定输入) */
  listMediaSourceRows(householdId: string): MediaSourceRow[];
  /** manual 模式 EPG 绑定行 */
  listManualBindingRows(householdId: string): ManualEpgBindingRow[];
  /** 家庭 EPG 频道标识行 */
  listEpgChannelRows(householdId: string): EpgChannelRow[];
  /** 覆盖 now 的节目行(starts_at<=now<ends_at,按关联对过滤) */
  listCoveringProgrammeRows(householdId: string, nowIso: string, pairKeys: readonly string[]): ProgrammeRow[];
  /** 每关联对最早未来行(MIN(starts_at>now) 子查询 join,同起点并列全部返回) */
  listNextEarliestProgrammeRows(householdId: string, nowIso: string, pairKeys: readonly string[]): ProgrammeRow[];
}

/**
 * seam 槽（ADR-0015 D1）：未绑定即调用为编程错误（显式失败，不静默空转）；
 * 重复绑定幂等覆盖（测试 rig 在 Database 单例重开后重建需要）。
 */
let boundStore: LiveTvStore | null = null;

export function bindLiveTvStore(store: LiveTvStore): void {
  boundStore = store;
}

export function liveTvStore(): LiveTvStore {
  if (boundStore === null) {
    throw new Error(
      'LIVE_TV_STORE 未绑定：live-tv 仓储端口需在模块装配（live-tv.module.ts）或测试 rig 中经 bindLiveTvStore 绑定（ADR-0015 D1 / 规格 008 FR-004）',
    );
  }
  return boundStore;
}
