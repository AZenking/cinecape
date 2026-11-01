/**
 * personal-data 仓储 Drizzle 实现（008-repository-extraction T005，ADR-0015 D1）。
 *
 * 查询代码自 application 的 favorites.service / history.service /
 * progress-write.service / progress-clock.service 逐字迁移（008 FR-002：join 链、
 * 谓词、分块参数、返回形态均不变）；行→DTO/判定视图的映射留在 application。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzlePersonalDataStore(db) 以固定句柄构造（内存库）。句柄来自
 * @platform/database/drizzle（008 实施修正：句柄归属平台层，infrastructure→platform
 * 为 R1c 合法边，且不经任何发布面——避免测试 setup 预加载 identity-access 面破坏 vi.mock）。
 *
 * 事务语义原样保留：withTransaction 经 getDb().transaction 透传 —— stop 协作路径
 * （applyFinalInTransaction 在调用方 lifecycle 事务内被调用）保持 better-sqlite3
 * 嵌套事务自动 savepoint 的既有行为。
 *
 * 010 T040 增量:upsertHistoryRow 携带可选在线保存证据 + completed 重置(新实际活动);
 * 新增 applyLedgerSample(会话 ledger 接受游标)与 findVodEpisodeEvidenceFacts(在线
 * 证据事实)。既有查询逐字不变。
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  mediaItem,
  playbackProgressState,
  playbackSession,
  profileChannelFavorite,
  profileProgressClock,
  profileViewingHistory,
  vodEpisode,
} from '@platform/database/schema';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  FavoriteRow,
  HistoryRow,
  HistoryUpsertInput,
  KeysetAnchor,
  LedgerSampleApplySet,
  MediaItemRow,
  PersonalDataStore,
  PersonalDataTxStore,
  PlaybackSessionRow,
  ProgressStateBookkeepingSet,
  ProgressStateInsertValues,
  ProgressStateRow,
  VodEpisodeEvidenceFacts,
} from '@contexts/personal-data/application/personal-data-store.port';

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzlePersonalDataTxStore implements PersonalDataTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveHandle(this.source);
  }

  findPlaybackSessionRow(householdId: string, sessionId: string): PlaybackSessionRow | undefined {
    return this.db()
      .select()
      .from(playbackSession)
      .where(and(eq(playbackSession.householdId, householdId), eq(playbackSession.id, sessionId)))
      .get();
  }

  findSessionGeneration(householdId: string, sessionId: string): number | undefined {
    return this.db()
      .select({ generation: playbackSession.generation })
      .from(playbackSession)
      .where(and(eq(playbackSession.householdId, householdId), eq(playbackSession.id, sessionId)))
      .get()?.generation;
  }

  findProgressStateRow(householdId: string, sessionId: string): ProgressStateRow | undefined {
    return this.db()
      .select()
      .from(playbackProgressState)
      .where(
        and(eq(playbackProgressState.householdId, householdId), eq(playbackProgressState.playbackSessionId, sessionId)),
      )
      .get();
  }

  findHistoryRow(householdId: string, profileId: string, mediaId: string): HistoryRow | undefined {
    return this.db()
      .select()
      .from(profileViewingHistory)
      .where(
        and(
          eq(profileViewingHistory.householdId, householdId),
          eq(profileViewingHistory.profileId, profileId),
          eq(profileViewingHistory.mediaId, mediaId),
        ),
      )
      .get();
  }

  findMediaRow(householdId: string, mediaId: string): MediaItemRow | undefined {
    return this.db()
      .select()
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
  }

  findMediaType(householdId: string, mediaId: string): string | undefined {
    return this.db()
      .select({ type: mediaItem.type })
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get()?.type;
  }

  findMediaContentRevision(householdId: string, mediaId: string): number | undefined {
    return this.db()
      .select({ contentRevision: mediaItem.contentRevision })
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get()?.contentRevision;
  }

  findMediaIdAndType(householdId: string, mediaId: string): { id: string; type: string } | undefined {
    return this.db()
      .select({ id: mediaItem.id, type: mediaItem.type })
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
  }

  /**
   * 历史写入(取得写入权 = upsert;owner 继续 = update;revision 实际更新递增)。
   *
   * 010 T040(data-model §5):写入即「新实际活动」——completed 重置 0(只由有效
   * finish 写,新活动重置);时长 COALESCE 保留既有可信值(与 T016 HistoryTx 逐字
   * 同语义,在线 probe 不回填/不清除全局历史时长);evidence 省略 = 静态媒体旧义
   * (INSERT 落 NULL、UPDATE 不动),显式携带 = 在线保存证据与 ledger 同事务落库。
   */
  upsertHistoryRow(input: HistoryUpsertInput): number {
    const existing = this.findHistoryRow(input.householdId, input.profileId, input.mediaId);
    const nextRevision = (existing?.revision ?? 0) + 1;
    const baseValues = {
      writerEpoch: input.candidateEpoch,
      writerPlaybackSessionId: input.playbackSessionId,
      lastSampleSeq: input.sampleSeq,
      contentRevision: input.contentRevision,
      positionSeconds: input.positionSeconds,
      lastViewedAt: input.at,
      revision: nextRevision,
    };
    const evidenceValues =
      input.evidence === undefined
        ? {}
        : {
            continuityRevision: input.evidence.continuityRevision,
            evidenceState: input.evidence.evidenceState,
            evidenceDigest: input.evidence.evidenceDigest,
          };
    this.db()
      .insert(profileViewingHistory)
      .values({
        householdId: input.householdId,
        profileId: input.profileId,
        mediaId: input.mediaId,
        ...baseValues,
        durationSeconds: input.trustedDuration,
        completed: 0,
        ...evidenceValues,
      })
      .onConflictDoUpdate({
        target: [
          profileViewingHistory.householdId,
          profileViewingHistory.profileId,
          profileViewingHistory.mediaId,
        ],
        set: {
          ...baseValues,
          // 时长 COALESCE 保留既有可信值(与 T016 HistoryTx.upsertHistoryWithEpoch
          // 逐字同语义;接受路径 trustedDuration 恒非 NULL,空值不清除全局时长)
          durationSeconds: sql`COALESCE(${input.trustedDuration}, ${profileViewingHistory.durationSeconds})`,
          completed: 0,
          ...evidenceValues,
        },
      })
      .run();
    return nextRevision;
  }

  /** 状态簿记（seq/digest/started/last_result）；started 省略 = 不更新该列 */
  updateProgressStateRow(householdId: string, sessionId: string, set: ProgressStateBookkeepingSet): void {
    this.db()
      .update(playbackProgressState)
      .set({
        started: set.started,
        lastSampleSeq: set.lastSampleSeq,
        lastSampleDigest: set.lastSampleDigest,
        lastGeneration: set.lastGeneration,
        lastResult: set.lastResult,
      })
      .where(
        and(eq(playbackProgressState.householdId, householdId), eq(playbackProgressState.playbackSessionId, sessionId)),
      )
      .run();
  }

  /**
   * 会话 ledger 接受样本推进(010 T040;SQL 与 T016 SessionLedgerTx.applyAcceptedSample
   * 逐字同语义,仅一处差异:last_result 不清空 —— duplicate 重放依赖原始结果记忆,
   * 由结果簿记在同事务内覆写;stale/duplicate 不走本写,零更新)。
   */
  applyLedgerSample(householdId: string, sessionId: string, values: LedgerSampleApplySet): void {
    this.db()
      .update(playbackProgressState)
      .set({
        lastSampleSeq: values.sampleSeq,
        lastSampleDigest: values.sampleDigest,
        lastGeneration: values.generation,
        continuityRevision: values.continuityRevision,
        ledgerPosition: values.positionSeconds,
        ledgerDuration: values.durationSeconds,
        ledgerGeneration: values.generation,
        ledgerAcceptedAt: values.acceptedAt,
        sessionStarted: sql`MAX(${playbackProgressState.sessionStarted}, ${values.sessionStarted ? 1 : 0})`,
      })
      .where(
        and(eq(playbackProgressState.householdId, householdId), eq(playbackProgressState.playbackSessionId, sessionId)),
      )
      .run();
  }

  /** 在线子项证据事实投影(010 T040;唯一 (household, media) 投影,静态媒体 undefined) */
  findVodEpisodeEvidenceFacts(householdId: string, mediaId: string): VodEpisodeEvidenceFacts | undefined {
    const row = this.db()
      .select({
        contentVersionState: vodEpisode.contentVersionState,
        evidenceDigest: vodEpisode.evidenceDigest,
        continuityRevision: vodEpisode.continuityRevision,
      })
      .from(vodEpisode)
      .where(and(eq(vodEpisode.householdId, householdId), eq(vodEpisode.mediaId, mediaId)))
      .get();
    if (row === undefined) {
      return undefined;
    }
    return {
      contentVersionState: row.contentVersionState === 'verified' ? 'verified' : 'unverified',
      evidenceDigest: row.evidenceDigest,
      continuityRevision: row.continuityRevision,
    };
  }

  findProgressClockNextEpoch(householdId: string, profileId: string): number | undefined {
    return this.db()
      .select({ nextEpoch: profileProgressClock.nextEpoch })
      .from(profileProgressClock)
      .where(and(eq(profileProgressClock.householdId, householdId), eq(profileProgressClock.profileId, profileId)))
      .get()?.nextEpoch;
  }

  insertProgressClockRow(householdId: string, profileId: string, nextEpoch: number): void {
    this.db()
      .insert(profileProgressClock)
      .values({ householdId, profileId, nextEpoch })
      .run();
  }

  bumpProgressClockNextEpoch(householdId: string, profileId: string): void {
    this.db()
      .update(profileProgressClock)
      .set({ nextEpoch: sql`${profileProgressClock.nextEpoch} + 1` })
      .where(
        and(
          eq(profileProgressClock.householdId, householdId),
          eq(profileProgressClock.profileId, profileId),
        ),
      )
      .run();
  }

  insertProgressStateRow(values: ProgressStateInsertValues): void {
    this.db()
      .insert(playbackProgressState)
      .values(values)
      .onConflictDoNothing()
      .run();
  }
}

class DrizzlePersonalDataStore extends DrizzlePersonalDataTxStore implements PersonalDataStore {
  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(handle === undefined ? getDb : () => handle);
  }

  listFavoriteRowsAfter(householdId: string, profileId: string, anchor: KeysetAnchor | null, limit: number): FavoriteRow[] {
    // 键集谓词逐字迁移:(created_at, media_id) 双列 DESC 严格后继
    const predicate = anchor === null
      ? and(
          eq(profileChannelFavorite.householdId, householdId),
          eq(profileChannelFavorite.profileId, profileId),
        )
      : and(
          eq(profileChannelFavorite.householdId, householdId),
          eq(profileChannelFavorite.profileId, profileId),
          sql`(${profileChannelFavorite.createdAt} < ${anchor.sortAt} OR (${profileChannelFavorite.createdAt} = ${anchor.sortAt} AND ${profileChannelFavorite.mediaId} < ${anchor.mediaId}))`,
        );
    return this.db()
      .select()
      .from(profileChannelFavorite)
      .where(predicate)
      .orderBy(desc(profileChannelFavorite.createdAt), desc(profileChannelFavorite.mediaId))
      .limit(limit)
      .all();
  }

  listHistoryRowsAfter(householdId: string, profileId: string, anchor: KeysetAnchor | null, limit: number): HistoryRow[] {
    // 键集谓词逐字迁移:(last_viewed_at, media_id) 双列 DESC 严格后继
    const predicate =
      anchor === null
        ? and(eq(profileViewingHistory.householdId, householdId), eq(profileViewingHistory.profileId, profileId))
        : and(
            eq(profileViewingHistory.householdId, householdId),
            eq(profileViewingHistory.profileId, profileId),
            sql`(${profileViewingHistory.lastViewedAt} < ${anchor.sortAt} OR (${profileViewingHistory.lastViewedAt} = ${anchor.sortAt} AND ${profileViewingHistory.mediaId} < ${anchor.mediaId}))`,
          );
    return this.db()
      .select()
      .from(profileViewingHistory)
      .where(predicate)
      .orderBy(desc(profileViewingHistory.lastViewedAt), desc(profileViewingHistory.mediaId))
      .limit(limit)
      .all();
  }

  listMediaRowsByIds(householdId: string, mediaIds: readonly string[]): MediaItemRow[] {
    return this.db()
      .select()
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), sql`${mediaItem.id} IN (${sql.join(mediaIds.map((id) => sql`${id}`), sql`, `)})`))
      .all();
  }

  findHistoryDurationByMedia(householdId: string, mediaId: string): { durationSeconds: number | null } | undefined {
    return this.db()
      .select({ durationSeconds: profileViewingHistory.durationSeconds })
      .from(profileViewingHistory)
      .where(and(eq(profileViewingHistory.householdId, householdId), eq(profileViewingHistory.mediaId, mediaId)))
      .get();
  }

  insertFavoriteRow(householdId: string, profileId: string, mediaId: string, createdAt: string): void {
    this.db().transaction((tx) => {
      // INSERT OR IGNORE:主键三元组冲突时保留首行(created_at 首次收藏固定)
      tx.insert(profileChannelFavorite)
        .values({
          householdId,
          profileId,
          mediaId,
          createdAt,
        })
        .onConflictDoNothing()
        .run();
    });
  }

  deleteFavoriteRow(householdId: string, profileId: string, mediaId: string): void {
    this.db()
      .delete(profileChannelFavorite)
      .where(
        and(
          eq(profileChannelFavorite.householdId, householdId),
          eq(profileChannelFavorite.profileId, profileId),
          eq(profileChannelFavorite.mediaId, mediaId),
        ),
      )
      .run();
  }

  withTransaction<T>(fn: (tx: PersonalDataTxStore) => T): T {
    return this.db().transaction((tx) => fn(new DrizzlePersonalDataTxStore(tx)));
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzlePersonalDataStore(handle?: Db): PersonalDataStore {
  return new DrizzlePersonalDataStore(handle);
}
