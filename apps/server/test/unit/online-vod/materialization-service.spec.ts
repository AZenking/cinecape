/**
 * 010-online-vod T029:MaterializeWorkSet 服务级单测(真实 DDL + 真实 UNIT_OF_WORK)。
 *
 * 被测:contexts/online-vod/application/materialization.service.ts(+publication.service.ts)。
 *
 * 装配方式(与 T024 契约 rig 同构,但不经 HTTP/Nest):
 * - 独立临时文件库 + 全量权威迁移 DDL(0001～0007,foreign_keys=ON 真实约束)+ 真实
 *   UNIT_OF_WORK(createUnitOfWork + 8 键注册表中本用例消费的 6 键真实参与者);
 * - policy 用 T017 evaluateEffectiveMediaPolicy 真实实现 + 服务端合成父子事实
 *   (effectiveMediaPolicy 端口按组合根形态包装:evaluate = 领域纯函数);
 * - 时钟注入 fixture-world 的 FakeClock(固定 24h 保留/重放不延长可推进验证);
 * - 步骤故障注入复用 T024 已验证的 FixtureStepFailurePlanner + TxStore Proxy 包装手法:
 *   被注入步骤所属上下文参与者的首次触达即抛 FixtureStepFailureError,位于
 *   UnitOfWork.run 的 try 段内 → 整体回滚、连接恢复可用、reset 后同 key 重试成功;
 * - 预览解析(生产由 T028 预览缓存 + T031 装配桥接)以内存 ref→事实表模拟 resolver
 *   (事务外调用;本文件同时断言「成功重放跳过解析」的接口点)。
 *
 * 覆盖清单(对应 T024 行为契约,服务级等价):
 * - 成功路径逐表断言(media_item vod 角色/关系/映射/线路/子项/详情快照/序列/
 *   source_entry/playback_source/operation);
 * - 幂等重放(原结果、零新增、revision 不虚增、24h 不延长、成功重放跳过解析);
 * - 同 key 异摘要 409 IDEMPOTENCY_CONFLICT;
 * - 新 key 预览过期 410 VOD_PREVIEW_EXPIRED(DB 直改快照 expires_at 模拟 TTL 到期);
 * - 新 key 预览修订落后 409 VOD_DETAIL_CHANGED(直改 current_detail_revision);
 * - 重放目标内容/连续性变化 409 VOD_MATERIALIZATION_STALE;
 * - 净配额(收窄注入;复用不占新配额;超额 409 零残留);
 * - FIXTURE_MATERIALIZE_STEP_NAMES 逐步骤故障注入:整体回滚零残留、预分配 ID 不落库、
 *   reset 后同 key 重试 201;
 * - candidateRef 分支:同事务登记 registeredCandidateRef、重放同引用、登记+operation
 *   原子回滚与重试同提交;
 * - 策略拒绝 404(真实 ADR-0006 判定;预分配 ID 不落库)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import {
  createUnitOfWork,
  type TxStoreFactory,
} from '@platform/database/unit-of-work';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createProfileTxReaders } from '@contexts/profile/infrastructure/transaction-participants';
import { createPolicyTxReaders } from '@contexts/policy/infrastructure/transaction-participants';
import { createSourcesTxParticipants } from '@contexts/sources/infrastructure/transaction-participants';
import { createMediaCatalogTxParticipants } from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createOnlineVodTxParticipants } from '@contexts/online-vod/infrastructure/transaction-participants';
import { drizzleOnlineVodStore } from '@contexts/online-vod/infrastructure/online-vod-store.drizzle';
import { evaluateEffectiveMediaPolicy } from '@contexts/policy';
import {
  digestMaterializeCommand,
  materialize,
  type MaterializationContext,
  type MaterializationQuotas,
  type MaterializationServiceDeps,
  type ResolvedMaterializationTarget,
} from '@contexts/online-vod/application/materialization.service';
import type { MaterializeCommand } from '@contexts/online-vod/application/publication-work-set.port';
import {
  FIXTURE_MATERIALIZE_STEP_NAMES,
  createFixtureFakeClock,
  createFixtureStepFailurePlanner,
  type FixtureFakeClock,
  type FixtureMaterializeStepName,
  type FixtureStepFailurePlan,
  type FixtureStepFailurePlanner,
} from '../../fixtures/online-vod/fixture-world';

/* ------------------------------------------------------------------ */
/* 夹具:真实 DDL + 真实事务参与者 + FakeClock                            */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

const CLOCK_START_MS = Date.parse('2026-10-30T08:00:00.000Z');
const HH = 'hh-t029';
const ACCOUNT = 'acc-t029';
const PROFILE = 'prof-main-t029';
const DEVICE = 'dev-t029';
const SESSION = 'sess-t029';
const SOURCE_ID = 'src-vod-t029';
/** 候选分支溯源所需的播放会话(api §7 I1 source session/generation 绑定) */
const SOURCE_SESSION = 'psrc-t029';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 全量权威迁移(与契约 rig 同源;FK ON 下 0007 的 12-step 等价序列逐语句零违反) */
function applyAuthoritativeMigrations(conn: SqliteConnection): void {
  const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const upSqlPath = path.join(migrationsDir, name, 'up.sql');
    expect(fs.existsSync(upSqlPath), `未找到迁移 DDL ${upSqlPath}(须以 apps/server 为工作目录运行)`).toBe(true);
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
  }
}

/** 身份/来源/目录基线事实(真实 DDL 列面;策略默认 adult 18/允许未评级) */
function seedFixture(
  conn: SqliteConnection,
  policy: { maxContentLevel: number; allowUnrated: number },
): void {
  const now = iso(CLOCK_START_MS);
  conn
    .prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)')
    .run(HH, 'T029 夹具家庭', now);
  conn
    .prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(ACCOUNT, HH, 'admin', 'admin', 'hash', 'admin', now);
  conn
    .prepare(
      "INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, created_at) VALUES (?, ?, ?, '主档案', 'adult', 1, 'active', ?)",
    )
    .run(PROFILE, HH, ACCOUNT, now);
  conn
    .prepare("INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, 'web', ?)")
    .run(DEVICE, HH, now);
  conn
    .prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(SESSION, HH, ACCOUNT, DEVICE, 'token-hash', PROFILE, iso(CLOCK_START_MS + 7 * 24 * 3600_000), now, now);
  conn
    .prepare(
      'INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    )
    .run(HH, PROFILE, policy.maxContentLevel, policy.allowUnrated, '[]', '[]', '[]', now);
  conn
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', '夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
    )
    .run(SOURCE_ID, HH, now, now);
  conn
    .prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')")
    .run(HH, SOURCE_ID);
  conn.prepare('INSERT INTO catalog_state (household_id) VALUES (?)').run(HH);
}

/** 候选分支溯源事实:独立锚点媒体 + preparing 播放会话(FK 真实约束) */
function seedCandidateProvenance(conn: SqliteConnection): void {
  const now = iso(CLOCK_START_MS);
  conn
    .prepare(
      "INSERT INTO media_item (id, household_id, type, title, version, created_at, updated_at) VALUES ('media-anchor-t029', ?, 'movie', '锚点影片', 1, ?, ?)",
    )
    .run(HH, now, now);
  conn
    .prepare(
      "INSERT INTO playback_session (id, household_id, device_session_id, device_id, profile_id, media_id, state, generation, version, position_seconds, last_heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'preparing', 1, 1, 0, ?, ?)",
    )
    .run(SOURCE_SESSION, HH, SESSION, DEVICE, PROFILE, 'media-anchor-t029', now, now);
}

/* ----- 解析事实构造(T028 预览缓存的服务级替身;生产由 T031 装配桥接) ----- */

function buildResolvedTarget(overrides?: {
  upstreamVodId?: string;
  episodeKey?: string;
  title?: string;
  parentContentLevel?: number | null;
  episodeContentLevel?: number | null;
}): ResolvedMaterializationTarget {
  const upstreamVodId = overrides?.upstreamVodId ?? 'up-100';
  const episodeKey = overrides?.episodeKey ?? 'ep-01';
  return {
    sourceId: SOURCE_ID,
    upstreamVodId,
    lineKey: 'main',
    episodeKey,
    previewRevision: 1,
    previewExpiresAt: iso(CLOCK_START_MS + 10 * 60_000),
    detail: {
      detailRevision: 1,
      locatorRevision: 1,
      title: overrides?.title ?? '夹具剧集',
      description: '夹具简介',
      parentContentLevel: overrides?.parentContentLevel ?? null,
      payloadDigest: `digest-${upstreamVodId}`,
      validatedPrivatePayload: JSON.stringify({
        kind: 'fixture-detail',
        upstreamVodId,
        entries: [`https://cache.internal/${upstreamVodId}/${episodeKey}/index.m3u8`],
      }),
      fetchedAt: iso(CLOCK_START_MS),
      expiresAt: iso(CLOCK_START_MS + 3600_000),
      lines: [
        {
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [1, 2, 3].map((ordinal) => ({
            episodeKey: `ep-0${ordinal}`,
            label: `第0${ordinal}集`,
            ordinal,
            seasonKey: null,
            sequenceRevision: 1,
            sequenceStatus: 'ordered' as const,
            contentLevel: overrides?.episodeContentLevel ?? null,
            contentVersionState: 'unverified' as const,
            evidenceKind: null,
            evidenceDigest: null,
            schemaVersion: null,
            continuityRevision: null,
            continuitySignature: null,
          })),
        },
      ],
    },
  };
}

/** 单集目标(独立影片:单线单集,type=movie) */
function buildStandaloneTarget(upstreamVodId: string): ResolvedMaterializationTarget {
  const base = buildResolvedTarget({ upstreamVodId, episodeKey: 'main-movie', title: `影片 ${upstreamVodId}` });
  return {
    ...base,
    detail: {
      ...base.detail,
      lines: [
        {
          lineKey: 'main',
          displayName: '正片',
          sortOrder: 1,
          episodes: [{ ...base.detail.lines[0]?.episodes[0], episodeKey: 'main-movie', label: '正片' } as ResolvedMaterializationTarget['detail']['lines'][number]['episodes'][number]],
        },
      ],
    },
  };
}

/* ----- rig 装配 ----- */

interface Rig {
  conn: SqliteConnection;
  deps: MaterializationServiceDeps;
  clock: FixtureFakeClock;
  /** ref → 解析事实(stable 分支按 episodeRef;candidate 分支按 `cand:<candidateRef>`) */
  targets: Map<string, ResolvedMaterializationTarget>;
  /** 事务外解析钩子(生产由 T028 预览缓存 + T031 装配桥接;此处为内存替身) */
  resolveTarget: (command: MaterializeCommand) => Promise<ResolvedMaterializationTarget>;
  resolverCalls: () => number;
  planner: FixtureStepFailurePlanner;
  plans: FixtureStepFailurePlan[];
  armStepFailure: (stepName: FixtureMaterializeStepName) => void;
  disarmStepFailure: () => void;
  context: MaterializationContext;
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];

/** 010 恢复:txStores 键名的字面量联合(具体注册表类型,使 BoundTxStores 与服务绑定面结构相容) */
type TxStoreKey = 'identityAccess' | 'profile' | 'policy' | 'sources' | 'catalog' | 'vod';

/** 步骤名 → 参与者所属 txStores 键(与 T024 契约 rig 同表;首次触达即注入点) */
const STEP_TX_STORE_KEY: Record<FixtureMaterializeStepName, TxStoreKey> = {
  'materialize:idempotent-replay': 'vod',
  'materialize:revalidate-context': 'identityAccess',
  'materialize:allocate-identity': 'catalog',
  'materialize:verify-policy': 'policy',
  'materialize:cas-detail': 'vod',
  'materialize:check-quota': 'vod',
  'materialize:map-resource': 'sources',
  'materialize:record-operation': 'vod',
  'materialize:bump-revision': 'catalog',
  'materialize:commit': 'catalog',
};

// 010 恢复:不注宽 Record<string, TxStoreFactory>,保留各工厂具体返回类型(satisfies 仅校验不展宽)
const BASE_TX_STORES = {
  identityAccess: createIdentityAccessTxReaders,
  profile: createProfileTxReaders,
  policy: createPolicyTxReaders,
  sources: createSourcesTxParticipants,
  catalog: createMediaCatalogTxParticipants,
  vod: createOnlineVodTxParticipants,
} satisfies Record<TxStoreKey, TxStoreFactory>;

/** 步骤故障包装(T024 已验证手法):参与者任一方法首次触达先 enterStep,命中计划即抛 */
function stepFailureProxyFactory(factory: TxStoreFactory, stepName: string, planner: FixtureStepFailurePlanner): TxStoreFactory {
  return (binding) => {
    const store: object = factory(binding) as object;
    return new Proxy(store, {
      get(target, property, _receiver) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          planner.enterStep(stepName);
          return (value as (...innerArgs: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  };
}

function createRig(
  options: {
    policy?: { maxContentLevel: number; allowUnrated: number };
    quotas?: MaterializationQuotas;
    injectedStep?: FixtureMaterializeStepName;
    withCandidateProvenance?: boolean;
  } = {},
): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t029-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  seedFixture(conn, options.policy ?? { maxContentLevel: 18, allowUnrated: 1 });
  if (options.withCandidateProvenance === true) {
    seedCandidateProvenance(conn);
  }
  openRigs.push({ conn, dataDir });

  const plans: FixtureStepFailurePlan[] = [];
  const planner = createFixtureStepFailurePlanner(plans);
  // 010 恢复:具体注册表(spread 保留字面量类型)——createUnitOfWork 泛型据此产出
  // 具名 BoundTxStores,与 MaterializeTxBoundStores 结构相容,无需任何断言桥接
  const txStores: typeof BASE_TX_STORES = { ...BASE_TX_STORES };
  if (options.injectedStep !== undefined) {
    const ownerKey = STEP_TX_STORE_KEY[options.injectedStep];
    const baseFactory = BASE_TX_STORES[ownerKey];
    // 010 恢复:注册表索引访问先收敛 undefined(基线 6 键恒在;缺失即装配错误直接拒绝)
    if (baseFactory === undefined) {
      throw new Error(`T029 rig 基线注册表缺少 ${ownerKey} 工厂`);
    }
    // 故障代理按方法转发、签名不变;经 TxStoreFactory 视图写入目标键
    (txStores as Record<TxStoreKey, TxStoreFactory>)[ownerKey] = stepFailureProxyFactory(
      baseFactory,
      options.injectedStep,
      planner,
    );
  }

  const clock = createFixtureFakeClock({ startMs: CLOCK_START_MS });
  const store = drizzleOnlineVodStore(conn);
  const deps: MaterializationServiceDeps = {
    uow: createUnitOfWork({ resolveDatabase: () => conn, txStores }),
    effectiveMediaPolicy: {
      evaluate: (input) => evaluateEffectiveMediaPolicy(input.policy, input.facts),
    },
    quotas: options.quotas ?? { maxParentTitles: 5000, maxChildEpisodes: 100000 },
    readCatalogRevision: (householdId) =>
      (conn.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
        | { revision: number }
        | undefined)?.revision ?? 1,
    findCommittedOperation: (householdId, deviceSessionId, profileContextVersion, operationKey) =>
      store.findCommittedOperation(householdId, deviceSessionId, profileContextVersion, operationKey),
    nowIso: () => iso(clock.nowMs()),
  };
  const targets = new Map<string, ResolvedMaterializationTarget>();
  let resolverCallCount = 0;
  const resolveTarget = async (command: MaterializeCommand): Promise<ResolvedMaterializationTarget> => {
    resolverCallCount += 1;
    const key = command.kind === 'candidateRef' ? `cand:${command.candidateRef}` : command.episodeRef;
    const target = targets.get(key);
    if (target === undefined) {
      // 伪造/不可达引用:解析层 404 同形(api §0「不存在…按既有404同形」)。
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    return target;
  };

  return {
    conn,
    deps,
    clock,
    targets,
    resolveTarget,
    resolverCalls: () => resolverCallCount,
    planner,
    plans,
    armStepFailure: (stepName) => {
      plans.push({
        stepName,
        occurrence: 1,
        error: { code: 'FIXTURE_STEP_FAILURE', message: `T029 每步故障注入:${stepName}` },
      });
      planner.reset();
    },
    disarmStepFailure: () => {
      plans.splice(0, plans.length);
      planner.reset();
    },
    context: {
      householdId: HH,
      deviceSessionId: SESSION,
      profileId: PROFILE,
      profileContextVersion: 1,
    },
  };
}

afterEach(() => {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    if (rig === undefined) {
      break;
    }
    rig.conn.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 断言辅助                                                             */
/* ------------------------------------------------------------------ */

const stableCommand = (episodeRef: string, operationKey: string = randomUUID(), previewRevision = 1): MaterializeCommand => ({
  kind: 'stableRef',
  titleRef: `vod-title-${episodeRef}`,
  episodeRef,
  previewRevision,
  operationKey,
});

const candidateCommand = (candidateRef: string, operationKey: string = randomUUID(), previewRevision = 1): MaterializeCommand => ({
  kind: 'candidateRef',
  candidateRef,
  previewRevision,
  operationKey,
});

/** 物化副作用全集行数(data-model §2/§4;失败回滚必须逐表归零) */
interface SideEffectState {
  parentMedia: number;
  episodeMedia: number;
  mediaRelation: number;
  vodTitle: number;
  vodLine: number;
  vodEpisode: number;
  vodDetailSnapshot: number;
  vodEpisodeSequence: number;
  sourceEntry: number;
  playbackSourceOnline: number;
  operation: number;
  registeredCandidate: number;
  catalogRevision: number;
}

function countOf(conn: SqliteConnection, sql: string, ...params: readonly unknown[]): number {
  const row = conn.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function sideEffectStateOf(conn: SqliteConnection): SideEffectState {
  return {
    parentMedia: countOf(conn, "SELECT COUNT(*) AS n FROM media_item WHERE media_role = 'vod_title'"),
    episodeMedia: countOf(conn, "SELECT COUNT(*) AS n FROM media_item WHERE media_role = 'vod_episode'"),
    mediaRelation: countOf(conn, 'SELECT COUNT(*) AS n FROM media_relation'),
    vodTitle: countOf(conn, 'SELECT COUNT(*) AS n FROM vod_title'),
    vodLine: countOf(conn, 'SELECT COUNT(*) AS n FROM vod_line'),
    vodEpisode: countOf(conn, 'SELECT COUNT(*) AS n FROM vod_episode'),
    vodDetailSnapshot: countOf(conn, 'SELECT COUNT(*) AS n FROM vod_detail_snapshot'),
    vodEpisodeSequence: countOf(conn, 'SELECT COUNT(*) AS n FROM vod_episode_sequence'),
    sourceEntry: countOf(conn, "SELECT COUNT(*) AS n FROM source_entry WHERE identity_kind = 'vod_episode'"),
    playbackSourceOnline: countOf(conn, "SELECT COUNT(*) AS n FROM playback_source WHERE locator_kind = 'online'"),
    operation: countOf(conn, 'SELECT COUNT(*) AS n FROM vod_materialization_operation'),
    registeredCandidate: countOf(conn, 'SELECT COUNT(*) AS n FROM vod_registered_candidate'),
    catalogRevision: countOf(conn, 'SELECT revision AS n FROM catalog_state WHERE household_id = ?', HH),
  };
}

function expectZeroMaterializationSideEffects(state: SideEffectState, label: string): void {
  expect(state, `${label}:物化副作用全集必须零残留`).toEqual({
    parentMedia: 0,
    episodeMedia: 0,
    mediaRelation: 0,
    vodTitle: 0,
    vodLine: 0,
    vodEpisode: 0,
    vodDetailSnapshot: 0,
    vodEpisodeSequence: 0,
    sourceEntry: 0,
    playbackSourceOnline: 0,
    operation: 0,
    registeredCandidate: 0,
    catalogRevision: 1,
  });
}

function expectDomainError(err: unknown, status: number, code: string): DomainError {
  expect(err).toBeInstanceOf(DomainError);
  const domainError = err as DomainError;
  expect(domainError.status, 'HTTP 状态须与问题码注册表一致').toBe(status);
  expect(domainError.code).toBe(code);
  return domainError;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

describe('T029 · MaterializeWorkSet 成功路径与幂等(api §3 / internal-ports §2)', () => {
  it('首次物化:整片映射+资源+幂等结果+公共 revision 同事务逐表落库(预分配 ID 随提交落库)', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    const before = sideEffectStateOf(rig.conn);
    expect(before.catalogRevision, '夹具基线 catalog_state.revision=1').toBe(1);

    const outcome = await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);

    expect(outcome.replayed).toBe(false);
    expect(outcome.candidateRef).toBeNull();
    expect(outcome.registeredCandidateRef).toBeNull();
    expect(outcome.detailRevision).toBe(1);
    expect(outcome.catalogRevision, '首次物化公共 revision 恰 +1(提交时值)').toBe(2);
    expect(outcome.parentMediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.mediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.mediaId).not.toBe(outcome.parentMediaId);

    const state = sideEffectStateOf(rig.conn);
    expect(state.parentMedia).toBe(1);
    expect(state.episodeMedia).toBe(3);
    expect(state.mediaRelation).toBe(3);
    expect(state.vodTitle).toBe(1);
    expect(state.vodLine).toBe(1);
    expect(state.vodEpisode).toBe(3);
    expect(state.vodDetailSnapshot).toBe(1);
    expect(state.vodEpisodeSequence).toBe(3);
    expect(state.sourceEntry).toBe(3);
    expect(state.playbackSourceOnline).toBe(3);
    expect(state.operation).toBe(1);
    expect(state.registeredCandidate).toBe(0);
    expect(state.catalogRevision).toBe(2);

    const title = rig.conn.prepare('SELECT * FROM vod_title').get() as {
      source_id: string;
      upstream_vod_id: string;
      parent_media_id: string;
      current_detail_revision: number;
      materialized_at: string;
    };
    expect(title.source_id).toBe(SOURCE_ID);
    expect(title.upstream_vod_id).toBe('up-100');
    expect(title.parent_media_id).toBe(outcome.parentMediaId);
    expect(title.current_detail_revision).toBe(1);
    expect(title.materialized_at).toBe(iso(CLOCK_START_MS));

    const operation = rig.conn.prepare('SELECT * FROM vod_materialization_operation').get() as {
      committed_at: string | null;
      expires_at: string;
      detail_revision: number;
      catalog_revision: number;
      request_digest: string;
      result: string;
    };
    expect(operation.committed_at).toBe(iso(CLOCK_START_MS));
    expect(operation.expires_at, '固定 24h 保留(committed+24h)').toBe(iso(CLOCK_START_MS + 24 * 3600_000));
    expect(operation.detail_revision).toBe(1);
    expect(operation.catalog_revision).toBe(2);
    expect(operation.request_digest).toBe(digestMaterializeCommand(stableCommand('ep-01')));
    expect(JSON.parse(operation.result) as Record<string, unknown>).toEqual({
      ...outcome,
      replayed: false,
    });

    const entry = rig.conn
      .prepare("SELECT identity_digest FROM source_entry WHERE identity_kind = 'vod_episode' LIMIT 1")
      .get() as { identity_digest: string };
    expect(entry.identity_digest, '身份摘要=64 位十六进制(不含 URL)').toMatch(/^[0-9a-f]{64}$/);
    const resource = rig.conn.prepare('SELECT * FROM playback_source LIMIT 1').get() as {
      locator_kind: string;
      protocol: string;
      location: string | null;
      requires_proxy: number;
      vod_episode_id: string | null;
    };
    expect(resource.locator_kind).toBe('online');
    expect(resource.protocol).toBe('hls');
    expect(resource.location, '在线分支地址私有(location 为空)').toBeNull();
    expect(resource.requires_proxy).toBe(1);
    expect(resource.vod_episode_id).not.toBeNull();
  });

  it('同 key 重放:200 形原结果(replayed=true)逐字段一致;零新增、revision 不虚增、24h 不延长、不再解析预览', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    const key = randomUUID();
    const first = await materialize(rig.deps, stableCommand('ep-01', key), rig.context, rig.resolveTarget);
    const afterFirst = sideEffectStateOf(rig.conn);
    expect(rig.resolverCalls()).toBe(1);

    // 010 恢复:advanceMs 为 Promise,须 await(eslint no-floating-promises)
    await rig.clock.advanceMs(3600_000);
    const replay = await materialize(rig.deps, stableCommand('ep-01', key), rig.context, rig.resolveTarget);

    expect(replay.replayed).toBe(true);
    expect({ ...replay, replayed: undefined }).toEqual({ ...first, replayed: undefined });
    expect(rig.resolverCalls(), '成功重放优先于预览 TTL:不再触碰预览缓存解析').toBe(1);
    expect(sideEffectStateOf(rig.conn)).toEqual(afterFirst);

    // 重放不延长:推进到保留期末段再重放,operation 行保持原 committed/expires。
    // 010 恢复:advanceMs 为 Promise,须 await(eslint no-floating-promises)
    await rig.clock.advanceMs(22 * 3600_000);
    const lateReplay = await materialize(rig.deps, stableCommand('ep-01', key), rig.context, rig.resolveTarget);
    expect(lateReplay.replayed).toBe(true);
    const operation = rig.conn.prepare('SELECT committed_at, expires_at FROM vod_materialization_operation').get() as {
      committed_at: string;
      expires_at: string;
    };
    expect(operation.committed_at).toBe(iso(CLOCK_START_MS));
    expect(operation.expires_at, '重放绝不延长固定 24h 保留').toBe(iso(CLOCK_START_MS + 24 * 3600_000));
    expect(sideEffectStateOf(rig.conn)).toEqual(afterFirst);
  });

  it('同 key 异载荷:409 IDEMPOTENCY_CONFLICT 且零新增(同 key 结果固定)', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    rig.targets.set('ep-02', buildResolvedTarget({ episodeKey: 'ep-02' }));
    const key = randomUUID();
    await materialize(rig.deps, stableCommand('ep-01', key), rig.context, rig.resolveTarget);
    const before = sideEffectStateOf(rig.conn);

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('ep-02', key), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 409, ProblemCode.IDEMPOTENCY_CONFLICT);
    expect(sideEffectStateOf(rig.conn), '冲突路径零新增(不重算/不建资源)').toEqual(before);
  });
});

describe('T029 · 预览/配置/详情 CAS 与 STALE(api §3 顺序)', () => {
  it('新 key + 当前详情快照过期(DB 直改 expires_at 模拟 TTL 到期):410 VOD_PREVIEW_EXPIRED 且零新增', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    const before = sideEffectStateOf(rig.conn);
    // 010 恢复:直改 expires_at 须满足 DDL CHECK(expires_at > fetched_at),
    // 故 fetched_at 同步平移到过去(保持「快照存在但已过期」的被测语义不变)
    rig.conn
      .prepare('UPDATE vod_detail_snapshot SET fetched_at = ?, expires_at = ? WHERE household_id = ?')
      .run('2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z', HH);

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 410, ProblemCode.VOD_PREVIEW_EXPIRED);
    expect(sideEffectStateOf(rig.conn)).toEqual(before);
  });

  it('新 key + 预览修订落后(DB 直改 current_detail_revision+1 模拟他人发布新详情):409 VOD_DETAIL_CHANGED', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    const before = sideEffectStateOf(rig.conn);
    rig.conn.prepare('UPDATE vod_title SET current_detail_revision = current_detail_revision + 1').run();

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 409, ProblemCode.VOD_DETAIL_CHANGED);
    expect(sideEffectStateOf(rig.conn), '预览变更拒绝零新增(不得用过期修订覆盖)').toEqual(before);
  });

  it('旧结果目标内容/连续性变化:同 key 重放 409 VOD_MATERIALIZATION_STALE(已提交重放仍检查当前资源)', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    const key = randomUUID();
    await materialize(rig.deps, stableCommand('ep-01', key), rig.context, rig.resolveTarget);

    // DB 直改注明:目标内容替换 + 连续性修订推进(data-model §3 语义)
    rig.conn.prepare("UPDATE media_item SET content_revision = content_revision + 1 WHERE media_role = 'vod_episode'").run();
    rig.conn.prepare('UPDATE vod_episode SET continuity_revision = continuity_revision + 1').run();

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('ep-01', key), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 409, ProblemCode.VOD_MATERIALIZATION_STALE);
  });

  it('配置 CAS:来源 locatorRevision 与预览基线失配(直改 locator_revision 模拟启停 ABA)→ 410 拒绝旧预览', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    rig.conn.prepare('UPDATE media_source SET locator_revision = 2 WHERE id = ?').run(SOURCE_ID);

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 410, ProblemCode.VOD_PREVIEW_EXPIRED);
    expectZeroMaterializationSideEffects(sideEffectStateOf(rig.conn), '配置失配拒绝');
  });
});

describe('T029 · 净配额与目录 revision(data-model §4/§3)', () => {
  it('净配额收窄:新目标占满后 409 VOD_QUOTA_EXCEEDED 零残留;同目标异 key 复用不占新配额、revision 不虚增', async () => {
    const rig = createRig({ quotas: { maxParentTitles: 2, maxChildEpisodes: 100000 } });
    rig.targets.set('ep-01', buildResolvedTarget());
    rig.targets.set('movie-a', buildStandaloneTarget('up-200'));
    rig.targets.set('movie-b', buildStandaloneTarget('up-300'));

    const first = await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    expect(first.catalogRevision).toBe(2);
    const second = await materialize(rig.deps, stableCommand('movie-a'), rig.context, rig.resolveTarget);
    expect(second.catalogRevision).toBe(3);
    const beforeFull = sideEffectStateOf(rig.conn);

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('movie-b'), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 409, ProblemCode.VOD_QUOTA_EXCEEDED);
    expect(sideEffectStateOf(rig.conn), '满额拒绝零残留(不删历史/不挤占)').toEqual(beforeFull);

    // 复用已有映射不要求新媒体配额:异 key 同目标 201,revision/detail 不虚增。
    const reuse = await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    expect(reuse.replayed).toBe(false);
    expect(reuse.parentMediaId).toBe(first.parentMediaId);
    expect(reuse.mediaId).toBe(first.mediaId);
    expect(reuse.detailRevision).toBe(first.detailRevision);
    // 010 恢复:revision 为「提交时值」——movie-a 已合法 +1 至 3,复用不虚增即
    // 保持当前 committed revision(second 的 3)而非回退到 first 的 2
    expect(reuse.catalogRevision, '复用无公开变化,revision 不虚增').toBe(second.catalogRevision);
    const afterReuse = sideEffectStateOf(rig.conn);
    expect(afterReuse.vodTitle).toBe(2);
    expect(afterReuse.operation, '新 key 记录新 operation').toBe(3);
    expect(afterReuse.vodDetailSnapshot, '同修订快照复用不重复发布').toBe(2);
  });
});

describe('T029 · 目标策略(T017 evaluateEffectiveMediaPolicy 真实判定)', () => {
  it('父子等级超限:404 且预分配 ID 不落库(策略拒绝不留任何痕迹)', async () => {
    const rig = createRig({ policy: { maxContentLevel: 0, allowUnrated: 0 } });
    rig.targets.set('ep-01', buildResolvedTarget({ parentContentLevel: 5, episodeContentLevel: 5 }));

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 404, ProblemCode.NOT_FOUND);
    expectZeroMaterializationSideEffects(sideEffectStateOf(rig.conn), '策略拒绝');
  });

  it('策略缺失(503)优先于任何写入;策略允许时正常物化', async () => {
    const rig = createRig();
    rig.targets.set('ep-01', buildResolvedTarget());
    rig.conn.prepare('DELETE FROM profile_policy').run();

    let surfaced: unknown;
    try {
      await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expectDomainError(surfaced, 503, ProblemCode.POLICY_UNAVAILABLE);
    expectZeroMaterializationSideEffects(sideEffectStateOf(rig.conn), '策略缺失拒绝');
  });
});

describe('T029 · 每步故障回滚(FIXTURE_MATERIALIZE_STEP_NAMES 逐步注入)', () => {
  for (const stepName of FIXTURE_MATERIALIZE_STEP_NAMES) {
    it(`C·${stepName} 第 1 次失败 → FixtureStepFailureError + 零残留;reset 后同 key 重试成功`, async () => {
      const rig = createRig({ injectedStep: stepName });
      rig.targets.set('ep-01', buildResolvedTarget());
      const key = randomUUID();
      const command = stableCommand('ep-01', key);
      const before = sideEffectStateOf(rig.conn);

      rig.armStepFailure(stepName);
      let surfaced: unknown;
      try {
        await materialize(rig.deps, command, rig.context, rig.resolveTarget);
      } catch (err) {
        surfaced = err;
      }
      expect(surfaced, `注入步骤 ${stepName} 应抛 FixtureStepFailureError`).toBeTruthy();
      expect((surfaced as { stepName?: string }).stepName).toBe(stepName);
      expect(rig.planner.stepExecutedCount(stepName), `注入步骤 ${stepName} 应恰好进入 1 次`).toBe(1);
      // 零残留同时覆盖「预分配 ID 不落库」:映射/资源前的步骤失败(media_item vod 角色=0)
      // 与其后失败一样,全部写入随事务回滚(internal-ports §2 首次 ID 只内存预分配)。
      expectZeroMaterializationSideEffects(sideEffectStateOf(rig.conn), `step ${stepName} 失败回滚后`);

      rig.disarmStepFailure();
      const retried = await materialize(rig.deps, command, rig.context, rig.resolveTarget);
      expect(retried.replayed).toBe(false);
      expect(retried.catalogRevision, '重试恰一次完整物化(revision 恰 +1)').toBe(before.catalogRevision + 1);
      const after = sideEffectStateOf(rig.conn);
      expect(after.vodTitle).toBe(1);
      expect(after.operation).toBe(1);
      expect(after.catalogRevision).toBe(before.catalogRevision + 1);
    });
  }
});

describe('T029 · candidateRef 分支(api §7 I1 同事务登记)', () => {
  it('候选分支:同目标复用稳定映射;registeredCandidateRef 非空不可解码;登记映射与 operation 同事务;重放同引用不重复登记', async () => {
    const rig = createRig({ withCandidateProvenance: true });
    rig.targets.set('ep-01', buildResolvedTarget());
    rig.targets.set('cand:cand-1', { ...buildResolvedTarget(), candidate: { sourceSessionId: SOURCE_SESSION, sourceGeneration: 1 } });

    const stable = await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    expect(stable.registeredCandidateRef).toBeNull();

    const candidate = await materialize(rig.deps, candidateCommand('cand-1'), rig.context, rig.resolveTarget);
    expect(candidate.candidateRef).toBe('cand-1');
    expect(candidate.registeredCandidateRef, '候选分支返回登记引用').toBeTruthy();
    expect(candidate.registeredCandidateRef?.startsWith('vod-reg-'), '登记引用为不透明 ref').toBe(true);
    expect(candidate.registeredCandidateRef?.includes('up-100'), '登记引用不得编码上游键').toBe(false);
    expect(candidate.parentMediaId, '同目标复用稳定映射').toBe(stable.parentMediaId);
    expect(candidate.mediaId).toBe(stable.mediaId);
    expect(sideEffectStateOf(rig.conn).registeredCandidate).toBe(1);

    const registration = rig.conn.prepare('SELECT * FROM vod_registered_candidate').get() as {
      registered_candidate_ref: string;
      candidate_ref: string;
      source_session_id: string;
      source_generation: number;
      preview_revision: number;
      target_media_id: string;
      materialization_operation_id: string;
      expires_at: string;
      created_at: string;
    };
    expect(registration.registered_candidate_ref).toBe(candidate.registeredCandidateRef);
    expect(registration.candidate_ref).toBe('cand-1');
    expect(registration.source_session_id).toBe(SOURCE_SESSION);
    expect(registration.source_generation).toBe(1);
    expect(registration.preview_revision).toBe(1);
    expect(registration.target_media_id).toBe(stable.mediaId);
    expect(registration.created_at).toBe(iso(CLOCK_START_MS));
    expect(registration.expires_at, '登记映射至少 24h 保护').toBe(iso(CLOCK_START_MS + 24 * 3600_000));
    const joinedOperation = rig.conn
      .prepare(
        'SELECT o.committed_at FROM vod_registered_candidate c JOIN vod_materialization_operation o ON o.household_id = c.household_id AND o.id = c.materialization_operation_id WHERE c.household_id = ?',
      )
      .get(HH) as { committed_at: string | null } | undefined;
    expect(joinedOperation?.committed_at, '登记映射外键恰指向本次已提交 operation(同 commit)').toBe(iso(CLOCK_START_MS));

    // 丢响应后同 key 原样重试:重放同引用,不重复登记。
    const candidateKey = randomUUID();
    const firstCandidate = await materialize(rig.deps, candidateCommand('cand-1', candidateKey), rig.context, rig.resolveTarget);
    const before = sideEffectStateOf(rig.conn);
    const candidateReplay = await materialize(rig.deps, candidateCommand('cand-1', candidateKey), rig.context, rig.resolveTarget);
    expect(candidateReplay.replayed).toBe(true);
    expect(candidateReplay.registeredCandidateRef).toBe(firstCandidate.registeredCandidateRef);
    expect(sideEffectStateOf(rig.conn), '重放不重复登记').toEqual(before);
  });

  it('登记映射原子性:record-operation 注入失败 → registered_candidate 与新 operation 均无;reset 后重试两行同提交', async () => {
    const rig = createRig({ injectedStep: 'materialize:record-operation', withCandidateProvenance: true });
    rig.targets.set('movie-a', buildStandaloneTarget('up-200'));
    rig.targets.set('cand:cand-1', {
      ...buildStandaloneTarget('up-200'),
      candidate: { sourceSessionId: SOURCE_SESSION, sourceGeneration: 2 },
    });

    // 注入前(计划为空):普通分支成功(010 恢复:回执值本用例不消费,直接 await)
    await materialize(rig.deps, stableCommand('movie-a'), rig.context, rig.resolveTarget);
    const stableState = sideEffectStateOf(rig.conn);
    expect(stableState.operation).toBe(1);
    expect(stableState.registeredCandidate).toBe(0);

    rig.armStepFailure('materialize:record-operation');
    let surfaced: unknown;
    try {
      await materialize(rig.deps, candidateCommand('cand-1'), rig.context, rig.resolveTarget);
    } catch (err) {
      surfaced = err;
    }
    expect((surfaced as { stepName?: string }).stepName).toBe('materialize:record-operation');
    const failedState = sideEffectStateOf(rig.conn);
    expect(failedState.registeredCandidate, '登记映射必须整体回滚').toBe(0);
    expect(failedState.operation, 'operation 结果必须整体回滚(无新增)').toBe(stableState.operation);

    rig.disarmStepFailure();
    const retried = await materialize(rig.deps, candidateCommand('cand-1'), rig.context, rig.resolveTarget);
    expect(retried.registeredCandidateRef).toBeTruthy();
    const joined = countOf(
      rig.conn,
      'SELECT COUNT(*) AS n FROM vod_registered_candidate c JOIN vod_materialization_operation o ON o.household_id = c.household_id AND o.id = c.materialization_operation_id WHERE c.household_id = ?',
      HH,
    );
    expect(joined, '重试登记行与本次 operation 外键互指(同 commit)').toBe(1);
  });
});

