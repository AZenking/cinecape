import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { MediaDto, MediaPageDto, ProgrammesDto } from '@hmp/shared';
import { CurrentSession, type SessionContext } from '../../../common/current-session.decorator';
import { SessionGuard } from '../../../common/session.guard';
import { parseBody } from '../../../modules/auth/validation';
import { getMediaProgrammes } from '@contexts/epg/application/epg.service';
import { getMedia, listMedia } from '@contexts/media-catalog/application/catalog.service';

/**
 * 观看目录契约路由(T035/T044;003 contracts/openapi.yaml /media、/media/{mediaId}、
 * /media/{mediaId}/programmes):
 * - 判定次序:SessionGuard(401)→ 严格 zod(400,未知查询键与授权事实字段拒绝)→
 *   服务层批量上下文(无档案 403 ACTIVE_PROFILE_REQUIRED;策略缺失/损坏 503 POLICY_UNAVAILABLE;
 *   目标不可见/不可用/跨家庭/不存在 404 NOT_FOUND 同形);
 * - 节目查询(T044)复用同一授权链后交由 epg.service 解析(非频道 400;指南缺失降级 200 unavailable);
 * - 列表和详情均无 owner 内容豁免;路由挂 /api 全局前缀(与生产 main.ts 一致)。
 */

/** GET /media 查询:q ≤100(trim 在服务层)、type 枚举、page ≥1 默认 1、pageSize 默认 20 最大 100 */
const listMediaQuerySchema = z.strictObject({
  q: z.string().max(100).optional(),
  type: z.enum(['channel', 'movie', 'series', 'episode', 'video']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

@Controller('media')
@UseGuards(SessionGuard)
export class CatalogController {
  /** GET /media:先策略过滤再搜索/排序/计数/分页;无记录 200 空列表 */
  @Get()
  list(@Query() query: unknown, @CurrentSession() context: SessionContext): MediaPageDto {
    return listMedia(context, parseBody(listMediaQuerySchema, query));
  }

  /** GET /media/{mediaId}:不可用/不可见/跨家庭/不存在统一 404 NOT_FOUND */
  @Get(':mediaId')
  detail(@Param('mediaId') mediaId: string, @CurrentSession() context: SessionContext): MediaDto {
    return getMedia(context, mediaId);
  }

  /**
   * GET /media/{mediaId}/programmes(T044):同一授权链(先授权再要求 type=channel);
   * 指南未关联/禁用/冲突/无匹配 → 200 unavailable,节目编排见 epg.service(T042)。
   */
  @Get(':mediaId/programmes')
  programmes(@Param('mediaId') mediaId: string, @CurrentSession() context: SessionContext): ProgrammesDto {
    return getMediaProgrammes(context, mediaId);
  }
}
