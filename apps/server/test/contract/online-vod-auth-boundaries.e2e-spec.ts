import 'reflect-metadata';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import { deviceSession } from '@platform/database/schema';
import { registerPersonalPlaybackFactsPort } from '@contexts/personal-data/application/progress-clock.service';
import {
  cleanupRigs,
  cookiePairOf,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
  type TestRig,
} from '../helpers';
import {
  createProfileViaSettings,
  selectMainAndUnlockSettings,
} from '../helpers-management';
import {
  seedPersonalWorld,
  seedPlaybackSessionRow,
  seedProgressState,
  type PersonalWorld,
} from '../unit/personal/personal-world';
import {
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../fixtures/playback';

/**
 * T021(010-online-vod · Phase 2 收尾,测试先行):真实装配下的授权边界 e2e ——
 * Public / Settings / Profile 三层边界、CSRF/同源、未知字段、私有地址白名单、
 * A→B→A、过期 grant/错误密码、内网拒绝与播放面既有鉴权回归。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §0(认证/授权/CSRF/16KiB/私有 opaque
 *   ref/公共读取不根据 cookie 过滤)、§2(Settings 及公共接口授权列)、§3(物化与个人
 *   接口 Profile 鉴权)、§4(resolve/progress 既有鉴权继承)、§6(同形/泄露口径);
 * - docs/specs/010-online-vod/contracts/openapi.yaml securitySchemes
 *   (SessionCookie=hmp_session / SessionBearer,写操作继承 005 同源 Origin/CSRF/JSON);
 * - docs/specs/010-online-vod/tasks.md T021 条目(依赖 T016/T017/T018/T020 已落地)。
 *
 * 装配方式(完全沿用既有 contract rig 惯例,不改共享 rig/helpers/fixtures):
 * - Nest TestingModule 真实装配 AppModule + Supertest 真实 HTTP
 *   (startFreshApp:os.tmpdir 随机 DATA_DIR + 按迁移目录序应用全部权威 DDL,
 *   目录已含 0007_online_vod,010 表随全量迁移就绪 —— 与 playback-authorization 等
 *   最新 contract rig 同源,无需本文件自建迁移逻辑);
 * - 身份世界三套按段复用:B/C 段 initialize+login(+selectMainAndUnlockSettings)
 *   的 Settings rig(同 settings-management-negative);A/D3/D4 段 seedPlaybackWorld
 *   (同 playback-authorization);D1/D2/E 段 seedPersonalWorld(同 me-personal/T092);
 * - DB 直改仅用于无 HTTP 语义的工厂事实(grant 过期/会话过期/清空当前档案/
 *   种子播放会话),逐处注明,与既有 rig 口径一致。
 *
 * ───────────────────────── 计划内红清单(失败不跳过)─────────────────────────
 * T021 要求「暂未实现端点的用例须失败不跳过,按故事补绿,不伪称全量通过」。
 * 以下用例钉 010 契约目标面,当前因端点/分支未装配而失败,失败原因均为
 * 「路由 404(Nest Cannot GET 缺省形态)」或「kind=vod 被 schema 枚举先拒(400)」:
 *
 * | 用例 | 端点/分支                    | 当前失败形态            | 转绿任务              |
 * | ---- | ---------------------------- | ----------------------- | --------------------- |
 * | A3   | GET /api/public/vod/search   | 404 路由未装配          | T028(search.service)+ T031(controller 装配) |
 * | A4   | GET /api/public/vod/titles/:ref | 404 路由未装配(Nest Cannot GET) | T028 + T031 |
 * | B7   | POST /settings/sources kind=vod(合法 201;缺 remoteUrl 400) | 400 枚举先拒 | T026(sources.service vod 分支) |
 * | C3   | POST /settings/sources kind=vod remoteUrl=内网 → 422 | 400 枚举先拒 | T026 |
 *
 * 其余用例(B/C 的既有 Settings 面、D 的身份/会话面、E 的播放面)在既有实现上
 * 全绿,作为 010 增量落地不得回归的负向基线。
 */

/* ------------------------------------------------------------------ */
/* 通用助手                                                            */
/* ------------------------------------------------------------------ */

function cookieOf(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 同形断言:两响应 problem 体逐字段一致(码与体结构一致,不可区分存在性) */
function expectSameProblemShape(a: request.Response, b: request.Response): void {
  expect(a.body).toEqual(b.body);
}

/** 公共/个人响应内不得出现的个人痕迹词面(api.md §0「无个人信息」探针) */
const PERSONAL_MARKERS = [
  'profileId',
  'accountId',
  'householdId',
  'sessionToken',
  'pinHash',
  'favorites',
  'positionSeconds',
  'resumePosition',
  'ticket=',
] as const;

function expectNoPersonalMarkers(res: request.Response, label: string): void {
  const serialized = JSON.stringify(res.body) ?? '';
  for (const marker of PERSONAL_MARKERS) {
    expect(serialized, `${label} 不得包含个人痕迹「${marker}」`).not.toContain(marker);
  }
}

/* ------------------------------------------------------------------ */
/* Settings rig(B/C 段:initialize + login + 主档案解锁)               */
/* ------------------------------------------------------------------ */

interface SettingsRig {
  app: INestApplication;
  cookie: string;
}

async function settingsRig(prefix: string, env?: Record<string, string>): Promise<SettingsRig> {
  const fresh = await startFreshApp({ prefix, env });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  return { app: fresh.app, cookie: cookiePairOf(loggedIn) };
}

/** POST /api/settings/sources(api.md §2:Settings + 当次密码;kind/remoteUrl 严格入参) */
function postSource(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/settings/sources').set('Cookie', cookie).send(body);
}

/** 合法公网 IPTV 代表体(创建对照/守卫通过面;不触发任何上游 IO) */
function publicIptvBody(ownerPassword?: string): Record<string, unknown> {
  return {
    kind: 'iptv',
    name: '夹具公网IPTV',
    remoteUrl: 'http://cms.example.com/api.php?ac=list',
    ...(ownerPassword === undefined ? {} : { ownerPassword }),
  };
}

/** 合法 vod 代表体(api.md §2:kind=vod 必须携带非空 remoteUrl;adapter=apple-cms-json) */
function publicVodBody(ownerPassword?: string): Record<string, unknown> {
  return {
    kind: 'vod',
    name: '在线片源',
    remoteUrl: 'http://cms.example.com/api.php?ac=detail',
    adapter: 'apple-cms-json',
    ...(ownerPassword === undefined ? {} : { ownerPassword }),
  };
}

/* ------------------------------------------------------------------ */
/* A 公共边界(游客)                                                    */
/* ------------------------------------------------------------------ */

describe('T021 · A 公共边界(游客)', () => {
  afterEach(cleanupRigs);

  it('A1 游客 GET /api/public/media:200 可用,无个人字段/凭据痕迹(010 物化父项落地后同界)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t021-a1-' });
    const world = await seedWorld(rig, { username: 'public-owner' });

    const res = await request(rig.app.getHttpServer()).get('/api/public/media');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const page = res.body as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(page.items)).toBe(true);
    // 夹具启用 IPTV(present=1 × 启用源)应进入公共目录
    expect(page.items.some((item) => item['id'] === world.iptv.mediaId), '启用源频道应公共可见').toBe(true);
    for (const item of page.items) {
      expect(typeof item['id']).toBe('string');
      expect(typeof item['title']).toBe('string');
      expect(typeof item['type']).toBe('string');
    }
    expectNoPersonalMarkers(res, '公共 media 列表');
  });

  it('A2 公共读取不根据 cookie 过滤内容,也不设置身份 cookie(带/不带会话响应一致)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t021-a2-' });
    const world = await seedWorld(rig, { username: 'cookie-owner' });
    const guest = await request(rig.app.getHttpServer()).get('/api/public/media');
    const authed = await request(rig.app.getHttpServer())
      .get('/api/public/media')
      .set('Cookie', cookieOf(world.sessionToken));
    expect(guest.status).toBe(200);
    expect(authed.status).toBe(200);
    // 同一家庭同一目录:携带身份 Cookie 不增不减不过滤任何条目
    expect(authed.body).toEqual(guest.body);
    // 公共读取不设置身份 cookie(api.md §0)
    expect(authed.headers['set-cookie']).toBeUndefined();
  });

  it('A3 [计划内红·待 T028/T031 转绿] 游客 GET /api/public/vod/search:契约应答(SearchPage 200 或无可用源 502/504),当前 404 路由未装配', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t021-a3-' });
    const res = await request(rig.app.getHttpServer()).get('/api/public/vod/search').query({ q: '星球' });
    expectProblemContentType(res);
    expect(res.headers['cache-control']).toBe('no-store');
    // 转绿后:无源/全失败/超时分别 502/504(api.md §2/§6),有源 200 SearchPage;
    // 当前路由未装配 → Nest 缺省 404 NOT_FOUND,本断言以计划内红钉住「端点必须存在且按契约应答」。
    expect(
      [200, 502, 504],
      `计划内红(待 T028/T031 转绿):GET /api/public/vod/search 尚未装配(当前 ${res.status} ${String(res.body.code)});` +
        'T028 search.service + T031 public-vod.controller 落地后应返回 200 SearchPage 或契约性 502/504',
    ).toContain(res.status);
    if (res.status === 200) {
      const body = res.body as Record<string, unknown>;
      expect(Array.isArray(body['items'])).toBe(true);
      expect(typeof body['searchId']).toBe('string');
      // SearchPage 为公共投影:无个人字段、无源内部 ID/地址
      expectNoPersonalMarkers(res, 'SearchPage');
    }
  });

  it('A4 [计划内红·待 T028/T031 转绿] 游客 GET /api/public/vod/titles/:ref:必须是域级契约端点(伪造 ref 404/失效 410),当前为路由级缺省 404', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t021-a4-' });
    const titleRef = `vod-title-${randomUUID()}`;
    const res = await request(rig.app.getHttpServer()).get(`/api/public/vod/titles/${encodeURIComponent(titleRef)}`);
    expectProblemContentType(res);
    expect(res.headers['cache-control']).toBe('no-store');
    expect([404, 410], '伪造 ref → 404 / 失效 ref → 410(api.md §2)').toContain(res.status);
    // 计划内红判据:当前 404 是 Nest 路由缺省形态(detail「Cannot GET …」),
    // 说明端点未装配;转绿后同一路径的 404/410 必须是域级 problem(detail 为领域短语)。
    const detail = typeof res.body.detail === 'string' ? res.body.detail : '';
    expect(
      detail,
      `计划内红(待 T028/T031 转绿):GET /api/public/vod/titles/:ref 为路由级缺省 404(${detail || '无 detail'})` +
        '——T028 preview.service + T031 public-vod.controller 装配后应为域级问题体',
    ).not.toContain('Cannot GET');
    // 域级应答(含伪造 404)同样无个人痕迹/无源位置
    expectNoPersonalMarkers(res, 'VodPreview 问题体');
  });
});

/* ------------------------------------------------------------------ */
/* B Settings 边界(来源管理;既有 Settings 面回归 + vod 计划内红)        */
/* ------------------------------------------------------------------ */

describe('T021 · B Settings 边界(来源管理)', () => {
  afterEach(cleanupRigs);

  it('B1 游客 401 先于一切 403;已登录未解锁(grant 缺失)→ 403 SETTINGS_ACCESS_REQUIRED(读/写同界)', async () => {
    const { app } = await settingsRig('hmp-t021-b1-');
    const guestGet = await request(app.getHttpServer()).get('/api/settings/sources');
    expectProblem(guestGet, 401, ProblemCode.SESSION_INVALID);
    const guestPost = await postSource(app, '', publicIptvBody('password-123'));
    expectProblem(guestPost, 401, ProblemCode.SESSION_INVALID);

    const loggedIn = await login(app, 'admin', 'password-123');
    const locked = cookiePairOf(loggedIn);
    const readDenied = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', locked);
    expectProblem(readDenied, 403, 'SETTINGS_ACCESS_REQUIRED');
    const writeDenied = await postSource(app, locked, publicIptvBody('password-123'));
    expectProblem(writeDenied, 403, 'SETTINGS_ACCESS_REQUIRED');
  });

  it('B2 非管理员主体(普通档案选中,非主档案)→ GET/POST 来源均 403 SETTINGS_ACCESS_REQUIRED,不当次放行', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-b2-');
    await selectMainAndUnlockSettings(app, cookie);
    const created = await createProfileViaSettings(app, cookie, { name: '儿童', type: 'child', pin: '246800' });
    expect(created.status).toBe(201);
    const unlock = await request(app.getHttpServer())
      .post(`/api/profiles/${(created.body as { id: string }).id}/unlock`)
      .set('Cookie', cookie)
      .send({ pin: '246800' });
    expect(unlock.status).toBe(200);
    const select = await request(app.getHttpServer())
      .post(`/api/profiles/${(created.body as { id: string }).id}/select`)
      .set('Cookie', cookie)
      .send({});
    expect(select.status).toBe(200);

    const readDenied = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expectProblem(readDenied, 403, 'SETTINGS_ACCESS_REQUIRED');
    const writeDenied = await postSource(app, cookie, publicIptvBody('password-123'));
    expectProblem(writeDenied, 403, 'SETTINGS_ACCESS_REQUIRED');
  });

  it('B3 缺当次密码 → 403 PARENT_VERIFICATION_REQUIRED;错误密码 → 403 PARENT_VERIFICATION_FAILED;正确密码 201 对照', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-b3-');
    await selectMainAndUnlockSettings(app, cookie);
    const missing = await postSource(app, cookie, publicIptvBody());
    expectProblem(missing, 403, ProblemCode.PARENT_VERIFICATION_REQUIRED);
    const wrong = await postSource(app, cookie, publicIptvBody('definitely-wrong'));
    expectProblem(wrong, 403, ProblemCode.PARENT_VERIFICATION_FAILED);
    // 密码拒绝路径零副作用:拒绝后正确创建仍 201,且来源表无错误尝试残留
    const ok = await postSource(app, cookie, publicIptvBody('password-123'));
    expect(ok.status).toBe(201);
    const list = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expect(list.status).toBe(200);
    expect((list.body as { total: number }).total).toBe(1);
  });

  it('B4 过期 grant(DB 直改 expires_at 到过去)→ 写/读均 403 SETTINGS_ACCESS_EXPIRED(固定 TTL 不滑动)', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-b4-');
    await selectMainAndUnlockSettings(app, cookie);
    const okBefore = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expect(okBefore.status).toBe(200);
    // DB 直改注明:签发/到期整体平移到过去(满足 CHECK),等价 15 分钟固定 TTL 自然过期
    Database.db
      .prepare(
        "UPDATE settings_access_grant SET issued_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:15:00.000Z'",
      )
      .run();
    const expiredWrite = await postSource(app, cookie, publicIptvBody('password-123'));
    expectProblem(expiredWrite, 403, 'SETTINGS_ACCESS_EXPIRED');
    const expiredRead = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expectProblem(expiredRead, 403, 'SETTINGS_ACCESS_EXPIRED');
  });

  it('B5 CSRF/同源:未配置许可 origin 时携带 Origin 一律 403(fail-closed);配置后跨源 403、同源放行、非 JSON 表单体 400', async () => {
    // 形态 1:未配置 PUBLIC_ORIGIN(缺省)→ fail-closed
    const closed = await settingsRig('hmp-t021-b5a-');
    const failClosed = await request(closed.app.getHttpServer())
      .post('/api/settings/sources')
      .set('Cookie', closed.cookie)
      .set('Origin', 'https://evil.example')
      .send(publicIptvBody('password-123'));
    expectProblem(failClosed, 403, ProblemCode.FORBIDDEN);

    // 形态 2:配置 PUBLIC_ORIGIN → 跨源 403;非 JSON 简单表单 400;同源放行(创建 201)
    const configured = await settingsRig('hmp-t021-b5b-', { PUBLIC_ORIGIN: 'http://home.local:3000' });
    await selectMainAndUnlockSettings(configured.app, configured.cookie);
    const crossOrigin = await request(configured.app.getHttpServer())
      .post('/api/settings/sources')
      .set('Cookie', configured.cookie)
      .set('Origin', 'https://evil.example')
      .send(publicIptvBody('password-123'));
    expectProblem(crossOrigin, 403, ProblemCode.FORBIDDEN);
    const formPost = await request(configured.app.getHttpServer())
      .post('/api/settings/sources')
      .set('Cookie', configured.cookie)
      .set('Origin', 'http://home.local:3000')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('kind=iptv&name=form');
    expectProblem(formPost, 400, ProblemCode.VALIDATION_FAILED);
    const sameOrigin = await request(configured.app.getHttpServer())
      .post('/api/settings/sources')
      .set('Cookie', configured.cookie)
      .set('Origin', 'http://home.local:3000')
      .send(publicIptvBody('password-123'));
    expect(sameOrigin.status, '同源 Origin + JSON 体 + 有效凭据应通过守卫创建').toBe(201);
  });

  it('B6 未知字段 body 一律 400(含伪造 profileId —— 身份只从 Session 推导,不收任何身份声明字段)', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-b6-');
    await selectMainAndUnlockSettings(app, cookie);
    for (const extra of [{ profileId: randomUUID() }, { householdId: randomUUID() }, { upstreamVodId: 'x-1' }]) {
      const res = await postSource(app, cookie, { ...publicIptvBody('password-123'), ...extra });
      expectProblem(res, 400, ProblemCode.VALIDATION_FAILED);
      const detail = typeof res.body.detail === 'string' ? res.body.detail : '';
      expect(detail, `detail 应指向未知键 ${Object.keys(extra).join(',')}`).toContain(Object.keys(extra)[0] ?? '');
    }
    const list = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expect((list.body as { total: number }).total, '全部 400,零创建').toBe(0);
  });

  it('B7 [计划内红·待 T026 转绿] kind=vod 来源:合法创建 201;缺 remoteUrl → 400(api.md §2「vod 必须 remote_url 非空」)', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-b7-');
    await selectMainAndUnlockSettings(app, cookie);
    // 计划内红判据 1:合法 vod 创建当前被 schema 枚举先拒(kind 枚举 iptv/epg/nas → 400),
    // T026 sources.service vod 分支落地后应 201(限 10 启用源内)。
    const created = await postSource(app, cookie, publicVodBody('password-123'));
    expect(
      created.status,
      `计划内红(待 T026 转绿):kind=vod 创建尚未实现(当前 ${created.status} ${String(created.body.code)},` +
        'schema 枚举先拒)——T026 落地后应为 201 SourceDto(kind=vod + capabilities)',
    ).toBe(201);
    expect((created.body as Record<string, unknown>)['kind']).toBe('vod');
    // 计划内红判据 2(转绿后生效):kind=vod 缺 remoteUrl → 400 VALIDATION_FAILED。
    const missingUrl = await postSource(app, cookie, {
      kind: 'vod',
      name: '缺地址片源',
      adapter: 'apple-cms-json',
      ownerPassword: 'password-123',
    });
    expectProblem(missingUrl, 400, ProblemCode.VALIDATION_FAILED);
  });
});

/* ------------------------------------------------------------------ */
/* C 私有地址白名单(SSRF 负向;既有 IPTV/NAS 同路径 + vod 计划内红)      */
/* ------------------------------------------------------------------ */

describe('T021 · C 私有地址白名单(SSRF 负向)', () => {
  afterEach(cleanupRigs);

  it('C1 既有远程源同路径:环回/链路本地/云元数据/未指定地址 → 422 SOURCE_TARGET_DENIED,且不回显 URL 原文', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-c1-');
    await selectMainAndUnlockSettings(app, cookie);
    const privateTargets = [
      'http://127.0.0.1:8123/api.php',
      'http://[::1]:8123/api.php',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0:8000/api.php',
    ];
    for (const target of privateTargets) {
      const res = await postSource(app, cookie, { kind: 'iptv', name: '内网探针', remoteUrl: target, ownerPassword: 'password-123' });
      expectProblem(res, 422, 'SOURCE_TARGET_DENIED');
      // 凭据脱敏:拒绝 detail 为稳定类别短语,不回显地址原文(sources 领域惯例)
      expect(JSON.stringify(res.body), `拒绝体不得回显目标原文 ${target}`).not.toContain(target);
    }
    const list = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expect((list.body as { total: number }).total, '全部拒绝,零创建').toBe(0);
  });

  it('C2 对照:公网 URL 201(拒绝为类别判定而非一律拒);NAS 同路径坏 rootKey / 越界相对目录 → 422', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-c2-');
    await selectMainAndUnlockSettings(app, cookie);
    const okPublic = await postSource(app, cookie, publicIptvBody('password-123'));
    expect(okPublic.status, '公网地址应放行(白名单只拒保留段)').toBe(201);

    const badRoot = await postSource(app, cookie, {
      kind: 'nas',
      name: '越权NAS',
      rootKey: 'not-configured-root',
      relativeDirectory: 'media',
      ownerPassword: 'password-123',
    });
    expectProblem(badRoot, 422, 'SOURCE_TARGET_DENIED');
    const escapeDir = await postSource(app, cookie, {
      kind: 'nas',
      name: '逃逸NAS',
      rootKey: 'playback-fixture-nas',
      relativeDirectory: '../outside',
      ownerPassword: 'password-123',
    });
    expectProblem(escapeDir, 422, 'SOURCE_TARGET_DENIED');
  });

  it('C3 [计划内红·待 T026 转绿] kind=vod remoteUrl 指向内网/环回 → 422 SOURCE_TARGET_DENIED(白名单覆盖 vod 分支)', async () => {
    const { app, cookie } = await settingsRig('hmp-t021-c3-');
    await selectMainAndUnlockSettings(app, cookie);
    const res = await postSource(app, cookie, {
      kind: 'vod',
      name: '内网在线片源',
      remoteUrl: 'http://127.0.0.1:8080/api.php?ac=detail',
      adapter: 'apple-cms-json',
      ownerPassword: 'password-123',
    });
    // 计划内红判据:当前 vod 被 schema 枚举先拒(400 VALIDATION_FAILED),根本未达
    // 目标许可层;T026 落地后同请求必须落「422 SOURCE_TARGET_DENIED」(与 IPTV 同类别判定)。
    expect(
      res.status,
      `计划内红(待 T026 转绿):kind=vod 分支未实现(当前 ${res.status} ${String(res.body.code)},` +
        'schema 枚举先拒,未达目标许可层)——T026 source-target vod 白名单落地后应为 422 SOURCE_TARGET_DENIED',
    ).toBe(422);
    expect(res.body.code).toBe('SOURCE_TARGET_DENIED');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
  });
});

/* ------------------------------------------------------------------ */
/* D1/D2 Profile/身份边界(personal world:双设备双档案)                  */
/* ------------------------------------------------------------------ */

describe('T021 · D Profile 身份边界(/me 语义回归)', () => {
  let rig: TestRig;
  let app: INestApplication;
  let world: PersonalWorld;
  let cookieA: string;
  let cookieB: string;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t021-d-' });
    app = rig.app;
    world = seedPersonalWorld(rig);
    cookieA = cookieOf(world.sessionAToken);
    cookieB = cookieOf(world.sessionBToken);
  });

  afterEach(cleanupRigs);

  it('D1 游客 /api/me/* → 401;无当前 Profile(DB 直清 active_profile_id)→ 403 ACTIVE_PROFILE_REQUIRED', async () => {
    const guestHistory = await request(app.getHttpServer()).get('/api/me/history');
    expectProblem(guestHistory, 401, ProblemCode.SESSION_INVALID);
    const guestFavorites = await request(app.getHttpServer()).get('/api/me/favorites/channels');
    expectProblem(guestFavorites, 401, ProblemCode.SESSION_INVALID);

    // DB 直改注明:清空设备会话当前档案(等价「登录后未选档」态;CurrentProfileGuard 403)
    getDb().update(deviceSession).set({ activeProfileId: null }).where(eq(deviceSession.id, world.deviceSessionAId)).run();
    const noProfileHistory = await request(app.getHttpServer()).get('/api/me/history').set('Cookie', cookieA);
    expectProblem(noProfileHistory, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
    const noProfileFavorites = await request(app.getHttpServer())
      .get('/api/me/favorites/channels')
      .set('Cookie', cookieA);
    expectProblem(noProfileFavorites, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  });

  it('D2 伪造 profileId/householdId(body/query)一律 400 拒绝;身份只从服务端当前 Profile 推导', async () => {
    // body 伪造:PUT 收藏携带 B 档案身份声明 → 400(严格入参),且零写入
    const forgedPut = await request(app.getHttpServer())
      .put(`/api/me/favorites/channels/${world.channel.mediaId}`)
      .set('Cookie', cookieA)
      .send({ profileId: world.profileBId, householdId: 'other-household' });
    expectProblem(forgedPut, 400, ProblemCode.VALIDATION_FAILED);
    // query 伪造:GET 历史携带 profileId → 400(严格 query)
    const forgedQuery = await request(app.getHttpServer())
      .get('/api/me/history')
      .query({ profileId: world.profileBId })
      .set('Cookie', cookieA);
    expectProblem(forgedQuery, 400, ProblemCode.VALIDATION_FAILED);
    // 服务端身份推导不漂移:A 干净写入落在 A;B 列表恒空
    const cleanPut = await request(app.getHttpServer())
      .put(`/api/me/favorites/channels/${world.channel.mediaId}`)
      .set('Cookie', cookieA)
      .send({});
    expect(cleanPut.status).toBe(204);
    const listA = await request(app.getHttpServer()).get('/api/me/favorites/channels').set('Cookie', cookieA);
    expect(listA.status).toBe(200);
    expect((listA.body as { items: unknown[] }).items).toHaveLength(1);
    const listB = await request(app.getHttpServer()).get('/api/me/favorites/channels').set('Cookie', cookieB);
    expect((listB.body as { items: unknown[] }).items).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* D3/D4 A→B→A 与跨设备/过期会话(playback world:同 playback-authorization) */
/* ------------------------------------------------------------------ */

/** seedWorld 句柄:PlaybackWorld + 显式 username(第二设备登录需要;同 playback-authorization 惯例) */
type SeededPlaybackWorld = PlaybackWorld & { readonly username: string };

async function seedWorld(rig: TestRig, options: Parameters<typeof seedPlaybackWorld>[1] = {}): Promise<SeededPlaybackWorld> {
  const username = options.username ?? 'player';
  const world = await seedPlaybackWorld(rig, { ...options, username });
  return { ...world, username };
}

function postSelectProfile(app: INestApplication, cookie: string, profileId: string): request.Test {
  return request(app.getHttpServer()).post(`/api/profiles/${profileId}/select`).set('Cookie', cookie).send({});
}

function postUnlockPin(app: INestApplication, cookie: string, profileId: string, pin: string): request.Test {
  return request(app.getHttpServer()).post(`/api/profiles/${profileId}/unlock`).set('Cookie', cookie).send({ pin });
}

function postResolve(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/playback/resolve').set('Cookie', cookie).send(body);
}

function getSession(app: INestApplication, cookie: string, id: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${id}`).set('Cookie', cookie);
}

function postRenew(app: INestApplication, cookie: string, id: string, expectedGeneration: number): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${id}/renew`)
    .set('Cookie', cookie)
    .send({ expectedGeneration });
}

function postProgress(
  app: INestApplication,
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer()).post(`/api/playback/sessions/${id}/progress`).set('Cookie', cookie).send(body);
}

function sessionRowOf(sessionId: string): { state: string; endedAt: string | null } {
  const row = Database.db
    .prepare('SELECT state, ended_at AS endedAt FROM playback_session WHERE id = ?')
    .get(sessionId) as { state: string; endedAt: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`夹具错误:playback_session ${sessionId} 不存在`);
  }
  return row;
}

describe('T021 · D3/D4 播放上下文归属(A→B→A / 跨设备 / 过期会话)', () => {
  afterEach(cleanupRigs);

  it('D3 A→B→A:切档事务终态化旧上下文播放,切回原档案后旧会话不可复活(404 同形)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t021-d3-' });
    const world = await seedWorld(rig, { username: 'abab-owner' });
    const cookie = cookieOf(world.sessionToken);

    const resolved = await postResolve(rig.app, cookie, { mediaId: world.iptv.mediaId });
    expect(resolved.status, '档案 A 下的 resolve 应 201').toBe(201);
    const sessionId = (resolved.body as Record<string, unknown>)['id'] as string;

    // A→B:解锁并切到 PIN 档案(005 语义:换档事务终态化旧上下文播放)
    expect((await postUnlockPin(rig.app, cookie, world.profileWithPinId, world.pin)).status).toBe(200);
    expect((await postSelectProfile(rig.app, cookie, world.profileWithPinId)).status).toBe(200);
    expectProblem(await getSession(rig.app, cookie, sessionId), 404, ProblemCode.PLAYBACK_NOT_FOUND);

    // B→A:切回原档案;旧会话仍是终态(interrupted),GET/renew 均 404 同形
    expect((await postSelectProfile(rig.app, cookie, world.profileId)).status).toBe(200);
    const staleGet = await getSession(rig.app, cookie, sessionId);
    expectProblem(staleGet, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectProblem(await postRenew(rig.app, cookie, sessionId, 1), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(staleGet, await getSession(rig.app, cookie, randomUUID()));
    const row = sessionRowOf(sessionId);
    expect(row.state).toBe('interrupted');
    expect(row.endedAt).not.toBeNull();
  });

  it('D4 跨设备访问同家庭会话 → 404 PLAYBACK_NOT_FOUND 与不存在同形;过期设备会话 → 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t021-d4-' });
    const world = await seedWorld(rig, { username: 'device-owner' });
    const session = seedPlaybackSession(world, {
      state: 'ready',
      at: new Date().toISOString(),
    });

    // 同账号新登录(另一台设备)选同一档案 → 非「本设备」会话 404,与随机 id 同形
    const secondLogin = await login(rig.app, world.username, world.password);
    expect(secondLogin.status).toBe(200);
    const cookieB = cookiePairOf(secondLogin);
    expect((await postSelectProfile(rig.app, cookieB, world.profileId)).status).toBe(200);
    const crossDevice = await getSession(rig.app, cookieB, session.sessionId);
    expectProblem(crossDevice, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossDevice, await getSession(rig.app, cookieB, randomUUID()));
    // 归属未被越权改变:原设备读取仍 200
    expect((await getSession(rig.app, cookieOf(world.sessionToken), session.sessionId)).status).toBe(200);

    // 过期会话(夹具参数:expires_at 落在过去)→ 下一请求 401 SESSION_INVALID
    const expiredRig = await startFreshApp({ prefix: 'hmp-t021-d4b-' });
    const expiredWorld = await seedWorld(expiredRig, {
      username: 'expired-owner',
      sessionExpiresAt: '2026-10-24T00:00:00.000Z',
    });
    expectProblem(
      await getSession(expiredRig.app, cookieOf(expiredWorld.sessionToken), session.sessionId),
      401,
      ProblemCode.SESSION_INVALID,
    );
    expectProblem(
      await postResolve(expiredRig.app, cookieOf(expiredWorld.sessionToken), { mediaId: expiredWorld.iptv.mediaId }),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });
});

/* ------------------------------------------------------------------ */
/* E 播放面继承(未授权 401 / 跨上下文 404 / 旧请求面回归)               */
/* ------------------------------------------------------------------ */

describe('T021 · E 播放面既有鉴权回归(010 增量不破坏旧语义)', () => {
  let rig: TestRig;
  let app: INestApplication;
  let world: PersonalWorld;
  let cookieA: string;
  let cookieB: string;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t021-e-' });
    app = rig.app;
    world = seedPersonalWorld(rig);
    cookieA = cookieOf(world.sessionAToken);
    cookieB = cookieOf(world.sessionBToken);
    // T092 同款:点播受信时长事实(progress 写入状态机依赖)
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => 3600 });
  });

  afterEach(() => {
    registerPersonalPlaybackFactsPort(null);
    return cleanupRigs();
  });

  /** 点播 playing 会话 + resolve 绑定形态 progress_state(T092 同款种子) */
  function seedPlayingVodSession(): { sessionId: string; generation: number } {
    const handle = seedPlaybackSessionRow({
      householdId: world.householdId,
      deviceSessionId: world.deviceSessionAId,
      deviceId: world.deviceIdA,
      profileId: world.profileAId,
      mediaId: world.vod.mediaId,
      playbackSourceId: world.vod.playbackSourceId,
      state: 'playing',
    });
    seedProgressState({
      householdId: world.householdId,
      playbackSessionId: handle.sessionId,
      profileId: world.profileAId,
      mediaId: world.vod.mediaId,
      candidateEpoch: 1,
      lastGeneration: handle.generation,
    });
    return { sessionId: handle.sessionId, generation: handle.generation };
  }

  it('E1 未授权:resolve/progress 无 Cookie / 伪造 token → 401 SESSION_INVALID(problem+json)', async () => {
    const { sessionId } = seedPlayingVodSession();
    const anonymousResolve = await postResolve(app, '', { mediaId: world.vod.mediaId });
    expectProblem(anonymousResolve, 401, ProblemCode.SESSION_INVALID);
    const anonymousProgress = await postProgress(app, '', sessionId, {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 0,
      reason: 'started',
    });
    expectProblem(anonymousProgress, 401, ProblemCode.SESSION_INVALID);
    const forged = cookieOf('forged-token-not-in-db');
    expectProblem(
      await postResolve(app, forged, { mediaId: world.vod.mediaId }),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });

  it('E2 跨上下文:B 设备会话对 A 的会话 progress → 404 与不存在同形;原设备同载荷 200(旧语义 applied)', async () => {
    const { sessionId, generation } = seedPlayingVodSession();
    const sample = { sampleSeq: 1, expectedGeneration: generation, positionSeconds: 0, reason: 'started' };
    const crossContext = await postProgress(app, cookieB, sessionId, sample);
    expectProblem(crossContext, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossContext, await postProgress(app, cookieB, randomUUID(), sample));
    // 原设备同载荷放行:404 是上下文绑定而非载荷问题(ProgressReply 旧字段语义不变;
    // 010 将追加 sessionAccepted 等字段,故用 toMatchObject 不钉键全集)
    const own = await postProgress(app, cookieA, sessionId, sample);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ applied: true, reason: 'accepted' });
  });

  it('E3 resolve 旧请求面回归:仅 {mediaId} → 201 preparing + Location + no-store(无需任何 010 新字段)', async () => {
    const resolved = await postResolve(app, cookieA, { mediaId: world.vod.mediaId });
    expect(resolved.status).toBe(201);
    expectProblemContentType(resolved);
    const body = resolved.body as Record<string, unknown>;
    expect(typeof body['id']).toBe('string');
    expect(body['state']).toBe('preparing');
    expect(body['generation']).toBe(1);
    const location = String(resolved.headers.location);
    expect(location.startsWith('/api/playback/sessions/')).toBe(true);
    expect(resolved.headers['cache-control']).toBe('no-store');
    // 旧负向面不回归:未知字段仍 400;解析响应不泄漏源内部 ID
    const unknownField = await postResolve(app, cookieA, { mediaId: world.vod.mediaId, profileId: world.profileAId });
    expectProblem(unknownField, 400, ProblemCode.VALIDATION_FAILED);
    expect(JSON.stringify(body)).not.toContain(world.vod.playbackSourceId);
  });
});
