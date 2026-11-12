import { ProblemCode } from '@hmp/shared';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { hashPassword, requireManagementRole } from '@contexts/identity-access';
import { verifyOwnerPassword } from '@contexts/settings/application/settings-owner-password';
import { clearDeviceSessionsProfile, revokeUnlockGrantsForProfile } from '@contexts/profile';
import { revokeSettingsGrantsForAccountTx } from '@contexts/settings/application/settings-access-revocation';
import { requireMainProfileTx } from '@contexts/settings/application/settings-access-grant.service';
import { settingsStore, type AccountCredentialRow, type SettingsTxStore } from '@contexts/settings/application/settings-store.port';

/**
 * 账号与安全服务(T126,005 contracts/api.md §6 + data-model.md §2 account + FR-035):
 *
 * PUT /settings/account/password 用例 —— 「account.credential_version 密码改动递增,
 * 并在同一事务撤销该账号全部 device_session 和设置授予」:
 *   Settings 守卫(上游 SettingsAccessGuard)→ 管理角色 → 严格入参(管道)→
 *   旧密码验证(沿用既有持久错误计数/锁定,parent_verification_state)→
 *   验证旧密码后再重读 credential_version(快照,避免并发密码变化窗口)→
 *   新密码哈希在事务外 → BEGIN IMMEDIATE 提交前重验 credential_version + 权限快照
 *   (requireMainProfileTx)→ 更新 password_hash/credential_version+1、
 *   撤销该账号全部 device_session 与设置授予、有身份的会话按失效回落语义清档并
 *   终态化活动播放 → 提交后撤销内存选档授予。
 *
 * Profile 收藏与历史不触碰(FR-035「保留 Profile 收藏和历史」);
 * 响应 204 无主体;清 cookie 由控制器承担(当前会话已随事务撤销)。
 *
 * 008-repository-extraction(T012,ADR-0015 D1):数据访问经 SettingsStore 端口
 * (查询逐字迁往 infrastructure/settings-store.drizzle.ts;事务经 withTransaction
 * 端口,BEGIN IMMEDIATE 语义不变;clearDeviceSessionsProfile 的调用方事务句柄以
 * 回调第二参 handle 穿引 —— 不透明连接凭证,加入同一物理事务,profile 端口先例)。
 */

function readAccountRow(db: SettingsTxStore, context: SessionContext): AccountCredentialRow {
  const row = db.findAccountCredentialRow(context.session.householdId, context.account.id);
  if (row === undefined) {
    // 会话与账号行不一致(理论不可达,Guard 已校验)→ 按会话失效拒绝
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
  return row;
}

export interface ChangeAccountPasswordInput {
  ownerPassword: string;
  newPassword: string;
}

export async function changeAccountPassword(context: SessionContext, input: ChangeAccountPasswordInput): Promise<void> {
  requireManagementRole(context);
  const store = settingsStore();

  // 1. 旧密码验证(缺失 403 REQUIRED;既有错误计数/锁定;错误 403 FAILED、锁定 423)
  await verifyOwnerPassword(context, input.ownerPassword);

  // 2. 验证旧密码后再重读 credential_version(快照;data-model §2)
  const snapshot = readAccountRow(store, context);

  // 3. 新密码哈希在事务外(短事务;I/O 不入事务)
  const newPasswordHash = await hashPassword(input.newPassword);

  // 4. BEGIN IMMEDIATE:提交前重验 credential_version + 权限快照,级联撤销原子提交
  store.withTransaction(
    (tx, handle) => {
      const fresh = readAccountRow(tx, context);
      if (fresh.credentialVersion !== snapshot.credentialVersion) {
        // 异步窗口内密码已被并发改动:拒绝提交,不基于旧凭据覆盖
        throw createDomainError('VERSION_CONFLICT');
      }
      // 权限快照重验(grant 撤销/过期、换档、主档案变化、PIN 变化 → 403)
      requireMainProfileTx(tx, context);

      // 同事务撤销该账号全部 device_session(含当前会话)
      const sessions = tx.listAccountSessions(context.account.id, context.session.householdId);
      const now = new Date().toISOString();
      const byProfile = new Map<string, string[]>();
      for (const session of sessions) {
        if (session.activeProfileId !== null) {
          const ids = byProfile.get(session.activeProfileId) ?? [];
          ids.push(session.id);
          byProfile.set(session.activeProfileId, ids);
        }
      }
      // 先按旧档案分组清空身份(终态化活动播放 + 撤票 + 撤该会话授予 + 递增上下文版本),
      // 再整体撤销;最后兜底撤销全部设置授予(无身份会话的授予也在内)。
      for (const [profileId, sessionIds] of byProfile) {
        clearDeviceSessionsProfile(handle, {
          householdId: context.session.householdId,
          deviceSessionIds: sessionIds,
          profileId,
        });
      }
      tx.revokeAccountSessions(context.account.id, context.session.householdId, now);
      revokeSettingsGrantsForAccountTx(tx, context.account.id);

      // 凭据落库(哈希已在事务外计算)
      tx.updateAccountCredentials(fresh.householdId, fresh.id, {
        passwordHash: newPasswordHash,
        credentialVersion: fresh.credentialVersion + 1,
      });
    },
    'immediate',
  );

  // 5. 提交后撤销内存选档授予(旧「已解锁可直接切回」路径不得残留)
  const householdProfiles = store.listAccountProfileIds(context.session.householdId, context.account.id);
  for (const row of householdProfiles) {
    revokeUnlockGrantsForProfile(row.id);
  }
}
