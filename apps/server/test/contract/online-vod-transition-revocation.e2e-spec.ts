import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import {
  mediaSource,
  playbackFinishReceipt,
  vodSourceConfig,
} from '@platform/database/schema';
import { hashToken } from '@contexts/identity-access/infrastructure/token.service';
import { PlaybackRetentionService } from '@contexts/playback/application/playback-retention.service';
import {
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  expectProblemContentType,
  initialize,
  login,
  restartApp,
  startFreshApp,
  type ControlledMediaServer,
  type TestRig,
} from '../helpers';
import {
  MANAGEMENT_MAIN_PIN,
  createProfileViaSettings,
  selectMainAndUnlockSettings,
} from '../helpers-management';
import type { MediaRequestContext } from '../fixtures/controlled-media-server';
import {
  createFixtureVodSource,
  createThreeEpisodeSerialWorld,
  findUpstreamRoute,
  type FixtureUpstreamSource,
} from '../fixtures/online-vod/fixture-upstream';

/**
 * T078(010-online-vod · US5,测试先行):过渡撤销/失权/复活契约 e2e ——
 * 创建/消费/GET 重放/cancel 每步旧上下文同形拒绝;更换 Profile/禁源 ABA/目标修订/
 * 偏好关闭后不能消费;已消费后继取消输家、watchdog 及重启不复活。
 * 审查补充:禁源但同 context 仅清理、跨设备/Profile/ABA 拒绝及清理标记阻断新票/资产。
 * 「只写测试不实现」;依赖 T072(过渡编排全量)与 T062(cleanup+失权 GET 面)均已
 * 落地 —— 本任务为系统性钉面:把「旧上下文/身份变化/禁源 ABA」的拒绝面逐步骤钉全,
 * 绝大多数用例对既有全绿面直接绿;个别确属未实现语义标计划内红并映射「→T081」,
 * 不虚绿、不跳过。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §5(GET 行「完整 IntentReply 要求当前
 *   源/目标权限;失权时不返回完整结果,使用 cleanup 最小清理接口,不借 GET 发票」;
 *   cancel 各 outcome;语义段「意图 TTL 60s;已消费不按 TTL 丢重放映射,至少 24h 保留;
 *   取消已经输给消费返回 successor,协调器显式 stop 不需要的后继;服务器 watchdog 回收
 *   无人接管 preparing/60s awaitingGesture 会话」)+ §7 I5(cleanup 权威:仅当前有效
 *   DeviceSession、原 Profile 及完全相同 contextVersion 可用,跨家庭/设备/Profile/旧
 *   context 及不存在均 404;不要求源或目标当前内容策略放行;不返回目标 ID/元数据/位置/
 *   票据;consumed 为唯一后继写持久 cleanup_requested,标记后拒绝其 renew/新资产并投递
 *   幂等空 stop;context 变更后禁止调用,由撤销处理与持久 cleanup 扫描负责;失败/重启
 *   扫描重试)+ §0/§6(不存在/跨家庭/非本设备/旧上下文 404 同形;来源/上下文授权失败
 *   优先于专用错误,防止借新错误判别旧会话存在性)+ §1(IntentReply 11 键;
 *   TransitionCleanupReply 仅 outcome 键);
 * - docs/specs/010-online-vod/data-model.md §7(intent 五态/consumed 槽永久不能再建立
 *   第二后继/取消输家返回 successor)+ §9(未有 playback_started_at 的 ready 会话以
 *   服务器 readyAt 起 60s 固定期限回收,heartbeat/renew 不续命;已消费 intent/slot/
 *   后继映射至少 24h 引用保护)+ §10(cleanup_requested/cleanup_reason/cleanup_state
 *   持久标记;标记先阻止新票/资产,网络和进程取消在 commit 后执行;策略失权不阻止最小
 *   清理;context 失配仍 404)+ §2(来源「启停均 locator_revision+1 防 ABA」)+ §6
 *  (重启中断旧播放/意图,已保存 Profile 历史保留以新认证 resolve 续播;cleanup 状态
 *   持久化可启动扫描,不能靠内存 refcount 唯一保障);
 * - docs/specs/010-online-vod/tasks.md T078 原文与审查补充(被钉面清单)+ T081(重启
 *   扫描/cleanup 持久标记收口 —— watchdog/重启/补投语义的转绿归属任务)+ T052 A/E/D5
 *   组与 T062 G 组(已钉面 —— B/E/G 组按「复验不劣化」口径重钉);
 * - rig 惯例(直接复用不改共享):test/contract/online-vod-next-transition.e2e-spec.ts
 *  (T052:next-plans/intents 消费链/失权 GET 断言/cleanup 手法 —— G 组已全绿,其失权
 *   GET/cleanup 手法逐形复用)、online-vod-switch.e2e-spec.ts(T067:禁源 DB 直改/
 *   旧 context 推进/资源种子口径)、playback-stream.e2e-spec.ts(T015:资产 URL 票据面)、
 *   helpers.restartApp(场景5/FR-005 重启:同一 DATA_DIR/DB_FILENAME 关闭后重建)。
 *
 * 装配方式(沿用 010 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威迁移,含 0007_online_vod)+
 *   initialize/login/selectMainAndUnlockSettings 身份 seed + Supertest 真实 HTTP;
 *   F 组重启经 helpers.restartApp(同 DATA_DIR/DB_FILENAME 重建 AppModule,不重放迁移
 *   DDL —— 真实重启形态;boot 恢复 recoverOnBoot 中断活动播放为 interrupted);
 * - 受控上游 mock 沿用 T036/T052 rig 手法(createControlledMediaServer 127.0.0.1 随机
 *   端口 + fixture-upstream 路由表 findUpstreamRoute 派发 Apple CMS JSON;
 *   LAN_ALLOWED_TARGETS='127.0.0.1';全程不发真实外网请求)。素材 = 三集连续剧
 *  (stardust EP1→EP2→EP3 同线明确 N+1;消费链目标恒 EP02);
 * - 双设备/双 Profile:两次 login 即两个 DeviceSession;跨 Profile 面经 Settings API
 *   新建档案后 POST /profiles/:id/select 切换(身份推导漂移素材;切档同事务递增
 *   profile_context_version 并终态化旧上下文活动播放 —— B1 钉面);
 * - DB 直改仅用于无 HTTP 语义的工厂事实,逐处注明:禁源(media_source.enabled=0,
 *   供禁源消费/清理叙事;ABA 面走真实 T026 PATCH /settings/sources 启停 —— 启停均
 *   locator_revision+1,递增断言锚定 media_source.locator_revision)、旧 context 推进
 *  (device_session.profile_context_version+1,等价 A→B→A)、意图 TTL 到期
 *  (created_at/expires_at 成对置过去,保持 CHECK)、目标详情修订推进/回滚
 *  (vod_title.current_detail_revision)、finish receipt 种子(等价 T058 finish 已提交
 *   且 autoNextEligible 形态)、cleanup 崩溃窗口标记(playback_session.cleanup_requested=1
 *   + cleanup_state='pending',等价「标记事务已提交、提交后幂等空 stop 未落定」的持久
 *   中间态 —— I5 崩溃窗口形态,列值与 markDeliveryCleanupRequested 提交面同形)。
 *   跨 Profile 面先建档案后切换(Settings 授予校验当前 contextVersion,切换留到身份
 *   漂移面执行)。不改任何共享文件;无 git 操作。
 *
 * ───────────────────────── 状态预期(全绿钉面)─────────────────────────
 * T060(创建/查询/取消编排)、T061(resolve 消费)、T062(cleanup+失权 GET 面+扫描)、
 * T045(T046:未起播 60s 回收+renew 固定输入重验)均已落地且现有契约面全绿 —— 本文件
 * 全部用例直接钉既有绿面,预期 15/15 绿、两次运行一致。两处按「注册稳定码」收敛钉面
 * (契约未钉专码,以实现注册表为准,不虚绿也不误红):
 * - C2 ABA 修订失配续播拒绝 = 503 PLAYBACK_RESOURCE_UNAVAILABLE + 会话 failed
 *  (data-model §3「旧会话修订不匹配时拒绝新交付,准备转 failed,需新 resolve」);
 * - G1 标记阻断新资产 = 503 PLAYBACK_RESOURCE_UNAVAILABLE(交付门注册稳定码;
 *   renew 面阻断为 409 PLAYBACK_NOT_READY,T062 已钉,此处复验)。
 * 若上述任一断言失败,按用例消息内标注映射「→T081」收口,不以 skip 掩盖。
 *
 * 预期计数:绿 15(A 4 + B 2 + C 2 + D 1 + E 2 + F 2 + G 2)/ 红 0;两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

const NEXT_PLANS_URL = '/api/playback/next-plans';
const INTENTS_URL = '/api/playback/transition-intents';
const RESOLVE_URL = '/api/playback/resolve';

/** IntentReply 契约 11 键(api.md §1 / openapi IntentReply:additionalProperties:false) */
const INTENT_REPLY_KEYS = [
  'action',
  'expiresAt',
  'fromGeneration',
  'fromSessionId',
  'id',
  'matchConfidence',
  'positionMode',
  'slotRevision',
  'status',
  'successorSessionId',
  'targetMediaId',
] as const;

/** TransitionCancelReply 3 键(api.md §5 / openapi) */
const CANCEL_REPLY_KEYS = ['outcome', 'slotRevision', 'successorSessionId'] as const;

/** TransitionCleanupReply 最小 1 键(I5「不返回目标 ID、元数据、位置或票据」) */
const CLEANUP_REPLY_KEYS = ['outcome'] as const;

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(
    res.status,
    `应 ${status} ${code}(契约稳定码;实际 ${res.status} ${JSON.stringify(res.body).slice(0, 220)})`,
  ).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 同形断言:两响应 status+code 一致即不可区分(404 detail 含路径不比对) */
function expectSameShape(a: request.Response, b: request.Response, label: string): void {
  expect(a.status, `${label}:status 应同形`).toBe(b.status);
  expect(a.body.code, `${label}:稳定码应同形(不可借错误判别存在性)`).toBe(b.body.code);
}

/** 契约未钉专码的稳定拒绝面(标记/修订门):4xx/5xx problem + no-store + 指定注册码 */
function expectStableRejection(res: request.Response, status: number, code: string, label: string): void {
  expect(res.status, `${label}:应 ${status} ${code}(注册稳定码;实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code, `${label}:稳定错误码`).toBe(code);
  expect(res.headers['cache-control'], `${label}:错误响应须 no-store(api §0)`).toBe('no-store');
}

/** 失权/旧上下文 404 不泄漏受保护标识(目标/后继不可从错误面判别) */
function expectNoLeak(res: request.Response, secrets: readonly string[], label: string): void {
  const payload = JSON.stringify(res.body ?? '');
  for (const secret of secrets) {
    expect(payload, `${label}:404 拒绝面不得泄漏受保护标识(${secret.slice(0, 8)}…)`).not.toContain(secret);
  }
}

interface IntentSnapshot {
  readonly id: string;
  readonly status: string;
  readonly slotRevision: number;
  readonly successorSessionId: string | null;
  readonly targetMediaId: string;
  readonly positionMode: string;
  readonly expiresAt: string;
  readonly [key: string]: unknown;
}

interface NextPlanSnapshot {
  readonly nextPlanRef: string;
  readonly targetMediaId: string;
  readonly detailRevision: number;
  readonly historyRevision: number;
  readonly expiresAt: string;
  readonly [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* 上游 mock(010 T036/T052 rig 手法:受控 CMS 端口 + fixture 路由表派发)  */
/* ------------------------------------------------------------------ */

const activeMediaServers: ControlledMediaServer[] = [];

/** 构建单个健康受控源(三集连续剧[N+1]:EP1→EP2→EP3;消费链目标恒 EP02) */
function buildRevocationSource(port: number): FixtureUpstreamSource {
  const origin = `http://127.0.0.1:${port}`;
  return createFixtureVodSource({
    sourceId: 'fixture-vod-source-t078',
    displayName: '夹具在线片源(T078)',
    behavior: 'healthy',
    address: { host: '127.0.0.1', port },
    titleWorlds: [createThreeEpisodeSerialWorld(origin)],
  });
}

/* ------------------------------------------------------------------ */
/* rig:受控上游 + 全量迁移 app + 双设备身份 + HTTP 物化在线剧集           */
/* ------------------------------------------------------------------ */

interface RevocationRig {
  /** helpers TestRig(保留供 F 组 restartApp 同 DATA_DIR 重启) */
  readonly fresh: TestRig;
  /** 当前活动 app(F 组重启后由用例改绑到重建实例;其余组恒为初始实例) */
  app: INestApplication;
  readonly householdId: string;
  readonly server: ControlledMediaServer;
  /** 设备A · 档案A(主档案,设置已解锁) */
  readonly cookieA: string;
  /** 设备B · 档案A(同档案第二设备) */
  readonly cookieB: string;
  readonly profileAId: string;
  readonly deviceSessionAId: string;
  readonly deviceSessionBId: string;
  /** 已物化三集连续剧(T031 真实装配链产物) */
  readonly serial: {
    readonly parentMediaId: string;
    readonly ep01MediaId: string;
    readonly ep02MediaId: string;
    /** EP01 逻辑时长(3×120s;fixture 清单聚合;finish receipt 种子用) */
    readonly ep01DurationSeconds: number;
  };
  /** kind=vod media_source 行 id(禁源/ABA DB 直改用) */
  readonly sourceRowId: string;
}

function householdIdOf(): string {
  const row = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string } | undefined;
  expect(row, '夹具错误:household 行不存在(初始化未执行)').toBeDefined();
  return row!.id;
}

/** 登录令牌 → DeviceSession 行 id(token_hash=SHA-256(明文令牌),与 SessionGuard 同算法) */
function deviceSessionIdOfToken(token: string): string {
  const row = Database.db.prepare('SELECT id FROM device_session WHERE token_hash = ?').get(hashToken(token)) as
    | { id: string }
    | undefined;
  expect(row, '夹具错误:登录令牌对应的 device_session 行不存在').toBeDefined();
  return row!.id;
}

function mediaContentRevisionOf(mediaId: string): number {
  const row = Database.db.prepare('SELECT content_revision AS r FROM media_item WHERE id = ?').get(mediaId) as
    | { r: number | null }
    | undefined;
  expect(row, `夹具错误:media_item ${mediaId} 不存在`).toBeDefined();
  return row!.r ?? 1;
}

/** kind=vod 来源行(media_source + vod_source_config 一源一行;对齐 T052 rig 口径) */
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

/** 搜索 → 指定线路/分集 → 预览 → POST /api/vod/materializations(真实 T031 链)→ mediaId */
async function materializeEpisodeAt(
  app: INestApplication,
  cookie: string,
  keyword: string,
  lineIndex: number,
  episodeIndex: number,
): Promise<{ mediaId: string; parentMediaId: string }> {
  const search = await request(app.getHttpServer()).get('/api/public/vod/search').query({ q: keyword });
  expect(search.status, `搜索 ${keyword} 应 200(受控上游)`).toBe(200);
  const card = (search.body as { items: Array<{ titleRef: string }> }).items[0];
  expect(card, `搜索 ${keyword} 应至少一条结果`).toBeDefined();
  const preview = await request(app.getHttpServer()).get(
    `/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`,
  );
  expect(preview.status, `预览 ${card!.titleRef} 应 200`).toBe(200);
  const episodeRef = (preview.body as {
    lines: Array<{ episodes: Array<{ episodeRef: string }> }>;
  }).lines[lineIndex]?.episodes[episodeIndex]?.episodeRef;
  expect(episodeRef, `预览 lines[${lineIndex}].episodes[${episodeIndex}] 应有候选分集`).toBeTypeOf('string');
  const res = await request(app.getHttpServer())
    .post('/api/vod/materializations')
    .set('Cookie', cookie)
    .send({
      titleRef: card!.titleRef,
      episodeRef: episodeRef!,
      previewRevision: (preview.body as { previewRevision: number }).previewRevision,
      operationKey: randomUUID(),
    });
  expect(res.status, `物化 ${keyword}[${lineIndex}/${episodeIndex}] 应 201(T031 已装配;实际 ${JSON.stringify(res.body)})`).toBe(
    201,
  );
  const body = res.body as { mediaId: string; parentMediaId: string };
  return { mediaId: body.mediaId, parentMediaId: body.parentMediaId };
}

async function startRevocationRig(prefix: string): Promise<RevocationRig> {
  const source = buildRevocationSource(0);
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
            // 挂起不回包(与 T052 rig 同形态;本文件路由全为健康应答,防御分支)
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

  const fresh = await startFreshApp({ prefix, env: { LAN_ALLOWED_TARGETS: '127.0.0.1' } });
  const app = fresh.app;

  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const cookieA = cookiePairOf(loggedIn);
  const profileAId = await selectMainAndUnlockSettings(app, cookieA);

  // 第二设备:同账号新登录(新 DeviceSession),选同一主档案(T036/T052 同序)
  const secondLogin = await login(app, 'admin', 'password-123', { deviceName: '设备B' });
  expect(secondLogin.status).toBe(200);
  const cookieB = cookiePairOf(secondLogin);
  const unlockB = await request(app.getHttpServer())
    .post(`/api/profiles/${profileAId}/unlock`)
    .set('Cookie', cookieB)
    .send({ pin: MANAGEMENT_MAIN_PIN });
  if (unlockB.status !== 200 && unlockB.status !== 404) {
    throw new Error(`夹具错误:设备B 解锁主档案失败 ${unlockB.status} ${JSON.stringify(unlockB.body)}`);
  }
  const selectB = await request(app.getHttpServer())
    .post(`/api/profiles/${profileAId}/select`)
    .set('Cookie', cookieB)
    .send({});
  expect(selectB.status, '设备B 选主档案应 200').toBe(200);

  const householdId = householdIdOf();
  const sourceRowId = seedVodSourceRow(householdId, `${server.baseUrl}${source.apiPath}`);

  // 在线剧集物化(T031 真实装配链:搜索→预览→物化,产生 online playback_source)
  const ep01 = await materializeEpisodeAt(app, cookieA, 'stardust', 0, 0);
  const ep02 = await materializeEpisodeAt(app, cookieA, 'stardust', 0, 1);
  await materializeEpisodeAt(app, cookieA, 'stardust', 0, 2);

  return {
    fresh,
    app,
    householdId,
    server,
    cookieA,
    cookieB,
    profileAId,
    deviceSessionAId: deviceSessionIdOfToken(loggedIn.body.sessionToken as string),
    deviceSessionBId: deviceSessionIdOfToken(secondLogin.body.sessionToken as string),
    serial: {
      parentMediaId: ep01.parentMediaId,
      ep01MediaId: ep01.mediaId,
      ep02MediaId: ep02.mediaId,
      ep01DurationSeconds: 360,
    },
    sourceRowId,
  };
}

/* ------------------------------------------------------------------ */
/* DB 读/种子(工厂事实;逐处注明)                                        */
/* ------------------------------------------------------------------ */

function scalarOf(sql: string, ...params: unknown[]): number {
  const row = Database.db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

function sessionRowOf(sessionId: string): { state: string; generation: number } {
  const row = Database.db.prepare('SELECT state, generation FROM playback_session WHERE id = ?').get(sessionId) as
    | { state: string; generation: number }
    | undefined;
  expect(row, `夹具错误:playback_session ${sessionId} 不存在`).toBeDefined();
  return row!;
}

function sessionCleanupMarkerOf(sessionId: string): { requested: number; state: string | null } {
  const row = Database.db
    .prepare('SELECT cleanup_requested AS requested, cleanup_state AS state FROM playback_session WHERE id = ?')
    .get(sessionId) as { requested: number; state: string | null } | undefined;
  expect(row, `夹具错误:playback_session ${sessionId} 不存在`).toBeDefined();
  return row!;
}

interface SlotRow {
  readonly status: string;
  readonly slotRevision: number;
  readonly activeIntentId: string | null;
  readonly successorSessionId: string | null;
}

function slotRowOf(householdId: string, fromSessionId: string): SlotRow | undefined {
  return Database.db
    .prepare(
      `SELECT status, slot_revision AS slotRevision, active_intent_id AS activeIntentId,
              successor_session_id AS successorSessionId
       FROM playback_transition_slot WHERE household_id = ? AND from_session_id = ?`,
    )
    .get(householdId, fromSessionId) as SlotRow | undefined;
}

function intentStatusOf(householdId: string, intentId: string): string | undefined {
  const row = Database.db
    .prepare('SELECT status FROM playback_transition_intent WHERE household_id = ? AND id = ?')
    .get(householdId, intentId) as { status: string } | undefined;
  return row?.status;
}

function sourceLocatorRevisionOf(sourceRowId: string): number {
  const row = Database.db.prepare('SELECT locator_revision AS r FROM media_source WHERE id = ?').get(sourceRowId) as
    | { r: number }
    | undefined;
  expect(row, `夹具错误:media_source ${sourceRowId} 不存在`).toBeDefined();
  return row!.r;
}

function sourceVersionOf(sourceRowId: string): number {
  const row = Database.db.prepare('SELECT version AS v FROM media_source WHERE id = ?').get(sourceRowId) as
    | { v: number }
    | undefined;
  expect(row, `夹具错误:media_source ${sourceRowId} 不存在`).toBeDefined();
  return row!.v;
}

/** HTTP 启停源(PATCH /api/settings/sources/:id;T026 面「启停均 locator_revision+1 防 ABA」) */
async function setSourceEnabledViaHttp(
  rig: RevocationRig,
  enabled: boolean,
): Promise<void> {
  const res = await request(rig.app.getHttpServer())
    .patch(`/api/settings/sources/${rig.sourceRowId}`)
    .set('Cookie', rig.cookieA)
    .send({
      expectedVersion: sourceVersionOf(rig.sourceRowId),
      enabled,
    });
  expect(res.status, `夹具错误:启停源 PATCH(enabled=${enabled})应 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 160)})`).toBe(200);
}

function serialDetailRevisionOf(householdId: string, parentMediaId: string): number {
  const row = Database.db
    .prepare('SELECT current_detail_revision AS r FROM vod_title WHERE household_id = ? AND parent_media_id = ?')
    .get(householdId, parentMediaId) as { r: number } | undefined;
  expect(row, '夹具错误:vod_title 行不存在').toBeDefined();
  return row!.r;
}

/** DB 直改:禁源(media_source.enabled=0;源启停无直改语义场景外的 HTTP 依赖面;
 *  C2 的 ABA 面走真实 PATCH —— 此 helper 供禁源消费/清理叙事使用,不动 revision 列) */
function disableSource(sourceRowId: string): void {
  Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(sourceRowId);
}

/** DB 直改:设备会话身份上下文推进(等价 A→B→A 身份变化;T052 bumpDeviceContextVersion 同口径) */
function bumpDeviceContextVersion(deviceSessionId: string): void {
  Database.db
    .prepare('UPDATE device_session SET profile_context_version = profile_context_version + 1 WHERE id = ?')
    .run(deviceSessionId);
}

/** DB 直改:目标详情修订推进(等价「后台已发布新详情」,data-model §3;T052 同口径) */
function bumpSerialDetailRevision(householdId: string, parentMediaId: string): void {
  const bumped = Database.db
    .prepare(
      'UPDATE vod_title SET current_detail_revision = current_detail_revision + 1 WHERE household_id = ? AND parent_media_id = ?',
    )
    .run(householdId, parentMediaId);
  expect(bumped.changes, '夹具错误:vod_title 行不存在(序列详情推进失败)').toBe(1);
}

/** DB 直改:目标详情修订回滚到指定值(D 组「过期后恢复修订」素材;精确还原快照对齐) */
function setSerialDetailRevision(householdId: string, parentMediaId: string, value: number): void {
  const set = Database.db
    .prepare('UPDATE vod_title SET current_detail_revision = ? WHERE household_id = ? AND parent_media_id = ?')
    .run(value, householdId, parentMediaId);
  expect(set.changes, '夹具错误:vod_title 行不存在(序列详情回滚失败)').toBe(1);
}

/**
 * DB 直改:意图 TTL 自然到期的等价存储事实(成对置过去保持 CHECK expires_at >
 * created_at;T052 D4 同口径)。
 */
function expireTransitionIntent(householdId: string, intentId: string): void {
  Database.db
    .prepare(
      "UPDATE playback_transition_intent SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:01:00.000Z' WHERE household_id = ? AND id = ?",
    )
    .run(householdId, intentId);
}

/**
 * DB 直改:cleanup 崩溃窗口标记(工厂事实;等价 I5「标记先阻止新票/资产,网络和进程
 * 取消在 commit 后执行」的持久中间态 —— 标记事务已提交、提交后幂等空 stop 未落定。
 * 列值与 markDeliveryCleanupRequested 提交面同形:requested=1/reason/state='pending',
 * 满足 listActiveSessionsRequestingCleanup 扫描谓词)。
 */
function seedCleanupRequestedMarker(sessionId: string): void {
  const updated = Database.db
    .prepare(
      "UPDATE playback_session SET cleanup_requested = 1, cleanup_reason = 'transition_cleanup', cleanup_state = 'pending' WHERE id = ?",
    )
    .run(sessionId);
  expect(updated.changes, '夹具错误:cleanup 标记种子失败(会话行不存在)').toBe(1);
}

/**
 * 种子:finish receipt(工厂事实;等价 T058「finish 已提交且 autoNextEligible=true」
 * 形态 —— B2 偏好复验的 next 资格素材;字段满足 0007 CHECK/FK,T052 同款)。
 */
function seedAutoNextFinishReceipt(input: {
  readonly householdId: string;
  readonly sourceSessionId: string;
  readonly durationSeconds: number;
}): void {
  const session = Database.db
    .prepare(
      `SELECT device_session_id AS deviceSessionId, profile_context_version AS profileContextVersion,
              generation, media_id AS mediaId
       FROM playback_session WHERE id = ?`,
    )
    .get(input.sourceSessionId) as
    | { deviceSessionId: string; profileContextVersion: number; generation: number; mediaId: string }
    | undefined;
  expect(session, '夹具错误:来源会话行不存在(receipt 种子失败)').toBeDefined();
  getDb()
    .insert(playbackFinishReceipt)
    .values({
      householdId: input.householdId,
      sessionId: input.sourceSessionId,
      deviceSessionId: session!.deviceSessionId,
      profileContextVersion: session!.profileContextVersion,
      generation: session!.generation,
      operationKey: randomUUID(),
      requestDigest: `fixture-finish-${randomUUID()}`,
      finalSeq: 2,
      finalSessionAccepted: 1,
      historyApplied: 0,
      historyRevision: null,
      sessionCompleted: 1,
      autoNextEligible: 1,
      reason: 'completed',
      positionSeconds: Math.max(1, input.durationSeconds - 5),
      durationSeconds: input.durationSeconds,
      endedAt: new Date().toISOString(),
      contentRevision: mediaContentRevisionOf(session!.mediaId),
      continuityRevision: 1,
      locatorRevision: 1,
    })
    .run();
}

/* ------------------------------------------------------------------ */
/* HTTP 助手                                                            */
/* ------------------------------------------------------------------ */

function postNextPlan(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(NEXT_PLANS_URL).set('Cookie', cookie).send(body);
}

function postIntent(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(INTENTS_URL).set('Cookie', cookie).send(body);
}

function getIntent(app: INestApplication, cookie: string, intentId: string): request.Test {
  return request(app.getHttpServer()).get(`${INTENTS_URL}/${intentId}`).set('Cookie', cookie);
}

function postCancel(app: INestApplication, cookie: string, intentId: string): request.Test {
  return request(app.getHttpServer()).post(`${INTENTS_URL}/${intentId}/cancel`).set('Cookie', cookie).send({});
}

function postCleanup(app: INestApplication, cookie: string, intentId: string): request.Test {
  return request(app.getHttpServer()).post(`${INTENTS_URL}/${intentId}/cleanup`).set('Cookie', cookie).send({});
}

function postResolve(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(RESOLVE_URL).set('Cookie', cookie).send(body);
}

function postStop(app: INestApplication, cookie: string, sessionId: string): request.Test {
  return request(app.getHttpServer()).post(`/api/playback/sessions/${sessionId}/stop`).set('Cookie', cookie).send({});
}

function postRenew(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  expectedGeneration: number,
): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${sessionId}/renew`)
    .set('Cookie', cookie)
    .send({ expectedGeneration });
}

function postSeek(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  expectedVersion: number,
): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${sessionId}/seek`)
    .set('Cookie', cookie)
    .send({ expectedVersion, positionSeconds: 30 });
}

function getStatus(app: INestApplication, cookie: string, sessionId: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${sessionId}`).set('Cookie', cookie);
}

/** 轮询等待会话进入指定状态(在线 hls 候选 probe 免 ffprobe 即时成功,T052 rig 同款) */
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

/* ------------------------------------------------------------------ */
/* 链式编排(真实 HTTP 全链;无 intent/slot 行种子)                        */
/* ------------------------------------------------------------------ */

interface SourceSession {
  readonly sessionId: string;
  readonly generation: number;
}

/** 真实 resolve 源会话并等 ready(活动形态;T031 已装配,绿基线) */
async function resolveSourceSession(
  rig: RevocationRig,
  options: { cookie?: string; mediaId?: string } = {},
): Promise<SourceSession> {
  const cookie = options.cookie ?? rig.cookieA;
  const res = await postResolve(rig.app, cookie, { mediaId: options.mediaId ?? rig.serial.ep01MediaId });
  expect(res.status, '夹具错误:源会话 resolve 应 201(T036 已装配)').toBe(201);
  const sessionId = String(res.headers['location']).split('/').pop() ?? '';
  await waitUntilState(rig.app, cookie, sessionId, 'ready');
  return { sessionId, generation: sessionRowOf(sessionId).generation };
}

/** 服务端先停止来源会话(消费前置「先停止再消费」/next「已结束来源」) */
async function stopSourceSession(rig: RevocationRig, source: SourceSession, cookie?: string): Promise<void> {
  const res = await postStop(rig.app, cookie ?? rig.cookieA, source.sessionId);
  expect(res.status, '夹具错误:来源会话 stop 应 204(既有 005 语义)').toBe(204);
  expect(sessionRowOf(source.sessionId).state, '夹具错误:stop 后来源会话应为终态 ended').toBe('ended');
}

/** 创建下一集计划(断言 200 NextPlanReply;T055+T060 已装配绿面) */
async function createNextPlanOk(
  rig: RevocationRig,
  sourceSessionId: string,
  options: { action?: 'next' | 'manual_next'; cookie?: string } = {},
): Promise<NextPlanSnapshot> {
  const res = await postNextPlan(rig.app, options.cookie ?? rig.cookieA, {
    fromSessionId: sourceSessionId,
    expectedGeneration: sessionRowOf(sourceSessionId).generation,
    action: options.action ?? 'manual_next',
  });
  expect(res.status, `夹具错误:计划创建应 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 160)})`).toBe(200);
  return res.body as NextPlanSnapshot;
}

/** 创建 pending intent(断言 201 IntentReply;T059+T060 已装配绿面) */
async function createIntentOk(
  rig: RevocationRig,
  input: {
    readonly source: SourceSession;
    readonly plan: NextPlanSnapshot;
    readonly action: 'next' | 'manual_next';
    readonly positionMode: 'beginning' | 'target_history';
    readonly cookie?: string;
  },
): Promise<IntentSnapshot> {
  const res = await postIntent(rig.app, input.cookie ?? rig.cookieA, {
    fromSessionId: input.source.sessionId,
    expectedGeneration: input.source.generation,
    action: input.action,
    nextPlanRef: input.plan.nextPlanRef,
    positionMode: input.positionMode,
    expectedSlotRevision: 0,
    operationKey: randomUUID(),
  });
  expect(res.status, `夹具错误:intent 创建应 201(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 160)})`).toBe(201);
  return res.body as IntentSnapshot;
}

interface PendingChain {
  readonly source: SourceSession;
  readonly plan: NextPlanSnapshot;
  readonly intent: IntentSnapshot;
}

/** 全链:resolve 源会话 → 计划 → pending intent(manual_next/beginning 缺省) */
async function createPendingChain(
  rig: RevocationRig,
  options: { action?: 'next' | 'manual_next'; cookie?: string } = {},
): Promise<PendingChain> {
  const cookie = options.cookie ?? rig.cookieA;
  const source = await resolveSourceSession(rig, { cookie });
  const action = options.action ?? 'manual_next';
  const plan = await createNextPlanOk(rig, source.sessionId, { action, cookie });
  const intent = await createIntentOk(rig, { source, plan, action, positionMode: 'beginning', cookie });
  return { source, plan, intent };
}

/** 消费 intent(前置:来源已停止)→ 201 + 后继会话 id */
async function consumeIntentOk(rig: RevocationRig, chain: PendingChain): Promise<string> {
  const res = await postResolve(rig.app, rig.cookieA, {
    mediaId: rig.serial.ep02MediaId,
    transitionIntentId: chain.intent.id,
  });
  expect(res.status, `夹具错误:消费应 201(T061 已装配;实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(201);
  const successorId = String(res.headers['location']).split('/').pop() ?? '';
  expect(successorId, '夹具错误:消费响应应携带后继 Location').not.toBe('');
  expect(intentStatusOf(rig.householdId, chain.intent.id), '夹具错误:消费后 intent 应 consumed').toBe('consumed');
  return successorId;
}

/** 消费 + 等后继 ready(活动后继形态;watchdog/renew/资产面素材) */
async function consumeAndReady(rig: RevocationRig, chain: PendingChain): Promise<string> {
  const successorId = await consumeIntentOk(rig, chain);
  await waitUntilState(rig.app, rig.cookieA, successorId, 'ready');
  return successorId;
}

/** Settings 名单精确 block/unblock 指定媒体(A2 目标/来源失权轴;T052 A7 同手法) */
async function setProfileBlockedMedia(
  app: INestApplication,
  cookie: string,
  profileId: string,
  blockedMediaIds: readonly string[],
): Promise<void> {
  const policyUrl = `/api/settings/profiles/${profileId}/policy`;
  const got = await request(app.getHttpServer()).get(policyUrl).set('Cookie', cookie);
  expect(got.status, `夹具错误:读取策略应 200(实际 ${got.status})`).toBe(200);
  const put = await request(app.getHttpServer())
    .put(`${policyUrl}/lists`)
    .set('Cookie', cookie)
    .send({
      expectedVersion: (got.body as { version: number }).version,
      allowedMediaIds: [],
      blockedMediaIds: [...blockedMediaIds],
      allowedChannelIds: [],
    });
  expect(put.status, `夹具错误:写策略名单应 200(实际 ${put.status} ${JSON.stringify(put.body).slice(0, 160)})`).toBe(200);
}

/** 新建档案(Settings;须在 context 推进前调用 —— Settings 授予校验当前 contextVersion) */
async function createProfileViaSettingsOk(
  app: INestApplication,
  settingsCookie: string,
  name: string,
  type: 'adult' | 'child',
): Promise<string> {
  const created = await createProfileViaSettings(app, settingsCookie, { name, type });
  expect(created.status, `夹具错误:创建档案应 201(实际 ${JSON.stringify(created.body).slice(0, 160)})`).toBe(201);
  return (created.body as { id: string }).id;
}

/** 切换指定设备会话到指定档案(身份漂移素材;切档同事务递增 contextVersion 并终态化旧上下文播放) */
async function selectProfileOn(
  app: INestApplication,
  selectCookie: string,
  profileId: string,
): Promise<void> {
  const select = await request(app.getHttpServer())
    .post(`/api/profiles/${profileId}/select`)
    .set('Cookie', selectCookie)
    .send({});
  expect(select.status, `夹具错误:切换档案应 200(实际 ${JSON.stringify(select.body).slice(0, 160)})`).toBe(200);
}

/** 新建档案并切换指定设备会话到该档案(B1 跨 Profile 身份漂移素材;T052 H2 同序) */
async function createProfileAndSelect(
  app: INestApplication,
  settingsCookie: string,
  selectCookie: string,
  name: string,
  type: 'adult' | 'child',
): Promise<string> {
  const profileId = await createProfileViaSettingsOk(app, settingsCookie, name, type);
  await selectProfileOn(app, selectCookie, profileId);
  return profileId;
}

/* ------------------------------------------------------------------ */
/* 通用 afterEach                                                       */
/* ------------------------------------------------------------------ */

afterEach(async () => {
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* A 每步旧上下文同形拒绝(创建/GET 重放/cancel/cleanup 四面 + 失权 GET)    */
/* ------------------------------------------------------------------ */

describe('T078 · A 每步旧上下文同形拒绝(api §0/§5/§7 I5;跨设备/跨 Profile/旧 context/随机 id 404 同形)', () => {
  it('A1 创建面四面同形 404:跨设备/随机 id/旧 contextVersion/跨 Profile → 404 PLAYBACK_NOT_FOUND 同形,零 intent/slot 写入', async () => {
    const rig = await startRevocationRig('hmp-t078-a1-');
    const chain = await createPendingChain(rig);
    const intentBody = {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    };
    const baselineIntents = scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId);
    const baselineSlots = scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId);
    // 档案B 提前创建(Settings 授予校验当前 contextVersion;切换留到跨 Profile 面执行)
    const profileBId = await createProfileViaSettingsOk(rig.app, rig.cookieA, '档案B', 'adult');
    // 面一:跨设备(设备B 以设备A 的来源会话/计划建意图 → 来源只读上下文授权失配)
    const crossDevice = await postIntent(rig.app, rig.cookieB, intentBody);
    // 面二:随机 id(与跨设备必须同形,不可判别存在性)
    const randomId = await postIntent(rig.app, rig.cookieA, { ...intentBody, fromSessionId: randomUUID() });
    // 面三:旧 contextVersion(DB 直改注明:设备A 身份上下文推进,等价 A→B→A;
    //        intent 归属三键之一 contextVersion 失配 → 404)
    bumpDeviceContextVersion(rig.deviceSessionAId);
    const oldContext = await postIntent(rig.app, rig.cookieA, { ...intentBody, operationKey: randomUUID() });
    // 面四:跨 Profile(设备A 切到档案B → 身份推导漂移:identity.profileId ≠ 来源
    //        会话 profileId;切档同事务已再递增 contextVersion,漂移双重成立)
    await selectProfileOn(rig.app, rig.cookieA, profileBId);
    const crossProfile = await postIntent(rig.app, rig.cookieA, { ...intentBody, operationKey: randomUUID() });
    // 四面全部 404 同形(PLAYBACK_NOT_FOUND),不可借错误判别来源会话存在性
    for (const face of [crossDevice, randomId, oldContext, crossProfile]) {
      expectProblem(face, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    }
    expectSameShape(crossDevice, randomId, '跨设备与随机 id 创建必须同形 404');
    expectSameShape(crossDevice, oldContext, '跨设备与旧 context 创建必须同形 404');
    expectSameShape(crossDevice, crossProfile, '跨设备与跨 Profile 创建必须同形 404');
    // 拒绝路径零写入:不落 intent、不占槽(仅链首合法创建的 1+1)
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      '四面拒绝不得落新 intent',
    ).toBe(baselineIntents);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId),
      '四面拒绝不得占新槽',
    ).toBe(baselineSlots);
  });

  it('A2 GET 重放面:四面同形 404 不泄漏;目标失权/来源失权/禁源 → 404 MEDIA_NOT_FOUND 不返回完整结果;失权后 cleanup 仅清理仍可用', async () => {
    const rig = await startRevocationRig('hmp-t078-a2-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeIntentOk(rig, chain);
    const secrets = [successorId, rig.serial.ep02MediaId] as const;
    // 基线:归属内 GET 重放 → 200 完整 IntentReply(consumed 含 successor;T061 绿面)
    const owned = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect(owned.status, '归属内 GET 重放应 200 完整结果').toBe(200);
    expect(Object.keys(owned.body).sort()).toEqual([...INTENT_REPLY_KEYS]);
    expect((owned.body as IntentSnapshot).status).toBe('consumed');
    expect((owned.body as IntentSnapshot).successorSessionId).toBe(successorId);
    // 目标失权轴(名单精确 block 目标 EP02;Settings HTTP 面):完整 IntentReply 要求
    // 当前源/目标权限 → 404 MEDIA_NOT_FOUND,不返回完整结果、不借 GET 发票
    // (api §5 GET 行;客户端应转 cleanup)
    await setProfileBlockedMedia(rig.app, rig.cookieA, rig.profileAId, [rig.serial.ep02MediaId]);
    const targetRevoked = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expectProblem(targetRevoked, 404, ProblemCode.MEDIA_NOT_FOUND);
    expectNoLeak(targetRevoked, secrets, '目标失权 GET');
    await setProfileBlockedMedia(rig.app, rig.cookieA, rig.profileAId, []);
    // 来源失权轴(名单精确 block 来源 EP01,目标 EP02 恢复可见 → 404 判定锚定来源轴):
    // 授权逐轴判定,任一失权即不返回完整结果
    await setProfileBlockedMedia(rig.app, rig.cookieA, rig.profileAId, [rig.serial.ep01MediaId]);
    const sourceRevoked = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expectProblem(sourceRevoked, 404, ProblemCode.MEDIA_NOT_FOUND);
    expectNoLeak(sourceRevoked, secrets, '来源失权 GET');
    expectSameShape(targetRevoked, sourceRevoked, '目标失权与来源失权 GET 必须同形 404');
    await setProfileBlockedMedia(rig.app, rig.cookieA, rig.profileAId, []);
    const restored = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect(restored.status, '失权轴恢复后 GET 重放应回到 200 完整结果(失权是即时态,非身份失效)').toBe(200);
    // 源禁用轴(enabled=0)→ 404 MEDIA_NOT_FOUND;失权不阻断最小清理:cleanup 不要求
    // 源/目标策略放行(I5),仅返回 outcome,不泄漏目标
    disableSource(rig.sourceRowId);
    const disabledRevoked = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expectProblem(disabledRevoked, 404, ProblemCode.MEDIA_NOT_FOUND);
    expectNoLeak(disabledRevoked, secrets, '禁源 GET');
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status, '禁源但同 context 的 cleanup 应 200(I5 不要求策略放行)').toBe(200);
    expect(Object.keys(cleanup.body).sort()).toEqual([...CLEANUP_REPLY_KEYS]);
    expect(['cleanup_pending', 'stopped'], `consumed 分支 outcome ∈ cleanup_pending|stopped(实际 ${String(cleanup.body.outcome)})`).toContain(
      cleanup.body.outcome,
    );
    expectNoLeak(cleanup, secrets, '禁源 cleanup 最小回执');
    expect(sessionCleanupMarkerOf(successorId).requested, 'cleanup 应为后继写持久 cleanup_requested').toBe(1);
    // 四面(跨设备/随机/旧 context/跨 Profile)→ 404 同形,不泄漏目标/后继标识
    // (档案B 在 context 推进前创建 —— Settings 授予校验当前 contextVersion)
    const profileBId = await createProfileViaSettingsOk(rig.app, rig.cookieA, '档案B', 'adult');
    const crossDevice = await getIntent(rig.app, rig.cookieB, chain.intent.id);
    const randomId = await getIntent(rig.app, rig.cookieA, randomUUID());
    bumpDeviceContextVersion(rig.deviceSessionAId);
    const oldContext = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    await selectProfileOn(rig.app, rig.cookieB, profileBId);
    const crossProfile = await getIntent(rig.app, rig.cookieB, chain.intent.id);
    for (const face of [crossDevice, randomId, oldContext, crossProfile]) {
      expectProblem(face, 404, ProblemCode.PLAYBACK_NOT_FOUND);
      expectNoLeak(face, secrets, 'GET 四面 404');
    }
    expectSameShape(crossDevice, randomId, '跨设备与随机 id GET 必须同形 404');
    expectSameShape(crossDevice, oldContext, '跨设备与旧 context GET 必须同形 404');
    expectSameShape(crossDevice, crossProfile, '跨设备与跨 Profile GET 必须同形 404');
  });

  it('A3 cancel 面四面同形 404:跨设备/随机/旧 context/跨 Profile → 404 同形,槽与 intent 零扰动', async () => {
    const rig = await startRevocationRig('hmp-t078-a3-');
    const chain = await createPendingChain(rig);
    const profileBId = await createProfileViaSettingsOk(rig.app, rig.cookieA, '档案B', 'adult');
    const crossDevice = await postCancel(rig.app, rig.cookieB, chain.intent.id);
    const randomId = await postCancel(rig.app, rig.cookieA, randomUUID());
    bumpDeviceContextVersion(rig.deviceSessionAId);
    const oldContext = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    await selectProfileOn(rig.app, rig.cookieA, profileBId);
    const crossProfile = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    for (const face of [crossDevice, randomId, oldContext, crossProfile]) {
      expectProblem(face, 404, ProblemCode.PLAYBACK_NOT_FOUND);
      expectNoLeak(face, [rig.serial.ep02MediaId], 'cancel 四面 404');
    }
    expectSameShape(crossDevice, randomId, '跨设备与随机 id cancel 必须同形 404');
    expectSameShape(crossDevice, oldContext, '跨设备与旧 context cancel 必须同形 404');
    expectSameShape(crossDevice, crossProfile, '跨设备与跨 Profile cancel 必须同形 404');
    // 拒绝路径零扰动:槽保持 reserved、intent 保持 pending(取消仅授权内可达,T052 D1)
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status, '四面 404 不得释放槽').toBe('reserved');
    expect(slot?.slotRevision, '四面 404 不得 bump 槽 revision').toBe(chain.intent.slotRevision);
    expect(slot?.activeIntentId).toBe(chain.intent.id);
    expect(intentStatusOf(rig.householdId, chain.intent.id), '四面 404 不得翻转 intent 状态').toBe('pending');
  });

  it('A4 cleanup 面四面同形 404 + context 变更后禁止调用:跨设备/随机/跨 Profile/旧 context → 404 同形,I5 撤销面兜底', async () => {
    const rig = await startRevocationRig('hmp-t078-a4-');
    const chain = await createPendingChain(rig);
    const profileBId = await createProfileViaSettingsOk(rig.app, rig.cookieA, '档案B', 'adult');
    const crossDevice = await postCleanup(rig.app, rig.cookieB, chain.intent.id);
    const randomId = await postCleanup(rig.app, rig.cookieA, randomUUID());
    await selectProfileOn(rig.app, rig.cookieB, profileBId);
    const crossProfile = await postCleanup(rig.app, rig.cookieB, chain.intent.id);
    for (const face of [crossDevice, randomId, crossProfile]) {
      expectProblem(face, 404, ProblemCode.PLAYBACK_NOT_FOUND);
      expectNoLeak(face, [rig.serial.ep02MediaId], 'cleanup 四面 404');
    }
    expectSameShape(crossDevice, randomId, '跨设备与随机 id cleanup 必须同形 404');
    expectSameShape(crossDevice, crossProfile, '跨设备与跨 Profile cleanup 必须同形 404');
    // context 变更后(I5「context 变更后禁止调用,由撤销处理与持久 cleanup 扫描负责」):
    // DB 直改注明:设备A 身份上下文推进 → 原归属 contextVersion 失配 → 归属内调用亦 404
    bumpDeviceContextVersion(rig.deviceSessionAId);
    const oldContext = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    const oldContextGet = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expectProblem(oldContext, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectProblem(oldContextGet, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectSameShape(crossDevice, oldContext, '跨设备与旧 context cleanup 必须同形 404');
    // 失败 cleanup 零副作用:intent 保持 pending、槽保持 reserved(清理责任移交撤销面/
    // 持久扫描,不由失权调用方触发);不产生后继会话
    expect(intentStatusOf(rig.householdId, chain.intent.id), '失权 cleanup 不得翻转 intent').toBe('pending');
    expect(slotRowOf(rig.householdId, chain.source.sessionId)?.status, '失权 cleanup 不得释放槽').toBe('reserved');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '失权 cleanup 不得建后继',
    ).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* B 更换 Profile/偏好关闭后不能消费(api §0 身份推导;T052 E 组复验)       */
/* ------------------------------------------------------------------ */

describe('T078 · B 更换 Profile/偏好关闭后不能消费(api §0 身份只从服务端推导;FR-035 消费时重验)', () => {
  it('B1 intent 创建后切换当前 Profile → resolve/GET/cancel/cleanup 全 404 同形(身份推导漂移);切档终态化旧上下文播放,零后继', async () => {
    const rig = await startRevocationRig('hmp-t078-b1-');
    const chain = await createPendingChain(rig);
    expect(sessionRowOf(chain.source.sessionId).state, '夹具前提:来源会话活动').toBe('ready');
    // 设备A 切到新建档案B(切档同事务:递增 contextVersion + 终态化旧上下文活动播放)
    await createProfileAndSelect(rig.app, rig.cookieA, rig.cookieA, '档案B', 'adult');
    expect(
      sessionRowOf(chain.source.sessionId).state,
      '切档应终态化旧上下文活动播放(profile-store finalizePlaybackForIdentityChange → interrupted)',
    ).toBe('interrupted');
    // 消费:身份推导漂移 → 404 同形(与随机 id 不可判别;不泄漏目标)
    const consume = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    const randomConsume = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: randomUUID(),
    });
    expectProblem(consume, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    expectNoLeak(consume, [rig.serial.ep02MediaId], '跨 Profile 消费 404');
    expectSameShape(consume, randomConsume, '跨 Profile 消费与随机 id 消费必须同形 404');
    // 查询/取消/清理同四面漂移 → 404 同形(I5 跨 Profile 均不可用)
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    for (const face of [got, cancel, cleanup]) {
      expectProblem(face, 404, ProblemCode.PLAYBACK_NOT_FOUND);
    }
    expectSameShape(consume, got, '跨 Profile 消费与 GET 必须同形 404');
    expectSameShape(consume, cancel, '跨 Profile 消费与 cancel 必须同形 404');
    expectSameShape(consume, cleanup, '跨 Profile 消费与 cleanup 必须同形 404');
    // 零写入:intent 保持 pending(原归属)、无后继会话
    expect(intentStatusOf(rig.householdId, chain.intent.id), '身份漂移不得翻转 intent').toBe('pending');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '身份漂移消费不得建后继',
    ).toBe(0);
  });

  it('B2 偏好关闭后不能消费(复验 T052 E 组不劣化):autoplayNext=false → 消费 409 NEXT_PLAN_CHANGED,intent 保持 pending', async () => {
    const rig = await startRevocationRig('hmp-t078-b2-');
    const source = await resolveSourceSession(rig);
    await stopSourceSession(rig, source);
    // DB 直改注明:等价 T058 finish 已提交且 autoNextEligible=true(next 资格素材)
    seedAutoNextFinishReceipt({
      householdId: rig.householdId,
      sourceSessionId: source.sessionId,
      durationSeconds: rig.serial.ep01DurationSeconds,
    });
    const plan = await createNextPlanOk(rig, source.sessionId, { action: 'next' });
    const intent = await createIntentOk(rig, { source, plan, action: 'next', positionMode: 'beginning' });
    // 偏好关闭(T056 PATCH;T052 E1 同序)
    const prefsGet = await request(rig.app.getHttpServer()).get('/api/me/vod/preferences').set('Cookie', rig.cookieA);
    expect(prefsGet.status, '夹具错误:偏好 GET 应 200').toBe(200);
    const patchOff = await request(rig.app.getHttpServer())
      .patch('/api/me/vod/preferences')
      .set('Cookie', rig.cookieA)
      .send({ expectedVersion: (prefsGet.body as { version: number }).version, autoplayNext: false, operationKey: randomUUID() });
    expect(patchOff.status, '夹具错误:偏好 PATCH 应 200').toBe(200);
    // 消费时重读偏好(FR-035;创建后关闭 → 消费拒绝,不静默消费)
    const denied = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: intent.id,
    });
    expectProblem(denied, 409, 'NEXT_PLAN_CHANGED');
    expect(intentStatusOf(rig.householdId, intent.id), '偏好拒绝不消耗 intent').toBe('pending');
    expect(slotRowOf(rig.householdId, source.sessionId)?.status, '偏好拒绝不消耗槽').toBe('reserved');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '偏好拒绝不建后继',
    ).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* C 禁源 ABA(§0 授权族优先;data-model §2 locator_revision 防ABA/§3 修订失配) */
/* ------------------------------------------------------------------ */

describe('T078 · C 禁源 ABA(api §6 授权族优先;data-model §2 启停均 locator_revision+1 防 ABA)', () => {
  it('C1 禁源后 intent 消费 → 404 授权族优先(非 409 SOURCE_NOT_TERMINAL);intent/槽零扰动;cleanup 禁源但同 context 仅清理', async () => {
    const rig = await startRevocationRig('hmp-t078-c1-');
    const chain = await createPendingChain(rig);
    // 来源保持活动(未 stop)→ 若授权不优先,消费将落 409 SOURCE_NOT_TERMINAL;
    // 禁源后必须以授权族 404 优先拒绝(api §6「来源/上下文授权失败优先于专用错误」)
    expect(sessionRowOf(chain.source.sessionId).state, '夹具前提:来源会话活动').toBe('ready');
    disableSource(rig.sourceRowId);
    const consume = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expectProblem(consume, 404, ProblemCode.MEDIA_NOT_FOUND);
    expectNoLeak(consume, [rig.serial.ep02MediaId], '禁源消费 404');
    // GET 失权同形 404(完整结果要求当前源权限;T062 失权面复验)
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expectProblem(got, 404, ProblemCode.MEDIA_NOT_FOUND);
    // 拒绝路径零扰动:intent pending、槽 reserved、零后继
    expect(intentStatusOf(rig.householdId, chain.intent.id), '禁源消费拒绝不消耗 intent').toBe('pending');
    expect(slotRowOf(rig.householdId, chain.source.sessionId)?.status, '禁源消费拒绝不消耗槽').toBe('reserved');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '禁源消费拒绝不建后继',
    ).toBe(0);
    // 禁源但同 context 仅清理:cleanup 不要求策略放行(I5)→ pending 分支取消/释放槽
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status, '禁源但同 context 的 cleanup 应 200(不要求策略放行)').toBe(200);
    expect(cleanup.body).toEqual({ outcome: 'cancelled' });
    expect(intentStatusOf(rig.householdId, chain.intent.id)).toBe('cancelled');
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status, 'cleanup pending 分支应释放槽').toBe('open');
    expect(slot?.slotRevision, '释放槽 revision+1(T052 G2 同口径)').toBe(chain.intent.slotRevision + 1);
    // cleanup 重试幂等:already_cancelled(终态分支,不再变化)
    const retry = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ outcome: 'already_cancelled' });
  });

  it('C2 禁源→复源(ABA)locator_revision 已变 → 旧绑定续播拒绝(renew 503+会话 failed,需新 resolve);已消费重放不复活、新授权 resolve 唯一回头路', async () => {
    const rig = await startRevocationRig('hmp-t078-c2-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeAndReady(rig, chain);
    // 基线:活动后继 renew 200(有效会话面;票据签发)
    const generation = sessionRowOf(successorId).generation;
    const renewOk = await postRenew(rig.app, rig.cookieA, successorId, generation);
    expect(renewOk.status, '夹具错误:活动后继 renew 应 200').toBe(200);
    const locatorBase = sourceLocatorRevisionOf(rig.sourceRowId);
    // 禁源期间续播:授权族 404 优先(候选收集零启用源 → MEDIA_NOT_FOUND;会话不翻转;
    // 启停走真实 T026 PATCH 面 —— 「启停均 locator_revision+1 防 ABA」)
    await setSourceEnabledViaHttp(rig, false);
    expect(sourceLocatorRevisionOf(rig.sourceRowId), '禁源应 locator_revision+1(T026 面)').toBe(locatorBase + 1);
    const renewDisabled = await postRenew(rig.app, rig.cookieA, successorId, generation);
    expectProblem(renewDisabled, 404, ProblemCode.MEDIA_NOT_FOUND);
    expect(sessionRowOf(successorId).state, '禁源 renew 拒绝不翻转会话状态').toBe('ready');
    // 复源(ABA):enabled 恢复但 locator_revision 已推进(启停均+1,data-model §2)
    await setSourceEnabledViaHttp(rig, true);
    expect(
      sourceLocatorRevisionOf(rig.sourceRowId),
      'ABA 后 locator_revision 应推进(禁源+1、复源+1)',
    ).toBe(locatorBase + 2);
    // ABA 续播拒绝:renew 固定输入重验 → 绑定冻结 locator_revision 与当前失配 →
    // 撤交付 + 会话 failed 同提交(data-model §3「拒绝新交付,准备转 failed,需新 resolve」;
    // 注册稳定码 503 PLAYBACK_RESOURCE_UNAVAILABLE,失败标注 →T081 收口)
    const renewAba = await postRenew(rig.app, rig.cookieA, successorId, generation);
    expectStableRejection(renewAba, 503, 'PLAYBACK_RESOURCE_UNAVAILABLE', 'ABA 后 renew 必须拒绝旧绑定续播(→T081)');
    expect(sessionRowOf(successorId).state, 'ABA 修订失配应将会话转 failed(需新 resolve)').toBe('failed');
    // 已消费重放不复活:200 同后继当前真实状态(failed),不重建、不再次消费造新播放
    const replay = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(replay.status, '已消费重放应 200 同后继(终态也返回当前状态,不复活)').toBe(200);
    expect(String(replay.headers['location']).split('/').pop()).toBe(successorId);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '重放不得新建第二后继',
    ).toBe(1);
    // 唯一回头路 = 新授权 resolve(全新绑定取当前 locator_revision)
    const fresh = await postResolve(rig.app, rig.cookieA, { mediaId: rig.serial.ep01MediaId });
    expect(fresh.status, '复源后新 resolve 应 201(新授权新绑定;需新 resolve 的合法出路)').toBe(201);
  });
});

/* ------------------------------------------------------------------ */
/* D 目标修订/过期不复活(T052 A/C 组已钉消费重验 —— 此处钉过期后修订恢复不复活) */
/* ------------------------------------------------------------------ */

describe('T078 · D 目标修订与过期不复活(api §5/§6 TRANSITION_EXPIRED/NEXT_PLAN_CHANGED;T052 C5 复验不劣化)', () => {
  it('D1 详情推进消费 409 NEXT_PLAN_CHANGED(复验);intent 过期 410 后即使修订回滚也不复活(GET/消费仍 410,cancel=expired,槽释放,零后继)', async () => {
    const rig = await startRevocationRig('hmp-t078-d1-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    // 复验面(T052 C5 同形):目标详情修订推进 → 消费 409 NEXT_PLAN_CHANGED,不消耗槽
    const detailBefore = serialDetailRevisionOf(rig.householdId, rig.serial.parentMediaId);
    bumpSerialDetailRevision(rig.householdId, rig.serial.parentMediaId);
    const staleDetail = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expectProblem(staleDetail, 409, 'NEXT_PLAN_CHANGED');
    expect(intentStatusOf(rig.householdId, chain.intent.id), '计划变化拒绝后 intent 保持 pending').toBe('pending');
    // 过期(DB 直改注明:TTL 60s 自然到期等价存储事实,成对置过去保持 CHECK)
    expireTransitionIntent(rig.householdId, chain.intent.id);
    const expiredConsume = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expectProblem(expiredConsume, 410, 'TRANSITION_EXPIRED');
    // 修订回滚(恢复到快照值)→ 计划快照重新对齐,但过期意图不复活:
    // 「过期未消费 410,不误作可重新消费」与快照状态正交
    setSerialDetailRevision(rig.householdId, rig.serial.parentMediaId, detailBefore);
    const rolledBackConsume = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expectProblem(rolledBackConsume, 410, 'TRANSITION_EXPIRED');
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expectProblem(got, 410, 'TRANSITION_EXPIRED');
    // cancel → outcome expired + 槽释放 open(T052 D4 已钉 outcome/successor;此处钉
    // 「回滚后仍 expired」;slotRevision=释放后 revision —— store releaseSlotTx 返回
    // 释放后的槽 revision,过期取消同样走释放路径)
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancel.status).toBe(200);
    expect(Object.keys(cancel.body).sort()).toEqual([...CANCEL_REPLY_KEYS]);
    expect(cancel.body).toEqual({ outcome: 'expired', successorSessionId: null, slotRevision: 2 });
    expect(slotRowOf(rig.householdId, chain.source.sessionId)?.status, '过期取消释放槽').toBe('open');
    // 终态意图不可再用:expired 取消后消费 → 409 TRANSITION_SLOT_CONFLICT
    const afterCancel = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expectProblem(afterCancel, 409, 'TRANSITION_SLOT_CONFLICT');
    // 全程零后继:计划变化/过期/回滚/取消各路径均不建播放
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      'D1 全路径不得建后继',
    ).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* E 已消费后继:cancel 输家追查幂等 / watchdog 回收不复活                  */
/* ------------------------------------------------------------------ */

describe('T078 · E 已消费后继(api §5 cancel successor/§7 watchdog;T052 D5 复验+T081 收口面)', () => {
  it('E1 cancel 输家返回 successor(复验 D5)+重复 cancel 追查幂等;successor stop 后 renew 终态拒绝、重放 200 同后继、cleanup=stopped 幂等', async () => {
    const rig = await startRevocationRig('hmp-t078-e1-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeIntentOk(rig, chain);
    // 取消输给消费:already_consumed + successorSessionId(仅原上下文可见;T052 D5 复验)
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancel.status).toBe(200);
    expect(Object.keys(cancel.body).sort()).toEqual([...CANCEL_REPLY_KEYS]);
    expect(cancel.body).toEqual({ outcome: 'already_consumed', successorSessionId: successorId, slotRevision: 1 });
    // 重复 cancel 追查幂等:同 outcome 同 successor(协调器按此追查并 stop 不需要的后继)
    const cancelAgain = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancelAgain.status).toBe(200);
    expect(cancelAgain.body).toEqual({ outcome: 'already_consumed', successorSessionId: successorId, slotRevision: 1 });
    // 后继显式 stop(协调器追查语义;005 既有 204)
    const stop = await postStop(rig.app, rig.cookieA, successorId);
    expect(stop.status).toBe(204);
    expect(sessionRowOf(successorId).state).toBe('ended');
    // stop 后 cancel 仍 already_consumed 且后继引用不变(已消费槽永久保留映射)
    const cancelAfterStop = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancelAfterStop.status).toBe(200);
    expect(cancelAfterStop.body).toEqual({ outcome: 'already_consumed', successorSessionId: successorId, slotRevision: 1 });
    // stop 语义:终态后 renew 拒绝(播放权终结,不复活)
    const renew = await postRenew(rig.app, rig.cookieA, successorId, sessionRowOf(successorId).generation);
    expectProblem(renew, 409, 'PLAYBACK_ENDED');
    // 已消费重放:200 同后继当前状态(ended),不重建、不再次消费造新播放
    const replay = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(replay.status).toBe(200);
    expect(String(replay.headers['location']).split('/').pop()).toBe(successorId);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '重放不得新建第二后继',
    ).toBe(1);
    // cleanup:consumed 分支对终态后继收口 → stopped;重试幂等
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status).toBe(200);
    expect(Object.keys(cleanup.body).sort()).toEqual([...CLEANUP_REPLY_KEYS]);
    expect(cleanup.body).toEqual({ outcome: 'stopped' });
    const cleanupRetry = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanupRetry.status).toBe(200);
    expect(cleanupRetry.body).toEqual({ outcome: 'stopped' });
    // 槽永久 consumed + successor 引用保留(至少 24h 重放保护,data-model §7/§9)
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('consumed');
    expect(slot?.successorSessionId).toBe(successorId);
  });

  it('E2 watchdog 回收未起播后继(readyAt 60s,T045 面)→ 后继 interrupted;GET 意图仍 200 consumed 不复活、重放同后继、cleanup 幂等、第二拍零回收', async () => {
    const rig = await startRevocationRig('hmp-t078-e2-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeAndReady(rig, chain);
    expect(sessionRowOf(successorId).state, '夹具前提:后继 ready 未起播').toBe('ready');
    // watchdog 单拍(T045 可测入口;期限锚点=created_at 起 60s,heartbeat/renew 不续命;
    // 以 nowMs 越过期限表达「到期」,不等待真实 60s):→T081 收口面
    const retention = rig.app.get(PlaybackRetentionService);
    const beat1 = await retention.runUnstartedReadyReclaim(Date.now() + 61_000);
    expect(beat1.reclaimed, 'watchdog 应回收未起播 ready 后继(→T081)').toBeGreaterThanOrEqual(1);
    expect(sessionRowOf(successorId).state, '回收为终态 interrupted').toBe('interrupted');
    // GET 意图仍 200 consumed:已消费映射不随回收翻转,successor 引用保留(不复活语义锚)
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect(got.status, '回收后 GET 意图应仍 200 consumed').toBe(200);
    expect((got.body as IntentSnapshot).status).toBe('consumed');
    expect((got.body as IntentSnapshot).successorSessionId).toBe(successorId);
    // 已消费重放:200 同后继当前状态(interrupted),不重建、不复活播放
    const replay = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(replay.status).toBe(200);
    expect(String(replay.headers['location']).split('/').pop()).toBe(successorId);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '重放不得新建第二后继',
    ).toBe(1);
    // cancel 输家:already_consumed 同 successor(回收不改已消费映射)
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ outcome: 'already_consumed', successorSessionId: successorId, slotRevision: 1 });
    // 回收后播放权不复活:终态 renew 拒绝(interrupted → 409 PLAYBACK_NOT_READY)
    const renew = await postRenew(rig.app, rig.cookieA, successorId, sessionRowOf(successorId).generation);
    expectProblem(renew, 409, 'PLAYBACK_NOT_READY');
    // cleanup 终态分支:stopped;重试幂等
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status).toBe(200);
    expect(cleanup.body).toEqual({ outcome: 'stopped' });
    // watchdog 第二拍:回收幂等(终态会话不入清单,零回收)
    const beat2 = await retention.runUnstartedReadyReclaim(Date.now() + 61_000);
    expect(beat2.reclaimed, 'watchdog 第二拍必须零回收(条件 UPDATE 幂等)').toBe(0);
    expect(sessionRowOf(successorId).state).toBe('interrupted');
  });
});

/* ------------------------------------------------------------------ */
/* F 重启不复活(helpers.restartApp 同 DATA_DIR;data-model §6/§9+I5 重试扫描) */
/* ------------------------------------------------------------------ */

describe('T078 · F 重启不复活(data-model §6 重启中断旧播放/意图;I5 失败/重启扫描重试;→T081)', () => {
  it('F1 消费后重启:意图 consumed 状态持久、重放 200 同后继(interrupted 不复活)、renew 拒绝、cancel 追查、cleanup 幂等', async () => {
    const rig = await startRevocationRig('hmp-t078-f1-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeAndReady(rig, chain);
    // 重启(rig 重建 app 同 DATA_DIR/DB_FILENAME;boot 恢复中断活动播放)并改绑 rig.app
    rig.app = await restartApp(rig.fresh);
    // 意图 consumed 状态持久:GET 200 consumed + successor 引用保留
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect(got.status, '重启后 GET 意图应 200(consumed 至少 24h 保留)').toBe(200);
    expect((got.body as IntentSnapshot).status).toBe('consumed');
    expect((got.body as IntentSnapshot).successorSessionId).toBe(successorId);
    // 库内:intent/slot 均持久 consumed
    expect(intentStatusOf(rig.householdId, chain.intent.id)).toBe('consumed');
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('consumed');
    expect(slot?.successorSessionId).toBe(successorId);
    // 后继不复活播放权:boot 恢复中断活动播放 → interrupted;重放 200 同后继真实状态
    expect(sessionRowOf(successorId).state, '重启应中断活动播放(recoverOnBoot → interrupted)').toBe('interrupted');
    const replay = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(replay.status, '重启后重放应 200 同后继(不复活不重建)').toBe(200);
    expect(String(replay.headers['location']).split('/').pop()).toBe(successorId);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '重启后重放不得新建第二后继',
    ).toBe(1);
    // 播放权不复活:终态 renew 拒绝(→T081)
    const renew = await postRenew(rig.app, rig.cookieA, successorId, sessionRowOf(successorId).generation);
    expectProblem(renew, 409, 'PLAYBACK_NOT_READY');
    // cancel 追查与 cleanup 收口在重启后仍可用且幂等
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ outcome: 'already_consumed', successorSessionId: successorId, slotRevision: 1 });
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status, '重启后 cleanup 应 200(终态分支 stopped)').toBe(200);
    expect(cleanup.body).toEqual({ outcome: 'stopped' });
    const cleanupRetry = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanupRetry.status).toBe(200);
    expect(cleanupRetry.body).toEqual({ outcome: 'stopped' });
  });

  it('F2 cleanup 标记跨重启持久:清理后重启 renew 仍拒绝(持久标记+终态)、重放不复活、扫描补投幂等空转(第二拍全零)', async () => {
    const rig = await startRevocationRig('hmp-t078-f2-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeAndReady(rig, chain);
    // 重启前清理:consumed 分支写持久标记 + 幂等空 stop
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status).toBe(200);
    expect(cleanup.body).toEqual({ outcome: 'stopped' });
    expect(sessionCleanupMarkerOf(successorId).requested, '重启前标记应已落库').toBe(1);
    // 重启(同 DATA_DIR)并改绑 rig.app
    rig.app = await restartApp(rig.fresh);
    // 持久标记跨重启阻断新票:renew 409(I5「标记后拒绝其 renew」;重启不解除撤销)
    const renew = await postRenew(rig.app, rig.cookieA, successorId, sessionRowOf(successorId).generation);
    expectProblem(renew, 409, 'PLAYBACK_NOT_READY');
    // 意图 consumed 持久;重放 200 同后继(ended;标记/终态不复活播放)
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect(got.status).toBe(200);
    expect((got.body as IntentSnapshot).status).toBe('consumed');
    expect((got.body as IntentSnapshot).successorSessionId).toBe(successorId);
    const replay = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(replay.status).toBe(200);
    expect(String(replay.headers['location']).split('/').pop()).toBe(successorId);
    // 重启扫描面(启动恢复首拍挂 retention 节拍链;此处显式单拍断言):
    // 标记会话已终态不入补投清单 → 全零;第二拍仍全零(幂等,不重复补投/不误删)
    const retention = rig.app.get(PlaybackRetentionService);
    const beat1 = await retention.runTransitionCleanupSweep();
    expect(beat1, '重启后过渡清理扫描应可用(→T081)').toBeDefined();
    expect(beat1!.cleanupStopsRedelivered, '已终态标记会话不入补投清单').toBe(0);
    const beat2 = await retention.runTransitionCleanupSweep();
    expect(beat2).toBeDefined();
    expect(beat2!.cleanupStopsRedelivered).toBe(0);
    expect(beat2!.consumedIntentsDeleted, '24h 保护窗内已消费 intent 不删(data-model §9)').toBe(0);
    expect(sessionRowOf(successorId).state, '扫描不得复活或翻转终态后继').toBe('ended');
  });
});

/* ------------------------------------------------------------------ */
/* G 清理标记阻断(api §7 I5;T062 已钉 renew 409 —— 扩展新资产/seek 面+补投幂等) */
/* ------------------------------------------------------------------ */

describe('T078 · G 清理标记阻断(api §7 I5「标记先阻止新票/资产」;data-model §10;→T081)', () => {
  it('G1 标记崩溃窗口:renew 409(复验 T062)+新资产 503 交付门拒绝(有效票仍拦)+seek 静态拒绝面;扫描补投幂等空 stop(第二拍全零)', async () => {
    const rig = await startRevocationRig('hmp-t078-g1-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeAndReady(rig, chain);
    const generation = sessionRowOf(successorId).generation;
    // 基线:标记前 renew 200,取得有效票(playbackUrl 票据面,T015 已装配)
    const renewOk = await postRenew(rig.app, rig.cookieA, successorId, generation);
    expect(renewOk.status, '夹具错误:标记前 renew 应 200').toBe(200);
    const playbackUrl = String((renewOk.body as { playbackUrl: string }).playbackUrl);
    expect(playbackUrl).toMatch(/^\/api\/playback\/stream\//);
    // DB 直改注明:cleanup 崩溃窗口标记(标记事务已提交、提交后幂等空 stop 未落定 ——
    // I5 持久中间态;列值与 markDeliveryCleanupRequested 提交面同形)
    seedCleanupRequestedMarker(successorId);
    // 标记先阻止新票:renew 409(T062 已钉,复验精确码;先于授权链,源/策略放行亦不解除)
    const renew = await postRenew(rig.app, rig.cookieA, successorId, generation);
    expectProblem(renew, 409, 'PLAYBACK_NOT_READY');
    // 标记阻断新资产:持有效票请求入口清单 → 交付门 503 PLAYBACK_RESOURCE_UNAVAILABLE
    // (票据本身有效 —— 拒绝发生在授权/票校验之后的交付资格门;注册稳定码,失败 →T081)
    const asset = await request(rig.app.getHttpServer()).get(playbackUrl).set('Cookie', rig.cookieA);
    expectStableRejection(asset, 503, 'PLAYBACK_RESOURCE_UNAVAILABLE', '清理标记必须阻断新资产交付(→T081)');
    expect(
      JSON.stringify(asset.body ?? ''),
      '资产拒绝面不得携带上游清单形态(私有定位不外泄)',
    ).not.toContain('m3u8');
    // seek 面不能借道:hls_proxy VOD 服务端 POST seek 静态拒绝保留(T045/I4 第一期形态;
    // 标记态下不存在经 seek 建新交付的旁路)
    const seek = await postSeek(rig.app, rig.cookieA, successorId, 1);
    expectProblem(seek, 400, 'PLAYBACK_SEEK_UNSUPPORTED');
    expect(sessionRowOf(successorId).state, '崩溃窗口内会话保持活动态(标记先于进程取消)').toBe('ready');
    // 扫描补投(失败/重启扫描重试面;→T081):第一拍补投幂等空 stop → 会话 ended
    const retention = rig.app.get(PlaybackRetentionService);
    const beat1 = await retention.runTransitionCleanupSweep();
    expect(beat1!.cleanupStopsRedelivered, '扫描应补投幂等空 stop(→T081)').toBe(1);
    expect(sessionRowOf(successorId).state, '补投空 stop 后会话终态 ended').toBe('ended');
    // 第二拍全零:补投清单出清,全部计数归零(幂等,不重复补投/不误删)
    const beat2 = await retention.runTransitionCleanupSweep();
    expect(beat2).toEqual({
      expiredPendingFlipped: 0,
      consumedSlotsDeleted: 0,
      consumedIntentsDeleted: 0,
      finishReceiptsDeleted: 0,
      nextPlansRecycled: 0,
      cleanupStopsRedelivered: 0,
    });
  });

  it('G2 禁源 + 同 context cleanup 仅清理:consumed 分支标记+stopped(不要求策略放行);renew 409;扫描两拍全零不重复补投', async () => {
    const rig = await startRevocationRig('hmp-t078-g2-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const successorId = await consumeAndReady(rig, chain);
    // 消费成功后禁源(等价「来源被管理员停用」;T052 G1 同口径)
    disableSource(rig.sourceRowId);
    // GET 失权 404(完整结果要求当前源权限;不借 GET 发票)
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expectProblem(got, 404, ProblemCode.MEDIA_NOT_FOUND);
    // 禁源但同 context 仅清理:cleanup 不要求策略放行 → consumed 分支标记 + stopped
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status, '禁源但同 context 的 cleanup 应 200(I5)').toBe(200);
    expect(Object.keys(cleanup.body).sort()).toEqual([...CLEANUP_REPLY_KEYS]);
    expect(cleanup.body).toEqual({ outcome: 'stopped' });
    expect(JSON.stringify(cleanup.body), 'cleanup 响应不得泄漏目标 mediaId').not.toContain(rig.serial.ep02MediaId);
    // 持久标记:唯一已关联后继 cleanup_requested=1(T062 G1 复验)
    expect(sessionCleanupMarkerOf(successorId).requested).toBe(1);
    expect(sessionCleanupMarkerOf(successorId).state).toBe('pending');
    // 槽保持 consumed(consumed 分支不释放槽;consumed 槽永久不能再建第二后继)
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('consumed');
    expect(slot?.successorSessionId).toBe(successorId);
    // 标记阻断新票:renew 409(T062 已钉,复验)
    const renew = await postRenew(rig.app, rig.cookieA, successorId, sessionRowOf(successorId).generation);
    expectProblem(renew, 409, 'PLAYBACK_NOT_READY');
    // 扫描两拍全零:端点补投已落定(会话已终态),扫描不重复补投、不误删受引用行
    const retention = rig.app.get(PlaybackRetentionService);
    const beat1 = await retention.runTransitionCleanupSweep();
    expect(beat1!.cleanupStopsRedelivered, '终态标记会话不入补投清单').toBe(0);
    const beat2 = await retention.runTransitionCleanupSweep();
    expect(beat2!.cleanupStopsRedelivered).toBe(0);
    expect(beat2!.consumedIntentsDeleted).toBe(0);
    expect(beat2!.consumedSlotsDeleted).toBe(0);
    expect(sessionRowOf(successorId).state, '扫描不得翻转已收口后继').toBe('ended');
  });
});

