/**
 * settings 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - settings-access-grant.service（requireValidSettingsGrant）：platform
 *   http-common/settings-access 守卫消费（r4 反向依赖边，T022 收口）。
 *
 * 本上下文服务为纯函数模块惯例（SettingsGrantStartupRevocation 仅本上下文模块装配，
 * 不入令牌面）；令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口）。
 *
 * 008-repository-extraction（T012，ADR-0015 D1）：SETTINGS_STORE 为仓储 seam 装配
 * 令牌（settings.module.ts useFactory 经 bindSettingsStore 注入 Drizzle 实现）；
 * 仅本上下文模块装配使用，不入 exports 发布面。
 */
export const SETTINGS_ACCESS_GRANT_PORT = Symbol('SETTINGS_ACCESS_GRANT_PORT');
export const SETTINGS_STORE = Symbol('SETTINGS_STORE');
