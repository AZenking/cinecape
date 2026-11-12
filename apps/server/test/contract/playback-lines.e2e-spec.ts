import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { getDb } from '@platform/database/drizzle';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import { mediaItem, mediaSource, playbackSource, profilePolicy, sourceEntry } from '@platform/database/schema';
import {
  cleanupRigs,
  expectProblemContentType,
  startFreshApp,
  type TestRig,
} from '../helpers';
import {
  seedPlaybackWorld,
  PLAYBACK_FIXTURE_NOW,
  type PlaybackWorld,
} from '../fixtures/playback';

/**
 * 016-multi-source-live-epg T017(US3 服务端全链路):播放解析多线路契约测试。
 *
 * 权威依据(父代理契约-现实裁决):
 * - 016 api.md §2.1 所写 `GET /api/playback/channels/:mediaId/resolve` 与现行唯一统一入口
 *   `POST /playback/resolve`(004 契约,宪章原则三)冲突 —— 本测试对准现行入口
 *   `POST /api/playback/resolve`,请求体增量携带可选 `lineId`;
 * - 响应(PlaybackDto)增量携带可选 `selectedLineId` 与 `lines[]`(StreamLine 公开投影:
 *   lineId/sourceId/sourceTitle/label/priority/isDefault/isEnabled;不含源地址/凭据/位置);
 * - 404 语义跟随既有 MEDIA_NOT_FOUND 同形(不存在/无源/线路不存在同形);策略拒绝按现行
 *   稳定语义为 404 MEDIA_NOT_FOUND 同形(T037 裁决①;016 api.md 原文 403 与现行映射冲突,
 *   本测试以现行实现为准并在任务汇报中注明偏离);
 * - 授权零绕行(硬约束):策略裁决发生在授权管线内,先于线路选择 —— 未授权档案的
 *   resolve 在建 session 之前拒绝,响应零线路信息泄漏。
 *
 * 夹具:seedPlaybackWorld(会话/档案/启用 IPTV 世界)+ 用例内直插第二来源与第二条
 * source_entry/playback_source 构造「≥2 条启用线路」的频道(与 fixtures/playback 的
 * 权威 location 形态一致;priority 为导入派生权重的落库形态)。
 */

function cookieOf(world: PlaybackWorld): string {
  return `${SESSION_COOKIE}=${world.sessionToken}`;
}

function postResolve(app: TestRig['app'], cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/playback/resolve').set('Cookie', cookie).send(body);
}

function expectStableProblem(res: request.Response, status: number, code: ProblemCode): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

interface MultiLineSeed {
  readonly mediaId: string;
  readonly lineOne: { readonly entryId: string; readonly sourceId: string };
  readonly lineTwo: { readonly entryId: string; readonly sourceId: string };
}

/**
 * 构造双线路频道:线路 1 挂 world.iptv 来源(priority 10),线路 2 挂新第二来源
 * (priority 20);两线路 playback_source.priority 落导入派生权重形态(10/20)。
 */
async function seedMultiLineChannel(rig: TestRig, world: PlaybackWorld): Promise<MultiLineSeed> {
  const db = getDb();
  const now = PLAYBACK_FIXTURE_NOW;
  const mediaId = randomUUID();
  const sourceTwoId = randomUUID();
  const entryOneId = randomUUID();
  const entryTwoId = randomUUID();
  const lineOneUrl = 'http://iptv.playback-fixture.test/stream/multi-line-1.m3u8';
  const lineTwoUrl = 'http://iptv.playback-fixture.test/stream/multi-line-2.m3u8';

  db.transaction((tx) => {
    // 线路 1 来源 = world.iptv(启用),权重对齐 016 §1.1(数值越小越优先)
    tx.update(mediaSource)
      .set({ priority: 10 })
      .where(eq(mediaSource.id, world.iptv.sourceId))
      .run();
    // 线路 2 来源:第二 IPTV 源(启用,优先级低于线路 1 来源)
    tx.insert(mediaSource)
      .values({
        id: sourceTwoId,
        householdId: world.householdId,
        kind: 'iptv',
        name: '夹具线路B源',
        remoteUrl: 'http://iptv.playback-fixture.test/list-b.m3u8',
        enabled: 1,
        priority: 20,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // 聚合频道 media_item(单逻辑频道,双物理线路)
    tx.insert(mediaItem)
      .values({
        id: mediaId,
        householdId: world.householdId,
        type: 'channel',
        title: '多线路夹具频道',
        contentLevel: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(sourceEntry)
      .values({
        id: entryOneId,
        householdId: world.householdId,
        sourceId: world.iptv.sourceId,
        identityKind: 'url',
        identityDigest: hashToken(lineOneUrl),
        mediaId,
        present: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    tx.insert(sourceEntry)
      .values({
        id: entryTwoId,
        householdId: world.householdId,
        sourceId: sourceTwoId,
        identityKind: 'url',
        identityDigest: hashToken(lineTwoUrl),
        mediaId,
        present: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    // 播放资源:location 私有,不下发;linePriority 落导入派生权重形态
    tx.insert(playbackSource)
      .values({
        id: randomUUID(),
        householdId: world.householdId,
        sourceId: world.iptv.sourceId,
        sourceEntryId: entryOneId,
        mediaItemId: mediaId,
        protocol: 'http',
        location: lineOneUrl,
        mimeType: 'application/vnd.apple.mpegurl',
        priority: 10,
        requiresProxy: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(playbackSource)
      .values({
        id: randomUUID(),
        householdId: world.householdId,
        sourceId: sourceTwoId,
        sourceEntryId: entryTwoId,
        mediaItemId: mediaId,
        protocol: 'http',
        location: lineTwoUrl,
        mimeType: 'application/vnd.apple.mpegurl',
        priority: 20,
        requiresProxy: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  void rig;
  return {
    mediaId,
    lineOne: { entryId: entryOneId, sourceId: world.iptv.sourceId },
    lineTwo: { entryId: entryTwoId, sourceId: sourceTwoId },
  };
}

/** StreamLine 公开投影恰七键(无源地址/凭据/位置/内部 playback_source id) */
const STREAM_LINE_KEYS = ['isDefault', 'isEnabled', 'label', 'lineId', 'priority', 'sourceId', 'sourceTitle'].sort();

describe('POST /api/playback/resolve 多线路下发(016 api.md §2.1 增量,经现行入口)', () => {
  afterEach(cleanupRigs);

  it('① ≥2 条启用线路的频道:响应含 lines[](priority ASC)且 selectedLineId=默认线路;lines 投影无源地址', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lines-basic-' });
    const world = await seedPlaybackWorld(rig);
    const seed = await seedMultiLineChannel(rig, world);
    const cookie = cookieOf(world);

    const res = await postResolve(rig.app, cookie, { mediaId: seed.mediaId });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/playback/sessions/${res.body.id}`);
    // 线路数组:2 条启用线路,按 priority ASC
    expect(Array.isArray(res.body.lines)).toBe(true);
    expect(res.body.lines).toHaveLength(2);
    const lines = res.body.lines as Array<Record<string, unknown>>;
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(STREAM_LINE_KEYS);
    }
    expect(lines[0]?.priority).toBeLessThanOrEqual(Number(lines[1]?.priority));
    // 不透明 lineId = source_entry.id;第一线路(默认)指向权重更高的条目
    expect(lines[0]?.lineId).toBe(seed.lineOne.entryId);
    expect(lines[1]?.lineId).toBe(seed.lineTwo.entryId);
    expect(lines[0]?.isDefault).toBe(true);
    expect(lines[1]?.isDefault).toBe(false);
    expect(lines.every((line) => line.isEnabled === true)).toBe(true);
    // selectedLineId = 默认线路;label 形如「线路 N [来源名]」
    expect(res.body.selectedLineId).toBe(seed.lineOne.entryId);
    expect(String(lines[0]?.label)).toMatch(/^线路 1 \[.+\]$/);
    expect(String(lines[1]?.label)).toMatch(/^线路 2 \[.+\]$/);
    // 公开投影不泄漏源地址/凭据/内部资源 id
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('iptv.playback-fixture.test/stream/multi-line');
    expect(serialized.toLowerCase()).not.toContain('location');
    expect(serialized).not.toContain('playbackSourceId');
  });

  it('② 请求带 lineId 指定第二线路:按指定线路签发(selectedLineId=指定值),lines 仍全量下发', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lines-pick-' });
    const world = await seedPlaybackWorld(rig);
    const seed = await seedMultiLineChannel(rig, world);
    const cookie = cookieOf(world);

    const res = await postResolve(rig.app, cookie, { mediaId: seed.mediaId, lineId: seed.lineTwo.entryId });
    expect(res.status).toBe(201);
    expect(res.body.selectedLineId).toBe(seed.lineTwo.entryId);
    const lines = res.body.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    // 指定线路仍在下发清单中(换线 UI 需要全量顺位)
    expect(lines.map((line) => line.lineId)).toEqual([seed.lineOne.entryId, seed.lineTwo.entryId]);
    // Location 指向新会话(线路切换 = 新 resolve 会话,与主动重复 resolve 语义一致)
    expect(res.headers.location).toBe(`/api/playback/sessions/${res.body.id}`);
  });

  it('③ 不存在的 lineId → 404 MEDIA_NOT_FOUND 同形(与未知媒体 404 逐字段同形,不建 session)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lines-404-' });
    const world = await seedPlaybackWorld(rig);
    const seed = await seedMultiLineChannel(rig, world);
    const cookie = cookieOf(world);

    const badLine = await postResolve(rig.app, cookie, { mediaId: seed.mediaId, lineId: 'no-such-line' });
    expectStableProblem(badLine, 404, ProblemCode.MEDIA_NOT_FOUND);
    const unknownMedia = await postResolve(rig.app, cookie, { mediaId: randomUUID() });
    expectStableProblem(unknownMedia, 404, ProblemCode.MEDIA_NOT_FOUND);
    // 同形:不存在线路与不存在媒体对客户端不可区分
    expect(badLine.body).toEqual(unknownMedia.body);
    // 拒绝路径不建会话
    expect(badLine.headers.location).toBeUndefined();
  });

  it('④ 未授权档案(策略拒绝:未评级且 allowUnrated=0)→ 404 同形且零线路信息泄漏(授权先于线路选择)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lines-denied-' });
    const world = await seedPlaybackWorld(rig);
    const seed = await seedMultiLineChannel(rig, world);
    const cookie = cookieOf(world);
    const db = getDb();

    // 基线:默认策略放行 0 级频道(201)
    const baseline = await postResolve(rig.app, cookie, { mediaId: seed.mediaId });
    expect(baseline.status).toBe(201);

    // 收紧:频道置未评级 + 档案策略 allowUnrated=0 → 策略拒绝
    db.update(mediaItem).set({ contentLevel: null }).where(eq(mediaItem.id, seed.mediaId)).run();
    db.update(profilePolicy).set({ allowUnrated: 0, version: 2 }).where(eq(profilePolicy.profileId, world.profileId)).run();

    const denied = await postResolve(rig.app, cookie, { mediaId: seed.mediaId });
    expectStableProblem(denied, 404, ProblemCode.MEDIA_NOT_FOUND);
    const unknownMedia = await postResolve(rig.app, cookie, { mediaId: randomUUID() });
    // 同形 404:策略拒绝与不存在媒体对客户端不可区分,不泄露判定轴
    expect(denied.body).toEqual(unknownMedia.body);
    // 零线路信息泄漏:响应体不含任何线路字段/线路标识
    const serialized = JSON.stringify(denied.body);
    expect(serialized).not.toContain('lines');
    expect(serialized).not.toContain('selectedLineId');
    expect(serialized).not.toContain(seed.lineOne.entryId);
    expect(serialized).not.toContain(seed.lineTwo.entryId);
  });

  it('⑤ 单线路频道保持既有键面(无 lines/selectedLineId;向后兼容基线)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-lines-legacy-' });
    const world = await seedPlaybackWorld(rig);
    const cookie = cookieOf(world);

    const res = await postResolve(rig.app, cookie, { mediaId: world.iptv.mediaId });
    expect(res.status).toBe(201);
    expect(res.body.lines).toBeUndefined();
    expect(res.body.selectedLineId).toBeUndefined();
    expect(Object.keys(res.body)).not.toContain('lines');
    expect(Object.keys(res.body)).not.toContain('selectedLineId');
  });
});
