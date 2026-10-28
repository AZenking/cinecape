import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { hashToken } from '@contexts/identity-access'; // T022b 端口反转测试适配:管线签名增加 SessionVerifierPort(行为等价)
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { verifyAndIssueSettingsAccess } from '../../../src/contexts/settings/application/settings-pin-verification.service';
import { changeAccountPassword } from '../../../src/contexts/settings/application/settings-account.service';
import { revokeDevice, queryDevicePlaybackRecords } from '../../../src/contexts/settings/application/settings-devices.service';
import { createManagedProfile } from '../../../src/contexts/settings/application/settings-profiles.service';
import { randomUUID } from 'node:crypto';

/**
 * T121(005-US8 单元测试,先 FAIL):密码改动事务回滚/级联与设备管理归属校验。
 * 权威:tasks.md T121、data-model.md §1/§2(account「credential_version 密码改动递增,
 * 并在同一事务撤销该账号全部 device_session 和设置授予」)、contracts/api.md §6/§7。
 *
 * 覆盖:
 * - 成功改密:credential_version 递增;同事务撤销全部 device_session(多设备)与全部
 *   设置授予;选档授予清空;Profile 收藏与历史保留;
 * - 事务纪律(「事务 BEGIN IMMEDIATE,密码/PIN 哈希计算及 I/O 在事务外,提交前重新
 *   校验权限快照」):哈希 await 窗口内换档/改 PIN/撤销会话/撤授予时提交被拒,无部分写入;
 * - 设备撤销与设备播放记录查询的归属校验:跨家庭/未知设备 404 同形,不越权。
 *
 * hashPassword 经 vi.mock 门闩挂起,确定性复现「哈希进行中」窗口(与
 * settings-pin-verification.spec 同一手法;门闩为空时透传真实 argon2)。
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
    hashPassword: async (plain: string) => {
      if (hashGate.pending !== null) {
        hashGate.entered = true;
        await hashGate.pending;
      }
      return actual.hashPassword(plain);
    },
  };
});

const MAIN_PIN = '135790';
const OLD_PASSWORD = INITIALIZE_BODY.password;
const NEW_PASSWORD = 'new-password-456';

type FreshRig = Awaited<ReturnType<typeof startFreshApp>>;

interface Rig {
  rig: FreshRig;
  cookie: string;
  context: SessionContext;
  mainProfileId: string;
}

async function selectProfile(app: FreshRig['app'], cookie: string, profileId: string, pin?: string): Promise<void> {
  if (pin !== undefined) {
    const unlock = await request(app.getHttpServer())
      .post(`/api/profiles/${profileId}/unlock`)
      .set('Cookie', cookie)
      .send({ pin });
    expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
  }
  const select = await request(app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', cookie)
    .send({});
  expect(select.status, JSON.stringify(select.body)).toBe(200);
}

async function setupRig(options: { withUnlock?: boolean } = {}): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t121-pwd-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const token = (loggedIn.body as { sessionToken: string }).sessionToken;
  const bootstrapped = await request(rig.app.getHttpServer())
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', cookie)
    .send({ name: '主档案', pin: MAIN_PIN, ownerPassword: OLD_PASSWORD });
  expect(bootstrapped.status).toBe(201);
  const mainProfileId = (bootstrapped.body as { id: string }).id;
  await selectProfile(rig.app, cookie, mainProfileId, MAIN_PIN);
  const context = validateSessionToken(token, { hashToken });
  if (options.withUnlock !== false) {
    const access = await verifyAndIssueSettingsAccess(context, MAIN_PIN);
    expect(access.unlocked).toBe(true);
  }
  return { rig, cookie, context, mainProfileId };
}

/** 第二台设备的独立会话:登录 + 选主档案 + 设置解锁(设置授予与会话一一绑定) */
async function loginSecondDevice(
  app: FreshRig['app'],
  mainProfileId: string,
): Promise<{ cookie: string; token: string; context: SessionContext }> {
  const res = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password, {
    deviceType: 'mobile',
    deviceName: '手机',
  });
  expect(res.status).toBe(200);
  const cookie = cookiePairOf(res);
  const token = (res.body as { sessionToken: string }).sessionToken;
  await selectProfile(app, cookie, mainProfileId, MAIN_PIN);
  const context = validateSessionToken(token, { hashToken });
  const access = await verifyAndIssueSettingsAccess(context, MAIN_PIN);
  expect(access.unlocked).toBe(true);
  return { cookie, token, context };
}

function sqlRows<T>(sql: string, ...params: unknown[]): T[] {
  return Database.db.prepare(sql).all(...params) as T[];
}

/** 在缓存内直接铺个人收藏与历史行(仅验证「密码改动不触碰它们」) */
function seedFavoriteAndHistory(householdId: string, profileId: string): void {
  const now = new Date().toISOString();
  const mediaId = randomUUID();
  Database.db
    .prepare(
      `INSERT INTO media_item (id, household_id, type, title, description, content_level, version, content_revision, created_at, updated_at)
       VALUES (?, ?, 'movie', '存留影片', NULL, 0, 1, 1, ?, ?)`,
    )
    .run(mediaId, householdId, now, now);
  Database.db
    .prepare(
      'INSERT INTO profile_channel_favorite (household_id, profile_id, media_id, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(householdId, profileId, mediaId, now);
  Database.db
    .prepare(
      `INSERT INTO profile_viewing_history
         (household_id, profile_id, media_id, writer_epoch, writer_playback_session_id, last_sample_seq,
          content_revision, position_seconds, duration_seconds, last_viewed_at, revision)
       VALUES (?, ?, ?, 1, ?, 1, 1, 120, 600, ?, 1)`,
    )
    .run(householdId, profileId, mediaId, `tmp-${randomUUID()}`, now);
}

function personalRows(householdId: string, profileId: string): { favorites: number; history: number } {
  const favorites = sqlRows<{ n: number }>(
    'SELECT COUNT(*) AS n FROM profile_channel_favorite WHERE household_id = ? AND profile_id = ?',
    householdId,
    profileId,
  )[0]!.n;
  const history = sqlRows<{ n: number }>(
    'SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ? AND profile_id = ?',
    householdId,
    profileId,
  )[0]!.n;
  return { favorites, history };
}

describe('T121 · 密码改动事务与设备管理(data-model §1/§2)', () => {
  afterEach(cleanupRigs);

  it('成功改密:credential_version 递增;同事务撤销全部 device_session 与设置授予;收藏历史保留', async () => {
    const { rig, context, mainProfileId } = await setupRig();
    const householdId = context.session.householdId;
    const second = await loginSecondDevice(rig.app, mainProfileId); // 第二会话也有设置授予
    seedFavoriteAndHistory(householdId, mainProfileId);
    const before = personalRows(householdId, mainProfileId);
    expect(before.favorites).toBe(1);
    expect(before.history).toBe(1);
    const credentialBefore = sqlRows<{ v: number }>('SELECT credential_version AS v FROM account')[0]!.v;

    await changeAccountPassword(context, { ownerPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });

    const account = sqlRows<{ credential_version: number; password_hash: string }>(
      'SELECT credential_version, password_hash FROM account',
    )[0]!;
    expect(account.credential_version).toBe(credentialBefore + 1);
    // 全部 device_session 撤销(两个设备),全部设置授予撤销
    const sessions = sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM device_session');
    expect(sessions.length).toBe(2);
    expect(sessions.every((row) => row.revoked_at !== null)).toBe(true);
    const grants = sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM settings_access_grant');
    expect(grants.length).toBe(2);
    expect(grants.every((row) => row.revoked_at !== null)).toBe(true);
    // 收藏与历史保留
    expect(personalRows(householdId, mainProfileId)).toEqual(before);
    // 旧会话立即失效(恢复请求 401)
    const restore = await request(rig.app.getHttpServer()).get('/api/auth/session').set('Cookie', second.cookie);
    expect(restore.status).toBe(401);
  });

  it('改密使用既有密码错误计数:错误旧密码 403 且 credential_version/会话不变', async () => {
    const { context } = await setupRig();
    const credentialBefore = sqlRows<{ v: number }>('SELECT credential_version AS v FROM account')[0]!.v;
    await expect(
      changeAccountPassword(context, { ownerPassword: 'wrong-password-1', newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ status: 403 });
    expect(sqlRows<{ v: number }>('SELECT credential_version AS v FROM account')[0]!.v).toBe(credentialBefore);
    expect(sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM device_session')).toEqual([
      { revoked_at: null },
    ]);
    // 错误计数持久化(沿用既有家长验证状态表)
    expect(
      sqlRows<{ failed_attempts: number }>('SELECT failed_attempts FROM parent_verification_state'),
    ).toEqual([{ failed_attempts: 1 }]);
  });

  describe('事务纪律:哈希 await 窗口内权限快照变化 → 提交被拒且无部分写入', () => {
    /** 挂起新密码哈希,返回改密 Promise 与放行函数 */
    async function holdPasswordHash(
      context: SessionContext,
    ): Promise<{ promise: Promise<void>; release: () => void }> {
      let release!: () => void;
      hashGate.pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      hashGate.entered = false;
      const promise = changeAccountPassword(context, { ownerPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
      await vi.waitFor(() => expect(hashGate.entered).toBe(true));
      return {
        promise,
        release: () => {
          hashGate.pending = null;
          release();
        },
      };
    }

    it('窗口内撤销设置授予 → 403 SETTINGS_ACCESS_REQUIRED,密码/会话/授予均未被改写', async () => {
      const { context } = await setupRig();
      const pending = await holdPasswordHash(context);
      try {
        // 哈希挂起窗口内:并发撤销授予(模拟同会话授权失效)
        Database.db
          .prepare('UPDATE settings_access_grant SET revoked_at = ? WHERE revoked_at IS NULL')
          .run(new Date().toISOString());
      } finally {
        pending.release(); // 先放行哈希,服务事务内重验权限快照后拒绝
      }
      await expect(pending.promise).rejects.toMatchObject({ status: 403, code: 'SETTINGS_ACCESS_REQUIRED' });
      // 无部分写入
      expect(sqlRows<{ v: number }>('SELECT credential_version AS v FROM account')[0]!.v).toBe(1);
      expect(sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM device_session')).toEqual([
        { revoked_at: null },
      ]);
    });

    it('窗口内换档(实际切到其他档案)→ 提交被拒,无部分写入', async () => {
      const { rig, context, mainProfileId, cookie } = await setupRig();
      const child = await createManagedProfile(context, {
        name: '儿童',
        type: 'child',
        isDefault: false,
        ownerPassword: OLD_PASSWORD,
      });
      const pending = await holdPasswordHash(context);
      try {
        await selectProfile(rig.app, cookie, child.id); // profile_context_version 递增
      } finally {
        pending.release(); // 先放行哈希,服务事务内重验权限快照后拒绝
      }
      await expect(pending.promise).rejects.toMatchObject({ status: 403 });
      expect(sqlRows<{ v: number }>('SELECT credential_version AS v FROM account')[0]!.v).toBe(1);
      expect(sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM device_session')).toEqual([
        { revoked_at: null },
      ]);
      // 主档案行未被触碰
      expect(
        sqlRows<{ version: number }>('SELECT version FROM profile WHERE id = ?', mainProfileId)[0]!.version,
      ).toBe(1);
    });

    it('窗口内改主档案 PIN(pin_version 变化)→ 提交被拒,无部分写入', async () => {
      const { context, mainProfileId } = await setupRig();
      const pending = await holdPasswordHash(context);
      try {
        Database.db
          .prepare('UPDATE profile SET pin_version = pin_version + 1 WHERE id = ?')
          .run(mainProfileId);
      } finally {
        pending.release();
      }
      await expect(pending.promise).rejects.toMatchObject({ status: 403 });
      expect(sqlRows<{ v: number }>('SELECT credential_version AS v FROM account')[0]!.v).toBe(1);
      expect(sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM device_session')).toEqual([
        { revoked_at: null },
      ]);
    });

    it('窗口内撤销当前会话(另一设备已注销等)→ 401 SESSION_INVALID,无部分写入', async () => {
      const { context } = await setupRig();
      const pending = await holdPasswordHash(context);
      try {
        Database.db
          .prepare('UPDATE device_session SET revoked_at = ? WHERE id = ?')
          .run(new Date().toISOString(), context.session.id);
      } finally {
        pending.release();
      }
      await expect(pending.promise).rejects.toMatchObject({ status: 401 });
      expect(sqlRows<{ v: number }>('SELECT credential_version AS v FROM account')[0]!.v).toBe(1);
    });
  });

  describe('设备撤销与播放记录查询归属校验', () => {
    it('撤销本家庭设备:当次密码,204 语义(服务层无返回),目标设备全部会话与授予失效', async () => {
      const { rig, context, mainProfileId } = await setupRig();
      const second = await loginSecondDevice(rig.app, mainProfileId);
      const secondDeviceId = second.context.session.deviceId;
      await revokeDevice(context, secondDeviceId, { ownerPassword: OLD_PASSWORD });
      expect(sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM device WHERE id = ?', secondDeviceId)).toEqual([
        { revoked_at: expect.any(String) },
      ]);
      expect(
        sqlRows<{ revoked_at: string | null }>('SELECT revoked_at FROM device_session WHERE device_id = ?', secondDeviceId),
      ).toEqual([{ revoked_at: expect.any(String) }]);
      // 该设备会话的设置授予同事务撤销
      const grant = sqlRows<{ revoked_at: string | null }>(
        'SELECT g.revoked_at AS revoked_at FROM settings_access_grant g WHERE g.device_session_id = ?',
        second.context.session.id,
      );
      expect(grant).toHaveLength(1);
      expect(grant[0]!.revoked_at).not.toBeNull();
    });

    it('缺失/错误密码拒绝;跨家庭或未知设备 404 同形', async () => {
      const { context } = await setupRig();
      const ownDeviceId = context.session.deviceId;
      await expect(revokeDevice(context, ownDeviceId, { ownerPassword: undefined })).rejects.toMatchObject({
        status: 403,
        code: 'PARENT_VERIFICATION_REQUIRED',
      });
      await expect(revokeDevice(context, ownDeviceId, { ownerPassword: 'totally-wrong' })).rejects.toMatchObject({ status: 403 });
      await expect(revokeDevice(context, randomUUID(), { ownerPassword: OLD_PASSWORD })).rejects.toMatchObject({ status: 404 });
      // 跨家庭设备夹具:插入他家庭设备后 404 同形
      const foreignHousehold = randomUUID();
      Database.db
        .prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)')
        .run(foreignHousehold, '邻居家庭', new Date().toISOString());
      const foreignDevice = randomUUID();
      Database.db
        .prepare('INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)')
        .run(foreignDevice, foreignHousehold, '他人设备', 'tv', new Date().toISOString());
      await expect(revokeDevice(context, foreignDevice, { ownerPassword: OLD_PASSWORD })).rejects.toMatchObject({ status: 404 });
    });

    it('播放记录查询:缺密码 403;跨家庭/未知设备 404;本家庭设备 200 语义(空页)', async () => {
      const { context } = await setupRig();
      const ownDeviceId = context.session.deviceId;
      await expect(queryDevicePlaybackRecords(context, ownDeviceId, {})).rejects.toMatchObject({
        status: 403,
        code: 'PARENT_VERIFICATION_REQUIRED',
      });
      await expect(queryDevicePlaybackRecords(context, randomUUID(), { ownerPassword: OLD_PASSWORD })).rejects.toMatchObject({
        status: 404,
      });
      const page = await queryDevicePlaybackRecords(context, ownDeviceId, { ownerPassword: OLD_PASSWORD });
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    });
  });
});
