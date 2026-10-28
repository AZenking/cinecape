import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { canonicalJson, type DiffCounts } from '@contexts/sources/infrastructure/catalog-diff';
import {
  computeSnapshotDigest as stagedSnapshotDigest,
  type LoadedStagedEntry,
} from '@contexts/sources/infrastructure/refresh-staging.service';
import { parseStoredList } from '@contexts/policy';
import type { XMLTVChannel, XMLTVProgramme } from '@contexts/sources/infrastructure/xmltv.parser';
// 008-T009(ADR-0015 D1):数据访问经仓储端口 seam,发布事务经 withSqlTransaction 表达
// (原生 SQL 逐字迁移至 infrastructure/sources-store.drizzle.ts,行为零变化)
import {
  sourcesStore,
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

      for (const entry of staged) {
        const existing = existingByKey.get(entry.entryKey);
        let mediaId = existing?.media_id ?? null;
        if (mediaId === null) {
          mediaId = randomUUID();
          db.insertMediaItem(mediaId, params.householdId, entryMediaType(params.kind), entryTitleOf(params.kind, entry), nowIso, nowIso);
        } else {
          // 人工标题/类型不被刷新覆盖;既有 content_level 一律不改写
          const media = db.findMediaItemPresentation(mediaId, params.householdId);
          if (media !== undefined) {
            const nextTitle = media.title_overridden === 1 ? media.title : entryTitleOf(params.kind, entry);
            const nextType = media.type_overridden === 1 ? media.type : entryMediaType(params.kind);
            if (nextTitle !== media.title || nextType !== media.type) {
              db.updateMediaItemPresentation(mediaId, params.householdId, nextTitle, nextType, nowIso);
            }
          }
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
          );
        } else {
          db.updatePlaybackSource(mediaId, resource.protocol, resource.location, nowIso, playbackId, params.householdId);
        }
      }

      if (params.kind === 'nas' && replacedMediaIds.size > 0) {
        applyNasReplacementCleanup(db, params.householdId, replacedMediaIds, nowIso);
      }

      this.finalizeSuccess(db, params, nowIso, canonicalJson({ counts: params.counts }));
      return 'succeeded';
    });
  }

  /**
   * EPG 窗口原子发布:同事务删除本来源旧窗口并写入新频道/节目;
   * 完全相同节目按唯一键去重,冲突标记照解析器结论;不创建 MediaItem、不改分级;
   * 成功路径同事务 media_source.epg_generation+1(US5/ADR-0008;失败/回滚/stale 不加),
   * 且绝不触碰 manual_epg_binding(手动配置跨刷新保留)。
   */
  publishEpgWindow(params: EpgPublishParams): PublishOutcome {
    const nowIso = iso(params.nowMs);
    return sourcesStore().withSqlTransaction((db): PublishOutcome => {
      const stale = this.markStaleAndClear(db, params, nowIso);
      if (!this.revalidate(db, params, stale)) {
        return 'stale';
      }
      db.deleteEpgProgrammes(params.householdId, params.sourceId);
      db.deleteEpgChannels(params.householdId, params.sourceId);

      const conflicted = new Set(params.conflictedChannelIds);
      for (const channel of params.channels) {
        db.insertEpgChannel(params.householdId, params.sourceId, channel.xmltvChannelId, channel.displayName ?? channel.xmltvChannelId, conflicted.has(channel.xmltvChannelId) ? 1 : 0);
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
        storedProgrammes += db.insertEpgProgrammeIfAbsent(
          randomUUID(),
          params.householdId,
          params.sourceId,
          programme.xmltvChannelId,
          programme.title,
          programme.description,
          startsAt,
          endsAt,
        );
      }

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
