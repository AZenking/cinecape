import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AuthController } from './auth.controller';
import { BootstrapController } from './bootstrap.controller';
import { SetupController } from './setup.controller';
import { DeviceController } from './device.controller';

/**
 * 认证模块(T019/T033/T034/T035;T036/T037/T039 扩展)。
 * 服务均为纯函数模块(对齐 token.service.ts 惯例),模块仅承载路由注册;
 * CommonModule 提供 SetupController 依赖的 PublicContextService 与
 * RateLimitGuard 的 RateLimitService(T036 /setup/status)。
 */
@Module({
  imports: [CommonModule],
  controllers: [AuthController, SetupController, BootstrapController, DeviceController],
})
export class AuthModule {}
