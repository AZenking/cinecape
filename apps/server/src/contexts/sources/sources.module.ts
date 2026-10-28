import { Module } from '@nestjs/common';
import { RefreshExecutorService } from '@contexts/sources/application/refresh-executor.service';
import { RefreshPublishService } from '@contexts/sources/application/refresh-publish.service';
import {
  createSource,
  confirmSourceRefresh,
  discardSourceRefresh,
  getSourceRefresh,
  listSourceRoots,
  listSources,
  requestSourceRefresh,
  updateSource,
} from '@contexts/sources/application/sources.service';
import { bindSourcesStore } from '@contexts/sources/application/sources-store.port';
import { drizzleSourcesStore } from '@contexts/sources/infrastructure/sources-store.drizzle';
import { REFRESH_EXECUTOR_PORT, SOURCES_SERVICE_PORT, SOURCES_STORE } from '@contexts/sources/sources.tokens';
import type { ISourcesService } from '@contexts/sources/sources.ports';

/**
 * Sources 模块(T020/T028):来源管理 + 刷新任务契约路由。
 * 服务为纯函数模块(对齐 policy/profile 惯例),模块承载路由注册与执行器注入;
 * RefreshModule 已由 AppModule 注册,此处导入仅为把 RefreshExecutorService 注入控制器 ——
 * Nest 模块缓存放宽下仍是同一实例,不会产生第二个串行执行循环。
 *
 * 刷新执行模块(T026/T027):
 * - RefreshPublishService:发布事务(重验/upsert/mark missing/NAS 替换清理/收尾,单事务原子);
 * - RefreshExecutorService:任务状态机 + 串行执行器 + 确认/丢弃,导出供 T028 sources 控制器消费;
 * - 数据访问经 SOURCES_STORE seam 绑定的仓储实现(008-T009;句柄仍随 Database SQLite
 *   单例惰性解析,连接语义与迁移前一致)。
 *
 * 007-T021:发布面 exports 对齐令牌 —— RefreshExecutorService 类 provider 保留
 * (sources.service 函数束以 executor 参数引用同一实例),令牌经 useExisting 别名到
 * 同一实例(useClass/useFactory 会产生第二执行循环,违反行为零变化);exports 仅发布
 * 令牌,settings 控制器类引用注入同步改为 @Inject(令牌)(T021 最小编译/启动修复,
 * 逐条记录)。
 *
 * 008-repository-extraction(T009,ADR-0015 D1):装配期绑定仓储 seam ——
 * SOURCES_STORE provider 实例化时经 bindSourcesStore 注入 Drizzle 实现
 * (drizzle/原生句柄均惰性解析,Database 单例重开安全);所有 provider 构造完成后
 * 生命周期钩子方触发(RefreshExecutorService.onModuleInit 的恢复路径安全);
 * 不经 HTTP 暴露,不导出。
 */
@Module({
  controllers: [],
  providers: [
    {
      provide: SOURCES_STORE,
      useFactory: () => bindSourcesStore(drizzleSourcesStore()),
    },
    RefreshPublishService,
    RefreshExecutorService,
    { provide: REFRESH_EXECUTOR_PORT, useExisting: RefreshExecutorService },
    {
      provide: SOURCES_SERVICE_PORT,
      useValue: {
        createSource,
        confirmSourceRefresh,
        discardSourceRefresh,
        getSourceRefresh,
        listSourceRoots,
        listSources,
        requestSourceRefresh,
        updateSource,
      } satisfies ISourcesService,
    },
  ],
  exports: [REFRESH_EXECUTOR_PORT, SOURCES_SERVICE_PORT],
})
export class SourcesModule {}
