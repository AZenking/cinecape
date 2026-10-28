import { Module } from '@nestjs/common';
import { HttpCommonModule } from '@platform/http-common/http-common.module';
import { AuthController } from '@contexts/identity-access/interface/auth.controller';
import { SetupController } from '@contexts/identity-access/interface/setup.controller';
import { BootstrapController } from '@contexts/identity-access/interface/bootstrap.controller';
import { HouseholdController } from '@contexts/identity-access/interface/household.controller';
import {
  IDENTITY_ACCESS_BOOTSTRAP_PORT,
  IDENTITY_ACCESS_DEVICE_PORT,
  IDENTITY_ACCESS_PARENT_VERIFICATION_PORT,
} from '@contexts/identity-access/identity-access.tokens';
import { listHouseholdDevices, revokeHouseholdDevice } from '@contexts/identity-access/application/device.service';
import { requireManagementRole } from '@contexts/identity-access/application/bootstrap.service';
import { verifyParentPassword } from '@contexts/identity-access/application/parent-verification.service';
import type {
  IBootstrapService,
  IDeviceService,
  IParentVerificationService,
} from '@contexts/identity-access/identity-access.ports';

/**
 * 认证模块(T019/T033/T034/T035;T036/T037/T039 扩展)。
 * US8 T130:DeviceController(GET /devices、POST /devices/{id}/revoke)已迁入
 * contexts/settings(settings-devices.controller,新契约含当次密码),本模块不再注册。
 * 服务均为纯函数模块(对齐 token.service.ts 惯例),模块仅承载路由注册;
 * CommonModule 提供 SetupController 依赖的 PublicContextService 与
 * RateLimitGuard 的 RateLimitService(T036 /setup/status)。
 */

/**
 * Household 模块(T018/T020):家庭信息查询。
 * T036(005-US2)起初始化契约(/setup/*)迁入 auth(现 identity-access,setup.controller.ts,
 * 仅建 Household+Account、不自动登录);本模块不再承载 setup 路由。
 *
 * 007-T015:AuthModule 与 HouseholdModule 合并为 IdentityAccessModule
 * (contexts/identity-access 装配;HouseholdController 路由前缀语义原样保留)。
 *
 * 007-T021:发布面令牌装配 —— 跨上下文消费的应用服务以令牌 provider 发布
 * (纯函数模块经 useValue 函数束 + satisfies 对齐 ports 接口,零行为变化:
 * 函数引用原样,不新增实例/状态);exports 仅发布令牌(contracts 白名单),
 * 消费方迁移(经 index 直接导入或 @Inject(令牌))属 T022。
 */
@Module({
  imports: [HttpCommonModule],
  controllers: [AuthController, SetupController, BootstrapController, HouseholdController],
  providers: [
    {
      provide: IDENTITY_ACCESS_PARENT_VERIFICATION_PORT,
      useValue: { verifyParentPassword } satisfies IParentVerificationService,
    },
    {
      provide: IDENTITY_ACCESS_BOOTSTRAP_PORT,
      useValue: { requireManagementRole } satisfies IBootstrapService,
    },
    {
      provide: IDENTITY_ACCESS_DEVICE_PORT,
      useValue: { listHouseholdDevices, revokeHouseholdDevice } satisfies IDeviceService,
    },
  ],
  exports: [
    IDENTITY_ACCESS_PARENT_VERIFICATION_PORT,
    IDENTITY_ACCESS_BOOTSTRAP_PORT,
    IDENTITY_ACCESS_DEVICE_PORT,
  ],
})
export class IdentityAccessModule {}
