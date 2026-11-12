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
  buildAppleCmsListDocument,
  createFixtureTitleWorld,
  createFixtureVodSource,
  createStandardEpisodePresentation,
  findUpstreamRoute,
  type FixtureHlsPresentation,
  type FixtureTitleWorld,
  type FixtureUpstreamSource,
} from '../fixtures/online-vod/fixture-upstream';

/**
 * T083(010-online-vod · Phase 8,测试收口):在线点播安全端到端负向面 ——
 * 「CMS/redirect/manifest/key/segment/ffmpeg/测速的 SSRF 与预算、未知字段/大体积/
 * 源位置/其他 Profile 泄露、限流桶与缓存全局上限;同源或测速成功不能绕过目标策略」。
 * 依赖 T081/T067 已落地;服务端现状全绿(candidates/probes/materializations/resolve/
 * progress/finish/intents/cleanup 全链装配;ffmpeg 在线拒绝 T044;预算面 VOD_BUDGETS/
 * vod-config)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §0(认证/授权/错误收敛/限流桶:公共查询
 *   每 IP 120/min、在线搜索另 20/min、phase 观测独立 120/min/session、progress
 *   60/min/DeviceSession、创建 intent/测速各 10/min/DeviceSession;桶 TTL+全局上限,
 *   429+Retry-After;写 body<=16KiB;详细上游错误/地址/凭据不公开;私有 opaque ref
 *   不可解码)、§2(公共面无个人字段/源位置;每家庭 100 搜索/1000 预览、全进程
 *   256MiB、单详情 4MiB 超限 422;ref 失效 410)、§5(候选/测速:无票/无历史、逐候选
 *   预览有效+策略检查后有界请求、未授权目标不探测)、§6(问题码/恢复;来源/上下文
 *   授权失败优先于专用错误)+ §7 I1(候选登记映射);
 * - docs/specs/010-online-vod/tasks.md T083 原文 + T044(ffmpeg 在线拒绝)/T070/T071
 *   (候选/测速语义)/T019/T028(预算/缓存)。
 *
 * 与既有面的关系(引用不重复):
 * - test/unit/online-vod/safe-upstream.spec.ts(58 例):SafeUpstream 内部(协议/DNS/
 *   每跳/内网/Abort/字节/嵌套)与 T083 增量「经 HTTP 面端到端形态」已钉;本文件只在
 *   真实装配链上验证「经 HTTP 面」的服务端行为(候选 locator→probe 的 SSRF 面等);
 * - test/contract/online-vod-auth-boundaries.e2e-spec.ts(T021):Public/Settings/
 *   Profile 授权边界、CSRF/同源、私有地址白名单(来源创建面);本文件不重复;
 * - test/contract/online-vod-switch.e2e-spec.ts(T067):候选/测速/switch/recover
 *   正负向契约(伪造 ref 404 零上游、candidateRefs 1–3、挂起预算 timeout);本文件
 *   补其安全语义延伸(私网/重定向 pivot locator、测速成功不绕目标策略、混合预算);
 * - test/contract/rate-limit-evidence.e2e-spec.ts(T141):public 120/guide 30/
 *   progress 60(第 61 发 429 + 跨会话隔离);本文件补 010 新桶(搜索 20/观测 120/
 *   测速 10/过渡 intent 10)与跨桶隔离;
 * - test/unit/online-vod/search-preview.spec.ts A8/B3(注入时钟):TTL 到期 410 语义;
 *   e2e 链路 TTL 固定契约值 10min/60s 不可快进,本文件钉同一 410 问题的可达形态
 *   (伪造游标/searchId、禁源失效),TTL 推进面引用单测,不伪称 e2e 已覆盖;
 * - test/unit/playback/vod-delivery-input.spec.ts F1:supervisor 级在线转换拒绝
 *   (inputChannel='online-upstream' → PLAYBACK_FORMAT_UNSUPPORTED,不 reserve 不
 *   spawn);本文件在真实装配链钉「在线面零 ffmpeg 转换启动面 + 交付走 SafeUpstream」;
 * - NAS 转换路径零变化:conversion 单测族(conversion.spec/conversion-delivery.spec)
 *   与 playback-readiness.e2e-spec 迁移面已覆盖,本文件不重复。
 *
 * 装配方式(沿用 010 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威迁移,含 0007_online_vod)+
 *   initialize/login/selectMainAndUnlockSettings + Supertest 真实 HTTP;双设备两次
 *   login;T092 seam registerPersonalPlaybackFactsPort 注入可信时长(进度接受面);
 * - 受控上游 createControlledMediaServer(127.0.0.1 随机端口 + fixture-upstream 路由
 *   派发;LAN_ALLOWED_TARGETS='127.0.0.1';零真实外网请求)。SSRF 素材:源B 详情
 *   (ac=detail)按 ids 覆写 EP01 locator —— 私网字面量(10.120.0.8,RFC1918,许可外
 *   且字面量在连接/DNS 前被拒)、受控首跳 302 → 私网字面量(重定向 pivot)、恒挂起
 *   路径(预算取消);全部字面量目标零网络(拒绝发生在建连前,受控计数为零);
 * - 策略面经真实 HTTP:PUT /api/settings/profiles/:id/policy(maxContentLevel=0 +
 *   allowUnrated=false,当次密码 + expectedVersion CAS)构造「目标策略 block」;
 * - env 收窄注入(E1):process.env.VOD_CACHE_MAX_TOTAL_BYTES=128(只许收紧),DI
 *   解析期读 env,用例后恢复;
 * - DB 直改仅用于无 HTTP 语义的工厂事实,逐处注明:kind=vod 来源行(media_source +
 *   vod_source_config,T067 同款)、禁源(media_source.enabled=0)、会话/终态只读快照。
 *   不改任何共享文件;临时目录隔离;无 git 操作。
 *
 * ───────────────────────── 绿/红口径 ─────────────────────────
 * 依赖面(T081/T067/预算/限流/缓存)全部已装配:本文件用例应全绿;「确属未实现
 * 语义标计划内红」经逐一核对后为零 —— 可达性受限的语义(TTL 快进、intent 429 的
 * Retry-After 响应头缺口)以「引用单测/头注注记」表达,不伪称覆盖亦不制造红。
 * 预期计数:红 0 / 绿 18(A 5 + B 3 + C 3 + D 4 + E 2 + F 1);两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

const CANDIDATES_URL = '/api/vod/switch-candidates';
const PROBES_URL = '/api/vod/switch-probes';
const INTENTS_URL = '/api/playback/transition-intents';
const MATERIALIZE_URL = '/api/vod/materializations';
const SEARCH_URL = '/api/public/vod/search';

/** SSRF 素材:RFC1918 私网字面量(夹具保留值;许可外,连接前被拒,零网络) */
const PRIVATE_LITERAL = '10.120.0.8';
const PRIVATE_ORIGIN = `http://${PRIVATE_LITERAL}:9981`;

/** 受信时长事实(T092 seam;进度接受面) */
const TRUSTED_DURATION_SECONDS = 3600;

/** RFC 9457 problem 白名单键(全局 ProblemJsonFilter + 502/504 直渲染体;超集) */
const PROBLEM_ALLOWED_KEYS = ['type', 'title', 'status', 'code', 'detail', 'instance', 'annotations'] as const;

/** 源A 健康连续剧(物化/播放素材);源B 同名双胞胎经 versionLabel 区分 */
const SERIAL_NAME = 'fixture·星尘信使';
const TWIN_LABELS = {
  healthy: '健康测试版',
  private: '私网测试版',
  redirect: '重定向测试版',
  hang: '挂起测试版',
} as const;

/** 候选清单条目(测试消费子集;12 键契约见 T067 A1) */
interface CandidateLike {
  readonly candidateRef: string;
  readonly title: string;
  readonly label: string;
  readonly versionLabel: string | null;
  readonly sourceLabel: string;
  readonly matchConfidence: string;
  readonly previewRevision: number;
  readonly expiresAt: string;
  readonly [key: string]: unknown;
}

/** ProbeResult 4 键(api §1) */
interface ProbeLike {
  readonly candidateRef: string;
  readonly status: string;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  readonly [key: string]: unknown;
}

/** 稳定错误断言:status + problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** problem 体键白名单 + 错误体零内部细节(上游地址/源路径/堆栈形态) */
function expectSanitizedProblem(res: request.Response, markers: readonly string[], label: string): void {
  expectProblemContentType(res);
  const keys = Object.keys(res.body as Record<string, unknown>);
  const illegal = keys.filter((key) => !(PROBLEM_ALLOWED_KEYS as readonly string[]).includes(key));
  expect(illegal, `${label} 出现 problem 白名单外字段:${illegal.join(',')}`).toEqual([]);
  const serialized = JSON.stringify(res.body) ?? '';
  for (const marker of markers) {
    expect(serialized, `${label} 错误体不得包含内部标记「${marker}」`).not.toContain(marker);
  }
  expect(serialized, `${label} 错误体不得包含堆栈/内部路径形态`).not.toMatch(/at |\n|node:|\/Volumes\/|\.ts:/);
}

/* ------------------------------------------------------------------ */
/* 夹具世界(源A 连续剧 + 源B 四双胞胎 + 大详情世界)                       */
/* ------------------------------------------------------------------ */

/** 标准单集呈现(rootPath 参数化,避免同端口路由互撞;T067 同手法) */
function presentationFor(prefix: string, episodeKey: string, origin: string, rootPath: string): FixtureHlsPresentation {
  return createStandardEpisodePresentation({
    presentationKey: `t083:${prefix}:${episodeKey}`,
    episodeKey,
    origin,
    rootPath: `${rootPath}/ep-${episodeKey}`,
    segmentCount: 2,
    segmentDurationSeconds: 120,
  });
}

/** 源A 三集连续剧(检索词 stardust;物化/播放链素材) */
function createSerialWorld(origin: string): FixtureTitleWorld {
  return createFixtureTitleWorld({
    titleKey: 't083-serial',
    searchKeyword: 'stardust',
    upstreamVodId: 1001,
    name: SERIAL_NAME,
    year: '2024',
    remarks: '连载完毕 共3集',
    episodesTotal: 3,
    synopsis: '源A 健康连续剧(T083 播放链/泄露面素材)。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [1, 2, 3].map((ordinal) => {
          const episodeKey = String(ordinal).padStart(2, '0');
          return {
            episodeKey,
            label: `第${episodeKey}集`,
            presentation: presentationFor('a', episodeKey, origin, '/vod/hls/t083-a'),
            seasonKey: 'S01',
            ordinal,
            sequenceStatus: 'ordered' as const,
          };
        }),
      },
    ],
  });
}

interface TwinSpec {
  readonly upstreamVodId: number;
  readonly versionLabel: string;
  readonly rootPath: string;
}

/** 源B 同名双胞胎(检索词同 stardust;跨源候选素材;versionLabel 供用例辨识) */
function createTwinWorld(origin: string, spec: TwinSpec): FixtureTitleWorld {
  return createFixtureTitleWorld({
    titleKey: `t083-twin-${spec.upstreamVodId}`,
    searchKeyword: 'stardust',
    upstreamVodId: spec.upstreamVodId,
    name: SERIAL_NAME,
    year: '2024',
    versionLabel: spec.versionLabel,
    remarks: `跨源双胞胎 ${spec.versionLabel}`,
    episodesTotal: 3,
    synopsis: '源B 同名双胞胎(T083 候选/测速安全面素材)。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [1, 2, 3].map((ordinal) => {
          const episodeKey = String(ordinal).padStart(2, '0');
          return {
            episodeKey,
            label: `第${episodeKey}集`,
            presentation: presentationFor(`b${spec.upstreamVodId}`, episodeKey, origin, spec.rootPath),
            seasonKey: 'S01',
            ordinal,
            sequenceStatus: 'ordered' as const,
          };
        }),
      },
    ],
  });
}

/** 源B 大详情世界(brief 正常;detail 体由覆写注入 ~5MiB,触发 4MiB 读预算) */
function createBigDetailWorld(origin: string): FixtureTitleWorld {
  return createFixtureTitleWorld({
    titleKey: 't083-big-detail',
    searchKeyword: 'bigdetail',
    upstreamVodId: 2201,
    name: 'fixture·巨型详情',
    year: '2020',
    remarks: '正片',
    episodesTotal: 1,
    synopsis: '大详情世界(detail 体在 ac=detail 覆写中注入,超 4MiB 读预算)。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [
          {
            episodeKey: '01',
            label: '第01集',
            presentation: presentationFor('big', '01', origin, '/vod/hls/t083-big'),
            ordinal: 1,
            sequenceStatus: 'ordered',
          },
        ],
      },
    ],
  });
}

/** 详情体覆写:按集键改写 vod_play_url 定位(SSRF/预算素材注入点;brief 不变) */
function detailBodyWithLocator(world: FixtureTitleWorld, locatorByEpisodeKey: Record<string, string>): string {
  const item = { ...world.item };
  item.vod_play_url = world.seed.lines
    .map((line) =>
      line.episodes.map((episode) => `${episode.label}$${locatorByEpisodeKey[episode.episodeKey] ?? episode.playlistUri}`).join('#'),
    )
    .join('$$$');
  return JSON.stringify(buildAppleCmsListDocument([item]));
}

/** ~5MiB 巨型详情体(超 preview.maxBytes=4MiB 读预算;超限在读取侧整体拒绝) */
function hugeDetailBody(world: FixtureTitleWorld): string {
  const item = { ...world.item };
  item.vod_content = `<p>${'巨'.repeat(2 * 1024 * 1024)}</p>`;
  return JSON.stringify(buildAppleCmsListDocument([item]));
}

interface SecuritySourcePair {
  readonly sourceA: FixtureUpstreamSource;
  readonly sourceB: FixtureUpstreamSource;
}

/** 两源世界:源A 连续剧;源B 四双胞胎(健康/私网/重定向/挂起)+ 大详情 */
function buildSecuritySourcePair(port: number): SecuritySourcePair {
  const origin = `http://127.0.0.1:${port}`;
  const sourceA = createFixtureVodSource({
    sourceId: 'fixture-vod-source-t083-a',
    displayName: '夹具源A(T083)',
    behavior: 'healthy',
    apiPath: '/t083-src-a/api.php',
    address: { host: '127.0.0.1', port },
    titleWorlds: [createSerialWorld(origin)],
  });
  const sourceB = createFixtureVodSource({
    sourceId: 'fixture-vod-source-t083-b',
    displayName: '夹具源B(T083)',
    behavior: 'healthy',
    apiPath: '/t083-src-b/api.php',
    address: { host: '127.0.0.1', port },
    titleWorlds: [
      createTwinWorld(origin, { upstreamVodId: 2100, versionLabel: TWIN_LABELS.healthy, rootPath: '/vod/hls/t083-b-ok' }),
      createTwinWorld(origin, { upstreamVodId: 2101, versionLabel: TWIN_LABELS.private, rootPath: '/vod/hls/t083-b-priv' }),
      createTwinWorld(origin, { upstreamVodId: 2102, versionLabel: TWIN_LABELS.redirect, rootPath: '/vod/hls/t083-b-redir' }),
      createTwinWorld(origin, { upstreamVodId: 2103, versionLabel: TWIN_LABELS.hang, rootPath: '/vod/hls/t083-b-hang' }),
      createBigDetailWorld(origin),
    ],
  });
  return { sourceA, sourceB };
}

/* ------------------------------------------------------------------ */
/* rig:受控上游 + 全量迁移 app + 双设备身份 + HTTP 物化                   */
/* ------------------------------------------------------------------ */

interface SecurityRig {
  readonly app: INestApplication;
  readonly householdId: string;
  readonly server: ControlledMediaServer;
  readonly cookieA: string;
  readonly cookieB: string;
  readonly profileAId: string;
  readonly deviceSessionAId: string;
  readonly deviceSessionBId: string;
  readonly serialA: { readonly parentMediaId: string; readonly ep01MediaId: string };
  readonly sourceLabelA: string;
  readonly sourceLabelB: string;
  /** 受控上游请求计数增量(零上游断言基线;apiPath A/B + pivot 跳 + 挂起路径) */
  readonly requestsSince: (baseline: number) => number;
  /** 双胞胎候选定位覆写后的受控路径(泄露/计数断言用) */
  readonly redirectHopPath: string;
  readonly hangPath: string;
}

function householdIdOf(): string {
  const row = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string } | undefined;
  expect(row, '夹具错误:household 行不存在(初始化未执行)').toBeDefined();
  return row!.id;
}

/** 登录令牌 → DeviceSession 行 id(与 SessionGuard 同算法;T067 同款) */
function deviceSessionIdOfToken(token: string): string {
  const row = Database.db.prepare('SELECT id FROM device_session WHERE token_hash = ?').get(hashToken(token)) as
    | { id: string }
    | undefined;
  expect(row, '夹具错误:登录令牌对应的 device_session 行不存在').toBeDefined();
  return row!.id;
}

/** kind=vod 来源行(media_source + vod_source_config 一源一行;T067 同款工厂事实) */
function seedVodSourceRow(householdId: string, name: string, remoteUrl: string): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({ id: sourceId, householdId, kind: 'vod', name, remoteUrl, enabled: 1, createdAt: now, updatedAt: now })
      .run();
    tx.insert(vodSourceConfig).values({ householdId, sourceId, adapter: 'apple-cms-json' }).run();
  });
  return sourceId;
}

/** DB 直改:禁源(media_source.enabled=0;T067/T022 同口径;启停失效 locator 语义) */
function disableSource(sourceRowId: string): void {
  Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(sourceRowId);
}

/** 搜索 → 按 sourceLabel 精确选卡 → 预览 → 物化(T031 真实装配链;T067 同款) */
async function materializeEpisodeFromSource(
  app: INestApplication,
  cookie: string,
  keyword: string,
  wantedSourceLabel: string,
): Promise<{ mediaId: string; parentMediaId: string }> {
  const search = await request(app.getHttpServer()).get(SEARCH_URL).query({ q: keyword });
  expect(search.status, `搜索 ${keyword} 应 200(受控上游)`).toBe(200);
  const items = (search.body as { items: Array<{ titleRef: string; sourceLabel: string }> }).items;
  const card = items.find((item) => item.sourceLabel === wantedSourceLabel);
  expect(card, `搜索 ${keyword} 应含来源「${wantedSourceLabel}」条目`).toBeDefined();
  const preview = await request(app.getHttpServer()).get(`/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`);
  expect(preview.status, `预览应 200(实际 ${preview.status} ${JSON.stringify(preview.body).slice(0, 160)})`).toBe(200);
  const episodeRef = (preview.body as { lines: Array<{ episodes: Array<{ episodeRef: string }> }> }).lines[0]?.episodes[0]
    ?.episodeRef;
  expect(episodeRef, '预览应有候选分集').toBeTypeOf('string');
  const res = await request(app.getHttpServer())
    .post(MATERIALIZE_URL)
    .set('Cookie', cookie)
    .send({
      titleRef: card!.titleRef,
      episodeRef: episodeRef!,
      previewRevision: (preview.body as { previewRevision: number }).previewRevision,
      operationKey: randomUUID(),
    });
  expect(res.status, `物化 ${keyword}@${wantedSourceLabel} 应 201(T031 链;实际 ${JSON.stringify(res.body).slice(0, 200)})`).toBe(201);
  const body = res.body as { mediaId: string; parentMediaId: string };
  return { mediaId: body.mediaId, parentMediaId: body.parentMediaId };
}

/** 受控上游请求总计数(apiPath 派发/pivot 跳/raw media 均计数;挂起路径不计数) */
let upstreamRequestCount = 0;

/** 受控服务器句柄(afterEach 统一关闭;文件级登记表) */
const activeMediaServers: ControlledMediaServer[] = [];

async function startSecurityRig(prefix: string, options: { readonly skipMaterialize?: boolean } = {}): Promise<SecurityRig> {
  let pair = buildSecuritySourcePair(0);
  upstreamRequestCount = 0;
  const redirectHopPath = '/t083/redirect-jump';
  const hangPath = '/t083/hang-master';
  const counted = (): void => {
    upstreamRequestCount += 1;
  };

  /** 详情覆写(源B ids→locator;SSRF/预算素材注入;brief/搜索面不变) */
  const detailOverrides = new Map<string, string>();

  /** apiPath 派发(按名延迟解引用:受控服务器启动后重烙 pair,请求时读当前世界;T067 同手法) */
  const rawRespondOf = (sourceName: 'sourceA' | 'sourceB') => (context: MediaRequestContext) => {
    counted();
    // 详情覆写优先(按 ids 精确;素材定位只存在于详情 wire)
    const ids = context.url.searchParams.get('ids');
    const override = ids !== null ? detailOverrides.get(ids) : undefined;
    if (context.url.searchParams.get('ac') === 'detail' && override !== undefined) {
      context.res.statusCode = 200;
      context.res.setHeader('content-type', 'application/json; charset=utf-8');
      context.res.end(override);
      return;
    }
    const route = findUpstreamRoute(pair[sourceName].routes, context.url.href);
    if (route === null || route.response.kind === 'timeout') {
      context.res.statusCode = 404;
      context.res.setHeader('content-type', 'text/plain; charset=utf-8');
      context.res.end('fixture upstream: no route');
      return;
    }
    context.res.statusCode = route.response.status;
    for (const [name, value] of Object.entries(route.response.headers)) {
      context.res.setHeader(name, value);
    }
    context.res.end(route.response.body);
  };

  const server = await createControlledMediaServer({
    routes: [
      { path: pair.sourceA.apiPath, kind: 'raw' as const, respond: rawRespondOf('sourceA') },
      { path: pair.sourceB.apiPath, kind: 'raw' as const, respond: rawRespondOf('sourceB') },
      {
        // 受控首跳:302 → 私网字面量(重定向 pivot 素材;私网侧零请求零网络)
        path: redirectHopPath,
        kind: 'raw' as const,
        respond: (context: MediaRequestContext) => {
          counted();
          context.res.statusCode = 302;
          context.res.setHeader('location', `${PRIVATE_ORIGIN}/secret.m3u8`);
          context.res.end();
        },
      },
    ],
  });
  activeMediaServers.push(server);

  // 受控服务器已监听真实端口:重烙世界(presentation/locator 命中真实路由;T067 同手法)
  pair = buildSecuritySourcePair(server.port);
  detailOverrides.set('2101', detailBodyWithLocator(
    pair.sourceB.titleWorlds.find((world) => world.seed.upstreamVodId === 2101)!,
    { '01': `${PRIVATE_ORIGIN}/ep-01/master.m3u8` },
  ));
  detailOverrides.set('2102', detailBodyWithLocator(
    pair.sourceB.titleWorlds.find((world) => world.seed.upstreamVodId === 2102)!,
    { '01': `${server.baseUrl}${redirectHopPath}` },
  ));
  detailOverrides.set('2103', detailBodyWithLocator(
    pair.sourceB.titleWorlds.find((world) => world.seed.upstreamVodId === 2103)!,
    { '01': `${server.baseUrl}${hangPath}` },
  ));
  detailOverrides.set('2201', hugeDetailBody(pair.sourceB.titleWorlds.find((world) => world.seed.upstreamVodId === 2201)!));

  // 挂起路径(hang 路由;恒不回包,单候选预算必须主动取消)
  server.setRoute(hangPath, { kind: 'hang' });

  // 媒体路由逐路径注册(raw;两源 rootPath 已参数化不互撞),全部计数
  const mediaRoutes = new Map<string, { status: number; headers: Record<string, string>; body: string }>();
  for (const source of [pair.sourceA, pair.sourceB]) {
    for (const route of source.routes) {
      if (route.path.startsWith('/t083-src-')) continue;
      const pathname = route.path.split('?')[0] ?? route.path;
      if (route.response.kind === 'response' && !mediaRoutes.has(pathname)) {
        mediaRoutes.set(pathname, { status: route.response.status, headers: route.response.headers, body: route.response.body });
      }
    }
  }
  for (const [pathname, response] of mediaRoutes) {
    server.setRoute(pathname, {
      kind: 'raw' as const,
      respond: (context: MediaRequestContext) => {
        counted();
        context.res.statusCode = response.status;
        for (const [name, value] of Object.entries(response.headers)) {
          context.res.setHeader(name, value);
        }
        context.res.end(response.body);
      },
    });
  }

  const fresh = await startFreshApp({ prefix, env: { LAN_ALLOWED_TARGETS: '127.0.0.1' } });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const cookieA = cookiePairOf(loggedIn);
  const profileAId = await selectMainAndUnlockSettings(fresh.app, cookieA);
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
  const selectB = await request(fresh.app.getHttpServer()).post(`/api/profiles/${profileAId}/select`).set('Cookie', cookieB).send({});
  expect(selectB.status, '设备B 选主档案应 200').toBe(200);

  const householdId = householdIdOf();
  const sourceLabelA = '夹具源A(T083)';
  const sourceLabelB = '夹具源B(T083)';
  seedVodSourceRow(householdId, sourceLabelA, `${server.baseUrl}${pair.sourceA.apiPath}`);
  seedVodSourceRow(householdId, sourceLabelB, `${server.baseUrl}${pair.sourceB.apiPath}`);
  const materialized = options.skipMaterialize === true
    ? null
    : await materializeEpisodeFromSource(fresh.app, cookieA, 'stardust', sourceLabelA);
  const serialA: { readonly parentMediaId: string; readonly ep01MediaId: string } = {
    parentMediaId: materialized?.parentMediaId ?? '',
    ep01MediaId: materialized?.mediaId ?? '',
  };

  return {
    app: fresh.app,
    householdId,
    server,
    cookieA,
    cookieB,
    profileAId,
    deviceSessionAId: deviceSessionIdOfToken(loggedIn.body.sessionToken as string),
    deviceSessionBId: deviceSessionIdOfToken(secondLogin.body.sessionToken as string),
    serialA,
    sourceLabelA,
    sourceLabelB,
    requestsSince: (baseline: number) => upstreamRequestCount - baseline,
    redirectHopPath,
    hangPath,
  };
}

/* ------------------------------------------------------------------ */
/* 链式编排助手                                                          */
/* ------------------------------------------------------------------ */

interface SourceSession {
  readonly sessionId: string;
  readonly generation: number;
}

function sessionRowOf(sessionId: string): { state: string; generation: number; delivery: string | null; failureCode: string | null } {
  const row = Database.db
    .prepare('SELECT state, generation, delivery, failure_code AS failureCode FROM playback_session WHERE id = ?')
    .get(sessionId) as { state: string; generation: number; delivery: string | null; failureCode: string | null } | undefined;
  expect(row, `夹具错误:playback_session ${sessionId} 不存在`).toBeDefined();
  return row!;
}

function scalarOf(sql: string, ...params: unknown[]): number {
  const row = Database.db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 副本全集快照(测速/候选零副作用断言;T067 同款) */
function sideEffectsOf(householdId: string): {
  sessions: number;
  histories: number;
  materializations: number;
  registeredCandidates: number;
  intents: number;
  conversions: number;
} {
  return {
    sessions: scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ?', householdId),
    histories: scalarOf('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ?', householdId),
    materializations: scalarOf('SELECT COUNT(*) AS n FROM vod_materialization_operation WHERE household_id = ?', householdId),
    registeredCandidates: scalarOf('SELECT COUNT(*) AS n FROM vod_registered_candidate WHERE household_id = ?', householdId),
    intents: scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', householdId),
    conversions: scalarOf('SELECT COUNT(*) AS n FROM playback_conversion WHERE household_id = ?', householdId),
  };
}

/** 轮询等待会话进入指定状态(在线 hls probe 免 ffprobe 即时成功;T036/T067 同款) */
async function waitUntilState(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  wanted: 'ready' | 'playing',
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  let lastState = '';
  while (Date.now() < deadline) {
    const res = await request(app.getHttpServer()).get(`/api/playback/sessions/${sessionId}`).set('Cookie', cookie);
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

/** 真实 resolve 源会话并等 ready */
async function resolveSourceSession(rig: SecurityRig): Promise<SourceSession> {
  const res = await request(rig.app.getHttpServer())
    .post('/api/playback/resolve')
    .set('Cookie', rig.cookieA)
    .send({ mediaId: rig.serialA.ep01MediaId });
  expect(res.status, '夹具错误:源会话 resolve 应 201').toBe(201);
  const sessionId = String(res.headers['location']).split('/').pop() ?? '';
  await waitUntilState(rig.app, rig.cookieA, sessionId, 'ready');
  return { sessionId, generation: sessionRowOf(sessionId).generation };
}

/** 候选清单 200 断言(4 键回执;返回 items 供链式消费) */
async function getSwitchCandidatesOk(rig: SecurityRig, source: SourceSession): Promise<readonly CandidateLike[]> {
  const res = await request(rig.app.getHttpServer())
    .get(CANDIDATES_URL)
    .query({ fromSessionId: source.sessionId, expectedGeneration: source.generation })
    .set('Cookie', rig.cookieA);
  expect(res.status, `候选清单应 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(200);
  expect(res.headers['cache-control'], '候选清单须 no-store(api §0)').toBe('no-store');
  const body = res.body as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor', 'partial', 'reasons']);
  const items = body['items'] as readonly CandidateLike[];
  expect(items.length, '双源同集世界应至少一条候选').toBeGreaterThanOrEqual(1);
  return items;
}

/** 按 versionLabel 取双胞胎候选(四双胞胎以 versionLabel 辨识;同名单保证匹配语义一致) */
function candidateOfVersion(items: readonly CandidateLike[], versionLabel: string): CandidateLike {
  const candidate = items.find((item) => item.versionLabel === versionLabel);
  expect(candidate, `候选清单应含「${versionLabel}」双胞胎(实际 ${JSON.stringify(items.map((item) => item.versionLabel))})`).toBeDefined();
  return candidate!;
}

/** 测速 200 断言(ProbeResult 4 键;输入序一一对应) */
async function postProbesOk(
  rig: SecurityRig,
  source: SourceSession,
  candidateRefs: readonly string[],
): Promise<readonly ProbeLike[]> {
  const res = await request(rig.app.getHttpServer())
    .post(PROBES_URL)
    .set('Cookie', rig.cookieA)
    .send({ fromSessionId: source.sessionId, expectedGeneration: source.generation, candidateRefs });
  expect(res.status, `测速应 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(200);
  expect(res.headers['cache-control'], '测速响应须 no-store(api §0)').toBe('no-store');
  const body = res.body as { items: readonly ProbeLike[] };
  expect(body.items).toHaveLength(candidateRefs.length);
  expect(body.items.map((item) => item.candidateRef)).toEqual([...candidateRefs]);
  return body.items;
}

/** 目标策略收紧(真实 HTTP:PUT /settings/profiles/:id/policy;max 0 + 拒未评级) */
async function blockAllContentPolicy(rig: SecurityRig): Promise<void> {
  const current = await request(rig.app.getHttpServer())
    .get(`/api/settings/profiles/${rig.profileAId}/policy`)
    .set('Cookie', rig.cookieA);
  expect(current.status, '策略读应 200(主档案已解锁)').toBe(200);
  const version = (current.body as { version: number }).version;
  const saved = await request(rig.app.getHttpServer())
    .put(`/api/settings/profiles/${rig.profileAId}/policy`)
    .set('Cookie', rig.cookieA)
    .send({ expectedVersion: version, policy: { maxContentLevel: 0, allowUnrated: false } });
  expect(saved.status, `策略收紧应 200(实际 ${saved.status} ${JSON.stringify(saved.body).slice(0, 160)})`).toBe(200);
}

afterEach(async () => {
  registerPersonalPlaybackFactsPort(null);
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* A SSRF/预算端到端(候选→测速面)                                        */
/* ------------------------------------------------------------------ */

describe('T083 · A SSRF/预算端到端(候选→测速面;api §0/§5/§6)', () => {
  it('A1 私网 locator 候选:probe 不可用、零上游请求、零真实网络(私网字面量连接前被拒),错误零目标回显', async () => {
    const rig = await startSecurityRig('hmp-t083-a1-');
    const source = await resolveSourceSession(rig);
    const items = await getSwitchCandidatesOk(rig, source);
    const candidate = candidateOfVersion(items, TWIN_LABELS.private);
    const baseline = upstreamRequestCount;
    const before = sideEffectsOf(rig.householdId);
    const probes = await postProbesOk(rig, source, [candidate.candidateRef]);
    const probe = probes[0]!;
    // 私网字面量在 SafeUpstream 类别/许可校验(连接前)被拒 → unavailable,延迟恒空
    expect(probe.status, `私网 locator 应 unavailable(实际 ${probe.status})`).toBe('unavailable');
    expect(probe.latencyMs).toBeNull();
    expect(new Date(probe.checkedAt).toString()).not.toBe('Invalid Date');
    // 零上游(受控计数):locator 不经许可目标;零真实网络由 SafeUpstream 连接前拒绝保证
    expect(rig.requestsSince(baseline), '私网 locator 测速不得产生任何受控上游请求').toBe(0);
    // 测速零副作用(无票/无历史/不物化;api §5)
    expect(sideEffectsOf(rig.householdId)).toEqual(before);
    // 错误不回显目标:私网字面量/ locator 路径零出现在响应(ProbeResult 4 键纯值)
    expect(JSON.stringify(probes)).not.toContain(PRIVATE_LITERAL);
    expect(JSON.stringify(probes)).not.toContain('master.m3u8');
  });

  it('A2 重定向 pivot 候选:受控首跳 302 → 私网字面量,每跳重新校验在目标连接前拒绝(pivot 零请求、错误零回显)', async () => {
    const rig = await startSecurityRig('hmp-t083-a2-');
    const source = await resolveSourceSession(rig);
    const items = await getSwitchCandidatesOk(rig, source);
    const candidate = candidateOfVersion(items, TWIN_LABELS.redirect);
    const baseline = upstreamRequestCount;
    const probes = await postProbesOk(rig, source, [candidate.candidateRef]);
    expect(probes[0]!.status, `重定向 pivot 应 unavailable(实际 ${probes[0]!.status})`).toBe('unavailable');
    expect(probes[0]!.latencyMs).toBeNull();
    // 受控首跳恰好 1 次(302 应答);302 跳向的私网字面量连接前被拒(零请求零网络:
    // 私网目标无服务端可计数,SafeUpstream 类别/许可校验在建连前拒绝)
    expect(rig.requestsSince(baseline), '重定向 pivot 只应消耗受控首跳 1 次请求').toBe(1);
    expect(JSON.stringify(probes), '测速响应不得回显私网目标/跳路径').not.toContain(PRIVATE_LITERAL);
    expect(JSON.stringify(probes)).not.toContain(rig.redirectHopPath);
  });

  it('A3 候选 hang 上游 → 预算内收敛:同单混合「健康+恒挂起」候选,各归其位(reachable/timeout)且总耗时受全次预算约束', async () => {
    const rig = await startSecurityRig('hmp-t083-a3-');
    const source = await resolveSourceSession(rig);
    const items = await getSwitchCandidatesOk(rig, source);
    const healthy = candidateOfVersion(items, TWIN_LABELS.healthy);
    const hang = candidateOfVersion(items, TWIN_LABELS.hang);
    const before = sideEffectsOf(rig.householdId);
    const startedAt = Date.now();
    const probes = await postProbesOk(rig, source, [healthy.candidateRef, hang.candidateRef]);
    const elapsedMs = Date.now() - startedAt;
    // 健康候选 reachable(首响应延迟);挂起候选按单候选 3s 预算收敛为 timeout
    expect(probes[0]!.status, `健康候选应 reachable(实际 ${probes[0]!.status})`).toBe('reachable');
    expect(probes[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(['timeout', 'unavailable'], `挂起候选应预算内收敛(实际 ${probes[1]!.status})`).toContain(probes[1]!.status);
    expect(probes[1]!.latencyMs).toBeNull();
    // 全次 5s 预算(8s 为 CI 抖动上界;超出即预算未生效);单候选 3s 不拖垮同单健康结论
    expect(elapsedMs, `混合测速应预算内返回(实际 ${elapsedMs}ms)`).toBeLessThanOrEqual(8000);
    // 无票/无历史/不物化(api §5)
    expect(sideEffectsOf(rig.householdId), '测速不得写会话/历史/物化/登记/intent/转换').toEqual(before);
  });

  it('A4 测速成功不能绕过目标策略:reachable 后目标策略 block → candidateRef 物化 404(零落库)、原 candidateRef 建 intent 404(未登记;授权族优先)', async () => {
    const rig = await startSecurityRig('hmp-t083-a4-');
    const source = await resolveSourceSession(rig);
    const items = await getSwitchCandidatesOk(rig, source);
    const healthy = candidateOfVersion(items, TWIN_LABELS.healthy);
    // 先证明「测速成功」:未物化目标无策略事实可判,健康上游可达
    const probes = await postProbesOk(rig, source, [healthy.candidateRef]);
    expect(probes[0]!.status, '策略收紧前健康候选应 reachable(测速成功)').toBe('reachable');
    // 目标策略 block(真实 HTTP 策略面;主档案 max 0 + 拒未评级)
    await blockAllContentPolicy(rig);
    // 物化分支:登记前先验目标策略 → 404(授权族优先;零落库)
    const materialize = await request(rig.app.getHttpServer())
      .post(MATERIALIZE_URL)
      .set('Cookie', rig.cookieA)
      .send({ candidateRef: healthy.candidateRef, previewRevision: healthy.previewRevision, operationKey: randomUUID() });
    expectProblem(materialize, 404, ProblemCode.NOT_FOUND);
    expect(
      scalarOf(
        'SELECT COUNT(*) AS n FROM vod_title WHERE household_id = ? AND source_id IN (SELECT id FROM media_source WHERE household_id = ? AND name = ?)',
        rig.householdId,
        rig.householdId,
        rig.sourceLabelB,
      ),
      '策略拒绝物化必须零落库(不得借测速成功放行建目录)',
    ).toBe(0);
    // intent 只接受已登记目标候选:原 candidateRef(未登记)→ 404 同形,零 intent 残留
    const intent = await request(rig.app.getHttpServer())
      .post(INTENTS_URL)
      .set('Cookie', rig.cookieA)
      .send({
        fromSessionId: source.sessionId,
        expectedGeneration: source.generation,
        action: 'switch',
        targetCandidateRef: healthy.candidateRef,
        previewRevision: healthy.previewRevision,
        positionMode: 'beginning',
        confirmedAmbiguous: false,
        expectedSlotRevision: 0,
        operationKey: randomUUID(),
      });
    expectProblem(intent, 404, ProblemCode.NOT_FOUND);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      '被拒 intent 不得残留',
    ).toBe(0);
  });

  it('A5 目标策略 block 时 intent 消费 404 授权族优先:登记物化在前、收紧在后,创建 201 但消费 404 MEDIA_NOT_FOUND 且 intent 保持 pending 零后继', async () => {
    const rig = await startSecurityRig('hmp-t083-a5-');
    const source = await resolveSourceSession(rig);
    const items = await getSwitchCandidatesOk(rig, source);
    const healthy = candidateOfVersion(items, TWIN_LABELS.healthy);
    // 策略放行窗口内完成候选登记物化(201 + registeredCandidateRef)
    const materialize = await request(rig.app.getHttpServer())
      .post(MATERIALIZE_URL)
      .set('Cookie', rig.cookieA)
      .send({ candidateRef: healthy.candidateRef, previewRevision: healthy.previewRevision, operationKey: randomUUID() });
    expect(materialize.status, `候选登记物化应 201(实际 ${JSON.stringify(materialize.body).slice(0, 200)})`).toBe(201);
    const registeredCandidateRef = (materialize.body as { registeredCandidateRef: string | null }).registeredCandidateRef;
    expect(registeredCandidateRef, '登记映射引用应非空(api §7 I1)').toBeTruthy();
    // 目标策略 block(物化之后收紧)
    await blockAllContentPolicy(rig);
    // 意图创建只验登记绑定(不验目标策略)→ 201
    const intent = await request(rig.app.getHttpServer())
      .post(INTENTS_URL)
      .set('Cookie', rig.cookieA)
      .send({
        fromSessionId: source.sessionId,
        expectedGeneration: source.generation,
        action: 'switch',
        targetCandidateRef: registeredCandidateRef!,
        previewRevision: healthy.previewRevision,
        positionMode: 'beginning',
        confirmedAmbiguous: false,
        expectedSlotRevision: 0,
        operationKey: randomUUID(),
      });
    expect(intent.status, `switch intent 创建应 201(实际 ${intent.status} ${JSON.stringify(intent.body).slice(0, 200)})`).toBe(201);
    const intentId = (intent.body as { id: string }).id;
    const targetMediaId = (intent.body as { targetMediaId: string }).targetMediaId;
    // 消费:目标策略 authorizeResolve 先于来源终态等专用错误 → 404 MEDIA_NOT_FOUND(授权族优先)
    // (不先 stop:来源终态资格排在目标授权之后,本断言钉「授权失败优先于专用错误」)
    const consume = await request(rig.app.getHttpServer())
      .post('/api/playback/resolve')
      .set('Cookie', rig.cookieA)
      .send({ mediaId: targetMediaId, transitionIntentId: intentId });
    expectProblem(consume, 404, ProblemCode.MEDIA_NOT_FOUND);
    // 意图未被消费、零后继(pending 保持;slot 不产生 successor)
    const row = Database.db
      .prepare('SELECT status, successor_id AS successorId FROM playback_transition_intent WHERE household_id = ? AND id = ?')
      .get(rig.householdId, intentId) as { status: string; successorId: string | null } | undefined;
    expect(row, '夹具错误:intent 行不存在').toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.successorId).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* B 泄露面(零源地址/零上游 URL/零票据;其他 Profile 零泄漏)              */
/* ------------------------------------------------------------------ */

/** 全链响应收集(候选/预览/物化/resolve/状态;renew 单列 —— 票据仅 renew 合法) */
async function collectChainResponses(rig: SecurityRig, source: SourceSession): Promise<{
  serialized: string;
  renewPlaybackUrl: string;
}> {
  const app = rig.app.getHttpServer();
  const items = await getSwitchCandidatesOk(rig, source);
  const search = await request(app).get(SEARCH_URL).query({ q: 'stardust' });
  expect(search.status).toBe(200);
  const card = (search.body as { items: Array<{ titleRef: string; sourceLabel: string }> }).items.find(
    (item) => item.sourceLabel === rig.sourceLabelA,
  );
  expect(card).toBeDefined();
  const preview = await request(app).get(`/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`);
  expect(preview.status).toBe(200);
  const materialize = await request(app)
    .post(MATERIALIZE_URL)
    .set('Cookie', rig.cookieA)
    .send({
      titleRef: card!.titleRef,
      episodeRef: (preview.body as { lines: Array<{ episodes: Array<{ episodeRef: string }> }> }).lines[0]!.episodes[0]!.episodeRef,
      previewRevision: (preview.body as { previewRevision: number }).previewRevision,
      operationKey: randomUUID(),
    });
  expect([200, 201]).toContain(materialize.status);
  const resolve = await request(app).post('/api/playback/resolve').set('Cookie', rig.cookieA).send({ mediaId: rig.serialA.ep01MediaId });
  expect(resolve.status).toBe(201);
  const sessionId = String(resolve.headers['location']).split('/').pop() ?? '';
  await waitUntilState(rig.app, rig.cookieA, sessionId, 'ready');
  const status = await request(app).get(`/api/playback/sessions/${sessionId}`).set('Cookie', rig.cookieA);
  expect(status.status).toBe(200);
  const renew = await request(app)
    .post(`/api/playback/sessions/${sessionId}/renew`)
    .set('Cookie', rig.cookieA)
    .send({ expectedGeneration: sessionRowOf(sessionId).generation });
  expect(renew.status, 'renew 应 200(发票唯一入口)').toBe(200);
  const playbackUrl = String((renew.body as Record<string, unknown>)['playbackUrl']);
  const serialized = JSON.stringify([items, search.body, preview.body, materialize.body, resolve.body, status.body]) ?? '';
  return { serialized, renewPlaybackUrl: playbackUrl };
}

describe('T083 · B 泄露面(api §0 详细上游错误/地址/凭据不公开;§2 公共面无源位置)', () => {
  it('B1 候选/搜索/预览/物化/resolve/状态响应零源地址、零上游 URL/路径、零票据;票据仅 renew 返回且为同源流路径', async () => {
    const rig = await startSecurityRig('hmp-t083-b1-');
    const source = await resolveSourceSession(rig);
    const { serialized, renewPlaybackUrl } = await collectChainResponses(rig, source);
    const markers = [
      rig.server.baseUrl, // 上游 origin(http://127.0.0.1:<port>)
      'api.php',
      '/t083-src-a',
      '/t083-src-b',
      '/vod/hls/t083',
      PRIVATE_LITERAL,
      rig.redirectHopPath,
      rig.hangPath,
      'ticket=',
    ];
    for (const marker of markers) {
      expect(serialized, `全链公共响应不得包含「${marker}」`).not.toContain(marker);
    }
    // opaque ref 不可解码为 URL(api §0「所有私有 opaque ref 不能携带可解码 URL」)
    expect(serialized).not.toMatch(/https?:\/\//);
    // 票据仅 renew:playbackUrl 为同源流路径 + ticket(本设备合法票据),不是上游地址
    expect(renewPlaybackUrl.startsWith('/api/playback/stream/'), `renew 票据应为同源流路径(实际 ${renewPlaybackUrl})`).toBe(true);
    expect(renewPlaybackUrl).toContain('ticket=');
    expect(renewPlaybackUrl).not.toContain(rig.server.baseUrl);
  });

  it('B2 其他 Profile 零泄漏:游客公共面无个人字段;跨 Profile 的进度/历史/偏好互不可见(A 写入后 B 三 null/空/默认)', async () => {
    const rig = await startSecurityRig('hmp-t083-b2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    // A(设备A · 主档案):真实进度 + 偏好变更
    const source = await resolveSourceSession(rig);
    const progress = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${source.sessionId}/progress`)
      .set('Cookie', rig.cookieA)
      .send({ sampleSeq: 1, expectedGeneration: source.generation, positionSeconds: 60, reason: 'started' });
    expect(progress.status).toBe(200);
    expect((progress.body as Record<string, unknown>)['sessionAccepted']).toBe(true);
    const prefA = await request(rig.app.getHttpServer())
      .patch('/api/me/vod/preferences')
      .set('Cookie', rig.cookieA)
      .send({ expectedVersion: 0, autoplayNext: false, operationKey: randomUUID() });
    expect(prefA.status, `A 偏好更新应 200(实际 ${JSON.stringify(prefA.body).slice(0, 160)})`).toBe(200);

    // 游客:公共面(搜索/预览)无任何个人字段/历史痕迹
    const guestSearch = await request(rig.app.getHttpServer()).get(SEARCH_URL).query({ q: 'stardust' });
    expect(guestSearch.status).toBe(200);
    const guestSerialized = JSON.stringify(guestSearch.body) ?? '';
    for (const marker of ['profileId', 'accountId', 'householdId', 'positionSeconds', 'history', 'favorites', 'ticket=', 'resumePosition']) {
      expect(guestSerialized, `游客搜索不得包含「${marker}」`).not.toContain(marker);
    }

    // 跨 Profile:第二档案(儿童)经真实 Settings API 创建,设备B 切换
    const created = await createProfileViaSettings(rig.app, rig.cookieA, { name: '儿童', type: 'child', pin: '246800' });
    expect(created.status).toBe(201);
    const profileBId = (created.body as { id: string }).id;
    expect((await request(rig.app.getHttpServer()).post(`/api/profiles/${profileBId}/unlock`).set('Cookie', rig.cookieB).send({ pin: '246800' })).status).toBe(200);
    expect((await request(rig.app.getHttpServer()).post(`/api/profiles/${profileBId}/select`).set('Cookie', rig.cookieB).send({})).status).toBe(200);

    // B 视角:同父项进度三 null(不泄 A 的 latest/位置);历史为空;偏好默认值
    const progressB = await request(rig.app.getHttpServer())
      .get(`/api/me/vod/titles/${rig.serialA.parentMediaId}/progress`)
      .set('Cookie', rig.cookieB);
    expect(progressB.status).toBe(200);
    expect(progressB.body).toEqual({ latest: null, resumeCandidate: null, nextEpisodeAction: null });
    const historyB = await request(rig.app.getHttpServer()).get('/api/me/history').set('Cookie', rig.cookieB);
    expect(historyB.status).toBe(200);
    expect((historyB.body as { items: unknown[] }).items, 'B 的历史不得出现 A 的记录').toHaveLength(0);
    const prefB = await request(rig.app.getHttpServer()).get('/api/me/vod/preferences').set('Cookie', rig.cookieB);
    expect(prefB.status).toBe(200);
    expect(prefB.body).toEqual({ autoplayNext: true, switchCarryPosition: true, version: 0 });
    // A 自身事实仍在(A 视角不回归)
    const progressA = await request(rig.app.getHttpServer())
      .get(`/api/me/vod/titles/${rig.serialA.parentMediaId}/progress`)
      .set('Cookie', rig.cookieA);
    expect(progressA.status).toBe(200);
    expect((progressA.body as { latest: unknown }).latest, 'A 自身进度应可见(隔离而非丢失)').not.toBeNull();
    const historyA = await request(rig.app.getHttpServer()).get('/api/me/history').set('Cookie', rig.cookieA);
    expect((historyA.body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(1);
  });

  it('B3 错误响应零内部 detail:伪造/禁源失效/未知字段各形态 problem 键白名单,detail 静态且零上游地址/源行 ID/堆栈', async () => {
    const rig = await startSecurityRig('hmp-t083-b3-');
    const app = rig.app.getHttpServer();
    const markers = [rig.server.baseUrl, 'api.php', '/t083-src', PRIVATE_LITERAL, 'source', 'SELECT', 'stack'];
    const search = await request(app).get(SEARCH_URL).query({ q: 'stardust' });
    expect(search.status).toBe(200);
    const card = (search.body as { items: Array<{ titleRef: string; sourceLabel: string }> }).items.find(
      (item) => item.sourceLabel === rig.sourceLabelA,
    );
    expect(card, '应取源A 卡片(禁源 410 面素材)').toBeDefined();
    const titleRef = card!.titleRef;

    // 伪造 ref → 404(与不存在同形;零内部细节)
    const forged = await request(app).get(`/api/public/vod/titles/${encodeURIComponent(`vod-title-${randomUUID()}`)}`);
    expectProblem(forged, 404, ProblemCode.NOT_FOUND);
    expectSanitizedProblem(forged, markers, '伪造 ref 404');

    // 未知字段 → 400(detail 仅指向字段名)
    const unknownField = await request(app).get(SEARCH_URL).query({ q: 'stardust', profileId: randomUUID() });
    expectProblem(unknownField, 400, ProblemCode.VALIDATION_FAILED);
    expectSanitizedProblem(unknownField, markers, '未知字段 400');

    // 禁源(DB 直改工厂事实)后旧 ref → 410:先失效缓存再拒绝旧页,零内部细节
    const sourceRow = Database.db
      .prepare('SELECT id FROM media_source WHERE household_id = ? AND name = ?')
      .get(rig.householdId, rig.sourceLabelA) as { id: string } | undefined;
    expect(sourceRow, '夹具错误:源A 行不存在').toBeDefined();
    disableSource(sourceRow!.id);
    const expired = await request(app).get(`/api/public/vod/titles/${encodeURIComponent(titleRef)}`);
    expectProblem(expired, 410, 'VOD_PREVIEW_EXPIRED');
    expectSanitizedProblem(expired, markers, '禁源失效 410');
  });
});

/* ------------------------------------------------------------------ */
/* C 未知字段/大体积                                                     */
/* ------------------------------------------------------------------ */

describe('T083 · C 未知字段/大体积(api §0 JSON 未知字段拒绝 + 写 body<=16KiB;§2 单详情 4MiB 422)', () => {
  it('C1 各新端点未知字段一律 400(含伪造 profileId/任意 URL 字段),拒绝路径零副作用', async () => {
    const rig = await startSecurityRig('hmp-t083-c1-');
    const app = rig.app.getHttpServer();
    const source = await resolveSourceSession(rig);
    const before = sideEffectsOf(rig.householdId);
    const faces: request.Test[] = [
      // 公共搜索/预览:未知 query 字段(伪造身份声明/任意 URL)
      request(app).get(SEARCH_URL).query({ q: 'x', householdId: rig.householdId }),
      request(app).get(`/api/public/vod/titles/forged`).query({ upstreamVodId: '1' }),
      // 物化:伪造身份声明
      request(app).post(MATERIALIZE_URL).set('Cookie', rig.cookieA).send({
        titleRef: 't1-forged',
        episodeRef: 'e1-forged',
        previewRevision: 1,
        operationKey: randomUUID(),
        profileId: rig.profileAId,
      }),
      // 候选:任意 q/URL 一律拒绝(服务端只从可信标题构造搜索)
      request(app)
        .get(CANDIDATES_URL)
        .query({ fromSessionId: source.sessionId, expectedGeneration: source.generation, url: 'http://127.0.0.1:9/x' })
        .set('Cookie', rig.cookieA),
      // 测速:任意 URL 字段(不接受客户端定位)
      request(app).post(PROBES_URL).set('Cookie', rig.cookieA).send({
        fromSessionId: source.sessionId,
        expectedGeneration: source.generation,
        candidateRefs: ['x'],
        locatorUrl: 'http://127.0.0.1:9/master.m3u8',
      }),
      // 意图:伪造身份声明
      request(app).post(INTENTS_URL).set('Cookie', rig.cookieA).send({
        fromSessionId: source.sessionId,
        expectedGeneration: source.generation,
        action: 'switch',
        targetCandidateRef: 'x',
        previewRevision: 1,
        positionMode: 'beginning',
        confirmedAmbiguous: false,
        expectedSlotRevision: 0,
        operationKey: randomUUID(),
        householdId: rig.householdId,
      }),
    ];
    for (const face of faces) {
      const res = await face;
      expectProblem(res, 400, ProblemCode.VALIDATION_FAILED);
    }
    // 拒绝路径零副作用:物化/登记/intent 副本与 sweep 前一致(rig 物化基线之上零新增)
    const after = sideEffectsOf(rig.householdId);
    expect(after.materializations, '未知字段拒绝零物化 operation 写入').toBe(before.materializations);
    expect(after.registeredCandidates, '未知字段拒绝零登记候选写入').toBe(before.registeredCandidates);
    expect(after.intents, '未知字段拒绝零 intent 写入').toBe(before.intents);
  });

  it('C2 写体 >16KiB 一律 400(物化/测速/意图三端点;守卫先于语义,零写入)', async () => {
    const rig = await startSecurityRig('hmp-t083-c2-');
    const app = rig.app.getHttpServer();
    const source = await resolveSourceSession(rig);
    const before = sideEffectsOf(rig.householdId);
    const bigPad = 'x'.repeat(17 * 1024);
    const faces: Array<[string, request.Test]> = [
      [
        'materializations',
        request(app).post(MATERIALIZE_URL).set('Cookie', rig.cookieA).send({
          titleRef: `t1-${bigPad}`,
          episodeRef: 'e1',
          previewRevision: 1,
          operationKey: randomUUID(),
        }),
      ],
      [
        'switch-probes',
        request(app).post(PROBES_URL).set('Cookie', rig.cookieA).send({
          fromSessionId: source.sessionId,
          expectedGeneration: source.generation,
          candidateRefs: [bigPad],
        }),
      ],
      [
        'transition-intents',
        request(app).post(INTENTS_URL).set('Cookie', rig.cookieA).send({
          fromSessionId: source.sessionId,
          expectedGeneration: source.generation,
          action: 'switch',
          targetCandidateRef: bigPad,
          previewRevision: 1,
          positionMode: 'beginning',
          confirmedAmbiguous: false,
          expectedSlotRevision: 0,
          operationKey: randomUUID(),
        }),
      ],
    ];
    for (const [label, face] of faces) {
      const res = await face;
      expectProblem(res, 400, ProblemCode.VALIDATION_FAILED);
      expect(
        JSON.stringify(res.body),
        `${label} 超预算拒绝体不得回显体内容`,
      ).not.toContain('x'.repeat(64));
    }
    // 守卫拒绝先于语义:零写入(与 sweep 前副本一致)
    const after = sideEffectsOf(rig.householdId);
    expect(after.materializations).toBe(before.materializations);
    expect(after.intents).toBe(before.intents);
  });

  it('C3 大详情 422 VOD_DETAIL_TOO_LARGE:上游详情体超 4MiB 读预算 → 整次失败,零标题绑定残留,错误体零内部细节', async () => {
    const rig = await startSecurityRig('hmp-t083-c3-');
    const app = rig.app.getHttpServer();
    const search = await request(app).get(SEARCH_URL).query({ q: 'bigdetail' });
    expect(search.status, `大详情世界检索应 200(brief 正常;实际 ${JSON.stringify(search.body).slice(0, 160)})`).toBe(200);
    const card = (search.body as { items: Array<{ titleRef: string; sourceLabel: string }> }).items.find(
      (item) => item.sourceLabel === rig.sourceLabelB,
    );
    expect(card, '大详情世界应出现在源B 检索结果').toBeDefined();
    const preview = await request(app).get(`/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`);
    // 超体积整次失败(api §2/§6 错误收敛:不降级部分结果)
    expectProblem(preview, 422, 'VOD_DETAIL_TOO_LARGE');
    expectSanitizedProblem(preview, [rig.server.baseUrl, 'api.php', PRIVATE_LITERAL], '大详情 422');
    // 整次失败:预览事实零残留(标题绑定停留在搜索登记态,未推进 title-preview),
    // 同 ref 物化入口 410 VOD_PREVIEW_EXPIRED(无可物化的预览事实;T031 同形)
    const materialize = await request(app)
      .post(MATERIALIZE_URL)
      .set('Cookie', rig.cookieA)
      .send({ titleRef: card!.titleRef, episodeRef: 'e1-forged', previewRevision: 1, operationKey: randomUUID() });
    expectProblem(materialize, 410, 'VOD_PREVIEW_EXPIRED');
  });
});

/* ------------------------------------------------------------------ */
/* D 限流桶端到端(api §0:搜索 20/观测 120/测速 10/过渡 intent 10)         */
/* ------------------------------------------------------------------ */

describe('T083 · D 限流桶端到端(受控快发;桶隔离;progress 60/min 已由 rate-limit-evidence 钉面)', () => {
  it('D1 在线搜索 20/min/IP:第 21 发 429+Retry-After(≤60)+no-store;跨桶隔离:公共查询桶(public 120)不受牵连', async () => {
    const rig = await startSecurityRig('hmp-t083-d1-');
    const app = rig.app.getHttpServer();
    let sawLimited = false;
    // 注:rig 物化已消耗 1 发搜索;循环内第 20 发即全局第 21 发 → 触桶
    for (let index = 1; index <= 20; index += 1) {
      // 同 q 快发:重放路径不重抓上游,限频桶在守卫层照常计数(搜索 20/min/IP)
      const res = await request(app).get(SEARCH_URL).query({ q: 'stardust' });
      if (index <= 19) {
        expect(res.status, `全局第 ${index + 1} 发搜索应在桶内 200(实际 ${res.status})`).toBe(200);
      } else {
        sawLimited = res.status === 429;
        if (sawLimited) {
          expectProblem(res, 429, ProblemCode.PLAYBACK_RATE_LIMITED);
          const retryAfter = Number(res.headers['retry-after']);
          expect(Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After 应为 1..60 秒(实际 ${res.headers['retry-after']})`).toBe(true);
          expect(res.headers['cache-control']).toBe('no-store');
        }
      }
    }
    expect(sawLimited, '全局第 21 发搜索必须触发 429(20/min/IP 桶)').toBe(true);
    // 跨桶隔离:同一 IP 上公共查询桶独立(搜索桶耗尽可能不牵连 public 桶)
    const media = await request(app).get('/api/public/media?pageSize=1');
    expect(media.status, '搜索桶耗尽可能不牵连 public 查询桶(独立桶)').toBe(200);
  });

  it('D2 phase 观测 120/min/session:第 121 发 429+Retry-After;桶隔离:另一播放会话(新键)观测不受牵连', async () => {
    const rig = await startSecurityRig('hmp-t083-d2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const app = rig.app.getHttpServer();
    const source = await resolveSourceSession(rig);
    const payloadOf = (eventSeq: number): Record<string, unknown> => ({
      eventSeq,
      expectedGeneration: source.generation,
      event: 'pause',
      positionSeconds: 0,
      playbackRate: 1,
    });
    let sawLimited = false;
    for (let eventSeq = 1; eventSeq <= 121; eventSeq += 1) {
      const res = await request(app)
        .post(`/api/playback/sessions/${source.sessionId}/observations`)
        .set('Cookie', rig.cookieA)
        .send(payloadOf(eventSeq));
      if (eventSeq <= 120) {
        expect(res.status, `第 ${eventSeq} 发观测应在桶内 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 120)})`).toBe(200);
      } else {
        sawLimited = res.status === 429;
        if (sawLimited) {
          expectProblem(res, 429, ProblemCode.PLAYBACK_RATE_LIMITED);
          const retryAfter = Number(res.headers['retry-after']);
          expect(Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After 应为 1..60 秒(实际 ${res.headers['retry-after']})`).toBe(true);
        }
      }
    }
    expect(sawLimited, '第 121 发观测必须触发 429(120/min/session 桶)').toBe(true);
    // 桶隔离:停掉旧会话,新 resolve 产生新播放会话(新桶键)→ 观测照常 200
    expect((await request(app).post(`/api/playback/sessions/${source.sessionId}/stop`).set('Cookie', rig.cookieA).send({})).status).toBe(204);
    const next = await resolveSourceSession(rig);
    const isolated = await request(app)
      .post(`/api/playback/sessions/${next.sessionId}/observations`)
      .set('Cookie', rig.cookieA)
      .send({ eventSeq: 1, expectedGeneration: next.generation, event: 'pause', positionSeconds: 0, playbackRate: 1 });
    expect(isolated.status, '新播放会话观测不得被旧会话桶牵连(会话级隔离)').toBe(200);
  });

  it('D3 测速桶 10/min/DeviceSession:守卫先于授权(被拒请求同耗桶),第 11 发 429+Retry-After;跨设备隔离(设备B 新桶)', async () => {
    const rig = await startSecurityRig('hmp-t083-d3-');
    const app = rig.app.getHttpServer();
    const requestOf = (cookie: string, fromSessionId: string): request.Test =>
      request(app)
        .post(PROBES_URL)
        .set('Cookie', cookie)
        .send({ fromSessionId, expectedGeneration: 1, candidateRefs: ['x'] });
    let sawLimited = false;
    for (let index = 1; index <= 11; index += 1) {
      const res = await requestOf(rig.cookieA, randomUUID());
      if (index <= 10) {
        // 计数点=通过守卫的请求(含随后被授权拒绝者,防绕过):前 10 发授权 404
        expectProblem(res, 404, ProblemCode.PLAYBACK_NOT_FOUND);
      } else {
        sawLimited = res.status === 429;
        if (sawLimited) {
          expectProblem(res, 429, ProblemCode.PLAYBACK_RATE_LIMITED);
          const retryAfter = Number(res.headers['retry-after']);
          expect(Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After 应为 1..60 秒(实际 ${res.headers['retry-after']})`).toBe(true);
        }
      }
    }
    expect(sawLimited, '第 11 发测速必须触发 429(10/min/DeviceSession 桶)').toBe(true);
    // 桶隔离:设备B(另一 DeviceSession)独立桶 → 同请求走授权面 404(而非 429)
    const deviceB = await requestOf(rig.cookieB, randomUUID());
    expectProblem(deviceB, 404, ProblemCode.PLAYBACK_NOT_FOUND);
  });

  it('D4 过渡 intent 桶 10/min/DeviceSession:第 11 发 429 PLAYBACK_RATE_LIMITED(秒数进 detail);跨桶隔离:progress 桶不受过渡桶牵连', async () => {
    const rig = await startSecurityRig('hmp-t083-d4-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const app = rig.app.getHttpServer();
    // 先建立可用播放会话(progress 对照面)
    const source = await resolveSourceSession(rig);
    const firstProgress = await request(app)
      .post(`/api/playback/sessions/${source.sessionId}/progress`)
      .set('Cookie', rig.cookieA)
      .send({ sampleSeq: 1, expectedGeneration: source.generation, positionSeconds: 0, reason: 'started' });
    expect(firstProgress.status).toBe(200);
    let sawLimited = false;
    for (let index = 1; index <= 11; index += 1) {
      const res = await request(app)
        .post(INTENTS_URL)
        .set('Cookie', rig.cookieA)
        .send({
          fromSessionId: randomUUID(),
          expectedGeneration: 1,
          action: 'switch',
          targetCandidateRef: 'x',
          previewRevision: 1,
          positionMode: 'beginning',
          confirmedAmbiguous: false,
          expectedSlotRevision: 0,
          operationKey: randomUUID(),
        });
      if (index <= 10) {
        expectProblem(res, 404, ProblemCode.PLAYBACK_NOT_FOUND);
      } else {
        sawLimited = res.status === 429;
        if (sawLimited) {
          expectProblem(res, 429, ProblemCode.PLAYBACK_RATE_LIMITED);
          // 注记:T060 面把 Retry-After 秒数承载于 detail(控制器无动态头注入;
          // api §0「429+Retry-After」的响应头缺口归限频装配面收口,不属本文件语义)
          expect(JSON.stringify(res.body), '429 体应携带限频窗口秒数(恢复动作)').toMatch(/限频/);
        }
      }
    }
    expect(sawLimited, '第 11 发 intent 必须触发 429(10/min/DeviceSession 过渡桶)').toBe(true);
    // 跨桶隔离:progress 控制桶(60/min/DeviceSession)独立 → 照常接受
    const secondProgress = await request(app)
      .post(`/api/playback/sessions/${source.sessionId}/progress`)
      .set('Cookie', rig.cookieA)
      .send({ sampleSeq: 2, expectedGeneration: source.generation, positionSeconds: 30, reason: 'periodic' });
    expect(secondProgress.status, '过渡桶耗尽可能不牵连 progress 桶(独立桶)').toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* E 缓存全局上限与 ref 失效(api §2:进程 256MiB/TTL 10min;env 只许收紧)   */
/* ------------------------------------------------------------------ */

/** 预算 env 注入(DI 解析期读 process.env;用例后恢复;T022 E6 同手法) */
const injectedEnvKeys: string[] = [];
function injectVodEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
    injectedEnvKeys.push(key);
  }
}

describe('T083 · E 缓存全局上限与 ref 失效(api §2 缓存段;淘汰排序语义引用 search-preview 单测 C1/C2)', () => {
  it('E1 进程缓存上限触达(env 收窄 128B)→ 搜索 429 VOD_CACHE_CAPACITY:资源忙拒绝、零上游写放大、错误体脱敏', async () => {
    injectVodEnv({ VOD_CACHE_MAX_TOTAL_BYTES: '128' });
    const rig = await startSecurityRig('hmp-t083-e1-', { skipMaterialize: true });
    const res = await request(rig.app.getHttpServer()).get(SEARCH_URL).query({ q: 'stardust' });
    // 会话/标题绑定入账超收窄上限 → 拒绝服务(资源忙 429),不堆无界队列
    expectProblem(res, 429, 'VOD_CACHE_CAPACITY');
    expect(res.headers['cache-control']).toBe('no-store');
    expectSanitizedProblem(res, [rig.server.baseUrl, 'api.php'], '缓存上限 429');
  });

  it('E2 ref 失效面:伪造搜索游标/searchId → 410 VOD_SEARCH_EXPIRED 与预览伪造 404 同形区分;缓存失效后不复活(禁源旧 ref 410 见 B3,不重复)', async () => {
    const rig = await startSecurityRig('hmp-t083-e2-');
    const app = rig.app.getHttpServer();
    const search = await request(app).get(SEARCH_URL).query({ q: 'stardust' });
    expect(search.status).toBe(200);
    const page = search.body as { searchId: string; nextCursor: string | null };
    // 伪造游标/未知 searchId → 410(保留 q 重新搜索;不与伪造 404 混同)
    const forgedCursor = await request(app).get(SEARCH_URL).query({ searchId: page.searchId, cursor: `c1-${randomUUID()}` });
    expectProblem(forgedCursor, 410, 'VOD_SEARCH_EXPIRED');
    const unknownSearchId = await request(app).get(SEARCH_URL).query({ searchId: `s1-${randomUUID()}` });
    expectProblem(unknownSearchId, 410, 'VOD_SEARCH_EXPIRED');
    expectSanitizedProblem(forgedCursor, [rig.server.baseUrl, 'api.php'], '伪造游标 410');
    // 伪造预览 ref 与 410 同面区分:未签发 → 404(TTL 推进面引用 search-preview 单测 A8/B3)
    const forgedPreview = await request(app).get(`/api/public/vod/titles/${encodeURIComponent(`t1-${randomUUID()}`)}`);
    expectProblem(forgedPreview, 404, ProblemCode.NOT_FOUND);
  });
});

/* ------------------------------------------------------------------ */
/* F ffmpeg 面(T044 语义端到端:在线面零转换启动,交付走 SafeUpstream)      */
/* ------------------------------------------------------------------ */

describe('T083 · F ffmpeg 在线面(api §0;T044「ffmpeg 不直接任意上游联网」;supervisor 裁决引用 vod-delivery-input F1)', () => {
  it('F1 在线播放全链零 ffmpeg 转换:resolve→ready→renew→流交付全程 playback_conversion 零行、交付非转换族,清单经同源流路径重写(上游地址零下发)', async () => {
    const rig = await startSecurityRig('hmp-t083-f1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const app = rig.app.getHttpServer();
    const source = await resolveSourceSession(rig);
    const session = sessionRowOf(source.sessionId);
    // 在线 vod 交付为固定输入(非 ffmpeg 转换族)
    expect(['remux', 'audio_transcode', 'video_transcoding', 'video_transcode']).not.toContain(session.delivery);
    // renew 取票 → 同源流路径
    const renew = await request(app)
      .post(`/api/playback/sessions/${source.sessionId}/renew`)
      .set('Cookie', rig.cookieA)
      .send({ expectedGeneration: source.generation });
    expect(renew.status).toBe(200);
    const playbackUrl = String((renew.body as Record<string, unknown>)['playbackUrl']);
    expect(playbackUrl.startsWith('/api/playback/stream/')).toBe(true);
    // 流入口:经 hls-proxy SafeUpstream 交付(受控上游计数增加),清单重写为同源路径
    const master = await request(app).get(playbackUrl).set('Cookie', rig.cookieA);
    expect(master.status, `流入口应 200(实际 ${master.status})`).toBe(200);
    expect(String(master.text).startsWith('#EXTM3U'), '流入口应返回 HLS 清单').toBe(true);
    expect(String(master.text), '重写清单不得包含上游地址').not.toContain(rig.server.baseUrl);
    expect(rig.requestsSince(0), '在线交付应经过受控上游(SafeUpstream 读取,非 ffmpeg)').toBeGreaterThan(0);
    // 全链 ffmpeg 转换零启动:本会话/本家庭转换行恒 0(在线固定输入不经转换监督者)
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_conversion WHERE household_id = ?', rig.householdId),
      '在线面不得出现任何 ffmpeg 转换任务行',
    ).toBe(0);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_conversion WHERE session_id = ?', source.sessionId),
      '本会话转换行恒 0',
    ).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 收尾:env 注入恢复(每文件级;vitest worker 进程隔离兜底)               */
/* ------------------------------------------------------------------ */

afterEach(() => {
  for (const key of injectedEnvKeys.splice(0)) {
    delete process.env[key];
  }
});
