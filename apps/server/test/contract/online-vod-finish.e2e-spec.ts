import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import { mediaSource, vodSourceConfig } from '@platform/database/schema';
import { registerPersonalPlaybackFactsPort } from '@contexts/personal-data/application/progress-clock.service';
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
  createFixtureVodSource,
  createThreeEpisodeSerialWorld,
  findUpstreamRoute,
  type FixtureUpstreamSource,
} from '../fixtures/online-vod/fixture-upstream';

/**
 * T051(010-online-vod · US3,测试先行):observations/finish/finish-result/stop 契约
 * e2e —— 「只写测试不实现」,依赖 T046 已落地(US2 服务端全绿,T036 契约 27/27 复核)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §4(observations/finish/finish-result/
 *   stop 四行 + 语义段)+ §1 FinishReceipt/ObservationReply DTO + §7 I4(playing 观测与
 *   playback_started_at 同事务;playbackStarted 事实可用):
 *   · finish operationKey 必须 UUID;final 先校验接受再判尾段 min(5s,d×5%)/连续末段
 *     min(2s,d×5%);同 payload 重放返回原结果(replayed=true),同 key 异 payload 409;
 *     已有 receipt 且新 key 不同 → 409 FINISH_ALREADY_RECORDED 附恢复路径而不重算;
 *     session 只有一份不可变 finish 结果;旧 stop 先赢时首次 finish 只登记「别处停止」
 *     形态回执而不写新 final,endedAt 取原终态时刻,不得给 ended 任意升级资格(表行:
 *     后到 finish 返回 not_completed);finish 重放先校验身份/归属再读 receipt,不要求
 *     活动态;无权读取时只允许既有最小空 stop 清理;
 *   · observations:授权/交付/phase 检查;同 seq 同载荷重放、冲突 409、陈旧 accepted=
 *     false;观测不写个人历史/epoch;0.5–2 倍速,推进不得大于服务器间隔×rate+0.5s;
 *   · stop 仍 204:先赢的 stop 使后到 finish 不补写 final;无 auto-next 资格;
 * - docs/specs/010-online-vod/data-model.md §5(观测匹配 generation/接收时间/已交付;
 *   gap>3s、跳跃/暂停/缓冲使资格 unknown 需新的连续末段;completed 是会话观测结果;
 *   个人历史归属和会话完成独立:superseded 可 ledger 接受且 session_completed=true,
 *   绝不把其完成写到另设备 owner 历史;普通 stop 204 不生成成功完成证据)与
 *   playback_finish_receipt 表(session_id 唯一 + (家庭,device_session,contextVersion,
 *   operationKey) 幂等四元组唯一索引);
 * - docs/specs/010-online-vod/contracts/playback-state.md §4(finish 流程:停周期→flush
 *   尾段观测→final seq→同事务接受 final→ledger→epoch 历史→完成判定→receipt→ended;
 *   保存硬错误回滚不部分终态化;stale final 可 ended 但不可 auto-next;superseded final
 *   可 sessionAccepted/completed 而 historyApplied=false;finish 先赢后 stop 仅清理);
 * - docs/specs/010-online-vod/tasks.md T051/T057/T058 原文(T057/T058 为被测实现目标,
 *   本文件先钉契约目标面,计划内红失败不跳过);
 * - 行为基线(既有绿,010 增量不得回归):test/contract/playback-control.e2e-spec.ts
 *   (stop 204 幂等/跨设备 404)、playback-context-binding.e2e-spec.ts(T045 A→B→A 旧
 *   上下文稳定拒绝 + 空 stop 最小清理)、online-vod-progress-resume.e2e-spec.ts(T036)。
 *
 * 装配方式(沿用 010 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威迁移,含 0007_online_vod)+
 *   initialize/login/selectMainAndUnlockSettings 身份 seed + Supertest 真实 HTTP;
 * - 受控上游 mock 沿用 T031/T036 rig 手法(createControlledMediaServer 127.0.0.1 随机
 *   端口 + fixture-upstream 路由表 findUpstreamRoute 派发 Apple CMS JSON;
 *   LAN_ALLOWED_TARGETS='127.0.0.1';全程不发真实外网请求)。来源/物化/resolve 走真实
 *   装配链:HTTP 搜索→预览→POST /api/vod/materializations 物化三集连续剧(EP01=3×120s,
 *   清单时长 360s —— 尾窗 min(5,360×5%)=5s、末段窗 min(2,360×5%)=2s),再
 *   resolve→ready(T036 同款 waitUntilState 轮询);
 * - 时长事实注入沿用 T092 seam(T036 同款):registerPersonalPlaybackFactsPort 覆盖为
 *   360(=EP01 真实清单时长,代表「probe 已知时长」形态;在线媒体不经历史兜底),
 *   afterEach 复位 null;
 * - 双设备:两次 login 即两个 DeviceSession(设备A/设备B);旧上下文(A→B→A)经
 *   Settings API 新建档案B + 选档往返构造(T045 同款,contextVersion 递增);
 * - 观测/finish 时钟为真实系统时钟(服务器接收时间不可注入):正常尾段以 0.4s 步进
 *   连续上报(0.4 ≤ 间隔×1+0.5);A8 的 gap>3s 用例以单次 3.2s 真实间隔构造,testTimeout
 *   30s 内完成;
 * - DB 直读仅作存储面断言(receipt/观测行/历史 completed/ledger 游标);本文件零 DB 种子
 *   (全部会话走真实 resolve 链,progress_state/input binding/probe 事实由 T043/T042
 *   真实装配产生)。不改任何共享文件;无 git 操作。
 *
 * ───────────────────────── 计划内红清单(失败不跳过)─────────────────────────
 * T051 为测试先行:observations/finish/finish-result 端点均未装配(T057/T058 待实现),
 * 相关用例当前失败原因一律为「路由级缺省 404 NOT_FOUND(Cannot POST/GET …)」;stop 走
 * 005 既有装配(204/幂等/授权负向)应绿。红→绿映射:
 *
 * | 用例  | 计划内红断言(当前失败原因)                                   | 转绿任务        |
 * | ----- | ----------------------------------------------------------- | --------------- |
 * | A1–A7 | observations 404 路由未装配(回放/冲突/陈旧/尾锚/倍速/推进)   | T057            |
 * | A8    | observations 404(尾段 gap>3s → finish 资格 unknown 形态)     | T057+T058       |
 * | B1/B2/B6 | finish 链首步尾段 observations 404(T057);finish 404(T058)| T057+T058       |
 * | B3/B4/B5/B7 | finish 404 路由未装配(幂等冲突/尾段判定/not_started)   | T058            |
 * | C1    | finish 链 observations 404(T057)→ finish 404(T058)         | T057+T058       |
 * | C2    | finish 404 路由未装配(stale final 不连播)                   | T058            |
 * | D1/D2 | finish 404 路由未装配(stop 前置 204 为绿;竞争语义在 finish) | T058            |
 * | E1/E2/E3 | finish/finish-result 404 路由未装配(E3 旧上下文空 stop 204 绿)| T058         |
 * | F2    | observations/finish/finish-result 授权/schema 负向随路由装配 | T057+T058       |
 *
 * 绿基线(既有语义回归,010 落地不得回归):
 * D3(普通 stop 204 不生成成功完成证据:receipt 零行、历史 completed=0、stop-with-final
 * 只落 ledger/历史)、F1(stop 幂等 204/游客 401/伪造 profileId 400/跨设备 404 同形)。
 *
 * 预期计数:红 23(A1–A8、B1–B7、C1–C2、D1–D2、E1–E3、F2)/ 绿 2(D3、F1);两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

/** EP01 逻辑时长(fixture 三集连续剧:3×120s 清单聚合;probe 受信事实) */
const EP01_DURATION_SECONDS = 360;
/** 自然结束 final 位置(360-0.5,落在尾窗 [355,360] 内) */
const NATURAL_END_POSITION = 359.5;
/** 距尾过大 final 位置(300/360,远在尾窗 [355,360] 之外) */
const MIDWAY_POSITION = 300;

/** 010 FinishReceipt 契约 13 键(api.md §1 / openapi FinishReceipt:additionalProperties:false) */
const FINISH_RECEIPT_010_KEYS = [
  'sessionId',
  'generation',
  'ended',
  'finalSessionAccepted',
  'historyApplied',
  'historyRevision',
  'sessionCompleted',
  'autoNextEligible',
  'reason',
  'positionSeconds',
  'durationSeconds',
  'endedAt',
  'replayed',
] as const;

/** 010 ObservationReply 契约 3 键(api.md §4 / openapi ObservationReply:additionalProperties:false) */
const OBSERVATION_REPLY_010_KEYS = ['accepted', 'lastEventSeq', 'playbackStarted'] as const;

/** 计划内红统一标注(消息内钉转绿任务号 + 目标契约形态 + 当前失败原因) */
function redLabel(tasks: string, target: string, current: string): string {
  return `计划内红(待 ${tasks} 转绿):${current} —— ${tasks} 落地后应 ${target}`;
}

/** 未装配路由响应摘要(红消息内引用当前 404 形态) */
function routeShapeOf(res: request.Response): string {
  const code = (res.body as Record<string, unknown> | undefined)?.['code'];
  return `${res.status} ${String(code ?? '')}`;
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ------------------------------------------------------------------ */
/* 上游 mock(010 T031/T036 rig 手法:受控 CMS 端口 + fixture 路由表派发)  */
/* ------------------------------------------------------------------ */

const activeMediaServers: ControlledMediaServer[] = [];

/** 构建单个健康受控源(三集连续剧[EP01 已知时长 360s],T051 完播素材) */
function buildHealthySource(port: number): FixtureUpstreamSource {
  const origin = `http://127.0.0.1:${port}`;
  return createFixtureVodSource({
    sourceId: 'fixture-vod-source-t051',
    displayName: '夹具在线片源(T051)',
    behavior: 'healthy',
    address: { host: '127.0.0.1', port },
    titleWorlds: [createThreeEpisodeSerialWorld(origin)],
  });
}

/* ------------------------------------------------------------------ */
/* rig:受控上游 + 全量迁移 app + 双设备身份 + HTTP 物化在线剧集           */
/* ------------------------------------------------------------------ */

interface OnlineFinishRig {
  readonly app: INestApplication;
  readonly householdId: string;
  readonly server: ControlledMediaServer;
  /** 设备A · 档案A(主档案) */
  readonly cookieA: string;
  /** 设备B · 档案A(同档案第二设备;跨设备边界场景) */
  readonly cookieB: string;
  readonly profileAId: string;
  /** 已物化三集连续剧 EP01(T031 真实装配链产物;probe 时长 360s) */
  readonly ep01MediaId: string;
}

function householdIdOf(): string {
  const row = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string } | undefined;
  expect(row, '夹具错误:household 行不存在(初始化未执行)').toBeDefined();
  return row!.id;
}

/** 搜索 → 首卡 → 预览 → POST /api/vod/materializations(真实 T031 链)→ 子项 mediaId */
async function materializeEpisode(app: INestApplication, cookie: string, keyword: string): Promise<string> {
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
    .send({
      titleRef: card!.titleRef,
      episodeRef,
      previewRevision: (preview.body as { previewRevision: number }).previewRevision,
      operationKey: randomUUID(),
    });
  expect(res.status, `物化 ${keyword} 应 201(T031 已装配;实际 ${JSON.stringify(res.body)})`).toBe(201);
  return (res.body as { mediaId: string }).mediaId;
}

async function startOnlineFinishRig(prefix: string): Promise<OnlineFinishRig> {
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
            // 挂起不回包(与 catalog/T036 rig 同形态;本文件路由全为健康应答,防御分支)
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
  const cookieA = cookiePairOf(loggedIn);
  const profileAId = await selectMainAndUnlockSettings(fresh.app, cookieA);

  // 第二设备:同账号新登录(新 DeviceSession),选同一主档案(跨设备边界场景)
  const secondLogin = await login(fresh.app, 'admin', 'password-123', { deviceName: '设备B' });
  expect(secondLogin.status).toBe(200);
  const cookieB = cookiePairOf(secondLogin);
  const unlockB = await request(fresh.app.getHttpServer())
    .post(`/api/profiles/${profileAId}/unlock`)
    .set('Cookie', cookieB)
    .send({ pin: MANAGEMENT_MAIN_PIN });
  if (unlockB.status !== 200 && unlockB.status !== 404) {
    throw new Error(`夹具错误:设备B 解锁主档案失败 ${unlockB.status} ${JSON.stringify(unlockB.body)}`);
  }
  const selectB = await request(fresh.app.getHttpServer())
    .post(`/api/profiles/${profileAId}/select`)
    .set('Cookie', cookieB)
    .send({});
  expect(selectB.status, '设备B 选主档案应 200').toBe(200);

  // 时长事实注入(T092 seam;T036 同款):EP01 真实清单时长,代表「probe 已知」形态
  registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => EP01_DURATION_SECONDS });

  const householdId = householdIdOf();
  seedVodSourceRow(householdId, `${server.baseUrl}${source.apiPath}`);

  // 在线剧集物化(T031 真实装配链:搜索→预览→物化,产生 online playback_source)
  const ep01MediaId = await materializeEpisode(fresh.app, cookieA, 'stardust');

  return { app: fresh.app, householdId, server, cookieA, cookieB, profileAId, ep01MediaId };
}

/** kind=vod 来源行(media_source + vod_source_config 一源一行;对齐 catalog/T036 口径) */
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
/* DB 读(存储面断言;全部真实 resolve 链,零种子)                         */
/* ------------------------------------------------------------------ */

interface SessionRow {
  readonly state: string;
  readonly generation: number;
  readonly endedAt: string | null;
  readonly playbackStartedAt: string | null;
}

function sessionRowOf(sessionId: string): SessionRow {
  const row = Database.db
    .prepare(
      `SELECT state, generation, ended_at AS endedAt, playback_started_at AS playbackStartedAt
       FROM playback_session WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  expect(row, `夹具错误:playback_session ${sessionId} 不存在`).toBeDefined();
  return row!;
}

interface ProgressStateRow {
  readonly candidateEpoch: number;
  readonly started: number;
  readonly sessionStarted: number;
  readonly lastSampleSeq: number;
  readonly lastGeneration: number;
  readonly ledgerPosition: number | null;
}

function progressStateRowOf(sessionId: string): ProgressStateRow {
  const row = Database.db
    .prepare(
      `SELECT candidate_epoch AS candidateEpoch, started, session_started AS sessionStarted,
              last_sample_seq AS lastSampleSeq, last_generation AS lastGeneration,
              ledger_position AS ledgerPosition
       FROM playback_progress_state WHERE playback_session_id = ?`,
    )
    .get(sessionId) as ProgressStateRow | undefined;
  expect(row, `夹具错误:playback_progress_state ${sessionId} 不存在(resolve 绑定应已建档)`).toBeDefined();
  return row!;
}

interface HistoryRow {
  readonly writerPlaybackSessionId: string;
  readonly positionSeconds: number;
  readonly revision: number;
  readonly completed: number;
}

function historyRowOf(householdId: string, profileId: string, mediaId: string): HistoryRow | undefined {
  return Database.db
    .prepare(
      `SELECT writer_playback_session_id AS writerPlaybackSessionId, position_seconds AS positionSeconds,
              revision, completed
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

interface FinishReceiptRow {
  readonly operationKey: string;
  readonly finalSessionAccepted: number;
  readonly historyApplied: number;
  readonly historyRevision: number | null;
  readonly sessionCompleted: number;
  readonly autoNextEligible: number;
  readonly reason: string;
  readonly positionSeconds: number | null;
  readonly endedAt: string;
}

function finishReceiptRowOf(sessionId: string): FinishReceiptRow | undefined {
  return Database.db
    .prepare(
      `SELECT operation_key AS operationKey, final_session_accepted AS finalSessionAccepted,
              history_applied AS historyApplied, history_revision AS historyRevision,
              session_completed AS sessionCompleted, auto_next_eligible AS autoNextEligible,
              reason, position_seconds AS positionSeconds, ended_at AS endedAt
       FROM playback_finish_receipt WHERE session_id = ?`,
    )
    .get(sessionId) as FinishReceiptRow | undefined;
}

function finishReceiptCount(householdId: string): number {
  return (
    Database.db.prepare('SELECT COUNT(*) AS n FROM playback_finish_receipt WHERE household_id = ?').get(householdId) as {
      n: number;
    }
  ).n;
}

interface ObservationRow {
  readonly eventSeq: number;
  readonly eventType: string;
  readonly tailAnchorPositionSeconds: number | null;
  readonly tailAnchorTime: string | null;
}

function observationRowsOf(sessionId: string): ObservationRow[] {
  return Database.db
    .prepare(
      `SELECT event_seq AS eventSeq, event_type AS eventType,
              tail_anchor_position_seconds AS tailAnchorPositionSeconds, tail_anchor_time AS tailAnchorTime
       FROM playback_phase_observation WHERE session_id = ? ORDER BY event_seq`,
    )
    .all(sessionId) as ObservationRow[];
}

function observationCount(sessionId: string): number {
  return (
    Database.db.prepare('SELECT COUNT(*) AS n FROM playback_phase_observation WHERE session_id = ?').get(sessionId) as {
      n: number;
    }
  ).n;
}

/* ------------------------------------------------------------------ */
/* HTTP 助手                                                            */
/* ------------------------------------------------------------------ */

function postResolve(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/playback/resolve').set('Cookie', cookie).send(body);
}

function postProgress(app: INestApplication, cookie: string, sessionId: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(`/api/playback/sessions/${sessionId}/progress`).set('Cookie', cookie).send(body);
}

function postStop(app: INestApplication, cookie: string, sessionId: string, body: Record<string, unknown> = {}): request.Test {
  return request(app.getHttpServer()).post(`/api/playback/sessions/${sessionId}/stop`).set('Cookie', cookie).send(body);
}

function postObservation(app: INestApplication, cookie: string, sessionId: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${sessionId}/observations`)
    .set('Cookie', cookie)
    .send(body);
}

function postFinish(app: INestApplication, cookie: string, sessionId: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(`/api/playback/sessions/${sessionId}/finish`).set('Cookie', cookie).send(body);
}

function getFinishResult(app: INestApplication, cookie: string, sessionId: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${sessionId}/finish-result`).set('Cookie', cookie);
}

function getStatus(app: INestApplication, cookie: string, sessionId: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${sessionId}`).set('Cookie', cookie);
}

/** 轮询等待会话进入指定状态(在线 hls 候选 probe 免 ffprobe 即时成功,毫秒级 ready) */
async function waitUntilState(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  wanted: 'ready' | 'ended',
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
    await sleep(20);
  }
  throw new Error(`夹具错误:会话 ${sessionId} 未在 5s 内进入 ${wanted}(当前 ${lastState || '不可读'})`);
}

/* ------------------------------------------------------------------ */
/* 会话/观测/finish 链助手(真实 resolve→ready→样本→观测→final)           */
/* ------------------------------------------------------------------ */

interface ActiveSession {
  readonly sessionId: string;
  readonly generation: number;
}

/** resolve → 轮询 ready(真实 T031/T043 装配链;probe 事实 EP01=360s) */
async function openReadySession(rig: OnlineFinishRig, cookie: string): Promise<ActiveSession> {
  const res = await postResolve(rig.app, cookie, { mediaId: rig.ep01MediaId });
  expect(res.status, `resolve 应 201(真实装配链;实际 ${JSON.stringify(res.body)})`).toBe(201);
  const sessionId = String(res.headers['location']).split('/').pop() as string;
  const ready = await waitUntilState(rig.app, cookie, sessionId, 'ready');
  return { sessionId, generation: Number(ready['generation']) };
}

/** started 样本(T046 既有 8 键面;缺省位置 0) */
async function acceptStartedSample(
  rig: OnlineFinishRig,
  cookie: string,
  session: ActiveSession,
  positionSeconds = 0,
): Promise<void> {
  const res = await postProgress(rig.app, cookie, session.sessionId, {
    sampleSeq: 1,
    expectedGeneration: session.generation,
    positionSeconds,
    reason: 'started',
  });
  expect(res.status, `started 样本应 200(T046 已装配;实际 ${JSON.stringify(res.body)})`).toBe(200);
  expect(res.body).toMatchObject({ applied: true, reason: 'accepted' });
}

/** periodic 样本(T046 既有面) */
async function acceptPeriodicSample(
  rig: OnlineFinishRig,
  cookie: string,
  session: ActiveSession,
  sampleSeq: number,
  positionSeconds: number,
): Promise<void> {
  const res = await postProgress(rig.app, cookie, session.sessionId, {
    sampleSeq,
    expectedGeneration: session.generation,
    positionSeconds,
    reason: 'periodic',
  });
  expect(res.status, `periodic 样本应 200(实际 ${JSON.stringify(res.body)})`).toBe(200);
  expect(res.body).toMatchObject({ applied: true, reason: 'accepted' });
}

interface TailObservationSpec {
  readonly from: number;
  readonly to: number;
  readonly step: number;
  readonly startEventSeq?: number;
  readonly playbackRate?: number;
  readonly intervalMs?: number;
}

/**
 * 连续尾段观测(playing 0.4s 步进 ≪ 间隔×rate+0.5s 可行界;每步 25ms 真实间隔)。
 * 计划内红判据落在首个观测应答(observations 路由未装配 → T057)。
 */
async function sendTailObservations(
  rig: OnlineFinishRig,
  cookie: string,
  session: ActiveSession,
  spec: TailObservationSpec,
): Promise<void> {
  const rate = spec.playbackRate ?? 1;
  let eventSeq = spec.startEventSeq ?? 1;
  for (let position = spec.from; position <= spec.to + 1e-9; position += spec.step) {
    const res = await postObservation(rig.app, cookie, session.sessionId, {
      eventSeq,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: Number(position.toFixed(3)),
      playbackRate: rate,
    });
    expect(
      res.status,
      redLabel(
        'T057',
        `observations(eventSeq=${eventSeq}) 应 200 ${OBSERVATION_REPLY_010_KEYS.join(',')}(尾段连续推进素材)`,
        `当前 ${routeShapeOf(res)}(observations 路由未装配)`,
      ),
    ).toBe(200);
    expect((res.body as Record<string, unknown>)['accepted']).toBe(true);
    eventSeq += 1;
    await sleep(spec.intervalMs ?? 25);
  }
}

/** finish 请求体(cause 仅 natural_end;final = 本次样本,seq 续接 ledger) */
function finishPayloadOf(
  session: ActiveSession,
  sampleSeq: number,
  positionSeconds: number,
  operationKey = randomUUID(),
): Record<string, unknown> {
  return {
    operationKey,
    finalProgress: { sampleSeq, expectedGeneration: session.generation, positionSeconds },
    cause: 'natural_end',
  };
}

/** 中段收尾 receipt 素材(started(0) → final(300/360);无尾段观测,距尾过大形态) */
async function recordMidwayFinishReceipt(
  rig: OnlineFinishRig,
  cookie: string,
): Promise<{ session: ActiveSession; receipt: Record<string, unknown>; operationKey: string }> {
  const session = await openReadySession(rig, cookie);
  await acceptStartedSample(rig, cookie, session);
  const payload = finishPayloadOf(session, 2, MIDWAY_POSITION);
  const res = await postFinish(rig.app, cookie, session.sessionId, payload);
  expect(
    res.status,
    redLabel(
      'T058',
      'finish 应 200 FinishReceipt(无尾段证据不等于接口失败:可 ended=true/autoNextEligible=false)',
      `当前 ${routeShapeOf(res)}(finish 路由未装配)`,
    ),
  ).toBe(200);
  return { session, receipt: res.body as Record<string, unknown>, operationKey: payload.operationKey as string };
}

/** 设备A 档案往返(A→B→A):device_session.profile_context_version 递增(T045 同款) */
async function cycleProfileContext(rig: OnlineFinishRig): Promise<void> {
  const created = await createProfileViaSettings(rig.app, rig.cookieA, { name: '档案B', type: 'adult' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const profileBId = (created.body as { id: string }).id;
  const selectB = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${profileBId}/select`)
    .set('Cookie', rig.cookieA)
    .send({});
  expect(selectB.status, JSON.stringify(selectB.body)).toBe(200);
  // 切回主档案(PIN 保护 → 先解锁;T036 设备B 同款次序)
  const unlockA = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${rig.profileAId}/unlock`)
    .set('Cookie', rig.cookieA)
    .send({ pin: MANAGEMENT_MAIN_PIN });
  expect(unlockA.status, JSON.stringify(unlockA.body)).toBe(200);
  const selectA = await request(rig.app.getHttpServer())
    .post(`/api/profiles/${rig.profileAId}/select`)
    .set('Cookie', rig.cookieA)
    .send({});
  expect(selectA.status, JSON.stringify(selectA.body)).toBe(200);
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
/* A observations(T057;api.md §4 observations 行 + §7 I4;data-model §5) */
/* ------------------------------------------------------------------ */

describe('T051 · A observations(api.md §4 observations 行+§7 I4;data-model §5 观测匹配;→T057)', () => {
  it('A1 [计划内红·待 T057] playing 观测 accepted+lastEventSeq,与 playback_started_at 同事务(I4 事实可用);不写历史/epoch', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a1-');
    const session = await openReadySession(rig, rig.cookieA);
    const res = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 0,
      playbackRate: 1,
    });
    expect(
      res.status,
      redLabel(
        'T057',
        `observations 应 200 {${OBSERVATION_REPLY_010_KEYS.join(',')}}(playing 观测接受)`,
        `当前 ${routeShapeOf(res)}(observations 路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as Record<string, unknown>;
    // 回复键面(openapi additionalProperties:false)
    expect(Object.keys(body).sort()).toEqual([...OBSERVATION_REPLY_010_KEYS].sort());
    expect(body['accepted']).toBe(true);
    expect(body['lastEventSeq']).toBe(1);
    // I4:playing 观测与 playback_started_at 同事务,HTTP 确认后事实即可用(api.md §7)
    expect(body['playbackStarted']).toBe(true);
    const status = await getStatus(rig.app, rig.cookieA, session.sessionId);
    expect(status.status).toBe(200);
    expect((status.body as Record<string, unknown>)['playbackStarted']).toBe(true);
    // 存储面:观测行落库;playback_started_at 非空(session 级,跨 generation 保留)
    expect(observationCount(session.sessionId)).toBe(1);
    expect(sessionRowOf(session.sessionId).playbackStartedAt).not.toBeNull();
    // 观测不写个人历史/epoch/ledger:历史零行、started 门未开、seq 簿记未动
    expect(historyRowCount(rig.householdId, rig.ep01MediaId)).toBe(0);
    const state = progressStateRowOf(session.sessionId);
    expect(state.started).toBe(0);
    expect(state.sessionStarted).toBe(0);
    expect(state.lastSampleSeq).toBe(0);
  });

  it('A2 [计划内红·待 T057] 同 seq 同载荷重放返回原结果:accepted=true、lastEventSeq 不变、观测不重复落行', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a2-');
    const session = await openReadySession(rig, rig.cookieA);
    const payload = {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 12.5,
      playbackRate: 1,
    };
    const first = await postObservation(rig.app, rig.cookieA, session.sessionId, payload);
    expect(
      first.status,
      redLabel('T057', 'observations 应 200(首次接受)', `当前 ${routeShapeOf(first)}(observations 路由未装配)`),
    ).toBe(200);
    const replay = await postObservation(rig.app, rig.cookieA, session.sessionId, payload);
    expect(replay.status, `重放应 200(实际 ${routeShapeOf(replay)})`).toBe(200);
    const body = replay.body as Record<string, unknown>;
    // 同 seq 同载荷重放返回原结果(api.md §4「同seq同载荷重放」)
    expect(body['accepted']).toBe(true);
    expect(body['lastEventSeq']).toBe(1);
    // 不重复落行(最新 event_seq 幂等)
    expect(observationCount(session.sessionId)).toBe(1);
  });

  it('A3 [计划内红·待 T057] 同 seq 异载荷 → 409(共用 seq 摘要领域机,PROGRESS_SAMPLE_CONFLICT 族);不写新行', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a3-');
    const session = await openReadySession(rig, rig.cookieA);
    const first = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 10,
      playbackRate: 1,
    });
    expect(
      first.status,
      redLabel('T057', 'observations 应 200(首次接受)', `当前 ${routeShapeOf(first)}(observations 路由未装配)`),
    ).toBe(200);
    // 同 eventSeq 不同载荷 → 409(problem+json;复用既有 PROGRESS_SAMPLE_CONFLICT 稳定码,
    // api.md §6「既有409」族;未登记新枚举不得写入 —— api.md §0 错误白名单)
    const conflict = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 99,
      playbackRate: 1,
    });
    expectProblem(conflict, 409, 'PROGRESS_SAMPLE_CONFLICT');
    // 冲突不写新行
    expect(observationCount(session.sessionId)).toBe(1);
  });

  it('A4 [计划内红·待 T057] 陈旧 seq → 200 accepted=false,lastEventSeq 保持最新游标', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a4-');
    const session = await openReadySession(rig, rig.cookieA);
    const first = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 10,
      playbackRate: 1,
    });
    expect(
      first.status,
      redLabel('T057', 'observations 应 200(首次接受)', `当前 ${routeShapeOf(first)}(observations 路由未装配)`),
    ).toBe(200);
    const second = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 2,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 10.4,
      playbackRate: 1,
    });
    expect(second.status).toBe(200);
    // 陈旧样本(seq 低于最新):accepted=false,游标不回退(api.md §4「陈旧false」)
    const stale = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 10,
      playbackRate: 1,
    });
    expect(stale.status).toBe(200);
    const body = stale.body as Record<string, unknown>;
    expect(body['accepted']).toBe(false);
    expect(body['lastEventSeq']).toBe(2);
  });

  it('A5 [计划内红·待 T057] seek/pause 重置尾段锚,playing 再连续上报重新锚定(存储面 tail_anchor 成对语义)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a5-');
    const session = await openReadySession(rig, rig.cookieA);
    const events: Array<{ eventSeq: number; event: string; positionSeconds: number }> = [
      { eventSeq: 1, event: 'playing', positionSeconds: 10 },
      { eventSeq: 2, event: 'playing', positionSeconds: 10.4 },
      { eventSeq: 3, event: 'seeking', positionSeconds: 300 },
      { eventSeq: 4, event: 'pause', positionSeconds: 300 },
      { eventSeq: 5, event: 'playing', positionSeconds: 300.4 },
      { eventSeq: 6, event: 'playing', positionSeconds: 300.8 },
    ];
    let last: request.Response | undefined;
    for (const item of events) {
      last = await postObservation(rig.app, rig.cookieA, session.sessionId, {
        ...item,
        expectedGeneration: session.generation,
        playbackRate: 1,
      });
      // seek 事件为按契约必须可上报的重置类事件(推进约束仅约束 playing 连续推进)
      expect(
        last.status,
        redLabel(
          'T057',
          `observations ${item.event}(eventSeq=${item.eventSeq}) 应 200`,
          `当前 ${routeShapeOf(last)}(observations 路由未装配)`,
        ),
      ).toBe(200);
      await sleep(25);
    }
    expect(last).toBeDefined();
    const rows = observationRowsOf(session.sessionId);
    expect(rows.map((row) => row.eventType)).toEqual(['playing', 'playing', 'seeking', 'pause', 'playing', 'playing']);
    // 尾锚语义(data-model §5/schema CHECK:成对非空或成对空;seek/pause 重置):
    // 连续 playing 已锚定 → seeking/pause 行锚为空 → 后续 playing 重新锚定(需新的连续末段)
    const anchoredBefore = rows.filter((row) => row.eventSeq <= 2);
    expect(anchoredBefore.some((row) => row.tailAnchorPositionSeconds !== null && row.tailAnchorTime !== null)).toBe(true);
    for (const row of rows.filter((item) => item.eventSeq === 3 || item.eventSeq === 4)) {
      expect(
        [row.tailAnchorPositionSeconds, row.tailAnchorTime],
        `eventSeq=${row.eventSeq}(${row.eventType})应成对空(尾锚已重置)`,
      ).toEqual([null, null]);
    }
    const reAnchored = rows.filter((row) => row.eventSeq >= 5);
    expect(reAnchored.some((row) => row.tailAnchorPositionSeconds !== null && row.tailAnchorTime !== null)).toBe(true);
  });

  it('A6 [计划内红·待 T057] rate 0.5/2 边界接受;0.49/2.01 与未知 event → 400 VALIDATION_FAILED(schema 面)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a6-');
    const session = await openReadySession(rig, rig.cookieA);
    // 边界内:0.5 与 2 均接受(data-model §5「允许0.5–2倍速」)
    const lower = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 5,
      playbackRate: 0.5,
    });
    expect(
      lower.status,
      redLabel('T057', 'observations 应 200(rate=0.5 边界接受)', `当前 ${routeShapeOf(lower)}(observations 路由未装配)`),
    ).toBe(200);
    const upper = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 2,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 5.5,
      playbackRate: 2,
    });
    expect(upper.status).toBe(200);
    // 超界:schema min/max → 400(0.49 / 2.01)
    const belowRate = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 3,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 5.6,
      playbackRate: 0.49,
    });
    expectProblem(belowRate, 400, ProblemCode.VALIDATION_FAILED);
    const aboveRate = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 3,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 5.6,
      playbackRate: 2.01,
    });
    expectProblem(aboveRate, 400, ProblemCode.VALIDATION_FAILED);
    // 未知 event 枚举 → 400
    const unknownEvent = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 3,
      expectedGeneration: session.generation,
      event: 'rewind',
      positionSeconds: 5.6,
      playbackRate: 1,
    });
    expectProblem(unknownEvent, 400, ProblemCode.VALIDATION_FAILED);
  });

  it('A7 [计划内红·待 T057] playing 推进 > 服务器间隔×rate+0.5s → 拒绝(accepted=false,游标不动,不落数据行)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a7-');
    const session = await openReadySession(rig, rig.cookieA);
    const first = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 100,
      playbackRate: 1,
    });
    expect(
      first.status,
      redLabel('T057', 'observations 应 200(首次接受)', `当前 ${routeShapeOf(first)}(observations 路由未装配)`),
    ).toBe(200);
    // 毫秒级真实间隔(≈0.03s)内推进 40s ≫ 间隔×1+0.5s → 不可行推进被拒
    // (data-model §5「推进不得大于服务器间隔×rate+0.5s」;拒绝形态钉为 accepted=false
    // —— 409 保留给同 seq 异载荷冲突,陈旧 false 保留给低 seq)
    await sleep(30);
    const infeasible = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 2,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 140,
      playbackRate: 1,
    });
    expect(infeasible.status).toBe(200);
    const body = infeasible.body as Record<string, unknown>;
    expect(body['accepted']).toBe(false);
    expect(body['lastEventSeq']).toBe(1);
    // 拒绝观测不落数据行、不入尾段证据
    expect(observationCount(session.sessionId)).toBe(1);
  });

  it('A8 [计划内红·待 T057+T058] 尾段 gap>3s → 资格 unknown 保守形态:finish autoNextEligible=false(final 先接受)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-a8-');
    const session = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session);
    // 尾窗内两观测之间留 3.2s 真实接收间隔(>3s):推进 0.4 ≤ 3.2×1+0.5(隔离推进规则,
    // 仅触发 gap 连续性规则)→ 尾段连续性 unknown,需新的连续末段而未形成
    const first = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 358,
      playbackRate: 1,
    });
    expect(
      first.status,
      redLabel('T057', 'observations 应 200(首次接受)', `当前 ${routeShapeOf(first)}(observations 路由未装配)`),
    ).toBe(200);
    await sleep(3200);
    const afterGap = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 2,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 358.4,
      playbackRate: 1,
    });
    expect(afterGap.status).toBe(200);
    // final 落尾窗 [355,360]:先校验接受,再判尾段(gap>3s → unknown → 保守拒绝连播)
    const finish = await postFinish(rig.app, rig.cookieA, session.sessionId, finishPayloadOf(session, 2, 358.4));
    expect(
      finish.status,
      redLabel(
        'T057+T058',
        'finish 应 200 FinishReceipt(final 接受;gap>3s 尾段 unknown → autoNextEligible=false)',
        `当前 ${routeShapeOf(finish)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const receipt = finish.body as Record<string, unknown>;
    expect(receipt['finalSessionAccepted']).toBe(true);
    expect(receipt['historyApplied']).toBe(true);
    expect(receipt['sessionCompleted']).toBe(false);
    expect(receipt['autoNextEligible']).toBe(false);
    expect(receipt['reason']).toBe('no_tail_observation');
    expect(receipt['ended']).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* B finish 主链(api.md §4 finish 行+语义段;FinishReceipt;playback-state §4) */
/* ------------------------------------------------------------------ */

describe('T051 · B finish 主链(api.md §4 finish 行+FinishReceipt 13 键;playback-state §4)', () => {
  it('B1 [计划内红·待 T057+T058] 自然结束 final→200 FinishReceipt:独立值 completed 形态+终态+历史 completed=1', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-b1-');
    const session = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session);
    // 连续尾段观测(355.5→359.5,0.4s 步进):覆盖末段窗 [357.5,359.5](min(2,360×5%)=2s)
    await sendTailObservations(rig, rig.cookieA, session, { from: 355.5, to: 359.5, step: 0.4 });
    // final 本次样本落尾窗 min(5,360×5%)=5s 内(360-359.5=0.5 ≤ 5)
    const res = await postFinish(rig.app, rig.cookieA, session.sessionId, finishPayloadOf(session, 2, NATURAL_END_POSITION));
    expect(
      res.status,
      redLabel(
        'T057+T058',
        'finish 应 200 FinishReceipt(reason=completed,四独立值全真)',
        `当前 ${routeShapeOf(res)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as Record<string, unknown>;
    // FinishReceipt 13 键全量(api.md §1 / openapi additionalProperties:false)
    expect(Object.keys(body).sort()).toEqual([...FINISH_RECEIPT_010_KEYS].sort());
    expect(body['sessionId']).toBe(session.sessionId);
    expect(body['generation']).toBe(session.generation);
    expect(body['ended']).toBe(true);
    // 四独立值(finalSessionAccepted/historyApplied/sessionCompleted/autoNextEligible)
    expect(body['finalSessionAccepted']).toBe(true);
    expect(body['historyApplied']).toBe(true);
    expect(body['historyRevision']).toBeGreaterThanOrEqual(1);
    expect(body['sessionCompleted']).toBe(true);
    expect(body['autoNextEligible']).toBe(true);
    expect(body['reason']).toBe('completed');
    expect(body['positionSeconds']).toBe(NATURAL_END_POSITION);
    expect(body['durationSeconds']).toBe(EP01_DURATION_SECONDS);
    expect(typeof body['endedAt']).toBe('string');
    expect(Number.isNaN(Date.parse(String(body['endedAt'])))).toBe(false);
    expect(body['replayed']).toBe(false);
    // 存储面:receipt 落库;历史 completed 只由有效 finish 写(data-model §5)
    const receipt = finishReceiptRowOf(session.sessionId);
    expect(receipt).toBeDefined();
    expect(receipt!.reason).toBe('completed');
    expect(receipt!.sessionCompleted).toBe(1);
    expect(receipt!.autoNextEligible).toBe(1);
    const history = historyRowOf(rig.householdId, rig.profileAId, rig.ep01MediaId);
    expect(history).toBeDefined();
    expect(history!.completed).toBe(1);
    expect(history!.positionSeconds).toBe(NATURAL_END_POSITION);
    // 会话终态与 receipt 同提交(playback-state §4「写receipt→ended」)
    const status = await getStatus(rig.app, rig.cookieA, session.sessionId);
    expect((status.body as Record<string, unknown>)['state']).toBe('ended');
  });

  it('B2 [计划内红·待 T057+T058] 同 key 同 payload 重放返回原结果(replayed=true):receipt 不可变,endedAt 不刷新', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-b2-');
    const session = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session);
    await sendTailObservations(rig, rig.cookieA, session, { from: 355.5, to: 359.5, step: 0.4 });
    const payload = finishPayloadOf(session, 2, NATURAL_END_POSITION);
    const first = await postFinish(rig.app, rig.cookieA, session.sessionId, payload);
    expect(
      first.status,
      redLabel(
        'T057+T058',
        'finish 应 200 FinishReceipt(首次)',
        `当前 ${routeShapeOf(first)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const before = finishReceiptRowOf(session.sessionId);
    expect(before).toBeDefined();
    // 同 operationKey 同 payload 重放:返回原结果,仅 replayed=true
    const replay = await postFinish(rig.app, rig.cookieA, session.sessionId, payload);
    expect(replay.status, `重放应 200(实际 ${routeShapeOf(replay)})`).toBe(200);
    expect(replay.body).toEqual({ ...(first.body as Record<string, unknown>), replayed: true });
    // 重放不刷新既有结果(不可变终态):endedAt/键值不变
    const after = finishReceiptRowOf(session.sessionId);
    expect(after).toEqual(before);
  });

  it('B3 [计划内红·待 T058] 同 operationKey 异 payload → 409 IDEMPOTENCY_CONFLICT;receipt 不被改写', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-b3-');
    const { session, receipt, operationKey } = await recordMidwayFinishReceipt(rig, rig.cookieA);
    expect(receipt['reason']).toBe('no_tail_observation');
    const rowBefore = finishReceiptRowOf(session.sessionId);
    expect(rowBefore).toBeDefined();
    // 同 key 异 payload(api.md §4「same operationKey异payload409」;幂等 scope 摘要冲突,
    // 与 materializations「同key异摘要409 IDEMPOTENCY_CONFLICT」同族)
    const conflict = await postFinish(rig.app, rig.cookieA, session.sessionId, {
      operationKey,
      finalProgress: { sampleSeq: 2, expectedGeneration: session.generation, positionSeconds: 299 },
      cause: 'natural_end',
    });
    expect(
      conflict.status,
      redLabel(
        'T058',
        '同 key 异 payload 应 409 IDEMPOTENCY_CONFLICT(problem+json)',
        `当前 ${routeShapeOf(conflict)}(finish 路由未装配)`,
      ),
    ).toBe(409);
    expectProblem(conflict, 409, ProblemCode.IDEMPOTENCY_CONFLICT);
    // receipt 不被改写(重放仅返回既有结果;终态不得由新 finish 升级)
    expect(finishReceiptRowOf(session.sessionId)).toEqual(rowBefore);
  });

  it('B4 [计划内红·待 T058] 已有 receipt + 新 key 不同 → 409 FINISH_ALREADY_RECORDED 附恢复路径(finish-result)而不重算', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-b4-');
    const { session, receipt } = await recordMidwayFinishReceipt(rig, rig.cookieA);
    const rowBefore = finishReceiptRowOf(session.sessionId);
    expect(rowBefore).toBeDefined();
    // 新 key:session 只有一份不可变 finish 结果(api.md §4「已有receipt且新key不同则
    // 409 FINISH_ALREADY_RECORDED,附恢复路径而不重算」)
    const again = await postFinish(rig.app, rig.cookieA, session.sessionId, finishPayloadOf(session, 3, 359.5));
    expect(
      again.status,
      redLabel(
        'T058',
        '已有 receipt 新 key 应 409 FINISH_ALREADY_RECORDED(problem+json,detail 附恢复路径)',
        `当前 ${routeShapeOf(again)}(finish 路由未装配)`,
      ),
    ).toBe(409);
    expectProblem(again, 409, ProblemCode.FINISH_ALREADY_RECORDED);
    // 恢复路径:detail 指向 finish-result 读取入口(不重算)
    expect(String(again.body.detail ?? '')).toContain('finish-result');
    // receipt 不重算;原回执仍可经 finish-result 恢复
    expect(finishReceiptRowOf(session.sessionId)).toEqual(rowBefore);
    expect(receipt['sessionId']).toBe(session.sessionId);
  });

  it('B5 [计划内红·待 T058] 距尾过大(300/360)→ no_tail_observation 形态:final 先接受再判尾段(历史照落、资格拒绝)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-b5-');
    const { receipt } = await recordMidwayFinishReceipt(rig, rig.cookieA);
    // 「无证据不等于接口失败」:receipt 如实登记,ended=true 但无连播资格
    expect(receipt['ended']).toBe(true);
    expect(receipt['replayed']).toBe(false);
    expect(receipt['reason']).toBe('no_tail_observation');
    // final 先校验接受再判尾段:finalSessionAccepted/historyApplied 独立为真(final 已落账)
    expect(receipt['finalSessionAccepted']).toBe(true);
    expect(receipt['historyApplied']).toBe(true);
    expect(receipt['historyRevision']).toBeGreaterThanOrEqual(1);
    expect(receipt['sessionCompleted']).toBe(false);
    expect(receipt['autoNextEligible']).toBe(false);
    expect(receipt['positionSeconds']).toBe(MIDWAY_POSITION);
    expect(receipt['durationSeconds']).toBe(EP01_DURATION_SECONDS);
    // 存储面:final 位置已先落历史(final 先接受),completed 不置位
    const history = historyRowOf(rig.householdId, rig.profileAId, rig.ep01MediaId);
    expect(history).toBeDefined();
    expect(history!.positionSeconds).toBe(MIDWAY_POSITION);
    expect(history!.completed).toBe(0);
  });

  it('B6 [计划内红·待 T057+T058] 末段连续性:final 在尾窗但缺末段(min(2,d×5%))连续观测 → 资格拒绝', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-b6-');
    const session = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session);
    // 观测止于 350.0:final 358 在尾窗 [355,360] 内,但末段窗 [356,358] 无连续观测
    await sendTailObservations(rig, rig.cookieA, session, { from: 348, to: 350, step: 0.4 });
    const res = await postFinish(rig.app, rig.cookieA, session.sessionId, finishPayloadOf(session, 2, 358));
    expect(
      res.status,
      redLabel(
        'T057+T058',
        'finish 应 200 FinishReceipt(缺末段样本 → autoNextEligible=false/no_tail_observation)',
        `当前 ${routeShapeOf(res)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['finalSessionAccepted']).toBe(true);
    expect(body['historyApplied']).toBe(true);
    expect(body['sessionCompleted']).toBe(false);
    expect(body['autoNextEligible']).toBe(false);
    expect(body['reason']).toBe('no_tail_observation');
    expect(body['ended']).toBe(true);
    expect(body['positionSeconds']).toBe(358);
  });

  it('B7 [计划内红·待 T058] 未 started 的 final → not_started 形态(final 先校验:started 门先于尾段判定,不建历史)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-b7-');
    const session = await openReadySession(rig, rig.cookieA);
    // 无任何样本:finish 首个 final 即未越过 started 门
    const res = await postFinish(rig.app, rig.cookieA, session.sessionId, finishPayloadOf(session, 1, 0));
    expect(
      res.status,
      redLabel(
        'T058',
        'finish 应 200 FinishReceipt(reason=not_started,ended=true,资格否定)',
        `当前 ${routeShapeOf(res)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['reason']).toBe('not_started');
    expect(body['ended']).toBe(true);
    expect(body['finalSessionAccepted']).toBe(false);
    expect(body['historyApplied']).toBe(false);
    expect(body['historyRevision']).toBeNull();
    expect(body['sessionCompleted']).toBe(false);
    expect(body['autoNextEligible']).toBe(false);
    expect(body['replayed']).toBe(false);
    // 不建历史(resolve 绑定不写可见历史;not_started final 亦不写)
    expect(historyRowCount(rig.householdId, rig.ep01MediaId)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* C superseded/stale(数据模型 §5 独立完成;playback-state §4)           */
/* ------------------------------------------------------------------ */

describe('T051 · C superseded/stale(data-model §5 个人历史归属和会话完成独立;playback-state §4)', () => {
  it('C1 [计划内红·待 T057+T058] superseded 会话 finish 独立完成:sessionCompleted=true/historyApplied=false,绝不写他 owner 历史', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-c1-');
    // 双设备两次 resolve:设备A epoch 旧,设备B epoch 新
    const sessionA = await openReadySession(rig, rig.cookieA);
    const sessionB = await openReadySession(rig, rig.cookieB);
    const epochA = progressStateRowOf(sessionA.sessionId).candidateEpoch;
    const epochB = progressStateRowOf(sessionB.sessionId).candidateEpoch;
    expect(epochB).toBeGreaterThan(epochA);
    // 新 owner(设备B)started 取得历史权
    await acceptStartedSample(rig, rig.cookieB, sessionB, 300);
    const ownerHistory = historyRowOf(rig.householdId, rig.profileAId, rig.ep01MediaId);
    expect(ownerHistory).toBeDefined();
    expect(ownerHistory!.writerPlaybackSessionId).toBe(sessionB.sessionId);
    // 旧 epoch(设备A)started → superseded(既有 epoch 语义:历史不写,ledger 仍接受)
    const supersededStart = await postProgress(rig.app, rig.cookieA, sessionA.sessionId, {
      sampleSeq: 1,
      expectedGeneration: sessionA.generation,
      positionSeconds: 100,
      reason: 'started',
    });
    expect(supersededStart.status).toBe(200);
    expect(supersededStart.body).toMatchObject({ applied: false, reason: 'superseded' });
    // 设备A 连续尾段观测 + 自然结束 final
    await sendTailObservations(rig, rig.cookieA, sessionA, { from: 355.5, to: 359.5, step: 0.4 });
    const res = await postFinish(rig.app, rig.cookieA, sessionA.sessionId, finishPayloadOf(sessionA, 2, NATURAL_END_POSITION));
    expect(
      res.status,
      redLabel(
        'T057+T058',
        'finish 应 200 FinishReceipt(superseded 独立完成形态)',
        `当前 ${routeShapeOf(res)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as Record<string, unknown>;
    // superseded final 可 sessionAccepted/completed 而 historyApplied=false(playback-state §4)
    expect(body['finalSessionAccepted']).toBe(true);
    expect(body['historyApplied']).toBe(false);
    expect(body['historyRevision']).toBeNull();
    // 会话完成是本会话观测结果,独立于历史归属(data-model §5)
    expect(body['sessionCompleted']).toBe(true);
    expect(body['autoNextEligible']).toBe(true);
    expect(body['reason']).toBe('completed');
    expect(body['ended']).toBe(true);
    // 绝不把其完成写到另设备 owner 历史:writer/位置/revision 不变,completed 仍 0
    const after = historyRowOf(rig.householdId, rig.profileAId, rig.ep01MediaId)!;
    expect(after.writerPlaybackSessionId).toBe(sessionB.sessionId);
    expect(after.positionSeconds).toBe(300);
    expect(after.revision).toBe(ownerHistory!.revision);
    expect(after.completed).toBe(0);
    expect(historyRowCount(rig.householdId, rig.ep01MediaId)).toBe(1);
  });

  it('C2 [计划内红·待 T058] stale final → 不连播:reason=stale_final、ended=true、autoNextEligible=false,ledger/历史不动', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-c2-');
    const session = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session);
    await acceptPeriodicSample(rig, rig.cookieA, session, 2, 300);
    // final 携低于最新游标的 seq(1 < 2)→ stale final
    const res = await postFinish(rig.app, rig.cookieA, session.sessionId, finishPayloadOf(session, 1, 120));
    expect(
      res.status,
      redLabel(
        'T058',
        'finish 应 200 FinishReceipt(stale_final 可 ended 但不可 auto-next)',
        `当前 ${routeShapeOf(res)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['reason']).toBe('stale_final');
    expect(body['ended']).toBe(true);
    expect(body['finalSessionAccepted']).toBe(false);
    expect(body['historyApplied']).toBe(false);
    expect(body['historyRevision']).toBeNull();
    expect(body['sessionCompleted']).toBe(false);
    expect(body['autoNextEligible']).toBe(false);
    // 不写新 final:ledger 游标与历史位置均保持 periodic(300)原值
    expect(progressStateRowOf(session.sessionId).lastSampleSeq).toBe(2);
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.ep01MediaId)?.positionSeconds).toBe(300);
  });
});

/* ------------------------------------------------------------------ */
/* D stop 竞争与完成证据分离(api.md §4 stop 行;data-model §5)            */
/* ------------------------------------------------------------------ */

describe('T051 · D stop 竞争与完成证据分离(api.md §4 stop 行;data-model §5「普通stop不生成成功完成证据」)', () => {
  it('D1 [计划内红·待 T058] stop 先赢(204,绿)→ 后到 finish 返回 not_completed 且不补写 final(endedAt 取原终态时刻)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-d1-');
    const session = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session);
    await acceptPeriodicSample(rig, rig.cookieA, session, 2, 300);
    // stop 先赢:005 既有装配 204(绿)
    const stop = await postStop(rig.app, rig.cookieA, session.sessionId);
    expect(stop.status).toBe(204);
    const stoppedRow = sessionRowOf(session.sessionId);
    expect(stoppedRow.state).toBe('ended');
    expect(stoppedRow.endedAt).not.toBeNull();
    // 后到 finish(新 key):只登记「别处停止」形态回执,不写新 final、不得升级
    // (api.md §4 表行「返回 not_completed」+ 语义段「endedAt 取原终态时刻」)
    const res = await postFinish(rig.app, rig.cookieA, session.sessionId, finishPayloadOf(session, 3, NATURAL_END_POSITION));
    expect(
      res.status,
      redLabel(
        'T058',
        'finish 应 200 FinishReceipt(reason=not_completed,不补写 final)',
        `当前 ${routeShapeOf(res)}(finish 路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body['reason']).toBe('not_completed');
    expect(body['ended']).toBe(true);
    expect(body['finalSessionAccepted']).toBe(false);
    expect(body['historyApplied']).toBe(false);
    expect(body['historyRevision']).toBeNull();
    expect(body['sessionCompleted']).toBe(false);
    expect(body['autoNextEligible']).toBe(false);
    expect(body['replayed']).toBe(false);
    // endedAt 取原终态时刻(stop 的 ended_at),不是本次 finish 时刻
    expect(body['endedAt']).toBe(stoppedRow.endedAt);
    // 不补写 final:ledger 游标(2/300)与历史位置(300)保持原值
    expect(progressStateRowOf(session.sessionId).lastSampleSeq).toBe(2);
    expect(historyRowOf(rig.householdId, rig.profileAId, rig.ep01MediaId)?.positionSeconds).toBe(300);
    expect(finishReceiptRowOf(session.sessionId)?.reason).toBe('not_completed');
  });

  it('D2 [计划内红·待 T058] finish 先赢 → stop 204 语义不变(仅清理):receipt 不可变、终态不升级', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-d2-');
    const { session, receipt } = await recordMidwayFinishReceipt(rig, rig.cookieA);
    const rowBefore = finishReceiptRowOf(session.sessionId);
    expect(rowBefore).toBeDefined();
    // finish 先赢后 stop 仅清理(playback-state §4):仍 204、零回执副作用
    const stop = await postStop(rig.app, rig.cookieA, session.sessionId);
    expect(
      stop.status,
      redLabel('T058', 'finish 成功后 stop 仍应 204(既有语义不变)', `finish 阶段已红,stop 前置实际 ${stop.status}`),
    ).toBe(204);
    expect(stop.body ?? null).toBeFalsy();
    // 终态不升级:receipt 原样(endedAt/reason 不变)
    expect(finishReceiptRowOf(session.sessionId)).toEqual(rowBefore);
    expect(receipt['reason']).toBe('no_tail_observation');
    const status = await getStatus(rig.app, rig.cookieA, session.sessionId);
    expect((status.body as Record<string, unknown>)['state']).toBe('ended');
  });

  it('D3 [绿·既有语义回归] 普通 stop(空与携 final)204 落终态/ledger/历史,但绝不生成完成证据(receipt 零行、completed=0)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-d3-');
    // 会话1:空 stop(幂等终止,无 final)
    const session1 = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session1);
    const stop1 = await postStop(rig.app, rig.cookieA, session1.sessionId);
    expect(stop1.status).toBe(204);
    // 会话2:携 finalProgress 的 stop(T101:final 与终态同事务落 ledger/历史)
    const session2 = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session2);
    const stop2 = await postStop(rig.app, rig.cookieA, session2.sessionId, {
      finalProgress: { sampleSeq: 2, expectedGeneration: session2.generation, positionSeconds: 120 },
    });
    expect(stop2.status).toBe(204);
    expect((await getStatus(rig.app, rig.cookieA, session1.sessionId)).body).toMatchObject({ state: 'ended' });
    expect((await getStatus(rig.app, rig.cookieA, session2.sessionId)).body).toMatchObject({ state: 'ended' });
    // 完成回执只由 finish 登记:两次 stop 后 receipt 表零行(data-model §5「普通stop204
    // 不生成成功完成证据」)
    expect(finishReceiptCount(rig.householdId)).toBe(0);
    // stop-with-final 落位置但不落完成:历史 completed 仍 0(仅有效 finish 可置位)
    const history = historyRowOf(rig.householdId, rig.profileAId, rig.ep01MediaId);
    expect(history).toBeDefined();
    expect(history!.positionSeconds).toBe(120);
    expect(history!.completed).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* E finish-result 恢复与上下文边界(api.md §4 finish-result 行)          */
/* ------------------------------------------------------------------ */

describe('T051 · E finish-result(api.md §4:只当前原设备/原上下文可读,丢响应恢复;禁止跨上下文读旧结果)', () => {
  it('E1 [计划内红·待 T058] 无 receipt 时 GET finish-result → 200 body null(FinishReceipt|null 形态)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-e1-');
    const session = await openReadySession(rig, rig.cookieA);
    const res = await getFinishResult(rig.app, rig.cookieA, session.sessionId);
    expect(
      res.status,
      redLabel(
        'T058',
        'finish-result 应 200 body null(未 finish 的会话无回执)',
        `当前 ${routeShapeOf(res)}(finish-result 路由未装配)`,
      ),
    ).toBe(200);
    expect(res.body).toBeNull();
  });

  it('E2 [计划内红·待 T058] finish 丢响应恢复:GET 返回与 finish 响应一致的原 receipt(重复 GET 幂等)', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-e2-');
    const { session, receipt } = await recordMidwayFinishReceipt(rig, rig.cookieA);
    // 网络丢响应可 GET 恢复:回执与 finish 响应逐字段一致
    const restored = await getFinishResult(rig.app, rig.cookieA, session.sessionId);
    expect(
      restored.status,
      redLabel(
        'T058',
        'finish-result 应 200 FinishReceipt(与 finish 响应一致)',
        `当前 ${routeShapeOf(restored)}(finish-result 路由未装配)`,
      ),
    ).toBe(200);
    expect(restored.body).toEqual(receipt);
    // 重复 GET 幂等(重放仅返回既有结果)
    const again = await getFinishResult(rig.app, rig.cookieA, session.sessionId);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(receipt);
  });

  it('E3 [计划内红·待 T058+绿·旧上下文空 stop] 跨设备/旧上下文(A→B→A)GET 均 404 同形;旧上下文仅空 stop 清理仍 204', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-e3-');
    const { session } = await recordMidwayFinishReceipt(rig, rig.cookieA);
    expect(finishReceiptRowOf(session.sessionId)).toBeDefined();
    // 跨设备读 → 404 PLAYBACK_NOT_FOUND,与随机 id 同形(不泄露存在性)
    const crossDevice = await getFinishResult(rig.app, rig.cookieB, session.sessionId);
    expect(
      crossDevice.status,
      redLabel(
        'T058',
        '跨设备 finish-result 应 404 PLAYBACK_NOT_FOUND(problem+json)',
        `当前 ${routeShapeOf(crossDevice)}(finish-result 路由未装配)`,
      ),
    ).toBe(404);
    expectProblem(crossDevice, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    const randomId = await getFinishResult(rig.app, rig.cookieB, randomUUID());
    expectProblem(randomId, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossDevice, randomId);
    // 旧上下文(A→B→A,contextVersion 递增)→ 404 同形:禁止跨上下文读旧结果
    await cycleProfileContext(rig);
    const staleContext = await getFinishResult(rig.app, rig.cookieA, session.sessionId);
    expect(
      staleContext.status,
      redLabel(
        'T058',
        '旧上下文 finish-result 应 404(与不存在同形,contextVersion 不等)',
        `当前 ${routeShapeOf(staleContext)}(finish-result 路由未装配)`,
      ),
    ).toBe(404);
    expectProblem(staleContext, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(staleContext, randomId);
    // 无权读取时只允许既有最小空 stop 清理(api.md §4):005 既有装配 204(绿)
    const cleanupStop = await postStop(rig.app, rig.cookieA, session.sessionId);
    expect(cleanupStop.status).toBe(204);
    // receipt 行保留(24h 重放保护),仅读取被上下文边界拒绝
    expect(finishReceiptRowOf(session.sessionId)).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* F 授权负向(既有 stop 面绿;observations/finish/finish-result 随装配)  */
/* ------------------------------------------------------------------ */

describe('T051 · F 授权负向(api.md §0/§4:身份只从服务端推导;授权失败优先于专用错误)', () => {
  it('F1 [绿·既有语义回归] stop:游客 401;伪造 profileId 400;跨设备/随机 id 404 同形;重复 stop 幂等 204', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-f1-');
    const session = await openReadySession(rig, rig.cookieA);
    await acceptStartedSample(rig, rig.cookieA, session);
    // 游客 401(先于一切域级语义;problem+json)
    const guest = await postStop(rig.app, '', session.sessionId);
    expectProblem(guest, 401, ProblemCode.SESSION_INVALID);
    // body 伪造 profileId → 400 VALIDATION_FAILED(StopRequest additionalProperties:false)
    const forged = await postStop(rig.app, rig.cookieA, session.sessionId, { profileId: rig.profileAId });
    expectProblem(forged, 400, ProblemCode.VALIDATION_FAILED);
    // 跨设备 stop → 404 与随机 id 同形(不泄露存在性)
    const crossDevice = await postStop(rig.app, rig.cookieB, session.sessionId);
    expectProblem(crossDevice, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    const randomId = await postStop(rig.app, rig.cookieB, randomUUID());
    expectProblem(randomId, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameProblemShape(crossDevice, randomId);
    // 归属未被越权改动:原设备仍可 stop;重复 stop 幂等 204(终态零副作用)
    expect((await postStop(rig.app, rig.cookieA, session.sessionId)).status).toBe(204);
    expect((await postStop(rig.app, rig.cookieA, session.sessionId)).status).toBe(204);
    expect((await getStatus(rig.app, rig.cookieA, session.sessionId)).body).toMatchObject({ state: 'ended' });
  });

  it('F2 [计划内红·待 T057+T058] observations/finish/finish-result:游客 401;伪造 profileId 400;非 UUID operationKey 400', async () => {
    const rig = await startOnlineFinishRig('hmp-t051-f2-');
    const session = await openReadySession(rig, rig.cookieA);
    // 游客 observations → 401 SESSION_INVALID(当前路由未装配 404)
    const guestObs = await postObservation(rig.app, '', session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 0,
      playbackRate: 1,
    });
    expect(
      guestObs.status,
      redLabel(
        'T057',
        '游客 observations 应 401 SESSION_INVALID(problem+json;授权先于域级语义)',
        `当前 ${routeShapeOf(guestObs)}(observations 路由未装配)`,
      ),
    ).toBe(401);
    expectProblem(guestObs, 401, ProblemCode.SESSION_INVALID);
    // 游客 finish → 401
    const guestFinish = await postFinish(rig.app, '', session.sessionId, finishPayloadOf(session, 1, 0));
    expect(
      guestFinish.status,
      redLabel(
        'T058',
        '游客 finish 应 401 SESSION_INVALID(problem+json)',
        `当前 ${routeShapeOf(guestFinish)}(finish 路由未装配)`,
      ),
    ).toBe(401);
    expectProblem(guestFinish, 401, ProblemCode.SESSION_INVALID);
    // 游客 finish-result → 401
    const guestResult = await getFinishResult(rig.app, '', session.sessionId);
    expect(
      guestResult.status,
      redLabel(
        'T058',
        '游客 finish-result 应 401 SESSION_INVALID(problem+json)',
        `当前 ${routeShapeOf(guestResult)}(finish-result 路由未装配)`,
      ),
    ).toBe(401);
    expectProblem(guestResult, 401, ProblemCode.SESSION_INVALID);
    // body 伪造 profileId → 400(additionalProperties:false,身份只从服务端推导)
    const forgedObs = await postObservation(rig.app, rig.cookieA, session.sessionId, {
      eventSeq: 1,
      expectedGeneration: session.generation,
      event: 'playing',
      positionSeconds: 0,
      playbackRate: 1,
      profileId: rig.profileAId,
    });
    expectProblem(forgedObs, 400, ProblemCode.VALIDATION_FAILED);
    const forgedFinish = await postFinish(rig.app, rig.cookieA, session.sessionId, {
      ...finishPayloadOf(session, 1, 0),
      profileId: rig.profileAId,
    });
    expectProblem(forgedFinish, 400, ProblemCode.VALIDATION_FAILED);
    // finish operationKey 必须为 UUID(api.md §4)→ 400
    const nonUuid = await postFinish(rig.app, rig.cookieA, session.sessionId, {
      operationKey: 'not-a-uuid',
      finalProgress: { sampleSeq: 1, expectedGeneration: session.generation, positionSeconds: 0 },
      cause: 'natural_end',
    });
    expectProblem(nonUuid, 400, ProblemCode.VALIDATION_FAILED);
  });
});
