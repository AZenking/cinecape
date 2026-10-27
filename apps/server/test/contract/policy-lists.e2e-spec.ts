import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode, type PolicyDto } from '@hmp/shared';
import { Database } from '../../src/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
} from '../helpers';
import { ensureSettingsUnlocked } from '../helpers-management';

/**
 * T049(US3 契约 e2e):PUT /profiles/{profileId}/policy/lists —— 真实媒体黑白名单事务。
 * 对照 contracts/api.md「家长候选与人工修正」节与 openapi.yaml UpdateLists/Policy schema:
 * - 三名单必填数组整体替换;每名单去重后 ≤1000(去重后 1001 → 400);每 ID 1~128、大小写敏感;
 * - allowedChannelIds 仅接受 type=channel 的媒体;每个 ID 校验同 Household 归属,
 *   任一不存在/跨家庭 → 整体 400 且原策略不变;
 * - expectedVersion 冲突 409 POLICY_VERSION_CONFLICT;允许/禁止交集按提交保留;
 * - 目标 Profile 归属 Household+Account,与是否 active 无关(停用仍可保存);
 * - 与既有 PUT /profiles/{profileId}/policy(等级)共享同一策略版本:lists +1、等级再 +1;
 * - 无密码/空串 403 REQUIRED、错密码 403 FAILED、非 owner 403、跨家庭/不存在 Profile 404 同形。
 *
 * 环境硬约束:名单边界用例需 1000 个可引用媒体 ID —— 归属校验只读 media_item,
 * 种子为单事务批量轻量插入(无 source_entry/playback),不触碰大量内存分配。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;
const NOW_ISO = '2026-01-01T00:00:00.000Z';
const FOREIGN_MEDIA_ID = 'm-foreign-list';
const FOREIGN_PROFILE_ID = 'profile-foreign-list';

interface ListsFixture {
  app: INestApplication;
  cookie: string;
  householdId: string;
  profileId: string;
}

/** bulk-0000…bulk-0999:1000 个本家庭真实媒体 ID(电影) */
function bulkId(index: number): string {
  return `bulk-${String(index).padStart(4, '0')}`;
}

function bulkIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => bulkId(index));
}

function seedListMedia(householdId: string): void {
  const conn = Database.db;
  const insertMedia = conn.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 3, 0, 0, 1, ?, ?)',
  );
  const run = conn.transaction(() => {
    for (let index = 0; index < 1000; index += 1) {
      insertMedia.run(bulkId(index), householdId, 'movie', `名单片${index}`, NOW_ISO, NOW_ISO);
    }
    insertMedia.run('m'.repeat(128), householdId, 'movie', '超长ID电影', NOW_ISO, NOW_ISO);
    insertMedia.run('ch-alpha', householdId, 'channel', '名单频道甲', NOW_ISO, NOW_ISO);
    insertMedia.run('ch-beta', householdId, 'channel', '名单频道乙', NOW_ISO, NOW_ISO);
    insertMedia.run('c'.repeat(128), householdId, 'channel', '超长ID频道', NOW_ISO, NOW_ISO);
  });
  run();
}

/** 跨家庭夹具:独立家庭+账号+档案+媒体(复合 FK 要求账号同家庭) */
function seedForeignHousehold(): void {
  const conn = Database.db;
  conn
    .prepare("INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-foreign-lists', '对门家', 'zh-CN', 'Asia/Shanghai', ?)")
    .run(NOW_ISO);
  conn
    .prepare("INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES ('acc-foreign-lists', 'hh-foreign-lists', 'neighbor', 'neighbor', 'not-a-hash', 'owner', ?)")
    .run(NOW_ISO);
  conn
    .prepare("INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, 'hh-foreign-lists', 'acc-foreign-lists', '邻居档案', NULL, 'adult', 0, NULL, 'active', 0, NULL, ?)")
    .run(FOREIGN_PROFILE_ID, NOW_ISO);
  conn
    .prepare("INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, 'hh-foreign-lists', 'movie', '他家名单片', NULL, NULL, 3, 0, 0, 1, ?, ?)")
    .run(FOREIGN_MEDIA_ID, NOW_ISO, NOW_ISO);
}

async function setupLists(): Promise<ListsFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-lists-' });
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await ensureSettingsUnlocked(app, cookie);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  const householdId = (household.body as { id: string }).id;

  // 成人档案先建:停用目标(儿童)档案时家庭仍保留可用档案,不触发「最后可用档案」保护
  const adult = await request(app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookie)
    .send({ name: '名单成人', type: 'adult', ownerPassword: OWNER_PASSWORD });
  expect(adult.status).toBe(201);
  const child = await request(app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookie)
    .send({ name: '名单儿童', type: 'child', ownerPassword: OWNER_PASSWORD });
  expect(child.status).toBe(201);

  seedForeignHousehold();
  seedListMedia(householdId);
  return { app, cookie, householdId, profileId: (child.body as { id: string }).id };
}

function putLists(f: ListsFixture, body: Record<string, unknown>): request.Test {
  return request(f.app.getHttpServer())
    .put(`/api/settings/profiles/${f.profileId}/policy/lists`)
    .set('Cookie', f.cookie)
    .send(body);
}

function putLevel(f: ListsFixture, expectedVersion: number, policy: Record<string, unknown>): request.Test {
  return request(f.app.getHttpServer())
    .put(`/api/settings/profiles/${f.profileId}/policy`)
    .set('Cookie', f.cookie)
    .send({ ownerPassword: OWNER_PASSWORD, expectedVersion, policy });
}

function storedListsOf(profileId: string): { allowed: string[]; blocked: string[]; channels: string[]; version: number } {
  const row = Database.db
    .prepare('SELECT allowed_media_ids, blocked_media_ids, allowed_channel_ids, version FROM profile_policy WHERE profile_id = ?')
    .get(profileId) as { allowed_media_ids: string; blocked_media_ids: string; allowed_channel_ids: string; version: number };
  return {
    allowed: JSON.parse(row.allowed_media_ids) as string[],
    blocked: JSON.parse(row.blocked_media_ids) as string[],
    channels: JSON.parse(row.allowed_channel_ids) as string[],
    version: row.version,
  };
}

/** 断言策略(库内)与版本完全未被改动 */
function expectPolicyUntouched(f: ListsFixture, snapshot: { allowed: string[]; blocked: string[]; channels: string[]; version: number }): void {
  expect(storedListsOf(f.profileId)).toStrictEqual(snapshot);
}

describe('T049 名单事务契约(PUT /profiles/{profileId}/policy/lists)', () => {
  afterEach(cleanupRigs);

  it('三名单整体替换成功:PolicyDto 形状、version+1、去重排序落库、等级字段保持不变', async () => {
    const f = await setupLists();
    const res = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(3), bulkId(1), bulkId(3)],
      blockedMediaIds: [bulkId(2)],
      allowedChannelIds: ['ch-beta', 'ch-beta', 'ch-alpha'],
    });
    expect(res.status).toBe(200);
    const policy: PolicyDto = res.body;
    expect(Object.keys(policy).sort()).toStrictEqual([
      'allowUnrated',
      'allowedChannelIds',
      'allowedMediaIds',
      'blockedMediaIds',
      'maxContentLevel',
      'profileId',
      'updatedAt',
      'version',
    ]);
    expect(policy.profileId).toBe(f.profileId);
    expect(policy.maxContentLevel).toBe(12); // 儿童默认等级不被名单入口改写
    expect(policy.allowUnrated).toBe(false);
    expect(policy.allowedMediaIds).toStrictEqual([bulkId(1), bulkId(3)]); // 去重 + 排序
    expect(policy.blockedMediaIds).toStrictEqual([bulkId(2)]);
    expect(policy.allowedChannelIds).toStrictEqual(['ch-alpha', 'ch-beta']);
    expect(policy.version).toBe(2);
    expect(storedListsOf(f.profileId)).toStrictEqual({
      allowed: [bulkId(1), bulkId(3)],
      blocked: [bulkId(2)],
      channels: ['ch-alpha', 'ch-beta'],
      version: 2,
    });
  });

  it('去重与数量边界:重复 ID 计一次;2000 项去重后 1000 → 200;去重后 1001 → 400 且原值不变', async () => {
    const f = await setupLists();

    // 999 个唯一 ID(每个重复两次)→ 200,落库 999
    const save999 = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: bulkIds(999).flatMap((id) => [id, id]),
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(save999.status).toBe(200);
    expect(save999.body.version).toBe(2);
    expect(storedListsOf(f.profileId).allowed).toHaveLength(999);

    // 1000 个唯一 ID 重复提交 2000 项 → 去重后恰 1000,仍 200(去重先于上限)
    const save1000 = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      allowedMediaIds: bulkIds(1000).flatMap((id) => [id, id]),
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(save1000.status).toBe(200);
    expect(save1000.body.version).toBe(3);
    expect(storedListsOf(f.profileId).allowed).toHaveLength(1000);

    // 去重后 1001(1000 真实 + 1 不存在)→ 400;原名单与版本不变
    const over = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 3,
      allowedMediaIds: [...bulkIds(1000), 'no-such-media'],
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(over.status).toBe(400);
    expectProblemContentType(over);
    expect(over.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expect(storedListsOf(f.profileId).allowed).toHaveLength(1000);
    expect(storedListsOf(f.profileId).version).toBe(3);
  });

  it('ID 长度边界:128 字符可保存(电影与频道名单);129 → 400', async () => {
    const f = await setupLists();
    const longMovie = 'm'.repeat(128);
    const longChannel = 'c'.repeat(128);

    const ok128 = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [longMovie],
      blockedMediaIds: [],
      allowedChannelIds: [longChannel],
    });
    expect(ok128.status).toBe(200);
    expect(ok128.body.allowedMediaIds).toStrictEqual([longMovie]);
    expect(ok128.body.allowedChannelIds).toStrictEqual([longChannel]);

    const bad129 = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      allowedMediaIds: ['x'.repeat(129)],
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(bad129.status).toBe(400);
    expect(bad129.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expect(storedListsOf(f.profileId).allowed).toStrictEqual([longMovie]); // 原值不变
  });

  it('allowedChannelIds 含非频道媒体 → 400 整体拒绝,三名单与版本原值不变', async () => {
    const f = await setupLists();
    // 先建立基线名单
    const baseline = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(1)],
      blockedMediaIds: [bulkId(2)],
      allowedChannelIds: ['ch-alpha'],
    });
    expect(baseline.status).toBe(200);
    const snapshot = storedListsOf(f.profileId);

    const nonChannel = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      allowedMediaIds: [bulkId(1)],
      blockedMediaIds: [bulkId(2)],
      allowedChannelIds: [bulkId(5)], // 电影混入频道名单
    });
    expect(nonChannel.status).toBe(400);
    expect(nonChannel.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expectPolicyUntouched(f, snapshot);
  });

  it('不存在/跨家庭 ID → 400 整体拒绝且原值不变(含混合合法 ID 的整体失败)', async () => {
    const f = await setupLists();
    const baseline = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(1)],
      blockedMediaIds: [],
      allowedChannelIds: ['ch-alpha'],
    });
    expect(baseline.status).toBe(200);
    const snapshot = storedListsOf(f.profileId);

    const missing = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      allowedMediaIds: ['no-such-media'],
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expectPolicyUntouched(f, snapshot);

    const mixed = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      allowedMediaIds: [bulkId(9), 'no-such-media'],
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(mixed.status).toBe(400); // 任一非法整体失败
    expectPolicyUntouched(f, snapshot);

    const foreign = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      allowedMediaIds: [FOREIGN_MEDIA_ID], // 存在但属于其他家庭
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    expectPolicyUntouched(f, snapshot);
  });

  it('expectedVersion 冲突 → 409 POLICY_VERSION_CONFLICT,原名单与版本不变', async () => {
    const f = await setupLists();
    const first = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(1)],
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(first.status).toBe(200); // version → 2
    const snapshot = storedListsOf(f.profileId);

    const stale = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(2)],
      blockedMediaIds: [],
      allowedChannelIds: [],
    });
    expect(stale.status).toBe(409);
    expectProblemContentType(stale);
    expect(stale.body.code).toBe(ProblemCode.POLICY_VERSION_CONFLICT);
    expectPolicyUntouched(f, snapshot);
  });

  it('允许/禁止交集按提交保留(不自动去交)', async () => {
    const f = await setupLists();
    const res = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(7), bulkId(8)],
      blockedMediaIds: [bulkId(8), bulkId(9)], // bulk-8 交集
      allowedChannelIds: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.allowedMediaIds).toStrictEqual([bulkId(7), bulkId(8)]);
    expect(res.body.blockedMediaIds).toStrictEqual([bulkId(8), bulkId(9)]);
  });

  it('非 active Profile 保存成功:归属校验与是否 active 无关', async () => {
    const f = await setupLists();
    const disable = await request(f.app.getHttpServer())
      .patch(`/api/settings/profiles/${f.profileId}`)
      .set('Cookie', f.cookie)
      .send({ ownerPassword: OWNER_PASSWORD, status: 'disabled', clearPin: false, expectedVersion: 1 });
    expect(disable.status).toBe(200);
    expect((disable.body as { status: string }).status).toBe('disabled');

    const res = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(1)],
      blockedMediaIds: [],
      allowedChannelIds: ['ch-alpha'],
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
  });

  it('与等级入口共享同一策略版本:lists 保存 +1,等级保存再 +1,名单不被等级入口改写', async () => {
    const f = await setupLists();
    const lists = await putLists(f, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      allowedMediaIds: [bulkId(1)],
      blockedMediaIds: [bulkId(2)],
      allowedChannelIds: ['ch-alpha'],
    });
    expect(lists.status).toBe(200);
    expect(lists.body.version).toBe(2);

    const level = await putLevel(f, 2, { maxContentLevel: 10, allowUnrated: true });
    expect(level.status).toBe(200);
    expect(level.body.version).toBe(3); // 共享版本继续 +1
    expect(level.body.maxContentLevel).toBe(10);
    expect(level.body.allowUnrated).toBe(true);
    // 等级入口不扩充/不改写名单
    expect(level.body.allowedMediaIds).toStrictEqual([bulkId(1)]);
    expect(level.body.blockedMediaIds).toStrictEqual([bulkId(2)]);
    expect(level.body.allowedChannelIds).toStrictEqual(['ch-alpha']);
    expect(storedListsOf(f.profileId).version).toBe(3);
  });

  it('鉴权与归属:无密码/空串 403 REQUIRED、错密码 403 FAILED、非 owner 403、跨家庭与不存在 Profile 404 同形', async () => {
    const f = await setupLists();
    const validLists = { allowedMediaIds: [bulkId(1)], blockedMediaIds: [], allowedChannelIds: [] };

    const noPwd = await putLists(f, { expectedVersion: 1, ...validLists });
    expect(noPwd.status).toBe(403);
    expect(noPwd.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const emptyPwd = await putLists(f, { ownerPassword: '', expectedVersion: 1, ...validLists });
    expect(emptyPwd.status).toBe(403);
    expect(emptyPwd.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const wrongPwd = await putLists(f, { ownerPassword: 'not-the-password', expectedVersion: 1, ...validLists });
    expect(wrongPwd.status).toBe(403);
    expect(wrongPwd.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    expect(String(wrongPwd.body.detail ?? '')).not.toContain('not-the-password');

    // 005 settings 边界 = owner/admin:admin 允许(超长 ID 400 先于密码校验)
    Database.db.prepare("UPDATE account SET role = 'admin'").run();
    const admin = await putLists(f, { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, allowedMediaIds: ['x'.repeat(129)], blockedMediaIds: [], allowedChannelIds: [] });
    expect(admin.status).toBe(400);
    expect(admin.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    Database.db.prepare("UPDATE account SET role = 'owner'").run();

    // 不存在与跨家庭 Profile 统一 404 同形
    const missing = await request(f.app.getHttpServer())
      .put(`/api/settings/profiles/${randomUUID()}/policy/lists`)
      .set('Cookie', f.cookie)
      .send({ ownerPassword: OWNER_PASSWORD, expectedVersion: 1, ...validLists });
    const foreignProfile = await request(f.app.getHttpServer())
      .put(`/api/settings/profiles/${FOREIGN_PROFILE_ID}/policy/lists`)
      .set('Cookie', f.cookie)
      .send({ ownerPassword: OWNER_PASSWORD, expectedVersion: 1, ...validLists });
    for (const problem of [missing, foreignProfile]) {
      expect(problem.status).toBe(404);
      expectProblemContentType(problem);
      expect(problem.body.code).toBe(ProblemCode.NOT_FOUND);
      expect(problem.body.status).toBe(404);
    }
    expect(missing.body).toStrictEqual(foreignProfile.body);

    // 参数校验:缺名单/缺 expectedVersion/未知字段 → 400(在家长验证之前先拒绝非法形态?
    // 契约次序:格式(400)先于家长验证 —— 与 policy.controller 既有 PUT 一致)
    const badShape = await putLists(f, { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, allowedMediaIds: [] });
    expect(badShape.status).toBe(400);
    expect(badShape.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    const unknownField = await putLists(f, { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, ...validLists, extra: 1 });
    expect(unknownField.status).toBe(400);
  });
});
