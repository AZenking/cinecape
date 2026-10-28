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
 * T020(US3 契约 e2e):家长验证锁定 —— FR-011/SC-004。
 * 计数按账号共享(跨会话/换浏览器)、重启保留;锁定中正确密码也拒绝;成功清零。
 */

const PASSWORD = INITIALIZE_BODY.password;

function patchRename(app: INestApplication, cookie: string, profileId: string, ownerPassword: string | undefined) {
  return request(app.getHttpServer())
    .patch(`/api/settings/profiles/${profileId}`)
    .set('Cookie', cookie)
    .send({
      name: `名字-${Math.random().toString(36).slice(2, 6)}`,
      clearPin: false,
      expectedVersion: 1,
      ...(ownerPassword !== undefined ? { ownerPassword } : {}),
    })
    .then((r) => r);
}

describe('US3 家长验证锁定(账号范围共享,FR-011)', () => {
  afterEach(cleanupRigs);

  it('连续 5 次错误 → 锁定;锁定中正确密码也 423;换新登录会话仍锁定(计数按账号共享)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lock-' });
    const init = await initialize(rig.app);
    expect(init.status).toBe(201);
    const loggedIn = await login(rig.app, INITIALIZE_BODY.username, PASSWORD);
    const cookie = cookiePairOf(loggedIn);
    await ensureSettingsUnlocked(rig.app, cookie);
    const created = await request(rig.app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', cookie)
      .send({ name: '目标', type: 'adult', ownerPassword: PASSWORD });
    const profileId = created.body.id as string;

    for (let i = 0; i < 5; i += 1) {
      const res = await patchRename(rig.app, cookie, profileId, 'wrong-password');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    }
    const locked = await patchRename(rig.app, cookie, profileId, PASSWORD);
    expect(locked.status).toBe(423);
    expectProblemContentType(locked);
    expect(locked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);

    // 换一个全新登录会话(模拟另一浏览器):仍锁定 —— 计数绑定账号而非会话
    const secondLogin = await login(rig.app, INITIALIZE_BODY.username, PASSWORD, { deviceType: 'web', deviceName: 'browser-b' });
    expect(secondLogin.status).toBe(200);
    const cookieB = cookiePairOf(secondLogin);
    await ensureSettingsUnlocked(rig.app, cookieB); // 新会话同样需要设置解锁才能发起管理写
    const stillLocked = await patchRename(rig.app, cookieB, profileId, PASSWORD);
    expect(stillLocked.status).toBe(423);
    expect(stillLocked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);

    // 重启应用:锁定保留(状态落库);005 启动撤销 grants → 重新解锁设置
    await restartApp(rig);
    await ensureSettingsUnlocked(rig.app, cookie);
    const afterRestart = await patchRename(rig.app, cookie, profileId, PASSWORD);
    expect(afterRestart.status).toBe(423);
    expect(afterRestart.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);

    // 窗口到期(直写过去时刻)→ 正确密码恢复可用,计数清零
    Database.db
      .prepare('UPDATE parent_verification_state SET locked_until = ?')
      .run(new Date(Date.now() - 1000).toISOString());
    const recovered = await patchRename(rig.app, cookie, profileId, PASSWORD);
    expect(recovered.status).toBe(200);
    expect(
      Database.db.prepare('SELECT COUNT(*) AS n FROM parent_verification_state').get() as { n: number },
    ).toMatchObject({ n: 0 });
  });

  it('成功验证清零计数:2 次错误后成功 → 状态清空;再错从 1 起算', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lock-' });
    await initialize(rig.app);
    const loggedIn = await login(rig.app, INITIALIZE_BODY.username, PASSWORD);
    const cookie = cookiePairOf(loggedIn);
    await ensureSettingsUnlocked(rig.app, cookie);
    const created = await request(rig.app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', cookie)
      .send({ name: '目标', type: 'adult', ownerPassword: PASSWORD });
    const profileId = created.body.id as string;

    await patchRename(rig.app, cookie, profileId, 'wrong-1');
    await patchRename(rig.app, cookie, profileId, 'wrong-2');
    const state = Database.db
      .prepare('SELECT failed_attempts FROM parent_verification_state')
      .get() as { failed_attempts: number };
    expect(state.failed_attempts).toBe(2);

    const ok = await patchRename(rig.app, cookie, profileId, PASSWORD);
    expect(ok.status).toBe(200);
    expect(Database.db.prepare('SELECT COUNT(*) AS n FROM parent_verification_state').get()).toMatchObject({ n: 0 });

    await patchRename(rig.app, cookie, profileId, 'wrong-3');
    expect(
      (Database.db.prepare('SELECT failed_attempts FROM parent_verification_state').get() as { failed_attempts: number })
        .failed_attempts,
    ).toBe(1);
  });
});
