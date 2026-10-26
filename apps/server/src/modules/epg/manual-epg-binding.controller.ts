import { Body, Controller, HttpCode, Param, Post, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  ProblemCode,
  type EpgBindingDto,
  type EpgBindingQueryRequest,
  type EpgCandidatePageDto,
  type EpgCandidateQueryRequest,
  type ProgrammeDto,
  type UpdateEpgBindingRequest,
} from '@hmp/shared';
import { CurrentSession, type SessionContext } from '../../common/current-session.decorator';
import { SessionGuard } from '../../common/session.guard';
import { DomainError, createDomainError } from '../../common/domain-error';
import { Database } from '../../database/database';
import { deviceSession, epgChannel, epgProgramme, mediaItem, mediaSource } from '../../database/schema';
import { getDb } from '../auth/db';
import { verifyParentPassword } from '../auth/parent-verification.service';
import { parseBody } from '../auth/validation';
import { getBindingState, saveBinding, unbindBinding, type ManualEpgBindingState } from './manual-epg-binding.service';

/**
 * 手动 EPG 绑定管理契约路由(T071;US5/ADR-0008,003 contracts/openapi.yaml
 * /catalog/media/{mediaId}/epg-binding|epg-candidates):
 * - 判定次序与来源管理一致:SessionGuard(401)→ owner(403)→ 严格 zod(400,未知字段拒绝)→
 *   家长验证(缺失/空串统一 403 PARENT_VERIFICATION_REQUIRED;错误 403 FAILED / 5 次锁定 423 LOCKED,
 *   账号级共享计数)→ 验证后重验会话行(已撤销/过期 401 SESSION_INVALID)→ 媒体归属 →
 *   服务层语义(saveBinding/unbindBinding 抛出的 DomainError 原样映射:404 同形/400/422/409);
 * - 管理读取(两个 query 端点)同样要求 owner+当次密码:绑定行可能携带目标信息,
 *   无行/墓碑/失效绑定均可读取(invalid 是读取状态,不是管理 GET 失败);
 * - 成功响应统一 Cache-Control: no-store(管理数据不缓存);响应只含契约字段白名单,
 *   不含源位置/凭据/候选原始标识以外的信息;跨家庭/不存在统一 404 NOT_FOUND 同形。
 */

/* ------------------------------------------------------------------ */
/* 请求 schema(对照 openapi components/schemas;strictObject 未知键拒绝) */
/* ------------------------------------------------------------------ */

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
    // epgSourceId 请求期只做非空形态检查:来源归属/存在性在服务层统一 404 同形判定,
    // 不在 400 层拒绝(契约夹具与既有目录一样使用任意稳定字符串标识,非 UUID 字面量)
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

/* ------------------------------------------------------------------ */
/* 验证与共享辅助                                                       */
/* ------------------------------------------------------------------ */

function requireOwner(context: SessionContext): void {
  if (context.account.role !== 'owner') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以管理手动 EPG 绑定');
  }
}

/**
 * 家长验证 + 会话/设备重验(与 sources.service requireParentVerification 同链):
 * 密码缺失/空串统一 403 PARENT_VERIFICATION_REQUIRED,非空密码交由 verifyParentPassword
 * (403 FAILED / 423 LOCKED);验证通过后重读会话行,已撤销/已过期 401 SESSION_INVALID。
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
    // 不存在与跨家庭同形,不泄漏归属(与 catalog/sources 一致)
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  if (media.type !== 'channel') {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '仅频道条目支持手动 EPG 管理');
  }
}

/**
 * 服务层状态 → 契约 EpgBinding(components/schemas/EpgBinding):
 * mode='none'(无行)映射为契约 mode='auto',version=0(manual-epg-binding.service 注释);
 * auto 墓碑保留 version、目标两列 null;manual 派生 valid/invalidReason;updatedAt 不出契约。
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

/* ------------------------------------------------------------------ */
/* 候选查询(同家庭指定 EPG 来源;ADR-0008「可选同家庭任一已启用成功导入的 EPG」) */
/* ------------------------------------------------------------------ */

interface CandidateRow {
  xmltvChannelId: string;
  displayName: string;
}

function toProgrammeDto(row: Pick<typeof epgProgramme.$inferSelect, 'title' | 'description' | 'startsAt' | 'endsAt'>): ProgrammeDto {
  return { title: row.title, description: row.description, startsAt: row.startsAt, endsAt: row.endsAt };
}

/** 窗口判定与 epg.service 同语义:current 起点 含/终点 不含,next 为未来最早一条(与 current 互斥) */
function programmeWindowOf(rows: typeof epgProgramme.$inferSelect[]): { current: ProgrammeDto | null; next: ProgrammeDto | null } {
  const now = Date.now();
  let current: ProgrammeDto | null = null;
  let next: ProgrammeDto | null = null;
  for (const row of rows) {
    const startsAtMs = Date.parse(row.startsAt);
    const endsAtMs = Date.parse(row.endsAt);
    if (current === null && startsAtMs <= now && now < endsAtMs) {
      current = toProgrammeDto(row);
      continue;
    }
    if (next === null && startsAtMs > now) {
      next = toProgrammeDto(row);
      break; // startsAt 升序:首个未来开始即最早 next
    }
  }
  return { current, next };
}

/**
 * 候选分页查询:同家庭指定来源(404 同形)→ kind=epg 且启用且已成功导入
 * (否则 422 EPG_SOURCE_NOT_READY;api.md「候选来源未启用/从未成功导入」)→
 * 非 conflicted 频道 → q 对 xmltv_channel_id/display_name 大小写不敏感子串过滤 →
 * 排序=当前/未来有节目优先,同组内 xmltv_channel_id 升序稳定分页;仅当页频道查节目窗口;epgGeneration=来源当前值,
 * 保存须回传该值(不等 → 409 EPG_CANDIDATE_STALE)。候选不含源地址/路径/凭据。
 */
export function listEpgCandidates(householdId: string, input: EpgCandidateQueryRequest): EpgCandidatePageDto {
  const source = getDb()
    .select()
    .from(mediaSource)
    .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.id, input.epgSourceId)))
    .get();
  if (source === undefined) {
    // 不存在/跨家庭来源统一 404 同形,不泄漏归属
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
  if (source.kind !== 'epg' || source.enabled !== 1 || source.lastSuccessAt === null) {
    throw createDomainError('EPG_SOURCE_NOT_READY');
  }
  const channels = getDb()
    .select({ xmltvChannelId: epgChannel.xmltvChannelId, displayName: epgChannel.displayName })
    .from(epgChannel)
    .where(and(eq(epgChannel.householdId, householdId), eq(epgChannel.sourceId, input.epgSourceId), eq(epgChannel.conflicted, 0)))
    .orderBy(epgChannel.xmltvChannelId)
    .all();
  // 大小写不敏感子串(SQLite LIKE 仅 ASCII 不敏感,这里在 JS 侧统一 Unicode 语义)
  const needle = input.q?.trim().toLowerCase() ?? '';
  const filtered: CandidateRow[] =
    needle === ''
      ? channels
      : channels.filter(
          (channel) => channel.xmltvChannelId.toLowerCase().includes(needle) || channel.displayName.toLowerCase().includes(needle),
        );
  // 排序优化(US5 反馈):当前/未来有节目的候选排前面,便于家长挑「绑了就有节目」的目标;
  // 无节目数据(窗口内 ends_at 全部过期或无记录)的排后面——绑定仍允许,目标可能稍后有数据。
  const nowIso = new Date().toISOString();
  const liveRows = getDb()
    .selectDistinct({ xmltvChannelId: epgProgramme.xmltvChannelId })
    .from(epgProgramme)
    .where(
      and(
        eq(epgProgramme.householdId, householdId),
        eq(epgProgramme.sourceId, input.epgSourceId),
        gt(epgProgramme.endsAt, nowIso),
      ),
    )
    .all();
  const hasLive = new Set(liveRows.map((row) => row.xmltvChannelId));
  filtered.sort((a, b) => {
    const aLive = hasLive.has(a.xmltvChannelId) ? 1 : 0;
    const bLive = hasLive.has(b.xmltvChannelId) ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    return a.xmltvChannelId < b.xmltvChannelId ? -1 : a.xmltvChannelId > b.xmltvChannelId ? 1 : 0;
  });
  const start = (input.page - 1) * input.pageSize;
  const pageItems = filtered.slice(start, start + input.pageSize);
  const pageIds = pageItems.map((item) => item.xmltvChannelId);
  const programmeRows =
    pageIds.length === 0
      ? []
      : getDb()
          .select()
          .from(epgProgramme)
          .where(
            and(
              eq(epgProgramme.householdId, householdId),
              eq(epgProgramme.sourceId, input.epgSourceId),
              inArray(epgProgramme.xmltvChannelId, pageIds),
            ),
          )
          .orderBy(epgProgramme.xmltvChannelId, epgProgramme.startsAt)
          .all();
  const rowsByChannel = new Map<string, typeof epgProgramme.$inferSelect[]>();
  for (const row of programmeRows) {
    const bucket = rowsByChannel.get(row.xmltvChannelId);
    if (bucket === undefined) {
      rowsByChannel.set(row.xmltvChannelId, [row]);
    } else {
      bucket.push(row);
    }
  }
  return {
    items: pageItems.map((item) => ({ ...item, ...programmeWindowOf(rowsByChannel.get(item.xmltvChannelId) ?? []) })),
    total: filtered.length,
    page: input.page,
    pageSize: input.pageSize,
    epgGeneration: source.epgGeneration,
  };
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

@Controller('catalog/media')
@UseGuards(SessionGuard)
export class ManualEpgBindingController {
  /** POST /catalog/media/{mediaId}/epg-binding/query:当前绑定状态 + no-store(invalid 仍 200 可读) */
  @Post(':mediaId/epg-binding/query')
  @HttpCode(200)
  async queryBinding(
    @Param('mediaId') mediaId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<EpgBindingDto> {
    requireOwner(context);
    const input = parseBody(bindingQuerySchema, body) satisfies EpgBindingQueryRequest;
    await requireParentVerification(context, input.ownerPassword);
    requireChannelOfHousehold(context.session.householdId, mediaId);
    const state = getBindingState(Database.db, { householdId: context.session.householdId, mediaId });
    res.setHeader('Cache-Control', 'no-store');
    return toEpgBindingDto(state);
  }

  /** POST /catalog/media/{mediaId}/epg-candidates/query:指定来源候选分页 + no-store */
  @Post(':mediaId/epg-candidates/query')
  @HttpCode(200)
  async queryCandidates(
    @Param('mediaId') mediaId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<EpgCandidatePageDto> {
    requireOwner(context);
    const input = parseBody(epgCandidateQuerySchema, body) satisfies EpgCandidateQueryRequest;
    await requireParentVerification(context, input.ownerPassword);
    requireChannelOfHousehold(context.session.householdId, mediaId);
    const page = listEpgCandidates(context.session.householdId, input);
    res.setHeader('Cache-Control', 'no-store');
    return page;
  }

  /**
   * PUT /catalog/media/{mediaId}/epg-binding:manual 保存(manual 锁定)/auto 解除(auto 墓碑)。
   * 会话/账号由服务层事务前重验;媒体/目标/候选 generation/expectedVersion 校验与
   * DomainError 映射(404 同形/400/422/409)全部沿用 manual-epg-binding.service。
   */
  @Put(':mediaId/epg-binding')
  async updateBinding(
    @Param('mediaId') mediaId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<EpgBindingDto> {
    requireOwner(context);
    const input = parseBody(updateEpgBindingSchema, body) satisfies UpdateEpgBindingRequest;
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
