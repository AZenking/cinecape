import { randomUUID } from 'node:crypto';
import {
  ProblemCode,
  type RefreshDto,
  type RootDto,
  type SourceDto,
  type SourcePageDto,
} from '@hmp/shared';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { getConfig } from '@platform/config/env';
import type { MediaSource } from '@platform/database/schema';
import { verifyParentPassword } from '@contexts/identity-access';
import { toRefreshDtoCounts, type RefreshJobView } from '@contexts/sources/application/refresh-executor.service';
// 007-T022a:executor 参数改用发布面接口(结构同源,实现类 implements;纯类型收窄,行为零变化)
import type { IRefreshExecutorService } from './ports';
import { findNasTargetDenial, findRemoteTargetDenial, findVodTargetDenial } from '@contexts/sources/domain/source-target.validation';
// 008-T009(ADR-0015 D1):数据访问经仓储端口 seam,Drizzle 实现于 infrastructure 装配期绑定
import { sourcesStore } from './sources-store.port';
// 010 T026(api.md §2「POST /settings/sources/:id/test」):可达性探测走平台 SafeUpstream
// 实现但以本文件结构端口表达 —— application 层 R1 白名单不含 platform/upstream
// (仅 http-common/config),故只镜像请求子面与缺省预算;SafeUpstreamPort 实现结构兼容
// 可直接传入,装配归 T031(许可=LAN_ALLOWED_TARGETS,与刷新面同一口径)。
import type { LanTarget } from '@platform/config/env.schema';

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
 * - 服务为纯函数模块(对齐 policy/profile 惯例),事务经仓储端口 withTransaction 表达
 *   (008-T009:SQL 逐字迁移至 infrastructure/sources-store.drizzle.ts,行为零变化);
 * - 010 T026(在线点播):kind=vod 创建分支(必 remote_url、禁 NAS/EPG 绑定字段、
 *   vod_source_config 同事务落库、10 启用源净配额 409 VOD_QUOTA_EXCEEDED)、PATCH 根地址
 *   拒绝 400 + 启停 locator_revision+1 防 ABA(改名不递增)、vod 来源 refresh 稳定 400、
 *   POST :id/test 连通性测试(SafeUpstream 有界探测,零媒体写入)。
 */

export interface CreateSourceInput {
  ownerPassword?: string;
  kind: 'iptv' | 'epg' | 'nas' | 'vod';
  name: string;
  enabled: boolean;
  remoteUrl?: string;
  rootKey?: string;
  relativeDirectory?: string;
  privateAccessApproved: boolean;
  epgSourceId?: string | null;
  /** 010 T026:kind=vod 必填且恒为 apple-cms-json(契约 VodCreateSourceRequest;iptv/epg/nas 不携带) */
  adapter?: 'apple-cms-json';
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

/* ------------------------------------------------------------------ */
/* vod 常量(010 T026;跨上下文深导入禁止,契约值本地镜像并注明出处)       */
/* ------------------------------------------------------------------ */

/** 启用 vod 源净配额上限(=10;数值来源 contexts/online-vod/domain/vod-budgets.ts
 *  catalog.maxEnabledSources,api.md §2「限10启用源」/data-model §4 净额口径) */
const VOD_MAX_ENABLED_SOURCES = 10;

/** vod 唯一受支持 adapter(data-model §2「adapter=apple-cms-json」;schema CHECK 同值) */
const VOD_SUPPORTED_ADAPTER = 'apple-cms-json';

/** kind=vod 能力常量(010 openapi VodSourceCapabilities;resume=operational 为候选语义,
 *  最终续播资格需当次 probe 判定,故 requiresCurrentProbe 恒 true) */
const VOD_SOURCE_CAPABILITIES = { resume: 'operational', requiresCurrentProbe: true } as const;

/**
 * vod 测试探测缺省预算(010 T026;数值镜像 platform/upstream VOD_SAFE_UPSTREAM_BUDGETS,
 *  后者镜像 VOD_BUDGETS.search/preview:总期限 8s、空闲 15s、重定向 3 跳、4MiB)。
 *  本地镜像因 application 层 R1 白名单不含 platform/upstream;测试对照锁定与
 *  test/unit/online-vod/safe-upstream.spec.ts 同一口径。
 */
const VOD_TEST_PROBE_BUDGETS = {
  totalTimeoutMs: 8_000,
  idleTimeoutMs: 15_000,
  maxRedirects: 3,
  maxBytes: 4 * 1024 * 1024,
} as const;

/** 有界读取请求(平台 SafeUpstreamOpenRequest 的 service 消费子面;许可词表取自
 *  platform/config 的 LanTarget —— application 白名单允许 platform/config) */
export interface VodSourceProbeRequest {
  url: string;
  allowedTargets: readonly LanTarget[];
  byteBudget?: number;
  timeBudgets?: { totalTimeoutMs: number; idleTimeoutMs: number; maxRedirects: number };
}

/**
 * vod 测试探测端口(010 T026):结构对齐平台 SafeUpstreamPort.read 子面 —— 装配侧
 * (T031)直接传 SAFE_UPSTREAM_PORT 绑定实现,无需适配器;失败抛 RemoteReadFailure
 * 形态(携带稳定 code,见 platform/upstream/safe-upstream-reader)。独立声明仅因
 * application 层 R1 对 platform 的白名单收窄,非另起端口体系。
 */
export interface VodSourceProbePort {
  read(request: VodSourceProbeRequest): Promise<unknown>;
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
  const sessionRow = sourcesStore().findDeviceSession(context.session.id);
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
  const base = {
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
  // 010 T026(api.md §2「现有来源DTO扩kind=vod及capabilities」):仅 kind=vod 附能力字段
  // (005 SourceDto 面向后兼容扩展,010 openapi Source 同形;键集合不受影响)
  if (row.kind === 'vod') {
    return { ...base, capabilities: VOD_SOURCE_CAPABILITIES } as SourceDto;
  }
  return base;
}

/** EPG 关联目标校验:必须同家庭(不存在/跨家庭 404 同形)、kind=epg(400)、非自引用(400);允许目标暂时禁用 */
function resolveEpgTarget(epgSourceId: string, householdId: string, selfSourceId: string | null): void {
  const target = sourcesStore().findMediaSourceById(epgSourceId);
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
  const page = sourcesStore().listMediaSourcePage(context.session.householdId, query.page, query.pageSize);
  return { items: page.rows.map(toSourceDto), total: page.total, page: query.page, pageSize: query.pageSize };
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
  } else if (input.kind === 'vod') {
    // 010 T026(api.md §2「POST kind=vod,name,remoteUrl,adapter=apple-cms-json…201;限10启用源;
    // 新源根URL只接受http(s)并校验」+ data-model §2「vod必须remote_url非空、NAS及EPG绑定为空」):
    // 严格分支 —— 远程必填(400 detail 指向 remoteUrl)、NAS/EPG 绑定字段禁带(400)、
    // adapter 恒为 apple-cms-json(400);目标许可与 IPTV 同一判定面(422 SOURCE_TARGET_DENIED)。
    const candidate = input.remoteUrl ?? '';
    if (candidate === '') {
      throw invalidRequest('vod 来源必须提供 remoteUrl(非空根地址)');
    }
    if (input.rootKey !== undefined || input.relativeDirectory !== undefined) {
      throw invalidRequest('vod 来源不能携带 NAS 绑定字段(rootKey/relativeDirectory)');
    }
    if (input.epgSourceId !== undefined && input.epgSourceId !== null) {
      throw invalidRequest('vod 来源不能携带 EPG 绑定字段(epgSourceId)');
    }
    if (input.adapter !== undefined && input.adapter !== VOD_SUPPORTED_ADAPTER) {
      throw invalidRequest('vod 来源 adapter 仅支持 apple-cms-json');
    }
    const denial = findVodTargetDenial(candidate);
    if (denial !== null) {
      throw createDomainError('SOURCE_TARGET_DENIED', denial);
    }
    remoteUrl = candidate;
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
  return sourcesStore().withTransaction((tx) => {
    // 010 T026 净配额(api.md §2「限10启用源」/data-model §4「事务内按新增净额检查」):
    // 仅计 kind=vod 且启用态;本次创建为启用即占净额,超限 409 VOD_QUOTA_EXCEEDED(不删既有)。
    // 检查在写入前、同事务内执行,并发下由 SQLite 写事务串行化保证不突破。
    if (input.kind === 'vod' && input.enabled) {
      if (tx.countEnabledVodSources(householdId) >= VOD_MAX_ENABLED_SOURCES) {
        throw createDomainError('VOD_QUOTA_EXCEEDED');
      }
    }
    tx.insertMediaSource({
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
    });
    // 010 T026(data-model §2 vod_source_config「一源一行;kind=vod」):适配配置与来源同事务落库
    if (input.kind === 'vod') {
      tx.insertVodSourceConfig({ householdId, sourceId: id, adapter: VOD_SUPPORTED_ADAPTER });
    }
    tx.bumpCatalogRevision(householdId);
    const row = tx.findMediaSourceById(id);
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

  const existing = sourcesStore().findOwnedMediaSource(sourceId, householdId);
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

  // remoteUrl:NAS 禁止;vod 根地址不可 PATCH(010 T026,api.md §2「根地址字段拒绝」400,
  // 禁借旧「换地址须 privateAccessApproved」通路 → 与 IPTV 的 422 语义区分);新地址须通过
  // 目标许可;IPTV/EPG 换地址须同时显式 privateAccessApproved=true(不继承旧目标许可)
  let nextRemoteUrl = existing.remoteUrl;
  if (input.remoteUrl !== undefined) {
    if (existing.kind === 'nas') {
      throw invalidRequest('NAS 来源不能设置远程地址');
    }
    if (existing.kind === 'vod') {
      throw invalidRequest('在线点播来源不允许通过 PATCH 修改根地址(remoteUrl)');
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

  return sourcesStore().withTransaction((tx) => {
    const row = tx.findOwnedMediaSource(sourceId, householdId);
    if (row === undefined) {
      throw notFound();
    }
    if (row.version !== input.expectedVersion) {
      throw createDomainError('SOURCE_VERSION_CONFLICT');
    }
    // 010 T026 净配额(api.md §2「限10启用源」净额口径):vod 停用→启用同样占净额,
    // 事务内检查,超限 409 VOD_QUOTA_EXCEEDED(启用数已满 10 时不得再启用第 11 源)。
    if (row.kind === 'vod' && input.enabled === true && row.enabled !== 1) {
      if (tx.countEnabledVodSources(householdId) >= VOD_MAX_ENABLED_SOURCES) {
        throw createDomainError('VOD_QUOTA_EXCEEDED');
      }
    }
    // 010 T026(data-model §2「启停均locator_revision+1防ABA」):仅 vod 且启用态实际变化
    // 时失效活动 locator;改名不递增(改名不杀流,A5 绿基线),同值启停非状态迁移不失效。
    const enabledChanged = input.enabled !== undefined && (input.enabled ? 1 : 0) !== row.enabled;
    tx.updateOwnedMediaSource(sourceId, householdId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
      ...(input.privateAccessApproved !== undefined
        ? { privateAccessApproved: input.privateAccessApproved ? 1 : 0 }
        : {}),
      remoteUrl: nextRemoteUrl,
      epgSourceId: nextEpgSourceId,
      version: row.version + 1,
      updatedAt: new Date().toISOString(),
    });
    if (row.kind === 'vod' && enabledChanged) {
      tx.incrementLocatorRevision(sourceId, householdId);
    }
    // 旧待确认快照失效(同事务):任务 version 随状态变化加一
    tx.markAwaitingSnapshotsStale(householdId, sourceId);
    tx.bumpCatalogRevision(householdId);
    const fresh = tx.findOwnedMediaSource(sourceId, householdId);
    if (fresh === undefined) {
      throw new Error('来源更新后读取失败');
    }
    return toSourceDto(fresh);
  });
}

/* ------------------------------------------------------------------ */
/* vod 连通性测试(010 T026;api.md §2「POST /settings/sources/:id/test」)  */
/* ------------------------------------------------------------------ */

/** POST /sources/{sourceId}/test 请求体(契约 SourceTestRequest;控制器侧做 zod 严格校验) */
export interface TestSourceInput {
  ownerPassword?: string;
}

/** SourceTestResult(契约 010 openapi components/schemas/SourceTestResult;reason:null|timeout|invalid|unavailable) */
export interface SourceTestResultDto {
  reachable: boolean;
  compatible: boolean;
  capabilities: typeof VOD_SOURCE_CAPABILITIES;
  reason: 'timeout' | 'invalid' | 'unavailable' | null;
}

/**
 * SafeUpstream 稳定失败码 → 契约 reason(不回显上游细节,message 一律不进响应):
 * - 超预算类(总期限/空闲)→ timeout;目标不许可/DNS 不可解析 → invalid;
 * - 传输失败/重定向超限/中止 → unavailable;未知形态防御性归 unavailable。
 */
function reasonOfUpstreamFailure(error: unknown): SourceTestResultDto['reason'] {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  switch (code) {
    case 'SOURCE_IDLE_TIMEOUT':
    case 'SOURCE_BUDGET_EXCEEDED':
      return 'timeout';
    case 'SOURCE_TARGET_DENIED':
    case 'SOURCE_DNS_INVALID':
      return 'invalid';
    default:
      return 'unavailable';
  }
}

/**
 * POST /sources/{sourceId}/test:vod 连通性/兼容性测试(010 T026;api.md §2「Settings+当次密码;
 * 200{reachable,compatible,capabilities,reason},不写媒体;授权错误不能包装为测试结果」):
 * - 判定次序:家长验证(缺失/空串 403 REQUIRED;错误/锁定沿用 verifyParentPassword,直抛
 *   DomainError 不包装)→ 来源归属 404 同形 → 仅 kind=vod 可测(其余 400);
 * - 可达性:SafeUpstream 有界全量读取(许可=LAN_ALLOWED_TARGETS,与刷新面同一口径;
 *   预算=VOD_TEST_PROBE_BUDGETS 8s/4MiB/3 跳,镜像 VOD_SAFE_UPSTREAM_BUDGETS),
 *   失败按稳定码映射 reason;
 * - 兼容性:「adapter 已登记」语义(vod_source_config.adapter=apple-cms-json;T025 解析
 *   联动落地后可收紧为报文级判定,service 面不变);
 * - 纯读:不写任何媒体/目录/来源行(探测失败也不落库)。
 */
export async function testSource(
  sourceId: string,
  context: SessionContext,
  input: TestSourceInput,
  probe: VodSourceProbePort,
): Promise<SourceTestResultDto> {
  await requireParentVerification(context, input.ownerPassword);
  const householdId = context.session.householdId;
  const existing = sourcesStore().findOwnedMediaSource(sourceId, householdId);
  if (existing === undefined) {
    throw notFound();
  }
  if (existing.kind !== 'vod') {
    throw invalidRequest('仅在线点播来源支持连通性测试');
  }
  const compatible = sourcesStore().findVodSourceConfig(householdId, sourceId)?.adapter === VOD_SUPPORTED_ADAPTER;
  try {
    await probe.read({
      url: existing.remoteUrl ?? '',
      allowedTargets: getConfig().LAN_ALLOWED_TARGETS,
      byteBudget: VOD_TEST_PROBE_BUDGETS.maxBytes,
      timeBudgets: {
        totalTimeoutMs: VOD_TEST_PROBE_BUDGETS.totalTimeoutMs,
        idleTimeoutMs: VOD_TEST_PROBE_BUDGETS.idleTimeoutMs,
        maxRedirects: VOD_TEST_PROBE_BUDGETS.maxRedirects,
      },
    });
  } catch (error) {
    return {
      reachable: false,
      compatible,
      capabilities: VOD_SOURCE_CAPABILITIES,
      reason: reasonOfUpstreamFailure(error),
    };
  }
  return {
    reachable: true,
    compatible,
    capabilities: VOD_SOURCE_CAPABILITIES,
    reason: compatible ? null : 'invalid',
  };
}

/* ------------------------------------------------------------------ */
/* vod 来源配置发布端口（010 T028/T031 装配消费）                        */
/* ------------------------------------------------------------------ */

/**
 * vod 来源运行期配置端口（010 T028/T031；online-vod 搜索/预览/物化的
 * VodSourceConfigurationPort 消费面 + 上游定位读取）。
 * 形状与 contexts/online-vod/application/publication-work-set.port.ts 的
 * VodSourceConfigurationPort 结构一致（R2 禁深导入，消费侧以结构相容装配），
 * 另附 findSourceLocator 供上游 URL 构建（私有定位，绝不进入公共 DTO）。
 * 全部为非事务单语句读（自动提交语义）；事务内重验仍走 MaterializeWorkSet.source。
 */
export interface VodSourceRuntimeConfigurationPort {
  /** 读本家庭启用 vod 来源端点（≤10；搜索轮转缓冲输入） */
  listEnabledVodSources(householdId: string): Array<{
    readonly sourceId: string;
    readonly name: string;
    readonly adapter: 'apple-cms-json';
    readonly locatorRevision: number;
  }>;
  /** 配置 CAS 读数：locatorRevision 失配即拒绝旧配置消费（未配置/禁用返回 undefined） */
  readLocatorRevision(householdId: string, sourceId: string): number | undefined;
  /** 读单源适配配置（adapter 判别；未配置返回 undefined；形状 = vod_source_config 行投影） */
  findSourceConfig(
    householdId: string,
    sourceId: string,
  ): { householdId: string; sourceId: string; adapter: string } | undefined;
  /** 读单源私有定位（上游 URL 构建；未配置/禁用返回 undefined，绝不进入公共 DTO） */
  findSourceLocator(householdId: string, sourceId: string): string | undefined;
  /**
   * 按来源 ID 读私有定位（无家庭维度；来源 ID 全局唯一，搜索/详情上游请求只携带
   * sourceId —— T028 VodSearchUpstreamRequest/VodDetailUpstreamRequest 形态）。
   * 仅 kind=vod 且启用返回；绝不进入公共 DTO。
   */
  findSourceLocatorById(sourceId: string): string | undefined;
}

/** 创建 vod 来源运行期配置端口（发布面纯函数；每次调用产出一个无状态读取束） */
export function createVodSourceConfigurationPort(): VodSourceRuntimeConfigurationPort {
  return {
    listEnabledVodSources: (householdId) =>
      sourcesStore()
        .listEnabledVodSourceSnapshots(householdId)
        .map((row) => ({
          sourceId: row.sourceId,
          name: row.name,
          // adapter 由 vod_source_config_adapter_check(CHECK='apple-cms-json')保证
          adapter: row.adapter as 'apple-cms-json',
          locatorRevision: row.locatorRevision,
        })),
    readLocatorRevision: (householdId, sourceId) => {
      const row = sourcesStore().findOwnedMediaSource(sourceId, householdId);
      return row !== undefined && row.kind === 'vod' ? row.locatorRevision : undefined;
    },
    findSourceConfig: (householdId, sourceId) => sourcesStore().findVodSourceConfig(householdId, sourceId),
    findSourceLocator: (householdId, sourceId) => {
      const row = sourcesStore().findOwnedMediaSource(sourceId, householdId);
      return row !== undefined && row.kind === 'vod' && row.enabled === 1 ? (row.remoteUrl ?? undefined) : undefined;
    },
    findSourceLocatorById: (sourceId) => {
      const row = sourcesStore().findMediaSourceById(sourceId);
      return row !== undefined && row.kind === 'vod' && row.enabled === 1 ? (row.remoteUrl ?? undefined) : undefined;
    },
  };
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
  executor: IRefreshExecutorService,
  context: SessionContext,
  sourceId: string,
  input: RequestRefreshBody,
): Promise<RefreshDto> {
  await requireParentVerification(context, input.ownerPassword);
  // 010 T026(任务「禁 vod 旧 refresh」;api.md §2 未定义 vod 刷新面):vod 来源稳定拒绝
  // 目录刷新(400 VALIDATION_FAILED,先于执行器状态机;不存在/跨家庭仍 404 同形)。
  // 判定置于 service 层:执行器状态机零改动,iptv/epg/nas 刷新路径与次序完全不变。
  const sourceRow = sourcesStore().findOwnedMediaSource(sourceId, context.session.householdId);
  if (sourceRow === undefined) {
    throw notFound();
  }
  if (sourceRow.kind === 'vod') {
    throw invalidRequest('在线点播来源不支持目录刷新');
  }
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
  executor: IRefreshExecutorService,
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
  executor: IRefreshExecutorService,
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
  executor: IRefreshExecutorService,
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
