import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  type CandidatePageDto,
  type MediaDto,
  type RefreshDto,
  type RootDto,
  type SourceDto,
  type SourcePageDto,
} from '@hmp/shared';
import { CurrentSession } from '../../common/current-session.decorator';
import type { SessionContext } from '../../common/current-session.decorator';
import { SameOriginGuard } from '../../common/same-origin/same-origin.guard';
import { SessionGuard } from '../../common/session.guard';
import { SettingsAccessGuard } from '../../common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '../../common/strict-input/strict-pipes';
import { RefreshExecutorService } from '@contexts/sources/application/refresh-executor.service';
import { parseBody } from '../auth/validation';
import { isParsableRemoteUrl } from '@contexts/sources/domain/source-target.validation';
import {
  confirmSourceRefresh,
  createSource,
  discardSourceRefresh,
  getSourceRefresh,
  listSourceRoots,
  listSources,
  requestSourceRefresh,
  updateSource,
} from '@contexts/sources/application/sources.service';
import { patchMediaMetadata, queryCandidates } from '@contexts/media-catalog/application/catalog-admin.service';

/**
 * 媒体来源与目录管理契约路由(T128,005 contracts/api.md §6;api.md §8「新 settings
 * 前缀是替代,不保留旧 /sources、/catalog 管理入口」):
 * - 领域核心零改动:复用 modules/sources(sources.service)与 modules/imports
 *   (RefreshExecutorService)、modules/catalog(catalog-admin.service),本控制器
 *   只做「Settings 边界守卫 + 严格入参 + 新前缀」;当次密码/既有 CAS/源 URL 脱敏/
 *   失败保留上次成功目录均由域核心承担;
 * - refresh Location 指向新契约路径 /api/settings/refreshes/{id};
 * - GET 轮询失效(403)即由前端终止(服务端无轮询状态)。
 */

/* 请求 schema:与旧 sources/catalog 管理控制器逐字一致(继承 003 契约) */

const remoteUrlSyntaxSchema = z
  .string()
  .min(1)
  .refine(isParsableRemoteUrl, { message: 'remoteUrl 必须是带合法主机的绝对 URL' });

const createSourceRequestSchema = z
  .strictObject({
    ownerPassword: z.string().optional(),
    kind: z.enum(['iptv', 'epg', 'nas']),
    name: z.string().min(1).max(100),
    enabled: z.boolean().default(true),
    remoteUrl: remoteUrlSyntaxSchema.optional(),
    rootKey: z.string().min(1).optional(),
    relativeDirectory: z.string().optional(),
    privateAccessApproved: z.boolean().default(false),
    epgSourceId: z.union([z.string().uuid(), z.null()]).optional(),
  })
  .superRefine((value, ctx) => {
    const reject = (field: string, message: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [field] });
    };
    if (value.kind === 'nas') {
      if (value.rootKey === undefined) {
        reject('rootKey', 'NAS 来源必须提供 rootKey');
      }
      if (value.relativeDirectory === undefined) {
        reject('relativeDirectory', 'NAS 来源必须提供 relativeDirectory');
      }
      if (value.remoteUrl !== undefined) {
        reject('remoteUrl', 'NAS 来源不能携带 remoteUrl');
      }
      if (value.epgSourceId !== undefined) {
        reject('epgSourceId', 'NAS 来源不能携带 epgSourceId');
      }
      return;
    }
    if (value.remoteUrl === undefined) {
      reject('remoteUrl', 'IPTV/EPG 来源必须提供 remoteUrl');
    }
    if (value.rootKey !== undefined) {
      reject('rootKey', 'IPTV/EPG 来源不能携带 rootKey');
    }
    if (value.relativeDirectory !== undefined) {
      reject('relativeDirectory', 'IPTV/EPG 来源不能携带 relativeDirectory');
    }
    if (value.kind === 'epg' && value.epgSourceId !== undefined) {
      reject('epgSourceId', '仅 IPTV 来源可携带 epgSourceId');
    }
  });

const patchSourceRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  remoteUrl: remoteUrlSyntaxSchema.optional(),
  privateAccessApproved: z.boolean().optional(),
  epgSourceId: z.union([z.string().uuid(), z.null()]).optional(),
});

const listSourcesQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const refreshRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
  operationKey: z.string().uuid(),
});

const jobActionSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
});

const candidateQuerySchema = z.strictObject({
  ownerPassword: z.string().optional(),
  q: z.string().max(100).optional(),
  type: z.enum(['channel', 'movie', 'series', 'episode', 'video']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

const patchMediaRequestSchema = z
  .strictObject({
    ownerPassword: z.string().optional(),
    expectedVersion: z.number().int().min(1),
    title: z.string().min(1).max(255).optional(),
    type: z.enum(['channel', 'movie', 'series', 'episode', 'video']).optional(),
    contentLevel: z.union([z.number().int().min(0).max(18), z.null()]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.title === undefined && value.type === undefined && value.contentLevel === undefined) {
      ctx.addIssue({ code: 'custom', message: 'title/type/contentLevel 至少提供一项', path: ['title'] });
    }
  });

@Controller('settings')
export class SettingsSourcesController {
  // 显式 @Inject 令牌:不依赖 emitDecoratorMetadata(契约测试经 vitest/esbuild 转译,无该元数据)
  constructor(@Inject(RefreshExecutorService) private readonly refreshExecutor: RefreshExecutorService) {}

  /** GET /settings/sources:分页脱敏概览(Settings 边界) */
  @Get('sources')
  @UseGuards(SessionGuard, SettingsAccessGuard)
  list(@Query() query: unknown, @CurrentSession() context: SessionContext): SourcePageDto {
    return listSources(context, parseBody(listSourcesQuerySchema, query));
  }

  /** POST /settings/sources:创建(当次密码 + 目标许可;201 SourceDto) */
  @Post('sources')
  @HttpCode(201)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async create(
    @Body(new StrictBodyPipe(createSourceRequestSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<SourceDto> {
    return createSource(context, parseBody(createSourceRequestSchema, body));
  }

  /** PATCH /settings/sources/{sourceId}:部分更新(当次密码 + expectedVersion CAS) */
  @Patch('sources/:sourceId')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async patchSource(
    @Param('sourceId') sourceId: string,
    @Body(new StrictBodyPipe(patchSourceRequestSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<SourceDto> {
    return updateSource(sourceId, context, parseBody(patchSourceRequestSchema, body));
  }

  /**
   * POST /settings/sources/{sourceId}/refresh:发起刷新(当次密码;幂等 operationKey);
   * 202 + Location=/api/settings/refreshes/{id},不等待网络导入结束。
   */
  @Post('sources/:sourceId/refresh')
  @HttpCode(202)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async refresh(
    @Param('sourceId') sourceId: string,
    @Body(new StrictBodyPipe(refreshRequestSchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<RefreshDto> {
    const dto = await requestSourceRefresh(this.refreshExecutor, context, sourceId, parseBody(refreshRequestSchema, body));
    res.setHeader('Location', `/api/settings/refreshes/${dto.id}`);
    return dto;
  }

  /** GET /settings/source-roots:NAS 根选择列表(仅 rootKey 与展示名,不含绝对路径) */
  @Get('source-roots')
  @UseGuards(SessionGuard, SettingsAccessGuard)
  listRoots(): RootDto[] {
    return listSourceRoots();
  }

  /** GET /settings/refreshes/{refreshId}:任务概览(同家庭;未知/跨家庭 404 同形) */
  @Get('refreshes/:refreshId')
  @UseGuards(SessionGuard, SettingsAccessGuard)
  getRefresh(@Param('refreshId') refreshId: string, @CurrentSession() context: SessionContext): RefreshDto {
    return getSourceRefresh(this.refreshExecutor, context, refreshId);
  }

  /** POST /settings/refreshes/{refreshId}/confirm:确认待确认快照(当次密码 + expectedVersion;200 终态) */
  @Post('refreshes/:refreshId/confirm')
  @HttpCode(200)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async confirm(
    @Param('refreshId') refreshId: string,
    @Body(new StrictBodyPipe(jobActionSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<RefreshDto> {
    return confirmSourceRefresh(this.refreshExecutor, context, refreshId, parseBody(jobActionSchema, body));
  }

  /** POST /settings/refreshes/{refreshId}/discard:丢弃待确认快照(200 discarded;保留上次成功目录) */
  @Post('refreshes/:refreshId/discard')
  @HttpCode(200)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async discard(
    @Param('refreshId') refreshId: string,
    @Body(new StrictBodyPipe(jobActionSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<RefreshDto> {
    return discardSourceRefresh(this.refreshExecutor, context, refreshId, parseBody(jobActionSchema, body));
  }
}

/**
 * 目录候选与人工修正契约路由(T128;继承 003 /catalog/candidates/query、/catalog/media/{id}):
 * 与 sources 控制器同一守卫链;域核心 catalog-admin.service(家长验证/归属/CAS/
 * catalogRevision 递增)零改动。
 */
@Controller('settings/catalog')
@UseGuards(SessionGuard, SettingsAccessGuard)
export class SettingsCatalogController {
  /** POST /settings/catalog/candidates/query:候选分页(当次密码;绕过观看策略,限本家庭) */
  @Post('candidates/query')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async queryCandidates(
    @Body(new StrictBodyPipe(candidateQuerySchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<CandidatePageDto> {
    return queryCandidates(context, parseBody(candidateQuerySchema, body));
  }

  /** PATCH /settings/catalog/media/{mediaId}:人工修正(当次密码 + expectedVersion CAS) */
  @Patch('media/:mediaId')
  @UseGuards(SameOriginGuard)
  async patchMedia(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(patchMediaRequestSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<MediaDto> {
    return patchMediaMetadata(mediaId, context, parseBody(patchMediaRequestSchema, body));
  }
}
