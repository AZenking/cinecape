import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { CommonModule } from '../../common/common.module';
import { RateLimitGuard } from '../../common/rate-limit/rate-limit.guard';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { PublicCatalogService } from '@contexts/media-catalog/application/public-catalog.service';
import { CatalogController } from '@contexts/media-catalog/interface/catalog.controller';
import { PublicCatalogController } from '@contexts/media-catalog/interface/public-catalog.controller';

/**
 * RateLimitGuard 构造参数元数据补齐(本模块装载时一次性执行)——
 * 运行时(esbuild/tsx 转译)不发射 design:paramtypes,守卫经 @UseGuards(类引用)
 * 实例化时构造依赖解析为 undefined(reflector 缺失 → canActivate 崩溃)。
 * common/ 底座不可修改,此处按 emitDecoratorMetadata 的等价形态为该类补齐
 * [RateLimitService, Reflector] 参数类型元数据;与 tsc 全元数据产物(相同两型)
 * 逐位一致,重复定义无语义差。仓库既有先例:playback 模块以 @Inject 显式声明
 * 依赖规避同一运行时缺口,本类不可改,故以元数据补齐达到同一效果。
 */
Reflect.defineMetadata(PARAMTYPES_METADATA, [RateLimitService, Reflector], RateLimitGuard);

/**
 * 观看目录模块(T035;US2):只读目录路由 + 家长候选/人工修正(T050)。
 * 目录服务为纯函数模块(对齐 policy/profile 惯例),数据访问经 auth/db
 * 共享 SQLite 单例,无独立 provider。
 * ⚠️ PolicyListsController(PUT /profiles/{profileId}/policy/lists)为 T063 过渡托管:
 * 该路由最终应迁入 policy.controller.ts(本任务不可写该文件),迁移时仅动控制器注册。
 *
 * 公共目录模块(T023,005 Phase 3 US1)——
 * 承载 /api/public/context、/api/public/media、/api/public/media/{mediaId} 三个
 * 匿名只读端点(research R1:公共元数据统一 /api/public/*,复用 available-media
 * 集合与范围解析,不复用身份授权前置)。
 *
 * 依赖:CommonModule 提供 PublicContextService(范围解析)与 RateLimitService
 * (RateLimitGuard 构造依赖);无状态 Guard/Pipe 按仓库惯例具名导入挂载,不入组。
 *
 * 接线说明(供 app.module.ts 注册,本任务不改该文件):
 *   import { PublicCatalogModule } from './modules/public-catalog/public-catalog.module';
 *   imports: [..., PublicCatalogModule]
 */
@Module({
  imports: [CommonModule],
  controllers: [CatalogController, PublicCatalogController],
  providers: [PublicCatalogService],
})
export class MediaCatalogModule {}
