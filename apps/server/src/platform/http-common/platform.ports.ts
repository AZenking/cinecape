import type { SessionContext } from '@platform/http-common/current-session.decorator';

/**
 * platform 守卫端口(T022b 治理裁决,ADR-0014 修正案:R4 组合根端口反转)。
 *
 * platform 被所有上下文依赖,自身不得依赖任何业务上下文(R4);守卫所需的
 * 上下文能力以端口接口 + 注入令牌在此声明,真实实现由组合根(app.module.ts
 * 的 @Global PlatformPortsModule)经上下文发布面(@contexts/<ctx> index.ts)
 * 绑定 —— app.module 同时导入 platform 与 contexts,绑定落点合法。
 *
 * 守卫经 @UseGuards(类) 由路由所在模块的注入器在请求期延迟实例化;
 * @Global 导出使令牌对所有模块注入器可见(APP_GUARD/路由守卫两种挂法均可解析)。
 */

/** 会话令牌校验端口:SessionGuard 校验管线所需的令牌哈希能力
 *  (identity-access token.service 同口径:SHA-256 hex,device_session.token_hash 落库值) */
export interface SessionVerifierPort {
  hashToken(token: string): string;
}

/** SessionGuard 消费的注入令牌;组合根绑定 = { hashToken }(发布面纯函数) */
export const SESSION_VERIFIER_PORT: symbol = Symbol('SESSION_VERIFIER_PORT');

/** 设置授权校验结果(与 settings 上下文 SettingsGrantValidation 结构一致的最小面) */
export interface SettingsGrantValidation {
  readonly expiresAt: string;
}

/** 设置授权逐请求重检端口:SettingsAccessGuard 所需的 grant 有效性判定能力。
 *  语义契约与 settings 上下文 requireValidSettingsGrant 完全一致:Session 失效
 *  先 401;grant 缺失/撤销/版本失配 403 SETTINGS_ACCESS_REQUIRED;过期
 *  403 SETTINGS_ACCESS_EXPIRED;通过仅返回 expiresAt 元数据。 */
export interface SettingsGrantValidatorPort {
  requireValidSettingsGrant(context: SessionContext): SettingsGrantValidation;
}

/** SettingsAccessGuard 消费的注入令牌;组合根绑定 = { requireValidSettingsGrant }(发布面纯函数) */
export const SETTINGS_GRANT_VALIDATOR_PORT: symbol = Symbol('SETTINGS_GRANT_VALIDATOR_PORT');
