import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { DeviceController } from './device.controller';

/**
 * 认证模块(T019/T033/T034/T035)。服务均为纯函数模块(对齐 token.service.ts 惯例),
 * 模块仅承载路由注册。
 */
@Module({
  controllers: [AuthController, DeviceController],
})
export class AuthModule {}
