/**
 * playback 仓储 Drizzle 实现（008-repository-extraction T013，ADR-0015 D1）。
 *
 * 查询代码自 6 个 application 服务（playback-authorization / playback-audit /
 * playback-resolver / playback-selection / playback-ticket / playback-retention）
 * 与 playback.module 的 PlaybackConversionBridge 逐字迁移（008 FR-002：join 链、
 * 谓词、投影列集、返回形态均不变）。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzlePlaybackStore(db) 以固定句柄构造（内存库）。句柄来自 @platform/database/drizzle
 * （ADR-0015 D1 实施修正：句柄归属平台层，infrastructure→platform 为 R1c 合法边，
 * 且不经任何发布面——避免测试 setup 预加载 identity-access 面破坏 vi.mock）。
 *
 * 迁移前全部调用点均为事务外单语句（自动提交）：generation CAS / 票据签发短事务 /
 * BEGIN IMMEDIATE 写路径仍全部位于 infrastructure/playback.repository（既有合法层），
 * 本实现不引入新事务边界（行为零变化）。
 */
import { and, eq, inArray, lt, lte } from 'drizzle-orm';
import {
  account,
  device,
  deviceSession,
  mediaItem,
  mediaSource,
  playbackConversion,
  playbackFailureEvent,
  playbackSession,
  playbackSource,
  playbackTicket,
  profile,
  profilePolicy,
  sourceEntry,
} from '@platform/database/schema';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  EnabledPlaybackResourceRow,
  FailureEventInsert,
  MediaItemRow,
  PlaybackSessionRow,
  PlaybackStore,
  ProfilePolicyDefaultInsert,
  ProfileRow,
  TicketRow,
  TrustedSessionRow,
} from '@contexts/playback/application/playback-store.port';

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzlePlaybackStore implements PlaybackStore {
  private readonly source: HandleSource;

  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    this.source = handle === undefined ? getDb : () => handle;
  }

  private db(): Db {
    return resolveHandle(this.source);
  }

  /* ---------- 授权管线（playback-authorization.service） ---------- */

  findTrustedSessionRow(sessionId: string): TrustedSessionRow | undefined {
    return this.db()
      .select({
        sessionId: deviceSession.id,
        sessionHouseholdId: deviceSession.householdId,
        sessionAccountId: deviceSession.accountId,
        sessionDeviceId: deviceSession.deviceId,
        activeProfileId: deviceSession.activeProfileId,
        sessionExpiresAt: deviceSession.expiresAt,
        sessionRevokedAt: deviceSession.revokedAt,
        accountUsername: account.username,
        accountRole: account.role,
        accountHouseholdId: account.householdId,
        deviceRevokedAt: device.revokedAt,
        profileHouseholdId: profile.householdId,
        profileAccountId: profile.accountId,
        profileContextVersion: deviceSession.profileContextVersion,
      })
      .from(deviceSession)
      .innerJoin(account, eq(account.id, deviceSession.accountId))
      .innerJoin(device, eq(device.id, deviceSession.deviceId))
      .leftJoin(profile, eq(profile.id, deviceSession.activeProfileId))
      .where(eq(deviceSession.id, sessionId))
      .get();
  }

  findDeviceSessionContextVersion(sessionId: string): { profileContextVersion: number } | undefined {
    return this.db()
      .select({ profileContextVersion: deviceSession.profileContextVersion })
      .from(deviceSession)
      .where(eq(deviceSession.id, sessionId))
      .get();
  }

  findProfileRowById(profileId: string): ProfileRow | undefined {
    return this.db().select().from(profile).where(eq(profile.id, profileId)).get();
  }

  findProfileRowInHousehold(householdId: string, profileId: string): ProfileRow | undefined {
    return this.db()
      .select()
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.id, profileId)))
      .get();
  }

  findHouseholdProfileId(householdId: string, profileId: string): { id: string } | undefined {
    return this.db()
      .select({ id: profile.id })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.id, profileId)))
      .get();
  }

  findHouseholdMediaId(householdId: string, mediaId: string): { id: string } | undefined {
    return this.db()
      .select({ id: mediaItem.id })
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
  }

  findPresentSourceEntryId(householdId: string, mediaId: string): { id: string } | undefined {
    return this.db()
      .select({ id: sourceEntry.id })
      .from(sourceEntry)
      .where(
        and(
          eq(sourceEntry.householdId, householdId),
          eq(sourceEntry.mediaId, mediaId),
          eq(sourceEntry.present, 1),
        ),
      )
      .get();
  }

  findPlaybackSourceIdByMedia(householdId: string, mediaId: string): { id: string } | undefined {
    return this.db()
      .select({ id: playbackSource.id })
      .from(playbackSource)
      .where(and(eq(playbackSource.householdId, householdId), eq(playbackSource.mediaItemId, mediaId)))
      .get();
  }

  findMediaItemRowInHousehold(householdId: string, mediaId: string): MediaItemRow | undefined {
    return this.db()
      .select()
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
  }

  findMediaItemType(householdId: string, mediaId: string): { type: string } | undefined {
    return this.db()
      .select({ type: mediaItem.type })
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
  }

  findProfilePolicyProfileId(profileId: string): { profileId: string } | undefined {
    return this.db()
      .select({ profileId: profilePolicy.profileId })
      .from(profilePolicy)
      .where(eq(profilePolicy.profileId, profileId))
      .get();
  }

  insertProfilePolicyOnConflictNothing(values: ProfilePolicyDefaultInsert): void {
    this.db()
      .insert(profilePolicy)
      .values({
        householdId: values.householdId,
        profileId: values.profileId,
        maxContentLevel: values.maxContentLevel,
        allowUnrated: values.allowUnrated,
        allowedMediaIds: values.allowedMediaIds,
        blockedMediaIds: values.blockedMediaIds,
        allowedChannelIds: values.allowedChannelIds,
        version: values.version,
        updatedAt: values.updatedAt,
      })
      .onConflictDoNothing()
      .run();
  }

  listEnabledPlaybackResourceRows(householdId: string, mediaId: string): EnabledPlaybackResourceRow[] {
    return this.db()
      .select({
        playbackSourceId: playbackSource.id,
        sourceId: playbackSource.sourceId,
        protocol: playbackSource.protocol,
      })
      .from(playbackSource)
      .innerJoin(
        mediaSource,
        and(eq(mediaSource.householdId, playbackSource.householdId), eq(mediaSource.id, playbackSource.sourceId)),
      )
      .innerJoin(
        sourceEntry,
        and(eq(sourceEntry.householdId, playbackSource.householdId), eq(sourceEntry.id, playbackSource.sourceEntryId)),
      )
      .where(
        and(
          eq(playbackSource.householdId, householdId),
          eq(playbackSource.mediaItemId, mediaId),
          eq(sourceEntry.mediaId, mediaId),
          eq(mediaSource.enabled, 1),
          eq(sourceEntry.present, 1),
        ),
      )
      .all();
  }

  /* ---------- 审计（playback-audit.service） ---------- */

  insertFailureEvent(values: FailureEventInsert): void {
    this.db()
      .insert(playbackFailureEvent)
      .values({
        id: values.id,
        householdId: values.householdId,
        deviceSessionId: values.deviceSessionId,
        deviceId: values.deviceId,
        profileId: values.profileId,
        mediaId: values.mediaId,
        occurredAt: values.occurredAt,
        stableCode: values.stableCode,
      })
      .run();
  }

  /* ---------- 解析（playback-resolver.service） ---------- */

  findSessionMediaId(sessionId: string): { mediaId: string } | undefined {
    return this.db()
      .select({ mediaId: playbackSession.mediaId })
      .from(playbackSession)
      .where(eq(playbackSession.id, sessionId))
      .get();
  }

  findSessionContextBinding(sessionId: string): { profileContextVersion: number; deviceSessionId: string } | undefined {
    return this.db()
      .select({
        profileContextVersion: playbackSession.profileContextVersion,
        deviceSessionId: playbackSession.deviceSessionId,
      })
      .from(playbackSession)
      .where(eq(playbackSession.id, sessionId))
      .get();
  }

  /* ---------- 换代票撤销卫生层（playback-selection.service） ---------- */

  listSessionTicketRows(sessionId: string): Array<{ id: string; revokedAt: string | null }> {
    return this.db()
      .select({ id: playbackTicket.id, revokedAt: playbackTicket.revokedAt })
      .from(playbackTicket)
      .where(eq(playbackTicket.sessionId, sessionId))
      .all();
  }

  /* ---------- 票据校验（playback-ticket.service） ---------- */

  findTicketRowByTokenHash(tokenHash: string): TicketRow | undefined {
    return this.db().select().from(playbackTicket).where(eq(playbackTicket.tokenHash, tokenHash)).get();
  }

  findPlaybackSessionRowById(sessionId: string): PlaybackSessionRow | undefined {
    return this.db().select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
  }

  findDeviceSessionHouseholdId(deviceSessionId: string): { householdId: string } | undefined {
    return this.db()
      .select({ householdId: deviceSession.householdId })
      .from(deviceSession)
      .where(eq(deviceSession.id, deviceSessionId))
      .get();
  }

  /* ---------- 保留清理（playback-retention.service） ---------- */

  deleteFailureEventsAtOrBefore(cutoffIso: string): number {
    const result = this.db()
      .delete(playbackFailureEvent)
      .where(lte(playbackFailureEvent.occurredAt, cutoffIso))
      .run();
    return result.changes;
  }

  listExpiredTicketRowsBefore(cutoffIso: string): Array<{ id: string; sessionId: string }> {
    return this.db()
      .select({ id: playbackTicket.id, sessionId: playbackTicket.sessionId })
      .from(playbackTicket)
      .where(lt(playbackTicket.expiresAt, cutoffIso))
      .all();
  }

  listSessionIdsInStates(states: readonly string[]): string[] {
    return this.db()
      .select({ id: playbackSession.id })
      .from(playbackSession)
      .where(inArray(playbackSession.state, [...states]))
      .all()
      .map((row) => row.id);
  }

  deleteTicketsByIds(ids: readonly string[]): number {
    const result = this.db()
      .delete(playbackTicket)
      .where(inArray(playbackTicket.id, [...ids]))
      .run();
    return result.changes;
  }

  /* ---------- 装配桥接（playback.module 的 PlaybackConversionBridge） ---------- */

  listActiveConversionRowsForGeneration(
    sessionId: string,
    generation: number,
    states: readonly string[],
  ): Array<{ id: string; householdId: string }> {
    return this.db()
      .select({ id: playbackConversion.id, householdId: playbackConversion.householdId })
      .from(playbackConversion)
      .where(
        and(
          eq(playbackConversion.sessionId, sessionId),
          eq(playbackConversion.generation, generation),
          inArray(playbackConversion.state, [...states]),
        ),
      )
      .all();
  }

  findConversionState(conversionId: string): { state: string; failureCode: string | null } | undefined {
    return this.db()
      .select({ state: playbackConversion.state, failureCode: playbackConversion.failureCode })
      .from(playbackConversion)
      .where(eq(playbackConversion.id, conversionId))
      .get();
  }

  findSessionHouseholdId(sessionId: string): { householdId: string } | undefined {
    return this.db()
      .select({ householdId: playbackSession.householdId })
      .from(playbackSession)
      .where(eq(playbackSession.id, sessionId))
      .get();
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzlePlaybackStore(handle?: Db): PlaybackStore {
  return new DrizzlePlaybackStore(handle);
}
