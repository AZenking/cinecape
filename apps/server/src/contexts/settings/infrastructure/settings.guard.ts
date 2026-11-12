import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpStatus,
} from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionRequest } from '@platform/http-common/current-session.decorator';

/**
 * 设置管理越权异常 (403 FORBIDDEN)
 *
 * 013 角色差异化设置体系统一拒绝码:非主管理员访问管理端点一律 403 FORBIDDEN
 * (ProblemCode.FORBIDDEN);旧 ADR-0011 的 SETTINGS_ACCESS_REQUIRED /
 * SETTINGS_ACCESS_EXPIRED 随 15 分钟临时 Ticket 机制一并废止(ADR-0017)。
 */
export class SettingsForbiddenError extends ForbiddenException {
  readonly code: string = ProblemCode.FORBIDDEN;

  constructor(message = 'FORBIDDEN') {
    super(
      {
        statusCode: HttpStatus.FORBIDDEN,
        status: HttpStatus.FORBIDDEN,
        code: ProblemCode.FORBIDDEN,
        message,
      },
      message,
    );
    this.name = 'ForbiddenException';
  }
}

interface ActiveProfileRow {
  is_main: number;
  status: string;
  household_id: string;
  account_id: string;
}

const ACTIVE_PROFILE_SQL = `
  SELECT is_main, status, household_id, account_id
  FROM profile
  WHERE id = ?
`;

/**
 * SettingsGuard (013-role-differentiated-settings, T005;ADR-0017)
 *
 * 角色差异化设置体系管理门禁(替代 005 时代的 SettingsAccessGrant 临时 Ticket):
 * - 挂载次序与旧守卫同槽:@UseGuards(SessionGuard, SettingsGuard);
 * - SessionGuard 之后核验当前会话活动档案:activeProfile.isMain === 1 放行主管理员;
 * - 会话上下文缺失(SessionGuard 未先行,装配错误)→ 401 SESSION_INVALID fail-closed;
 * - 未选档 / 档案不存在 / 档案停用 / 跨家庭跨账号 / 非主档案 → 403 FORBIDDEN
 *   (无差别拒绝,不泄露具体原因;逐请求查库,零缓存零放行窗口);
 * - 不再依赖 X-Settings-Grant-Token / settings_access_grant 表(ADR-0017 废除)。
 */
@Injectable()
export class SettingsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const session = request.hmpSessionContext;
    if (session === undefined) {
      // SessionGuard 未先行:边界装配错误按未认证同形拒绝(fail-closed)
      throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
    }

    const activeProfileId = session.session.activeProfileId;
    if (activeProfileId === null) {
      throw new SettingsForbiddenError();
    }

    const row = Database.db.prepare(ACTIVE_PROFILE_SQL).get(activeProfileId) as ActiveProfileRow | undefined;
    if (
      row === undefined ||
      row.status !== 'active' ||
      row.household_id !== session.session.householdId ||
      row.account_id !== session.session.accountId ||
      !(row.is_main === 1 || (row.is_main as unknown) === true)
    ) {
      throw new SettingsForbiddenError();
    }
    return true;
  }
}

export default SettingsGuard;
