import { Module } from '@nestjs/common';
import { HttpCommonModule } from '@platform/http-common/http-common.module';
import { HealthModule } from '@platform/health/health.module';

/**
 * platform 聚合模块(007-T018)—— 按 migration-map「Module 装配说明」聚合
 * HealthModule 与 http-common 子模块(config/database 为直接消费的单例/纯函数,
 * 无既有 Nest providers,维持原样不新增绑定)。AppModule 经本模块取得与原
 * `CommonModule + HealthModule` 完全一致的装配图。
 */
@Module({
  imports: [HttpCommonModule, HealthModule],
})
export class PlatformModule {}
