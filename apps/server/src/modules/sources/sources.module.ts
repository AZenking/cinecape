import { Module } from '@nestjs/common';
import { RefreshModule } from '../imports/refresh.module';
import { RefreshesController, SourcesController, SourceRootsController } from './sources.controller';

/**
 * Sources 模块(T020/T028):来源管理 + 刷新任务契约路由。
 * 服务为纯函数模块(对齐 policy/profile 惯例),模块承载路由注册与执行器注入;
 * RefreshModule 已由 AppModule 注册,此处导入仅为把 RefreshExecutorService 注入控制器 ——
 * Nest 模块缓存放宽下仍是同一实例,不会产生第二个串行执行循环。
 */
@Module({
  imports: [RefreshModule],
  controllers: [SourcesController, SourceRootsController, RefreshesController],
})
export class SourcesModule {}
