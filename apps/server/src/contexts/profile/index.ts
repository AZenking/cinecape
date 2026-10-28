/**
 * profile 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型/纯函数；实现类禁止导出。
 */
export type { IIdentityTransitionService, IPinService, IProfileService } from './profile.ports';
export { PROFILE_IDENTITY_TRANSITION_PORT, PROFILE_PIN_PORT, PROFILE_SERVICE_PORT } from './profile.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export { clearDeviceSessionsProfile } from './application/identity-transition';
export {
  PIN_STATE_CLEARED,
  isPinLocked,
  registerPinFailure,
  revokeUnlockGrantsForProfile,
  type PinFailureState,
} from './application/pin.service';
// T022a 补面：policy.service 经发布面消费的属主校验纯函数（实现零改动）
export { assertNotLastActiveProfile, requireOwnedProfile, swapDefault } from './application/profile.service';
