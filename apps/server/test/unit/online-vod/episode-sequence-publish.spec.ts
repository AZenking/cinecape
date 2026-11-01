/**
 * 010-online-vod T055:独立导航序列发布/导航查询服务级单测(真实 DDL + 真实 store)。
 *
 * 被测:
 * - contexts/online-vod/application/episode-sequence.service.ts(publishSequence/nextEpisodeFor);
 * - materialization.service.ts 的 T055 接线点(map/commit 步骤内同事务调用 publishSequence);
 * - infrastructure/online-vod-store.drizzle.ts 序列读面(listLatestEpisodeSequences/
 *   listCurrentEpisodeSequences(ByLine)/findEpisodeSequenceAtRevision)。
 *
 * 装配方式(与 T029 服务级 rig 同构,但不经 HTTP/Nest):
 * - 独立临时文件库 + 全量权威迁移 DDL(0001～0007,foreign_keys=ON 真实约束)+
 *   真实 UNIT_OF_WORK(createUnitOfWork + 本用例消费的 6 键真实参与者);
 * - 物化路径经真实 materialize()(resolver 为内存 ref→事实表,零网络/零预览缓存);
 * - 服务级直驱路径经同一 UNIT_OF_WORK 取绑定后的真实 vod 参与者调用 publishSequence;
 * - 导航查询经真实 OnlineVodReadStatements(onlineVodExecutorOf(conn))——非事务读面
 *   与 T027 store 同一语句/谓词/投影;
 * - 序列纯规则面(判定序/缺集保守读法/季界/重复键钉面)由 episode-sequence.spec.ts
 *   钉死,本文件只钉发布与查询事实(修订语义/物化接线/导航读面)。
 *
 * 覆盖清单:
 * - 首次物化三集剧 → 序列 3 行 ordered(rev1/det1,ordinal 1/2/3)→ nextEpisodeFor
 *   标题级链 ep-01→ep-02→ep-03→end_of_line;未知键 unknown_episode;
 * - 重复发布幂等:同 key 重放零写入;异 key 同目标重发 rowsWritten=0、revision 不虚增、
 *   catalogRevision 不虚增;
 * - 修订变化 → 新 revision(service 级直驱):新增集随新 detailRevision 发布 rev2;
 *   旧修订行不可变;纯详情重发布(成员未变)revision 沿用不虚增(§3);
 * - 标题级导航跨线选择:键在两线时解析首个可导航线(main);线级入口显式消歧;
 *   非本标题 lineId → unknown_episode;
 * - 缺集/特典经物化发布:缺 ordinal 3 → missing_ordinal(不猜 03、不跳 04);
 *   特典行 special 且不作起点(跳不过特典 → missing_ordinal)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createUnitOfWork } from '@platform/database/unit-of-work';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createProfileTxReaders } from '@contexts/profile/infrastructure/transaction-participants';
import { createPolicyTxReaders } from '@contexts/policy/infrastructure/transaction-participants';
import { createSourcesTxParticipants } from '@contexts/sources/infrastructure/transaction-participants';
import { createMediaCatalogTxParticipants } from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createOnlineVodTxParticipants } from '@contexts/online-vod/infrastructure/transaction-participants';
import {
  OnlineVodReadStatements,
  onlineVodExecutorOf,
} from '@contexts/online-vod/infrastructure/online-vod-store.drizzle';
import { evaluateEffectiveMediaPolicy } from '@contexts/policy';
import {
  materialize,
  type MaterializationContext,
  type MaterializationQuotas,
  type MaterializationServiceDeps,
  type MaterializeUnitOfWork,
  type ResolvedMaterializationTarget,
} from '@contexts/online-vod/application/materialization.service';
import {
  nextEpisodeFor,
  publishSequence,
  type NextEpisodeForInput,
  type PublishSequenceInput,
  type PublishSequenceOutcome,
} from '@contexts/online-vod/application/episode-sequence.service';
import type { MaterializeCommand } from '@contexts/online-vod/application/publication-work-set.port';
import { createFixtureFakeClock } from '../../fixtures/online-vod/fixture-world';

/* ------------------------------------------------------------------ */
/* 夹具:真实 DDL + 真实事务参与者 + FakeClock(零网络)                    */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

const CLOCK_START_MS = Date.parse('2026-10-30T08:00:00.000Z');
const HH = 'hh-t055';
const ACCOUNT = 'acc-t055';
const PROFILE = 'prof-main-t055';
const DEVICE = 'dev-t055';
const SESSION = 'sess-t055';
const SOURCE_ID = 'src-vod-t055';

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
function seedFixture(conn: SqliteConnection): void {
  const now = iso(CLOCK_START_MS);
  conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(HH, 'T055 夹具家庭', now);
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
    .run(HH, PROFILE, 18, 1, '[]', '[]', '[]', now);
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

/* ----- 解析事实构造(零网络:内存 ref→事实表;生产由 T028/T031 装配桥接) ----- */

interface FixtureEpisode {
  readonly episodeKey: string;
  readonly label: string;
  readonly ordinal: number;
  readonly seasonKey: string | null;
  /** 上游/adapter 判定的非常规集(特典/花絮/正片电影);规则层重推其余分类 */
  readonly special?: boolean;
}

interface FixtureLine {
  readonly lineKey: string;
  readonly displayName: string;
  readonly sortOrder: number;
  readonly episodes: readonly FixtureEpisode[];
}

function buildResolvedTarget(lines: readonly FixtureLine[], upstreamVodId = 'up-100'): ResolvedMaterializationTarget {
  const allEpisodes = lines.flatMap((line) => line.episodes);
  return {
    sourceId: SOURCE_ID,
    upstreamVodId,
    lineKey: lines[0]?.lineKey ?? 'main',
    episodeKey: allEpisodes[0]?.episodeKey ?? 'ep-01',
    previewRevision: 1,
    previewExpiresAt: iso(CLOCK_START_MS + 10 * 60_000),
    detail: {
      detailRevision: 1,
      locatorRevision: 1,
      title: '夹具剧集',
      description: '夹具简介',
      parentContentLevel: null,
      payloadDigest: `digest-${upstreamVodId}`,
      validatedPrivatePayload: JSON.stringify({
        kind: 'fixture-detail',
        upstreamVodId,
        entries: allEpisodes.map(
          (episode) => `https://cache.internal/${upstreamVodId}/${episode.episodeKey}/index.m3u8`,
        ),
      }),
      fetchedAt: iso(CLOCK_START_MS),
      expiresAt: iso(CLOCK_START_MS + 3600_000),
      lines: lines.map((line) => ({
        lineKey: line.lineKey,
        displayName: line.displayName,
        sortOrder: line.sortOrder,
        episodes: line.episodes.map((episode) => ({
          episodeKey: episode.episodeKey,
          label: episode.label,
          ordinal: episode.ordinal,
          seasonKey: episode.seasonKey,
          sequenceRevision: 1,
          sequenceStatus: episode.special === true ? ('special' as const) : ('ordered' as const),
          contentLevel: null,
          contentVersionState: 'unverified' as const,
          evidenceKind: null,
          evidenceDigest: null,
          schemaVersion: null,
          continuityRevision: null,
          continuitySignature: null,
        })),
      })),
    },
  };
}

/* ----- rig 装配 ----- */

interface Rig {
  conn: SqliteConnection;
  deps: MaterializationServiceDeps;
  uow: MaterializeUnitOfWork;
  targets: Map<string, ResolvedMaterializationTarget>;
  resolveTarget: (command: MaterializeCommand) => Promise<ResolvedMaterializationTarget>;
  navigation: OnlineVodReadStatements;
  context: MaterializationContext;
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];

/** 事务注册表字面量(与 T029 rig 同 6 键;具体工厂类型保留,BoundTxStores 结构相容) */
function createRigTxStores() {
  return {
    identityAccess: createIdentityAccessTxReaders,
    profile: createProfileTxReaders,
    policy: createPolicyTxReaders,
    sources: createSourcesTxParticipants,
    catalog: createMediaCatalogTxParticipants,
    vod: createOnlineVodTxParticipants,
  };
}

function createRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t055-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  seedFixture(conn);
  openRigs.push({ conn, dataDir });

  const clock = createFixtureFakeClock({ startMs: CLOCK_START_MS });
  const uow = createUnitOfWork({ resolveDatabase: () => conn, txStores: createRigTxStores() });
  const store = new OnlineVodReadStatements(onlineVodExecutorOf(conn));
  const deps: MaterializationServiceDeps = {
    uow,
    effectiveMediaPolicy: {
      evaluate: (input) => evaluateEffectiveMediaPolicy(input.policy, input.facts),
    },
    quotas: { maxParentTitles: 5000, maxChildEpisodes: 100000 } satisfies MaterializationQuotas,
    readCatalogRevision: (householdId) =>
      (conn.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as
        | { revision: number }
        | undefined)?.revision ?? 1,
    findCommittedOperation: (householdId, deviceSessionId, profileContextVersion, operationKey) =>
      store.findCommittedOperation(householdId, deviceSessionId, profileContextVersion, operationKey),
    nowIso: () => iso(clock.nowMs()),
  };
  const targets = new Map<string, ResolvedMaterializationTarget>();
  const resolveTarget = async (command: MaterializeCommand): Promise<ResolvedMaterializationTarget> => {
    const key = command.kind === 'candidateRef' ? `cand:${command.candidateRef}` : command.episodeRef;
    const target = targets.get(key);
    if (target === undefined) {
      throw new Error(`T055 rig:未登记解析事实 ${key}(夹具装配错误)`);
    }
    return target;
  };

  return {
    conn,
    deps,
    uow,
    targets,
    resolveTarget,
    navigation: store,
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

const stableCommand = (episodeRef: string, operationKey: string = randomUUID()): MaterializeCommand => ({
  kind: 'stableRef',
  titleRef: `vod-title-${episodeRef}`,
  episodeRef,
  previewRevision: 1,
  operationKey,
});

interface RawSequenceRow {
  household_id: string;
  title_id: string;
  line_id: string;
  detail_revision: number;
  sequence_revision: number;
  episode_id: string;
  season_key: string | null;
  ordinal: number;
  sequence_status: string;
}

function allSequenceRows(conn: SqliteConnection): RawSequenceRow[] {
  return conn
    .prepare('SELECT * FROM vod_episode_sequence ORDER BY line_id, ordinal, episode_id')
    .all() as RawSequenceRow[];
}

function requireTitleId(conn: SqliteConnection): string {
  const title = conn.prepare('SELECT id FROM vod_title').get() as { id: string } | undefined;
  if (title === undefined) {
    throw new Error('夹具缺 vod_title 行');
  }
  return title.id;
}

function requireLineIdBySortOrder(conn: SqliteConnection, sortOrder: number): string {
  const line = conn
    .prepare('SELECT id FROM vod_line WHERE household_id = ? AND sort_order = ?')
    .get(HH, sortOrder) as { id: string } | undefined;
  if (line === undefined) {
    throw new Error(`夹具缺 sort_order=${sortOrder} 的 vod_line 行`);
  }
  return line.id;
}

/** 事务内直驱 publishSequence(真实绑定参与者;发布与物化同一事务路径) */
function publishInTx(rig: Rig, input: PublishSequenceInput): PublishSequenceOutcome {
  return rig.uow.run(
    (tx) => tx.vod,
    (vod) => publishSequence(vod, input),
    { behavior: 'immediate' },
  );
}

function navigate(rig: Rig, titleId: string, lineId: string | null, currentEpisodeKey: string) {
  const input: NextEpisodeForInput = {
    householdId: HH,
    titleId,
    lineId,
    currentEpisodeKey,
  };
  return nextEpisodeFor(rig.navigation, input);
}

/** 以现有 vod_episode 行键 → 行 id 映射构造发布输入(直驱路径复用) */
function episodeIdByKey(conn: SqliteConnection): Map<string, string> {
  return new Map(
    (
      conn.prepare('SELECT id, episode_key FROM vod_episode ORDER BY episode_key').all() as {
        id: string;
        episode_key: string;
      }[]
    ).map((row) => [row.episode_key, row.id]),
  );
}

/** 模拟后台详情推进:指针 + 不可变快照行(物化 CAS 面之外的服务级直驱前置事实) */
function advanceDetailPointer(conn: SqliteConnection, titleId: string, revision: number): void {
  conn
    .prepare('UPDATE vod_title SET current_detail_revision = ? WHERE household_id = ? AND id = ?')
    .run(revision, HH, titleId);
  conn
    .prepare(
      `INSERT INTO vod_detail_snapshot (household_id, title_id, revision, locator_revision, validated_private_payload, fetched_at, expires_at)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      HH,
      titleId,
      revision,
      JSON.stringify({ kind: 'fixture-detail', revision }),
      iso(CLOCK_START_MS),
      iso(CLOCK_START_MS + 3600_000),
    );
}

/** 新增一集的最小真实行(media_item vod_episode 角色 + vod_episode;序列行 FK 事实) */
function insertEpisodeRow(
  conn: SqliteConnection,
  input: { lineId: string; episodeKey: string; label: string },
): string {
  const now = iso(CLOCK_START_MS);
  const mediaId = `media-${input.episodeKey}`;
  conn
    .prepare(
      `INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at)
       VALUES (?, ?, 'episode', ?, 1, 'vod_episode', ?, ?)`,
    )
    .run(mediaId, HH, input.label, now, now);
  const episodeId = `vdep-${input.episodeKey}`;
  conn
    .prepare(
      `INSERT INTO vod_episode (id, household_id, line_id, episode_key, label, media_id, content_version_state, continuity_revision)
       VALUES (?, ?, ?, ?, ?, ?, 'unverified', 1)`,
    )
    .run(episodeId, HH, input.lineId, input.episodeKey, input.label, mediaId);
  return episodeId;
}

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

describe('T055 · 物化接线:首次发布与导航链(真实 DDL + 真实 store)', () => {
  it('物化三集剧:序列 3 行 ordered(rev1/det1,ordinal 1/2/3)随同事务发布;nextEpisodeFor 标题级链 ep-01→02→03→end_of_line', async () => {
    const rig = createRig();
    rig.targets.set(
      'ep-01',
      buildResolvedTarget([
        {
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [
            { episodeKey: 'ep-01', label: '第01集', ordinal: 1, seasonKey: 'S01' },
            { episodeKey: 'ep-02', label: '第02集', ordinal: 2, seasonKey: 'S01' },
            { episodeKey: 'ep-03', label: '第03集', ordinal: 3, seasonKey: 'S01' },
          ],
        },
      ]),
    );

    const outcome = await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    expect(outcome.replayed).toBe(false);
    expect(outcome.detailRevision).toBe(1);
    expect(outcome.catalogRevision).toBe(2);

    const titleId = requireTitleId(rig.conn);
    const rows = allSequenceRows(rig.conn);
    expect(rows, '三集剧恰 3 条序列行(每集一行,行身份 rowid)').toHaveLength(3);
    expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.sequence_status)).toEqual(['ordered', 'ordered', 'ordered']);
    expect(rows.map((row) => row.sequence_revision)).toEqual([1, 1, 1]);
    expect(rows.map((row) => row.detail_revision)).toEqual([1, 1, 1]);
    expect(rows.map((row) => row.season_key)).toEqual(['S01', 'S01', 'S01']);
    expect(rows.every((row) => row.household_id === HH && row.title_id === titleId)).toBe(true);

    // 导航链:nextEpisodeFor 物化后即可回答 EP01→02→03;next 行携带完整身份
    const nextOf01 = navigate(rig, titleId, null, 'ep-01');
    expect(nextOf01.status).toBe('ordered');
    expect(nextOf01.reason).toBeNull();
    expect(nextOf01.next?.lineKey).toBe('main');
    expect(nextOf01.next?.episodeKey).toBe('ep-02');
    expect(nextOf01.next?.ordinal).toBe(2);
    expect(nextOf01.next?.mediaId, 'next 行携带完整身份(子媒体稳定 ID 非空)').toBeTruthy();
    expect(navigate(rig, titleId, null, 'ep-02').next?.episodeKey).toBe('ep-03');
    const afterTail = navigate(rig, titleId, null, 'ep-03');
    expect(afterTail.status).toBe('ordered');
    expect(afterTail.next).toBeNull();
    expect(afterTail.reason).toBe('end_of_line');
    // 未知键防御:不抛错、不猜
    const unknown = navigate(rig, titleId, null, 'zz');
    expect(unknown).toEqual({ status: 'ambiguous', next: null, reason: 'unknown_episode' });
  });
});

describe('T055 · 重复发布幂等(revision 不虚增)', () => {
  it('同 key 重放零写入(replayed=true);异 key 同目标重发 rowsWritten=0、序列修订/公共 revision 均不虚增', async () => {
    const rig = createRig();
    rig.targets.set(
      'ep-01',
      buildResolvedTarget([
        {
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [
            { episodeKey: 'ep-01', label: '第01集', ordinal: 1, seasonKey: 'S01' },
            { episodeKey: 'ep-02', label: '第02集', ordinal: 2, seasonKey: 'S01' },
          ],
        },
      ]),
    );
    const firstOpKey = stableCommand('ep-01').operationKey;
    const first = await materialize(rig.deps, stableCommand('ep-01', firstOpKey), rig.context, rig.resolveTarget);
    expect(first.catalogRevision).toBe(2);
    expect(allSequenceRows(rig.conn)).toHaveLength(2);

    // 同 key 重放:原结果原样返回,零新增(发布路径根本不进入)。
    const replay = await materialize(rig.deps, stableCommand('ep-01', firstOpKey), rig.context, rig.resolveTarget);
    expect(replay.replayed).toBe(true);
    expect(allSequenceRows(rig.conn), '重放零新增').toHaveLength(2);

    // 异 key 同目标重发:成员/顺序/年季/资格未变 → 修订沿用 1;行级幂等守卫零新行;
    // 无公开变化 → catalogRevision 不虚增。
    const reuse = await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    expect(reuse.replayed).toBe(false);
    expect(reuse.catalogRevision, '复用无公开变化,revision 不虚增').toBe(2);
    const rows = allSequenceRows(rig.conn);
    expect(rows, '重发零新行(同 detail_revision 快照幂等)').toHaveLength(2);
    expect(rows.map((row) => row.sequence_revision)).toEqual([1, 1]);
    expect(rows.map((row) => row.detail_revision)).toEqual([1, 1]);
  });
});

describe('T055 · 修订变化 → 新 revision(service 级直驱,§3 递增语义)', () => {
  it('新增集随新 detailRevision 发布 rev2(旧修订行不可变);纯详情重发布(成员未变)修订沿用不虚增', async () => {
    const rig = createRig();
    rig.targets.set(
      'ep-01',
      buildResolvedTarget([
        {
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [
            { episodeKey: 'ep-01', label: '第01集', ordinal: 1, seasonKey: 'S01' },
            { episodeKey: 'ep-02', label: '第02集', ordinal: 2, seasonKey: 'S01' },
            { episodeKey: 'ep-03', label: '第03集', ordinal: 3, seasonKey: 'S01' },
          ],
        },
      ]),
    );
    await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    const titleId = requireTitleId(rig.conn);
    const lineId = requireLineIdBySortOrder(rig.conn, 1);
    const ids = episodeIdByKey(rig.conn);

    // ── 后台详情推进(指针 1→2 + 不可变快照行)+ 新增第 4 集(成员变化)──
    advanceDetailPointer(rig.conn, titleId, 2);
    const ep04Id = insertEpisodeRow(rig.conn, { lineId, episodeKey: 'ep-04', label: '第04集' });
    const publishInput: PublishSequenceInput = {
      householdId: HH,
      sourceId: SOURCE_ID,
      titleId,
      detailRevision: 2,
      lines: [
        {
          lineId,
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [
            { episodeId: ids.get('ep-01') ?? '', episodeKey: 'ep-01', mediaId: null, seasonKey: 'S01', ordinal: 1, special: false },
            { episodeId: ids.get('ep-02') ?? '', episodeKey: 'ep-02', mediaId: null, seasonKey: 'S01', ordinal: 2, special: false },
            { episodeId: ids.get('ep-03') ?? '', episodeKey: 'ep-03', mediaId: null, seasonKey: 'S01', ordinal: 3, special: false },
            { episodeId: ep04Id, episodeKey: 'ep-04', mediaId: null, seasonKey: 'S01', ordinal: 4, special: false },
          ],
        },
      ],
    };
    const advanced = publishInTx(rig, publishInput);
    expect(advanced.revisionAdvanced, '成员变化 → 修订递增').toBe(true);
    expect(advanced.sequenceRevision).toBe(2);
    expect(advanced.rowsWritten, '新快照随新 detailRevision 整片发布(4 行)').toBe(4);

    let rows = allSequenceRows(rig.conn);
    expect(rows, '旧修订行不可变不删除(3 旧 + 4 新)').toHaveLength(7);
    const oldRows = rows.filter((row) => row.detail_revision === 1);
    const newRows = rows.filter((row) => row.detail_revision === 2);
    expect(oldRows.map((row) => row.sequence_revision)).toEqual([1, 1, 1]);
    expect(newRows.map((row) => row.sequence_revision)).toEqual([2, 2, 2, 2]);
    expect(newRows.map((row) => row.ordinal)).toEqual([1, 2, 3, 4]);

    // 当前指针修订下的导航直接回答新链尾部
    expect(navigate(rig, titleId, null, 'ep-03').next?.episodeKey).toBe('ep-04');
      expect(navigate(rig, titleId, null, 'ep-04').reason).toBe('end_of_line');

      // ── 纯详情重发布(成员/顺序/年季/资格未变):修订沿用 2,不虚增(§3)──
      advanceDetailPointer(rig.conn, titleId, 3);
      const unchanged = publishInTx(rig, { ...publishInput, detailRevision: 3 });
      expect(unchanged.revisionAdvanced).toBe(false);
      expect(unchanged.sequenceRevision, '纯详情变化不虚增修订').toBe(2);
      expect(unchanged.rowsWritten, '快照随新 detailRevision 一同发布').toBe(4);
      rows = allSequenceRows(rig.conn);
      expect(Math.max(...rows.map((row) => row.sequence_revision))).toBe(2);
      expect(rows.filter((row) => row.detail_revision === 3)).toHaveLength(4);
      expect(navigate(rig, titleId, null, 'ep-03').next?.episodeKey).toBe('ep-04');
  });
});

describe('T055 · 标题级导航跨线选择与线级消歧入口', () => {
  it('键在两线时标题级解析首个可导航线(main);线级入口显式消歧 backup;非本标题 lineId → unknown_episode', async () => {
    const rig = createRig();
    rig.targets.set(
      'ep-01',
      buildResolvedTarget([
        {
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [
            { episodeKey: 'ep-01', label: '第01集', ordinal: 1, seasonKey: 'S01' },
            { episodeKey: 'ep-02', label: '第02集', ordinal: 2, seasonKey: 'S01' },
          ],
        },
        {
          lineKey: 'backup',
          displayName: '备用线',
          sortOrder: 2,
          episodes: [
            { episodeKey: 'ep-01', label: '第01集', ordinal: 1, seasonKey: 'S01' },
            { episodeKey: 'ep-02', label: '第02集', ordinal: 2, seasonKey: 'S01' },
            { episodeKey: 'ep-03', label: '第03集', ordinal: 3, seasonKey: 'S01' },
          ],
        },
      ]),
    );
    await materialize(rig.deps, stableCommand('ep-01'), rig.context, rig.resolveTarget);
    const titleId = requireTitleId(rig.conn);
    const mainLineId = requireLineIdBySortOrder(rig.conn, 1);
    const backupLineId = requireLineIdBySortOrder(rig.conn, 2);

    // 标题级:'ep-01' 双线皆有 → 按 sortOrder 首个可导航线(main)→ main 的 ep-02
    const titleLevel = navigate(rig, titleId, null, 'ep-01');
    expect(titleLevel.status).toBe('ordered');
    expect(titleLevel.next?.lineKey).toBe('main');
    expect(titleLevel.next?.episodeKey).toBe('ep-02');

    // 线级显式消歧:backup 线内 ep-01 → backup 自己的 ep-02(与 main 的 ep-02 不同行对象)
    const lineLevel = navigate(rig, titleId, backupLineId, 'ep-01');
    expect(lineLevel.status).toBe('ordered');
    expect(lineLevel.next?.lineKey).toBe('backup');
    expect(lineLevel.next?.episodeKey).toBe('ep-02');
    expect(lineLevel.next?.mediaId, '同键异线 = 不同行(线级入口消歧)').not.toBe(titleLevel.next?.mediaId);

    // main 线级入口与标题级同链(同线内判定)
    expect(navigate(rig, titleId, mainLineId, 'ep-01').next?.episodeKey).toBe('ep-02');
    // 仅 backup 有的键:标题级定位 backup;线内走完 → end_of_line
    const tail = navigate(rig, titleId, null, 'ep-03');
    expect(tail.status).toBe('ordered');
    expect(tail.next).toBeNull();
    expect(tail.reason).toBe('end_of_line');
    // 非本标题 lineId:保守 unknown_episode(不跨标题导航)
    expect(navigate(rig, titleId, 'line-not-exist', 'ep-01')).toEqual({
      status: 'ambiguous',
      next: null,
      reason: 'unknown_episode',
    });
  });
});

describe('T055 · 缺集/特典经物化发布(保守读法读侧对偶)', () => {
  it('缺 ordinal 3 → missing_ordinal(不猜 03、不跳 04);特典行 special 且不作起点(跳不过特典)', async () => {
    // ── 缺集:main 01/02/04 ──
    const gapped = createRig();
    gapped.targets.set(
      'ep-01',
      buildResolvedTarget([
        {
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [
            { episodeKey: 'ep-01', label: '第01集', ordinal: 1, seasonKey: 'S01' },
            { episodeKey: 'ep-02', label: '第02集', ordinal: 2, seasonKey: 'S01' },
            { episodeKey: 'ep-04', label: '第04集', ordinal: 4, seasonKey: 'S01' },
          ],
        },
      ]),
    );
    await materialize(gapped.deps, stableCommand('ep-01'), gapped.context, gapped.resolveTarget);
    const gappedTitleId = requireTitleId(gapped.conn);
    // 缺集行仍有序位 → 行状态全部 ordered(「导航与身份分开」:分类与导航判定分开)
    expect(allSequenceRows(gapped.conn).map((row) => row.sequence_status)).toEqual([
      'ordered',
      'ordered',
      'ordered',
    ]);
    const gapOutcome = navigate(gapped, gappedTitleId, null, 'ep-02');
    expect(gapOutcome.status).toBe('ambiguous');
    expect(gapOutcome.next).toBeNull();
    expect(gapOutcome.reason).toBe('missing_ordinal');
    expect(gapOutcome.next?.episodeKey).not.toBe('ep-04');
    expect(navigate(gapped, gappedTitleId, null, 'ep-01').next?.episodeKey).toBe('ep-02');
    expect(navigate(gapped, gappedTitleId, null, 'ep-04').reason).toBe('end_of_line');

    // ── 特典:main 01/02/SP(ordinal 3, special)/04 ──
    const special = createRig();
    special.targets.set(
      'ep-01',
      buildResolvedTarget([
        {
          lineKey: 'main',
          displayName: '主线',
          sortOrder: 1,
          episodes: [
            { episodeKey: 'ep-01', label: '第01集', ordinal: 1, seasonKey: 'S01' },
            { episodeKey: 'ep-02', label: '第02集', ordinal: 2, seasonKey: 'S01' },
            { episodeKey: 'sp-00', label: '特典·制作花絮', ordinal: 3, seasonKey: null, special: true },
            { episodeKey: 'ep-04', label: '第04集', ordinal: 4, seasonKey: 'S01' },
          ],
        },
      ]),
    );
    await materialize(special.deps, stableCommand('ep-01'), special.context, special.resolveTarget);
    const specialTitleId = requireTitleId(special.conn);
    const rows = allSequenceRows(special.conn);
    expect(rows.map((row) => row.sequence_status)).toEqual(['ordered', 'ordered', 'special', 'ordered']);
    // 特典不作起点
    const fromSpecial = navigate(special, specialTitleId, null, 'sp-00');
    expect(fromSpecial.status).toBe('special');
    expect(fromSpecial.next).toBeNull();
    expect(fromSpecial.reason).toBe('special_episode');
    // 特典不作合法 N+1 目标:02 之后 ordinal 3 槽位被特典占据 → 缺集语义停止(跳不过,不猜)
    const acrossSpecial = navigate(special, specialTitleId, null, 'ep-02');
    expect(acrossSpecial.status).toBe('ambiguous');
    expect(acrossSpecial.next).toBeNull();
    expect(acrossSpecial.reason).toBe('missing_ordinal');
  });
});
