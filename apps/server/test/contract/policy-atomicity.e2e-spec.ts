import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import { Database } from '../../src/database/database';
import { writePolicyLists } from '../../src/modules/policy/policy.service';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  initialize,
  login,
  restartApp,
  startFreshApp,
} from '../helpers';
import { ensureSettingsUnlocked } from '../helpers-management';

/**
 * T010(US1 契约 e2e):创建原子性 / 重启持久化 / 停用保留 / 名单读写夹具(FR-003/008/013 + ADR-0006)。
 * 名单写入走应用层校验路径 writePolicyLists(阶段 2 无 HTTP 名单编辑;阶段 3 接资源归属后开放)。
 */

interface SessionFixture {
  app: INestApplication;
  cookie: string;
}

async function bootstrap(): Promise<SessionFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-us1b-' });
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  await ensureSettingsUnlocked(app, cookiePairOf(loggedIn));
  return { app, cookie: cookiePairOf(loggedIn) };
}

function createProfile(s: SessionFixture, body: Record<string, unknown>): Promise<request.Response> {
  return request(s.app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', s.cookie)
    .send({ ownerPassword: INITIALIZE_BODY.password, ...body })
    .then((r) => r);
}

function counts(): { profiles: number; policies: number } {
  const row = Database.db
    .prepare('SELECT (SELECT COUNT(*) FROM profile) AS profiles, (SELECT COUNT(*) FROM profile_policy) AS policies')
    .get() as { profiles: number; policies: number };
  return row;
}

function listsOf(profileId: string): { allowed: string[]; blocked: string[]; channels: string[]; version: number } {
  const row = Database.db
    .prepare('SELECT allowed_media_ids, blocked_media_ids, allowed_channel_ids, version FROM profile_policy WHERE profile_id = ?')
    .get(profileId) as Record<string, unknown>;
  return {
    allowed: JSON.parse(row.allowed_media_ids as string),
    blocked: JSON.parse(row.blocked_media_ids as string),
    channels: JSON.parse(row.allowed_channel_ids as string),
    version: row.version as number,
  };
}

describe('US1 创建原子性/重启持久化/名单读写(契约 e2e)', () => {
  afterEach(cleanupRigs);

  it('原子创建:每个新档案同事务获得唯一默认策略;非法输入失败时档案与策略皆不落库', async () => {
    const s = await bootstrap();
    const adult = await createProfile(s, { name: '爸爸', type: 'adult' });
    const child = await createProfile(s, { name: '女儿', type: 'child' });
    expect(adult.status).toBe(201);
    expect(child.status).toBe(201);

    const after = counts();
    // 005:夹具主档案先建(1 档案 + 1 策略),新两个档案原子各带策略
    expect(after.profiles).toBe(3);
    expect(after.policies).toBe(3); // 一档案一策略,无孤儿
    expect(listsOf(adult.body.id)).toMatchObject({ allowed: [], blocked: [], channels: [], version: 1 });

    // 非法输入 → 400,两者皆不落库
    const invalid = await createProfile(s, { name: '坏档案', type: 'teenager' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    const unchanged = counts();
    // 005:主档案先建,基线 3(2 新档案 + 主档案)
    expect(unchanged.profiles).toBe(3);
    expect(unchanged.policies).toBe(3);
  });

  it('重启持久化:保存后的策略在进程重启后 100% 保留;默认策略不覆盖已保存值', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-us1b-' });
    const init = await initialize(rig.app);
    expect(init.status).toBe(201);
    const loggedIn = await login(rig.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    const cookie = cookiePairOf(loggedIn);
    await ensureSettingsUnlocked(rig.app, cookie);
    const created = await request(rig.app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', cookie)
      .send({ name: '女儿', type: 'child', ownerPassword: INITIALIZE_BODY.password });
    expect(created.status).toBe(201);

    const saved = await request(rig.app.getHttpServer())
      .put(`/api/settings/profiles/${created.body.id}/policy`)
      .set('Cookie', cookie)
      .send({ ownerPassword: INITIALIZE_BODY.password, expectedVersion: 1, policy: { maxContentLevel: 7, allowUnrated: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);

    await restartApp(rig);
    await ensureSettingsUnlocked(rig.app, cookie);

    const afterRestart = await request(rig.app.getHttpServer())
      .get(`/api/settings/profiles/${created.body.id}/policy`)
      .set('Cookie', cookie);
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body).toMatchObject({ maxContentLevel: 7, allowUnrated: true, version: 2 });
  });

  it('停用档案:策略保留且仍可读取/编辑(FR 边缘:停用可编辑策略,但不能作为观看者)', async () => {
    const s = await bootstrap();
    const adult = await createProfile(s, { name: 'A', type: 'adult' });
    const kid = await createProfile(s, { name: 'K', type: 'child' });

    const kidVersion = (
      Database.db.prepare('SELECT version FROM profile WHERE id = ?').get(kid.body.id as string) as { version: number }
    ).version;
    const disabled = await request(s.app.getHttpServer())
      .patch(`/api/settings/profiles/${kid.body.id}`)
      .set('Cookie', s.cookie)
      .send({ status: 'disabled', clearPin: false, expectedVersion: kidVersion, ownerPassword: INITIALIZE_BODY.password });
    expect(disabled.status).toBe(200);

    const read = await request(s.app.getHttpServer()).get(`/api/settings/profiles/${kid.body.id}/policy`).set('Cookie', s.cookie);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ profileId: kid.body.id, maxContentLevel: 12 });

    const edited = await request(s.app.getHttpServer())
      .put(`/api/settings/profiles/${kid.body.id}/policy`)
      .set('Cookie', s.cookie)
      .send({ ownerPassword: INITIALIZE_BODY.password, expectedVersion: 1, policy: { maxContentLevel: 6, allowUnrated: false } });
    expect(edited.status).toBe(200);
    expect(edited.body.maxContentLevel).toBe(6);
    expect(adult.body.id).toBeTruthy();
  });

  it('名单读写夹具:去重排序持久化;第 1001 项确定拒绝;1～128 非空大小写敏感;允许∩禁止交集保留', async () => {
    const s = await bootstrap();
    const created = await createProfile(s, { name: '夹具档案', type: 'child' });
    expect(created.status).toBe(201);
    const householdId = (Database.db.prepare('SELECT id FROM household').get() as { id: string }).id;
    const profileId = created.body.id as string;

    // 去重 + 排序持久化;交集保留(不跨名单删除)
    const written = writePolicyLists(householdId, profileId, {
      allowedMediaIds: ['m2', 'b', 'm2', 'a'],
      blockedMediaIds: ['m2', 'z9'],
      allowedChannelIds: ['ch1', 'ch1', 'CH1'],
    });
    expect(written).toMatchObject({
      allowedMediaIds: ['a', 'b', 'm2'],
      blockedMediaIds: ['m2', 'z9'],
      allowedChannelIds: ['CH1', 'ch1'], // 大小写敏感去重
      version: 2, // 夹具写入同样递增版本
    });
    expect(listsOf(profileId)).toMatchObject({ allowed: ['a', 'b', 'm2'], blocked: ['m2', 'z9'], channels: ['CH1', 'ch1'] });

    // 非法元素:空串 / 129 字符 / 非字符串
    const bad: Array<[string, string[]]> = [
      ['空串', ['ok', '']],
      ['超长', ['x'.repeat(129)]],
      ['非字符串', [42 as unknown as string]],
    ];
    for (const [label, list] of bad) {
      try {
        writePolicyLists(householdId, profileId, { allowedMediaIds: list });
        throw new Error(`${label}:期望拒绝但成功了`);
      } catch (err) {
        expect((err as Error).message, label).not.toBe(`${label}:期望拒绝但成功了`);
      }
    }
    // 失败写入不改变已存名单与版本
    expect(listsOf(profileId)).toMatchObject({ allowed: ['a', 'b', 'm2'], version: 2 });

    // 上限:1000 项可写,第 1001 项拒绝
    writePolicyLists(householdId, profileId, { allowedMediaIds: Array.from({ length: 1000 }, (_, i) => `id-${i}`) });
    expect(listsOf(profileId).allowed).toHaveLength(1000);
    try {
      writePolicyLists(householdId, profileId, { allowedMediaIds: Array.from({ length: 1001 }, (_, i) => `id-${i}`) });
      throw new Error('1001:期望拒绝但成功了');
    } catch (err) {
      expect((err as Error).message).not.toBe('1001:期望拒绝但成功了');
    }
    expect(listsOf(profileId).allowed).toHaveLength(1000);

    // 跨家庭/不存在目标 → 与 API 同形 NOT_FOUND
    expect(() => writePolicyLists(householdId, crypto.randomUUID(), { allowedMediaIds: [] })).toThrowError();
  });

  it('损坏名单读取拒绝:超上限/非字符串元素的存量行 → 判损坏拒绝,不静默当空数组(503 语义)', async () => {
    const s = await bootstrap();
    const householdId = (Database.db.prepare('SELECT id FROM household').get() as { id: string }).id;
    const mkProfile = async (): Promise<string> => {
      const created = await createProfile(s, { name: `夹具${Math.random().toString(36).slice(2, 7)}`, type: 'adult' });
      expect(created.status).toBe(201);
      return created.body.id as string;
    };

    const oversized = await mkProfile();
    const tooMany = JSON.stringify(Array.from({ length: 1001 }, (_, i) => `m-${i}`));
    Database.db.prepare('UPDATE profile_policy SET allowed_media_ids = ? WHERE profile_id = ?').run(tooMany, oversized);
    // 读取路径(loadPolicyForRead)对损坏行抛 503 POLICY_UNAVAILABLE
    const { loadPolicyForRead } = await import('../../src/modules/policy/policy.service');
    expect(() => loadPolicyForRead(householdId, oversized)).toThrowError(
      expect.objectContaining({ status: 503, code: ProblemCode.POLICY_UNAVAILABLE }),
    );

    const nonString = await mkProfile();
    Database.db.prepare('UPDATE profile_policy SET blocked_media_ids = ? WHERE profile_id = ?').run('["a", 3]', nonString);
    expect(() => loadPolicyForRead(householdId, nonString)).toThrowError(
      expect.objectContaining({ status: 503, code: ProblemCode.POLICY_UNAVAILABLE }),
    );
  });
});
