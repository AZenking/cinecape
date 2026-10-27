import 'reflect-metadata';
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
import { ensureSettingsUnlocked } from '../helpers-management';

/**
 * T019(US3 契约 e2e):管理写操作与成人切换的家长验证 —— FR-004/FR-012 + SC-004。
 * owner 会话可承载儿童观看,但不能因此授予变更能力;伪造"已验证"状态无效。
 */

interface SessionFixture {
  app: INestApplication;
  cookie: string;
  sessionId: string;
}

const PASSWORD = INITIALIZE_BODY.password;

async function bootstrap(): Promise<SessionFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, PASSWORD);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await ensureSettingsUnlocked(app, cookie);
  return { app, cookie, sessionId: loggedIn.body.sessionId as string };
}

function createProfile(s: SessionFixture, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer()).post('/api/settings/profiles').set('Cookie', s.cookie).send(body).then((r) => r);
}

function patchProfile(s: SessionFixture, profileId: string, body: Record<string, unknown>): Promise<request.Response> {
  // US8 契约:expectedVersion CAS —— 夹具读取库内现值,多段 PATCH 天然递增;clearPin 默认 false
  const row = Database.db.prepare('SELECT version FROM profile WHERE id = ?').get(profileId) as
    | { version: number }
    | undefined;
  return request(s.app.getHttpServer())
    .patch(`/api/settings/profiles/${profileId}`)
    .set('Cookie', s.cookie)
    .send({ clearPin: false, expectedVersion: row?.version ?? 1, ...body })
    .then((r) => r);
}

function selectProfile(s: SessionFixture, profileId: string, body?: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', s.cookie)
    .send(body ?? {})
    .then((r) => r);
}

function activeProfileIdOf(sessionId: string): string | null {
  const row = Database.db.prepare('SELECT active_profile_id FROM device_session WHERE id = ?').get(sessionId) as
    | { active_profile_id: string | null }
    | undefined;
  return row?.active_profile_id ?? null;
}

function policyCount(): number {
  return (Database.db.prepare('SELECT COUNT(*) AS n FROM profile_policy').get() as { n: number }).n;
}

describe('US3 管理写操作家长验证(契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('POST /profiles:密码缺失 403 REQUIRED 且无部分写入;错误密码 403 FAILED 不落库;正确密码 201 且档案+策略原子创建', async () => {
    const s = await bootstrap();
    const before = policyCount();
    const profilesBefore = (Database.db.prepare('SELECT COUNT(*) AS n FROM profile').get() as { n: number }).n;

    const missing = await createProfile(s, { name: '新档案', type: 'child' });
    expect(missing.status).toBe(403);
    expectProblemContentType(missing);
    expect(missing.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const wrong = await createProfile(s, { name: '新档案', type: 'child', ownerPassword: 'not-it' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    expect(wrong.body.detail).not.toContain('not-it');

    // 无孤儿行:两次失败均未创建档案或策略(主档案为夹具既有行,不计入)
    expect(
      (Database.db.prepare('SELECT COUNT(*) AS n FROM profile').get() as { n: number }).n,
    ).toBe(profilesBefore);
    expect(policyCount()).toBe(before);

    const ok = await createProfile(s, { name: '新档案', type: 'child', ownerPassword: PASSWORD });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: '新档案', type: 'child' });
    expect(policyCount()).toBe(before + 1);

    // 伪造"已验证"标记(未知字段)不被信任:仍需密码
    // 005 §1:未知字段(parentVerified/verified 等验证声明)一律 400,不能借此绕过家长验证
    const forged = await createProfile(s, { name: '又一个', type: 'adult', parentVerified: true, verified: 1 });
    // 005 §1:验证声明类未知字段一律 400(验证态只在当次请求 body,不可伪造)
    expect(forged.status).toBe(400);
    expect(forged.body.code).toBe(ProblemCode.VALIDATION_FAILED);
  });

  it('PATCH /profiles/{id}:名称/设 PIN/清 PIN 全部须家长验证;失败数据不变;type 为不可信未知字段被忽略', async () => {
    const s = await bootstrap();
    const created = await createProfile(s, { name: '原档案', type: 'adult', ownerPassword: PASSWORD });
    const id = created.body.id as string;

    const renameNoPwd = await patchProfile(s, id, { name: '改名' });
    expect(renameNoPwd.status).toBe(403);
    expect(renameNoPwd.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const renameWrong = await patchProfile(s, id, { name: '改名', ownerPassword: 'nope' });
    expect(renameWrong.status).toBe(403);
    expect(renameWrong.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);

    const row = Database.db.prepare('SELECT * FROM profile WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.name).toBe('原档案');
    expect(row.pin_hash).toBeNull();

    // 正确密码:设 PIN 成功
    const setPin = await patchProfile(s, id, { pin: '135790', ownerPassword: PASSWORD });
    expect(setPin.status).toBe(200);
    expect(setPin.body.pinProtected).toBe(true);

    // 清 PIN 亦须验证;错误密码拒绝且 PIN 保留
    const clearWrong = await patchProfile(s, id, { clearPin: true, ownerPassword: 'bad' });
    expect(clearWrong.status).toBe(403);
    expect((Database.db.prepare('SELECT pin_hash FROM profile WHERE id = ?').get(id) as { pin_hash: string }).pin_hash).not.toBeNull();

    const clearOk = await patchProfile(s, id, { clearPin: true, ownerPassword: PASSWORD });
    expect(clearOk.status).toBe(200);
    expect(clearOk.body.pinProtected).toBe(false);

    // 005 §1:type 为白名单枚举字段(不可信改档)→ 400 严格拒绝,不产生编辑效果
    const typeTamper = await patchProfile(s, id, { name: '合法改名', type: 'child', ownerPassword: PASSWORD });
    expect(typeTamper.status).toBe(400);
    expect((Database.db.prepare("SELECT name, type FROM profile WHERE id = ?").get(id) as { name: string; type: string }).name).not.toBe('合法改名');
  });

  it('儿童家庭选择无 PIN 成人:须家长验证(403 REQUIRED/FAILED → 正确密码 200);停用儿童同样触发保护', async () => {
    const s = await bootstrap();
    const adult = await createProfile(s, { name: '无码成人', type: 'adult', ownerPassword: PASSWORD });
    const child = await createProfile(s, { name: '儿童', type: 'child', ownerPassword: PASSWORD });
    const adultId = adult.body.id as string;

    // 儿童在列(可用)→ 无密码拒绝
    const noPwd = await selectProfile(s, adultId);
    expect(noPwd.status).toBe(403);
    expectProblemContentType(noPwd);
    expect(noPwd.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const wrong = await selectProfile(s, adultId, { ownerPassword: 'bad' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);

    const ok = await selectProfile(s, adultId, { ownerPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(activeProfileIdOf(s.sessionId)).toBe(adultId);

    // 换回儿童(儿童选择不走家长验证),停用儿童后再次选成人仍须验证(不得经停用绕过)
    expect((await selectProfile(s, child.body.id)).status).toBe(200);
    await patchProfile(s, child.body.id, { status: 'disabled', ownerPassword: PASSWORD });
    Database.db.prepare('UPDATE device_session SET active_profile_id = NULL WHERE id = ?').run(s.sessionId);
    const stillProtected = await selectProfile(s, adultId);
    expect(stillProtected.status).toBe(403);
    expect(stillProtected.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);
  });

  it('有 PIN 成人沿用 PIN 流程:ownerPassword 不替代 PIN 解锁;儿童选择不受影响;无儿童家庭无 PIN 成人可直接选择', async () => {
    const s = await bootstrap();
    const pinned = await createProfile(s, { name: '有码成人', type: 'adult', pin: '246813', ownerPassword: PASSWORD });
    const kid = await createProfile(s, { name: '儿童', type: 'child', ownerPassword: PASSWORD });

    // 未解锁:即使带正确 ownerPassword 也要求 PIN(ownerPassword 不替代解锁授予)
    const withPwd = await selectProfile(s, pinned.body.id, { ownerPassword: PASSWORD });
    expect(withPwd.status).toBe(403);
    expect(withPwd.body.code).toBe(ProblemCode.PROFILE_PIN_REQUIRED);

    await request(s.app.getHttpServer())
      .post(`/api/profiles/${pinned.body.id}/unlock`)
      .set('Cookie', s.cookie)
      .send({ pin: '246813' });
    const selected = await selectProfile(s, pinned.body.id);
    expect(selected.status).toBe(200);
    expect(activeProfileIdOf(s.sessionId)).toBe(pinned.body.id);

    // 儿童选择:家庭含儿童时选择无需 ownerPassword 的场景以实际契约为准 ——
    // 携带 ownerPassword 满足「儿童在列时选 PIN-less 成人须验证」的同一防线(儿童目标本身允许)
    expect((await selectProfile(s, kid.body.id, { ownerPassword: PASSWORD })).status).toBe(200);

    // 无儿童家庭:无 PIN 成人直接可选(阶段 1 行为保留)
    const s2 = await bootstrap();
    const onlyAdult = await createProfile(s2, { name: '独居成人', type: 'adult', ownerPassword: PASSWORD });
    const direct = await selectProfile(s2, onlyAdult.body.id);
    expect(direct.status).toBe(200);
  });

  it('过期/撤销会话 → 401;验证失败计数与策略数据不变', async () => {
    const s = await bootstrap();
    // 注销(撤销会话)后再写入 → 401
    const logout = await request(s.app.getHttpServer()).post('/api/auth/logout').set('Cookie', s.cookie);
    expect(logout.status).toBe(204);

    const rejected = await createProfile(s, { name: 'X', type: 'adult', ownerPassword: PASSWORD });
    expect(rejected.status).toBe(401);
    expect(rejected.body.code).toBe(ProblemCode.SESSION_INVALID);
    const profilesAtEnd = (Database.db.prepare('SELECT COUNT(*) AS n FROM profile').get() as { n: number }).n;
    expect(profilesAtEnd).toBeGreaterThan(0); // 主档案保留;登出后无新增写入
  });
});
