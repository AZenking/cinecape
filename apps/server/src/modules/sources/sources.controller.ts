import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  ProblemCode,
  type RefreshDto,
  type RootDto,
  type SourceDto,
  type SourcePageDto,
} from '@hmp/shared';
import { CurrentSession, type SessionContext } from '../../common/current-session.decorator';
import { SessionGuard } from '../../common/session.guard';
import { DomainError } from '../../common/domain-error';
import { parseBody } from '../auth/validation';
import { RefreshExecutorService } from '../imports/refresh-executor.service';
import {
  confirmSourceRefresh,
  createSource,
  discardSourceRefresh,
  getSourceRefresh,
  listSourceRoots,
  listSources,
  requestSourceRefresh,
  updateSource,
} from './sources.service';
import { isParsableRemoteUrl } from './source-target.validation';

/**
 * 来源管理契约路由(T020;003 contracts/openapi.yaml /sources、/source-roots):
 * - 判定次序:SessionGuard(401)→ owner(403)→ 严格 zod(400,未知字段拒绝)→
 *   家长验证等服务层语义(sources.service);
 * - remoteUrl 请求期只做「绝对 URL + 主机语法」形态检查(400);协议与 IP 字面类别等
 *   目标许可判断(422 SOURCE_TARGET_DENIED)在服务层完成,主机名 DNS 级校验留待刷新期读取器;
 * - kind/NAS 根不可变:PATCH 请求体携带 kind/rootKey/relativeDirectory 一律未知键拒绝(400)。
 */

/** 远程地址形态(400 层);许可判断(422)见 source-target.validation.findRemoteTargetDenial */
const remoteUrlSyntaxSchema = z
  .string()
  .min(1)
  .refine(isParsableRemoteUrl, { message: 'remoteUrl 必须是带合法主机的绝对 URL' });

/** 契约 CreateSource(components/schemas/CreateSource;strictObject + superRefine 表达 allOf 跨字段规则) */
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
    epgSourceId: z.union([z.uuid(), z.null()]).optional(),
  })
  .superRefine((value, ctx) => {
    const reject = (field: string, message: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [field] });
    };
    if (value.kind === 'nas') {
      // NAS:必须 rootKey+relativeDirectory,禁 remoteUrl/epgSourceId
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
    // IPTV/EPG:必须 remoteUrl,禁 rootKey/relativeDirectory;epgSourceId 仅 IPTV
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

/** 契约 PatchSource(components/schemas/PatchSource;省略字段保留原值,由服务层合并) */
const patchSourceRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  remoteUrl: remoteUrlSyntaxSchema.optional(),
  privateAccessApproved: z.boolean().optional(),
  epgSourceId: z.union([z.uuid(), z.null()]).optional(),
});

/** GET /sources 分页查询:page/pageSize 默认 1/20,pageSize ≤100;未知查询键拒绝 */
const listSourcesQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** 契约 RefreshRequest(components/schemas/RefreshRequest;operationKey 为幂等键,必须为 UUID) */
const refreshRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
  operationKey: z.uuid(),
});

/** 契约 JobAction(components/schemas/JobAction;expectedVersion 为任务当前 version) */
const jobActionSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
});

function requireOwner(context: SessionContext): void {
  if (context.account.role !== 'owner') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以管理媒体来源');
  }
}

@Controller('sources')
@UseGuards(SessionGuard)
export class SourcesController {
  // 显式 @Inject 令牌:不依赖 emitDecoratorMetadata(契约测试经 vitest/esbuild 转译,无该元数据)
  constructor(@Inject(RefreshExecutorService) private readonly refreshExecutor: RefreshExecutorService) {}

  /** GET /sources:分页脱敏概览(owner) */
  @Get()
  list(@Query() query: unknown, @CurrentSession() context: SessionContext): SourcePageDto {
    requireOwner(context);
    return listSources(context, parseBody(listSourcesQuerySchema, query));
  }

  /** POST /sources:创建(owner + 家长验证 + 目标许可;201 SourceDto,version=1) */
  @Post()
  async create(@Body() body: unknown, @CurrentSession() context: SessionContext): Promise<SourceDto> {
    requireOwner(context);
    return createSource(context, parseBody(createSourceRequestSchema, body));
  }

  /** PATCH /sources/{sourceId}:部分更新(ownerPassword + expectedVersion 乐观锁) */
  @Patch(':sourceId')
  async update(
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<SourceDto> {
    requireOwner(context);
    return updateSource(sourceId, context, parseBody(patchSourceRequestSchema, body));
  }

  /**
   * POST /sources/{sourceId}/refresh(T028):发起刷新(owner + 当次密码,家长验证次序与
   * 来源管理一致);202 + Location=/api/refreshes/{id},不等待网络导入结束。
   */
  @Post(':sourceId/refresh')
  @HttpCode(202)
  async refresh(
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<RefreshDto> {
    requireOwner(context);
    const dto = await requestSourceRefresh(
      this.refreshExecutor,
      context,
      sourceId,
      parseBody(refreshRequestSchema, body),
    );
    res.setHeader('Location', `/api/refreshes/${dto.id}`);
    return dto;
  }
}

/**
 * 刷新任务契约路由(T028;003 contracts/openapi.yaml /refreshes/*):
 * - 判定次序与来源管理一致:SessionGuard(401)→ owner(403)→ 严格 zod(400,未知字段拒绝)→
 *   家长验证(缺失/空串统一 403 REQUIRED)→ 服务层(执行器:404 同形/409/422/429);
 * - GET 懒执行 expireStaleConfirmations,使超时任务以 expired 终态可见;
 * - RefreshDto 仅含契约字段,不携带 householdId/源内容/原始条目/地址/原始解析错误。
 */
@Controller('refreshes')
@UseGuards(SessionGuard)
export class RefreshesController {
  // 同 SourcesController:显式 @Inject 令牌,兼容无 emitDecoratorMetadata 的测试运行时
  constructor(@Inject(RefreshExecutorService) private readonly refreshExecutor: RefreshExecutorService) {}

  /** GET /refreshes/{refreshId}:任务概览(owner;同家庭;未知/跨家庭 404 同形) */
  @Get(':refreshId')
  get(@Param('refreshId') refreshId: string, @CurrentSession() context: SessionContext): RefreshDto {
    requireOwner(context);
    return getSourceRefresh(this.refreshExecutor, context, refreshId);
  }

  /** POST /refreshes/{refreshId}/confirm:确认待确认快照(ownerPassword+expectedVersion;200 终态 succeeded) */
  @Post(':refreshId/confirm')
  @HttpCode(200)
  async confirm(
    @Param('refreshId') refreshId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<RefreshDto> {
    requireOwner(context);
    return confirmSourceRefresh(this.refreshExecutor, context, refreshId, parseBody(jobActionSchema, body));
  }

  /** POST /refreshes/{refreshId}/discard:丢弃待确认快照(ownerPassword+expectedVersion;200 discarded,释放来源锁) */
  @Post(':refreshId/discard')
  @HttpCode(200)
  async discard(
    @Param('refreshId') refreshId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<RefreshDto> {
    requireOwner(context);
    return discardSourceRefresh(this.refreshExecutor, context, refreshId, parseBody(jobActionSchema, body));
  }
}

@Controller('source-roots')
@UseGuards(SessionGuard)
export class SourceRootsController {
  /** GET /source-roots:NAS 根选择列表(owner;仅 rootKey 与展示名,不含绝对路径) */
  @Get()
  list(@CurrentSession() context: SessionContext): RootDto[] {
    requireOwner(context);
    return listSourceRoots();
  }
}
