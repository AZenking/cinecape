import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PublicGuideController } from '@contexts/epg/interface/public-guide.controller';

/**
 * EPG 节目指南模块(T042/T115;005 contracts/api.md §2、data-model.md §8):
 * - epg.service 为纯函数模块(对齐 catalog/policy 惯例),数据访问经 auth/db 共享 SQLite
 *   单例,由 catalog 控制器直接消费(T044 的 GET /media/{mediaId}/programmes;
 *   T071 起节目解析含手动绑定优先语义;绑定管理路由迁入 settings 后本模块不再挂
 *   ManualEpgBindingController,业务规则仍在 manual-epg-binding.service);
 * - 本模块不承担 US1 发布前置职责(指南窗口发布已由 imports 的
 *   RefreshPublishService.publishEpgWindow + 执行器 T026 实现,EPG 关联目标校验已由
 *   sources T020 实现,此处只消费其落库结果);
 * - PublicGuideController(US6 T115):GET /public/guide 公共 EPG 墙窗口
 *   (guide-calendar/guide-window.service/binding-core/catalog-revision 纯函数核心;
 *   Public 边界匿名、guide 限频 30 次/分钟、严格入参、409/422 语义)。
 */
@Module({
  // CommonModule 提供 RateLimitGuard 的 RateLimitService(与 AuthModule 同一惯例;
  // US4 执行者越界最小修复:US6 T115 挂载守卫后全应用 boot 失败,详见最终报告)
  imports: [CommonModule],
  controllers: [PublicGuideController],
})
export class EpgModule {}
