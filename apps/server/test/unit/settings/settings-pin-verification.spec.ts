import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Database } from '../../../src/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  initialize,
  login,
  startFreshApp,
} from '../../helpers';
import { restartSettingsApp } from '../../helpers-settings';
import { validateSessionToken } from '../../../src/common/session.guard';
import type { SessionContext } from '../../../src/common/current-session.decorator';
import { verifyAndIssueSettingsAccess } from '../../../src/modules/settings/settings-pin-verification.service';

/**
 * T074(005 US7 单元测试,先 FAIL):设置 PIN 验证竞态与持久失败锁定。
 * 权威:docs/specs/005-pc-browsing-flow/data-model.md §3/§2、contracts/api.md §6/§7、ADR-0011 决议 4。
 *
 * - 验证开始捕获 pin_version/profile_context_version/main_profile_version/credential_version,
 *   异步哈希完成后 BEGIN IMMEDIATE 事务内重读比对;任一变化拒绝提交(409),
 *   不签发基于旧身份的授予;
 * - 哈希计算在事务外(哈希挂起期间无任何授予写入);
 * - 持久失败计数 5 次锁 5 分钟,跨刷新/新会话/服务重启保留,与选档共享同一计数;
 * - 成功清零;锁定不被 PIN 变更/计数篡改绕过;错误不泄露 PIN 或哈希。
 *
 * verifyPassword 经 vi.mock 注入可控门闩:竞态用例在「哈希进行中」窗口内并发改写
 * 版本列,确定性复现提交前重验路径;门闩为空时完全透传真实 argon2 行为。
 */
const hashGate = vi.hoisted(() => ({
  pending: null as Promise<void> | null,
  entered: false,
}));

vi.mock('@contexts/identity-access/infrastructure/password.service', async (importOriginal) => {
  const actual = await importOriginal<{
    hashPassword: (plain: string) => Promise<string>;
    verifyPassword: (digest: string, plain: string) => Promise<boolean>;
  }>();
  return {
    ...actual,
    verifyPassword: async (digest: string, plain: string) => {
      if (hashGate.pending !== null) {
        hashGate.entered = true;
        await hashGate.pending;
      }
      return actual.verifyPassword(digest, plain);
    },
  };
});

const MAIN_PIN = '111111';

type FreshRig = Awaited<ReturnType<typeof startFreshApp>>;

interface Rig {
  rig: FreshRig;
  cookie: string;
  mainProfileId: string;
  context: SessionContext;
}

async function setupRig(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t074-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const sessionToken = (loggedIn.body as { sessionToken: string }).sessionToken;
  const cookie = cookiePairOf(loggedIn);
  const bootstrapped = await request(rig.app.getHttpServer())
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', cookie)
    .send({ name: '妈妈', pin: MAIN_PIN, ownerPassword: INITIALIZE_BODY.password });
  expect(bootstrapped.status).toBe(201);
  const mainProfileId = (bootstrapped.body as { id: string }).id;
  await selectMainProfile(rig.app, cookie, mainProfileId);
  return { rig, cookie, mainProfileId, context: validateSessionToken(sessionToken) };
}

async function selectMainProfile(app: FreshRig['app'], cookie: string, mainProfileId: string): Promise<void> {
  const unlock = await request(app.getHttpServer())
    .post(`/api/profiles/${mainProfileId}/unlock`)
    .set('Cookie', cookie)
    .send({ pin: MAIN_PIN });
  expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
  const select = await request(app.getHttpServer())
    .post(`/api/profiles/${mainProfileId}/select`)
    .set('Cookie', cookie)
    .send({});
  expect(select.status).toBe(200);
}

function grantCount(): number {
  return (Database.db.prepare('SELECT COUNT(*) AS n FROM settings_access_grant').get() as { n: number }).n;
}

function pinState(): { failed_pin_count: number; pin_locked_until: string | null } {
  const row = Database.db
    .prepare('SELECT failed_pin_count, pin_locked_until FROM profile WHERE is_main = 1')
    .get() as { failed_pin_count: number; pin_locked_until: string | null };
  return row;
}

/** 门闩挂起哈希,返回 [验证 Promise, 放行函数];调用方在挂起窗口内改写版本列 */
async function holdHash(context: SessionContext, pin: string): Promise<{ promise: Promise<unknown>; release: () => void }> {
  let release!: () => void;
  hashGate.pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  hashGate.entered = false;
  const promise = verifyAndIssueSettingsAccess(context, pin);
  await vi.waitFor(() => expect(hashGate.entered).toBe(true));
  return { promise, release: () => { hashGate.pending = null; release(); } };
}

describe('T074 · 设置 PIN 验证竞态与失败锁定(data-model §3)', () => {
  afterEach(async () => {
    await cleanupRigs();
  });

  it('成功验证:清零持久失败计数并签发绑定当前上下文的授予(200 仅含 expiresAt 元数据)', async () => {
    const rig = await setupRig();
    // 预置一次失败(非锁定),成功后必须清零
    await expect(verifyAndIssueSettingsAccess(rig.context, '999999')).rejects.toMatchObject({ status: 403 });
    expect(pinState().failed_pin_count).toBe(1);

    const before = Date.now();
    const result = await verifyAndIssueSettingsAccess(rig.context, MAIN_PIN);
    expect(result).toEqual({ unlocked: true, expiresAt: expect.any(String) });
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'unlocked']); // 无 bearer/token
    expect(Date.parse(result.expiresAt as string) - before).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    expect(pinState()).toEqual({ failed_pin_count: 0, pin_locked_until: null }); // 成功清零
    expect(grantCount()).toBe(1);
    const row = Database.db
      .prepare(
        `SELECT g.profile_id, g.profile_context_version, g.pin_version, g.main_profile_version
         FROM settings_access_grant g
         JOIN device_session s ON s.id = g.device_session_id AND s.household_id = g.household_id
         JOIN household h ON h.id = g.household_id
         WHERE s.id = ?`,
      )
      .get(rig.context.session.id) as {
      profile_id: string;
      profile_context_version: number;
      pin_version: number;
      main_profile_version: number;
    };
    expect(row.profile_id).toBe(rig.mainProfileId);
    const current = Database.db
      .prepare(
        `SELECT s.profile_context_version AS pcv, p.pin_version AS pv, h.main_profile_version AS mpv
         FROM device_session s
         JOIN household h ON h.id = s.household_id
         JOIN profile p ON p.household_id = s.household_id AND p.id = s.active_profile_id
         WHERE s.id = ?`,
      )
      .get(rig.context.session.id) as { pcv: number; pv: number; mpv: number };
    expect(row.profile_context_version).toBe(current.pcv);
    expect(row.pin_version).toBe(current.pv);
    expect(row.main_profile_version).toBe(current.mpv);
  });

  it.each([
    ['pin_version', 'UPDATE profile SET pin_version = pin_version + 1 WHERE id = (SELECT id FROM profile WHERE is_main = 1)'],
    ['profile_context_version', 'UPDATE device_session SET profile_context_version = profile_context_version + 1'],
    ['main_profile_version', 'UPDATE household SET main_profile_version = main_profile_version + 1'],
    ['credential_version', 'UPDATE account SET credential_version = credential_version + 1'],
  ])('哈希挂起期间 %s 变化 → 提交前重验拒绝(409),不签发基于旧身份的授予', async (_label, mutateSql) => {
    const rig = await setupRig();
    const held = await holdHash(rig.context, MAIN_PIN);
    // 挂起窗口:哈希在事务外 —— 此刻尚无任何授予写入
    expect(grantCount()).toBe(0);
    Database.db.prepare(mutateSql).run();
    held.release();
    await expect(held.promise).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    expect(grantCount()).toBe(0); // 任一变化拒绝提交
    // 门闩放行后重新验证成功(新身份上下文)
    const result = await verifyAndIssueSettingsAccess(rig.context, MAIN_PIN);
    expect(result.unlocked).toBe(true);
    expect(grantCount()).toBe(1);
  });

  it('连续 5 次错误锁定 5 分钟:第 5 次错误仍 403 并落锁定,其后正确 PIN 也 423', async () => {
    const rig = await setupRig();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const remaining = 5 - attempt;
      await expect(verifyAndIssueSettingsAccess(rig.context, '000000')).rejects.toMatchObject({
        status: 403,
        detail: `PIN 验证失败,剩余尝试次数:${remaining}`,
      });
    }
    expect(pinState().pin_locked_until).not.toBeNull(); // 持久化锁定窗口
    // 锁定窗口内即使 PIN 正确也 423 PROFILE_PIN_LOCKED(PIN 变更/重放不可绕过)
    await expect(verifyAndIssueSettingsAccess(rig.context, MAIN_PIN)).rejects.toMatchObject({
      status: 423,
      code: 'PROFILE_PIN_LOCKED',
    });
    expect(grantCount()).toBe(0);
    expect(String(pinState().pin_locked_until)).not.toContain('000000'); // 不泄露输入
  });

  it('失败计数与选档共享:两条入口任一累计达上限,双方一致 423', async () => {
    const rig = await setupRig();
    const unlock = (): request.Test =>
      request(rig.rig.app.getHttpServer())
        .post(`/api/profiles/${rig.mainProfileId}/unlock`)
        .set('Cookie', rig.cookie)
        .send({ pin: '000000' });
    // 选档侧 3 次 + 设置侧 2 次 → 达到共享上限
    for (let i = 0; i < 3; i += 1) {
      expect((await unlock()).status).toBe(403);
    }
    for (let i = 0; i < 2; i += 1) {
      await expect(verifyAndIssueSettingsAccess(rig.context, '000000')).rejects.toMatchObject({ status: 403 });
    }
    expect(pinState().pin_locked_until).not.toBeNull();
    await expect(verifyAndIssueSettingsAccess(rig.context, MAIN_PIN)).rejects.toMatchObject({ status: 423 });
    const selectionLocked = await request(rig.rig.app.getHttpServer())
      .post(`/api/profiles/${rig.mainProfileId}/unlock`)
      .set('Cookie', rig.cookie)
      .send({ pin: MAIN_PIN });
    expect(selectionLocked.status).toBe(423); // 选档入口同样被共享锁定拒绝
  });

  it('锁定跨刷新/新会话/服务重启保留(持久失败计数)', async () => {
    const rig = await setupRig();
    for (let i = 0; i < 5; i += 1) {
      await expect(verifyAndIssueSettingsAccess(rig.context, '000000')).rejects.toMatchObject({ status: 403 });
    }
    expect(pinState().pin_locked_until).not.toBeNull();

    // 服务重启(同一 DATA_DIR):锁定窗口仍在(启动撤销 grants 不影响持久失败计数)
    await restartSettingsApp(rig.rig);
    await expect(verifyAndIssueSettingsAccess(rig.context, MAIN_PIN)).rejects.toMatchObject({ status: 423 });

    // 新设备会话(重新登录):新会话未选档不能直接验证设置;经共享计数的选档入口
    // 同样 423 —— 持久锁定跨会话生效,且不被「换一个会话」绕过
    const relogin = await login(rig.rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(relogin.status).toBe(200);
    const selectionLocked = await request(rig.rig.app.getHttpServer())
      .post(`/api/profiles/${rig.mainProfileId}/unlock`)
      .set('Cookie', cookiePairOf(relogin))
      .send({ pin: MAIN_PIN });
    expect(selectionLocked.status).toBe(423);
    // 新会话未选档:设置验证本身分层拒绝(403 ACTIVE_PROFILE_REQUIRED,不泄露锁定细节)
    const newContext = validateSessionToken((relogin.body as { sessionToken: string }).sessionToken);
    await expect(verifyAndIssueSettingsAccess(newContext, '000000')).rejects.toMatchObject({
      status: 403,
      code: 'ACTIVE_PROFILE_REQUIRED',
    });
  });

  it('错误响应不泄露 PIN 或哈希', async () => {
    const rig = await setupRig();
    let captured: unknown;
    try {
      await verifyAndIssueSettingsAccess(rig.context, '123123');
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeDefined();
    const text = JSON.stringify(captured);
    expect(text).not.toContain('123123');
    const hash = Database.db.prepare('SELECT pin_hash FROM profile WHERE is_main = 1').get() as { pin_hash: string };
    expect(text.toLowerCase()).not.toContain('$argon2');
    expect(text).not.toContain(hash.pin_hash.slice(0, 20));
  });
});
