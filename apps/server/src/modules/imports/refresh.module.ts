import { Module } from '@nestjs/common';
import { RefreshExecutorService } from './refresh-executor.service';
import { RefreshPublishService } from './refresh-publish.service';

/**
 * 刷新执行模块(T026/T027):
 * - RefreshPublishService:发布事务(重验/upsert/mark missing/NAS 替换清理/收尾,单事务原子);
 * - RefreshExecutorService:任务状态机 + 串行执行器 + 确认/丢弃,导出供 T028 sources 控制器消费;
 * - 数据访问沿用 Database SQLite 单例(对齐 sources/policy 纯函数模块惯例),无独立 provider 依赖。
 */
@Module({
  providers: [RefreshPublishService, RefreshExecutorService],
  exports: [RefreshExecutorService],
})
export class RefreshModule {}
