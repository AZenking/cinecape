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
  playbackSession,
  playbackTransitionIntent,
  playbackTransitionSlot,
  profileViewingHistory,
  vodSourceConfig,
} from '@platform/database/schema';
import { registerPersonalPlaybackFactsPort } from '@contexts/personal-data/application/progress-clock.service';
import {
  clearVodMaterializationTargets,
  registerVodMaterializationTarget,
} from '@contexts/online-vod/interface/materialization.controller';
import type { ResolvedMaterializationTarget } from '@contexts/online-vod/application/materialization.service';
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
import { MANAGEMENT_MAIN_PIN, selectMainAndUnlockSettings } from '../helpers-management';
import type { MediaRequestContext } from '../fixtures/controlled-media-server';
import {
  createFixtureTitleWorld,
  createFixtureVodSource,
  createStandardEpisodePresentation,
  createVersionConflictWorld,
  findUpstreamRoute,
  type FixtureHlsPresentation,
  type FixtureTitleWorld,
  type FixtureUpstreamSource,
} from '../fixtures/online-vod/fixture-upstream';

/**
 * T067(010-online-vod · US4,测试先行):换源候选/测速/switch/recover_switch 及
 * resolve 消费契约 e2e —— 「只写测试不实现」,依赖 T061/T062 已全绿(本仓库实测
 * T052 38/38、T036 27/27 全绿)。审查补充:candidateRef 物化贯通、checkpoint
 * 缺失/不等/明确旧游标、内容失权清理与旧 context 拒绝。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §5(候选/测速表+语义段:服务端从已授权
 *   fromSession 可信标题构造搜索、不接受任意 q/URL、failed 可恢复来源仅 60s、逐候选
 *   预览有效+策略检查后有界请求 单候选 3s/1MiB 全次 5s 并发 3、只首响应延迟、无客户端
 *   清单/片段/票据、不物化不写历史;switch/recover_switch IntentRequest 判别分支:
 *   targetCandidateRef/previewRevision/positionMode carry|target_history|beginning/
 *   confirmedAmbiguous/sourceCheckpoint{expectedGeneration,sampleSeq}/
 *   allowEarlierAcceptedPosition/expectedSlotRevision/operationKey;carry 必须
 *   checkpoint 且精确等于当前代 ledger;conflict 只 beginning/target_history;候选需先
 *   物化 registeredCandidateRef;正常 switch 旧源必须先 stop 到 ended;recover_switch
 *   允许网络/格式/媒体故障 failed 后 60s,权限/修订/禁源终态不可恢复;409
 *   SOURCE_NOT_TERMINAL 不消耗 intent)+ §7 I1(candidateRef 物化:登记映射与 operation
 *   同事务、intent.targetCandidateRef 使用 registeredCandidateRef)+ I2(checkpoint 语义:
 *   pauseAndFlush 返回 sessionAccepted 游标;事务读取当前代 ledger 必须精确等于该游标
 *   否则 409 SOURCE_PROGRESS_PENDING;更早位置需 allowEarlierAcceptedPosition=true+新 key;
 *   不自动挑旧位置)+ §1 DTO(SwitchCandidate 12 键/ProbeResult 4 键/IntentReply 11 键)
 *   + §0/§6(404 同形、错误收敛、no-store);
 * - docs/specs/010-online-vod/data-model.md §7(消费事务:来源必须终态——switch 正常路径
 *   先 stop、recover 来自可恢复 failed;原会话网络/格式故障后 60s 内允许 recover_switch,
 *   权限/切档/撤销/禁源/修订失配的终态不允许 carry 恢复)+ §10(vod_registered_candidate
 *   绑定 source session/generation;intent.source_checkpoint_generation/seq 与
 *   allow_earlier_accepted_position 仅 carry 必填、与当前 ledger 精确匹配后复制
 *   position/duration;source_checkpoint_seq 是接受游标不是尚待接受的暂停 seq);
 * - docs/specs/010-online-vod/tasks.md T067 原文与 T070/T071/T072/T073(被测实现目标,
 *   本文件先钉契约目标面,计划内红失败不跳过);
 * - 行为基线(既有绿,010 增量不得回归):test/contract/online-vod-progress-resume
 *   .e2e-spec.ts(T036 rig 惯例/物化链/双设备/受控上游/T092 seam)、online-vod-next-
 *   transition.e2e-spec.ts(T052 transition 链/Proxy 注入/cleanup/T058 finish 面 ——
 *   switch 的 fromSession 需要可终态来源)、online-vod-materialization.e2e-spec.ts
 *   (T024 candidateRef 登记桥 registerVodMaterializationTarget seam)。
 *
 * 装配方式(沿用 010 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威迁移,含 0007_online_vod)+
 *   initialize/login/selectMainAndUnlockSettings 身份 seed + Supertest 真实 HTTP;
 * - 受控上游沿用 T036/T052 rig 手法(createControlledMediaServer 127.0.0.1 随机端口 +
 *   fixture-upstream 路由表 findUpstreamRoute 派发 Apple CMS JSON;LAN_ALLOWED_TARGETS=
 *   '127.0.0.1';全程不发真实外网请求)。两源同集世界按 fixture-upstream 实际能力构造:
 *   源A/源B 各持同名同版本三集连续剧(星尘信使/stardust,跨源同题 → high 候选素材)
 *   与同名不同版本回声双城(源A=1003 剧场版 2019、源B=2003 导演剪辑版 2023 →
 *   match_conflict 素材);两源以不同 apiPath(/t067-src-{a,b}/api.php)与不同 HLS
 *   rootPath 共存于同一受控端口。来源/物化走真实 T031 装配链(搜索按 sourceLabel=来源
 *   行名精确选卡,双源同检索词各自命中);raw respond 闭包累计上游请求总数
 *   upstreamRequests,B 组「未授权目标不探测」以此为受控上游断言;
 * - 双设备:两次 login 即两个 DeviceSession(T036/T052 同序);T092 seam
 *   registerPersonalPlaybackFactsPort 注入可信时长 3600s(与 T036 同形);
 * - candidateRef 登记桥(T031 已装配、生产装配零注册):D/E 组经
 *   registerVodMaterializationTarget 直种绑定真实来源会话(session/generation)的候选
 *   目标,走真实 candidateRef 物化分支取 registeredCandidateRef —— I1 登记贯通的既有
 *   绿面;A/C 组候选引用一律取自候选端点响应(计划内红点);
 * - DB 直改仅用于无 HTTP 语义的工厂事实,逐处注明:媒体故障终态(state='failed'+
 *   failure_code,等价 T044/T045 故障管线库内形态)、故障时刻回拨(>60s 窗口素材)、
 *   禁源(media_source.enabled=0)、旧 context 推进(device_session.
 *   profile_context_version+1,等价 A→B→A)、consumed/pending switch intent+slot+后继
 *   会话行种子(等价 T072 创建后的库内归属事实,F 组授权/cleanup 面素材)、目标历史行
 *   种子(等价「他设备已看目标」)。不改任何共享文件;无 git 操作。
 *
 * ───────────────────────── 计划内红清单(失败不跳过)─────────────────────────
 * T067 为测试先行:GET /vod/switch-candidates 与 POST /vod/switch-probes 未装配
 * (T070/T071),POST /playback/transition-intents 的 switch/recover_switch action 被
 * rejectSwitchPathInPhase1 显式拒绝(400/稳定形态,T060 收录,T072 放开)。当前失败形态:
 *  - 候选/测速端点 = 404 路由级(Nest 缺省 NOT_FOUND + detail Cannot …);
 *  - switch/recover_switch intent 创建 = 400 VALIDATION_FAILED(一期未开放稳定形态)。
 * 红→绿映射(计划内红断言均经 redLabel 钉「→T070/T071/T072/T073」):
 *
 * | 用例 | 计划内红断言(当前失败原因)                                  | 转绿任务       |
 * | ---- | ------------------------------------------------------------ | --------------- |
 * | A1–A4| 候选端点 200/400/404 契约形态(路由未装配 404)               | →T070          |
 * | B1–B4| 测速端点 200/400/预算/零上游请求契约形态(路由未装配 404)    | →T071          |
 * | C1–C6| switch intent 创建 201/carry 消费/checkpoint 族(一期 400 拒绝)| →T070+T072+T073|
 * | D2   | registeredCandidateRef 建意图 201(一期 400 拒绝)            | →T072          |
 * | E1–E3| recover_switch 60s 窗口创建/消费(一期 400 拒绝)             | →T072          |
 *
 * 绿基线(窗口内即绿):D1(candidateRef 登记桥→物化分支→registeredCandidateRef,
 * T031 已装配)、F1/F2(消费后禁源 cleanup/旧 context 404 同形 —— 以 switch 形态
 * intent 行种子工厂事实钉 T062 面)、G1/G2(授权负向:已装配面精确 401/400;候选/测速
 * 窗口封套,装配后自动收紧)。
 *
 * 预期计数:红 18(A 4 + B 4 + C 6 + D 1 + E 3)/ 绿 5(D1/F1/F2/G1/G2);两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

const CANDIDATES_URL = '/api/vod/switch-candidates';
const PROBES_URL = '/api/vod/switch-probes';
const INTENTS_URL = '/api/playback/transition-intents';
const RESOLVE_URL = '/api/playback/resolve';
const MATERIALIZE_URL = '/api/vod/materializations';

/** 受信时长事实(T092 seam;3600 = 「probe 已知时长」形态,T036 同款) */
const TRUSTED_DURATION_SECONDS = 3600;

/** SwitchCandidate 契约 12 键(api.md §1 / openapi SwitchCandidate:additionalProperties:false;ASCII 序) */
const SWITCH_CANDIDATE_KEYS = [
  'candidateRef',
  'expiresAt',
  'label',
  'lineLabel',
  'matchConfidence',
  'matchReasons',
  'previewRevision',
  'season',
  'sourceLabel',
  'title',
  'versionLabel',
  'year',
] as const;

/** ProbeResult 契约 4 键(api.md §1 / openapi ProbeResult:additionalProperties:false;ASCII 序) */
const PROBE_RESULT_KEYS = ['candidateRef', 'checkedAt', 'latencyMs', 'status'] as const;

/** 候选清单回执 4 键(api.md §5 GET /vod/switch-candidates 输出;ASCII 序) */
const CANDIDATES_REPLY_KEYS = ['items', 'nextCursor', 'partial', 'reasons'] as const;

/** Materialized 契约 7 键(api.md §1 / openapi Materialized:additionalProperties:false;ASCII 序) */
const MATERIALIZED_KEYS = [
  'candidateRef',
  'catalogRevision',
  'detailRevision',
  'mediaId',
  'parentMediaId',
  'registeredCandidateRef',
  'replayed',
] as const;

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

/** TransitionCleanupReply 最小 1 键(I5「不返回目标 ID、元数据、位置或票据」) */
const CLEANUP_REPLY_KEYS = ['outcome'] as const;

/** 计划内红统一标注(消息内钉转绿任务号 + 目标契约形态 + 当前失败原因) */
function redLabel(tasks: string, target: string, current: string): string {
  return `计划内红(待 ${tasks} 转绿):${current} —— ${tasks} 落地后应 ${target}`;
}

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status, redLabel('T070/T071/T072/T073', `${status} ${code}(契约稳定码)`, `${res.status} ${JSON.stringify(res.body).slice(0, 220)}`)).toBe(
    status,
  );
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/** 同形断言:两响应 status+code 一致即不可区分(404 窗口 detail 含路径不比对) */
function expectSameShape(a: request.Response, b: request.Response, label: string): void {
  expect(a.status, `${label}:status 应同形`).toBe(b.status);
  expect(a.body.code, `${label}:稳定码应同形(不可借错误判别存在性)`).toBe(b.body.code);
}

/** 契约未钉码的 4xx 拒绝面:4xx + problem+json + no-store */
function expect4xxProblem(res: request.Response, label: string): void {
  expect(res.status, `${label}:应落在 4xx 客户错误带`).toBeGreaterThanOrEqual(400);
  expect(res.status, `${label}:不得以 5xx 泄露内部失败`).toBeLessThan(500);
  expectProblemContentType(res);
  expect(res.headers['cache-control'], `${label}:错误响应须 no-store(api §0)`).toBe('no-store');
}

/**
 * 授权封套断言(T052 H 组同手法,双态可断言):
 * - 窗口(端点未装配):404 + problem+json + no-store + code=NOT_FOUND + detail 以
 *   Cannot 开头(Nest 缺省形状);
 * - 装配后:精确 wired.status + wired.code(404 分支自动不可达,断言自动收紧)。
 */
function expectWiredOrRouteWindow(
  res: request.Response,
  wired: { status: number; code: string },
  label: string,
): void {
  expect(res.status, `${label}:应落在 4xx 客户错误带`).toBeGreaterThanOrEqual(400);
  expect(res.status, `${label}:不得以 5xx 泄露内部失败`).toBeLessThan(500);
  expect([wired.status, 404], `${label}:应为 ${wired.status} ${wired.code}(装配窗口内允许路由级 404)`).toContain(
    res.status,
  );
  expectProblemContentType(res);
  expect(res.headers['cache-control'], `${label}:错误响应须 no-store(api §0)`).toBe('no-store');
  if (res.status === 404) {
    expect(res.body.code, `${label}:404 窗口必须恰为 Nest 未装配路由缺省形状(NOT_FOUND)`).toBe(
      ProblemCode.NOT_FOUND,
    );
    expect(String(res.body.detail ?? ''), `${label}:404 窗口 detail 应为 Cannot …(装配后本分支不可达)`).toContain(
      'Cannot',
    );
  } else {
    expect(res.body.code, `${label}:精确稳定错误码`).toBe(wired.code);
  }
}

interface SwitchCandidateLike {
  readonly candidateRef: string;
  readonly title: string;
  readonly label: string;
  readonly year: string | null;
  readonly season: string | null;
  readonly versionLabel: string | null;
  readonly sourceLabel: string;
  readonly lineLabel: string;
  readonly matchConfidence: string;
  readonly matchReasons: readonly string[];
  readonly previewRevision: number;
  readonly expiresAt: string;
  readonly [key: string]: unknown;
}

interface ProbeResultLike {
  readonly candidateRef: string;
  readonly status: string;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  readonly [key: string]: unknown;
}

interface MaterializedLike {
  readonly parentMediaId: string;
  readonly mediaId: string;
  readonly detailRevision: number;
  readonly catalogRevision: number;
  readonly replayed: boolean;
  readonly candidateRef: string | null;
  readonly registeredCandidateRef: string | null;
}

interface IntentSnapshot {
  readonly id: string;
  readonly status: string;
  readonly slotRevision: number;
  readonly successorSessionId: string | null;
  readonly targetMediaId: string;
  readonly positionMode: string;
  readonly matchConfidence: string;
  readonly action: string;
  readonly expiresAt: string;
  readonly [key: string]: unknown;
}

/** pauseAndFlush 接受游标(api.md §5 I2:sessionAccepted 三元组) */
interface AcceptedCursor {
  readonly generation: number;
  readonly sampleSeq: number;
  readonly positionSeconds: number;
}

/* ------------------------------------------------------------------ */
/* 上游 mock(010 T036 rig 手法:受控 CMS 端口 + fixture 路由表派发)       */
/* ------------------------------------------------------------------ */

const activeMediaServers: ControlledMediaServer[] = [];

/** 受控上游请求总数(raw respond 闭包累计;B2「未授权目标不探测」零上游断言基线) */
let upstreamRequests = 0;

/** 上游请求增量(B 组零上游断言;每次 startSwitchRig 归零) */
function upstreamRequestsSince(baseline: number): number {
  return upstreamRequests - baseline;
}

/** 跨源同题三集连续剧世界(源A/源B 各持同名同版本;rootPath 参数化避免路由互撞) */
function createT067SerialWorld(origin: string, rootPath: string): FixtureTitleWorld {
  const presentationFor = (episodeKey: string): FixtureHlsPresentation =>
    createStandardEpisodePresentation({
      presentationKey: `t067-stardust:${episodeKey}:${rootPath}`,
      episodeKey,
      origin,
      rootPath: `${rootPath}/ep-${episodeKey}`,
      segmentCount: 3,
      segmentDurationSeconds: 120,
    });
  return createFixtureTitleWorld({
    titleKey: 't067-stardust',
    searchKeyword: 'stardust',
    upstreamVodId: 1001,
    name: 'fixture·星尘信使',
    year: '2024',
    remarks: '连载完毕 共3集',
    area: '夹具地区',
    lang: '夹具语言',
    episodesTotal: 3,
    synopsis:
      '跨源同题夹具(US4 换源 happy 面):源A/源B 各持同名同版本三集连续剧,跨源候选 matchConfidence=high 素材。',
    lines: [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: [
          { episodeKey: '01', label: '第01集', presentation: presentationFor('01'), seasonKey: 'S01', ordinal: 1, sequenceStatus: 'ordered' },
          { episodeKey: '02', label: '第02集', presentation: presentationFor('02'), seasonKey: 'S01', ordinal: 2, sequenceStatus: 'ordered' },
          { episodeKey: '03', label: '第03集', presentation: presentationFor('03'), seasonKey: 'S01', ordinal: 3, sequenceStatus: 'ordered' },
        ],
      },
    ],
  });
}

interface SwitchSourcePair {
  readonly sourceA: FixtureUpstreamSource;
  readonly sourceB: FixtureUpstreamSource;
  /** 源B 连续剧 EP01 master 清单路径(B4 测速预算 hang 注入点) */
  readonly targetMasterPath: string;
}

/** 两源同集世界:同名同版本连续剧(跨源 high)+ 同名版本冲突双城(conflict) */
function buildSwitchSourcePair(port: number): SwitchSourcePair {
  const originA = `http://127.0.0.1:${port}`;
  const originB = `http://127.0.0.1:${port}`;
  const sourceA = createFixtureTitleSource({
    sourceId: 'fixture-vod-source-t067-a',
    displayName: '夹具源A(T067)',
    apiPath: '/t067-src-a/api.php',
    address: { host: '127.0.0.1', port },
    titleWorlds: [
      createT067SerialWorld(originA, '/vod/hls/t067-a'),
      createVersionConflictWorld(originA, 'theatrical'),
    ],
  });
  const sourceB = createFixtureTitleSource({
    sourceId: 'fixture-vod-source-t067-b',
    displayName: '夹具源B(T067)',
    apiPath: '/t067-src-b/api.php',
    address: { host: '127.0.0.1', port },
    titleWorlds: [
      createT067SerialWorld(originB, '/vod/hls/t067-b'),
      createVersionConflictWorld(originB, 'directors-cut'),
    ],
  });
  return { sourceA, sourceB, targetMasterPath: '/vod/hls/t067-b/ep-01/master.m3u8' };
}

/** createFixtureVodSource 的本地别名(限定 behavior=healthy;签名同源) */
function createFixtureTitleSource(input: {
  readonly sourceId: string;
  readonly displayName: string;
  readonly apiPath: string;
  readonly address: { readonly host: string; readonly port: number };
  readonly titleWorlds: readonly FixtureTitleWorld[];
}): FixtureUpstreamSource {
  return createFixtureVodSource({ ...input, behavior: 'healthy' });
}

/* ------------------------------------------------------------------ */
/* rig:受控上游 + 全量迁移 app + 双设备身份 + HTTP 物化在线剧集           */
/* ------------------------------------------------------------------ */

interface SwitchRig {
  readonly app: INestApplication;
  readonly householdId: string;
  readonly server: ControlledMediaServer;
  /** 设备A · 档案A(主档案,设置已解锁) */
  readonly cookieA: string;
  /** 设备B · 档案A(同档案第二设备) */
  readonly cookieB: string;
  readonly profileAId: string;
  readonly deviceSessionAId: string;
  readonly deviceSessionBId: string;
  /** kind=vod media_source 行 id(登记桥/D 组 seam/禁源 DB 直改用) */
  readonly sourceRowIdA: string;
  readonly sourceRowIdB: string;
  /** 已物化源A 三集连续剧(T031 真实装配链产物) */
  readonly serialA: {
    readonly parentMediaId: string;
    readonly ep01MediaId: string;
    /** EP01 逻辑时长(3×120s;fixture 清单聚合) */
    readonly ep01DurationSeconds: number;
  };
  /** 已物化源A 剧场版(同名版本冲突 A 端;match_conflict 素材) */
  readonly theatricalA: {
    readonly parentMediaId: string;
    readonly movieMediaId: string;
    readonly movieDurationSeconds: number;
  };
  /** 源B 连续剧 EP01 master 清单路径(B4 hang 注入点) */
  readonly targetMasterPath: string;
  /** B4 专用:开启后源B 目标清单路径恒挂起(测速预算注入;仅 B4 调用) */
  readonly enableTargetMasterHang: () => void;
  /** 来源展示名(检索选卡 sourceLabel 精确匹配用) */
  readonly sourceLabelA: string;
  readonly sourceLabelB: string;
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

function deviceOfDeviceSession(deviceSessionId: string): string {
  const row = Database.db.prepare('SELECT device_id AS d FROM device_session WHERE id = ?').get(deviceSessionId) as
    | { d: string }
    | undefined;
  expect(row, `夹具错误:device_session ${deviceSessionId} 不存在`).toBeDefined();
  return row!.d;
}

function deviceSessionProfileContextVersionOf(deviceSessionId: string): number {
  const row = Database.db
    .prepare('SELECT profile_context_version AS v FROM device_session WHERE id = ?')
    .get(deviceSessionId) as { v: number } | undefined;
  expect(row, `夹具错误:device_session ${deviceSessionId} 不存在`).toBeDefined();
  return row!.v;
}

function mediaContentRevisionOf(mediaId: string): number {
  const row = Database.db.prepare('SELECT content_revision AS r FROM media_item WHERE id = ?').get(mediaId) as
    | { r: number | null }
    | undefined;
  expect(row, `夹具错误:media_item ${mediaId} 不存在`).toBeDefined();
  return row!.r ?? 1;
}

function playbackSourceIdOf(householdId: string, mediaId: string): string {
  const row = Database.db
    .prepare('SELECT id FROM playback_source WHERE household_id = ? AND media_item_id = ? LIMIT 1')
    .get(householdId, mediaId) as { id: string } | undefined;
  expect(row, `夹具错误:media ${mediaId} 应有物化播放资源`).toBeDefined();
  return row!.id;
}

/** kind=vod 来源行(media_source + vod_source_config 一源一行;名称固定供 sourceLabel 选卡) */
function seedVodSourceRow(householdId: string, name: string, remoteUrl: string): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  getDb().transaction((tx) => {
    tx.insert(mediaSource)
      .values({
        id: sourceId,
        householdId,
        kind: 'vod',
        name,
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

/** 搜索 → 按 sourceLabel 精确选卡 → 预览 → POST /api/vod/materializations(T031 链)→ mediaId */
async function materializeEpisodeFromSource(
  app: INestApplication,
  cookie: string,
  keyword: string,
  wantedSourceLabel: string,
  lineIndex: number,
  episodeIndex: number,
): Promise<{ mediaId: string; parentMediaId: string }> {
  const search = await request(app.getHttpServer()).get('/api/public/vod/search').query({ q: keyword });
  expect(search.status, `搜索 ${keyword} 应 200(受控上游)`).toBe(200);
  const items = (search.body as { items: Array<{ titleRef: string; sourceLabel: string }> }).items;
  const card = items.find((item) => item.sourceLabel === wantedSourceLabel);
  expect(card, `搜索 ${keyword} 应含来源「${wantedSourceLabel}」的条目(实际来源 ${items.map((item) => item.sourceLabel).join(',')})`).toBeDefined();
  const preview = await request(app.getHttpServer()).get(
    `/api/public/vod/titles/${encodeURIComponent(card!.titleRef)}`,
  );
  expect(preview.status, `预览 ${card!.titleRef} 应 200`).toBe(200);
  const episodeRef = (preview.body as {
    lines: Array<{ episodes: Array<{ episodeRef: string }> }>;
  }).lines[lineIndex]?.episodes[episodeIndex]?.episodeRef;
  expect(episodeRef, `预览 lines[${lineIndex}].episodes[${episodeIndex}] 应有候选分集`).toBeTypeOf('string');
  const res = await request(app.getHttpServer())
    .post(MATERIALIZE_URL)
    .set('Cookie', cookie)
    .send({
      titleRef: card!.titleRef,
      episodeRef: episodeRef!,
      previewRevision: (preview.body as { previewRevision: number }).previewRevision,
      operationKey: randomUUID(),
    });
  expect(res.status, `物化 ${keyword}@${wantedSourceLabel}[${lineIndex}/${episodeIndex}] 应 201(T031 已装配;实际 ${JSON.stringify(res.body)})`).toBe(
    201,
  );
  const body = res.body as { mediaId: string; parentMediaId: string };
  return { mediaId: body.mediaId, parentMediaId: body.parentMediaId };
}

async function startSwitchRig(prefix: string): Promise<SwitchRig> {
  // 契约裁决(lead,2026-10-31):受控服务器必须先启动再以真实端口重烙 presentation 源
  // (T036 惯例)。原实现以 port=0 一次成形,vod_play_url/候选 locator 恒烙 127.0.0.1:0
  // 不可路由——B1 probe 永远 unavailable。路由 path(apiPath/targetMasterPath)端口无关,
  // 处理器按名延迟解引用,服务器启动后替换 pair 即全部请求命中真实端口。
  let pair = buildSwitchSourcePair(0);
  upstreamRequests = 0;
  // B4 测速预算注入开关:开启后源B 目标清单路径恒挂起(默认放行真实路由,
  // 否则会连带挂起登记桥物化目标/候选的正常 probe —— 仅 B4 用例开启)
  let hangTargetMaster = false;
  const rawRespondOf = (sourceName: 'sourceA' | 'sourceB') => (context: MediaRequestContext) => {
    upstreamRequests += 1;
    const source = pair[sourceName];
    const route = findUpstreamRoute(source.routes, context.url.href);
    if (route === null) {
      context.res.statusCode = 404;
      context.res.setHeader('content-type', 'text/plain; charset=utf-8');
      context.res.end('fixture upstream: no route');
      return;
    }
    if (route.response.kind === 'timeout') {
      // 挂起不回包(与 T036/T052 rig 同形态;本文件路由全为健康应答,防御分支)
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
      // 源B 目标清单路径:默认经源B 真实路由应答;B4 开启 hang 后计数并挂起不回包
      {
        path: pair.targetMasterPath,
        kind: 'raw' as const,
        respond: (context: MediaRequestContext) => {
          upstreamRequests += 1;
          if (hangTargetMaster) {
            // 挂起不回包:单候选 3s/全次 5s 预算必须主动取消(B4 计划内红断言)
            return;
          }
          const route = findUpstreamRoute(pair.sourceB.routes, context.url.href);
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
        },
      },
    ],
  });
  activeMediaServers.push(server);
  // 受控服务器已监听真实端口:重烙 presentation 源(vod_play_url/候选 locator 命中真实路由)
  pair = buildSwitchSourcePair(server.port);

  const fresh = await startFreshApp({ prefix, env: { LAN_ALLOWED_TARGETS: '127.0.0.1' } });
  expect((await initialize(fresh.app)).status).toBe(201);
  const loggedIn = await login(fresh.app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const cookieA = cookiePairOf(loggedIn);
  const profileAId = await selectMainAndUnlockSettings(fresh.app, cookieA);

  // 第二设备:同账号新登录(新 DeviceSession),选同一主档案(T036/T052 同序)
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

  const householdId = householdIdOf();
  const sourceLabelA = '夹具源A(T067)';
  const sourceLabelB = '夹具源B(T067)';
  const sourceRowIdA = seedVodSourceRow(householdId, sourceLabelA, `${server.baseUrl}${pair.sourceA.apiPath}`);
  const sourceRowIdB = seedVodSourceRow(householdId, sourceLabelB, `${server.baseUrl}${pair.sourceB.apiPath}`);

  // 在线剧集物化(T031 真实装配链:搜索按 sourceLabel 选卡→预览→物化,产生 online playback_source)
  const ep01A = await materializeEpisodeFromSource(fresh.app, cookieA, 'stardust', sourceLabelA, 0, 0);
  const theatrical = await materializeEpisodeFromSource(fresh.app, cookieA, 'echocity', sourceLabelA, 0, 0);

  return {
    app: fresh.app,
    householdId,
    server,
    cookieA,
    cookieB,
    profileAId,
    deviceSessionAId: deviceSessionIdOfToken(loggedIn.body.sessionToken as string),
    deviceSessionBId: deviceSessionIdOfToken(secondLogin.body.sessionToken as string),
    sourceRowIdA,
    sourceRowIdB,
    serialA: {
      parentMediaId: ep01A.parentMediaId,
      ep01MediaId: ep01A.mediaId,
      ep01DurationSeconds: 360,
    },
    theatricalA: {
      parentMediaId: theatrical.parentMediaId,
      movieMediaId: theatrical.mediaId,
      movieDurationSeconds: 180,
    },
    targetMasterPath: pair.targetMasterPath,
    enableTargetMasterHang: () => {
      hangTargetMaster = true;
    },
    sourceLabelA,
    sourceLabelB,
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

interface IntentRow {
  readonly status: string;
  readonly slotRevision: number;
  readonly successorId: string | null;
  readonly positionMode: string;
  readonly carryPositionSeconds: number | null;
  readonly carryDurationSeconds: number | null;
  readonly sourceLedgerSeq: number | null;
  readonly sourceCheckpointGeneration: number | null;
  readonly sourceCheckpointSeq: number | null;
  readonly allowEarlierAcceptedPosition: number | null;
}

function intentRowOf(householdId: string, intentId: string): IntentRow | undefined {
  return Database.db
    .prepare(
      `SELECT status, slot_revision AS slotRevision, successor_id AS successorId, position_mode AS positionMode,
              carry_position_seconds AS carryPositionSeconds, carry_duration_seconds AS carryDurationSeconds,
              source_ledger_seq AS sourceLedgerSeq, source_checkpoint_generation AS sourceCheckpointGeneration,
              source_checkpoint_seq AS sourceCheckpointSeq,
              allow_earlier_accepted_position AS allowEarlierAcceptedPosition
       FROM playback_transition_intent WHERE household_id = ? AND id = ?`,
    )
    .get(householdId, intentId) as IntentRow | undefined;
}

function intentCountOf(householdId: string): number {
  return scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', householdId);
}

interface InputBindingRow {
  readonly startBasis: string;
  readonly frozenStartSeconds: number | null;
}

function inputBindingOf(householdId: string, sessionId: string): InputBindingRow | undefined {
  return Database.db
    .prepare(
      `SELECT start_basis AS startBasis, frozen_start_seconds AS frozenStartSeconds
       FROM playback_input_binding WHERE household_id = ? AND session_id = ?`,
    )
    .get(householdId, sessionId) as InputBindingRow | undefined;
}

function successorProgressStateOf(sessionId: string): { candidateEpoch: number; started: number } | undefined {
  return Database.db
    .prepare(
      `SELECT candidate_epoch AS candidateEpoch, started FROM playback_progress_state WHERE playback_session_id = ?`,
    )
    .get(sessionId) as { candidateEpoch: number; started: number } | undefined;
}

function historyRowPositionOf(householdId: string, profileId: string, mediaId: string): number | undefined {
  const row = Database.db
    .prepare(
      'SELECT position_seconds AS p FROM profile_viewing_history WHERE household_id = ? AND profile_id = ? AND media_id = ?',
    )
    .get(householdId, profileId, mediaId) as { p: number } | undefined;
  return row?.p;
}

/** 副本全集快照(测速零副作用断言:会话/历史/物化 operation/登记候选/intent 全不增) */
interface SideEffectSnapshot {
  readonly sessions: number;
  readonly histories: number;
  readonly materializationOperations: number;
  readonly registeredCandidates: number;
  readonly intents: number;
  readonly slots: number;
}

function sideEffectsOf(householdId: string): SideEffectSnapshot {
  return {
    sessions: scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ?', householdId),
    histories: scalarOf('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ?', householdId),
    materializationOperations: scalarOf(
      'SELECT COUNT(*) AS n FROM vod_materialization_operation WHERE household_id = ?',
      householdId,
    ),
    registeredCandidates: scalarOf('SELECT COUNT(*) AS n FROM vod_registered_candidate WHERE household_id = ?', householdId),
    intents: intentCountOf(householdId),
    slots: scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', householdId),
  };
}

/** DB 直改:禁源(media_source.enabled=0;T052 disableSource 同口径) */
function disableSource(sourceRowId: string): void {
  Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(sourceRowId);
}

/** DB 直改:设备会话身份上下文推进(等价 A→B→A;T052 bumpDeviceContextVersion 同口径) */
function bumpDeviceContextVersion(deviceSessionId: string): void {
  Database.db
    .prepare('UPDATE device_session SET profile_context_version = profile_context_version + 1 WHERE id = ?')
    .run(deviceSessionId);
}

/**
 * DB 直改:媒体故障终态(工厂事实;等价 T044/T045 故障管线库内形态 —— 网络/格式/媒体
 * 上游故障 failed + failureCode 必填满足 CHECK;recover_switch 的可恢复素材)。
 */
function flipSessionToMediaFailure(sessionId: string, failureCode: string): void {
  const updated = Database.db
    .prepare(
      `UPDATE playback_session SET state = 'failed', failure_code = ?, ended_at = ?, version = version + 1 WHERE id = ?`,
    )
    .run(failureCode, new Date().toISOString(), sessionId);
  expect(updated.changes, '夹具错误:媒体故障终态回写失败(会话行不存在)').toBe(1);
}

/** DB 直改:终态时刻回拨 61s(>60s 可恢复窗口素材;created_at/heartbeat/ended_at 成对回拨) */
function shiftSessionFailureBeyondRecoverWindow(sessionId: string): void {
  const at = new Date(Date.now() - 61_000).toISOString();
  const created = new Date(Date.now() - 62_000).toISOString();
  Database.db
    .prepare(
      'UPDATE playback_session SET ended_at = ?, last_heartbeat_at = ?, created_at = ? WHERE id = ?',
    )
    .run(at, at, created, sessionId);
}

/** 种子:终态 writer 会话(目标历史行 FK 目标;T052 seedEndedWriterSession 同款) */
function seedEndedWriterSession(input: {
  readonly householdId: string;
  readonly deviceSessionId: string;
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
      deviceId: deviceOfDeviceSession(input.deviceSessionId),
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

/** 种子:目标未完成历史行(等价「他设备已看目标位置 42」;carry 不得取该位置) */
function seedTargetHistoryFromOtherDevice(input: {
  readonly rig: SwitchRig;
  readonly mediaId: string;
  readonly positionSeconds: number;
}): void {
  const writerSessionId = seedEndedWriterSession({
    householdId: input.rig.householdId,
    deviceSessionId: input.rig.deviceSessionBId,
    profileId: input.rig.profileAId,
    mediaId: input.mediaId,
  });
  getDb()
    .insert(profileViewingHistory)
    .values({
      householdId: input.rig.householdId,
      profileId: input.rig.profileAId,
      mediaId: input.mediaId,
      writerEpoch: 1,
      writerPlaybackSessionId: writerSessionId,
      lastSampleSeq: 1,
      contentRevision: mediaContentRevisionOf(input.mediaId),
      positionSeconds: input.positionSeconds,
      durationSeconds: TRUSTED_DURATION_SECONDS,
      lastViewedAt: new Date().toISOString(),
      revision: 1,
      completed: 0,
    })
    .run();
}

/**
 * 种子:switch 形态 transition intent + slot(工厂事实;等价 T072 创建后的库内归属
 * 事实,F 组授权/失权 cleanup 面素材 —— 创建端点一期拒绝,行级事实经种子表达;
 * 全部列满足 0007 CHECK/FK,carry 三件套 + checkpoint 成对非空)。
 */
function seedSwitchIntentWithSlot(input: {
  readonly rig: SwitchRig;
  readonly fromSessionId: string;
  readonly fromGeneration: number;
  readonly status: 'pending' | 'consumed';
  readonly successorSessionId: string | null;
  readonly carry: { readonly positionSeconds: number; readonly durationSeconds: number; readonly ledgerSeq: number };
  readonly checkpoint: { readonly generation: number; readonly sampleSeq: number };
}): string {
  const intentId = randomUUID();
  const now = new Date();
  getDb().transaction((tx) => {
    tx.insert(playbackTransitionIntent)
      .values({
        id: intentId,
        householdId: input.rig.householdId,
        fromSessionId: input.fromSessionId,
        fromGeneration: input.fromGeneration,
        deviceSessionId: input.rig.deviceSessionAId,
        profileId: input.rig.profileAId,
        profileContextVersion: deviceSessionProfileContextVersionOf(input.rig.deviceSessionAId),
        action: 'switch',
        targetMediaId: input.rig.serialA.ep01MediaId,
        targetContentRevision: mediaContentRevisionOf(input.rig.serialA.ep01MediaId),
        targetContinuityRevision: 1,
        targetLocatorRevision: 1,
        matchRevision: 1,
        matchConfidence: 'high',
        confirmedAmbiguous: 0,
        positionMode: 'carry',
        carryPositionSeconds: input.carry.positionSeconds,
        carryDurationSeconds: input.carry.durationSeconds,
        sourceLedgerSeq: input.carry.ledgerSeq,
        sourceCheckpointGeneration: input.checkpoint.generation,
        sourceCheckpointSeq: input.checkpoint.sampleSeq,
        allowEarlierAcceptedPosition: 0,
        finishReceiptId: null,
        operationKey: randomUUID(),
        requestDigest: `fixture-switch-${randomUUID()}`,
        slotRevision: 1,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        status: input.status,
        successorId: input.successorSessionId,
        nextPlanId: null,
      })
      .run();
    tx.insert(playbackTransitionSlot)
      .values({
        householdId: input.rig.householdId,
        fromSessionId: input.fromSessionId,
        fromGeneration: input.fromGeneration,
        slotRevision: 1,
        status: input.status === 'consumed' ? 'consumed' : 'reserved',
        activeIntentId: intentId,
        successorSessionId: input.successorSessionId,
      })
      .run();
  });
  return intentId;
}

/** 种子:preparing 后继会话行(F1 consumed 分支 cleanup 面素材;等价消费创建的库内形态) */
function seedSuccessorSession(input: { readonly rig: SwitchRig; readonly mediaId: string }): string {
  const at = new Date().toISOString();
  const sessionId = randomUUID();
  getDb()
    .insert(playbackSession)
    .values({
      id: sessionId,
      householdId: input.rig.householdId,
      deviceSessionId: input.rig.deviceSessionAId,
      deviceId: deviceOfDeviceSession(input.rig.deviceSessionAId),
      profileId: input.rig.profileAId,
      mediaId: input.mediaId,
      playbackSourceId: playbackSourceIdOf(input.rig.householdId, input.mediaId),
      state: 'preparing',
      delivery: 'hls_proxy',
      generation: 1,
      version: 1,
      positionSeconds: 0,
      audioTrackId: null,
      subtitleTrackId: null,
      desiredPaused: 0,
      profileContextVersion: deviceSessionProfileContextVersionOf(input.rig.deviceSessionAId),
      createdAt: at,
      startedAt: at,
      endedAt: null,
      lastHeartbeatAt: at,
      failureCode: null,
    })
    .run();
  return sessionId;
}

/* ------------------------------------------------------------------ */
/* T031 登记桥 seam(D/E 组:绑定真实来源会话的候选目标直种)              */
/* ------------------------------------------------------------------ */

/** 登记桥候选目标(事实与检索世界一致:源B 星尘信使 EP01,locatorRevision=1) */
function seamCandidateTarget(input: {
  readonly sourceRowId: string;
  readonly candidateRef: string;
  readonly provenance: { readonly sourceSessionId: string; readonly sourceGeneration: number };
  /** 受控上游 origin(server.baseUrl;私有定位指向源B 连续剧真实路由,消费后可真实 probe/ready) */
  readonly locatorOrigin: string;
}): ResolvedMaterializationTarget {
  const episodes = [1, 2, 3].map((index) => ({
    episodeKey: String(index).padStart(2, '0'),
    label: `第${String(index).padStart(2, '0')}集`,
    ordinal: index,
    seasonKey: 'S01',
    sequenceRevision: 1,
    sequenceStatus: 'ordered' as const,
    contentLevel: null,
    contentVersionState: 'unverified' as const,
    evidenceKind: null,
    evidenceDigest: null,
    schemaVersion: null,
    continuityRevision: null,
    continuitySignature: null,
  }));
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  return {
    sourceId: input.sourceRowId,
    upstreamVodId: '1001',
    lineKey: 'main',
    episodeKey: '01',
    previewRevision: 1,
    previewExpiresAt: expiresAt,
    candidate: input.provenance,
    detail: {
      detailRevision: 1,
      locatorRevision: 1,
      title: 'fixture·星尘信使',
      description: null,
      parentContentLevel: null,
      payloadDigest: `fixture-t067-candidate-${randomUUID()}`,
      // 私有定位与真实检索世界同形(vod-detail-private;T042 location.service 解析面),
      // 指向源B 连续剧真实路由 —— 登记桥物化目标可真实 probe/ready(E1 消费链可用)
      validatedPrivatePayload: JSON.stringify({
        kind: 'vod-detail-private',
        lines: [
          {
            lineKey: 'main',
            name: 'fixture正片',
            episodes: [1, 2, 3].map((index) => ({
              episodeKey: String(index).padStart(2, '0'),
              locatorUrl: `${input.locatorOrigin}/vod/hls/t067-b/ep-${String(index).padStart(2, '0')}/master.m3u8`,
            })),
          },
        ],
      }),
      fetchedAt: new Date().toISOString(),
      expiresAt,
      lines: [{ lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes }],
    },
  };
}

/** 登记桥直种(T031 设计内形态;绑定真实来源会话,生产装配零注册,事务内全量重验) */
function registerSeamCandidate(input: {
  readonly rig: SwitchRig;
  readonly candidateRef: string;
  readonly provenance: { readonly sourceSessionId: string; readonly sourceGeneration: number };
}): void {
  registerVodMaterializationTarget({
    ...seamCandidateTarget({
      sourceRowId: input.rig.sourceRowIdB,
      candidateRef: input.candidateRef,
      provenance: input.provenance,
      locatorOrigin: input.rig.server.baseUrl,
    }),
    candidateRef: input.candidateRef,
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 助手                                                            */
/* ------------------------------------------------------------------ */

function getSwitchCandidates(
  app: INestApplication,
  cookie: string,
  query: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer()).get(CANDIDATES_URL).query(query).set('Cookie', cookie);
}

function postSwitchProbes(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(PROBES_URL).set('Cookie', cookie).send(body);
}

function postIntent(app: INestApplication, cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).post(INTENTS_URL).set('Cookie', cookie).send(body);
}

function getIntent(app: INestApplication, cookie: string, intentId: string): request.Test {
  return request(app.getHttpServer()).get(`${INTENTS_URL}/${intentId}`).set('Cookie', cookie);
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

function postProgress(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  body: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${sessionId}/progress`)
    .set('Cookie', cookie)
    .send(body);
}

function getStatus(app: INestApplication, cookie: string, sessionId: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${sessionId}`).set('Cookie', cookie);
}

function postRenew(
  app: INestApplication,
  cookie: string,
  sessionId: string,
  body: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer())
    .post(`/api/playback/sessions/${sessionId}/renew`)
    .set('Cookie', cookie)
    .send(body);
}

/** 轮询等待会话进入指定状态(在线 hls 候选 probe 免 ffprobe 即时成功,T036/T052 同款) */
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
/* 链式编排(计划内红点集中在此:候选/测速端点 + switch intent 创建)       */
/* ------------------------------------------------------------------ */

interface SourceSession {
  readonly sessionId: string;
  readonly generation: number;
}

/** 真实 resolve 源会话并等 ready(T031 已装配,绿基线) */
async function resolveSourceSession(
  rig: SwitchRig,
  options: { cookie?: string; mediaId?: string } = {},
): Promise<SourceSession> {
  const cookie = options.cookie ?? rig.cookieA;
  const res = await postResolve(rig.app, cookie, { mediaId: options.mediaId ?? rig.serialA.ep01MediaId });
  expect(res.status, '夹具错误:源会话 resolve 应 201(T036 已装配)').toBe(201);
  const sessionId = String(res.headers['location']).split('/').pop() ?? '';
  await waitUntilState(rig.app, cookie, sessionId, 'ready');
  return { sessionId, generation: sessionRowOf(sessionId).generation };
}

/** 服务端停止来源会话(switch 正常路径「先 stop 到 ended」前置;005 既有语义) */
async function stopSourceSession(rig: SwitchRig, source: SourceSession, cookie?: string): Promise<void> {
  const res = await postStop(rig.app, cookie ?? rig.cookieA, source.sessionId);
  expect(res.status, '夹具错误:来源会话 stop 应 204(既有 005 语义)').toBe(204);
  expect(sessionRowOf(source.sessionId).state, '夹具错误:stop 后来源会话应为终态 ended').toBe('ended');
}

/** 接受一条进度样本并返回 sessionAccepted 接受游标(等价 pauseAndFlush 返回形态,T040 已装配) */
async function acceptProgress(
  rig: SwitchRig,
  source: SourceSession,
  sampleSeq: number,
  positionSeconds: number,
  reason: 'started' | 'periodic',
): Promise<AcceptedCursor> {
  const res = await postProgress(rig.app, rig.cookieA, source.sessionId, {
    sampleSeq,
    expectedGeneration: source.generation,
    positionSeconds,
    reason,
  });
  expect(res.status, `夹具错误:进度样本 seq=${sampleSeq} 应 200(T040 已装配)`).toBe(200);
  const body = res.body as Record<string, unknown>;
  expect(body['sessionAccepted'], '夹具错误:样本应会话接受(T040 已装配)').toBe(true);
  return {
    generation: Number(body['acceptedGeneration']),
    sampleSeq: Number(body['acceptedSampleSeq']),
    positionSeconds: Number(body['acceptedPositionSeconds']),
  };
}

/** 候选清单 200 断言(A 组计划内红点;返回 items 供链式消费) */
async function getSwitchCandidatesOk(
  rig: SwitchRig,
  source: SourceSession,
): Promise<readonly SwitchCandidateLike[]> {
  const res = await getSwitchCandidates(rig.app, rig.cookieA, {
    fromSessionId: source.sessionId,
    expectedGeneration: source.generation,
  });
  expect(
    res.status,
    redLabel(
      'T070',
      `200 候选清单(GET ${CANDIDATES_URL};服务端从可信标题构造搜索)`,
      `${res.status} ${JSON.stringify(res.body).slice(0, 200)}(路由未装配)`,
    ),
  ).toBe(200);
  expect(res.headers['cache-control'], '候选清单须 no-store(api §0)').toBe('no-store');
  const body = res.body as Record<string, unknown>;
  expect(
    Object.keys(body).sort(),
    redLabel('T070', `候选清单回执键集合 ${CANDIDATES_REPLY_KEYS.join(',')}`, `当前键 ${Object.keys(body).sort().join(',')}`),
  ).toEqual([...CANDIDATES_REPLY_KEYS]);
  expect(body['partial'], 'partial 应为 boolean').toBeTypeOf('boolean');
  expect(body['reasons'], 'reasons 应为字符串数组').toBeInstanceOf(Array);
  expect(
    body['nextCursor'] === null || typeof body['nextCursor'] === 'string',
    'nextCursor 应为 string|null',
  ).toBe(true);
  const items = body['items'] as readonly SwitchCandidateLike[];
  expect(items, '同线/跨源候选至少一条(双源同集世界)').toBeInstanceOf(Array);
  expect(items.length, '同线/跨源候选至少一条(双源同集世界)').toBeGreaterThanOrEqual(1);
  return items;
}

/** 候选分支物化 201 断言(I1;返回 Materialized 供链式消费) */
async function materializeCandidateOk(
  rig: SwitchRig,
  candidate: SwitchCandidateLike,
): Promise<MaterializedLike> {
  const res = await request(rig.app.getHttpServer())
    .post(MATERIALIZE_URL)
    .set('Cookie', rig.cookieA)
    .send({ candidateRef: candidate.candidateRef, previewRevision: candidate.previewRevision, operationKey: randomUUID() });
  expect(
    res.status,
    redLabel(
      'T070',
      `201 候选分支物化(POST ${MATERIALIZE_URL};candidateRef 来自候选端点签发)`,
      `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
    ),
  ).toBe(201);
  const body = res.body as MaterializedLike;
  expect(Object.keys(body).sort(), 'Materialized 7 键全量(openapi additionalProperties:false)').toEqual([
    ...MATERIALIZED_KEYS,
  ]);
  expect(body.candidateRef, '候选分支回显非空 candidateRef').not.toBeNull();
  expect(
    body.registeredCandidateRef,
    redLabel('T070+T072', 'registeredCandidateRef 非空(I1 登记映射引用;intent 只接受已登记目标)', 'registeredCandidateRef 为空'),
  ).toBeTruthy();
  return body;
}

/** switch/recover_switch intent 创建 201 断言(T072 计划内红点;targetCandidateRef=registeredCandidateRef) */
async function postSwitchIntentOk(
  rig: SwitchRig,
  input: {
    readonly action?: 'switch' | 'recover_switch';
    readonly source: SourceSession;
    readonly targetCandidateRef: string;
    readonly previewRevision: number;
    readonly positionMode: 'carry' | 'target_history' | 'beginning';
    readonly sourceCheckpoint?: { readonly expectedGeneration: number; readonly sampleSeq: number };
    readonly allowEarlierAcceptedPosition?: boolean;
    readonly confirmedAmbiguous?: boolean;
    readonly expectedSlotRevision?: number;
    readonly operationKey?: string;
  },
): Promise<IntentSnapshot> {
  const res = await postIntent(rig.app, rig.cookieA, {
    fromSessionId: input.source.sessionId,
    expectedGeneration: input.source.generation,
    action: input.action ?? 'switch',
    targetCandidateRef: input.targetCandidateRef,
    previewRevision: input.previewRevision,
    positionMode: input.positionMode,
    confirmedAmbiguous: input.confirmedAmbiguous ?? false,
    ...(input.sourceCheckpoint === undefined ? {} : { sourceCheckpoint: input.sourceCheckpoint }),
    ...(input.allowEarlierAcceptedPosition === undefined ? {} : { allowEarlierAcceptedPosition: input.allowEarlierAcceptedPosition }),
    expectedSlotRevision: input.expectedSlotRevision ?? 0,
    operationKey: input.operationKey ?? randomUUID(),
  });
  expect(
    res.status,
    redLabel(
      'T070+T072',
      `201 IntentReply(POST ${INTENTS_URL};switch 分支经候选映射接受)`,
      `${res.status} ${JSON.stringify(res.body).slice(0, 200)}(一期 switch 分支被 rejectSwitchPathInPhase1 拒绝)`,
    ),
  ).toBe(201);
  return res.body as IntentSnapshot;
}

interface CandidateChain {
  readonly source: SourceSession;
  readonly candidate: SwitchCandidateLike;
  readonly materialized: MaterializedLike;
}

/** 全链:源会话 → 候选 → 取 high 候选 → 候选分支物化(计划内红点:候选端点) */
async function chainHighCandidateMaterialization(
  rig: SwitchRig,
  source: SourceSession,
): Promise<CandidateChain> {
  const items = await getSwitchCandidatesOk(rig, source);
  const candidate =
    items.find((item) => item.matchConfidence === 'high') ??
    (items[0] as SwitchCandidateLike | undefined);
  expect(candidate, '候选清单应含 high 匹配项(跨源同题世界)').toBeDefined();
  const materialized = await materializeCandidateOk(rig, candidate!);
  return { source, candidate: candidate!, materialized };
}

/* ------------------------------------------------------------------ */
/* 通用 afterEach                                                       */
/* ------------------------------------------------------------------ */

afterEach(async () => {
  registerPersonalPlaybackFactsPort(null);
  clearVodMaterializationTargets();
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* A 候选清单(api.md §5 GET /vod/switch-candidates;T070 被测目标)       */
/* ------------------------------------------------------------------ */

describe('T067 · A 候选清单(api.md §5 候选表+语义段;T070 为被测实现目标)', () => {
  it('A1 [计划内红·待 T070] 已授权源会话候选 200:4 键回执+SwitchCandidate 12 键;跨源同题 high 候选;ref 不透明+TTL 60s;候选只元数据不物化', async () => {
    const rig = await startSwitchRig('hmp-t067-a1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const source = await resolveSourceSession(rig);
    const before = sideEffectsOf(rig.householdId);
    const items = await getSwitchCandidatesOk(rig, source);
    const candidate = items[0]!;
    // SwitchCandidate 12 键全量(openapi additionalProperties:false;source 内部 ID/位置不下发)
    expect(
      Object.keys(candidate).sort(),
      redLabel(
        'T070',
        `SwitchCandidate 键集合 ${SWITCH_CANDIDATE_KEYS.join(',')}`,
        `当前键 ${Object.keys(candidate).sort().join(',')}`,
      ),
    ).toEqual([...SWITCH_CANDIDATE_KEYS]);
    expect(
      ['high', 'ambiguous', 'conflict'],
      redLabel('T070', 'matchConfidence ∈ high|ambiguous|conflict(枚举)', `实际 ${candidate.matchConfidence}`),
    ).toContain(candidate.matchConfidence);
    // 契约裁决(lead,2026-10-31):跨源同题【剧集形态】的集锚定候选,候选侧 season/language
    // 事实缺失(T025 解析面无此字段)→ 按 T068 冻结判定表为 ambiguous(season_episode_missing),
    // 系 data-model §3「缺关键字段不自动制造内容一致」的保守语义;high 已在 T068 规则层以
    // 电影形态(双侧季/集沉默)钉死,服务级对剧集形态恒 ambiguous 并非缺陷。
    expect(
      candidate.matchConfidence,
      redLabel('T070', '剧集形态集锚定候选=ambiguous(缺季声明,保守)', `实际 ${candidate.matchConfidence}/${candidate.matchReasons?.join(',')}`),
    ).toBe('ambiguous');
    expect(candidate.matchReasons, '降歧义原因应含季集缺失').toContain('season_episode_missing');
    expect(candidate.title, '候选标题来自可信标题检索(星尘信使)').toBe('fixture·星尘信使');
    expect(candidate.label, '候选应绑定具体集(第01集)').toBe('第01集');
    expect(candidate.previewRevision, '候选携带预览修订(物化入口)').toBeGreaterThanOrEqual(1);
    expect(candidate.candidateRef, 'candidateRef 不透明且不携带可解码 URL(api §0)').not.toMatch(/^https?:\/\//);
    expect(new Date(candidate.expiresAt).getTime(), '候选 TTL 60s 固定(expiresAt≈now+60s)').toBeGreaterThanOrEqual(
      Date.now() + 55_000,
    );
    expect(new Date(candidate.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 65_000);
    // 候选只元数据:不物化不写历史(api §5「不物化/写历史」同义面;测速同,B1 另钉)
    expect(sideEffectsOf(rig.householdId), '候选列举不得产生会话/历史/物化/登记/intent 副作用').toEqual(before);
  });

  it('A2 [计划内红·待 T070] 不接受任意 q/URL(未知字段 400);跨设备/错误代次/伪造 fromSession 与随机 id 404 同形', async () => {
    const rig = await startSwitchRig('hmp-t067-a2-');
    const source = await resolveSourceSession(rig);
    // 任意 q/URL 一律拒绝:服务端只从可信标题构造搜索(api §5「不接任意q/URL」)
    const withQ = await getSwitchCandidates(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      q: 'anything',
    });
    expectProblem(withQ, 400, ProblemCode.VALIDATION_FAILED);
    const withUrl = await getSwitchCandidates(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      url: 'http://127.0.0.1:9/api.php',
    });
    expectProblem(withUrl, 400, ProblemCode.VALIDATION_FAILED);
    // 跨设备(设备B 读设备A 会话)/错误代次/随机 id → 404 同形(不可判别存在性)
    const crossDevice = await getSwitchCandidates(rig.app, rig.cookieB, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
    });
    const wrongGeneration = await getSwitchCandidates(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation + 7,
    });
    const randomId = await getSwitchCandidates(rig.app, rig.cookieA, {
      fromSessionId: randomUUID(),
      expectedGeneration: 1,
    });
    for (const face of [crossDevice, wrongGeneration, randomId]) {
      expect(
        face.status,
        redLabel('T070', '404 NOT_FOUND(未授权 fromSession 同形)', `${face.status} ${JSON.stringify(face.body).slice(0, 160)}`),
      ).toBe(404);
      expectProblemContentType(face);
    }
    expectSameShape(crossDevice, randomId, '跨设备与随机 id 必须同形 404');
    expectSameShape(wrongGeneration, randomId, '错误代次与随机 id 必须同形 404');
  });

  it('A3 [计划内红·待 T070] 版本冲突世界候选:同名不同版本 → matchConfidence=conflict+matchReasons;不冒充 high', async () => {
    const rig = await startSwitchRig('hmp-t067-a3-');
    const source = await resolveSourceSession(rig, { mediaId: rig.theatricalA.movieMediaId });
    const items = await getSwitchCandidatesOk(rig, source);
    // 源A 剧场版(2019)在播,源B 导演剪辑版(2023)同名同年检索词 → match_conflict 素材
    const conflict = items.find((item) => item.matchConfidence === 'conflict');
    expect(
      conflict,
      redLabel(
        'T070',
        '应含 matchConfidence=conflict 候选(fixture 版本冲突世界:2019 剧场版 vs 2023 导演剪辑版)',
        `实际 confidence 分布 ${JSON.stringify(items.map((item) => item.matchConfidence))}`,
      ),
    ).toBeDefined();
    expect(conflict!.versionLabel, '冲突候选应携带版本标签(导演剪辑版)').toBe('导演剪辑版');
    expect(conflict!.year, '冲突候选应携带年份(2023)').toBe('2023');
    expect(
      (conflict!.matchReasons as readonly string[]).length,
      'conflict 候选应携带匹配原因(年/版本冲突可解释)',
    ).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => item.matchConfidence === 'high'), '版本冲突不得整体冒充 high').toBe(false);
  });

  it('A4 [计划内红·待 T070] failed 可恢复来源仅 60s:窗口内候选 200;窗口外(DB 回拨终态时刻)4xx 拒绝', async () => {
    const rig = await startSwitchRig('hmp-t067-a4-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const source = await resolveSourceSession(rig);
    await acceptProgress(rig, source, 1, 60, 'started');
    // 工厂事实(DB 直改注明):媒体故障终态(等价 T044/T045 故障管线库内形态)
    flipSessionToMediaFailure(source.sessionId, 'PLAYBACK_FORMAT_UNSUPPORTED');
    // 60s 窗口内:failed 来源仍可恢复 → 候选可用
    const withinWindow = await getSwitchCandidates(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
    });
    expect(
      withinWindow.status,
      redLabel(
        'T070',
        '200(failed 可恢复来源 60s 窗口内候选可用)',
        `${withinWindow.status} ${JSON.stringify(withinWindow.body).slice(0, 160)}`,
      ),
    ).toBe(200);
    // DB 直改注明:终态时刻回拨 61s(>60s 窗口素材;created_at/heartbeat/ended_at 成对回拨)
    shiftSessionFailureBeyondRecoverWindow(source.sessionId);
    const beyondWindow = await getSwitchCandidates(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
    });
    // 窗口外恢复资格关闭:不再返回候选(具体码随 T070 装配收敛;404 同形预期)
    expect4xxProblem(
      beyondWindow,
      redLabel('T070', '4xx(60s 恢复窗口关闭,不再返回候选;404 同形预期)', `${beyondWindow.status}`),
    );
    expect(beyondWindow.status, '窗口外不得仍 200 返回候选').not.toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* B 测速(api.md §5 POST /vod/switch-probes;T071 被测目标)              */
/* ------------------------------------------------------------------ */

describe('T067 · B 测速(api.md §5 测速表+语义段;T071 为被测实现目标)', () => {
  it('B1 [计划内红·待 T071] 授权候选测速 200:ProbeResult 4 键+reachable+首响应延迟;无票/无历史/不物化(全副本零副作用)', async () => {
    const rig = await startSwitchRig('hmp-t067-b1-');
    const source = await resolveSourceSession(rig);
    const chain = await chainHighCandidateMaterialization(rig, source);
    const before = sideEffectsOf(rig.householdId);
    const res = await postSwitchProbes(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      candidateRefs: [chain.candidate.candidateRef],
    });
    expect(
      res.status,
      redLabel(
        'T071',
        `200 测速回执(POST ${PROBES_URL};逐候选预览有效+策略检查后有界请求)`,
        `${res.status} ${JSON.stringify(res.body).slice(0, 200)}(路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as { items: readonly ProbeResultLike[] };
    expect(body.items, '测速回执应与 candidateRefs 一一对应').toHaveLength(1);
    const probe = body.items[0]!;
    expect(
      Object.keys(probe).sort(),
      redLabel('T071', `ProbeResult 键集合 ${PROBE_RESULT_KEYS.join(',')}`, `当前键 ${Object.keys(probe).sort().join(',')}`),
    ).toEqual([...PROBE_RESULT_KEYS]);
    expect(probe.candidateRef, '测速结果回显候选引用').toBe(chain.candidate.candidateRef);
    expect(
      probe.status,
      redLabel('T071', "status='reachable'(健康受控上游)", `实际 ${probe.status}`),
    ).toBe('reachable');
    expect(probe.latencyMs === null || probe.latencyMs >= 0, 'latencyMs 为首响应延迟(number|null)').toBe(true);
    expect(new Date(probe.checkedAt).toString(), 'checkedAt 应为时间戳').not.toBe('Invalid Date');
    // 无票/无历史/不物化(api §5「无票/无历史」):全副本零副作用
    expect(sideEffectsOf(rig.householdId), '测速不得写会话/历史/物化/登记/intent/slot').toEqual(before);
  });

  it('B2 [计划内红·待 T071] 未授权目标不探测:伪造/随机 candidateRef 404 同形且零上游请求(受控上游计数断言)', async () => {
    const rig = await startSwitchRig('hmp-t067-b2-');
    const source = await resolveSourceSession(rig);
    // 先取真实候选(链式前置,保证本用例在装配后是「已授权世界」下的未授权目标)
    await getSwitchCandidatesOk(rig, source);
    const upstreamBaseline = upstreamRequests;
    const forged = await postSwitchProbes(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      candidateRefs: [`vod-candidate-forged-${randomUUID()}`],
    });
    expect(
      forged.status,
      redLabel('T071', '404 NOT_FOUND(未授权目标同形,不探测)', `${forged.status} ${JSON.stringify(forged.body).slice(0, 160)}`),
    ).toBe(404);
    const random = await postSwitchProbes(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      candidateRefs: [randomUUID()],
    });
    expect(random.status, '随机 ref 同形 404').toBe(404);
    expectSameShape(forged, random, '伪造与随机未授权目标必须同形 404');
    // 零上游请求(受控上游断言):未授权目标不得触达任何上游(T071 先授权再测)
    expect(
      upstreamRequestsSince(upstreamBaseline),
      redLabel('T071', '未授权目标探测不得产生任何上游请求', `实际上游请求 ${upstreamRequestsSince(upstreamBaseline)} 次`),
    ).toBe(0);
  });

  it('B3 [计划内红·待 T071] candidateRefs 预算:0 个/4 个(>3)一律 400 VALIDATION_FAILED', async () => {
    const rig = await startSwitchRig('hmp-t067-b3-');
    const source = await resolveSourceSession(rig);
    for (const refs of [[], ['a', 'b', 'c', 'd']]) {
      const res = await postSwitchProbes(rig.app, rig.cookieA, {
        fromSessionId: source.sessionId,
        expectedGeneration: source.generation,
        candidateRefs: refs,
      });
      expect(
        res.status,
        redLabel('T071', `400 VALIDATION_FAILED(candidateRefs ${refs.length} 个,须 1–3)`, `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`),
      ).toBe(400);
      expect(res.body.code, 'candidateRefs 界外应稳定 400').toBe(ProblemCode.VALIDATION_FAILED);
    }
  });

  it('B4 [计划内红·待 T071] 有界预算:上游清单恒挂起时测速须在预算内返回 timeout/unavailable(单候选 3s/全次 5s)', async () => {
    const rig = await startSwitchRig('hmp-t067-b4-');
    const source = await resolveSourceSession(rig);
    const chain = await chainHighCandidateMaterialization(rig, source);
    // 开启目标清单挂起(仅本用例;源B 真实路由其余放行)
    rig.enableTargetMasterHang();
    const startedAt = Date.now();
    const res = await postSwitchProbes(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      candidateRefs: [chain.candidate.candidateRef],
    });
    const elapsedMs = Date.now() - startedAt;
    expect(
      res.status,
      redLabel('T071', `200(预算内有界返回;实际 ${elapsedMs}ms)`, `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`),
    ).toBe(200);
    const probe = (res.body as { items: readonly ProbeResultLike[] }).items[0];
    expect(probe, '挂起目标应返回单条有界结果').toBeDefined();
    expect(
      ['timeout', 'unavailable'],
      redLabel('T071', "挂起目标 status ∈ timeout|unavailable(不宣称带宽/画质)", `实际 ${probe!.status}`),
    ).toContain(probe!.status);
    // 单候选 3s/全次 5s 预算(8s 为 CI 抖动上界;超出即预算未生效)
    expect(
      elapsedMs,
      redLabel('T071', `预算内返回(≤8000ms;实际 ${elapsedMs}ms)`, `实际 ${elapsedMs}ms(预算未生效)`),
    ).toBeLessThanOrEqual(8000);
  });
});

/* ------------------------------------------------------------------ */
/* C switch 消费(api.md §5 switch 分支+消费位置语义;T070+T072+T073)     */
/* ------------------------------------------------------------------ */

describe('T067 · C switch 消费(api.md §5 IntentRequest switch 分支+消费位置语义+I2 checkpoint;T070+T072+T073)', () => {
  it('C1 [计划内红·待 T070+T072+T073] carry 全链:checkpoint 冻结 ledger → intent 201(checkpoint 落库)→ stop → resolve 201 startBasis=transition_carry+frozen=接受游标;他设备历史不劫持位置', async () => {
    const rig = await startSwitchRig('hmp-t067-c1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const source = await resolveSourceSession(rig);
    await acceptProgress(rig, source, 1, 180, 'started');
    const cursor = await acceptProgress(rig, source, 2, 240, 'periodic');
    const chain = await chainHighCandidateMaterialization(rig, source);
    // 他设备已看目标位置 42(工厂事实):carry 必须来自源会话 ledger,不得取目标历史
    seedTargetHistoryFromOtherDevice({ rig, mediaId: chain.materialized.mediaId, positionSeconds: 42 });
    const intent = await postSwitchIntentOk(rig, {
      source,
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      sourceCheckpoint: { expectedGeneration: cursor.generation, sampleSeq: cursor.sampleSeq },
    });
    expect(Object.keys(intent).sort(), 'IntentReply 11 键全量(api §1)').toEqual([...INTENT_REPLY_KEYS]);
    expect(intent.action).toBe('switch');
    expect(intent.status).toBe('pending');
    expect(intent.positionMode).toBe('carry');
    expect(
      intent.matchConfidence,
      '剧集形态候选匹配事实等级=ambiguous(T072 断言修正:对齐 A1 lead 契约裁决 —— T068 钉死 high 仅电影形态(双侧季/集沉默),剧集形态恒 ambiguous 并非缺陷;IntentReply 恒报匹配事实等级,不因确认提升)',
    ).toBe('ambiguous');
    expect(intent.successorSessionId, '消费前 successor=null').toBeNull();
    expect(intent.targetMediaId, 'intent 目标=登记映射目标').toBe(chain.materialized.mediaId);
    // 库内冻结事实:data-model §10「与当前 ledger 精确匹配后复制 position/duration 及修订」
    const row = intentRowOf(rig.householdId, intent.id);
    expect(row?.positionMode).toBe('carry');
    expect(row?.carryPositionSeconds, redLabel('T072', 'carry_position_seconds=240(精确 checkpoint 游标)', `实际 ${String(row?.carryPositionSeconds)}`)).toBe(240);
    expect(row?.carryDurationSeconds).toBe(TRUSTED_DURATION_SECONDS);
    expect(row?.sourceLedgerSeq).toBe(cursor.sampleSeq);
    expect(row?.sourceCheckpointGeneration).toBe(cursor.generation);
    expect(row?.sourceCheckpointSeq).toBe(cursor.sampleSeq);
    // 正常 switch 旧源必须先 stop 到 ended(api §5)
    await stopSourceSession(rig, source);
    const res = await postResolve(rig.app, rig.cookieA, {
      mediaId: chain.materialized.mediaId,
      transitionIntentId: intent.id,
    });
    expect(
      res.status,
      redLabel('T072+T073', '201 preparing(resolve 消费 switch 意图)', `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`),
    ).toBe(201);
    const successorId = String(res.headers['location']).split('/').pop();
    const body = res.body as Record<string, unknown>;
    expect(body['startBasis'], 'positionMode=carry 映射唯一 startBasis=transition_carry').toBe('transition_carry');
    expect(body['playbackUrl'] ?? null, '消费不发票(发票仍走 renew)').toBeNull();
    // 原子结果:intent consumed + slot successor
    expect(intentRowOf(rig.householdId, intent.id)?.status).toBe('consumed');
    expect(intentRowOf(rig.householdId, intent.id)?.successorId).toBe(successorId);
    expect(slotRowOf(rig.householdId, source.sessionId)?.status).toBe('consumed');
    expect(slotRowOf(rig.householdId, source.sessionId)?.successorSessionId).toBe(successorId);
    // carry 位置=冻结源 ledger(240),不被他设备目标历史(42)劫持(T073)
    await waitUntilState(rig.app, rig.cookieA, successorId!, 'ready');
    const binding = inputBindingOf(rig.householdId, successorId!);
    expect(binding?.startBasis).toBe('transition_carry');
    expect(
      binding?.frozenStartSeconds,
      redLabel('T073', 'frozen_start_seconds=240(carry 来自冻结 ledger,不取他设备历史 42)', `实际 ${String(binding?.frozenStartSeconds)}`),
    ).toBe(240);
    expect(successorProgressStateOf(successorId!), '后继应分配 epoch/ledger 建档').toBeDefined();
    expect(historyRowPositionOf(rig.householdId, rig.profileAId, chain.materialized.mediaId), '他设备历史保留(不被消费改写)').toBe(42);
    expect(sessionRowOf(source.sessionId).state, '来源保持 ended(不被复活)').toBe('ended');
  });

  it('C2 [计划内红·待 T072] checkpoint 缺失:carry 无 sourceCheckpoint → 400 VALIDATION_FAILED,不落 intent', async () => {
    const rig = await startSwitchRig('hmp-t067-c2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const source = await resolveSourceSession(rig);
    const cursor = await acceptProgress(rig, source, 1, 240, 'started');
    const chain = await chainHighCandidateMaterialization(rig, source);
    // 快乐前置(同槽首发,expectedSlotRevision=0):checkpoint 齐备可创建(转绿后 201)
    const happy = await postSwitchIntentOk(rig, {
      source,
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      sourceCheckpoint: { expectedGeneration: cursor.generation, sampleSeq: cursor.sampleSeq },
    });
    expect(happy.status).toBe('pending');
    // 缺 checkpoint 的 carry → 400(carry 必须提供 sourceCheckpoint;api §5)
    const missing = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      expectedSlotRevision: 1,
      operationKey: randomUUID(),
    });
    expect(
      missing.status,
      redLabel('T072', '400 VALIDATION_FAILED(carry 缺 sourceCheckpoint)', `${missing.status} ${JSON.stringify(missing.body).slice(0, 160)}`),
    ).toBe(400);
    expect(missing.body.code, 'carry 缺 sourceCheckpoint 稳定码(T072 实参修正:同 C5 lead 修法)').toBe('VALIDATION_FAILED');
    expect(intentCountOf(rig.householdId), '缺 checkpoint 拒绝不落新 intent(仅存快乐前置 1 条)').toBe(1);
  });

  it('C3 [计划内红·待 T072] checkpoint 不等(游标未接受):409 SOURCE_PROGRESS_PENDING,不落 intent;ledger 精确相等才可创建', async () => {
    const rig = await startSwitchRig('hmp-t067-c3-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const source = await resolveSourceSession(rig);
    const cursor = await acceptProgress(rig, source, 1, 240, 'started');
    const chain = await chainHighCandidateMaterialization(rig, source);
    const happy = await postSwitchIntentOk(rig, {
      source,
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      sourceCheckpoint: { expectedGeneration: cursor.generation, sampleSeq: cursor.sampleSeq },
    });
    expect(happy.status).toBe('pending');
    // 提交未接受游标(seq=2 从未接受;当前 ledger 停在 seq=1)→ 409 SOURCE_PROGRESS_PENDING
    const unequal = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: { expectedGeneration: cursor.generation, sampleSeq: cursor.sampleSeq + 1 },
      expectedSlotRevision: 1,
      operationKey: randomUUID(),
    });
    expect(
      unequal.status,
      redLabel('T072', '409 SOURCE_PROGRESS_PENDING(事务读取的当前代 ledger 必须精确等于该游标)', `${unequal.status} ${JSON.stringify(unequal.body).slice(0, 160)}`),
    ).toBe(409);
    expect(unequal.body.code).toBe('SOURCE_PROGRESS_PENDING');
    expect(intentCountOf(rig.householdId), 'checkpoint 不等拒绝不落新 intent(仅存快乐前置 1 条)').toBe(1);
  });

  it('C4 [计划内红·待 T072] 明确旧游标:无 flag 409;allowEarlierAcceptedPosition=true+新 key 接受且冻结旧游标;未接受样本永不为 checkpoint', async () => {
    const rig = await startSwitchRig('hmp-t067-c4-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const source = await resolveSourceSession(rig);
    const oldCursor = await acceptProgress(rig, source, 1, 180, 'started');
    const currentCursor = await acceptProgress(rig, source, 2, 240, 'periodic'); // ledger 前进至 seq2@240
    const chain = await chainHighCandidateMaterialization(rig, source);
    // (a) 旧游标(seq1@180)无显式回退标志 → 409(不自动挑旧位置)
    const withoutFlag = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: { expectedGeneration: oldCursor.generation, sampleSeq: oldCursor.sampleSeq },
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expect(
      withoutFlag.status,
      redLabel('T072', '409 SOURCE_PROGRESS_PENDING(ledger 已前进,须显式确认旧游标)', `${withoutFlag.status} ${JSON.stringify(withoutFlag.body).slice(0, 160)}`),
    ).toBe(409);
    expect(withoutFlag.body.code, '旧游标无标志稳定码(T072 实参修正:同 C5 lead 修法)').toBe('SOURCE_PROGRESS_PENDING');
    // (b) 契约裁决(lead,2026-10-31):原「旧游标 180+allow→201 冻结 180」违背 api §5 冻结原文
    // 「仍须精确相等;ledger 已前进则重新展示/确认」——ledger 已前进至 seq2@240,旧游标
    // (seq1@180)即使带 allowEarlierAcceptedPosition 也必须 409 重新展示(flag 不豁免精确
    // 相等;data-model §10「不需要保留全部历史样本」,服务端不可证 seq1@180)。allow 的语义
    // =用户显式确认采用「早于当前播放头」的已接受位置,并非豁免 checkpoint 精确性。
    const staleWithFlag = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: { expectedGeneration: oldCursor.generation, sampleSeq: oldCursor.sampleSeq },
      allowEarlierAcceptedPosition: true,
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expect(
      staleWithFlag.status,
      redLabel('T072', '409 SOURCE_PROGRESS_PENDING(flag 不豁免精确相等,ledger 已前进须重新展示)', `${staleWithFlag.status} ${JSON.stringify(staleWithFlag.body).slice(0, 160)}`),
    ).toBe(409);
    expect(staleWithFlag.body.code, '旧游标+flag 稳定码').toBe('SOURCE_PROGRESS_PENDING');
    // (b') 用户确认已显示的当前接受游标:新 key + 精确当前游标(seq2@240) + allow=true → 201
    // (carry 位置早于播放头属 UI 语义;服务端钉「精确当前游标+确认位持久」)
    const withFlag = await postSwitchIntentOk(rig, {
      source,
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      sourceCheckpoint: { expectedGeneration: currentCursor.generation, sampleSeq: currentCursor.sampleSeq },
      allowEarlierAcceptedPosition: true,
    });
    expect(withFlag.status).toBe('pending');
    expect(
      intentRowOf(rig.householdId, withFlag.id)?.carryPositionSeconds,
      redLabel('T072', 'carry_position_seconds=240(精确当前接受游标)', `实际 ${String(intentRowOf(rig.householdId, withFlag.id)?.carryPositionSeconds)}`),
    ).toBe(240);
    expect(intentRowOf(rig.householdId, withFlag.id)?.sourceCheckpointSeq).toBe(currentCursor.sampleSeq);
    expect(
      intentRowOf(rig.householdId, withFlag.id)?.allowEarlierAcceptedPosition,
      'allow 确认位持久(审计语义)',
    ).toBe(1);
    // (c) 从未接受的样本(seq99)即使带 flag 也不得作为 checkpoint(仍须精确相等)
    const neverAccepted = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: { expectedGeneration: oldCursor.generation, sampleSeq: 99 },
      allowEarlierAcceptedPosition: true,
      expectedSlotRevision: 1,
      operationKey: randomUUID(),
    });
    expect(
      neverAccepted.status,
      redLabel('T072', '409 SOURCE_PROGRESS_PENDING(未接受样本不作为 checkpoint)', `${neverAccepted.status} ${JSON.stringify(neverAccepted.body).slice(0, 160)}`),
    ).toBe(409);
    expect(neverAccepted.body.code, '未接受样本稳定码(T072 实参修正:同 C5 lead 修法)').toBe('SOURCE_PROGRESS_PENDING');
    // 消费明确接受游标:先 stop → resolve 201,frozen=240(精确当前接受游标)
    await stopSourceSession(rig, source);
    const res = await postResolve(rig.app, rig.cookieA, {
      mediaId: chain.materialized.mediaId,
      transitionIntentId: withFlag.id,
    });
    expect(res.status, redLabel('T072+T073', '201(明确接受游标消费)', `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`)).toBe(201);
    const successorId = String(res.headers['location']).split('/').pop();
    await waitUntilState(rig.app, rig.cookieA, successorId!, 'ready');
    expect(
      inputBindingOf(rig.householdId, successorId!)?.frozenStartSeconds,
      redLabel('T073', 'frozen_start_seconds=240(用户确认的当前接受游标)', `实际 ${String(inputBindingOf(rig.householdId, successorId!)?.frozenStartSeconds)}`),
    ).toBe(240);
  });

  it('C5 [计划内红·待 T070+T072] conflict 候选禁 carry:carry → 400(conflict 只 beginning/target_history),不落 intent', async () => {
    const rig = await startSwitchRig('hmp-t067-c5-');
    const source = await resolveSourceSession(rig, { mediaId: rig.theatricalA.movieMediaId });
    const items = await getSwitchCandidatesOk(rig, source);
    const conflict = items.find((item) => item.matchConfidence === 'conflict');
    expect(conflict, '夹具前提:版本冲突世界应含 conflict 候选').toBeDefined();
    const materialized = await materializeCandidateOk(rig, conflict!);
    const res = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: materialized.registeredCandidateRef!,
      previewRevision: conflict!.previewRevision,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: { expectedGeneration: source.generation, sampleSeq: 1 },
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    // conflict 只 beginning/target_history 且不能继承源位置(api §5)
    // 契约裁决(lead,2026-10-31):原用例把 redLabel 散文串误作 expectProblem 的 code 实参(恒假);
    // 修正为稳定码 VALIDATION_FAILED,redLabel 语义移入断言消息。
    expect(
      res.status,
      redLabel('T072', '400 VALIDATION_FAILED(conflict 候选禁 carry)', `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`),
    ).toBe(400);
    expect(res.body.code, 'conflict 候选禁 carry 稳定码').toBe('VALIDATION_FAILED');
    expect(intentCountOf(rig.householdId), 'conflict carry 拒绝不落 intent').toBe(0);
  });

  it('C6 [计划内红·待 T072] 源未终态不消费:resolve → 409 SOURCE_NOT_TERMINAL(intent 保持 pending);停止丢响应恢复(stop 幂等重试)后消费 201', async () => {
    const rig = await startSwitchRig('hmp-t067-c6-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const source = await resolveSourceSession(rig);
    const cursor = await acceptProgress(rig, source, 1, 240, 'started');
    const chain = await chainHighCandidateMaterialization(rig, source);
    const intent = await postSwitchIntentOk(rig, {
      source,
      targetCandidateRef: chain.materialized.registeredCandidateRef!,
      previewRevision: chain.candidate.previewRevision,
      positionMode: 'carry',
      sourceCheckpoint: { expectedGeneration: cursor.generation, sampleSeq: cursor.sampleSeq },
    });
    // 源仍活动(ready)即消费 → 409 SOURCE_NOT_TERMINAL,不消耗 intent(api §5)
    const early = await postResolve(rig.app, rig.cookieA, {
      mediaId: chain.materialized.mediaId,
      transitionIntentId: intent.id,
    });
    expect(
      early.status,
      redLabel('T072', '409 SOURCE_NOT_TERMINAL(未确认终态不消费)', `${early.status} ${JSON.stringify(early.body).slice(0, 160)}`),
    ).toBe(409);
    expect(early.body.code, '源未终态稳定码(T072 实参修正:同 C5 lead 修法)').toBe('SOURCE_NOT_TERMINAL');
    expect(intentRowOf(rig.householdId, intent.id)?.status, '409 不消耗 intent').toBe('pending');
    expect(slotRowOf(rig.householdId, source.sessionId)?.status).toBe('reserved');
    // 停止丢响应恢复:stop 响应丢失 → 先恢复状态(幂等重发 stop,005 既有语义 204),未确认终态不消费
    await stopSourceSession(rig, source);
    const stopAgain = await postStop(rig.app, rig.cookieA, source.sessionId);
    expect(stopAgain.status, '重复 stop 幂等 204(终态零副作用;T058 面)').toBe(204);
    expect(sessionRowOf(source.sessionId).state).toBe('ended');
    const consumed = await postResolve(rig.app, rig.cookieA, {
      mediaId: chain.materialized.mediaId,
      transitionIntentId: intent.id,
    });
    expect(consumed.status, redLabel('T072+T073', '201(stop 恢复后消费成功)', `${consumed.status} ${JSON.stringify(consumed.body).slice(0, 160)}`)).toBe(201);
    expect(intentRowOf(rig.householdId, intent.id)?.status).toBe('consumed');
  });
});

/* ------------------------------------------------------------------ */
/* D candidateRef 物化贯通(审查补充;I1 + T031 登记桥既有绿面)           */
/* ------------------------------------------------------------------ */

describe('T067 · D candidateRef 物化贯通(api.md §7 I1;T031 登记桥既有绿面 + T072 意图接受)', () => {
  it('D1 [绿·T031 登记桥] 绑定真实来源会话的 candidateRef → 物化分支 201 → registeredCandidateRef 落库(source session/generation 绑定);同 key 重放 200 同引用', async () => {
    const rig = await startSwitchRig('hmp-t067-d1-');
    const source = await resolveSourceSession(rig);
    const candidateRef = `vod-candidate-t067-${randomUUID()}`;
    registerSeamCandidate({
      rig,
      candidateRef,
      provenance: { sourceSessionId: source.sessionId, sourceGeneration: source.generation },
    });
    const operationKey = randomUUID();
    const first = await request(rig.app.getHttpServer())
      .post(MATERIALIZE_URL)
      .set('Cookie', rig.cookieA)
      .send({ candidateRef, previewRevision: 1, operationKey });
    expect(first.status, '候选分支物化 201(T031 已装配)').toBe(201);
    const body = first.body as MaterializedLike;
    expect(Object.keys(body).sort(), 'Materialized 7 键全量').toEqual([...MATERIALIZED_KEYS]);
    expect(body.candidateRef, '候选分支回显原 candidateRef').toBe(candidateRef);
    expect(body.registeredCandidateRef, '返回不可变登记映射引用(I1)').toBeTruthy();
    // 登记映射与 operation 同事务落库,并绑定原来源会话/代次(data-model §10)
    const registered = Database.db
      .prepare(
        `SELECT source_session_id AS sourceSessionId, source_generation AS sourceGeneration,
                candidate_ref AS candidateRef, preview_revision AS previewRevision, target_media_id AS targetMediaId
         FROM vod_registered_candidate WHERE household_id = ? AND registered_candidate_ref = ?`,
      )
      .get(rig.householdId, body.registeredCandidateRef) as
      | { sourceSessionId: string; sourceGeneration: number; candidateRef: string; previewRevision: number; targetMediaId: string }
      | undefined;
    expect(registered, '登记映射应落库(vod_registered_candidate)').toBeDefined();
    expect(registered!.sourceSessionId, '登记绑定原来源会话(I1/§10)').toBe(source.sessionId);
    expect(registered!.sourceGeneration).toBe(source.generation);
    expect(registered!.candidateRef).toBe(candidateRef);
    expect(registered!.targetMediaId).toBe(body.mediaId);
    // 丢响应后同 key 原样重试:200 同引用(T024 D1 同面)
    const replay = await request(rig.app.getHttpServer())
      .post(MATERIALIZE_URL)
      .set('Cookie', rig.cookieA)
      .send({ candidateRef, previewRevision: 1, operationKey });
    expect(replay.status, '同成功 key 重放 200').toBe(200);
    expect((replay.body as MaterializedLike).replayed).toBe(true);
    expect((replay.body as MaterializedLike).registeredCandidateRef).toBe(body.registeredCandidateRef);
  });

  it('D2 [计划内红·待 T072] registeredCandidateRef 意图接受:switch intent 201;previewRevision 失配 409 VOD_DETAIL_CHANGED', async () => {
    const rig = await startSwitchRig('hmp-t067-d2-');
    const source = await resolveSourceSession(rig);
    const candidateRef = `vod-candidate-t067-${randomUUID()}`;
    registerSeamCandidate({
      rig,
      candidateRef,
      provenance: { sourceSessionId: source.sessionId, sourceGeneration: source.generation },
    });
    const materialized = await request(rig.app.getHttpServer())
      .post(MATERIALIZE_URL)
      .set('Cookie', rig.cookieA)
      .send({ candidateRef, previewRevision: 1, operationKey: randomUUID() });
    expect(materialized.status, '夹具前提:候选分支物化 201(T031 已装配)').toBe(201);
    const body = materialized.body as MaterializedLike;
    // intent 只接受已登记目标的候选映射(I1):registeredCandidateRef + previewRevision 匹配 → 201
    const intent = await postSwitchIntentOk(rig, {
      source,
      targetCandidateRef: body.registeredCandidateRef!,
      previewRevision: 1,
      positionMode: 'beginning',
    });
    expect(intent.status).toBe('pending');
    expect(intent.targetMediaId).toBe(body.mediaId);
    // previewRevision 失配 → 409 VOD_DETAIL_CHANGED(修订改变拒绝)
    const staleRevision = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: body.registeredCandidateRef!,
      previewRevision: 2,
      positionMode: 'beginning',
      confirmedAmbiguous: false,
      expectedSlotRevision: 1,
      operationKey: randomUUID(),
    });
    expect(
      staleRevision.status,
      redLabel('T072', '409 VOD_DETAIL_CHANGED(previewRevision 失配)', `${staleRevision.status} ${JSON.stringify(staleRevision.body).slice(0, 160)}`),
    ).toBe(409);
    expect(staleRevision.body.code, 'previewRevision 失配稳定码(T072 实参修正:同 C5 lead 修法)').toBe('VOD_DETAIL_CHANGED');
  });
});

/* ------------------------------------------------------------------ */
/* E recover_switch(api.md §5+data-model §7:媒体故障 60s 分支;T072)     */
/* ------------------------------------------------------------------ */

/** recover 链共享:真实播放 → 媒体故障终态 → 登记桥物化目标(返回游标与登记引用) */
async function chainRecoverableFailedSource(
  rig: SwitchRig,
  options: { readonly withinWindow: boolean } = { withinWindow: true },
): Promise<{ source: SourceSession; cursor: AcceptedCursor; materialized: MaterializedLike }> {
  const source = await resolveSourceSession(rig);
  const cursor = await acceptProgress(rig, source, 1, 300, 'started');
  // 工厂事实(DB 直改注明):媒体/格式上游故障终态(可恢复素材;PLAYBACK_FORMAT_UNSUPPORTED)
  flipSessionToMediaFailure(source.sessionId, 'PLAYBACK_FORMAT_UNSUPPORTED');
  if (!options.withinWindow) {
    shiftSessionFailureBeyondRecoverWindow(source.sessionId);
  }
  const candidateRef = `vod-candidate-t067-${randomUUID()}`;
  registerSeamCandidate({
    rig,
    candidateRef,
    provenance: { sourceSessionId: source.sessionId, sourceGeneration: source.generation },
  });
  const res = await request(rig.app.getHttpServer())
    .post(MATERIALIZE_URL)
    .set('Cookie', rig.cookieA)
    .send({ candidateRef, previewRevision: 1, operationKey: randomUUID() });
  expect(res.status, '夹具错误:登记桥候选物化 201(T031 已装配)').toBe(201);
  return { source, cursor, materialized: res.body as MaterializedLike };
}

describe('T067 · E recover_switch(api.md §5 recover 分支+data-model §7 60s/权限失配不可恢复;T072)', () => {
  it('E1 [计划内红·待 T072] 媒体故障 failed 源 60s 内 recover_switch:创建 201(carry+checkpoint=故障前接受游标)→ 消费 201(failed 即终态,免 stop)', async () => {
    const rig = await startSwitchRig('hmp-t067-e1-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const { source, cursor, materialized } = await chainRecoverableFailedSource(rig);
    expect(sessionRowOf(source.sessionId).state, '夹具前提:来源已媒体故障终态 failed').toBe('failed');
    const intent = await postSwitchIntentOk(rig, {
      action: 'recover_switch',
      source,
      targetCandidateRef: materialized.registeredCandidateRef!,
      previewRevision: 1,
      positionMode: 'carry',
      sourceCheckpoint: { expectedGeneration: cursor.generation, sampleSeq: cursor.sampleSeq },
    });
    expect(intent.action, 'recover_switch 分支回执 action').toBe('recover_switch');
    // 库内:action=recover_switch 由创建载荷 action 决定;此处经 resolve 消费验证 failed 即终态(免 stop)
    const res = await postResolve(rig.app, rig.cookieA, {
      mediaId: materialized.mediaId,
      transitionIntentId: intent.id,
    });
    expect(
      res.status,
      redLabel('T072+T073', '201(recover_switch 消费;failed 为可接受终态)', `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`),
    ).toBe(201);
    const successorId = String(res.headers['location']).split('/').pop();
    expect((res.body as Record<string, unknown>)['startBasis']).toBe('transition_carry');
    await waitUntilState(rig.app, rig.cookieA, successorId!, 'ready');
    expect(
      inputBindingOf(rig.householdId, successorId!)?.frozenStartSeconds,
      redLabel('T073', 'frozen_start_seconds=300(恢复冻结故障前接受游标)', `实际 ${String(inputBindingOf(rig.householdId, successorId!)?.frozenStartSeconds)}`),
    ).toBe(300);
    expect(intentRowOf(rig.householdId, intent.id)?.status).toBe('consumed');
  });

  it('E2 [计划内红·待 T072] 超 60s 恢复窗口:同链第二来源回拨终态时刻后 recover → 4xx 拒绝,零 intent 残留', async () => {
    const rig = await startSwitchRig('hmp-t067-e2-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    // 窗口内第一来源:recover 创建成功(计划内红点,兼证窗口内可用)
    const first = await chainRecoverableFailedSource(rig, { withinWindow: true });
    const okIntent = await postSwitchIntentOk(rig, {
      action: 'recover_switch',
      source: first.source,
      targetCandidateRef: first.materialized.registeredCandidateRef!,
      previewRevision: 1,
      positionMode: 'carry',
      sourceCheckpoint: {
        expectedGeneration: first.cursor.generation,
        sampleSeq: first.cursor.sampleSeq,
      },
    });
    expect(okIntent.action).toBe('recover_switch');
    expect(okIntent.status).toBe('pending');
    // 第二来源:终态时刻回拨 61s → 窗口关闭
    const expired = await chainRecoverableFailedSource(rig, { withinWindow: false });
    const before = intentCountOf(rig.householdId);
    const res = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: expired.source.sessionId,
      expectedGeneration: expired.source.generation,
      action: 'recover_switch',
      targetCandidateRef: expired.materialized.registeredCandidateRef!,
      previewRevision: 1,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: {
        expectedGeneration: expired.cursor.generation,
        sampleSeq: expired.cursor.sampleSeq,
      },
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    // 超时走普通明确新播放,无旧 carry(data-model §7);具体码随 T072 装配收敛(404 同形预期)
    expect4xxProblem(
      res,
      redLabel('T072', '4xx(60s 恢复窗口关闭,不再允许 recover_switch)', `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`),
    );
    expect(intentCountOf(rig.householdId), '窗口外拒绝不落新 intent').toBe(before);
  });

  it('E3 [计划内红·待 T072] 禁源终态不可恢复:窗口内第一来源创建成功后禁源,第二来源 recover → 4xx 拒绝,零 intent 残留', async () => {
    const rig = await startSwitchRig('hmp-t067-e3-');
    registerPersonalPlaybackFactsPort({ trustedDurationSeconds: () => TRUSTED_DURATION_SECONDS });
    const first = await chainRecoverableFailedSource(rig, { withinWindow: true });
    const okIntent = await postSwitchIntentOk(rig, {
      action: 'recover_switch',
      source: first.source,
      targetCandidateRef: first.materialized.registeredCandidateRef!,
      previewRevision: 1,
      positionMode: 'carry',
      sourceCheckpoint: {
        expectedGeneration: first.cursor.generation,
        sampleSeq: first.cursor.sampleSeq,
      },
    });
    expect(okIntent.action).toBe('recover_switch');
    expect(okIntent.status).toBe('pending');
    // 第二条可恢复链先建(夹具前提:源A 仍启用时完成 resolve/物化/故障终态全套)
    const second = await chainRecoverableFailedSource(rig, { withinWindow: true });
    // DB 直改注明:等价「来源被管理员停用」(禁源终态不得借恢复)——禁第二条链自身来源,
    // 契约语义=恢复中会话的自身来源被禁 → 授权族 404 优先,不可借恢复通道
    disableSource(rig.sourceRowIdA);
    const before = intentCountOf(rig.householdId);
    const res = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: second.source.sessionId,
      expectedGeneration: second.source.generation,
      action: 'recover_switch',
      targetCandidateRef: second.materialized.registeredCandidateRef!,
      previewRevision: 1,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: {
        expectedGeneration: second.cursor.generation,
        sampleSeq: second.cursor.sampleSeq,
      },
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expect4xxProblem(
      res,
      redLabel('T072', '4xx(禁源终态不可恢复;权限失配优先于专用错误)', `${res.status} ${JSON.stringify(res.body).slice(0, 160)}`),
    );
    expect(intentCountOf(rig.householdId), '禁源拒绝不落新 intent').toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* F 内容失权清理与旧 context(审查补充;T062 面既有绿,switch 行种子)     */
/* ------------------------------------------------------------------ */

describe('T067 · F 内容失权清理与旧 context(I5 cleanup;T062 面既有绿,switch intent 行种子工厂事实)', () => {
  it('F1 [绿·T062 面] consumed 后禁源:GET 失权拒绝完整结果;cleanup 最小清理(仅 outcome)+重试幂等+持久标记阻断 renew', async () => {
    const rig = await startSwitchRig('hmp-t067-f1-');
    const source = await resolveSourceSession(rig);
    await stopSourceSession(rig, source);
    // 工厂事实:consumed switch intent + 后继会话 + slot(等价 T072 消费后的库内归属)
    const successorId = seedSuccessorSession({ rig, mediaId: rig.serialA.ep01MediaId });
    const intentId = seedSwitchIntentWithSlot({
      rig,
      fromSessionId: source.sessionId,
      fromGeneration: source.generation,
      status: 'consumed',
      successorSessionId: successorId,
      carry: { positionSeconds: 240, durationSeconds: TRUSTED_DURATION_SECONDS, ledgerSeq: 2 },
      checkpoint: { generation: source.generation, sampleSeq: 2 },
    });
    disableSource(rig.sourceRowIdA);
    // 失权时不返回完整结果 → 客户端直接走 cleanup(api §5 GET 行;§7 I5)
    const got = await getIntent(rig.app, rig.cookieA, intentId);
    expect4xxProblem(got, '失权 GET 不返回完整 IntentReply(不借 GET 发票)');
    // 最小清理:200 {outcome} 且不返回目标 ID/元数据/位置/票据(I5)
    const cleanup = await postCleanup(rig.app, rig.cookieA, intentId);
    expect(cleanup.status, '200 TransitionCleanupReply(T062 已装配)').toBe(200);
    expect(Object.keys(cleanup.body).sort(), 'cleanup 仅最小结果(I5)').toEqual([...CLEANUP_REPLY_KEYS]);
    const outcome = (cleanup.body as { outcome: string }).outcome;
    expect(['cleanup_pending', 'stopped'], `consumed 分支 outcome ∈ cleanup_pending|stopped(实际 ${outcome})`).toContain(outcome);
    expect(JSON.stringify(cleanup.body), 'cleanup 响应不得泄漏目标 mediaId').not.toContain(rig.serialA.ep01MediaId);
    // 持久 cleanup 标记:唯一已关联后继写 cleanup_requested(data-model §10)
    const marker = Database.db
      .prepare('SELECT cleanup_requested AS requested FROM playback_session WHERE id = ?')
      .get(successorId) as { requested: number } | undefined;
    expect(marker?.requested, '后继会话应写持久 cleanup_requested').toBe(1);
    // 标记先阻止新票/资产:renew 被拒(I5;码未钉 → 4xx 封套)
    const renew = await postRenew(rig.app, rig.cookieA, successorId, { expectedGeneration: 1 });
    expect4xxProblem(renew, 'cleanup 标记应阻断后继 renew/新资产');
    // 响应丢失重试同入口:仍 200 最小形态(失败/重启扫描重试同语义)
    const retry = await postCleanup(rig.app, rig.cookieA, intentId);
    expect(retry.status, '200 重试幂等(T062 已装配)').toBe(200);
    expect(Object.keys(retry.body).sort()).toEqual([...CLEANUP_REPLY_KEYS]);
    expect(['cleanup_pending', 'stopped']).toContain((retry.body as { outcome: string }).outcome);
  });

  it('F2 [绿·旧 context 拒绝] pending switch intent:跨设备/随机 id/旧 context(A→B→A)GET 与 cleanup 均 404 同形', async () => {
    const rig = await startSwitchRig('hmp-t067-f2-');
    const source = await resolveSourceSession(rig);
    const intentId = seedSwitchIntentWithSlot({
      rig,
      fromSessionId: source.sessionId,
      fromGeneration: source.generation,
      status: 'pending',
      successorSessionId: null,
      carry: { positionSeconds: 240, durationSeconds: TRUSTED_DURATION_SECONDS, ledgerSeq: 2 },
      checkpoint: { generation: source.generation, sampleSeq: 2 },
    });
    const crossDevice = await getIntent(rig.app, rig.cookieB, intentId);
    const randomId = await getIntent(rig.app, rig.cookieA, randomUUID());
    expect(crossDevice.status, '跨设备 GET switch intent 应 404').toBe(404);
    expect(randomId.status, '随机 id 应 404').toBe(404);
    expectSameShape(crossDevice, randomId, '跨设备与随机 id 同形(不可判别存在性)');
    // 旧 context:DB 直改注明:设备A 身份上下文推进(等价 A→B→A)→ 原 context 失配 404
    bumpDeviceContextVersion(rig.deviceSessionAId);
    const oldContext = await getIntent(rig.app, rig.cookieA, intentId);
    expect(oldContext.status, '旧 context GET 应 404(I5:context 变更后禁止调用)').toBe(404);
    const oldContextCleanup = await postCleanup(rig.app, rig.cookieA, intentId);
    expect(oldContextCleanup.status, '旧 context cleanup 应 404(I5)').toBe(404);
    expectSameShape(crossDevice, oldContextCleanup, '旧 context cleanup 与跨设备 GET 同形');
  });
});

/* ------------------------------------------------------------------ */
/* G 授权负向(api §0/§5 同形口径;已装配面精确绿+候选/测速窗口封套)       */
/* ------------------------------------------------------------------ */

describe('T067 · G 授权负向(api §0 同形口径;G 组窗口内即绿)', () => {
  it('G1 [绿] 游客/伪造 token:已装配面(switch intent/resolve)精确 401 SESSION_INVALID;候选/测速窗口封套(装配后 401)', async () => {
    const rig = await startSwitchRig('hmp-t067-g1-');
    const source = await resolveSourceSession(rig);
    // 已装配面:游客/伪造 token 精确 401(守卫链先于 switch 分支拒绝)
    const guestIntent = await postIntent(rig.app, '', {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: 'vod-candidate-fixture',
      previewRevision: 1,
      positionMode: 'beginning',
      confirmedAmbiguous: false,
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectProblem(guestIntent, 401, ProblemCode.SESSION_INVALID);
    const forgedIntent = await postIntent(rig.app, `${SESSION_COOKIE}=forged-token-not-in-db`, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: 'vod-candidate-fixture',
      previewRevision: 1,
      positionMode: 'beginning',
      confirmedAmbiguous: false,
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectProblem(forgedIntent, 401, ProblemCode.SESSION_INVALID);
    const guestResolve = await postResolve(rig.app, '', { mediaId: rig.serialA.ep01MediaId });
    expect(guestResolve.status).toBe(401);
    expectProblemContentType(guestResolve);
    expect(guestResolve.body.code).toBe(ProblemCode.SESSION_INVALID);
    // 候选/测速窗口封套:窗口内 Nest 404 形状;T070/T071 装配后自动收紧 401
    const guestCandidates = await getSwitchCandidates(rig.app, '', {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
    });
    expectWiredOrRouteWindow(guestCandidates, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客候选清单');
    const guestProbes = await postSwitchProbes(rig.app, '', {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      candidateRefs: ['vod-candidate-fixture'],
    });
    expectWiredOrRouteWindow(guestProbes, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客测速');
  });

  it('G2 [绿] body 伪造 profileId/householdId → 400 VALIDATION_FAILED(身份只从服务端推导);拒绝路径零 intent 残留', async () => {
    const rig = await startSwitchRig('hmp-t067-g2-');
    const source = await resolveSourceSession(rig);
    const forgedProfile = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'switch',
      targetCandidateRef: 'vod-candidate-fixture',
      previewRevision: 1,
      positionMode: 'beginning',
      confirmedAmbiguous: false,
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
      profileId: rig.profileAId,
    });
    expectProblem(forgedProfile, 400, ProblemCode.VALIDATION_FAILED);
    const forgedHousehold = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'recover_switch',
      targetCandidateRef: 'vod-candidate-fixture',
      previewRevision: 1,
      positionMode: 'beginning',
      confirmedAmbiguous: false,
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
      householdId: rig.householdId,
    });
    expectProblem(forgedHousehold, 400, ProblemCode.VALIDATION_FAILED);
    // 测速请求伪造身份字段:窗口封套(装配后 400 严格入参拒绝)
    const forgedProbes = await postSwitchProbes(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      candidateRefs: ['vod-candidate-fixture'],
      profileId: rig.profileAId,
    });
    expectWiredOrRouteWindow(forgedProbes, { status: 400, code: ProblemCode.VALIDATION_FAILED }, '伪造 profileId 测速');
    // 拒绝路径零副作用
    expect(intentCountOf(rig.householdId), '伪造身份拒绝不落 intent').toBe(0);
  });
});
