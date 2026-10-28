import { Module } from '@nestjs/common';
import { RefreshExecutorService } from '@contexts/sources/application/refresh-executor.service';
import { RefreshPublishService } from '@contexts/sources/application/refresh-publish.service';

/**
 * Sources 模块(T020/T028):来源管理 + 刷新任务契约路由。
 * 服务为纯函数模块(对齐 policy/profile 惯例),模块承载路由注册与执行器注入;
 * RefreshModule 已由 AppModule 注册,此处导入仅为把 RefreshExecutorService 注入控制器 ——
 * Nest 模块缓存放宽下仍是同一实例,不会产生第二个串行执行循环。
 *
 * 刷新执行模块(T026/T027):
 * - RefreshPublishService:发布事务(重验/upsert/mark missing/NAS 替换清理/收尾,单事务原子);
 * - RefreshExecutorService:任务状态机 + 串行执行器 + 确认/丢弃,导出供 T028 sources 控制器消费;
 * - 数据访问沿用 Database SQLite 单例(对齐 sources/policy 纯函数模块惯例),无独立 provider 依赖。
 */
@Module({
  controllers: [],
  providers: [RefreshPublishService, RefreshExecutorService],
  exports: [RefreshExecutorService],
})
export class SourcesModule {}
