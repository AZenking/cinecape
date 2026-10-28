import { Injectable, Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext, SessionRequest } from '@platform/http-common/current-session.decorator';
import { SETTINGS_GRANT_VALIDATOR_PORT, type SettingsGrantValidatorPort } from '@platform/http-common/platform.ports';

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
 *   (判定单一实现在 settings 上下文的 requireValidSettingsGrant:连接
 *   account/device/device_session/profile/household 逐请求重检,错误码语义与
 *   /settings/access 独立入口完全一致;T022b 治理裁决(ADR-0014 修正案)R4
 *   端口反转 —— platform 不再深导入 settings 应用服务,改消费组合根绑定的
 *   SETTINGS_GRANT_VALIDATOR_PORT,真实实现 = 发布面纯函数,行为零变化);
 * - /settings/access 的 GET/POST/DELETE 是独立入口(api.md §7),不挂本 Guard ——
 *   由 modules/settings/settings-access.controller.ts 单独注册;
 * - 判定逻辑全部写在 protected authorize()(T009 约定的扩展点,保持可覆写);
 *   逐请求重检、无缓存:每次请求都以库内现值为准,本 Guard 不放行也不缓存任何
 *   授权事实。
 */
@Injectable()
export class SettingsAccessGuard implements CanActivate {
  // @Inject 显式声明依赖(esbuild/tsx 运行时不发射 design:paramtypes,仓库既有惯例);
  // 守卫由路由所在模块注入器在请求期延迟实例化,令牌经组合根 @Global 模块全局可见。
  constructor(
    @Inject(SETTINGS_GRANT_VALIDATOR_PORT) private readonly grantValidator: SettingsGrantValidatorPort,
  ) {}

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
    this.grantValidator.requireValidSettingsGrant(session as SessionContext);
    return true;
  }
}
