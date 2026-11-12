import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Database } from '@platform/database/database';
import type { GroupPageDto, ChannelPageDto } from '@hmp/shared';
import {
  INITIALIZE_BODY,
  buildM3u,
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  initialize,
  login,
  type ControlledMediaServer,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';
import { groupKeyOf } from '@contexts/live-tv/domain/live-grouping';
import { AppModule } from '../../src/app.module';
import { LiveTvModule } from '@contexts/live-tv/live-tv.module';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { Test } from '@nestjs/testing';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 导入发布分组契约测试(T145;005 data-model §2「来源发布/条目更新同事务保存 M3U 分组」、
 * T146 发布链路、FR-023):
 * - 从真实受控 M3U(受控 HTTP 服务 + 真实 refresh 链路:解析→暂存→发布事务)导入 group-title,
 *   断言 source_entry.group_title 持久化;/public/live/groups 与 channels 反映主分组;
 * - 空白 group-title 归 NULL(归入其他);超长(>100)按既定验证失败处理
 *   (M3U_GROUP_TITLE_INVALID,任务 failed)且不截断伪造分组;
 * - 多来源同一频道(真实导入 + 003 目录归一语义的条目归并)按 (source_id, entry_id) 升序
 *   取第一项非空 group_title,主分组稳定;
 * - 失败刷新保留旧值(失败/未确认快照不更新旧目录分组);
 * - 重启后 /public/live/groups 与 channels 仍正确(持久化,非内存)。
 * 不能只直接写分组夹具:全部 group_title 值均经真实导入链路写入;
 * 唯一的直接库操作是把来源 B 的条目 media_id 归并到来源 A 的频道(003 目录归一的事实准备,
 * 不触碰任何 group_title 值),用于构造「多来源可用频道」真实形态。
 */

const OWNER_PASSWORD = INITIALIZE_BODY.password;

const activeServers: ControlledMediaServer[] = [];

interface Rig {
  app: INestApplication;
  cookie: string;
  sessionId: string;
  /** 同一 DATA_DIR(重启语义:关闭后按原库重建,含 LiveModule 组合) */
  dataDir: string;
  dbFilename: string;
}

/** 组合 AppModule + LiveModule 的契约用应用(与报告「模块注册」节的生产注册逐位一致) */
async function bootComposedApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, LiveTvModule] }).compile();
  const composed = moduleRef.createNestApplication({ logger: ['warn', 'error'] });
  composed.setGlobalPrefix('api');
  await composed.init();
  return composed;
}

async function bootstrap(): Promise<Rig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-live-groups-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename, LAN_ALLOWED_TARGETS: '127.0.0.1' }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
  for (const name of fs.readdirSync(migrationsDir).sort()) {
    Database.db.exec(fs.readFileSync(path.join(migrationsDir, name, 'up.sql'), 'utf8'));
    Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }
  const app = await bootComposedApp();
  const init = await initialize(app);
  expect(init.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, OWNER_PASSWORD);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await selectMainAndUnlockSettings(app, cookie);
  return { app, cookie, sessionId: loggedIn.body.sessionId as string, dataDir, dbFilename };
}

/** 同一 DATA_DIR 重启(真实重启语义;不重放迁移) */
async function restartRig(rig: Rig): Promise<INestApplication> {
  await rig.app.close();
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: rig.dataDir, DB_FILENAME: rig.dbFilename, LAN_ALLOWED_TARGETS: '127.0.0.1' }));
  Database.close();
  rig.app = await bootComposedApp();
  return rig.app;
}

/** 登记当前夹具,收尾清理临时目录(cleanupRigs 只清理 startFreshApp 登记的夹具) */
let currentRig: Rig | null = null;
async function bootstrapTracked(): Promise<Rig> {
  currentRig = await bootstrap();
  return currentRig;
}

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()?.close();
  }
  await cleanupRigs();
  if (currentRig !== null) {
    await currentRig.app.close().catch(() => undefined);
    Database.close();
    fs.rmSync(currentRig.dataDir, { recursive: true, force: true });
    currentRig = null;
  }
  (globalThis as { gc?: () => void }).gc?.();
});

afterAll(async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') {
    gc();
    gc();
  }
  await new Promise((resolve) => setImmediate(resolve));
});

/** 创建 IPTV 来源(创建期禁回环,先占位 URL,再以既有 DB 访问模式接到受控夹具) */
async function createIptvSource(rig: Rig, name: string, targetPath: string): Promise<string> {
  const created = await request(rig.app.getHttpServer())
    .post('/api/settings/sources')
    .set('Cookie', rig.cookie)
    .send({ kind: 'iptv', name, remoteUrl: 'http://iptv.placeholder.invalid/list.m3u' });
  expect(created.status).toBe(201);
  const sourceId = created.body.id as string;
  const server = activeServers[activeServers.length - 1];
  if (server !== undefined) {
    Database.db.prepare('UPDATE media_source SET remote_url = ? WHERE id = ?').run(`${server.baseUrl}${targetPath}`, sourceId);
  }
  return sourceId;
}

async function startRefresh(rig: Rig, sourceId: string): Promise<string> {
  const res = await request(rig.app.getHttpServer())
    .post(`/api/settings/sources/${sourceId}/refresh`)
    .set('Cookie', rig.cookie)
    .send({ expectedVersion: 1, operationKey: randomUUID() });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.id as string;
}

async function waitForStatus(rig: Rig, refreshId: string, statuses: string[], timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(rig.app.getHttpServer()).get(`/api/settings/refreshes/${refreshId}`).set('Cookie', rig.cookie);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    if (statuses.includes(body.status as string)) {
      return body;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待状态 [${statuses.join(',')}] 超时,最后状态: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function getGroups(rig: Rig): Promise<GroupPageDto> {
  const res = await request(rig.app.getHttpServer()).get('/api/public/live/groups');
  expect(res.status).toBe(200);
  return res.body as GroupPageDto;
}

async function getChannelRow(rig: Rig, mediaId: string): Promise<ChannelPageDto['items'][number]> {
  for (let page = 1; page <= 20; page += 1) {
    const res = await request(rig.app.getHttpServer())
      .get('/api/public/live/channels')
      .query({ section: 'all', page, pageSize: 50 });
    expect(res.status).toBe(200);
    const body = res.body as ChannelPageDto;
    const hit = body.items.find((row) => row.media.id === mediaId);
    if (hit !== undefined) {
      return hit;
    }
    if (body.items.length < 50) {
      break;
    }
  }
  throw new Error(`频道 ${mediaId} 未出现在公共频道列表`);
}

describe('导入发布分组(T145/T146)', () => {
  it('真实 M3U 导入:group-title 持久化;空白归 NULL(其他);分组/频道公共响应正确', async () => {
    const rig = await bootstrapTracked();
    const server = await createControlledMediaServer({
      routes: [
        {
          path: '/main.m3u',
          kind: 'm3u',
          content: buildM3u([
            { name: '新闻频道', url: 'http://stream.example/news', tvgId: 'gid-news', groupTitle: '央视新闻' },
            { name: '体育频道', url: 'http://stream.example/sports', tvgId: 'gid-sports', groupTitle: '  央视体育  ' },
            { name: '空白分组频道', url: 'http://stream.example/blank', tvgId: 'gid-blank', groupTitle: '   ' },
          ]),
        },
      ],
    });
    activeServers.push(server);
    const sourceId = await createIptvSource(rig, '主源', '/main.m3u');
    const jobId = await startRefresh(rig, sourceId);
    const job = await waitForStatus(rig, jobId, ['succeeded', 'failed', 'stale']);
    expect(job.status).toBe('succeeded');

    // 持久化断言:group_title 直接查库(存储值域:trim 后原文;空白为 NULL)
    const rows = Database.db.prepare(
      "SELECT se.group_title AS g FROM source_entry se WHERE se.source_id = ? AND se.present = 1 ORDER BY se.id",
    ).all(sourceId) as Array<{ g: string | null }>;
    // 码元序:体(U+4F53) < 新(U+65B0)
    expect(rows.map((row) => row.g).sort()).toEqual([null, '央视体育', '央视新闻']);

    // 公共分组反映:三个频道 → 央视新闻 / 央视体育 / 其他(空白归其他)
    const groups = await getGroups(rig);
    const labels = groups.items.map((item) => item.label);
    expect(labels).toContain('央视新闻');
    expect(labels).toContain('央视体育');
    expect(labels).toContain('其他');

    const blank = await getChannelRow(rig, (Database.db.prepare(
      'SELECT media_id FROM source_entry WHERE source_id = ? AND upstream_channel_id = ?',
    ).get(sourceId, 'gid-blank') as { media_id: string | null } | undefined)?.media_id as string);
    expect(blank.groupLabel).toBe('其他');
    // trim 归一化:分组显示名为剥离空白后的原文
    const sports = await getChannelRow(rig, (Database.db.prepare(
      'SELECT media_id FROM source_entry WHERE source_id = ? AND upstream_channel_id = ?',
    ).get(sourceId, 'gid-sports') as { media_id: string | null } | undefined)?.media_id as string);
    expect(sports.groupLabel).toBe('央视体育');
    expect(sports.groupKey).toBe(groupKeyOf('央视体育'));
  });

  it('超长 group-title(>100):按既定验证失败(M3U_GROUP_TITLE_INVALID),不截断伪造分组', async () => {
    const rig = await bootstrapTracked();
    const overlong = '超'.repeat(101);
    const server = await createControlledMediaServer({
      routes: [
        {
          path: '/overlong.m3u',
          kind: 'm3u',
          content: buildM3u([
            { name: '超长分组频道', url: 'http://stream.example/overlong', tvgId: 'gid-overlong', groupTitle: overlong },
          ]),
        },
      ],
    });
    activeServers.push(server);
    const sourceId = await createIptvSource(rig, '超长源', '/overlong.m3u');
    const jobId = await startRefresh(rig, sourceId);
    const job = await waitForStatus(rig, jobId, ['succeeded', 'failed']);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('M3U_GROUP_TITLE_INVALID');

    // 无部分写入:目录中没有任何条目/分组
    const count = Database.db.prepare('SELECT COUNT(*) AS n FROM source_entry WHERE source_id = ?').get(sourceId) as { n: number };
    expect(count.n).toBe(0);
    const groups = await getGroups(rig);
    expect(groups.items.map((item) => item.label)).not.toContain(overlong.slice(0, 100));
  });

  it('多来源可用频道:按 (source_id, entry_id) 升序取第一项非空 group_title,主分组稳定', async () => {
    const rig = await bootstrapTracked();
    const server = await createControlledMediaServer({
      routes: [
        {
          path: '/src-a.m3u',
          kind: 'm3u',
          content: buildM3u([
            { name: '多源频道A', url: 'http://stream.example/multi-a', tvgId: 'gid-multi', groupTitle: '来源甲分组' },
          ]),
        },
        {
          path: '/src-b.m3u',
          kind: 'm3u',
          content: buildM3u([
            { name: '多源频道B', url: 'http://stream.example/multi-b', tvgId: 'gid-multi', groupTitle: '来源乙分组' },
          ]),
        },
      ],
    });
    activeServers.push(server);
    const sourceA = await createIptvSource(rig, '多来源甲', '/src-a.m3u');
    const sourceB = await createIptvSource(rig, '多来源乙', '/src-b.m3u');
    for (const sourceId of [sourceA, sourceB]) {
      const job = await waitForStatus(rig, await startRefresh(rig, sourceId), ['succeeded', 'failed']);
      expect(job.status).toBe('succeeded');
    }
    // 真实形态准备(003 目录归一语义):把来源 B 的同频道条目归并到来源 A 的频道媒体。
    // 不触碰 group_title 值 —— 分组仍全部来自真实导入。
    const mediaA = (Database.db.prepare(
      'SELECT media_id FROM source_entry WHERE source_id = ? AND upstream_channel_id = ?',
    ).get(sourceA, 'gid-multi') as { media_id: string | null } | undefined)?.media_id as string;
    expect(mediaA).toBeTruthy();
    Database.db.prepare(
      'UPDATE source_entry SET media_id = ? WHERE source_id = ? AND upstream_channel_id = ?',
    ).run(mediaA, sourceB, 'gid-multi');

    // 主分组 = (source_id, entry_id) 升序第一项非空 —— 来源 id 字典序决定,重复读取稳定
    const [winnerSource, loserSource] = [sourceA, sourceB].sort();
    const winnerGroup = (Database.db.prepare(
      'SELECT group_title FROM source_entry WHERE source_id = ? AND upstream_channel_id = ?',
    ).get(winnerSource, 'gid-multi') as { group_title: string | null } | undefined)?.group_title as string;
    const loserGroup = (Database.db.prepare(
      'SELECT group_title FROM source_entry WHERE source_id = ? AND upstream_channel_id = ?',
    ).get(loserSource, 'gid-multi') as { group_title: string | null } | undefined)?.group_title as string;
    expect(winnerGroup).toBeTruthy();
    expect(loserGroup).toBeTruthy();

    const groups = await getGroups(rig);
    const labels = groups.items.map((item) => item.label);
    expect(labels).toContain(winnerGroup);
    // 主分组胜出者唯一:输家分组只可能来自其其他频道(此处无)→ 不出现
    expect(labels).not.toContain(loserGroup);

    const row = await getChannelRow(rig, mediaA);
    expect(row.groupLabel).toBe(winnerGroup);
    // 重复读取稳定
    const again = await getChannelRow(rig, mediaA);
    expect(again.groupKey).toBe(row.groupKey);
  });

  it('失败刷新保留旧分组;重启后 groups/channels 仍正确(持久化)', async () => {
    const rig = await bootstrapTracked();
    const server = await createControlledMediaServer({
      routes: [
        {
          path: '/stable.m3u',
          kind: 'm3u',
          content: buildM3u([
            { name: '稳定频道', url: 'http://stream.example/stable', tvgId: 'gid-stable', groupTitle: '稳定分组' },
          ]),
        },
      ],
    });
    activeServers.push(server);
    const sourceId = await createIptvSource(rig, '稳定源', '/stable.m3u');
    const firstJob = await waitForStatus(rig, await startRefresh(rig, sourceId), ['succeeded', 'failed']);
    expect(firstJob.status).toBe('succeeded');

    // 失败刷新(网络层断开):旧目录分组保持不变
    server.setRoute('/stable.m3u', { kind: 'empty' });
    const secondJob = await waitForStatus(rig, await startRefresh(rig, sourceId), ['succeeded', 'failed']);
    expect(secondJob.status).toBe('failed');
    const retained = (Database.db.prepare(
      'SELECT group_title FROM source_entry WHERE source_id = ? AND present = 1',
    ).get(sourceId) as { group_title: string | null } | undefined)?.group_title as string;
    expect(retained).toBe('稳定分组');
    expect((await getGroups(rig)).items.map((item) => item.label)).toContain('稳定分组');

    // 重启(同 DATA_DIR):公共分组与频道行仍正确
    const mediaId = (Database.db.prepare(
      'SELECT media_id FROM source_entry WHERE source_id = ? AND present = 1',
    ).get(sourceId) as { media_id: string | null } | undefined)?.media_id as string;
    const app2 = await restartRig(rig);
    const groupsAfter = await request(app2.getHttpServer()).get('/api/public/live/groups');
    expect(groupsAfter.status).toBe(200);
    expect((groupsAfter.body as GroupPageDto).items.map((item) => item.label)).toContain('稳定分组');
    const channelAfter = await request(app2.getHttpServer())
      .get('/api/public/live/channels')
      .query({ section: 'all', page: 1, pageSize: 50 });
    expect(channelAfter.status).toBe(200);
    const row = (channelAfter.body as ChannelPageDto).items.find((item) => item.media.id === mediaId);
    expect(row?.groupLabel).toBe('稳定分组');
  });
});
