import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseDate } from '@internationalized/date';
import type { GuideWindowDto } from '@hmp/shared';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '../../common/domain-error';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '../../common/rate-limit/rate-limit.guard';
import { StrictQueryPipe } from '../../common/strict-input/strict-pipes';
import { PublicContextService } from '../../common/public-context/public-context.service';
import { liveNowMs } from '../live/live-clock';
import { allowedGuideDates, defaultGuideWindowMs, guideDateString, guideDayWindowMs, todayCalendarDateOf } from './guide-calendar';
import { loadGuideWindow } from './guide-window.service';

/**
 * 公共 guide 契约路由(T115;005 contracts/api.md §2):
 *
 * - GET /public/guide:date=YYYY-MM-DD(缺省今天)、from/to 为 UTC、page/pageSize
 *   (「每页最多 50 频道、默认 20」);返回 GuideWindow{date,timezone,now,allowedDates,
 *   from,to,page,pageSize,totalChannels,catalogRevision,channels:[{media,programmes}]}。
 * - Public 边界:**不挂 SessionGuard** —— 匿名可访问、不读取任何请求身份决定内容范围
 *   (api.md §1;即便携带失效 cookie 也按匿名处理);范围由服务端唯一 Household 确定
 *   (PublicContextService);伪造 householdId/profileId/isAdmin 与未知字段(含夹带
 *   revision)由 StrictQueryPipe 一律 400 拒绝。
 * - 限频 @RateLimit('guide')(每连接 IP 30 次/分钟,429 + Retry-After;契约 §1);
 * - Cache-Control: no-store 由全局安全头拦截器统一附加(所有响应,含错误);
 * - 校验次序:严格入参(管道 400)→ 日期范围(昨天/已过期 409 GUIDE_DATE_EXPIRED +
 *   新 allowedDates;未到允许未来范围 400)→ 窗口形态(跨日/>6h/倒置 422/400)→ 查询;
 * - 未初始化家庭:返回 UTC 默认空窗口(与 live 公共端点同口径,不伪装已初始化);
 * - 集合查询:guide 数据装配 8 次(关联核心 6 + 批量窗口 1 + revision 1),
 *   外加全部公共端点共用的 1 次 household 范围判定(PublicContextService,非 guide 装配)。
 */

/** GET /public/guide 查询:date 缺省今天;from/to 成对可选、UTC ISO;page≥1;pageSize 20/max50 */
const guideQuerySchema = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  from: z.string().datetime({ offset: false }).optional(),
  to: z.string().datetime({ offset: false }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

/** 未初始化家庭的默认展示值窗口(UTC;空频道,与 live 公共端点同口径) */
function uninitializedGuideWindow(query: z.infer<typeof guideQuerySchema>, nowMs: number): GuideWindowDto {
  const timezone = 'UTC';
  const today = todayCalendarDateOf(nowMs, timezone);
  const day = guideDayWindowMs(today, timezone);
  const window = defaultGuideWindowMs(nowMs, day);
  return {
    date: guideDateString(today),
    timezone,
    now: new Date(nowMs).toISOString(),
    allowedDates: allowedGuideDates(nowMs, timezone),
    from: new Date(window.fromMs).toISOString(),
    to: new Date(window.toMs).toISOString(),
    page: query.page,
    pageSize: query.pageSize,
    totalChannels: 0,
    catalogRevision: 1,
    channels: [],
  };
}

@Controller('public')
@UseGuards(RateLimitGuard)
export class PublicGuideController {
  // @Inject 显式声明依赖(esbuild/tsx 运行时不发射 design:paramtypes,仓库既有惯例)
  constructor(
    @Inject(PublicContextService) private readonly publicContext: PublicContextService,
  ) {}

  /**
   * GET /public/guide:公共 EPG 墙窗口。date 缺省今天;显式 date 昨天或已过期 →
   * 409 GUIDE_DATE_EXPIRED(+新 allowedDates),today+7 及以后 → 400;from/to 必须
   * 落在该日真实边界内、to>from、跨度≤6 小时(跨日/超限 422 GUIDE_WINDOW_TOO_LARGE,
   * 倒置 400);默认窗口 = 现在前 30 分钟起 6 小时(裁剪日界)。
   */
  @Get('guide')
  @RateLimit('guide')
  guide(@Query(new StrictQueryPipe(guideQuerySchema)) query: z.infer<typeof guideQuerySchema>): GuideWindowDto {
    const nowMs = liveNowMs();
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      return uninitializedGuideWindow(query, nowMs);
    }
    // date 格式合法但非真实日历日(如 2026-02-30)→ 400(先于服务层,避免解析异常)
    if (query.date !== undefined) {
      try {
        parseDate(query.date);
      } catch {
        throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'date 必须是真实日历日(YYYY-MM-DD)');
      }
    }
    // from/to 成对提供方有效(缺一按缺省窗口处理,不产生半指定语义)
    const fromMs = query.from !== undefined && query.to !== undefined ? Date.parse(query.from) : undefined;
    const toMs = query.from !== undefined && query.to !== undefined ? Date.parse(query.to) : undefined;
    if (query.from !== undefined && query.to === undefined) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'from 与 to 必须成对提供');
    }
    return loadGuideWindow(scope.household.householdId, {
      nowMs,
      timezone: scope.household.timezone,
      date: query.date,
      fromMs,
      toMs,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}

// 未初始化窗口与既有公共端点口径一致(UTC 默认展示值);不伪装已初始化。
