import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import type { Vod } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import {
  mediaItem,
  mediaRelation,
  mediaSource,
  vodDetailSnapshot,
  vodEpisode,
  vodEpisodeSequence,
  vodLine,
  vodSourceConfig,
  vodTitle,
} from '@platform/database/schema';
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
import type { MediaRequestContext } from '../fixtures/controlled-media-server';
import { MANAGEMENT_OWNER_PASSWORD, selectMainAndUnlockSettings } from '../helpers-management';
import {
  buildAppleCmsListDocument,
  createFixtureTitleWorld,
  createFixtureVodSource,
  createHealthyAlphaSource,
  createHealthyBetaSource,
  createStandardEpisodePresentation,
  createStandaloneMovieWorld,
  findUpstreamRoute,
  FIXTURE_UPSTREAM_DEFAULT_API_PATH,
  type AppleCmsListDocument,
  type AppleCmsVodItem,
  type FixtureTitleWorld,
  type FixtureUpstreamRoute,
  type FixtureUpstreamSource,
} from '../fixtures/online-vod/fixture-upstream';
import { seedPlaybackWorld } from '../fixtures/playback';

/**
 * T022(010-online-vod · US1 测试先行):Settings vod 配置/测试/启停、公共
 * search/preview/media/episodes 及 /vod/materializations 全接口契约面 ——
 * 验证首次 201 / 重放 200 / 过期 410 / 变更 409 / 超限 422,以及公共响应
 * 零个人字段、零源位置(api.md §2/§3 逐行成为断言)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §2(Settings 及公共接口表+缓存段)、
 *   §3(物化和个人接口表+幂等段)、§6(问题码与恢复动作)、§7 I1(候选物化);
 * - docs/specs/010-online-vod/contracts/openapi.yaml 对应 paths(/settings/sources*、
 *   /public/vod/search、/public/vod/titles/{titleRef}、/public/media*、
 *   /vod/materializations)与 schemas(SearchPage/PublicVodCard/VodPreview/
 *   Materialized/StableEpisodes/Source/SourceTestResult,additionalProperties:false
 *   → 键集合精确断言);
 * - docs/specs/010-online-vod/tasks.md T022 条目(依赖 T021 已落地)。
 *
 * 装配方式(完全沿用既有 contract rig 惯例,不改共享 rig/helpers/fixtures):
 * - Nest TestingModule 真实装配 AppModule + Supertest 真实 HTTP(startFreshApp:
 *   os.tmpdir 随机 DATA_DIR + 全量权威迁移,0007_online_vod 表随迁移就绪);
 * - 上游 mock:仓库既有 e2e 先例是受控本地 HTTP(sources-refresh/settings-management
 *   同款 createControlledMediaServer,127.0.0.1 随机端口),无 vi.mock 先例 —— 本文件
 *   在 CMS API 路径上挂一个 raw 路由,以 fixture-upstream 的路由表(findUpstreamRoute,
 *   按 pathname+query 子集匹配,host 不参与)派发 Apple CMS v10 JSON 响应;同一端口
 *   上多源按 apiPath 路径命名空间互不串扰(T031 rig 接线:每源一个 pathname,
 *   behavior=timeout 的挂起源整路径挂起由服务端上游预算判 timeout);timeout 形态
 *   路由以「挂起不回包」表达;批量/重复身份世界以整列表文档覆盖(listDocOverrides)
 *   提供上游全量条目;运行期许可沿用 sources-refresh 的
 *   LAN_ALLOWED_TARGETS='127.0.0.1' 注入;全程不发任何真实外网请求;
 * - 来源/目录种子:kind=vod 的 media_source+vod_source_config 与 vod_title/line/
 *   episode/detail/sequence 行为本文件内自建 seed 包装直插(等价「工厂事实」,
 *   对齐 T021 的 DB 直改口径,逐处注明);Settings HTTP 创建路径(A 组)按契约钉住;
 * - VOD 预算 env(超时/配额)经 process.env 注入(loadVodRuntimeConfig 读
 *   process.env;env 只许收紧不许放大,T019 vod-config 语义),afterEach 统一清除。
 *
 * ───────────────────────── 计划内红清单(失败不跳过)─────────────────────────
 * T022 要求测试先行:「先观察合理失败,再实现并转绿,不用 skip 掩盖未实现」。
 * 以下用例钉 010 契约目标面,当前因端点/分支未装配而失败,失败形态均为
 * 「路由 404(Nest Cannot GET 缺省)」「kind=vod 被 schema 枚举先拒(400)」
 * 或「vod PATCH 语义未实现(locator_revision 不递增/根地址未拒绝)」:
 *
 * | 用例  | 端点/分支                                     | 当前失败形态           | 转绿任务 |
 * | ----- | --------------------------------------------- | ---------------------- | -------- |
 * | A1    | POST /settings/sources kind=vod 合法 201+capabilities | 400 枚举先拒   | T026 |
 * | A2    | POST kind=vod 缺 remoteUrl → 400(detail 指向 remoteUrl)| detail 指向 kind | T026 |
 * | A3    | POST kind=vod remoteUrl 内网 → 422 SOURCE_TARGET_DENIED | 400 枚举先拒 | T026 |
 * | A4    | PATCH vod 来源根地址字段 → 400                | 422(旧换地址语义) | T026 |
 * | A6    | PATCH 启停 → locator_revision+1(启停均失效防 ABA)     | 200 但 locator 不动 | T026 |
 * | A7    | POST /settings/sources/:id/test → 200 SourceTestResult | 404 路由未装配 | T025+T026 |
 * | A8    | 第 11 个启用 vod 源 → 409 VOD_QUOTA_EXCEEDED  | 400 枚举先拒   | T026 |
 * | B1–B8 | GET /public/vod/search(SearchPage/翻页重放/互斥/部分失败/502/504/去重/cookie 无关) | 404 路由未装配 | T028+T031 |
 * | C1–C4 | GET /public/vod/titles/:ref(VodPreview/伪造 404/禁源 410/超限 422/不物化) | 404 路由未装配 | T028+T031 |
 * | D3–D5 | GET /public/media/:id/episodes(非父 400/StableEpisodes/每页 100/修订绑定 cursor/409) | 404 路由未装配 | T030+T031 |
 * | E1–E8 | POST /vod/materializations(首次 201/重放 200/异摘要 409/过期 410/变更 409/净配额 409/candidateRef 分支/游客 401/无 Profile 403) | 404 路由未装配(链路用例先在 search/preview 门失败) | T029+T031(链路另需 T028) |
 *
 * 绿基线(可实现面,010 增量落地不得回归):
 * - A5(vod 来源改名 200 version+1 且 locator_revision 不动 —— 既有 PATCH 通路);
 * - D1/D2(既有 GET /public/media、/public/media/:id 投影;010 只许加字段不许改行为);
 * - F1–F3(新端点复用的同栈守卫次序:游客 401 先于 403、伪造 profileId 400;
 *   新端点本体在未装配期以「401 或路由级 Cannot-GET 404」双态断言,T031 装配后
 *   自动收紧为 401/403 次序,无需改动本文件)。
 *
 * candidateRef 正向链(候选分支 201 + registeredCandidateRef)依赖 US4 换源签发
 * 候选(T067/T070),不在 US1 可达面内;本文件按 T022 范围以「candidateRef 请求
 * 分支 oneOf 被接受 + 无绑定/伪造候选 404 同形(候选绑定冲突,openapi
 * NotFound404)+ 普通分支两引用为 null」钉住(E1/E7),正向登记映射归 T024。
 */

/* ------------------------------------------------------------------ */
/* 契约类型与断言助手                                                   */
/* ------------------------------------------------------------------ */

type SearchPageDto = Vod.components['schemas']['SearchPage'];
type VodPreviewDto = Vod.components['schemas']['VodPreview'];
type MaterializedDto = Vod.components['schemas']['Materialized'];
type StableEpisodesDto = Vod.components['schemas']['StableEpisodes'];
type SourceTestResultDto = Vod.components['schemas']['SourceTestResult'];
type PublicVodCardDto = Vod.components['schemas']['PublicVodCard'];

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** additionalProperties:false 的 DTO 键集合精确断言(null 字段也要在场) */
function expectExactKeys(value: unknown, keys: readonly string[], label: string): void {
  expect(value, `${label} 应为对象`).toBeTypeOf('object');
  expect(Array.isArray(value), `${label} 不应为数组`).toBe(false);
  expect(
    Object.keys(value as Record<string, unknown>).sort(),
    `${label} 键集合(openapi additionalProperties:false)`,
  ).toEqual([...keys].sort());
}

/** 公共/个人响应内不得出现的个人痕迹词面(T021 同表) */
const PERSONAL_MARKERS = [
  'profileId',
  'accountId',
  'householdId',
  'sessionToken',
  'pinHash',
  'favorites',
  'positionSeconds',
  'resumePosition',
  'ticket=',
] as const;

/** 公共响应内不得出现的源位置/上游配置痕迹(api.md §0「详细上游错误/地址/凭据
 *  不公开」「私有 opaque ref 不能携带可解码 URL」;sourceLabel 展示名不在此列) */
const UPSTREAM_LOCATION_MARKERS = [
  '127.0.0.1',
  '192.0.2.',
  'api.php',
  'remoteUrl',
  'remote_url',
  'playlistUri',
  '.m3u8',
  'upstreamVodId',
  'upstream_vod_id',
  'http://',
  'https://',
] as const;

function expectNoMarkers(res: request.Response, markers: readonly string[], label: string): void {
  const serialized = JSON.stringify(res.body) ?? '';
  for (const marker of markers) {
    expect(serialized, `${label} 不得包含「${marker}」`).not.toContain(marker);
  }
}

function expectNoPersonalMarkers(res: request.Response, label: string): void {
  expectNoMarkers(res, PERSONAL_MARKERS, label);
}

function expectNoSourceLocation(res: request.Response, label: string): void {
  expectNoMarkers(res, UPSTREAM_LOCATION_MARKERS, label);
}

/**
 * 端点契约应答门(计划内红的统一判据):
 * - 路由级缺省 404(detail 含「Cannot GET」)→ 以计划内红错误失败(附转绿任务号),
 *   不静默跳过;转绿后该分支不再触发;
 * - 其余状态必须落在契约状态集合内。
 */
function expectEndpointResUnderContract(
  res: request.Response,
  contractStatuses: readonly number[],
  label: string,
  greenTasks: string,
): void {
  expectProblemContentType(res);
  expect(res.headers['cache-control']).toBe('no-store');
  const detail = typeof res.body.detail === 'string' ? res.body.detail : '';
  if (res.status === 404 && /^Cannot (GET|POST|PUT|PATCH|DELETE) /.test(detail)) {
    throw new Error(
      `计划内红(待 ${greenTasks} 转绿):${label} 尚未装配(路由级缺省 404「${detail}」)——` +
        `${greenTasks} 落地后本端点应按契约返回 ${contractStatuses.join('/')}`,
    );
  }
  expect(
    contractStatuses,
    `${label} 应按契约应答(${contractStatuses.join('/')};实际 ${res.status} ${String(res.body.code)})`,
  ).toContain(res.status);
}

/**
 * 游客授权双态断言(F 组绿基线):端点已装配 → 游客必须 401 SESSION_INVALID
 * (先于一切 403);未装配期 → 路由级缺省 404(不误判为授权通过)。
 * 返回 'auth' 时调用方可继续断言「已登录无 Profile → 403」的次序。
 */
function expectGuestAuthOrUnassembled(
  res: request.Response,
  label: string,
  greenTasks: string,
): 'auth' | 'unassembled' {
  expectProblemContentType(res);
  const detail = typeof res.body.detail === 'string' ? res.body.detail : '';
  if (res.status === 404) {
    expect(
      detail,
      `${label}:404 只能是「路由未装配」缺省形态(待 ${greenTasks} 装配后游客必须 401)`,
    ).toMatch(/^Cannot (GET|POST|PUT|PATCH|DELETE) /);
    return 'unassembled';
  }
  expect(res.status, `${label}:游客必须 401(先于一切 403);实际 ${res.status}`).toBe(401);
  expect(res.body.code).toBe(ProblemCode.SESSION_INVALID);
  return 'auth';
}

/* ------------------------------------------------------------------ */
/* 上游 mock(fixture 路由表 → 受控本地 HTTP;不 vi.mock、不发真实外网)    */
/* ------------------------------------------------------------------ */

const activeMediaServers: ControlledMediaServer[] = [];
/** 本文件注入的 VOD 预算 env(只许收紧;afterEach 统一清除,不跨用例/文件泄漏) */
const injectedBudgetEnvKeys: string[] = [];

function injectBudgetEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
    injectedBudgetEnvKeys.push(key);
  }
}

/** 批量影片世界:同关键词 N 条(upstreamVodId 递增;单线单集,呈现为纯字符串构造) */
function bulkTitleWorlds(origin: string, keyword: string, idBase: number, count: number): FixtureTitleWorld[] {
  return Array.from({ length: count }, (_unused, index) => {
    const upstreamId = idBase + index;
    return createFixtureTitleWorld({
      titleKey: `bulk-${upstreamId}`,
      searchKeyword: keyword,
      upstreamVodId: upstreamId,
      name: `夹具批量片${String(index + 1).padStart(2, '0')}号`,
      year: '2025',
      remarks: '夹具批量条目',
      episodesTotal: 1,
      lines: [
        {
          lineKey: 'main',
          displayName: 'fixture正片',
          sortOrder: 1,
          episodes: [
            {
              episodeKey: '01',
              label: '第01集',
              ordinal: 1,
              sequenceStatus: 'ordered',
              presentation: createStandardEpisodePresentation({
                presentationKey: `bulk-${upstreamId}:01`,
                episodeKey: '01',
                origin,
                rootPath: `/vod/hls/${upstreamId}/ep-01`,
                segmentCount: 1,
                segmentDurationSeconds: 60,
              }),
            },
          ],
        },
      ],
    });
  });
}

/** 超预算形态:21 条线路(> detail.maxLines=20;api.md §2「最多20线路」→ 422 整次失败) */
function oversizeTitleWorld(origin: string): FixtureTitleWorld {
  return createFixtureTitleWorld({
    titleKey: 'oversize-lines',
    searchKeyword: 'bigshow',
    upstreamVodId: 7001,
    name: 'fixture·超线路影片',
    year: '2024',
    episodesTotal: 21,
    lines: Array.from({ length: 21 }, (_unused, index) => ({
      lineKey: `line-${String(index + 1).padStart(2, '0')}`,
      displayName: `fixture线路${String(index + 1).padStart(2, '0')}`,
      sortOrder: index + 1,
      episodes: [
        {
          episodeKey: '01',
          label: '第01集',
          ordinal: 1,
          sequenceStatus: 'ordered' as const,
          presentation: createStandardEpisodePresentation({
            presentationKey: `oversize:line-${index + 1}`,
            episodeKey: '01',
            origin,
            rootPath: `/vod/hls/7001/line-${index + 1}`,
            segmentCount: 1,
            segmentDurationSeconds: 60,
          }),
        },
      ],
    })),
  });
}

interface CatalogRig {
  app: INestApplication;
  householdId: string;
  server: ControlledMediaServer;
  sources: readonly FixtureUpstreamSource[];
  sourceIds: Readonly<Record<string, string>>;
}

interface CatalogRigOptions {
  /** wd 命名空间 → 500(上游失败形态;搜索侧应记 invalid/unavailable 或全源失败) */
  invalidKeywords?: readonly string[];
  /** wd 命名空间 → 整列表文档覆盖(批量/重复身份形态;先于 fixture 逐条 wd 路由命中) */
  listDocOverrides?: Readonly<Record<string, AppleCmsListDocument>>;
  env?: Record<string, string>;
}

/**
 * 带上游 mock 的目录 rig:受控 CMS 端口 + 全量迁移 app + 逐源 kind=vod 来源行
 * (remote_url 指向受控端口;运行期许可由 LAN_ALLOWED_TARGETS='127.0.0.1' 注入,
 * 与 sources-refresh.e2e-spec 同一口径)。来源行经 DB 直插(工厂事实):POST
 * /settings/sources 的 kind=vod 分支属 T026,由 A 组按契约单独钉住。
 */
async function startCatalogRig(
  prefix: string,
  fixtureSources: readonly FixtureUpstreamSource[],
  options: CatalogRigOptions = {},
): Promise<CatalogRig> {
  const listDocOverrides = new Map<string, AppleCmsListDocument>(
    Object.entries(options.listDocOverrides ?? {}),
  );
  const invalidKeywords = new Set<string>(options.invalidKeywords ?? []);

  // T031 rig 接线:多源共用同一 mock 端口时按 apiPath 命名空间隔离(每源一个
  // pathname 前缀,天然区分「哪个源被请求」);behavior=timeout 的挂起源整路径
  // 挂起(kind: 'hang',任意请求不回包,由服务端上游预算判 timeout)——否则其
  // 路由表与健康源合并后会被健康路由抢先命中,B4 的「部分源超时」形态无法表达。
  const routesByApiPath = new Map<string, FixtureUpstreamRoute[]>();
  const timeoutApiPaths = new Set<string>();
  for (const source of fixtureSources) {
    if (source.behavior === 'timeout') {
      timeoutApiPaths.add(source.apiPath);
    }
    const bucket = routesByApiPath.get(source.apiPath) ?? [];
    bucket.push(...source.routes);
    routesByApiPath.set(source.apiPath, bucket);
  }

  const server = await createControlledMediaServer({
    routes: [...routesByApiPath.entries()].map(([apiPath, routes]) =>
      timeoutApiPaths.has(apiPath)
        ? { path: apiPath, kind: 'hang' as const }
        : {
            path: apiPath,
            kind: 'raw' as const,
            respond: (context: MediaRequestContext) => {
              const keyword = context.url.searchParams.get('wd') ?? '';
              if (invalidKeywords.has(keyword)) {
                context.res.statusCode = 500;
                context.res.setHeader('content-type', 'text/plain; charset=utf-8');
                context.res.end('fixture upstream exploded');
                return;
              }
              const override = listDocOverrides.get(keyword);
              if (override !== undefined) {
                context.res.statusCode = 200;
                context.res.setHeader('content-type', 'application/json; charset=utf-8');
                context.res.end(JSON.stringify(override));
                return;
              }
              const route = findUpstreamRoute(routes, context.url.href);
              if (route === null) {
                context.res.statusCode = 404;
                context.res.setHeader('content-type', 'text/plain; charset=utf-8');
                context.res.end('fixture upstream: no route');
                return;
              }
              if (route.response.kind === 'timeout') {
                // 挂起不回包:由服务端上游预算判 timeout(契约:全部超时 504)
                return;
              }
              context.res.statusCode = route.response.status;
              for (const [name, value] of Object.entries(route.response.headers)) {
                context.res.setHeader(name, value);
              }
              context.res.end(route.response.body);
            },
          },
    ),
  });
  activeMediaServers.push(server);

  const fresh = await startFreshApp({
    prefix,
    env: { LAN_ALLOWED_TARGETS: '127.0.0.1', ...(options.env ?? {}) },
  });
  expect((await initialize(fresh.app)).status).toBe(201);
  const householdRow = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string };
  const sourceIds: Record<string, string> = {};
  for (const source of fixtureSources) {
    sourceIds[source.sourceId] = seedVodSourceRow(householdRow.id, `${server.baseUrl}${source.apiPath}`);
  }
  return { app: fresh.app, householdId: householdRow.id, server, sources: fixtureSources, sourceIds };
}

/* ------------------------------------------------------------------ */
/* DB 直改 seed 包装(工厂事实;对齐 T021「DB 直改仅用于无 HTTP 语义事实」) */
/* ------------------------------------------------------------------ */

/** kind=vod 来源行(media_source + vod_source_config 一源一行);返回 sourceId */
function seedVodSourceRow(householdId: string, remoteUrl: string, options: { enabled?: boolean } = {}): string {
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
        enabled: options.enabled === false ? 0 : 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(vodSourceConfig).values({ householdId, sourceId, adapter: 'apple-cms-json' }).run();
  });
  return sourceId;
}

interface SeededEpisodeSpec {
  episodeKey: string;
  label: string;
  /** 确定序列序号;null=缺序(sequence 行仍落,按 special 口径取 ordinal=1) */
  ordinal: number | null;
  sequenceStatus: 'ordered' | 'ambiguous' | 'special';
}

interface SeededVodTitle {
  titleId: string;
  parentMediaId: string;
  lineId: string;
  episodeMediaIds: string[];
  detailRevision: number;
}

/**
 * 已物化 vod 标题世界(公共目录身份链全量直插):父 media_item(media_role=
 * vod_title)+ vod_title + vod_line + 子 media_item(vod_episode)+ media_relation +
 * vod_episode + vod_detail_snapshot(revision=1)+ vod_episode_sequence。
 * 供 D 组 episodes 投影(T030+T031)转绿后直接消费。
 */
function seedVodTitleWorld(input: {
  householdId: string;
  sourceId: string;
  upstreamVodId: string;
  name: string;
  episodes: readonly SeededEpisodeSpec[];
}): SeededVodTitle {
  const now = new Date().toISOString();
  const titleId = randomUUID();
  const parentMediaId = randomUUID();
  const lineId = randomUUID();
  const episodeMediaIds: string[] = [];
  getDb().transaction((tx) => {
    tx.insert(mediaItem)
      .values({
        id: parentMediaId,
        householdId: input.householdId,
        type: 'series',
        mediaRole: 'vod_title',
        title: input.name,
        contentLevel: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(vodTitle)
      .values({
        id: titleId,
        householdId: input.householdId,
        sourceId: input.sourceId,
        upstreamVodId: input.upstreamVodId,
        parentMediaId,
        currentDetailRevision: 1,
        materializedAt: now,
      })
      .run();
    tx.insert(vodLine)
      .values({
        id: lineId,
        householdId: input.householdId,
        titleId,
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
      })
      .run();
    tx.insert(vodDetailSnapshot)
      .values({
        householdId: input.householdId,
        titleId,
        revision: 1,
        locatorRevision: 1,
        validatedPrivatePayload: JSON.stringify({ fixture: input.upstreamVodId }),
        fetchedAt: now,
        expiresAt: new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(),
      })
      .run();
    input.episodes.forEach((episode, index) => {
      const episodeRowId = randomUUID();
      const childMediaId = randomUUID();
      episodeMediaIds.push(childMediaId);
      tx.insert(mediaItem)
        .values({
          id: childMediaId,
          householdId: input.householdId,
          type: 'episode',
          mediaRole: 'vod_episode',
          title: episode.label,
          contentLevel: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      tx.insert(mediaRelation)
        .values({
          householdId: input.householdId,
          parentId: parentMediaId,
          childId: childMediaId,
          kind: 'vod_episode',
          sortOrder: index + 1,
        })
        .run();
      tx.insert(vodEpisode)
        .values({
          id: episodeRowId,
          householdId: input.householdId,
          lineId,
          episodeKey: episode.episodeKey,
          label: episode.label,
          mediaId: childMediaId,
          contentVersionState: 'unverified',
        })
        .run();
      tx.insert(vodEpisodeSequence)
        .values({
          householdId: input.householdId,
          titleId,
          lineId,
          detailRevision: 1,
          sequenceRevision: 1,
          episodeId: episodeRowId,
          seasonKey: 'S01',
          ordinal: episode.ordinal ?? 1,
          sequenceStatus: episode.sequenceStatus,
        })
        .run();
    });
  });
  return { titleId, parentMediaId, lineId, episodeMediaIds, detailRevision: 1 };
}

interface SourceRowFact {
  version: number;
  locatorRevision: number;
  enabled: number;
  remoteUrl: string | null;
}

function sourceRowOf(sourceId: string): SourceRowFact {
  const row = Database.db
    .prepare(
      'SELECT version, locator_revision AS locatorRevision, enabled, remote_url AS remoteUrl FROM media_source WHERE id = ?',
    )
    .get(sourceId) as SourceRowFact | undefined;
  if (row === undefined) {
    throw new Error(`夹具错误:media_source ${sourceId} 不存在`);
  }
  return row;
}

function tableCountOf(tableName: string, where: string = '1=1', ...params: readonly string[]): number {
  const row = Database.db.prepare(`SELECT COUNT(*) AS n FROM ${tableName} WHERE ${where}`).get(...params) as {
    n: number;
  };
  return row.n;
}

/* ------------------------------------------------------------------ */
/* Settings rig(A 组:initialize + login,同 settings-management-negative)*/
/* ------------------------------------------------------------------ */

interface SettingsRig {
  app: INestApplication;
  cookie: string;
  householdId: string;
}

async function settingsRig(prefix: string): Promise<SettingsRig> {
  const fresh = await startFreshApp({ prefix });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const householdRow = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string };
  return { app: fresh.app, cookie: cookiePairOf(loggedIn), householdId: householdRow.id };
}

function postSource(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post('/api/settings/sources').set('Cookie', cookie).send(body);
}

function patchSource(
  app: INestApplication,
  cookie: string,
  sourceId: string,
  body: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer())
    .patch(`/api/settings/sources/${sourceId}`)
    .set('Cookie', cookie)
    .send(body);
}

/** 合法 vod 创建体(api.md §2:kind=vod + remoteUrl + adapter=apple-cms-json) */
function vodSourceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'vod',
    name: '在线片源',
    remoteUrl: 'http://cms.example.com/api.php?ac=list',
    adapter: 'apple-cms-json',
    ownerPassword: MANAGEMENT_OWNER_PASSWORD,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* 公共/E 组链路助手                                                    */
/* ------------------------------------------------------------------ */

async function searchVod(app: INestApplication, query: Record<string, string>): Promise<request.Response> {
  return request(app.getHttpServer()).get('/api/public/vod/search').query(query);
}

/** 搜索 → 首页首卡 → 预览(C/E 组链路;任一步未装配即计划内红形态) */
async function previewFirstCard(
  app: INestApplication,
  keyword: string,
): Promise<{ titleRef: string; preview: VodPreviewDto }> {
  const first = await searchVod(app, { q: keyword });
  expectEndpointResUnderContract(first, [200, 502, 504], `GET /api/public/vod/search?q=${keyword}`, 'T028+T031');
  expect(first.status, `搜索 ${keyword} 应 200`).toBe(200);
  const page = first.body as SearchPageDto;
  const card: PublicVodCardDto | undefined = page.items[0];
  expect(card, `搜索 ${keyword} 应至少一条结果`).toBeDefined();
  const titleRef = card!.titleRef;
  const res = await request(app.getHttpServer()).get(`/api/public/vod/titles/${encodeURIComponent(titleRef)}`);
  expectEndpointResUnderContract(res, [200, 404, 410, 422], 'GET /api/public/vod/titles/:ref', 'T028+T031');
  expect(res.status, `预览 ${titleRef} 应 200`).toBe(200);
  return { titleRef, preview: res.body as VodPreviewDto };
}

function postMaterialization(
  app: INestApplication,
  cookie: string,
  body: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer()).post('/api/vod/materializations').set('Cookie', cookie).send(body);
}

/** 登录并选中主档案(Profile 鉴权面;selectMainAndUnlockSettings 复用,grant 解锁对 Profile 面无害) */
async function profileCookieOf(app: INestApplication): Promise<string> {
  const loggedIn = await login(app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const cookie = cookiePairOf(loggedIn);
  await selectMainAndUnlockSettings(app, cookie);
  return cookie;
}

/** 场景源构造:批量(healthy)/失败(healthy+wd 命中 500)/挂起(timeout 行为) */
function bulkSource(port: number, keyword = 'bulksearch', idBase = 5001, count = 25): FixtureUpstreamSource {
  return createFixtureVodSource({
    sourceId: 'fixture-vod-source-bulk',
    displayName: '夹具批量源',
    behavior: 'healthy',
    address: { host: '127.0.0.1', port },
    titleWorlds: bulkTitleWorlds(`http://127.0.0.1:${port}`, keyword, idBase, count),
  });
}

function failingSource(port: number): FixtureUpstreamSource {
  return singleWorldSource({
    sourceId: 'fixture-vod-source-failing',
    displayName: '夹具失败源',
    keyword: 'failsearch',
    upstreamVodId: 6001,
    name: 'fixture·失败源影片',
    port,
    behavior: 'healthy',
  });
}

function hangSource(port: number): FixtureUpstreamSource {
  const origin = `http://127.0.0.1:${port}`;
  // T031 rig 接线:挂起源用独立 apiPath 命名空间(与批量源共用 mock 端口但不共
  // 路由表)——startCatalogRig 对 behavior=timeout 的源整路径挂起,B4「部分源
  // 超时」的 timeout 状态由该源真实挂起产生,而非路由误命中健康源。
  return createFixtureVodSource({
    sourceId: 'fixture-vod-source-hang',
    displayName: '夹具挂起源',
    behavior: 'timeout',
    address: { host: '127.0.0.1', port },
    apiPath: `${FIXTURE_UPSTREAM_DEFAULT_API_PATH}hang/`,
    titleWorlds: [createStandaloneMovieWorld(origin)],
  });
}

function singleWorldSource(input: {
  sourceId: string;
  displayName: string;
  keyword: string;
  upstreamVodId: number;
  name: string;
  port: number;
  behavior: 'healthy' | 'timeout';
}): FixtureUpstreamSource {
  const origin = `http://127.0.0.1:${input.port}`;
  return createFixtureVodSource({
    sourceId: input.sourceId,
    displayName: input.displayName,
    behavior: input.behavior,
    address: { host: '127.0.0.1', port: input.port },
    titleWorlds: [
      createFixtureTitleWorld({
        titleKey: `${input.sourceId}:title`,
        searchKeyword: input.keyword,
        upstreamVodId: input.upstreamVodId,
        name: input.name,
        year: '2024',
        episodesTotal: 1,
        lines: [
          {
            lineKey: 'main',
            displayName: 'fixture正片',
            sortOrder: 1,
            episodes: [
              {
                episodeKey: '01',
                label: '第01集',
                ordinal: 1,
                sequenceStatus: 'ordered',
                presentation: createStandardEpisodePresentation({
                  presentationKey: `${input.sourceId}:01`,
                  episodeKey: '01',
                  origin,
                  rootPath: `/vod/hls/${input.upstreamVodId}/ep-01`,
                  segmentCount: 1,
                  segmentDurationSeconds: 60,
                }),
              },
            ],
          },
        ],
      }),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* 通用 afterEach                                                       */
/* ------------------------------------------------------------------ */

afterEach(async () => {
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
  for (const key of injectedBudgetEnvKeys.splice(0)) {
    delete process.env[key];
  }
});

/* ------------------------------------------------------------------ */
/* A Settings vod 配置/测试/启停                                        */
/* ------------------------------------------------------------------ */

describe('T022 · A Settings vod 配置/测试/启停(api.md §2)', () => {
  it('A1 [计划内红·待 T026] POST kind=vod 合法创建 201 SourceDto(kind=vod + capabilities),列表可见且不回显 remoteUrl', async () => {
    const { app, cookie } = await settingsRig('hmp-t022-a1-');
    await selectMainAndUnlockSettings(app, cookie);
    const created = await postSource(app, cookie, vodSourceBody());
    // 计划内红判据:当前 kind 枚举(iptv/epg/nas)先拒 → 400;T026 vod 分支落地后 201。
    expect(
      created.status,
      `计划内红(待 T026 转绿):kind=vod 创建尚未实现(当前 ${created.status} ${String(created.body.code)},` +
        'schema 枚举先拒)——T026 落地后应为 201 SourceDto(kind=vod + capabilities:{resume:operational,requiresCurrentProbe:true})',
    ).toBe(201);
    const body = created.body as Record<string, unknown>;
    expect(body['kind']).toBe('vod');
    expect(body['enabled']).toBe(true);
    expect(body['version']).toBe(1);
    expect(body['capabilities']).toEqual({ resume: 'operational', requiresCurrentProbe: true });
    // 契约裁决(lead,2026-10-30):openapi 010 Source.locationLabel 为 required 的「脱敏主机标签」,
    // 主机名本身允许出现;「不回显 remoteUrl 原文」按契约语义收窄为路径/query 特征。
    expect(JSON.stringify(body), 'SourceDto 不得回显 remoteUrl 原文(路径/query)').not.toContain('api.php');
    // 列表可见且同形脱敏(api.md §2:GET /settings/sources 扩 kind=vod + capabilities)
    const list = await request(app.getHttpServer())
      .get('/api/settings/sources')
      .query({ page: 1, pageSize: 20 })
      .set('Cookie', cookie);
    expect(list.status).toBe(200);
    const items = (list.body as { items: Array<Record<string, unknown>> }).items;
    const listed = items.find((item) => item['id'] === body['id']);
    expect(listed, '创建的 vod 来源应出现在来源列表').toBeDefined();
    expect(listed!['kind']).toBe('vod');
    expectNoMarkers(list, UPSTREAM_LOCATION_MARKERS, '来源列表(脱敏概览)');
  });

  it('A2 [计划内红·待 T026] POST kind=vod 缺 remoteUrl → 400 VALIDATION_FAILED 且 detail 指向 remoteUrl,零创建', async () => {
    const { app, cookie, householdId } = await settingsRig('hmp-t022-a2-');
    await selectMainAndUnlockSettings(app, cookie);
    const res = await postSource(app, cookie, {
      kind: 'vod',
      name: '缺地址片源',
      adapter: 'apple-cms-json',
      ownerPassword: MANAGEMENT_OWNER_PASSWORD,
    });
    // 契约形态:400 VALIDATION_FAILED,detail 指出 remoteUrl(vod 必须 remote_url 非空)。
    // 当前 kind 枚举先拒:400 但 detail 指向 kind → 计划内红(待 T026 vod 分支)。
    expectProblem(res, 400, ProblemCode.VALIDATION_FAILED);
    const detail = typeof res.body.detail === 'string' ? res.body.detail : '';
    expect(
      detail,
      `计划内红(待 T026 转绿):缺 remoteUrl 的 400 应由「vod 必须 remote_url 非空」分支给出` +
        `(当前 detail:「${detail}」为 kind 枚举先拒)`,
    ).toContain('remoteUrl');
    expect(
      tableCountOf('media_source', "household_id = ? AND kind = 'vod'", householdId),
      '拒绝路径零创建',
    ).toBe(0);
  });

  it('A3 [计划内红·待 T026] POST kind=vod remoteUrl 指向内网/环回 → 422 SOURCE_TARGET_DENIED 且不回显地址', async () => {
    const { app, cookie } = await settingsRig('hmp-t022-a3-');
    await selectMainAndUnlockSettings(app, cookie);
    for (const target of ['http://127.0.0.1:8080/api.php?ac=list', 'http://169.254.169.254/latest']) {
      const res = await postSource(app, cookie, vodSourceBody({ remoteUrl: target }));
      // 计划内红判据:当前 vod 被 schema 枚举先拒(400),未达目标许可层;
      // T026 source-target vod 白名单落地后必须 422 SOURCE_TARGET_DENIED(与 IPTV 同类别判定)。
      expect(
        res.status,
        `计划内红(待 T026 转绿):kind=vod 内网目标许可未实现(当前 ${res.status} ${String(res.body.code)})`,
      ).toBe(422);
      expectProblem(res, 422, 'SOURCE_TARGET_DENIED');
      expect(JSON.stringify(res.body), `拒绝体不得回显目标原文 ${target}`).not.toContain(target);
    }
  });

  it('A4 [计划内红·待 T026] PATCH vod 来源根地址字段 → 400 拒绝(根地址不可 PATCH,禁借旧换地址通路)', async () => {
    const { app, cookie, householdId } = await settingsRig('hmp-t022-a4-');
    await selectMainAndUnlockSettings(app, cookie);
    const sourceId = seedVodSourceRow(householdId, 'http://cms.example.com/api.php?ac=list');
    const res = await patchSource(app, cookie, sourceId, {
      ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      expectedVersion: 1,
      remoteUrl: 'http://other-cms.example.com/api.php?ac=list',
    });
    // 契约:PATCH 根地址字段拒绝 400(VodPatchSourceRequest 无 remoteUrl 字段,strictObject)。
    // 当前走旧「换地址」通路(未显式 privateAccessApproved → 422)→ 计划内红。
    expect(
      res.status,
      `计划内红(待 T026 转绿):vod 来源根地址 PATCH 应被 400 拒绝(当前 ${res.status} ${String(res.body.code)},` +
        '旧「换地址须 privateAccessApproved」语义未收敛)',
    ).toBe(400);
    expectProblem(res, 400, ProblemCode.VALIDATION_FAILED);
  });

  it('A5 [绿基线] PATCH vod 来源改名 → 200 version+1,locator_revision 不变(改名不失效活动 locator)', async () => {
    const { app, cookie, householdId } = await settingsRig('hmp-t022-a5-');
    await selectMainAndUnlockSettings(app, cookie);
    const sourceId = seedVodSourceRow(householdId, 'http://cms.example.com/api.php?ac=list');
    expect(sourceRowOf(sourceId)).toMatchObject({ version: 1, locatorRevision: 1 });
    const res = await patchSource(app, cookie, sourceId, {
      ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      expectedVersion: 1,
      name: '改名在线片源',
    });
    expect(res.status, `改名应 200: ${JSON.stringify(res.body)}`).toBe(200);
    expect((res.body as Record<string, unknown>)['version']).toBe(2);
    expect(sourceRowOf(sourceId)).toMatchObject({
      version: 2,
      locatorRevision: 1,
      enabled: 1,
      remoteUrl: 'http://cms.example.com/api.php?ac=list',
    });
  });

  it('A6 [计划内红·待 T026] PATCH 启停 → 200 且 locator_revision+1(启停均失效防 ABA)', async () => {
    const { app, cookie, householdId } = await settingsRig('hmp-t022-a6-');
    await selectMainAndUnlockSettings(app, cookie);
    const sourceId = seedVodSourceRow(householdId, 'http://cms.example.com/api.php?ac=list');
    const disable = await patchSource(app, cookie, sourceId, {
      ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      expectedVersion: 1,
      enabled: false,
    });
    expect(disable.status, `停用应 200: ${JSON.stringify(disable.body)}`).toBe(200);
    // 计划内红判据:启停必须使 locator 失效(locator_revision 1→2,防 ABA);
    // 当前既有 PATCH 不递增 locator_revision → 红待 T026。
    expect(
      sourceRowOf(sourceId).locatorRevision,
      `计划内红(待 T026 转绿):停用应 locator_revision+1(实际 ${sourceRowOf(sourceId).locatorRevision})`,
    ).toBe(2);
    const enable = await patchSource(app, cookie, sourceId, {
      ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      expectedVersion: 2,
      enabled: true,
    });
    expect(enable.status).toBe(200);
    expect(sourceRowOf(sourceId).locatorRevision, '再启用同样 +1(启停均失效)').toBe(3);
  });

  it('A7 [计划内红·待 T025/T026] POST /settings/sources/:id/test → 200 SourceTestResult(可达+兼容+能力),不写媒体;授权错误不包装为测试结果', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-a7-', [alpha]);
    const cookie = await profileCookieOf(rig.app);
    const sourceId = rig.sourceIds[alpha.sourceId]!;
    const mediaCountBefore = tableCountOf('media_item');
    const res = await request(rig.app.getHttpServer())
      .post(`/api/settings/sources/${sourceId}/test`)
      .set('Cookie', cookie)
      .send({ ownerPassword: MANAGEMENT_OWNER_PASSWORD });
    // 计划内红判据:测试端点未装配(路由 404);T025 adapter + T026 Settings vod 装配后 200。
    expectEndpointResUnderContract(res, [200], 'POST /api/settings/sources/:id/test', 'T025+T026');
    expect(res.status).toBe(200);
    expectExactKeys(res.body, ['reachable', 'compatible', 'capabilities', 'reason'], 'SourceTestResult');
    const body = res.body as SourceTestResultDto;
    expect(body.reachable, '夹具健康源应可达').toBe(true);
    expect(body.compatible, 'apple-cms-json 应兼容').toBe(true);
    expect(body.reason).toBeNull();
    expect(body.capabilities).toEqual({ resume: 'operational', requiresCurrentProbe: true });
    expect(tableCountOf('media_item'), '测试端点不得写媒体').toBe(mediaCountBefore);
    // 授权错误不能包装为测试结果:错密码 → 403 PARENT_VERIFICATION_FAILED(非 200 {reachable:false})
    const wrongPwd = await request(rig.app.getHttpServer())
      .post(`/api/settings/sources/${sourceId}/test`)
      .set('Cookie', cookie)
      .send({ ownerPassword: 'definitely-wrong' });
    expect(wrongPwd.status, `错密码应 403(当前 ${wrongPwd.status})`).toBe(403);
    expect(wrongPwd.body.code).toBe(ProblemCode.PARENT_VERIFICATION_FAILED);
  });

  it('A8 [计划内红·待 T026] 启用 vod 源满 10 个后再创建 → 409 VOD_QUOTA_EXCEEDED(净配额,不删既有)', async () => {
    const { app, cookie, householdId } = await settingsRig('hmp-t022-a8-');
    await selectMainAndUnlockSettings(app, cookie);
    for (let index = 0; index < 10; index += 1) {
      seedVodSourceRow(householdId, `http://cms-${index}.example.com/api.php?ac=list`);
    }
    const eleventh = await postSource(app, cookie, vodSourceBody({ name: '第十一源' }));
    // 计划内红判据:当前 kind 枚举先拒(400);T026 落地后必须 409 VOD_QUOTA_EXCEEDED。
    expect(
      eleventh.status,
      `计划内红(待 T026 转绿):10 启用源净配额未实现(当前 ${eleventh.status} ${String(eleventh.body.code)})`,
    ).toBe(409);
    expectProblem(eleventh, 409, ProblemCode.VOD_QUOTA_EXCEEDED);
    expect(
      tableCountOf('media_source', "household_id = ? AND kind = 'vod' AND enabled = 1", householdId),
      '配额拒绝后既有 10 源原样',
    ).toBe(10);
  });
});

/* ------------------------------------------------------------------ */
/* B 公共搜索                                                           */
/* ------------------------------------------------------------------ */

const SEARCH_PAGE_KEYS = ['searchId', 'items', 'sources', 'nextCursor', 'partial', 'reasons', 'expiresAt'] as const;
const PUBLIC_VOD_CARD_KEYS = ['titleRef', 'title', 'year', 'sourceLabel', 'posterRef'] as const;
const VOD_SEARCH_SOURCE_KEYS = ['sourceRef', 'status', 'hasMore'] as const;

describe('T022 · B 公共搜索 GET /api/public/vod/search(api.md §2)', () => {
  it('B1 [计划内红·待 T028/T031] 首页 20 条 + nextCursor + SearchPage 契约形状,无个人字段/无源地址', async () => {
    const bulk = bulkSource(0);
    // T031 rig 接线:夹具逐条 wd 路由同路径去重只保留首条(单条形态),批量 25 条
    // 世界经既有整列表文档覆盖(B7 同款 seam)按上游全量 25 条钉「每页 20/余 5 翻页」。
    const rig = await startCatalogRig('hmp-t022-b1-', [bulk], {
      listDocOverrides: {
        bulksearch: buildAppleCmsListDocument(bulk.titleWorlds.map((world) => world.briefItem)),
      },
    });
    const res = await searchVod(rig.app, { q: 'bulksearch' });
    expectEndpointResUnderContract(res, [200, 502, 504], 'GET /api/public/vod/search?q=bulksearch', 'T028+T031');
    expect(res.status, '25 条聚合结果首页应 200').toBe(200);
    expect(res.headers['set-cookie'], '公共读取不设置身份 cookie').toBeUndefined();
    expectExactKeys(res.body, SEARCH_PAGE_KEYS, 'SearchPage');
    const page = res.body as SearchPageDto;
    expect(page.items, '每页 20 条(api.md §2)').toHaveLength(20);
    expect(page.nextCursor, '还有 5 条未取,应给出 nextCursor').toBeTypeOf('string');
    expect(page.partial, '正常首页(无源失败)partial=false').toBe(false);
    expect(page.reasons).toEqual([]);
    expect(typeof page.searchId).toBe('string');
    expect(page.searchId.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(page.expiresAt)), 'expiresAt 应为 UTC ISO8601').toBe(false);
    for (const item of page.items) {
      expectExactKeys(item, PUBLIC_VOD_CARD_KEYS, 'PublicVodCard');
      expect(item.posterRef).toBeNull();
      expect(typeof item.titleRef).toBe('string');
      expect(item.titleRef.length).toBeGreaterThan(0);
    }
    for (const source of page.sources) {
      expectExactKeys(source, VOD_SEARCH_SOURCE_KEYS, 'VodSearchSource');
      expect(['ok', 'empty', 'timeout', 'invalid', 'unavailable']).toContain(source.status);
      expect(typeof source.sourceRef).toBe('string');
    }
    // sourceRef 不透明:不等于源配置内部 ID
    const bulkSourceId = rig.sourceIds['fixture-vod-source-bulk'] ?? '';
    expect(page.sources.map((source) => source.sourceRef)).not.toContain(bulkSourceId);
    expectNoPersonalMarkers(res, 'SearchPage');
    expectNoSourceLocation(res, 'SearchPage(无源配置 ID/地址)');
  });

  it('B2 [计划内红·待 T028/T031] 翻页 {searchId,cursor} → 第二页;缺 cursor 重放第一页且逐字段不变', async () => {
    const bulk = bulkSource(0);
    // T031 rig 接线:同 B1——整列表文档覆盖提供上游 25 条(首页 20 + 缓冲余 5 翻页)。
    const rig = await startCatalogRig('hmp-t022-b2-', [bulk], {
      listDocOverrides: {
        bulksearch: buildAppleCmsListDocument(bulk.titleWorlds.map((world) => world.briefItem)),
      },
    });
    const first = await searchVod(rig.app, { q: 'bulksearch' });
    expectEndpointResUnderContract(first, [200, 502, 504], 'GET /api/public/vod/search?q=bulksearch', 'T028+T031');
    expect(first.status).toBe(200);
    const page1 = first.body as SearchPageDto;
    expect(page1.nextCursor).toBeTypeOf('string');

    const second = await searchVod(rig.app, { searchId: page1.searchId, cursor: page1.nextCursor ?? '' });
    expectEndpointResUnderContract(second, [200, 410], 'GET search(翻页)', 'T028+T031');
    expect(second.status, '有效 cursor 翻页应 200').toBe(200);
    const page2 = second.body as SearchPageDto;
    expect(page2.items, '第二页为余下 5 条').toHaveLength(5);
    expect(page2.nextCursor, '取尽后 nextCursor=null').toBeNull();
    expect(page2.partial).toBe(false);

    // 缺 cursor 重放第一页:已生成页重放不变(api.md §2「缺 cursor 重放第一页」)
    const replay = await searchVod(rig.app, { searchId: page1.searchId });
    expect(replay.status).toBe(200);
    expect((replay.body as SearchPageDto).items).toEqual(page1.items);
    expect((replay.body as SearchPageDto).searchId).toBe(page1.searchId);
    expect((replay.body as SearchPageDto).nextCursor).toEqual(page1.nextCursor);
  });

  it('B3 [计划内红·待 T028/T031] 两组入参互斥与严格 query(同给 400、cursor 缺 searchId 400、q 空串/超长/未知字段 400)', async () => {
    const rig = await startCatalogRig('hmp-t022-b3-', [bulkSource(0)]);
    const cases: Array<[string, Record<string, string>]> = [
      ['q+searchId 同给(两组互斥)', { q: 'bulksearch', searchId: 'some-search-id' }],
      ['cursor 缺 searchId', { cursor: 'some-cursor' }],
      ['q 空串(minLength 1)', { q: '' }],
      ['q 超 100 字符', { q: 'x'.repeat(101) }],
      ['未知 query 字段', { q: 'bulksearch', filter: 'all' }],
    ];
    for (const [label, query] of cases) {
      const res = await searchVod(rig.app, query);
      expectEndpointResUnderContract(res, [400], `GET search 严格入参(${label})`, 'T028+T031');
      expectProblem(res, 400, ProblemCode.VALIDATION_FAILED);
    }
  });

  it('B4 [计划内红·待 T028/T031] 部分源超时 → 200 partial=true + reasons 非空 + sources 状态混合(ok/timeout)', async () => {
    // 收紧上游总期限(env 只许收紧;T019 vod-config)——转绿后本用例 ~500ms 内完成
    injectBudgetEnv({ VOD_SEARCH_TIMEOUT_MS: '500' });
    const rig = await startCatalogRig('hmp-t022-b4-', [bulkSource(0), hangSource(0)]);
    const res = await searchVod(rig.app, { q: 'bulksearch' });
    expectEndpointResUnderContract(res, [200, 504], 'GET search(部分源超时)', 'T028+T031');
    expect(res.status, '部分源失败应 200 partial(非整次失败)').toBe(200);
    const page = res.body as SearchPageDto;
    expect(page.partial, '有源超时 → partial=true').toBe(true);
    expect(page.reasons.length, 'reasons 应非空').toBeGreaterThanOrEqual(1);
    const statuses = page.sources.map((source) => source.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('timeout');
    expect(page.items.length, '健康源结果照常返回').toBeGreaterThan(0);
    expectNoPersonalMarkers(res, 'SearchPage(部分失败)');
    expectNoSourceLocation(res, 'SearchPage(部分失败,不泄上游地址)');
  });

  it('B5 [计划内红·待 T028/T031] 全源失败 → 502(problem+json;详细上游错误/地址/凭据不公开)', async () => {
    const rig = await startCatalogRig('hmp-t022-b5-', [failingSource(0)], { invalidKeywords: ['failsearch'] });
    const res = await searchVod(rig.app, { q: 'failsearch' });
    expectEndpointResUnderContract(res, [502], 'GET search(全源失败)', 'T028+T031');
    expect(res.status).toBe(502);
    expect(typeof res.body.code).toBe('string');
    expect((res.body.code as string).length).toBeGreaterThan(0);
    expectNoSourceLocation(res, '502 problem 体(不泄上游地址)');
  });

  it('B6 [计划内红·待 T028/T031] 全部超时 → 504(上游总期限耗尽)', async () => {
    injectBudgetEnv({ VOD_SEARCH_TIMEOUT_MS: '500' });
    const rig = await startCatalogRig('hmp-t022-b6-', [hangSource(0)]);
    const res = await searchVod(rig.app, { q: 'silentpost' });
    expectEndpointResUnderContract(res, [504], 'GET search(全部超时)', 'T028+T031');
    expect(res.status).toBe(504);
    expect(typeof res.body.code).toBe('string');
    expectNoSourceLocation(res, '504 problem 体(不泄上游地址)');
  });

  it('B7 [计划内红·待 T028/T031] 按 (source,VOD ID) 去重:同源重复 vod_id 只出一卡', async () => {
    const bulk = bulkSource(0);
    const duplicated: AppleCmsVodItem = { ...bulk.titleWorlds[0]!.briefItem, vod_name: '重复身份条目' };
    const rig = await startCatalogRig(
      'hmp-t022-b7-',
      [bulk],
      {
        listDocOverrides: {
          dupsearch: buildAppleCmsListDocument([bulk.titleWorlds[0]!.briefItem, duplicated]),
        },
      },
    );
    const res = await searchVod(rig.app, { q: 'dupsearch' });
    expectEndpointResUnderContract(res, [200, 502, 504], 'GET search(重复身份去重)', 'T028+T031');
    expect(res.status).toBe(200);
    const page = res.body as SearchPageDto;
    expect(page.items, '同源同 vod_id 去重为一卡').toHaveLength(1);
    expect(['夹具批量片01号', '重复身份条目']).toContain(page.items[0]!.title);
  });

  it('B8 [计划内红·待 T028/T031] 公共读取不根据 cookie 过滤、不设置身份 cookie(带/不带会话响应一致)', async () => {
    const rig = await startCatalogRig('hmp-t022-b8-', [bulkSource(0)]);
    const loggedIn = await login(rig.app, 'admin', 'password-123');
    expect(loggedIn.status).toBe(200);
    const guest = await searchVod(rig.app, { q: 'bulksearch' });
    const authed = await request(rig.app.getHttpServer())
      .get('/api/public/vod/search')
      .query({ q: 'bulksearch' })
      .set('Cookie', cookiePairOf(loggedIn));
    expectEndpointResUnderContract(guest, [200, 502, 504], 'GET search(游客)', 'T028+T031');
    expect(guest.status).toBe(200);
    expect(authed.status).toBe(200);
    expect(authed.body, '带会话 Cookie 不得过滤/增减公共条目').toEqual(guest.body);
    expect(guest.headers['set-cookie']).toBeUndefined();
    expect(authed.headers['set-cookie']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* C 公共预览/详情                                                      */
/* ------------------------------------------------------------------ */

const VOD_PREVIEW_KEYS = [
  'titleRef',
  'title',
  'description',
  'year',
  'sourceLabel',
  'posterRef',
  'previewRevision',
  'fetchedAt',
  'expiresAt',
  'lines',
] as const;
const VOD_PREVIEW_LINE_KEYS = ['lineRef', 'name', 'episodes'] as const;
const VOD_PREVIEW_EPISODE_KEYS = ['episodeRef', 'label', 'status', 'reason'] as const;

describe('T022 · C 公共预览 GET /api/public/vod/titles/:titleRef(api.md §2)', () => {
  it('C1 [计划内红·待 T028/T031] 有效 ref → 200 VodPreview 契约形状(candidate/unsupported/reason 枚举),无个人字段/无源位置', async () => {
    const rig = await startCatalogRig('hmp-t022-c1-', [
      createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } }),
      createHealthyBetaSource({ address: { host: '127.0.0.1', port: 0 } }),
    ]);
    const previewByKeyword = async (keyword: string): Promise<{ res: request.Response; titleRef: string }> => {
      const search = await searchVod(rig.app, { q: keyword });
      expectEndpointResUnderContract(search, [200, 502, 504], `GET search(${keyword})`, 'T028+T031');
      expect(search.status).toBe(200);
      const card = (search.body as SearchPageDto).items[0];
      expect(card, `${keyword} 应有首卡`).toBeDefined();
      const res = await request(rig.app.getHttpServer()).get(
        `/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`,
      );
      expectEndpointResUnderContract(res, [200, 404, 410, 422], `GET titles(${keyword})`, 'T028+T031');
      expect(res.status).toBe(200);
      return { res, titleRef: card!.titleRef };
    };

    // 形态一:三集连续剧(单线 3 候选)
    const serial = await previewByKeyword('stardust');
    const serialPreview = serial.res.body as VodPreviewDto;
    expectExactKeys(serialPreview, VOD_PREVIEW_KEYS, 'VodPreview');
    expect(serialPreview.titleRef).toBe(serial.titleRef);
    expect(serialPreview.title).toBe('fixture·星尘信使');
    expect(serialPreview.year).toBe('2024');
    expect(serialPreview.posterRef).toBeNull();
    expect(serialPreview.previewRevision).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(Date.parse(serialPreview.fetchedAt)), 'fetchedAt 应为 ISO8601').toBe(false);
    expect(Number.isNaN(Date.parse(serialPreview.expiresAt)), 'expiresAt 应为 ISO8601').toBe(false);
    expect(serialPreview.lines).toHaveLength(1);
    const serialLine = serialPreview.lines[0]!;
    expectExactKeys(serialLine, VOD_PREVIEW_LINE_KEYS, 'VodPreviewLine');
    expect(serialLine.episodes).toHaveLength(3);
    for (const episode of serialLine.episodes) {
      expectExactKeys(episode, VOD_PREVIEW_EPISODE_KEYS, 'VodPreviewEpisode');
      expect(episode.status).toBe('candidate');
      expect(episode.reason).toBeNull();
      expect(typeof episode.episodeRef).toBe('string');
    }
    expectNoPersonalMarkers(serial.res, 'VodPreview(连续剧)');
    expectNoSourceLocation(serial.res, 'VodPreview(无源位置)');

    // 形态二:缺集/重复编号世界(identity_ambiguous / unsupported 至少其一可见)
    const gapped = await previewByKeyword('mistfiles');
    const gappedPreview = gapped.res.body as VodPreviewDto;
    const gappedEpisodes = gappedPreview.lines.flatMap((line) => line.episodes);
    expect(gappedEpisodes.length).toBeGreaterThanOrEqual(1);
    for (const episode of gappedEpisodes) {
      expectExactKeys(episode, VOD_PREVIEW_EPISODE_KEYS, 'VodPreviewEpisode(缺集世界)');
      expect(['candidate', 'unsupported']).toContain(episode.status);
      expect([null, 'identity_ambiguous', 'format_unsupported']).toContain(episode.reason);
    }
    const ambiguousSeen = gappedEpisodes.some((episode) => episode.reason === 'identity_ambiguous');
    const unsupportedSeen = gappedEpisodes.some((episode) => episode.status === 'unsupported');
    expect(
      ambiguousSeen || unsupportedSeen,
      '重复键/重复线路世界应出现 identity_ambiguous 或 unsupported 形态(data-model §2)',
    ).toBe(true);
    expectNoPersonalMarkers(gapped.res, 'VodPreview(缺集世界)');
    expectNoSourceLocation(gapped.res, 'VodPreview(缺集世界,无源位置)');
  });

  it('C2 [计划内红·待 T028/T031] 伪造 ref → 404 同形;禁源后旧 ref → 410 VOD_PREVIEW_EXPIRED(先失效缓存再拒绝旧页)', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-c2-', [alpha]);
    const { titleRef } = await previewFirstCard(rig.app, 'stardust');
    // 伪造 ref:404 与不存在同形
    const forged = await request(rig.app.getHttpServer()).get(
      `/api/public/vod/titles/${encodeURIComponent(`vod-title-${randomUUID()}`)}`,
    );
    expectEndpointResUnderContract(forged, [404], 'GET titles(伪造 ref)', 'T028+T031');
    expect(forged.status).toBe(404);
    const forged2 = await request(rig.app.getHttpServer()).get(
      `/api/public/vod/titles/${encodeURIComponent(`vod-title-${randomUUID()}`)}`,
    );
    expect(forged2.status).toBe(404);
    expect(forged2.body).toEqual(forged.body);
    // 禁源 → 缓存先失效 → 旧 ref 复读 410 VOD_PREVIEW_EXPIRED
    Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(rig.sourceIds[alpha.sourceId]!);
    const stale = await request(rig.app.getHttpServer()).get(
      `/api/public/vod/titles/${encodeURIComponent(titleRef)}`,
    );
    expectEndpointResUnderContract(stale, [410], 'GET titles(禁源后旧 ref)', 'T028+T031');
    expectProblem(stale, 410, ProblemCode.VOD_PREVIEW_EXPIRED);
  });

  it('C3 [计划内红·待 T028/T031] 超预算(21 线路 > 20)→ 422 VOD_DETAIL_TOO_LARGE 整次失败', async () => {
    const oversize = createFixtureVodSource({
      sourceId: 'fixture-vod-source-oversize',
      displayName: '夹具超线路源',
      behavior: 'healthy',
      address: { host: '127.0.0.1', port: 0 },
      titleWorlds: [oversizeTitleWorld('http://127.0.0.1:0')],
    });
    const rig = await startCatalogRig('hmp-t022-c3-', [oversize]);
    const search = await searchVod(rig.app, { q: 'bigshow' });
    expectEndpointResUnderContract(search, [200, 502, 504], 'GET search(bigshow)', 'T028+T031');
    expect(search.status).toBe(200);
    const card = (search.body as SearchPageDto).items[0];
    expect(card).toBeDefined();
    const res = await request(rig.app.getHttpServer()).get(
      `/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`,
    );
    expectEndpointResUnderContract(res, [422], 'GET titles(超线路预算)', 'T028+T031');
    expectProblem(res, 422, ProblemCode.VOD_DETAIL_TOO_LARGE);
  });

  it('C4 [计划内红·待 T028/T031] 预览/搜索不物化、不建个人记录(公共列表/vod_title/operation 零写入)', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-c4-', [alpha]);
    await previewFirstCard(rig.app, 'stardust');
    expect(tableCountOf('vod_title'), '预览不得物化 vod_title').toBe(0);
    expect(tableCountOf('vod_materialization_operation'), '预览不得建物化操作').toBe(0);
    expect(tableCountOf('media_item'), '预览不得写公共媒体').toBe(0);
    const publicList = await request(rig.app.getHttpServer()).get('/api/public/media');
    expect(publicList.status).toBe(200);
    expect((publicList.body as { total: number }).total, '公共列表不得出现预览内容').toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* D 公共媒体/分集                                                      */
/* ------------------------------------------------------------------ */

describe('T022 · D 公共媒体与分集(api.md §2;media 既有面为绿基线)', () => {
  it('D1 [绿基线] GET /api/public/media 既有投影不回归:分页/q/type 过滤、无个人字段、无源位置', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t022-d1-' });
    const world = await seedPlaybackWorld(rig, { username: 'catalog-owner' });
    const list = await request(rig.app.getHttpServer()).get('/api/public/media');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expectExactKeys(list.body, ['items', 'page', 'pageSize', 'total'], 'PublicMediaPage');
    const page = list.body as { items: Array<Record<string, unknown>>; total: number };
    expect(page.items.some((item) => item['id'] === world.iptv.mediaId), '启用源频道应公共可见').toBe(true);
    for (const item of page.items) {
      expect(typeof item['id']).toBe('string');
      expect(typeof item['title']).toBe('string');
      expect(typeof item['type']).toBe('string');
      expect(['available', 'unavailable']).toContain(item['availability']);
    }
    expectNoPersonalMarkers(list, '公共 media 列表');
    expectNoSourceLocation(list, '公共 media 列表(无源位置)');

    const filtered = await request(rig.app.getHttpServer()).get('/api/public/media').query({ q: '夹具频道' });
    expect(filtered.status).toBe(200);
    expect((filtered.body as { total: number }).total).toBe(1);
    const typed = await request(rig.app.getHttpServer()).get('/api/public/media').query({ type: 'movie' });
    expect(typed.status).toBe(200);
    expect(
      (typed.body as { items: Array<Record<string, unknown>> }).items.some(
        (item) => item['id'] === world.iptv.mediaId,
      ),
      'type=movie 不应含频道',
    ).toBe(false);
    // 严格 query:身份声明字段不得扩大读取(既有 StrictQueryPipe)
    const forged = await request(rig.app.getHttpServer())
      .get('/api/public/media')
      .query({ profileId: randomUUID() });
    expectProblem(forged, 400, ProblemCode.VALIDATION_FAILED);
  });

  it('D2 [绿基线] GET /api/public/media/:id 既有详情:白名单投影 + 010 扩展字段若在场必须合法;404 同形', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t022-d2-' });
    const world = await seedPlaybackWorld(rig, { username: 'catalog-owner' });
    const detail = await request(rig.app.getHttpServer()).get(`/api/public/media/${world.iptv.mediaId}`);
    expect(detail.status).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    const body = detail.body as Record<string, unknown>;
    for (const key of ['id', 'type', 'title', 'description', 'posterRef', 'contentLevel', 'availability']) {
      expect(Object.hasOwn(body, key), `既有字段 ${key} 应在场`).toBe(true);
    }
    // 010 扩展(T030 落地前可缺省):在场则必须属合法枚举/形态
    if (Object.hasOwn(body, 'detailKind')) {
      expect(['standalone', 'vod_title', 'vod_episode']).toContain(body['detailKind']);
    }
    if (Object.hasOwn(body, 'parentMediaId')) {
      expect(body['parentMediaId'] === null || typeof body['parentMediaId'] === 'string').toBe(true);
    }
    expectNoPersonalMarkers(detail, '公共媒体详情');
    expectNoSourceLocation(detail, '公共媒体详情(无源位置/播放地址)');
    // 404 同形:未知 vs 不可见(无资源孤立行)
    const missing = await request(rig.app.getHttpServer()).get(`/api/public/media/${randomUUID()}`);
    const invisible = await request(rig.app.getHttpServer()).get(`/api/public/media/${world.invisibleMediaId}`);
    expectProblem(missing, 404, ProblemCode.NOT_FOUND);
    expect(invisible.status).toBe(404);
    expect(invisible.body).toEqual(missing.body);
  });

  it('D3 [计划内红·待 T030/T031] GET /public/media/:id/episodes 非父媒体(standalone 频道)→ 400 VOD_EPISODE_REQUIRED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t022-d3-' });
    const world = await seedPlaybackWorld(rig, { username: 'catalog-owner' });
    const res = await request(rig.app.getHttpServer()).get(`/api/public/media/${world.iptv.mediaId}/episodes`);
    expectEndpointResUnderContract(res, [400], 'GET /api/public/media/:id/episodes(非父)', 'T030+T031');
    expectProblem(res, 400, ProblemCode.VOD_EPISODE_REQUIRED);
  });

  it('D4 [计划内红·待 T030/T031] vod 父项 episodes → 200 StableEpisodes 契约形状(sequenceOrdinal 映射种子序列)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t022-d4-' });
    const world = await seedPlaybackWorld(rig, { username: 'catalog-owner' });
    const sourceId = seedVodSourceRow(world.householdId, 'http://cms.example.com/api.php?ac=list');
    const seeded = seedVodTitleWorld({
      householdId: world.householdId,
      sourceId,
      upstreamVodId: '9001',
      name: 'fixture·稳定分集剧',
      episodes: [
        { episodeKey: '01', label: '第01集', ordinal: 1, sequenceStatus: 'ordered' },
        { episodeKey: '02', label: '第02集', ordinal: 2, sequenceStatus: 'ordered' },
        { episodeKey: '04', label: '第04集', ordinal: 4, sequenceStatus: 'ordered' },
      ],
    });
    const res = await request(rig.app.getHttpServer()).get(`/api/public/media/${seeded.parentMediaId}/episodes`);
    expectEndpointResUnderContract(res, [200, 404], 'GET /api/public/media/:id/episodes(已物化父项)', 'T030+T031');
    expect(res.status, '已物化父项应 200').toBe(200);
    expectExactKeys(
      res.body,
      ['parentMediaId', 'detailRevision', 'fetchedAt', 'stale', 'lines', 'nextCursor'],
      'StableEpisodes',
    );
    const body = res.body as StableEpisodesDto;
    expect(body.parentMediaId).toBe(seeded.parentMediaId);
    expect(body.detailRevision).toBe(seeded.detailRevision);
    expect(body.stale).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.lines).toHaveLength(1);
    const line = body.lines[0]!;
    expectExactKeys(line, ['lineRef', 'name', 'episodes'], 'StableEpisodeLine');
    expect(line.episodes).toHaveLength(3);
    for (const episode of line.episodes) {
      expectExactKeys(episode, ['mediaId', 'label', 'availability', 'sequenceOrdinal'], 'StableEpisodeItem');
      expect(['candidate', 'unavailable']).toContain(episode.availability);
      expect(seeded.episodeMediaIds).toContain(episode.mediaId);
    }
    expect(line.episodes.map((episode) => episode.label)).toEqual(['第01集', '第02集', '第04集']);
    expect(line.episodes.map((episode) => episode.sequenceOrdinal)).toEqual([1, 2, 4]);
    expectNoPersonalMarkers(res, 'StableEpisodes');
    expectNoSourceLocation(res, 'StableEpisodes(无源位置)');
  });

  it('D5 [计划内红·待 T030/T031] 每页总计 100 子项 + 修订绑定 cursor + 详情变化 → 409 VOD_DETAIL_CHANGED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t022-d5-' });
    const world = await seedPlaybackWorld(rig, { username: 'catalog-owner' });
    const sourceId = seedVodSourceRow(world.householdId, 'http://cms.example.com/api.php?ac=list');
    const seeded = seedVodTitleWorld({
      householdId: world.householdId,
      sourceId,
      upstreamVodId: '9002',
      name: 'fixture·百集分页剧',
      episodes: Array.from({ length: 105 }, (_unused, index) => ({
        episodeKey: String(index + 1).padStart(3, '0'),
        label: `第${String(index + 1).padStart(3, '0')}集`,
        ordinal: index + 1,
        sequenceStatus: 'ordered' as const,
      })),
    });
    const first = await request(rig.app.getHttpServer()).get(
      `/api/public/media/${seeded.parentMediaId}/episodes`,
    );
    expectEndpointResUnderContract(first, [200, 404], 'GET episodes(分页首页)', 'T030+T031');
    expect(first.status).toBe(200);
    const page1 = first.body as StableEpisodesDto;
    const page1Count = page1.lines.reduce((sum, line) => sum + line.episodes.length, 0);
    expect(page1Count, '每页总计 100 子项(api.md §2)').toBe(100);
    expect(page1.nextCursor, '105 子项应有下一页 cursor').toBeTypeOf('string');

    // 详情变化:current_detail_revision 前进(+ 快照 rev2 一致落行)→ 旧 cursor 必须 409
    const now = new Date().toISOString();
    Database.db.prepare('UPDATE vod_title SET current_detail_revision = 2 WHERE id = ?').run(seeded.titleId);
    Database.db
      .prepare(
        'INSERT INTO vod_detail_snapshot (household_id, title_id, revision, locator_revision, validated_private_payload, fetched_at, expires_at) VALUES (?, ?, 2, 1, ?, ?, ?)',
      )
      .run(
        world.householdId,
        seeded.titleId,
        JSON.stringify({ fixture: '9002-r2' }),
        now,
        new Date(Date.parse(now) + 86_400_000).toISOString(),
      );
    const second = await request(rig.app.getHttpServer())
      .get(`/api/public/media/${seeded.parentMediaId}/episodes`)
      .query({ cursor: page1.nextCursor ?? '' });
    expectEndpointResUnderContract(second, [200, 409, 404], 'GET episodes(cursor 修订绑定)', 'T030+T031');
    expect(second.status, `详情修订变化后旧 cursor 应 409(实际 ${second.status})`).toBe(409);
    expectProblem(second, 409, ProblemCode.VOD_DETAIL_CHANGED);
  });
});

/* ------------------------------------------------------------------ */
/* E 物化 POST /api/vod/materializations                                */
/* ------------------------------------------------------------------ */

const MATERIALIZED_KEYS = [
  'parentMediaId',
  'mediaId',
  'detailRevision',
  'catalogRevision',
  'replayed',
  'candidateRef',
  'registeredCandidateRef',
] as const;

describe('T022 · E 物化 POST /api/vod/materializations(api.md §3 + §7 I1)', () => {
  it('E1 [计划内红·待 T029/T031] 首次 operationKey → 201 Materialized 契约形状(两候选引用 null),零个人/零源位置', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-e1-', [alpha]);
    const cookie = await profileCookieOf(rig.app);
    const { titleRef, preview } = await previewFirstCard(rig.app, 'stardust');
    const episodeRef = preview.lines[0]?.episodes[0]?.episodeRef;
    expect(episodeRef, '预览应有候选分集').toBeTypeOf('string');
    const res = await postMaterialization(rig.app, cookie, {
      titleRef,
      episodeRef,
      previewRevision: preview.previewRevision,
      operationKey: randomUUID(),
    });
    expectEndpointResUnderContract(res, [201], 'POST /api/vod/materializations(首次)', 'T029+T031');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expectExactKeys(res.body, MATERIALIZED_KEYS, 'Materialized');
    const body = res.body as MaterializedDto;
    expect(body.replayed).toBe(false);
    expect(body.candidateRef).toBeNull();
    expect(body.registeredCandidateRef).toBeNull();
    expect(body.detailRevision).toBeGreaterThanOrEqual(1);
    expect(body.catalogRevision).toBeGreaterThanOrEqual(1);
    expectNoPersonalMarkers(res, 'Materialized');
    expectNoSourceLocation(res, 'Materialized(无源位置)');
  });

  it('E2 [计划内红·待 T029/T031] 同成功 key 重放 → 200 replayed=true 同一结果;新 key 同目标 → 201 复用稳定 mediaId', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-e2-', [alpha]);
    const cookie = await profileCookieOf(rig.app);
    const { titleRef, preview } = await previewFirstCard(rig.app, 'stardust');
    const episodeRef = preview.lines[0]?.episodes[0]?.episodeRef ?? '';
    const operationKey = randomUUID();
    const firstBody = {
      titleRef,
      episodeRef,
      previewRevision: preview.previewRevision,
      operationKey,
    };
    const first = await postMaterialization(rig.app, cookie, firstBody);
    expectEndpointResUnderContract(first, [201], 'POST materializations(首次)', 'T029+T031');
    const materialized = first.body as MaterializedDto;
    // 同成功 key 重放 → 200 同结果(replayed=true,不续 TTL 的结果形态一致)
    const replay = await postMaterialization(rig.app, cookie, firstBody);
    expect(replay.status, '同成功 key 重放应 200').toBe(200);
    expect(replay.body as MaterializedDto).toMatchObject({
      mediaId: materialized.mediaId,
      parentMediaId: materialized.parentMediaId,
      detailRevision: materialized.detailRevision,
      catalogRevision: materialized.catalogRevision,
      replayed: true,
    });
    // 新 key 同目标 → 201,稳定 ID 复用(api.md §3「稳定 key 已存在可复用 ID」)
    const secondKey = await postMaterialization(rig.app, cookie, { ...firstBody, operationKey: randomUUID() });
    expect(secondKey.status, '新 key 同目标应 201').toBe(201);
    expect((secondKey.body as MaterializedDto).mediaId).toBe(materialized.mediaId);
    expect((secondKey.body as MaterializedDto).parentMediaId).toBe(materialized.parentMediaId);
  });

  it('E3 [计划内红·待 T029/T031] 同 key 异摘要(不同 episodeRef)→ 409 IDEMPOTENCY_CONFLICT', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-e3-', [alpha]);
    const cookie = await profileCookieOf(rig.app);
    const { titleRef, preview } = await previewFirstCard(rig.app, 'stardust');
    const episodeRefs = preview.lines[0]?.episodes.map((episode) => episode.episodeRef) ?? [];
    expect(episodeRefs.length, '预览应至少两集').toBeGreaterThanOrEqual(2);
    const operationKey = randomUUID();
    const first = await postMaterialization(rig.app, cookie, {
      titleRef,
      episodeRef: episodeRefs[0]!,
      previewRevision: preview.previewRevision,
      operationKey,
    });
    expectEndpointResUnderContract(first, [201], 'POST materializations(首次)', 'T029+T031');
    const conflict = await postMaterialization(rig.app, cookie, {
      titleRef,
      episodeRef: episodeRefs[1]!,
      previewRevision: preview.previewRevision,
      operationKey,
    });
    expect(conflict.status, '同 key 异摘要应 409').toBe(409);
    expectProblem(conflict, 409, ProblemCode.IDEMPOTENCY_CONFLICT);
  });

  it('E4 [计划内红·待 T029/T031] 预览过期(禁源失效缓存后新 key 物化)→ 410 VOD_PREVIEW_EXPIRED', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-e4-', [alpha]);
    const cookie = await profileCookieOf(rig.app);
    const { titleRef, preview } = await previewFirstCard(rig.app, 'stardust');
    const episodeRef = preview.lines[0]?.episodes[0]?.episodeRef ?? '';
    // 禁源:api.md §2「禁源/配置失配先失效缓存再拒绝旧页」→ 原 ref 过期(DB 直改注明:等价管理停用)
    Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(rig.sourceIds[alpha.sourceId]!);
    const res = await postMaterialization(rig.app, cookie, {
      titleRef,
      episodeRef,
      previewRevision: preview.previewRevision,
      operationKey: randomUUID(),
    });
    expectEndpointResUnderContract(res, [410], 'POST materializations(预览过期)', 'T029+T031');
    expectProblem(res, 410, ProblemCode.VOD_PREVIEW_EXPIRED);
  });

  it('E5 [计划内红·待 T029/T031] 新操作预览变化(请求 previewRevision 与当前不符)→ 409 VOD_DETAIL_CHANGED', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-e5-', [alpha]);
    const cookie = await profileCookieOf(rig.app);
    const { titleRef, preview } = await previewFirstCard(rig.app, 'stardust');
    const episodeRef = preview.lines[0]?.episodes[0]?.episodeRef ?? '';
    // 携带「用户所见修订」与当前预览不符:服务端必须以 VOD_DETAIL_CHANGED 拒绝重选,
    // 不得静默接受(也不得误作 400/410;api.md §3「新操作预览变化 409」)。
    const res = await postMaterialization(rig.app, cookie, {
      titleRef,
      episodeRef,
      previewRevision: preview.previewRevision + 1,
      operationKey: randomUUID(),
    });
    expectEndpointResUnderContract(res, [409], 'POST materializations(预览变化)', 'T029+T031');
    expectProblem(res, 409, ProblemCode.VOD_DETAIL_CHANGED);
  });

  it('E6 [计划内红·待 T029/T031] 净配额收紧(VOD_MAX_PARENT_TITLES=1)→ 第二父项 409 VOD_QUOTA_EXCEEDED', async () => {
    injectBudgetEnv({ VOD_MAX_PARENT_TITLES: '1' });
    const bulk = bulkSource(0, 'bulksearch', 5001, 3);
    // T031 rig 接线:同 B1——整列表文档覆盖提供 3 条批量世界,第二卡(secondCard)
    // 才可达(逐条 wd 路由去重形态只出单卡)。
    const rig = await startCatalogRig('hmp-t022-e6-', [bulk], {
      listDocOverrides: {
        bulksearch: buildAppleCmsListDocument(bulk.titleWorlds.map((world) => world.briefItem)),
      },
    });
    const cookie = await profileCookieOf(rig.app);
    const first = await previewFirstCard(rig.app, 'bulksearch');
    const firstRes = await postMaterialization(rig.app, cookie, {
      titleRef: first.titleRef,
      episodeRef: first.preview.lines[0]?.episodes[0]?.episodeRef ?? '',
      previewRevision: first.preview.previewRevision,
      operationKey: randomUUID(),
    });
    expectEndpointResUnderContract(firstRes, [201], 'POST materializations(配额内首次)', 'T029+T031');
    // 第二个不同父项(同源不同 upstreamVodId 的第二卡)
    const search = await searchVod(rig.app, { q: 'bulksearch' });
    expect(search.status).toBe(200);
    const secondCard = (search.body as SearchPageDto).items[1];
    expect(secondCard, '批量源应有第二卡').toBeDefined();
    const secondPreview = await request(rig.app.getHttpServer()).get(
      `/api/public/vod/titles/${encodeURIComponent(secondCard!.titleRef)}`,
    );
    expectEndpointResUnderContract(secondPreview, [200, 404, 410, 422], 'GET titles(第二父项)', 'T028+T031');
    expect(secondPreview.status).toBe(200);
    const overQuota = await postMaterialization(rig.app, cookie, {
      titleRef: secondCard!.titleRef,
      episodeRef: (secondPreview.body as VodPreviewDto).lines[0]?.episodes[0]?.episodeRef ?? '',
      previewRevision: (secondPreview.body as VodPreviewDto).previewRevision,
      operationKey: randomUUID(),
    });
    expectEndpointResUnderContract(overQuota, [409], 'POST materializations(净配额超限)', 'T029+T031');
    expectProblem(overQuota, 409, ProblemCode.VOD_QUOTA_EXCEEDED);
  });

  it('E7 [计划内红·待 T029/T031] candidateRef 分支:oneOf 形态被接受;伪造/无绑定候选 → 404 同形(候选绑定冲突)', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-e7-', [alpha]);
    const cookie = await profileCookieOf(rig.app);
    const first = await postMaterialization(rig.app, cookie, {
      candidateRef: `vod-candidate-${randomUUID()}`,
      previewRevision: 1,
      operationKey: randomUUID(),
    });
    // oneOf 分支接受(不得按未知字段 400 拒);无绑定候选 → 404 候选绑定冲突(NotFound404 同形)
    expectEndpointResUnderContract(first, [201, 404], 'POST materializations(candidateRef 分支)', 'T029+T031');
    expect(first.status, '伪造/无绑定候选应 404').toBe(404);
    const second = await postMaterialization(rig.app, cookie, {
      candidateRef: `vod-candidate-${randomUUID()}`,
      previewRevision: 1,
      operationKey: randomUUID(),
    });
    expect(second.status).toBe(404);
    expect(second.body, '候选绑定冲突与不存在同形').toEqual(first.body);
  });

  it('E8 [计划内红·待 T029/T031] 物化授权:游客 401;已登录无当前 Profile → 403 ACTIVE_PROFILE_REQUIRED', async () => {
    const alpha = createHealthyAlphaSource({ address: { host: '127.0.0.1', port: 0 } });
    const rig = await startCatalogRig('hmp-t022-e8-', [alpha]);
    const body = {
      titleRef: `vod-title-${randomUUID()}`,
      episodeRef: `vod-episode-${randomUUID()}`,
      previewRevision: 1,
      operationKey: randomUUID(),
    };
    const guest = await postMaterialization(rig.app, '', body);
    expectEndpointResUnderContract(guest, [401], 'POST /api/vod/materializations(游客)', 'T029+T031');
    expectProblem(guest, 401, ProblemCode.SESSION_INVALID);
    // 登录但不选档:SessionGuard 放行 → CurrentProfileGuard 403(次序:401 先于 403)
    const loggedIn = await login(rig.app, 'admin', 'password-123');
    expect(loggedIn.status).toBe(200);
    const noProfile = await postMaterialization(rig.app, cookiePairOf(loggedIn), body);
    expectEndpointResUnderContract(noProfile, [403], 'POST /api/vod/materializations(无当前 Profile)', 'T029+T031');
    expectProblem(noProfile, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  });
});

/* ------------------------------------------------------------------ */
/* F 授权负向回归(绿基线:新端点复用的同栈守卫次序)                       */
/* ------------------------------------------------------------------ */

describe('T022 · F 授权负向回归(新端点同栈守卫次序;未装配期双态断言,应绿)', () => {
  it('F1 新端点游客 401 先于 403:Settings/Profile 两栈锚点回归 + 未装配期 404 缺省形态钉住', async () => {
    const { app, cookie } = await settingsRig('hmp-t022-f1-');
    // 锚点 1(既有 Settings 栈):游客 401 先于「未解锁 403」
    expectProblem(
      await request(app.getHttpServer()).get('/api/settings/sources'),
      401,
      ProblemCode.SESSION_INVALID,
    );
    expectProblem(await postSource(app, '', vodSourceBody()), 401, ProblemCode.SESSION_INVALID);
    const lockedRead = await request(app.getHttpServer()).get('/api/settings/sources').set('Cookie', cookie);
    expectProblem(lockedRead, 403, 'SETTINGS_ACCESS_REQUIRED');

    // 新端点(未装配期双态;T031 装配后同一断言自动收紧为 401)
    const guestCases: Array<[string, () => Promise<request.Response>]> = [
      [
        'POST /api/settings/sources/:id/test',
        async () =>
          request(app.getHttpServer())
            .post(`/api/settings/sources/${randomUUID()}/test`)
            .send({ ownerPassword: 'whatever-password' }),
      ],
      [
        'POST /api/vod/materializations',
        async () =>
          request(app.getHttpServer())
            .post('/api/vod/materializations')
            .send({
              titleRef: `vod-title-${randomUUID()}`,
              episodeRef: `vod-episode-${randomUUID()}`,
              previewRevision: 1,
              operationKey: randomUUID(),
            }),
      ],
      ['GET /api/me/vod/preferences', () => request(app.getHttpServer()).get('/api/me/vod/preferences')],
      [
        'PATCH /api/me/vod/preferences',
        async () =>
          request(app.getHttpServer())
            .patch('/api/me/vod/preferences')
            .send({ expectedVersion: 0, autoplayNext: false, operationKey: randomUUID() }),
      ],
      [
        'GET /api/me/vod/titles/:parentId/progress',
        () => request(app.getHttpServer()).get(`/api/me/vod/titles/${randomUUID()}/progress`),
      ],
    ];
    for (const [label, send] of guestCases) {
      const res = await send();
      expectGuestAuthOrUnassembled(res, label, 'T031');
    }
  });

  it('F2 Profile 栈次序锚点:游客 401 → 登录未选档 403 ACTIVE_PROFILE_REQUIRED(读面既有实现)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t022-f2-' });
    expect((await initialize(rig.app)).status).toBe(201);
    expectProblem(
      await request(rig.app.getHttpServer()).get('/api/me/history'),
      401,
      ProblemCode.SESSION_INVALID,
    );
    const loggedIn = await login(rig.app, 'admin', 'password-123');
    expect(loggedIn.status).toBe(200);
    const noProfile = await request(rig.app.getHttpServer())
      .get('/api/me/history')
      .set('Cookie', cookiePairOf(loggedIn));
    expectProblem(noProfile, 403, ProblemCode.ACTIVE_PROFILE_REQUIRED);
  });

  it('F3 伪造 profileId/householdId(body/query)一律 400:身份只从服务端当前 Profile 推导', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-t022-f3-' });
    expect((await initialize(rig.app)).status).toBe(201);
    const loggedIn = await login(rig.app, 'admin', 'password-123');
    const cookie = cookiePairOf(loggedIn);
    // 守卫链先于严格入参:需已选主档案并解锁设置(同 T021 B6 口径),伪造字段才抵达 400 层
    await selectMainAndUnlockSettings(rig.app, cookie);
    // Settings 写面 body 伪造(既有严格入参)
    const forgedSettings = await postSource(rig.app, cookie, { ...vodSourceBody(), profileId: randomUUID() });
    expectProblem(forgedSettings, 400, ProblemCode.VALIDATION_FAILED);
    // /me 读面 query 伪造
    const forgedQuery = await request(rig.app.getHttpServer())
      .get('/api/me/history')
      .query({ profileId: randomUUID() })
      .set('Cookie', cookie);
    expectProblem(forgedQuery, 400, ProblemCode.VALIDATION_FAILED);
    // 播放 resolve body 伪造(物化后播放链同栈)
    const forgedResolve = await request(rig.app.getHttpServer())
      .post('/api/playback/resolve')
      .set('Cookie', cookie)
      .send({ mediaId: randomUUID(), profileId: randomUUID() });
    expectProblem(forgedResolve, 400, ProblemCode.VALIDATION_FAILED);
  });
});
