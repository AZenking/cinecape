import { Inject, Injectable } from '@nestjs/common';
import { ProblemCode, type PublicContextDto, type PublicMediaDto, type PublicMediaPageDto } from '@hmp/shared';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { DomainError } from '@platform/http-common/domain-error';
import { loadAvailableMediaIdSet } from '@contexts/policy';
import { mediaCatalogStore } from '@contexts/media-catalog/application/media-catalog-store.port';
import { toPublicMedia, type PublicMediaRow } from '@contexts/media-catalog/domain/public-media-projection';

/**
 * 公共目录服务(T023/T024/T025,005 contracts/api.md §1/§2、research R1):
 * - 家庭范围一律 PublicContextService.requireScope() 服务端确定(零家庭 → 未初始化形态、
 *   多家庭配置损坏/存储不可读 → 503),不读取任何请求身份声明;
 * - 目录/详情只含本家庭可用内容(available = present 条目 × 启用来源 × 播放资源,
 *   复用 loadAvailableMediaIdSet 同一谓词,不复制可用性规则),不执行 ProfilePolicy
 *   过滤(FR-002:浏览与策略无关,元数据对游客完全可见);
 * - 未执行 ProfilePolicy ≠ 授权下放:公共投影无 canPlay/策略结果字段,浏览 ≠ 可播放;
 * - 排序与既有观看目录同语义:UTF-8 字节序 title 升序、同题按 id 升序(稳定);
 * - DTO 一律经 public-media-projection 白名单出口,绝无源地址/来源凭据/播放票据。
 *
 * 008-repository-extraction(T010,ADR-0015 D1):Database.db.prepare 原生查询逐字
 * 移入仓储实现(infrastructure/media-catalog-store.drizzle.ts),本服务经
 * media-catalog 仓储端口访问,调用形态与返回形态均不变。
 */

/** 未初始化部署的默认展示值(与初始化向导 InitializeRequest 缺省一致,data-model §9) */
const UNINITIALIZED_DISPLAY = {
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
} as const;

/** 稳定排序(与 catalog.service.compareTitleBinaryThenId 同语义):UTF-8 字节序 title,同题 id */
function compareTitleBinaryThenId(a: PublicMediaRow, b: PublicMediaRow): number {
  const byTitle = Buffer.compare(Buffer.from(a.title, 'utf8'), Buffer.from(b.title, 'utf8'));
  if (byTitle !== 0) {
    return byTitle;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 不存在/跨家庭/不可用统一同形 404,不泄露存在性 */
function notFound(): DomainError {
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

@Injectable()
export class PublicCatalogService {
  // @Inject 显式声明依赖(esbuild/tsx 运行时不发射 design:paramtypes,仓库既有惯例)
  constructor(
    @Inject(PublicContextService) private readonly publicContext: PublicContextService,
  ) {}

  /** GET /public/context:PublicContext 白名单投影(T023;未初始化返回默认展示值) */
  getContext(): PublicContextDto {
    const scope = this.publicContext.requireScope();
    const now = new Date().toISOString();
    if (!scope.initialized) {
      return {
        initialized: false,
        displayName: null,
        language: UNINITIALIZED_DISPLAY.language,
        timezone: UNINITIALIZED_DISPLAY.timezone,
        now,
        catalogRevision: 1,
      };
    }
    const { household } = scope;
    const revisionRow = mediaCatalogStore().findCatalogRevision(household.householdId);
    return {
      initialized: true,
      displayName: household.displayName,
      language: household.language,
      timezone: household.timezone,
      now,
      catalogRevision: revisionRow?.revision ?? 1,
    };
  }

  /**
   * GET /public/media:公共目录列表(T024)——
   * q(字面包含,管道已限 <=100)/type 筛选只影响搜索不扩大范围;
   * 仅 available 进入目录;不先分页后过滤(先筛后排再计数/分页)。
   * 未初始化部署:无家庭即无内容 → 空页(不泄露存储形态)。
   */
  listMedia(query: PublicMediaListQuery): PublicMediaPageDto {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      return { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
    }
    const availableIds = loadAvailableMediaIdSet(scope.household.householdId);
    const rows = mediaCatalogStore().listPublicMediaRows(scope.household.householdId);
    const availableRows: PublicMediaRow[] = [];
    for (const row of rows) {
      if (!availableIds.has(row.id)) {
        continue; // 只有可用资源进入目录
      }
      if (query.type !== undefined && row.type !== query.type) {
        continue;
      }
      const needle = (query.q ?? '').trim().toLowerCase();
      if (needle !== '' && !row.title.toLowerCase().includes(needle)) {
        continue; // 字面包含;q/%/_ 无通配符语义(不经 SQL LIKE)
      }
      // 进目录者即可用(上方集合判定);补投影标志,避免行缺 available 字段被误标 unavailable
      availableRows.push({ ...row, available: true });
    }
    availableRows.sort(compareTitleBinaryThenId);
    const total = availableRows.length;
    const start = (query.page - 1) * query.pageSize;
    return {
      items: availableRows.slice(start, start + query.pageSize).map(toPublicMedia),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /**
   * GET /public/media/{mediaId}:公共详情(T025)——
   * 与列表同一可用集合判定;不存在/跨家庭/不可用统一同形 404;
   * 白名单投影,无个人状态、无播放 URL 或票据。
   */
  getMedia(mediaId: string): PublicMediaDto {
    const scope = this.publicContext.requireScope();
    if (!scope.initialized) {
      throw notFound();
    }
    const availableIds = loadAvailableMediaIdSet(scope.household.householdId);
    if (!availableIds.has(mediaId)) {
      throw notFound();
    }
    const row = mediaCatalogStore().findPublicMediaRowById(scope.household.householdId, mediaId);
    if (row === undefined) {
      throw notFound();
    }
    return toPublicMedia({ ...row, available: true });
  }
}

/** GET /public/media 查询形态(管道已严格校验;此处为服务层契约类型) */
export interface PublicMediaListQuery {
  readonly q?: string;
  readonly type?: PublicMediaDto['type'];
  readonly page: number;
  readonly pageSize: number;
}
