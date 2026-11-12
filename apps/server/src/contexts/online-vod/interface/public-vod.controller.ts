import { Body, Controller, Get, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import type { Vod } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { RateLimitGuard } from '@platform/http-common/rate-limit/rate-limit.guard';
import { RateLimit } from '@platform/http-common/rate-limit/rate-limit.decorator';
import { sharedRateLimitService, type RateLimitService } from '@platform/http-common/rate-limit/rate-limit.service';
import { clientIpOf } from '@platform/http-common/rate-limit/client-ip.util';
import { StrictBodyPipe, StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import {
  createVodSearchService,
  vodUpstreamError,
  VOD_UPSTREAM_PROBLEM_CODES,
} from '@contexts/online-vod/application/search.service';
import type { VodPreviewValues } from '@contexts/online-vod/application/preview.service';
import type { VodSearchPageSnapshot } from '@contexts/online-vod/application/publication-work-set.port';
import { VOD_CACHE, VOD_POSTER_SERVICE, VOD_PREVIEW_SERVICE, VOD_SEARCH_SERVICE } from '@contexts/online-vod/online-vod.tokens';
import type { VodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import type { VodPosterContent } from '@contexts/online-vod/application/poster.service';

/**
 * 010 T031 — 公共搜索/预览契约路由(api.md §2;公共边界)。
 *
 * 公共路由挂法(005 底座约定,与 PublicCatalogController 同款;不挂 SessionGuard:
 * 公共只读不读取身份、不设身份 cookie、不按 cookie 过滤内容):
 *   @Controller('public') + @UseGuards(RateLimitGuard) + @RateLimit('public')
 *   + StrictQueryPipe/空体严格管道(未知字段一律 400)。
 * 在线搜索另挂 vodSearch 控制桶(api.md §0「在线搜索另 20/min/IP,在公共查询
 * 总桶之内」;VodSearchRateGuard 与总桶并行计数,超限 429 + Retry-After)。
 *
 * 家庭范围经 PublicContextService.requireScope() 服务端确定(单家庭部署模型,
 * 与 PublicCatalogService 同一谓词);未初始化部署无可用来源 → 502(与「无启用
 * 源」同形,不泄露存储形态)。业务语义零新增:轮转/去重/分页/缓存与错误分级
 * (502/504/410/422)全部由 T028 search/preview 服务承担,错误一律经既有
 * DomainError/问题码;no-store 等公共安全头由全局拦截器保证。
 */

/* ------------------------------------------------------------------ */
/* 请求 DTO(严格 query;openapi /public/vod/search 参数面)               */
/* ------------------------------------------------------------------ */

/**
 * 搜索严格形态:{q:1–100} 或 {searchId, cursor?},两组互斥(同给 400);
 * 缺 cursor 重放第一页;未知 query 字段一律 400。
 */
const searchQuerySchema = strictObject({
  q: z.string().min(1).max(100).optional(),
  searchId: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  const reject = (field: string, message: string): void => {
    ctx.addIssue({ code: 'custom', message, path: [field] });
  };
  if (value.q !== undefined && value.searchId !== undefined) {
    reject('searchId', 'q 与 searchId 只能二选一(两组互斥)');
  }
  if (value.q === undefined && value.searchId === undefined) {
    reject('q', '首次搜索必须提供 q,翻页必须提供 searchId');
  }
  if (value.searchId === undefined && value.cursor !== undefined) {
    reject('cursor', 'cursor 仅可与 searchId 同用');
  }
});

/** 公共只读端点不接受任何请求体:未知 JSON 字段一律 400(GET 防御性同口径) */
const PUBLIC_EMPTY_BODY_SCHEMA = z.preprocess((value: unknown) => value ?? {}, strictObject({}));

/** 预览路径参数外的 query 一律拒绝(未知字段 400) */
const PUBLIC_EMPTY_QUERY_SCHEMA = strictObject({});

/**
 * 在线搜索控制桶(api.md §0「在线搜索另 20/min/IP」):与 public 总桶同 IP
 * 维度并行计数;超限 429 + Retry-After(动态窗口余量,同 RateLimitGuard 口径)。
 * 构造依赖带缺省:经模块元数据补齐(per-app 实例,桶随 app 生命周期隔离);
 * 免装配挂载时回落共享单例(方向安全,不产生放行窗口)。
 */
@Injectable()
export class VodSearchRateGuard implements CanActivate {
  private readonly rateLimit: RateLimitService;

  constructor(rateLimit?: RateLimitService) {
    this.rateLimit = rateLimit ?? sharedRateLimitService();
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const outcome = this.rateLimit.acquire('vodSearch', `ip:${clientIpOf(request)}`);
    if (!outcome.ok) {
      (http.getResponse<Response>()).setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw new DomainError(429, ProblemCode.PLAYBACK_RATE_LIMITED, undefined);
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* 控制器                                                               */
/* ------------------------------------------------------------------ */

type SearchPageDto = Vod.components['schemas']['SearchPage'];

/**
 * T015 搜索页纯值 → 冻结 wire DTO(api §1)。

 * 唯一差异:纯值 sources[].sourceId 字段载荷本就是不透明 sourceRef(search.service
 * 文件头「sourceId 字段载荷 = 不透明 sourceRef,api §1 无源配置 ID」),wire 字段名
 * 为 sourceRef(openapi VodSearchSource additionalProperties:false);其余字段同形直传。
 */
function toSearchPageDto(page: VodSearchPageSnapshot): SearchPageDto {
  return {
    searchId: page.searchId,
    items: page.items.map((item) => ({
      titleRef: item.titleRef,
      title: item.title,
      year: item.year,
      sourceLabel: item.sourceLabel,
      posterRef: item.posterRef,
    })),
    sources: page.sources.map((source) => ({
      sourceRef: source.sourceId,
      status: source.status,
      hasMore: source.hasMore,
    })),
    nextCursor: page.nextCursor,
    partial: page.partial,
    reasons: [...page.reasons],
    expiresAt: page.expiresAt,
  };
}

/** 成功响应 Content-Type(契约 e2e 对 problem+json 形态断言;播放控制同款惯例) */
const RESPONSE_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/**
 * 同(家庭, 关键词)会话重放登记(api.md §2「缺 cursor 重放第一页」「已生成页重放
 * 不变」在公共检索入口的组合):同 q 复用仍存活的会话按既有 service 语义重放第一页,
 * 不新增服务语义、不重新抓取上游;会话失效(过期/禁源失效)自然回落首次搜索。
 * 仅进程内登记(有界;模块单例,cache 为同一 VodCache 实例)。
 */
const LAST_SEARCH_BY_QUERY = new Map<string, { readonly householdId: string; readonly searchId: string }>();
const LAST_SEARCH_MAX_ENTRIES = 512;

/** 上游故障码 → 相对 problem type(RFC9457 允许相对 URI;502/504 体不携带绝对 URL) */
function upstreamProblemType(code: string): string {
  return `/problems/${code.toLowerCase().replaceAll('_', '-')}`;
}

/** 上游故障码 → title(与全局 ProblemJsonFilter 的 TitleCase 同形) */
function upstreamProblemTitle(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

@Controller('public')
@UseGuards(RateLimitGuard)
@RateLimit('public')
export class PublicVodController {
  constructor(
    // @Inject 显式声明(esbuild/tsx 不发射 design:paramtypes;仓库既有惯例)
    @Inject(VOD_SEARCH_SERVICE) private readonly searchService: ReturnType<typeof createVodSearchService>,
    @Inject(VOD_PREVIEW_SERVICE)
    private readonly previewService: {
      preview(command: { readonly householdId: string; readonly titleRef: string }): Promise<VodPreviewValues>;
    },
    @Inject(VOD_POSTER_SERVICE)
    private readonly posterService: {
      fetch(command: { readonly householdId: string; readonly posterRef: string }): Promise<VodPosterContent>;
    },
    @Inject(VOD_CACHE) private readonly cache: VodCache,
    @Inject(PublicContextService) private readonly publicContext: PublicContextService,
  ) {}

  /**
   * GET /public/vod/search:多源轮转聚合搜索(SearchPage;不物化、不建个人记录)。
   * 未初始化/无家庭 → 无可用来源 502(与「无启用源」同形,不泄露存储形态);
   * 全源失败/全部超时以相对 type 的 problem 体直接渲染(502/504 响应体不携带
   * 绝对 URL,api.md §0/§6 脱敏口径),其余错误经全局 ProblemJsonFilter。
   */
  @Get('vod/search')
  @UseGuards(VodSearchRateGuard)
  async search(
    @Query(new StrictQueryPipe(searchQuerySchema)) query: { readonly q?: string; readonly searchId?: string; readonly cursor?: string },
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SearchPageDto> {
    res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      throw vodUpstreamError(
        VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED,
        '没有可用的在线片源,请在设置中配置并启用来源',
      );
    }
    const householdId = scope.household.householdId;
    try {
      if (query.q !== undefined) {
        // 同(家庭, 关键词)且会话仍存活 → 重放第一页(逐字段不变;不带 cookie 的
        // 游客与携带会话的请求同一会话,公共读取不按 cookie 过滤)
        const reuseKey = `${householdId}\u0000${query.q}`;
        const previous = LAST_SEARCH_BY_QUERY.get(reuseKey);
        if (previous !== undefined) {
          const view = this.cache.get(previous.searchId);
          if (view !== undefined && !view.expired) {
            return toSearchPageDto(
              await this.searchService.search({ mode: 'page', householdId, searchId: previous.searchId, cursor: null }),
            );
          }
          LAST_SEARCH_BY_QUERY.delete(reuseKey);
        }
        const page = await this.searchService.search({ mode: 'query', householdId, query: query.q });
        if (LAST_SEARCH_BY_QUERY.size >= LAST_SEARCH_MAX_ENTRIES) {
          LAST_SEARCH_BY_QUERY.clear();
        }
        LAST_SEARCH_BY_QUERY.set(reuseKey, { householdId, searchId: page.searchId });
        return toSearchPageDto(page);
      }
      return toSearchPageDto(
        await this.searchService.search({
          mode: 'page',
          householdId,
          searchId: query.searchId ?? '',
          cursor: query.cursor ?? null,
        }),
      );
    } catch (error) {
      if (error instanceof DomainError && (error.status === 502 || error.status === 504)) {
        res.status(error.status);
        res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
        res.json({
          type: upstreamProblemType(String(error.code)),
          title: upstreamProblemTitle(String(error.code)),
          status: error.status,
          code: error.code,
          ...(error.detail !== undefined ? { detail: error.detail } : {}),
        });
        return undefined as unknown as SearchPageDto;
      }
      throw error;
    }
  }

  /**
   * GET /public/vod/titles/:titleRef:预览/详情(VodPreview;ref 失效 410,
   * 伪造/跨家庭 404 同形,超预算 422)。
   */
  @Get('vod/titles/:titleRef')
  async preview(
    @Param('titleRef') titleRef: string,
    @Query(new StrictQueryPipe(PUBLIC_EMPTY_QUERY_SCHEMA)) _query: Record<string, never>,
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<VodPreviewValues> {
    res.setHeader('Content-Type', RESPONSE_CONTENT_TYPE);
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      // 未初始化部署无任何已签发 ref:404 同形(不泄露存储形态)
      throw new DomainError(404, ProblemCode.NOT_FOUND, '媒体不存在或当前不可见');
    }
    return this.previewService.preview({ householdId: scope.household.householdId, titleRef });
  }

  /**
   * GET /public/vod/posters/:posterRef:同源海报代理(image/* 字节流)。
   * posterRef 为 p 级不透明 ref;伪造/未签发/跨家庭 404 同形,过期 410,上游
   * 失败/非图片响应 502,超预算 504(问题体经全局 ProblemJsonFilter)。
   * 二进制成功响应不走 RESPONSE_CONTENT_TYPE(problem JSON 惯例),按上游
   * image/* 类型直传;字节有界(≤2MiB)已由服务面保证。
   */
  @Get('vod/posters/:posterRef')
  async poster(
    @Param('posterRef') posterRef: string,
    @Query(new StrictQueryPipe(PUBLIC_EMPTY_QUERY_SCHEMA)) _query: Record<string, never>,
    @Body(new StrictBodyPipe(PUBLIC_EMPTY_BODY_SCHEMA)) _body: Record<string, never>,
    @Res() res: Response,
  ): Promise<void> {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      // 未初始化部署无任何已签发 ref:404 同形(不泄露存储形态)
      throw new DomainError(404, ProblemCode.NOT_FOUND, '媒体不存在或当前不可见');
    }
    const content = await this.posterService.fetch({ householdId: scope.household.householdId, posterRef });
    res.setHeader('Content-Type', content.contentType);
    res.setHeader('Content-Length', String(content.bytes.byteLength));
    res.status(200);
    res.end(content.bytes);
  }
}
/* (010 T090 knip 清理:文件尾 VodSearchServiceDeps 类型再导出已删除——零消费;
 *  组装面在 online-vod.module 工厂,类型单一事实源在 search.service) */
