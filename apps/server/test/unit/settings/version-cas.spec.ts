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
import { hashToken } from '@contexts/identity-access'; // T022b 端口反转测试适配:管线签名增加 SessionVerifierPort(行为等价)
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { verifyAndIssueSettingsAccess } from '../../../src/contexts/settings/application/settings-pin-verification.service';
import {
  getHouseholdSettings,
  patchHouseholdSettings,
} from '../../../src/contexts/settings/application/settings-household.service';
import {
  createManagedProfile,
  patchManagedProfile,
  transferMainProfile,
} from '../../../src/contexts/settings/application/settings-profiles.service';
import { updatePolicy } from '@contexts/policy/application/policy.service';

/**
 * T121(005-US8 单元测试,先 FAIL):设置管理写路径的 expectedVersion CAS。
 * 权威:docs/specs/005-pc-browsing-flow/tasks.md T121、data-model.md §1/§2、contracts/api.md §6/§7。
 *
 * 覆盖:
 * - 通用设置(household)/档案编辑/PIN 重设/策略与名单的 expectedVersion CAS:
 *   旧版本与伪造版本一律 409(VERSION_CONFLICT 家族),不静默覆盖现值;
 * - 主档案转移三项 CAS(expectedVersion=household.main_profile_version /
 *   expectedCurrentProfileVersion=现任主档案 version / expectedProfileVersion=目标
 *   version):任一不符 409 且无部分写入;
 * - 成功路径递增对应版本列,响应只携带契约字段。
 */

const MAIN_PIN = '135790';
const PASSWORD = INITIALIZE_BODY.password;

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

/** 初始化 + 登录 + 首建主档案 + 选档 + 设置解锁:返回可直调服务层的会话上下文 */
async function setupRig(): Promise<Rig> {
  const rig = await startFreshApp({ prefix: 'hmp-t121-cas-' });
  expect((await initialize(rig.app)).status).toBe(201);
  const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const token = (loggedIn.body as { sessionToken: string }).sessionToken;
  const bootstrapped = await request(rig.app.getHttpServer())
    .post('/api/auth/bootstrap-profile')
    .set('Cookie', cookie)
    .send({ name: '主档案', pin: MAIN_PIN, ownerPassword: PASSWORD });
  expect(bootstrapped.status).toBe(201);
  const mainProfileId = (bootstrapped.body as { id: string }).id;
  await selectProfile(rig.app, cookie, mainProfileId, MAIN_PIN);
  const context = validateSessionToken(token, { hashToken });
  const access = await verifyAndIssueSettingsAccess(context, MAIN_PIN);
  expect(access.unlocked).toBe(true);
  return { rig, cookie, context, mainProfileId };
}

function householdVersion(): number {
  return (Database.db.prepare('SELECT version AS v FROM household').get() as { v: number }).v;
}

function profileRow(id: string): { version: number; pin_version: number; name: string; pin_hash: string | null } {
  return Database.db.prepare('SELECT version, pin_version, name, pin_hash FROM profile WHERE id = ?').get(id) as {
    version: number;
    pin_version: number;
    name: string;
    pin_hash: string | null;
  };
}

function policyVersion(profileId: string): number {
  return (
    Database.db.prepare('SELECT version AS v FROM profile_policy WHERE profile_id = ?').get(profileId) as { v: number }
  ).v;
}

describe('T121 · 设置管理 expectedVersion CAS(data-model §1/§2)', () => {
  afterEach(cleanupRigs);

  describe('通用设置(household,CAS on household.version)', () => {
    it('成功路径:合法 expectedVersion 保存并递增 version,返回 HouseholdSettings 投影', async () => {
      const { context } = await setupRig();
      const before = getHouseholdSettings(context.session.householdId);
      expect(before.version).toBe(1);
      const updated = await patchHouseholdSettings(context, {
        expectedVersion: before.version,
        ownerPassword: PASSWORD,
        name: '新家',
        timezone: 'America/New_York',
      });
      expect(updated).toMatchObject({ name: '新家', language: 'zh-CN', timezone: 'America/New_York', version: 2 });
      expect(Object.keys(updated).sort()).toEqual(['language', 'mainProfileVersion', 'name', 'timezone', 'version']);
      expect(householdVersion()).toBe(2);
    });

    it('旧版本与伪造版本一律 409 VERSION_CONFLICT,现值不被静默覆盖', async () => {
      const { context } = await setupRig();
      // 第一次成功保存把 version 推到 2
      await patchHouseholdSettings(context, { expectedVersion: 1, ownerPassword: PASSWORD, name: '第一步' });
      // 旧版本 1 重放 → 409,不改写现值
      await expect(
        patchHouseholdSettings(context, { expectedVersion: 1, ownerPassword: PASSWORD, name: '过期写入' }),
      ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      expect(getHouseholdSettings(context.session.householdId).name).toBe('第一步');
      // 伪造版本(远超现值)同样 409
      await expect(
        patchHouseholdSettings(context, { expectedVersion: 999, ownerPassword: PASSWORD, name: '伪造写入' }),
      ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      expect(getHouseholdSettings(context.session.householdId).name).toBe('第一步');
      expect(householdVersion()).toBe(2);
    });
  });

  describe('档案编辑与 PIN 重设(profile,CAS on profile.version)', () => {
    it('成功编辑递增 version;PIN 重设递增 pin_version 并清失败计数', async () => {
      const { context, mainProfileId } = await setupRig();
      const edited = await patchManagedProfile(context, mainProfileId, {
        expectedVersion: 1,
        ownerPassword: PASSWORD,
        name: '改名主档案',
      });
      expect(edited.version).toBe(2);
      expect(profileRow(mainProfileId).version).toBe(2);
      const repinned = await patchManagedProfile(context, mainProfileId, {
        expectedVersion: 2,
        ownerPassword: PASSWORD,
        pin: '246810',
      });
      expect(repinned.pinProtected).toBe(true);
      expect(profileRow(mainProfileId).pin_version).toBe(2);
      expect(profileRow(mainProfileId).pin_hash).not.toBeNull();
    });

    it('旧版本/伪造版本 409 VERSION_CONFLICT:name 与 PIN 均不被覆盖', async () => {
      const { context, mainProfileId } = await setupRig();
      await expect(
        patchManagedProfile(context, mainProfileId, {
          expectedVersion: 999,
          ownerPassword: PASSWORD,
          name: '伪造',
          pin: '246810',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      const row = profileRow(mainProfileId);
      expect(row.name).toBe('主档案');
      expect(row.pin_version).toBe(1);
      // 旧版本(编辑成功后重放)同样 409
      await patchManagedProfile(context, mainProfileId, { expectedVersion: 1, ownerPassword: PASSWORD, name: 'V2' });
      await expect(
        patchManagedProfile(context, mainProfileId, { expectedVersion: 1, ownerPassword: PASSWORD, name: '重放' }),
      ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      expect(profileRow(mainProfileId).name).toBe('V2');
    });

    it('主档案 clearPin 拒绝(400)、停用主档案须先转移(409 MAIN_PROFILE_CONFLICT)', async () => {
      const { context, mainProfileId } = await setupRig();
      await expect(
        patchManagedProfile(context, mainProfileId, {
          expectedVersion: 1,
          ownerPassword: PASSWORD,
          clearPin: true,
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        patchManagedProfile(context, mainProfileId, {
          expectedVersion: 1,
          ownerPassword: PASSWORD,
          status: 'disabled',
        }),
      ).rejects.toMatchObject({ status: 409, code: 'MAIN_PROFILE_CONFLICT' });
      // 无部分写入
      expect(profileRow(mainProfileId).pin_hash).not.toBeNull();
      expect(profileRow(mainProfileId).version).toBe(1);
    });
  });

  describe('主档案转移(三项 CAS,一次事务)', () => {
    async function rigWithTarget(): Promise<Rig & { targetId: string }> {
      const rig = await setupRig();
      const target = await createManagedProfile(rig.context, {
        name: '新主',
        type: 'adult',
        isDefault: false,
        pin: '369258',
        ownerPassword: PASSWORD,
      });
      expect(target.isMain).toBe(false);
      return { ...rig, targetId: target.id };
    }

    it('成功转移:先去旧标记再设新标记,mainProfileVersion 递增,响应只含新主档案 ID 与版本', async () => {
      const { context, mainProfileId, targetId } = await rigWithTarget();
      const householdBefore = getHouseholdSettings(context.session.householdId);
      const reply = await transferMainProfile(context, {
        profileId: targetId,
        expectedVersion: householdBefore.mainProfileVersion,
        expectedCurrentProfileVersion: profileRow(mainProfileId).version,
        expectedProfileVersion: profileRow(targetId).version,
        ownerPassword: PASSWORD,
      });
      expect(Object.keys(reply).sort()).toEqual(['mainProfileId', 'mainProfileVersion']);
      expect(reply.mainProfileId).toBe(targetId);
      expect(reply.mainProfileVersion).toBe(householdBefore.mainProfileVersion + 1);
      const rows = Database.db
        .prepare('SELECT id, is_main FROM profile WHERE household_id = ? AND is_main = 1')
        .all(context.session.householdId) as Array<{ id: string; is_main: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(targetId);
    });

    it('任一 CAS 不符(旧/伪造家庭版本、现任版本、目标版本)409 且主档案不变、无部分写入', async () => {
      const { context, mainProfileId, targetId } = await rigWithTarget();
      const mainVersion = profileRow(mainProfileId).version;
      const targetVersion = profileRow(targetId).version;
      const mainProfileVersion = getHouseholdSettings(context.session.householdId).mainProfileVersion;
      const base = {
        profileId: targetId,
        expectedVersion: mainProfileVersion,
        expectedCurrentProfileVersion: mainVersion,
        expectedProfileVersion: targetVersion,
        ownerPassword: PASSWORD,
      };
      await expect(transferMainProfile(context, { ...base, expectedVersion: mainProfileVersion - 1 })).rejects.toMatchObject({
        status: 409,
        code: 'VERSION_CONFLICT',
      });
      await expect(transferMainProfile(context, { ...base, expectedVersion: 999 })).rejects.toMatchObject({
        status: 409,
        code: 'VERSION_CONFLICT',
      });
      await expect(
        transferMainProfile(context, { ...base, expectedCurrentProfileVersion: mainVersion + 3 }),
      ).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
      await expect(transferMainProfile(context, { ...base, expectedProfileVersion: targetVersion + 5 })).rejects.toMatchObject({
        status: 409,
        code: 'VERSION_CONFLICT',
      });
      // 无部分写入:主档案未变、两个档案版本不变、main_profile_version 不变
      expect(
        (Database.db.prepare('SELECT id FROM profile WHERE household_id = ? AND is_main = 1').get(context.session.householdId) as { id: string }).id,
      ).toBe(mainProfileId);
      expect(profileRow(mainProfileId).version).toBe(mainVersion);
      expect(profileRow(targetId).version).toBe(targetVersion);
    });

    it('目标不满足 active adult + 已设 PIN → 409 MAIN_PROFILE_CONFLICT;跨家庭目标 404', async () => {
      const { context, mainProfileId, targetId } = await rigWithTarget();
      const base = {
        expectedVersion: getHouseholdSettings(context.session.householdId).mainProfileVersion,
        expectedCurrentProfileVersion: profileRow(mainProfileId).version,
        expectedProfileVersion: profileRow(targetId).version,
        ownerPassword: PASSWORD,
      };
      // 未设 PIN 的成人目标:409
      const noPin = await createManagedProfile(context, {
        name: '无 PIN 成人',
        type: 'adult',
        isDefault: false,
        ownerPassword: PASSWORD,
      });
      await expect(
        transferMainProfile(context, { ...base, profileId: noPin.id, expectedProfileVersion: profileRow(noPin.id).version }),
      ).rejects.toMatchObject({ status: 409, code: 'MAIN_PROFILE_CONFLICT' });
      // 儿童目标:409
      const child = await createManagedProfile(context, {
        name: '儿童',
        type: 'child',
        isDefault: false,
        pin: '123456',
        ownerPassword: PASSWORD,
      });
      await expect(
        transferMainProfile(context, { ...base, profileId: child.id, expectedProfileVersion: profileRow(child.id).version }),
      ).rejects.toMatchObject({ status: 409, code: 'MAIN_PROFILE_CONFLICT' });
      // 未知/跨家庭目标:404 同形(夹具直接插一个他家庭档案 ID)
      await expect(transferMainProfile(context, { ...base, profileId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('策略与名单(继承 002 域核心,expectedVersion CAS)', () => {
    it('旧版本保存策略 409 且现值保留;成功保存递增策略版本', async () => {
      const { context, mainProfileId } = await setupRig();
      const saved = await updatePolicy(mainProfileId, context, {
        ownerPassword: PASSWORD,
        expectedVersion: 1,
        policy: { maxContentLevel: 12, allowUnrated: false },
      });
      expect(saved.version).toBe(2);
      // 旧版本重放 → 409(策略域稳定码;仍为 409 冲突家族),现值不被静默覆盖
      await expect(
        updatePolicy(mainProfileId, context, {
          ownerPassword: PASSWORD,
          expectedVersion: 1,
          policy: { maxContentLevel: 18, allowUnrated: true },
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(policyVersion(mainProfileId)).toBe(2);
      expect(
        Database.db.prepare('SELECT max_content_level AS m FROM profile_policy WHERE profile_id = ?').get(mainProfileId),
      ).toMatchObject({ m: 12 });
      // 伪造版本同样 409
      await expect(
        updatePolicy(mainProfileId, context, {
          ownerPassword: PASSWORD,
          expectedVersion: 99,
          policy: { maxContentLevel: 0, allowUnrated: false },
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(policyVersion(mainProfileId)).toBe(2);
    });
  });
});
