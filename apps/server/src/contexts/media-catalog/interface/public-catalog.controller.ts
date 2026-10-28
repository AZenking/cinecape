import { Body, Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { PublicContextDto, PublicMediaDto, PublicMediaPageDto } from '@hmp/shared';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { StrictBodyPipe, StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import { PublicCatalogService, type PublicMediaListQuery } from '@contexts/media-catalog/application/public-catalog.service';

/**
 * 公共目录控制器(T023/T024/T025,005 contracts/api.md §1/§2)——
 *
 * 公共路由挂法(005 底座约定,不挂 SessionGuard:公共只读不读取身份):
 *   @Controller('public') + @UseGuards(RateLimitGuard) + @RateLimit('public')
 *   + StrictQueryPipe(未知 query 字段一律 400,不能借 householdId/profileId/isAdmin
 *   扩大读取范围)+ 空体严格管道(GET 亦拒绝携带未知 JSON body 字段)。
 * SameOriginGuard 只约束写操作,公共只读路由不挂(api.md §1)。
 *
 * 路由(全部匿名可读、无会话门槛):
 * - GET /public/context            公共上下文白名单投影
 * - GET /public/media              公共目录列表(q<=100/type/page/pageSize=20 max100)
 * - GET /public/media/{mediaId}    公共详情(白名单投影;不存在/跨家庭统一 404)
 */

/** 公共只读端点不接受任何请求体:未知 JSON 字段一律 400(GET 防御性同口径) */
const PUBLIC_EMPTY_BODY_SCHEMA = z.preprocess((value: unknown) => value ?? {}, strictObject({}));

/** media type 枚举(media_item CHECK 与 PublicMedia 契约一致) */
const MEDIA_TYPE_VALUES = ['channel', 'movie', 'series', 'episode', 'video'] as const;

/** 目录查询严格形态:q<=100、type 枚举、page>=1、pageSize=20(缺省)/max100 */
const MEDIA_LIST_QUERY_SCHEMA = strictObject({
  q: z.string().max(100).optional(),
  type: z.enum(MEDIA_TYPE_VALUES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** context/详情:不接受任何 query 字段(未知字段一律 400) */
const PUBLIC_EMPTY_QUERY_SCHEMA = strictObject({});

@Controller('public')
@UseGuards(RateLimitGuard)
@RateLimit('public')
export class PublicCatalogController {
  // @Inject 显式声明依赖(esbuild/tsx 运行时不发射 design:paramtypes,
  // 仓库既有惯例见 playback-authorization.service)
  constructor(@Inject(PublicCatalogService) private readonly catalog: PublicCatalogService) {}

  @Get('context')
  context(
    @Query(new StrictQueryPipe(PUBLIC_EMPTY_QUERY_SCHEMA)) _query: Record<string, never>,
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
  ): PublicContextDto {
    return this.catalog.getContext();
  }

  @Get('media')
  listMedia(
    @Query(new StrictQueryPipe(MEDIA_LIST_QUERY_SCHEMA)) query: PublicMediaListQuery,
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
  ): PublicMediaPageDto {
    return this.catalog.listMedia(query);
  }

  @Get('media/:mediaId')
  getMedia(
    @Param('mediaId') mediaId: string,
    @Query(new StrictQueryPipe(PUBLIC_EMPTY_QUERY_SCHEMA)) _query: Record<string, never>,
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
  ): PublicMediaDto {
    return this.catalog.getMedia(mediaId);
  }
}
