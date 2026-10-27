import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { GuideWindowDto } from '@hmp/shared';
import { AppModule } from '../../src/app.module';
import { Database } from '../../src/database/database';
import { setEnvOverride } from '../../src/config/env';
import { loadEnv } from '../../src/config/env.schema';
import { sharedRateLimitService } from '../../src/common/rate-limit/rate-limit.service';
import { saveBinding } from '../../src/modules/epg/manual-epg-binding.service';
import {
  SCALE_FIXTURE_CREDENTIALS,
  SCALE_FIXTURE_FIXED_NOW_MS,
  SCALE_FIXTURE_IDS,
  SCALE_FIXTURE_TIMEZONE,
  scaleChannelMediaId,
  scaleXmltvChannelId,
  seedScaleFixture,
} from '../fixtures/scale-fixture';
import { cleanupRigs, expectProblemContentType, startFreshApp } from '../helpers';

/**
 * 公共 guide 契约测试(T108;005 contracts/api.md §1/§2、宪章原则一/三):
 * - 无 Cookie 匿名 GET /api/public/guide 返回 GuideWindow 完整信封
 *   {date,timezone,now,allowedDates,from,to,page,pageSize,totalChannels,catalogRevision,
 *    channels:[{media,programmes}]};默认窗口 = 现在前 30 分钟起 6 小时(裁剪日界);
 * - 响应 Cache-Control: no-store、无 Set-Cookie(公共浏览不建立会话);
 * - guide 限频 30 次/分钟(429 + Retry-After,契约 §1);
 * - 负向:昨天/已过期 date → 409 GUIDE_DATE_EXPIRED 且 problem.allowedDates 为新范围;
 *   尚未到允许未来范围 → 400 VALIDATION_FAILED;跨日或 >6 小时窗口 → 422
 *   GUIDE_WINDOW_TOO_LARGE;伪造 householdId/profileId 与未知字段(含夹带 revision)
 *   → 400 一律拒绝;pageSize>50 → 400;
 * - EPG 绑定变更后 catalogRevision 递增且不得返回旧快照(经 manual-epg-binding.service
 *   的真实变更事务,与契约「EPG 发布或绑定变更后 catalogRevision 递增」同源);
 * - 公共响应不含源 ID、XMLTV 原始 ID、路径、个人数据或播放凭据。
 *
 * 复用 T012 规模夹具(200 频道/67,200 排期)+ 固定时钟偏移(锚定 SCALE_FIXTURE_FIXED_NOW_MS
 * = 2026-11-04T12:05Z,CST 20:05,家庭时区 Asia/Shanghai);模块组合与 public-live 契约
 * 测试同惯例(AppModule 已注册 EpgModule)。
 */

const OFFSET_ENV_KEY = 'HMP_CLOCK_OFFSET_MS';
const HOUSEHOLD_ID = SCALE_FIXTURE_IDS.householdId;

let app: INestApplication;
let dataDir: string;

async function bootComposedApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const composed = moduleRef.createNestApplication({ logger: ['warn', 'error'] });
  composed.setGlobalPrefix('api');
  await composed.init();
  return composed;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-public-guide-'));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  const migrationsDir = path.join(process.cwd(), 'src/database/migrations');
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const upSql = fs.readFileSync(path.join(migrationsDir, name, 'up.sql'), 'utf8');
    Database.db.transaction(() => {
      Database.db.exec(upSql);
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  await seedScaleFixture(Database.db);
  // 限频为全应用共享内存单例:套件开始前清空(纯测试隔离动作,不改变生产行为)
  (sharedRateLimitService() as unknown as { windows: Map<string, number[]> }).windows.clear();
  // 固定时钟:锚到规模夹具固定 now(此后 1:1 流动;断言锚定夹具常量,容许秒级漂移)
  process.env[OFFSET_ENV_KEY] = String(SCALE_FIXTURE_FIXED_NOW_MS - Date.now());
  app = await bootComposedApp();
}, 120_000);

afterAll(async () => {
  delete process.env[OFFSET_ENV_KEY];
  await app?.close();
  Database.close();
  if (dataDir !== undefined) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
  }
  await new Promise((resolve) => setImmediate(resolve));
});

afterEach(async () => {
  await cleanupRigs();
});

// supertest 的 App 类型经 export = 命名空间引用;此处直接以结构兼容的 http server 传参
const http = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

function getGuide(query = ''): request.Test {
  return request(http()).get(`/api/public/guide${query}`);
}

describe('GET /public/guide 匿名契约(T108 · 规模夹具)', () => {
  it('默认窗口(现在前 30 分钟起 6 小时,裁剪日界)返回完整 GuideWindow 信封、no-store、无 Set-Cookie', async () => {
    const res = await getGuide();
    expect(res.status).toBe(200);
    const body = res.body as GuideWindowDto;
    // 信封字段
    expect(body.date).toBe('2026-11-04');
    expect(body.timezone).toBe(SCALE_FIXTURE_TIMEZONE);
    // now/窗口自锚点起 1:1 流动(与 public-live 同口径,容许秒级漂移)
    const anchorIso = new Date(SCALE_FIXTURE_FIXED_NOW_MS).toISOString();
    expect(Math.abs(Date.parse(body.now) - Date.parse(anchorIso))).toBeLessThan(5_000);
    expect(Math.abs(Date.parse(body.from) - Date.parse('2026-11-04T11:35:00.000Z'))).toBeLessThan(5_000);
    // 终点越过日界裁剪到 24:00 CST(裁剪量分钟级,漂移不影响断言)
    expect(body.to).toBe('2026-11-04T16:00:00.000Z');
    expect(body.allowedDates).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    // totalChannels = 可用频道(200 − 15 号不可用)= 199(含无 EPG 频道)
    expect(body.totalChannels).toBe(199);
    expect(body.catalogRevision).toBe(1);
    expect(body.channels).toHaveLength(20);
    expect(body.channels[0]?.media.type).toBe('channel');
    expect(body.channels[0]?.media.title).toBe('夹具频道 001');
    expect(body.channels[0]?.media.availability).toBe('available');
    // 节目块:名称 + 完整 UTC 起止;窗口内存在覆盖 now 的节目
    const nowIso = new Date(SCALE_FIXTURE_FIXED_NOW_MS).toISOString();
    const programmes = body.channels[0]?.programmes ?? [];
    expect(programmes.length).toBeGreaterThan(0);
    for (const programme of programmes) {
      expect(programme.title.length).toBeGreaterThan(0);
      expect(Date.parse(programme.startsAt)).toBeLessThan(Date.parse(programme.endsAt));
      expect(programme.key).toMatch(/^pg-[0-9a-f]{24}$/);
    }
    expect(programmes.some((p) => p.startsAt <= nowIso && nowIso < p.endsAt)).toBe(true);
    // 响应头:no-store;公共浏览不 Set-Cookie
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('公共响应不含源 ID、XMLTV 原始 ID、路径、个人数据或播放凭据(宪章原则一/三)', async () => {
    const res = await getGuide('?page=10&pageSize=50');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    // 源 ID / XMLTV ID(规模夹具确定性标识)
    expect(text).not.toContain('fx-src');
    expect(text).not.toContain('fx-xmltv');
    expect(text).not.toContain('upstream');
    // 路径与源位置
    expect(text).not.toContain('iptv.scale-fixture.test');
    expect(text).not.toContain('nas-media');
    expect(text).not.toContain('/stream/');
    // 个人数据与凭据(账号/档案/会话/密码)
    expect(text).not.toContain('fx-profile');
    expect(text).not.toContain('fx-account');
    expect(text).not.toContain('fx-session');
    expect(text).not.toContain(SCALE_FIXTURE_CREDENTIALS.sessionToken);
    expect(text).not.toContain(SCALE_FIXTURE_CREDENTIALS.password);
    expect(text).not.toContain('pin');
    expect(text).not.toContain('passwordHash');
  });

  it('分页遍历含无节目频道:末页包含无 EPG 频道(programmes=[])且不隐藏', async () => {
    const res = await getGuide('?page=10&pageSize=20');
    expect(res.status).toBe(200);
    const body = res.body as GuideWindowDto;
    expect(body.page).toBe(10);
    expect(body.channels.length).toBe(19); // 199 = 9×20 + 19
    const titles = body.channels.map((row) => row.media.title);
    expect(titles).toEqual([...titles].sort((l, r) => (l < r ? -1 : 1)));
    // 无 EPG 频道 197~200 在频道序末尾(programmes=[])
    for (const no of [197, 198, 199, 200]) {
      const row = body.channels.find((candidate) => candidate.media.id === scaleChannelMediaId(no));
      expect(row).toBeDefined();
      expect(row?.programmes).toEqual([]);
    }
  });

  it('显式 6 小时窗口(pageSize=50)正常返回;每频道节目按起止排序', async () => {
    const res = await getGuide('?date=2026-11-05&from=2026-11-04T16:00:00.000Z&to=2026-11-04T22:00:00.000Z&page=1&pageSize=50');
    expect(res.status).toBe(200);
    const body = res.body as GuideWindowDto;
    expect(body.date).toBe('2026-11-05');
    expect(body.from).toBe('2026-11-04T16:00:00.000Z');
    expect(body.to).toBe('2026-11-04T22:00:00.000Z');
    expect(body.pageSize).toBe(50);
    expect(body.channels.length).toBe(50);
    for (const row of body.channels) {
      const starts = row.programmes.map((p) => p.startsAt);
      expect(starts).toEqual([...starts].sort());
    }
  });
});

describe('guide 日期与窗口负向契约(T108 · 原则三)', () => {
  it('昨天(家庭时区已过期)→ 409 GUIDE_DATE_EXPIRED 且 problem.allowedDates 为新范围', async () => {
    const res = await getGuide('?date=2026-11-03');
    expect(res.status).toBe(409);
    expectProblemContentType(res);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.code).toBe('GUIDE_DATE_EXPIRED');
    expect(res.body.status).toBe(409);
    expect(res.body.allowedDates).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
    ]);
  });

  it('尚未到允许未来范围(today+7)→ 400 VALIDATION_FAILED', async () => {
    const res = await getGuide('?date=2026-11-11');
    expect(res.status).toBe(400);
    expectProblemContentType(res);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('from 早于该日真实日界(跨日窗口)→ 422 GUIDE_WINDOW_TOO_LARGE', async () => {
    const res = await getGuide('?date=2026-11-05&from=2026-11-04T15:00:00.000Z&to=2026-11-04T18:00:00.000Z');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GUIDE_WINDOW_TOO_LARGE');
  });

  it('to 晚于该日真实日界(跨日窗口)→ 422', async () => {
    const res = await getGuide('?date=2026-11-05&from=2026-11-05T14:00:00.000Z&to=2026-11-05T17:00:00.000Z');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('GUIDE_WINDOW_TOO_LARGE');
  });

  it('跨度 > 6 小时 → 422(恰好 6 小时允许)', async () => {
    const over = await getGuide('?date=2026-11-05&from=2026-11-04T16:30:00.000Z&to=2026-11-04T23:00:00.000Z');
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('GUIDE_WINDOW_TOO_LARGE');
    const exact = await getGuide('?date=2026-11-05&from=2026-11-04T16:30:00.000Z&to=2026-11-04T22:30:00.000Z');
    expect(exact.status).toBe(200);
  });

  it('伪造 householdId/profileId/isAdmin 与夹带 revision 等未知字段 → 400 拒绝', async () => {
    for (const forged of [
      '?householdId=fx-household',
      '?profileId=fx-profile-main',
      '?isAdmin=1',
      '?revision=99',
      '?sourceId=fx-src-a-epg-xmltv',
    ]) {
      const res = await getGuide(forged);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('pageSize>50 / page<1 / 非法 date 格式 → 400', async () => {
    expect((await getGuide('?pageSize=51')).status).toBe(400);
    expect((await getGuide('?page=0')).status).toBe(400);
    expect((await getGuide('?date=20261105')).status).toBe(400);
    expect((await getGuide('?from=not-a-date')).status).toBe(400);
  });
});

describe('catalogRevision 同步快照(T108/T114)', () => {
  it('绑定变更(真实变更事务)后 catalogRevision 递增,后续响应不返回旧快照', async () => {
    const before = await getGuide('?pageSize=1');
    expect(before.status).toBe(200);
    const revisionBefore = (before.body as GuideWindowDto).catalogRevision;

    // 经 manual-epg-binding.service 的真实绑定事务(与契约「绑定修改同事务递增」同源);
    // 规模夹具会话/账号/设备齐备,可直接走生产写入路径。
    saveBinding(Database.db, {
      householdId: HOUSEHOLD_ID,
      mediaId: scaleChannelMediaId(2),
      epgSourceId: SCALE_FIXTURE_IDS.epgSourceId,
      xmltvChannelId: scaleXmltvChannelId(2),
      expectedVersion: 0,
      candidateEpgGeneration: 0,
      accountId: SCALE_FIXTURE_IDS.accountId,
      sessionId: SCALE_FIXTURE_IDS.deviceSessionId,
    });

    const after = await getGuide('?pageSize=1');
    expect(after.status).toBe(200);
    expect((after.body as GuideWindowDto).catalogRevision).toBe(revisionBefore + 1);
  });
});

describe('guide 限频 30 次/分钟(T108 · 契约 §1)', () => {
  it('1 分钟内第 31 个请求 → 429 + Retry-After;计含被业务拒绝的请求(防绕过)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-guide-rate-' });
    // 独立临时环境(未初始化家庭,guide 仍匿名可达);清空共享限频表后精确计数
    (sharedRateLimitService() as unknown as { windows: Map<string, number[]> }).windows.clear();
    for (let i = 0; i < 30; i += 1) {
      const res = await request(rig.app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/guide');
      expect(res.status).toBe(200);
    }
    const overflow = await request(rig.app.getHttpServer() as Parameters<typeof request>[0]).get('/api/public/guide');
    expect(overflow.status).toBe(429);
    expectProblemContentType(overflow);
    expect(overflow.headers['cache-control']).toBe('no-store');
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });
});
