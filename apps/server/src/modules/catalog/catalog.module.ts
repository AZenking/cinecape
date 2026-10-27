import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';

/**
 * 观看目录模块(T035;US2):只读目录路由 + 家长候选/人工修正(T050)。
 * 目录服务为纯函数模块(对齐 policy/profile 惯例),数据访问经 auth/db
 * 共享 SQLite 单例,无独立 provider。
 * ⚠️ PolicyListsController(PUT /profiles/{profileId}/policy/lists)为 T063 过渡托管:
 * 该路由最终应迁入 policy.controller.ts(本任务不可写该文件),迁移时仅动控制器注册。
 */
@Module({
  controllers: [CatalogController],
})
export class CatalogModule {}
