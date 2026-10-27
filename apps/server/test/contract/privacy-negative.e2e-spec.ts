import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '@nestjs/common';
import { SESSION_COOKIE } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import { cleanupRigs, startFreshApp, type TestRig } from '../helpers';
import {
  seedPersonalWorld,
  type PersonalWorld,
} from '../unit/personal/personal-world';

/**
 * T142(005 · 隐私与日志复查 —— 自动化部分;FR-003/FR-033)。
 * 权威:tasks.md T142、spec.md FR-003(公共响应无个人数据)/FR-033(PIN 与密码
 * 不出现在地址、日志、个人缓存或公共响应)/004 R6(日志不落 query ticket/源路径)。
 *
 * 断言清单(全部真实 HTTP 负向探针,非 mock 语义 —— 日志侧经 Nest Logger 静态
 * 路由捕获 plain-object LoggerService,等价拦截器单测,见文件内说明):
 * 1. no-store:公共/个人/设置三类响应成功+错误各抽样,断言 Cache-Control: no-store;
 * 2. FR-003:public context/media(列表+详情)/guide 三端点字段白名单 + 敏感值泄漏探针
 *    (会话令牌/密码哈希/个人字段名/票据);
 * 3. 日志侧:带标记密码的登录失败请求、带标记 PIN 的设置验证失败请求、带标记 ticket 的
 *    请求 URL —— 断言请求日志行仅含 method/路由/状态/耗时,不含上述任何明文值;
 *    ticket 值经 redactQueryTicket 落为 '[REDACTED]'。
 *
 * 既有等效能力引用(本套件不重复其单元口径,报告注明):
 * - apps/server/test/unit/log-redaction.spec.ts:redactForLog 敏感键(含 password/pin/token)
 *   脱敏、redactQueryTicket 票据闸、redactSourcePaths 源路径占位、summarizeFfmpegStderr;
 * - apps/server/test/contract/public-browse-negative.e2e-spec.ts:公共错误响应 no-store
 *   与内部策略/源位置泄漏探针(FORBIDDEN_ERROR_FRAGMENTS)。
 *
 * 范围口径(报告注明):当前请求日志字段为 method/URL(模板路由)/状态/耗时;
 * requestId、响应字节、批量查询数字段尚未在 LoggingInterceptor 实现,T142 日志字段
 * 完整性留待 lead 层跟进;真实抓包(Network 层人工证据)留待 T144 人工核对。
 */

function cookieOf(world: PersonalWorld): string {
  return `${SESSION_COOKIE}=${world.sessionAToken}`;
}

/* ------------------------------------------------------------------ */
/* 1) no-store 三类响应(成功 + 错误)                                  */
/* ------------------------------------------------------------------ */

describe('T142 · Cache-Control: no-store(公共/个人/设置,成功+错误)', () => {
  let rig: TestRig;
  let app: INestApplication;
  let world: PersonalWorld;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t142-nostore-' });
    app = rig.app;
    world = seedPersonalWorld(rig);
  });

  afterEach(() => cleanupRigs());

  it('公共:成功(context 200)与错误(media 详情 404)均 no-store', async () => {
    const ok = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/context');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const missing = await request(app.getHttpServer() as Parameters<typeof request>[0]).get(
      '/api/public/media/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.status).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(String(missing.headers['content-type'])).toContain('application/problem+json');
  });

  it('个人:成功(favorites 200)与错误(匿名 401)均 no-store', async () => {
    const ok = await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get('/api/me/favorites/channels')
      .set('Cookie', cookieOf(world));
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const anonymous = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/me/favorites/channels');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['cache-control']).toBe('no-store');
  });

  it('设置:成功(access 状态 200)与错误(未解锁管理读 403)均 no-store', async () => {
    const ok = await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get('/api/settings/access')
      .set('Cookie', cookieOf(world));
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const denied = await request(app.getHttpServer() as Parameters<typeof request>[0])
      .get('/api/settings/sources')
      .set('Cookie', cookieOf(world));
    expect(denied.status).toBe(403);
    expect(denied.headers['cache-control']).toBe('no-store');
  });
});

/* ------------------------------------------------------------------ */
/* 2) FR-003:公共响应无 Profile 个人数据(白名单 + 泄漏探针)           */
/* ------------------------------------------------------------------ */

const CONTEXT_KEYS = ['initialized', 'displayName', 'language', 'timezone', 'now', 'catalogRevision'] as const;
const PUBLIC_MEDIA_KEYS = ['id', 'type', 'title', 'description', 'posterRef', 'contentLevel', 'availability'] as const;
const GUIDE_WINDOW_KEYS = [
  'date',
  'timezone',
  'now',
  'allowedDates',
  'from',
  'to',
  'page',
  'pageSize',
  'totalChannels',
  'catalogRevision',
  'channels',
] as const;
const GUIDE_CHANNEL_KEYS = ['media', 'programmes'] as const;
const PROGRAMME_KEYS = ['key', 'title', 'description', 'startsAt', 'endsAt'] as const;

function expectKeysWithin(body: unknown, whitelist: readonly string[], label: string): void {
  const keys = Object.keys(body as Record<string, unknown>);
  const illegal = keys.filter((key) => !whitelist.includes(key));
  expect(illegal, `${label} 出现白名单外字段:${illegal.join(',')}`).toEqual([]);
}

describe('T142 · 公共响应无 Profile 个人数据(FR-003,context/media/guide)', () => {
  let rig: TestRig;
  let app: INestApplication;
  let world: PersonalWorld;
  /** 个人事实已存在(收藏/选档)后的公共投影仍须零个人数据 */
  const secretValues: string[] = [];

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t142-public-' });
    app = rig.app;
    world = seedPersonalWorld(rig);
    secretValues.length = 0;
    secretValues.push(world.sessionAToken, 'x-not-verified');
    // 制造真实个人事实:选档 + 收藏(此后公共响应不得携带任何个人痕迹)
    expect(
      (await request(app.getHttpServer()).post(`/api/profiles/${world.profileAId}/select`).set('Cookie', cookieOf(world)).send({})).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .put(`/api/me/favorites/channels/${world.channel.mediaId}`)
          .set('Cookie', cookieOf(world))
          .send({})
      ).status,
    ).toBe(204);
  });

  afterEach(() => cleanupRigs());

  it('context:键白名单,无个人字段/会话令牌/凭据痕迹', async () => {
    const res = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/context');
    expect(res.status).toBe(200);
    expectKeysWithin(res.body, CONTEXT_KEYS, 'context');
    const serialized = JSON.stringify(res.body) ?? '';
    for (const secret of [...secretValues, 'password', 'pinHash', 'profileId', 'accountId', 'sessionToken', 'favorites', 'positionSeconds']) {
      expect(serialized, `context 不得包含「${secret}」`).not.toContain(secret);
    }
  });

  it('media 列表与详情:条目键白名单,无个人字段/凭据哈希/票据', async () => {
    const list = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/media?pageSize=50');
    expect(list.status).toBe(200);
    const page = list.body as { items: Array<Record<string, unknown>> };
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expectKeysWithin(item, PUBLIC_MEDIA_KEYS, 'media item');
    }
    const serialized = JSON.stringify(list.body) ?? '';
    for (const secret of [...secretValues, 'pinHash', 'profileId', 'favorites', 'history', 'positionSeconds', 'ticket=', 'resumePosition']) {
      expect(serialized, `media 列表不得包含「${secret}」`).not.toContain(secret);
    }

    const detail = await request(app.getHttpServer() as Parameters<typeof request>[0]).get(`/api/public/media/${world.channel.mediaId}`);
    expect(detail.status).toBe(200);
    expectKeysWithin(detail.body, PUBLIC_MEDIA_KEYS, 'media detail');
    const detailSerialized = JSON.stringify(detail.body) ?? '';
    for (const secret of [...secretValues, 'pinHash', 'profileId', 'favorites', 'positionSeconds']) {
      expect(detailSerialized, `media 详情不得包含「${secret}」`).not.toContain(secret);
    }
  });

  it('guide:窗口/频道/节目键白名单,无个人字段(已选档+已收藏事实存在)', async () => {
    const res = await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/guide?pageSize=5');
    expect(res.status).toBe(200);
    const window = res.body as {
      channels: Array<{ media: Record<string, unknown>; programmes: Array<Record<string, unknown>> }>;
    };
    expectKeysWithin(res.body, GUIDE_WINDOW_KEYS, 'guide window');
    for (const channel of window.channels) {
      expectKeysWithin(channel, GUIDE_CHANNEL_KEYS, 'guide channel');
      expectKeysWithin(channel.media, PUBLIC_MEDIA_KEYS, 'guide channel.media');
      for (const programme of channel.programmes) {
        expectKeysWithin(programme, PROGRAMME_KEYS, 'guide programme');
      }
    }
    const serialized = JSON.stringify(res.body) ?? '';
    for (const secret of [...secretValues, 'pinHash', 'profileId', 'favorites', 'history', 'positionSeconds', 'ticket=']) {
      expect(serialized, `guide 不得包含「${secret}」`).not.toContain(secret);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3) 日志侧断言(拦截器级;Logger 静态路由捕获)                        */
/* ------------------------------------------------------------------ */

describe('T142 · 请求日志仅含 method/路由/状态/耗时,凭据/PIN/票据明文为 0', () => {
  let rig: TestRig;
  let app: INestApplication;
  let world: PersonalWorld;
  const captured: string[] = [];

  const PASSWORD_MARKER = 'WrongPassword-Marker-9d2f';
  const PIN_MARKER = '990877';
  const TICKET_MARKER = 'TOPSECRETTICKETVALUE';

  /**
   * plain-object LoggerService:Logger 实例日志(localInstance 路由)不经级别过滤,
   * 等价「拦截器单测」的输出捕获面。必须在每次 startFreshApp 之后接管 ——
   * createNestApplication({logger:['warn','error']}) 会在启动期重设 Logger 级别/
   * 静态引用,先 override 会被启动配置覆盖(实测行为);随后以数组级 override 把
   * 级别放开到全量,避免 info 级访问行被夹具默认 ['warn','error'] 过滤。
   */
  function captureServerLogs(): void {
    Logger.overrideLogger(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']);
    Logger.overrideLogger({
      log: (message: unknown, ...rest: unknown[]) => captured.push(`LOG ${String(message)} ${rest.filter(Boolean).join(' ')}`),
      error: (message: unknown, ...rest: unknown[]) => captured.push(`ERR ${String(message)} ${rest.filter(Boolean).join(' ')}`),
      warn: (message: unknown, ...rest: unknown[]) => captured.push(`WARN ${String(message)} ${rest.filter(Boolean).join(' ')}`),
      debug: (message: unknown, ...rest: unknown[]) => captured.push(`DBG ${String(message)} ${rest.filter(Boolean).join(' ')}`),
      verbose: (message: unknown, ...rest: unknown[]) => captured.push(`VRB ${String(message)} ${rest.filter(Boolean).join(' ')}`),
      fatal: (message: unknown, ...rest: unknown[]) => captured.push(`FATL ${String(message)} ${rest.filter(Boolean).join(' ')}`),
    });
  }

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t142-log-' });
    app = rig.app;
    world = seedPersonalWorld(rig);
    captureServerLogs();
    captured.length = 0;
  });

  afterEach(() => cleanupRigs());

  it('带密码的登录失败请求:日志不含密码明文,行形态仅 method/路由/状态/耗时', async () => {
    // 种子世界账号 passwordHash 非真实 argon2 哈希(直接验会 500),统一失败语义走
    // 「未知用户名」路径:凭据(含标记密码)同样进入登录失败管线,401 统一拒绝
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'no-such-user', password: PASSWORD_MARKER });
    expect(res.status).toBe(401);

    const loginLines = captured.filter((line) => line.includes('/api/auth/login'));
    expect(loginLines.length, `登录请求应留有访问日志:${captured.join(' || ')}`).toBeGreaterThan(0);
    for (const line of loginLines) {
      expect(line, `访问日志不得包含密码明文:${line}`).not.toContain(PASSWORD_MARKER);
      expect(
        line.replace(/^(LOG|WARN|ERR|DBG|VRB|FATL) /, ''),
        `请求日志行应仅含 method/URL/状态/耗时(允许 Logger context 后缀):${line}`,
      ).toMatch(/^POST \/api\/auth\/login (401 \+\d+ms|failed \+\d+ms)( \S+)?$/);
    }
    // 全量日志无任何密码明文/请求体倾倒(不采集根策略的端到端复核)
    expect(captured.join('\n')).not.toContain(PASSWORD_MARKER);
  });

  it('带 PIN 的设置验证失败请求:PIN 明文不出现在日志与 URL', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/settings/access')
      .set('Cookie', cookieOf(world))
      .send({ pin: PIN_MARKER });
    // 世界种子主档案无 PIN(404 形态)等失败形态均属「未解锁」;本用例只钉
    // 「带 PIN 的失败请求不落明文」,状态矩阵归 settings-access 契约测试
    expect(res.status).not.toBe(200);

    const lines = captured.filter((line) => line.includes('/api/settings/access'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, `访问日志不得包含 PIN 明文:${line}`).not.toContain(PIN_MARKER);
      expect(line, 'PIN 走请求体,访问日志 URL 不得携带 pin 查询参数').not.toMatch(/[?&]pin=/);
    }
    expect(captured.join('\n')).not.toContain(PIN_MARKER);
  });

  it('含 ticket 的请求 URL:日志落 ticket=[REDACTED],票据明文为 0(T142 复查修复点)', async () => {
    // 未知 query 参数 → 400(严格入参);目的 = 让「含票据 URL」经过访问日志管线
    const res = await request(app.getHttpServer() as Parameters<typeof request>[0]).get(
      `/api/public/media?pageSize=1&ticket=${TICKET_MARKER}`,
    );
    expect(res.status).toBe(400);
    const lines = captured.filter((line) => line.includes('/api/public/media'));
    expect(lines.length).toBeGreaterThan(0);
    const redactedSeen = lines.some((line) => line.includes('ticket=[REDACTED]'));
    expect(redactedSeen, `票据参数应整体脱敏为 [REDACTED]:${lines.join(' || ')}`).toBe(true);
    expect(captured.join('\n'), '票据明文不得出现在任何日志行').not.toContain(TICKET_MARKER);
  });

  it('日志字段边界:全部 /api/ 访问行仅含 method/路由/状态/耗时(无请求体/头部/源路径)', async () => {
    // 混合成功与失败路径,汇总断言访问行形态
    await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/context');
    await request(app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/media?pageSize=1');
    await request(app.getHttpServer()).post('/api/auth/login').send({ username: 'personal', password: 'definitely-wrong' });

    const httpLines = captured.filter((line) => /^(LOG|WARN|ERR|DBG|VRB|FATL) (GET|POST|PUT|PATCH|DELETE) \//.test(line));
    expect(httpLines.length).toBeGreaterThanOrEqual(3);
    for (const line of httpLines) {
      expect(
        line.replace(/^(LOG|WARN|ERR|DBG|VRB|FATL) /, ''),
        `访问日志行应仅含 method/URL/状态/耗时(允许 Logger context 后缀):${line}`,
      ).toMatch(/^(GET|POST|PUT|PATCH|DELETE) \S+ (\d{3} \+\d+ms|failed \+\d+ms)( \S+)?$/);
      expect(line).not.toMatch(/password|argon|\$2[aby]\.|\/Volumes\/|sourcePath/i);
    }
  });
});
