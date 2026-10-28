import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  deviceSession,
  playbackProgressState,
  playbackSession,
  playbackTicket,
  profileViewingHistory,
  settingsAccessGrant,
} from '@platform/database/schema';
import type { Db } from '@contexts/identity-access';

/**
 * 身份变化事务挂钩(T038/T039,005 data-model §2 device_session/profile):
 * 「实际 activeProfile 改变、清空或失效回落时递增 profile_context_version;
 *  改变身份、撤销当前 settings grant、终态化该 DeviceSession 旧身份的活动 playback
 *  及撤销对应票据在同一事务」。A→B→A 至少递增两次(每次实际变化各递增一次)。
 *
 * 本文件是 profile/auth 两个模块共享的最小挂钩实现(纯 DB 事务内操作,无 I/O):
 * - contexts/playback 的 PlaybackLifecycleService 依赖注入式回收(异步、监督者取消转换)
 *   无法在调用方短事务内复用,故此处按同一终态语义做最小同步实现:
 *   失权属系统回收 → state='interrupted'(与 playback-lifecycle 的失权终态选择一致,
 *   failure_code 仅 failed 非空,故不写);票据按会话撤销;
 * - 调用方(profile 选档 / auth 会话与 PIN 变更)在自己的 BEGIN IMMEDIATE 事务内调用,
 *   保证「身份变化 + 版本递增 + 播放终态化 + 撤票 + 撤销授予」原子提交;
 * - playback 模块自身零改动(硬边界),T052(US3)后续可替换为仓储级挂钩。
 */

/** 活动播放状态(与 playback.types PLAYBACK_ACTIVE_SESSION_STATES 同词表,字面量直写避免跨模块依赖) */
const ACTIVE_PLAYBACK_STATES = ['preparing', 'ready', 'playing', 'paused'] as const;

function isoNow(): string {
  return new Date().toISOString();
}

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
 *
 * 调用点:finalizePlaybackForIdentityChange 终态化之前(调用方事务内,原子提交);
 * 身份变化之后旧进度写入由 progress 端点的上下文版本重验拒绝(404 同形)。
 */
function flushPlaybackFinalWithinBudget(
  tx: Db,
  input: { householdId: string; deviceSessionIds: string[]; profileId: string },
): void {
  try {
    const rows = tx
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
      const history = tx
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
      tx.update(profileViewingHistory)
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
export function finalizePlaybackForIdentityChange(
  tx: Db,
  input: { householdId: string; deviceSessionIds: string[]; profileId: string },
): void {
  if (input.deviceSessionIds.length === 0) {
    return;
  }
  const rows = tx
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
  flushPlaybackFinalWithinBudget(tx, input);
  const sessionIds = rows.map((row) => row.id);
  tx.update(playbackSession)
    .set({ state: 'interrupted', endedAt: now })
    .where(and(eq(playbackSession.householdId, input.householdId), inArray(playbackSession.id, sessionIds)))
    .run();
  tx.update(playbackTicket)
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
export function revokeSettingsGrantsForSessions(
  tx: Db,
  input: { householdId: string; deviceSessionIds: string[] },
): void {
  if (input.deviceSessionIds.length === 0) {
    return;
  }
  tx.update(settingsAccessGrant)
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
export function switchDeviceSessionProfile(
  tx: Db,
  input: { householdId: string; sessionId: string; fromProfileId: string | null; toProfileId: string },
): void {
  if (input.fromProfileId !== null) {
    finalizePlaybackForIdentityChange(tx, {
      householdId: input.householdId,
      deviceSessionIds: [input.sessionId],
      profileId: input.fromProfileId,
    });
  }
  revokeSettingsGrantsForSessions(tx, { householdId: input.householdId, deviceSessionIds: [input.sessionId] });
  tx.update(deviceSession)
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
export function clearDeviceSessionsProfile(
  tx: Db,
  input: { householdId: string; deviceSessionIds: string[]; profileId: string },
): void {
  if (input.deviceSessionIds.length === 0) {
    return;
  }
  finalizePlaybackForIdentityChange(tx, {
    householdId: input.householdId,
    deviceSessionIds: input.deviceSessionIds,
    profileId: input.profileId,
  });
  revokeSettingsGrantsForSessions(tx, { householdId: input.householdId, deviceSessionIds: input.deviceSessionIds });
  tx.update(deviceSession)
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
