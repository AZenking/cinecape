import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '../domain-error';
import type { SessionContext, SessionRequest } from '../current-session.decorator';
import { requireValidSettingsGrant } from '../../modules/settings/settings-access-grant.service';

/**
 * SettingsAccessGuard(T009 占位 → T083 填充,005 contracts/api.md §1 Settings 边界、
 * §7「一般设置主体次序」、data-model §3、ADR-0011 决议 5)——
 *
 * 授权次序:存储就绪 → Session → 角色(owner/admin)+ 当前主 Profile → 有效
 * settings grant → 严格入参 → 当次密码(敏感操作)→ 重读身份/grant/目标归属/版本
 * → 事务。本 Guard 只承担「Session 之后的角色/当前主 Profile → grant 有效性」一段:
 * - Session 校验由上游 SessionGuard 完成(挂载方 `@UseGuards(SessionGuard,
 *   SettingsAccessGuard)`);本 Guard 读取其会话上下文,缺失(未先挂 SessionGuard
 *   的装配错误)按未认证同形 401 fail-closed;
 * - 角色不足 / 当前档案非主 Profile / grant 缺失、撤销、换档、版本失配、目标停用
 *   → 403 SETTINGS_ACCESS_REQUIRED;grant 过期 → 403 SETTINGS_ACCESS_EXPIRED
 *   (判定单一实现在 modules/settings/settings-access-grant.service 的
 *   requireValidSettingsGrant:连接 account/device/device_session/profile/household
 *   逐请求重检,错误码语义与 /settings/access 独立入口完全一致);
 * - /settings/access 的 GET/POST/DELETE 是独立入口(api.md §7),不挂本 Guard ——
 *   由 modules/settings/settings-access.controller.ts 单独注册;
 * - 判定逻辑全部写在 protected authorize()(T009 约定的扩展点,保持可覆写);
 *   逐请求重检、无缓存:每次请求都以库内现值为准,本 Guard 不放行也不缓存任何
 *   授权事实。
 */
@Injectable()
export class SettingsAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return this.authorize(context);
  }

  /** 授权判定唯一入口(T009 扩展点;T083 填充实现) */
  protected authorize(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<Request>();
    const session = (request as SessionRequest).hmpSessionContext;
    if (session === undefined) {
      // SessionGuard 未先行:边界装配错误按未认证同形拒绝(fail-closed)
      throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
    }
    requireValidSettingsGrant(session as SessionContext);
    return true;
  }
}
