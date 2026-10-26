import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  ProblemCode,
  type RefreshDto,
  type RootDto,
  type SourceDto,
  type SourcePageDto,
} from '@hmp/shared';
import { DomainError, createDomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { getConfig } from '../../config/env';
import {
  catalogState,
  deviceSession,
  mediaSource,
  sourceRefresh,
  type MediaSource,
} from '../../database/schema';
import { getDb, type Db } from '../auth/db';
import { verifyParentPassword } from '../auth/parent-verification.service';
import {
  toRefreshDtoCounts,
  type RefreshExecutorService,
  type RefreshJobView,
} from '../imports/refresh-executor.service';
import { findNasTargetDenial, findRemoteTargetDenial } from './source-target.validation';

/**
 * 来源管理服务(T020;US1 来源三端点 + source-roots):
 * - 判定次序(contracts/api.md 权限与验证顺序):owner(控制器)→ 严格格式(控制器 zod,400)→
 *   家长验证(缺失/空串 403 REQUIRED;错误/锁定沿用阶段 2 verifyParentPassword,不另写密码校验)→
 *   会话/设备重验(验证期间可能被撤销/过期 → 401)→ 目标归属与许可(不存在/跨家庭 404 同形;
 *   URL/挂载目标不许可 422)→ 版本(409)→ 单事务写入;
 * - 事务语义:创建 source.version=1、更新 version+1,两者同事务 catalog_state.revision+1;
 *   更新时该来源 awaiting_confirmation 快照标 stale(任务 version 随状态变化加一);
 * - DTO 脱敏:SourceDto 仅含契约字段;locationLabel = 远程 origin 的主机标签(host[:port],
 *   默认端口省略,IPv6 保留方括号;绝无 path/query/userinfo)或 NAS rootKey;
 *   remote_url/rootKey/relativeDirectory 绝不进入响应;
 * - 服务为纯函数模块(对齐 policy/profile 惯例),事务经 better-sqlite3 同步回调。
 */

/** 事务句柄类型(better-sqlite3 同步事务回调入参;与 parent-verification.service 同一惯用法) */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface CreateSourceInput {
  ownerPassword?: string;
  kind: 'iptv' | 'epg' | 'nas';
  name: string;
  enabled: boolean;
  remoteUrl?: string;
  rootKey?: string;
  relativeDirectory?: string;
  privateAccessApproved: boolean;
  epgSourceId?: string | null;
}

export interface PatchSourceInput {
  ownerPassword?: string;
  expectedVersion: number;
  name?: string;
  enabled?: boolean;
  remoteUrl?: string;
  privateAccessApproved?: boolean;
  epgSourceId?: string | null;
}

export interface ListSourcesQuery {
  page: number;
  pageSize: number;
}

function notFound(): DomainError {
  // 不存在与跨家庭统一同形,不泄漏归属
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

function invalidRequest(detail: string): DomainError {
  return new DomainError(400, ProblemCode.VALIDATION_FAILED, detail);
}

/**
 * 家长验证 + 会话/设备重验:密码缺失/空串统一 403 PARENT_VERIFICATION_REQUIRED(阶段 2 语义),
 * 非空密码交由 verifyParentPassword(403 FAILED / 423 LOCKED);验证通过后重读会话行,
 * 已撤销/已过期一律 401 SESSION_INVALID(重验会话/设备有效)。
 */
async function requireParentVerification(context: SessionContext, ownerPassword?: string): Promise<void> {
  if (ownerPassword === undefined || ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, ownerPassword);
  const sessionRow = getDb().select().from(deviceSession).where(eq(deviceSession.id, context.session.id)).get();
  if (
    sessionRow === undefined ||
    sessionRow.revokedAt !== null ||
    !(Date.parse(sessionRow.expiresAt) > Date.now())
  ) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
}

/** 脱敏位置标签:远程仅 origin 主机标签(host[:port],默认端口省略,IPv6 带方括号);NAS 为 rootKey */
export function locationLabelOf(row: Pick<MediaSource, 'kind' | 'rootKey' | 'remoteUrl'>): string {
  if (row.kind === 'nas') {
    return row.rootKey ?? '';
  }
  try {
    const target = new URL(row.remoteUrl ?? '');
    const fallbackPort = target.protocol === 'https:' ? '443' : '80';
    const portSuffix = target.port !== '' && target.port !== fallbackPort ? `:${target.port}` : '';
    return `${target.hostname}${portSuffix}`;
  } catch {
    // 创建/修改期已做语法校验,此分支不可达;防御性返回不含任何地址细节的占位
    return 'remote';
  }
}

/** SourceDto 映射(契约 components/schemas/Source;不返回 remote_url/rootKey/relativeDirectory) */
function toSourceDto(row: MediaSource): SourceDto {
  return {
    id: row.id,
    kind: row.kind as SourceDto['kind'],
    name: row.name,
    enabled: row.enabled === 1,
    version: row.version,
    epgSourceId: row.epgSourceId,
    locationLabel: locationLabelOf(row),
    lastSuccessAt: row.lastSuccessAt,
    lastJobId: row.lastJobId,
  };
}

/** catalog_state.revision +1(单事务内;行缺失时以「创建后应为 2」的语义补建,不重置已有修订) */
function bumpCatalogRevision(tx: Tx, householdId: string): void {
  tx.insert(catalogState)
    .values({ householdId, revision: 2 })
    .onConflictDoUpdate({
      target: catalogState.householdId,
      set: { revision: sql`${catalogState.revision} + 1` },
    })
    .run();
}

/** EPG 关联目标校验:必须同家庭(不存在/跨家庭 404 同形)、kind=epg(400)、非自引用(400);允许目标暂时禁用 */
function resolveEpgTarget(epgSourceId: string, householdId: string, selfSourceId: string | null): void {
  const target = getDb().select().from(mediaSource).where(eq(mediaSource.id, epgSourceId)).get();
  if (target === undefined || target.householdId !== householdId) {
    throw notFound();
  }
  if (target.kind !== 'epg') {
    throw invalidRequest('epgSourceId 必须指向 EPG 类型来源');
  }
  if (selfSourceId !== null && target.id === selfSourceId) {
    throw invalidRequest('epgSourceId 不能指向来源自身');
  }
}

/** GET /sources:分页脱敏概览(owner);items 按 created_at、id 稳定排序 */
export function listSources(context: SessionContext, query: ListSourcesQuery): SourcePageDto {
  const db = getDb();
  const where = eq(mediaSource.householdId, context.session.householdId);
  const total = db.select({ value: count() }).from(mediaSource).where(where).get()?.value ?? 0;
  const rows = db
    .select()
    .from(mediaSource)
    .where(where)
    .orderBy(mediaSource.createdAt, mediaSource.id)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
    .all();
  return { items: rows.map(toSourceDto), total, page: query.page, pageSize: query.pageSize };
}

/** GET /source-roots:NAS 根选择列表(owner);label 即 rootKey,不含绝对路径 */
export function listSourceRoots(): RootDto[] {
  return Object.entries(getConfig().MEDIA_ROOTS)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([rootKey]) => ({ rootKey, label: rootKey }));
}

/**
 * POST /sources:创建。家长验证 → 目标许可(远程字面类别 / NAS rootKey+相对目录,422;
 * EPG 目标归属 404/400)→ 事务:version=1 + catalogRevision+1。
 */
export async function createSource(context: SessionContext, input: CreateSourceInput): Promise<SourceDto> {
  await requireParentVerification(context, input.ownerPassword);
  const householdId = context.session.householdId;

  let remoteUrl: string | null = null;
  let rootKey: string | null = null;
  let relativeDirectory: string | null = null;
  let epgSourceId: string | null = null;

  if (input.kind === 'nas') {
    const denial = findNasTargetDenial(
      input.rootKey ?? '',
      input.relativeDirectory ?? '',
      getConfig().MEDIA_ROOTS,
    );
    if (denial !== null) {
      throw createDomainError('SOURCE_TARGET_DENIED', denial);
    }
    rootKey = input.rootKey ?? null;
    relativeDirectory = input.relativeDirectory ?? null;
  } else {
    const candidate = input.remoteUrl ?? '';
    const denial = findRemoteTargetDenial(candidate);
    if (denial !== null) {
      throw createDomainError('SOURCE_TARGET_DENIED', denial);
    }
    remoteUrl = candidate;
    if (input.kind === 'iptv' && input.epgSourceId !== undefined && input.epgSourceId !== null) {
      resolveEpgTarget(input.epgSourceId, householdId, null);
      epgSourceId = input.epgSourceId;
    }
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  return getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({
        id,
        householdId,
        kind: input.kind,
        name: input.name,
        remoteUrl,
        rootKey,
        relativeDirectory,
        privateAccessApproved: input.privateAccessApproved ? 1 : 0,
        epgSourceId,
        enabled: input.enabled ? 1 : 0,
        version: 1,
        lastSuccessAt: null,
        lastJobId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    bumpCatalogRevision(tx, householdId);
    const row = tx.select().from(mediaSource).where(eq(mediaSource.id, id)).get();
    if (row === undefined) {
      throw new Error('来源创建后读取失败');
    }
    return toSourceDto(row);
  });
}

/**
 * PATCH /sources/{sourceId}:部分更新。目标归属(404 同形)→ 可变字段语义
 * (kind/NAS 根不可变由 zod 未知键拒绝;epgSourceId 仅 IPTV;NAS 禁 remoteUrl;换远程地址须
 * 重新 privateAccessApproved,不继承旧目标许可)→ 事务内版本检查(409)→ version+1、
 * awaiting_confirmation 快照标 stale、catalogRevision+1 同事务提交。
 */
export async function updateSource(
  sourceId: string,
  context: SessionContext,
  input: PatchSourceInput,
): Promise<SourceDto> {
  await requireParentVerification(context, input.ownerPassword);
  const householdId = context.session.householdId;

  const sourceWhere = and(eq(mediaSource.id, sourceId), eq(mediaSource.householdId, householdId));
  const existing = getDb().select().from(mediaSource).where(sourceWhere).get();
  if (existing === undefined) {
    throw notFound();
  }

  // epgSourceId:仅 IPTV 来源可更新;null 解除,非空须指向同家庭 EPG 来源
  if (input.epgSourceId !== undefined && existing.kind !== 'iptv') {
    throw invalidRequest('仅 IPTV 来源可修改 epgSourceId');
  }
  let nextEpgSourceId = existing.epgSourceId;
  if (input.epgSourceId !== undefined) {
    if (input.epgSourceId === null) {
      nextEpgSourceId = null;
    } else {
      resolveEpgTarget(input.epgSourceId, householdId, sourceId);
      nextEpgSourceId = input.epgSourceId;
    }
  }

  // remoteUrl:NAS 禁止;新地址须通过目标许可;换地址须同时显式 privateAccessApproved=true
  let nextRemoteUrl = existing.remoteUrl;
  if (input.remoteUrl !== undefined) {
    if (existing.kind === 'nas') {
      throw invalidRequest('NAS 来源不能设置远程地址');
    }
    const denial = findRemoteTargetDenial(input.remoteUrl);
    if (denial !== null) {
      throw createDomainError('SOURCE_TARGET_DENIED', denial);
    }
    if (input.remoteUrl !== existing.remoteUrl && input.privateAccessApproved !== true) {
      throw createDomainError('SOURCE_TARGET_DENIED', '更换远程地址须同时确认 privateAccessApproved');
    }
    nextRemoteUrl = input.remoteUrl;
  }

  return getDb().transaction((tx) => {
    const row = tx.select().from(mediaSource).where(sourceWhere).get();
    if (row === undefined) {
      throw notFound();
    }
    if (row.version !== input.expectedVersion) {
      throw createDomainError('SOURCE_VERSION_CONFLICT');
    }
    tx
      .update(mediaSource)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
        ...(input.privateAccessApproved !== undefined
          ? { privateAccessApproved: input.privateAccessApproved ? 1 : 0 }
          : {}),
        remoteUrl: nextRemoteUrl,
        epgSourceId: nextEpgSourceId,
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(sourceWhere)
      .run();
    // 旧待确认快照失效(同事务):任务 version 随状态变化加一
    tx
      .update(sourceRefresh)
      .set({ status: 'stale', version: sql`${sourceRefresh.version} + 1` })
      .where(
        and(
          eq(sourceRefresh.householdId, householdId),
          eq(sourceRefresh.sourceId, sourceId),
          eq(sourceRefresh.status, 'awaiting_confirmation'),
        ),
      )
      .run();
    bumpCatalogRevision(tx, householdId);
    const fresh = tx.select().from(mediaSource).where(sourceWhere).get();
    if (fresh === undefined) {
      throw new Error('来源更新后读取失败');
    }
    return toSourceDto(fresh);
  });
}

/* ------------------------------------------------------------------ */
/* 刷新任务(T028;消费 T026 RefreshExecutorService,只读调用其 API)      */
/* 判定次序与来源管理完全一致:家长验证(缺失/空串 403 REQUIRED;错误/锁定  */
/* 沿用阶段 2)→ 会话/设备重验(401)→ 执行器状态机(404 同形/422/409/429)。*/
/* ------------------------------------------------------------------ */

/** POST /sources/{sourceId}/refresh 请求体(契约 RefreshRequest;控制器已做 zod 严格校验) */
export interface RequestRefreshBody {
  ownerPassword?: string;
  expectedVersion: number;
  operationKey: string;
}

/** POST /refreshes/{refreshId}/confirm|discard 请求体(契约 JobAction;expectedVersion 为任务当前 version) */
export interface JobActionBody {
  ownerPassword?: string;
  expectedVersion: number;
}

/** RefreshJobView → RefreshDto(契约 components/schemas/Refresh;counts 由 toRefreshDtoCounts 补零为六字段全量) */
export function toRefreshDto(view: RefreshJobView): RefreshDto {
  return {
    id: view.id,
    sourceId: view.sourceId,
    status: view.status,
    version: view.version,
    createdAt: view.createdAt,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
    expiresAt: view.expiresAt,
    counts: toRefreshDtoCounts(view.counts),
    confirmationReason: view.confirmationReason,
    errorCode: view.errorCode,
  };
}

/**
 * POST /sources/{sourceId}/refresh:发起刷新(202,不等待导入)。
 * 执行器内部校验次序:ownerPasswordVerified 声明 → 来源 404 同形 → 禁用 422 SOURCE_DISABLED →
 * operationKey 幂等(同语义返回原任务,异语义 409 IDEMPOTENCY_CONFLICT)→ expectedVersion 409 →
 * 同来源 queued/running/awaiting 409 SOURCE_BUSY → 全局排队满 429 IMPORT_QUEUE_FULL(Retry-After: 5)。
 */
export async function requestSourceRefresh(
  executor: RefreshExecutorService,
  context: SessionContext,
  sourceId: string,
  input: RequestRefreshBody,
): Promise<RefreshDto> {
  await requireParentVerification(context, input.ownerPassword);
  const view = executor.requestRefresh({
    householdId: context.session.householdId,
    accountId: context.account.id,
    sessionId: context.session.id,
    sourceId,
    expectedVersion: input.expectedVersion,
    operationKey: input.operationKey,
    ownerPasswordVerified: true,
  });
  return toRefreshDto(view);
}

/** GET /refreshes/{refreshId}:懒执行过期使超时任务以 expired 终态可见;未知/跨家庭 404 同形 */
export function getSourceRefresh(
  executor: RefreshExecutorService,
  context: SessionContext,
  refreshId: string,
): RefreshDto {
  executor.expireStaleConfirmations();
  const view = executor.getRefreshJob(context.session.householdId, refreshId);
  if (view === null) {
    throw notFound();
  }
  return toRefreshDto(view);
}

/** POST /refreshes/{refreshId}/confirm:确认待确认快照(发布前执行器重验会话/来源/基线/摘要) */
export async function confirmSourceRefresh(
  executor: RefreshExecutorService,
  context: SessionContext,
  refreshId: string,
  input: JobActionBody,
): Promise<RefreshDto> {
  await requireParentVerification(context, input.ownerPassword);
  return toRefreshDto(
    executor.confirmRefresh({
      householdId: context.session.householdId,
      refreshId,
      expectedVersion: input.expectedVersion,
      sessionId: context.session.id,
    }),
  );
}

/** POST /refreshes/{refreshId}/discard:丢弃待确认快照(成功释放来源锁;终态 immutable) */
export async function discardSourceRefresh(
  executor: RefreshExecutorService,
  context: SessionContext,
  refreshId: string,
  input: JobActionBody,
): Promise<RefreshDto> {
  await requireParentVerification(context, input.ownerPassword);
  return toRefreshDto(
    executor.discardRefresh({
      householdId: context.session.householdId,
      refreshId,
      expectedVersion: input.expectedVersion,
      sessionId: context.session.id,
    }),
  );
}
