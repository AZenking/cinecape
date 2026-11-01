import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import {
  mediaSource,
  playbackProgressState,
  playbackSession,
  profileViewingHistory,
  vodSourceConfig,
} from '@platform/database/schema';
import { registerPersonalPlaybackFactsPort } from '@contexts/personal-data/application/progress-clock.service';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import {
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
  type ControlledMediaServer,
} from '../helpers';
import { MANAGEMENT_MAIN_PIN, createProfileViaSettings, selectMainAndUnlockSettings } from '../helpers-management';
import type { MediaRequestContext } from '../fixtures/controlled-media-server';
import {
  createFixtureTitleWorld,
  createFixtureVodSource,
  createStandardEpisodePresentation,
  createThreeEpisodeSerialWorld,
  findUpstreamRoute,
  type FixtureTitleWorld,
  type FixtureUpstreamSource,
} from '../fixtures/online-vod/fixture-upstream';

/**
 * T036(010-online-vod · US2,测试先行):在线点播 resolve/progress/历史分离/会话接受
 * ledger/受控资源及再授权契约 e2e —— 「只写测试不实现」,依赖 T031 已全部装配
 * (三契约 21/21+36/36+27/27 全绿)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §4(progress/finish 表+语义段:
 *   ProgressReply 保留 applied/reason/historyRevision 并追加 sessionAccepted/
 *   acceptedSampleSeq/acceptedPositionSeconds/acceptedGeneration/sessionStarted;
 *   superseded 可 sessionAccepted=true/applied=false;duplicate 返回原存储结果不再写;
 *   stale sessionAccepted=false 并返回最后会话接受游标;seq 跨 generation 单调;
 *   resolve 严格 oneOf;发票只走 renew)+ §7 I4(playbackStarted/seekCapability);
 * - docs/specs/010-online-vod/contracts/playback-state.md(三起点/进度事务机/seq 与
 *   generation 权威:sessionAccepted 与历史 applied 分离、ledger 位置允许倒退不能取
 *   MAX、旧代输出不能 ready、seq 不归零);
 * - docs/specs/010-online-vod/data-model.md §5(会话 ledger 与 epoch 历史分离:新有效
 *   样本先更新 ledger 再按 epoch 决定历史;superseded 不覆盖新 owner 历史;from-head
 *   可降低位置;本次 probe 未知则不能用历史 duration 作为在线兜底)与 §6(input
 *   binding:每 session/generation 最多一有效绑定;frozen_start_seconds nullable 直到
 *   probe;start_basis 三值);
 * - docs/specs/010-online-vod/tasks.md T036/T040–T043 原文(T040–T043 为被测实现目标,
 *   本文件先钉契约目标面,计划内红失败不跳过);
 * - 行为基线(既有绿,010 增量不得回归):test/contract/playback-progress.contract.spec.ts
 *   (T092)、playback-context-binding.e2e-spec.ts(T045)、playback-readiness.e2e-spec.ts
 *   (T009)、online-vod-catalog.e2e-spec.ts(T022)与 online-vod-auth-boundaries
 *   .e2e-spec.ts(T021 E 组)。
 *
 * 装配方式(沿用 010 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威迁移,含 0007_online_vod)+
 *   initialize/login/selectMainAndUnlockSettings 身份 seed + Supertest 真实 HTTP;
 * - 受控上游 mock 沿用 online-vod-catalog.e2e-spec 的 T031 rig 手法
 *   (createControlledMediaServer 127.0.0.1 随机端口 + fixture-upstream 路由表
 *   findUpstreamRoute 按 pathname+query 派发 Apple CMS JSON;LAN_ALLOWED_TARGETS=
 *   '127.0.0.1';全程不发真实外网请求)。来源/物化走真实装配链:HTTP 搜索→预览→
 *   POST /api/vod/materializations(T031 已绿)产生在线 media_item/source_entry/
 *   playback_source(locator_kind='online',protocol='hls');
 * - 双设备/双 Profile:两次 login 即两个 DeviceSession(设备A/设备B),第二 Profile
 *   经 Settings API 创建(同 online-vod-auth-boundaries B 组惯例);
 * - 时长事实注入沿用 T092 seam:registerPersonalPlaybackFactsPort 覆盖 probe 事实
 *   (3600s=「probe 已知」;null=「probe 未知」,与生产桥 LIVE_STREAM_FACTS duration=null
 *   同形 —— E 组在线时长未知场景即走该形态);
 * - DB 直改仅用于无 HTTP 语义的工厂事实,逐处注明:会话行/状态行/历史行种子(等价
 *   resolve 绑定/started 形态)、server_rebuild 换代(playback_session.generation CAS
 *   推进的库内事实,010 中由 T045 过渡/重建管线产生)、content/continuity 修订推进、
 *   禁源。不改任何共享文件;无 git 操作。
 *
 * ───────────────────────── 计划内红清单(失败不跳过)─────────────────────────
 * T036 为测试先行:A–F 组大部分用例钉 010 新字段/新语义(T040–T043/T045/T046 未实现),
 * 当前失败原因一律为「响应缺 010 新字段」或「010 拒绝/记录语义未实现(旧路径放行)」;
 * 既有语义回归(resolve 201 形态/准备不建历史/epoch 旧义/seq 簿记/受控资源/stop 与
 * 授权负向)应绿。红→绿映射:
 *
 * | 用例 | 计划内红断言(当前失败原因)                                  | 转绿任务        |
 * | ---- | ----------------------------------------------------------- | --------------- |
 * | A3   | resolve/状态 PlaybackDto 缺 startBasis/resumeDisposition/resumeReason(键缺失)| T041+T043+T046 |
 * | A4   | 无 playback_input_binding 行(start_basis 未记录、probe 前 frozen_start_seconds 应 NULL)| T042 |
 * | B2   | ProgressReply 缺 sessionAccepted/acceptedSampleSeq/acceptedPositionSeconds/acceptedGeneration/sessionStarted(8 键)| T040+T046 |
 * | B3   | ledger_position/ledger_duration/ledger_generation/ledger_accepted_at/session_started 未落库(NULL/0)| T040 |
 * | B5   | stale_sample 缺 sessionAccepted=false + 最后会话接受游标      | T040+T046      |
 * | C1   | superseded 缺 sessionAccepted=true/applied=false 会话接受形态 | T040+T046      |
 * | C3   | 跨 generation ledger 游标未记录(ledger_generation=新代、游标续接)| T040          |
 * | D3   | 在线历史缺 continuity_revision/evidence_state 证据记录(NULL) | T040           |
 * | E1   | 时长未知在线样本回落历史 duration 兜底(当前 200 accepted)    | T040+T041      |
 * | E2   | resumeDisposition/resumeReason 缺字段;presentationStart 冻结了历史位置 | T041+T046 |
 * | F2   | continuity 修订变化未拒绝旧绑定进度(当前 200 accepted)       | T043           |
 * | F4   | PlaybackDto 缺 seekCapability/playbackStarted                | T045+T046      |
 *
 * 绿基线(既有语义回归,010 落地不得回归):
 * A1/A2(resolve 201 形态+准备不建历史+严格 oneOf)、B1/B4/B6(applied 旧义/seq 机器/
 * duplicate 原存储结果)、C2/C4(seq 跨代簿记+旧代输出不能 ready/renew/交付)、
 * D1/D2(epoch owner 历史写+superseded 不覆盖+跨 Profile 隔离+from-head 降低位置)、
 * F1/F3/F5(content 修订拒绝/hls_proxy seek 拒绝保留/发票只走 renew)、G1–G3(授权负向)。
 *
 * 预期计数:红 12(A3/A4/B2/B3/B5/C1/C3/D3/E1/E2/F2/F4)/ 绿 15;两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

/** 受信时长事实(T092 seam;3600 = 「probe 已知时长」形态) */
const TRUSTED_DURATION_SECONDS = 3600;

/** 010 ProgressReply 契约 8 键(api.md §1 / openapi ProgressReply:additionalProperties:false) */
const PROGRESS_REPLY_010_KEYS = [
  'applied',
  'reason',
  'historyRevision',
  'sessionAccepted',
  'acceptedSampleSeq',
  'acceptedPositionSeconds',
  'acceptedGeneration',
  'sessionStarted',
] as const;

/** 三起点(api.md §1 PlaybackDto.startBasis) */
const START_BASIS_VALUES = ['beginning', 'target_history', 'transition_carry'] as const;

const RESOLVE_URL = '/api/playback/resolve';

function cookieOf(token: string): string {
  return `${SESSION_COOKIE}=${token}`;
}

/** 计划内红统一标注(消息内钉转绿任务号 + 目标契约形态 + 当前失败原因) */
function redLabel(tasks: string, target: string, current: string): string {
  return `计划内红(待 ${tasks} 转绿):${current} —— ${tasks} 落地后应 ${target}`;
}

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 同形断言:两响应 problem 体逐字段一致(码与体结构一致,不可区分存在性) */
function expectSameProblemShape(a: request.Response, b: request.Response): void {
  expect(a.body).toEqual(b.body);
}

/* ------------------------------------------------------------------ */
/* 上游 mock(010 T031 rig 手法:受控 CMS 端口 + fixture 路由表派发)       */
/* ------------------------------------------------------------------ */

const activeMediaServers: ControlledMediaServer[] = [];

/**
 * 时长未知影片世界(endList=false 清单形态,data-model §5「本次 probe 未知」素材;
 * fixture-upstream 的 createStandardEpisodePresentation 支持 endList:false)。
 */
function createUnknownDurationMovieWorld(origin: string): FixtureTitleWorld {
  const presentation = createStandardEpisodePresentation({
    presentationKey: 't036-unknown-duration:01',
    episodeKey: '01',
    origin,
    rootPath: '/vod/hls/9001/ep-01',
    segmentCount: 2,
    segmentDurationSeconds: 60,
    endList: false,
  });
  return createFixtureTitleWorld({
    titleKey: 't036-unknown-duration',
    searchKeyword: 'silentpost',
    upstreamVodId: 9001,
    name: 'fixture·未知时长影片',
    year: '2022',
    remarks: '正片',
    episodesTotal: 1,
    synopsis: '清单无 #EXT-X-ENDLIST(总时长未知形态):在线时长不得以历史 duration 兜底(T036 E 组素材)。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [
          { episodeKey: '01', label: '第01集', presentation, ordinal: 1, sequenceStatus: 'ordered' },
        ],
      },
    ],
  });
}

/** 构建单个健康受控源(三集连续剧[已知时长] + endList=false 未知时长影片) */
function buildHealthySource(port: number): FixtureUpstreamSource {
  const origin = `http://127.0.0.1:${port}`;
  return createFixtureVodSource({
    sourceId: 'fixture-vod-source-t036',
    displayName: '夹具在线片源(T036)',
    behavior: 'healthy',
    address: { host: '127.0.0.1', port },
    titleWorlds: [createThreeEpisodeSerialWorld(origin), createUnknownDurationMovieWorld(origin)],
  });
}

/* ------------------------------------------------------------------ */
/* rig:受控上游 + 全量迁移 app + 双设备身份 + HTTP 物化在线剧集           */
/* ------------------------------------------------------------------ */

interface OnlinePlaybackRig {
  readonly app: INestApplication;
  readonly householdId: string;
  readonly server: ControlledMediaServer;
  /** 设备A · 档案A(主档案) */
  readonly cookieA: string;
  /** 设备B · 档案A(同档案第二设备;跨设备/同 Profile 双会话场景) */
  readonly cookieB: string;
  readonly profileAId: string;
  readonly deviceSessionAId: string;
  readonly deviceSessionBId: string;
  /** 已物化三集连续剧(T031 真实装配链产物) */
  readonly serial: {
    readonly parentMediaId: string;
    readonly ep01MediaId: string;
    /** EP01 逻辑时长(3×120s;fixture 清单聚合) */
    readonly ep01DurationSeconds: number;
  };
  /** 已物化未知时长影片(endList=false) */
  readonly unknownMovieMediaId: string;
}

function householdIdOf(): string {
  const row = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string } | undefined;
  expect(row, '夹具错误:household 行不存在(初始化未执行)').toBeDefined();
  return row!.id;
}

/** 搜索 → 首卡 → 预览 → POST /api/vod/materializations(真实 T031 链)→ 子项 mediaId */
async function materializeEpisode(app: INestApplication, cookie: string, keyword: string): Promise<{
  mediaId: string;
  parentMediaId: string;
}> {
  const search = await request(app.getHttpServer()).get('/api/public/vod/search').query({ q: keyword });
  expect(search.status, `搜索 ${keyword} 应 200(受控上游)`).toBe(200);
  const card = (search.body as { items: Array<{ titleRef: string }> }).items[0];
  expect(card, `搜索 ${keyword} 应至少一条结果`).toBeDefined();
  const preview = await request(app.getHttpServer()).get(`/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`);
  expect(preview.status, `预览 ${card!.titleRef} 应 200`).toBe(200);
  const episodeRef = (preview.body as { lines: Array<{ episodes: Array<{ episodeRef: string }> }> }).lines[0]?.episodes[0]
    ?.episodeRef;
  expect(episodeRef, '预览应有候选分集').toBeTypeOf('string');
  const res = await request(app.getHttpServer())
    .post('/api/vod/materializations')
    .set('Cookie', cookie)
    .send({ titleRef: card!.titleRef, episodeRef, previewRevision: (preview.body as { previewRevision: number }).previewRevision, operationKey: randomUUID() });
  expect(res.status, `物化 ${keyword} 应 201(T031 已装配;实际 ${JSON.stringify(res.body)})`).toBe(201);
  const body = res.body as { mediaId: string; parentMediaId: string };
  return { mediaId: body.mediaId, parentMediaId: body.parentMediaId };
}

async function startOnlinePlaybackRig(prefix: string): Promise<OnlinePlaybackRig> {
  const source = buildHealthySource(0);
  const server = await createControlledMediaServer({
    routes: [
      {
        path: source.apiPath,
        kind: 'raw' as const,
        respond: (context: MediaRequestContext) => {
          const route = findUpstreamRoute(source.routes, context.url.href);
          if (route === null) {
            context.res.statusCode = 404;
            context.res.setHeader('content-type', 'text/plain; charset=utf-8');
            context.res.end('fixture upstream: no route');
            return;
          }
          if (route.response.kind === 'timeout') {
            // 挂起不回包(与 catalog rig 同形态;本文件路由全为健康应答,防御分支)
            return;
          }
          context.res.statusCode = route.response.status;
          for (const [name, value] of Object.entries(route.response.headers)) {
            context.res.setHeader(name, value);
          }
          context.res.end(route.response.body);
        },
      },
    ],
  });
  activeMediaServers.push(server);

  const fresh = await startFreshApp({
    prefix,
    env: { LAN_ALLOWED_TARGETS: '127.0.0.1' },
  });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  // cookiePairOf 已返回完整 name=value Cookie 对(hmp_session=…),直接回传
  const cookieA = cookiePairOf(loggedIn);
  const profileAId = await selectMainAndUnlockSettings(fresh.app, cookieA);

  // 第二设备:同账号新登录(新 DeviceSession),选同一主档案(跨设备/同 Profile 场景)
  const secondLogin = await login(fresh.app, 'admin', 'password-123', { deviceName: '设备B' });
  expect(secondLogin.status).toBe(200);
  const cookieB = cookiePairOf(secondLogin);
  // 主档案 PIN 保护时,新设备会话先解锁再选档(同 selectMainAndUnlockSettings 次序)
  const unlockB = await request(fresh.app.getHttpServer())
    .post(`/api/profiles/${profileAId}/unlock`)
    .set('Cookie', cookieB)
    .send({ pin: MANAGEMENT_MAIN_PIN });
  if (unlockB.status !== 200 && unlockB.status !== 404) {
    throw new Error(`夹具错误:设备B 解锁主档案失败 ${unlockB.status} ${JSON.stringify(unlockB.body)}`);
  }
  const selectB = await request(fresh.app.getHttpServer()).post(`/api/profiles/${profileAId}/select`).set('Cookie', cookieB).send({});
  expect(selectB.status, '设备B 选主档案应 200').toBe(200);

  const householdId = householdIdOf();
  seedVodSourceRow(householdId, `${server.baseUrl}${source.apiPath}`);

  // 在线剧集物化(T031 真实装配链:搜索→预览→物化,产生 online playback_source)
  const serial = await materializeEpisode(fresh.app, cookieA, 'stardust');
  const unknownMovie = await materializeEpisode(fresh.app, cookieA, 'silentpost');

  // 设备会话行 id(按登录令牌哈希精确反查;两登录同毫秒时 created_at 排序不稳定)
  const deviceSessionAId = deviceSessionIdOfToken(loggedIn.body.sessionToken as string);
  const deviceSessionBId = deviceSessionIdOfToken(secondLogin.body.sessionToken as string);

  return {
    app: fresh.app,
    householdId,
    server,
    cookieA,
    cookieB,
    profileAId,
    deviceSessionAId,
    deviceSessionBId,
    serial: { parentMediaId: serial.parentMediaId, ep01MediaId: serial.mediaId, ep01DurationSeconds: 360 },
    unknownMovieMediaId: unknownMovie.mediaId,
  };
}

/** 登录令牌 → DeviceSession 行 id(token_hash=SHA-256(明文令牌),与 SessionGuard 同算法) */
function deviceSessionIdOfToken(token: string): string {
  const row = Database.db.prepare('SELECT id FROM device_session WHERE token_hash = ?').get(hashToken(token)) as
    | { id: string }
    | undefined;
  expect(row, '夹具错误:登录令牌对应的 device_session 行不存在').toBeDefined();
  return row!.id;
}

/** kind=vod 来源行(media_source + vod_source_config 一源一行;对齐 catalog seedVodSourceRow 口径) */
function seedVodSourceRow(householdId: string, remoteUrl: string): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({
        id: sourceId,
        householdId,
        kind: 'vod',
        name: `夹具在线片源-${sourceId.slice(0, 8)}`,
        remoteUrl,
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(vodSourceConfig).values({ householdId, sourceId, adapter: 'apple-cms-json' }).run();
  });
  return sourceId;
}

/* ------------------------------------------------------------------ */
/* DB 读/种子(工厂事实;逐处注明)                                        */
/* ------------------------------------------------------------------ */

interface ProgressStateRow {
  readonly candidateEpoch: number;
  readonly contentRevision: number | null;
  readonly started: number;
  readonly sessionStarted: number;
  readonly lastSampleSeq: number;
  readonly lastGeneration: number;
  readonly ledgerPosition: number | null;
  readonly ledgerDuration: number | null;
  readonly ledgerGeneration: number | null;
  readonly ledgerAcceptedAt: string | null;
}

function progressStateRowOf(sessionId: string): ProgressStateRow {
  const row = Database.db
    .prepare(
      `SELECT candidate_epoch AS candidateEpoch, content_revision AS contentRevision, started,
              session_started AS sessionStarted, last_sample_seq AS lastSampleSeq,
              last_generation AS lastGeneration, ledger_position AS ledgerPosition,
              ledger_duration AS ledgerDuration, ledger_generation AS ledgerGeneration,
              ledger_accepted_at AS ledgerAcceptedAt
       FROM playback_progress_state WHERE playback_session_id = ?`,
    )
    .get(sessionId) as ProgressStateRow | undefined;
  expect(row, `夹具错误:playback_progress_state ${sessionId} 不存在(resolve 绑定应已建档)`).toBeDefined();
  return row!;
}

interface HistoryRow {
  readonly writerEpoch: number;
  readonly writerPlaybackSessionId: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number | null;
  readonly revision: number;
  readonly lastSampleSeq: number;
  readonly continuityRevision: number | null;
  readonly evidenceState: string | null;
  readonly evidenceDigest: string | null;
  readonly completed: number;
}

function historyRowOf(householdId: string, profileId: string, mediaId: string): HistoryRow | undefined {
  return Database.db
    .prepare(
      `SELECT writer_epoch AS writerEpoch, writer_playback_session_id AS writerPlaybackSessionId,
              position_seconds AS positionSeconds, duration_seconds AS durationSeconds, revision,
              last_sample_seq AS lastSampleSeq, continuity_revision AS continuityRevision,
              evidence_state AS evidenceState, evidence_digest AS evidenceDigest, completed
       FROM profile_viewing_history
       WHERE household_id = ? AND profile_id = ? AND media_id = ?`,
    )
    .get(householdId, profileId, mediaId) as HistoryRow | undefined;
}

function historyRowCount(householdId: string, mediaId: string): number {
  return (
    Database.db.prepare('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ? AND media_id = ?').get(householdId, mediaId) as {
      n: number;
    }
  ).n;
}

function mediaContentRevisionOf(mediaId: string): number {
  const row = Database.db.prepare('SELECT content_revision AS r FROM media_item WHERE id = ?').get(mediaId) as
    | { r: number | null }
    | undefined;
  expect(row, `夹具错误:media_item ${mediaId} 不存在`).toBeDefined();
  return row!.r ?? 1;
}

function inputBindingCount(householdId: string, sessionId: string): number {
  return (
    Database.db
      .prepare('SELECT COUNT(*) AS n FROM playback_input_binding WHERE household_id = ? AND session_id = ?')
      .get(householdId, sessionId) as { n: number }
  ).n;
}

function inputBindingFrozenCount(householdId: string, sessionId: string): number {
  return (
    Database.db
      .prepare(
        'SELECT COUNT(*) AS n FROM playback_input_binding WHERE household_id = ? AND session_id = ? AND frozen_start_seconds IS NOT NULL',
      )
      .get(householdId, sessionId) as { n: number }
  ).n;
}

function playbackSourceIdOf(householdId: string, mediaId: string): string {
  const row = Database.db
    .prepare('SELECT id FROM playback_source WHERE household_id = ? AND media_item_id = ? LIMIT 1')
    .get(householdId, mediaId) as { id: string } | undefined;
  expect(row, `夹具错误:media ${mediaId} 应有物化播放资源`).toBeDefined();
  return row!.id;
}

function deviceSessionProfileContextVersionOf(deviceSessionId: string): number {
  const row = Database.db.prepare('SELECT profile_context_version AS v FROM device_session WHERE id = ?').get(deviceSessionId) as
    | { v: number }
    | undefined;
  expect(row, `夹具错误:device_session ${deviceSessionId} 不存在`).toBeDefined();
  return row!.v;
}

/** 设备会话所属设备 id(FK 权威;种子会话行 device_id 必须取库内值) */
function deviceOfDeviceSession(deviceSessionId: string): string {
  const row = Database.db.prepare('SELECT device_id AS d FROM device_session WHERE id = ?').get(deviceSessionId) as
    | { d: string }
    | undefined;
  expect(row, `夹具错误:device_session ${deviceSessionId} 不存在`).toBeDefined();
  return row!.d;
}

/**
 * 种子:指定状态在线播放会话行(工厂事实;等价 resolve→probe→ready/playing 形态:
 * delivery='hls_proxy'、online 源、profile_context_version 取设备会话当前值)。
 */
function seedOnlineSessionRow(input: {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly playbackSourceId: string;
  readonly state: 'preparing' | 'ready' | 'playing' | 'paused';
  readonly generation?: number;
}): { sessionId: string; generation: number; version: number } {
  const generation = input.generation ?? 1;
  const version = 1;
  const at = new Date().toISOString();
  const sessionId = randomUUID();
  getDb()
    .insert(playbackSession)
    .values({
      id: sessionId,
      householdId: input.householdId,
      deviceSessionId: input.deviceSessionId,
      deviceId: input.deviceId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      playbackSourceId: input.playbackSourceId,
      state: input.state,
      delivery: 'hls_proxy',
      generation,
      version,
      positionSeconds: 0,
      audioTrackId: null,
      subtitleTrackId: null,
      desiredPaused: input.state === 'paused' ? 1 : 0,
      profileContextVersion: deviceSessionProfileContextVersionOf(input.deviceSessionId),
      createdAt: at,
      startedAt: at,
      endedAt: null,
      lastHeartbeatAt: at,
      failureCode: null,
    })
    .run();
  return { sessionId, generation, version };
}

/** 种子:resolve 绑定形态 progress_state(等价 bindVodResolveCandidate 输出;候选 epoch 显式) */
function seedProgressStateRow(input: {
  readonly householdId: string;
  readonly playbackSessionId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly candidateEpoch: number;
  readonly generation?: number;
}): void {
  getDb()
    .insert(playbackProgressState)
    .values({
      householdId: input.householdId,
      playbackSessionId: input.playbackSessionId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      candidateEpoch: input.candidateEpoch,
      contentRevision: mediaContentRevisionOf(input.mediaId),
      profileContextVersion: 1,
      started: 0,
      lastSampleSeq: 0,
      lastSampleDigest: null,
      lastGeneration: input.generation ?? 1,
      lastResult: null,
    })
    .run();
}

/** 种子:历史行(工厂事实;E 组时长未知兜底素材/既有历史形态) */
function seedHistoryRowFor(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly writerEpoch: number;
  readonly writerPlaybackSessionId: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
}): void {
  const now = new Date().toISOString();
  getDb()
    .insert(profileViewingHistory)
    .values({
      householdId: input.householdId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      writerEpoch: input.writerEpoch,
      writerPlaybackSessionId: input.writerPlaybackSessionId,
      lastSampleSeq: 1,
      contentRevision: mediaContentRevisionOf(input.mediaId),
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
      lastViewedAt: now,
      revision: 1,
      completed: 0,
    })
    .run();
}

/** 种子:终态 dummy 会话(E 组历史 writer FK 目标;等价「上次观看会话」) */
function seedEndedWriterSession(input: {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly mediaId: string;
}): string {
  const at = new Date().toISOString();
  const sessionId = randomUUID();
  getDb()
    .insert(playbackSession)
    .values({
      id: sessionId,
      householdId: input.householdId,
      deviceSessionId: input.deviceSessionId,
      deviceId: input.deviceId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      playbackSourceId: playbackSourceIdOf(input.householdId, input.mediaId),
      state: 'ended',
      delivery: 'hls_proxy',
      generation: 1,
      version: 1,
      positionSeconds: 0,
      audioTrackId: null,
      subtitleTrackId: null,
      desiredPaused: 0,
      profileContextVersion: deviceSessionProfileContextVersionOf(input.deviceSessionId),
      createdAt: at,
      startedAt: at,
      endedAt: at,
      lastHeartbeatAt: at,
      failureCode: null,
    })
    .run();
  return sessionId;
}

/* ------------------------------------------------------------------ */
/* HTTP 助手                                                            */
/* ------------------------------------------------------------------ */

function postResolve(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(RESOLVE_URL).set('Cookie', cookie).send(body);
}

function progressUrl(sessionId: string): string {
  return `/api/playback/sessions/${sessionId}/progress`;
}

function postProgress(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  body: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer()).post(progressUrl(sessionId)).set('Cookie', cookie).send(body);
}

function getStatus(app: INestApplication, cookie: string, sessionId: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${sessionId}`).set('Cookie', cookie);
}

function postSeek(app: INestApplication, cookie: string, sessionId: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(`/api/playback/sessions/${sessionId}/seek`).set('Cookie', cookie).send(body);
}

/** 轮询等待会话进入指定状态(在线 hls 候选 probe 免 ffprobe 即时成功,毫秒级 ready) */
async function waitUntilState(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  wanted: 'ready' | 'playing',
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  let lastState = '';
  while (Date.now() < deadline) {
    const res = await getStatus(app, cookie, sessionId);
    if (res.status === 200) {
      lastState = String((res.body as Record<string, unknown>)['state']);
      if (lastState === wanted) {
        return res.body as Record<string, unknown>;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`夹具错误:会话 ${sessionId} 未在 5s 内进入 ${wanted}(当前 ${lastState || '不可读'})`);
}

/** 轮询等待会话行离开指定状态(终态化;DB 直读) */
function sessionRowOf(sessionId: string): { state: string; generation: number } {
  const row = Database.db
    .prepare('SELECT state, generation FROM playback_session WHERE id = ?')
    .get(sessionId) as { state: string; generation: number } | undefined;
  expect(row, `夹具错误:playback_session ${sessionId} 不存在`).toBeDefined();
  return row!;
}

/* ------------------------------------------------------------------ */
/* 通用 afterEach                                                       */
/* ------------------------------------------------------------------ */

afterEach(async () => {
  registerPersonalPlaybackFactsPort(null);
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* A resolve/准备                                                       */
/* ------------------------------------------------------------------ */

describe('T036 · A resolve/准备(api.md §4 resolve 行 + PlaybackDto 追加字段;data-model §6)', () => {
  it('A1 [绿·既有形态回归] 在线 media resolve 201 preparing:Location+无票+建档 progress_state;准备不建历史(profile_viewing_history 零行)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-a1-');
    const res = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(res.status).toBe(201);
    expect(res.headers['location']).toMatch(/^\/api\/playback\/sessions\//);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as Record<string, unknown>;
    expect(body['id']).toBeTypeOf('string');
    expect(body['state']).toBe('preparing');
    expect(body['generation']).toBe(1);
    // 201 无票:票据仅经 renew(004/005 既有;010 §4「发票仍走 renew」)
    expect(body['playbackUrl'] ?? null).toBeNull();
    expect(body['ticketExpiresAt'] ?? null).toBeNull();
    const sessionId = String(res.headers['location']).split('/').pop();
    // resolve 建档:progress_state 存在(candidate_epoch 分配、未 started),不写可见历史
    const state = progressStateRowOf(sessionId!);
    expect(state.candidateEpoch).toBeGreaterThan(0);
    expect(state.started).toBe(0);
    expect(historyRowCount(rig.householdId, rig.serial.ep01MediaId)).toBe(0);
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)).toBeUndefined();
  });

  it('A2 [绿·严格 oneOf] startMode+transitionIntentId 同给 400;startMode 枚举外 400;beginning/resume 各自 201', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-a2-');
    // 过渡请求禁止 startMode 字段(api.md §4「过渡禁止 startMode」;严格 oneOf 同给 400)
    const both = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep01MediaId,
      startMode: 'beginning',
      transitionIntentId: 'ti-fixture',
    });
    expectProblem(both, 400, ProblemCode.VALIDATION_FAILED);
    // 枚举外 startMode → 400
    const badMode = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId, startMode: 'middle' });
    expectProblem(badMode, 400, ProblemCode.VALIDATION_FAILED);
    // 合法两态各自接受(010:startMode 缺省/ beginning 与 resume 仅点播两值)
    for (const startMode of ['beginning', 'resume']) {
      const ok = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId, startMode });
      expect(ok.status, `startMode=${startMode} 应 201`).toBe(201);
      expect((ok.body as Record<string, unknown>)['state']).toBe('preparing');
    }
  });

  it('A3 [计划内红·待 T041+T043+T046] resolve/状态 PlaybackDto 应含 startBasis/resumeDisposition/resumeReason(准备起点形态)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-a3-');
    const res = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId, startMode: 'beginning' });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    // 计划内红判据:010 PlaybackDto required 集合含 startBasis/resumeDisposition/resumeReason
    // (api.md §1「preparing 未冻结= pending」);当前响应无这些键。
    expect(
      Object.keys(body),
      redLabel(
        'T041+T043+T046',
        `PlaybackDto 应含 startBasis(${START_BASIS_VALUES.join('|')})/resumeDisposition(pending|resume|beginning)/resumeReason`,
        `resolve 响应缺 010 起点 DTO 字段(当前键 ${Object.keys(body).sort().join(',')})`,
      ),
    ).toEqual(expect.arrayContaining(['startBasis', 'resumeDisposition', 'resumeReason']));
    // 转绿后形态(当前不可达):beginning 模式 preparing 期 resumeDisposition=pending
    expect(body['startBasis']).toBe('beginning');
    expect(body['resumeDisposition']).toBe('pending');
  });

  it('A4 [计划内红·待 T042] resolve 应建 playback_input_binding 固定输入绑定(start_basis 记录;probe 前 frozen_start_seconds 为 NULL)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-a4-');
    const res = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(res.status).toBe(201);
    const sessionId = String(res.headers['location']).split('/').pop();
    // 绿护栏:probe 前不得有任何非空 frozen_start(该断言转绿后仍须成立)
    expect(inputBindingFrozenCount(rig.householdId, sessionId!)).toBe(0);
    // 计划内红判据:data-model §6「每 session/generation 最多一有效绑定」「frozen_start_seconds
    // (nullable 直到 probe)」「start_basis 三值」—— T042 未实现,当前 resolve 不建绑定行。
    expect(
      inputBindingCount(rig.householdId, sessionId!),
      redLabel(
        'T042',
        'resolve 应建 playback_input_binding 行(generation=1、start_basis=beginning、frozen_start_seconds=NULL 直到 probe)',
        `当前该会话 playback_input_binding 行数 ${inputBindingCount(rig.householdId, sessionId!)}(固定输入绑定未落库)`,
      ),
    ).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------------ */
/* B progress 会话接受(会话 ledger 与历史 applied 分离)                  */
/* ------------------------------------------------------------------ */

/** 在线 playing 种子会话 + resolve 绑定形态状态行(工厂事实;epoch=1) */
function seedOnlineProgressSession(
  rig: OnlinePlaybackRig,
  options: { mediaId?: string; candidateEpoch?: number; state?: 'ready' | 'playing' | 'paused' } = {},
): { sessionId: string; generation: number; version: number } {
  const mediaId = options.mediaId ?? rig.serial.ep01MediaId;
  const handle = seedOnlineSessionRow({
    householdId: rig.householdId,
    deviceSessionId: rig.deviceSessionAId,
    deviceId: deviceOfDeviceSession(rig.deviceSessionAId),
    profileId: rig.profileAId,
    mediaId,
    playbackSourceId: playbackSourceIdOf(rig.householdId, mediaId),
    state: options.state ?? 'playing',
  });
  seedProgressStateRow({
    householdId: rig.householdId,
    playbackSessionId: handle.sessionId,
    profileId: rig.profileAId,
    mediaId,
    candidateEpoch: options.candidateEpoch ?? 1,
    generation: handle.generation,
  });
  return handle;
}

describe('T036 · B progress 会话接受(api.md §4 ProgressReply 追加字段;data-model §5 ledger)', () => {
  it('B1 [绿·applied 旧义回归] started 样本 200 accepted:{applied:true,reason:accepted,historyRevision>=1};started/seq 簿记落库', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-b1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    const res = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(res.status).toBe(200);
    // applied 旧义保留(只指历史写入);010 追加字段由 B2 单独钉住,此处不钉键全集
    expect(res.body).toMatchObject({ applied: true, reason: 'accepted' });
    expect((res.body as { historyRevision: number }).historyRevision).toBeGreaterThanOrEqual(1);
    const state = progressStateRowOf(handle.sessionId);
    expect(state.started).toBe(1);
    expect(state.lastSampleSeq).toBe(1);
    expect(state.lastGeneration).toBe(handle.generation);
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)?.positionSeconds).toBe(0);
  });

  it('B2 [计划内红·待 T040+T046] started 样本 ProgressReply 会话接受形态:8 键含 sessionAccepted/acceptedSampleSeq/acceptedPositionSeconds/acceptedGeneration/sessionStarted', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-b2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    const res = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    // 计划内红判据:ProgressReply 8 键全量(openapi additionalProperties:false)
    expect(
      Object.keys(body).sort(),
      redLabel(
        'T040+T046',
        `ProgressReply 键集合应为 ${PROGRESS_REPLY_010_KEYS.join(',')}`,
        `当前缺会话接受字段(当前键 ${Object.keys(body).sort().join(',')})`,
      ),
    ).toEqual([...PROGRESS_REPLY_010_KEYS].sort());
    // 转绿后形态(当前不可达):会话接受游标与 sessionStarted
    expect(body['sessionAccepted']).toBe(true);
    expect(body['sessionStarted']).toBe(true);
    expect(body['acceptedSampleSeq']).toBe(1);
    expect(body['acceptedPositionSeconds']).toBe(0);
    expect(body['acceptedGeneration']).toBe(handle.generation);
  });

  it('B3 [计划内红·待 T040] periodic 样本 ledger 前进:ledger_position/ledger_duration/ledger_generation/ledger_accepted_at/session_started 落库', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-b3-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    const res = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 2,
      expectedGeneration: handle.generation,
      positionSeconds: 30,
      reason: 'periodic',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, reason: 'accepted' });
    const state = progressStateRowOf(handle.sessionId);
    // 计划内红判据:data-model §5「新有效样本先更新 ledger,再按 epoch 决定历史」——
    // 当前实现只写 started/seq 簿记,ledger_* 游标列未落库(NULL)。
    expect(
      state.ledgerPosition,
      redLabel(
        'T040',
        'periodic 样本应更新会话 ledger(ledger_position=30、ledger_duration=3600、ledger_generation=1、ledger_accepted_at 非空、session_started=1)',
        `当前 ledger_position=${String(state.ledgerPosition)}(ledger 游标列未落库)`,
      ),
    ).toBe(30);
    expect(state.ledgerDuration, redLabel('T040', 'ledger_duration=3600(已知时长)', `当前 ${String(state.ledgerDuration)}`)).toBe(
      TRUSTED_DURATION_SECONDS,
    );
    expect(state.ledgerGeneration).toBe(handle.generation);
    expect(state.ledgerAcceptedAt).not.toBeNull();
    expect(state.sessionStarted, redLabel('T040', 'session_started=1(独立于历史 applied)', `当前 ${state.sessionStarted}`)).toBe(1);
  });

  it('B4 [绿·seq 机器既有回归] 未 started periodic 409;同 seq 异载荷 409 不消耗序号;seq 低于最新 → 200 stale_sample', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-b4-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    // 未 started 的 periodic → 409
    const early = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 10,
      reason: 'periodic',
    });
    expectProblem(early, 409, 'PLAYBACK_NOT_READY');
    // started seq1
    expect(
      (
        await postProgress(rig.app, rig.cookieA, handle.sessionId, {
          sampleSeq: 1,
          expectedGeneration: handle.generation,
          positionSeconds: 0,
          reason: 'started',
        })
      ).status,
    ).toBe(200);
    // periodic seq2 前进
    expect(
      (
        await postProgress(rig.app, rig.cookieA, handle.sessionId, {
          sampleSeq: 2,
          expectedGeneration: handle.generation,
          positionSeconds: 30,
          reason: 'periodic',
        })
      ).status,
    ).toBe(200);
    // 同 seq 异载荷 → 409 PROGRESS_SAMPLE_CONFLICT,不消耗序号
    const conflict = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 2,
      expectedGeneration: handle.generation,
      positionSeconds: 99,
      reason: 'periodic',
    });
    expectProblem(conflict, 409, 'PROGRESS_SAMPLE_CONFLICT');
    // seq 低于最新 → 200 stale_sample(applied=false;游标不移动)
    const stale = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 5,
      reason: 'periodic',
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ applied: false, reason: 'stale_sample' });
    // 序号未被消耗:seq=3 立即接受
    const ok = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 3,
      expectedGeneration: handle.generation,
      positionSeconds: 40,
      reason: 'periodic',
    });
    expect(ok.status).toBe(200);
    expect(progressStateRowOf(handle.sessionId).lastSampleSeq).toBe(3);
  });

  it('B5 [计划内红·待 T040+T046] stale 样本 sessionAccepted=false 且返回最后会话接受游标(acceptedSampleSeq/acceptedGeneration/acceptedPositionSeconds)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-b5-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 2,
      expectedGeneration: handle.generation,
      positionSeconds: 30,
      reason: 'periodic',
    });
    const stale = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 5,
      reason: 'periodic',
    });
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ applied: false, reason: 'stale_sample' });
    const body = stale.body as Record<string, unknown>;
    // 计划内红判据:stale sessionAccepted=false,并返回最后会话接受游标供恢复(api.md §4)
    expect(
      body,
      redLabel(
        'T040+T046',
        'stale_sample 应 sessionAccepted=false 且 acceptedSampleSeq=2/acceptedGeneration=1/acceptedPositionSeconds=30(最后会话接受游标)',
        `当前响应缺 sessionAccepted/游标字段(当前键 ${Object.keys(body).sort().join(',')})`,
      ),
    ).toHaveProperty('sessionAccepted', false);
    // 转绿后形态(当前不可达)
    expect(body['acceptedSampleSeq']).toBe(2);
    expect(body['acceptedGeneration']).toBe(handle.generation);
    expect(body['acceptedPositionSeconds']).toBe(30);
  });

  it('B6 [绿·duplicate 原存储结果] 同 seq 同载荷重放返回原结果,不再次写历史(history revision 不变)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-b6-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    const first = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(first.status).toBe(200);
    const historyBefore = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId);
    expect(historyBefore).toBeDefined();
    const replay = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(replay.status).toBe(200);
    // 重放返回原存储结果(applied/historyRevision 原值),不再次写历史
    expect(replay.body).toMatchObject({
      applied: (first.body as { applied: boolean }).applied,
      historyRevision: (first.body as { historyRevision: number }).historyRevision,
    });
    const historyAfter = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)!;
    expect(historyAfter.revision).toBe(historyBefore!.revision);
    expect(historyAfter.lastSampleSeq).toBe(historyBefore!.lastSampleSeq);
    expect(progressStateRowOf(handle.sessionId).lastSampleSeq).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* C superseded/generation(seq 跨 generation 单调;旧代输出不能 ready)   */
/* ------------------------------------------------------------------ */

describe('T036 · C superseded 与 generation(playback-state §2/§7;api.md §4「seq 跨 generation 单调」)', () => {
  it('C1 [计划内红·待 T040+T046] 旧 epoch 会话样本 → superseded + sessionAccepted=true/applied=false,且不覆盖新 owner 历史', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-c1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    // 双设备同 Profile 两次 resolve:设备A epoch=1(旧),设备B epoch=2(新)
    const resolveA = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(resolveA.status).toBe(201);
    const sessionA = String(resolveA.headers['location']).split('/').pop();
    const resolveB = await postResolve(rig.app, rig.cookieB, { mediaId: rig.serial.ep01MediaId });
    expect(resolveB.status).toBe(201);
    const sessionB = String(resolveB.headers['location']).split('/').pop();
    const epochA = progressStateRowOf(sessionA!).candidateEpoch;
    const epochB = progressStateRowOf(sessionB!).candidateEpoch;
    expect(epochB).toBeGreaterThan(epochA);
    // 新 owner(设备B)先 started:取得历史权
    const startedB = await postProgress(rig.app, rig.cookieB, sessionB!, {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 500,
      reason: 'started',
    });
    expect(startedB.status).toBe(200);
    expect(startedB.body).toMatchObject({ applied: true, reason: 'accepted' });
    const historyAfterOwner = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)!;
    expect(historyAfterOwner.writerPlaybackSessionId).toBe(sessionB);
    // 旧 epoch(设备A)started → superseded:历史不因非 owner 样本改变(既有语义,绿)
    const superseded = await postProgress(rig.app, rig.cookieA, sessionA!, {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 100,
      reason: 'started',
    });
    expect(superseded.status).toBe(200);
    expect(superseded.body).toMatchObject({ applied: false, reason: 'superseded' });
    const body = superseded.body as Record<string, unknown>;
    // 计划内红判据:superseded 可 sessionAccepted=true/applied=false(api.md §4;
    // playback-state §2「有效样本,失去历史权 → true/false·superseded,更新本 session ledger」)
    expect(
      body,
      redLabel(
        'T040+T046',
        'superseded 应 sessionAccepted=true/applied=false(会话 ledger 接受、历史不写)',
        `当前响应缺 sessionAccepted 字段(当前键 ${Object.keys(body).sort().join(',')})`,
      ),
    ).toHaveProperty('sessionAccepted', true);
    // 转绿后形态(当前不可达)
    expect(body['applied']).toBe(false);
    expect(body['acceptedSampleSeq']).toBe(1);
    expect(body['acceptedPositionSeconds']).toBe(100);
    // 新 owner 历史不被覆盖(既有语义,绿;转绿后仍须成立)
    const historyAfterSuperseded = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)!;
    expect(historyAfterSuperseded.writerPlaybackSessionId).toBe(sessionB);
    expect(historyAfterSuperseded.positionSeconds).toBe(500);
    expect(historyAfterSuperseded.revision).toBe(historyAfterOwner.revision);
    // 旧会话后续 periodic 仍 superseded,历史仍不变
    const again = await postProgress(rig.app, rig.cookieA, sessionA!, {
      sampleSeq: 2,
      expectedGeneration: 1,
      positionSeconds: 120,
      reason: 'periodic',
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ applied: false, reason: 'superseded' });
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)?.positionSeconds).toBe(500);
  });

  it('C2 [绿·seq 跨 generation 单调簿记] 换代后 seq 续接不归零(last_generation=新代);旧代样本 409 不消耗序号', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-c2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    // server_rebuild 换代工厂事实(DB 直改注明:等价 T045 代次 CAS 推进后的库内形态)
    Database.db
      .prepare('UPDATE playback_session SET generation = generation + 1, version = version + 1 WHERE id = ?')
      .run(handle.sessionId);
    const generation2 = sessionRowOf(handle.sessionId).generation;
    expect(generation2).toBe(handle.generation + 1);
    // 新代样本:seq 续接(2),接受且 last_generation=2 —— seq 不归零
    const nextGen = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 2,
      expectedGeneration: generation2,
      positionSeconds: 60,
      reason: 'periodic',
    });
    expect(nextGen.status).toBe(200);
    expect(nextGen.body).toMatchObject({ applied: true, reason: 'accepted' });
    const state = progressStateRowOf(handle.sessionId);
    expect(state.lastSampleSeq).toBe(2);
    expect(state.lastGeneration).toBe(generation2);
    // 旧代样本 → 409 PLAYBACK_GENERATION_STALE,不消耗序号
    const oldGen = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 3,
      expectedGeneration: handle.generation,
      positionSeconds: 70,
      reason: 'periodic',
    });
    expectProblem(oldGen, 409, 'PLAYBACK_GENERATION_STALE');
    // 序号未消耗:seq=3 以新代立即接受
    const ok = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 3,
      expectedGeneration: generation2,
      positionSeconds: 70,
      reason: 'periodic',
    });
    expect(ok.status).toBe(200);
    expect(progressStateRowOf(handle.sessionId).lastSampleSeq).toBe(3);
  });

  it('C3 [计划内红·待 T040] 跨 generation 样本的 ledger 游标应记录新代(ledger_generation=2)且游标续接', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-c3-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    Database.db
      .prepare('UPDATE playback_session SET generation = generation + 1, version = version + 1 WHERE id = ?')
      .run(handle.sessionId);
    const generation2 = sessionRowOf(handle.sessionId).generation;
    const res = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 2,
      expectedGeneration: generation2,
      positionSeconds: 60,
      reason: 'periodic',
    });
    expect(res.status).toBe(200);
    const state = progressStateRowOf(handle.sessionId);
    // 计划内红判据:seq 跨 generation 单调的 ledger 形态 —— 接受游标须带新代
    // (data-model §5「ledger_position/duration/generation/accepted_at」)
    expect(
      state.ledgerGeneration,
      redLabel(
        'T040',
        `跨代样本应记录 ledger_generation=${generation2} 且 ledger_position=60(游标续接不归零)`,
        `当前 ledger_generation=${String(state.ledgerGeneration)}(ledger 游标未落库)`,
      ),
    ).toBe(generation2);
    expect(state.ledgerPosition).toBe(60);
  });

  it('C4 [绿·旧代输出不能 ready(004 既有语义)] 旧代 renew 409 PLAYBACK_GENERATION_STALE;旧代票取流 401 PLAYBACK_TICKET_INVALID', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-c4-');
    const resolveRes = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(resolveRes.status).toBe(201);
    const sessionId = String(resolveRes.headers['location']).split('/').pop();
    const ready = await waitUntilState(rig.app, rig.cookieA, sessionId!, 'ready');
    const generation1 = Number(ready['generation']);
    // 当前代 renew 签发票(renew 200,票字段仅在 renew 出现)
    const renew = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}/renew`)
      .set('Cookie', rig.cookieA)
      .send({ expectedGeneration: generation1 });
    expect(renew.status).toBe(200);
    const playbackUrl = String((renew.body as Record<string, unknown>)['playbackUrl']);
    expect(playbackUrl).toContain('/api/playback/stream/');
    const ticket = new URL(playbackUrl, 'http://localhost').searchParams.get('ticket');
    expect(ticket).toBeTypeOf('string');
    // server_rebuild 换代工厂事实(DB 直改注明;等价代次 CAS 推进)
    Database.db
      .prepare('UPDATE playback_session SET generation = generation + 1, version = version + 1 WHERE id = ?')
      .run(sessionId!);
    const generation2 = sessionRowOf(sessionId!).generation;
    // 旧代 renew → 409(旧代不可签发新票/不可回到 ready 交付)
    const oldRenew = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}/renew`)
      .set('Cookie', rig.cookieA)
      .send({ expectedGeneration: generation1 });
    expectProblem(oldRenew, 409, 'PLAYBACK_GENERATION_STALE');
    // 旧代票取流 → 401 PLAYBACK_TICKET_INVALID(票代绑定,旧票立即失效)
    const oldStream = await request(rig.app.getHttpServer())
      .get(`/api/playback/stream/${sessionId}/${generation1}/index?ticket=${ticket}`)
      .set('Cookie', rig.cookieA);
    expect(oldStream.status).toBe(401);
    expect(oldStream.body.code).toBe('PLAYBACK_TICKET_INVALID');
    // 对照:新代 renew 仍可签发(拒绝只针对旧代)
    const newRenew = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}/renew`)
      .set('Cookie', rig.cookieA)
      .send({ expectedGeneration: generation2 });
    expect(newRenew.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* D 历史分离(epoch owner 写;from-head 降低位置)                        */
/* ------------------------------------------------------------------ */

describe('T036 · D 历史分离(data-model §5:仅历史 owner 写;from-head 可降低位置)', () => {
  it('D1 [绿·epoch owner 旧义回归] 本 Profile 历史只由 epoch owner 写:superseded 样本不改历史位置/revision', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-d1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const resolveA = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    const resolveB = await postResolve(rig.app, rig.cookieB, { mediaId: rig.serial.ep01MediaId });
    const sessionA = String(resolveA.headers['location']).split('/').pop();
    const sessionB = String(resolveB.headers['location']).split('/').pop();
    // 新 epoch(设备B)started 取得历史权
    const startedB = await postProgress(rig.app, rig.cookieB, sessionB!, {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 500,
      reason: 'started',
    });
    expect(startedB.status).toBe(200);
    const owner = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)!;
    expect(owner.writerPlaybackSessionId).toBe(sessionB);
    expect(owner.writerEpoch).toBe(progressStateRowOf(sessionB!).candidateEpoch);
    // 旧 epoch 样本(含较低位置)不覆盖 owner 历史
    const old = await postProgress(rig.app, rig.cookieA, sessionA!, {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 100,
      reason: 'started',
    });
    expect(old.status).toBe(200);
    expect(old.body).toMatchObject({ applied: false, reason: 'superseded' });
    const after = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)!;
    expect(after.writerEpoch).toBe(owner.writerEpoch);
    expect(after.writerPlaybackSessionId).toBe(sessionB);
    expect(after.positionSeconds).toBe(500);
    expect(after.revision).toBe(owner.revision);
    expect(historyRowCount(rig.householdId, rig.serial.ep01MediaId)).toBe(1);
  });

  it('D2 [绿·隔离与 from-head] 跨 Profile 位置隔离;新 epoch beginning started 位置 0 降低历史位置(不取 MAX)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-d2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    // 档案A(设备A)started 500
    const resolveA = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    const sessionA = String(resolveA.headers['location']).split('/').pop();
    expect(
      (
        await postProgress(rig.app, rig.cookieA, sessionA!, {
          sampleSeq: 1,
          expectedGeneration: 1,
          positionSeconds: 500,
          reason: 'started',
        })
      ).status,
    ).toBe(200);
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)?.positionSeconds).toBe(500);
    // 设备B 切到新建档案B(adult,无 PIN):同媒体 started 30 → B 自己的历史行
    const createdB = await createProfileViaSettings(rig.app, rig.cookieA, { name: '档案B', type: 'adult' });
    expect(createdB.status, JSON.stringify(createdB.body)).toBe(201);
    const profileBId = (createdB.body as { id: string }).id;
    const selectB = await request(rig.app.getHttpServer()).post(`/api/profiles/${profileBId}/select`).set('Cookie', rig.cookieB).send({});
    expect(selectB.status).toBe(200);
    const resolveB = await postResolve(rig.app, rig.cookieB, { mediaId: rig.serial.ep01MediaId });
    expect(resolveB.status).toBe(201);
    const sessionB2 = String(resolveB.headers['location']).split('/').pop();
    const startedB = await postProgress(rig.app, rig.cookieB, sessionB2!, {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 30,
      reason: 'started',
    });
    expect(startedB.status).toBe(200);
    expect(startedB.body).toMatchObject({ applied: true });
    expect(historyRowOf(rig.householdId, profileBId, rig.serial.ep01MediaId)?.positionSeconds).toBe(30);
    // A 历史不被 B 影响(个人历史归属独立)
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)?.positionSeconds).toBe(500);
    // from-head:档案A 新 epoch(beginning)started 位置 0 → 历史位置降低,不取 MAX
    const resolveA2 = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId, startMode: 'beginning' });
    const sessionA2 = String(resolveA2.headers['location']).split('/').pop();
    const headStart = await postProgress(rig.app, rig.cookieA, sessionA2!, {
      sampleSeq: 1,
      expectedGeneration: 1,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(headStart.status).toBe(200);
    expect(headStart.body).toMatchObject({ applied: true });
    const head = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)!;
    expect(head.positionSeconds).toBe(0);
    expect(head.writerEpoch).toBe(progressStateRowOf(sessionA2!).candidateEpoch);
    expect(historyRowCount(rig.householdId, rig.serial.ep01MediaId)).toBe(2);
  });

  it('D3 [计划内红·待 T040] 在线媒体历史应记录 continuity/evidence 证据(与 ledger 同事务):continuity_revision/evidence_state 非空', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-d3-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    const started = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ applied: true, reason: 'accepted' });
    const history = historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)!;
    // 计划内红判据:data-model §5 profile_viewing_history 扩展「continuity_revision、
    // evidence_state/digest」—— 在线媒体保存时须记录来源证据(当前实现写 NULL)。
    expect(
      history.continuityRevision,
      redLabel(
        'T040',
        '在线历史应记录 continuity_revision(>=1)与 evidence_state(unverified|verified)/evidence_digest(与 ledger 同事务)',
        `当前 continuity_revision=${String(history.continuityRevision)}、evidence_state=${String(history.evidenceState)}(证据未记录)`,
      ),
    ).not.toBeNull();
    expect(history.evidenceState).not.toBeNull();
    expect(history.evidenceDigest).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* E 时长未知(拒绝旧历史兜底)                                          */
/* ------------------------------------------------------------------ */

describe('T036 · E 时长未知(data-model §5「本次 probe 未知则不能用历史 duration 作为在线兜底」)', () => {
  /** 时长未知场景世界:无 probe 事实(port=null)+ 既有历史 duration=600,writerEpoch=1 */
  async function startUnknownDurationWorld(prefix: string): Promise<{
    rig: OnlinePlaybackRig;
    sessionId: string;
    generation: number;
  }> {
    const rig = await startOnlinePlaybackRig(prefix);
    registerPersonalPlaybackFactsPort(null); // probe 未知(生产桥 LIVE_STREAM_FACTS duration=null 同形)
    const writerSessionId = seedEndedWriterSession({
      householdId: rig.householdId,
      deviceSessionId: rig.deviceSessionAId,
      deviceId: deviceOfDeviceSession(rig.deviceSessionAId),
      profileId: rig.profileAId,
      mediaId: rig.unknownMovieMediaId,
    });
    seedHistoryRowFor({
      householdId: rig.householdId,
      profileId: rig.profileAId,
      mediaId: rig.unknownMovieMediaId,
      writerEpoch: 1,
      writerPlaybackSessionId: writerSessionId,
      positionSeconds: 300,
      durationSeconds: 600,
    });
    // 两次 resolve:第二次候选 epoch=2 > 历史 writerEpoch=1(取得写入权,红因只可能是时长兜底)
    const first = await postResolve(rig.app, rig.cookieA, { mediaId: rig.unknownMovieMediaId });
    expect(first.status).toBe(201);
    const second = await postResolve(rig.app, rig.cookieA, { mediaId: rig.unknownMovieMediaId });
    expect(second.status).toBe(201);
    const sessionId = String(second.headers['location']).split('/').pop();
    const generation = sessionRowOf(sessionId!).generation;
    return { rig, sessionId: sessionId!, generation };
  }

  it('E1 [计划内红·待 T040+T041] 时长未知(endList=false)在线样本应拒绝旧历史 duration 兜底:409 PROGRESS_NOT_READY', async () => {
    const { rig, sessionId, generation } = await startUnknownDurationWorld('hmp-t036-e1-');
    expect(progressStateRowOf(sessionId).candidateEpoch).toBeGreaterThan(1);
    const started = await postProgress(rig.app, rig.cookieA, sessionId, {
      sampleSeq: 1,
      expectedGeneration: generation,
      positionSeconds: 100,
      reason: 'started',
    });
    // 计划内红判据:本次 probe 无可信时长 → 可播放但不承诺进度/续播
    // (playback-state §3;api.md PlaybackDto durationSeconds「未知时长可播放但不承诺进度/续播」)。
    // 当前实现回落历史 duration=600 → 200 accepted(010 明确禁止的在线兜底)。
    expect(
      started.status,
      redLabel(
        'T040+T041',
        'probe 时长未知应 409 PROGRESS_NOT_READY(不使用历史 duration 作为在线兜底,历史行保留)',
        `当前 ${started.status} ${JSON.stringify(started.body)}(回落了历史 duration 兜底)`,
      ),
    ).toBe(409);
    expect(started.body.code).toBe('PROGRESS_NOT_READY');
    // 旧历史保留(未被在线未知时长样本改写)
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.unknownMovieMediaId)?.durationSeconds).toBe(600);
  });

  it('E2 [计划内红·待 T041+T046] 时长未知 resume:resumeDisposition=beginning + resumeReason=duration_unknown,不从历史冻结位置', async () => {
    const { rig } = await startUnknownDurationWorld('hmp-t036-e2-');
    const res = await postResolve(rig.app, rig.cookieA, { mediaId: rig.unknownMovieMediaId, startMode: 'resume' });
    expect(res.status).toBe(201);
    const body = res.body as Record<string, unknown>;
    // 计划内红判据 1:010 PlaybackDto 应声明本次起点形态(api.md §1 resumeDisposition/
    // resumeReason;无时长不能承诺续播 → 降级从头并给出 duration_unknown 原因)
    // T046 测试侧最小修正(结构性死断言;同 A1/A3 裁决先例):原写法
    // expect(响应对象).toEqual(arrayContaining([...键名])) 以对象比对数组恒假 ——
    // arrayContaining 只作用于数组;改为对 Object.keys(body) 断言(语义不变:
    // 响应键集合须含 resumeDisposition/resumeReason)。唯一测试改动,其余断言原样。
    expect(
      Object.keys(body),
      redLabel(
        'T041+T046',
        'resolve 应含 resumeDisposition=beginning + resumeReason=duration_unknown(时长未知降级从头)',
        `当前响应缺 resumeDisposition/resumeReason 字段(当前键 ${Object.keys(body).sort().join(',')})`,
      ),
    ).toEqual(expect.arrayContaining(['resumeDisposition', 'resumeReason']));
    // 计划内红判据 2:presentationStart 不得冻结历史位置 300(线上起点不从历史兜底)
    const sessionId = String(res.headers['location']).split('/').pop();
    const ready = await waitUntilState(rig.app, rig.cookieA, sessionId!, 'ready');
    const finalDisposition = String((ready as { resumeDisposition?: string }).resumeDisposition);
    expect(
      [finalDisposition, ready['presentationStartSeconds']],
      redLabel(
        'T041+T046',
        'ready 后 resumeDisposition=beginning 且 presentationStartSeconds=0(不冻结历史位置 300)',
        `当前 resumeDisposition=${finalDisposition || '缺失'}、presentationStartSeconds=${String(ready['presentationStartSeconds'])}(历史位置被冻结)`,
      ),
    ).toEqual(['beginning', 0]);
  });
});

/* ------------------------------------------------------------------ */
/* F 受控资源与再授权                                                   */
/* ------------------------------------------------------------------ */

describe('T036 · F 受控资源与再授权(api.md §6 既有 409 族 + §7 I4 seekCapability)', () => {
  it('F1 [绿·既有语义回归] content 修订变化 → 409 PROGRESS_RESOURCE_CHANGED(旧播放不改新资源历史)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-f1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    // 工厂事实(DB 直改注明):content 修订推进(等价内容替换)
    Database.db.prepare('UPDATE media_item SET content_revision = content_revision + 1 WHERE id = ?').run(rig.serial.ep01MediaId);
    const changed = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 2,
      expectedGeneration: handle.generation,
      positionSeconds: 30,
      reason: 'periodic',
    });
    expectProblem(changed, 409, 'PROGRESS_RESOURCE_CHANGED');
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.serial.ep01MediaId)?.positionSeconds).toBe(0);
  });

  it('F2 [计划内红·待 T043] continuity 修订变化 → 旧绑定进度应拒绝(准备转 failed、需新 resolve);当前放行', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-f2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    // 工厂事实(DB 直改注明):在线子项 continuity 修订推进(等价稳定定位/版本匹配条件变化)
    Database.db
      .prepare('UPDATE vod_episode SET continuity_revision = 2 WHERE media_id = ?')
      .run(rig.serial.ep01MediaId);
    const res = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 2,
      expectedGeneration: handle.generation,
      positionSeconds: 30,
      reason: 'periodic',
    });
    // 计划内红判据:data-model §3「旧会话修订不匹配时拒绝新交付/进度,准备转 failed,
    // 需新 resolve」—— 当前 progress 状态机不校验 continuity 修订 → 200 accepted。
    expect(
      res.status,
      redLabel(
        'T043',
        'continuity 修订失配应 409(PLAYBACK_GENERATION_STALE 族/PROGRESS_RESOURCE_CHANGED 拒绝路径),不写新位置',
        `当前 ${res.status} ${JSON.stringify(res.body)}(旧绑定进度被放行)`,
      ),
    ).toBe(409);
  });

  it('F3 [绿·受控资源回归] hls_proxy 服务端 seek 拒绝保留(400 PLAYBACK_SEEK_UNSUPPORTED)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-f3-');
    const resolveRes = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(resolveRes.status).toBe(201);
    const sessionId = String(resolveRes.headers['location']).split('/').pop();
    const ready = await waitUntilState(rig.app, rig.cookieA, sessionId!, 'ready');
    expect((ready as { delivery?: string }).delivery).toBe('hls_proxy');
    const seek = await postSeek(rig.app, rig.cookieA, sessionId!, {
      expectedVersion: ready['version'],
      positionSeconds: 10,
    });
    // hls_proxy 交付无影片逻辑时间轴:seek 拒绝保留(T045 审查补充「保留 hls_proxy 服务端 seek 拒绝」)
    expectProblem(seek, 400, 'PLAYBACK_SEEK_UNSUPPORTED');
    // 拒绝不换代:generation/version 不变,无新绑定
    expect(sessionRowOf(sessionId!).generation).toBe(Number(ready['generation']));
  });

  it('F4 [计划内红·待 T045+T046] PlaybackDto 应发布 seekCapability 与 playbackStarted(起播确认/定位能力)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-f4-');
    const resolveRes = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(resolveRes.status).toBe(201);
    const sessionId = String(resolveRes.headers['location']).split('/').pop();
    const ready = await waitUntilState(rig.app, rig.cookieA, sessionId!, 'ready');
    const body = ready as Record<string, unknown>;
    // 计划内红判据:api.md §7 I4 —— PlaybackDto 追加 seekCapability:none|client|
    // server_rebuild 与 playbackStarted:boolean(hls_proxy VOD 第一期仅 client 或 none)
    expect(
      Object.keys(body),
      redLabel(
        'T045+T046',
        'PlaybackDto 应含 seekCapability(none|client|server_rebuild;hls_proxy VOD 第一期仅 client|none)与 playbackStarted:boolean',
        `当前响应缺 I4 字段(当前键 ${Object.keys(body).sort().join(',')})`,
      ),
    ).toEqual(expect.arrayContaining(['seekCapability', 'playbackStarted']));
    // 转绿后形态(当前不可达)
    expect(['none', 'client']).toContain(body['seekCapability']);
    expect(body['playbackStarted']).toBe(false);
  });

  it('F5 [绿·发票只走 renew] resolve/GET 无票字段;renew 200 携 playbackUrl+ticketExpiresAt', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-f5-');
    const resolveRes = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(resolveRes.status).toBe(201);
    const sessionId = String(resolveRes.headers['location']).split('/').pop();
    // resolve 无票(201 仅表示接受)
    expect((resolveRes.body as Record<string, unknown>)['playbackUrl'] ?? null).toBeNull();
    expect((resolveRes.body as Record<string, unknown>)['ticketExpiresAt'] ?? null).toBeNull();
    const ready = await waitUntilState(rig.app, rig.cookieA, sessionId!, 'ready');
    // GET 不重签也不复现旧票
    expect(ready['playbackUrl'] ?? null).toBeNull();
    expect(ready['ticketExpiresAt'] ?? null).toBeNull();
    // renew 200:票字段仅在此出现
    const renew = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}/renew`)
      .set('Cookie', rig.cookieA)
      .send({ expectedGeneration: ready['generation'] });
    expect(renew.status).toBe(200);
    const renewBody = renew.body as Record<string, unknown>;
    expect(String(renewBody['playbackUrl'])).toContain('/api/playback/stream/');
    expect(renewBody['ticketExpiresAt']).toBeTypeOf('string');
    // 票绑定本设备:跨设备会话不可读(renew 归属校验)
    const crossDeviceRenew = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${sessionId}/renew`)
      .set('Cookie', rig.cookieB)
      .send({ expectedGeneration: ready['generation'] });
    expect(crossDeviceRenew.status).toBe(404);
    expect(crossDeviceRenew.body.code).toBe(ProblemCode.PLAYBACK_NOT_FOUND);
  });
});

/* ------------------------------------------------------------------ */
/* G 授权负向(既有语义,应绿)                                           */
/* ------------------------------------------------------------------ */

describe('T036 · G 授权负向(既有授权面回归;api.md §0/§6 同形口径)', () => {
  it('G1 [绿] 游客/伪造 token 的 resolve/progress → 401 SESSION_INVALID(problem+json)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-g1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    const guestResolve = await postResolve(rig.app, '', { mediaId: rig.serial.ep01MediaId });
    expectProblem(guestResolve, 401, ProblemCode.SESSION_INVALID);
    const guestProgress = await postProgress(rig.app, '', handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    });
    expectProblem(guestProgress, 401, ProblemCode.SESSION_INVALID);
    const forged = await postResolve(rig.app, cookieOf('forged-token-not-in-db'), { mediaId: rig.serial.ep01MediaId });
    expectProblem(forged, 401, ProblemCode.SESSION_INVALID);
  });

  it('G2 [绿] body 伪造 profileId/householdId 一律 400 VALIDATION_FAILED(身份只从服务端推导)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-g2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    const forgedResolve = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep01MediaId,
      profileId: rig.profileAId,
    });
    expectProblem(forgedResolve, 400, ProblemCode.VALIDATION_FAILED);
    const forgedHousehold = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep01MediaId,
      householdId: rig.householdId,
    });
    expectProblem(forgedHousehold, 400, ProblemCode.VALIDATION_FAILED);
    const forgedProgress = await postProgress(rig.app, rig.cookieA, handle.sessionId, {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
      profileId: rig.profileAId,
    });
    expectProblem(forgedProgress, 400, ProblemCode.VALIDATION_FAILED);
  });

  it('G3 [绿] 跨设备会话 progress → 404 PLAYBACK_NOT_FOUND 与随机 id 同形(不泄露存在性)', async () => {
    const rig = await startOnlinePlaybackRig('hmp-t036-g3-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const handle = seedOnlineProgressSession(rig);
    const sample = {
      sampleSeq: 1,
      expectedGeneration: handle.generation,
      positionSeconds: 0,
      reason: 'started',
    };
    const crossDevice = await postProgress(rig.app, rig.cookieB, handle.sessionId, sample);
    expectProblem(crossDevice, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossDevice, await postProgress(rig.app, rig.cookieB, randomUUID(), sample));
    // 归属未被越权改变:原设备同载荷仍按既有协议放行(applied 旧义;010 追加字段由 B 组钉)
    const own = await postProgress(rig.app, rig.cookieA, handle.sessionId, sample);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ applied: true, reason: 'accepted' });
  });
});
