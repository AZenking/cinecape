import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AuthController } from './auth.controller';
import { BootstrapController } from './bootstrap.controller';
import { SetupController } from './setup.controller';

/**
 * 认证模块(T019/T033/T034/T035;T036/T037/T039 扩展)。
 * US8 T130:DeviceController(GET /devices、POST /devices/{id}/revoke)已迁入
 * modules/settings(settings-devices.controller,新契约含当次密码),本模块不再注册。
 * 服务均为纯函数模块(对齐 token.service.ts 惯例),模块仅承载路由注册;
 * CommonModule 提供 SetupController 依赖的 PublicContextService 与
 * RateLimitGuard 的 RateLimitService(T036 /setup/status)。
 */
@Module({
  imports: [CommonModule],
  controllers: [AuthController, SetupController, BootstrapController],
})
export class AuthModule {}
