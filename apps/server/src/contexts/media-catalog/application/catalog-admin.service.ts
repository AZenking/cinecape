import { and, eq, sql } from 'drizzle-orm';
import { ProblemCode, type CandidateDto, type CandidatePageDto, type MediaDto } from '@hmp/shared';
import type { SessionContext } from '../../../common/current-session.decorator';
import { DomainError } from '../../../common/domain-error';
import { catalogState, deviceSession, mediaItem } from '../../../database/schema';
import { getDb, type Db } from '../../../modules/auth/db';
import { verifyParentPassword } from '../../../modules/auth/parent-verification.service';
import { loadMediaAvailabilityFacts } from '@contexts/media-catalog/infrastructure/resource-reader';
import type { CatalogCandidateRow } from '@contexts/policy/application/policy.batch-context';
import type { MediaType } from '@contexts/policy/domain/policy.rules';

/**
 * 家长候选与人工修正服务(T050;US3):
 * - 判定次序(contracts/api.md「家长候选与人工修正」):owner(控制器)→ 严格 zod(控制器,400)→
 *   家长验证(缺失/空串 403 REQUIRED;错误 403 FAILED;锁定 423)→ 会话/设备重验(401)→
 *   家庭边界(404 同形)→ 版本(409)→ 单事务写入;
 * - 候选查询是独立 owner 管线:绕过观看策略(不做 evaluatePolicy 过滤),但仍以会话 Household
 *   为唯一查询边界;复用 resource-reader 的真实可用性,含 unavailable 候选与 available 布尔;
 *   不复用 policy.batch-context(那是观看授权管线,要求 activeProfile 且按策略过滤);
 * - 人工修正与 catalog_state.revision+1 同事务;title/type 修改置对应 overridden 标志
 *   (contentLevel 修改不动标志),导入刷新据此保留人工标题/类型(data-model「media_item」节);
 * - 不创建任何长期家长令牌;密码仅当次验证,不写日志/缓存(LoggingInterceptor 不采集请求体);
 * - DTO 仅契约字段:poster=null,绝无播放地址/路径/凭据/upstream tvg-id。
 */

/** 事务句柄类型(better-sqlite3 同步事务回调入参;与 sources.service 同一惯用法) */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface CandidateQueryInput {
  ownerPassword?: string;
  q?: string;
  type?: MediaType;
  page: number;
  pageSize: number;
}

export interface PatchMediaInput {
  ownerPassword?: string;
  expectedVersion: number;
  title?: string;
  type?: MediaType;
  contentLevel?: number | null;
}

function notFound(): DomainError {
  // 不存在/跨家庭统一同形,不泄漏归属与可见性
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

/**
 * 家长验证 + 会话重验(与 sources.service requireParentVerification 同语义):
 * 密码缺失/空串统一 403 REQUIRED;verifyParentPassword 负责 403 FAILED / 423 LOCKED;
 * 通过后重读会话行,已撤销/过期一律 401 SESSION_INVALID。
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

function toCandidateDto(candidate: CatalogCandidateRow): CandidateDto {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    description: candidate.description,
    contentLevel: candidate.contentLevel,
    poster: null,
    version: candidate.version,
    available: candidate.available,
  };
}

function matchesFilter(candidate: CatalogCandidateRow, query: { q?: string; type?: MediaType }): boolean {
  if (query.type !== undefined && candidate.type !== query.type) {
    return false;
  }
  const needle = (query.q ?? '').trim().toLowerCase();
  if (needle === '') {
    return true;
  }
  return candidate.title.toLowerCase().includes(needle);
}

/** title 按 UTF-8 字节序(= SQLite BINARY collation)升序;同题按 id 升序稳定(目录同惯例) */
function compareTitleBinaryThenId(a: CatalogCandidateRow, b: CatalogCandidateRow): number {
  const byTitle = Buffer.compare(Buffer.from(a.title, 'utf8'), Buffer.from(b.title, 'utf8'));
  if (byTitle !== 0) {
    return byTitle;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * POST /catalog/candidates/query:owner 管线候选分页(绕过观看策略,仅限会话家庭)。
 * 先装载家庭全集(含不可用与可用性布尔),再筛选 → 排序 → 计数 → 分页(不先分页后过滤)。
 */
export async function queryCandidates(context: SessionContext, input: CandidateQueryInput): Promise<CandidatePageDto> {
  await requireParentVerification(context, input.ownerPassword);
  const db = getDb();
  const householdId = context.session.householdId;

  const rows = db
    .select({
      id: mediaItem.id,
      type: mediaItem.type,
      title: mediaItem.title,
      description: mediaItem.description,
      contentLevel: mediaItem.contentLevel,
      version: mediaItem.version,
    })
    .from(mediaItem)
    .where(eq(mediaItem.householdId, householdId))
    .all();
  const availability = loadMediaAvailabilityFacts(db, { householdId });
  const candidates: CatalogCandidateRow[] = rows.map((row) => ({
    id: row.id,
    type: row.type as MediaType,
    title: row.title,
    description: row.description,
    contentLevel: row.contentLevel,
    version: row.version,
    available: availability.get(row.id) === true,
  }));

  const filtered = candidates.filter((candidate) => matchesFilter(candidate, input)).sort(compareTitleBinaryThenId);
  const start = (input.page - 1) * input.pageSize;
  return {
    items: filtered.slice(start, start + input.pageSize).map(toCandidateDto),
    total: filtered.length,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/** catalog_state.revision +1(单事务内;行缺失按「创建后应为 2」语义补建,与 sources.service 同规则) */
function bumpCatalogRevision(tx: Tx, householdId: string): void {
  tx.insert(catalogState)
    .values({ householdId, revision: 2 })
    .onConflictDoUpdate({
      target: catalogState.householdId,
      set: { revision: sql`${catalogState.revision} + 1` },
    })
    .run();
}

/**
 * PATCH /catalog/media/{mediaId}:人工元数据修正。
 * 顺序:家庭边界 404 同形 → 频道跨类别转换 400(语义校验,需先读行)→ 版本 409 →
 * 同事务更新字段+version+1+overridden 标志+catalog_state.revision+1。
 * type 仅允许非频道四类互转(channel↔非频道一律 400);不建立 Series/Episode 层级关系。
 */
export async function patchMediaMetadata(mediaId: string, context: SessionContext, input: PatchMediaInput): Promise<MediaDto> {
  await requireParentVerification(context, input.ownerPassword);
  const householdId = context.session.householdId;

  return getDb().transaction((tx) => {
    const row = tx
      .select()
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
    if (row === undefined) {
      throw notFound();
    }
    if (input.type !== undefined && (row.type === 'channel') !== (input.type === 'channel')) {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '频道与非频道之间不能互相转换类型');
    }
    if (row.version !== input.expectedVersion) {
      throw new DomainError(409, ProblemCode.MEDIA_VERSION_CONFLICT, '媒体已被其他操作修改,请重新加载');
    }

    tx
      .update(mediaItem)
      .set({
        ...(input.title !== undefined ? { title: input.title, titleOverridden: 1 } : {}),
        ...(input.type !== undefined ? { type: input.type, typeOverridden: 1 } : {}),
        // contentLevel 修改(含 null 恢复未评级)不改 overridden 标志:普通刷新按现行导入规则覆盖分级
        ...(input.contentLevel !== undefined ? { contentLevel: input.contentLevel } : {}),
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .run();
    bumpCatalogRevision(tx, householdId);

    const fresh = tx
      .select()
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
    if (fresh === undefined) {
      throw notFound();
    }
    return {
      id: fresh.id,
      type: fresh.type as MediaType,
      title: fresh.title,
      description: fresh.description,
      contentLevel: fresh.contentLevel,
      poster: null,
      version: fresh.version,
    };
  });
}
