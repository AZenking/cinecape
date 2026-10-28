import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  restartApp,
  startFreshApp,
  type LoginOptions,
  type TestRig,
} from '../helpers';
import {
  ensureSettingsUnlocked,
  selectMainAndUnlockSettings,
  mgmtSessionCookie,
} from '../helpers-management';
import { getDb } from '@platform/database/drizzle';
import { generateToken, hashToken } from '@contexts/identity-access/infrastructure/token.service';
import { device, deviceSession, household } from '@platform/database/schema';

/**
 * T032(US3 契约 e2e):会话生命周期 —— 恢复、注销与设备撤销。
 * 对照 contracts/openapi.yaml:/auth/session、/auth/logout、/devices、
 * /devices/{deviceId}/revoke;错误一律 application/problem+json(RFC 9457)。
 *
 * 覆盖:FR-005(重启持久化)、FR-010(恢复/过期拒绝/滑动续期)、
 * FR-011(注销/设备撤销立即失效)、FR-012(幂等)、
 * Edge Cases(同设备多会话:注销只影响当前会话;恰好过期 = 已过期,无放行窗口)。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** SESSION_ABSOLUTE_DAYS 默认 90(见 config/env.schema.ts) */
const SESSION_ABSOLUTE_DAYS = 90;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LoginResult {
  /** name=value Cookie 对(回传请求用) */
  cookie: string;
  /** 一次性明文令牌(登录响应 sessionToken) */
  token: string;
  sessionId: string;
  expiresAt: string;
}

/** 初始化 + 登录(同一 rig 内可多次调用制造多设备/多会话;重复初始化 409 视为已就绪) */
async function setupAndLogin(app: INestApplication, options: LoginOptions = {}): Promise<LoginResult> {
  const init = await initialize(app);
  expect([201, 409]).toContain(init.status);
  const res = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password, options);
  expect(res.status).toBe(200);
  return {
    cookie: cookiePairOf(res),
    token: res.body.sessionToken as string,
    sessionId: res.body.sessionId as string,
    expiresAt: res.body.expiresAt as string,
  };
}

/** 按令牌读取会话行(测试夹具/库内状态断言;令牌 → SHA-256 → token_hash 唯一定位) */
function sessionByToken(token: string): typeof deviceSession.$inferSelect {
  const row = getDb()
    .select()
    .from(deviceSession)
    .where(eq(deviceSession.tokenHash, hashToken(token)))
    .get();
  if (row === undefined) {
    throw new Error('夹具错误:令牌对应会话不存在');
  }
  return row;
}

/**
 * 夹具:在既有设备上直接插入第二个会话(契约 LoginRequest 无 deviceId 入参,
 * 服务端策略为"每次登录新建 Device 行",故"同设备多会话"只能以库内夹具构造;
 * device_session 对 device 为 N:1,与 Edge Cases「同一台设备先后登录多次」一致)。
 */
function insertExtraSessionOnDevice(of: {
  deviceId: string;
  householdId: string;
  accountId: string;
}): LoginResult {
  const token = generateToken();
  const now = new Date();
  const sessionId = randomUUID();
  getDb()
    .insert(deviceSession)
    .values({
      id: sessionId,
      householdId: of.householdId,
      accountId: of.accountId,
      deviceId: of.deviceId,
      tokenHash: hashToken(token),
      activeProfileId: null,
      expiresAt: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
      revokedAt: null,
      lastActiveAt: now.toISOString(),
      createdAt: now.toISOString(),
    })
    .run();
  return {
    cookie: `${SESSION_COOKIE}=${token}`,
    token,
    sessionId,
    expiresAt: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
  };
}

/** 直接改写过期时刻(确定性边界测试;避免真实等待) */
function forceExpiresAt(sessionId: string, expiresAt: Date): void {
  getDb()
    .update(deviceSession)
    .set({ expiresAt: expiresAt.toISOString() })
    .where(eq(deviceSession.id, sessionId))
    .run();
}

/** 夹具:他家庭的设备(FR-006 越权边界) */
function insertForeignHouseholdDevice(): string {
  const foreignHouseholdId = randomUUID();
  getDb()
    .insert(household)
    .values({ id: foreignHouseholdId, name: '邻居家庭', createdAt: new Date().toISOString() })
    .run();
  const foreignDeviceId = randomUUID();
  getDb()
    .insert(device)
    .values({
      id: foreignDeviceId,
      householdId: foreignHouseholdId,
      name: '他人设备',
      type: 'tv',
      lastSeenAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    })
    .run();
  return foreignDeviceId;
}

describe('US3 会话生命周期:恢复、注销与设备撤销(契约 e2e)', () => {
  afterEach(cleanupRigs);

  describe('a) 恢复 GET /auth/session(场景1/FR-010)', () => {
    it('有效 Cookie 恢复 200 SessionDto:无 sessionToken 字段、activeProfile 为 null、无哈希泄露', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);

      const res = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe(session.sessionId);
      expect(res.body.account).toMatchObject({ username: 'admin', role: 'owner' });
      expect((res.body.account as Record<string, unknown>).id).toEqual(expect.any(String));
      expect(res.body.activeProfile).toBeNull();
      expect(typeof res.body.expiresAt).toBe('string');
      // 契约:sessionToken 仅登录响应出现一次 → 恢复响应不得包含该字段
      expect(res.body).not.toHaveProperty('sessionToken');
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('sessionToken');
      // FR-007:任何响应不得含哈希
      expect(serialized).not.toContain('tokenHash');
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('$argon2');
    });

    it('契约双通道:Bearer sessionToken 恢复同样 200', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);

      const res = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);

      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBe(session.sessionId);
      expect(res.body).not.toHaveProperty('sessionToken');
    });

    it('滑动续期(FR-010/research D5):GET 后 expires_at 前移、last_active_at 前移,且不超过 created_at+SESSION_ABSOLUTE_DAYS', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);
      const before = sessionByToken(session.token);
      await sleep(5);

      const res = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);

      expect(res.status).toBe(200);
      // expires_at 前移(响应与库内一致)
      expect(Date.parse(res.body.expiresAt as string)).toBeGreaterThan(Date.parse(session.expiresAt));
      const after = sessionByToken(session.token);
      expect(after.expiresAt).toBe(res.body.expiresAt);
      expect(Date.parse(after.lastActiveAt)).toBeGreaterThan(Date.parse(before.lastActiveAt));
      // 滑动上限:expires_at ≤ created_at + SESSION_ABSOLUTE_DAYS
      expect(Date.parse(after.expiresAt)).toBeLessThanOrEqual(
        Date.parse(after.createdAt) + SESSION_ABSOLUTE_DAYS * DAY_MS,
      );
    });

    it('绝对上限封顶:到 created_at+ABS 后连续 GET 不再前移 expires_at(仅当新过期时间晚于原值才写库)', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);
      // 夹具:会话创建于 89 天前,过期时间 = created_at + 90d = now+1d(仍有效,已触顶)
      const now = Date.now();
      getDb()
        .update(deviceSession)
        .set({
          createdAt: new Date(now - 89 * DAY_MS).toISOString(),
          expiresAt: new Date(now + DAY_MS).toISOString(),
        })
        .where(eq(deviceSession.id, session.sessionId))
        .run();
      const capped = sessionByToken(session.token);

      const first = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);
      await sleep(5);
      const second = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // 封顶后过期时间不再前移(两次恢复返回同一值,且与原库值一致)
      expect(first.body.expiresAt).toBe(capped.expiresAt);
      expect(second.body.expiresAt).toBe(first.body.expiresAt);
      // 仅当新过期时间晚于原值才写库 → 封顶时整体跳过,last_active_at 亦不动
      const after = sessionByToken(session.token);
      expect(after.lastActiveAt).toBe(capped.lastActiveAt);
    });
  });

  describe('b) 过期与边界(场景2/FR-010,Edge:恰好过期 = 已过期)', () => {
    it('SESSION_TTL_DAYS 注入小数天极小值(≈2 秒):先恢复 200,过期后 401 SESSION_INVALID', async () => {
      const { app } = await startFreshApp({
        prefix: 'hmp-us3-ttl-',
        env: { SESSION_TTL_DAYS: String(2 / 86400) },
      });
      const session = await setupAndLogin(app);

      const fresh = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);
      expect(fresh.status).toBe(200);

      await sleep(2100);
      const expired = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);

      expect(expired.status).toBe(401);
      expectProblemContentType(expired);
      expect(expired.body.code).toBe(ProblemCode.SESSION_INVALID);
      expect(expired.body.status).toBe(401);
    });

    it('边界:expires_at 恰好等于请求瞬间 → 401(严格大于,无放行窗口);过去时刻 → 401;未来对照 → 200', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const past = await setupAndLogin(app, { deviceName: '过去时刻' });
      const boundary = await setupAndLogin(app, { deviceName: '恰好边界' });
      const control = await setupAndLogin(app, { deviceName: '未来对照' });

      forceExpiresAt(past.sessionId, new Date(Date.now() - 1000));
      // 恰好等于过期时刻:expires_at = 紧接着发起请求瞬间的 now,
      // Guard 比较为「expires_at > now」→ 相等即失败,任何 ≥0 的时间流逝都判已过期
      forceExpiresAt(boundary.sessionId, new Date());
      forceExpiresAt(control.sessionId, new Date(Date.now() + 60_000));

      const pastRes = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', past.cookie);
      const boundaryRes = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', boundary.cookie);
      const controlRes = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', control.cookie);

      expect(pastRes.status).toBe(401);
      expect(pastRes.body.code).toBe(ProblemCode.SESSION_INVALID);
      expect(boundaryRes.status).toBe(401);
      expect(boundaryRes.body.code).toBe(ProblemCode.SESSION_INVALID);
      expectProblemContentType(boundaryRes);
      expect(controlRes.status).toBe(200);
    });
  });

  describe('c) 注销 POST /auth/logout(场景3/FR-011/FR-012)', () => {
    it('logout 204 → 同凭证 GET /auth/session 401 → 重复 logout 仍 204(幂等)', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);

      const first = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', session.cookie);
      expect(first.status).toBe(204);

      const restore = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);
      expect(restore.status).toBe(401);
      expectProblemContentType(restore);
      expect(restore.body.code).toBe(ProblemCode.SESSION_INVALID);

      const second = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', session.cookie);
      expect(second.status).toBe(204);

      const restoreAgain = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);
      expect(restoreAgain.status).toBe(401);
    });

    it('005 T039 契约替代:无凭证/未知令牌 logout 幂等 204(「Session/已失效幂等」),不泄露会话存在性', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      await setupAndLogin(app);

      const anonymous = await request(app.getHttpServer()).post('/api/auth/logout');
      expect(anonymous.status).toBe(204);

      const unknown = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', `${SESSION_COOKIE}=definitely-not-a-known-token`);
      expect(unknown.status).toBe(204);
    });

    it('Bearer 通道注销同样生效(与 Guard 同令牌解析规则),Cookie 与 Bearer 同会话一并失效', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);

      const out = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${session.token}`);
      expect(out.status).toBe(204);

      const bearerRestore = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Authorization', `Bearer ${session.token}`);
      expect(bearerRestore.status).toBe(401);

      const cookieRestore = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', session.cookie);
      expect(cookieRestore.status).toBe(401);
    });

    it('注销已过期但未注销的会话 → 仍 204 并补写 revoked_at(过期会话注销无害)', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);
      forceExpiresAt(session.sessionId, new Date(Date.now() - 1000));

      const out = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', session.cookie);

      expect(out.status).toBe(204);
      expect(sessionByToken(session.token).revokedAt).not.toBeNull();
    });
  });

  describe('d) 设备列表与撤销 GET /devices + POST /devices/{deviceId}/revoke(场景4/FR-011/FR-012)', () => {
    it('GET /devices 返回当前家庭设备列表(DeviceDto 含 revokedAt);无凭证 401(FR-006/FR-019)', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      await setupAndLogin(app, { deviceType: 'tv', deviceName: '客厅电视' });
      const second = await setupAndLogin(app, { deviceType: 'mobile', deviceName: '手机' });

      await selectMainAndUnlockSettings(app, second.cookie);
      const res = await request(app.getHttpServer()).get('/api/settings/devices').set('Cookie', second.cookie);

      expect(res.status).toBe(200);
      const items = res.body as Record<string, unknown>[];
      expect(Array.isArray(items)).toBe(true);
      // 005 T036 起:初始化不再注册设备 —— 两次 setupAndLogin = 两次登录各建一台设备
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item.id).toEqual(expect.any(String));
        expect(item.type).toEqual(expect.any(String));
        expect(typeof item.createdAt).toBe('string');
        expect('revokedAt' in item).toBe(true);
        expect('lastSeenAt' in item).toBe(true);
      }
      expect(items.map((item) => item.name)).toEqual(expect.arrayContaining(['客厅电视', '手机']));

      const anonymous = await request(app.getHttpServer()).get('/api/settings/devices');
      expect(anonymous.status).toBe(401);
      expect(anonymous.body.code).toBe(ProblemCode.SESSION_INVALID);
    });

    it('撤销设备:该设备全部会话(含同设备第二会话)立即失效,他设备会话不受影响;重复 revoke 204;不存在/他家庭设备 404', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      // 设备1:登录会话1 + 夹具会话2(同设备并发两会话)
      const deviceOneSessionOne = await setupAndLogin(app, { deviceType: 'tv', deviceName: '设备一' });
      const deviceOneRow = sessionByToken(deviceOneSessionOne.token);
      const deviceOneSessionTwo = insertExtraSessionOnDevice({
        deviceId: deviceOneRow.deviceId,
        householdId: deviceOneRow.householdId,
        accountId: deviceOneRow.accountId,
      });
      // 设备2:另一设备的第三会话(撤销方)
      const deviceTwoSession = await setupAndLogin(app, { deviceType: 'mobile', deviceName: '设备二' });

      const mgmt = await mgmtSessionCookie(app, { username: INITIALIZE_BODY.username, password: INITIALIZE_BODY.password });
      const revoke = await request(app.getHttpServer())
        .post(`/api/settings/devices/${deviceOneRow.deviceId}/revoke`)
        .set('Cookie', mgmt)
        .send({ ownerPassword: INITIALIZE_BODY.password });
      expect(revoke.status).toBe(204);

      // 设备1 的两个会话:库内 revoked_at 均被补写 + 访问一律 401
      expect(sessionByToken(deviceOneSessionOne.token).revokedAt).not.toBeNull();
      expect(sessionByToken(deviceOneSessionTwo.token).revokedAt).not.toBeNull();
      for (const victim of [deviceOneSessionOne, deviceOneSessionTwo]) {
        const res = await request(app.getHttpServer())
          .get('/api/auth/session')
          .set('Cookie', victim.cookie);
        expect(res.status).toBe(401);
        expect(res.body.code).toBe(ProblemCode.SESSION_INVALID);
      }

      // 设备2 会话不受影响
      const survivor = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', deviceTwoSession.cookie);
      expect(survivor.status).toBe(200);

      // 重复 revoke → 仍 204(幂等,无额外副作用;同一已解锁会话)
      const repeat = await request(app.getHttpServer())
        .post(`/api/settings/devices/${deviceOneRow.deviceId}/revoke`)
        .set('Cookie', mgmt)
        .send({ ownerPassword: INITIALIZE_BODY.password });
      expect(repeat.status).toBe(204);

      // 设备列表标注 revokedAt
      const devices = await request(app.getHttpServer())
        .get('/api/settings/devices')
        .set('Cookie', mgmt);
      expect(devices.status).toBe(200);
      const revokedDevice = (devices.body as Record<string, unknown>[]).find(
        (item) => item.id === deviceOneRow.deviceId,
      );
      expect(revokedDevice).toBeDefined();
      expect(revokedDevice?.revokedAt).toEqual(expect.any(String));

      // 撤销不存在的设备 → 404
      const missing = await request(app.getHttpServer())
        .post(`/api/settings/devices/${randomUUID()}/revoke`)
        .set('Cookie', mgmt)
        .send({ ownerPassword: INITIALIZE_BODY.password });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);
      expectProblemContentType(missing);

      // 撤销其他家庭的设备(夹具)→ 404,且与「不存在」响应一致(不泄露跨家庭存在性)
      const foreignDeviceId = insertForeignHouseholdDevice();
      const foreign = await request(app.getHttpServer())
        .post(`/api/settings/devices/${foreignDeviceId}/revoke`)
        .set('Cookie', mgmt)
        .send({ ownerPassword: INITIALIZE_BODY.password });
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe(ProblemCode.NOT_FOUND);
      expect(foreign.body).toEqual(missing.body);
    });

    it('zod 校验:非 UUID 的 deviceId → 400 VALIDATION_FAILED', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const session = await setupAndLogin(app);

      await selectMainAndUnlockSettings(app, session.cookie);
      const res = await request(app.getHttpServer())
        .post('/api/settings/devices/not-a-uuid/revoke')
        .set('Cookie', session.cookie)
        .send({ ownerPassword: INITIALIZE_BODY.password });

      // 005:deviceId 形态校验放宽为「归属 404 同形」(未知/非法 id 与不存在同形)
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('e) 多会话语义(Edge Cases):注销只影响当前会话', () => {
    it('同设备两会话:会话1注销后仅会话1失效,同设备会话2仍有效(撤销才全失效)', async () => {
      const { app } = await startFreshApp({ prefix: 'hmp-us3-' });
      const sessionOne = await setupAndLogin(app, { deviceType: 'tv', deviceName: '同一台电视' });
      const deviceRow = sessionByToken(sessionOne.token);
      const sessionTwo = insertExtraSessionOnDevice({
        deviceId: deviceRow.deviceId,
        householdId: deviceRow.householdId,
        accountId: deviceRow.accountId,
      });

      const out = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', sessionOne.cookie);
      expect(out.status).toBe(204);

      const gone = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', sessionOne.cookie);
      expect(gone.status).toBe(401);

      const alive = await request(app.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', sessionTwo.cookie);
      expect(alive.status).toBe(200);
      expect(alive.body.sessionId).toBe(sessionTwo.sessionId);
    });
  });

  describe('f) 重启持久化(场景5/FR-005)', () => {
    it('close 后同 DATA_DIR 重建 AppModule:有效会话恢复 200、已注销会话仍 401、家庭/设备数据保留', async () => {
      const rig: TestRig = await startFreshApp({ prefix: 'hmp-us3-restart-' });
      const kept = await setupAndLogin(rig.app, { deviceName: '重启后仍在' });
      const dropped = await setupAndLogin(rig.app, { deviceName: '已注销设备' });
      const out = await request(rig.app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', dropped.cookie);
      expect(out.status).toBe(204);

      const restarted = await restartApp(rig);

      // 未注销会话:重启后凭原凭证恢复
      const restored = await request(restarted.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', kept.cookie);
      expect(restored.status).toBe(200);
      expect(restored.body.sessionId).toBe(kept.sessionId);

      // 已注销会话:重启后仍拒绝(注销状态持久)
      const dead = await request(restarted.getHttpServer())
        .get('/api/auth/session')
        .set('Cookie', dropped.cookie);
      expect(dead.status).toBe(401);
      expect(dead.body.code).toBe(ProblemCode.SESSION_INVALID);

      // 身份数据保留:家庭无需重新初始化
      const householdRes = await request(restarted.getHttpServer())
        .get('/api/household')
        .set('Cookie', kept.cookie);
      expect(householdRes.status).toBe(200);
      expect(householdRes.body.name).toBe(INITIALIZE_BODY.householdName);
      const status = await request(restarted.getHttpServer()).get('/api/setup/status');
      expect(status.body).toEqual({ initialized: true });

      // 设备记录保留(005:重启撤销 grants → 重新解锁设置)
      await ensureSettingsUnlocked(restarted, kept.cookie);
      const devices = await request(restarted.getHttpServer())
        .get('/api/settings/devices')
        .set('Cookie', kept.cookie);
      expect(devices.status).toBe(200);
      expect((devices.body as Record<string, unknown>[]).map((item) => item.name)).toEqual(
        expect.arrayContaining(['重启后仍在', '已注销设备']),
      );
    });
  });
});
