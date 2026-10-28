import { Module } from '@nestjs/common';
import { HttpCommonModule } from '@platform/http-common/http-common.module';
import { LivePublicController } from '@contexts/live-tv/interface/live.controller';
import { LIVE_TV_LIVE_PROJECTION_PORT, LIVE_TV_STORE } from '@contexts/live-tv/live-tv.tokens';
import {
  loadChannelAssociationCore,
  loadLiveChannelWindows,
  programmeKeyOf,
} from '@contexts/live-tv/application/live-projection.service';
import { bindLiveTvStore } from '@contexts/live-tv/application/live-tv-store.port';
import { drizzleLiveTvStore } from '@contexts/live-tv/infrastructure/live-tv-store.drizzle';
import type { ILiveProjectionService } from '@contexts/live-tv/live-tv.ports';

/**
 * 公共直播模块(T063;005 Phase 6 / US5):
 * - LivePublicController 承载三个公共只读端点(GET /api/public/live/groups、
 *   /api/public/live/channels、/api/public/media/{mediaId}/programmes),
 *   Public 边界不挂 SessionGuard;限频经 CommonModule 的 RateLimitService;
 * - 纯函数核心(live-time/live-grouping/live-sections)+ 批量投影
 *   (live-projection.service:关联解析不含 ProfilePolicy,集合查询次数不随频道数增长);
 * - 模块无独立持久状态,纯函数服务不经 providers 注入(对齐 epg/catalog 惯例)。
 *
 * 注册(app.module.ts,由 lead 任务勾选时接入;007-T012 迁移落位后为
 *   import { LiveTvModule } from '@contexts/live-tv/live-tv.module';
 *   imports: [ ..., LiveTvModule ]  (追加于 EpgModule 之后))
 *
 * 007-T021:发布面令牌装配 —— 跨上下文消费的 live-projection.service 以令牌 provider
 * 发布(纯函数模块经 useValue 函数束 + satisfies 对齐 ports 接口,零行为变化;
 * 头注释「纯函数服务不经 providers 注入」自本步起对发布面例外:provider 仅为令牌束,
 * 无实例/状态);exports 仅发布令牌,消费方迁移属 T022。
 *
 * 008-repository-extraction(T008,ADR-0015 D1):装配期绑定仓储 seam ——
 * LIVE_TV_STORE provider 实例化时经 bindLiveTvStore 注入 Drizzle 实现
 * (惰性 getDb 解析,Database 单例重开安全);不经 HTTP 暴露,不导出。
 */
@Module({
  imports: [HttpCommonModule],
  controllers: [LivePublicController],
  providers: [
    {
      provide: LIVE_TV_STORE,
      useFactory: () => bindLiveTvStore(drizzleLiveTvStore()),
    },
    {
      provide: LIVE_TV_LIVE_PROJECTION_PORT,
      useValue: { loadChannelAssociationCore, loadLiveChannelWindows, programmeKeyOf } satisfies ILiveProjectionService,
    },
  ],
  exports: [LIVE_TV_LIVE_PROJECTION_PORT],
})
export class LiveTvModule {}
