import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
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
import { ensureSettingsUnlocked, mgmtSessionCookie } from '../helpers-management';

/**
 * T009(US1 契约 e2e):策略读取/整体保存 —— FR-001/002/004/009/011/013/014。
 * 对照 contracts/openapi.yaml:/profiles/{id}/policy GET/PUT;错误 RFC 9457。
 * 判定次序(api.md):身份 → 角色 → 格式 → 家长验证 → 目标归属 → 版本 → 事务保存。
 */

interface SessionFixture {
  app: INestApplication;
  cookie: string;
  sessionId: string;
  householdId: string;
}

const OWNER_PASSWORD = INITIALIZE_BODY.password;

async function bootstrap(): Promise<SessionFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-us1-' });
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  await ensureSettingsUnlocked(app, cookiePairOf(loggedIn));
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookiePairOf(loggedIn));
  expect(household.status).toBe(200);
  return { app, cookie: cookiePairOf(loggedIn), sessionId: loggedIn.body.sessionId as string, householdId: household.body.id as string };
}

function createProfile(s: SessionFixture, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', s.cookie)
    .send({ ownerPassword: OWNER_PASSWORD, ...body })
    .then((r) => r);
}

function getPolicy(s: SessionFixture, profileId: string): Promise<request.Response> {
  return request(s.app.getHttpServer()).get(`/api/settings/profiles/${profileId}/policy`).set('Cookie', s.cookie).then((r) => r);
}

function putPolicy(s: SessionFixture, profileId: string, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .put(`/api/settings/profiles/${profileId}/policy`)
    .set('Cookie', s.cookie)
    .send(body)
    .then((r) => r);
}

function policyRowOf(profileId: string): { max_content_level: number; allow_unrated: number; version: number } | undefined {
  return Database.db
    .prepare('SELECT max_content_level, allow_unrated, version FROM profile_policy WHERE profile_id = ?')
    .get(profileId) as { max_content_level: number; allow_unrated: number; version: number } | undefined;
}

describe('US1 策略读取/整体保存(契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('默认策略:新建 adult/child 各有且仅有一份默认策略;GET 返回完整 PolicyDto,不含 householdId/凭据/计数', async () => {
    const s = await bootstrap();
    const adult = await createProfile(s, { name: '爸爸', type: 'adult' });
    const child = await createProfile(s, { name: '女儿', type: 'child' });
    expect(adult.status).toBe(201);
    expect(child.status).toBe(201);

    const adultPolicy = await getPolicy(s, adult.body.id);
    expect(adultPolicy.status).toBe(200);
    expect(adultPolicy.body).toEqual({
      profileId: adult.body.id,
      maxContentLevel: 18,
      allowUnrated: true,
      allowedMediaIds: [],
      blockedMediaIds: [],
      allowedChannelIds: [],
      version: 1,
      updatedAt: expect.any(String),
    });

    const childPolicy = await getPolicy(s, child.body.id);
    expect(childPolicy.status).toBe(200);
    expect(childPolicy.body).toMatchObject({ maxContentLevel: 12, allowUnrated: false, version: 1 });

    const serialized = JSON.stringify([adultPolicy.body, childPolicy.body]);
    expect(serialized).not.toContain('householdId');
    expect(serialized).not.toContain('ownerPassword');
    expect(serialized).not.toContain('failedAttempts');
  });

  it('PUT 成功:version +1(相同值仍 +1);三名单原样保留;落库一致;管理目标无须是当前观看者', async () => {
    const s = await bootstrap();
    const child = await createProfile(s, { name: '女儿', type: 'child' });
    // 夹具写入名单,验证 PUT 不覆盖/不清空(服务端保留语义,FR-009/FR-013)
    Database.db
      .prepare('UPDATE profile_policy SET allowed_media_ids = ?, blocked_media_ids = ? WHERE profile_id = ?')
      .run('["m2","m1"]', '["bad1"]', child.body.id);

    const saved = await putPolicy(s, child.body.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      policy: { maxContentLevel: 10, allowUnrated: true },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      profileId: child.body.id,
      maxContentLevel: 10,
      allowUnrated: true,
      allowedMediaIds: ['m2', 'm1'],
      blockedMediaIds: ['bad1'],
      allowedChannelIds: [],
      version: 2,
    });
    expect(policyRowOf(child.body.id)).toMatchObject({ max_content_level: 10, allow_unrated: 1, version: 2 });

    // 相同值保存仍 +1
    const again = await putPolicy(s, child.body.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 2,
      policy: { maxContentLevel: 10, allowUnrated: true },
    });
    expect(again.status).toBe(200);
    expect(again.body.version).toBe(3);
  });

  it('格式校验:未知字段/缺失字段/非法等级/非法 expectedVersion → 400 VALIDATION_FAILED 且不触达密码验证', async () => {
    const s = await bootstrap();
    const p = await createProfile(s, { name: 'A', type: 'child' });

    const cases: Array<[string, Record<string, unknown>]> = [
      ['未知顶层字段', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: 10, allowUnrated: false }, extra: 1 }],
      ['policy 未知字段', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: 10, allowUnrated: false, allowedMediaIds: ['x'] } }],
      ['缺 policy', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1 }],
      ['缺 allowUnrated', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: 10 } }],
      ['等级越界 19', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: 19, allowUnrated: false } }],
      ['等级负数', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: -1, allowUnrated: false } }],
      ['等级非整数', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: 1.5, allowUnrated: false } }],
      ['等级非数字', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, policy: { maxContentLevel: '12', allowUnrated: false } }],
      ['expectedVersion 0', { ownerPassword: OWNER_PASSWORD, expectedVersion: 0, policy: { maxContentLevel: 10, allowUnrated: false } }],
      ['expectedVersion 缺失', { ownerPassword: OWNER_PASSWORD, policy: { maxContentLevel: 10, allowUnrated: false } }],
    ];
    for (const [label, body] of cases) {
      const res = await putPolicy(s, p.body.id, body);
      expect(res.status, label).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code, label).toBe(ProblemCode.VALIDATION_FAILED);
    }
    // 全部格式失败不消耗家长验证次数(错误密码计数仍为 0)
    const state = Database.db
      .prepare('SELECT failed_attempts FROM parent_verification_state')
      .get() as { failed_attempts: number } | undefined;
    expect(state).toBeUndefined();
    expect(policyRowOf(p.body.id)?.version).toBe(1);
  });

  it('家长验证:密码缺失 403 REQUIRED;错误密码 403 FAILED(计数累加);锁定中正确密码 423;全部不改变策略', async () => {
    const s = await bootstrap();
    const p = await createProfile(s, { name: 'A', type: 'child' });

    const missing = await putPolicy(s, p.body.id, { expectedVersion: 1, policy: { maxContentLevel: 10, allowUnrated: false } });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const wrong = await putPolicy(s, p.body.id, {
      ownerPassword: 'not-the-password',
      expectedVersion: 1,
      policy: { maxContentLevel: 10, allowUnrated: false },
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    expect(wrong.body.detail).not.toContain('not-the-password');
    expect(policyRowOf(p.body.id)?.version).toBe(1);

    // 连续 5 次错误 → 锁定;窗口内正确密码也 423
    for (let i = 0; i < 4; i += 1) {
      const res = await putPolicy(s, p.body.id, {
        ownerPassword: 'nope',
        expectedVersion: 1,
        policy: { maxContentLevel: 10, allowUnrated: false },
      });
      expect(res.status).toBe(403);
    }
    const locked = await putPolicy(s, p.body.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      policy: { maxContentLevel: 10, allowUnrated: false },
    });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);
    expect(policyRowOf(p.body.id)).toMatchObject({ max_content_level: 12, allow_unrated: 0, version: 1 });
  });

  it('目标归属:不存在 404;跨家庭 404 同形;验证先于目标(错误密码跨家庭目标 → 403 FAILED 而非 404 泄漏)', async () => {
    const s = await bootstrap();
    const foreignProfileId = randomUUID();
    const foreignHousehold = randomUUID();
    const now = new Date().toISOString();
    Database.db
      .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(foreignHousehold, '别家', 'zh-CN', 'Asia/Shanghai', now);
    Database.db
      .prepare(
        "INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(randomUUID(), foreignHousehold, 'stranger', 'stranger', '$argon2id$x', 'owner', now);
    const foreignAccountId = (
      Database.db.prepare('SELECT id FROM account WHERE household_id = ?').get(foreignHousehold) as { id: string }
    ).id;
    Database.db
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, NULL, 'child', 0, NULL, 'active', 0, NULL, ?)",
      )
      .run(foreignProfileId, foreignHousehold, foreignAccountId, '别家儿童', now);

    const missing = await getPolicy(s, randomUUID());
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);

    const cross = await getPolicy(s, foreignProfileId);
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);

    // 契约次序:格式 → 家长验证 → 目标。错误密码时对跨家庭目标先失败于验证,不泄漏存在性
    const wrongPwdForeign = await putPolicy(s, foreignProfileId, {
      ownerPassword: 'nope',
      expectedVersion: 1,
      policy: { maxContentLevel: 10, allowUnrated: false },
    });
    expect(wrongPwdForeign.status).toBe(403);
    expect(wrongPwdForeign.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);

    // 正确密码 + 跨家庭目标 → 统一 404,与不存在同形
    const correctPwdForeign = await putPolicy(s, foreignProfileId, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      policy: { maxContentLevel: 10, allowUnrated: false },
    });
    expect(correctPwdForeign.status).toBe(404);
    expect(correctPwdForeign.body).toEqual(missing.body);
  });

  it('版本冲突:expectedVersion 过期 → 409 POLICY_VERSION_CONFLICT,等级/未评级/名单/版本全部不变', async () => {
    const s = await bootstrap();
    const p = await createProfile(s, { name: 'A', type: 'child' });

    const first = await putPolicy(s, p.body.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      policy: { maxContentLevel: 8, allowUnrated: false },
    });
    expect(first.status).toBe(200);

    const stale = await putPolicy(s, p.body.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      policy: { maxContentLevel: 3, allowUnrated: true },
    });
    expect(stale.status).toBe(409);
    expectProblemContentType(stale);
    expect(stale.body.code).toBe(ProblemCode.POLICY_VERSION_CONFLICT);
    expect(policyRowOf(p.body.id)).toMatchObject({ max_content_level: 8, allow_unrated: 0, version: 2 });
  });

  it('策略缺失/损坏:行缺失或名单损坏(非字符串元素)→ GET/PUT 503 POLICY_UNAVAILABLE,不静默补默认', async () => {
    const s = await bootstrap();
    const missing = await createProfile(s, { name: '无策略', type: 'child' });
    Database.db.prepare('DELETE FROM profile_policy WHERE profile_id = ?').run(missing.body.id);

    const getMissing = await getPolicy(s, missing.body.id);
    expect(getMissing.status).toBe(503);
    expectProblemContentType(getMissing);
    expect(getMissing.body.code).toBe(ProblemCode.POLICY_UNAVAILABLE);

    const putMissing = await putPolicy(s, missing.body.id, {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 1,
      policy: { maxContentLevel: 10, allowUnrated: false },
    });
    expect(putMissing.status).toBe(503);
    expect(putMissing.body.code).toBe(ProblemCode.POLICY_UNAVAILABLE);

    const corrupt = await createProfile(s, { name: '损坏', type: 'child' });
    Database.db
      .prepare('UPDATE profile_policy SET allowed_media_ids = ? WHERE profile_id = ?')
      .run('[1, 2]', corrupt.body.id); // 合法 JSON 数组但元素非字符串 → 应用层判损坏
    const getCorrupt = await getPolicy(s, corrupt.body.id);
    expect(getCorrupt.status).toBe(503);
    expect(getCorrupt.body.code).toBe(ProblemCode.POLICY_UNAVAILABLE);
  });

  it('无会话 401;管理目标可以是当前观看者之外的档案', async () => {
    const s = await bootstrap();
    const a = await createProfile(s, { name: 'A', type: 'adult' });
    const c = await createProfile(s, { name: 'C', type: 'child' });
    expect((await request(s.app.getHttpServer()).post(`/api/profiles/${a.body.id}/select`).set('Cookie', s.cookie).send({ ownerPassword: OWNER_PASSWORD })).status).toBe(200);

    // 会话当前观看者为 A:管理目标语义经独立管理会话表达(005 设置边界要求主档案选中)
    const mgmt = await mgmtSessionCookie(s.app, { username: INITIALIZE_BODY.username, password: OWNER_PASSWORD });
    const manageOther = await request(s.app.getHttpServer())
      .get(`/api/settings/profiles/${c.body.id}/policy`)
      .set('Cookie', mgmt);
    expect(manageOther.status).toBe(200);
    expect(manageOther.body.profileId).toBe(c.body.id);

    const anonymous = await request(s.app.getHttpServer()).get(`/api/settings/profiles/${a.body.id}/policy`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe(ProblemCode.SESSION_INVALID);
  });
});
