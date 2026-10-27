import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import { Database } from '../../src/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';

/**
 * T069(US5 契约 e2e,预期红):手动 EPG 绑定管理端点 HTTP 矩阵,对照
 * docs/specs/003-media-catalog/contracts/api.md「EPG 手动匹配增补」/openapi.yaml
 * 与 quickstart H4/H5:
 * - POST /catalog/media/{mediaId}/epg-binding/query:owner+当次密码;无行 → auto/version=0;
 *   管理失效绑定仍可读取;no-store;不泄漏源位置/凭据;
 * - POST /catalog/media/{mediaId}/epg-candidates/query:同家庭 EPG 候选分页,排除 conflicted,
 *   返回 epgGeneration;无 URL/路径/密钥;
 * - PUT /catalog/media/{mediaId}/epg-binding:version0→1→2→3 生命周期、并发旧版本 409
 *   EPG_BINDING_VERSION_CONFLICT、候选 generation 变化 409 EPG_CANDIDATE_STALE、
 *   解除写 auto 墓碑不删行;非频道 400;跨家庭 404;禁用源/冲突候选 422;
 *   缺/错密码 403、5 次锁定 423、撤销会话 401。
 *
 * ⚠️ 预期红(T069 交付物):三个端点在 T071 才接线,当前全部 404。
 * 夹具以「无行绑定查询须 200」作为正控守卫,端点缺席时整文件用例统一失败于该守卫
 * (失败原因分类:端点未实现),T071 落地后本文件应转绿。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;
const API = '/api/settings/catalog/media';
const NOW_ISO = '2026-01-01T00:00:00.000Z';

/** 管理成功响应绝不允许出现的敏感字样(仅对 200 响应体做反向断言;problem.type 合法含 http) */
const FORBIDDEN_LEAK_FRAGMENTS = ['remote_url', 'root_key', 'relative_directory', 'm3u8', 'playback', 'token', 'secret'];

interface BindingFixture {
  app: INestApplication;
  cookie: string;
  householdId: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 目录种子:IPTV(默认 EPG=src-epg-a)+ 两个 EPG(启用 gen=3/禁用)+ 频道/非频道/裸频道 + 邻居家 */
function seedCatalog(householdId: string): void {
  const conn = Database.db;
  const now = NOW_ISO;
  const insertSource = conn.prepare(
    "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, epg_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, 1, ?, NULL, ?, ?, ?)",
  );
  // 启用且「已成功导入」的 EPG 来源(last_success_at + generation=3 + 实际频道行)
  insertSource.run('src-epg-a', householdId, 'epg', '指南来源A', 'http://epg-seed.example/guide.xml', null, 1, now, 3, now, now);
  insertSource.run('src-epg-off', householdId, 'epg', '停用指南', 'http://epg-seed.example/off.xml', null, 0, now, 0, now, now);
  insertSource.run('src-iptv', householdId, 'iptv', '受控IPTV', 'http://iptv-seed.example/list.m3u8', 'src-epg-a', 1, now, 0, now, now);

  const insertMedia = conn.prepare(
    'INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)',
  );
  const insertEntry = conn.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)",
  );
  const insertPlayback = conn.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', ?, NULL, 100, 0, ?, ?)",
  );
  // 频道(有 IPTV 条目与播放资源;location 含敏感字样用于泄漏反向断言)
  insertMedia.run('m-chan', householdId, 'channel', '频道甲', null, 0, now, now);
  insertEntry.run('entry-chan', householdId, 'src-iptv', sha256('src-iptv:m-chan'), 'm-chan', 'cctv-1', 1, now, now);
  insertPlayback.run('pb-chan', householdId, 'src-iptv', 'entry-chan', 'm-chan', 'http://secret-upstream.example/stream.m3u8?token=topsecret', now, now);
  // 非频道(有 IPTV 条目:证明 400 来自类型校验)
  insertMedia.run('m-movie', householdId, 'movie', '电影甲', null, 3, now, now);
  insertEntry.run('entry-movie', householdId, 'src-iptv', sha256('src-iptv:m-movie'), 'm-movie', null, 1, now, now);
  // 无任何来源条目的频道
  insertMedia.run('m-bare', householdId, 'channel', '裸频道', null, 0, now, now);

  // EPG 频道:cctv-1(含当前/未来节目)、cctv-2(无节目,验证「无节目 ≠ 失效」)、cctv-conflict(冲突)
  const insertChannel = conn.prepare('INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)');
  insertChannel.run(householdId, 'src-epg-a', 'cctv-1', '央视一套', 0);
  insertChannel.run(householdId, 'src-epg-a', 'cctv-2', '央视二套', 0);
  insertChannel.run(householdId, 'src-epg-a', 'cctv-conflict', '冲突频道', 1);
  insertChannel.run(householdId, 'src-epg-off', 'off-1', '停用源频道', 0);
  const insertProgramme = conn.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  const currentStart = new Date(Date.now() - 10 * 60_000).toISOString();
  const currentEnd = new Date(Date.now() + 20 * 60_000).toISOString();
  const nextStart = new Date(Date.now() + 20 * 60_000).toISOString();
  const nextEnd = new Date(Date.now() + 80 * 60_000).toISOString();
  insertProgramme.run('pg-now', householdId, 'src-epg-a', 'cctv-1', '当前节目', currentStart, currentEnd);
  insertProgramme.run('pg-next', householdId, 'src-epg-a', 'cctv-1', '下一节目', nextStart, nextEnd);

  // 邻居家:同形 404 断言用(跨家庭媒体/来源)
  conn.prepare("INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-foreign', '邻居家', 'zh-CN', 'Asia/Shanghai', ?)").run(now);
  insertSource.run('src-foreign-epg', 'hh-foreign', 'epg', '他家指南', 'http://foreign-seed.example/guide.xml', null, 1, now, 1, now, now);
  conn
    .prepare("INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES ('m-foreign', 'hh-foreign', 'channel', 'Foreign 频道', NULL, NULL, 0, 0, 0, 1, ?, ?)")
    .run(now, now);
}

async function setupBindingRig(): Promise<BindingFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-epg-binding-' });
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  const householdId = (household.body as { id: string }).id;
  seedCatalog(householdId);
  await selectMainAndUnlockSettings(app, cookie);

  const fixture: BindingFixture = { app, cookie, householdId };

  // 正控守卫(T069 预期红):端点未实现时此处 404,整文件用例统一失败于「端点未实现」
  const probe = await queryBinding(fixture, 'm-chan', { ownerPassword: OWNER_PASSWORD });
  if (probe.status !== 200) {
    throw new Error(
      `manual EPG 管理端点未实现(T071):POST /api/settings/catalog/media/{id}/epg-binding/query 返回 ${probe.status};` +
        '本契约文件按 T069 预期保持红,T071 接线后应转绿',
    );
  }
  return fixture;
}

/* ------------------------------------------------------------------ */
/* 请求包装(均携带 owner 会话 Cookie;密码只出现在 body)                  */
/* ------------------------------------------------------------------ */

function queryBinding(f: BindingFixture, mediaId: string, body: Record<string, unknown>): request.Test {
  return request(f.app.getHttpServer()).post(`${API}/${mediaId}/epg-binding/query`).set('Cookie', f.cookie).send(body);
}

function queryCandidates(f: BindingFixture, mediaId: string, body: Record<string, unknown>): request.Test {
  return request(f.app.getHttpServer()).post(`${API}/${mediaId}/epg-candidates/query`).set('Cookie', f.cookie).send(body);
}

function putBinding(f: BindingFixture, mediaId: string, body: Record<string, unknown>): request.Test {
  return request(f.app.getHttpServer()).put(`${API}/${mediaId}/epg-binding`).set('Cookie', f.cookie).send(body);
}

/** 管理保存的最小合法 body(目标 src-epg-a / cctv-2,无节目候选) */
function manualSaveBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerPassword: OWNER_PASSWORD,
    expectedVersion: 0,
    mode: 'manual',
    epgSourceId: 'src-epg-a',
    xmltvChannelId: 'cctv-2',
    expectedEpgGeneration: 3,
    ...overrides,
  };
}

describe('POST /catalog/media/{mediaId}/epg-binding/query(管理读取,quickstart H5)', () => {
  afterEach(cleanupRigs);
  let f: BindingFixture;
  beforeEach(async () => {
    f = await setupBindingRig();
  });

  it('无行:200 {mode:auto,version:0,status:auto,invalidReason:null};no-store;响应无源位置/凭据', async () => {
    const res = await queryBinding(f, 'm-chan', { ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      mediaId: 'm-chan',
      mode: 'auto',
      version: 0,
      epgSourceId: null,
      xmltvChannelId: null,
      status: 'auto',
      invalidReason: null,
    });
    for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
      expect(res.text, `响应不得包含 ${fragment}`).not.toContain(fragment);
    }
  });

  it('已保存 manual 且无节目:status=valid(无节目 ≠ 失效);BindingDto 不含目标源位置', async () => {
    const saved = await putBinding(f, 'm-chan', manualSaveBody());
    expect(saved.status).toBe(200);
    const res = await queryBinding(f, 'm-chan', { ownerPassword: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'manual', version: 1, epgSourceId: 'src-epg-a', xmltvChannelId: 'cctv-2', status: 'valid', invalidReason: null });
    for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
      expect(res.text).not.toContain(fragment);
    }
    // 普通节目查询:manual 有效但无当前/未来节目 → unavailable(不误称失效,不回退自动)
    const programmes = await request(f.app.getHttpServer()).get('/api/media/m-chan/programmes').set('Cookie', f.cookie);
    expect(programmes.status).toBe(200);
    expect(programmes.body).toMatchObject({ status: 'unavailable', current: null, next: null });
  });

  it('缺密码 → 403 PARENT_VERIFICATION_REQUIRED;错密码 → 403 PARENT_VERIFICATION_FAILED(problem+json)', async () => {
    const missing = await queryBinding(f, 'm-chan', {});
    expect(missing.status).toBe(403);
    expectProblemContentType(missing);
    expect(missing.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const wrong = await queryBinding(f, 'm-chan', { ownerPassword: 'definitely-wrong' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
  });

  it('连续 5 次错密码 → 第 6 次(即使正确)423 PARENT_VERIFICATION_LOCKED(账号级共享)', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await queryBinding(f, 'm-chan', { ownerPassword: `wrong-${i}` });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
    }
    const locked = await queryBinding(f, 'm-chan', { ownerPassword: OWNER_PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe(ProblemCode.PARENT_VERIFICATION_LOCKED);
  });

  it('撤销会话 → 401 SESSION_INVALID;无 Cookie → 401', async () => {
    Database.db.prepare('UPDATE device_session SET revoked_at = ?').run(new Date().toISOString());
    const revoked = await queryBinding(f, 'm-chan', { ownerPassword: OWNER_PASSWORD });
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe(ProblemCode.SESSION_INVALID);

    const anonymous = await request(f.app.getHttpServer())
      .post(`${API}/m-chan/epg-binding/query`)
      .send({ ownerPassword: OWNER_PASSWORD });
    expect(anonymous.status).toBe(401);
  });

  it('跨家庭媒体与未知媒体统一 404 同形 problem+json(NOT_FOUND),不泄漏存在性差异', async () => {
    const [foreign, unknown] = await Promise.all([
      queryBinding(f, 'm-foreign', { ownerPassword: OWNER_PASSWORD }),
      queryBinding(f, '00000000-0000-4000-8000-000000000000', { ownerPassword: OWNER_PASSWORD }),
    ]);
    for (const res of [foreign, unknown]) {
      expect(res.status).toBe(404);
      expectProblemContentType(res);
      expect(res.body.code).toBe(ProblemCode.NOT_FOUND);
    }
    expect(foreign.body.code).toBe(unknown.body.code);
  });

  it('非频道媒体保存 → 400 VALIDATION_FAILED;无 IPTV 条目的频道保存 → 400', async () => {
    const movie = await putBinding(f, 'm-movie', manualSaveBody());
    expect(movie.status).toBe(400);
    expect(movie.body.code).toBe(ProblemCode.VALIDATION_FAILED);

    const bare = await putBinding(f, 'm-bare', manualSaveBody());
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe(ProblemCode.VALIDATION_FAILED);
  });
});

describe('PUT /catalog/media/{mediaId}/epg-binding(保存/解除,quickstart H4)', () => {
  afterEach(cleanupRigs);
  let f: BindingFixture;
  beforeEach(async () => {
    f = await setupBindingRig();
  });

  it('版本生命周期 0→1→2→3:manual 保存 → auto 解除(墓碑) → 再次 manual;库中恒一行', async () => {
    const v1 = await putBinding(f, 'm-chan', manualSaveBody({ xmltvChannelId: 'cctv-1' }));
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ mode: 'manual', version: 1, status: 'valid' });

    const v2 = await putBinding(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, mode: 'auto' });
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ mode: 'auto', version: 2, epgSourceId: null, xmltvChannelId: null });

    const v3 = await putBinding(f, 'm-chan', manualSaveBody({ expectedVersion: 2 }));
    expect(v3.status).toBe(200);
    expect(v3.body).toMatchObject({ mode: 'manual', version: 3 });

    const rows = Database.db.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number };
    expect(rows.n).toBe(1); // 墓碑不删行,防 ABA
  });

  it('旧 expectedVersion 保存与解除 → 409 EPG_BINDING_VERSION_CONFLICT,原配置不变;解除后旧 version0 请求 409', async () => {
    expect((await putBinding(f, 'm-chan', manualSaveBody())).status).toBe(200);
    const rowAfterSave = Database.db.prepare('SELECT * FROM manual_epg_binding WHERE media_id = ?').get('m-chan');

    const staleSave = await putBinding(f, 'm-chan', manualSaveBody({ expectedVersion: 0 }));
    expect(staleSave.status).toBe(409);
    expect(staleSave.body.code).toBe('EPG_BINDING_VERSION_CONFLICT');

    const staleUnbind = await putBinding(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, expectedVersion: 0, mode: 'auto' });
    expect(staleUnbind.status).toBe(409);
    expect(staleUnbind.body.code).toBe('EPG_BINDING_VERSION_CONFLICT');
    expect(Database.db.prepare('SELECT * FROM manual_epg_binding WHERE media_id = ?').get('m-chan')).toEqual(rowAfterSave);

    // 解除(auto v2)后,旧 version0 的保存请求仍 409 且墓碑不变
    expect((await putBinding(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, expectedVersion: 1, mode: 'auto' })).status).toBe(200);
    const tombstone = Database.db.prepare('SELECT * FROM manual_epg_binding WHERE media_id = ?').get('m-chan');
    const lateZero = await putBinding(f, 'm-chan', manualSaveBody({ expectedVersion: 0 }));
    expect(lateZero.status).toBe(409);
    expect(lateZero.body.code).toBe('EPG_BINDING_VERSION_CONFLICT');
    expect(Database.db.prepare('SELECT * FROM manual_epg_binding WHERE media_id = ?').get('m-chan')).toEqual(tombstone);
  });

  it('两个并发保存(同 expectedVersion 先后到达):一 200 一 409,版本防护不产生双写', async () => {
    const first = putBinding(f, 'm-chan', manualSaveBody());
    const second = putBinding(f, 'm-chan', manualSaveBody());
    const [left, right] = await Promise.all([first, second]);
    const statuses = [left.status, right.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect((left.status === 409 ? left : right).body.code).toBe('EPG_BINDING_VERSION_CONFLICT');
    expect((Database.db.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number }).n).toBe(1);
  });

  it('候选查询后 EPG generation 变化 → 409 EPG_CANDIDATE_STALE,原配置不变(要求重查候选)', async () => {
    const candidates = await queryCandidates(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, epgSourceId: 'src-epg-a' });
    expect(candidates.status).toBe(200);
    const generation = (candidates.body as { epgGeneration: number }).epgGeneration;
    expect(generation).toBe(3);

    // 模拟候选查询后 EPG 又成功发布
    Database.db.prepare('UPDATE media_source SET epg_generation = 4 WHERE id = ?').run('src-epg-a');
    const stale = await putBinding(f, 'm-chan', manualSaveBody({ expectedEpgGeneration: generation }));
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('EPG_CANDIDATE_STALE');
    expect(Database.db.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number }).toEqual({ n: 0 });

    // 重新查询候选后以新 generation 保存成功
    const fresh = await putBinding(f, 'm-chan', manualSaveBody({ expectedEpgGeneration: 4 }));
    expect(fresh.status).toBe(200);
    expect(fresh.body.version).toBe(1);
  });

  it('禁用源新绑定 → 422;冲突候选 → 422 EPG_CANDIDATE_INVALID;不存在频道 → 422 EPG_CANDIDATE_INVALID', async () => {
    const disabled = await putBinding(f, 'm-chan', manualSaveBody({ epgSourceId: 'src-epg-off', xmltvChannelId: 'off-1', expectedEpgGeneration: 0 }));
    expect(disabled.status).toBe(422);

    const conflict = await putBinding(f, 'm-chan', manualSaveBody({ xmltvChannelId: 'cctv-conflict' }));
    expect(conflict.status).toBe(422);
    expect(conflict.body.code).toBe('EPG_CANDIDATE_INVALID');

    const missing = await putBinding(f, 'm-chan', manualSaveBody({ xmltvChannelId: 'no-such-channel' }));
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('EPG_CANDIDATE_INVALID');
  });

  it('跨家庭来源保存 → 404 同形;auto 解除携带目标字段 → 400 VALIDATION_FAILED', async () => {
    const foreign = await putBinding(f, 'm-chan', manualSaveBody({ epgSourceId: 'src-foreign-epg', expectedEpgGeneration: 1 }));
    expect(foreign.status).toBe(404);
    expectProblemContentType(foreign);
    expect(foreign.body.code).toBe(ProblemCode.NOT_FOUND);

    const autoWithTarget = await putBinding(f, 'm-chan', {
      ownerPassword: OWNER_PASSWORD,
      expectedVersion: 0,
      mode: 'auto',
      xmltvChannelId: 'cctv-2',
    });
    expect(autoWithTarget.status).toBe(400);
    expect(autoWithTarget.body.code).toBe(ProblemCode.VALIDATION_FAILED);
  });
});

describe('POST /catalog/media/{mediaId}/epg-candidates/query(候选搜索,quickstart H5)', () => {
  afterEach(cleanupRigs);
  let f: BindingFixture;
  beforeEach(async () => {
    f = await setupBindingRig();
  });

  it('owner+密码:200 {items,total,page,pageSize,epgGeneration};排除 conflicted;候选无源地址/凭据;current/next 结构', async () => {
    const res = await queryCandidates(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, epgSourceId: 'src-epg-a' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as {
      items: Array<{ xmltvChannelId: string; displayName: string; current: unknown; next: unknown }>;
      total: number;
      page: number;
      pageSize: number;
      epgGeneration: number;
    };
    expect(body.epgGeneration).toBe(3);
    expect(body.total).toBe(2); // cctv-conflict 被排除
    expect(body.items.map((item) => item.xmltvChannelId).sort()).toEqual(['cctv-1', 'cctv-2']);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['current', 'displayName', 'next', 'xmltvChannelId'].sort());
    }
    const withProgramme = body.items.find((item) => item.xmltvChannelId === 'cctv-1');
    expect(withProgramme?.current).toMatchObject({ title: '当前节目' });
    expect(withProgramme?.next).toMatchObject({ title: '下一节目' });
    for (const fragment of FORBIDDEN_LEAK_FRAGMENTS) {
      expect(res.text).not.toContain(fragment);
    }

    // q 过滤 + 分页参数回显
    const filtered = await queryCandidates(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, epgSourceId: 'src-epg-a', q: '二套' });
    expect(filtered.status).toBe(200);
    expect((filtered.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('缺密码 → 403;跨家庭来源 → 404 同形;iptv 来源作为候选来源 → 422 EPG_SOURCE_NOT_READY', async () => {
    const missing = await queryCandidates(f, 'm-chan', { epgSourceId: 'src-epg-a' });
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe(ProblemCode.PARENT_VERIFICATION_REQUIRED);

    const foreign = await queryCandidates(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, epgSourceId: 'src-foreign-epg' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe(ProblemCode.NOT_FOUND);

    const iptv = await queryCandidates(f, 'm-chan', { ownerPassword: OWNER_PASSWORD, epgSourceId: 'src-iptv' });
    expect(iptv.status).toBe(422);
    expect(iptv.body.code).toBe('EPG_SOURCE_NOT_READY');
  });
});
