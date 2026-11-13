import { Module } from '@nestjs/common';
import { HttpCommonModule } from '@platform/http-common/http-common.module';
import { PublicGuideController } from '@contexts/epg/interface/public-guide.controller';
import { PublicProgrammePosterController } from '@contexts/epg/interface/public-programme-poster.controller';
import {
  EPG_MANUAL_BINDING_PORT,
  EPG_PROGRAMME_POSTER_PORT,
  EPG_PROGRAMME_POSTER_PROXY_PORT,
  EPG_SERVICE_PORT,
  EPG_STORE,
  TMDB_CLIENT_PORT,
} from '@contexts/epg/epg.tokens';
import {
  getBindingState,
  listEpgCandidates,
  saveBinding,
  unbindBinding,
} from '@contexts/epg/application/manual-epg-binding.service';
import { getMediaProgrammes } from '@contexts/epg/application/epg.service';
import { bindEpgStore, epgStore } from '@contexts/epg/application/epg-store.port';
import { drizzleEpgStore } from '@contexts/epg/infrastructure/epg-store.drizzle';
import { createTmdbClient, tmdbImageAllowedTargets } from '@contexts/epg/infrastructure/tmdb.client';
import { createProgrammePosterService } from '@contexts/epg/application/programme-poster.service';
import { createProgrammePosterProxyService } from '@contexts/epg/application/programme-poster-proxy.service';
import { SAFE_UPSTREAM_PORT } from '@platform/upstream/safe-upstream.port';
import { getConfig } from '@platform/config/env';
import type { IEpgManualBindingService, IEpgService } from '@contexts/epg/epg.ports';

/**
 * EPG 节目指南模块(T042/T115;005 contracts/api.md §2、data-model.md §8):
 * - epg.service 为纯函数模块(对齐 catalog/policy 惯例),数据访问经 epg 仓储端口 seam
 *   (008-T007 抽取,行为零变化),由 catalog 控制器直接消费(T044 的 GET /media/{mediaId}/programmes;
 *   T071 起节目解析含手动绑定优先语义;绑定管理路由迁入 settings 后本模块不再挂
 *   ManualEpgBindingController,业务规则仍在 manual-epg-binding.service);
 * - 本模块不承担 US1 发布前置职责(指南窗口发布已由 imports 的
 *   RefreshPublishService.publishEpgWindow + 执行器 T026 实现,EPG 关联目标校验已由
 *   sources T020 实现,此处只消费其落库结果);
 * - PublicGuideController(US6 T115):GET /public/guide 公共 EPG 墙窗口
 *   (guide-calendar/guide-window.service/binding-core/catalog-revision 纯函数核心;
 *   Public 边界匿名、guide 限频 30 次/分钟、严格入参、409/422 语义)。
 *
 * 007-T021:发布面令牌装配 —— 跨上下文消费的应用服务(manual-epg-binding/epg.service)
 * 以令牌 provider 发布(纯函数模块经 useValue 函数束 + satisfies 对齐 ports 接口,
 * 零行为变化);exports 仅发布令牌,消费方迁移属 T022。
 *
 * 008-repository-extraction(ADR-0015 D1):装配期绑定仓储 seam ——
 * EPG_STORE provider 实例化时经 bindEpgStore 注入 Drizzle 实现
 * (惰性 getDb 解析,Database 单例重开安全);不经 HTTP 暴露,不导出。
 */
@Module({
  // CommonModule 提供 RateLimitGuard 的 RateLimitService(与 AuthModule 同一惯例;
  // US4 执行者越界最小修复:US6 T115 挂载守卫后全应用 boot 失败,详见最终报告)
  imports: [HttpCommonModule],
  controllers: [PublicGuideController, PublicProgrammePosterController],
  providers: [
    {
      provide: EPG_STORE,
      useFactory: () => bindEpgStore(drizzleEpgStore()),
    },
    {
      provide: EPG_MANUAL_BINDING_PORT,
      useValue: { getBindingState, listEpgCandidates, saveBinding, unbindBinding } satisfies IEpgManualBindingService,
    },
    {
      provide: EPG_SERVICE_PORT,
      useValue: { getMediaProgrammes } satisfies IEpgService,
    },
    /* —— 020 TMDB 节目海报 —— */
    {
      provide: TMDB_CLIENT_PORT,
      useFactory: () => createTmdbClient(),
    },
    {
      provide: EPG_PROGRAMME_POSTER_PORT,
      inject: [TMDB_CLIENT_PORT],
      useFactory: (client: ReturnType<typeof createTmdbClient>) =>
        createProgrammePosterService({ client }),
    },
    {
      provide: EPG_PROGRAMME_POSTER_PROXY_PORT,
      inject: [SAFE_UPSTREAM_PORT],
      useFactory: (safeUpstream: { read: Parameters<typeof createProgrammePosterProxyService>[0]['safeUpstream']['read'] }) => {
        const config = getConfig();
        return createProgrammePosterProxyService({
          resolveByRef: (householdId, ref) => epgStore().findProgrammePosterByRef(householdId, ref),
          safeUpstream,
          imageBaseUrl: config.TMDB_IMAGE_BASE_URL,
          allowedTargets: tmdbImageAllowedTargets(config.TMDB_IMAGE_BASE_URL),
        });
      },
    },
  ],
  exports: [EPG_MANUAL_BINDING_PORT, EPG_SERVICE_PORT, EPG_PROGRAMME_POSTER_PORT],
})
export class EpgModule {}
