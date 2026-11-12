import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Database } from '@platform/database/database';
import {
  INITIALIZE_BODY,
  buildM3u,
  buildXmltv,
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  initialize,
  login,
  startFreshApp,
  type ControlledMediaServer,
  type TestRig,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';
import { loadLiveChannelWindows } from '@contexts/live-tv/application/live-projection.service';

/**
 * T013(US2 契约 e2e):多 EPG 源全量同步 —— 手动锁定防覆盖(ADR-0008)+ 主备级联补位,
 * 对照 016 spec.md US2 验收 1/3、research R2 判定链、FR-004:
 * - 真实刷新执行器路径(POST /settings/sources/{id}/refresh → 202 → 轮询 succeeded,
 *   与 epg-settings.e2e-spec 同模式)完成两 EPG 源 + IPTV 的全量导入/重拉;
 * - 全量刷新后 manual_epg_binding 的 manual 标记记录 100% 保持不变:
 *   mode/version/目标两列(epg_source_id, xmltv_channel_id)/updated_at 逐列相等,
 *   行数不增(刷新绝不写绑定表);管理读取仍 mode=manual/status=valid;
 *   投影仍命中手动目标(matchMode='manual',current 来自绑定源,不回退自动);
 * - 主备两源:主源(高优先级)缺失频道 A、备源包含频道 A → 公共投影接口
 *   (loadLiveChannelWindows,即 /public/live* 卡片同源管线)断言 current 非空、
 *   matchMode='cascade'、epgSourceId=备源;主源直连频道保持 matchMode='precise' 对照。
 * 环境说明:受控夹具绑定 127.0.0.1,来源经真实 API 创建后以既有 DB 访问模式把
 * remote_url 接到夹具;priority 为 0010 迁移已交付列,经 SQL 直接置值
 * (US4 管理端点属并行任务,非本文件范围)。每用例 ≤2 频道/≤4 节目。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

interface MultiEpgRig {
  app: INestApplication;
  /** restartApp 备用(本文件不重启;保留 rig 引用供 cleanup) */
  rig: TestRig;
  cookie: string;
  householdId: string;
  epgAId: string;
  epgBId: string;
  iptvId: string;
  /** 手动锁定频道 media(绑定目标 epgA/ch-lock) */
  lockMediaId: string;
  /** 主源缺失、由备源补位的频道 media */
  backupMediaId: string;
}

const activeMediaServers: ControlledMediaServer[] = [];

async function bootstrap(): Promise<MultiEpgRig> {
  const fresh = await startFreshApp({
    prefix: 'hmp-multi-epg-sync-',
    env: { LAN_ALLOWED_TARGETS: '127.0.0.1' },
  });
  const app = fresh.app;
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await selectMainAndUnlockSettings(app, cookie);
  const household = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  expect(household.status).toBe(200);
  const householdId = (household.body as { id: string }).id;

  // 节目窗口相对真实当前时刻(刷新/断言全程覆盖)
  const now = Math.floor(Date.now() / 1000) * 1000;
  const pad = (value: number): string => String(value).padStart(2, '0');
  const xmltvStamp = (ms: number): string => {
    const shifted = new Date(ms);
    return (
      `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}` +
      `${pad(shifted.getUTCHours())}${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())} +0000`
    );
  };
  const server = await createControlledMediaServer();
  activeMediaServers.push(server);
  server.setRoute('/guide-a.xml', {
    kind: 'xmltv',
    content: buildXmltv(
      [{ id: 'ch-lock', displayName: '锁定台' }],
      [
        { channel: 'ch-lock', start: xmltvStamp(now - 30 * MIN_MS), stop: xmltvStamp(now + 30 * MIN_MS), title: '主源锁定节目' },
        { channel: 'ch-lock', start: xmltvStamp(now + 30 * MIN_MS), stop: xmltvStamp(now + 2 * HOUR_MS), title: '主源锁定下一档' },
      ],
    ),
  });
  server.setRoute('/guide-b.xml', {
    kind: 'xmltv',
    content: buildXmltv(
      [{ id: 'ch-backup', displayName: '补位台' }],
      [
        { channel: 'ch-backup', start: xmltvStamp(now - 30 * MIN_MS), stop: xmltvStamp(now + 30 * MIN_MS), title: '备源补位节目' },
        { channel: 'ch-backup', start: xmltvStamp(now + 30 * MIN_MS), stop: xmltvStamp(now + 2 * HOUR_MS), title: '备源补位下一档' },
      ],
    ),
  });
  server.setRoute('/live.m3u', {
    kind: 'm3u',
    content: buildM3u([
      { name: '锁定台', tvgId: 'ch-lock', url: 'http://stream.example/lock.m3u8' },
      { name: '补位台', tvgId: 'ch-backup', url: 'http://stream.example/backup.m3u8' },
    ]),
  });

  // 来源创建(创建期字面校验拒绝回环,经 SQL 接到夹具)与优先级(0010 列;US4 管理端点并行交付)
  const createSource = async (body: Record<string, unknown>): Promise<string> => {
    const res = await request(app.getHttpServer()).post('/api/settings/sources').set('Cookie', cookie).send(body);
    expect(res.status, `创建来源前置失败: ${JSON.stringify(res.body)}`).toBe(201);
    return res.body.id as string;
  };
  const epgAId = await createSource({ kind: 'epg', name: '主指南源', remoteUrl: 'http://guide-a.example.com/epg.xml' });
  const epgBId = await createSource({ kind: 'epg', name: '备指南源', remoteUrl: 'http://guide-b.example.com/epg.xml' });
  const iptvId = await createSource({ kind: 'iptv', name: '受控直播', remoteUrl: 'http://live.example.com/list.m3u', epgSourceId: epgAId });
  Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(`${server.baseUrl}/guide-a.xml`, epgAId);
  Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(`${server.baseUrl}/guide-b.xml`, epgBId);
  Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(`${server.baseUrl}/live.m3u`, iptvId);
  Database.db.prepare('UPDATE media_source SET priority = 10 WHERE id = ?').run(epgAId);
  Database.db.prepare('UPDATE media_source SET priority = 20 WHERE id = ?').run(epgBId);

  // 全量首导:两 EPG 源 + IPTV(IPTV 发布建 media_item/source_entry/playback 链)
  await refreshAndWait(app, cookie, epgAId);
  await refreshAndWait(app, cookie, epgBId);
  await refreshAndWait(app, cookie, iptvId);

  const mediaIdByTitle = (title: string): string => {
    const row = Database.db
      .prepare("SELECT id FROM media_item WHERE household_id = ? AND type = 'channel' AND title = ?")
      .get(householdId, title) as { id: string } | undefined;
    expect(row, `IPTV 导入应产出频道媒体「${title}」`).toBeDefined();
    return (row as { id: string }).id;
  };

  return {
    app,
    rig: fresh,
    cookie,
    householdId,
    epgAId,
    epgBId,
    iptvId,
    lockMediaId: mediaIdByTitle('锁定台'),
    backupMediaId: mediaIdByTitle('补位台'),
  };
}

/* ------------------------------------------------------------------ */
/* 刷新管线与绑定 API 包装(与 epg-settings / manual-epg-binding 同模式) */
/* ------------------------------------------------------------------ */

async function refreshAndWait(
  app: INestApplication,
  cookie: string,
  sourceId: string,
  expectedVersion = 1,
): Promise<Record<string, unknown>> {
  const started = await request(app.getHttpServer())
    .post(`/api/settings/sources/${sourceId}/refresh`)
    .set('Cookie', cookie)
    .send({ expectedVersion, operationKey: randomUUID() });
  expect(started.status, `发起刷新前置失败: ${JSON.stringify(started.body)}`).toBe(202);
  const refreshId = started.body.id as string;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const poll = await request(app.getHttpServer()).get(`/api/settings/refreshes/${refreshId}`).set('Cookie', cookie);
    expect(poll.status).toBe(200);
    const body = poll.body as Record<string, unknown>;
    if (body.status === 'succeeded' || body.status === 'failed') {
      expect(body.status, `刷新应成功: ${JSON.stringify(body)}`).toBe('succeeded');
      return body;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待刷新完成超时,最后状态: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface BindingRow {
  mode: string;
  epg_source_id: string | null;
  xmltv_channel_id: string | null;
  version: number;
  updated_at: string;
}

function bindingRowsOf(mediaId: string): BindingRow[] {
  return Database.db
    .prepare('SELECT mode, epg_source_id, xmltv_channel_id, version, updated_at FROM manual_epg_binding WHERE media_id = ? ORDER BY updated_at')
    .all(mediaId) as BindingRow[];
}

async function saveManualBinding(s: MultiEpgRig): Promise<void> {
  // 真实家长流:候选查询取 epgGeneration → 保存即锁定(013 起免当次密码)
  const candidates = await request(s.app.getHttpServer())
    .post(`/api/settings/catalog/media/${s.lockMediaId}/epg-candidates/query`)
    .set('Cookie', s.cookie)
    .send({ epgSourceId: s.epgAId });
  expect(candidates.status, `候选查询前置失败: ${JSON.stringify(candidates.body)}`).toBe(200);
  const generation = candidates.body.epgGeneration as number;
  expect(
    candidates.body.items as Array<{ xmltvChannelId: string }>,
    '主源候选应含 ch-lock',
  ).toEqual(expect.arrayContaining([expect.objectContaining({ xmltvChannelId: 'ch-lock' })]));
  const saved = await request(s.app.getHttpServer())
    .put(`/api/settings/catalog/media/${s.lockMediaId}/epg-binding`)
    .set('Cookie', s.cookie)
    .send({
      expectedVersion: 0,
      mode: 'manual',
      epgSourceId: s.epgAId,
      xmltvChannelId: 'ch-lock',
      expectedEpgGeneration: generation,
    });
  expect(saved.status, `手动绑定保存失败: ${JSON.stringify(saved.body)}`).toBe(200);
  expect(saved.body).toMatchObject({ mode: 'manual', version: 1, epgSourceId: s.epgAId, xmltvChannelId: 'ch-lock', status: 'valid' });
}

function projectionOf(householdId: string, mediaId: string): ReturnType<typeof loadLiveChannelWindows>[number] {
  const windows = loadLiveChannelWindows(householdId, Date.now());
  const row = windows.find((item) => item.mediaId === mediaId);
  expect(row, `频道 ${mediaId} 应在公共投影中`).toBeDefined();
  return row as ReturnType<typeof loadLiveChannelWindows>[number];
}

afterEach(async () => {
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
  (globalThis as { gc?: () => void }).gc?.();
});

// 退出稳定性:与 epg-settings.e2e-spec 同因(真实刷新执行器的 better-sqlite3 原生析构),
// 文件收尾显式 major GC。
afterAll(async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
  }
  await new Promise((resolve) => setImmediate(resolve));
});

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('T013 多 EPG 源全量同步(US2 契约 e2e)', () => {
  it('全量 EPG 重拉后 manual 绑定记录 100% 保持不变(mode/version/目标两列;刷新零写入),投影仍命中手动目标', async () => {
    const s = await bootstrap();
    await saveManualBinding(s);
    const before = bindingRowsOf(s.lockMediaId);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ mode: 'manual', epg_source_id: s.epgAId, xmltv_channel_id: 'ch-lock', version: 1 });
    const totalBefore = (Database.db.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number }).n;

    // 全量刷新流程:两 EPG 源窗口原子替换(epg_generation 递增)+ IPTV 重发布
    await refreshAndWait(s.app, s.cookie, s.epgAId);
    await refreshAndWait(s.app, s.cookie, s.epgBId);
    await refreshAndWait(s.app, s.cookie, s.iptvId);
    const generationAfter = (Database.db.prepare('SELECT epg_generation AS g FROM media_source WHERE id = ?').get(s.epgAId) as { g: number }).g;
    expect(generationAfter).toBeGreaterThan(1); // 证明全量窗口替换真实发生

    // manual 标记记录 100% 保持:逐列相等 + 行数不增(刷新绝不写绑定表,ADR-0008/FR-004)
    const after = bindingRowsOf(s.lockMediaId);
    expect(after).toEqual(before);
    const totalAfter = (Database.db.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number }).n;
    expect(totalAfter).toBe(totalBefore);

    // 管理读取:仍 manual/valid(动态派生:目标源启用 + 目标频道存在 + 未冲突)
    const state = await request(s.app.getHttpServer())
      .post(`/api/settings/catalog/media/${s.lockMediaId}/epg-binding/query`)
      .set('Cookie', s.cookie)
      .send({});
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ mode: 'manual', version: 1, epgSourceId: s.epgAId, xmltvChannelId: 'ch-lock', status: 'valid', invalidReason: null });

    // 投影:严格保持手动选择(matchMode='manual'),不回退自动/级联
    const locked = projectionOf(s.householdId, s.lockMediaId);
    expect(locked.matchMode).toBe('manual');
    expect(locked.epgSourceId).toBe(s.epgAId);
    expect(locked.current?.title).toBe('主源锁定节目');
  });

  it('主源缺失频道由备用源补位:公共投影 current 非空 + matchMode=cascade + epgSourceId=备源(US2 验收 1)', async () => {
    const s = await bootstrap();

    // 全量刷新流程后再断言(既有刷新执行器路径;bootstrap 已首导,此处再做一轮全量重拉)
    await refreshAndWait(s.app, s.cookie, s.epgAId);
    await refreshAndWait(s.app, s.cookie, s.epgBId);
    await refreshAndWait(s.app, s.cookie, s.iptvId);

    // 主源直连频道(对照):tvg-id 精确命中主源 → precise
    const precise = projectionOf(s.householdId, s.lockMediaId);
    expect(precise.matchMode).toBe('precise');
    expect(precise.epgSourceId).toBe(s.epgAId);
    expect(precise.current?.title).toBe('主源锁定节目');

    // 主源缺失频道(补位台仅在备源指南中):L2 未命中 → L3 按优先级级联由备源补位
    const cascaded = projectionOf(s.householdId, s.backupMediaId);
    expect(cascaded.current, '级联补位后 current 必须非空').not.toBeNull();
    expect(cascaded.current?.title).toBe('备源补位节目');
    expect(cascaded.next?.title).toBe('备源补位下一档');
    expect(cascaded.matchMode).toBe('cascade');
    expect(cascaded.epgSourceId).toBe(s.epgBId);
  });
});
