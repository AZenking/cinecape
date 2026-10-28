import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Database } from '@platform/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  initialize,
  login,
  startFreshApp,
} from '../../helpers';
import { validateSessionToken } from '@platform/http-common/session.guard';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import {
  SETTINGS_GRANT_TTL_MS,
  issueSettingsGrant,
  readSettingsAccessStatus,
  requireValidSettingsGrant,
  revokeCurrentSessionGrant,
} from '../../../src/contexts/settings/application/settings-access-grant.service';

/**
 * T073(005 US7 单元测试,先 FAIL):settings_access_grant 签发/校验/撤销状态机。
 * 权威:docs/specs/005-pc-browsing-flow/data-model.md §3 + contracts/api.md §6/§7。
 *
 * - 「每设备会话一行」:联合主键 (household_id, device_session_id),重签发覆盖写;
 * - `expires_at = issued_at + 15 分钟;固定不滑动`:GET/刷新/返回/再次验证均不续期;
 * - `revoked_at` nullable 且「失效后不再恢复」:撤销行任何校验都不通过;
 * - 「授予本身无 bearer,浏览器仅收到 expiresAt 元数据;不进入 localStorage」:
 *   服务层返回值与持久化行都不存在 token 形态字段;
 * - profile_id 必须等于当前主 Profile;创建时捕获 profile_context_version/pin_version/
 *   main_profile_version 三个版本快照,任一失配校验即拒。
 */

interface Rig {
  app: Awaited<ReturnType<typeof startFreshApp>>['app'];
  cookie: string;
  sessionToken: string;
  mainProfileId: string;
  context: SessionContext;
}

async function setupRig(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t073-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const sessionToken = (loggedIn.body as { sessionToken: string }).sessionToken;
  const bootstrapped = await request(rig.app.getHttpServer())
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', cookiePairOf(loggedIn))
    .send({ name: '妈妈', pin: '111111', ownerPassword: INITIALIZE_BODY.password });
  expect(bootstrapped.status).toBe(201);
  const mainProfileId = (bootstrapped.body as { id: string }).id;
  const unlock = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${mainProfileId}/unlock`)
    .set('Cookie', cookiePairOf(loggedIn))
    .send({ pin: '111111' });
  expect(unlock.status).toBe(200);
  const select = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${mainProfileId}/select`)
    .set('Cookie', cookiePairOf(loggedIn))
    .send({});
  expect(select.status).toBe(200);
  return {
    app: rig.app,
    cookie: cookiePairOf(loggedIn),
    sessionToken,
    mainProfileId,
    context: validateSessionToken(sessionToken),
  };
}

interface GrantRow {
  household_id: string;
  device_session_id: string;
  profile_id: string;
  profile_context_version: number;
  pin_version: number;
  main_profile_version: number;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function grantRows(): GrantRow[] {
  return Database.db.prepare('SELECT * FROM settings_access_grant').all() as GrantRow[];
}

function currentSnapshot(rig: Rig): {
  profileId: string;
  profileContextVersion: number;
  pinVersion: number;
  mainProfileVersion: number;
} {
  const row = Database.db
    .prepare(
      `SELECT s.profile_context_version AS pcv, p.id AS pid, p.pin_version AS pv, h.main_profile_version AS mpv
       FROM device_session s
       JOIN profile p ON p.id = s.active_profile_id AND p.household_id = s.household_id
       JOIN household h ON h.id = s.household_id
       WHERE s.id = ?`,
    )
    .get(rig.context.session.id) as { pcv: number; pid: string; pv: number; mpv: number };
  return { profileId: row.pid, profileContextVersion: row.pcv, pinVersion: row.pv, mainProfileVersion: row.mpv };
}

describe('T073 · settings_access_grant 签发/校验/撤销(data-model §3)', () => {
  afterEach(async () => {
    await cleanupRigs();
  });

  it('签发绑定 household+device_session+当前主 Profile 并捕获三个版本快照', async () => {
    const rig = await setupRig();
    const snapshot = currentSnapshot(rig);
    const issued = issueSettingsGrant({
      householdId: rig.context.session.householdId,
      deviceSessionId: rig.context.session.id,
      snapshot,
    });
    expect(issued.reused).toBe(false);
    const rows = grantRows();
    expect(rows).toHaveLength(1); // 每设备会话一行
    const row = rows[0]!;

    expect(row.household_id).toBe(rig.context.session.householdId);
    expect(row.device_session_id).toBe(rig.context.session.id);
    expect(row.profile_id).toBe(rig.mainProfileId); // 必须等于当前主 Profile
    expect(row.profile_context_version).toBe(snapshot.profileContextVersion);
    expect(row.pin_version).toBe(snapshot.pinVersion);
    expect(row.main_profile_version).toBe(snapshot.mainProfileVersion);
    expect(row.revoked_at).toBeNull();
    // expires_at = issued_at + 15 分钟(固定;issued/expires 两次时钟读取允许 ≤2ms 取整差)
    expect(Math.abs(Date.parse(row.expires_at) - Date.parse(row.issued_at) - SETTINGS_GRANT_TTL_MS)).toBeLessThanOrEqual(2);
    expect(Date.parse(issued.expiresAt)).toBe(Date.parse(row.expires_at));
  });

  it('重签发覆盖写仍只一行;已失效(版本变化)后才创建新授予', async () => {
    const rig = await setupRig();
    const base = { householdId: rig.context.session.householdId, deviceSessionId: rig.context.session.id };
    const first = issueSettingsGrant({ ...base, snapshot: currentSnapshot(rig) });
    // 同上下文重验证:返回原 issued_at/expires_at,不覆盖不续期(data-model §3)
    const second = issueSettingsGrant({ ...base, snapshot: currentSnapshot(rig) });
    expect(second.reused).toBe(true);
    expect(second.issuedAt).toBe(first.issuedAt);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(grantRows()).toHaveLength(1);

    // 上下文变化(模拟实际换档后的新上下文):同主键覆盖写为新授予
    Database.db
      .prepare('UPDATE device_session SET profile_context_version = profile_context_version + 1 WHERE id = ?')
      .run(rig.context.session.id);
    const third = issueSettingsGrant({ ...base, snapshot: currentSnapshot(rig) });
    expect(third.reused).toBe(false); // 覆盖写为新授予(非复用)
    expect(Date.parse(third.expiresAt)).toBeGreaterThanOrEqual(Date.parse(first.expiresAt));
    expect(grantRows()).toHaveLength(1);
    expect(grantRows()[0]!.profile_context_version).toBe(currentSnapshot(rig).profileContextVersion);
  });

  it('校验不续期:逐请求重检通过,expires_at 严格保持不变(固定 15 分钟不滑动)', async () => {
    const rig = await setupRig();
    issueSettingsGrant({
      householdId: rig.context.session.householdId,
      deviceSessionId: rig.context.session.id,
      snapshot: currentSnapshot(rig),
    });
    const first = requireValidSettingsGrant(rig.context);
    const rowBefore = grantRows()[0]!;
    // 多次「GET/刷新/返回」式校验
    for (let i = 0; i < 3; i += 1) {
      expect(requireValidSettingsGrant(rig.context).expiresAt).toBe(first.expiresAt);
    }
    // 再次验证(POST 语义)也不得写库续期
    const again = issueSettingsGrant({
      householdId: rig.context.session.householdId,
      deviceSessionId: rig.context.session.id,
      snapshot: currentSnapshot(rig),
    });
    expect(again.expiresAt).toBe(first.expiresAt);
    const rowAfter = grantRows()[0]!;
    expect(rowAfter).toEqual(rowBefore); // 行逐字节未变 —— 无滑动、无续期
    // 最小状态接口同样只回服务器事实,不改到期时间
    expect(readSettingsAccessStatus(rig.context)).toEqual({ unlocked: true, expiresAt: first.expiresAt });
  });

  it('撤销后不再恢复:revoked 行校验一律 403;重新验证成功才创建全新授予(原到期时间不复用)', async () => {
    const rig = await setupRig();
    const base = { householdId: rig.context.session.householdId, deviceSessionId: rig.context.session.id };
    const first = issueSettingsGrant({ ...base, snapshot: currentSnapshot(rig) });
    revokeCurrentSessionGrant(rig.context);
    expect(grantRows()[0]!.revoked_at).not.toBeNull();
    // 撤销行即使未过期也拒绝;最小状态 unlocked=false
    expect(readSettingsAccessStatus(rig.context)).toEqual({ unlocked: false, expiresAt: null });
    expect(() => requireValidSettingsGrant(rig.context)).toThrow();
    // 重新验证成功(此处以签发入口代表 POST 成功路径)→ 新授予,原 revoked 行被覆盖为全新行
    const reissued = issueSettingsGrant({ ...base, snapshot: currentSnapshot(rig) });
    expect(reissued.reused).toBe(false);
    expect(Date.parse(reissued.issuedAt)).toBeGreaterThanOrEqual(Date.parse(first.issuedAt));
    const row = grantRows()[0]!;
    expect(row.revoked_at).toBeNull();
    expect(requireValidSettingsGrant(rig.context).expiresAt).toBe(reissued.expiresAt);
    // 再次撤销幂等:写 revoked_at,不复活
    revokeCurrentSessionGrant(rig.context);
    revokeCurrentSessionGrant(rig.context);
    expect(grantRows()[0]!.revoked_at).not.toBeNull();
  });

  it('逐请求重检:版本快照失配/主档案变化/当前档案变化/目标停用/过期 各自拒绝', async () => {
    const rig = await setupRig();
    const base = { householdId: rig.context.session.householdId, deviceSessionId: rig.context.session.id };

    function expectAccessRequired(): void {
      try {
        requireValidSettingsGrant(rig.context);
        expect.unreachable('应拒绝');
      } catch (error) {
        expect((error as { status: number }).status).toBe(403);
      }
    }

    // pin_version 变化(PIN 更新)
    issueSettingsGrant({ ...base, snapshot: currentSnapshot(rig) });
    Database.db.prepare('UPDATE profile SET pin_version = pin_version + 1 WHERE id = ?').run(rig.mainProfileId);
    expectAccessRequired();
    expect(readSettingsAccessStatus(rig.context)).toEqual({ unlocked: false, expiresAt: null });

    // main_profile_version 变化(主档案转移)
    Database.db
      .prepare('UPDATE household SET main_profile_version = main_profile_version + 1 WHERE id = ?')
      .run(rig.context.session.householdId);
    expectAccessRequired();

    // 当前档案变化(换档:active_profile_id 不再是主档案)
    Database.db
      .prepare("UPDATE device_session SET active_profile_id = NULL WHERE id = ?")
      .run(rig.context.session.id);
    expectAccessRequired();

    // 恢复身份后目标主档案停用(先移主标记:CHECK 禁止停用 is_main=1 档案 ——
    // US8 停用主档案须先转移,其事务语义即「先移主再停用 + 撤销授予」)
    Database.db
      .prepare('UPDATE device_session SET active_profile_id = ? WHERE id = ?')
      .run(rig.mainProfileId, rig.context.session.id);
    Database.db.prepare('UPDATE profile SET is_main = 0 WHERE id = ?').run(rig.mainProfileId);
    Database.db.prepare("UPDATE profile SET status = 'disabled' WHERE id = ?").run(rig.mainProfileId);
    expectAccessRequired();

    // 主档案行丢失(is_main 清除;停用后恢复 active 仍无主档案)
    Database.db.prepare("UPDATE profile SET status = 'active' WHERE id = ?").run(rig.mainProfileId);
    expectAccessRequired();

    // 无授予行:403(不是 401 —— Session 仍有效)
    Database.db.prepare('DELETE FROM settings_access_grant').run();
    expectAccessRequired();

    // 过期:回拨 expires_at/issued_at 同幅,满足 CHECK 且 expires_at <= serverNow
    issueSettingsGrant({ ...base, snapshot: currentSnapshot(rig) });
    Database.db.prepare("UPDATE profile SET is_main = 1 WHERE id = ?").run(rig.mainProfileId);
    Database.db
      .prepare(
        "UPDATE settings_access_grant SET issued_at = ?, expires_at = ? WHERE device_session_id = ?",
      )
      .run(
        new Date(Date.now() - 16 * 60_000).toISOString(),
        new Date(Date.now() - 60_000).toISOString(),
        rig.context.session.id,
      );
    try {
      requireValidSettingsGrant(rig.context);
      expect.unreachable('过期应拒绝');
    } catch (error) {
      expect((error as { status: number }).status).toBe(403);
      expect((error as { code: string }).code).toBe('SETTINGS_ACCESS_EXPIRED');
    }
  });

  it('授予无 bearer:服务层返回值与持久化行均无 token 形态字段(仅 expiresAt 元数据)', async () => {
    const rig = await setupRig();
    const issued = issueSettingsGrant({
      householdId: rig.context.session.householdId,
      deviceSessionId: rig.context.session.id,
      snapshot: currentSnapshot(rig),
    });
    expect(Object.keys(issued).sort()).toEqual(['expiresAt', 'issuedAt', 'profileId', 'reused']);
    const valid = requireValidSettingsGrant(rig.context);
    expect(Object.keys(valid).sort()).toEqual(['expiresAt']);
    const columns = (Database.db.prepare('PRAGMA table_info(settings_access_grant)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    for (const column of columns) {
      expect(column.toLowerCase()).not.toContain('token');
      expect(column.toLowerCase()).not.toContain('bearer');
    }
  });
});
