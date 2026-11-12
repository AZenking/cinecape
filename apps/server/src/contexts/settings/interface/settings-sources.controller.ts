import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type CandidatePageDto,
  type MediaDto,
  type RefreshDto,
  type RootDto,
  type SourceDto,
  type SourcePageDto,
} from '@hmp/shared';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsGuard } from '@contexts/settings/infrastructure/settings.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { env } from '@platform/config/env';
// 007-T021:SourcesModule exports 已对齐令牌,注入改经发布令牌(裸导入 = 发布面契约)
// 007-T022a:跨上下文消费统一改经发布面 index.ts(裸导入),实现文件零改动
import {
  REFRESH_EXECUTOR_PORT,
  confirmSourceRefresh,
  createSource,
  discardSourceRefresh,
  getSourceRefresh,
  isParsableRemoteUrl,
  listSourceRoots,
  listSources,
  requestSourceRefresh,
  testSource,
  updateSource,
  type IRefreshExecutorService,
  type SourceTestResultDto,
} from '@contexts/sources';
import { parseBody } from '@contexts/identity-access';
import {
  addMediaStream,
  batchUpdateMediaVisibility,
  deleteMediaStream,
  listMediaStreams,
  patchMediaMetadata,
  queryCandidates,
  updateMediaStream,
  type ChannelStreamDto,
} from '@contexts/media-catalog';
import { SAFE_UPSTREAM_PORT, type SafeUpstreamPort } from '@platform/upstream/safe-upstream.port';

/**
 * 媒体来源与目录管理契约路由(T128,005 contracts/api.md §6;api.md §8「新 settings
 * 前缀是替代,不保留旧 /sources、/catalog 管理入口」;013-role-differentiated-settings/
 * ADR-0017):来源增删改/连通性测试/刷新/确认丢弃与目录候选/人工修正均属常规运维,
 * 不再要求当次主账号密码(请求体不再携带 ownerPassword,strictObject 下携带即 400);
 * 不可逆高危操作(账号密码/主档案转移/设备撤销)仍保留单次密码。
 * - 领域核心零改动:复用 contexts/sources(sources.service)与 sources 发布面
 *   (RefreshExecutorService)、contexts/media-catalog(catalog-admin.service),本控制器
 *   只做「Settings 边界守卫 + 严格入参 + 新前缀」;既有 CAS/源 URL 脱敏/
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
    kind: z.enum(['iptv', 'epg', 'nas', 'vod']),
    name: z.string().min(1).max(100),
    enabled: z.boolean().default(true),
    remoteUrl: remoteUrlSyntaxSchema.optional(),
    rootKey: z.string().min(1).optional(),
    relativeDirectory: z.string().optional(),
    privateAccessApproved: z.boolean().default(false),
    epgSourceId: z.union([z.string().uuid(), z.null()]).optional(),
    // 010 T026(api.md §2):仅 kind=vod 携带;恒为 apple-cms-json(data-model §2)
    adapter: z.literal('apple-cms-json').optional(),
  })
  .superRefine((value, ctx) => {
    const reject = (field: string, message: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [field] });
    };
    if (value.kind === 'vod') {
      // 010 T026 vod 分支(契约 VodCreateSourceRequest):remoteUrl 必填且 detail
      // 指向 remoteUrl;adapter 必填枚举 apple-cms-json;禁 NAS/EPG 绑定字段。
      if (value.remoteUrl === undefined) {
        reject('remoteUrl', 'vod 来源必须提供 remoteUrl(非空根地址)');
      }
      if (value.adapter === undefined) {
        reject('adapter', 'vod 来源必须提供 adapter(apple-cms-json)');
      }
      if (value.rootKey !== undefined) {
        reject('rootKey', 'vod 来源不能携带 NAS 绑定字段(rootKey)');
      }
      if (value.relativeDirectory !== undefined) {
        reject('relativeDirectory', 'vod 来源不能携带 NAS 绑定字段(relativeDirectory)');
      }
      if (value.epgSourceId !== undefined) {
        reject('epgSourceId', 'vod 来源不能携带 EPG 绑定字段(epgSourceId)');
      }
      return;
    }
    if (value.adapter !== undefined) {
      // 010 T026:非 vod 来源禁带 adapter(仅在线点播来源声明适配器)
      reject('adapter', '仅 vod 来源可携带 adapter(apple-cms-json)');
    }
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

/** 010 T026 SourceTestRequest(严格空对象;013 起免当次密码,携带任何字段一律 400) */
const sourceTestRequestSchema = z.strictObject({});

const refreshRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  operationKey: z.string().uuid(),
});

const jobActionSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});

const candidateQuerySchema = z.strictObject({
  q: z.string().max(100).optional(),
  type: z.enum(['channel', 'movie', 'series', 'episode', 'video']).optional(),
  // 018 频道管理全量过滤修复:可选可见性切片,缺省 all(旧请求体不带该字段语义不变)
  visibility: z.enum(['all', 'visible', 'hidden']).default('all'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

const patchMediaRequestSchema = z
  .strictObject({
    expectedVersion: z.number().int().min(1),
    title: z.string().min(1).max(255).optional(),
    type: z.enum(['channel', 'movie', 'series', 'episode', 'video']).optional(),
    contentLevel: z.union([z.number().int().min(0).max(18), z.null()]).optional(),
    visible: z.boolean().optional(),
    logoUrl: z.union([z.string().max(2048), z.null()]).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.title === undefined &&
      value.type === undefined &&
      value.contentLevel === undefined &&
      value.visible === undefined &&
      value.logoUrl === undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'title/type/contentLevel/visible/logoUrl 至少提供一项',
        path: ['title'],
      });
    }
  });

const batchVisibilitySchema = z.strictObject({
  mediaIds: z.array(z.string().min(1)).optional(),
  all: z.boolean().optional(),
  visible: z.boolean(),
});

const uploadLogoSchema = z.strictObject({
  filename: z.string().min(1).max(255),
  data: z.string().min(1),
});

const updateStreamSchema = z.strictObject({
  location: z.string().min(1).max(2048).optional(),
  protocol: z.enum(['hls', 'dash', 'file', 'flv', 'http']).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
});

const addStreamSchema = z.strictObject({
  location: z.string().min(1).max(2048),
  protocol: z.enum(['hls', 'dash', 'file', 'flv', 'http']).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
});

@Controller('settings')
export class SettingsSourcesController {
  // 显式 @Inject 令牌:不依赖 emitDecoratorMetadata(契约测试经 vitest/esbuild 转译,无该元数据);
  // 007-T021 起注入发布令牌(useExisting 别名,与原类 provider 同一实例)
  constructor(
    @Inject(REFRESH_EXECUTOR_PORT) private readonly refreshExecutor: IRefreshExecutorService,
    // 010 T031:vod 连通性测试探测端口(组合根绑定平台 SafeUpstream 实现;结构兼容直传)
    @Inject(SAFE_UPSTREAM_PORT) private readonly safeUpstream: SafeUpstreamPort,
  ) {}

  /** GET /settings/sources:分页脱敏概览(Settings 边界) */
  @Get('sources')
  @UseGuards(SessionGuard, SettingsGuard)
  list(@Query() query: unknown, @CurrentSession() context: SessionContext): SourcePageDto {
    return listSources(context, parseBody(listSourcesQuerySchema, query));
  }

  /** POST /settings/sources:创建(目标许可;013 起免当次密码;201 SourceDto) */
  @Post('sources')
  @HttpCode(201)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
  async create(
    @Body(new StrictBodyPipe(createSourceRequestSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<SourceDto> {
    return createSource(context, parseBody(createSourceRequestSchema, body));
  }

  /** PATCH /settings/sources/{sourceId}:部分更新(expectedVersion CAS;013 起免当次密码) */
  @Patch('sources/:sourceId')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
  async patchSource(
    @Param('sourceId') sourceId: string,
    @Body(new StrictBodyPipe(patchSourceRequestSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<SourceDto> {
    return updateSource(sourceId, context, parseBody(patchSourceRequestSchema, body));
  }

  /**
   * POST /settings/sources/{sourceId}/test:vod 连通性/兼容性测试(010 T026;
   * 013 起免当次密码,请求体为空对象;200 SourceTestResult,零媒体写入)。
   * 探测实现 = 组合根绑定的平台 SafeUpstream(有界读取,许可=LAN_ALLOWED_TARGETS);
   * 成功响应 Content-Type 沿 problem+json 形态(010 契约 e2e 断言面)。
   */
  @Post('sources/:sourceId/test')
  @HttpCode(200)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
  async testSource(
    @Param('sourceId') sourceId: string,
    @Body(new StrictBodyPipe(sourceTestRequestSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SourceTestResultDto> {
    res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    parseBody(sourceTestRequestSchema, body);
    return testSource(sourceId, context, this.safeUpstream);
  }

  /**
   * POST /settings/sources/{sourceId}/refresh:发起刷新(幂等 operationKey;013 起免当次密码);
   * 202 + Location=/api/settings/refreshes/{id},不等待网络导入结束。
   */
  @Post('sources/:sourceId/refresh')
  @HttpCode(202)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
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
  @UseGuards(SessionGuard, SettingsGuard)
  listRoots(): RootDto[] {
    return listSourceRoots();
  }

  /** GET /settings/refreshes/{refreshId}:任务概览(同家庭;未知/跨家庭 404 同形) */
  @Get('refreshes/:refreshId')
  @UseGuards(SessionGuard, SettingsGuard)
  getRefresh(@Param('refreshId') refreshId: string, @CurrentSession() context: SessionContext): RefreshDto {
    return getSourceRefresh(this.refreshExecutor, context, refreshId);
  }

  /** POST /settings/refreshes/{refreshId}/confirm:确认待确认快照(expectedVersion CAS;013 起免当次密码;200 终态) */
  @Post('refreshes/:refreshId/confirm')
  @HttpCode(200)
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
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
  @UseGuards(SameOriginGuard, SessionGuard, SettingsGuard)
  async discard(
    @Param('refreshId') refreshId: string,
    @Body(new StrictBodyPipe(jobActionSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<RefreshDto> {
    return discardSourceRefresh(this.refreshExecutor, context, refreshId, parseBody(jobActionSchema, body));
  }
}

/**
 * 目录候选与人工修正契约路由(T128;继承 003 /catalog/candidates/query、/catalog/media/{id};
 * 013/ADR-0017:候选查询与人工修正属常规运维,免当次密码):
 * 与 sources 控制器同一守卫链;域核心 catalog-admin.service(归属/CAS/
 * catalogRevision 递增)语义零改动。
 */
@Controller('settings/catalog')
@UseGuards(SessionGuard, SettingsGuard)
export class SettingsCatalogController {
  /** POST /settings/catalog/candidates/query:候选分页(绕过观看策略,限本家庭;013 起免当次密码) */
  @Post('candidates/query')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async queryCandidates(
    @Body(new StrictBodyPipe(candidateQuerySchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<CandidatePageDto> {
    return queryCandidates(context, parseBody(candidateQuerySchema, body));
  }

  /** PATCH /settings/catalog/media/{mediaId}:人工修正(expectedVersion CAS;013 起免当次密码) */
  @Patch('media/:mediaId')
  @UseGuards(SameOriginGuard)
  async patchMedia(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(patchMediaRequestSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<MediaDto> {
    return patchMediaMetadata(mediaId, context, parseBody(patchMediaRequestSchema, body));
  }

  /** POST /settings/catalog/media/batch-visibility:批量修改频道显隐状态 */
  @Post('media/batch-visibility')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async batchVisibility(
    @Body(new StrictBodyPipe(batchVisibilitySchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<{ updatedCount: number }> {
    return batchUpdateMediaVisibility(context, parseBody(batchVisibilitySchema, body));
  }

  /** POST /settings/catalog/upload-logo:上传自定义台标 */
  @Post('upload-logo')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async uploadLogo(
    @Body(new StrictBodyPipe(uploadLogoSchema)) body: unknown,
  ): Promise<{ url: string; filename: string }> {
    const input = parseBody(uploadLogoSchema, body);
    const rawData = input.data.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
    const buffer = Buffer.from(rawData, 'base64');
    if (buffer.byteLength > 5 * 1024 * 1024) {
      throw new Error('上传的台标图片大小不能超过 5MB');
    }
    const extMatch = path.extname(input.filename).toLowerCase();
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'].includes(extMatch) ? extMatch : '.png';
    const filename = `${randomUUID()}${safeExt}`;
    const uploadDir = path.resolve(env.DATA_DIR, 'uploads', 'logos');
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.writeFileSync(path.join(uploadDir, filename), buffer);
    return {
      url: `/api/public/media/custom-logos/${filename}`,
      filename,
    };
  }

  /** GET /settings/catalog/media/:mediaId/streams: 获取频道的所有播放线路 */
  @Get('media/:mediaId/streams')
  async listStreams(
    @Param('mediaId') mediaId: string,
    @CurrentSession() context: SessionContext,
  ): Promise<{ items: ChannelStreamDto[] }> {
    const items = listMediaStreams(context.session.householdId, mediaId);
    return { items };
  }

  /** POST /settings/catalog/media/:mediaId/streams: 为频道新增一条直播源线路 */
  @Post('media/:mediaId/streams')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async addStream(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(addStreamSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<ChannelStreamDto> {
    return addMediaStream(context.session.householdId, mediaId, parseBody(addStreamSchema, body));
  }

  /** PATCH /settings/catalog/media/:mediaId/streams/:streamId: 修改指定播放线路 URL/协议/优先级 */
  @Patch('media/:mediaId/streams/:streamId')
  @UseGuards(SameOriginGuard)
  async updateStream(
    @Param('mediaId') mediaId: string,
    @Param('streamId') streamId: string,
    @Body(new StrictBodyPipe(updateStreamSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<ChannelStreamDto> {
    return updateMediaStream(context.session.householdId, mediaId, streamId, parseBody(updateStreamSchema, body));
  }

  /** DELETE /settings/catalog/media/:mediaId/streams/:streamId: 删除指定播放线路 */
  @Delete('media/:mediaId/streams/:streamId')
  @UseGuards(SameOriginGuard)
  async deleteStream(
    @Param('mediaId') mediaId: string,
    @Param('streamId') streamId: string,
    @CurrentSession() context: SessionContext,
  ): Promise<{ success: boolean }> {
    deleteMediaStream(context.session.householdId, mediaId, streamId);
    return { success: true };
  }
}
