import 'reflect-metadata';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { CandidatePageDto } from '@hmp/shared';
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

/**
 * T008 (US1 契约 e2e): 频道显隐控制与公共过滤契约测试。
 * 对照 contracts/admin-channel-customization-api.md:
 * - 默认所有逻辑频道 visible=true;
 * - PATCH /settings/catalog/media/{mediaId} 支持 visible: false/true 更新;
 * - POST /settings/catalog/candidates/query 对管理端全量可见，携带 visible 真实状态;
 * - 公共 GET /public/live/channels 与 /public/live/groups 严格排除 visible=0 的隐藏频道;
 * - 重新将 visible 切回 true 后，公共列表即刻恢复该频道。
 */

const NOW_ISO = '2026-11-09T00:00:00.000Z';

interface VisibilityFixture {
  app: INestApplication;
  cookie: string;
  householdId: string;
  channelId1: string;
  channelId2: string;
}

function seedLiveChannels(householdId: string): { channelId1: string; channelId2: string } {
  const conn = Database.db;
  const channelId1 = 'ch-cctv-1';
  const channelId2 = 'ch-cctv-2';

  // 1) 插入 IPTV 媒体源
  conn
    .prepare(
      `INSERT INTO media_source (
        id, household_id, kind, name, remote_url, priority, enabled, created_at, updated_at
      ) VALUES (
        'src-live-1', ?, 'iptv', '央视频道源', 'http://example.com/playlist.m3u', 100, 1, ?, ?
      )`,
    )
    .run(householdId, NOW_ISO, NOW_ISO);

  // 2) 插入两个逻辑频道 (默认 visible=1)
  const insertMedia = conn.prepare(
    `INSERT INTO media_item (
      id, household_id, type, title, description, poster_ref, content_level,
      title_overridden, type_overridden, visible, version, content_revision, media_role, created_at, updated_at
    ) VALUES (?, ?, 'channel', ?, NULL, NULL, 0, 0, 0, 1, 1, 1, 'standalone', ?, ?)`,
  );
  insertMedia.run(channelId1, householdId, 'CCTV-1 综合', NOW_ISO, NOW_ISO);
  insertMedia.run(channelId2, householdId, 'CCTV-2 财经', NOW_ISO, NOW_ISO);

  // 3) 插入 source_entry
  const insertEntry = conn.prepare(
    `INSERT INTO source_entry (
      id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id,
      group_title, present, first_seen_at, last_seen_at
    ) VALUES (?, ?, 'src-live-1', 'url', ?, ?, ?, '央视', 1, ?, ?)`,
  );
  insertEntry.run('entry-cctv-1', householdId, createHash('sha256').update('dig-1').digest('hex'), channelId1, 'CCTV1', NOW_ISO, NOW_ISO);
  insertEntry.run('entry-cctv-2', householdId, createHash('sha256').update('dig-2').digest('hex'), channelId2, 'CCTV2', NOW_ISO, NOW_ISO);

  // 4) 插入 playback_source
  const insertPb = conn.prepare(
    `INSERT INTO playback_source (
      id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, created_at, updated_at
    ) VALUES (?, ?, 'src-live-1', ?, ?, 'http', 'http://stream.example/live.m3u8', 100, 0, ?, ?)`,
  );
  insertPb.run('pb-cctv-1', householdId, 'entry-cctv-1', channelId1, NOW_ISO, NOW_ISO);
  insertPb.run('pb-cctv-2', householdId, 'entry-cctv-2', channelId2, NOW_ISO, NOW_ISO);

  return { channelId1, channelId2 };
}

async function setupVisibilityApp(): Promise<VisibilityFixture> {
  const { app } = await startFreshApp({ prefix: 'hmp-channel-vis-' });
  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);

  const householdRes = await request(app.getHttpServer()).get('/api/household').set('Cookie', cookie);
  const householdId = (householdRes.body as { id: string }).id;

  await selectMainAndUnlockSettings(app, cookie);

  const { channelId1, channelId2 } = seedLiveChannels(householdId);

  return { app, cookie, householdId, channelId1, channelId2 };
}

describe('018 US1 逻辑频道显隐控制与公共过滤契约测试', () => {
  afterEach(async () => {
    await cleanupRigs();
  });

  it('显隐切换全链路: 初始全显 → 管理端隐藏某个频道 → 公共列表排除 → 恢复显示后即刻重现', async () => {
    const f = await setupVisibilityApp();

    // 1) 初始状态：公共直播列表同时包含两个可用频道
    const initialPublic = await request(f.app.getHttpServer()).get('/api/public/live/channels');
    expect(initialPublic.status).toBe(200);
    const initialChannelIds = (initialPublic.body.items as { media: { id: string } }[]).map((c) => c.media.id);
    expect(initialChannelIds).toContain(f.channelId1);
    expect(initialChannelIds).toContain(f.channelId2);

    // 2) 管理端查询候选：两者 visible 均为 true
    const candidatesRes = await request(f.app.getHttpServer())
      .post('/api/settings/catalog/candidates/query')
      .set('Cookie', f.cookie)
      .send({ type: 'channel', page: 1, pageSize: 20 });
    expect(candidatesRes.status).toBe(200);
    const candidates = candidatesRes.body as CandidatePageDto;
    const c1 = candidates.items.find((item) => item.id === f.channelId1);
    const c2 = candidates.items.find((item) => item.id === f.channelId2);
    expect(c1?.visible).toBe(true);
    expect(c2?.visible).toBe(true);

    // 3) 管理员将 channelId2 设为隐藏 (visible: false)
    const patchRes = await request(f.app.getHttpServer())
      .patch(`/api/settings/catalog/media/${f.channelId2}`)
      .set('Cookie', f.cookie)
      .send({ expectedVersion: 1, visible: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.version).toBe(2);

    // 4) 管理端工作台仍然能查到已隐藏频道，但 visible 为 false
    const candidatesAfterPatch = await request(f.app.getHttpServer())
      .post('/api/settings/catalog/candidates/query')
      .set('Cookie', f.cookie)
      .send({ type: 'channel', page: 1, pageSize: 20 });
    const c2After = (candidatesAfterPatch.body as CandidatePageDto).items.find((item) => item.id === f.channelId2);
    expect(c2After?.visible).toBe(false);

    // 5) 公共直播列表已严格排除隐藏频道
    const publicAfterHide = await request(f.app.getHttpServer()).get('/api/public/live/channels');
    expect(publicAfterHide.status).toBe(200);
    const idsAfterHide = (publicAfterHide.body.items as { media: { id: string } }[]).map((c) => c.media.id);
    expect(idsAfterHide).toContain(f.channelId1);
    expect(idsAfterHide).not.toContain(f.channelId2);

    // 6) 重新将 channelId2 设为可见 (visible: true)
    const restoreRes = await request(f.app.getHttpServer())
      .patch(`/api/settings/catalog/media/${f.channelId2}`)
      .set('Cookie', f.cookie)
      .send({ expectedVersion: 2, visible: true });
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.version).toBe(3);

    // 7) 公共直播列表即刻恢复该频道
    const publicAfterRestore = await request(f.app.getHttpServer()).get('/api/public/live/channels');
    expect(publicAfterRestore.status).toBe(200);
    const idsAfterRestore = (publicAfterRestore.body.items as { media: { id: string } }[]).map((c) => c.media.id);
    expect(idsAfterRestore).toContain(f.channelId1);
    expect(idsAfterRestore).toContain(f.channelId2);
  });
});
