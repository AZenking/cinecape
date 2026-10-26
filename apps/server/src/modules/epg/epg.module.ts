import { Module } from '@nestjs/common';
import { ManualEpgBindingController } from './manual-epg-binding.controller';

/**
 * EPG 节目指南模块(T042;US4,只读「当前/下一节目」查询):
 * - epg.service 为纯函数模块(对齐 catalog/policy 惯例),数据访问经 auth/db 共享 SQLite
 *   单例,由 catalog 控制器直接消费(T044 的 GET /media/{mediaId}/programmes;
 *   T071 起节目解析含手动绑定优先语义,管理动作仍全部收敛在 manual-epg-binding.service);
 * - ManualEpgBindingController(T071;US5/ADR-0008)承载手动绑定管理契约路由
 *   (/catalog/media/{mediaId}/epg-binding|epg-candidates),业务规则在
 *   manual-epg-binding.service,本模块不承担 US1 发布前置职责
 *   (指南窗口发布已由 imports 的 RefreshPublishService.publishEpgWindow + 执行器 T026 实现,
 *   EPG 关联目标校验已由 sources T020 实现,此处只消费其落库结果)。
 */
@Module({
  controllers: [ManualEpgBindingController],
})
export class EpgModule {}
