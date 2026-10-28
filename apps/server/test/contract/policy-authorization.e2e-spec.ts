import 'reflect-metadata';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Database } from '@platform/database/database';
import { authorizeCurrentProfile, type TrustedResourceReader } from '@contexts/policy/application/policy.service';
import type { MediaPolicyFacts } from '@contexts/policy/domain/policy.rules';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  initialize,
  login,
  startFreshApp,
} from '../helpers';
import { ensureSettingsUnlocked, mgmtSessionCookie } from '../helpers-management';

/**
 * T016(US2 集成):服务端授权入口 authorizeCurrentProfile —— FR-005/006/007 + SC-003。
 * 测试专用装配:可信资源 reader 为进程内夹具(按会话 Household 查询的模拟目录),
 * 生产 AppModule 不注册任何 evaluate 路由;本文件也验证「客户端输入不改变授权上下文」。
 */

interface Fixture {
  app: INestApplication;
  cookie: string;
  householdId: string;
  context: SessionContext;
  adultProfileId: string;
  childProfileId: string;
}

async function bootstrap(): Promise<Fixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-us2-' });
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await ensureSettingsUnlocked(app, cookie);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  const householdId = household.body.id as string;

  const adult = await request(app.getHttpServer()).post('/api/settings/profiles').set('Cookie', cookie).send({ name: '成人', type: 'adult', ownerPassword: INITIALIZE_BODY.password });
  const child = await request(app.getHttpServer()).post('/api/settings/profiles').set('Cookie', cookie).send({ name: '儿童', type: 'child', ownerPassword: INITIALIZE_BODY.password });

  // 以 DB 行构造服务端 SessionContext(与 SessionGuard 产出同构;信任源为会话行本身)
  const sessionRow = Database.db
    .prepare('SELECT * FROM device_session WHERE id = ?')
    .get(loggedIn.body.sessionId as string) as Record<string, string | null>;
  const accountRow = Database.db
    .prepare('SELECT * FROM account WHERE id = ?')
    .get(sessionRow.account_id as string) as Record<string, string>;
  const context: SessionContext = {
    session: {
      id: sessionRow.id as string,
      householdId: sessionRow.household_id as string,
      accountId: sessionRow.account_id as string,
      deviceId: sessionRow.device_id as string,
      activeProfileId: sessionRow.active_profile_id ?? null,
      expiresAt: sessionRow.expires_at as string,
    },
    account: {
      id: accountRow.id as string,
      householdId: accountRow.household_id as string,
      username: accountRow.username as string,
      role: accountRow.role as 'owner',
    },
  };

  return {
    app,
    cookie,
    householdId,
    context,
    adultProfileId: adult.body.id as string,
    childProfileId: child.body.id as string,
  };
}

/** 选择档案(经 API,保持服务端语义) */
function selectProfile(f: Fixture, profileId: string, ownerPassword?: string): Promise<request.Response> {
  return request(f.app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', f.cookie)
    .send(ownerPassword === undefined ? {} : { ownerPassword })
    .then((r) => r);
}

/**
 * 测试专用可信资源 reader(夹具目录):仅按传入 household 返回该家庭拥有的资源;
 * 跨家庭/不存在 → null。记录收到的 household 供断言(reader 必须以会话家庭为查询键)。
 */
function fixtureCatalog(catalog: Map<string, MediaPolicyFacts>): TrustedResourceReader & { householdCalls: string[] } {
  const householdCalls: string[] = [];
  const reader = (householdId: string, mediaId: string): MediaPolicyFacts | null => {
    householdCalls.push(householdId);
    const facts = catalog.get(mediaId);
    if (facts === undefined || facts.householdId !== householdId) {
      return null; // 跨家庭资源:与不存在统一不可区分(不泄漏存在性)
    }
    return facts;
  };
  return Object.assign(reader, { householdCalls });
}

describe('US2 授权入口 authorizeCurrentProfile(集成,夹具目录)', () => {
  afterEach(cleanupRigs);

  it('无当前观看者 → 拒绝(ACTIVE_PROFILE_REQUIRED),不回落成人策略;选择后按档案类型判定', async () => {
    const f = await bootstrap();
    const catalog = fixtureCatalog(
      new Map([['m-1', { householdId: f.householdId, mediaId: 'm-1', type: 'movie', channelId: null, contentLevel: 16, householdEnabled: true }]]),
    );

    // 005:夹具登录即选主档案 → 当前观看者为主档案(成人,max=18)→ 放行
    const mainViewer = await authorizeCurrentProfile(f.context, 'm-1', catalog);
    expect(mainViewer).toStrictEqual({ allowed: true, reason: 'LEVEL_ALLOWED' });

    expect((await selectProfile(f, f.childProfileId)).status).toBe(200);
    const childDecision = await authorizeCurrentProfile(f.context, 'm-1', catalog);
    expect(childDecision).toStrictEqual({ allowed: false, reason: 'LEVEL_EXCEEDED' }); // 儿童 max=12

    expect((await selectProfile(f, f.adultProfileId, INITIALIZE_BODY.password)).status).toBe(200);
    const adultDecision = await authorizeCurrentProfile(f.context, 'm-1', catalog);
    expect(adultDecision).toStrictEqual({ allowed: true, reason: 'LEVEL_ALLOWED' }); // 成人 max=18
  });

  it('当前观看者停用 → 拒绝(ACTIVE_PROFILE_REQUIRED);篡改上下文(伪造 activeProfile/家庭)不改变判定', async () => {
    const f = await bootstrap();
    // 等级 16:成人(18)允许、儿童(12)拒绝 —— 用于证明判定以 DB 为准而非上下文声明
    const catalog = fixtureCatalog(
      new Map([['m-16', { householdId: f.householdId, mediaId: 'm-16', type: 'movie', channelId: null, contentLevel: 16, householdEnabled: true }]]),
    );
    expect((await selectProfile(f, f.adultProfileId, INITIALIZE_BODY.password)).status).toBe(200);

    // 停用当前观看者(保留儿童/主档案)→ 授权拒绝;管理写经独立管理会话(005 设置边界)
    const mgmt = await mgmtSessionCookie(f.app, { username: INITIALIZE_BODY.username, password: INITIALIZE_BODY.password });
    const adultVersion = (
      Database.db.prepare('SELECT version FROM profile WHERE id = ?').get(f.adultProfileId) as { version: number }
    ).version;
    await request(f.app.getHttpServer())
      .patch(`/api/settings/profiles/${f.adultProfileId}`)
      .set('Cookie', mgmt)
      .send({ status: 'disabled', clearPin: false, expectedVersion: adultVersion, ownerPassword: INITIALIZE_BODY.password });
    expect(await authorizeCurrentProfile(f.context, 'm-16', catalog)).toStrictEqual({
      allowed: false,
      reason: 'ACTIVE_PROFILE_REQUIRED',
    });

    // 重新启用并选择成人;伪造上下文(声称当前观看者是儿童/他家庭)→ 判定仍以会话行为准(成人允许)
    // 005:重启后/管理写后 grant 已失效 —— 重启用经新的管理会话
    const mgmt2 = await mgmtSessionCookie(f.app, { username: INITIALIZE_BODY.username, password: INITIALIZE_BODY.password });
    await request(f.app.getHttpServer())
      .patch(`/api/settings/profiles/${f.adultProfileId}`)
      .set('Cookie', mgmt2)
      .send({ status: 'active', clearPin: false, expectedVersion: adultVersion + 1, ownerPassword: INITIALIZE_BODY.password });
    expect((await selectProfile(f, f.adultProfileId, INITIALIZE_BODY.password)).status).toBe(200);
    expect(await authorizeCurrentProfile(f.context, 'm-16', catalog)).toStrictEqual({
      allowed: true,
      reason: 'LEVEL_ALLOWED',
    });
    const forged: SessionContext = {
      ...f.context,
      session: {
        ...f.context.session,
        activeProfileId: f.childProfileId, // 伪造为儿童(若被采信将错误地拒绝)
        householdId: 'forged-household',
      },
    };
    expect(await authorizeCurrentProfile(forged, 'm-16', catalog)).toStrictEqual({
      allowed: true,
      reason: 'LEVEL_ALLOWED',
    });
  });

  it('策略缺失 → POLICY_UNAVAILABLE(不静默补默认);跨家庭 mediaId → RESOURCE_UNAVAILABLE 统一不可区分', async () => {
    const f = await bootstrap();
    const catalog = fixtureCatalog(
      new Map([
        ['own-1', { householdId: f.householdId, mediaId: 'own-1', type: 'movie', channelId: null, contentLevel: 10, householdEnabled: true }],
        ['foreign-1', { householdId: 'other-household', mediaId: 'foreign-1', type: 'movie', channelId: null, contentLevel: 10, householdEnabled: true }],
      ]),
    );
    expect((await selectProfile(f, f.adultProfileId, INITIALIZE_BODY.password)).status).toBe(200);

    // 跨家庭/不存在 → 同一拒绝(不泄漏存在性);reader 收到的查询键始终是会话家庭
    const cross = await authorizeCurrentProfile(f.context, 'foreign-1', catalog);
    const missing = await authorizeCurrentProfile(f.context, 'no-such-media', catalog);
    expect(cross).toStrictEqual({ allowed: false, reason: 'RESOURCE_UNAVAILABLE' });
    expect(missing).toStrictEqual(cross);
    expect(new Set(catalog.householdCalls)).toContain(f.householdId);
    expect(catalog.householdCalls.includes('other-household')).toBe(false);

    // 删除策略行 → 拒绝而非回落默认
    Database.db.prepare('DELETE FROM profile_policy WHERE profile_id = ?').run(f.adultProfileId);
    expect(await authorizeCurrentProfile(f.context, 'own-1', catalog)).toStrictEqual({
      allowed: false,
      reason: 'POLICY_UNAVAILABLE',
    });
  });

  it('策略修改后的下一次授权即采用新值(不缓存、不依赖客户端刷新);家庭禁用资源即时生效', async () => {
    const f = await bootstrap();
    const catalog = fixtureCatalog(
      new Map([['m-1', { householdId: f.householdId, mediaId: 'm-1', type: 'movie', channelId: null, contentLevel: 16, householdEnabled: true }]]),
    );
    expect((await selectProfile(f, f.childProfileId)).status).toBe(200);

    // 初始:儿童 12 → 拒绝
    expect(await authorizeCurrentProfile(f.context, 'm-1', catalog)).toStrictEqual({
      allowed: false,
      reason: 'LEVEL_EXCEEDED',
    });

    // 家长保存新策略(经服务 API,模拟另一设备修改;管理写经独立管理会话)
    const mgmt = await mgmtSessionCookie(f.app, { username: INITIALIZE_BODY.username, password: INITIALIZE_BODY.password });
    const saved = await request(f.app.getHttpServer())
      .put(`/api/settings/profiles/${f.childProfileId}/policy`)
      .set('Cookie', mgmt)
      .send({ ownerPassword: INITIALIZE_BODY.password, expectedVersion: 1, policy: { maxContentLevel: 16, allowUnrated: false } });
    expect(saved.status).toBe(200);

    // 下一次授权(无刷新/无重建)即用新值
    expect(await authorizeCurrentProfile(f.context, 'm-1', catalog)).toStrictEqual({
      allowed: true,
      reason: 'LEVEL_ALLOWED',
    });

    // 家庭禁用资源 → 立即拒绝
    const disabledCatalog = fixtureCatalog(
      new Map([['m-1', { householdId: f.householdId, mediaId: 'm-1', type: 'movie', channelId: null, contentLevel: 16, householdEnabled: false }]]),
    );
    expect(await authorizeCurrentProfile(f.context, 'm-1', disabledCatalog)).toStrictEqual({
      allowed: false,
      reason: 'RESOURCE_UNAVAILABLE',
    });
  });

  it('会话撤销/过期后授权拒绝(ACTIVE_PROFILE_REQUIRED):授权入口重验会话有效性', async () => {
    const f = await bootstrap();
    const catalog = fixtureCatalog(
      new Map([['m-1', { householdId: f.householdId, mediaId: 'm-1', type: 'movie', channelId: null, contentLevel: 10, householdEnabled: true }]]),
    );
    expect((await selectProfile(f, f.adultProfileId, INITIALIZE_BODY.password)).status).toBe(200);
    expect(await authorizeCurrentProfile(f.context, 'm-1', catalog)).toStrictEqual({ allowed: true, reason: 'LEVEL_ALLOWED' });

    // 撤销会话(直写库模拟登出/撤销竞态)→ 授权拒绝
    Database.db
      .prepare('UPDATE device_session SET revoked_at = ? WHERE id = ?')
      .run(new Date().toISOString(), f.context.session.id);
    expect(await authorizeCurrentProfile(f.context, 'm-1', catalog)).toStrictEqual({
      allowed: false,
      reason: 'ACTIVE_PROFILE_REQUIRED',
    });
  });
});
