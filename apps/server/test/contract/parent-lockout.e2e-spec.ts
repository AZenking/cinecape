import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import { Database } from '@platform/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  restartApp,
  startFreshApp,
} from '../helpers';
import { ensureSettingsUnlocked } from '../helpers-management';

/**
 * T020(US3 契约 e2e):家长验证锁定 —— FR-011/SC-004;013-role-differentiated-settings/
 * ADR-0017 后锁定路径改挂在保留端点 POST /settings/devices/{deviceId}/revoke
 * (不可逆高危操作,单次当次密码)继续覆盖 423 语义;常规端点不再触达计数。
 * 计数按账号共享(跨会话/换浏览器)、重启保留;锁定中正确密码也拒绝;成功清零。
 */

const PASSWORD = INITIALIZE_BODY.password;

/** 撤销目标设备(保留端点;ownerPassword 缺省 = 缺密码负向) */
function revokeDevice(app: INestApplication, cookie: string, deviceId: string, ownerPassword?: string) {
  return request(app.getHttpServer())
    .post(`/api/settings/devices/${deviceId}/revoke`)
    .set('Cookie', cookie)
    .send(ownerPassword !== undefined ? { ownerPassword } : {})
    .then((r) => r);
}

/** 另登一台独立设备作为可撤销目标(撤销成功 = 204 的正向锚点);deviceId 取自库内会话行 */
async function secondDeviceWithId(app: INestApplication): Promise<string> {
  const secondLogin = await login(app, INITIALIZE_BODY.username, PASSWORD, { deviceType: 'mobile', deviceName: '可撤销手机' });
  expect(secondLogin.status).toBe(200);
  const sessionId = (secondLogin.body as { sessionId: string }).sessionId;
  const row = Database.db.prepare('SELECT device_id AS d FROM device_session WHERE id = ?').get(sessionId) as
    | { d: string }
    | undefined;
  expect(row, '登录应产生库内会话行').toBeDefined();
  return row!.d;
}

describe('US3 家长验证锁定(账号范围共享,FR-011;013 后挂保留端点设备撤销)', () => {
  afterEach(cleanupRigs);

  it('连续 5 次错误 → 锁定;锁定中正确密码也 423;换新登录会话仍锁定(计数按账号共享)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lock-' });
    const init = await initialize(rig.app);
    expect(init.status).toBe(201);
    const loggedIn = await login(rig.app, INITIALIZE_BODY.username, PASSWORD);
    const cookie = cookiePairOf(loggedIn);
    await ensureSettingsUnlocked(rig.app, cookie);
    // 预置第二台设备作为撤销目标(锁定期内不会被真撤销)
    const victimDeviceId = await secondDeviceWithId(rig.app);

    for (let i = 0; i < 5; i += 1) {
      const res = await revokeDevice(rig.app, cookie, victimDeviceId, `wrong-password-${i}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    }
    const locked = await revokeDevice(rig.app, cookie, victimDeviceId, PASSWORD);
    expect(locked.status).toBe(423);
    expectProblemContentType(locked);
    expect(locked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);

    // 换一个全新登录会话(模拟另一浏览器):仍锁定 —— 计数绑定账号而非会话
    const secondLogin = await login(rig.app, INITIALIZE_BODY.username, PASSWORD, { deviceType: 'web', deviceName: 'browser-b' });
    expect(secondLogin.status).toBe(200);
    const cookieB = cookiePairOf(secondLogin);
    await ensureSettingsUnlocked(rig.app, cookieB); // 新会话同样需要设置解锁才能发起管理写
    const stillLocked = await revokeDevice(rig.app, cookieB, victimDeviceId, PASSWORD);
    expect(stillLocked.status).toBe(423);
    expect(stillLocked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);

    // 重启应用:锁定保留(状态落库);005 启动撤销 grants → 重新解锁设置
    await restartApp(rig);
    await ensureSettingsUnlocked(rig.app, cookie);
    const afterRestart = await revokeDevice(rig.app, cookie, victimDeviceId, PASSWORD);
    expect(afterRestart.status).toBe(423);
    expect(afterRestart.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);

    // 窗口到期(直写过去时刻)→ 正确密码恢复可用(真撤销 204),计数清零
    Database.db
      .prepare('UPDATE parent_verification_state SET locked_until = ?')
      .run(new Date(Date.now() - 1000).toISOString());
    const recovered = await revokeDevice(rig.app, cookie, victimDeviceId, PASSWORD);
    expect(recovered.status).toBe(204);
    expect(
      Database.db.prepare('SELECT COUNT(*) AS n FROM parent_verification_state').get() as { n: number },
    ).toMatchObject({ n: 0 });
  });

  it('成功验证清零计数:2 次错误后成功撤销 → 状态清空;再错从 1 起算', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lock-' });
    await initialize(rig.app);
    const loggedIn = await login(rig.app, INITIALIZE_BODY.username, PASSWORD);
    const cookie = cookiePairOf(loggedIn);
    await ensureSettingsUnlocked(rig.app, cookie);
    const victimDeviceId = await secondDeviceWithId(rig.app);

    await revokeDevice(rig.app, cookie, victimDeviceId, 'wrong-password-1');
    await revokeDevice(rig.app, cookie, victimDeviceId, 'wrong-password-2');
    const state = Database.db
      .prepare('SELECT failed_attempts FROM parent_verification_state')
      .get() as { failed_attempts: number };
    expect(state.failed_attempts).toBe(2);

    const ok = await revokeDevice(rig.app, cookie, victimDeviceId, PASSWORD);
    expect(ok.status).toBe(204);
    expect(Database.db.prepare('SELECT COUNT(*) AS n FROM parent_verification_state').get()).toMatchObject({ n: 0 });

    await revokeDevice(rig.app, cookie, victimDeviceId, 'wrong-password-3');
    expect(
      (Database.db.prepare('SELECT failed_attempts FROM parent_verification_state').get() as { failed_attempts: number })
        .failed_attempts,
    ).toBe(1);
  });
});
