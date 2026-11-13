import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { canonicalJson, type DiffCounts } from '@contexts/sources/infrastructure/catalog-diff';
import {
  channelKeyOf,
  deriveLinePriority,
} from '@contexts/sources/infrastructure/m3u.parser';
import {
  computeSnapshotDigest as stagedSnapshotDigest,
  type LoadedStagedEntry,
} from '@contexts/sources/infrastructure/refresh-staging.service';
import { parseStoredList } from '@contexts/policy';
// 014 T033:EPG/IPTV 发布的受限合并(M2/M3/M4)复用 live-projection 的 upstream 精确
// 匹配关联核心(internal-ports.md §4「绑定判定核心复用,禁止复制第三份逻辑」;经发布面
// 消费,同 epg/domain/binding-core.ts 先例)。核心经 liveTvStore/policyStore seam 以同一
// SQLite 连接读取,发布事务内的未提交写入对核心可见(better-sqlite3 连接级事务)。
import { loadChannelAssociationCore } from '@contexts/live-tv';
import { posterMatchKeyOf, type ProgrammePosterRef } from '@contexts/epg';
import type { XMLTVChannel, XMLTVProgramme } from '@contexts/sources/infrastructure/xmltv.parser';
// 008-T009(ADR-0015 D1):数据访问经仓储端口 seam,发布事务经 withSqlTransaction 表达
// (原生 SQL 逐字迁移至 infrastructure/sources-store.drizzle.ts,行为零变化)
// 014 T015:墓碑窗口常量为 media-catalog CHANNEL_LOGO_TOMBSTONE_WINDOW_MS 的结构镜像
// (sources-store.port.ts;data-model §4「revoked_at ≤ now−7d 集合 DELETE」)。
import {
  CHANNEL_LOGO_TOMBSTONE_WINDOW_MS,
  sourcesStore,
  type ChannelLogoParticipant,
  type MediaSourceRow,
  type RefreshTxStore,
  type SourceEntryRow,
} from '@contexts/sources/application/sources-store.port';

/**
 * 刷新发布事务(T026/T027;data-model「发布事务」/research R5,FR-022/SC-009):
 * - 单个同步 better-sqlite3 事务内完成:重验(来源启用、source.version、catalog revision、
 *   job version、快照摘要与暂存一致)→ 稳定 upsert(media_item/source_entry/playback_source,
 *   IPTV 与 NAS 同规则)→ mark missing(只改 present,不动 media_item 与名单引用)→
 *   NAS 同路径替换清理(T027)→ 来源成功信息 + job succeeded + catalog revision+1,同事务提交;
 * - 任一重验失败 → status='stale'(version+1)并清理暂存,不发布,绝不部分写入;
 * - IPTV/NAS 暂存数据经 refresh_stage_entry 回读,网络/文件 IO 绝不出现在本事务;
 *   EPG 无暂存(T043 前不由暂存层承载),发布数据由执行器解析后传入,事务内窗口原子替换:
 *   完全相同节目按唯一键去重、冲突标记照解析器结论、不创建 MediaItem、不改任何分级;
 * - 人工配置保护:media_item 仅在未人工覆盖(title_overridden/type_overridden)时更新
 *   标题/类型;既有 content_level 一律不由普通刷新改写,仅 NAS 替换清理显式置 null;
 * - NAS 替换清理(T027):staged 条目与既有 entry 的 file_size_text/file_mtime_ns 任一不同 →
 *   同事务内该媒体 content_level=null,并从当前 Household 全部 Profile 的 allowedMediaIds
 *   移除该媒体 id(blockedMediaIds 保留),每个发生名单变化的档案 version 只 +1(单次发布内
 *   无论影响多少媒体);策略名单读取经 policy.rules 的 parseStoredList 严格校验,
 *   损坏即抛 PolicyCorruptionError 使整个发布事务回滚,绝不带着旧允许项继续;
 *   同 size 同 mtime 未变 → 不触碰该媒体的任何配置。
 * - 014 T015(频道 Logo,IPTV 发布 M1/internal-ports §4 时序):发布事务内写
 *   source_entry.logo_url 私有证据(NAS 恒无),有 logo 的频道经 media-catalog 事务
 *   参与者执行 M1 胜者合并(upsertChannelLogoWinner → setChannelPosterRef),收尾前
 *   顺带墓碑 GC(gcExpiredChannelLogoTombstones,revoked_at ≤ now−7d 集合 DELETE);
 *   合并细节(url 未变不换 ref/epg 不覆盖 iptv)由参与者强制,引用签发不出参与者;
 *   缺列容忍:0001~0008 部分迁移库(无 logo_url/channel_logo)整段静默跳过。
 * - 014 T033(US4,同一发布事务内补 M2/M3/M4 生命周期):
 *   · IPTV 发布 M2(research R5):条目新快照无有效 logo 且当前 active(iptv) → 撤销
 *     转墓碑 + poster_ref=NULL,并在条目循环后同事务按 M3 逻辑以绑定 epg 频道的
 *     icon_url 证据填补(无绑定/icon 留墓碑;active(epg) 胜者不动);填补判定复用
 *     live-projection 关联核心(经发布面 @contexts/live-tv,禁第三份判定逻辑);
 *   · EPG 窗口发布 M3/M4(受限合并):epg_channel.icon_url 随窗口 upsert 同事务写入
 *     (缺列容忍);「受影响且已绑定频道」= 关联核心解析出、关联对落在本来源窗口内的
 *     频道 —— icon 非空 → M3 写/复 active(epg)(epg 绝不覆盖 iptv 由参与者强制);
 *     icon 为空 → M4 撤 active(epg);绑定随本次窗口替换失效(频道移出窗口/转
 *     conflicted)→ M4 同款撤销;收尾前墓碑 GC 与 IPTV 事务同款。
 * - 016 T018(US3 多线路聚合,research R1):IPTV 发布按 normalizeChannelKey(条目标题)
 *   在同一 Household 内聚合 —— 同名流(归一键相同,含大小写/清晰度后缀差异)收敛为
 *   「单 media_item + 多 source_entry 线路」;跨来源同名并入既有频道;人工改名频道
 *   不参与自动归并;重导入幂等(既有条目 media_id 保持不变)。线路权重 = 来源
 *   priority + 清晰度加权落 playback_source.priority(播放解析 016 T019 按 ASC 选线)。
 */

/** 策略损坏信号:发布事务内抛出即整体回滚,由执行器映射为 POLICY_UNAVAILABLE */
export class PolicyCorruptionError extends Error {
  constructor(field: string) {
    super(`策略损坏(${field}),发布事务已中止`);
    this.name = 'PolicyCorruptionError';
  }
}

export function isPolicyCorruptionError(error: unknown): error is PolicyCorruptionError {
  return error instanceof PolicyCorruptionError;
}

/** 条目发布参数(kind=iptv|nas;暂存数据由本服务自 refresh_stage_entry 回读) */
export interface EntryPublishParams {
  householdId: string;
  sourceId: string;
  refreshId: string;
  kind: 'iptv' | 'nas';
  /** 发布时期望的任务 version(并发修改防护) */
  jobVersion: number;
  /** 发布时期望的来源 version */
  sourceVersion: number;
  /** 发布时期望的家庭目录 revision */
  baselineRevision: number;
  /** 期望的暂存快照摘要(SHA-256 hex) */
  snapshotDigest: string;
  /** 差异计数(执行器 diffSnapshot 结果,落 summary_json) */
  counts: DiffCounts;
  nowMs: number;
}

/** EPG 窗口发布参数(解析结果由执行器传入;无暂存层) */
export interface EpgPublishParams {
  householdId: string;
  sourceId: string;
  refreshId: string;
  jobVersion: number;
  sourceVersion: number;
  baselineRevision: number;
  snapshotDigest: string;
  channels: readonly XMLTVChannel[];
  programmes: readonly XMLTVProgramme[];
  conflictedChannelIds: readonly string[];
  nowMs: number;
  /** 020:发布前本地缓存命中的 ({ rawTitle → { matchKey, ref } })；缺省时只算 key、ref=NULL */
  posterByTitle?: ReadonlyMap<string, ProgrammePosterRef>;
}

export type PublishOutcome = 'succeeded' | 'stale';

/** 发布用暂存条目投影(payload 回读) */
interface StagedEntry {
  entryKey: string;
  identityKind: string;
  identityDigest: string;
  title: string | null;
  url: string | null;
  tvgId: string | null;
  /** T146:M3U group_title(解析层已归一化:trim 1~100 或缺失);NAS 恒 null */
  groupTitle: string | null;
  /** 014 T014:M3U tvg-logo(解析层已归一化:http(s) 9~2048 或 null);NAS 恒无该键 → null */
  tvgLogo: string | null;
  relativePath: string | null;
  sizeText: string | null;
  mtimeNsText: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** entry_key = identity_kind + ':' + identity_digest(与 catalog-diff 拼接规则一致) */
function entryKeyOf(kind: string, digest: string): string {
  return `${kind}:${digest}`;
}

/* ------------------------------------------------------------------ */
/* 014 T033:胜者受限合并辅助(M2 撤销+epg 填补 / M3 写入 / M4 撤销)        */
/* ------------------------------------------------------------------ */

/**
 * 关联对键分解(live-projection pairKeyOf = sourceId + \u0000 + xmltvChannelId;
 * indexOf 切分:sourceId 为 UUID 不含 \u0000,xmltvChannelId 理论上任意原文 →
 * 用首个分隔符切分而非 split 全拆)。解析失败返回 null(编程性防御,不猜测)。
 */
function splitPairKey(pairKey: string): { sourceId: string; xmltvChannelId: string } | null {
  const separator = pairKey.indexOf('\u0000');
  if (separator <= 0 || separator === pairKey.length - 1) {
    return null;
  }
  return { sourceId: pairKey.slice(0, separator), xmltvChannelId: pairKey.slice(separator + 1) };
}

/**
 * M4/M2 的撤销执行面(research R5「若胜者 source_kind='epg' → 撤销转墓碑;否则不动」):
 * 仅当当前行 active 且 source_kind='epg' 时撤销 + poster_ref 置 NULL —— active(iptv)
 * 胜者绝不由此撤销(受限合并:只撤 epg 来源胜者,data-model §4「任何场景」行);
 * 无行/墓碑 no-op(不刷新既有 revoked_at,墓碑窗口以首次撤销时间计)。
 */
function revokeEpgWinnerIfActive(
  logoParticipant: ChannelLogoParticipant,
  householdId: string,
  mediaId: string,
  nowIso: string,
): void {
  const winner = logoParticipant.findChannelLogo(householdId, mediaId);
  if (winner !== undefined && winner.revokedAt === null && winner.sourceKind === 'epg') {
    logoParticipant.revokeChannelLogo(householdId, mediaId, nowIso);
    logoParticipant.setChannelPosterRef(householdId, mediaId, null);
  }
}

/**
 * M2 同事务 epg 填补(data-model §4 M2「随后按 M3 逻辑尝试 epg 填补」):对刚撤销的
 * 频道,经关联核心解析其绑定对(manual 优先/自动精确/conflicted=0,与 live 投影同一
 * 判定);绑定对存在且该 epg 频道 icon_url 非空 → 按 M3 写 active(epg)(参与者强制
 * 「epg 绝不覆盖 iptv」与同 url 无操作);无绑定/无 icon → 留墓碑(旧引用 410)。
 * epg 证据行一次集合查询(不随频道数线性增长);candidates 为空则零查询零调用。
 */
function fillEpgEvidenceForRevoked(
  db: RefreshTxStore,
  logoParticipant: ChannelLogoParticipant,
  householdId: string,
  candidateMediaIds: readonly string[],
  nowIso: string,
): void {
  if (candidateMediaIds.length === 0) {
    return;
  }
  const core = loadChannelAssociationCore(householdId);
  let iconRows: ReturnType<RefreshTxStore['listEpgChannelIconRows']> | null = null;
  for (const mediaId of candidateMediaIds) {
    const pairKey = core.associationByMedia.get(mediaId) ?? null;
    if (pairKey === null) {
      continue; // 无绑定:留墓碑
    }
    const pair = splitPairKey(pairKey);
    if (pair === null) {
      continue;
    }
    iconRows ??= db.listEpgChannelIconRows(householdId);
    const icon = iconRows.find(
      (row) => row.sourceId === pair.sourceId && row.xmltvChannelId === pair.xmltvChannelId && row.conflicted === 0,
    );
    if (icon === undefined || icon.iconUrl === null) {
      continue; // 绑定对无 icon 证据:留墓碑
    }
    const { ref } = logoParticipant.upsertChannelLogoWinner({
      householdId,
      mediaId,
      upstreamUrl: icon.iconUrl,
      sourceKind: 'epg',
      sourceId: pair.sourceId,
      nowIso,
    });
    logoParticipant.setChannelPosterRef(householdId, mediaId, ref);
  }
}

/** NAS 媒体标题:文件名去扩展名(点开头文件不剥) */
function nasTitleOf(relativePath: string): string {
  const base = relativePath.split('/').pop() ?? relativePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** 条目标题:IPTV 取解析标题;NAS 取去扩展名文件名 */
function entryTitleOf(kind: 'iptv' | 'nas', entry: StagedEntry): string {
  if (kind === 'nas') {
    return nasTitleOf(entry.relativePath ?? '');
  }
  return entry.title ?? '';
}

/** 条目媒体类型:IPTV 恒为 channel;NAS 恒为 video */
function entryMediaType(kind: 'iptv' | 'nas'): 'channel' | 'video' {
  return kind === 'nas' ? 'video' : 'channel';
}

/** 资源协议推断:IPTV URL 以 .m3u8 结尾 → hls 否则 http;NAS 为 file,location=rootKey+相对路径 */
function playbackOf(kind: 'iptv' | 'nas', entry: StagedEntry, source: Pick<MediaSourceRow, 'root_key'>): {
  protocol: 'hls' | 'http' | 'file';
  location: string;
} {
  if (kind === 'nas') {
    return { protocol: 'file', location: `${source.root_key}/${entry.relativePath ?? ''}` };
  }
  const url = entry.url ?? '';
  return { protocol: url.toLowerCase().endsWith('.m3u8') ? 'hls' : 'http', location: url };
}

function stagedEntryOf(row: LoadedStagedEntry): StagedEntry {
  const payload = row.payload as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' ? value : null;
  };
  const kind = text('identityKind');
  const digest = text('identityDigest');
  if (kind === null || digest === null || row.entryKey !== entryKeyOf(kind, digest)) {
    throw new Error(`暂存条目身份字段缺失或不一致(${row.entryKey})`);
  }
  return {
    entryKey: row.entryKey,
    identityKind: kind,
    identityDigest: digest,
    title: text('title'),
    url: text('url'),
    tvgId: text('tvgId'),
    groupTitle: text('groupTitle'),
    tvgLogo: text('tvgLogo'),
    relativePath: text('relativePath'),
    sizeText: text('sizeText'),
    mtimeNsText: text('mtimeNsText'),
  };
}

/**
 * T027 NAS 替换清理(发布事务内):媒体分级置空 + 全档案 allowedMediaIds 移除。
 * 策略缺失不补建(FR-003/FR-008);名单解析损坏抛 PolicyCorruptionError 整体回滚。
 */
function applyNasReplacementCleanup(
  db: RefreshTxStore,
  householdId: string,
  replacedMediaIds: ReadonlySet<string>,
  nowIso: string,
): void {
  for (const mediaId of replacedMediaIds) {
    db.nullMediaItemContentLevel(mediaId, householdId, nowIso);
  }
  const profiles = db.listProfileIdsInHousehold(householdId);
  for (const profileId of profiles) {
    const policy = db.findProfilePolicyLists(householdId, profileId);
    if (policy === undefined) {
      continue; // 不自动补建缺失策略;该档案本就没有允许项可清理
    }
    let allowed: string[];
    let blocked: string[];
    try {
      // allowed 与 blocked 都严格解析:任一名单损坏即整体失败,不带着旧允许项继续
      allowed = parseStoredList(policy.allowed_media_ids, 'allowedMediaIds');
      blocked = parseStoredList(policy.blocked_media_ids, 'blockedMediaIds');
    } catch {
      throw new PolicyCorruptionError(`profile ${profileId} 的 allowedMediaIds/blockedMediaIds`);
    }
    void blocked; // blocked 仅用于严格解析(任一名单损坏即整体失败),本事务不写入禁止项
    const filtered = allowed.filter((mediaId) => !replacedMediaIds.has(mediaId));
    if (filtered.length === allowed.length) {
      continue; // 该档案名单未变化:version 不加
    }
    db.updateProfilePolicyAllowedMediaIds(householdId, profileId, JSON.stringify(filtered), nowIso);
  }
}

@Injectable()
export class RefreshPublishService {
  /**
   * 条目快照发布(IPTV/NAS):单事务重验 + upsert + mark missing + NAS 替换清理 + 收尾。
   * 返回 'stale' 时任务已在事务内被标记 stale(终态),调用方无须再改状态。
   */
  publishEntrySnapshot(params: EntryPublishParams): PublishOutcome {
    const nowIso = iso(params.nowMs);
    return sourcesStore().withSqlTransaction((db): PublishOutcome => {
      const stale = this.markStaleAndClear(db, params, nowIso);
      if (!this.revalidate(db, params, stale)) {
        return 'stale';
      }
      const stagedRows = db.loadStagedEntries({ householdId: params.householdId, refreshId: params.refreshId });
      if (stagedSnapshotDigest(stagedRows) !== params.snapshotDigest) {
        stale();
        return 'stale';
      }
      const staged = stagedRows.map(stagedEntryOf).sort((left, right) => (left.entryKey < right.entryKey ? -1 : 1));

      const baselineRows = db.listSourceEntryBaselineRows(params.householdId, params.sourceId);
      const existingByKey = new Map<string, SourceEntryRow>(
        baselineRows.map((row) => [entryKeyOf(row.identity_kind, row.identity_digest), row] as const),
      );
      const stagedKeys = new Set(staged.map((entry) => entry.entryKey));

      // mark missing:baseline present 而 staged 缺席 → present=0 + missing_since(不删行、不动媒体)
      for (const row of baselineRows) {
        if (row.present === 1 && !stagedKeys.has(entryKeyOf(row.identity_kind, row.identity_digest))) {
          db.markSourceEntryMissing(row.id, params.householdId, nowIso);
        }
      }

      // 重验已保证来源行存在(与迁移前同一非空断言语义)
      const source = db.findMediaSourceRecordInHousehold(params.sourceId, params.householdId) as MediaSourceRow;
      const replacedMediaIds = new Set<string>();
      // 016 T018(US3 多线路聚合,research R1):IPTV 快照按 normalizeChannelKey(条目标题)
      // 在「同一 Household」内聚合 —— 命中相同归一键的新条目并入既有逻辑频道 media_item
      // (跨来源生效),不再每个物理流新建一个频道;聚合键覆盖:家庭内既有可聚合频道行
      // (type='channel' 且未人工改名)+ 本事务内已建/已并入的条目。NAS 不聚合(视频逐
      // 文件建档,行为零变化);人工改名频道不参与自动归并(家长人工修正优先)。
      const mediaIdByChannelKey = new Map<string, string>();
      if (params.kind === 'iptv') {
        for (const row of db.listAggregatableChannelMediaRows(params.householdId)) {
          const key = channelKeyOf(row.title);
          if (key !== '' && !mediaIdByChannelKey.has(key)) {
            mediaIdByChannelKey.set(key, row.id);
          }
        }
      }
      // 聚合频道的展示标题裁决:同 media 的首条 staged 条目(entryKey 升序,确定性)为
      // 规范标题 —— 聚合后多条线路指向同一 media,逐条目按各自标题覆写会使标题随
      // 迭代次序漂移;首触裁决保证重导入/多来源场景标题稳定(未人工覆盖时)。
      const canonicalTitleByMedia = new Map<string, string>();
      // T148(005 data-model §2 media_item.content_revision):同一 NAS 身份文件的可信
      // size/mtime 真实变化时,导入发布事务内递增 content_revision(与目录发布原子;
      // 失败/stale/未确认快照不会执行到本写入)。普通标题/分级修改只改既有 version,
      // 不触发修订;同一成功快照重试时 size/mtime 与已存值一致 → 不再递增(幂等)。
      // 缺列容忍(照 hasGroupTitleColumn 惯例):仅应用 0001~0005 的部分迁移库无该列,
      // bump 静默跳过;已就绪库(含 0006)恒执行。
      const hasContentRevisionColumn = db.mediaItemHasContentRevisionColumn();
      // T146:group_title 写入按缺列容忍降级(照本文件 epg_generation 缺列惯例)——
      // 仅应用 0001~0003 的部分迁移库没有 source_entry.group_title 列,发布静默跳过分组写入
      // 不使任务崩溃;已就绪库(含 0006)恒有该列,分组恒随发布事务持久化。
      const hasGroupTitleColumn = db.sourceEntryHasGroupTitleColumn();
      // 014 T015:Logo 数据链路按缺列容忍降级(同 hasGroupTitleColumn 惯例)——
      // 仅应用 0001~0008 的部分迁移库无 source_entry.logo_url/channel_logo(0009 原子
      // 增补),证据写入/胜者合并/墓碑 GC 静默跳过不使发布崩溃;已就绪库(含 0009)恒执行。
      const hasLogoUrlColumn = db.sourceEntryHasLogoUrlColumn();
      const logoParticipant = db.hasChannelLogoTable() ? db.channelLogoParticipant() : null;
      // 014 T033:M2 撤销候选(本快照无 logo 且当前 active(iptv) 的频道;撤销后统一填补)
      const m2RevokedMediaIds: string[] = [];

      for (const entry of staged) {
        const existing = existingByKey.get(entry.entryKey);
        // 016 T018:IPTV 条目的聚合键(归一化标题);NAS 不聚合(空键 = 逐条目建档)
        const channelKey = params.kind === 'iptv' ? channelKeyOf(entry.title ?? '') : '';
        let mediaId = existing?.media_id ?? null;
        if (mediaId === null) {
          // 多线路聚合:命中家庭内既有归一键 → 并入该逻辑频道(跨来源生效),不新建 media_item
          const aggregated = channelKey === '' ? undefined : mediaIdByChannelKey.get(channelKey);
          if (aggregated !== undefined) {
            mediaId = aggregated;
          } else {
            mediaId = randomUUID();
            if (channelKey !== '') {
              mediaIdByChannelKey.set(channelKey, mediaId);
            }
            db.insertMediaItem(mediaId, params.householdId, entryMediaType(params.kind), entryTitleOf(params.kind, entry), nowIso, nowIso);
          }
        } else if (!canonicalTitleByMedia.has(mediaId)) {
          // 人工标题/类型不被刷新覆盖;既有 content_level 一律不改写(仅该 media 首触裁决,
          // 聚合场景多条线路不再逐条目覆写标题 —— 见 canonicalTitleByMedia 注释)
          const media = db.findMediaItemPresentation(mediaId, params.householdId);
          if (media !== undefined) {
            const nextTitle = media.title_overridden === 1 ? media.title : entryTitleOf(params.kind, entry);
            const nextType = media.type_overridden === 1 ? media.type : entryMediaType(params.kind);
            if (nextTitle !== media.title || nextType !== media.type) {
              db.updateMediaItemPresentation(mediaId, params.householdId, nextTitle, nextType, nowIso);
            }
          }
        }
        if (!canonicalTitleByMedia.has(mediaId)) {
          canonicalTitleByMedia.set(mediaId, entryTitleOf(params.kind, entry));
        }

        const entryId = existing?.id ?? randomUUID();
        const upstreamChannelId = params.kind === 'iptv' ? entry.tvgId : null;
        const sizeText = params.kind === 'nas' ? entry.sizeText : null;
        const mtimeNsText = params.kind === 'nas' ? entry.mtimeNsText : null;
        // T146(005 data-model §2):「来源发布/条目更新同事务保存 M3U 分组」——
        // 成功发布事务内写入归一化后的 group_title(NAS 恒 NULL);
        // 失败/stale/未确认快照不会执行到本写入,旧目录分组保持不变。
        const groupTitle = params.kind === 'iptv' ? entry.groupTitle : null;
        if (existing === undefined) {
          if (hasGroupTitleColumn) {
            db.insertSourceEntryWithGroup(
              entryId,
              params.householdId,
              params.sourceId,
              entry.identityKind,
              entry.identityDigest,
              mediaId,
              upstreamChannelId,
              params.refreshId,
              nowIso,
              nowIso,
              sizeText,
              mtimeNsText,
              groupTitle,
            );
          } else {
            db.insertSourceEntry(
              entryId,
              params.householdId,
              params.sourceId,
              entry.identityKind,
              entry.identityDigest,
              mediaId,
              upstreamChannelId,
              params.refreshId,
              nowIso,
              nowIso,
              sizeText,
              mtimeNsText,
            );
          }
        } else {
          // T027:先以更新前事实判定替换,再写入新事实
          if (
            params.kind === 'nas' &&
            (existing.file_size_text !== sizeText || existing.file_mtime_ns !== mtimeNsText)
          ) {
            replacedMediaIds.add(mediaId);
            // T148:真实内容变化(NAS 身份文件 size/mtime 任一不同)→ 同事务递增修订;
            // 标题/分级路径不进入本分支(只改 version,不递增 content_revision)
            if (hasContentRevisionColumn) {
              db.bumpMediaItemContentRevision(mediaId, params.householdId, nowIso);
            }
          }
          if (hasGroupTitleColumn) {
            db.updateSourceEntryWithGroup(
              mediaId,
              upstreamChannelId,
              params.refreshId,
              nowIso,
              sizeText,
              mtimeNsText,
              groupTitle,
              entryId,
              params.householdId,
            );
          } else {
            db.updateSourceEntry(
              mediaId,
              upstreamChannelId,
              params.refreshId,
              nowIso,
              sizeText,
              mtimeNsText,
              entryId,
              params.householdId,
            );
          }
        }

        const playbackId = db.findPlaybackSourceId(params.householdId, entryId);
        const resource = playbackOf(params.kind, entry, source);
        // 016 T018:线路排序权重 = 来源 priority + 清晰度加权(m3u.parser 确定性公式;
        // NAS 不加权恒 100,既有 NAS 行为零变化)。解析多线路(016 T019)按该权重
        // priority ASC 选默认线路;缺列容忍:部分迁移库 SELECT * 无 priority → 公式内兜底 100。
        const linePriority =
          params.kind === 'iptv' ? deriveLinePriority(source.priority, entry.title ?? '') : 100;
        if (playbackId === undefined) {
          db.insertPlaybackSource(
            randomUUID(),
            params.householdId,
            params.sourceId,
            entryId,
            mediaId,
            resource.protocol,
            resource.location,
            nowIso,
            nowIso,
            linePriority,
          );
        } else {
          db.updatePlaybackSource(mediaId, resource.protocol, resource.location, nowIso, playbackId, params.householdId, linePriority);
        }

        // 014 T015(internal-ports §4 时序「写 source_entry(含 logo_url)→ 写 media_item →
        // 对受影响频道逐批合并」):IPTV 条目携带解析层归一化 logo(NAS 恒无 logo)——
        // 发布事务内同事务写私有证据列,并经参与者执行 M1 胜者合并:upsert 签发/复用
        // 引用 → setChannelPosterRef 落 poster_ref。合并细节(url 未变且 active 同源 ⇒
        // 无操作不换 ref;epg 不覆盖 iptv;墓碑复 active)由参与者内部强制(data-model §4);
        // 上游 url 非法已在解析层归一化为 null,不会进入本分支(FR-010:Logo 绝不阻塞导入;
        // 参与者抛错沿事务语义整体回滚,无半状态)。
        const logoUrl = params.kind === 'iptv' ? entry.tvgLogo : null;
        if (hasLogoUrlColumn && params.kind === 'iptv') {
          db.setSourceEntryLogoUrl(logoUrl, entryId, params.householdId);
        }
        if (logoParticipant !== null && logoUrl !== null) {
          const { ref } = logoParticipant.upsertChannelLogoWinner({
            householdId: params.householdId,
            mediaId,
            upstreamUrl: logoUrl,
            sourceKind: 'iptv',
            sourceId: params.sourceId,
            nowIso,
          });
          logoParticipant.setChannelPosterRef(params.householdId, mediaId, ref);
        } else if (logoParticipant !== null && params.kind === 'iptv') {
          // 014 T033 M2(研究 R5「条目 logo_url 为空 → 当前胜者 active(iptv) 才撤销」):
          // 快照移除 logo → active(iptv) 转墓碑 + poster_ref 置 NULL(旧引用随后 410);
          // active(epg)/墓碑/无行一律不动。epg 填补在条目循环后统一执行(关联核心
          // 需要条目全部落位后的 present/关联事实,且集合查询只做一次)。
          const winner = logoParticipant.findChannelLogo(params.householdId, mediaId);
          if (winner !== undefined && winner.revokedAt === null && winner.sourceKind === 'iptv') {
            logoParticipant.revokeChannelLogo(params.householdId, mediaId, nowIso);
            logoParticipant.setChannelPosterRef(params.householdId, mediaId, null);
            m2RevokedMediaIds.push(mediaId);
          }
        }
      }

      if (params.kind === 'nas' && replacedMediaIds.size > 0) {
        applyNasReplacementCleanup(db, params.householdId, replacedMediaIds, nowIso);
      }

      // 014 T033 M2 收尾(data-model §4 M2「撤销后同事务按 M3 逻辑尝试 epg 填补,
      // 若无绑定/icon 则留墓碑」):仅存在撤销候选时才装载关联核心(固定次数集合查询,
      // 不随频道数线性增长;NAS/无 Logo 变化的发布零开销)。
      if (logoParticipant !== null) {
        fillEpgEvidenceForRevoked(db, logoParticipant, params.householdId, m2RevokedMediaIds, nowIso);
      }

      // 014 T015:墓碑 GC 随发布事务顺带执行一次(集合 DELETE,非逐条;data-model §4
      // 「revoked_at ≤ now−7d 的行在任一发布事务内集合 DELETE,无后台任务」;仅触本家庭,
      // active 行不受影响;失败/stale 路径早退,不会执行到此)
      logoParticipant?.gcExpiredChannelLogoTombstones(
        params.householdId,
        iso(params.nowMs - CHANNEL_LOGO_TOMBSTONE_WINDOW_MS),
      );

      this.finalizeSuccess(db, params, nowIso, canonicalJson({ counts: params.counts }));
      return 'succeeded';
    });
  }

  /**
   * EPG 窗口原子发布:同事务删除本来源旧窗口并写入新频道/节目;
   * 完全相同节目按唯一键去重,冲突标记照解析器结论;不创建 MediaItem、不改分级;
   * 成功路径同事务 media_source.epg_generation+1(US5/ADR-0008;失败/回滚/stale 不加),
   * 且绝不触碰 manual_epg_binding(手动配置跨刷新保留)。
   *
   * 014 T033(频道 Logo EPG 发布链,internal-ports.md §4「EPG 刷新发布事务」时序):
   * - epg_channel.icon_url 私有证据随窗口 upsert 同事务写入(XMLTV 解析层归一化产物;
   *   缺列容忍沿 hasGroupTitleColumn 惯例,0001~0008 部分迁移库静默跳过);
   * - 受限合并 M3/M4:「受影响且已绑定频道」集合 = 关联核心(loadChannelAssociationCore)
   *   解析出、关联对落在本来源且在本次窗口内的频道(绑定谓词与 live-projection 的
   *   upstream 精确匹配同源,禁止第三份判定逻辑;manual 优先/失效不回退/自动精确/
   *   conflicted=0 全由核心承担):icon_url 非空 → M3 写/复 active(epg)(参与者强制
   *   「epg 绝不覆盖 active(iptv)」与同 url 无操作);icon_url 为空 → M4 撤 active(epg);
   * - M4 绑定失效:窗口替换前仍绑定本来源、替换后不再绑定(频道移出窗口/转 conflicted)
   *   的频道,撤 active(epg) 转墓碑 —— 「窗口前」绑定集合在删除旧窗口前经同一核心读取,
   *   BEGIN IMMEDIATE 同连接事务内读算写原子;
   * - 墓碑 GC 与 IPTV 发布事务同款:收尾前顺带集合 DELETE revoked_at ≤ now−7d 行。
   */
  publishEpgWindow(params: EpgPublishParams): PublishOutcome {
    const nowIso = iso(params.nowMs);
    return sourcesStore().withSqlTransaction((db): PublishOutcome => {
      const stale = this.markStaleAndClear(db, params, nowIso);
      if (!this.revalidate(db, params, stale)) {
        return 'stale';
      }
      // 014 T033:Logo 能力守卫(channel_logo 表与 epg_channel.icon_url 列同属 0009 原子
      // 增补;缺任一即整段合并静默跳过,不使发布崩溃 —— 与 IPTV 侧 hasChannelLogoTable
      // 同款守卫)
      const logoParticipant = db.hasChannelLogoTable() ? db.channelLogoParticipant() : null;
      // M4 绑定失效检测输入:窗口替换「前」仍绑定本来源的频道集合(同一核心、同一连接)
      const boundBefore = new Set<string>();
      if (logoParticipant !== null) {
        const coreBefore = loadChannelAssociationCore(params.householdId);
        for (const [mediaId, pairKey] of coreBefore.associationByMedia) {
          const pair = pairKey === null ? null : splitPairKey(pairKey);
          if (pair !== null && pair.sourceId === params.sourceId) {
            boundBefore.add(mediaId);
          }
        }
      }

      db.deleteEpgProgrammes(params.householdId, params.sourceId);
      db.deleteEpgChannels(params.householdId, params.sourceId);

      const conflicted = new Set(params.conflictedChannelIds);
      // 014 T033:icon_url 随窗口 upsert 同事务写入(解析层归一化,非法已在解析层归 null)
      const hasIconUrlColumn = db.epgChannelHasIconUrlColumn();
      for (const channel of params.channels) {
        if (hasIconUrlColumn) {
          db.insertEpgChannelWithIcon(params.householdId, params.sourceId, channel.xmltvChannelId, channel.displayName ?? channel.xmltvChannelId, conflicted.has(channel.xmltvChannelId) ? 1 : 0, channel.iconUrl);
        } else {
          db.insertEpgChannel(params.householdId, params.sourceId, channel.xmltvChannelId, channel.displayName ?? channel.xmltvChannelId, conflicted.has(channel.xmltvChannelId) ? 1 : 0);
        }
      }

      const seenSlots = new Set<string>();
      let storedProgrammes = 0;
      for (const programme of params.programmes) {
        const startsAt = programme.startsAtUtc.toISOString();
        const endsAt = programme.endsAtUtc.toISOString();
        const slot = `${programme.xmltvChannelId}\u0000${startsAt}\u0000${endsAt}`;
        if (seenSlots.has(slot)) {
          continue; // 完全相同节目去重
        }
        seenSlots.add(slot);
        const poster = params.posterByTitle?.get(programme.title);
        const posterMatchKey = poster?.matchKey ?? posterMatchKeyOf(programme.title);
        const posterRef = poster?.ref ?? null;
        storedProgrammes += db.insertEpgProgrammeIfAbsent(
          randomUUID(),
          params.householdId,
          params.sourceId,
          programme.xmltvChannelId,
          programme.title,
          programme.description,
          startsAt,
          endsAt,
          posterMatchKey,
          posterRef,
        );
      }

      // 014 T033:受限合并 M3/M4(窗口已落位,核心此刻读取到新绑定事实)
      if (logoParticipant !== null) {
        const iconByChannelId = new Map(params.channels.map((channel) => [channel.xmltvChannelId, channel.iconUrl] as const));
        const coreAfter = loadChannelAssociationCore(params.householdId);
        const stillBound = new Set<string>();
        for (const [mediaId, pairKey] of coreAfter.associationByMedia) {
          const pair = pairKey === null ? null : splitPairKey(pairKey);
          if (pair === null || pair.sourceId !== params.sourceId) {
            continue; // 只合并本来源窗口的绑定对(他源窗口不受本次发布影响)
          }
          const icon = iconByChannelId.get(pair.xmltvChannelId) ?? null;
          if (icon === undefined) {
            continue; // 关联对本源但频道不在本次窗口(理论不可达:本源 epg_channel 即窗口)
          }
          stillBound.add(mediaId);
          if (icon !== null) {
            // M3:icon 非空 → 写/复 active(epg);active(iptv) 与同 url active(epg)
            // 的无操作语义由参与者内部强制(返回生效引用,发布方据此落 poster_ref)
            const { ref } = logoParticipant.upsertChannelLogoWinner({
              householdId: params.householdId,
              mediaId,
              upstreamUrl: icon,
              sourceKind: 'epg',
              sourceId: params.sourceId,
              nowIso,
            });
            logoParticipant.setChannelPosterRef(params.householdId, mediaId, ref);
          } else {
            // M4(绑定仍在、icon 变空):仅撤 active(epg),active(iptv) 不动
            revokeEpgWinnerIfActive(logoParticipant, params.householdId, mediaId, nowIso);
          }
        }
        // M4(绑定失效):窗口前绑定、窗口后不再绑定(移出窗口/转 conflicted/手动失效)
        for (const mediaId of boundBefore) {
          if (!stillBound.has(mediaId)) {
            revokeEpgWinnerIfActive(logoParticipant, params.householdId, mediaId, nowIso);
          }
        }
      }

      // 014 T033:墓碑 GC 与 IPTV 发布事务同款(收尾前顺带集合 DELETE 一次,仅触本家庭;
      // data-model §4「revoked_at ≤ now−7d 的行在任一发布事务内集合 DELETE,无后台任务」;
      // 失败/stale 路径早退,不会执行到此)
      logoParticipant?.gcExpiredChannelLogoTombstones(
        params.householdId,
        iso(params.nowMs - CHANNEL_LOGO_TOMBSTONE_WINDOW_MS),
      );

      this.finalizeSuccess(
        db,
        params,
        nowIso,
        canonicalJson({ counts: { channels: params.channels.length, programmes: storedProgrammes } }),
      );
      // US5/ADR-0008(T070):EPG 成功发布的同事务内 epg_generation+1 —— 与窗口替换/收尾原子;
      // 仅 kind=epg 的该来源行;失败/回滚/stale 均不会执行到此(事务早退或整体回滚)。
      // EPG 刷新绝不写/删 manual_epg_binding(手动配置跨刷新/重启保留)。
      // 缺列容忍(照 hasSourceRefreshTable 的未就绪库降级惯例):仅应用 0001~0003 的
      // 部分迁移库(就绪检查应 503)没有 epg_generation 列,bump 静默跳过不使发布崩溃;
      // 已就绪库(含 0004)恒有该列,bump 恒执行。
      const hasGenerationColumn = db.mediaSourceHasEpgGenerationColumn();
      if (hasGenerationColumn) {
        db.bumpMediaSourceEpgGeneration(params.sourceId, params.householdId);
      }
      return 'succeeded';
    });
  }

  /** 发布重验:来源存在且启用、source.version、catalog revision、job version、摘要落库一致 */
  private revalidate(
    db: RefreshTxStore,
    params: {
      householdId: string;
      sourceId: string;
      refreshId: string;
      jobVersion: number;
      sourceVersion: number;
      baselineRevision: number;
      snapshotDigest: string;
    },
    stale: () => void,
  ): boolean {
    const source = db.findMediaSourceEnabledVersion(params.sourceId, params.householdId);
    if (source === undefined || source.enabled !== 1 || source.version !== params.sourceVersion) {
      stale();
      return false;
    }
    const catalogRevision = db.getCatalogRevision(params.householdId);
    if (catalogRevision === undefined || catalogRevision !== params.baselineRevision) {
      stale();
      return false;
    }
    const job = db.findRefreshJobVersionAndDigest(params.householdId, params.refreshId);
    if (job === undefined || job.version !== params.jobVersion || job.snapshotDigest !== params.snapshotDigest) {
      stale();
      return false;
    }
    return true;
  }

  /** stale 标记(发布事务内,原子):status='stale'、version+1、finished_at、清理暂存 */
  private markStaleAndClear(
    db: RefreshTxStore,
    params: { householdId: string; refreshId: string },
    nowIso: string,
  ): () => void {
    return (): void => {
      db.markRefreshJobStaleAndClearStaged(params.householdId, params.refreshId, nowIso);
    };
  }

  /** 收尾(同一事务):来源成功信息、job succeeded、catalog revision+1、清理已发布快照的暂存 */
  private finalizeSuccess(
    db: RefreshTxStore,
    params: { householdId: string; sourceId: string; refreshId: string },
    nowIso: string,
    summaryJson: string,
  ): void {
    db.recordMediaSourceSuccess(params.sourceId, params.householdId, params.refreshId, nowIso);
    db.markRefreshJobSucceeded(params.householdId, params.refreshId, nowIso, summaryJson);
    db.incrementCatalogRevision(params.householdId);
    // 快照已发布:暂存数据完成使命,同事务清理(与成功终态原子)
    db.clearStagedEntries({ householdId: params.householdId, refreshId: params.refreshId });
  }
}
