/**
 * profile 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - identity-transition（clearDeviceSessionsProfile）：identity-access / settings 消费；
 * - pin.service（PIN_STATE_CLEARED / isPinLocked / registerPinFailure /
 *   revokeUnlockGrantsForProfile）：identity-access / settings 消费；
 * - profile.service（assertNotLastActiveProfile / swapDefault）：settings 消费。
 *
 * 本上下文服务为纯函数模块（见 profile.module.ts 头注释惯例），无 @Injectable 类；
 * 令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口）。
 */
export const PROFILE_IDENTITY_TRANSITION_PORT = Symbol('PROFILE_IDENTITY_TRANSITION_PORT');
export const PROFILE_PIN_PORT = Symbol('PROFILE_PIN_PORT');
export const PROFILE_SERVICE_PORT = Symbol('PROFILE_SERVICE_PORT');

/** 008 仓储端口装配令牌（ADR-0015 D1）：profile.module 装配期绑定 Drizzle 实现到 seam。 */
export const PROFILE_STORE = Symbol('PROFILE_STORE');
