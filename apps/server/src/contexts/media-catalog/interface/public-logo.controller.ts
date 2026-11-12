import fs from 'node:fs';
import path from 'node:path';
import { Body, Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { StrictBodyPipe, StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { env } from '@platform/config/env';
import { MEDIA_CATALOG_LOGO_PROXY_SERVICE } from '@contexts/media-catalog/media-catalog.tokens';
import type { MediaLogoContent } from '@contexts/media-catalog/application/logo.service';

/**
 * 014 T010 — 公共频道 Logo 同源代理契约路由(contracts/api.md §1):
 *
 * GET /public/media/logos/:logoRef —— 010 GET /public/vod/posters/:posterRef 的
 * 同口径镜像,路由挂法与公共面底座约定一致(与 PublicVodController/LivePublicController
 * 同款;不挂 SessionGuard:公共只读不读取身份、不设身份 cookie、不按 cookie 过滤内容):
 *   @Controller('public') + @UseGuards(RateLimitGuard) + @RateLimit('public')
 *   + StrictQueryPipe/空体严格管道(未知字段一律 400)。
 *
 * 家庭范围经 PublicContextService.requireScope() 服务端确定(单家庭部署模型),
 * 绝不取自客户端(api.md §1「授权」行);未初始化部署无任何已签发 ref → 404 同形
 * (不泄露存储形态)。业务语义(解析门 404/410 与上游门 502/504)全部由 T009 服务
 * 承担,错误一律经既有 DomainError/问题码由全局 ProblemJsonFilter 渲染;接口层只透传。
 *
 * 成功响应:image/* 字节原样回传(不落盘、不写服务端缓存)+ Cache-Control:
 * public, max-age=300(R6 引用键控短缓存;本端点显式覆盖全局安全头拦截器的
 * no-store,api-security-headers.interceptor 注释明示「端点显式覆盖以端点为准」)。
 * 二进制成功响应不走 problem JSON 惯例 Content-Type;字节有界(≤2MiB)已由服务面保证。
 */

/** 预览/代理路径参数外的 query 一律拒绝(未知字段 400) */
const PUBLIC_EMPTY_QUERY_SCHEMA = strictObject({});

/** 公共只读端点不接受任何请求体:未知 JSON 字段一律 400(GET 防御性同口径) */
const PUBLIC_EMPTY_BODY_SCHEMA = z.preprocess((value: unknown) => value ?? {}, strictObject({}));

@Controller('public')
@UseGuards(RateLimitGuard)
@RateLimit('public')
export class PublicLogoController {
  // @Inject 显式声明(esbuild/tsx 不发射 design:paramtypes;仓库既有惯例)
  constructor(
    @Inject(MEDIA_CATALOG_LOGO_PROXY_SERVICE)
    private readonly logoService: {
      fetch(command: { readonly householdId: string; readonly logoRef: string }): Promise<MediaLogoContent>;
    },
    @Inject(PublicContextService) private readonly publicContext: PublicContextService,
  ) {}

  @Get('media/logos/:logoRef')
  async logo(
    @Param('logoRef') logoRef: string,
    @Query(new StrictQueryPipe(PUBLIC_EMPTY_QUERY_SCHEMA)) _query: Record<string, never>,
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
    @Res() res: Response,
  ): Promise<void> {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      // 未初始化部署无任何已签发 ref:404 同形(不泄露存储形态;与目录资源不存在完全同形)
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    const content = await this.logoService.fetch({ householdId: scope.household.householdId, logoRef });
    res.setHeader('Content-Type', content.contentType);
    res.setHeader('Content-Length', String(content.bytes.byteLength));
    // R6:引用键控短缓存(引用按频道+家庭唯一,无跨家庭串味面);显式覆盖全局 no-store
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200);
    res.end(content.bytes);
  }

  /** GET /public/media/custom-logos/:filename —— 自定义上传台标直读服务 */
  @Get('media/custom-logos/:filename')
  async customLogo(
    @Param('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    const safeName = path.basename(filename);
    const filePath = path.resolve(env.DATA_DIR, 'uploads', 'logos', safeName);
    if (!fs.existsSync(filePath)) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    const ext = path.extname(safeName).toLowerCase();
    const mime =
      ext === '.svg'
        ? 'image/svg+xml'
        : ext === '.webp'
        ? 'image/webp'
        : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : 'image/png';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  }
}
