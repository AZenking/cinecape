import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  initialize,
  login,
  restartApp,
  startFreshApp,
  type TestRig,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';

/**
 * T124(005 US8)服务端重启半部:e2e 浏览器侧无法重启 Playwright webServer 托管的
 * Nest 进程,故「服务重启后持久 + 重启不复活 grant」以同库重启的 integration 测试替代
 * (restartApp:同一 DATA_DIR/DB_FILENAME 关闭后重建 AppModule,等价真实重启;不重放迁移)。
 * 权威:data-model.md §3「启动时撤销所有 grants」、tasks.md T124、contracts/api.md §6/§7。
 *
 * 覆盖:
 * - 重启后全部 settings grant 撤销:GET /settings/access → unlocked=false;
 *   设置主体(grant 守卫路由)403 SETTINGS_ACCESS_REQUIRED,须重新 PIN 验证;
 * - 会话本身持久(设备会话不撤销):/api/auth/session 200;
 * - 重启前经设置 API 的代表性写(家庭名称/时区、档案+PIN、IPTV 来源)全部持久;
 * - 重新解锁后读回一致(PIN 验证链在重启后仍工作,数据非空架)。
 */

interface HouseholdSettings {
  name: string;
  language: string;
  timezone: string;
  version: number;
}

interface ProfileSummary {
  id: string;
  name: string;
  pinProtected: boolean;
}

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
}

async function setupUnlockedWorld(): Promise<{ rig: TestRig; app: INestApplication; cookie: string }> {
  const rig = await startFreshApp({ prefix: 'hmp-t124-restart-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const app = rig.app;
  // 零档案 → selectMainAndUnlockSettings 先 bootstrap 主档案(PIN=135790)再选档解锁
  await selectMainAndUnlockSettings(app, cookie, { mainPin: '135790' });
  return { rig, app, cookie };
}

describe('T124 · 设置数据服务重启后持久且 grant 不复活(integration,替代 e2e 进程内重启)', () => {
  afterEach(cleanupRigs);

  it('重启:全部设置授予撤销(unlocked=false,主体 403 需重新 PIN);家庭/档案/来源写持久', async () => {
    const { rig, cookie } = await setupUnlockedWorld();

    // ── 重启前:经设置 API 完成三项代表性写 ──
    const householdBefore = await request(rig.app.getHttpServer()).get('/api/settings/household').set('Cookie', cookie);
    expect(householdBefore.status).toBe(200);
    const current = householdBefore.body as HouseholdSettings;
    const patched = await request(rig.app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({
        expectedVersion: current.version,
        ownerPassword: INITIALIZE_BODY.password,
        name: '重启之家',
        timezone: 'Asia/Tokyo',
      });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    const created = await request(rig.app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', cookie)
      .send({ name: '重启档案', type: 'child', pin: '345678', ownerPassword: INITIALIZE_BODY.password });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const source = await request(rig.app.getHttpServer())
      .post('/api/settings/sources')
      .set('Cookie', cookie)
      .send({
        ownerPassword: INITIALIZE_BODY.password,
        kind: 'iptv',
        name: '重启来源',
        enabled: true,
        privateAccessApproved: true,
        // 上游不可达不影响创建(导入属显式后续动作)
        remoteUrl: 'http://iptv.scale-fixture.test/list.m3u8',
      });
    expect(source.status, JSON.stringify(source.body)).toBe(201);

    // 重启前解锁态基线
    const accessBefore = await request(rig.app.getHttpServer()).get('/api/settings/access').set('Cookie', cookie);
    expect(accessBefore.status).toBe(200);
    expect((accessBefore.body as { unlocked: boolean }).unlocked).toBe(true);

    // ── 重启(同一 DATA_DIR/DB;不重放迁移)──
    const restarted = await restartApp(rig);

    // 会话持久:设备会话行不随重启撤销
    const session = await request(restarted.getHttpServer()).get('/api/auth/session').set('Cookie', cookie);
    expect(session.status).toBe(200);

    // data-model §3「启动时撤销所有 grants」:解锁态不复活
    const access = await request(restarted.getHttpServer()).get('/api/settings/access').set('Cookie', cookie);
    expect(access.status).toBe(200);
    expect(access.body).toEqual({ unlocked: false, expiresAt: null });

    // 设置主体(grant 守卫路由)一律 403 SETTINGS_ACCESS_REQUIRED
    const householdDenied = await request(restarted.getHttpServer()).get('/api/settings/household').set('Cookie', cookie);
    expect(householdDenied.status).toBe(403);
    expect((householdDenied.body as { code: string }).code).toBe('SETTINGS_ACCESS_REQUIRED');

    // 重新 PIN 验证解锁(重启后验证链工作)
    const reUnlock = await request(restarted.getHttpServer())
      .post('/api/settings/access')
      .set('Cookie', cookie)
      .send({ pin: '135790' });
    expect(reUnlock.status, JSON.stringify(reUnlock.body)).toBe(200);
    expect((reUnlock.body as { unlocked: boolean }).unlocked).toBe(true);

    // ── 重新解锁后读回:三项写全部持久 ──
    const householdAfter = await request(restarted.getHttpServer()).get('/api/settings/household').set('Cookie', cookie);
    expect(householdAfter.status).toBe(200);
    expect(householdAfter.body.name).toBe('重启之家');
    expect(householdAfter.body.timezone).toBe('Asia/Tokyo');

    const profiles = await request(restarted.getHttpServer()).get('/api/settings/profiles').set('Cookie', cookie);
    expect(profiles.status).toBe(200);
    const createdProfile = (profiles.body as ProfileSummary[]).find((profile) => profile.name === '重启档案');
    expect(createdProfile, '重启前创建的档案应持久').toBeDefined();
    expect(createdProfile!.pinProtected).toBe(true);

    const sources = await request(restarted.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expect(sources.status).toBe(200);
    const createdSource = (sources.body as { items: SourceRow[] }).items.find((row) => row.name === '重启来源');
    expect(createdSource, '重启前创建的来源应持久').toBeDefined();
    expect(createdSource!.kind).toBe('iptv');
    expect(createdSource!.enabled).toBe(true);
  });
});
