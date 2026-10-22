import { Module } from '@nestjs/common';
import { HouseholdController } from './household.controller';
import { SetupController } from './setup.controller';

/**
 * Household 模块(T018/T020):初始化向导契约 + 家庭信息查询。
 * 服务为纯函数模块(复用 auth 模块的会话/设备/口令能力),模块仅承载路由注册。
 */
@Module({
  controllers: [SetupController, HouseholdController],
})
export class HouseholdModule {}
