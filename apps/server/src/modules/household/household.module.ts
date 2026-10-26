import { Module } from '@nestjs/common';
import { HouseholdController } from './household.controller';

/**
 * Household 模块(T018/T020):家庭信息查询。
 * T036(005-US2)起初始化契约(/setup/*)迁入 modules/auth(setup.controller.ts,
 * 仅建 Household+Account、不自动登录);本模块不再承载 setup 路由。
 */
@Module({
  controllers: [HouseholdController],
})
export class HouseholdModule {}
