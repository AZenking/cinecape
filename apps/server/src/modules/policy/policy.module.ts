import { Module } from '@nestjs/common';
import { PolicyController } from './policy.controller';

/**
 * Policy 模块(T011):策略管理契约路由。
 * 服务为纯函数模块(对齐 auth/profile 惯例),模块仅承载路由注册。
 * 授权入口 authorizeCurrentProfile 不经 HTTP 暴露;测试夹具经测试专用装配注入可信资源 reader,
 * 不注册到本模块或生产 AppModule(FR-015/plan)。
 */
@Module({
  controllers: [PolicyController],
})
export class PolicyModule {}
