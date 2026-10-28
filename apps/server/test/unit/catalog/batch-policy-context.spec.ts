import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import DatabaseConstructor from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import * as schema from '../../../src/database/schema';
import { DomainError } from '../../../src/common/domain-error';
import type { Db } from '../../../src/modules/auth/db';
import {
  filterAllowedCandidates,
  loadAvailableMediaIdSet,
  loadBatchCatalogContext,
  type BatchCatalogContext,
  type CatalogCandidateRow,
} from '@contexts/policy/application/policy.batch-context';
import { buildMediaPage, type ListMediaQuery } from '@contexts/media-catalog/application/catalog.service';
import { isMediaAvailable, loadMediaAvailabilityFacts } from '@contexts/media-catalog/infrastructure/resource-reader';
import type { MediaType, PolicyJudgment } from '@contexts/policy/domain/policy.rules';

/**
 * T033(US2 单元):批量目录上下文与目录管线(research R7):
 * - 列表在单次同步读取中装载有效会话/设备/档案/策略与家庭候选集;
 *   查询数与候选规模无关(无逐条 await 的 N+1),且函数本身非异步;
 * - 过滤调用与详情相同的 evaluatePolicy 顺序(黑名单优先/未评级按 allowUnrated/频道白名单仅 channel),
 *   规则自 policy.rules.ts 导入,不复制;
 * - 先过滤,后搜索/排序(title 二进制序再 id 稳定)/计数/分页(不得先分页后过滤);
 * - 错误语义:无档案/会话或设备失效 403 ACTIVE_PROFILE_REQUIRED,策略缺失/损坏 503 POLICY_UNAVAILABLE。
 *
 * 使用独立内存库 + 权威迁移 DDL(与 helpers.ts 同源的 up.sql),不经 Nest 装配。
 */

const NOW_ISO = '2026-01-01T00:00:00.000Z';
const FUTURE_ISO = '2099-01-01T00:00:00.000Z';

interface UnitRig {
  conn: DatabaseConstructor.Database;
  db: Db;
}

const openConnections: DatabaseConstructor.Database[] = [];

afterEach(() => {
  while (openConnections.length > 0) {
    openConnections.pop()?.close();
  }
});

function createRig(): UnitRig {
  const conn = new DatabaseConstructor(':memory:');
  conn.pragma('foreign_keys = ON');
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience']) {
    const upSqlPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
  }
  openConnections.push(conn);
  return { conn, db: drizzle(conn, { schema }) };
}

function run(conn: DatabaseConstructor.Database, sql: string, ...args: unknown[]): void {
  conn.prepare(sql).run(...args);
}

function seedPolicy(
  conn: DatabaseConstructor.Database,
  profileId: string,
  maxContentLevel: number,
  allowUnrated: 0 | 1,
  allowedMediaIds = '[]',
  blockedMediaIds = '[]',
  allowedChannelIds = '[]',
): void {
  run(
    conn,
    "INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES ('hh-1', ?, ?, ?, ?, ?, ?, 1, ?)",
    profileId,
    maxContentLevel,
    allowUnrated,
    allowedMediaIds,
    blockedMediaIds,
    allowedChannelIds,
    NOW_ISO,
  );
}

/** 身份夹具:成人/儿童双档案 + 各自会话;儿童策略 6+拒绝未评级,名单含 allowed∩blocked 交集 */
function seedIdentity(conn: DatabaseConstructor.Database): void {
  run(conn, "INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-1', '单元之家', 'zh-CN', 'Asia/Shanghai', ?)", NOW_ISO);
  run(conn, "INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES ('acc-1', 'hh-1', 'admin', 'admin', 'unit-hash', 'owner', ?)", NOW_ISO);
  run(conn, "INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES ('dev-1', 'hh-1', NULL, 'web', NULL, NULL, ?)", NOW_ISO);
  for (const [id, type] of [['prof-adult', 'adult'], ['prof-child', 'child']] as const) {
    run(
      conn,
      "INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, 'hh-1', 'acc-1', ?, NULL, ?, 0, NULL, 'active', 0, NULL, ?)",
      id,
      type === 'adult' ? '成人' : '儿童',
      type,
      NOW_ISO,
    );
  }
  for (const [id, hash, active] of [['ses-adult', 'hash-adult', 'prof-adult'], ['ses-child', 'hash-child', 'prof-child']] as const) {
    run(
      conn,
      "INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, 'hh-1', 'acc-1', 'dev-1', ?, ?, ?, NULL, ?, ?)",
      id,
      hash,
      active,
      FUTURE_ISO,
      NOW_ISO,
      NOW_ISO,
    );
  }
  // 跨家庭档案夹具:他家庭 hh-2 的档案(会话指向它 → 归属不一致拒绝;不改动 hh-1 行避免复合 FK 失败)
  run(conn, "INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-2', '另一家', 'zh-CN', 'Asia/Shanghai', ?)", NOW_ISO);
  run(conn, "INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES ('acc-2', 'hh-2', 'other', 'other', 'unit-hash', 'owner', ?)", NOW_ISO);
  run(
    conn,
    "INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES ('prof-foreign', 'hh-2', 'acc-2', '别家档案', NULL, 'adult', 0, NULL, 'active', 0, NULL, ?)",
    NOW_ISO,
  );
  seedPolicy(conn, 'prof-adult', 18, 1);
  seedPolicy(conn, 'prof-child', 6, 0, JSON.stringify(['m-blocked-allowed', 'm-allow-only']), JSON.stringify(['m-blocked-allowed']), JSON.stringify(['ch-in']));
}

function seedCatalog(conn: DatabaseConstructor.Database): void {
  const insertSource = conn.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, 'hh-1', 'iptv', ?, 'http://unit-seed.example/a.m3u8', NULL, NULL, 1, NULL, ?, 1, NULL, NULL, ?, ?)",
  );
  insertSource.run('src-a', '启用源', 1, NOW_ISO, NOW_ISO);
  insertSource.run('src-off', '停用源', 0, NOW_ISO, NOW_ISO);

  const insertMedia = conn.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)',
  );
  const insertEntry = conn.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, 'hh-1', ?, 'url', ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, NULL)",
  );
  const insertPlayback = conn.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, 'hh-1', ?, ?, ?, 'http', 'http://unit-seed.example/stream', NULL, 100, 0, ?, ?)",
  );

  const seed = (
    id: string,
    type: MediaType,
    title: string,
    contentLevel: number | null,
    sources: Array<{ sourceId: string; present?: 0 | 1; playback?: boolean }>,
  ): void => {
    insertMedia.run(id, 'hh-1', type, title, null, contentLevel, NOW_ISO, NOW_ISO);
    for (const source of sources) {
      const entryId = `entry-${id}-${source.sourceId}`;
      insertEntry.run(
        entryId,
        source.sourceId,
        createHash('sha256').update(`${source.sourceId}:${id}`).digest('hex'),
        id,
        source.present ?? 1,
        NOW_ISO,
        NOW_ISO,
      );
      if (source.playback ?? true) {
        insertPlayback.run(`pb-${id}-${source.sourceId}`, source.sourceId, entryId, id, NOW_ISO, NOW_ISO);
      }
    }
  };

  seed('m-low', 'movie', '低级片', 3, [{ sourceId: 'src-a' }]);
  seed('m-high', 'movie', '高级片', 18, [{ sourceId: 'src-a' }]);
  seed('m-unrated', 'video', '未评级片', null, [{ sourceId: 'src-a' }]);
  // allowed∩blocked 交集:黑名单必须优先(即使同时在允许名单)
  seed('m-blocked-allowed', 'movie', '交集片', 3, [{ sourceId: 'src-a' }]);
  // 在允许名单 → 覆盖等级上限(18 > 儿童 6)
  seed('m-allow-only', 'movie', '名单片', 18, [{ sourceId: 'src-a' }]);
  // 频道种子给 contentLevel=0:未评级在判定表序中位于频道白名单之后,
  // 用已评级频道使「白名单内可见/名单外不可见」与 allowUnrated 解耦。
  seed('ch-in', 'channel', '白名单台', 0, [{ sourceId: 'src-a' }]);
  seed('ch-out', 'channel', '名单外台', 0, [{ sourceId: 'src-a' }]);
  // 不可用:仅停用来源
  seed('m-off', 'movie', '失效片', 3, [{ sourceId: 'src-off' }]);
  // 可用:停用来源 + 启用来源并存(来源独立性)
  seed('m-dual', 'movie', '双源片', 3, [{ sourceId: 'src-off' }, { sourceId: 'src-a' }]);
  // 不可用:条目缺失 / 无播放资源
  seed('m-absent', 'movie', '缺条目片', 3, [{ sourceId: 'src-a', present: 0 }]);
  seed('m-nores', 'movie', '无资源片', 3, [{ sourceId: 'src-a', playback: false }]);
}

function freshRig(): UnitRig {
  const rig = createRig();
  seedIdentity(rig.conn);
  seedCatalog(rig.conn);
  return rig;
}

function candidateIds(context: BatchCatalogContext): string[] {
  return context.allowed.map((candidate) => candidate.id).sort();
}

function expectDomainError(action: () => unknown, status: number, code: ProblemCode): void {
  let caught: unknown;
  try {
    action();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DomainError);
  const domain = caught as DomainError;
  expect(domain.status).toBe(status);
  expect(domain.code).toBe(code);
}

/** drizzle 句柄计数代理:统计根 select() 调用次数(每个查询恰好一次) */
function countedDb(db: Db): { db: Db; count(): number } {
  let selects = 0;
  const proxy = new Proxy(db as object, {
    get(target, prop) {
      if (prop === 'select') {
        return (...args: unknown[]) => {
          selects += 1;
          return (target as Db).select(...(args as Parameters<Db['select']>));
        };
      }
      return Reflect.get(target, prop, target);
    },
  });
  return { db: proxy as Db, count: () => selects };
}

function candidateRow(id: string, title: string, overrides: Partial<CatalogCandidateRow> = {}): CatalogCandidateRow {
  return {
    id,
    type: 'movie',
    title,
    description: null,
    contentLevel: 3,
    version: 1,
    available: true,
    ...overrides,
  };
}

describe('T033 批量目录上下文(单次同步装载 + evaluatePolicy 同序过滤)', () => {
  it('单次同步读取:查询数与候选规模无关(无 N+1),返回值非 Promise(无逐条 await)', () => {
    const rig = freshRig();
    const small = countedDb(rig.db);
    const smallContext = loadBatchCatalogContext(small.db, { householdId: 'hh-1', sessionId: 'ses-adult' });
    const smallCount = small.count();
    expect((smallContext as { then?: unknown }).then).toBeUndefined();

    // 候选规模 +20(总量 31,环境硬约束内的小体量放大)→ 查询数必须不变
    const insertMedia = rig.conn.prepare(
      'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)',
    );
    const insertChain = rig.conn.prepare(
      "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, 'hh-1', 'src-a', 'url', ?, ?, NULL, 1, NULL, ?, ?, NULL, NULL, NULL)",
    );
    const insertPlayback = rig.conn.prepare(
      "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, 'hh-1', 'src-a', ?, ?, 'http', 'http://unit-seed.example/s', NULL, 100, 0, ?, ?)",
    );
    for (let i = 0; i < 20; i += 1) {
      const id = `m-bulk-${i}`;
      insertMedia.run(id, 'hh-1', 'movie', `批量片${i}`, null, 3, NOW_ISO, NOW_ISO);
      insertChain.run(`entry-${id}`, createHash('sha256').update(`src-a:${id}`).digest('hex'), id, NOW_ISO, NOW_ISO);
      insertPlayback.run(`pb-${id}`, `entry-${id}`, id, NOW_ISO, NOW_ISO);
    }

    const large = countedDb(rig.db);
    const largeContext = loadBatchCatalogContext(large.db, { householdId: 'hh-1', sessionId: 'ses-adult' });
    expect(large.count()).toBe(smallCount);
    expect(smallCount).toBeLessThanOrEqual(8); // 会话/设备/档案/策略/候选/可用性 —— 常数,不随候选数增长
    expect(smallContext.candidates).toHaveLength(11);
    expect(largeContext.candidates).toHaveLength(31);
    // 成人 18+允许未评级 → 除 3 条不可用候选外全部可见(31-3=28)
    expect(largeContext.allowed).toHaveLength(28);
  });

  it('可用性事实(T034 复用):双源独立性/缺条目/无资源/停用源;查询键须为会话家庭', () => {
    const rig = freshRig();
    const facts = loadMediaAvailabilityFacts(rig.db, { householdId: 'hh-1' });
    expect(facts.size).toBe(11);
    expect(facts.get('m-dual')).toBe(true); // 一源停用不屏蔽另一启用来源
    expect(facts.get('m-off')).toBe(false);
    expect(facts.get('m-absent')).toBe(false);
    expect(facts.get('m-nores')).toBe(false);

    expect(isMediaAvailable(rig.db, { householdId: 'hh-1', mediaId: 'm-dual' })).toBe(true);
    expect(isMediaAvailable(rig.db, { householdId: 'hh-1', mediaId: 'm-off' })).toBe(false);
    expect(isMediaAvailable(rig.db, { householdId: 'hh-1', mediaId: '不存在' })).toBe(false);
    expect(isMediaAvailable(rig.db, { householdId: 'hh-other', mediaId: 'm-dual' })).toBe(false);

    const subset = loadMediaAvailabilityFacts(rig.db, { householdId: 'hh-1', mediaIds: ['m-dual', 'm-off'] });
    expect([...subset.keys()].sort()).toStrictEqual(['m-dual', 'm-off']);
    expect(loadMediaAvailabilityFacts(rig.db, { householdId: 'hh-1', mediaIds: [] }).size).toBe(0);
  });

  it('会话/设备/档案信任源:无档案、撤销、过期、设备撤销、档案停用、跨家庭档案 → 403 ACTIVE_PROFILE_REQUIRED', () => {
    const rig = freshRig();
    const load = (): unknown => loadBatchCatalogContext(rig.db, { householdId: 'hh-1', sessionId: 'ses-adult' });

    run(rig.conn, 'UPDATE device_session SET active_profile_id = NULL WHERE id = ?', 'ses-adult');
    expectDomainError(load, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    run(rig.conn, 'UPDATE device_session SET active_profile_id = ? WHERE id = ?', 'prof-adult', 'ses-adult');

    run(rig.conn, 'UPDATE device_session SET revoked_at = ? WHERE id = ?', NOW_ISO, 'ses-adult');
    expectDomainError(load, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    run(rig.conn, 'UPDATE device_session SET revoked_at = NULL WHERE id = ?', 'ses-adult');

    run(rig.conn, 'UPDATE device_session SET expires_at = ? WHERE id = ?', NOW_ISO, 'ses-adult');
    expectDomainError(load, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    run(rig.conn, 'UPDATE device_session SET expires_at = ? WHERE id = ?', FUTURE_ISO, 'ses-adult');

    run(rig.conn, 'UPDATE device SET revoked_at = ? WHERE id = ?', NOW_ISO, 'dev-1');
    expectDomainError(load, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    run(rig.conn, 'UPDATE device SET revoked_at = NULL WHERE id = ?', 'dev-1');

    run(rig.conn, "UPDATE profile SET status = 'disabled' WHERE id = 'prof-adult'");
    expectDomainError(load, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    run(rig.conn, "UPDATE profile SET status = 'active' WHERE id = 'prof-adult'");

    // 跨家庭档案:会话指向他家庭档案 → 归属不一致拒绝(以会话行为准)
    run(rig.conn, 'UPDATE device_session SET active_profile_id = ? WHERE id = ?', 'prof-foreign', 'ses-adult');
    expectDomainError(load, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    run(rig.conn, 'UPDATE device_session SET active_profile_id = ? WHERE id = ?', 'prof-adult', 'ses-adult');

    // 调用方 householdId 与会话行不一致 → 以会话行为准拒绝
    expectDomainError(
      () => loadBatchCatalogContext(rig.db, { householdId: 'hh-forged', sessionId: 'ses-adult' }),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
  });

  it('策略缺失/损坏 → 503 POLICY_UNAVAILABLE(不伪装空列表、不回落默认)', () => {
    const rig = freshRig();
    const load = (): unknown => loadBatchCatalogContext(rig.db, { householdId: 'hh-1', sessionId: 'ses-child' });

    run(rig.conn, 'DELETE FROM profile_policy WHERE profile_id = ?', 'prof-child');
    expectDomainError(load, 503, ProblemCode.POLICY_UNAVAILABLE);

    // 名单 JSON 损坏:CHECK 对合法写入生效,经 ignore_check_constraints 注入损坏行(与 e2e 同法)
    rig.conn.exec('PRAGMA ignore_check_constraints = 1');
    run(
      rig.conn,
      "INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES ('hh-1', 'prof-child', 6, 0, '{broken', '[]', '[]', 1, ?)",
      NOW_ISO,
    );
    rig.conn.exec('PRAGMA ignore_check_constraints = 0');
    expectDomainError(load, 503, ProblemCode.POLICY_UNAVAILABLE);
  });

  it('过滤与 evaluatePolicy 同序:黑名单优先、未评级按 allowUnrated、频道白名单仅 channel、允许名单覆盖等级', () => {
    const rig = freshRig();
    const child = loadBatchCatalogContext(rig.db, { householdId: 'hh-1', sessionId: 'ses-child' });
    // 儿童(6,拒绝未评级,allowed∩blocked 交集,频道白名单 [ch-in]):
    // 可见 = m-low(3) + m-allow-only(名单覆盖 18 上限) + m-dual(3,双源可用) + ch-in(白名单频道)
    expect(child.profileType).toBe('child');
    expect(candidateIds(child)).toStrictEqual(['ch-in', 'm-allow-only', 'm-dual', 'm-low']);
    // 交集片在候选集中但被黑名单优先排除
    expect(child.candidates.map((candidate) => candidate.id)).toContain('m-blocked-allowed');
    expect(child.allowed.map((candidate) => candidate.id)).not.toContain('m-blocked-allowed');

    // 未评级按 allowUnrated:儿童 allowUnrated=false → 不可见;改为 true → 立即可见(名单不变)
    run(rig.conn, 'UPDATE profile_policy SET allow_unrated = 1 WHERE profile_id = ?', 'prof-child');
    const childAllowUnrated = loadBatchCatalogContext(rig.db, { householdId: 'hh-1', sessionId: 'ses-child' });
    expect(candidateIds(childAllowUnrated)).toContain('m-unrated');

    // 成人(18,允许未评级,空名单):频道无白名单门槛;不可用候选仍被排除(可用性先于策略)
    const adult = loadBatchCatalogContext(rig.db, { householdId: 'hh-1', sessionId: 'ses-adult' });
    expect(adult.profileType).toBe('adult');
    expect(candidateIds(adult)).toStrictEqual([
      'ch-in',
      'ch-out',
      'm-allow-only',
      'm-blocked-allowed',
      'm-dual',
      'm-high',
      'm-low',
      'm-unrated',
    ]);
    for (const unavailableId of ['m-off', 'm-absent', 'm-nores']) {
      expect(adult.allowed.map((candidate) => candidate.id)).not.toContain(unavailableId);
    }
  });
});

describe('T033 目录管线(先过滤后搜索/排序/计数/分页)', () => {
  it('title 二进制(BINARY)升序、同题按 id 稳定;重复构建顺序一致', () => {
    const allowed = [
      candidateRow('b-2', '同题'),
      candidateRow('a-1', '同题'),
      candidateRow('z-1', 'Zebra'),
      candidateRow('y-1', 'apple'),
      candidateRow('x-1', 'Banana'),
    ];
    const query: ListMediaQuery = { page: 1, pageSize: 10 };
    const first = buildMediaPage(allowed, query);
    // B(0x42) < Z(0x5A) < a(0x61) < 同(U+540C):locale 排序会把小写插在 Zebra 前,BINARY 不会
    expect(first.items.map((item) => item.id)).toStrictEqual(['x-1', 'z-1', 'y-1', 'a-1', 'b-2']);
    const second = buildMediaPage(allowed, query);
    expect(second.items.map((item) => item.id)).toStrictEqual(first.items.map((item) => item.id));
  });

  it('先过滤后计数分页:total 为过滤后总数,越界页空列表;搜索/type 只影响筛选', () => {
    const allowed = [
      candidateRow('m-1', 'Alpha 片'),
      candidateRow('m-2', 'alpha 片'),
      candidateRow('m-3', 'Beta 片'),
      candidateRow('c-1', 'Gamma 台', { type: 'channel' }),
    ];

    const page1 = buildMediaPage(allowed, { page: 1, pageSize: 2 });
    expect(page1.total).toBe(4);
    expect(page1.items.map((item) => item.id)).toStrictEqual(['m-1', 'm-3']);
    const page2 = buildMediaPage(allowed, { page: 2, pageSize: 2 });
    expect(page2.total).toBe(4);
    expect(page2.items.map((item) => item.id)).toStrictEqual(['c-1', 'm-2']);
    const beyond = buildMediaPage(allowed, { page: 9, pageSize: 2 });
    expect(beyond.items).toStrictEqual([]);
    expect(beyond.total).toBe(4);

    // q 大小写不敏感字面包含(%/_ 不作通配);q+type 组合
    expect(buildMediaPage(allowed, { q: 'alpha', page: 1, pageSize: 10 }).total).toBe(2);
    expect(buildMediaPage(allowed, { q: '%', page: 1, pageSize: 10 }).total).toBe(0);
    expect(buildMediaPage(allowed, { q: '  Beta  ', page: 1, pageSize: 10 }).total).toBe(1);
    const channels = buildMediaPage(allowed, { type: 'channel', page: 1, pageSize: 10 });
    expect(channels.total).toBe(1);
    expect(channels.items[0]?.id).toBe('c-1');
    // 空结果仍是 200 形状的空页
    expect(buildMediaPage(allowed, { q: '不存在', page: 1, pageSize: 20 })).toStrictEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
  });

  it('MediaDto 映射:键集合精确、poster=null、contentLevel/description/version 透传', () => {
    const allowed = [
      candidateRow('m-1', '某片', { contentLevel: 18, description: '简介', version: 7 }),
      candidateRow('m-2', '未评级片', { contentLevel: null, type: 'video' }),
    ];
    const page = buildMediaPage(allowed, { page: 1, pageSize: 10 });
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toStrictEqual([
        'contentLevel',
        'description',
        'id',
        'poster',
        'title',
        'type',
        'version',
      ]);
      expect(item.poster).toBeNull();
    }
    // BINARY 序:未(U+672A) < 某(U+67D0) → '未评级片' 在前
    expect(page.items[1]).toMatchObject({ id: 'm-1', contentLevel: 18, description: '简介', version: 7 });
    expect(page.items[0]).toMatchObject({ id: 'm-2', contentLevel: null, description: null, type: 'video' });
    // 响应不携带候选内部字段(available 等)
    expect(JSON.stringify(page)).not.toContain('available');
  });
});

/**
 * T056 性能守卫(SC-005):
 * - 双跑对比测试(R7 等价下推守卫):批量上下文的集合式可用性查询(loadAvailableMediaIdSet)
 *   与权威逐行 EXISTS(loadMediaAvailabilityFacts)在同一数据库上对同一 id 域逐 id 对照,
 *   两侧任何一侧 join 链/谓词单独变更都会在此失败 —— 修改必须同步;
 * - 耗时上界哨兵:10k 内存候选批量过滤耗时的宽松防抖上界。它是回归哨兵而非性能基准
 *   (真实 SC-005 证据以 runtime-smoke S5 HTTP 层为准),阈值刻意放宽以吸收 CI 慢机抖动;
 *   若过滤路径回归为逐条查询或名单 O(n²) 复制判定,将显著越界。
 *   本用例纯内存构造候选,不经 better-sqlite3 批量装载(规避本机 Statement 终结竞态,
 *   保持既有小体量 DB 用例模式)。
 */
describe('T056 性能守卫(可用性等价下推双跑对比 + 10k 过滤耗时上界)', () => {
  it('双跑对比:集合式可用性与 resource-reader 逐行 EXISTS 对同一 id 域逐 id 一致', () => {
    const rig = freshRig();
    const canonical = loadMediaAvailabilityFacts(rig.db, { householdId: 'hh-1' });
    const availableIds = loadAvailableMediaIdSet(rig.db, 'hh-1');
    // 同一 id 域 = 权威 Map 的全部键 ∪ 集合查询的全部值(双方向覆盖,防一侧漏报)
    const allIds = new Set([...canonical.keys(), ...availableIds]);
    expect(allIds.size).toBeGreaterThan(0);
    for (const id of allIds) {
      expect(availableIds.has(id), `可用性不一致: ${id}`).toBe(canonical.get(id) === true);
    }
    // 夹具四种形状逐一钉住:双源可用/停用源/缺条目/无资源
    expect(availableIds.has('m-dual')).toBe(true);
    expect(availableIds.has('m-off')).toBe(false);
    expect(availableIds.has('m-absent')).toBe(false);
    expect(availableIds.has('m-nores')).toBe(false);
    // 不存在的 id:双方一致「不可用」(集合不含;权威 Map 无键)
    expect(availableIds.has('不存在')).toBe(false);
    expect(canonical.get('不存在')).toBeUndefined();
  });

  it('10k 内存候选过滤 < 1500ms(宽松防抖上界;回归哨兵,非基准)', () => {
    const candidates: CatalogCandidateRow[] = Array.from({ length: 10_000 }, (_, index) =>
      candidateRow(`perf-${String(index).padStart(5, '0')}`, `性能片${index}`),
    );
    // 名单非空(500 条黑名单)贴近上限场景:每候选两次名单成员判定仍须 O(1) 级别常数内
    const policy: PolicyJudgment = {
      maxContentLevel: 18,
      allowUnrated: true,
      allowedMediaIds: [],
      blockedMediaIds: candidates.slice(0, 500).map((candidate) => candidate.id),
      allowedChannelIds: [],
    };
    const started = performance.now();
    const allowed = filterAllowedCandidates(policy, 'adult', 'hh-1', candidates);
    const elapsedMs = performance.now() - started;
    expect(allowed).toHaveLength(9_500);
    expect(elapsedMs, `10k 过滤耗时 ${Math.round(elapsedMs * 10) / 10}ms,超出宽松上界`).toBeLessThan(1500);
  });
});
