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
 * T019 (018 US3): 逻辑频道自定义台标 Logo 与 M3U/XMLTV 刷新防覆盖保护契约测试。
 * 对照 contracts/admin-channel-customization-api.md:
 * - 默认导入的逻辑频道台标为 source_kind = 'iptv' 或 'epg';
 * - PATCH /settings/catalog/media/{mediaId} 支持 logoUrl 自定义，设置 source_kind = 'custom', source_id = NULL;
 * - 生成不透明 32-hex posterRef，可通过 /public/media/logos/:logoRef 代理访问;
 * - 后续 M3U/XMLTV 源刷新时，严格保护 custom 台标不被覆盖;
 * - 管理员可清空台标 (logoUrl: null / "")，标记 revoked_at 并将 posterRef 置为 NULL。
 */

// 1x1 透明 PNG 字节基准
const CUSTOM_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const UPSTREAM_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface CustomLogoRig {
  app: INestApplication;
  cookie: string;
  householdId: string;
}

const mediaServers: ControlledMediaServer[] = [];

async function setupCustomLogoApp(): Promise<CustomLogoRig> {
  const fresh = await startFreshApp({
    prefix: 'hmp-custom-logo-',
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

describe('018 US3 逻辑频道自定义台标 Logo 与防刷新覆盖契约测试', () => {
  afterEach(async () => {
    while (mediaServers.length > 0) {
      const s = mediaServers.pop();
      if (s !== undefined) {
        await s.close();
      }
    }
    await cleanupRigs();
  });

  it('全链路: 导入初始台标 → 设置自定义 Logo → 公共代理回源成功 → M3U 刷新不覆盖 → 清空恢复', async () => {
    const media = await createControlledMediaServer();
    mediaServers.push(media);

    // 配置受控图片路由
    media.setRoute('/upstream-logo.png', {
      kind: 'body',
      contentType: 'image/png',
      body: UPSTREAM_PNG,
    });
    media.setRoute('/upstream-logo-v2.png', {
      kind: 'body',
      contentType: 'image/png',
      body: UPSTREAM_PNG,
    });
    media.setRoute('/custom-logo.png', {
      kind: 'body',
      contentType: 'image/png',
      body: CUSTOM_PNG,
    });

    // 初始 M3U 携带 upstream-logo.png
    media.setRoute('/playlist.m3u', {
      kind: 'm3u',
      content: buildM3u([
        {
          name: 'CCTV-1 综合',
          url: 'http://127.0.0.1:9099/live/cctv1.m3u8',
          tvgId: 'cctv-1',
          tvgLogo: `${media.baseUrl}/upstream-logo.png`,
          groupTitle: '央视',
        },
      ]),
    });

    const { app, cookie } = await setupCustomLogoApp();

    // 1) 创建 IPTV 来源并刷新导入
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

    const refresh1 = await request(app.getHttpServer())
      .post(`/api/settings/sources/${sourceId}/refresh`)
      .set('Cookie', cookie)
      .send({ expectedVersion: 1, operationKey: randomUUID() });
    expect(refresh1.status).toBe(202);
    await waitRefreshStatus(app, cookie, refresh1.body.id as string, 'succeeded');

    // 2) 获取导入后的频道信息
    const candidatesRes1 = await request(app.getHttpServer())
      .post('/api/settings/catalog/candidates/query')
      .set('Cookie', cookie)
      .send({ type: 'channel', page: 1, pageSize: 20 });
    expect(candidatesRes1.status).toBe(200);
    const candidate1 = (candidatesRes1.body as CandidatePageDto).items[0]!;
    expect(candidate1).toBeDefined();
    const channelId = candidate1.id;
    expect(candidate1.logoUrl).toBe(`${media.baseUrl}/upstream-logo.png`);

    // 数据库初始验证: source_kind = 'iptv'
    const logoRow1 = Database.db
      .prepare('SELECT source_kind, source_id, upstream_url, revoked_at FROM channel_logo WHERE media_id = ?')
      .get(channelId) as { source_kind: string; source_id: string; upstream_url: string; revoked_at: string | null };
    expect(logoRow1.source_kind).toBe('iptv');
    expect(logoRow1.source_id).toBe(sourceId);
    expect(logoRow1.revoked_at).toBeNull();

    // 3) 管理员自定义修改台标 URL
    const customUrl = `${media.baseUrl}/custom-logo.png`;
    const patchRes = await request(app.getHttpServer())
      .patch(`/api/settings/catalog/media/${channelId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: candidate1.version, logoUrl: customUrl, visible: true });
    expect(patchRes.status).toBe(200);
    const patchedMedia = patchRes.body as MediaDto;
    expect(patchedMedia.posterRef).toBeTruthy();
    const customLogoRef = patchedMedia.posterRef!;

    // 4) 验证管理端候选返回了自定义的 logoUrl
    const candidatesRes2 = await request(app.getHttpServer())
      .post('/api/settings/catalog/candidates/query')
      .set('Cookie', cookie)
      .send({ type: 'channel', page: 1, pageSize: 20 });
    const candidate2 = (candidatesRes2.body as CandidatePageDto).items.find((c) => c.id === channelId);
    expect(candidate2?.logoUrl).toBe(customUrl);

    // 5) 数据库验证: 胜者转为 custom 且 source_id 置为 NULL
    const logoRow2 = Database.db
      .prepare('SELECT ref, source_kind, source_id, upstream_url, revoked_at FROM channel_logo WHERE media_id = ?')
      .get(channelId) as { ref: string; source_kind: string; source_id: string | null; upstream_url: string; revoked_at: string | null };
    expect(logoRow2.ref).toBe(customLogoRef);
    expect(logoRow2.source_kind).toBe('custom');
    expect(logoRow2.source_id).toBeNull();
    expect(logoRow2.upstream_url).toBe(customUrl);
    expect(logoRow2.revoked_at).toBeNull();

    // 6) 验证公共代理接口返回自定义台标图片字节，且公共频道列表反映 posterRef
    const publicChannelsRes1 = await request(app.getHttpServer()).get('/api/public/live/channels');
    expect(publicChannelsRes1.status).toBe(200);
    const pubChannels1 = (publicChannelsRes1.body.items as { media: { id: string; posterRef?: string | null } }[]);
    expect(pubChannels1.find((c) => c.media.id === channelId)?.media.posterRef).toBe(customLogoRef);

    const publicLogoRes = await request(app.getHttpServer()).get(`/api/public/media/logos/${customLogoRef}`);
    expect(publicLogoRes.status).toBe(200);
    expect(publicLogoRes.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(Buffer.from(publicLogoRes.body as Buffer), CUSTOM_PNG)).toBe(0);

    // 7) 模拟上游 M3U 更新台标为 upstream-logo-v2.png
    media.setRoute('/playlist.m3u', {
      kind: 'm3u',
      content: buildM3u([
        {
          name: 'CCTV-1 综合',
          url: 'http://127.0.0.1:9099/live/cctv1.m3u8',
          tvgId: 'cctv-1',
          tvgLogo: `${media.baseUrl}/upstream-logo-v2.png`,
          groupTitle: '央视',
        },
      ]),
    });

    const sourceRow = Database.db
      .prepare('SELECT version FROM media_source WHERE id = ?')
      .get(sourceId) as { version: number };

    // 触发刷新并等待成功
    const refresh2 = await request(app.getHttpServer())
      .post(`/api/settings/sources/${sourceId}/refresh`)
      .set('Cookie', cookie)
      .send({ expectedVersion: sourceRow.version, operationKey: randomUUID() });
    expect(refresh2.status).toBe(202);
    await waitRefreshStatus(app, cookie, refresh2.body.id as string, 'succeeded');

    // 8) 验证防覆盖保护: 即使上游提供了新台标，已自定义的 custom 台标绝不被覆盖
    const logoRow3 = Database.db
      .prepare('SELECT ref, source_kind, source_id, upstream_url, revoked_at FROM channel_logo WHERE media_id = ?')
      .get(channelId) as { ref: string; source_kind: string; source_id: string | null; upstream_url: string; revoked_at: string | null };
    expect(logoRow3.ref).toBe(customLogoRef);
    expect(logoRow3.source_kind).toBe('custom');
    expect(logoRow3.source_id).toBeNull();
    expect(logoRow3.upstream_url).toBe(customUrl);
    expect(logoRow3.revoked_at).toBeNull();

    // 9) 管理员清空台标 (logoUrl: null)
    const currentMediaRow = Database.db
      .prepare('SELECT version FROM media_item WHERE id = ?')
      .get(channelId) as { version: number };
    const clearRes = await request(app.getHttpServer())
      .patch(`/api/settings/catalog/media/${channelId}`)
      .set('Cookie', cookie)
      .send({ expectedVersion: currentMediaRow.version, logoUrl: null });
    expect(clearRes.status).toBe(200);
    expect((clearRes.body as MediaDto).posterRef).toBeNull();

    // 数据库验证: channel_logo 被标记 revoked_at，poster_ref 变为 NULL
    const logoRow4 = Database.db
      .prepare('SELECT revoked_at FROM channel_logo WHERE media_id = ?')
      .get(channelId) as { revoked_at: string | null };
    expect(logoRow4.revoked_at).not.toBeNull();

    const mediaRow4 = Database.db
      .prepare('SELECT poster_ref FROM media_item WHERE id = ?')
      .get(channelId) as { poster_ref: string | null };
    expect(mediaRow4.poster_ref).toBeNull();

    // 公共接口即刻反映 posterRef 置空
    const publicChannelsRes2 = await request(app.getHttpServer()).get('/api/public/live/channels');
    expect(publicChannelsRes2.status).toBe(200);
    const pubChannels2 = (publicChannelsRes2.body.items as { media: { id: string; posterRef?: string | null } }[]);
    expect(pubChannels2.find((c) => c.media.id === channelId)?.media.posterRef).toBeNull();
  });

  it('上传台标接口: 支持超过默认 100KB 限制的大图上传 (如 500KB 图片)', async () => {
    const { app, cookie } = await setupCustomLogoApp();

    // 生成约 500KB 大小的伪图片 base64 数据
    const largeBuffer = Buffer.alloc(500 * 1024, 0xab);
    const largeBase64 = `data:image/png;base64,${largeBuffer.toString('base64')}`;

    const uploadRes = await request(app.getHttpServer())
      .post('/api/settings/catalog/upload-logo')
      .set('Cookie', cookie)
      .send({
        filename: 'large-logo.png',
        data: largeBase64,
      });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.url).toMatch(/^\/api\/public\/media\/custom-logos\/.+\.png$/);
    expect(uploadRes.body.filename).toMatch(/\.png$/);
  });
});
