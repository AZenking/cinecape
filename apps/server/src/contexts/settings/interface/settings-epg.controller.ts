import { Body, Controller, HttpCode, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ProblemCode,
  type EpgBindingDto,
  type EpgCandidatePageDto,
} from '@hmp/shared';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsAccessGuard } from '@platform/http-common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { deviceSession, mediaItem } from '@platform/database/schema';
import { Database } from '@platform/database/database';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { verifyParentPassword } from '@contexts/identity-access/application/parent-verification.service';
import { parseBody } from '@contexts/identity-access/interface/validation';
import {
  getBindingState,
  listEpgCandidates,
  saveBinding,
  unbindBinding,
  type ManualEpgBindingState,
} from '@contexts/epg/application/manual-epg-binding.service';

/**
 * 节目单管理契约路由(T129,005 contracts/api.md §6「epg-binding 三组」;FR-038):
 * - POST /settings/catalog/media/{mediaId}/epg-binding/query:当前绑定状态
 *   (当次密码;invalid 是读取状态,不是管理失败);
 * - POST /settings/catalog/media/{mediaId}/epg-candidates/query:指定 EPG 来源候选分页
 *   (当次密码);
 * - PUT /settings/catalog/media/{mediaId}/epg-binding:逐频道手动匹配与解除
 *   (当次密码 + expectedVersion;manual 失效不自动回退)。
 * 复用 modules/epg 域核心(manual-epg-binding.service)只读 import:匹配/解除语义、
 * manual 失效派生与 catalog revision 递增全部沿用;不引入定时同步、模糊匹配或批量匹配;
 * 旧 /catalog/media 管理入口随本次迁移删除(epg.module.ts 不再注册旧控制器)。
 */

/** 契约 BindingQuery */
const bindingQuerySchema = z.strictObject({
  ownerPassword: z.string().optional(),
});

/** 契约 EpgCandidateQuery:epgSourceId 必填(指定候选来源,q 搜索/page 分页可选) */
const epgCandidateQuerySchema = z.strictObject({
  ownerPassword: z.string().optional(),
  epgSourceId: z.string().min(1),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** 契约 UpdateEpgBinding(manual 必带目标三元组,auto 解除禁带目标字段 —— allOf if/then) */
const updateEpgBindingSchema = z
  .strictObject({
    ownerPassword: z.string().optional(),
    expectedVersion: z.number().int().min(0),
    mode: z.enum(['manual', 'auto']),
    // epgSourceId 请求期只做非空形态检查:来源归属/存在性在服务层统一 404 同形判定
    epgSourceId: z.string().min(1).optional(),
    xmltvChannelId: z.string().min(1).max(255).optional(),
    expectedEpgGeneration: z.number().int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    const reject = (field: string, message: string): void => {
      ctx.addIssue({ code: 'custom', message, path: [field] });
    };
    if (value.mode === 'manual') {
      if (value.epgSourceId === undefined) {
        reject('epgSourceId', 'manual 绑定必须提供 epgSourceId');
      }
      if (value.xmltvChannelId === undefined) {
        reject('xmltvChannelId', 'manual 绑定必须提供 xmltvChannelId');
      }
      if (value.expectedEpgGeneration === undefined) {
        reject('expectedEpgGeneration', 'manual 绑定必须提供 expectedEpgGeneration');
      }
      return;
    }
    if (value.epgSourceId !== undefined) {
      reject('epgSourceId', 'auto 解除不能携带 epgSourceId');
    }
    if (value.xmltvChannelId !== undefined) {
      reject('xmltvChannelId', 'auto 解除不能携带 xmltvChannelId');
    }
    if (value.expectedEpgGeneration !== undefined) {
      reject('expectedEpgGeneration', 'auto 解除不能携带 expectedEpgGeneration');
    }
  });

/**
 * 当次密码验证(缺失/空串统一 403 REQUIRED;错误 403 FAILED / 5 次锁定 423 LOCKED,
 * 账号级共享计数)+ 验证后重验会话行(已撤销/过期 401 SESSION_INVALID)。
 */
async function requireParentVerification(context: SessionContext, ownerPassword?: string): Promise<void> {
  if (ownerPassword === undefined || ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, ownerPassword);
  const sessionRow = getDb().select().from(deviceSession).where(eq(deviceSession.id, context.session.id)).get();
  if (sessionRow === undefined || sessionRow.revokedAt !== null || !(Date.parse(sessionRow.expiresAt) > Date.now())) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
}

/** 媒体归属与类型(管理查询前置):不存在/跨家庭统一 404 同形;非频道 400 */
function requireChannelOfHousehold(householdId: string, mediaId: string): void {
  const media = getDb()
    .select({ type: mediaItem.type })
    .from(mediaItem)
    .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
    .get();
  if (media === undefined) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  if (media.type !== 'channel') {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '仅频道条目支持手动 EPG 管理');
  }
}

/**
 * 服务层状态 → 契约 EpgBinding(components/schemas/EpgBinding):
 * mode='none'(无行)映射为契约 mode='auto',version=0;auto 墓碑保留 version、目标两列
 * null;manual 派生 valid/invalidReason;updatedAt 不出契约。
 */
function toEpgBindingDto(state: ManualEpgBindingState): EpgBindingDto {
  const manual = state.mode === 'manual';
  return {
    mediaId: state.mediaId,
    mode: manual ? 'manual' : 'auto',
    version: state.version,
    epgSourceId: state.epgSourceId,
    xmltvChannelId: state.xmltvChannelId,
    status: manual ? (state.valid ? 'valid' : 'invalid') : 'auto',
    invalidReason: manual ? state.invalidReason : null,
  };
}

@Controller('settings/catalog/media')
@UseGuards(SessionGuard, SettingsAccessGuard)
export class SettingsEpgBindingController {
  /** POST .../epg-binding/query:当前绑定状态 + no-store(invalid 仍 200 可读) */
  @Post(':mediaId/epg-binding/query')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async queryBinding(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(bindingQuerySchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<EpgBindingDto> {
    const input = parseBody(bindingQuerySchema, body);
    await requireParentVerification(context, input.ownerPassword);
    requireChannelOfHousehold(context.session.householdId, mediaId);
    const state = getBindingState(Database.db, { householdId: context.session.householdId, mediaId });
    res.setHeader('Cache-Control', 'no-store');
    return toEpgBindingDto(state);
  }

  /** POST .../epg-candidates/query:指定来源候选分页 + no-store */
  @Post(':mediaId/epg-candidates/query')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async queryCandidates(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(epgCandidateQuerySchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<EpgCandidatePageDto> {
    const input = parseBody(epgCandidateQuerySchema, body);
    await requireParentVerification(context, input.ownerPassword);
    requireChannelOfHousehold(context.session.householdId, mediaId);
    const page = listEpgCandidates(context.session.householdId, input);
    res.setHeader('Cache-Control', 'no-store');
    return page;
  }

  /**
   * PUT .../epg-binding:manual 保存(manual 锁定)/ auto 解除(auto 墓碑)。
   * 会话/账号由服务层事务前重验;媒体/目标/候选 generation/expectedVersion 校验与
   * DomainError 映射(404 同形/400/422/409)全部沿用 manual-epg-binding.service。
   */
  @Put(':mediaId/epg-binding')
  @UseGuards(SameOriginGuard)
  async updateBinding(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(updateEpgBindingSchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<EpgBindingDto> {
    const input = parseBody(updateEpgBindingSchema, body);
    await requireParentVerification(context, input.ownerPassword);
    const householdId = context.session.householdId;
    const writer = { accountId: context.session.accountId, sessionId: context.session.id };
    let state: ManualEpgBindingState;
    if (input.mode === 'manual') {
      // superRefine 已保证三元组存在;运行时守卫仅为满足 strict 收窄,不可达
      if (input.epgSourceId === undefined || input.xmltvChannelId === undefined || input.expectedEpgGeneration === undefined) {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'manual 绑定必须提供目标来源/频道/候选 generation');
      }
      state = saveBinding(Database.db, {
        householdId,
        mediaId,
        epgSourceId: input.epgSourceId,
        xmltvChannelId: input.xmltvChannelId,
        expectedVersion: input.expectedVersion,
        candidateEpgGeneration: input.expectedEpgGeneration,
        ...writer,
      });
    } else {
      state = unbindBinding(Database.db, { householdId, mediaId, expectedVersion: input.expectedVersion, ...writer });
    }
    res.setHeader('Cache-Control', 'no-store');
    return toEpgBindingDto(state);
  }
}
