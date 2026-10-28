import type { Db } from '@platform/database/drizzle';
import {
  profileStore,
  type IdentityChangePlaybackInput,
  type RevokeSettingsGrantsInput,
  type SwitchProfileInput,
} from '@contexts/profile/application/profile-store.port';

/**
 * 身份变化事务挂钩(T038/T039,005 data-model §2 device_session/profile):
 * 「实际 activeProfile 改变、清空或失效回落时递增 profile_context_version;
 *  改变身份、撤销当前 settings grant、终态化该 DeviceSession 旧身份的活动 playback
 *  及撤销对应票据在同一事务」。A→B→A 至少递增两次(每次实际变化各递增一次)。
 *
 * 本文件是 profile/auth 两个模块共享的最小挂钩实现(纯 DB 事务内操作,无 I/O):
 * - contexts/playback 的 PlaybackLifecycleService 依赖注入式回收(异步、监督者取消转换)
 *   无法在调用方短事务内复用,故按同一终态语义做最小同步实现:
 *   失权属系统回收 → state='interrupted'(与 playback-lifecycle 的失权终态选择一致,
 *   failure_code 仅 failed 非空,故不写);票据按会话撤销;
 * - 调用方(profile 选档 / auth 会话与 PIN 变更)在自己的 BEGIN IMMEDIATE 事务内调用,
 *   保证「身份变化 + 版本递增 + 播放终态化 + 撤票 + 撤销授予」原子提交;
 * - playback 模块自身零改动(硬边界),T052(US3)后续可替换为仓储级挂钩。
 *
 * 008-repository-extraction(T006,ADR-0015 D1):查询实现逐字迁往
 * infrastructure/profile-store.drizzle.ts;本文件保留原导出签名(tx 显式传递)——
 * clearDeviceSessionsProfile 被 settings/identity-access 跨上下文在「调用方自己的
 * 事务内」消费,句柄经 txStore(tx) 穿透 application 仅作不透明连接凭证,加入的是
 * 同一物理事务,各消费方的仓储化属其后续任务(008 FR-001 逐上下文独立抽取)。
 */

/**
 * 终态化指定设备会话在给定身份上下文下的活动播放,并撤销其对应票据。
 * (householdId, deviceSessionId, profileId) 定位旧上下文;已终态行零副作用。
 */
export function finalizePlaybackForIdentityChange(
  tx: Db,
  input: IdentityChangePlaybackInput,
): void {
  profileStore().txStore(tx).finalizePlaybackForIdentityChange(input);
}

/** 撤销指定设备会话的设置授予(失效后不再恢复;保留行与撤销时间供审计) */
export function revokeSettingsGrantsForSessions(
  tx: Db,
  input: RevokeSettingsGrantsInput,
): void {
  profileStore().txStore(tx).revokeSettingsGrantsForSessions(input);
}

/**
 * 实际换档(调用方须保证 fromProfileId ≠ toProfileId):同事务
 * 终态化旧上下文播放 + 撤票 + 撤销设置授予 + 写入新身份并递增 profile_context_version。
 */
export function switchDeviceSessionProfile(
  tx: Db,
  input: SwitchProfileInput,
): void {
  profileStore().txStore(tx).switchDeviceSessionProfile(input);
}

/**
 * 清空指定设备会话的当前身份(失效回落 / 档案停用 / PIN 更新强制重选档):
 * 同事务终态化该档案上下文活动播放 + 撤票 + 撤销设置授予 + 清 active_profile_id 并递增版本。
 */
export function clearDeviceSessionsProfile(
  tx: Db,
  input: IdentityChangePlaybackInput,
): void {
  profileStore().txStore(tx).clearDeviceSessionsProfile(input);
}
