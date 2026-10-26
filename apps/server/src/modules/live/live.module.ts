import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { LivePublicController } from './live.controller';

/**
 * 公共直播模块(T063;005 Phase 6 / US5):
 * - LivePublicController 承载三个公共只读端点(GET /api/public/live/groups、
 *   /api/public/live/channels、/api/public/media/{mediaId}/programmes),
 *   Public 边界不挂 SessionGuard;限频经 CommonModule 的 RateLimitService;
 * - 纯函数核心(live-time/live-grouping/live-sections)+ 批量投影
 *   (live-projection.service:关联解析不含 ProfilePolicy,集合查询次数不随频道数增长);
 * - 模块无独立持久状态,纯函数服务不经 providers 注入(对齐 epg/catalog 惯例)。
 *
 * 注册(app.module.ts,由 lead 任务勾选时接入;本任务不改 app.module.ts):
 *   import { LiveModule } from './modules/live/live.module';
 *   imports: [ ..., LiveModule ]  (追加于 EpgModule 之后)
 */
@Module({
  imports: [CommonModule],
  controllers: [LivePublicController],
})
export class LiveModule {}
