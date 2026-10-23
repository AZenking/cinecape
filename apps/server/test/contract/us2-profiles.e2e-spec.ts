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

/**
 * T023(US2 契约 e2e):选择与切换观看 Profile,含 PIN 保护。
 * 对照 contracts/openapi.yaml:/profiles POST、/profiles/{id} PATCH、
 * /profiles/{id}/select、/profiles/{id}/unlock;错误一律 RFC 9457 problem+json。
 *
 * 场景映射(spec.md US2 验收 1-7 / FR-013~019):
 * a) 创建 adult/child(+可选 PIN)→ 201 ProfileDto 形,pinHash 绝不出现(场景1/5,FR-013/007)
 * b) 默认唯一互换:PATCH isDefault=true,旧默认自动取消(场景2,FR-013)
 * c) 停用唯一可用 Profile → 409 LAST_ACTIVE_PROFILE(场景3,FR-013)
 * d) select 矩阵:合法(查 device_session.active_profile_id)/ 不存在 404 / 跨家庭夹具 404 不泄露存在性 /
 *    已停用 403 PROFILE_NOT_SELECTABLE(场景4/6/7,FR-014/016/019)
 * e) PIN 流:未解锁 select 403 PROFILE_PIN_REQUIRED;错误 PIN 403;连续 5 次错误触发锁定;
 *    锁定窗口内正确 PIN 也 423;窗口过期重试成功并授予 select(场景5,FR-015)
 * f) 停用某会话当前观看者 → active_profile_id 同事务清空(场景6,FR-016/T028)
 * g) 伪造 householdId/profileId 请求体/查询字段一律被忽略;无会话 401(场景7,FR-018/019)
 *
 * 锁定窗口说明:不使用 PIN_LOCK_MINUTES=0(envSchema positive 校验拒绝 0)。
 * 「窗口内」用例由真实触发锁定(5 次错误)后立即断言(默认窗口 5 分钟,无需等待);
 * 「窗口过期」用例通过直写测试库把 pin_locked_until 改写为过去时刻模拟,零等待。
 */

interface SessionFixture {
  app: INestApplication;
  cookie: string;
  sessionId: string;
  accountId: string;
  householdId: string;
}

/** 独立环境 + 初始化 + 登录(取登录会话而非 initialize 会话作断言主体) */
async function bootstrap(): Promise<SessionFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-us2-' });
  const init = await initialize(app);
  expect(init.status).toBe(201);

  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const account = loggedIn.body.account as { id: string; username: string; role: string };

  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  expect(household.status).toBe(200);

  return {
    app,
    cookie,
    sessionId: loggedIn.body.sessionId as string,
    accountId: account.id,
    householdId: household.body.id as string,
  };
}

function createProfile(s: SessionFixture, body: Record<string, unknown>): request.Test {
  // 阶段 2(002 契约变更):创建/编辑为管理写操作,须携带主账号密码;
  // 默认注入测试账号密码,个别用例可用 ownerPassword: undefined 显式省略
  return request(s.app.getHttpServer())
    .post('/api/profiles')
    .set('Cookie', s.cookie)
    .send({ ownerPassword: INITIALIZE_BODY.password, ...body });
}

function patchProfile(s: SessionFixture, profileId: string, body: Record<string, unknown>): request.Test {
  return request(s.app.getHttpServer())
    .patch(`/api/profiles/${profileId}`)
    .set('Cookie', s.cookie)
    .send({ ownerPassword: INITIALIZE_BODY.password, ...body });
}

function selectProfile(s: SessionFixture, profileId: string, forgedQueryProfileId?: string, ownerPassword?: string): request.Test {
  const suffix = forgedQueryProfileId === undefined ? '' : `?profileId=${forgedQueryProfileId}`;
  return request(s.app.getHttpServer())
    .post(`/api/profiles/${profileId}/select${suffix}`)
    .set('Cookie', s.cookie)
    .send(ownerPassword === undefined ? {} : { ownerPassword });
}

function unlockProfile(s: SessionFixture, profileId: string, pin: string): request.Test {
  return request(s.app.getHttpServer()).post(`/api/profiles/${profileId}/unlock`).set('Cookie', s.cookie).send({ pin });
}

function listProfiles(s: SessionFixture): request.Test {
  return request(s.app.getHttpServer()).get('/api/profiles').set('Cookie', s.cookie);
}

interface ProfileRow {
  id: string;
  household_id: string;
  account_id: string;
  name: string;
  avatar: string | null;
  type: string;
  is_default: number;
  pin_hash: string | null;
  status: string;
  failed_pin_count: number;
  pin_locked_until: string | null;
  created_at: string;
}

function profileRow(id: string): ProfileRow | undefined {
  return Database.db.prepare('SELECT * FROM profile WHERE id = ?').get(id) as ProfileRow | undefined;
}

/** data-model 权威断言:select 后查 device_session 行(而非 US3 才实现的 GET /auth/session) */
function activeProfileIdOf(sessionId: string): string | null {
  const row = Database.db.prepare('SELECT active_profile_id FROM device_session WHERE id = ?').get(sessionId) as
    | { active_profile_id: string | null }
    | undefined;
  return row?.active_profile_id ?? null;
}

function activeDefaultCount(householdId: string): number {
  const row = Database.db
    .prepare("SELECT COUNT(*) AS n FROM profile WHERE household_id = ? AND is_default = 1 AND status = 'active'")
    .get(householdId) as { n: number };
  return row.n;
}

/** 夹具注入:第二家庭 + 第二账号 + 其 profile(绕过一次性初始化守卫,专测跨家庭越权) */
function injectForeignHousehold(): { householdId: string; accountId: string; profileId: string } {
  const ids = { householdId: randomUUID(), accountId: randomUUID(), profileId: randomUUID() };
  const now = new Date().toISOString();
  Database.db
    .prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ids.householdId, '第二家庭', 'zh-CN', 'Asia/Shanghai', now);
  Database.db
    .prepare('INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ids.accountId, ids.householdId, 'stranger', 'stranger', '$argon2id$not-a-real-hash', 'owner', now);
  Database.db
    .prepare('INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ids.profileId, ids.householdId, ids.accountId, '别家档案', null, 'adult', 0, null, 'active', 0, null, now);
  return ids;
}

describe('US2 选择与切换观看 Profile,含 PIN 保护(契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('场景a/FR-013+FR-007:创建 adult(默认)与 child(含 PIN)→ 201 ProfileDto 形,pinHash 绝不出现,落库仅 argon2id 哈希', async () => {
    const s = await bootstrap();

    const adult = await createProfile(s, { name: '爸爸', type: 'adult', isDefault: true });

    expect(adult.status).toBe(201);
    expect(adult.body).toEqual({
      id: expect.any(String),
      name: '爸爸',
      avatar: null,
      type: 'adult',
      isDefault: true,
      pinProtected: false,
      status: 'active',
      createdAt: expect.any(String),
    });

    const child = await createProfile(s, {
      name: '女儿',
      type: 'child',
      avatar: 'https://example.test/a.png',
      pin: '4321',
    });

    expect(child.status).toBe(201);
    expect(child.body).toMatchObject({
      name: '女儿',
      type: 'child',
      avatar: 'https://example.test/a.png',
      isDefault: false,
      pinProtected: true,
      status: 'active',
    });

    // 场景5/FR-007:任何响应不含 PIN 哈希/失败计数等存储形态字段
    const serialized = JSON.stringify([adult.body, child.body]);
    expect(serialized).not.toContain('pinHash');
    expect(serialized).not.toContain('pin_hash');
    expect(serialized).not.toContain('failedPinCount');
    expect(serialized).not.toContain('$argon2');

    // 落库:仅哈希,明文 PIN 不落库;新档案计数归零
    const childRow = profileRow(child.body.id);
    expect(childRow?.pin_hash).toMatch(/^\$argon2id\$/);
    expect(childRow?.pin_hash).not.toContain('4321');
    expect(childRow?.failed_pin_count).toBe(0);
    expect(childRow?.pin_locked_until).toBeNull();
  });

  it('场景b/FR-013:PATCH isDefault=true 默认互换 —— 列表中默认唯一,旧默认自动取消', async () => {
    const s = await bootstrap();
    const a = await createProfile(s, { name: 'A', type: 'adult', isDefault: true });
    const b = await createProfile(s, { name: 'B', type: 'adult' });
    expect(a.body.isDefault).toBe(true);

    const swap = await patchProfile(s, b.body.id, { isDefault: true });

    expect(swap.status).toBe(200);
    expect(swap.body).toMatchObject({ id: b.body.id, isDefault: true });

    const list = await listProfiles(s);
    expect(list.status).toBe(200);
    const defaults = (list.body as Array<{ id: string; isDefault: boolean }>).filter((p) => p.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.id).toBe(b.body.id);
    expect((list.body as Array<{ id: string; isDefault: boolean }>).find((p) => p.id === a.body.id)?.isDefault).toBe(false);
    expect(activeDefaultCount(s.householdId)).toBe(1);

    // 反向互换回来,仍恰好一个默认(幂等收敛)
    const back = await patchProfile(s, a.body.id, { isDefault: true });
    expect(back.status).toBe(200);
    expect(activeDefaultCount(s.householdId)).toBe(1);
    const relist = await listProfiles(s);
    expect(
      (relist.body as Array<{ id: string; isDefault: boolean }>).filter((p) => p.isDefault)[0]?.id,
    ).toBe(a.body.id);
  });

  it('场景c/FR-013:停用唯一可用 Profile → 409 LAST_ACTIVE_PROFILE(problem+json),数据保持不变;存在其他可用时才允许', async () => {
    const s = await bootstrap();
    const a = await createProfile(s, { name: 'A', type: 'adult' });
    expect(a.status).toBe(201);

    const rejected = await patchProfile(s, a.body.id, { status: 'disabled' });

    expect(rejected.status).toBe(409);
    expectProblemContentType(rejected);
    expect(rejected.body.code).toBe(ProblemCode.LAST_ACTIVE_PROFILE);
    expect(rejected.body.status).toBe(409);
    expect(profileRow(a.body.id)?.status).toBe('active'); // 拒绝即无任何写入

    const b = await createProfile(s, { name: 'B', type: 'child' });
    const disableA = await patchProfile(s, a.body.id, { status: 'disabled' });
    expect(disableA.status).toBe(200);
    expect(disableA.body).toMatchObject({ id: a.body.id, status: 'disabled' });
    expect(profileRow(a.body.id)?.status).toBe('disabled');

    // B 成为唯一可用 → 再停用被拒
    const rejectedB = await patchProfile(s, b.body.id, { status: 'disabled' });
    expect(rejectedB.status).toBe(409);
    expect(rejectedB.body.code).toBe(ProblemCode.LAST_ACTIVE_PROFILE);
    expect(profileRow(b.body.id)?.status).toBe('active');
  });

  it('场景d/FR-014+FR-019:select 矩阵 —— 合法更新会话上下文;不存在/跨家庭 404 不泄露存在性;已停用 403 PROFILE_NOT_SELECTABLE', async () => {
    const s = await bootstrap();
    const a = await createProfile(s, { name: 'A', type: 'adult' });
    const c = await createProfile(s, { name: 'C', type: 'adult' });
    expect((await patchProfile(s, c.body.id, { status: 'disabled' })).status).toBe(200);

    // 合法 select:200 + 会话上下文摘要;权威断言按 data-model 查 device_session 行
    const selected = await selectProfile(s, a.body.id);

    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      sessionId: s.sessionId,
      account: { id: s.accountId, username: 'admin', role: 'owner' },
      expiresAt: expect.any(String),
    });
    expect(selected.body.activeProfile).toMatchObject({ id: a.body.id, name: 'A', type: 'adult', status: 'active' });
    expect(selected.body).not.toHaveProperty('sessionToken'); // 契约:sessionToken 仅登录响应出现一次
    expect(activeProfileIdOf(s.sessionId)).toBe(a.body.id);

    // 伪造不存在的 id → 404 NOT_FOUND
    const missing = await selectProfile(s, randomUUID());
    expect(missing.status).toBe(404);
    expectProblemContentType(missing);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);

    // 跨家庭 profile(夹具注入第二家庭)→ 同样 404,problem 体与「不存在」完全一致(不泄露存在性)
    const foreign = injectForeignHousehold();
    const crossFamily = await selectProfile(s, foreign.profileId);
    expect(crossFamily.status).toBe(404);
    expect(crossFamily.body.code).toBe(ProblemCode.NOT_FOUND);
    expect(crossFamily.body).toEqual(missing.body);

    // 已停用 → 403 PROFILE_NOT_SELECTABLE
    const disabled = await selectProfile(s, c.body.id);
    expect(disabled.status).toBe(403);
    expectProblemContentType(disabled);
    expect(disabled.body.code).toBe(ProblemCode.PROFILE_NOT_SELECTABLE);

    // 失败尝试不得影响既有会话上下文
    expect(activeProfileIdOf(s.sessionId)).toBe(a.body.id);
  });

  it('场景e/FR-015:PIN 流 —— 未解锁 select 403 PROFILE_PIN_REQUIRED;错误 PIN 403(仅含剩余次数);连续 5 次错误触发锁定,窗口内正确 PIN 也 423;窗口过期重试成功并授予 select', async () => {
    const s = await bootstrap();
    const a = await createProfile(s, { name: 'A', type: 'adult' });
    const b = await createProfile(s, { name: 'B', type: 'child', pin: '4321' });

    // 未解锁直接 select → 403 PROFILE_PIN_REQUIRED
    const locked = await selectProfile(s, b.body.id);
    expect(locked.status).toBe(403);
    expectProblemContentType(locked);
    expect(locked.body.code).toBe(ProblemCode.PROFILE_PIN_REQUIRED);
    expect(activeProfileIdOf(s.sessionId)).toBeNull();

    // 错误 PIN → 403 FORBIDDEN;detail 只含剩余次数,不回显 PIN、无其他提示
    const firstWrong = await unlockProfile(s, b.body.id, '0000');
    expect(firstWrong.status).toBe(403);
    expect(firstWrong.body.code).toBe(ProblemCode.FORBIDDEN);
    expect(firstWrong.body.detail).toContain('4'); // PIN_MAX_ATTEMPTS=5,剩余 4
    expect(firstWrong.body.detail).not.toContain('0000');
    expect(profileRow(b.body.id)?.failed_pin_count).toBe(1);

    // 连续错误至第 5 次:每次均 403(data-model:failed_pin_count < 5 → 验证),第 5 次触发锁定
    for (const remaining of [3, 2, 1, 0]) {
      const res = await unlockProfile(s, b.body.id, '0000');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ProblemCode.FORBIDDEN);
      expect(res.body.detail).toContain(String(remaining));
    }
    const bRow = profileRow(b.body.id);
    expect(bRow?.failed_pin_count).toBe(5);
    expect(bRow?.pin_locked_until).not.toBeNull();
    expect(Date.parse(bRow?.pin_locked_until as string)).toBeGreaterThan(Date.now());

    // 锁定窗口内:正确 PIN 也 423 PROFILE_PIN_LOCKED(默认窗口 5 分钟,立即断言,零等待)
    const correctDuringLock = await unlockProfile(s, b.body.id, '4321');
    expect(correctDuringLock.status).toBe(423);
    expectProblemContentType(correctDuringLock);
    expect(correctDuringLock.body.code).toBe(ProblemCode.PROFILE_PIN_LOCKED);
    expect(activeProfileIdOf(s.sessionId)).toBeNull();

    // 窗口过期(直写测试库把 pin_locked_until 改写为过去时刻,零等待)→ 正确 PIN 重试成功,计数清零
    Database.db
      .prepare('UPDATE profile SET pin_locked_until = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), b.body.id);
    const recovered = await unlockProfile(s, b.body.id, '4321');
    expect(recovered.status).toBe(200);
    expect(recovered.body).toEqual({ unlocked: true });
    const cleared = profileRow(b.body.id);
    expect(cleared?.failed_pin_count).toBe(0);
    expect(cleared?.pin_locked_until).toBeNull();

    // 解锁授予:select 成功;授予一次性消费,再次 select 需重新解锁(设计语义)
    const selected = await selectProfile(s, b.body.id);
    expect(selected.status).toBe(200);
    expect(selected.body.activeProfile).toMatchObject({ id: b.body.id, pinProtected: true });
    expect(activeProfileIdOf(s.sessionId)).toBe(b.body.id);

    const reSelected = await selectProfile(s, b.body.id);
    expect(reSelected.status).toBe(403);
    expect(reSelected.body.code).toBe(ProblemCode.PROFILE_PIN_REQUIRED);

    // 无 PIN 档案不受影响,可正常选择(家庭含儿童 B → 阶段 2 起需家长验证,002 契约变更)
    const selectA = await selectProfile(s, a.body.id, undefined, INITIALIZE_BODY.password);
    expect(selectA.status).toBe(200);
    expect(activeProfileIdOf(s.sessionId)).toBe(a.body.id);
  });

  it('场景f/T028+FR-016:停用某会话的当前观看者 → 同事务清空 device_session.active_profile_id,会话仍有效但须重新选择', async () => {
    const s = await bootstrap();
    const a = await createProfile(s, { name: 'A', type: 'adult' });
    const b = await createProfile(s, { name: 'B', type: 'child' });
    expect((await selectProfile(s, a.body.id, undefined, INITIALIZE_BODY.password)).status).toBe(200);
    expect(activeProfileIdOf(s.sessionId)).toBe(a.body.id);

    const disabled = await patchProfile(s, a.body.id, { status: 'disabled' });

    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
    expect(activeProfileIdOf(s.sessionId)).toBeNull();

    // 会话本身仍有效(仅当前观看者被清空),被停用档案不可再选
    expect((await listProfiles(s)).status).toBe(200);
    const reselect = await selectProfile(s, a.body.id);
    expect(reselect.status).toBe(403);
    expect(reselect.body.code).toBe(ProblemCode.PROFILE_NOT_SELECTABLE);

    // 切换到另一可用档案正常
    expect((await selectProfile(s, b.body.id)).status).toBe(200);
    expect(activeProfileIdOf(s.sessionId)).toBe(b.body.id);
  });

  it('场景g/FR-018+FR-019:伪造 householdId/profileId 请求体与查询字段一律被忽略,边界一律以服务端会话为准;无会话 401', async () => {
    const s = await bootstrap();
    const foreign = injectForeignHousehold();

    // 创建:塞入伪造 householdId/accountId/profileId → 仍归属会话的家庭与账号
    const created = await createProfile(s, {
      name: '伪造者',
      type: 'adult',
      householdId: foreign.householdId,
      accountId: foreign.accountId,
      profileId: foreign.profileId,
    });
    expect(created.status).toBe(201);
    expect(created.body.id).not.toBe(foreign.profileId);
    const createdRow = profileRow(created.body.id);
    expect(createdRow?.household_id).toBe(s.householdId);
    expect(createdRow?.account_id).toBe(s.accountId);

    // 编辑:伪造 profileId/householdId → 目标仍是路径参数指向的本家庭档案,他家庭档案不受影响
    const patched = await patchProfile(s, created.body.id, {
      name: '改名',
      profileId: foreign.profileId,
      householdId: foreign.householdId,
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: created.body.id, name: '改名' });
    expect(profileRow(foreign.profileId)?.name).toBe('别家档案');
    expect(profileRow(foreign.profileId)?.household_id).toBe(foreign.householdId);

    // select:伪造查询参数同样无效
    const selected = await selectProfile(s, created.body.id, foreign.profileId);
    expect(selected.status).toBe(200);
    expect(selected.body.activeProfile).toMatchObject({ id: created.body.id });

    // 无会话访问受保护能力 → 401 SESSION_INVALID(FR-019)
    const anonymous = await request(s.app.getHttpServer()).post('/api/profiles').send({ name: 'X', type: 'adult' });
    expect(anonymous.status).toBe(401);
    expectProblemContentType(anonymous);
    expect(anonymous.body.code).toBe(ProblemCode.SESSION_INVALID);
  });
});
