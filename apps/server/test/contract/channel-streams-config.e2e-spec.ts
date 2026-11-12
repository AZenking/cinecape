import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
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
import {
  buildM3u,
  createControlledMediaServer,
  type ControlledMediaServer,
} from '../fixtures/controlled-media-server';

interface StreamsRig {
  app: INestApplication;
  cookie: string;
  householdId: string;
}

const mediaServers: ControlledMediaServer[] = [];

async function setupStreamsApp(): Promise<StreamsRig> {
  const fresh = await startFreshApp({
    prefix: 'hmp-streams-config-',
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
  targetStatus: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(app.getHttpServer())
      .get(`/api/settings/refreshes/${refreshId}`)
      .set('Cookie', cookie);
    if (res.status === 200 && (res.body as { status: string }).status === targetStatus) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for refresh ${refreshId} to reach ${targetStatus}, current=${res.body?.status}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

afterEach(async () => {
  while (mediaServers.length > 0) {
    const s = mediaServers.pop();
    if (s) await s.close();
  }
  await cleanupRigs();
});

describe('频道直播源线路可配置性测试 (GET/POST/PATCH/DELETE /settings/catalog/media/:id/streams)', () => {
  it('支持查看线路、修改线路 URL、设为主线路(提升优先级)、新增与删除线路', async () => {
    const media = await createControlledMediaServer();
    mediaServers.push(media);

    media.setRoute('/playlist.m3u', {
      kind: 'm3u',
      content: buildM3u([
        {
          name: 'CCTV-1 综合',
          url: 'http://upstream.example.com/cctv1-hd.m3u8',
          tvgId: 'cctv1',
        },
      ]),
    });

    const rig = await setupStreamsApp();

    // 1. 创建 IPTV 订阅源并刷新
    const createRes = await request(rig.app.getHttpServer())
      .post('/api/settings/sources')
      .set('Cookie', rig.cookie)
      .send({
        kind: 'iptv',
        name: '测试直播源',
        enabled: true,
        remoteUrl: 'http://placeholder.media.invalid/playlist.m3u',
        privateAccessApproved: true,
      });
    expect(createRes.status).toBe(201);
    const sourceId = createRes.body.id as string;

    Database.db
      .prepare('UPDATE media_source SET remote_url = ? WHERE id = ?')
      .run(`${media.baseUrl}/playlist.m3u`, sourceId);

    const refreshRes = await request(rig.app.getHttpServer())
      .post(`/api/settings/sources/${sourceId}/refresh`)
      .set('Cookie', rig.cookie)
      .send({ expectedVersion: 1, operationKey: randomUUID() });
    expect(refreshRes.status).toBe(202);
    await waitRefreshStatus(rig.app, rig.cookie, refreshRes.body.id as string, 'succeeded');

    // 2. 查询频道
    const candRes = await request(rig.app.getHttpServer())
      .post('/api/settings/catalog/candidates/query')
      .set('Cookie', rig.cookie)
      .send({ type: 'channel' });
    expect(candRes.status).toBe(200);
    const candidates = candRes.body as CandidatePageDto;
    expect(candidates.items.length).toBeGreaterThan(0);
    const channel = candidates.items[0]!;

    // 3. GET 频道的所有播放线路
    const streamsRes = await request(rig.app.getHttpServer())
      .get(`/api/settings/catalog/media/${channel.id}/streams`)
      .set('Cookie', rig.cookie);
    expect(streamsRes.status).toBe(200);
    expect(streamsRes.body.items).toHaveLength(1);
    const initialStream = streamsRes.body.items[0];
    expect(initialStream.location).toBe('http://upstream.example.com/cctv1-hd.m3u8');
    expect(initialStream.protocol).toBe('hls');

    // 4. POST 为频道新增一条备用直播源线路
    const addRes = await request(rig.app.getHttpServer())
      .post(`/api/settings/catalog/media/${channel.id}/streams`)
      .set('Cookie', rig.cookie)
      .send({
        location: 'http://backup.example.com/cctv1-backup.m3u8',
        protocol: 'hls',
        priority: 5,
      });
    expect(addRes.status).toBe(200);
    const newStream = addRes.body;
    expect(newStream.id).toBeDefined();
    expect(newStream.location).toBe('http://backup.example.com/cctv1-backup.m3u8');

    // 再次 GET 确认有 2 条线路
    const streamsRes2 = await request(rig.app.getHttpServer())
      .get(`/api/settings/catalog/media/${channel.id}/streams`)
      .set('Cookie', rig.cookie);
    expect(streamsRes2.status).toBe(200);
    expect(streamsRes2.body.items).toHaveLength(2);

    // 5. PATCH 修改新线路的 URL
    const updateRes = await request(rig.app.getHttpServer())
      .patch(`/api/settings/catalog/media/${channel.id}/streams/${newStream.id}`)
      .set('Cookie', rig.cookie)
      .send({
        location: 'http://backup.example.com/cctv1-backup-edited.m3u8',
      });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.location).toBe('http://backup.example.com/cctv1-backup-edited.m3u8');

    // 6. PATCH 将新线路提升为最高优先级 (设为主线路)
    const promoteRes = await request(rig.app.getHttpServer())
      .patch(`/api/settings/catalog/media/${channel.id}/streams/${newStream.id}`)
      .set('Cookie', rig.cookie)
      .send({
        priority: 200,
      });
    expect(promoteRes.status).toBe(200);
    expect(promoteRes.body.priority).toBe(200);

    // 验证重新 GET 后的排序：优先级 100 的排在首位
    const streamsRes3 = await request(rig.app.getHttpServer())
      .get(`/api/settings/catalog/media/${channel.id}/streams`)
      .set('Cookie', rig.cookie);
    expect(streamsRes3.body.items[0].id).toBe(newStream.id);
    expect(streamsRes3.body.items[0].location).toBe('http://backup.example.com/cctv1-backup-edited.m3u8');

    // 7. DELETE 删除原始线路
    const delRes = await request(rig.app.getHttpServer())
      .delete(`/api/settings/catalog/media/${channel.id}/streams/${initialStream.id}`)
      .set('Cookie', rig.cookie);
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);

    // 验证剩余 1 条线路
    const streamsRes4 = await request(rig.app.getHttpServer())
      .get(`/api/settings/catalog/media/${channel.id}/streams`)
      .set('Cookie', rig.cookie);
    expect(streamsRes4.body.items).toHaveLength(1);
    expect(streamsRes4.body.items[0].id).toBe(newStream.id);

    // 8. 关联播放历史会话场景下安全删除 (外键约束级联解除测试)
    const sessionId = randomUUID();
    const [profileRow] = Database.db
      .prepare('SELECT id FROM profile WHERE household_id = ? LIMIT 1')
      .all(rig.householdId) as [{ id: string }];
    const [deviceRow] = Database.db
      .prepare('SELECT id FROM device WHERE household_id = ? LIMIT 1')
      .all(rig.householdId) as [{ id: string }];
    const [deviceSessionRow] = Database.db
      .prepare('SELECT id FROM device_session WHERE household_id = ? LIMIT 1')
      .all(rig.householdId) as [{ id: string }];

    const nowIso = new Date().toISOString();
    Database.db
      .prepare(
        `INSERT INTO playback_session (
          id, household_id, device_session_id, device_id, profile_id, media_id,
          playback_source_id, state, delivery, generation, version, position_seconds,
          desired_paused, profile_context_version, cleanup_requested, cleanup_state,
          created_at, ended_at, last_heartbeat_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, 'ended', 'direct', 1, 1, 10.0,
          0, 1, 0, 'complete',
          ?, ?, ?
        )`,
      )
      .run(
        sessionId,
        rig.householdId,
        deviceSessionRow.id,
        deviceRow.id,
        profileRow.id,
        channel.id,
        newStream.id,
        nowIso,
        nowIso,
        nowIso,
      );

    // 删除关联了历史会话的 newStream 线路
    const delStreamWithSessionRes = await request(rig.app.getHttpServer())
      .delete(`/api/settings/catalog/media/${channel.id}/streams/${newStream.id}`)
      .set('Cookie', rig.cookie);
    expect(delStreamWithSessionRes.status).toBe(200);
    expect(delStreamWithSessionRes.body.success).toBe(true);

    // 验证会话中外键已安全置空，无外键违规异常
    const sessionAfter = Database.db
      .prepare('SELECT playback_source_id FROM playback_session WHERE id = ?')
      .get(sessionId) as { playback_source_id: string | null };
    expect(sessionAfter.playback_source_id).toBeNull();
  });
});
