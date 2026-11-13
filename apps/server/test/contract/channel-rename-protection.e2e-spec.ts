import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { CandidatePageDto, MediaDto } from '@hmp/shared';
import { Database } from '@platform/database/database';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  cookiePairOf,
  initialize,
  login,
  startFreshApp,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';
import {
  buildM3u,
  createControlledMediaServer,
  type ControlledMediaServer,
} from '../fixtures/controlled-media-server';

/**
 * T014 (018 US2): 逻辑频道重命名与 M3U 刷新防覆盖保护契约测试。
 * 对照 contracts/admin-channel-customization-api.md:
 * - 默认导入的逻辑频道 title_overridden = 0;
 * - PATCH /settings/catalog/media/{mediaId} 支持 title 重命名，并将 title_overridden 置为 1;
 * - 乐观锁并发保护: expectedVersion 不匹配时返回 409 Conflict (MEDIA_VERSION_CONFLICT);
 * - M3U 订阅源重新拉取刷新时，严格保留已重命名的频道名称，绝不被上游新名称冲刷覆盖;
 * - 未重命名的频道仍可正常随上游刷新更新名称;
 * - 公共直播列表 (/public/live/channels) 即刻呈现自定义名称。
 */

interface RenameRig {
  app: INestApplication;
  cookie: string;
  householdId: string;
}

const mediaServers: ControlledMediaServer[] = [];

async function setupRenameApp(): Promise<RenameRig> {
  const fresh = await startFreshApp({
    prefix: 'hmp-rename-prot-',
    env: { LAN_ALLOWED_TARGETS: '127.0.0.1' },
  });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await selectMainAndUnlockSettings(fresh.app, cookie);

  const householdRes = await request(fresh.app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  expect(householdRes.status).toBe(200);
  const householdId = (householdRes.body as { id: string }).id;

  return { app: fresh.app, cookie, householdId };
}

async function waitRefreshStatus(
  app: INestApplication,
  cookie: string,
  refreshId: string,
  targetStatus = 'succeeded',
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app.getHttpServer())
      .get(`/api/settings/refreshes/${refreshId}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    if (body.status === targetStatus) {
      return body;
    }
    if (body.status === 'failed') {
      throw new Error(`Refresh failed: ${JSON.stringify(body)}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Wait for status ${targetStatus} timed out: ${JSON.stringify(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('018 US2 逻辑频道重命名与防刷新覆盖契约测试', () => {
  afterEach(async () => {
    while (mediaServers.length > 0) {
      const s = mediaServers.pop();
      if (s !== undefined) {
        await s.close();
      }
    }
    await cleanupRigs();
  });

  it('全链路: 导入频道 → 人工重命名并锁定 → 并发冲突防护 → 上游变更刷新防覆盖保护', async () => {
    const media = await createControlledMediaServer();
    mediaServers.push(media);

    media.setRoute('/playlist.m3u', {
      kind: 'm3u',
      content: buildM3u([
        { name: 'CCTV-1 综合', url: 'http://127.0.0.1:9099/live/cctv1.m3u8', tvgId: 'cctv-1', groupTitle: '央视' },
        { name: 'CCTV-2 财经', url: 'http://127.0.0.1:9099/live/cctv2.m3u8', tvgId: 'cctv-2', groupTitle: '央视' },
      ]),
    });

    const { app, cookie } = await setupRenameApp();

    // 1) 创建 IPTV 来源并指向受控 M3U
    const createdSource = await request(app.getHttpServer())
      .post('/api/settings/sources')
      .set('Cookie', cookie)
      .send({
        kind: 'iptv',
        name: '央视直播源',
        enabled: true,
        remoteUrl: 'http://placeholder.media.invalid/playlist.m3u',
        privateAccessApproved: true,
      });
    expect(createdSource.status).toBe(201);
    const sourceId = createdSource.body.id as string;

    Database.db
      .prepare('UPDATE media_source SET remote_url = ? WHERE id = ?')
      .run(`${media.baseUrl}/playlist.m3u`, sourceId);

    // 2) 触发首次刷新并等待成功
    const refresh1 = await request(app.getHttpServer())
      .post(`/api/settings/sources/${sourceId}/refresh`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, operationKey: randomUUID() });
    expect(refresh1.status).toBe(202);
    await waitRefreshStatus(app, cookie, refresh1.body.id as string, 'succeeded');

    // 3) 检索候选频道
    const candidatesRes1 = await request(app.getHttpServer())
      .post('/api/settings/catalog/candidates/query')
      .set('Cookie', cookie)
      .send({ type: 'channel', page: 1, pageSize: 20 });
    expect(candidatesRes1.status).toBe(200);
    const page1 = candidatesRes1.body as CandidatePageDto;
    const cctv1 = page1.items.find((item) => item.title === 'CCTV-1 综合');
    const cctv2 = page1.items.find((item) => item.title === 'CCTV-2 财经');
    expect(cctv1).toBeDefined();
    expect(cctv2).toBeDefined();
    const cctv1Id = cctv1!.id;
    const cctv2Id = cctv2!.id;

    // 检查初始数据库状态：未改名，title_overridden = 0, version = 1
    const initialRow1 = Database.db
      .prepare('SELECT title, title_overridden, version FROM media_item WHERE id = ?')
      .get(cctv1Id) as { title: string; title_overridden: number; version: number };
    expect(initialRow1.title).toBe('CCTV-1 综合');
    expect(initialRow1.title_overridden).toBe(0);
    expect(initialRow1.version).toBe(1);

    // 检查公共列表
    const publicRes1 = await request(app.getHttpServer()).get('/api/public/live/channels');
    expect(publicRes1.status).toBe(200);
    const pubChannels1 = (publicRes1.body.items as { media: { id: string; title: string } }[]);
    expect(pubChannels1.find((c) => c.media.id === cctv1Id)?.media.title).toBe('CCTV-1 综合');

    // 4) 乐观锁版本并发冲突测试: 用过期的 expectedVersion 提交应返回 409
    const conflictRes = await request(app.getHttpServer())
      .patch(`/api/settings/catalog/media/${cctv1Id}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 999, title: '冲突名称' });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.code).toBe('MEDIA_VERSION_CONFLICT');

    // 5) 管理员合法重命名频道名称
    const patchRes = await request(app.getHttpServer())
      .patch(`/api/settings/catalog/media/${cctv1Id}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, title: '我的央视综合频道' });
    expect(patchRes.status).toBe(200);
    const patchedDto = patchRes.body as MediaDto;
    expect(patchedDto.title).toBe('我的央视综合频道');
    expect(patchedDto.version).toBe(2);

    // 数据库状态已变更且 title_overridden = 1
    const patchedRow1 = Database.db
      .prepare('SELECT title, title_overridden, version FROM media_item WHERE id = ?')
      .get(cctv1Id) as { title: string; title_overridden: number; version: number };
    expect(patchedRow1.title).toBe('我的央视综合频道');
    expect(patchedRow1.title_overridden).toBe(1);
    expect(patchedRow1.version).toBe(2);

    // 公共直播列表即刻反映重命名
    const publicRes2 = await request(app.getHttpServer()).get('/api/public/live/channels');
    expect(publicRes2.status).toBe(200);
    const pubChannels2 = (publicRes2.body.items as { media: { id: string; title: string } }[]);
    expect(pubChannels2.find((c) => c.media.id === cctv1Id)?.media.title).toBe('我的央视综合频道');

    // 6) 模拟上游 M3U 变更频道标题
    media.setRoute('/playlist.m3u', {
      kind: 'm3u',
      content: buildM3u([
        { name: 'CCTV-1 综合 (超清4K)', url: 'http://127.0.0.1:9099/live/cctv1.m3u8', tvgId: 'cctv-1', groupTitle: '央视' },
        { name: 'CCTV-2 财经 (高清升级)', url: 'http://127.0.0.1:9099/live/cctv2.m3u8', tvgId: 'cctv-2', groupTitle: '央视' },
      ]),
    });

    const sourceRow = Database.db
      .prepare('SELECT version FROM media_source WHERE id = ?')
      .get(sourceId) as { version: number };

    // 7) 再次触发刷新并等待成功
    const refresh2 = await request(app.getHttpServer())
      .post(`/api/settings/sources/${sourceId}/refresh`)
      .set('Cookie', cookie)
      .send({ expectedVersion: sourceRow.version, operationKey: randomUUID() });
    expect(refresh2.status).toBe(202);
    await waitRefreshStatus(app, cookie, refresh2.body.id as string, 'succeeded');

    // 8) 验证防覆盖保护:
    // cctv1 人工改名过 (title_overridden = 1)，名称必须仍为 '我的央视综合频道'
    const finalRow1 = Database.db
      .prepare('SELECT title, title_overridden FROM media_item WHERE id = ?')
      .get(cctv1Id) as { title: string; title_overridden: number };
    expect(finalRow1.title).toBe('我的央视综合频道');
    expect(finalRow1.title_overridden).toBe(1);

    // cctv2 未人工改名 (title_overridden = 0)，其名称应随上游自动更新为 'CCTV-2 财经 (高清升级)'
    const finalRow2 = Database.db
      .prepare('SELECT title, title_overridden FROM media_item WHERE id = ?')
      .get(cctv2Id) as { title: string; title_overridden: number };
    expect(finalRow2.title).toBe('CCTV-2 财经 (高清升级)');
    expect(finalRow2.title_overridden).toBe(0);

    // 公共接口同样维持保护后的状态
    const publicRes3 = await request(app.getHttpServer()).get('/api/public/live/channels');
    expect(publicRes3.status).toBe(200);
    const pubChannels3 = (publicRes3.body.items as { media: { id: string; title: string } }[]);
    expect(pubChannels3.find((c) => c.media.id === cctv1Id)?.media.title).toBe('我的央视综合频道');
    expect(pubChannels3.find((c) => c.media.id === cctv2Id)?.media.title).toBe('CCTV-2 财经 (高清升级)');
  });
});
