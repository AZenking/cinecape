import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ProblemCode,
  type EpgBindingDto,
  type EpgCandidatePageDto,
  type EpgSourcePriorityDto,
} from '@hmp/shared';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsGuard } from '@contexts/settings/infrastructure/settings.guard';
import { StrictBodyPipe, StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';
import { catalogState, epgChannel, mediaItem, mediaSource, sourceArchive } from '@platform/database/schema';
import { getDb, parseBody } from '@contexts/identity-access';
// 016 US4 T024:保存后「全量级联匹配刷新」复用 sources 域既有刷新执行器(只读 import
// 发布令牌,不得自建第二套刷新机制;007-T022a 同款发布面裸导入)
import { REFRESH_EXECUTOR_PORT, type IRefreshExecutorService } from '@contexts/sources';
import {
  getBindingState,
  listEpgCandidates,
  saveBinding,
  unbindBinding,
  type ManualEpgBindingState,
} from '@contexts/epg';

/**
 * 节目单管理契约路由(T129,005 contracts/api.md §6「epg-binding 三组」;FR-038;
 * 013-role-differentiated-settings/ADR-0017:频道 EPG 调整属常规运维,免当次主账号密码):
 * - POST /settings/catalog/media/{mediaId}/epg-binding/query:当前绑定状态
 *   (invalid 是读取状态,不是管理失败);
 * - POST /settings/catalog/media/{mediaId}/epg-candidates/query:指定 EPG 来源候选分页;
 * - PUT /settings/catalog/media/{mediaId}/epg-binding:逐频道手动匹配与解除
 *   (expectedVersion CAS;manual 失效不自动回退)。
 * 复用 contexts/epg 域核心(manual-epg-binding.service)只读 import:匹配/解除语义、
 * manual 失效派生与 catalog revision 递增全部沿用;不引入定时同步、模糊匹配或批量匹配;
 * 旧 /catalog/media 管理入口随本次迁移删除(epg.module.ts 不再注册旧控制器)。
 */

/** 契约 BindingQuery(013 起免当次密码 → 空对象,strictObject 拒绝任何字段) */
const bindingQuerySchema = z.strictObject({});

/** 契约 EpgCandidateQuery:epgSourceId 必填(指定候选来源,q 搜索/page 分页可选) */
const epgCandidateQuerySchema = z.strictObject({
  epgSourceId: z.string().min(1),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** 契约 UpdateEpgBinding(manual 必带目标三元组,auto 解除禁带目标字段 —— allOf if/then) */
const updateEpgBindingSchema = z
  .strictObject({
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
 * 013/ADR-0017:原「当次密码验证 + 验证后重验会话行」helper(requireParentVerification)
 * 已摘除 —— EPG 绑定查询/候选/手动匹配均属常规运维;会话有效性由 SessionGuard 逐请求
 * 承担,重验块属验证竞态防线而非业务。高危单次密码仅保留于账号密码/主档案转移/设备撤销。
 */

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
@UseGuards(SessionGuard, SettingsGuard)
export class SettingsEpgBindingController {
  /** POST .../epg-binding/query:当前绑定状态 + no-store(invalid 仍 200 可读;013 起免当次密码) */
  @Post(':mediaId/epg-binding/query')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  async queryBinding(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(bindingQuerySchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<EpgBindingDto> {
    parseBody(bindingQuerySchema, body);
    requireChannelOfHousehold(context.session.householdId, mediaId);
    const state = getBindingState({ householdId: context.session.householdId, mediaId });
    res.setHeader('Cache-Control', 'no-store');
    return toEpgBindingDto(state);
  }

  /** POST .../epg-candidates/query:指定来源候选分页 + no-store(013 起免当次密码) */
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
    requireChannelOfHousehold(context.session.householdId, mediaId);
    const page = listEpgCandidates(context.session.householdId, input);
    res.setHeader('Cache-Control', 'no-store');
    return page;
  }

  /**
   * PUT .../epg-binding:manual 保存(manual 锁定)/ auto 解除(auto 墓碑;013 起免当次密码)。
   * 会话/账号由守卫链承担;媒体/目标/候选 generation/expectedVersion 校验与
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
    const householdId = context.session.householdId;
    const writer = { accountId: context.session.accountId, sessionId: context.session.id };
    let state: ManualEpgBindingState;
    if (input.mode === 'manual') {
      // superRefine 已保证三元组存在;运行时守卫仅为满足 strict 收窄,不可达
      if (input.epgSourceId === undefined || input.xmltvChannelId === undefined || input.expectedEpgGeneration === undefined) {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'manual 绑定必须提供目标来源/频道/候选 generation');
      }
      state = saveBinding({
        householdId,
        mediaId,
        epgSourceId: input.epgSourceId,
        xmltvChannelId: input.xmltvChannelId,
        expectedVersion: input.expectedVersion,
        candidateEpgGeneration: input.expectedEpgGeneration,
        ...writer,
      });
    } else {
      state = unbindBinding({ householdId, mediaId, expectedVersion: input.expectedVersion, ...writer });
    }
    res.setHeader('Cache-Control', 'no-store');
    return toEpgBindingDto(state);
  }
}

/* ------------------------------------------------------------------ */
/* EPG 源优先级(016 api.md §3,US4 T024;ADR-0017 主管理员门禁)          */
/* ------------------------------------------------------------------ */

/**
 * 契约 UpdateEpgSourcePriorities(016 api.md §3.2):批量权重更新;
 * priority 整数 1~999(数值越小越优先,data-model §1.1);strictObject 拒绝未知字段
 * (旧时代当次密码字段携带即 400,与既有运维路由同一 013 口径);重复 sourceId 视为
 * 歧义载荷 400;列表上限 100(单家庭 EPG 源量级的查询预算护栏)。
 */
const epgPriorityEntrySchema = z.strictObject({
  // sourceId 请求期只做非空形态检查:归属/存在性/kind 在保存事务内统一 404 同形判定
  sourceId: z.string().min(1),
  priority: z.number().int().min(1).max(999),
});

const updateEpgPrioritiesSchema = z
  .strictObject({ priorities: z.array(epgPriorityEntrySchema).min(1).max(100) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const entry of value.priorities) {
      if (seen.has(entry.sourceId)) {
        ctx.addIssue({ code: 'custom', message: `priorities 内 sourceId 重复: ${entry.sourceId}`, path: ['priorities'] });
        return;
      }
      seen.add(entry.sourceId);
    }
  });

/**
 * GET /settings/sources/epg-priorities 读路径(016 api.md §3.1):家庭内 kind='epg' 且
 * 启用的来源视图,priority ASC 排序(数值越小越优先;created_at/id 为稳定决胜键);
 * channelCount = 该源 epg_channel 行数(单次 LEFT JOIN 集合查询,Anti-N+1);
 * lastSyncAt = 最近同步完成时间,尚未同步为 null;remote_url 私有不出契约。
 * 决策注明:来源管理/刷新管线查询走 sources 域端口(sourcesStore),本视图为 settings
 * 契约投影,与本文件既有目录查询(requireChannelOfHousehold)同为 interface 层 drizzle 直查。
 */
const epgPriorityQuerySchema = z.strictObject({ includeDisabled: z.enum(['true', 'false']).optional() });

function listEpgPriorityView(householdId: string, includeDisabled = false): EpgSourcePriorityDto[] {
  return getDb()
    .select({
      sourceId: mediaSource.id,
      name: mediaSource.name,
      priority: mediaSource.priority,
      lastSyncAt: mediaSource.lastSuccessAt,
      channelCount: count(epgChannel.xmltvChannelId),
    })
    .from(mediaSource)
    .leftJoin(
      epgChannel,
      and(eq(epgChannel.householdId, mediaSource.householdId), eq(epgChannel.sourceId, mediaSource.id)),
    )
    .leftJoin(
      sourceArchive,
      and(eq(sourceArchive.householdId, mediaSource.householdId), eq(sourceArchive.sourceId, mediaSource.id)),
    )
    .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.kind, 'epg'), isNull(sourceArchive.sourceId), includeDisabled ? undefined : eq(mediaSource.enabled, 1)))
    .groupBy(mediaSource.id)
    .orderBy(asc(mediaSource.priority), asc(mediaSource.createdAt), asc(mediaSource.id))
    .all();
}

/** 刷新触发目标(事务内读出的启用 EPG 源及其 CAS 基准;version 不因权重写入而变) */
interface EpgRefreshTarget {
  sourceId: string;
  version: number;
}

/**
 * PUT 保存事务(016 api.md §3.2):逐条校验来源归属当前家庭且 kind='epg'
 * (不存在/跨家庭/类型不符一律 404 同形 —— 不泄漏来源形态,同 requireChannelOfHousehold
 * 惯例)→ 单事务内更新 priority + catalog_state.revision 原子递增(补建语义与 sources 域
 * bumpCatalogRevision 逐字一致);任一条目非法即整体抛出回滚,零部分写入。
 * 权重写入不触碰 media_source.version(来源管理 expectedVersion CAS 语义不受本端点干扰)。
 * 停用的 EPG 源权重仍可配(归属+kind 校验;启停属来源管理语义)。
 */
function saveEpgPriorities(
  householdId: string,
  entries: Array<{ sourceId: string; priority: number }>,
): { updatedCount: number; refreshTargets: EpgRefreshTarget[] } {
  const nowIso = new Date().toISOString();
  return getDb().transaction((tx) => {
    for (const entry of entries) {
      const source = tx
        .select({ id: mediaSource.id, kind: mediaSource.kind, archivedId: sourceArchive.sourceId })
        .from(mediaSource)
        .leftJoin(
          sourceArchive,
          and(eq(sourceArchive.householdId, mediaSource.householdId), eq(sourceArchive.sourceId, mediaSource.id)),
        )
        .where(and(eq(mediaSource.id, entry.sourceId), eq(mediaSource.householdId, householdId)))
        .get();
      if (source === undefined || source.kind !== 'epg' || source.archivedId !== null) {
        throw new DomainError(404, ProblemCode.NOT_FOUND);
      }
      tx
        .update(mediaSource)
        .set({ priority: entry.priority, updatedAt: nowIso })
        .where(and(eq(mediaSource.id, entry.sourceId), eq(mediaSource.householdId, householdId)))
        .run();
    }
    tx
      .insert(catalogState)
      .values({ householdId, revision: 2 })
      .onConflictDoUpdate({
        target: catalogState.householdId,
        set: { revision: sql`${catalogState.revision} + 1` },
      })
      .run();
    const refreshTargets = tx
      .select({ sourceId: mediaSource.id, version: mediaSource.version })
      .from(mediaSource)
      .leftJoin(
        sourceArchive,
        and(eq(sourceArchive.householdId, mediaSource.householdId), eq(sourceArchive.sourceId, mediaSource.id)),
      )
      .where(and(eq(mediaSource.householdId, householdId), eq(mediaSource.kind, 'epg'), isNull(sourceArchive.sourceId), eq(mediaSource.enabled, 1)))
      .all();
    return { updatedCount: entries.length, refreshTargets };
  });
}

/**
 * EPG 源优先级契约路由(016 api.md §3.1/§3.2,US4 T024;ADR-0017:仅主管理员可访问):
 * - GET /settings/sources/epg-priorities:家庭内启用 EPG 源权重视图(priority ASC);
 * - PUT /settings/sources/epg-priorities:批量权重保存(单事务 + revision 原子递增)
 *   + 保存后触发一次全量级联匹配刷新(见 triggerCascadeRefresh)。
 * 守卫链与 settings-sources/settings-catalog 控制器同槽:SessionGuard → SettingsGuard,
 * 写路径追加 SameOriginGuard;会话有效性由 SessionGuard 逐请求承担(013 免当次密码)。
 */
@Controller('settings/sources')
@UseGuards(SessionGuard, SettingsGuard)
export class SettingsEpgPrioritiesController {
  // 显式 @Inject 令牌:不依赖 emitDecoratorMetadata(与 SettingsSourcesController 同款)
  constructor(
    @Inject(REFRESH_EXECUTOR_PORT) private readonly refreshExecutor: IRefreshExecutorService,
  ) {}

  /** GET:优先级视图 + no-store(权重与同步时间为易变事实) */
  @Get('epg-priorities')
  @HttpCode(200)
  async listPriorities(
    @Query(new StrictQueryPipe(epgPriorityQuerySchema)) query: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<{ sources: EpgSourcePriorityDto[] }> {
    const input = parseBody(epgPriorityQuerySchema, query);
    const sources = listEpgPriorityView(context.session.householdId, input.includeDisabled === 'true');
    res.setHeader('Cache-Control', 'no-store');
    return { sources };
  }

  /**
   * PUT:批量权重保存(200 {success,updatedCount})。校验/事务/revision 递增见
   * saveEpgPriorities;保存成功后异步轻量触发全量级联匹配刷新。
   */
  @Put('epg-priorities')
  @UseGuards(SameOriginGuard)
  async updatePriorities(
    @Body(new StrictBodyPipe(updateEpgPrioritiesSchema)) body: unknown,
    @Res({ passthrough: true }) res: Response,
    @CurrentSession() context: SessionContext,
  ): Promise<{ success: true; updatedCount: number }> {
    const input = parseBody(updateEpgPrioritiesSchema, body);
    const { updatedCount, refreshTargets } = saveEpgPriorities(context.session.householdId, input.priorities);
    this.triggerCascadeRefresh(context, refreshTargets);
    res.setHeader('Cache-Control', 'no-store');
    return { success: true, updatedCount };
  }

  /**
   * 保存后的「全量级联匹配刷新」触发(016 api.md §3.2 注记;spec US4 验收 1):
   * - 多源 EPG 关联裁决(live 投影/指南窗口)为读时集合计算,catalog revision 递增已令
   *   新权重对读路径即时生效;此处再经 sources 域既有刷新执行器为家庭内全部启用 EPG 源
   *   入队一轮全量刷新,复用既有管线重验指南窗口与级联链 —— 绝不自建第二套刷新机制;
   * - 入队 = 请求路径内的轻量 INSERT(queued 任务行),导入本体由既有后台串行执行器
   *   异步承担,不阻塞保存响应;
   * - 尽力而为:同源互斥(409)/版本竞态/队列预算等业务拒绝静默吞掉,不影响保存结果;
   *   ownerPasswordVerified 恒 true 与 requestSourceRefresh 公开入口同款(013 起
   *   常规运维免当次密码;主管理员身份已由 SettingsGuard 逐请求核验)。
   */
  private triggerCascadeRefresh(context: SessionContext, targets: EpgRefreshTarget[]): void {
    for (const target of targets) {
      try {
        this.refreshExecutor.requestRefresh({
          householdId: context.session.householdId,
          accountId: context.session.accountId,
          sessionId: context.session.id,
          sourceId: target.sourceId,
          expectedVersion: target.version,
          operationKey: randomUUID(),
          ownerPasswordVerified: true,
        });
      } catch {
        // 尽力而为触发:竞态业务拒绝(互斥/版本/预算)不影响权重保存语义
      }
    }
  }
}
