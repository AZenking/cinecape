import 'reflect-metadata';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Database } from '@platform/database/database';
import {
  INITIALIZE_BODY,
  buildM3u,
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  createNasRootFixture,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
  type ControlledMediaServer,
  type NasRootFixture,
} from '../helpers';
import {
  MANAGEMENT_OWNER_PASSWORD,
  createProfileViaSettings,
  mainProfileOf,
  selectMainAndUnlockSettings,
} from '../helpers-management';

/**
 * T122(005-US8 契约 e2e,先 FAIL)—— settings 管理路由代表性读写(正向半部)。
 * 权威:contracts/api.md §6 全部路由表、§3 ProfileSummary、§7 次序与 no-store。
 * 负向矩阵(次序/越权/过期/伪造 grant/锁定/409/400/响应面)见
 * settings-management-negative.e2e-spec.ts。
 */

const mediaServers: ControlledMediaServer[] = [];
const activeNasRoots: NasRootFixture[] = [];

afterAll(async () => {
  for (const server of mediaServers) {
    await server.close();
  }
  mediaServers.length = 0;
  for (const nas of activeNasRoots) {
    nas.cleanup();
  }
  activeNasRoots.length = 0;
});

interface Rig {
  app: INestApplication;
  cookie: string;
  mainProfileId: string;
  householdId: string;
}

/** 初始化 + 登录 + 首建主档案 + 选档 + 设置解锁 */
async function rig(prefix: string, env: Record<string, string> = {}): Promise<Rig> {
  const fresh = await startFreshApp({ prefix, env });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const mainProfileId = await selectMainAndUnlockSettings(fresh.app, cookie);
  const household = await request(fresh.app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  expect(household.status).toBe(200);
  return { app: fresh.app, cookie, mainProfileId, householdId: household.body.id as string };
}

function noStore(res: { headers: Record<string, unknown> }): void {
  expect(String(res.headers['cache-control'])).toBe('no-store');
}

describe('T122 · settings 管理路由代表性读写(api.md §6 正向)', () => {
  afterEach(cleanupRigs);

  it('GET /settings/account:AccountSummary 白名单(id/username/role),no-store', async () => {
    const { app, cookie } = await rig('hmp-t122-account-');
    const res = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(res.status).toBe(200);
    noStore(res);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'role', 'username']);
    expect(res.body.username).toBe(INITIALIZE_BODY.username);
    expect(res.body.role).toBe('owner');
  });

  it('PUT /settings/account/password:204 清 cookie,旧会话失效,新密码可重登,旧密码被拒', async () => {
    const { app, cookie } = await rig('hmp-t122-password-');
    const res = await request(app.getHttpServer())
      .put('/api/settings/account/password')
      .set('Cookie', cookie)
      .send({ ownerPassword: INITIALIZE_BODY.password, newPassword: 'brand-new-password-9' });
    expect(res.status).toBe(204);
    noStore(res);
    // 清 cookie:响应含过期 Set-Cookie(旧会话也已服务端撤销)
    const setCookie = res.headers['set-cookie'] as string[] | string | undefined;
    expect(setCookie).toBeDefined();
    const restore = await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', cookie);
    expect(restore.status).toBe(401);
    expectProblemContentType(restore);
    const oldLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: INITIALIZE_BODY.username, password: INITIALIZE_BODY.password });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: INITIALIZE_BODY.username, password: 'brand-new-password-9' });
    expect(newLogin.status).toBe(200);
  });

  it('GET/PATCH /settings/household:HouseholdSettings 投影;PATCH 当次密码+CAS 保存', async () => {
    const { app, cookie } = await rig('hmp-t122-household-');
    const got = await request(app.getHttpServer()).get('/api/settings/household').set('Cookie', cookie);
    expect(got.status).toBe(200);
    noStore(got);
    expect(Object.keys(got.body).sort()).toEqual([
      'language',
      'mainProfileVersion',
      'name',
      'timezone',
      'version',
    ]);
    expect(got.body.version).toBe(1);

    const patched = await request(app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({
        expectedVersion: 1,
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
        name: '改后的家',
        language: 'zh-CN',
        timezone: 'America/New_York',
      });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    noStore(patched);
    expect(patched.body).toMatchObject({ name: '改后的家', timezone: 'America/New_York', version: 2 });

    // 旧版本 409;未知字段 400;非法时区 400
    const stale = await request(app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, name: '过期写入' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
    expect(stale.body.name).toBeUndefined();
    const unknown = await request(app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({
        expectedVersion: 2,
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
        name: 'X',
        householdId: '00000000-0000-4000-8000-000000000000',
      });
    expect(unknown.status).toBe(400);
    const badTz = await request(app.getHttpServer())
      .patch('/api/settings/household')
      .set('Cookie', cookie)
      .send({
        expectedVersion: 2,
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
        timezone: 'Mars/Olympus_Mons',
      });
    expect(badTz.status).toBe(400);
  });

  it('GET/POST /settings/profiles + PATCH {id}:ProfileSummary 投影、当次密码、expectedVersion CAS、主档案守卫', async () => {
    const { app, cookie, mainProfileId } = await rig('hmp-t122-profiles-');
    const listed = await request(app.getHttpServer()).get('/api/settings/profiles').set('Cookie', cookie);
    expect(listed.status).toBe(200);
    noStore(listed);
    const summaryKeys = Object.keys((listed.body as Array<Record<string, unknown>>)[0]!).sort();
    expect(summaryKeys).toEqual([
      'avatar',
      'createdAt',
      'id',
      'isDefault',
      'isMain',
      'name',
      'pinProtected',
      'status',
      'type',
      'version',
    ]);

    const created = await createProfileViaSettings(app, cookie, {
      name: '儿童档案',
      type: 'child',
      pin: '246800',
      isDefault: false,
    });
    expect(created.status).toBe(201);
    noStore(created);
    const childId = created.body.id as string;
    expect(created.body.version).toBe(1);

    // 缺当次密码 → 403 REQUIRED;错误密码沿用既有计数
    const missingPassword = await request(app.getHttpServer())
      .post('/api/settings/profiles')
      .set('Cookie', cookie)
      .send({ name: '无密码', type: 'adult' });
    expect(missingPassword.status).toBe(403);
    expect(missingPassword.body.code).toBe('PARENT_VERIFICATION_REQUIRED');

    // 编辑:CAS 成功 → version+1;旧版本 409 不覆盖
    const edited = await request(app.getHttpServer())
      .patch(`/api/settings/profiles/${childId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, name: '儿童改名' });
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(2);
    const stale = await request(app.getHttpServer())
      .patch(`/api/settings/profiles/${childId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, name: '静默覆盖' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    // 主档案守卫:clearPin 400;停用主档案 409 MAIN_PROFILE_CONFLICT
    const clearMain = await request(app.getHttpServer())
      .patch(`/api/settings/profiles/${mainProfileId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, clearPin: true });
    expect(clearMain.status).toBe(400);
    const disableMain = await request(app.getHttpServer())
      .patch(`/api/settings/profiles/${mainProfileId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, ownerPassword: MANAGEMENT_OWNER_PASSWORD, status: 'disabled' });
    expect(disableMain.status).toBe(409);
    expect(disableMain.body.code).toBe('MAIN_PROFILE_CONFLICT');

    // 停用普通档案成功 → 响应 disabled;再停用最后一个可用档案(主档案)已由上行覆盖
    const disabled = await request(app.getHttpServer())
      .patch(`/api/settings/profiles/${childId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 2, ownerPassword: MANAGEMENT_OWNER_PASSWORD, status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect(disabled.body.status).toBe('disabled');
  });

  it('PUT /settings/main-profile:三项 CAS 成功转移,响应只含 mainProfileId/mainProfileVersion,全部设置授予撤销', async () => {
    const { app, cookie } = await rig('hmp-t122-mainprofile-');
    const created = await createProfileViaSettings(app, cookie, {
      name: '新主',
      type: 'adult',
      pin: '369258',
    });
    expect(created.status).toBe(201);
    const targetId = created.body.id as string;
    const main = await mainProfileOf(app, cookie);
    const household = await request(app.getHttpServer()).get('/api/settings/household').set('Cookie', cookie);
    const mainProfileVersion = household.body.mainProfileVersion as number;

    const transferred = await request(app.getHttpServer())
      .put('/api/settings/main-profile')
      .set('Cookie', cookie)
      .send({
        profileId: targetId,
        expectedVersion: mainProfileVersion,
        expectedCurrentProfileVersion: main.version,
        expectedProfileVersion: created.body.version,
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      });
    expect(transferred.status, JSON.stringify(transferred.body)).toBe(200);
    noStore(transferred);
    expect(Object.keys(transferred.body).sort()).toEqual(['mainProfileId', 'mainProfileVersion']);
    expect(transferred.body.mainProfileId).toBe(targetId);
    expect(transferred.body.mainProfileVersion).toBe(mainProfileVersion + 1);
    // 转移完成撤销全部设置授予:当前会话立即 403 SETTINGS_ACCESS_REQUIRED
    const afterTransfer = await request(app.getHttpServer()).get('/api/settings/account').set('Cookie', cookie);
    expect(afterTransfer.status).toBe(403);
    expect(afterTransfer.body.code).toBe('SETTINGS_ACCESS_REQUIRED');
    // 旧主档案不再是主档案;最后一档停用守卫仍有效
    const list = await request(app.getHttpServer()).get('/api/settings/profiles').set('Cookie', cookie);
    expect(list.status).toBe(403); // 授予已撤销,读取同样被拒
  });

  it('GET/PUT policy 与 policy/lists:继承 002 字段,当次密码+CAS', async () => {
    const { app, cookie, mainProfileId } = await rig('hmp-t122-policy-');
    const got = await request(app.getHttpServer())
      .get(`/api/settings/profiles/${mainProfileId}/policy`)
      .set('Cookie', cookie);
    expect(got.status).toBe(200);
    noStore(got);
    expect(got.body.version).toBe(1);

    const put = await request(app.getHttpServer())
      .put(`/api/settings/profiles/${mainProfileId}/policy`)
      .set('Cookie', cookie)
      .send({
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
        expectedVersion: 1,
        policy: { maxContentLevel: 12, allowUnrated: false },
      });
    expect(put.status).toBe(200);
    noStore(put);
    expect(put.body.version).toBe(2);

    const lists = await request(app.getHttpServer())
      .put(`/api/settings/profiles/${mainProfileId}/policy/lists`)
      .set('Cookie', cookie)
      .send({
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
        expectedVersion: 2,
        allowedMediaIds: [],
        blockedMediaIds: [],
        allowedChannelIds: [],
      });
    expect(lists.status).toBe(200);
    expect(lists.body.version).toBe(3);

    const stale = await request(app.getHttpServer())
      .put(`/api/settings/profiles/${mainProfileId}/policy`)
      .set('Cookie', cookie)
      .send({
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
        expectedVersion: 1,
        policy: { maxContentLevel: 18, allowUnrated: true },
      });
    expect(stale.status).toBe(409);
  });

  describe('sources/source-roots/refresh/refreshes + catalog(受控夹具)', () => {
    it('创建 IPTV 来源 → PATCH CAS → refresh 202(Location=settings 路径)→ 状态轮询 → 快照确认 → 发布成功', async () => {
      const media = await createControlledMediaServer();
      mediaServers.push(media);
      media.setRoute('/a.m3u', {
        kind: 'm3u',
        content: buildM3u([
          { name: 'CCTV-1', url: 'http://stream.example/cctv1.m3u8', tvgId: 'cctv-1', groupTitle: '央视' },
          { name: 'CCTV-2', url: 'http://stream.example/cctv2.m3u8', groupTitle: '央视' },
        ]),
      });
      const { app, cookie } = await rig('hmp-t122-sources-', { LAN_ALLOWED_TARGETS: '127.0.0.1' });

      const created = await request(app.getHttpServer())
        .post('/api/settings/sources')
        .set('Cookie', cookie)
        .send({
          ownerPassword: MANAGEMENT_OWNER_PASSWORD,
          kind: 'iptv',
          name: '直播源',
          enabled: true,
          remoteUrl: 'http://media.example.tv/a.m3u',
          privateAccessApproved: true,
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      noStore(created);
      const sourceId = created.body.id as string;
      // 源 URL 脱敏:响应只含契约字段(locationLabel 为主机名),不含原始 URL/路径/凭据
      expect(JSON.stringify(created.body)).not.toContain('remoteUrl');
      expect(JSON.stringify(created.body)).not.toContain('/a.m3u');

      // 接到受控夹具(创建期字面校验拒绝回环,既有模式)
      Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(`${media.baseUrl}/a.m3u`, sourceId);

      const listed = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      expect(listed.body.items).toHaveLength(1);

      const patched = await request(app.getHttpServer())
        .patch(`/api/settings/sources/${sourceId}`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: 1, name: '直播源改名' });
      expect(patched.status).toBe(200);
      expect(patched.body.version).toBe(2);

      const roots = await request(app.getHttpServer()).get('/api/settings/source-roots').set('Cookie', cookie);
      expect(roots.status).toBe(200);
      expect(Array.isArray(roots.body)).toBe(true);

      // refresh:202 + Location 指向 settings 路径
      const refresh = await request(app.getHttpServer())
        .post(`/api/settings/sources/${sourceId}/refresh`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: 2, operationKey: crypto.randomUUID() });
      expect(refresh.status, JSON.stringify(refresh.body)).toBe(202);
      expect(refresh.headers.location).toBe(`/api/settings/refreshes/${refresh.body.id}`);

      // 状态轮询至终态(小快照:2 条全部保留 → succeeded)
      const refreshId = refresh.body.id as string;
      let status = '';
      for (let attempt = 0; attempt < 100 && status !== 'succeeded' && status !== 'failed'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const poll = await request(app.getHttpServer()).get(`/api/settings/refreshes/${refreshId}`).set('Cookie', cookie);
        expect(poll.status).toBe(200);
        status = poll.body.status as string;
      }
      expect(status).toBe('succeeded');

      // catalog 候选查询(密码必填)+ 人工修正 CAS
      const candidates = await request(app.getHttpServer())
        .post('/api/settings/catalog/candidates/query')
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, page: 1, pageSize: 20 });
      expect(candidates.status).toBe(200);
      expect(candidates.body.total).toBe(2);
      const mediaId = candidates.body.items[0].id as string;
      const patchedMedia = await request(app.getHttpServer())
        .patch(`/api/settings/catalog/media/${mediaId}`)
        .set('Cookie', cookie)
        .send({
          ownerPassword: MANAGEMENT_OWNER_PASSWORD,
          expectedVersion: 1,
          title: '人工标题',
          contentLevel: 12,
        });
      expect(patchedMedia.status).toBe(200);
      expect(patchedMedia.body.title).toBe('人工标题');
    });

    it('快照确认/丢弃:awaiting_confirmation → discard 保留上次成功目录', async () => {
      const nas = createNasRootFixture({ rootKey: 'nas-main' });
      activeNasRoots.push(nas);
      const { app, cookie } = await rig('hmp-t122-discard-', {
        MEDIA_ROOTS: `nas-main=${nas.rootPath}`,
      });
      // 首次导入:2 个 NAS 文件,成功发布
      nas.write('a.mp4', 'aaa');
      nas.write('b.mp4', 'bbb');
      const created = await request(app.getHttpServer())
        .post('/api/settings/sources')
        .set('Cookie', cookie)
        .send({
          ownerPassword: MANAGEMENT_OWNER_PASSWORD,
          kind: 'nas',
          name: '丢弃实验',
          rootKey: 'nas-main',
          relativeDirectory: '',
          privateAccessApproved: true,
        });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const sourceId = created.body.id as string;
      const versionBeforeFirst = await sourceVersion(app, cookie, sourceId);
      const first = await request(app.getHttpServer())
        .post(`/api/settings/sources/${sourceId}/refresh`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: versionBeforeFirst, operationKey: crypto.randomUUID() });
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      await waitStatus(app, cookie, first.body.id as string, 'succeeded');

      // 二次导入:全部缺失(>25%)→ awaiting_confirmation
      nas.remove('a.mp4');
      nas.remove('b.mp4');
      const versionBeforeSecond = await sourceVersion(app, cookie, sourceId);
      const second = await request(app.getHttpServer())
        .post(`/api/settings/sources/${sourceId}/refresh`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: versionBeforeSecond, operationKey: crypto.randomUUID() });
      expect(second.status, JSON.stringify(second.body)).toBe(202);
      const awaiting = await waitStatus(app, cookie, second.body.id as string, 'awaiting_confirmation', 'failed');
      expect(awaiting.status).toBe('awaiting_confirmation');
      // discard:当次密码+任务当前 version;上次成功目录保留
      const discarded = await request(app.getHttpServer())
        .post(`/api/settings/refreshes/${second.body.id}/discard`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: awaiting.version });
      expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
      expect(discarded.body.status).toBe('discarded');
      const candidates = await request(app.getHttpServer())
        .post('/api/settings/catalog/candidates/query')
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, page: 1, pageSize: 20 });
      expect(candidates.body.total).toBe(2); // 失败/丢弃不清上次成功目录(FR-037)
    });
  });

  describe('EPG 管理三组(逐频道手动匹配)', () => {
    it('epg-binding/query 默认 auto 状态;epg-candidates/query 对未导入 EPG 来源 422;解除绑定 auto 墓碑', async () => {
      const media = await createControlledMediaServer();
      mediaServers.push(media);
      media.setRoute('/guide.xml', {
        kind: 'xmltv',
        content: '<tv><channel id="cctv-1"><display-name>CCTV-1</display-name></channel></tv>',
      });
      const { app, cookie } = await rig('hmp-t122-epg-', { LAN_ALLOWED_TARGETS: '127.0.0.1' });
      // 频道媒体(IPTV 导入)+ EPG 来源(未导入任何节目 → not ready)
      const iptv = await request(app.getHttpServer())
        .post('/api/settings/sources')
        .set('Cookie', cookie)
        .send({
          ownerPassword: MANAGEMENT_OWNER_PASSWORD,
          kind: 'iptv',
          name: '直播',
          remoteUrl: 'http://media.example.tv/live.m3u',
          privateAccessApproved: true,
        });
      expect(iptv.status).toBe(201);
      Database.db
        .prepare('UPDATE media_source SET remote_url = ? WHERE id = ?')
        .run(`${media.baseUrl}/live.m3u`, iptv.body.id as string);
      media.setRoute('/live.m3u', {
        kind: 'm3u',
        content: buildM3u([{ name: 'CCTV-1', url: 'http://stream.example/1.m3u8', tvgId: 'cctv-1' }]),
      });
      const epg = await request(app.getHttpServer())
        .post('/api/settings/sources')
        .set('Cookie', cookie)
        .send({
          ownerPassword: MANAGEMENT_OWNER_PASSWORD,
          kind: 'epg',
          name: '节目单',
          remoteUrl: 'http://media.example.tv/guide.xml',
          privateAccessApproved: true,
        });
      expect(epg.status).toBe(201);
      const epgId = epg.body.id as string;
      Database.db
        .prepare('UPDATE media_source SET remote_url = ? WHERE id = ?')
        .run(`${media.baseUrl}/guide.xml`, epgId);
      const refreshed = await request(app.getHttpServer())
        .post(`/api/settings/sources/${iptv.body.id}/refresh`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: 1, operationKey: crypto.randomUUID() });
      expect(refreshed.status).toBe(202);
      await waitStatus(app, cookie, refreshed.body.id as string, 'succeeded');
      const candidates = await request(app.getHttpServer())
        .post('/api/settings/catalog/candidates/query')
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, page: 1, pageSize: 20 });
      const channelId = candidates.body.items[0].id as string;

      // 绑定状态查询:auto / version 0(无行)
      const binding = await request(app.getHttpServer())
        .post(`/api/settings/catalog/media/${channelId}/epg-binding/query`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD });
      expect(binding.status).toBe(200);
      expect(binding.body).toMatchObject({ mediaId: channelId, mode: 'auto', version: 0 });

      // 候选查询:EPG 来源尚未成功导入 → 422 EPG_SOURCE_NOT_READY
      const epgCandidates = await request(app.getHttpServer())
        .post(`/api/settings/catalog/media/${channelId}/epg-candidates/query`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, epgSourceId: epgId, page: 1, pageSize: 20 });
      expect(epgCandidates.status).toBe(422);
      expect(epgCandidates.body.code).toBe('EPG_SOURCE_NOT_READY');

      // 解除(当前已是 auto/version 0):成功返回 auto 墓碑语义
      const unbound = await request(app.getHttpServer())
        .put(`/api/settings/catalog/media/${channelId}/epg-binding`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: 0, mode: 'auto' });
      expect(unbound.status).toBe(200);
      expect(unbound.body.mode).toBe('auto');
      // 旧 expectedVersion 409
      const staleUnbind = await request(app.getHttpServer())
        .put(`/api/settings/catalog/media/${channelId}/epg-binding`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD, expectedVersion: 0, mode: 'auto' });
      expect(staleUnbind.status).toBe(409);
    });
  });

  describe('devices 三组', () => {
    it('GET /settings/devices 列表;revoke 当次密码撤目标设备;playback-records/query 空页', async () => {
      const { app, cookie } = await rig('hmp-t122-devices-');
      // 第二台设备登录(未选档)
      const secondLogin = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password, {
        deviceType: 'mobile',
        deviceName: '手机',
      });
      expect(secondLogin.status).toBe(200);
      const secondCookie = cookiePairOf(secondLogin);

      const listed = await request(app.getHttpServer()).get('/api/settings/devices').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      noStore(listed);
      const devices = listed.body as Array<{ id: string; type: string; revokedAt: string | null }>;
      expect(devices).toHaveLength(2);
      // 设备按 createdAt 升序:首台为主会话设备,第二台为刚登录的手机
      const target = devices.find((device) => device.type === 'mobile');
      expect(target, '夹具应含 mobile 设备').toBeDefined();

      // 撤销第二台设备(当次密码;204)→ 其会话立即失效
      const revoked = await request(app.getHttpServer())
        .post(`/api/settings/devices/${target!.id}/revoke`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD });
      expect(revoked.status).toBe(204);
      noStore(revoked);
      const secondRestore = await request(app.getHttpServer()).get('/api/auth/session').set('Cookie', secondCookie);
      expect(secondRestore.status).toBe(401);

      // 播放记录查询:当次密码;空页形态 {items,nextCursor}
      const records = await request(app.getHttpServer())
        .post(`/api/settings/devices/${target!.id}/playback-records/query`)
        .set('Cookie', cookie)
        .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD });
      expect(records.status).toBe(200);
      expect(Object.keys(records.body).sort()).toEqual(['items', 'nextCursor']);
      expect(records.body.items).toEqual([]);
      expect(records.body.nextCursor).toBeNull();
    });
  });
});

/** 当前来源 version(GET /settings/sources;发布可能递增,刷新请求前现读现用) */
async function sourceVersion(app: INestApplication, cookie: string, sourceId: string): Promise<number> {
  const listed = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
  expect(listed.status).toBe(200);
  const source = (listed.body as { items: Array<{ id: string; version: number }> }).items.find((item) => item.id === sourceId);
  expect(source, '来源应在列表中').toBeDefined();
  return source!.version;
}

/** 轮询任务状态直至达到任一期望终态;返回完整任务体(status/version 现读现用) */
async function waitStatus(
  app: INestApplication,
  cookie: string,
  refreshId: string,
  ...terminal: string[]
): Promise<{ status: string; version: number }> {
  let status = '';
  let version = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const poll = await request(app.getHttpServer()).get(`/api/settings/refreshes/${refreshId}`).set('Cookie', cookie);
    expect(poll.status).toBe(200);
    status = poll.body.status as string;
    version = poll.body.version as number;
    if (terminal.includes(status)) {
      return { status, version };
    }
  }
  throw new Error(`任务未达终态 ${JSON.stringify(terminal)},当前 ${status}`);
}
