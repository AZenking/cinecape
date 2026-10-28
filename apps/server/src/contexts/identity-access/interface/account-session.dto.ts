import { eq } from 'drizzle-orm';
import type { Profile } from '@platform/database/schema';
import { deviceSession, profile } from '@platform/database/schema';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { clearDeviceSessionsProfile } from '@contexts/profile';
// T024 类型上提：ProfileSummaryBody / toProfileSummary 实体落位 application 层
// （profile-summary.dto.ts，application→interface 为审计禁边故上提；实现零改动），
// 此处再导出保持既有消费方（auth/bootstrap.controller、发布面 index）零破坏。
import { toProfileSummary, type ProfileSummaryBody } from '@contexts/identity-access/application/profile-summary.dto';

export { toProfileSummary, type ProfileSummaryBody };

/**
 * 统一会话 DTO(T039,005 data-model §9「AccountSession」+ contracts/api.md §3):
 * - SessionDto/AccountSession 为同一形态(B001SessionDto):sessionId、account 最小摘要、
 *   activeProfile(ProfileSummary|null)、expiresAt、householdId、bootstrapRequired、
 *   profileContextVersion;sessionToken 仅登录响应出现一次(可选字段);
 * - ProfileSummary(B001ProfileDto):id、name、avatar、type、isDefault、isMain、
 *   pinProtected、status、createdAt、version —— 白名单投影,永不含 PIN 哈希、
 *   失败计数、策略等设置主体;
 * - bootstrapRequired=true 仅表示「零档案」;不允许客户端借字段写入身份;
 * - FR-009 失效回落:当前 Profile 停用/失效时,会话恢复在事务内清空 active_profile_id、
 *   递增 profile_context_version 并撤销设置授予,DTO 返回 activeProfile=null。
 */

/** AccountSession 响应体(契约 B001SessionDto;sessionToken 仅登录响应携带) */
export interface AccountSessionBody {
  sessionId: string;
  account: { id: string; username: string; role: 'owner' | 'admin' };
  activeProfile: ProfileSummaryBody | null;
  expiresAt: string;
  householdId: string;
  bootstrapRequired: boolean;
  profileContextVersion: number;
}

/** 当前 activeProfile 的有效档案行(不存在/停用/归属不符均视为无有效身份) */
export function readActiveProfileRow(householdId: string, accountId: string, profileId: string | null): Profile | null {
  if (profileId === null) {
    return null;
  }
  const row = getDb().select().from(profile).where(eq(profile.id, profileId)).get();
  if (
    row === undefined ||
    row.status !== 'active' ||
    row.householdId !== householdId ||
    row.accountId !== accountId
  ) {
    return null;
  }
  return row;
}

/** 家庭档案行数(零档案 = bootstrapRequired,bootstrap-profile 的唯一前置语义) */
function householdProfileCount(householdId: string): number {
  const row = getDb()
    .select({ id: profile.id })
    .from(profile)
    .where(eq(profile.householdId, householdId))
    .all();
  return row.length;
}

/**
 * 由设备会话行构建 AccountSession DTO(全部身份事实读自服务端存储,FR-018)。
 * sessionToken 仅在登录响应传入;其余端点不携带。
 */
export function buildAccountSession(input: {
  sessionId: string;
  account: { id: string; username: string; role: 'owner' | 'admin' };
  expiresAt: string;
  sessionToken?: string;
}): AccountSessionBody {
  const sessionRow = getDb()
    .select({
      householdId: deviceSession.householdId,
      activeProfileId: deviceSession.activeProfileId,
      profileContextVersion: deviceSession.profileContextVersion,
    })
    .from(deviceSession)
    .where(eq(deviceSession.id, input.sessionId))
    .get();
  if (sessionRow === undefined) {
    // 会话行缺失(理论不可达,Guard 已校验)按未认证同形拒绝
    throw new Error('device_session row missing');
  }
  const activeProfileRow = readActiveProfileRow(
    sessionRow.householdId,
    input.account.id,
    sessionRow.activeProfileId,
  );
  return {
    sessionId: input.sessionId,
    // 账号最小摘要:仅 id/username/role(householdId 是 DTO 顶层服务端字段,不混入账号对象)
    account: { id: input.account.id, username: input.account.username, role: input.account.role },
    activeProfile: activeProfileRow === null ? null : toProfileSummary(activeProfileRow),
    expiresAt: input.expiresAt,
    householdId: sessionRow.householdId,
    bootstrapRequired: householdProfileCount(sessionRow.householdId) === 0,
    profileContextVersion: sessionRow.profileContextVersion,
    ...(input.sessionToken !== undefined ? { sessionToken: input.sessionToken } : {}),
  };
}

/**
 * 会话恢复(GET /auth/session)入口(T039/FR-009):
 * - 滑动续期由调用方完成后传入生效的 expiresAt;
 * - 失效回落:activeProfileId 指向的档案已停用/缺失时,同一事务清空身份、
 *   递增 profile_context_version、撤销设置授予,再以 activeProfile=null 呈现
 *   (客户端按「需重新选档」处理;公共浏览不受影响)。
 */
export function restoreAccountSession(context: SessionContext, expiresAt: string): AccountSessionBody {
  const sessionRow = getDb()
    .select({
      householdId: deviceSession.householdId,
      activeProfileId: deviceSession.activeProfileId,
    })
    .from(deviceSession)
    .where(eq(deviceSession.id, context.session.id))
    .get();
  if (sessionRow !== undefined && sessionRow.activeProfileId !== null) {
    const activeRow = readActiveProfileRow(
      sessionRow.householdId,
      context.account.id,
      sessionRow.activeProfileId,
    );
    if (activeRow === null) {
      // 失效回落:data-model §2「清空或失效回落时递增」—— 事务内清空并递增版本
      getDb().transaction((tx) => {
        clearDeviceSessionsProfile(tx, {
          householdId: sessionRow.householdId,
          deviceSessionIds: [context.session.id],
          profileId: sessionRow.activeProfileId as string,
        });
      });
    }
  }
  return buildAccountSession({
    sessionId: context.session.id,
    account: context.account,
    expiresAt,
  });
}
