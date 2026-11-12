import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ProblemCode } from '@hmp/shared';
import { AppModule } from '../../src/app.module';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import { mediaItem, mediaSource, playbackSession, vodSourceConfig } from '@platform/database/schema';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import {
  clearVodMaterializationTargets,
  registerVodMaterializationTarget,
} from '@contexts/online-vod/interface/materialization.controller';
import type { ResolvedMaterializationTarget } from '@contexts/online-vod/application/materialization.service';
import {
  UNIT_OF_WORK,
  createUnitOfWork,
  type TxStoreFactory,
  type TxStoresRegistry,
} from '@platform/database/unit-of-work';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createProfileTxReaders } from '@contexts/profile/infrastructure/transaction-participants';
import { createPolicyTxReaders } from '@contexts/policy/infrastructure/transaction-participants';
import { createSourcesTxParticipants } from '@contexts/sources/infrastructure/transaction-participants';
import { createMediaCatalogTxParticipants } from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createOnlineVodTxParticipants } from '@contexts/online-vod/infrastructure/transaction-participants';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
import {
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
  type TestRig,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';
import {
  FIXTURE_MATERIALIZE_STEP_NAMES,
  FIXTURE_TITLE_KEYS,
  createFixtureStepFailurePlanner,
  type FixtureMaterializeStepName,
  type FixtureStepFailurePlan,
  type FixtureStepFailurePlanner,
} from '../fixtures/online-vod/fixture-world';

/**
 * T024(010-online-vod · US1,测试先行):物化契约 e2e —— POST /api/vod/materializations
 * 的每步故障回滚、预分配 ID 策略拒绝、净配额并发、异 key 目标复用、同 key 异摘要冲突、
 * 成功重放优先于预览 TTL、24h 目标保护和目录 revision 不虚增;审查补充:candidateRef
 * 首次物化、丢响应/过期重放、登记映射与结果原子回滚。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §3(物化接口表 + 幂等段:先查成功重放 →
 *   预览有效 → 同 key 异摘要 409 IDEMPOTENCY_CONFLICT → 新操作预览变化 409
 *   VOD_DETAIL_CHANGED → 过期 410 VOD_PREVIEW_EXPIRED → 满额 409 VOD_QUOTA_EXCEEDED →
 *   旧结果内容变化 409 VOD_MATERIALIZATION_STALE;幂等 scope=家庭/DeviceSession/
 *   contextVersion;目标 24h 受回收保护)与 §7 I1(candidateRef 分支/registeredCandidateRef;
 *   登记映射与 operation 同事务提交;候选绑定冲突 404、过期 410、修订改变 409);
 * - docs/specs/010-online-vod/contracts/internal-ports.md §2(MaterializeWorkSet 步骤顺序:
 *   幂等已提交恢复 → 重验上下文 → 预分配稳定身份 → 目标策略 → 预览/配置/详情 CAS →
 *   净配额 → 完整映射/资源 → 幂等结果 → 公共 revision;步骤名即本文件故障注入点命名)与
 *   §5(RegisteredCandidateParticipant 登记映射+operation 结果同事务);
 * - docs/specs/010-online-vod/data-model.md §4(净配额并发不突破、24h 固定保留、
 *   先过期幂等再引用图清理、新 key 复用已有映射不要求新配额)与 §10 I1
 *   (vod_registered_candidate 与 operation 同事务,至少 24h 保护);
 * - docs/specs/010-online-vod/tasks.md T024 条目(依赖 T021 已落地,本文件只写测试不实现)。
 *
 * 装配方式(沿用 T021 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - 常规用例:startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威 DDL,含 0007_online_vod)
 *   + initialize/login/selectMainAndUnlockSettings 身份 seed + Supertest 真实 HTTP;
 * - 故障注入用例(C/D2):本文件本地复刻 boot 装配并以 Nest TestingModule
 *   overrideProvider(UNIT_OF_WORK) 覆盖 txStores 对应键(仅 override,不改 app.module.ts):
 *   被覆盖键的 TxStore 以 Proxy 包装 —— 参与者方法首次被工作集触达时经
 *   planner.enterStep(步骤名) 抛 FixtureStepFailureError。抛点位于 UnitOfWork.run 的
 *   try 段内(callback/工作集执行期),因此失败按 T008 契约整体 ROLLBACK、连接恢复可用,
 *   同 key 重试(reset 后)可成功 —— 这是「回滚后可恢复」契约本身的要求;
 * - 注入粒度说明:TxStore 参与者在每次 run 的 BEGIN 后统一构造(internal-ports §2),
 *   当前可注入 seam 为「该步骤所属上下文参与者的首次触达点」(事务内、早于具名步骤的
 *   精确执行点);失败语义(整体回滚/零副作用/稳定码/步骤名轨迹/occurrence 计数)已按
 *   FIXTURE_MATERIALIZE_STEP_NAMES 就位,不依赖 T029 的内部编排形态;
 * - DB 直改仅用于无 HTTP 语义的工厂事实(预览/详情过期、详情修订推进、目标内容/连续性
 *   变化、operation/登记候选过期、清空当前档案),逐处注明,与 T021 rig 口径一致;
 * - 配额收窄经 env 注入:B1/B2 以 VOD_MAX_PARENT_TITLES 收窄父项净配额到极小值
 *   (vod-config.ts loadVodRuntimeConfig 只允许收紧;现读 process.env,zod env override
 *   不透传未知键,故直接注入 process.env 并在 finally 恢复);
 * - T031 登记桥接线(设计内合法形态;materialization.controller 文件头已声明):
 *   本文件 A–D 组使用合成 ref(不经 T028 预览缓存签发),resolveStableTarget 对
 *   缓存未命中 ref 走登记注册表(生产装配零注册)。物化前以 registerVodMaterializationTarget
 *   直种与用例数据一致的稳定目标(titleRef/episodeRef → ResolvedMaterializationTarget,
 *   含 detail 事实;来源行为 DB 直插工厂事实)与候选目标(D 组 candidateRef 分支,
 *   含服务端绑定溯源),cleanupAllRigs 统一 clearVodMaterializationTargets。注册表
 *   随测试文件进程隔离无串扰;登记目标仍受事务内 CAS/策略/配额全量重验,不构成授权旁路。
 *
 * ───────────────────────── 计划内红清单(失败不跳过)─────────────────────────
 * T024 为测试先行任务:「POST /api/vod/materializations」路由与 MaterializeWorkSet 应用
 * 用例尚未装配(T029 materialization.service/publication.service + T031
 * materialization.controller 装配)。以下用例钉 010 契约目标面,当前失败原因一律为
 * 「路由 404(Nest Cannot POST 缺省形态,problem+json NOT_FOUND)」:
 *
 * | 用例组 | 用例                                                        | 当前失败形态       | 转绿任务 |
 * | ------ | ----------------------------------------------------------- | ------------------ | -------- |
 * | A1–A8  | 首次 201/重放 200/异摘要 409/异 key 复用/重放优先 TTL/410/409 | 404 路由未装配     | T029+T031(请求 ref 装配另需 T022/T026/T028 提供真实 opaque ref 链) |
 * | B1–B3  | 净配额并发/24h 目标保护/目录 revision 不虚增                  | 404 路由未装配     | T029+T031 |
 * | C·×10  | FIXTURE_MATERIALIZE_STEP_NAMES 逐步骤故障回滚                 | 404 路由未装配     | T029+T031 |
 * | D1–D3  | candidateRef 首次物化/登记映射原子回滚/伪造与过期候选          | 404 路由未装配     | T029+T031(候选 ref 签发贯通另需 T070 候选发布) |
 *
 * E 组(授权负向封套)为绿:对「路由未装配窗口」采用可自收紧的封套断言 ——
 * 非 2xx 非 5xx + problem+json + no-store;404 分支钉死「Nest 缺省形状(NOT_FOUND +
 * detail 以 Cannot POST 开头)」,T031 装配后同路径不再产生路由级 404,该分支自动不可达,
 * 断言即收紧为精确码(游客 401 SESSION_INVALID/无 Profile 403 ACTIVE_PROFILE_REQUIRED/
 * 伪造身份字段 400 VALIDATION_FAILED)。
 *
 * 预期计数:红 24(A 8 + B 3 + C 10 + D 3)/ 绿 3(E 组);两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

const MATERIALIZE_PATH = '/api/vod/materializations';

/** 计划内红统一标注(转绿任务:T029 物化应用用例 + T031 控制器装配) */
function redLabel(target: string, current: string): string {
  return (
    `计划内红(待 T029+T031 转绿):POST ${MATERIALIZE_PATH} 尚未装配(当前 ${current});` +
    `MaterializeWorkSet(T029)+materialization.controller(T031)落地后应 ${target}`
  );
}

/** Materialized DTO(api.md §1 / openapi Materialized:additionalProperties:false) */
interface MaterializedDto {
  parentMediaId: string;
  mediaId: string;
  detailRevision: number;
  catalogRevision: number;
  replayed: boolean;
  candidateRef: string | null;
  registeredCandidateRef: string | null;
}

const MATERIALIZED_DTO_KEYS = [
  'candidateRef',
  'catalogRevision',
  'detailRevision',
  'mediaId',
  'parentMediaId',
  'replayed',
  'registeredCandidateRef',
] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 夹具目标(占位 opaque ref:形状合法、不解析上游键;转绿时经 T022/T028 预览链取真实 ref) */
interface FixtureTarget {
  readonly titleRef: string;
  readonly episodeRef: string;
}

const TARGET_SERIAL_EP01: FixtureTarget = {
  titleRef: `vod-title-${FIXTURE_TITLE_KEYS.threeEpisodeSerial}`,
  episodeRef: `vod-episode-${FIXTURE_TITLE_KEYS.threeEpisodeSerial}-main-01`,
};
const TARGET_SERIAL_EP02: FixtureTarget = {
  titleRef: `vod-title-${FIXTURE_TITLE_KEYS.threeEpisodeSerial}`,
  episodeRef: `vod-episode-${FIXTURE_TITLE_KEYS.threeEpisodeSerial}-main-02`,
};
const TARGET_THEATRICAL: FixtureTarget = {
  titleRef: `vod-title-${FIXTURE_TITLE_KEYS.echoTheatrical}`,
  episodeRef: `vod-episode-${FIXTURE_TITLE_KEYS.echoTheatrical}-main-movie`,
};
const TARGET_GAPPED_EP01: FixtureTarget = {
  titleRef: `vod-title-${FIXTURE_TITLE_KEYS.gappedDuplicateSeries}`,
  episodeRef: `vod-episode-${FIXTURE_TITLE_KEYS.gappedDuplicateSeries}-main-01`,
};
const TARGET_DIRECTORS_CUT: FixtureTarget = {
  titleRef: `vod-title-${FIXTURE_TITLE_KEYS.echoDirectorsCut}`,
  episodeRef: `vod-episode-${FIXTURE_TITLE_KEYS.echoDirectorsCut}-main-movie`,
};

/** 占位候选引用(I1:服务端签发的不透明候选引用;转绿贯通需 T070 签发链) */
const FORGED_CANDIDATE_REF_A = `vod-candidate-forged-${randomUUID()}`;
const FORGED_CANDIDATE_REF_B = `vod-candidate-forged-${randomUUID()}`;

function stableRefBody(target: FixtureTarget, operationKey: string = randomUUID(), previewRevision = 1): Record<string, unknown> {
  return { titleRef: target.titleRef, episodeRef: target.episodeRef, previewRevision, operationKey };
}

function candidateBody(candidateRef: string, operationKey: string = randomUUID(), previewRevision = 1): Record<string, unknown> {
  return { candidateRef, previewRevision, operationKey };
}

function postMaterialize(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(MATERIALIZE_PATH).set('Cookie', cookie).send(body);
}

function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/* ------------------------------------------------------------------ */
/* T031 登记桥接线(rig 直种合法物化目标;设计内形态,见文件头说明)      */
/* ------------------------------------------------------------------ */

/**
 * kind=vod 来源行(media_source + vod_source_config 一源一行;DB 直插工厂事实,
 * 对齐 online-vod-catalog.e2e seedVodSourceRow 口径)。
 * 物化事务内 CAS 要求目标来源为本家庭启用 vod 来源(locator_revision=1),
 * 登记目标的 detail.locatorRevision 必须与之同值。
 */
function seedFixtureVodSource(householdId: string): string {
  const sourceId = `vod-src-${randomUUID()}`;
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({
        id: sourceId,
        householdId,
        kind: 'vod',
        name: '夹具在线片源(物化 rig)',
        remoteUrl: 'http://cms.fixture.invalid/api.php?ac=list',
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(vodSourceConfig).values({ householdId, sourceId, adapter: 'apple-cms-json' }).run();
  });
  return sourceId;
}

/** 登记目标预览 TTL 基准(用例窗口内恒未来;既有目标快照过期不再拦截物化) */
function fixturePreviewExpiresAt(): string {
  return new Date(Date.now() + 3600_000).toISOString();
}

/** 夹具登记目标构建(T031 登记桥;事实与 TARGET_* 用例数据一致,LocatorRevision=1) */
function fixtureTarget(input: {
  readonly sourceId: string;
  readonly upstreamVodId: string;
  readonly episodeKey: string;
  readonly title: string;
  readonly totalEpisodes: number;
  readonly candidateRef?: string;
}): ResolvedMaterializationTarget {
  const episodes = Array.from({ length: input.totalEpisodes }, (_unused, index) => ({
    episodeKey: input.totalEpisodes === 1 ? input.episodeKey : String(index + 1).padStart(2, '0'),
    label: input.totalEpisodes === 1 ? '正片' : `第${String(index + 1).padStart(2, '0')}集`,
    ordinal: index + 1,
    seasonKey: null,
    sequenceRevision: 1,
    sequenceStatus: 'ordered' as const,
    contentLevel: null,
    contentVersionState: 'unverified' as const,
    evidenceKind: null,
    evidenceDigest: null,
    schemaVersion: null,
    continuityRevision: null,
    continuitySignature: null,
  }));
  return {
    sourceId: input.sourceId,
    upstreamVodId: input.upstreamVodId,
    lineKey: 'main',
    episodeKey: input.episodeKey,
    previewRevision: 1,
    previewExpiresAt: fixturePreviewExpiresAt(),
    detail: {
      detailRevision: 1,
      locatorRevision: 1,
      title: input.title,
      description: null,
      parentContentLevel: null,
      payloadDigest: `fixture-digest-${input.upstreamVodId}`,
      validatedPrivatePayload: JSON.stringify({ kind: 'fixture-materialization-target', upstreamVodId: input.upstreamVodId }),
      fetchedAt: new Date().toISOString(),
      expiresAt: fixturePreviewExpiresAt(),
      lines: [{ lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes }],
    },
  };
}

/**
 * T031 登记桥直种(设计内合法形态;materialization.controller 文件头已声明):
 * A–C/D 组的合成 ref 不经预览缓存签发,物化前按用例数据直种稳定目标 —— 生产装配
 * 零注册;登记目标仍受事务内 CAS/策略/配额全量重验,不构成授权旁路。
 * 五个 TARGET_* 各映射独立 (sourceId, upstreamVodId) 稳定键,episodeKey 与
 * TARGET_*.episodeRef 的 `-main-<key>` 后缀一致。
 */
function registerFixtureStableTargets(sourceId: string): void {
  const stable = (titleRef: string, episodeRef: string, target: ResolvedMaterializationTarget): void =>
    registerVodMaterializationTarget({ ...target, titleRef, episodeRef });
  stable(
    TARGET_SERIAL_EP01.titleRef,
    TARGET_SERIAL_EP01.episodeRef,
    fixtureTarget({ sourceId, upstreamVodId: '3001', episodeKey: '01', title: 'fixture·登记三集剧', totalEpisodes: 2 }),
  );
  stable(
    TARGET_SERIAL_EP02.titleRef,
    TARGET_SERIAL_EP02.episodeRef,
    fixtureTarget({ sourceId, upstreamVodId: '3001', episodeKey: '02', title: 'fixture·登记三集剧', totalEpisodes: 2 }),
  );
  stable(
    TARGET_THEATRICAL.titleRef,
    TARGET_THEATRICAL.episodeRef,
    fixtureTarget({ sourceId, upstreamVodId: '3002', episodeKey: 'movie', title: 'fixture·登记剧场版', totalEpisodes: 1 }),
  );
  stable(
    TARGET_GAPPED_EP01.titleRef,
    TARGET_GAPPED_EP01.episodeRef,
    fixtureTarget({ sourceId, upstreamVodId: '3003', episodeKey: '01', title: 'fixture·登记缺集剧', totalEpisodes: 2 }),
  );
  stable(
    TARGET_DIRECTORS_CUT.titleRef,
    TARGET_DIRECTORS_CUT.episodeRef,
    fixtureTarget({ sourceId, upstreamVodId: '3004', episodeKey: 'movie', title: 'fixture·登记导演剪辑版', totalEpisodes: 1 }),
  );
}

/**
 * 候选溯源工厂事实(DB 直插;I1 sourceSessionId 外键 = playback_session):
 * media_item(standalone) + playback_session(ended 终态,五要素绑定当前 rig
 * 会话/设备/档案),返回可外键引用的 playback_session.id。
 */
function seedFixturePlaybackProvenance(householdId: string): string {
  const mediaId = `prov-media-${randomUUID()}`;
  const sessionId = `prov-psession-${randomUUID()}`;
  const sessionRow = Database.db
    .prepare(
      'SELECT id AS deviceSessionId, device_id AS deviceId, active_profile_id AS profileId FROM device_session LIMIT 1',
    )
    .get() as { deviceSessionId: string; deviceId: string; profileId: string } | undefined;
  expect(sessionRow, '夹具错误:device_session 行不存在(seedSession 未执行)').toBeDefined();
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaItem)
      .values({
        id: mediaId,
        householdId,
        type: 'movie',
        mediaRole: 'standalone',
        title: 'fixture·候选溯源媒体',
        contentLevel: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(playbackSession)
      .values({
        id: sessionId,
        householdId,
        deviceSessionId: sessionRow!.deviceSessionId,
        deviceId: sessionRow!.deviceId,
        profileId: sessionRow!.profileId,
        mediaId,
        state: 'ended',
        delivery: null,
        generation: 1,
        version: 1,
        positionSeconds: 0,
        createdAt: now,
        endedAt: now,
        lastHeartbeatAt: now,
      })
      .run();
  });
  return sessionId;
}

/** 候选分支直种(D 组;candidateRef → 同 EP01 稳定目标事实 + 服务端绑定溯源) */
function registerFixtureCandidateTarget(householdId: string, sourceId: string, candidateRef: string): void {
  registerVodMaterializationTarget({
    ...fixtureTarget({ sourceId, upstreamVodId: '3001', episodeKey: '01', title: 'fixture·登记三集剧', totalEpisodes: 2 }),
    candidateRef,
    candidate: { sourceSessionId: seedFixturePlaybackProvenance(householdId), sourceGeneration: 1 },
  });
}

/* ------------------------------------------------------------------ */
/* DB 直读/直改(断言口径与 T021 同:Database 单例 + 原生 SQL)           */
/* ------------------------------------------------------------------ */

function householdIdOf(): string {
  const row = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string } | undefined;
  expect(row, '夹具错误:household 行不存在(初始化未执行)').toBeDefined();
  return (row as { id: string }).id;
}

function countOf(table: string, householdId: string, extraWhere = ''): number {
  const row = Database.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE household_id = ?${extraWhere}`).get(householdId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** 公共目录修订(catalog_state.revision;无行视为初版 1 —— media-catalog 既有口径) */
function catalogRevisionOf(householdId: string): number {
  const row = Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
    | { revision: number }
    | undefined;
  return row?.revision ?? 1;
}

/** 物化副作用全集快照(data-model §2/§4:父/子/线/详情/序列/entry/资源/operation/登记候选) */
interface MaterializationState {
  mediaItemVodRoles: number;
  mediaRelation: number;
  vodTitle: number;
  vodLine: number;
  vodEpisode: number;
  vodDetailSnapshot: number;
  vodEpisodeSequence: number;
  sourceEntryVod: number;
  playbackSourceOnline: number;
  operation: number;
  registeredCandidate: number;
  catalogRevision: number;
}

function materializationStateOf(householdId: string): MaterializationState {
  return {
    mediaItemVodRoles: countOf('media_item', householdId, " AND media_role != 'standalone'"),
    mediaRelation: countOf('media_relation', householdId),
    vodTitle: countOf('vod_title', householdId),
    vodLine: countOf('vod_line', householdId),
    vodEpisode: countOf('vod_episode', householdId),
    vodDetailSnapshot: countOf('vod_detail_snapshot', householdId),
    vodEpisodeSequence: countOf('vod_episode_sequence', householdId),
    sourceEntryVod: countOf('source_entry', householdId, " AND identity_kind = 'vod_episode'"),
    playbackSourceOnline: countOf('playback_source', householdId, " AND locator_kind = 'online'"),
    operation: countOf('vod_materialization_operation', householdId),
    registeredCandidate: countOf('vod_registered_candidate', householdId),
    catalogRevision: catalogRevisionOf(householdId),
  };
}

/** C 组零副作用:物化全集行数必须全 0(父 media/vod_title/line/episode/详情/序列/
 *  source_entry/playback_source/registered_candidate/operation),目录 revision 不变 */
function expectZeroMaterializationSideEffects(state: MaterializationState, baselineRevision: number, label: string): void {
  expect(state.mediaItemVodRoles, `${label}:media_item 不得有 vod 角色残留`).toBe(0);
  expect(state.mediaRelation, `${label}:media_relation 不得有残留`).toBe(0);
  expect(state.vodTitle, `${label}:vod_title 不得有残留`).toBe(0);
  expect(state.vodLine, `${label}:vod_line 不得有残留`).toBe(0);
  expect(state.vodEpisode, `${label}:vod_episode 不得有残留`).toBe(0);
  expect(state.vodDetailSnapshot, `${label}:vod_detail_snapshot 不得有残留`).toBe(0);
  expect(state.vodEpisodeSequence, `${label}:vod_episode_sequence 不得有残留`).toBe(0);
  expect(state.sourceEntryVod, `${label}:source_entry(identity_kind=vod_episode)不得有残留`).toBe(0);
  expect(state.playbackSourceOnline, `${label}:playback_source(locator_kind=online)不得有残留`).toBe(0);
  expect(state.operation, `${label}:vod_materialization_operation 不得有残留`).toBe(0);
  expect(state.registeredCandidate, `${label}:vod_registered_candidate 不得有残留`).toBe(0);
  expect(state.catalogRevision, `${label}:目录 revision 不得虚增`).toBe(baselineRevision);
}

function expectStateUnchanged(before: MaterializationState, after: MaterializationState, label: string): void {
  expect(after, `${label}:物化副作用全集必须与基线逐项一致(零新增/零虚增)`).toEqual(before);
}

/* ----- DB 直改(工厂事实模拟;每处注明等价语义) ----- */

/** 模拟详情快照过期(快照 expires_at 只服务稳定详情 stale 判定,不再拦截物化)。
 * T031 断言适配修正:fetched_at 须随 expires_at 一并置过去(vod_detail_snapshot
 * CHECK expires_at > fetched_at 在 UPDATE 上同样生效;expireRegisteredCandidates/
 * expireMaterializationOperations 同款「成对置过去」口径) */
function expireVodDetailSnapshots(householdId: string): void {
  Database.db
    .prepare(
      "UPDATE vod_detail_snapshot SET fetched_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T01:00:00.000Z' WHERE household_id = ?",
    )
    .run(householdId);
}

/** 模拟详情修订推进(他人/后台已发布新详情):current_detail_revision +1 */
function bumpCurrentDetailRevision(householdId: string): void {
  Database.db
    .prepare('UPDATE vod_title SET current_detail_revision = current_detail_revision + 1 WHERE household_id = ?')
    .run(householdId);
}

/** 模拟目标内容/连续性变化(data-model §3:内容替换/关键结构变更) */
function bumpTargetContentAndContinuity(householdId: string): void {
  Database.db
    .prepare("UPDATE media_item SET content_revision = content_revision + 1 WHERE household_id = ? AND media_role = 'vod_episode'")
    .run(householdId);
  Database.db
    .prepare('UPDATE vod_episode SET continuity_revision = continuity_revision + 1 WHERE household_id = ?')
    .run(householdId);
}

/** 模拟幂等 key 24h 到期(固定保留不延长;CHECK expires_at > committed_at 保持成立) */
function expireMaterializationOperations(householdId: string): void {
  Database.db
    .prepare(
      "UPDATE vod_materialization_operation SET committed_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T01:00:00.000Z' WHERE household_id = ?",
    )
    .run(householdId);
}

/** 模拟登记候选过期(I1:过期按引用清理语义的目标态) */
function expireRegisteredCandidates(householdId: string): void {
  Database.db
    .prepare(
      "UPDATE vod_registered_candidate SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T01:00:00.000Z' WHERE household_id = ?",
    )
    .run(householdId);
}

/** 清空设备会话当前档案(等价「登录后未选档」;T021 D1 同口径 DB 直改) */
function clearActiveProfile(): void {
  Database.db.prepare('UPDATE device_session SET active_profile_id = NULL').run();
}

/* ------------------------------------------------------------------ */
/* 故障注入装配(仅本文件:overrideProvider 覆盖 UNIT_OF_WORK 的 txStores 键) */
/* ------------------------------------------------------------------ */

/** app.module.ts UNIT_OF_WORK 的原始 txStores 注册表(逐键同源,不改源码仅覆盖) */
const ORIGINAL_TX_STORE_FACTORIES: Record<string, TxStoreFactory> = {
  identityAccess: createIdentityAccessTxReaders,
  profile: createProfileTxReaders,
  policy: createPolicyTxReaders,
  sources: createSourcesTxParticipants,
  catalog: createMediaCatalogTxParticipants,
  vod: createOnlineVodTxParticipants,
  playback: createPlaybackTxParticipants,
  personalData: createPersonalDataTxParticipants,
};

/**
 * MaterializeWorkSet 步骤名(FIXTURE_MATERIALIZE_STEP_NAMES,internal-ports §2 顺序)
 * → 步骤所属上下文的 txStores 注册表键。该键的事务参与者在工作集内被首次触达时,
 * 即视为进入该步骤(注入点,见文件头「注入粒度说明」)。
 */
const MATERIALIZE_STEP_TX_STORE_KEY: Record<FixtureMaterializeStepName, string> = {
  'materialize:idempotent-replay': 'vod', // MaterializationOperationStore.findCommittedOperation
  'materialize:revalidate-context': 'identityAccess', // IdentitySnapshotReader.findDeviceContext
  'materialize:allocate-identity': 'catalog', // CatalogParticipant.findCatalogMedia/预分配身份
  'materialize:verify-policy': 'policy', // PolicyReader 目标策略
  'materialize:cas-detail': 'vod', // VodParticipant.findDetailSnapshot(预览/配置/详情 CAS)
  'materialize:check-quota': 'vod', // QuotaStore.count*(净配额)
  'materialize:map-resource': 'sources', // SourceEntryParticipant/SourceReader(完整映射/资源)
  'materialize:record-operation': 'vod', // recordCommittedOperation(+§5 登记映射同提交)
  'materialize:bump-revision': 'catalog', // bumpPublicCatalogRevision(仅公开变化)
  'materialize:commit': 'catalog', // 提交边界(最后写入参与者为公共 revision;COMMIT 前注入归 T029 接线)
};

/**
 * 步骤故障包装工厂:被覆盖键的 TxStore 以 Proxy 包装 —— 参与者任一方法首次被工作集
 * 触达时先 planner.enterStep(步骤名)(命中计划即抛 FixtureStepFailureError,位于
 * UnitOfWork.run 的 try 段内 → 整体回滚、连接恢复),未命中则透传原方法。
 */
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

function txStoresWithStepInjection(stepName: FixtureMaterializeStepName, planner: FixtureStepFailurePlanner): TxStoresRegistry {
  const ownerKey = MATERIALIZE_STEP_TX_STORE_KEY[stepName];
  const registry: TxStoresRegistry = {};
  for (const [key, factory] of Object.entries(ORIGINAL_TX_STORE_FACTORIES)) {
    registry[key] = key === ownerKey ? stepFailureProxyFactory(factory, stepName, planner) : factory;
  }
  return registry;
}

/* ----- 本地 rig 管理(与 test/helpers.ts startFreshApp 同构;不改共享 rig) ----- */

interface LocalRig {
  app: INestApplication;
  dataDir: string;
}

const localRigs: LocalRig[] = [];

function applyAuthoritativeMigrations(): void {
  const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const insert = Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const name of names) {
    const upSqlPath = path.join(migrationsDir, name, 'up.sql');
    expect(fs.existsSync(upSqlPath), `未找到迁移 DDL ${upSqlPath}(须以 apps/server 为工作目录运行)`).toBe(true);
    Database.db.exec(fs.readFileSync(upSqlPath, 'utf8'));
    insert.run(name, new Date().toISOString());
  }
}

/** 本地 boot:独立临时数据目录 + 全量迁移 + TestingModule overrideProvider(UNIT_OF_WORK) */
async function bootAppWithUnitOfWorkOverride(
  unitOfWorkFactory: () => unknown,
  env?: Record<string, string>,
): Promise<INestApplication> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t024-'));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db`, ...env }));
  Database.close();
  Database.db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  applyAuthoritativeMigrations();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(UNIT_OF_WORK)
    // Nest 12 覆盖 API:useFactory 收 { factory }(OverrideByFactoryOptions)
    .useFactory({
      factory: unitOfWorkFactory,
    })
    .compile();
  const app = moduleRef.createNestApplication({ logger: ['warn', 'error'] });
  app.setGlobalPrefix('api');
  await app.init();
  localRigs.push({ app, dataDir });
  return app;
}

async function cleanupLocalRigs(): Promise<void> {
  while (localRigs.length > 0) {
    const rig = localRigs.pop();
    if (rig === undefined) {
      break;
    }
    await rig.app.close();
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

/** afterEach 统一清理(共享 rig + 本地 rig + T031 登记桥注册表清空) */
async function cleanupAllRigs(): Promise<void> {
  // T031 登记桥卫生兜底:注册表随用例文件进程隔离,逐用例清空防跨 describe 残留
  clearVodMaterializationTargets();
  await cleanupLocalRigs();
  await cleanupRigs();
}

/* ------------------------------------------------------------------ */
/* 身份 seed 与 rig 句柄                                               */
/* ------------------------------------------------------------------ */

interface SeededRig {
  app: INestApplication;
  cookie: string;
  householdId: string;
}

/** initialize + login + 选主档案(物化为 Profile 面;T021 settingsRig 同链) */
async function seedSession(app: INestApplication): Promise<string> {
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await selectMainAndUnlockSettings(app, cookie);
  return cookie;
}

async function seededRig(prefix: string, env?: Record<string, string>): Promise<SeededRig> {
  const rig: TestRig = await startFreshApp({ prefix, env });
  const cookie = await seedSession(rig.app);
  return { app: rig.app, cookie, householdId: householdIdOf() };
}

/* ----- 故障注入 rig:C/D2 用 ----- */

interface FaultInjectedRig extends SeededRig {
  planner: FixtureStepFailurePlanner;
  /** planner 持有的计划数组(闭包读同一数组;装配期保持为空,seed 完成后再武装) */
  plans: FixtureStepFailurePlan[];
  stepName: FixtureMaterializeStepName;
}

async function startFaultInjectedRig(prefix: string, stepName: FixtureMaterializeStepName): Promise<FaultInjectedRig> {
  const plans: FixtureStepFailurePlan[] = [];
  const planner = createFixtureStepFailurePlanner(plans);
  const app = await bootAppWithUnitOfWorkOverride(() =>
    createUnitOfWork({
      resolveDatabase: () => Database.db,
      txStores: txStoresWithStepInjection(stepName, planner),
    }),
  );
  const cookie = await seedSession(app);
  return { app, cookie, householdId: householdIdOf(), planner, plans, stepName };
}

/** 武装注入(装配期事务已结束;reset 清掉 seed 轨迹,使下一次即 occurrence 1) */
function armStepFailure(rig: FaultInjectedRig): void {
  rig.plans.push({
    stepName: rig.stepName,
    occurrence: 1,
    error: { code: 'FIXTURE_STEP_FAILURE', message: `T024 每步故障注入:${rig.stepName}` },
  });
  rig.planner.reset();
}

/** 解除注入(计划数组与轨迹一并清空;同 key 重试走成功路径) */
function disarmStepFailure(rig: FaultInjectedRig): void {
  rig.plans.splice(0, rig.plans.length);
  rig.planner.reset();
}

/* ------------------------------------------------------------------ */
/* 响应 DTO 断言                                                       */
/* ------------------------------------------------------------------ */

function assertMaterializedDto(res: request.Response): MaterializedDto {
  const body = res.body as MaterializedDto;
  // T031 断言适配修正:期望侧排序比对(MATERIALIZED_DTO_KEYS 常量原序非字典序,
  // registeredCandidateRef 字典序先于 replayed;转绿前该断言从未对真实 201 执行)
  expect(Object.keys(body).sort(), 'Materialized DTO 必须严格(consumed 未知字段拒绝白名单输出)').toEqual([
    ...MATERIALIZED_DTO_KEYS,
  ].sort());
  expect(body.parentMediaId, 'parentMediaId 应为服务端生成 UUID').toMatch(UUID_PATTERN);
  expect(body.mediaId, 'mediaId 应为服务端生成 UUID').toMatch(UUID_PATTERN);
  expect(body.detailRevision, 'detailRevision >= 1').toBeGreaterThanOrEqual(1);
  expect(body.catalogRevision, 'catalogRevision >= 1').toBeGreaterThanOrEqual(1);
  expect(typeof body.replayed).toBe('boolean');
  return body;
}

/* ------------------------------------------------------------------ */
/* A 幂等与目标(计划内红 · 待 T029+T031)                              */
/* ------------------------------------------------------------------ */

describe('T024 · A 幂等与目标(POST /api/vod/materializations · 计划内红)', () => {
  let rig: SeededRig;

  beforeEach(async () => {
    rig = await seededRig('hmp-t024-a-');
    // T031 登记桥接线(设计内形态):合成 ref 不经预览缓存签发,rig 直种与用例
    // 数据一致的稳定目标;注册表随测试进程隔离,afterEach 统一清空。
    registerFixtureStableTargets(seedFixtureVodSource(rig.householdId));
  });

  afterEach(cleanupAllRigs);

  it('A1 首次物化:201 Materialized(replayed=false、candidate/registered 均空),资源与 operation 同事务落库', async () => {
    const res = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(res.status, redLabel('201 首次物化 Materialized', `${res.status} ${String(res.body.code)}`)).toBe(201);
    const body = assertMaterializedDto(res);
    expect(body.replayed, '首次物化 replayed=false').toBe(false);
    expect(body.candidateRef, '普通分支 candidateRef=null(api §7 I1)').toBeNull();
    expect(body.registeredCandidateRef, '普通分支 registeredCandidateRef=null').toBeNull();
    // 资源与幂等结果同事务(internal-ports §2:完整映射/资源 → 幂等结果同 commit)
    expect(countOf('vod_title', rig.householdId), '稳定映射父行应落库').toBe(1);
    expect(countOf('vod_materialization_operation', rig.householdId), '幂等 operation 应落库').toBe(1);
    const operation = Database.db
      .prepare('SELECT committed_at, expires_at FROM vod_materialization_operation WHERE household_id = ?')
      .get(rig.householdId) as { committed_at: string | null; expires_at: string } | undefined;
    expect(operation?.committed_at, 'operation 仅 committed 非空可重放(data-model §4)').not.toBeNull();
    expect(new Date(operation?.expires_at ?? '').getTime(), '固定 24h 保留(≈ committed+24h)').toBeGreaterThanOrEqual(
      new Date(operation?.committed_at ?? '').getTime() + 23.5 * 3600_000,
    );
    // 响应 catalogRevision 与公共目录计数一致(提交时值)
    expect(body.catalogRevision).toBe(catalogRevisionOf(rig.householdId));
  });

  it('A2 同 key 同载荷:200 replayed=true 原结果逐字段一致;operation/资源零新增,目录 revision 不虚增', async () => {
    const key = randomUUID();
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);
    const firstBody = first.body as MaterializedDto;
    const before = materializationStateOf(rig.householdId);

    // 丢响应后原样重试同 key(§3 幂等段):200 + replayed=true
    const replay = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(replay.status, redLabel('200 同 key 重放', `${replay.status} ${String(replay.body.code)}`)).toBe(200);
    const body = replay.body as MaterializedDto;
    expect(body.replayed, '同 key 重放 replayed=true').toBe(true);
    // T031 断言适配修正:「原结果逐字段一致」除 replayed 标志外比较(该标志恰为
    // 重放语义本体;原断言 whole-body toEqual 与 replayed=true 自相矛盾)
    expect({ ...body, replayed: false }, '重放必须原样返回原结果(不重算/不刷新)').toEqual(firstBody);
    expectStateUnchanged(before, materializationStateOf(rig.householdId), '同 key 重放');
  });

  it('A3 同 key 异载荷:409 IDEMPOTENCY_CONFLICT;不得新增任何资源/operation(同 key 结果固定)', async () => {
    const key = randomUUID();
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);
    const before = materializationStateOf(rig.householdId);

    const conflict = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP02, key));
    expectProblem(conflict, 409, ProblemCode.IDEMPOTENCY_CONFLICT);
    expectStateUnchanged(before, materializationStateOf(rig.householdId), '同 key 异摘要冲突');
  });

  it('A4 异 key 同目标:复用稳定映射(同 parentMediaId/detailRevision);不占新配额、目录 revision 不虚增', async () => {
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);
    const firstBody = first.body as MaterializedDto;
    const afterFirst = materializationStateOf(rig.householdId);

    const reuse = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(reuse.status, redLabel('201 异 key 复用已有映射', `${reuse.status} ${String(reuse.body.code)}`)).toBe(201);
    const body = assertMaterializedDto(reuse);
    expect(body.parentMediaId, '稳定 key 已存在必须复用同父媒体 ID(api §3)').toBe(firstBody.parentMediaId);
    expect(body.mediaId, '同目标子项复用同 mediaId').toBe(firstBody.mediaId);
    expect(body.detailRevision, 'detailRevision 为提交时值(同目标同详情)').toBe(firstBody.detailRevision);
    expect(body.replayed, '异 key 是新操作而非幂等重放').toBe(false);
    expect(countOf('vod_title', rig.householdId), '复用不得新建父映射(不占新配额,data-model §4)').toBe(1);
    expect(countOf('vod_materialization_operation', rig.householdId), '新 key 记录新 operation').toBe(2);
    expect(catalogRevisionOf(rig.householdId), '复用无公开变化,目录 revision 不得虚增').toBe(afterFirst.catalogRevision);
  });

  it('A5 成功重放优先于预览 TTL:预览过期后同 key 24h 内仍 200 原结果(DB 直改 expires_at 模拟过期)', async () => {
    const key = randomUUID();
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);
    const firstBody = first.body as MaterializedDto;

    // DB 直改注明:预览/详情 TTL 自然到期后的等价存储事实(expires_at 落到过去)
    expireVodDetailSnapshots(rig.householdId);

    const replay = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(replay.status, redLabel('200 已提交重放优先于预览 TTL', `${replay.status} ${String(replay.body.code)}`)).toBe(200);
    const body = replay.body as MaterializedDto;
    expect(body.replayed).toBe(true);
    // T031 断言适配修正:同 A2 —— 除 replayed 标志外逐字段一致(候选/registered 语义同 A1:普通分支均空)
    expect({ ...body, replayed: false }, '重放原结果(候选/registered 语义同 A1:普通分支均空)').toEqual(firstBody);
  });

  it('A6 新 key + 详情快照过期(预览有效):201 复用映射,快照不重发布(过期不再拦截)', async () => {
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);
    const before = materializationStateOf(rig.householdId);

    expireVodDetailSnapshots(rig.householdId);
    const reuse = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(reuse.status, redLabel('201 复用映射', `${reuse.status}`)).toBe(201);
    const after = materializationStateOf(rig.householdId);
    // 复用零公开变化:仅新 operation 记录 +1,标题/集/快照/revision 均不虚增
    expect(after.vodDetailSnapshot, '同修订快照不重发布').toBe(before.vodDetailSnapshot);
    expect(after.vodTitle).toBe(before.vodTitle);
    expect(after.vodEpisode).toBe(before.vodEpisode);
    expect(after.catalogRevision).toBe(before.catalogRevision);
    expect(after.operation, '新 key 记录新 operation').toBe(before.operation + 1);
  });

  it('A7 新 key + 预览修订落后:409 VOD_DETAIL_CHANGED(DB 直改 current_detail_revision+1 模拟详情变化)', async () => {
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);
    const before = materializationStateOf(rig.householdId);

    bumpCurrentDetailRevision(rig.householdId);
    const changed = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expectProblem(changed, 409, 'VOD_DETAIL_CHANGED');
    expectStateUnchanged(before, materializationStateOf(rig.householdId), '预览变更拒绝');
  });

  it('A8 旧结果目标内容/连续性变化:同 key 重放 409 VOD_MATERIALIZATION_STALE(已提交重放仍检查当前资源)', async () => {
    const key = randomUUID();
    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);

    // DB 直改注明:目标内容替换 + 连续性修订推进(data-model §3 语义)
    bumpTargetContentAndContinuity(rig.householdId);

    const stale = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expectProblem(stale, 409, 'VOD_MATERIALIZATION_STALE');
  });
});

/* ------------------------------------------------------------------ */
/* B 配额与保护(计划内红 · 待 T029+T031)                              */
/* ------------------------------------------------------------------ */

describe('T024 · B 配额与保护(净配额并发 / 24h 目标保护 / 目录 revision)', () => {
  afterEach(cleanupAllRigs);

  it('B1 净配额并发:并发 4 个新目标请求,成功数恰好补足到剩余配额 3(VOD_MAX_PARENT_TITLES 收窄注入),无超发', async () => {
    const previousQuota = process.env.VOD_MAX_PARENT_TITLES;
    process.env.VOD_MAX_PARENT_TITLES = '3';
    try {
      const rig = await seededRig('hmp-t024-b1-');
      // T031 登记桥接线(设计内形态):四个并发新目标各直种独立稳定键(3001–3004)
      registerFixtureStableTargets(seedFixtureVodSource(rig.householdId));
      const baseline = materializationStateOf(rig.householdId);
      const targets = [TARGET_SERIAL_EP01, TARGET_THEATRICAL, TARGET_GAPPED_EP01, TARGET_DIRECTORS_CUT];

      const results = await Promise.all(targets.map((target) => postMaterialize(rig.app, rig.cookie, stableRefBody(target))));
      const created = results.filter((res) => res.status === 201);
      const quotaDenied = results.filter((res) => res.status === 409);
      expect(created.length, redLabel('恰好 3 个 201(剩余配额)', `全部 ${results.map((r) => r.status).join('/')}`)).toBe(3);
      expect(quotaDenied.length, '第 4 个新目标必须 409 满额').toBe(1);
      for (const denied of quotaDenied) {
        expectProblem(denied, 409, 'VOD_QUOTA_EXCEEDED');
      }
      // 无超发:父映射与 operation 恰为成功数;并发各得独立目标(无同父复用混入)
      const parents = new Set(created.map((res) => (res.body as MaterializedDto).parentMediaId));
      expect(parents.size, '并发新目标应各得独立父媒体').toBe(3);
      expect(countOf('vod_title', rig.householdId), '父映射行数=成功数(无半成品/超发)').toBe(3);
      expect(countOf('vod_materialization_operation', rig.householdId), '失败请求不占成功 key/无 operation 残留').toBe(3);
      expect(catalogRevisionOf(rig.householdId), '目录 revision 恰 +3(每次首次物化 +1)').toBe(baseline.catalogRevision + 3);
    } finally {
      if (previousQuota === undefined) {
        delete process.env.VOD_MAX_PARENT_TITLES;
      } else {
        process.env.VOD_MAX_PARENT_TITLES = previousQuota;
      }
    }
  });

  it('B2 24h 目标保护:配额满时新 key 异目标 409;幂等 key 过期(模拟)不缩短目标保护,复用不重建不虚增', async () => {
    const previousQuota = process.env.VOD_MAX_PARENT_TITLES;
    process.env.VOD_MAX_PARENT_TITLES = '1';
    try {
      const rig = await seededRig('hmp-t024-b2-');
      // T031 登记桥接线(设计内形态):EP01 + THEATRICAL 两稳定键直种(配额满/复用面)
      registerFixtureStableTargets(seedFixtureVodSource(rig.householdId));
      const key = randomUUID();
      const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
      expect(first.status, redLabel('201 首次物化(占满配额 1)', `${first.status}`)).toBe(201);
      const firstBody = first.body as MaterializedDto;

      // 24h 内配额满:新 key 异目标 → 409 VOD_QUOTA_EXCEEDED(不删历史/不挤占既有目标)
      const denied = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_THEATRICAL));
      expectProblem(denied, 409, 'VOD_QUOTA_EXCEEDED');

      // DB 直改注明:幂等 key 固定 24h 保留到期的等价存储事实
      expireMaterializationOperations(rig.householdId);

      // 幂等 key 过期不缩短目标保护:目标组仍在;同 key 请求按既有映射复用(200 重放或
      // 201 复用皆为契约形态),绝不重建第二份目标、不要求新媒体配额、revision 不虚增
      const protectedState = materializationStateOf(rig.householdId);
      expect(protectedState.vodTitle, '目标父映射仍在(回收保护未被幂等过期缩短)').toBe(1);
      const again = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
      expect(
        [200, 201],
        redLabel('200 重放或 201 复用既有映射', `${again.status} ${String(again.body.code)}`),
      ).toContain(again.status);
      const againBody = again.body as MaterializedDto;
      expect(againBody.parentMediaId, '同目标必须复用同父媒体(ID 不复用他人/不重建)').toBe(firstBody.parentMediaId);
      expect(countOf('vod_title', rig.householdId), '目标仍恰好 1 份(无重建/无超发)').toBe(1);
      expect(catalogRevisionOf(rig.householdId), '复用/重放均不虚增目录 revision').toBe(protectedState.catalogRevision);
    } finally {
      if (previousQuota === undefined) {
        delete process.env.VOD_MAX_PARENT_TITLES;
      } else {
        process.env.VOD_MAX_PARENT_TITLES = previousQuota;
      }
    }
  });

  it('B3 目录 revision 只在首次物化 +1:同 key 重放、异 key 同目标复用均不虚增(响应与 catalog_state 一致)', async () => {
    const rig = await seededRig('hmp-t024-b3-');
    // T031 登记桥接线(设计内形态):EP01 稳定键直种(首次/重放/复用 revision 面)
    registerFixtureStableTargets(seedFixtureVodSource(rig.householdId));
    const baselineRevision = catalogRevisionOf(rig.householdId);
    const key = randomUUID();

    const first = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(first.status, redLabel('201 首次物化', `${first.status}`)).toBe(201);
    const firstBody = first.body as MaterializedDto;
    expect(firstBody.catalogRevision, '首次物化目录 revision 恰 +1').toBe(baselineRevision + 1);
    expect(catalogRevisionOf(rig.householdId)).toBe(baselineRevision + 1);

    const replay = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01, key));
    expect(replay.status, redLabel('200 同 key 重放', `${replay.status} ${String(replay.body.code)}`)).toBe(200);
    expect((replay.body as MaterializedDto).catalogRevision, '重放不得虚增').toBe(baselineRevision + 1);
    expect(catalogRevisionOf(rig.householdId)).toBe(baselineRevision + 1);

    const reuse = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(reuse.status, redLabel('201 异 key 复用', `${reuse.status}`)).toBe(201);
    expect((reuse.body as MaterializedDto).catalogRevision, '复用不得虚增').toBe(baselineRevision + 1);
    expect(catalogRevisionOf(rig.householdId), 'catalog_state 与响应一致且不虚增').toBe(baselineRevision + 1);
  });
});

/* ------------------------------------------------------------------ */
/* C 每步故障回滚(step planner 注入,逐步骤 · 计划内红)                */
/* ------------------------------------------------------------------ */

describe('T024 · C 每步故障回滚(FIXTURE_MATERIALIZE_STEP_NAMES 逐步注入 · 计划内红)', () => {
  afterEach(cleanupAllRigs);

  for (const stepName of FIXTURE_MATERIALIZE_STEP_NAMES) {
    it(`C·${stepName} 第 1 次失败 → 500 稳定码 + 零副作用 + 目录 revision 不变;reset 后同 key 201`, async () => {
      const rig = await startFaultInjectedRig('hmp-t024-c-', stepName);
      // T031 登记桥接线(设计内形态):故障注入 rig 同样直种 EP01 稳定键
      registerFixtureStableTargets(seedFixtureVodSource(rig.householdId));
      const baseline = materializationStateOf(rig.householdId);
      const key = randomUUID();
      const body = stableRefBody(TARGET_SERIAL_EP01, key);

      armStepFailure(rig);
      const failed = await postMaterialize(rig.app, rig.cookie, body);
      expect(failed.status, redLabel(`500 稳定错误码(step=${stepName})`, `${failed.status} ${String(failed.body.code)}`)).toBe(500);
      expectProblem(failed, 500, 'INTERNAL');
      expect(rig.planner.stepExecutedCount(stepName), `注入步骤 ${stepName} 应恰好进入 1 次`).toBe(1);
      // 零副作用:父 media/vod_title/line/episode/source_entry/playback_source/
      // registered_candidate/operation 全表无残留,目录 revision 不变
      expectZeroMaterializationSideEffects(materializationStateOf(rig.householdId), baseline.catalogRevision, `step ${stepName} 失败回滚后`);
      if (stepName === 'materialize:map-resource') {
        // 预分配 ID 策略拒绝语义:预分配只在内存,map-resource 前失败 ⇒ 预分配 ID 未落库
        expect(
          countOf('media_item', rig.householdId, " AND media_role IN ('vod_title','vod_episode')"),
          '预分配 ID 未落库(不能为策略先提交占位资源,internal-ports §2)',
        ).toBe(0);
      }

      disarmStepFailure(rig);
      const retry = await postMaterialize(rig.app, rig.cookie, body);
      expect(retry.status, redLabel('201 同 key 重试成功(回滚后可恢复)', `${retry.status} ${String(retry.body.code)}`)).toBe(201);
      const bodyDto = assertMaterializedDto(retry);
      expect(bodyDto.replayed).toBe(false);
      expect(countOf('vod_title', rig.householdId), '重试恰好一次完整物化').toBe(1);
      expect(countOf('vod_materialization_operation', rig.householdId), '重试恰记录一条已提交 operation').toBe(1);
      expect(catalogRevisionOf(rig.householdId), '目录 revision 恰 +1(仅首次成功物化)').toBe(baseline.catalogRevision + 1);
    });
  }
});

/* ------------------------------------------------------------------ */
/* D candidateRef 分支(计划内红 · 待 T029+T031;候选签发贯通另需 T070)  */
/* ------------------------------------------------------------------ */

describe('T024 · D candidateRef 分支(首次物化 / 登记映射原子回滚 / 伪造与过期)', () => {
  afterEach(cleanupAllRigs);

  it('D1 普通分支成功后,candidateRef+previewRevision+新 key 物化同目标:201 且 registeredCandidateRef 非空;重放 200 同引用', async () => {
    const rig = await seededRig('hmp-t024-d1-');
    // T031 登记桥接线(设计内形态):EP01 稳定键直种(候选分支同目标复用其稳定映射)
    const sourceId = seedFixtureVodSource(rig.householdId);
    registerFixtureStableTargets(sourceId);
    const stable = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(stable.status, redLabel('201 普通分支首次物化', `${stable.status}`)).toBe(201);
    const stableBody = stable.body as MaterializedDto;
    expect(stableBody.registeredCandidateRef, '普通分支 registeredCandidateRef=null').toBeNull();

    // 候选分支(I1):candidateRef 由服务端记录绑定,不要求前端推导 titleRef/episodeRef
    // T031 登记桥接线(设计内形态):伪造候选 404 面(D3)要求 _A 仅在此处按点直种
    registerFixtureCandidateTarget(rig.householdId, sourceId, FORGED_CANDIDATE_REF_A);
    const candidateKey = randomUUID();
    const candidate = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_A, candidateKey));
    expect(candidate.status, redLabel('201 候选分支物化', `${candidate.status} ${String(candidate.body.code)}`)).toBe(201);
    const candidateBodyDto = assertMaterializedDto(candidate);
    expect(candidateBodyDto.candidateRef, '候选分支回显非空 candidateRef').not.toBeNull();
    expect(candidateBodyDto.registeredCandidateRef, '候选分支返回不可变登记映射引用(I1)').toBeTruthy();
    expect(candidateBodyDto.parentMediaId, '同目标复用稳定映射').toBe(stableBody.parentMediaId);
    expect(
      countOf('vod_registered_candidate', rig.householdId),
      '登记映射与 operation 同事务落库(data-model §10 I1)',
    ).toBe(1);

    // 丢响应后同 key 原样重试:200 同引用(replayed=true)
    const replay = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_A, candidateKey));
    expect(replay.status, redLabel('200 候选分支重放', `${replay.status} ${String(replay.body.code)}`)).toBe(200);
    const replayBody = replay.body as MaterializedDto;
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.registeredCandidateRef).toBe(candidateBodyDto.registeredCandidateRef);
    expect(countOf('vod_registered_candidate', rig.householdId), '重放不重复登记').toBe(1);
  });

  it('D2 登记映射与 operation 同事务:record-operation 注入失败 → registered_candidate 与新 operation 均无;reset 后重试 201 且两行同提交', async () => {
    const rig = await startFaultInjectedRig('hmp-t024-d2-', 'materialize:record-operation');
    // T031 登记桥接线(设计内形态):THEATRICAL 稳定键直种(装配期普通分支用)
    const sourceId = seedFixtureVodSource(rig.householdId);
    registerFixtureStableTargets(sourceId);

    // 先普通分支成功(装配期计划为空 ⇒ 不注入)
    const stable = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_THEATRICAL));
    expect(stable.status, redLabel('201 普通分支首次物化', `${stable.status}`)).toBe(201);
    const stableOpCount = countOf('vod_materialization_operation', rig.householdId);
    expect(stableOpCount).toBe(1);

    // T031 登记桥接线(设计内形态):候选 _A 在武装注入前按点直种(同 EP01 稳定目标)
    registerFixtureCandidateTarget(rig.householdId, sourceId, FORGED_CANDIDATE_REF_A);
    armStepFailure(rig);
    const candidateKey = randomUUID();
    const failed = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_A, candidateKey));
    expect(failed.status, redLabel('500 登记步骤失败稳定码', `${failed.status} ${String(failed.body.code)}`)).toBe(500);
    expectProblem(failed, 500, 'INTERNAL');
    // 原子回滚:登记候选与新 operation 均无(只余普通分支那份)
    expect(countOf('vod_registered_candidate', rig.householdId), '登记映射必须整体回滚').toBe(0);
    expect(countOf('vod_materialization_operation', rig.householdId), 'operation 结果必须整体回滚(无新增)').toBe(stableOpCount);

    disarmStepFailure(rig);
    const retry = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_A, candidateKey));
    expect(retry.status, redLabel('201 重试成功', `${retry.status}`)).toBe(201);
    const retryBody = assertMaterializedDto(retry);
    expect(retryBody.registeredCandidateRef, '重试成功返回登记引用').toBeTruthy();
    // 同事务核对:登记行的 operation 外键恰指向本次 operation(同 commit)。
    // T031 断言适配修正:本用例仅重试成功一条候选登记(武装失败那份已整体回滚,
    // 前面已断言 registered_candidate=0),JOIN 行数=候选登记行数=1 即证外键互指;
    // 原「toBe(2)」与用例自身行数断言矛盾(测试先行期从未对真实 201 执行)
    const joined = Database.db
      .prepare(
        'SELECT COUNT(*) AS n FROM vod_registered_candidate c JOIN vod_materialization_operation o ON o.household_id = c.household_id AND o.id = c.materialization_operation_id WHERE c.household_id = ?',
      )
      .get(rig.householdId) as { n: number } | undefined;
    expect(joined?.n ?? 0, '登记映射与 operation 同事务(外键互指同提交)').toBe(1);
  });

  it('D3 伪造 candidateRef → 404 同形;过期 candidateRef(DB 直改 expires_at)→ 新 key 410 VOD_PREVIEW_EXPIRED', async () => {
    const rig = await seededRig('hmp-t024-d3-');
    // T031 登记桥接线(设计内形态):伪造面要求 _A/_B 此刻均未登记(404 候选绑定冲突);
    // EP01 稳定键先行直种(过期分支的普通分支物化用)
    const sourceId = seedFixtureVodSource(rig.householdId);
    registerFixtureStableTargets(sourceId);

    // 伪造引用:404 且不同伪造值同形(不可借错误码判别存在性)
    const forgedA = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_A));
    expect(forgedA.status, redLabel('404 伪造候选绑定冲突(I1)', `${forgedA.status} ${String(forgedA.body.code)}`)).toBe(404);
    const forgedB = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_B));
    expect(forgedB.status).toBe(404);
    expect(forgedB.body, '不同伪造引用必须同形 404').toEqual(forgedA.body);
    expect(countOf('vod_registered_candidate', rig.householdId)).toBe(0);

    // 过期分支:成功登记后过期 → 新 key 同 candidateRef 必须 410(不得用过期原候选)
    const stable = await postMaterialize(rig.app, rig.cookie, stableRefBody(TARGET_SERIAL_EP01));
    expect(stable.status, redLabel('201 普通分支首次物化', `${stable.status}`)).toBe(201);
    // T031 登记桥接线(设计内形态):_A 至此才按点直种(伪造断言已先验 404)
    registerFixtureCandidateTarget(rig.householdId, sourceId, FORGED_CANDIDATE_REF_A);
    const candidate = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_A));
    expect(candidate.status, redLabel('201 候选分支物化', `${candidate.status}`)).toBe(201);

    // DB 直改注明:登记候选 24h 保留到期的等价存储事实
    expireRegisteredCandidates(rig.householdId);
    const expired = await postMaterialize(rig.app, rig.cookie, candidateBody(FORGED_CANDIDATE_REF_A));
    expectProblem(expired, 410, 'VOD_PREVIEW_EXPIRED');
  });
});

/* ------------------------------------------------------------------ */
/* E 授权负向封套(当前窗口内绿;T031 装配后自动收紧为精确码)           */
/* ------------------------------------------------------------------ */

/**
 * 授权封套断言:非 2xx 非 5xx + problem+json + no-store;目标码(装配后)与
 * 路由未装配窗口(404)双态可断言 —— 404 分支钉死「Nest 缺省形状」:
 * code=NOT_FOUND 且 detail 以 Cannot POST 开头;T031 装配后同路径不再产生路由级 404,
 * 该分支自动不可达,断言即收紧为精确码(授权次序:认证 → 当前 Profile → 严格入参)。
 */
function expectAuthRejectionEnvelope(res: request.Response, wired: { status: number; code: string }, label: string): void {
  expect(res.status, `${label}:应落在 4xx 客户错误带(窗口内允许路由级 404)`).toBeGreaterThanOrEqual(400);
  expect(res.status, `${label}:不得以 5xx 泄露内部失败`).toBeLessThan(500);
  expect([wired.status, 404], `${label}:应为 ${wired.status} ${wired.code}(窗口内允许 404)`).toContain(res.status);
  expectProblemContentType(res);
  expect(res.headers['cache-control'], `${label}:错误响应须 no-store(api §0)`).toBe('no-store');
  if (res.status === 404) {
    expect(res.body.code, `${label}:404 窗口必须恰为 Nest 未装配路由缺省形状(NOT_FOUND)`).toBe(ProblemCode.NOT_FOUND);
    expect(String(res.body.detail ?? ''), `${label}:404 窗口 detail 应为 Cannot POST(T031 装配后本分支不可达)`).toContain(
      'Cannot POST',
    );
  } else {
    expect(res.body.code, `${label}:精确稳定错误码`).toBe(wired.code);
  }
}

describe('T024 · E 授权负向封套(游客/无 Profile/伪造身份字段;窗口内绿)', () => {
  afterEach(cleanupAllRigs);

  it('E1 游客(无 Cookie)POST 物化 → 401 封套(窗口内为 Nest 缺省 404 形状)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t024-e1-' });
    const res = await postMaterialize(rig.app, '', stableRefBody(TARGET_SERIAL_EP01));
    expectAuthRejectionEnvelope(res, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客物化');
  });

  it('E2 已登录无当前 Profile → 403 封套(DB 直清 active_profile_id,T021 D1 同口径)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t024-e2-' });
    expect((await initialize(rig.app)).status).toBe(201);
    const loggedIn = await login(rig.app, 'admin', 'password-123');
    expect(loggedIn.status).toBe(200);
    // DB 直改注明:清空设备会话当前档案(等价「登录后未选档」态)
    clearActiveProfile();
    // T031 断言适配修正:cookiePairOf 已是「名=值」对,此前 cookieOf 再包一层
    // SESSION_COOKIE= 前缀产生畸形 cookie(SESSION_INVALID 401),守卫次序根本未达
    const res = await postMaterialize(rig.app, cookiePairOf(loggedIn), stableRefBody(TARGET_SERIAL_EP01));
    expectAuthRejectionEnvelope(res, { status: 403, code: ProblemCode.ACTIVE_PROFILE_REQUIRED }, '无当前 Profile 物化');
  });

  it('E3 已选档 + body 伪造 profileId/householdId → 400 封套(身份只从 Session 推导);窗口内零副作用', async () => {
    const rig = await seededRig('hmp-t024-e3-');
    const forged = {
      ...stableRefBody(TARGET_SERIAL_EP01),
      profileId: randomUUID(),
      householdId: randomUUID(),
    };
    const res = await postMaterialize(rig.app, rig.cookie, forged);
    expectAuthRejectionEnvelope(res, { status: 400, code: ProblemCode.VALIDATION_FAILED }, '伪造身份字段物化');
    expect(countOf('vod_materialization_operation', rig.householdId), '拒绝路径零副作用').toBe(0);
    expect(countOf('vod_title', rig.householdId), '拒绝路径零副作用(无父映射)').toBe(0);
  });
});
