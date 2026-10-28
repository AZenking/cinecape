import { Module } from '@nestjs/common';
import { HttpCommonModule } from '@platform/http-common/http-common.module';
import { AuthController } from '@contexts/identity-access/interface/auth.controller';
import { SetupController } from '@contexts/identity-access/interface/setup.controller';
import { BootstrapController } from '@contexts/identity-access/interface/bootstrap.controller';
import { HouseholdController } from '@contexts/identity-access/interface/household.controller';

/**
 * 认证模块(T019/T033/T034/T035;T036/T037/T039 扩展)。
 * US8 T130:DeviceController(GET /devices、POST /devices/{id}/revoke)已迁入
 * modules/settings(settings-devices.controller,新契约含当次密码),本模块不再注册。
 * 服务均为纯函数模块(对齐 token.service.ts 惯例),模块仅承载路由注册;
 * CommonModule 提供 SetupController 依赖的 PublicContextService 与
 * RateLimitGuard 的 RateLimitService(T036 /setup/status)。
 */

/**
 * Household 模块(T018/T020):家庭信息查询。
 * T036(005-US2)起初始化契约(/setup/*)迁入 modules/auth(setup.controller.ts,
 * 仅建 Household+Account、不自动登录);本模块不再承载 setup 路由。
 *
 * 007-T015:AuthModule 与 HouseholdModule 合并为 IdentityAccessModule
 * (contexts/identity-access 装配;HouseholdController 路由前缀语义原样保留)。
 */
@Module({
  imports: [HttpCommonModule],
  controllers: [AuthController, SetupController, BootstrapController, HouseholdController],
})
export class IdentityAccessModule {}
