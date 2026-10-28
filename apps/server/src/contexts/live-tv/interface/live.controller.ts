import { Controller, Get, Inject, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { ChannelPageDto, ChannelRowDto, ExperienceProgrammesDto, GroupPageDto, PublicMediaDto } from '@hmp/shared';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { Database } from '@platform/database/database';
import { readCatalogRevision } from '@contexts/epg';
import { liveNowMs } from '@contexts/live-tv/domain/live-clock';
import { groupKeyOf, OTHER_GROUP_LABEL } from '@contexts/live-tv/domain/live-grouping';
import { loadLiveGroups } from '@contexts/live-tv/application/live-grouping.service';
import { loadLiveChannelWindows } from '@contexts/live-tv/application/live-projection.service';
import { DEFAULT_PAGE_SIZE, paginate, sortChannelRows, type LiveSectionName, type SectionSortableRow } from '@contexts/live-tv/domain/live-sections';

/**
 * 公共直播契约路由(T064/T065/T066;005 contracts/api.md §2 公共浏览):
 * - Public 边界:**不挂 SessionGuard** —— 公共浏览不读取身份决定内容范围,
 *   即便携带失效 cookie 也按匿名处理(api.md §1);范围由服务端唯一 Household 确定
 *   (PublicContextService,不接收任何请求身份声明);
 * - 限频 @RateLimit('public')(每连接 IP 120 次/分钟,429 + Retry-After);
 * - 严格 query 管道:未知键一律 400(伪造 householdId/profileId/isAdmin 等
 *   身份/授权事实字段不可能扩大公开查询范围);
 * - 每个响应冻结同一 now(liveNowMs 一次)+ 家庭 timezone + catalogRevision 同步快照;
 *   不要求不同 HTTP 请求的 now 相等;Cache-Control: no-store 由全局安全头拦截器统一附加;
 * - catalogRevision 读取(US6 T114 起平移至 contexts/epg/infrastructure/catalog-revision.service):
 *   读 catalog_state.revision(来源/EPG 发布与管理修改同事务递增的既有计数),
 *   行缺失按「创建后应为 1」语义取 1(与 catalog-admin/sources 补建惯例一致)。
 */

/** GET /public/live/channels 查询:section 枚举、groupKey?、q?、page≥1、pageSize=20/max50 */
const channelsQuerySchema = z.strictObject({
  section: z.enum(['now', 'next', 'group', 'all']).default('all'),
  groupKey: z.string().min(1).max(128).optional(),
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(DEFAULT_PAGE_SIZE),
});

/** groups 与 programmes 查询:契约无输入,未知键一律 400 */
const emptyQuerySchema = z.strictObject({});

/** 同步快照三元组(now 一次冻结;timezone/catalogRevision 同事务读取) */
interface LiveSnapshot {
  readonly now: string;
  readonly timezone: string;
  readonly catalogRevision: number;
}

function readSnapshot(householdId: string | null, nowMs: number): LiveSnapshot {
  let timezone = 'UTC';
  let catalogRevision = 1;
  if (householdId !== null) {
    const household = Database.db
      .prepare('SELECT timezone FROM household WHERE id = ?')
      .get(householdId) as { timezone: string } | undefined;
    if (household !== undefined) {
      timezone = household.timezone;
    }
    // catalog_state.revision 读取点平移至 catalog-revision.service(US6 T114;行缺失=1 规则不变)
    catalogRevision = readCatalogRevision(householdId);
  }
  return { now: new Date(nowMs).toISOString(), timezone, catalogRevision };
}

function toPublicMedia(row: {
  mediaId: string;
  title: string;
  description: string | null;
  posterRef: string | null;
  contentLevel: number | null;
}): PublicMediaDto {
  // 直播列表只含可用频道;posterRef 仅转发服务端存储值(导入路径只写 NULL,不做外部转发)
  return {
    id: row.mediaId,
    type: 'channel',
    title: row.title,
    description: row.description,
    posterRef: row.posterRef,
    contentLevel: row.contentLevel,
    availability: 'available',
  };
}

interface SortableProjection {
  readonly mediaId: string;
  readonly title: string;
  readonly groupKey: string;
  readonly current: { readonly endsAt: string } | null;
  readonly next: { readonly startsAt: string } | null;
}

@Controller('public')
@UseGuards(RateLimitGuard)
@RateLimit('public')
export class LivePublicController {
  // @Inject 显式声明依赖(esbuild/tsx 运行时不发射 design:paramtypes,仓库既有惯例)
  constructor(
    @Inject(PublicContextService) private readonly publicContext: PublicContextService,
  ) {}

  /**
   * GET /public/live/groups:仅可用频道分组;{items:[{key,label}],now,timezone,catalogRevision},
   * 无源 ID/源 URL/来源身份(分组 key 为显示名的单向不透明映射)。
   */
  @Get('live/groups')
  groups(@Query(new StrictQueryPipe(emptyQuerySchema)) _query: Record<string, never>): GroupPageDto {
    const nowMs = liveNowMs();
    const scope = this.publicContext.requireScope();
    const snapshot = readSnapshot(scope.initialized ? scope.household.householdId : null, nowMs);
    if (!scope.initialized) {
      return { items: [], ...snapshot };
    }
    return { items: loadLiveGroups(scope.household.householdId, nowMs).items, ...snapshot };
  }

  /**
   * GET /public/live/channels:section=now/next/group/all + groupKey?/q?/page/pageSize=20/max50。
   * now/next 按 A-007 排序(当前节目结束时间/下一节目开始时间,同时间按名称与稳定标识);
   * all/group 包含无 EPG 可用频道(current/next=null,频道本身仍存在);
   * 先集合计算可用性与关联映射再批量取节目窗口(查询次数不随频道数增长)。
   */
  @Get('live/channels')
  channels(@Query(new StrictQueryPipe(channelsQuerySchema)) query: z.infer<typeof channelsQuerySchema>): ChannelPageDto {
    const nowMs = liveNowMs();
    const scope = this.publicContext.requireScope();
    const snapshot = readSnapshot(scope.initialized ? scope.household.householdId : null, nowMs);
    if (!scope.initialized) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0, ...snapshot };
    }
    const projections = loadLiveChannelWindows(scope.household.householdId, nowMs);
    const sortable: SortableProjection[] = [];
    const projectionById = new Map<string, (typeof projections)[number]>();
    for (const projection of projections) {
      const groupKey = groupKeyOf(projection.mainGroupLabel ?? OTHER_GROUP_LABEL);
      // section=group 按 groupKey 过滤;缺省 groupKey 不缩小范围(契约 groupKey? 可选)
      if (query.section === 'group' && query.groupKey !== undefined && groupKey !== query.groupKey) {
        continue;
      }
      if (query.q !== undefined && !projection.title.toLowerCase().includes(query.q.toLowerCase())) {
        continue;
      }
      sortable.push({
        mediaId: projection.mediaId,
        title: projection.title,
        groupKey,
        current: projection.current,
        next: projection.next,
      });
      projectionById.set(projection.mediaId, projection);
    }
    const section: LiveSectionName = query.section;
    const sorted: SectionSortableRow[] = sortChannelRows(sortable, section);
    const page = paginate(sorted, query.page, query.pageSize);
    const items: ChannelRowDto[] = page.items.map((row) => {
      const projection = projectionById.get(row.mediaId);
      if (projection === undefined) {
        throw new Error('分区排序返回了未知频道(编程错误)');
      }
      return {
        media: toPublicMedia(projection),
        groupKey: groupKeyOf(projection.mainGroupLabel ?? OTHER_GROUP_LABEL),
        groupLabel: projection.mainGroupLabel ?? OTHER_GROUP_LABEL,
        current: projection.current,
        next: projection.next,
      };
    });
    return { items, page: page.page, pageSize: page.pageSize, total: page.total, ...snapshot };
  }

  /**
   * GET /public/media/{mediaId}/programmes:该频道当前/下一节目(复用 T063 投影与
   * 不透明 programme key);非频道 400;无匹配(未关联/禁用/冲突/无节目)200 unavailable;
   * 未知/跨家庭/不可用 404 同形(公开目录只暴露可用元数据);无个人状态、无播放 URL。
   */
  @Get('media/:mediaId/programmes')
  programmes(
    @Param('mediaId') mediaId: string,
    @Query(new StrictQueryPipe(emptyQuerySchema)) _query: Record<string, never>,
  ): ExperienceProgrammesDto {
    const nowMs = liveNowMs();
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    const householdId = scope.household.householdId;
    const media = Database.db
      .prepare('SELECT type FROM media_item WHERE household_id = ? AND id = ?')
      .get(householdId, mediaId) as { type: string } | undefined;
    if (media === undefined) {
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    if (media.type !== 'channel') {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '仅频道条目提供节目指南');
    }
    const windows = loadLiveChannelWindows(householdId, nowMs, { mediaIds: [mediaId] });
    const row = windows[0];
    if (row === undefined) {
      // 频道存在但不可用(公开目录只暴露可用元数据)→ 与未知同形 404
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    const available = row.current !== null || row.next !== null;
    return {
      status: available ? 'available' : 'unavailable',
      current: row.current,
      next: row.next,
      ...readSnapshot(householdId, nowMs),
    };
  }
}
