import { Body, Controller, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ProblemCode, type CandidatePageDto, type MediaDto } from '@hmp/shared';
import { CurrentSession, type SessionContext } from '../../common/current-session.decorator';
import { SessionGuard } from '../../common/session.guard';
import { DomainError } from '../../common/domain-error';
import { parseBody } from '../auth/validation';
import { replacePolicyLists, type PolicyDtoBody } from '../policy/policy.service';
import { patchMediaMetadata, queryCandidates } from './catalog-admin.service';

/**
 * 家长候选与人工修正契约路由(T050;003 contracts/openapi.yaml
 * /catalog/candidates/query、/catalog/media/{mediaId}):
 * - 判定次序:SessionGuard(401)→ owner(403,先于格式校验)→ 严格 zod(400,未知字段拒绝)→
 *   服务层家长验证(缺失/空串 403 REQUIRED)→ 家庭边界(404 同形)→ 版本(409)→ 事务;
 * - 密码经 POST/PATCH body 提交,绝不出现在 URL/日志/长期缓存;
 * - 独立控制器:与 catalog.controller.ts(观看目录,另一任务在扩展 programmes 路由)互不触碰。
 */

/** 契约 CandidateQuery(components/schemas/CandidateQuery;strictObject 拒绝未知字段) */
const candidateQuerySchema = z.strictObject({
  ownerPassword: z.string().optional(),
  q: z.string().max(100).optional(),
  type: z.enum(['channel', 'movie', 'series', 'episode', 'video']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});

/** 契约 PatchMedia(components/schemas/PatchMedia;title/type/contentLevel 至少一项) */
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

function requireOwner(context: SessionContext): void {
  if (context.account.role !== 'owner') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以管理媒体候选与人工修正');
  }
}

@Controller('catalog')
@UseGuards(SessionGuard)
export class CatalogAdminController {
  /** POST /catalog/candidates/query:owner 候选分页(绕过观看策略,限本家庭,含 unavailable) */
  @Post('candidates/query')
  @HttpCode(200)
  async query(@Body() body: unknown, @CurrentSession() context: SessionContext): Promise<CandidatePageDto> {
    requireOwner(context);
    return queryCandidates(context, parseBody(candidateQuerySchema, body));
  }

  /** PATCH /catalog/media/{mediaId}:人工修正(同事务 version+1 与 catalogRevision+1) */
  @Patch('media/:mediaId')
  async patchMedia(
    @Param('mediaId') mediaId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<MediaDto> {
    requireOwner(context);
    return patchMediaMetadata(mediaId, context, parseBody(patchMediaRequestSchema, body));
  }
}

/**
 * PUT /profiles/{profileId}/policy/lists(T049/T051 契约路由;T063 过渡托管):
 * ⚠️ tasks.md T063 计划把该路由注册进 policy.controller.ts;该文件不在本任务可写范围,
 * 为使契约测试先行全绿,暂托管于本文件。T063 落地时应把本控制器迁回 policy.controller.ts
 * 并删除此处,避免重复路由(service 入口 replacePolicyLists 无需变动)。
 */

/** 契约 UpdateLists(components/schemas/UpdateLists;三名单必填;去重后 ≤1000 与归属/类型校验在服务层) */
const updateListsRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().min(1),
  allowedMediaIds: z.array(z.string().min(1).max(128)),
  blockedMediaIds: z.array(z.string().min(1).max(128)),
  allowedChannelIds: z.array(z.string().min(1).max(128)),
});

function requireOwnerForLists(context: SessionContext): void {
  if (context.account.role !== 'owner') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以管理策略名单');
  }
}

@Controller('profiles/:profileId/policy')
@UseGuards(SessionGuard)
export class PolicyListsController {
  /** PUT /profiles/{profileId}/policy/lists:三名单整体替换(owner + 家长验证 + 版本/归属/类型事务) */
  @Put('lists')
  async replaceLists(
    @Param('profileId') profileId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<PolicyDtoBody> {
    requireOwnerForLists(context);
    return replacePolicyLists(profileId, context, parseBody(updateListsRequestSchema, body));
  }
}
