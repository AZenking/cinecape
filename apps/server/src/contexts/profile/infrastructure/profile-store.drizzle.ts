/**
 * profile 仓储 Drizzle 实现（008-repository-extraction T006，ADR-0015 D1）。
 *
 * 查询代码自 application/profile.service.ts、profile-selection.service.ts、
 * pin.service.ts 与 identity-transition.ts 逐字迁移（008 FR-002：join 链、谓词、
 * 分块参数、返回形态均不变）；行→DTO 映射与用例编排（版本 CAS、404/401/423 判定、
 * swapDefault 差量计算、PIN 状态机）留在 application。
 *
 * 句柄解析语义与迁移前 getDb() 一致：缺省形态每方法惰性经 getDb() 解析，
 * Database 单例 close/重开自动重建包装（不在构造期捕获句柄）；测试 rig 经
 * drizzleProfileStore(db) 以固定句柄构造（内存库）。句柄来自 @platform/database/drizzle
 * （008 实施修正：句柄归属平台层，infrastructure→platform 为 R1c 合法边，
 * 且不经任何发布面——避免测试 setup 预加载 identity-access 面破坏 vi.mock）。
 *
 * identity-transition 挂钩（终态化/撤票/撤销授予/换档）自调用方事务句柄
 * （txStore(tx)）或 withTransaction 回调执行：跨上下文调用方（settings /
 * identity-access）在自身事务内传入句柄，加入的是同一物理事务，语义与迁移前
 * 「调用方 BEGIN IMMEDIATE 事务内调用」逐字一致。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  deviceSession,
  playbackProgressState,
  playbackSession,
  playbackTicket,
  profile,
  profilePolicy,
  profileViewingHistory,
  settingsAccessGrant,
} from '@platform/database/schema';
import { getDb, type Db } from '@platform/database/drizzle';
import type {
  IdentityChangePlaybackInput,
  ProfileInsert,
  ProfilePolicyInsert,
  ProfileStore,
  ProfileTxStore,
  RevokeSettingsGrantsInput,
  SwitchProfileInput,
} from '@contexts/profile/application/profile-store.port';

/** 活动播放状态(与 playback.types PLAYBACK_ACTIVE_SESSION_STATES 同词表,字面量直写避免跨模块依赖) */
const ACTIVE_PLAYBACK_STATES = ['preparing', 'ready', 'playing', 'paused'] as const;

function isoNow(): string {
  return new Date().toISOString();
}

/** 句柄来源：固定句柄（测试 rig / 事务内 tx）或惰性 getDb()（生产，单例重开安全） */
type HandleSource = Db | (() => Db);

function resolveHandle(source: HandleSource): Db {
  return typeof source === 'function' ? source() : source;
}

class DrizzleProfileTxStore implements ProfileTxStore {
  constructor(private readonly source: HandleSource) {}

  protected db(): Db {
    return resolveHandle(this.source);
  }

  findOwnedProfile(profileId: string, householdId: string, accountId: string) {
    return this.db()
      .select()
      .from(profile)
      .where(
        and(
          eq(profile.id, profileId),
          eq(profile.householdId, householdId),
          eq(profile.accountId, accountId),
        ),
      )
      .get();
  }

  findSessionContextVersion(sessionId: string): number | undefined {
    const row = this.db()
      .select({ profileContextVersion: deviceSession.profileContextVersion })
      .from(deviceSession)
      .where(eq(deviceSession.id, sessionId))
      .get();
    return row === undefined ? undefined : row.profileContextVersion;
  }

  findSessionActiveProfileId(householdId: string, sessionId: string): string | null | undefined {
    const row = this.db()
      .select({ activeProfileId: deviceSession.activeProfileId })
      .from(deviceSession)
      .where(and(eq(deviceSession.householdId, householdId), eq(deviceSession.id, sessionId)))
      .get();
    return row === undefined ? undefined : row.activeProfileId;
  }

  updateProfilePinState(profileId: string, state: { failedPinCount: number; pinLockedUntil: string | null }): void {
    this.db().update(profile).set(state).where(eq(profile.id, profileId)).run();
  }

  listActiveProfileDefaultFlags(householdId: string): Array<{ id: string; isDefault: number }> {
    return this.db()
      .select({ id: profile.id, isDefault: profile.isDefault })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.status, 'active')))
      .all();
  }

  clearProfileDefault(profileId: string): void {
    this.db().update(profile).set({ isDefault: 0 }).where(eq(profile.id, profileId)).run();
  }

  insertProfile(row: ProfileInsert): void {
    this.db().insert(profile).values(row).run();
  }

  insertProfilePolicy(values: ProfilePolicyInsert): void {
    this.db().insert(profilePolicy).values(values).run();
  }

  // -------------------------------------------------------------------------
  // identity-transition 挂钩（自 application/identity-transition.ts 逐字迁移）
  // -------------------------------------------------------------------------

  /**
   * 换档/退出前的 final flush(T101,005 api.md §5「退出/换档流程先尝试有界 1 秒 final
   * 保存/停止,再改变身份;失败不能阻止用户退出」):
   *
   * - 仅对「历史写入权归属本会话且已 started」的点播会话服务端内落一次 final:
   *   位置取服务端事实(playback_session.position_seconds,由 15 秒 heartbeat 维护),
   *   不信任任何客户端补报;历史行 revision+1、last_viewed_at 推进;
   * - 旧 candidate(superseded,非 owner)不覆盖较新 owner 的续播位置;
   * - 资源修订已变化的旧播放不写入;无 started 的准备取消不伪造历史;
   * - 本函数只做本地 SQLite 写(微秒级),「最多 1 秒」为上限预算;任何异常吞掉 ——
   *   flush 失败仅意味着保留最后确认值,身份变化照常提交(不阻塞退出)。
   */
  private flushPlaybackFinalWithinBudget(input: IdentityChangePlaybackInput): void {
    try {
      const rows = this.db()
        .select({
          sessionId: playbackSession.id,
          mediaId: playbackSession.mediaId,
          positionSeconds: playbackSession.positionSeconds,
          candidateEpoch: playbackProgressState.candidateEpoch,
          contentRevision: playbackProgressState.contentRevision,
        })
        .from(playbackSession)
        .innerJoin(
          playbackProgressState,
          and(
            eq(playbackProgressState.householdId, playbackSession.householdId),
            eq(playbackProgressState.playbackSessionId, playbackSession.id),
          ),
        )
        .where(
          and(
            eq(playbackSession.householdId, input.householdId),
            inArray(playbackSession.deviceSessionId, input.deviceSessionIds),
            eq(playbackSession.profileId, input.profileId),
            inArray(playbackSession.state, [...ACTIVE_PLAYBACK_STATES]),
            // 仅已真正起播的会话存在可 flush 的个人进度(未 started 不能伪造 final)
            eq(playbackProgressState.started, 1),
          ),
        )
        .all();
      if (rows.length === 0) {
        return;
      }
      const now = isoNow();
      for (const row of rows) {
        const history = this.db()
          .select()
          .from(profileViewingHistory)
          .where(
            and(
              eq(profileViewingHistory.householdId, input.householdId),
              eq(profileViewingHistory.profileId, input.profileId),
              eq(profileViewingHistory.mediaId, row.mediaId),
            ),
          )
          .get();
        if (history === undefined) {
          continue; // 无历史行:owner 判定不可建立,保持「首次有效 started 才建历史」语义
        }
        if (history.writerPlaybackSessionId !== row.sessionId) {
          continue; // superseded:不覆盖较新 owner 的续播位置
        }
        if (history.contentRevision !== row.contentRevision) {
          continue; // 资源修订已变化:旧播放不写新资源历史
        }
        // 位置约束(历史 CHECK:有限非负且不超过可信时长);服务端事实越界时保留原值
        const trustedDuration =
          history.durationSeconds !== null && Number.isFinite(history.durationSeconds) ? history.durationSeconds : null;
        const position = Number.isFinite(row.positionSeconds) && row.positionSeconds >= 0 ? row.positionSeconds : null;
        const withinDuration = trustedDuration === null || position === null || position <= trustedDuration;
        if (position === null || !withinDuration) {
          continue;
        }
        this.db()
          .update(profileViewingHistory)
          .set({
            positionSeconds: position,
            lastViewedAt: now,
            revision: history.revision + 1,
          })
          .where(
            and(
              eq(profileViewingHistory.householdId, input.householdId),
              eq(profileViewingHistory.profileId, input.profileId),
              eq(profileViewingHistory.mediaId, row.mediaId),
            ),
          )
          .run();
      }
    } catch {
      // flush 失败不阻止退出/换档:保留最后确认值(用户可见「进度未同步」提示由前端承担)
    }
  }

  /**
   * 终态化指定设备会话在给定身份上下文下的活动播放,并撤销其对应票据。
   * (householdId, deviceSessionId, profileId) 定位旧上下文;已终态行零副作用。
   */
  finalizePlaybackForIdentityChange(input: IdentityChangePlaybackInput): void {
    if (input.deviceSessionIds.length === 0) {
      return;
    }
    const rows = this.db()
      .select({ id: playbackSession.id })
      .from(playbackSession)
      .where(
        and(
          eq(playbackSession.householdId, input.householdId),
          inArray(playbackSession.deviceSessionId, input.deviceSessionIds),
          eq(playbackSession.profileId, input.profileId),
          inArray(playbackSession.state, [...ACTIVE_PLAYBACK_STATES]),
        ),
      )
      .all();
    if (rows.length === 0) {
      return;
    }
    const now = isoNow();
    // 换档/退出前的有界 final flush(T101):先尝试保存旧上下文 owner 会话的最后位置,
    // 再终态化 —— 与身份变化同事务原子提交,失败不阻塞身份变化。
    this.flushPlaybackFinalWithinBudget(input);
    const sessionIds = rows.map((row) => row.id);
    this.db()
      .update(playbackSession)
      .set({ state: 'interrupted', endedAt: now })
      .where(and(eq(playbackSession.householdId, input.householdId), inArray(playbackSession.id, sessionIds)))
      .run();
    this.db()
      .update(playbackTicket)
      .set({ revokedAt: now })
      .where(
        and(
          eq(playbackTicket.householdId, input.householdId),
          inArray(playbackTicket.sessionId, sessionIds),
          isNull(playbackTicket.revokedAt),
        ),
      )
      .run();
  }

  /** 撤销指定设备会话的设置授予(失效后不再恢复;保留行与撤销时间供审计) */
  revokeSettingsGrantsForSessions(input: RevokeSettingsGrantsInput): void {
    if (input.deviceSessionIds.length === 0) {
      return;
    }
    this.db()
      .update(settingsAccessGrant)
      .set({ revokedAt: isoNow() })
      .where(
        and(
          eq(settingsAccessGrant.householdId, input.householdId),
          inArray(settingsAccessGrant.deviceSessionId, input.deviceSessionIds),
          isNull(settingsAccessGrant.revokedAt),
        ),
      )
      .run();
  }

  /**
   * 实际换档(调用方须保证 fromProfileId ≠ toProfileId):同事务
   * 终态化旧上下文播放 + 撤票 + 撤销设置授予 + 写入新身份并递增 profile_context_version。
   */
  switchDeviceSessionProfile(input: SwitchProfileInput): void {
    if (input.fromProfileId !== null) {
      this.finalizePlaybackForIdentityChange({
        householdId: input.householdId,
        deviceSessionIds: [input.sessionId],
        profileId: input.fromProfileId,
      });
    }
    this.revokeSettingsGrantsForSessions({ householdId: input.householdId, deviceSessionIds: [input.sessionId] });
    this.db()
      .update(deviceSession)
      .set({
        activeProfileId: input.toProfileId,
        profileContextVersion: sql`${deviceSession.profileContextVersion} + 1`,
        lastActiveAt: isoNow(),
      })
      .where(and(eq(deviceSession.householdId, input.householdId), eq(deviceSession.id, input.sessionId)))
      .run();
  }

  /**
   * 清空指定设备会话的当前身份(失效回落 / 档案停用 / PIN 更新强制重选档):
   * 同事务终态化该档案上下文活动播放 + 撤票 + 撤销设置授予 + 清 active_profile_id 并递增版本。
   */
  clearDeviceSessionsProfile(input: IdentityChangePlaybackInput): void {
    if (input.deviceSessionIds.length === 0) {
      return;
    }
    this.finalizePlaybackForIdentityChange({
      householdId: input.householdId,
      deviceSessionIds: input.deviceSessionIds,
      profileId: input.profileId,
    });
    this.revokeSettingsGrantsForSessions({ householdId: input.householdId, deviceSessionIds: input.deviceSessionIds });
    this.db()
      .update(deviceSession)
      .set({
        activeProfileId: null,
        profileContextVersion: sql`${deviceSession.profileContextVersion} + 1`,
        lastActiveAt: isoNow(),
      })
      .where(
        and(
          eq(deviceSession.householdId, input.householdId),
          inArray(deviceSession.id, input.deviceSessionIds),
        ),
      )
      .run();
  }
}

class DrizzleProfileStore extends DrizzleProfileTxStore implements ProfileStore {
  constructor(handle?: Db) {
    // 缺省 getDb（惰性函数引用，不在构造期解析）；显式句柄用于测试 rig。
    super(handle === undefined ? getDb : () => handle);
  }

  listProfilesByHousehold(householdId: string) {
    return this.db()
      .select()
      .from(profile)
      .where(eq(profile.householdId, householdId)) // 显式 household 边界(FR-006)
      .all();
  }

  householdHasChildProfile(householdId: string): boolean {
    const row = this.db()
      .select({ id: profile.id })
      .from(profile)
      .where(and(eq(profile.householdId, householdId), eq(profile.type, 'child')))
      .limit(1)
      .get();
    return row !== undefined;
  }

  withTransaction<T>(fn: (tx: ProfileTxStore) => T, behavior?: 'immediate'): T {
    // 省略 behavior ≡ 迁移前 getDb().transaction(fn)（drizzle 缺省 deferred）；
    // 'immediate' ≡ 迁移前 { behavior: 'immediate' }（unlock/select BEGIN IMMEDIATE 短事务）。
    return this.db().transaction((tx) => fn(new DrizzleProfileTxStore(tx)), behavior === undefined ? undefined : { behavior });
  }

  txStore(tx: Db): ProfileTxStore {
    return new DrizzleProfileTxStore(tx);
  }
}

/** 装配/测试工厂：缺省 getDb() 惰性解析（生产）；显式句柄用于测试 rig（内存库） */
export function drizzleProfileStore(handle?: Db): ProfileStore {
  return new DrizzleProfileStore(handle);
}
