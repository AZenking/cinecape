import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { count } from 'drizzle-orm';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { getDb } from '@platform/database/drizzle';
import { Database } from '@platform/database/database';
import { mediaSource, playbackSession, playbackSource, playbackTicket, sourceEntry } from '@platform/database/schema';
import { cleanupRigs, cookiePairOf, expectProblemContentType, login, startFreshApp } from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';
import { PLAYBACK_FIXTURE_NOW, seedPlaybackWorld, type PlaybackWorld } from '../fixtures/playback';

/**
 * T023(016-multi-source-live-epg · US4 契约 e2e):儿童档案多线路白名单负向矩阵。
 *
 * 权威依据:
 * - 016 spec.md US4 验收 3:「当前观影者为儿童 Profile,访问未在 allowedChannelIds 白名单中
 *   的频道,无论该频道包含多少条备用线路,播放解析器均坚决拒绝播放」;FR-013(多线路/多 EPG
 *   不得越过既有儿童白名单与分级管控);016 api.md §2.1 负向:「403 Forbidden:当前 Profile
 *   未通过 ProfilePolicy(如儿童收看未授权频道)」。
 *
 * ⚠️ 权威口径裁决(只验证既有行为,不改 playback/** 策略代码 —— 本文件为纯测试):
 * - 拒绝签名:016 api.md §2.1 名义「403」vs 现行实现「404 MEDIA_NOT_FOUND 同形」。既有
 *   T037 裁决(playback-authorization.e2e-spec.ts T035/c1~c5)钉住的稳定错误面是
 *   「404 MEDIA_NOT_FOUND:不存在/跨家庭/不可见/无源同形」,策略拒绝不返回策略明细、
 *   与不存在媒体不可区分(防枚举)。本文件按既有策略契约测试的断言面断言
 *   (expectStableProblem 404 + 与缺失媒体 expectSameProblemShape);
 * - lineId 指定线路:T019 落地后现行 resolve 契约(POST /playback/resolve)已接受可选
 *   lineId(请求体 additive 扩展)。本文件钉住的安全不变式:「指定线路」绕行**不可能绕过
 *   授权链** —— body 携带 lineId 与 query 携带(契约外静默忽略)两种形态下,儿童白名单
 *   裁决均先于线路投影发生 → 同样 404 MEDIA_NOT_FOUND 同形(防枚举)+ 同样零签发;
 *   lineId 不构成越权通道(与 T017「策略拒绝先于线路」契约一致)。
 *
 * 夹具(全部复用既有设施,零新 helpers):
 * - test/fixtures/playback seedPlaybackWorld(双档案/启用 IPTV 源/可见频道) +
 *   DB 直改「追接第二条物理线路」(第二 IPTV 源 + source_entry + playback_source,
 *   单事务工厂事实;playback_source (household,source_entry) 唯一,同媒体多行即多线路);
 * - unlockSettingsAsOwner 同款升格(有 PIN 成人 → 主档案)承担设置边界;
 * - 儿童档案经 POST /settings/profiles 创建(type=child,无 PIN),独立会话选档;
 * - 白名单裁决面:PUT /settings/profiles/{childId}/policy/lists(allowedChannelIds=[])。
 */

/* ------------------------------------------------------------------ */
/* 通用助手(照 playback-authorization.e2e-spec.ts 同款内联惯例)        */
/* ------------------------------------------------------------------ */

function cookieOf(world: PlaybackWorld): string {
  return `${SESSION_COOKIE}=${world.sessionToken}`;
}

type SeededWorld = PlaybackWorld & { readonly username: string };

function expectStableProblem(res: request.Response, status: number, code: ProblemCode): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 同形断言:两响应的 problem 体逐字段一致(码与体结构一致,无法区分存在性) */
function expectSameProblemShape(a: request.Response, b: request.Response): void {
  expect(a.body).toEqual(b.body);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function postResolve(app: INestApplication, cookie: string, mediaId: string, query?: { lineId?: string }): request.Test {
  const req = request(app.getHttpServer()).post('/api/playback/resolve').set('Cookie', cookie);
  if (query?.lineId !== undefined) {
    req.query({ lineId: query.lineId });
  }
  return req.send({ mediaId });
}

function postSelectProfile(app: INestApplication, cookie: string, profileId: string): request.Test {
  return request(app.getHttpServer()).post(`/api/profiles/${profileId}/select`).set('Cookie', cookie).send({});
}

/** 当前策略 version(PUT lists 前 CAS 基准;档案创建即建策略行) */
async function currentPolicyVersion(app: INestApplication, cookie: string, profileId: string): Promise<number> {
  const res = await request(app.getHttpServer())
    .get(`/api/settings/profiles/${profileId}/policy`)
    .set('Cookie', cookie);
  expect(res.status, 'GET policy 应 200(策略行随档案创建已存在)').toBe(200);
  return res.body.version as number;
}

/** 签发面计数:playback_session / playback_ticket 全表行数(拒绝必须零新增) */
function issuanceCounts(): { sessions: number; tickets: number } {
  return {
    sessions: getDb().select({ value: count() }).from(playbackSession).get()?.value ?? 0,
    tickets: getDb().select({ value: count() }).from(playbackTicket).get()?.value ?? 0,
  };
}

/**
 * DB 直改:给既有频道追接第二条物理线路(单事务工厂事实,无 HTTP 语义):
 * 第二 IPTV 源(enabled=1,priority=200)+ source_entry(present=1,回链同 media_id)
 * + playback_source(受控代理路径形态,同 fixture 首线路);同名频道自此聚合两条线路。
 */
function attachBackupLine(
  householdId: string,
  mediaId: string,
): { sourceId: string; entryId: string; playbackSourceId: string } {
  const now = PLAYBACK_FIXTURE_NOW;
  const ids = { sourceId: randomUUID(), entryId: randomUUID(), playbackSourceId: randomUUID() };
  const db = getDb();
  db.transaction((tx) => {
    tx.insert(mediaSource)
      .values({
        id: ids.sourceId,
        householdId,
        kind: 'iptv',
        name: '备用线路源',
        remoteUrl: 'http://iptv.playback-fixture.test/backup.m3u8',
        enabled: 1,
        priority: 200,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(sourceEntry)
      .values({
        id: ids.entryId,
        householdId,
        sourceId: ids.sourceId,
        identityKind: 'url',
        identityDigest: sha256('backup-line:fixture-channel'),
        mediaId,
        present: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    tx.insert(playbackSource)
      .values({
        id: ids.playbackSourceId,
        householdId,
        sourceId: ids.sourceId,
        sourceEntryId: ids.entryId,
        mediaItemId: mediaId,
        protocol: 'http',
        location: 'http://iptv.playback-fixture.test/backup/stream/fixture-channel.m3u8',
        mimeType: 'application/vnd.apple.mpegurl',
        priority: 200,
        requiresProxy: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  });
  return ids;
}

interface ChildMultilineWorld {
  readonly app: INestApplication;
  readonly world: SeededWorld;
  /** 儿童会话 Cookie(已选儿童档案)与档案 id */
  readonly childCookie: string;
  readonly childProfileId: string;
  /** 追接的备用线路句柄(线路 1 = world.iptv 原始夹具,线路 2 = backup) */
  readonly backup: { sourceId: string; entryId: string; playbackSourceId: string };
  /** 频道多线路事实:两条 source_entry / 两条 playback_source 回链同一媒体 */
  readonly multilineLineEntryIds: [string, string];
}

/**
 * 多线路世界 + 儿童档案编排:startFreshApp → seedPlaybackWorld → 追接备用线路 →
 * 升格主档案解锁设置 → 创建儿童档案(无 PIN)→ 独立会话选档。
 */
async function startChildMultilineWorld(prefix: string): Promise<ChildMultilineWorld> {
  const rig = await startFreshApp({ prefix });
  const username = 'multiline';
  const world = { ...(await seedPlaybackWorld(rig, { username })), username };
  const backup = attachBackupLine(world.householdId, world.iptv.mediaId);

  // 设置边界:升格有 PIN 成人为主档案并解锁(005 US8;副作用:world 会话切至主档案)
  Database.db
    .prepare("UPDATE profile SET is_main = 1 WHERE id = ? AND type = 'adult' AND status = 'active' AND pin_hash IS NOT NULL")
    .run(world.profileWithPinId);
  await selectMainAndUnlockSettings(rig.app, cookieOf(world), { mainPin: world.pin });

  // 儿童档案(无 PIN)+ 独立会话选档
  const create = await request(rig.app.getHttpServer())
    .post('/api/settings/profiles')
    .set('Cookie', cookieOf(world))
    .send({ name: '儿童档案', type: 'child' });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const childProfileId = (create.body as Record<string, unknown>)['id'] as string;
  const childLogin = await login(rig.app, username, world.password);
  expect(childLogin.status).toBe(200);
  const childCookie = cookiePairOf(childLogin);
  const select = await postSelectProfile(rig.app, childCookie, childProfileId);
  expect(select.status, '儿童档案(无 PIN)应可直接选择').toBe(200);

  return {
    app: rig.app,
    world,
    childCookie,
    childProfileId,
    backup,
    multilineLineEntryIds: [world.iptv.entryId, backup.entryId],
  };
}

/** 经 HTTP 名单入口把儿童白名单置空(allowedChannelIds=[];version+1) */
async function setChildWhitelistEmpty(app: INestApplication, world: SeededWorld, childProfileId: string): Promise<void> {
  const version = await currentPolicyVersion(app, cookieOf(world), childProfileId);
  const res = await request(app.getHttpServer())
    .put(`/api/settings/profiles/${childProfileId}/policy/lists`)
    .set('Cookie', cookieOf(world))
    .send({ expectedVersion: version, allowedMediaIds: [], blockedMediaIds: [], allowedChannelIds: [] });
  expect(res.status, 'PUT policy/lists 应 200').toBe(200);
  expect(res.body.version, '策略保存必须 version+1').toBe(version + 1);
}

/** 双线路事实自检(原生 SQL;不依赖 drizzle where 组装) */
function multilineLineCount(mediaId: string): { entries: number; playbackSources: number } {
  const conn = Database.db;
  return {
    entries: (conn.prepare('SELECT COUNT(*) AS n FROM source_entry WHERE media_id = ? AND present = 1').get(mediaId) as { n: number }).n,
    playbackSources: (conn.prepare('SELECT COUNT(*) AS n FROM playback_source WHERE media_item_id = ?').get(mediaId) as { n: number }).n,
  };
}

afterEach(async () => {
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('T023 儿童档案多线路白名单负向(016 US4 验收 3;FR-013)', () => {
  it('儿童档案访问白名单外多线路频道:默认优选 resolve 拒绝 —— 404 MEDIA_NOT_FOUND 与缺失媒体同形,零签发,响应/错误面不泄漏线路细节', async () => {
    const w = await startChildMultilineWorld('hmp-child-line-deny-');
    const mediaId = w.world.iptv.mediaId;
    // 前置事实:该频道确有两条物理线路(present 条目 ×2,播放资源 ×2)
    expect(multilineLineCount(mediaId)).toEqual({ entries: 2, playbackSources: 2 });

    await setChildWhitelistEmpty(w.app, w.world, w.childProfileId);
    expect(issuanceCounts()).toEqual({ sessions: 0, tickets: 0 });

    const denied = await postResolve(w.app, w.childCookie, mediaId);
    expectStableProblem(denied, 404, ProblemCode.MEDIA_NOT_FOUND);

    // 同形:与「缺失媒体」逐字段一致(多线路不因白名单外而泄露存在性)
    const missing = await postResolve(w.app, w.childCookie, randomUUID());
    expectStableProblem(missing, 404, ProblemCode.MEDIA_NOT_FOUND);
    expectSameProblemShape(denied, missing);

    // 零签发:拒绝路径不建 session、不下发 ticket
    expect(issuanceCounts()).toEqual({ sessions: 0, tickets: 0 });

    // 不泄漏线路细节:problem 体与请求面不含任何线路 location/条目/来源句柄
    const deniedText = JSON.stringify(denied.body);
    for (const fragment of [
      'iptv.playback-fixture.test',
      'backup',
      'fixture-channel',
      w.backup.sourceId,
      w.backup.entryId,
      w.backup.playbackSourceId,
      w.world.iptv.sourceId,
      w.world.iptv.entryId,
    ]) {
      expect(deniedText, `拒绝面不得包含线路细节「${fragment}」`).not.toContain(fragment);
    }
  });

  it('指定线路绕行同样拒绝签发:body 携带 lineId(现行契约合法字段)进入授权链后白名单照常 404;query 携带 = 契约外忽略后白名单照常 404;两条线路任一指定均零签发', async () => {
    const w = await startChildMultilineWorld('hmp-child-line-bypass-');
    const mediaId = w.world.iptv.mediaId;
    expect(multilineLineCount(mediaId)).toEqual({ entries: 2, playbackSources: 2 });
    await setChildWhitelistEmpty(w.app, w.world, w.childProfileId);
    const baseline = issuanceCounts();

    for (const lineId of w.multilineLineEntryIds) {
      // body 携带 lineId:T019 起为契约合法可选字段 → 进入授权链 → 儿童白名单裁决
      // 先于线路投影发生 → 404 同形(lineId 不构成越权通道,与 T017 契约一致)
      const bodyBypass = await request(w.app.getHttpServer())
        .post('/api/playback/resolve')
        .set('Cookie', w.childCookie)
        .send({ mediaId, lineId });
      expectStableProblem(bodyBypass, 404, ProblemCode.MEDIA_NOT_FOUND);
      // query 携带 lineId:契约外参数被忽略,授权链照常按儿童白名单拒绝
      const queryBypass = await postResolve(w.app, w.childCookie, mediaId, { lineId });
      expectStableProblem(queryBypass, 404, ProblemCode.MEDIA_NOT_FOUND);
    }

    // 无论指定哪条线路:零 session、零 ticket(绕行不存在)
    expect(issuanceCounts()).toEqual(baseline);

    // 同形复核:query 绕行的 404 与普通缺失媒体同体(多线路不改变拒绝签名)
    const missing = await postResolve(w.app, w.childCookie, randomUUID(), {
      lineId: w.multilineLineEntryIds[1] as string,
    });
    expectStableProblem(missing, 404, ProblemCode.MEDIA_NOT_FOUND);
    const plainMissing = await postResolve(w.app, w.childCookie, randomUUID());
    expectSameProblemShape(missing, plainMissing);
    expect(issuanceCounts()).toEqual(baseline);
  });

  it('对照组:成人主档案同频道(两条线路)resolve 正常签发 201 —— 拒绝确因儿童白名单而非线路/频道事实', async () => {
    const w = await startChildMultilineWorld('hmp-child-line-adult-');
    const mediaId = w.world.iptv.mediaId;
    expect(multilineLineCount(mediaId)).toEqual({ entries: 2, playbackSources: 2 });

    // world 会话此时即主档案(unlockSettingsAsOwner 升格后选档);成人默认策略放行
    const granted = await postResolve(w.app, cookieOf(w.world), mediaId);
    expect(granted.status, `成人对照 resolve 应 201: ${JSON.stringify(granted.body)}`).toBe(201);
    expect(granted.headers.location).toMatch(/^\/api\/playback\/sessions\//);

    // 对照组内零拒绝面泄漏:成人签发响应同样不回传线路私有 location
    const grantedText = JSON.stringify(granted.body);
    expect(grantedText).not.toContain('iptv.playback-fixture.test');
    expect(grantedText).not.toContain('backup');
  });
});
