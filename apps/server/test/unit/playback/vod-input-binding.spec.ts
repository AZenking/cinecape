/**
 * 010-online-vod T038(测试先行,US2)—— VOD 固定输入绑定 / generation 原子换绑 / 未起播回收行为契约。
 *
 * T038 原文(tasks.md):「先新增 apps/server/test/unit/playback/vod-input-binding.spec.ts:
 *  probe/资产/转换同input、一次准备重试/取消、修订变更终止、generation原子换绑、
 *  旧代输出不能ready、重启清理及readyAt60s未playback_started_at回收。」
 * 审查补充:「测试未知duration合格playing后超过60s保留、无playing仍回收及watchdog CAS竞争」。
 *
 * ⚠️ 计划内红(文件顶部声明):
 *   - 被测高层模块 `@contexts/playback/infrastructure/playback-input-store.drizzle`
 *     (T042 扩展:固定 ResolvedVodInput 及私有绑定;T045/T062/T081 扩展:watchdog 扫描面)
 *     尚不存在。本文件经**唯一一处动态 import**(loadPlannedVodInputStore)消费它:
 *     既有基础设施面用例可正常收集并全绿;标 [T042-*]/[T045-*] 的用例即计划内红。
 *   - `pnpm --filter @hmp/server typecheck` 预期恰好 1 条 TS2307 指向该模块路径,零其他错误。
 *   - `vitest run` 本文件:「既有基础设施面」describe 全绿(除标题带 [T042 缺口暴露] 的
 *     客观缺陷钉面,见下),「计划内红」describe 全红(模块未找到)。T042/T045 落地后全绿。
 *
 * 用例 ↔ 实现状态映射(文件头映射):
 *   T038-A 唯一绑定/冻结起点        → 既有面绿(InputBindingTx + 0007 唯一索引/CHECK);
 *                                     [T042 缺口暴露] 1 例预期红(NULL 冻结后二次冻结可覆盖)
 *   T038-B 同 input 固定            → 既有面绿(绑定行=当前代唯一输入源);
 *                                     [T042-B] 红(resolveVodInput 幂等固定/不重读最新 location)
 *   T038-C 一次准备替换             → [T042-C] 红(replaceUnacceptedProbeInput 一次/二次拒绝)
 *   T038-D 修订变更终止             → 既有面绿(冻结修订×当前修订失配输入面);
 *                                     [T042-D] 红(失配判定→终止写入→新交付拒绝)
 *   T038-E generation 原子换绑      → 既有面绿(CAS/同事务/失败前无变化/failed 不倒退/seq 不归零);
 *                                     [T042-E] 红(旧代撤销同事务/代次回退拒绝)
 *   T038-F 旧代不 ready             → [T042-F] 红(旧代票/资产/probe 提交拒绝 409)
 *   T038-G 重启清理                 → 既有面绿(cleanup 持久标记跨连接/重启扫描形态)
 *   T038-H 60s 回收/watchdog CAS    → 既有面绿(起播标记单向 CAS/终态竞争/heartbeat 持久面);
 *                                     [T045-H] 红(60s 固定期限/未知 duration 保留/无 playing 回收/
 *                                     两 watcher 竞争)
 *   T038-I 暂停不重开期限           → 既有面绿(起播事实持久前提);[T045-I] 红(暂停不重开)
 *
 * 权威依据(先读后写):
 * - docs/specs/010-online-vod/data-model.md §6「固定输入、generation及起点」:
 *   「每 session/generation 最多一有效绑定」「resolved_input 私有」「仅 current generation
 *   可新交付;seek/会重建输出选择:CAS推进generation+新绑定同resolved_input_id+旧代撤销/
 *   cleanup标记同事务;失败前无变化,失败后新代failed不倒退,seq不归零」「新代沿用输入,
 *   不暗换最新地址」「首次定位允许一次替换未接受的probe输入;先取消旧probe及输出再原子换引用」
 *   「本次probe后统一冻结一次位置」;§9「未有playback_started_at的ready会话以服务器readyAt起
 *   60s固定期限回收(等待手势不延长、heartbeat/renew不续命),独立playback_started_at由已交付后
 *   的合格playing观测设置后解除该期限」;§10「playing观测与session标记同短事务、CAS重验;
 *   无时长仍可设置」「cleanup_requested/持久执行状态;标记先阻止新票/资产」。
 * - docs/specs/010-online-vod/contracts/api.md §7 I4「起播确认语义」:「playing接受先后与
 *   watchdog用同一session CAS竞争,终态不可复活」「暂停不重新开启该60s期限;服务端重建
 *   generation不重置session级起播事实」。
 * - docs/specs/010-online-vod/tasks.md T038/T042/T044/T045 原文(上引);contracts/internal-ports.md
 *   §1 PlaybackInputLifecyclePort「probe/资产/转换统一消费输入ID及租约」;contracts/playback-state.md
 *   §7「probe后结果只可提交当前代」「代次推进前失败原代可用,推进后失败新代failed,不回退;
 *   session的seq不重置」。
 * - 既有基线:test/unit/playback/retention.spec.ts / lifecycle.spec.ts(rig 手法)、
 *   test/unit/online-vod/materialization-service.spec.ts(真实 DDL + 真实 UNIT_OF_WORK rig)、
 *   T016 已实现事务参与者(DrizzlePlaybackTxParticipants/DrizzlePersonalDataTxParticipants)。
 *
 * 夹具分层:独立临时文件库 + 全量权威迁移 DDL(0001–0007,foreign_keys=ON 真实约束)+
 * 真实 createUnitOfWork(playback/personalData 两键真实参与者)+ fixture-world FakeClock
 * (T005;期限/租约时刻全部经 clock 推进,不写魔数时刻)。行种子直插(复合 FK/CHECK 全满足)。
 *
 * readyAt 锚点说明:schema 无 ready_at 列(data-model §9「服务器readyAt」未定锚点列)。
 * 本文件以「行 created_at = ready 时刻」的种子钉死 60s 固定期限语义(会话直接以 ready 态落行,
 * 准备完成时刻即 created_at);T045/T081 若采用其他锚点(新增列等)须保证该语义不变,报告已列。
 *
 * 建议导出面(供 T042/T045 实现;本文件 [T042-*]/[T045-*] 用例即其行为契约,详见任务报告):
 *   drizzleVodInputStore(deps: { handle?: Db; nowMs?: () => number }): VodInputStore
 *   interface VodInputStore {
 *     // —— T042 固定输入面 ——
 *     resolveVodInput(command, io: { resolveUpstream }): Promise<{ resolvedInputId }>  // 同 session/generation 幂等;resolveUpstream 全程恰一次
 *     bindFixedInput(command: {…; startBasis; frozenStartSeconds?: null }): Promise<{ bindingId }>
 *     inputForDelivery(householdId, sessionId, generation): { resolvedInputId }        // probe/资产/转换统一消费点
 *     replaceUnacceptedProbeInput(command: {…; nextInputId }): Promise<void>           // 一次;再调/已接受 → DomainError 409
 *     assertFixedInputCurrent(command: {…; expected: { locator/detail/content/continuity Revision } }): void  // 失配 → DomainError 409
 *     failSessionOnRevisionMismatch(command: {…; reason }): void                       // 终止写入(撤交付+failed 同提交)
 *     advanceGenerationWithRebind(command: {…; expectedGeneration; nextGeneration }): Promise<void>
 *       // CAS 推进 + 新绑定同 resolved_input_id + 旧代撤销(cleanup_requested=1)同事务;回退代次拒绝
 *     assertGenerationDeliverable(householdId, sessionId, generation): void            // 旧代 → DomainError 409 PLAYBACK_GENERATION_STALE
 *     assertProbeCommitGeneration(householdId, sessionId, generation): void            // probe 结果只可提交当前代
 *     // —— T045/T062/T081 watchdog 扫描面(持久原语;节拍调度归 playback-retention.service) ——
 *     listReclaimableUnstartedReadySessions(input: { nowMs }): { householdId; sessionId; readyAtMs }[]
 *     reclaimExpiredUnstartedReadySession(input: { householdId; sessionId; nowMs }): Promise<{ reclaimed: boolean }>
 *   }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { createFixtureFakeClock, type FixtureFakeClock } from '../../fixtures/online-vod/fixture-world';
import { createUnitOfWork, type UnitOfWork } from '@platform/database/unit-of-work';
import { DomainError } from '@platform/http-common/domain-error';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
import type {
  InputBindingInsertValues,
  InputBindingTx,
  PlaybackDeliveryFactReader,
  PlaybackSessionTx,
  PlaybackTrustedFactsReader,
  ProgressClockTx,
  SessionLedgerTx,
  StartBasis,
} from '@contexts/playback/application/playback-work-set.port';

/* ------------------------------------------------------------------ */
/* 计划内红装载点(全文件唯一 TS2307 来源)                                */
/* ------------------------------------------------------------------ */

/** T042 固定输入定位事实(store 经 io.resolveUpstream 注入的唯一上游读取点;T042 location.service 生产形态) */
interface VodResolvedInputFacts {
  readonly entryUrl: string;
  readonly locatorRevision: number;
  readonly detailRevision: number | null;
  readonly contentRevision: number;
  readonly continuityRevision: number | null;
  readonly evidenceState: 'unverified' | 'verified';
  readonly evidenceDigest: string;
  readonly leaseSeconds: number;
}

/** 修订失配检测期望面(assertFixedInputCurrent 输入;省略维度不参与失配判定) */
interface VodInputRevisionExpectation {
  readonly locatorRevision?: number;
  readonly detailRevision?: number | null;
  readonly contentRevision?: number;
  readonly continuityRevision?: number | null;
}

/** 回收清单行(watchdog 扫描面) */
interface VodReclaimableSessionRow {
  readonly householdId: string;
  readonly sessionId: string;
  readonly readyAtMs: number;
}

/**
 * T042/T045 建议导出面(本文件 [T042-*]/[T045-*] 用例即其行为契约;实现任务落地时以此为接口基线):
 * - T042 固定输入面:resolveVodInput/bindFixedInput/inputForDelivery/replaceUnacceptedProbeInput/
 *   assertFixedInputCurrent/failSessionOnRevisionMismatch/advanceGenerationWithRebind/
 *   assertGenerationDeliverable/assertProbeCommitGeneration;
 * - T045/T062/T081 watchdog 扫描面(持久原语;节拍调度归 playback-retention.service):
 *   listReclaimableUnstartedReadySessions/reclaimExpiredUnstartedReadySession。
 */
interface VodInputStoreSuggested {
  resolveVodInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ resolvedInputId: string }>;
  bindFixedInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string; startBasis: StartBasis },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ bindingId: string }>;
  inputForDelivery(householdId: string, sessionId: string, generation: number): Promise<{ resolvedInputId: string }>;
  replaceUnacceptedProbeInput(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    nextInputId: string;
  }): Promise<void>;
  assertFixedInputCurrent(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    expected: VodInputRevisionExpectation;
  }): void;
  failSessionOnRevisionMismatch(command: { householdId: string; sessionId: string; generation: number; reason: string }): void;
  advanceGenerationWithRebind(command: {
    householdId: string;
    sessionId: string;
    expectedGeneration: number;
    nextGeneration: number;
  }): Promise<void>;
  assertGenerationDeliverable(householdId: string, sessionId: string, generation: number): void;
  assertProbeCommitGeneration(householdId: string, sessionId: string, generation: number): void;
  listReclaimableUnstartedReadySessions(input: { nowMs: number }): Promise<VodReclaimableSessionRow[]>;
  reclaimExpiredUnstartedReadySession(input: { householdId: string; sessionId: string; nowMs: number }): Promise<{ reclaimed: boolean }>;
}

/** store 工厂形态(与 drizzlePlaybackStore/drizzleOnlineVodStore 同 rig seam:注入句柄+时钟) */
type VodInputStoreModule = {
  drizzleVodInputStore: (deps: { handle?: SqliteConnection; nowMs?: () => number }) => VodInputStoreSuggested;
};

/**
 * 被测模块由 T042 创建(playback-input-store.drizzle)/T045·T062·T081 扩展(watchdog 扫描面),
 * 当前不存在:动态 import 使既有基础设施面用例可正常收集并全绿;
 * 调用本装载点的用例即计划内红。typecheck 预期恰好 1 条 TS2307 指向该模块。
 */
async function loadPlannedVodInputStore(): Promise<VodInputStoreModule> {
  return import('@contexts/playback/infrastructure/playback-input-store.drizzle');
}

/* ------------------------------------------------------------------ */
/* 夹具:真实 DDL + 真实事务参与者 + FakeClock(materialization rig 同构)   */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

const CLOCK_START_MS = Date.parse('2026-10-30T08:00:00.000Z');
/** 输入租约有界(<= 10 分钟;CHECK expires_at > resolved_at) */
const INPUT_LEASE_MS = 10 * 60_000;
/** 未起播回收固定期限(data-model §9:readyAt 起 60s,不因等待手势/heartbeat/renew 延长) */
const UNSTARTED_READY_RECLAIM_MS = 60_000;

interface RigSeed {
  householdId: string;
  accountId: string;
  profileId: string;
  deviceId: string;
  deviceSessionId: string;
  sourceId: string;
  parentMediaId: string;
  episodeMediaId: string;
  titleId: string;
  lineId: string;
  episodeId: string;
  sourceEntryId: string;
  playbackSourceId: string;
}

interface Rig {
  conn: SqliteConnection;
  dataDir: string;
  /** rig 主库文件路径(「重启副本」连接按同一路径重开,验证持久化跨连接) */
  dbPath: string;
  clock: FixtureFakeClock;
  t0: number;
  uow: UnitOfWork<{
    playback: typeof createPlaybackTxParticipants;
    personalData: typeof createPersonalDataTxParticipants;
  }>;
  seed: RigSeed;
}

const openRigs: { conn: SqliteConnection; extraConns: SqliteConnection[]; dataDir: string }[] = [];

/** 全量权威迁移(与 T029 rig 同源;FK ON 下逐语句零违反) */
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

/** UTC ISO-8601(毫秒,Z) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** VOD 在线链路种子(FK 依赖序):身份 → vod 源 → 目录(父/集)→ entry → 在线 playback_source */
function seedVodWorld(conn: SqliteConnection, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t038-${randomUUID()}`;
  const accountId = `acc-t038-${randomUUID()}`;
  const profileId = `prof-t038-${randomUUID()}`;
  const deviceId = `dev-t038-${randomUUID()}`;
  const deviceSessionId = `dsess-t038-${randomUUID()}`;
  const sourceId = `src-t038-${randomUUID()}`;
  const parentMediaId = `media-parent-t038-${randomUUID()}`;
  const episodeMediaId = `media-ep-t038-${randomUUID()}`;
  const titleId = `vtitle-t038-${randomUUID()}`;
  const lineId = `vline-t038-${randomUUID()}`;
  const episodeId = `vep-t038-${randomUUID()}`;
  const sourceEntryId = `entry-t038-${randomUUID()}`;
  const playbackSourceId = `psrc-t038-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T038 夹具家庭', now);
    conn
      .prepare(
        'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(accountId, householdId, 'admin', 'admin', 'hash', 'admin', now);
    conn
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, created_at) VALUES (?, ?, ?, '主档案', 'adult', 1, 'active', ?)",
      )
      .run(profileId, householdId, accountId, now);
    conn.prepare("INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, 'web', ?)").run(deviceId, householdId, now);
    conn
      .prepare(
        'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(deviceSessionId, householdId, accountId, deviceId, `token-hash-${deviceSessionId}`, profileId, iso(t0 + 7 * 24 * 3600_000), now, now);
    // vod 源:remote_url 必填、NAS/EPG 绑定为空(data-model §2)
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T038 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(sourceId, householdId, now, now);
    conn.prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')").run(householdId, sourceId);
    // 目录:父(vod_title)与集(vod_episode)媒体
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', 'T038 剧集', 1, 'vod_title', ?, ?)",
      )
      .run(parentMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', '第01集', 1, 'vod_episode', ?, ?)",
      )
      .run(episodeMediaId, householdId, now, now);
    conn
      .prepare(
        'INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      )
      .run(titleId, householdId, sourceId, 'up-100', parentMediaId, now);
    conn
      .prepare('INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, 1)')
      .run(lineId, householdId, titleId, 'main', '主线');
    conn
      .prepare(
        "INSERT INTO vod_episode (id, household_id, line_id, episode_key, label, media_id, content_version_state) VALUES (?, ?, ?, 'ep-01', '第01集', ?, 'unverified')",
      )
      .run(episodeId, householdId, lineId, episodeMediaId);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(sourceEntryId, householdId, sourceId, 'a'.repeat(64), episodeMediaId, now, now);
    // 在线资源判别联合:locator_kind=online → location NULL + vod 引用非空 + protocol=hls
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, vod_episode_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', NULL, 100, 0, 'online', ?, ?, ?)",
      )
      .run(playbackSourceId, householdId, sourceId, sourceEntryId, episodeMediaId, episodeId, now, now);
  })();
  return {
    householdId,
    accountId,
    profileId,
    deviceId,
    deviceSessionId,
    sourceId,
    parentMediaId,
    episodeMediaId,
    titleId,
    lineId,
    episodeId,
    sourceEntryId,
    playbackSourceId,
  };
}

/** 事务参与者注册表(rig 与「重启副本」连接共用同一工厂引用) */
const TX_STORES = {
  playback: createPlaybackTxParticipants,
  personalData: createPersonalDataTxParticipants,
};

/** 本文件消费的工作集成员(与 TransitionConsumeWorkSet 的 playback/personalData 面对齐) */
interface RigWorkSet {
  readonly session: PlaybackSessionTx;
  readonly inputBinding: InputBindingTx;
  readonly trustedFacts: PlaybackTrustedFactsReader;
  readonly deliveryFacts: PlaybackDeliveryFactReader;
  readonly progressClock: ProgressClockTx;
  readonly ledger: SessionLedgerTx;
}

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t038-vod-input-'));
  const dbPath = path.join(dataDir, `${randomUUID()}.db`);
  const conn = new DatabaseConstructor(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const clock = createFixtureFakeClock({ startMs: CLOCK_START_MS });
  const seed = seedVodWorld(conn, CLOCK_START_MS);
  openRigs.push({ conn, extraConns: [], dataDir });
  return {
    conn,
    dataDir,
    dbPath,
    clock,
    t0: CLOCK_START_MS,
    uow: createUnitOfWork({ resolveDatabase: () => conn, txStores: TX_STORES }),
    seed,
  };
}

/** 同步事务封装(uow run 全同步;callback 抛错即整体回滚) */
function inTx<T>(rig: Rig, callback: (workSet: RigWorkSet) => T): T {
  return rig.uow.run(
    (tx) => ({
      session: tx.playback,
      inputBinding: tx.playback,
      trustedFacts: tx.playback,
      deliveryFacts: tx.playback,
      progressClock: tx.personalData,
      ledger: tx.personalData,
    }),
    callback,
    { behavior: 'immediate' },
  );
}

/* ------------------------------------------------------------------ */
/* 夹具:行直插与行读取                                                   */
/* ------------------------------------------------------------------ */

/** 直插播放会话(默认 ready 态:source/delivery 非空;created_at=ready 时刻即期限锚点) */
function insertPlaybackSession(
  conn: SqliteConnection,
  seed: RigSeed,
  input: {
    sessionId: string;
    atMs: number;
    state?: 'preparing' | 'ready' | 'playing' | 'paused';
    delivery?: string;
    startedAtMs?: number | null;
    playbackStartedAtMs?: number | null;
    lastHeartbeatAtMs?: number;
  },
): string {
  const state = input.state ?? 'ready';
  const delivery = input.delivery ?? (state === 'preparing' ? null : 'hls_proxy');
  conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, audio_track_id, subtitle_track_id, desired_paused,
        profile_context_version, playback_started_at, cleanup_requested, cleanup_reason, cleanup_state,
        created_at, started_at, ended_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, 0, 1, ?, 0, NULL, 'pending', ?, ?, NULL, ?, NULL)`,
    )
    .run(
      input.sessionId,
      seed.householdId,
      seed.deviceSessionId,
      seed.deviceId,
      seed.profileId,
      seed.episodeMediaId,
      state === 'preparing' ? null : seed.playbackSourceId,
      state,
      delivery,
      input.playbackStartedAtMs === undefined || input.playbackStartedAtMs === null
        ? null
        : iso(input.playbackStartedAtMs),
      iso(input.atMs),
      input.startedAtMs === undefined || input.startedAtMs === null ? null : iso(input.startedAtMs),
      iso(input.lastHeartbeatAtMs ?? input.atMs),
    );
  return input.sessionId;
}

interface BindingRowRead {
  id: string;
  session_id: string;
  generation: number;
  resolved_input_id: string;
  start_basis: string;
  frozen_start_seconds: number | null;
  cleanup_requested: number;
  cleanup_state: string;
}

function bindingRowsOf(conn: SqliteConnection, householdId: string, sessionId: string): BindingRowRead[] {
  return conn
    .prepare(
      `SELECT id, session_id, generation, resolved_input_id, start_basis, frozen_start_seconds,
              cleanup_requested, cleanup_state
       FROM playback_input_binding WHERE household_id = ? AND session_id = ? ORDER BY generation ASC`,
    )
    .all(householdId, sessionId) as BindingRowRead[];
}

function requireBindingRow(conn: SqliteConnection, householdId: string, sessionId: string, generation: number): BindingRowRead {
  const row = bindingRowsOf(conn, householdId, sessionId).find((candidate) => candidate.generation === generation);
  expect(row, `generation ${generation} 绑定行应存在(session ${sessionId})`).toBeDefined();
  return row as BindingRowRead;
}

interface SessionRowRead {
  id: string;
  state: string;
  generation: number;
  version: number;
  playback_started_at: string | null;
  cleanup_requested: number;
  cleanup_reason: string | null;
  cleanup_state: string;
  created_at: string;
  ended_at: string | null;
  failure_code: string | null;
  last_heartbeat_at: string;
}

function sessionRowOf(conn: SqliteConnection, sessionId: string): SessionRowRead {
  const row = conn
    .prepare(
      `SELECT id, state, generation, version, playback_started_at, cleanup_requested, cleanup_reason,
              cleanup_state, created_at, ended_at, failure_code, last_heartbeat_at
       FROM playback_session WHERE id = ?`,
    )
    .get(sessionId) as SessionRowRead | undefined;
  expect(row, `session ${sessionId} 应存在`).toBeDefined();
  return row as SessionRowRead;
}

interface LedgerRowRead {
  last_sample_seq: number;
  last_generation: number;
  ledger_generation: number | null;
  ledger_position: number | null;
  session_started: number;
}

function ledgerRowOf(conn: SqliteConnection, householdId: string, sessionId: string): LedgerRowRead | undefined {
  return conn
    .prepare(
      `SELECT last_sample_seq, last_generation, ledger_generation, ledger_position, session_started
       FROM playback_progress_state WHERE household_id = ? AND playback_session_id = ?`,
    )
    .get(householdId, sessionId) as LedgerRowRead | undefined;
}

/* ------------------------------------------------------------------ */
/* 夹具:端口值集构造                                                     */
/* ------------------------------------------------------------------ */

/** 绑定写入值集(010 收敛:detail/content 冻结修订、resolved_input_id 私有不透明、租约有界) */
function bindingValues(
  rig: Rig,
  input: {
    sessionId: string;
    generation: number;
    resolvedInputId: string;
    startBasis?: StartBasis;
    frozenStartSeconds?: number | null;
    contentRevision?: number;
    locatorRevision?: number;
    detailRevision?: number | null;
    continuityRevision?: number | null;
  },
): InputBindingInsertValues {
  const resolvedAtMs = rig.clock.nowMs();
  return {
    id: randomUUID(),
    householdId: rig.seed.householdId,
    sessionId: input.sessionId,
    generation: input.generation,
    playbackSourceId: rig.seed.playbackSourceId,
    sourceId: rig.seed.sourceId,
    locatorRevision: input.locatorRevision ?? 1,
    detailRevision: input.detailRevision === undefined ? 1 : input.detailRevision,
    contentRevision: input.contentRevision ?? 1,
    continuityRevision: input.continuityRevision === undefined ? null : input.continuityRevision,
    evidenceState: 'unverified',
    evidenceDigest: 'b'.repeat(64),
    resolvedInputId: input.resolvedInputId,
    resolvedAt: iso(resolvedAtMs),
    expiresAt: iso(resolvedAtMs + INPUT_LEASE_MS),
    startBasis: input.startBasis ?? 'beginning',
    frozenStartSeconds: input.frozenStartSeconds ?? null,
  };
}

function bindGeneration(
  rig: Rig,
  input: {
    sessionId: string;
    generation: number;
    resolvedInputId: string;
    startBasis?: StartBasis;
    contentRevision?: number;
    locatorRevision?: number;
    detailRevision?: number | null;
    continuityRevision?: number | null;
  },
): InputBindingInsertValues {
  const values = bindingValues(rig, input);
  inTx(rig, (workSet) => {
    workSet.inputBinding.insertBinding(values);
  });
  return values;
}

/** ledger 首次建档(allocate epoch + insert row;与 session 建档同事务为生产形态,此处独立事务) */
function initLedger(rig: Rig, sessionId: string): number {
  return inTx(rig, (workSet) => {
    const epoch = workSet.progressClock.allocateProgressEpoch(rig.seed.householdId, rig.seed.profileId);
    workSet.ledger.insertLedgerRow({
      householdId: rig.seed.householdId,
      playbackSessionId: sessionId,
      profileId: rig.seed.profileId,
      mediaId: rig.seed.episodeMediaId,
      candidateEpoch: epoch,
      contentRevision: 1,
      profileContextVersion: 1,
      lastGeneration: 1,
      continuityRevision: 1,
      lastResult: null,
    });
    return epoch;
  });
}

/** 接受样本推进 ledger 游标(seq 跨 generation 单调;stale 判定归 application,此处仅接受分支) */
function applyLedgerSample(
  rig: Rig,
  sessionId: string,
  input: { sampleSeq: number; generation: number; positionSeconds: number; durationSeconds?: number | null },
): void {
  inTx(rig, (workSet) => {
    workSet.ledger.applyAcceptedSample(rig.seed.householdId, sessionId, {
      sampleSeq: input.sampleSeq,
      sampleDigest: `digest-seq-${input.sampleSeq}`,
      generation: input.generation,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds ?? null,
      continuityRevision: 1,
      acceptedAt: iso(rig.clock.nowMs()),
      sessionStarted: true,
    });
  });
}

/** SQLITE 约束违例断言(唯一/CHECK 同形:约束前缀 + 事务回滚由各用例自行验证) */
function expectSqliteConstraint(action: () => void, label: string): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `${label}:应被 SQLITE 约束拒绝`).toBeInstanceOf(Error);
  const error = thrown as { code?: string; message?: string };
  expect(error.code ?? '', `${label}:应为 SQLITE_CONSTRAINT 约束错误`).toMatch(/^SQLITE_CONSTRAINT/);
}

afterEach(() => {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    if (rig === undefined) {
      break;
    }
    rig.conn.close();
    for (const extra of rig.extraConns) {
      extra.close();
    }
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* T038-A 唯一绑定与冻结起点(既有基础设施面:T016 InputBindingTx + 0007 约束) */
/* ------------------------------------------------------------------ */

describe('T038-A 唯一绑定与冻结起点(T016 InputBindingTx 既有面)', () => {
  it('绑定落行全列投影:start_basis 三域可落、frozen_start_seconds 为 NULL 直到 probe、resolved_input_id 私有不透明', () => {
    const rig = openRig();
    const bases: readonly StartBasis[] = ['beginning', 'target_history', 'transition_carry'];
    const sessionIds = bases.map((basis, index) =>
      insertPlaybackSession(rig.conn, rig.seed, { sessionId: `sess-a1-${index}`, atMs: rig.clock.nowMs() }),
    );
    bases.forEach((basis, index) => {
      bindGeneration(rig, {
        sessionId: sessionIds[index] as string,
        generation: 1,
        resolvedInputId: `resolved-input-${basis}`,
        startBasis: basis,
      });
    });
    bases.forEach((basis, index) => {
      const row = requireBindingRow(rig.conn, rig.seed.householdId, sessionIds[index] as string, 1);
      expect(row.start_basis).toBe(basis);
      expect(row.frozen_start_seconds, 'probe 前 frozen_start_seconds 必须 NULL(nullable 直到 probe)').toBeNull();
      expect(row.resolved_input_id).toBe(`resolved-input-${basis}`);
      expect(row.cleanup_requested).toBe(0);
      expect(row.cleanup_state, '绑定 cleanup 初值 pending(持久执行状态列)').toBe('pending');
    });
  });

  it('同 session/generation 第二次绑定被拒:唯一索引钉死「每 session/generation 至多一有效绑定」,冲突事务整体回滚零残留', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-a2', atMs: rig.clock.nowMs() });
    bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-first' });

    // 已有绑定代内二次绑定(异 resolved_input_id)→ 唯一索引拒绝,本事务零残留
    expectSqliteConstraint(
      () =>
        inTx(rig, (workSet) => {
          workSet.inputBinding.insertBinding(bindingValues(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-second' }));
        }),
      '同 session/generation 二次绑定',
    );
    expect(bindingRowsOf(rig.conn, rig.seed.householdId, sessionId)).toHaveLength(1);
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).resolved_input_id).toBe('resolved-input-first');

    // 同事务先写其他会话合法绑定、再撞唯一冲突 → 整体回滚,合法分支同样零残留(失败前无变化)
    const otherSessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-a2-other', atMs: rig.clock.nowMs() });
    expectSqliteConstraint(
      () =>
        inTx(rig, (workSet) => {
          workSet.inputBinding.insertBinding(
            bindingValues(rig, { sessionId: otherSessionId, generation: 1, resolvedInputId: 'resolved-input-other' }),
          );
          workSet.inputBinding.insertBinding(
            bindingValues(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-conflict' }),
          );
        }),
      '同事务合法分支随冲突回滚',
    );
    expect(bindingRowsOf(rig.conn, rig.seed.householdId, otherSessionId), '冲突事务内合法写入必须一并回滚').toHaveLength(0);
    expect(sessionRowOf(rig.conn, sessionId).version).toBe(1);
  });

  it('probe 后冻结起点仅一次:第二次 freeze 不覆盖首次值(NULL → 值单向)', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-a3', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-a3' });
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).frozen_start_seconds).toBeNull();

    inTx(rig, (workSet) => {
      workSet.inputBinding.freezeStartSeconds(rig.seed.householdId, values.id, 30);
    });
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).frozen_start_seconds).toBe(30);

    // 第二次冻结(45)不得覆盖「本次 probe 后统一冻结一次位置」的首次值
    inTx(rig, (workSet) => {
      workSet.inputBinding.freezeStartSeconds(rig.seed.householdId, values.id, 45);
    });
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).frozen_start_seconds).toBe(30);
  });

  it('[T042 缺口暴露] NULL 冻结(起点未知属合法冻结结果)后二次冻结不得覆盖 —— 现 T016 面无「已冻结为 NULL」记录,违背端口「仅冻结一次」契约', () => {
    // 权威:internal-ports InputBindingTx.freezeStartSeconds「NULL 合法,仅冻结一次」;
    // data-model §6「本次probe后统一冻结一次位置」。NULL 是 probe 的合法冻结结论,
    // 之后的任何 freeze 调用都属第二次冻结,不得改变已冻结(NULL)事实。
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-a4', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-a4' });

    inTx(rig, (workSet) => {
      workSet.inputBinding.freezeStartSeconds(rig.seed.householdId, values.id, null);
    });
    inTx(rig, (workSet) => {
      workSet.inputBinding.freezeStartSeconds(rig.seed.householdId, values.id, 30);
    });
    expect(
      requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).frozen_start_seconds,
      'NULL 冻结后二次冻结不得写入(缺口:持久层无法区分「已冻结为 NULL」与「尚未冻结」)',
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* T038-B 同 input 固定(既有面:绑定行是当前代唯一输入源)                  */
/* ------------------------------------------------------------------ */

describe('T038-B 同 input 固定(既有面:绑定行是当前代唯一输入源,重读不漂移)', () => {
  it('绑定行重读不漂移:findActiveBinding 两次读深一致,且 trusted facts 与绑定行同源(修订/起点面一致)', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-b1', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, {
      sessionId,
      generation: 1,
      resolvedInputId: 'resolved-input-b1',
      startBasis: 'target_history',
      locatorRevision: 3,
      detailRevision: 2,
      contentRevision: 1,
      continuityRevision: 1,
    });

    const first = inTx(rig, (workSet) => workSet.inputBinding.findActiveBinding(rig.seed.householdId, sessionId, 1));
    const second = inTx(rig, (workSet) => workSet.inputBinding.findActiveBinding(rig.seed.householdId, sessionId, 1));
    expect(first).toBeDefined();
    expect(second).toEqual(first);
    expect(first?.resolvedInputId).toBe('resolved-input-b1');

    // 受信事实与绑定行同源:probe/资产/转换共用该行判定(不含任何重读最新 location 的旁路)
    const facts = inTx(rig, (workSet) => workSet.trustedFacts.findSessionTrustedFacts(rig.seed.householdId, sessionId));
    expect(facts).toBeDefined();
    expect(facts?.generation).toBe(1);
    expect(facts?.state).toBe('ready');
    expect(facts?.playbackSourceId).toBe(rig.seed.playbackSourceId);
    expect(facts?.sourceId).toBe(rig.seed.sourceId);
    expect(facts?.locatorRevision).toBe(values.locatorRevision);
    expect(facts?.detailRevision).toBe(values.detailRevision);
    expect(facts?.contentRevision).toBe(values.contentRevision);
    expect(facts?.continuityRevision).toBe(values.continuityRevision);
    expect(facts?.startBasis).toBe('target_history');
    expect(facts?.frozenStartSeconds).toBeNull();
    // probe 受信时长:持久层无列,未知为 null(不以 0 冒充;未知 duration 场景的持久前提)
    expect(facts?.probeDurationSeconds).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* T038-D 修订失配输入面(既有面:冻结修订 × 目录当前修订)                  */
/* ------------------------------------------------------------------ */

describe('T038-D 修订失配输入面(既有面:失配检测输入齐备;终止判定归 T042/T043)', () => {
  it('目录 content_revision 推进后受信事实反映新值:绑定冻结修订(旧)× 当前修订(新)失配可检测', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-d1', atMs: rig.clock.nowMs() });
    bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-d1', contentRevision: 1 });

    const before = inTx(rig, (workSet) => workSet.trustedFacts.findSessionTrustedFacts(rig.seed.householdId, sessionId));
    expect(before?.contentRevision, '绑定冻结修订').toBe(1);
    expect(before?.mediaContentRevision).toBe(1);

    // 上游已知内容替换:目录内容修订推进(历史保存产生时的修订不批量跟随,data-model §3)
    rig.conn
      .prepare('UPDATE media_item SET content_revision = 2, updated_at = ? WHERE household_id = ? AND id = ?')
      .run(iso(rig.clock.nowMs()), rig.seed.householdId, rig.seed.episodeMediaId);

    const after = inTx(rig, (workSet) => workSet.trustedFacts.findSessionTrustedFacts(rig.seed.householdId, sessionId));
    // 失配对(冻结 1 × 当前 2)即 T043「ready 前重验 content/continuity」与 T042 终止判定的输入
    expect(after?.contentRevision).toBe(1);
    expect(after?.mediaContentRevision).toBe(2);
    // 绑定行自身不被目录推进暗改(冻结事实不可变)
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).resolved_input_id).toBe('resolved-input-d1');
  });

  it('绑定修订/枚举列域负向:content/locator 修订 <1、非法 evidence_state/start_basis 被 CHECK 拒绝(参数化)', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-d2', atMs: rig.clock.nowMs() });
    const invalid: readonly { readonly name: string; readonly patch: Partial<InputBindingInsertValues> }[] = [
      { name: 'contentRevision=0', patch: { contentRevision: 0 } },
      { name: 'locatorRevision=0', patch: { locatorRevision: 0 } },
      { name: 'detailRevision=0', patch: { detailRevision: 0 } },
      { name: 'continuityRevision=0', patch: { continuityRevision: 0 } },
      { name: 'evidenceState=bogus', patch: { evidenceState: 'bogus' as InputBindingInsertValues['evidenceState'] } },
      { name: 'startBasis=resume', patch: { startBasis: 'resume' as StartBasis } },
      { name: 'frozenStartSeconds=-1', patch: { frozenStartSeconds: -1 } },
    ];
    for (const testCase of invalid) {
      const base = bindingValues(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-d2' });
      expectSqliteConstraint(
        () =>
          inTx(rig, (workSet) => {
            workSet.inputBinding.insertBinding({ ...base, ...testCase.patch });
          }),
        testCase.name,
      );
    }
    expect(bindingRowsOf(rig.conn, rig.seed.householdId, sessionId), '全部负向写必须零残留').toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* T038-E generation 原子换绑(既有面:CAS/同事务/失败前无变化/不倒退/seq 不归零) */
/* ------------------------------------------------------------------ */

describe('T038-E generation 原子换绑(T016 既有面)', () => {
  it('成功换绑同事务:CAS 推进 generation+新绑定同 resolved_input_id;session 起播标记跨代保留;旧代绑定行保留为历史', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-e1', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-e1' });
    // 服务端重建 generation 不重置 session 级起播事实(api §7 I4)—— 换绑前先设置起播标记
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, sessionId, iso(rig.clock.nowMs()));
    });

    inTx(rig, (workSet) => {
      workSet.session.advanceGeneration(rig.seed.householdId, sessionId, 1, 2);
      workSet.inputBinding.insertBinding(bindingValues(rig, { sessionId, generation: 2, resolvedInputId: values.resolvedInputId }));
    });

    const row = sessionRowOf(rig.conn, sessionId);
    expect(row.generation).toBe(2);
    expect(row.version, 'CAS 推进须 version+1').toBe(2);
    expect(row.playback_started_at, 'generation 推进不清除 session 级起播事实').not.toBeNull();
    const gen2 = requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 2);
    expect(gen2.resolved_input_id, '新代沿用同输入,不暗换最新地址(data-model §6)').toBe(values.resolvedInputId);
    // 旧代绑定行保留(旧代撤销/cleanup 标记属 T042 同事务面,见 [T042-E] 计划内红)
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).resolved_input_id).toBe(values.resolvedInputId);
  });

  it('陈旧 expectedGeneration 的 advanceGeneration 无持久变化(输赢由事务内重读判定,exec 无 changes 返回的端口约定)', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-e2', atMs: rig.clock.nowMs() });
    bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-e2' });

    // expected=1 陈旧(当前已是 2):守卫式 CAS 不命中 → 零行写入
    inTx(rig, (workSet) => {
      workSet.session.advanceGeneration(rig.seed.householdId, sessionId, 2, 3);
    });
    const row = sessionRowOf(rig.conn, sessionId);
    expect(row.generation).toBe(1);
    expect(row.version).toBe(1);
    // 事务内重读协议:换绑组合(推进+新绑定)必须以同事务重读到的代次为准(见 [T042-E] store 面 CAS)
    const inTxGeneration = inTx(rig, (workSet) => workSet.session.findSession(rig.seed.householdId, sessionId)?.generation);
    expect(inTxGeneration).toBe(1);
  });

  it('失败前无变化:换绑事务中途注入 CHECK 违例 → 代次/新绑定/旧绑定/ledger 全部回滚', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-e3', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-e3' });
    initLedger(rig, sessionId);
    applyLedgerSample(rig, sessionId, { sampleSeq: 1, generation: 1, positionSeconds: 5 });

    expectSqliteConstraint(
      () =>
        inTx(rig, (workSet) => {
          workSet.session.advanceGeneration(rig.seed.householdId, sessionId, 1, 2);
          // 注入点:locator_revision=0 违反 CHECK,令事务中途失败
          workSet.inputBinding.insertBinding(
            bindingValues(rig, { sessionId, generation: 2, resolvedInputId: values.resolvedInputId, locatorRevision: 0 }),
          );
        }),
      '换绑事务中途 CHECK 违例',
    );

    const row = sessionRowOf(rig.conn, sessionId);
    expect(row.generation, '失败前无变化:代次不推进').toBe(1);
    expect(row.version).toBe(1);
    expect(bindingRowsOf(rig.conn, rig.seed.householdId, sessionId), 'gen2 绑定零残留').toHaveLength(1);
    expect(ledgerRowOf(rig.conn, rig.seed.householdId, sessionId)?.last_sample_seq).toBe(1);
  });

  it('失败后新代 failed 不倒退:终态持久+二写 no-op 不覆盖首者事实+旧代 CAS 不可回退', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-e4', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-e4' });
    inTx(rig, (workSet) => {
      workSet.session.advanceGeneration(rig.seed.householdId, sessionId, 1, 2);
      workSet.inputBinding.insertBinding(bindingValues(rig, { sessionId, generation: 2, resolvedInputId: values.resolvedInputId }));
    });

    // 新代 probe 失败 → 终态写入(failed + 稳定失败码;ended_at 必填由 CHECK 保证)
    const failedAt = iso(rig.clock.nowMs());
    inTx(rig, (workSet) => {
      workSet.session.markSessionTerminal(rig.seed.householdId, sessionId, 'failed', ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED, failedAt);
    });
    const failedRow = sessionRowOf(rig.conn, sessionId);
    expect(failedRow.state).toBe('failed');
    expect(failedRow.failure_code).toBe(ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED);
    expect(failedRow.ended_at).toBe(failedAt);
    expect(failedRow.generation, '失败发生在新代:代次不回退(data-model §6「失败后新代failed不倒退」)').toBe(2);
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 2).resolved_input_id).toBe(values.resolvedInputId);

    // 后到终态写(如 watchdog 回收)不得覆盖首者终态事实(终态不可复活/不可改写)
    await rig.clock.advanceMs(5_000);
    inTx(rig, (workSet) => {
      workSet.session.markSessionTerminal(rig.seed.householdId, sessionId, 'interrupted', null, iso(rig.clock.nowMs()));
    });
    const rowAfterSecondWrite = sessionRowOf(rig.conn, sessionId);
    expect(rowAfterSecondWrite.state).toBe('failed');
    expect(rowAfterSecondWrite.ended_at).toBe(failedAt);
    expect(rowAfterSecondWrite.failure_code).toBe(ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED);
  });

  it('seq 不归零:ledger 游标跨 generation 连续递增,换代事务不触碰 ledger', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-e5', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-e5' });
    initLedger(rig, sessionId);
    applyLedgerSample(rig, sessionId, { sampleSeq: 1, generation: 1, positionSeconds: 5 });
    applyLedgerSample(rig, sessionId, { sampleSeq: 2, generation: 1, positionSeconds: 10 });
    const beforeAdvance = ledgerRowOf(rig.conn, rig.seed.householdId, sessionId);
    expect(beforeAdvance?.last_sample_seq).toBe(2);

    inTx(rig, (workSet) => {
      workSet.session.advanceGeneration(rig.seed.householdId, sessionId, 1, 2);
      workSet.inputBinding.insertBinding(bindingValues(rig, { sessionId, generation: 2, resolvedInputId: values.resolvedInputId }));
    });
    const afterAdvance = ledgerRowOf(rig.conn, rig.seed.householdId, sessionId);
    expect(afterAdvance?.last_sample_seq, 'seq 不归零:换代事务不动 ledger 游标').toBe(2);

    // 新代首个已接受样本从游标继续(跨 generation 单调)
    applyLedgerSample(rig, sessionId, { sampleSeq: 3, generation: 2, positionSeconds: 20 });
    const row = ledgerRowOf(rig.conn, rig.seed.householdId, sessionId);
    expect(row?.last_sample_seq).toBe(3);
    expect(row?.last_generation).toBe(2);
    expect(row?.ledger_generation).toBe(2);
    expect(row?.ledger_position).toBe(20);
  });
});

/* ------------------------------------------------------------------ */
/* T038-G 重启清理持久化(既有面:持久标记非内存 refcount)                  */
/* ------------------------------------------------------------------ */

describe('T038-G 重启清理(T016 既有面)', () => {
  it('requestCleanup 持久标记+原因+pending 状态;新参与者实例(重启扫描形态)重读仍可见', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-g1', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-g1' });

    inTx(rig, (workSet) => {
      workSet.session.requestCleanup(rig.seed.householdId, sessionId, 'watchdog: 未起播超期回收');
    });
    const row = sessionRowOf(rig.conn, sessionId);
    expect(row.cleanup_requested).toBe(1);
    expect(row.cleanup_reason).toBe('watchdog: 未起播超期回收');
    expect(row.cleanup_state).toBe('pending');

    // 「重启」形态:同一库上新参与者实例(新 uow run)读同一持久标记 —— 非内存 refcount
    const reread = inTx(rig, (workSet) => workSet.session.findSession(rig.seed.householdId, sessionId));
    expect(reread?.cleanupRequested).toBe(1);
    expect(reread?.cleanupState).toBe('pending');
    expect(reread?.cleanupReason).toBe('watchdog: 未起播超期回收');
    expect(values.id.length).toBeGreaterThan(0);
  });

  it('第二连接(重启副本)可扫描 pending cleanup 并推进绑定 cleanup complete;原连接同见(持久执行状态跨连接)', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-g2', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-g2' });
    inTx(rig, (workSet) => {
      workSet.session.requestCleanup(rig.seed.householdId, sessionId, 'transition-cleanup');
    });

    const restartConn = new DatabaseConstructor(rig.dbPath);
    restartConn.pragma('journal_mode = WAL');
    restartConn.pragma('foreign_keys = ON');
    openRigs.at(-1)?.extraConns.push(restartConn);

    const restartUow = createUnitOfWork({ resolveDatabase: () => restartConn, txStores: TX_STORES });
    const scanned = restartUow.run(
      (tx) => ({ session: tx.playback, inputBinding: tx.playback }),
      (workSet) => {
        const found = workSet.session.findSession(rig.seed.householdId, sessionId);
        expect(found?.cleanupRequested).toBe(1);
        expect(found?.cleanupState).toBe('pending');
        // 启动扫描语义:pending 标记可被推进为 complete(持久执行状态,非内存引用计数)
        workSet.inputBinding.markBindingCleanupComplete(rig.seed.householdId, values.id);
        return workSet.session.findSession(rig.seed.householdId, sessionId);
      },
      { behavior: 'immediate' },
    );
    expect(scanned?.cleanupState).toBe('pending');
    expect(
      (rig.conn.prepare('SELECT cleanup_state FROM playback_input_binding WHERE id = ?').get(values.id) as { cleanup_state: string })
        .cleanup_state,
      '绑定 cleanup complete 对原连接可见(同库持久)',
    ).toBe('complete');
  });

  it('markBindingCleanupComplete 仅 pending→complete 幂等推进', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-g3', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-g3' });
    inTx(rig, (workSet) => {
      workSet.inputBinding.markBindingCleanupComplete(rig.seed.householdId, values.id);
    });
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).cleanup_state).toBe('complete');
    inTx(rig, (workSet) => {
      workSet.inputBinding.markBindingCleanupComplete(rig.seed.householdId, values.id);
    });
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).cleanup_state).toBe('complete');
  });
});

/* ------------------------------------------------------------------ */
/* T038-H/I 起播标记与回收 CAS 持久基础(既有面;60s 期限逻辑=计划内红)      */
/* ------------------------------------------------------------------ */

describe('T038-H/I 起播标记与回收 CAS 持久基础(T016 既有面)', () => {
  it('playback_started_at 单向首次设置:二次标记不覆盖;未知 duration(无受信时长/冻结起点 NULL)仍可设置;deliveryFacts 反映', () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-h1', atMs: rig.clock.nowMs() });
    bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-h1' });

    // 未知 duration 场景:绑定 frozen_start 仍 NULL、无受信时长 —— 合格 playing 仍可设置标记
    const startedAt = iso(rig.clock.nowMs());
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, sessionId, startedAt);
    });
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, sessionId, iso(rig.clock.nowMs() + 30_000));
    });
    const facts = inTx(rig, (workSet) => workSet.deliveryFacts.findDeliveryFacts(rig.seed.householdId, sessionId));
    expect(facts?.playbackStartedAt, '起播标记首者赢,二次标记不覆盖(api §7 I4 CAS)').toBe(startedAt);
    expect(facts?.generation).toBe(1);
    expect(facts?.delivery).toBe('hls_proxy');
    expect(facts?.state).toBe('ready');
  });

  it('watchdog CAS 竞争基础:终态先赢者保持 —— 后到 playing 标记不复活、后到终态写不覆盖(终态不可复活)', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-h2', atMs: rig.clock.nowMs() });

    // watcher A(回收)先赢:终态提交
    const reclaimedAt = iso(rig.clock.nowMs());
    inTx(rig, (workSet) => {
      workSet.session.markSessionTerminal(rig.seed.householdId, sessionId, 'interrupted', null, reclaimedAt);
    });
    // 后到的 playing 确认(与 watchdog 同一 session CAS 的输家分支):不得复活会话
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, sessionId, iso(rig.clock.nowMs()));
    });
    const rowAfterPlaying = sessionRowOf(rig.conn, sessionId);
    expect(rowAfterPlaying.state, '终态不可复活:后到 playing 标记不得改变终态事实').toBe('interrupted');
    expect(rowAfterPlaying.ended_at).toBe(reclaimedAt);
    // 第二个回收 watcher(基于过期活动态观察)再写终态:不得覆盖首者事实
    await rig.clock.advanceMs(5_000);
    inTx(rig, (workSet) => {
      workSet.session.markSessionTerminal(rig.seed.householdId, sessionId, 'interrupted', null, iso(rig.clock.nowMs()));
    });
    const rowAfterSecondWatcher = sessionRowOf(rig.conn, sessionId);
    expect(rowAfterSecondWatcher.ended_at, '输家终态写不得覆盖首者 ended_at').toBe(reclaimedAt);
    expect(rowAfterSecondWatcher.state).toBe('interrupted');
  });

  it('heartbeat/renew 不续命(持久面):touchHeartbeat 只推进 last_heartbeat_at,不触碰起播/清理标记与创建时刻', async () => {
    const rig = openRig();
    const readyAtMs = rig.clock.nowMs();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-h3', atMs: readyAtMs });
    bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-h3' });
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, sessionId, iso(readyAtMs + 1_000));
    });
    const before = sessionRowOf(rig.conn, sessionId);

    await rig.clock.advanceMs(15_000);
    inTx(rig, (workSet) => {
      workSet.session.touchHeartbeat(rig.seed.householdId, sessionId, iso(rig.clock.nowMs()));
    });
    const after = sessionRowOf(rig.conn, sessionId);
    expect(after.last_heartbeat_at).toBe(iso(readyAtMs + 15_000));
    expect(after.playback_started_at, 'heartbeat/renew 不解除也不重置起播标记').toBe(before.playback_started_at);
    expect(after.created_at, 'heartbeat 不延长 readyAt 锚点(60s 固定期限不因 renew 续命)').toBe(before.created_at);
    expect(after.cleanup_requested).toBe(before.cleanup_requested);
    expect(after.state).toBe('ready');
  });

  it('session 级起播事实跨 generation/清理标记/终态保留:换绑、cleanup、终态均不清除 playback_started_at(暂停不重开期限的持久前提)', async () => {
    const rig = openRig();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-i1', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-i1' });
    const startedAt = iso(rig.clock.nowMs());
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, sessionId, startedAt);
    });

    inTx(rig, (workSet) => {
      workSet.session.advanceGeneration(rig.seed.householdId, sessionId, 1, 2);
      workSet.inputBinding.insertBinding(bindingValues(rig, { sessionId, generation: 2, resolvedInputId: values.resolvedInputId }));
      workSet.session.requestCleanup(rig.seed.householdId, sessionId, 'switch-successor-cleanup');
    });
    expect(sessionRowOf(rig.conn, sessionId).playback_started_at).toBe(startedAt);

    await rig.clock.advanceMs(30_000);
    // 已起播会话的失联/回收终态(既有生命周期)不清除起播事实
    inTx(rig, (workSet) => {
      workSet.session.markSessionTerminal(rig.seed.householdId, sessionId, 'interrupted', null, iso(rig.clock.nowMs()));
    });
    const terminalRow = sessionRowOf(rig.conn, sessionId);
    expect(terminalRow.playback_started_at).toBe(startedAt);
    expect(terminalRow.cleanup_requested).toBe(1);
    expect(terminalRow.cleanup_reason).toBe('switch-successor-cleanup');
    expect(terminalRow.cleanup_state).toBe('pending');
  });
});

/* ------------------------------------------------------------------ */
/* T038 计划内红(T042 固定输入 store / T045 watchdog):模块落地后本组须全绿  */
/* ------------------------------------------------------------------ */

describe('T038 计划内红(T042/T045):固定输入 store 与 watchdog 契约', () => {
  it('[T042-B] probe/资产/转换同 input:resolveVodInput 同 session/generation 幂等固定,重复消费不重读最新 location;入口 URL 不入库', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r1', atMs: rig.clock.nowMs() });

    const resolveUpstreamCalls: string[] = [];
    let upstreamVariant = 0;
    const io = {
      resolveUpstream: async () => {
        upstreamVariant += 1;
        resolveUpstreamCalls.push(`v${upstreamVariant}`);
        return {
          entryUrl: `https://cache.fixture/ep-01/v${upstreamVariant}/index.m3u8`,
          locatorRevision: 1,
          detailRevision: 1,
          contentRevision: 1,
          continuityRevision: null,
          evidenceState: 'unverified' as const,
          evidenceDigest: 'c'.repeat(64),
          leaseSeconds: 600,
        };
      },
    };
    const command = { householdId: rig.seed.householdId, sessionId, generation: 1, sourceId: rig.seed.sourceId };

    const first = await vodInput.resolveVodInput(command, io);
    await vodInput.bindFixedInput({ ...command, startBasis: 'beginning' }, io);

    // probe / 资产(hls_proxy 转写)/ 转换(supervisor)三个消费方各自读取:同一 resolved_input_id
    const probe = await vodInput.inputForDelivery(command.householdId, sessionId, 1);
    const assets = await vodInput.inputForDelivery(command.householdId, sessionId, 1);
    const conversion = await vodInput.inputForDelivery(command.householdId, sessionId, 1);
    expect(probe.resolvedInputId).toBe(first.resolvedInputId);
    expect(assets.resolvedInputId).toBe(first.resolvedInputId);
    expect(conversion.resolvedInputId).toBe(first.resolvedInputId);
    expect(resolveUpstreamCalls, 'probe/资产/转换不得各自重读最新 location(T044 接固定 input)').toHaveLength(1);

    // 上游地址轮换后的二次 resolve:仍返回同一输入(代内固定,不暗换最新地址,data-model §6)
    const again = await vodInput.resolveVodInput(command, io);
    expect(again.resolvedInputId).toBe(first.resolvedInputId);
    expect(resolveUpstreamCalls).toHaveLength(1);

    // 入口 URL 私有:绑定行任意列零 URL 痕迹(地址不进入持久面/公共 DTO)
    const row = requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1);
    expect(JSON.stringify(row)).not.toMatch(/https?:\/\//);
  });

  it('[T042-C] 一次准备替换:probe 未接受前允许一次原子换引用(取消旧 probe),第二次替换与已接受后替换均拒绝(409)', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r2', atMs: rig.clock.nowMs() });

    await vodInput.bindFixedInput(
      { householdId: rig.seed.householdId, sessionId, generation: 1, sourceId: rig.seed.sourceId, startBasis: 'target_history' },
      { resolveUpstream: async () => ({ entryUrl: 'https://cache.fixture/ep-01/a/index.m3u8', locatorRevision: 1, detailRevision: 1, contentRevision: 1, continuityRevision: null, evidenceState: 'unverified' as const, evidenceDigest: 'd'.repeat(64), leaseSeconds: 600 }) },
    );
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).frozen_start_seconds).toBeNull();

    // 首次替换(旧 probe 未接受):原子换引用,绑定行唯一且指向新输入;旧输入租约一并撤销
    await vodInput.replaceUnacceptedProbeInput({
      householdId: rig.seed.householdId,
      sessionId,
      generation: 1,
      nextInputId: 'resolved-input-retry-b',
    });
    const rows = bindingRowsOf(rig.conn, rig.seed.householdId, sessionId);
    expect(rows, '替换为原子换引用:仍只有一条有效绑定').toHaveLength(1);
    expect(rows[0]?.resolved_input_id).toBe('resolved-input-retry-b');

    // 第二次替换拒绝(data-model §6「首次定位允许一次替换」)
    let secondThrown: unknown;
    try {
      await vodInput.replaceUnacceptedProbeInput({
        householdId: rig.seed.householdId,
        sessionId,
        generation: 1,
        nextInputId: 'resolved-input-retry-c',
      });
    } catch (error) {
      secondThrown = error;
    }
    expect(secondThrown, '第二次替换必须拒绝').toBeInstanceOf(DomainError);
    expect((secondThrown as DomainError).status).toBe(409);
    expect(requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).resolved_input_id).toBe('resolved-input-retry-b');

    // probe 接受(冻结起点)后替换同样拒绝(ready 提交只重验,不再换引用)
    const bindingId = requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1).id;
    inTx(rig, (workSet) => {
      workSet.inputBinding.freezeStartSeconds(rig.seed.householdId, bindingId, 0);
    });
    let afterAcceptedThrown: unknown;
    try {
      await vodInput.replaceUnacceptedProbeInput({
        householdId: rig.seed.householdId,
        sessionId,
        generation: 1,
        nextInputId: 'resolved-input-retry-d',
      });
    } catch (error) {
      afterAcceptedThrown = error;
    }
    expect(afterAcceptedThrown, 'probe 接受后替换必须拒绝').toBeInstanceOf(DomainError);
    expect((afterAcceptedThrown as DomainError).status).toBe(409);
  });

  it('[T042-D] 修订变更终止:locator/detail/content/continuity 任一失配 → 会话终止写入+新交付拒绝(参数化四维)', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });

    // 四个独立会话,每维失配独立验证(终止为终态,不可复用会话)
    const cases: readonly {
      readonly name: string;
      readonly sessionId: string;
      readonly drift: () => void;
    }[] = [
      {
        name: 'locator_revision 失配',
        sessionId: insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r3-locator', atMs: rig.clock.nowMs() }),
        drift: () =>
          rig.conn
            .prepare('UPDATE media_source SET locator_revision = 2, updated_at = ? WHERE household_id = ? AND id = ?')
            .run(iso(rig.clock.nowMs()), rig.seed.householdId, rig.seed.sourceId),
      },
      {
        name: 'detail_revision 失配',
        sessionId: insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r3-detail', atMs: rig.clock.nowMs() }),
        drift: () =>
          rig.conn
            .prepare('UPDATE vod_title SET current_detail_revision = 2 WHERE household_id = ? AND id = ?')
            .run(rig.seed.householdId, rig.seed.titleId),
      },
      {
        name: 'content_revision 失配',
        sessionId: insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r3-content', atMs: rig.clock.nowMs() }),
        drift: () =>
          rig.conn
            .prepare('UPDATE media_item SET content_revision = 2, updated_at = ? WHERE household_id = ? AND id = ?')
            .run(iso(rig.clock.nowMs()), rig.seed.householdId, rig.seed.episodeMediaId),
      },
      {
        name: 'continuity_revision 失配',
        sessionId: insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r3-continuity', atMs: rig.clock.nowMs() }),
        drift: () =>
          rig.conn
            .prepare("UPDATE vod_episode SET continuity_revision = 2, content_version_state = 'verified', evidence_kind = 'fixture', evidence_digest = ?, schema_version = '1', continuity_signature = ? WHERE household_id = ? AND id = ?")
            .run('e'.repeat(64), 'sig-t038', rig.seed.householdId, rig.seed.episodeId),
      },
    ];
    for (const testCase of cases) {
      bindGeneration(rig, { sessionId: testCase.sessionId, generation: 1, resolvedInputId: `resolved-${testCase.sessionId}` });
      testCase.drift();

      // 失配检测(旧会话修订不匹配 → 拒绝新交付/进度,准备转 failed,需新 resolve;data-model §3)
      let mismatchThrown: unknown;
      try {
        vodInput.assertFixedInputCurrent({
          householdId: rig.seed.householdId,
          sessionId: testCase.sessionId,
          generation: 1,
          expected: { contentRevision: 1, locatorRevision: 1, detailRevision: 1, continuityRevision: 1 },
        });
      } catch (error) {
        mismatchThrown = error;
      }
      expect(mismatchThrown, `${testCase.name}:失配必须拒绝`).toBeInstanceOf(DomainError);
      expect((mismatchThrown as DomainError).status, testCase.name).toBe(409);

      // 终止写入 + 新交付拒绝
      vodInput.failSessionOnRevisionMismatch({
        householdId: rig.seed.householdId,
        sessionId: testCase.sessionId,
        generation: 1,
        reason: testCase.name,
      });
      const row = sessionRowOf(rig.conn, testCase.sessionId);
      expect(row.state, `${testCase.name}:会话必须终止`).toBe('failed');
      expect(row.ended_at).not.toBeNull();
      expect(() =>
        vodInput.assertGenerationDeliverable(rig.seed.householdId, testCase.sessionId, 1),
      ).toThrow(DomainError);
    }
  });

  it('[T042-E] generation 原子换绑含旧代撤销同事务:CAS+同 resolved_input_id 新绑定+旧代 cleanup 标记一 commit;回退代次拒绝', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r4', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-r4' });

    await vodInput.advanceGenerationWithRebind({
      householdId: rig.seed.householdId,
      sessionId,
      expectedGeneration: 1,
      nextGeneration: 2,
    });

    const sessionRow = sessionRowOf(rig.conn, sessionId);
    expect(sessionRow.generation).toBe(2);
    const gen2 = requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 2);
    expect(gen2.resolved_input_id, '新绑定同 resolved_input_id').toBe(values.resolvedInputId);
    const gen1 = requireBindingRow(rig.conn, rig.seed.householdId, sessionId, 1);
    expect(gen1.cleanup_requested, '旧代撤销与新绑定同一事务(data-model §6)').toBe(1);
    expect(gen1.cleanup_state).toBe('pending');

    // 代次回退(下一 generation <= 当前)必须拒绝 —— 「失败后新代failed不倒退」的代次面
    let rewindThrown: unknown;
    try {
      await vodInput.advanceGenerationWithRebind({
        householdId: rig.seed.householdId,
        sessionId,
        expectedGeneration: 2,
        nextGeneration: 1,
      });
    } catch (error) {
      rewindThrown = error;
    }
    expect(rewindThrown, '代次不得回退').toBeDefined();
    // 陈旧 CAS(expected=1 已过)必须冲突且零持久变化
    let staleThrown: unknown;
    try {
      await vodInput.advanceGenerationWithRebind({
        householdId: rig.seed.householdId,
        sessionId,
        expectedGeneration: 1,
        nextGeneration: 3,
      });
    } catch (error) {
      staleThrown = error;
    }
    expect(staleThrown, '陈旧 expectedGeneration 必须冲突抛错').toBeDefined();
    expect(sessionRowOf(rig.conn, sessionId).generation).toBe(2);
    expect(bindingRowsOf(rig.conn, rig.seed.householdId, sessionId)).toHaveLength(2);
  });

  it('[T042-F] 旧代不 ready:非 current generation 的票据/资产/probe 提交一律 409 PLAYBACK_GENERATION_STALE(新代不受影响)', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r5', atMs: rig.clock.nowMs() });
    const values = bindGeneration(rig, { sessionId, generation: 1, resolvedInputId: 'resolved-input-r5' });
    await vodInput.advanceGenerationWithRebind({
      householdId: rig.seed.householdId,
      sessionId,
      expectedGeneration: 1,
      nextGeneration: 2,
    });

    const assertStale = (action: () => void, label: string): void => {
      let thrown: unknown;
      try {
        action();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${label}:旧代必须拒绝`).toBeInstanceOf(DomainError);
      expect((thrown as DomainError).status, label).toBe(409);
      expect((thrown as DomainError).code, label).toBe(ProblemCode.PLAYBACK_GENERATION_STALE);
    };
    assertStale(() => vodInput.assertGenerationDeliverable(rig.seed.householdId, sessionId, 1), '旧代票据/资产');
    assertStale(() => vodInput.assertProbeCommitGeneration(rig.seed.householdId, sessionId, 1), '旧代 probe 结果提交(playback-state §7 只可提交当前代)');
    // 新代不受影响
    expect(() => vodInput.assertGenerationDeliverable(rig.seed.householdId, sessionId, 2)).not.toThrow();
    expect(values.id.length).toBeGreaterThan(0);
  });

  it('[T045-H] readyAt 起 60s 未 playback_started_at 回收:恰满 60s 进入回收清单;heartbeat 推进不续命;回收为终态且不可复活', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const readyAtMs = rig.clock.nowMs();
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r6', atMs: readyAtMs, state: 'ready' });
    const list = (): Promise<{ sessionId: string }[]> => vodInput.listReclaimableUnstartedReadySessions({ nowMs: rig.clock.nowMs() });

    await rig.clock.advanceMs(UNSTARTED_READY_RECLAIM_MS - 1);
    expect((await list()).some((entry) => entry.sessionId === sessionId), '期限未满不得回收').toBe(false);
    await rig.clock.advanceMs(1);
    expect((await list()).some((entry) => entry.sessionId === sessionId), '恰满 60s 进入固定期限回收').toBe(true);

    // heartbeat/renew 不续命:期限满后心跳推进不把会话移出回收清单
    inTx(rig, (workSet) => {
      workSet.session.touchHeartbeat(rig.seed.householdId, sessionId, iso(rig.clock.nowMs()));
    });
    expect((await list()).some((entry) => entry.sessionId === sessionId), 'heartbeat 不得为未起播会话续命').toBe(true);

    const outcome = await vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId,
      nowMs: rig.clock.nowMs(),
    });
    expect(outcome.reclaimed).toBe(true);
    const row = sessionRowOf(rig.conn, sessionId);
    expect(row.state, '回收即终态(005 系统回收约定 → interrupted)').toBe('interrupted');
    expect(row.ended_at).not.toBeNull();
    // 终态不可复活:后到 playing 标记与再次回收均不得改变终态事实
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, sessionId, iso(rig.clock.nowMs()));
    });
    expect(sessionRowOf(rig.conn, sessionId).state).toBe('interrupted');
    const secondOutcome = await vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId,
      nowMs: rig.clock.nowMs(),
    });
    expect(secondOutcome.reclaimed, '终态不可复活:二次回收必须为输家').toBe(false);
    expect((await list()).some((entry) => entry.sessionId === sessionId), '终态不得再入回收清单').toBe(false);
  });

  it('[T045-H] 未知 duration 合格 playing 后超 60s 保留;无 playing 对照仍回收', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const readyAtMs = rig.clock.nowMs();
    // 未知 duration 场景:绑定 frozen_start NULL/无受信时长,合格 playing 观测仍设置起播标记(data-model §10「无时长仍可设置」)
    const withPlaying = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r7-playing', atMs: readyAtMs, state: 'ready' });
    const withoutPlaying = insertPlaybackSession(rig.conn, rig.seed, { sessionId: 'sess-r7-idle', atMs: readyAtMs, state: 'ready' });
    inTx(rig, (workSet) => {
      workSet.session.markPlaybackStartedAt(rig.seed.householdId, withPlaying, iso(readyAtMs + 5_000));
    });

    await rig.clock.advanceMs(UNSTARTED_READY_RECLAIM_MS + 1_000);
    const list = await vodInput.listReclaimableUnstartedReadySessions({ nowMs: rig.clock.nowMs() });
    expect(list.some((entry) => entry.sessionId === withPlaying), '合格 playing 已解除未起播期限:超 60s 保留').toBe(false);
    expect(list.some((entry) => entry.sessionId === withoutPlaying), '无 playing 仍按固定期限回收').toBe(true);

    const outcome = await vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId: withoutPlaying,
      nowMs: rig.clock.nowMs(),
    });
    expect(outcome.reclaimed).toBe(true);
    const keptRow = sessionRowOf(rig.conn, withPlaying);
    expect(['ready', 'playing', 'paused'], '已起播会话不得被未起播期限触达').toContain(keptRow.state);
  });

  it('[T045-H] watchdog CAS:并发两 watcher 只有一个回收成功(输家 {reclaimed:false},终态不被覆盖/复活)', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const sessionId = insertPlaybackSession(rig.conn, rig.seed, {
      sessionId: 'sess-r8',
      atMs: rig.clock.nowMs() - UNSTARTED_READY_RECLAIM_MS - 1_000,
      state: 'ready',
    });
    // 两 watcher 基于「仍活动」的过期观察先后回收:唯一赢家
    const watcherA = await vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId,
      nowMs: rig.clock.nowMs(),
    });
    const watcherB = await vodInput.reclaimExpiredUnstartedReadySession({
      householdId: rig.seed.householdId,
      sessionId,
      nowMs: rig.clock.nowMs(),
    });
    expect(watcherA.reclaimed, '赢家恰一者').toBe(true);
    expect(watcherB.reclaimed, '输家必须观察到 reclaimed=false 而非覆盖').toBe(false);
    const row = sessionRowOf(rig.conn, sessionId);
    const winnerEndedAt = row.ended_at;
    expect(row.state).toBe('interrupted');
    // 输家不得复活/改写:重复推进后终态事实不变
    await rig.clock.advanceMs(5_000);
    await vodInput.reclaimExpiredUnstartedReadySession({ householdId: rig.seed.householdId, sessionId, nowMs: rig.clock.nowMs() });
    expect(sessionRowOf(rig.conn, sessionId).ended_at).toBe(winnerEndedAt);
    expect(sessionRowOf(rig.conn, sessionId).state).toBe('interrupted');
  });

  it('[T045-I] 已起播后暂停不重新开启 60s 期限', async () => {
    const rig = openRig();
    const store = await loadPlannedVodInputStore();
    const vodInput = store.drizzleVodInputStore({ handle: rig.conn, nowMs: () => rig.clock.nowMs() });
    const readyAtMs = rig.clock.nowMs();
    const pausedSession = insertPlaybackSession(rig.conn, rig.seed, {
      sessionId: 'sess-r9',
      atMs: readyAtMs,
      state: 'paused',
      playbackStartedAtMs: readyAtMs + 5_000,
    });
    await rig.clock.advanceMs(2 * UNSTARTED_READY_RECLAIM_MS);
    const list = await vodInput.listReclaimableUnstartedReadySessions({ nowMs: rig.clock.nowMs() });
    expect(list.some((entry) => entry.sessionId === pausedSession), '暂停不重新开启 60s 未起播期限(api §7 I4)').toBe(false);
  });
});
