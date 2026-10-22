import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';

/**
 * Profile 模块(T025-T028):list + 创建/编辑/选择/PIN 解锁。
 * 服务为纯函数模块(对齐 auth/household 惯例),模块仅承载路由注册。
 */
@Module({
  controllers: [ProfileController],
})
export class ProfileModule {}
