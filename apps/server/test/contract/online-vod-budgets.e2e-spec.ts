import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type DatabaseConstructor from 'better-sqlite3';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import { mediaSource, vodSourceConfig } from '@platform/database/schema';
import { VOD_BUDGETS } from '@contexts/online-vod/domain/vod-budgets';
import { SWITCH_PROBE_BUDGETS } from '@contexts/online-vod/application/switch-probe.service';
import { VOD_CACHE } from '@contexts/online-vod/online-vod.tokens';
import type { VodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import type { ControlledMediaServer, ControlledRouteSpec, MediaRequestContext } from '../fixtures/controlled-media-server';
import {
  cleanupRigs,
  cookiePairOf,
  createControlledMediaServer,
  expectProblemContentType,
  initialize,
  login,
  startFreshApp,
} from '../helpers';
import { selectMainAndUnlockSettings } from '../helpers-management';
import {
  buildAppleCmsListDocument,
  createFixtureTitleWorld,
  createFixtureVodSource,
  createStandardEpisodePresentation,
  findUpstreamRoute,
  type AppleCmsListDocument,
  type AppleCmsVodItem,
  type FixtureHlsPresentation,
  type FixtureTitleWorld,
  type FixtureUpstreamSource,
} from '../fixtures/online-vod/fixture-upstream';

/**
 * T085(010-online-vod · Phase 8 证据任务):端到端预算钉面 ——
 * 「搜索总期限、SQL 批量查询无 N+1、详情/候选大规模预算及全局工作队列上限;
 * 失败优化只改真实瓶颈,不降低公开完整性或安全校验」。
 * 依赖 T083/T084 已落地;服务端现状全绿(预算面 VOD_BUDGETS/vod-config、缓存
 * VodCache、搜索/预览/物化/候选/测速全链装配)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/tasks.md T085 原文 + T019(预算契约值:搜索 8s/并发 3、
 *   预览 8s/4MiB、详情 20 线/单线 2000/总 5000/4MiB、进程 256MiB)+ T071(测速:
 *   单候选 3s/1MiB、全次 5s、内部并发 3)+ T028/T030(搜索/分集批量查询);
 * - docs/specs/010-online-vod/quickstart.md Q1/SC001:「游客 20 次搜索,每源 100 样本,
 *   >=19 次 8s 内看到结果及部分失败。全部失败区别于无匹配」;
 * - docs/specs/010-online-vod/contracts/api.md §0(总期限 504/限流 429/资源忙不堆
 *   无界队列)、§2(搜索 10min/2000 结果/每页 20;详情「最多20线路/单线2000/合计
 *   5000/4MiB,超限422整次失败」;缓存「10min/最多2000结果……全进程最多256MiB、
 *   单详情4MiB,超额拒绝或淘汰最早过期项,ref 失效410」)、§5(测速「单候选3s/1MiB、
 *   全次5s,内部并发3」);
 * - apps/server/src/contexts/online-vod/infrastructure/vod-config.ts 16 个 VOD_* env
 *   表(只允许收紧;本文件预算收窄注入全部走该面,断言预算值取自 VOD_BUDGETS
 *   契约快照而非裸数字)。
 *
 * 与既有证据面的关系(引用不重复,详见 docs/specs/010-online-vod/evidence/performance.md):
 * - T028 search-preview.spec 16 例(单测注入时钟/闸计数):搜索轮转/去重/分页/并发合并/
 *   部分失败语义/A9「并发闸 ≤3 与 2000 结果上限」/缓存 C1-C3;本文件把「总期限+并发
 *   队列上限」钉到真实 HTTP 装配链(受控挂起源+上游峰值在飞计数);
 * - T022 B4/B6(catalog e2e):VOD_SEARCH_TIMEOUT_MS 收窄后的 partial/504 形态;本文件
 *   A1 以默认契约预算(8s)钉全链总期限,A2 以收窄预算钉并发队列的「排队」语义;
 * - T030 vod-public-catalog.spec N+1 守卫(unit;prepare 语句计数代理,105→305 语句数
 *   不变):本文件 D1 以同一手法经真实 HTTP 链(搜索→预览→物化→公共分集分页)复现;
 * - T083 A3(候选 hang 预算收敛)/E1(缓存 128B → 429)/C3(大详情 422):本文件 C2 为
 *   E1 语义复验,B 组补「恰界合法 + env 收窄 422」两侧,T083 不重复;
 * - T027/T030 store 批量面(unit):SQL 单查询+内存分组;D1 是其端到端观测面。
 *
 * 装配方式(沿用 010 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威迁移)+ initialize/login/
 *   selectMainAndUnlockSettings + Supertest 真实 HTTP;受控上游
 *   createControlledMediaServer(127.0.0.1 随机端口,LAN_ALLOWED_TARGETS='127.0.0.1',
 *   零真实外网);挂起形态 kind:'hang'(恒不回包,由服务端预算判 timeout);
 * - 预算 env 收窄注入(process.env,DI 解析期读;afterEach 恢复;T022/T083 同手法):
 *   A2 VOD_SEARCH_TIMEOUT_MS、B2 VOD_DETAIL_MAX_LINES、B4 VOD_DETAIL_MAX_EPISODES_PER_LINE、
 *   C1/C2 VOD_CACHE_MAX_TOTAL_BYTES;
 * - 上游峰值在飞计数:受控服务器 pendingResponseCount()(hang/未到期 slow 的未响应
 *   数),请求在飞期间等间隔采样取峰值 —— 并发队列上限的「上游峰值」观测面;
 * - 无 N+1 计数:Database.db 静态 getter 临时替换为 prepare 计数代理(T030 单测同手法;
 *   用例内 finally 恢复原 descriptor,drizzle getDb() 按连接同一性自动重建句柄),
 *   计数窗口只包住单次 HTTP 调用;
 * - DB 直改仅用于无 HTTP 语义的工厂事实:kind=vod 来源行(media_source +
 *   vod_source_config 一源一行;T022/T083 同款)。不改任何共享文件;临时目录隔离;
 *   无 git 操作。
 *
 * ───────────────────────── 绿/红口径 ─────────────────────────
 * 依赖面(T083/T084/预算/缓存/测速)全部已装配:本文件用例应全绿;「确属未实现
 * 语义标计划内红」经逐一核对后为零。可达性受限的语义以「引用单测/头注注记」表达:
 * - 缓存「淘汰最早过期项」的排序语义(expiresAtMs 升序 → createdAtMs 升序)由
 *   search-preview 单测 C1/C2 注入时钟钉面;e2e 无时钟快进(TTL 固定契约 10min),
 *   C1 钉的是同一淘汰路径的「最老在活条目先让位 → 换入新写」可达形态(put() 替换
 *   保留原 createdAtMs,首次搜索会话条目必为全表最老,任一淘汰事件必先移除之),
 *   不伪称覆盖完整排序;
 * - 测速「内部并发 3」的可见上限=单次候选数上限 3(T067 已钉 >3 refs 400),
 *   E1 以「3 挂起候选峰值在飞恰为 3」钉可达上限(串行执行峰值应为 1,无闸并发 >3
 *   违约,均可与本断言区分),不发明 4+ 候选形态;
 * - TTL 推进面/每家庭活对象配额(100/1000)/256MiB 缺省量级/预览 8s·4MiB:见文件尾
 *   「未覆盖项」,全部引用既有单测/e2e 面,不在此重复构造。
 * 预期计数:红 0 / 绿 12(A 2 + B 6 + C 2 + D 1 + E 1);两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

const SEARCH_URL = '/api/public/vod/search';
const PREVIEW_URL = '/api/public/vod/titles';
const MATERIALIZE_URL = '/api/vod/materializations';
const CANDIDATES_URL = '/api/vod/switch-candidates';
const PROBES_URL = '/api/vod/switch-probes';

/** 真实计时断言的 CI 抖动余量(预算上界 = 契约值 + 本余量;下界断言不受其影响:
 *  挂起源只在预算计时到期后收敛,elapsed 下界即契约值本身) */
const ELAPSED_SLACK_MS = 2_000;

/** RFC 9457 problem 白名单键(全局 ProblemJsonFilter;超集) */
const PROBLEM_ALLOWED_KEYS = ['type', 'title', 'status', 'code', 'detail', 'instance', 'annotations'] as const;

/** 源A 健康连续剧 / 源B 同名双胞胎(候选匹配素材;T083 同款命名) */
const SERIAL_NAME = 'fixture·预算信使';
const TWIN_LABELS = { hang1: '挂起甲', hang2: '挂起乙', hang3: '挂起丙' } as const;

/** 稳定错误断言:status + problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** problem 体键白名单 + 错误体零内部细节(上游地址/堆栈形态;T083 同款) */
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

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/* ------------------------------------------------------------------ */
/* 夹具世界(主源世界 + 换源双胞胎 + 批量面 + 合成详情体)                 */
/* ------------------------------------------------------------------ */

/** 标准单集呈现(rootPath 参数化,避免同端口路由互撞;T083 同手法) */
function presentationFor(prefix: string, episodeKey: string, origin: string, rootPath: string): FixtureHlsPresentation {
  return createStandardEpisodePresentation({
    presentationKey: `t085:${prefix}:${episodeKey}`,
    episodeKey,
    origin,
    rootPath: `${rootPath}/ep-${episodeKey}`,
    segmentCount: 1,
    segmentDurationSeconds: 60,
  });
}

/** 世界规格(端口绑定后由 rig 渲染为 FixtureTitleWorld) */
interface WorldSpec {
  readonly titleKey: string;
  readonly keyword: string;
  readonly upstreamVodId: number;
  readonly name: string;
  readonly episodeCount: number;
  readonly rootPath: string;
}

function buildWorld(origin: string, spec: WorldSpec): FixtureTitleWorld {
  return createFixtureTitleWorld({
    titleKey: spec.titleKey,
    searchKeyword: spec.keyword,
    upstreamVodId: spec.upstreamVodId,
    name: spec.name,
    year: '2024',
    remarks: `连载完毕 共${spec.episodeCount}集`,
    episodesTotal: spec.episodeCount,
    synopsis: 'T085 预算钉面素材(受控夹具,零真实外网)。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: Array.from({ length: spec.episodeCount }, (_unused, index) => {
          const episodeKey = String(index + 1).padStart(3, '0');
          return {
            episodeKey,
            label: `第${episodeKey}集`,
            presentation: presentationFor(spec.titleKey, episodeKey, origin, spec.rootPath),
            seasonKey: 'S01',
            ordinal: index + 1,
            sequenceStatus: 'ordered' as const,
          };
        }),
      },
    ],
  });
}

/** 换源双胞胎规格(同名录入源B;EP01 locator 经详情覆写指向挂起路径) */
interface TwinSpec {
  readonly upstreamVodId: number;
  readonly versionLabel: string;
  readonly hangPath: string;
}

function buildTwinWorld(origin: string, spec: TwinSpec): FixtureTitleWorld {
  return createFixtureTitleWorld({
    titleKey: `t085-twin-${spec.upstreamVodId}`,
    searchKeyword: 'probetwin',
    upstreamVodId: spec.upstreamVodId,
    name: SERIAL_NAME,
    year: '2024',
    versionLabel: spec.versionLabel,
    remarks: `跨源双胞胎 ${spec.versionLabel}`,
    episodesTotal: 3,
    synopsis: '源B 同名双胞胎(T085 测速并发面素材)。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [1, 2, 3].map((ordinal) => {
          // 3 位补位与主源世界一致:候选锚定按 episodeKey 严格相等
          // ('第01集' ≠ '第1集',宽度失配 → 零候选 —— T085 首轮实测教训)
          const episodeKey = String(ordinal).padStart(3, '0');
          return {
            episodeKey,
            label: `第${episodeKey}集`,
            presentation: presentationFor(
              `twin${spec.upstreamVodId}`,
              episodeKey,
              origin,
              `/vod/hls/t085-b-${spec.upstreamVodId}`,
            ),
            seasonKey: 'S01',
            ordinal,
            sequenceStatus: 'ordered' as const,
          };
        }),
      },
    ],
  });
}

/** 批量单集影片世界规格(同关键词 N 条,upstreamVodId 递增;缓存字节面用;T022 同款) */
function bulkWorldSpecs(keyword: string, idBase: number, count: number): WorldSpec[] {
  return Array.from({ length: count }, (_unused, index) => {
    const upstreamId = idBase + index;
    return {
      titleKey: `t085-bulk-${upstreamId}`,
      keyword,
      upstreamVodId: upstreamId,
      name: `夹具预算批量片${String(index + 1).padStart(2, '0')}号`,
      episodeCount: 1,
      rootPath: `/vod/hls/t085-bulk/${upstreamId}`,
    };
  });
}

/** 详情体覆写:按集键改写 vod_play_url 定位(T083 同手法;brief/搜索面不变) */
function detailBodyWithLocator(world: FixtureTitleWorld, locatorByEpisodeKey: Record<string, string>): string {
  const item = { ...world.item };
  item.vod_play_url = world.seed.lines
    .map((line) =>
      line.episodes
        .map((episode) => `${episode.label}$${locatorByEpisodeKey[episode.episodeKey] ?? episode.playlistUri}`)
        .join('#'),
    )
    .join('$$$');
  return JSON.stringify(buildAppleCmsListDocument([item]));
}

/**
 * 合成详情体(lines × episodesPerLine;详情预算面的 wire 注入点):字段全集对照
 * fixture-upstream buildAppleCmsVodItem 形态(vod_id 固定 8100 与覆写键一致);
 * locator 全部为 m3u8 形态 URL(解析为 candidate;预览/物化不真实抓取该路径,
 * 端口段无意义,不注册路由)。
 */
function detailBodyWithShape(lines: number, episodesPerLine: number): string {
  const item: AppleCmsVodItem = {
    vod_id: 8100,
    type_id: 6,
    type_name: 'fixture连续剧',
    vod_name: 'fixture·预算形态剧',
    vod_sub: '',
    vod_en: 'budgetshow',
    vod_letter: 'F',
    vod_remarks: '连载完毕',
    vod_year: '2024',
    vod_area: '',
    vod_lang: '',
    vod_version: '',
    vod_actor: '夹具演员甲,夹具演员乙',
    vod_director: '夹具导演',
    vod_blurb: 'T085 详情预算面合成详情(受控夹具)。',
    vod_content: '<p>T085 详情预算面合成详情(受控夹具)。</p>',
    vod_pubdate: '2026-01-01',
    vod_total: lines * episodesPerLine,
    vod_serial: String(lines * episodesPerLine),
    vod_time: '2026-01-01 00:00:00',
    vod_time_add: 1767225600,
    vod_play_from: Array.from({ length: lines }, (_unused, index) => `fixture线路${String(index + 1).padStart(2, '0')}`).join('$$$'),
    vod_play_url: Array.from({ length: lines }, (_unused, lineIndex) =>
      Array.from({ length: episodesPerLine }, (_unused, episodeIndex) => {
        const ordinal = lineIndex * episodesPerLine + episodeIndex + 1;
        return `第${ordinal}集$http://127.0.0.1:0/vod/hls/t085-budget/line-${lineIndex + 1}/ep-${episodeIndex + 1}/master.m3u8`;
      }).join('#'),
    ).join('$$$'),
    vod_play_note: '',
  };
  return JSON.stringify(buildAppleCmsListDocument([item]));
}

/* ------------------------------------------------------------------ */
/* rig:受控上游 + 全量迁移 app + 身份 + 缓存句柄                         */
/* ------------------------------------------------------------------ */

interface BudgetsRig {
  readonly app: INestApplication;
  readonly householdId: string;
  readonly server: ControlledMediaServer;
  readonly cookie: string;
  readonly profileId: string;
  readonly sourceLabel: string;
  readonly twinSourceLabel: string | null;
  readonly worlds: readonly FixtureTitleWorld[];
  readonly twins: readonly FixtureTitleWorld[];
  /** 进程缓存单例(VOD_CACHE;上限触达/淘汰断言的观测面) */
  readonly cache: VodCache;
}

/** 本文件注入的 VOD 预算 env(只许收紧;afterEach 统一清除,不跨用例/文件泄漏) */
const injectedEnvKeys: string[] = [];
function injectVodEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
    injectedEnvKeys.push(key);
  }
}

/** 受控服务器句柄(afterEach 统一关闭;文件级登记表) */
const activeMediaServers: ControlledMediaServer[] = [];

function householdIdOf(): string {
  const row = Database.db.prepare('SELECT id FROM household LIMIT 1').get() as { id: string } | undefined;
  expect(row, '夹具错误:household 行不存在(初始化未执行)').toBeDefined();
  return row!.id;
}

/** kind=vod 来源行(media_source + vod_source_config 一源一行;T022/T083 同款工厂事实)。
 *  createdAt 可显式错开:listEnabledVodSources ORDER BY created_at,id,同毫秒 seeding
 *  会退化为按随机 id 排序,破坏「主源排首位」的确定性轮转前提。 */
function seedVodSourceRow(householdId: string, name: string, remoteUrl: string, createdAt?: string): string {
  const sourceId = randomUUID();
  const now = createdAt ?? new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({ id: sourceId, householdId, kind: 'vod', name, remoteUrl, enabled: 1, createdAt: now, updatedAt: now })
      .run();
    tx.insert(vodSourceConfig).values({ householdId, sourceId, adapter: 'apple-cms-json' }).run();
  });
  return sourceId;
}

interface BudgetsRigOptions {
  /** 主源世界(单源承载;remoteUrl 指向受控端口独立 apiPath) */
  readonly worlds: readonly WorldSpec[];
  /** 换源双胞胎(第二健康源承载;候选/测速面) */
  readonly twins?: readonly TwinSpec[];
  /** 搜索挂起源个数(behavior=timeout;独立 apiPath;enabled 列表序排在主源之后) */
  readonly hangSearchSources?: number;
  /** 详情覆写(ids → detail body;ac=detail&ids= 命中即返回,先于路由表) */
  readonly detailOverrides?: ReadonlyMap<string, string>;
  /** 整列表覆盖关键词(wd → 该关键词全部 briefItem;T022 B1 同款 seam —— 夹具逐条
   *  wd 路由同路径去重只保留首条,批量形态须经整列表文档注入) */
  readonly listDocKeywords?: readonly string[];
}

interface FixturePair {
  readonly main: FixtureUpstreamSource;
  readonly twinsSource: FixtureUpstreamSource | null;
  readonly worlds: readonly FixtureTitleWorld[];
  readonly twins: readonly FixtureTitleWorld[];
}

function buildFixturePair(port: number, options: BudgetsRigOptions): FixturePair {
  const origin = `http://127.0.0.1:${port}`;
  const worlds = options.worlds.map((spec) => buildWorld(origin, spec));
  const twins = (options.twins ?? []).map((spec) => buildTwinWorld(origin, spec));
  const main = createFixtureVodSource({
    sourceId: 'fixture-vod-source-t085-main',
    displayName: '夹具预算源(T085)',
    behavior: 'healthy',
    apiPath: '/t085-src/api.php',
    address: { host: '127.0.0.1', port },
    titleWorlds: worlds,
  });
  const twinsSource =
    twins.length === 0
      ? null
      : createFixtureVodSource({
          sourceId: 'fixture-vod-source-t085-twins',
          displayName: '夹具换源源(T085)',
          behavior: 'healthy',
          apiPath: '/t085-src-b/api.php',
          address: { host: '127.0.0.1', port },
          titleWorlds: twins,
        });
  return { main, twinsSource, worlds, twins };
}

/**
 * 预算钉面 rig:受控 CMS 端口(主源/双胞胎源 raw 派发 + 挂起源整路径 hang + 媒体
 * 路由)+ 全量迁移 app + 登录/主档案 + 逐源 kind=vod 来源行。挂起源排在主源之后
 * seed(listEnabledVodSources ORDER BY created_at,id + 轮转指针初值 0):首个搜索
 * 的首波并发必含主源(健康结果可达)。
 */
async function startBudgetsRig(prefix: string, options: BudgetsRigOptions): Promise<BudgetsRig> {
  let pair = buildFixturePair(0, options);
  const hangApiPaths = Array.from(
    { length: options.hangSearchSources ?? 0 },
    (_unused, index) => `/t085-hang-${index + 1}/api.php`,
  );
  const detailOverrides = new Map<string, string>(options.detailOverrides ?? []);
  const listOverrides = new Map<string, AppleCmsListDocument>();

  /** 主源/双胞胎源 apiPath 派发(按名延迟解引用:受控服务器启动后重烙 pair) */
  const rawRespondOf = (sourceName: 'main' | 'twinsSource') => (context: MediaRequestContext) => {
    const ids = context.url.searchParams.get('ids');
    const override = ids !== null ? detailOverrides.get(ids) : undefined;
    if (context.url.searchParams.get('ac') === 'detail' && override !== undefined) {
      context.res.statusCode = 200;
      context.res.setHeader('content-type', 'application/json; charset=utf-8');
      context.res.end(override);
      return;
    }
    const listDoc = listOverrides.get(context.url.searchParams.get('wd') ?? '');
    if (context.url.searchParams.get('ac') === 'list' && listDoc !== undefined) {
      context.res.statusCode = 200;
      context.res.setHeader('content-type', 'application/json; charset=utf-8');
      context.res.end(JSON.stringify(listDoc));
      return;
    }
    const source = pair[sourceName];
    const route = source === null ? null : findUpstreamRoute(source.routes, context.url.href);
    if (source === null || route === null || route.response.kind === 'timeout') {
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

  const routeSpecs: ControlledRouteSpec[] = [
    { path: '/t085-src/api.php', kind: 'raw', respond: rawRespondOf('main') },
  ];
  if (options.twins !== undefined && options.twins.length > 0) {
    routeSpecs.push({ path: '/t085-src-b/api.php', kind: 'raw', respond: rawRespondOf('twinsSource') });
  }
  for (const hangApiPath of hangApiPaths) {
    routeSpecs.push({ path: hangApiPath, kind: 'hang' });
  }
  const server = await createControlledMediaServer({ routes: routeSpecs });
  activeMediaServers.push(server);

  // 受控服务器已监听真实端口:重烙世界(presentation/locator 命中真实路由;T067/T083 同手法)
  pair = buildFixturePair(server.port, options);
  for (const keyword of options.listDocKeywords ?? []) {
    const items = pair.worlds.filter((world) => world.searchKeyword === keyword).map((world) => world.briefItem);
    expect(items.length, `夹具错误:整列表覆盖 ${keyword} 无世界`).toBeGreaterThan(0);
    listOverrides.set(keyword, buildAppleCmsListDocument(items));
  }
  for (const twin of options.twins ?? []) {
    const world = pair.twins.find((entry) => entry.seed.upstreamVodId === twin.upstreamVodId);
    expect(world, `夹具错误:双胞胎 ${twin.upstreamVodId} 世界缺失`).toBeDefined();
    detailOverrides.set(
      String(twin.upstreamVodId),
      detailBodyWithLocator(world!, { '001': `${server.baseUrl}${twin.hangPath}` }),
    );
    server.setRoute(twin.hangPath, { kind: 'hang' });
  }

  // 媒体路由逐路径注册(raw;各世界 rootPath 已参数化不互撞)
  const mediaRoutes = new Map<string, { status: number; headers: Record<string, string>; body: string }>();
  for (const source of [pair.main, pair.twinsSource]) {
    if (source === null) continue;
    for (const route of source.routes) {
      if (route.path.startsWith('/t085-src')) continue;
      const pathname = route.path.split('?')[0] ?? route.path;
      if (route.response.kind === 'response' && !mediaRoutes.has(pathname)) {
        mediaRoutes.set(pathname, { status: route.response.status, headers: route.response.headers, body: route.response.body });
      }
    }
  }
  for (const [pathname, response] of mediaRoutes) {
    server.setRoute(pathname, {
      kind: 'raw',
      respond: (context: MediaRequestContext) => {
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
  const cookie = cookiePairOf(loggedIn);
  const profileId = await selectMainAndUnlockSettings(fresh.app, cookie);

  const householdId = householdIdOf();
  const sourceLabel = '夹具预算源(T085)';
  // 逐源错开 created_at(1ms 步进):启用来源清单序 = 主源 → 双胞胎源 → 挂起源…,
  // 轮转指针初值 0 → 首个搜索首波并发必含主源(健康结果可达;A2 队列断言前提)
  const seedBaseMs = Date.now();
  seedVodSourceRow(householdId, sourceLabel, `${server.baseUrl}/t085-src/api.php`, new Date(seedBaseMs).toISOString());
  const twinSourceLabel = pair.twinsSource === null ? null : '夹具换源源(T085)';
  if (twinSourceLabel !== null) {
    seedVodSourceRow(householdId, twinSourceLabel, `${server.baseUrl}/t085-src-b/api.php`, new Date(seedBaseMs + 1).toISOString());
  }
  hangApiPaths.forEach((hangApiPath, index) => {
    seedVodSourceRow(
      householdId,
      `夹具挂起源${index + 1}(T085)`,
      `${server.baseUrl}${hangApiPath}`,
      new Date(seedBaseMs + 2 + index).toISOString(),
    );
  });

  return {
    app: fresh.app,
    householdId,
    server,
    cookie,
    profileId,
    sourceLabel,
    twinSourceLabel,
    worlds: pair.worlds,
    twins: pair.twins,
    cache: fresh.app.get(VOD_CACHE) as VodCache,
  };
}

/* ------------------------------------------------------------------ */
/* 链式编排助手(搜索→预览→物化;候选→测速;T083 同款)                    */
/* ------------------------------------------------------------------ */

interface SearchPageLike {
  readonly searchId: string;
  readonly items: readonly { readonly titleRef: string; readonly sourceLabel: string }[];
  readonly sources: readonly { readonly status: string }[];
  readonly nextCursor: string | null;
  readonly partial: boolean;
  readonly reasons: readonly string[];
}

async function searchOk(rig: BudgetsRig, keyword: string): Promise<SearchPageLike> {
  const res = await request(rig.app.getHttpServer()).get(SEARCH_URL).query({ q: keyword });
  expect(res.status, `搜索 ${keyword} 应 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 160)})`).toBe(200);
  return res.body as SearchPageLike;
}

/** 搜索 → 指定来源首卡 → 预览 → 物化(T031 真实装配链;T083 同款) */
async function materializeEpisodeFromSource(
  rig: BudgetsRig,
  keyword: string,
  wantedSourceLabel: string,
): Promise<{ mediaId: string; parentMediaId: string }> {
  const page = await searchOk(rig, keyword);
  const card = page.items.find((item) => item.sourceLabel === wantedSourceLabel);
  expect(card, `搜索 ${keyword} 应含来源「${wantedSourceLabel}」条目`).toBeDefined();
  const preview = await request(rig.app.getHttpServer()).get(`${PREVIEW_URL}/${encodeURIComponent(card!.titleRef)}`);
  expect(preview.status, `预览应 200(实际 ${preview.status} ${JSON.stringify(preview.body).slice(0, 160)})`).toBe(200);
  const episodeRef = (preview.body as { lines: Array<{ episodes: Array<{ episodeRef: string }> }> }).lines[0]?.episodes[0]
    ?.episodeRef;
  expect(episodeRef, '预览应有候选分集').toBeTypeOf('string');
  const res = await request(rig.app.getHttpServer())
    .post(MATERIALIZE_URL)
    .set('Cookie', rig.cookie)
    .send({
      titleRef: card!.titleRef,
      episodeRef: episodeRef!,
      previewRevision: (preview.body as { previewRevision: number }).previewRevision,
      operationKey: randomUUID(),
    });
  expect(res.status, `物化 ${keyword}@${wantedSourceLabel} 应 201(实际 ${JSON.stringify(res.body).slice(0, 200)})`).toBe(201);
  return res.body as { mediaId: string; parentMediaId: string };
}

interface SourceSession {
  readonly sessionId: string;
  readonly generation: number;
}

function sessionRowOf(sessionId: string): { generation: number } {
  const row = Database.db.prepare('SELECT generation FROM playback_session WHERE id = ?').get(sessionId) as
    | { generation: number }
    | undefined;
  expect(row, `夹具错误:playback_session ${sessionId} 不存在`).toBeDefined();
  return row!;
}

/** 轮询等待会话就绪(在线 hls probe 免 ffprobe 即时成功;T036/T083 同款) */
async function waitUntilReady(rig: BudgetsRig, cookie: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastState = '';
  while (Date.now() < deadline) {
    const res = await request(rig.app.getHttpServer()).get(`/api/playback/sessions/${sessionId}`).set('Cookie', cookie);
    if (res.status === 200) {
      lastState = String((res.body as Record<string, unknown>)['state']);
      if (lastState === 'ready') return;
    }
    await sleep(20);
  }
  throw new Error(`夹具错误:会话 ${sessionId} 未在 5s 内就绪(当前 ${lastState || '不可读'})`);
}

/** 真实 resolve 源会话并等 ready */
async function resolveSourceSession(rig: BudgetsRig, mediaId: string): Promise<SourceSession> {
  const res = await request(rig.app.getHttpServer()).post('/api/playback/resolve').set('Cookie', rig.cookie).send({ mediaId });
  expect(res.status, '夹具错误:源会话 resolve 应 201').toBe(201);
  const sessionId = String(res.headers['location']).split('/').pop() ?? '';
  await waitUntilReady(rig, rig.cookie, sessionId);
  return { sessionId, generation: sessionRowOf(sessionId).generation };
}

/** 候选清单 200 断言(T083 同款;返回 items 供链式消费) */
async function getSwitchCandidatesOk(rig: BudgetsRig, source: SourceSession): Promise<readonly Record<string, unknown>[]> {
  const res = await request(rig.app.getHttpServer())
    .get(CANDIDATES_URL)
    .query({ fromSessionId: source.sessionId, expectedGeneration: source.generation })
    .set('Cookie', rig.cookie);
  expect(res.status, `候选清单应 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(200);
  const body = res.body as { items: readonly Record<string, unknown>[] };
  expect(body.items.length, '双源同集世界应至少一条候选').toBeGreaterThanOrEqual(1);
  return body.items;
}

/** 按 versionLabel 取双胞胎候选 ref */
function candidateRefOfVersion(items: readonly Record<string, unknown>[], versionLabel: string): string {
  const candidate = items.find((item) => item['versionLabel'] === versionLabel);
  expect(
    candidate,
    `候选清单应含「${versionLabel}」双胞胎(实际 ${JSON.stringify(items.map((item) => item['versionLabel']))})`,
  ).toBeDefined();
  return String(candidate!['candidateRef']);
}

/** 测速 200 断言(ProbeResult 4 键;输入序一一对应;T083 同款) */
interface ProbeLike {
  readonly candidateRef: string;
  readonly status: string;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
}

async function postProbesOk(
  rig: BudgetsRig,
  source: SourceSession,
  candidateRefs: readonly string[],
): Promise<readonly ProbeLike[]> {
  const res = await request(rig.app.getHttpServer())
    .post(PROBES_URL)
    .set('Cookie', rig.cookie)
    .send({ fromSessionId: source.sessionId, expectedGeneration: source.generation, candidateRefs });
  expect(res.status, `测速应 200(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(200);
  const body = res.body as { items: readonly ProbeLike[] };
  expect(body.items).toHaveLength(candidateRefs.length);
  expect(body.items.map((item) => item.candidateRef)).toEqual([...candidateRefs]);
  return body.items;
}

function scalarOf(sql: string, ...params: unknown[]): number {
  const row = Database.db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 副本全集快照(测速零副作用断言;T083 同款) */
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

/* ------------------------------------------------------------------ */
/* 观测代理(语句计数:T030 手法;峰值在飞:pendingResponseCount 采样)     */
/* ------------------------------------------------------------------ */

/**
 * Database.db 静态 getter 临时替换为 prepare 计数代理:
 * - 计数窗口 = await action() 全程(单次 HTTP 调用);
 * - 每方法惰性解析的消费面(原生 Database.db.prepare / drizzle getDb())在窗口内
 *   全部改走代理,语句计数完整;finally 恢复原 descriptor,drizzle 句柄按连接
 *   同一性在下次 getDb() 自动重建(与 close/重开同语义),不影响 rig 清理。
 */
async function countStatementsDuring<T>(action: () => Promise<T>): Promise<{ readonly result: T; readonly statements: number }> {
  const original = Object.getOwnPropertyDescriptor(Database, 'db');
  if (original === undefined || original.get === undefined) {
    throw new Error('夹具错误:Database.db 静态 getter 缺失,语句计数代理无法安装');
  }
  let statements = 0;
  const conn: DatabaseConstructor.Database = Database.db;
  const counted = new Proxy<DatabaseConstructor.Database>(conn, {
    get(target, property, _receiver) {
      if (property === 'prepare') {
        return (...args: unknown[]) => {
          statements += 1;
          return target.prepare(...(args as Parameters<DatabaseConstructor.Database['prepare']>));
        };
      }
      return Reflect.get(target, property, target) as unknown;
    },
  });
  Object.defineProperty(Database, 'db', { get: () => counted, configurable: true });
  try {
    const result = await action();
    return { result, statements };
  } finally {
    Object.defineProperty(Database, 'db', original);
  }
}

/** 在飞期间等间隔采样受控服务器挂起响应数,取峰值(并发队列上限观测面) */
async function samplePeakPendingWhile<T>(
  server: ControlledMediaServer,
  action: () => Promise<T>,
): Promise<{ readonly result: T; readonly peakPending: number }> {
  let settled = false;
  const promise = action().then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  let peak = 0;
  while (!settled) {
    peak = Math.max(peak, server.pendingResponseCount());
    await sleep(10);
  }
  return { result: await promise, peakPending: peak };
}

afterEach(async () => {
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
  for (const key of injectedEnvKeys.splice(0)) {
    delete process.env[key];
  }
});

/* ------------------------------------------------------------------ */
/* A 搜索总期限与并发队列上限(api §0「上游总期限504」;§2 搜索段;SC001)  */
/* ------------------------------------------------------------------ */

const SEARCH_WORLD: WorldSpec = {
  titleKey: 't085-search-ok',
  keyword: 'budgetok',
  upstreamVodId: 3001,
  name: 'fixture·预算健康剧',
  episodeCount: 1,
  rootPath: '/vod/hls/t085-ok',
};

describe('T085 · A 搜索总期限与并发队列上限(预算值来自 VOD_BUDGETS;SC001「19/20 ≤8s」服务端钉面)', () => {
  it('A1 默认契约总期限:健康+恒挂起源混合 → 全链在 search.totalTimeoutMs(8s)内收敛 200 partial(ok+timeout),健康源照常返回,零源位置泄漏', async () => {
    const rig = await startBudgetsRig('hmp-t085-a1-', { worlds: [SEARCH_WORLD], hangSearchSources: 1 });
    const startedAt = Date.now();
    const res = await request(rig.app.getHttpServer()).get(SEARCH_URL).query({ q: 'budgetok' });
    const elapsedMs = Date.now() - startedAt;
    expect(res.status, `混合搜索应 200 partial(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(200);
    const page = res.body as SearchPageLike;
    expect(page.partial, '有源超时 → partial=true(部分失败区别于无匹配)').toBe(true);
    expect(page.reasons.length, 'reasons 应非空').toBeGreaterThanOrEqual(1);
    const statuses = page.sources.map((source) => source.status);
    expect(statuses, '状态混合:健康源 ok + 挂起源 timeout').toEqual(['ok', 'timeout']);
    expect(page.items.length, '健康源结果照常返回').toBeGreaterThan(0);
    // 总期限钉面:挂起源只在共享 deadline 到期后收敛 → elapsed 下界即契约预算;
    // 上界 = 契约值 + CI 抖动余量(超出即总期限未生效)
    expect(elapsedMs, `全链应耗满共享 deadline(实际 ${elapsedMs}ms)`).toBeGreaterThanOrEqual(
      VOD_BUDGETS.search.totalTimeoutMs - 500,
    );
    expect(elapsedMs, `全链应在总期限内收敛(实际 ${elapsedMs}ms)`).toBeLessThanOrEqual(
      VOD_BUDGETS.search.totalTimeoutMs + ELAPSED_SLACK_MS,
    );
    // 脱敏:公共响应零上游地址/源路径(api §0/§2;T083 B1 同面,本处抽查)
    const serialized = JSON.stringify(res.body) ?? '';
    expect(serialized, '搜索响应不得包含上游 origin').not.toContain(rig.server.baseUrl);
    expect(serialized, '搜索响应不得包含源 api 路径').not.toContain('api.php');
    expect(res.headers['cache-control'], '公共响应须 no-store').toBe('no-store');
  });

  it('A2 并发队列上限:4 挂起源+1 健康(收窄预算 1200ms),上游峰值在飞恰为 search.concurrency=3(第 4/5 源排队不并发),收窄预算内 200 partial', async () => {
    injectVodEnv({ VOD_SEARCH_TIMEOUT_MS: '1200' });
    const rig = await startBudgetsRig('hmp-t085-a2-', { worlds: [SEARCH_WORLD], hangSearchSources: 4 });
    const startedAt = Date.now();
    const { result: res, peakPending } = await samplePeakPendingWhile(rig.server, async () =>
      request(rig.app.getHttpServer()).get(SEARCH_URL).query({ q: 'budgetok' }),
    );
    const elapsedMs = Date.now() - startedAt;
    expect(res.status, `混合搜索应 200 partial(实际 ${res.status} ${JSON.stringify(res.body).slice(0, 200)})`).toBe(200);
    const page = res.body as SearchPageLike;
    const statuses = page.sources.map((source) => source.status);
    expect(statuses, '状态:健康源 ok + 4 挂起源 timeout(5 源全部尝试)').toEqual([
      'ok',
      'timeout',
      'timeout',
      'timeout',
      'timeout',
    ]);
    expect(page.partial, '有源超时 → partial=true').toBe(true);
    expect(page.items.length, '健康源结果照常返回').toBeGreaterThan(0);
    // 并发队列上限(核心钉面):5 源并发闸 = search.concurrency(3) → 任一时刻受控
    // 上游在飞挂起请求峰值恰为 3;第 4/5 源在闸内排队,deadline 耗尽后不再发起
    // (预算内直接 timeout,无第 4 条在飞连接)
    expect(peakPending, `上游峰值在飞应恰为并发闸 3(实际 ${peakPending})`).toBe(VOD_BUDGETS.search.concurrency);
    // 收窄预算生效:elapsed ≈ 1200ms(远小于契约 8s;env 只许收紧)
    expect(elapsedMs, `收窄预算应生效(实际 ${elapsedMs}ms)`).toBeGreaterThanOrEqual(1_100);
    expect(elapsedMs, `全链仍受契约总期限约束(实际 ${elapsedMs}ms)`).toBeLessThanOrEqual(
      VOD_BUDGETS.search.totalTimeoutMs + ELAPSED_SLACK_MS,
    );
  });
});

/* ------------------------------------------------------------------ */
/* B 详情/候选大规模预算(api §2「最多20线路/单线2000/合计5000/4MiB,超限422整次失败」)*/
/* ------------------------------------------------------------------ */

const BUDGET_BASE_WORLD: WorldSpec = {
  titleKey: 't085-budget-base',
  keyword: 'budgetshow',
  upstreamVodId: 8100,
  name: 'fixture·预算形态剧',
  episodeCount: 1,
  rootPath: '/vod/hls/t085-budget',
};

/** 预览行扁平(线路顺序保持) */
function flattenPreviewEpisodes(preview: { readonly lines: readonly { readonly episodes: readonly unknown[] }[] }): readonly unknown[] {
  return preview.lines.flatMap((line) => line.episodes);
}

/** 检索预算形态剧并取本源首卡 */
async function budgetCardOf(rig: BudgetsRig): Promise<string> {
  const page = await searchOk(rig, 'budgetshow');
  const card = page.items.find((item) => item.sourceLabel === rig.sourceLabel);
  expect(card, '预算形态剧应出现在检索结果').toBeDefined();
  return card!.titleRef;
}

describe('T085 · B 详情/候选大规模预算(恰界合法 + env 收窄 422 整次失败;21 线超界面归 T083/T022 C3 不重复)', () => {
  it('B1 恰界合法:20 线(= detail.maxLines 契约上限,默认预算)→ 200 且 20 线全量', async () => {
    const rig = await startBudgetsRig('hmp-t085-b1-', {
      worlds: [BUDGET_BASE_WORLD],
      detailOverrides: new Map([['8100', detailBodyWithShape(VOD_BUDGETS.detail.maxLines, 1)]]),
    });
    const titleRef = await budgetCardOf(rig);
    const preview = await request(rig.app.getHttpServer()).get(`${PREVIEW_URL}/${encodeURIComponent(titleRef)}`);
    expect(preview.status, `恰界 20 线应 200(实际 ${preview.status} ${JSON.stringify(preview.body).slice(0, 160)})`).toBe(200);
    const body = preview.body as { lines: readonly { name: string }[] };
    expect(body.lines, '恰界 20 线全量保留').toHaveLength(VOD_BUDGETS.detail.maxLines);
  });

  it('B2 env 收窄(VOD_DETAIL_MAX_LINES=10):同 20 线 wire → 422 VOD_DETAIL_TOO_LARGE 整次失败,无预览事实(物化入口 410)', async () => {
    injectVodEnv({ VOD_DETAIL_MAX_LINES: '10' });
    const rig = await startBudgetsRig('hmp-t085-b2-', {
      worlds: [BUDGET_BASE_WORLD],
      detailOverrides: new Map([['8100', detailBodyWithShape(VOD_BUDGETS.detail.maxLines, 1)]]),
    });
    const titleRef = await budgetCardOf(rig);
    const preview = await request(rig.app.getHttpServer()).get(`${PREVIEW_URL}/${encodeURIComponent(titleRef)}`);
    expectProblem(preview, 422, ProblemCode.VOD_DETAIL_TOO_LARGE);
    expectSanitizedProblem(preview, [rig.server.baseUrl, 'api.php'], '收窄上限 422');
    // 整次失败:预览事实零残留 → 同 ref 物化入口 410 VOD_PREVIEW_EXPIRED(T083 C3 同形)
    const materialize = await request(rig.app.getHttpServer())
      .post(MATERIALIZE_URL)
      .set('Cookie', rig.cookie)
      .send({ titleRef, episodeRef: 'e1-forged', previewRevision: 1, operationKey: randomUUID() });
    expectProblem(materialize, 410, ProblemCode.VOD_PREVIEW_EXPIRED);
  });

  it('B3 恰界合法:单线 2000 集(= detail.maxEpisodesPerLine 契约上限,默认预算)→ 200 且 2000 候选全量', async () => {
    const rig = await startBudgetsRig('hmp-t085-b3-', {
      worlds: [BUDGET_BASE_WORLD],
      detailOverrides: new Map([['8100', detailBodyWithShape(1, VOD_BUDGETS.detail.maxEpisodesPerLine)]]),
    });
    const titleRef = await budgetCardOf(rig);
    const preview = await request(rig.app.getHttpServer()).get(`${PREVIEW_URL}/${encodeURIComponent(titleRef)}`);
    expect(preview.status, `恰界单线 2000 应 200(实际 ${preview.status} ${JSON.stringify(preview.body).slice(0, 160)})`).toBe(200);
    const body = preview.body as { lines: readonly { episodes: readonly unknown[] }[] };
    expect(body.lines).toHaveLength(1);
    expect(flattenPreviewEpisodes(body), '恰界 2000 候选全量').toHaveLength(VOD_BUDGETS.detail.maxEpisodesPerLine);
  });

  it('B4 env 收窄(VOD_DETAIL_MAX_EPISODES_PER_LINE=1500):同单线 2000 wire → 422 整次失败', async () => {
    injectVodEnv({ VOD_DETAIL_MAX_EPISODES_PER_LINE: '1500' });
    const rig = await startBudgetsRig('hmp-t085-b4-', {
      worlds: [BUDGET_BASE_WORLD],
      detailOverrides: new Map([['8100', detailBodyWithShape(1, VOD_BUDGETS.detail.maxEpisodesPerLine)]]),
    });
    const titleRef = await budgetCardOf(rig);
    const preview = await request(rig.app.getHttpServer()).get(`${PREVIEW_URL}/${encodeURIComponent(titleRef)}`);
    expectProblem(preview, 422, ProblemCode.VOD_DETAIL_TOO_LARGE);
    expectSanitizedProblem(preview, [rig.server.baseUrl, 'api.php'], '收窄单线上限 422');
  });

  it('B5 合计恰界:20 线×250=5000(= detail.maxEpisodesTotal,默认预算)→ 200 且全量', async () => {
    const rig = await startBudgetsRig('hmp-t085-b5-', {
      worlds: [BUDGET_BASE_WORLD],
      detailOverrides: new Map([['8100', detailBodyWithShape(20, 250)]]),
    });
    const titleRef = await budgetCardOf(rig);
    const boundary = await request(rig.app.getHttpServer()).get(`${PREVIEW_URL}/${encodeURIComponent(titleRef)}`);
    expect(boundary.status, `恰界合计 5000 应 200(实际 ${boundary.status} ${JSON.stringify(boundary.body).slice(0, 160)})`).toBe(200);
    const boundaryBody = boundary.body as { lines: readonly { episodes: readonly unknown[] }[] };
    expect(flattenPreviewEpisodes(boundaryBody), '恰界合计 5000 全量').toHaveLength(VOD_BUDGETS.detail.maxEpisodesTotal);
  });

  it('B6 合计越界:19×250+1×251=5001(+1,单线均 ≤2000)→ 422(契约默认值拦截,零 env)', async () => {
    const rigOver = await startBudgetsRig('hmp-t085-b6-', {
      worlds: [BUDGET_BASE_WORLD],
      detailOverrides: new Map([['8100', detailBodyWithShapeTotal(19, 250, 251)]]),
    });
    const titleRefOver = await budgetCardOf(rigOver);
    const over = await request(rigOver.app.getHttpServer()).get(`${PREVIEW_URL}/${encodeURIComponent(titleRefOver)}`);
    expectProblem(over, 422, ProblemCode.VOD_DETAIL_TOO_LARGE);
    expectSanitizedProblem(over, [rigOver.server.baseUrl, 'api.php'], '合计越界 422');
  });
});

/** 合成详情体变体:19 线×250 + 1 线×251 = 5001(单线均 ≤2000,只破合计) */
function detailBodyWithShapeTotal(fullLines: number, fullEpisodes: number, lastLineEpisodes: number): string {
  // detailBodyWithShape 产出信封:条目在 list[0](直接 parse 信封会丢 vod_id,
  // integrity_violation → 502,而非预算 422 —— T085 首轮实测教训)
  const envelope = JSON.parse(detailBodyWithShape(fullLines, fullEpisodes)) as { list: AppleCmsVodItem[] };
  const item: AppleCmsVodItem = { ...envelope.list[0]! };
  const lastLineEpisodesUrls = Array.from(
    { length: lastLineEpisodes },
    (_unused, index) =>
      `第${fullLines * fullEpisodes + index + 1}集$http://127.0.0.1:0/vod/hls/t085-budget/line-${fullLines + 1}/ep-${index + 1}/master.m3u8`,
  );
  item.vod_play_from = `${item.vod_play_from}$$$fixture线路${fullLines + 1}`;
  item.vod_play_url = `${item.vod_play_url}$$$${lastLineEpisodesUrls.join('#')}`;
  return JSON.stringify(buildAppleCmsListDocument([item]));
}

/* ------------------------------------------------------------------ */
/* C 缓存全局上限(api §2「全进程最多256MiB,超额拒绝或淘汰最早过期项」)   */
/* ------------------------------------------------------------------ */

/** 中期上限(实测标定):单次搜索会话字节 ≈ 上限的 2/3,两次搜索必触发淘汰换入 */
const CACHE_MID_CAP_BYTES = 26_000;

function cacheFillWorlds(): WorldSpec[] {
  return [...bulkWorldSpecs('cachefill', 5101, 25), ...bulkWorldSpecs('cacheevict', 5201, 25)];
}

describe('T085 · C 缓存全局上限(env 只许收紧;淘汰换入 + T083 E1 复验;排序语义引用 search-preview C1/C2)', () => {
  it('C1 中期上限:第二搜索经「淘汰最早项」换入 200(非 429),进程字节有界,被淘汰最早会话 410 不复活', async () => {
    injectVodEnv({ VOD_CACHE_MAX_TOTAL_BYTES: String(CACHE_MID_CAP_BYTES) });
    const rig = await startBudgetsRig('hmp-t085-c1-', {
      worlds: cacheFillWorlds(),
      listDocKeywords: ['cachefill', 'cacheevict'],
    });
    // 第一次搜索:建立会话+标题绑定(最老条目;put 替换保留 createdAtMs)
    const first = await searchOk(rig, 'cachefill');
    const firstStats = rig.cache.stats();
    expect(firstStats.bytes, `第一次搜索后缓存应有账面字节(实际 ${firstStats.bytes})`).toBeGreaterThan(0);
    expect(firstStats.bytes, `单次搜索必须可被中期上限容纳(实际 ${firstStats.bytes} ≥ ${CACHE_MID_CAP_BYTES})`).toBeLessThan(
      CACHE_MID_CAP_BYTES,
    );
    // 第二次搜索:两次写入总量必超上限 → 淘汰路径触发;「淘汰最早项」让位后换入 →
    // 200 而非 429 资源忙(api §2「超额拒绝或淘汰最早过期项」的淘汰分支)
    const second = await searchOk(rig, 'cacheevict');
    expect(second.searchId, '第二次搜索应换入成功(淘汰最早项 admit;非 429)').not.toBe(first.searchId);
    const statsAfterSecond = rig.cache.stats();
    expect(
      statsAfterSecond.bytes,
      `淘汰换入后进程字节必须有界(实际 ${statsAfterSecond.bytes} > ${CACHE_MID_CAP_BYTES})`,
    ).toBeLessThanOrEqual(CACHE_MID_CAP_BYTES);
    expect(
      statsAfterSecond.searchEntries,
      `在册搜索会话应恰为存活的第二次会话(实际 ${statsAfterSecond.searchEntries})`,
    ).toBe(1);
    // 被淘汰最早会话:ref 失效窗口语义 —— 旧 searchId 410(保留 q 重新搜索),不复活
    const replayEvicted = await request(rig.app.getHttpServer()).get(SEARCH_URL).query({ searchId: first.searchId });
    expectProblem(replayEvicted, 410, ProblemCode.VOD_SEARCH_EXPIRED);
    expectSanitizedProblem(replayEvicted, [rig.server.baseUrl, 'api.php'], '被淘汰会话 410');
    // 存活会话重放照常(淘汰有界,不误伤新写):缺 cursor 重放第一页 200,条数一致
    const replayAlive = await request(rig.app.getHttpServer()).get(SEARCH_URL).query({ searchId: second.searchId });
    expect(replayAlive.status, '存活会话重放应 200').toBe(200);
    expect(((replayAlive.body as { items: unknown[] }).items).length, '重放页条数与首次一致').toBe(second.items.length);
  });

  it('C2 T083 E1 语义复验:上限收窄 128B → 搜索 429 VOD_CACHE_CAPACITY(资源忙拒绝、拒绝先于上游抓取、错误体脱敏)', async () => {
    injectVodEnv({ VOD_CACHE_MAX_TOTAL_BYTES: '128' });
    const rig = await startBudgetsRig('hmp-t085-c2-', { worlds: [SEARCH_WORLD] });
    const res = await request(rig.app.getHttpServer()).get(SEARCH_URL).query({ q: 'budgetok' });
    expectProblem(res, 429, 'VOD_CACHE_CAPACITY');
    expect(res.headers['cache-control'], '429 亦须 no-store').toBe('no-store');
    expectSanitizedProblem(res, [rig.server.baseUrl, 'api.php'], '缓存上限 429');
    // 拒绝先于上游抓取(search 流程在 fetch 前先 persist 会话):缓存零半写入账面,可重试
    expect(rig.cache.stats().bytes, '拒绝路径不得留下半写入账面').toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* D 分集大分页无 N+1(T030 手法经真实 HTTP 链;api §2 每页 100 子项)      */
/* ------------------------------------------------------------------ */

const SERIAL_105: WorldSpec = {
  titleKey: 't085-serial-105',
  keyword: 'nplus105',
  upstreamVodId: 8201,
  name: 'fixture·百集预算剧',
  episodeCount: 105,
  rootPath: '/vod/hls/t085-s105',
};
const SERIAL_305: WorldSpec = {
  titleKey: 't085-serial-305',
  keyword: 'nplus305',
  upstreamVodId: 8202,
  name: 'fixture·三百集预算剧',
  episodeCount: 305,
  rootPath: '/vod/hls/t085-s305',
};

describe('T085 · D 分集大分页无 N+1(prepare 语句数与子项规模/页码无关;T030 守卫的端到端观测面)', () => {
  it('D1 经真实链(搜索→预览→物化 105/305 子项→公共分集分页):翻页/跨规模/列表语句数不变,每页 100 子项', async () => {
    const rig = await startBudgetsRig('hmp-t085-d1-', { worlds: [SERIAL_105, SERIAL_305] });
    const small = await materializeEpisodeFromSource(rig, 'nplus105', rig.sourceLabel);
    const big = await materializeEpisodeFromSource(rig, 'nplus305', rig.sourceLabel);

    // 小剧(105 子项)首页:语句基线
    const firstPage = await countStatementsDuring(async () => {
      const res = await request(rig.app.getHttpServer()).get(`/api/public/media/${small.parentMediaId}/episodes`);
      expect(res.status, `分集首页应 200(实际 ${JSON.stringify(res.body).slice(0, 160)})`).toBe(200);
      return res;
    });
    const firstBody = firstPage.result.body as { lines: readonly { episodes: readonly unknown[] }[]; nextCursor: string | null };
    expect(firstBody.lines.flatMap((line) => line.episodes), '每页总计 100 子项(api §2)').toHaveLength(100);
    expect(firstBody.nextCursor, '105 子项应有续页游标').toBeTypeOf('string');
    const firstPageStatements = firstPage.statements;
    expect(firstPageStatements, '分集首页语句数应为小常数(单查询 + 内存分组)').toBeLessThanOrEqual(8);

    // 翻页(余 5 条):语句数与首页相同(无逐条装载)
    const secondPage = await countStatementsDuring(async () => {
      const res = await request(rig.app.getHttpServer())
        .get(`/api/public/media/${small.parentMediaId}/episodes`)
        .query({ cursor: firstBody.nextCursor ?? '' });
      expect(res.status).toBe(200);
      return res;
    });
    const secondBody = secondPage.result.body as { lines: readonly { episodes: readonly unknown[] }[]; nextCursor: string | null };
    expect(secondBody.lines.flatMap((line) => line.episodes), '第二页为余下 5 条').toHaveLength(5);
    expect(secondBody.nextCursor, '取尽后 nextCursor=null').toBeNull();
    expect(
      secondPage.statements,
      `翻页语句数应与首页相同(实际 ${secondPage.statements} vs ${firstPageStatements})`,
    ).toBe(firstPageStatements);

    // 跨规模(305 子项):语句数不变(禁 N+1 核心断言)
    const bigPage = await countStatementsDuring(async () => {
      const res = await request(rig.app.getHttpServer()).get(`/api/public/media/${big.parentMediaId}/episodes`);
      expect(res.status).toBe(200);
      return res;
    });
    expect(
      bigPage.statements,
      `子项规模 105→305,语句数必须不变(实际 ${bigPage.statements} vs ${firstPageStatements})`,
    ).toBe(firstPageStatements);

    // 父级列表:语句数与页码无关(T030 listMedia 面的端到端对照)
    const listPage1 = await countStatementsDuring(async () => {
      const res = await request(rig.app.getHttpServer()).get('/api/public/media').query({ page: 1, pageSize: 50 });
      expect(res.status).toBe(200);
      return res;
    });
    const listPage2 = await countStatementsDuring(async () => {
      const res = await request(rig.app.getHttpServer()).get('/api/public/media').query({ page: 2, pageSize: 50 });
      expect(res.status).toBe(200);
      return res;
    });
    expect(
      listPage2.statements,
      `列表页码语句数应无关(实际 ${listPage2.statements} vs ${listPage1.statements})`,
    ).toBe(listPage1.statements);
  });
});

/* ------------------------------------------------------------------ */
/* E 全局工作队列:测速内部并发(api §5「单候选3s/1MiB、全次5s,内部并发3」)*/
/* ------------------------------------------------------------------ */

const PROBE_MAIN_WORLD: WorldSpec = {
  titleKey: 't085-probe-main',
  keyword: 'probetwin',
  upstreamVodId: 1001,
  name: SERIAL_NAME,
  episodeCount: 3,
  rootPath: '/vod/hls/t085-p-main',
};

const PROBE_TWINS: readonly TwinSpec[] = [
  { upstreamVodId: 2101, versionLabel: TWIN_LABELS.hang1, hangPath: '/t085/hang-probe-1' },
  { upstreamVodId: 2102, versionLabel: TWIN_LABELS.hang2, hangPath: '/t085/hang-probe-2' },
  { upstreamVodId: 2103, versionLabel: TWIN_LABELS.hang3, hangPath: '/t085/hang-probe-3' },
];

describe('T085 · E 全局工作队列:测速内部并发 3(上游峰值在飞观测;预算值来自 SWITCH_PROBE_BUDGETS)', () => {
  it('E1 3 挂起候选并发测速:上游峰值在飞恰为内部并发 3(串行峰值 1 可区分),全次 ≤5s 预算收敛为 timeout,零副作用', async () => {
    const rig = await startBudgetsRig('hmp-t085-e1-', { worlds: [PROBE_MAIN_WORLD], twins: PROBE_TWINS });
    const materialized = await materializeEpisodeFromSource(rig, 'probetwin', rig.sourceLabel);
    const source = await resolveSourceSession(rig, materialized.mediaId);
    const items = await getSwitchCandidatesOk(rig, source);
    const refs = PROBE_TWINS.map((twin) => candidateRefOfVersion(items, twin.versionLabel));
    expect(refs, '3 个挂起候选齐备(api §5 单次 1–3 refs;T067 钉 >3 refs 400)').toHaveLength(
      SWITCH_PROBE_BUDGETS.concurrency,
    );
    const before = sideEffectsOf(rig.householdId);

    const startedAt = Date.now();
    const { result: probes, peakPending } = await samplePeakPendingWhile(rig.server, () => postProbesOk(rig, source, refs));
    const elapsedMs = Date.now() - startedAt;

    // 峰值在飞 = 内部并发 3:3 个候选的定位全部指向挂起路径,并发闸满载;
    // 串行执行峰值应为 1、无闸并发(>3)均与本断言可区分
    expect(peakPending, `上游峰值在飞应恰为内部并发 ${SWITCH_PROBE_BUDGETS.concurrency}(实际 ${peakPending})`).toBe(
      SWITCH_PROBE_BUDGETS.concurrency,
    );
    // 挂起候选按单候选 3s 预算收敛为 timeout(首清单永不到达);全次 ≤5s 总截止
    expect(probes.map((probe) => probe.status), '3 个挂起候选均应 timeout').toEqual(['timeout', 'timeout', 'timeout']);
    for (const probe of probes) {
      expect(probe.latencyMs, 'timeout 候选延迟恒空').toBeNull();
      expect(new Date(probe.checkedAt).toString()).not.toBe('Invalid Date');
    }
    expect(elapsedMs, `混合测速应预算内返回(实际 ${elapsedMs}ms)`).toBeLessThanOrEqual(
      SWITCH_PROBE_BUDGETS.totalTimeoutMs + ELAPSED_SLACK_MS,
    );
    // 无票/无历史/不物化/不登记/不建意图/零转换(api §5;T083 A3 同款零副作用断言)
    expect(sideEffectsOf(rig.householdId), '测速不得写会话/历史/物化/登记/intent/转换').toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* 未覆盖项(诚实标注,详见 docs/specs/010-online-vod/evidence/performance.md) */
/* ------------------------------------------------------------------ */

/**
 * - TTL 到期(10min/60s)推进面:契约 TTL 固定值,e2e 无时钟快进 → 引用
 *   search-preview 单测 A8/B3(注入时钟)与 T083 E2(伪造 ref 410 可达形态);
 * - 每家庭 100 活搜索/1000 活预览配额与 256MiB 缺省值:注入收窄面已钉(C1/C2 与
 *   T083 E1),缺省值量级不属于 e2e 可构造窗口(10^2–10^3 活对象)→ 引用单测;
 * - 预览 8s 总期限/4MiB 读预算的挂起/超大 wire 形态:引用 T028 B3/T083 C3
 *   (504/422 已单测+e2e 钉),本文件不重复;
 * - 真实外网/真实硬件播放性能(quickstart Q1 全量 20 次×每源 100 样本、Q4 续播
 *   20 次):属 T035/T088 运行时证据任务,本文件不伪称覆盖。
 */
