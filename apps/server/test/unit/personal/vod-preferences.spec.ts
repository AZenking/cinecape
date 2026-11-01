import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUnitOfWork, type TxStoreFactory } from '@platform/database/unit-of-work';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createProfileTxReaders } from '@contexts/profile/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import {
  PREFERENCE_OPERATION_RETENTION_MS,
  digestVodPreferencesPatch,
  getVodPreferences,
  patchVodPreferences,
  type PreferenceUnitOfWork,
  type VodPreferencesContext,
  type VodPreferencesPatchCommand,
  type VodPreferencesServiceDeps,
} from '@contexts/personal-data/application/vod-preferences.service';
import type { VodPreferencesSnapshot } from '@contexts/personal-data/application/preference-work-set.port';
import type { DomainError } from '@platform/http-common/domain-error';

/**
 * T056(010-online-vod · US3 服务级单测,真实 DDL + 真实 UNIT_OF_WORK + FakeClock)——
 * 连播偏好 GET/PATCH 编排:
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §1 Preferences + §3 偏好行(GET 未有行
 *   默认 true/true/version=0 不写库;PATCH CAS 409;成功 key 24h 重放不再更新版本,
 *   先重验当前身份);
 * - docs/specs/010-online-vod/data-model.md §5(每 Profile 唯一;CAS;持久 version>=1)
 *   + §10 U1(唯一(家庭,device_session,context_version,operation_key);先查成功 key
 *   并校验原 Profile/context 及 digest 再 CAS;成功重放返回原响应不增版本;异 digest
 *   409 IDEMPOTENCY_CONFLICT;失败不占成功 key;不同 key 并发按 CAS 仅一者成功;
 *   expires>=committed+24h;清理过期 operation 不删偏好);
 * - docs/specs/010-online-vod/contracts/internal-ports.md §5 PreferenceWriteWorkSet
 *   (同事务先成功重放、再 CAS、写偏好及不可变成功响应;审查补充:偏好 CAS 与
 *   operation 同事务;T056 审查补充测试矩阵:A 成功/B 更新/重放 A 仅返回原值不覆盖 B、
 *   异摘要与 24h 清理)。
 *
 * 装配方式(与 T040 vod-progress-write rig 同构,零 HTTP/零网络):
 * - 独立临时文件库 + 全量权威迁移 DDL(0001~0007,foreign_keys=ON 真实约束)+
 *   真实 UNIT_OF_WORK(txStores 注册本用例消费的 3 键真实参与者:identityAccess/
 *   profile/personalData —— 具体注册表由 createUnitOfWork 泛型保留字面量类型,与
 *   PreferenceUnitOfWork 结构相容无需断言桥接);
 * - 时钟注入 FakeClock(24h 过期用例直接拨钟;生产装配为系统时钟)。
 *
 * 矩阵:GET 默认零写入 · CAS 成功(version 0→1 基线,偏好与 operation 同事务)·
 * A 成功后 B 更新(version 2)· 重放 A 仅返回原值不覆盖 B、不续 TTL · 异摘要 409 ·
 * 24h 过期重放不可用(偏好不被清理)· 失败不占成功 key · 不同 key 仅一者成功 ·
 * 身份重验(context 变化后旧 key 拒绝)。
 */

/** 夹具固定时刻(FakeClock 起点;committed_at/expires_at 断言锚点) */
const CLOCK_START_MS = Date.parse('2026-11-02T09:00:00.000Z');
const FAR_FUTURE_MS = CLOCK_START_MS + 7 * 24 * 3600_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ */
/* rig:真实 DDL + 真实 UNIT_OF_WORK(3 键真实参与者)+ FakeClock           */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

interface WorldSeed {
  readonly householdId: string;
  readonly profileAId: string;
  readonly deviceSessionAId: string;
}

interface Rig {
  readonly conn: SqliteConnection;
  readonly dataDir: string;
  readonly uow: PreferenceUnitOfWork;
  readonly world: WorldSeed;
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];

/** 全量权威迁移(与 T040 rig 同源;FK ON 下逐语句零违反) */
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

/** 身份种子(家庭/账号/档案 A/设备/会话;device_session.profile_context_version 默认 1) */
function seedWorld(conn: SqliteConnection): WorldSeed {
  const now = iso(CLOCK_START_MS - 60_000);
  const householdId = `hh-${randomUUID()}`;
  const accountId = `acc-${randomUUID()}`;
  const profileAId = `prof-${randomUUID()}`;
  const deviceIdA = `dev-${randomUUID()}`;
  const deviceSessionAId = `dsess-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T056 夹具家庭', now);
    conn
      .prepare(
        'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(accountId, householdId, 't056', 't056', 'hash', 'owner', now);
    conn
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, created_at) VALUES (?, ?, ?, ?, 'adult', 0, 'active', ?)",
      )
      .run(profileAId, householdId, accountId, '档案A', now);
    conn.prepare("INSERT INTO device (id, household_id, name, type, created_at) VALUES (?, ?, '设备A', 'web', ?)").run(deviceIdA, householdId, now);
    conn
      .prepare(
        'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(deviceSessionAId, householdId, accountId, deviceIdA, hashToken(`token-${deviceSessionAId}`), profileAId, iso(FAR_FUTURE_MS), now, now);
  })(); // better-sqlite3:transaction(fn) 返回包装函数,必须调用一次才执行
  return { householdId, profileAId, deviceSessionAId };
}

/** 本用例消费的 3 键真实参与者(具体注册表字面量类型经 createUnitOfWork 泛型保留) */
const TX_STORES = {
  identityAccess: createIdentityAccessTxReaders,
  profile: createProfileTxReaders,
  personalData: createPersonalDataTxParticipants,
} satisfies Record<string, TxStoreFactory>;

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t056-vod-prefs-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const world = seedWorld(conn);
  openRigs.push({ conn, dataDir });
  return {
    conn,
    dataDir,
    world,
    uow: createUnitOfWork({ resolveDatabase: () => conn, txStores: TX_STORES }),
  };
}

/* ------------------------------------------------------------------ */
/* 用例辅助(上下文/命令/错误归一/行读取)                                  */
/* ------------------------------------------------------------------ */

describe('T056 · 连播偏好 GET/PATCH(真实 DDL + 真实 UNIT_OF_WORK + FakeClock)', () => {
  let rig: Rig;
  let conn: SqliteConnection;
  let world: WorldSeed;
  let clockMs: number;
  let deps: VodPreferencesServiceDeps;
  let context: VodPreferencesContext;

  beforeEach(() => {
    rig = openRig();
    conn = rig.conn;
    world = rig.world;
    clockMs = CLOCK_START_MS;
    deps = { uow: rig.uow, nowIso: () => iso(clockMs) };
    context = { householdId: world.householdId, deviceSessionId: world.deviceSessionAId, profileId: world.profileAId };
  });

  afterEach(() => {
    for (let index = openRigs.length - 1; index >= 0; index -= 1) {
      const open = openRigs[index];
      if (open !== undefined) {
        open.conn.close();
        fs.rmSync(open.dataDir, { recursive: true, force: true });
      }
      openRigs.pop();
    }
  });

  /** PATCH 错误归一:DomainError → {status,code};非领域错误原样上抛(不吞装配错误) */
  function runPatch(command: VodPreferencesPatchCommand, ctx: VodPreferencesContext = context): VodPreferencesSnapshot | { status: number; code: string } {
    try {
      return patchVodPreferences(deps, command, ctx);
    } catch (err) {
      const domain = err as Partial<DomainError>;
      if (err instanceof Error && domain.name === 'DomainError' && typeof domain.status === 'number' && typeof domain.code === 'string') {
        return { status: domain.status, code: domain.code };
      }
      throw err;
    }
  }

  const isSnapshot = (value: VodPreferencesSnapshot | { status: number; code: string }): value is VodPreferencesSnapshot =>
    typeof (value as VodPreferencesSnapshot).version === 'number';

  function scalarOf(sql: string, ...params: readonly unknown[]): number {
    const row = conn.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  function preferenceRowCount(): number {
    return scalarOf('SELECT COUNT(*) AS n FROM profile_vod_preferences');
  }

  function operationRowCount(): number {
    return scalarOf('SELECT COUNT(*) AS n FROM profile_vod_preference_operation');
  }

  function preferenceRowOf(profileId: string = world.profileAId): { autoplayNext: number; switchCarryPosition: number; version: number } {
    const row = conn
      .prepare(
        'SELECT autoplay_next AS autoplayNext, switch_carry_position AS switchCarryPosition, version FROM profile_vod_preferences WHERE household_id = ? AND profile_id = ?',
      )
      .get(world.householdId, profileId) as { autoplayNext: number; switchCarryPosition: number; version: number } | undefined;
    expect(row, '夹具断言失败:偏好持久行不存在').toBeDefined();
    return row!;
  }

  function operationRowOf(
    operationKey: string,
    contextVersion = 1,
  ): { requestDigest: string; resultJson: string; committedAt: string; expiresAt: string } {
    const row = conn
      .prepare(
        'SELECT request_digest AS requestDigest, result_json AS resultJson, committed_at AS committedAt, expires_at AS expiresAt FROM profile_vod_preference_operation WHERE household_id = ? AND device_session_id = ? AND profile_context_version = ? AND operation_key = ?',
      )
      .get(world.householdId, world.deviceSessionAId, contextVersion, operationKey) as
      | { requestDigest: string; resultJson: string; committedAt: string; expiresAt: string }
      | undefined;
    expect(row, `夹具断言失败:operation 行不存在(${operationKey})`).toBeDefined();
    return row!;
  }

  /* ---------------------------------------------------------------- */

  it('GET 未有行返回默认 true/true/version=0 且零写入(传输初值不落库)', () => {
    const snapshot = getVodPreferences(deps.uow, { householdId: world.householdId, profileId: world.profileAId });
    expect(snapshot).toEqual({ autoplayNext: true, switchCarryPosition: true, version: 0 });
    // 零写入:偏好表与幂等表都无行(「不偷偷写公共状态」)
    expect(preferenceRowCount()).toBe(0);
    expect(operationRowCount()).toBe(0);
    // 重复读取同形(纯读工作集,无副作用累积)
    expect(getVodPreferences(deps.uow, { householdId: world.householdId, profileId: world.profileAId })).toEqual(snapshot);
    expect(preferenceRowCount()).toBe(0);
  });

  it('CAS 成功:未有行 version=0 基线写入持久 version=1,偏好与 operation 同事务落库(24h 保留)', () => {
    const command: VodPreferencesPatchCommand = { expectedVersion: 0, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    const result = runPatch(command);
    expect(result, '未有行基线 CAS 成功返回新快照').toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
    // 持久行 version>=1(服务端绝不写 0);未提交字段保留默认 true
    expect(preferenceRowOf()).toEqual({ autoplayNext: 0, switchCarryPosition: 1, version: 1 });
    // operation 行同事务落库:scope/摘要/原响应/24h 保留逐字段
    const operation = operationRowOf(command.operationKey);
    expect(operation.requestDigest).toBe(digestVodPreferencesPatch(command));
    expect(JSON.parse(operation.resultJson)).toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
    expect(operation.committedAt).toBe(iso(CLOCK_START_MS));
    expect(operation.expiresAt).toBe(iso(CLOCK_START_MS + PREFERENCE_OPERATION_RETENTION_MS));
    expect(Date.parse(operation.expiresAt) - Date.parse(operation.committedAt)).toBe(PREFERENCE_OPERATION_RETENTION_MS);
    // GET 回读持久事实(version=1,不再是传输初值)
    expect(getVodPreferences(deps.uow, context)).toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
  });

  it('A 成功后 B 更新(version 2);重放 A 仅返回原值不覆盖 B、不续 24h TTL', () => {
    const commandA: VodPreferencesPatchCommand = { expectedVersion: 0, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    const snapshotA = runPatch(commandA);
    expect(isSnapshot(snapshotA) && snapshotA.version).toBe(1);
    const commandB: VodPreferencesPatchCommand = {
      expectedVersion: 1,
      autoplayNext: true,
      switchCarryPosition: false,
      operationKey: randomUUID(),
    };
    const snapshotB = runPatch(commandB);
    expect(snapshotB).toEqual({ autoplayNext: true, switchCarryPosition: false, version: 2 });
    expect(preferenceRowOf()).toEqual({ autoplayNext: 1, switchCarryPosition: 0, version: 2 });

    // 重放 A(同 key 同摘要):仅返回原响应,不覆盖 B 的更新、不增版本、不续 TTL
    const before = operationRowOf(commandA.operationKey);
    const replayed = runPatch(commandA);
    expect(replayed, '成功 key 重放返回原响应(不更新版本)').toEqual(snapshotA);
    expect(preferenceRowOf(), '重放不得覆盖后来操作 B').toEqual({ autoplayNext: 1, switchCarryPosition: 0, version: 2 });
    const after = operationRowOf(commandA.operationKey);
    expect(after.committedAt, '重放不续 TTL(committed_at 不变)').toBe(before.committedAt);
    expect(after.expiresAt, '重放不续 TTL(expires_at 不变)').toBe(before.expiresAt);
    expect(operationRowCount(), '重放不新增 operation 行').toBe(2);
  });

  it('同 key 异摘要 409 IDEMPOTENCY_CONFLICT,零写入', () => {
    const commandA: VodPreferencesPatchCommand = { expectedVersion: 0, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    expect(runPatch(commandA)).toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
    // 同 key 不同载荷(expectedVersion/字段集变化)→ 摘要失配
    const conflicting: VodPreferencesPatchCommand = {
      expectedVersion: 0,
      autoplayNext: false,
      switchCarryPosition: false,
      operationKey: commandA.operationKey,
    };
    expect(digestVodPreferencesPatch(conflicting)).not.toBe(digestVodPreferencesPatch(commandA));
    expect(runPatch(conflicting)).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    // 零写入:偏好与 operation 都保持原状
    expect(preferenceRowOf()).toEqual({ autoplayNext: 0, switchCarryPosition: 1, version: 1 });
    expect(operationRowCount()).toBe(1);
  });

  it('24h 过期(FakeClock)后重放不可用(409),过期清理不删偏好', () => {
    const commandA: VodPreferencesPatchCommand = { expectedVersion: 0, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    expect(runPatch(commandA)).toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
    // 拨钟越过 24h 重放窗(过期 operation 尚未被清理任务触达)
    clockMs = CLOCK_START_MS + PREFERENCE_OPERATION_RETENTION_MS + 1000;
    expect(runPatch(commandA)).toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    // 清理过期 operation 不删偏好:偏好行原样保留、operation 行在服务侧不删(交由清理任务)
    expect(preferenceRowOf()).toEqual({ autoplayNext: 0, switchCarryPosition: 1, version: 1 });
    expect(operationRowOf(commandA.operationKey).expiresAt).toBe(iso(CLOCK_START_MS + PREFERENCE_OPERATION_RETENTION_MS));
  });

  it('CAS 失败不占成功 key:409 VERSION_CONFLICT 零残留,同 key 修正后重试成功', () => {
    const command: VodPreferencesPatchCommand = { expectedVersion: 5, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    expect(runPatch(command)).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
    // 失败整体回滚:两表零行(失败不占成功 key)
    expect(preferenceRowCount()).toBe(0);
    expect(operationRowCount()).toBe(0);
    // 同 key 修正 expectedVersion 重试:作为全新操作成功
    const retry: VodPreferencesPatchCommand = { ...command, expectedVersion: 0 };
    expect(runPatch(retry)).toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
    expect(preferenceRowOf()).toEqual({ autoplayNext: 0, switchCarryPosition: 1, version: 1 });
    expect(operationRowCount()).toBe(1);
    expect(operationRowOf(command.operationKey).requestDigest).toBe(digestVodPreferencesPatch(retry));
  });

  it('不同 key 并发仅一者成功:CAS 裁决,后到者 409 且零写入', () => {
    const winner: VodPreferencesPatchCommand = { expectedVersion: 0, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    const loser: VodPreferencesPatchCommand = { expectedVersion: 0, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    expect(runPatch(winner)).toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
    // BEGIN IMMEDIATE 串行化:后到者以同一 expectedVersion=0 CAS 落空
    expect(runPatch(loser)).toEqual({ status: 409, code: 'VERSION_CONFLICT' });
    expect(preferenceRowOf()).toEqual({ autoplayNext: 0, switchCarryPosition: 1, version: 1 });
    expect(operationRowCount(), '失败者不占成功 key').toBe(1);
    expect(operationRowOf(winner.operationKey)).toBeDefined();
  });

  it('身份重验:context 变化后旧 key 不跨上下文重放(拒绝而非返回旧结果)', () => {
    const commandA: VodPreferencesPatchCommand = { expectedVersion: 0, autoplayNext: false, switchCarryPosition: null, operationKey: randomUUID() };
    expect(runPatch(commandA)).toEqual({ autoplayNext: false, switchCarryPosition: true, version: 1 });
    // DB 直改注明:等价「切档/上下文失效回落」已递增 device_session.profile_context_version
    // (identity-access 应用层语义;此处只造存储事实)
    conn.prepare('UPDATE device_session SET profile_context_version = 2 WHERE id = ?').run(world.deviceSessionAId);
    // 旧 key 重放:scope(context_version=2)不命中 context 1 的成功记录 → 走新操作路径,
    // 载荷 expectedVersion=0 与当前持久版本 1 失配 → 409(绝不返回旧上下文的原响应)
    const replayed = runPatch(commandA);
    expect(replayed, '旧 key 不跨上下文重放旧结果').toEqual({ status: 409, code: 'VERSION_CONFLICT' });
    // 偏好未被旧 key 重放改写;context 1 的成功记录原样保留;context 2 无新 operation(回滚零残留)
    expect(preferenceRowOf()).toEqual({ autoplayNext: 0, switchCarryPosition: 1, version: 1 });
    expect(operationRowOf(commandA.operationKey, 1)).toBeDefined();
    expect(scalarOf('SELECT COUNT(*) AS n FROM profile_vod_preference_operation WHERE profile_context_version = 2')).toBe(0);
  });
});
