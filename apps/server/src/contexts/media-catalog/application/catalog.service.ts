import { ProblemCode, type MediaDto, type MediaPageDto } from '@hmp/shared';
import type { SessionContext } from '../../../common/current-session.decorator';
import { DomainError } from '../../../common/domain-error';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import type { CatalogCandidateRow } from '@contexts/policy/application/policy.batch-context';
import { loadBatchCatalogContext } from '@contexts/policy/application/policy.batch-context';
import type { MediaType } from '@contexts/policy/domain/policy.rules';

/**
 * 观看目录服务(T035;US2):
 * - 判定链(contracts/api.md):SessionGuard → 会话/设备/档案有效与归属 → 最新策略 →
 *   同家庭真实资源 → evaluatePolicy(批量上下文)→ 搜索 → 排序 → 计数 → 分页 → DTO;
 * - 搜索/分页参数只影响筛选不参与授权;q 为 trim 后大小写不敏感「字面包含」:
 *   在内存包含匹配中 %、_、\ 天然是字面字符,不经 SQL LIKE,无通配符语义可误触;
 * - 列表与详情共用同一 allowed 集合,判定必然一致;不可见/不可用/跨家庭/不存在统一 404 同形;
 * - DTO 仅契约字段,poster=null(首期不加载外部海报),绝无播放地址/路径/凭据/upstream tvg-id。
 */

export interface ListMediaQuery {
  q?: string;
  type?: MediaType;
  page: number;
  pageSize: number;
}

function notFound(): DomainError {
  // 不存在/跨家庭/不可见/不可用统一同形,不泄漏存在性
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

function toMediaDto(candidate: CatalogCandidateRow): MediaDto {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    description: candidate.description,
    contentLevel: candidate.contentLevel,
    poster: null,
    version: candidate.version,
  };
}

/** 筛选(授权后):type 枚举精确匹配 + q 字面包含;空 q 视为不过滤 */
function matchesFilter(candidate: CatalogCandidateRow, query: ListMediaQuery): boolean {
  if (query.type !== undefined && candidate.type !== query.type) {
    return false;
  }
  const needle = (query.q ?? '').trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return candidate.title.toLowerCase().includes(needle);
}

/** title 按 UTF-8 字节序(= SQLite BINARY collation)升序;同题按 id 升序保证稳定 */
function compareTitleBinaryThenId(a: CatalogCandidateRow, b: CatalogCandidateRow): number {
  const byTitle = Buffer.compare(Buffer.from(a.title, 'utf8'), Buffer.from(b.title, 'utf8'));
  if (byTitle !== 0) {
    return byTitle;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 纯目录管线(单元可直接验证):过滤已在批量上下文完成(策略+可用性先于本管线),
 * 此处再做搜索/类型筛选 → 排序 → 计数 → 分页;total 恒为过滤后总数,越界页空列表。
 */
export function buildMediaPage(allowed: readonly CatalogCandidateRow[], query: ListMediaQuery): MediaPageDto {
  const filtered = allowed.filter((candidate) => matchesFilter(candidate, query)).sort(compareTitleBinaryThenId);
  const total = filtered.length;
  const start = (query.page - 1) * query.pageSize;
  return {
    items: filtered.slice(start, start + query.pageSize).map(toMediaDto),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** GET /media:先策略过滤再搜索/排序/计数/分页(research R7,不得先分页后过滤) */
export function listMedia(context: SessionContext, query: ListMediaQuery): MediaPageDto {
  const catalog = loadBatchCatalogContext(getDb(), {
    householdId: context.session.householdId,
    sessionId: context.session.id,
  });
  return buildMediaPage(catalog.allowed, query);
}

/** GET /media/{mediaId}:与列表同一 allowed 集合判定;未命中 → 统一同形 404 */
export function getMedia(context: SessionContext, mediaId: string): MediaDto {
  const catalog = loadBatchCatalogContext(getDb(), {
    householdId: context.session.householdId,
    sessionId: context.session.id,
  });
  const hit = catalog.allowed.find((candidate) => candidate.id === mediaId);
  if (hit === undefined) {
    throw notFound();
  }
  return toMediaDto(hit);
}
