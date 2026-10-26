import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/database/database';
import { cleanupRigs, startFreshApp } from '../helpers';

/**
 * T003(阶段 2 契约 e2e):0002_profile_policy 迁移升级/回滚矩阵。
 * 对照 data-model.md「迁移与状态」与 spec FR-002/FR-003/FR-012、SC-006:
 * - 升级路径:以仅应用 0001_init 的库构造阶段 1 数据(直写 SQL 夹具,不经 initialize,
 *   避免就绪门禁依赖),再应用 0002 up.sql,断言回填/默认值/身份不变/上下文清空。
 * - 回滚路径:down → up,阶段 1 业务数据保留,策略恢复默认(自定义策略丢失,须备份恢复)。
 * - 约束矩阵:复合主键/UNIQUE(profile_id)/CHECK(等级/未评级/版本/JSON 数组)。
 * - 就绪(T009 就绪语义变更):缺任一迁移即未就绪;目录含 0005 后,仅应用 0001~0004 的部分形态库始终安全拒绝。
 */

interface PolicyRow {
  household_id: string;
  profile_id: string;
  max_content_level: number;
  allow_unrated: number;
  allowed_media_ids: string;
  blocked_media_ids: string;
  allowed_channel_ids: string;
  version: number;
  updated_at: string;
}

function policyTableExists(): boolean {
  return (
    Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile_policy'").get() !==
    undefined
  );
}

function policyRow(profileId: string): PolicyRow | undefined {
  if (!policyTableExists()) {
    return undefined;
  }
  return Database.db.prepare('SELECT * FROM profile_policy WHERE profile_id = ?').get(profileId) as
    | PolicyRow
    | undefined;
}

function policyCount(profileId: string): number {
  if (!policyTableExists()) {
    return 0;
  }
  const row = Database.db
    .prepare('SELECT COUNT(*) AS n FROM profile_policy WHERE profile_id = ?')
    .get(profileId) as { n: number };
  return row.n;
}

function activeProfileIdOf(sessionId: string): string | null {
  const row = Database.db.prepare('SELECT active_profile_id FROM device_session WHERE id = ?').get(sessionId) as
    | { active_profile_id: string | null }
    | undefined;
  return row?.active_profile_id ?? null;
}

interface Stage1Fixture {
  householdId: string;
  accountId: string;
  adultWithPinId: string;
  adultNoPinId: string;
  childId: string;
  disabledChildId: string;
  sessionWithPinAdult: string;
  sessionWithNoPinAdult: string;
  sessionWithChild: string;
}

/** 直写阶段 1 形态的业务行(家庭/账号/四类档案/三个会话),不经 HTTP */
function injectStage1Data(): Stage1Fixture {
  const ids = {
    householdId: randomUUID(),
    accountId: randomUUID(),
    adultWithPinId: randomUUID(),
    adultNoPinId: randomUUID(),
    childId: randomUUID(),
    disabledChildId: randomUUID(),
    deviceId: randomUUID(),
    sessionWithPinAdult: randomUUID(),
    sessionWithNoPinAdult: randomUUID(),
    sessionWithChild: randomUUID(),
  };
  const now = new Date().toISOString();
  const db = Database.db;
  db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ids.householdId, '迁移家庭', 'zh-CN', 'Asia/Shanghai', now);
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ids.accountId, ids.householdId, 'migrator', 'migrator', '$argon2id$fixture-hash', 'owner', now);
  const insertProfile = db.prepare(
    'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  insertProfile.run(ids.adultWithPinId, ids.householdId, ids.accountId, '有码成人', null, 'adult', 1, '$argon2id$pin', 'active', 0, null, now);
  insertProfile.run(ids.adultNoPinId, ids.householdId, ids.accountId, '无码成人', null, 'adult', 0, null, 'active', 0, null, now);
  insertProfile.run(ids.childId, ids.householdId, ids.accountId, '儿童', null, 'child', 0, null, 'active', 0, null, now);
  insertProfile.run(ids.disabledChildId, ids.householdId, ids.accountId, '停用儿童', null, 'child', 0, null, 'disabled', 0, null, now);
  db.prepare('INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ids.deviceId, ids.householdId, '迁移设备', 'web', now, null, now);
  const insertSession = db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const future = new Date(Date.now() + 86_400_000).toISOString();
  insertSession.run(ids.sessionWithPinAdult, ids.householdId, ids.accountId, ids.deviceId, `tok-${randomUUID()}`, ids.adultWithPinId, future, null, now, now);
  insertSession.run(ids.sessionWithNoPinAdult, ids.householdId, ids.accountId, ids.deviceId, `tok-${randomUUID()}`, ids.adultNoPinId, future, null, now, now);
  insertSession.run(ids.sessionWithChild, ids.householdId, ids.accountId, ids.deviceId, `tok-${randomUUID()}`, ids.childId, future, null, now, now);
  return ids;
}

function migrationSql(name: string, file: 'up.sql' | 'down.sql'): string {
  const p = path.join(process.cwd(), 'src/database/migrations', name, file);
  if (!fs.existsSync(p)) {
    throw new Error(`未找到迁移文件 ${p}`);
  }
  return fs.readFileSync(p, 'utf8');
}

function apply0002(): void {
  Database.db.exec(migrationSql('0002_profile_policy', 'up.sql'));
  Database.db
    .prepare("INSERT INTO _migrations (name, applied_at) VALUES ('0002_profile_policy', ?)")
    .run(new Date().toISOString());
}

/** 阶段 3(003-media-catalog)就绪路径同步:isReady 要求迁移记录与目录完全一致 */
function apply0003(): void {
  Database.db.exec(migrationSql('0003_media_catalog', 'up.sql'));
  Database.db
    .prepare("INSERT INTO _migrations (name, applied_at) VALUES ('0003_media_catalog', ?)")
    .run(new Date().toISOString());
}

/** 阶段 3 增补(US5 手动 EPG 绑定)就绪路径同步:0004 后才完全就绪 */
function apply0004(): void {
  Database.db.exec(migrationSql('0004_manual_epg_binding', 'up.sql'));
  Database.db
    .prepare("INSERT INTO _migrations (name, applied_at) VALUES ('0004_manual_epg_binding', ?)")
    .run(new Date().toISOString());
}

function rollback0002(): void {
  Database.db.exec(migrationSql('0002_profile_policy', 'down.sql'));
  Database.db.prepare("DELETE FROM _migrations WHERE name = '0002_profile_policy'").run();
}

describe('0002_profile_policy 迁移升级/回滚(阶段 2 契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('升级回填:每个档案(含停用)有且仅有一条默认策略;身份/PIN/状态/归属不变;版本为 1、名单为空数组', async () => {
    await startFreshApp({ prefix: 'hmp-mig-', migrations: ['0001_init'] });
    const f = injectStage1Data();

    apply0002();

    const expected: Array<[string, number, number, string]> = [
      [f.adultWithPinId, 18, 1, '有码成人'],
      [f.adultNoPinId, 18, 1, '无码成人'],
      [f.childId, 12, 0, '儿童'],
      [f.disabledChildId, 12, 0, '停用儿童'],
    ];
    for (const [profileId, level, unrated] of expected) {
      expect(policyCount(profileId)).toBe(1);
      const row = policyRow(profileId);
      expect(row).toMatchObject({
        household_id: f.householdId,
        max_content_level: level,
        allow_unrated: unrated,
        allowed_media_ids: '[]',
        blocked_media_ids: '[]',
        allowed_channel_ids: '[]',
        version: 1,
      });
      expect(Date.parse(row?.updated_at as string)).not.toBeNaN();
    }

    // 阶段 1 业务数据不变:姓名/PIN 哈希/状态/归属/会话令牌全部保留
    const profiles = Database.db
      .prepare('SELECT * FROM profile WHERE household_id = ?')
      .all(f.householdId) as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(4);
    const byName = new Map(profiles.map((p) => [p.name as string, p]));
    expect(byName.get('有码成人')?.pin_hash).toBe('$argon2id$pin');
    expect(byName.get('无码成人')?.pin_hash).toBeNull();
    expect(byName.get('停用儿童')?.status).toBe('disabled');
    const sessions = Database.db
      .prepare('SELECT COUNT(*) AS n FROM device_session WHERE household_id = ?')
      .get(f.householdId) as { n: number };
    expect(sessions.n).toBe(3);
  });

  it('升级清空:儿童家庭中引用未设 PIN 成人的活动上下文被清空;有 PIN 成人与儿童引用保留', async () => {
    await startFreshApp({ prefix: 'hmp-mig-', migrations: ['0001_init'] });
    const f = injectStage1Data();
    expect(activeProfileIdOf(f.sessionWithNoPinAdult)).toBe(f.adultNoPinId);

    apply0002();

    // 家庭存在 child(含停用)→ 未设 PIN 成人的活动上下文清空,要求重新选择验证
    expect(activeProfileIdOf(f.sessionWithNoPinAdult)).toBeNull();
    // 有 PIN 成人与儿童引用不受影响(PIN 保护/儿童本身即允许上下文)
    expect(activeProfileIdOf(f.sessionWithPinAdult)).toBe(f.adultWithPinId);
    expect(activeProfileIdOf(f.sessionWithChild)).toBe(f.childId);
  });

  it('回滚再升级:down 删除策略/验证表且保留全部阶段 1 数据;up 恢复默认策略,自定义策略丢失(须备份恢复)', async () => {
    await startFreshApp({ prefix: 'hmp-mig-', migrations: ['0001_init'] });
    const f = injectStage1Data();
    apply0002();

    // 写入自定义策略(模拟升级后家长已修改)
    Database.db
      .prepare('UPDATE profile_policy SET max_content_level = 7, version = 3 WHERE profile_id = ?')
      .run(f.childId);
    expect(policyRow(f.childId)?.max_content_level).toBe(7);

    rollback0002();

    // 新表删除;阶段 1 数据完整保留
    expect(
      Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'profile_policy'").get(),
    ).toBeUndefined();
    expect(
      Database.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'parent_verification_state'").get(),
    ).toBeUndefined();
    const profiles = Database.db
      .prepare('SELECT * FROM profile WHERE household_id = ?')
      .all(f.householdId) as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(4);
    expect(policyRow(f.childId)).toBeUndefined();

    // 再次 up:策略恢复默认(自定义值已随 down 丢失 —— 与 quickstart 恢复语义一致)
    apply0002();
    expect(policyRow(f.childId)).toMatchObject({ max_content_level: 12, version: 1 });
    expect(policyCount(f.childId)).toBe(1);
  });

  it('约束矩阵:复合主键/UNIQUE(profile_id)/等级/未评级/版本/JSON 数组 CHECK 全部生效', async () => {
    await startFreshApp({ prefix: 'hmp-mig-', migrations: ['0001_init'] });
    const f = injectStage1Data();
    apply0002();

    const insert = (overrides: Record<string, unknown>): void => {
      Database.db
        .prepare(
          'INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          overrides.household_id ?? f.householdId,
          overrides.profile_id,
          overrides.max_content_level ?? 12,
          overrides.allow_unrated ?? 0,
          overrides.allowed_media_ids ?? '[]',
          overrides.blocked_media_ids ?? '[]',
          overrides.allowed_channel_ids ?? '[]',
          overrides.version ?? 1,
          overrides.updated_at ?? new Date().toISOString(),
        );
    };
    const expectInsertFails = (overrides: Record<string, unknown>): Error => {
      try {
        insert(overrides);
        throw new Error('期望插入失败但成功了');
      } catch (err) {
        if ((err as Error).message === '期望插入失败但成功了') {
          throw err;
        }
        return err as Error;
      }
    };

    // 复合主键:同 (household, profile) 二次插入拒绝
    expectInsertFails({ profile_id: f.childId });
    // UNIQUE(profile_id):换 household 也不得复用同一档案 id
    expectInsertFails({ profile_id: f.childId, household_id: randomUUID() });
    // 等级越界 / 非法未评级 / 版本非正 / 非 JSON / 非数组 JSON
    expectInsertFails({ profile_id: randomUUID(), max_content_level: 19 });
    expectInsertFails({ profile_id: randomUUID(), max_content_level: -1 });
    expectInsertFails({ profile_id: randomUUID(), allow_unrated: 2 });
    expectInsertFails({ profile_id: randomUUID(), version: 0 });
    expectInsertFails({ profile_id: randomUUID(), allowed_media_ids: 'not-json' });
    expectInsertFails({ profile_id: randomUUID(), allowed_media_ids: '"string"' });

    // 合法边界:等级 0/18、未评级 0/1 均可
    const edgeA = randomUUID();
    const edgeB = randomUUID();
    Database.db
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, NULL, 'adult', 0, NULL, 'active', 0, NULL, ?)",
      )
      .run(edgeA, f.householdId, f.accountId, '边界甲', new Date().toISOString());
    Database.db
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, NULL, 'adult', 0, NULL, 'active', 0, NULL, ?)",
      )
      .run(edgeB, f.householdId, f.accountId, '边界乙', new Date().toISOString());
    insert({ profile_id: edgeA, max_content_level: 0, allow_unrated: 0 });
    insert({ profile_id: edgeB, max_content_level: 18, allow_unrated: 1 });
    expect(policyRow(edgeA)?.max_content_level).toBe(0);
    expect(policyRow(edgeB)?.max_content_level).toBe(18);
  });

  it('就绪:缺任一迁移即未就绪;目录含 0005 后,仅应用 0001~0004 的库安全拒绝(T009 就绪语义)', async () => {
    await startFreshApp({ prefix: 'hmp-mig-', migrations: ['0001_init'] });
    expect(Database.isReady()).toBe(false); // 缺 0002/0003 记录与新表 → 未就绪

    apply0002();
    expect(Database.isReady()).toBe(false); // 目录存在 0003,迁移记录仍不齐 → 未就绪

    apply0003();
    expect(Database.isReady()).toBe(false); // 目录存在 0004,迁移记录仍不齐 → 未就绪

    apply0004();
    // T009 就绪语义变更:目录已含 0005_playback,本库缺 0005 记录/表/列 → 安全拒绝(未就绪)
    expect(Database.isReady()).toBe(false);
  });
});
