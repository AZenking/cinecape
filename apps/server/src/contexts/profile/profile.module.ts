import { Module } from '@nestjs/common';
import { ProfileController } from '@contexts/profile/interface/profile.controller';
import { PROFILE_IDENTITY_TRANSITION_PORT, PROFILE_PIN_PORT, PROFILE_SERVICE_PORT } from '@contexts/profile/profile.tokens';
import { clearDeviceSessionsProfile } from '@contexts/profile/application/identity-transition';
import {
  PIN_STATE_CLEARED,
  isPinLocked,
  registerPinFailure,
  revokeUnlockGrantsForProfile,
} from '@contexts/profile/application/pin.service';
import { assertNotLastActiveProfile, swapDefault } from '@contexts/profile/application/profile.service';
import type { IIdentityTransitionService, IPinService, IProfileService } from '@contexts/profile/profile.ports';

/**
 * Profile 模块(T025-T028):list + 创建/编辑/选择/PIN 解锁。
 * 服务为纯函数模块(对齐 auth/household 惯例),模块仅承载路由注册。
 *
 * 007-T021:发布面令牌装配 —— 跨上下文消费的应用服务以令牌 provider 发布
 * (纯函数模块经 useValue 函数束 + satisfies 对齐 ports 接口,零行为变化);
 * exports 仅发布令牌(contracts 白名单),消费方迁移属 T022。
 */
@Module({
  controllers: [ProfileController],
  providers: [
    {
      provide: PROFILE_IDENTITY_TRANSITION_PORT,
      useValue: { clearDeviceSessionsProfile } satisfies IIdentityTransitionService,
    },
    {
      provide: PROFILE_PIN_PORT,
      useValue: { PIN_STATE_CLEARED, isPinLocked, registerPinFailure, revokeUnlockGrantsForProfile } satisfies IPinService,
    },
    {
      provide: PROFILE_SERVICE_PORT,
      useValue: { assertNotLastActiveProfile, swapDefault } satisfies IProfileService,
    },
  ],
  exports: [PROFILE_IDENTITY_TRANSITION_PORT, PROFILE_PIN_PORT, PROFILE_SERVICE_PORT],
})
export class ProfileModule {}
