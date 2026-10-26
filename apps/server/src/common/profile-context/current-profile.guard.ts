import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { Database } from '../../database/database';
import { DomainError } from '../domain-error';
import { attachProfileContext, type ProfileContext } from './current-profile.decorator';
import type { SessionRequest } from '../current-session.decorator';

/**
 * CurrentProfileGuard(T009,005 contracts/api.md §1/§7 Profile 边界)——
 * 挂载在 SessionGuard 之后(@UseGuards(SessionGuard, CurrentProfileGuard)),
 * 校验「服务端会话当前 activeProfile」的归属与状态:
 *
 *   会话上下文缺失 → 401 SESSION_INVALID(未挂 SessionGuard 的装配错误,同形拒绝)
 *   activeProfileId 为空(未选档)→ 403 ACTIVE_PROFILE_REQUIRED
 *   Profile 行不存在 / status ≠ active / 归属跨家庭跨账号 → 403 ACTIVE_PROFILE_REQUIRED
 *
 * 全部失败统一无差别(ACTIVE_PROFILE_REQUIRED 为既有码,§7 保留),不泄露具体原因、
 * 无放行窗口;不区分「未选档」与「档案停用」,客户端按「需重新选档」处理(FR-009)。
 * 不做 PIN/解锁判定 —— 选档授予属 profile 模块,设置授权属 SettingsAccessGuard。
 *
 * 挂载次序硬约束:必须位于 SessionGuard 之后;单独挂载本 Guard 时一律 401 fail-closed。
 */

interface ProfileRow {
  id: string;
  household_id: string;
  account_id: string;
  name: string;
  avatar: string | null;
  type: string;
  status: string;
}

const PROFILE_BY_ID_SQL = `
  SELECT id, household_id, account_id, name, avatar, type, status
  FROM profile
  WHERE id = ?
`;

function activeProfileRequired(): DomainError {
  return new DomainError(403, ProblemCodeConst.ACTIVE_PROFILE_REQUIRED, undefined);
}

@Injectable()
export class CurrentProfileGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const session = (request as SessionRequest).hmpSessionContext;
    if (session === undefined) {
      // SessionGuard 未先行:边界装配错误按未认证同形拒绝(fail-closed)
      throw new DomainError(401, ProblemCodeConst.SESSION_INVALID, undefined);
    }
    const activeProfileId = session.session.activeProfileId;
    // 1. 未选档 → 403(不是 401:会话本身有效)
    if (activeProfileId === null) {
      throw activeProfileRequired();
    }
    const row = Database.db.prepare(PROFILE_BY_ID_SQL).get(activeProfileId) as ProfileRow | undefined;
    // 2. Profile 行不存在(已删除/伪造 ID)
    if (row === undefined) {
      throw activeProfileRequired();
    }
    // 3. 状态失效(FR-009:停用即失效,不中断公共浏览只拒绝个人/播放边界)
    if (row.status !== 'active') {
      throw activeProfileRequired();
    }
    // 4. 归属一致:Profile 必须属于会话同家庭同账号(双保险,与 SessionGuard 自联口径一致)
    if (
      row.household_id !== session.session.householdId ||
      row.account_id !== session.session.accountId
    ) {
      throw activeProfileRequired();
    }
    attachProfileContext(request, {
      id: row.id,
      householdId: row.household_id,
      accountId: row.account_id,
      name: row.name,
      avatar: row.avatar,
      type: row.type === 'child' ? 'child' : 'adult',
    } satisfies ProfileContext);
    return true;
  }
}
