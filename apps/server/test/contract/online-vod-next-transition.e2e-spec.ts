import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ProblemCode, SESSION_COOKIE } from '@hmp/shared';
import { AppModule } from '../../src/app.module';
import { Database } from '@platform/database/database';
import { getDb } from '@platform/database/drizzle';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import {
  mediaSource,
  playbackFinishReceipt,
  playbackNextPlan,
  playbackSession,
  playbackTransitionIntent,
  playbackTransitionSlot,
  profileViewingHistory,
  vodSourceConfig,
} from '@platform/database/schema';
import {
  UNIT_OF_WORK,
  createUnitOfWork,
  type TxStoreFactory,
  type TxStoresRegistry,
} from '@platform/database/unit-of-work';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createProfileTxReaders } from '@contexts/profile/infrastructure/transaction-participants';
import { createPolicyTxReaders } from '@contexts/policy/infrastructure/transaction-participants';
import { createSourcesTxParticipants } from '@contexts/sources/infrastructure/transaction-participants';
import { createMediaCatalogTxParticipants } from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createOnlineVodTxParticipants } from '@contexts/online-vod/infrastructure/transaction-participants';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
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
import {
  MANAGEMENT_MAIN_PIN,
  MANAGEMENT_OWNER_PASSWORD,
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
import {
  createFixtureStepFailurePlanner,
  type FixtureStepFailurePlan,
  type FixtureStepFailurePlanner,
} from '../fixtures/online-vod/fixture-world';

/**
 * T052(010-online-vod · US3,测试先行):next/manual_next 过渡全链契约 e2e ——
 * next-plans 计划快照、intent 创建/查询/取消、resolve 消费、单后继槽 CAS、
 * 丢响应重放、每步事务故障、目标独立策略及偏好消费时重验;审查补充:nextPlan
 * 目标/序列/历史变更、过期、消费后禁源且响应丢失的最小 cleanup 及重试。
 * 「只写测试不实现」,依赖 T046 已落地;T054–T062 为被测实现目标。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/api.md §5(transition-intents 表+IntentRequest
 *   严格 oneOf:next/manual_next 带 nextPlanRef、禁 historyChoiceConfirmed/客户端目标 ID,
 *   positionMode 表达用户选择;switch/recover_switch 带 targetCandidateRef —— 本文件只测
 *   next/manual_next 面,switch 分支留 US4 测试)+ §7 I3(POST /playback/next-plans 请求/
 *   响应、TTL 60s 固定、每设备 20 活计划按最早过期淘汰、创建/消费均验证计划快照,
 *   目标/序列/历史变化 409 NEXT_PLAN_CHANGED、超期 410 NEXT_PLAN_EXPIRED、无确定下一集
 *   404 VOD_NEXT_UNAVAILABLE、不建播放/epoch/历史、不占 slot)+ §5 语义段(意图 TTL 60s
 *   固定、pending 显式替换 expectedSlotRevision、consumed 后新 key 409 带原后继、取消
 *   输家返回 successor、slot 消费与新 session/epoch 原子、重放 200 同后继、next 必须有
 *   finish receipt、manual_next 先停止再消费)+ §7 I5(cleanup 仅当前设备/Profile/context
 *   可用;不要求策略放行;不返回目标元数据;cleanup_pending/stopped outcome)+ §6 问题码;
 * - docs/specs/010-online-vod/contracts/playback-state.md §44–45/§50/§58(next 资格=
 *   已结束来源+autoNextEligible+偏好开启;manual_next 不要求完成/偏好;消费事务顺序:
 *   身份/偏好→目标→intent 未过期/slot 仍保留→来源终态→新 session+epoch/ledger→
 *   consumed+后继,任何异常不留新 session 或消耗槽);
 * - docs/specs/010-online-vod/data-model.md §7(slot open/reserved/consumed、intent 五态、
 *   唯一(household,from_session,generation)、pending 替换/取消 revision CAS、consumed 槽
 *   永久不能再建第二后继)+ §10(playback_next_plan 不可变 60s/引用保护/每设备 20 上限
 *   只计未引用活计划;session/input cleanup_requested 持久标记);
 * - docs/specs/010-online-vod/contracts/internal-ports.md §2/§5(TransitionConsumeWorkSet
 *   步骤顺序与工作集所有权;F 组故障注入点命名依据);
 * - docs/specs/010-online-vod/tasks.md T052 原文与 T054–T056/T059–T062(被测实现目标,
 *   本文件先钉契约目标面,计划内红失败不跳过);
 * - 行为基线(既有绿,010 增量不得回归):test/contract/online-vod-progress-resume
 *   .e2e-spec.ts(T036 rig 惯例/物化链/双设备/受控上游)、online-vod-materialization
 *   .e2e-spec.ts(T024 Proxy 包装 txStores 注入手法)、playback-policy-resource-rejection
 *   .e2e-spec.ts(策略拒绝 404 MEDIA_NOT_FOUND 同形)。
 *
 * 装配方式(沿用 010 contract rig 惯例,不改共享 rig/helpers/fixtures/源码):
 * - startFreshApp(os.tmpdir 随机 DATA_DIR + 全量权威迁移,含 0007_online_vod)+
 *   initialize/login/selectMainAndUnlockSettings 身份 seed + Supertest 真实 HTTP;
 * - 受控上游 mock 沿用 T036 rig 手法(createControlledMediaServer 127.0.0.1 随机端口 +
 *   fixture-upstream 路由表 findUpstreamRoute 派发 Apple CMS JSON;LAN_ALLOWED_TARGETS=
 *   '127.0.0.1';全程不发真实外网请求)。素材 = 三集连续剧(stardust EP1→EP2→EP3 同线
 *   明确 N+1,A 组 happy 面用 EP1→EP2)+ 缺集世界(mistfiles 主线 01/02/04 缺 03,
 *   VOD_NEXT_UNAVAILABLE 素材);来源/物化走真实 T031 装配链;
 * - 双设备/双 Profile:两次 login 即两个 DeviceSession,第二 Profile 经 Settings API
 *   创建(PUT settings policy/lists 表达「目标独立策略」的受限目标);
 * - F 组故障注入沿用 T024 已验证手法:本地复刻 boot 装配并以 overrideProvider
 *   (UNIT_OF_WORK) 覆盖 txStores 对应键(仅 override,不改 app.module.ts),被覆盖键的
 *   TxStore 以 Proxy 包装 —— 参与者方法第 N 次被工作集触达时经 planner.enterStep 抛
 *   FixtureStepFailureError(位于 UnitOfWork.run try 段内 → 整体回滚、连接恢复)。
 *   注入粒度与 T024 同:当前可注入 seam 为「该步骤所属上下文参与者的第 N 次触达点」
 *   (事务内、早于具名步骤的精确执行点);若实现合并触达致 occurrence 未达,该用例以
 *   显式失败暴露粒度协商点,不静默通过;
 * - DB 直改仅用于无 HTTP 语义的工厂事实,逐处注明:计划/意图/槽行种子(等价 T059+
 *   T060 创建后的库内形态,H 组授权同形/F 组引用保护素材)、目标历史行种子(等价
 *   「他设备已看目标」形态)、finish receipt 种子(等价 T058 finish 已提交且
 *   autoNextEligible 形态,T051/T058 未装配窗口内表达「已完成来源」)、计划/意图过期
 *   (成对置过去,保持 CHECK expires_at>created_at)、序列/详情修订推进、禁源、
 *   旧 context 推进。不改任何共享文件;无 git 操作。
 *
 * ───────────────────────── 计划内红清单(失败不跳过)─────────────────────────
 * T052 为测试先行:next-plans/transition-intents/cleanup 端点尚未装配(T054–T062 待
 * 实现),resolve 过渡分支未接线(T061)。当前失败形态:
 *  - 未装配端点(A/B/D/E/F/G 组)= 404 路由级(Nest 缺省 NOT_FOUND + detail Cannot …);
 *  - resolve 消费(C 组)= resolve 路由已装配但 strict schema 拒绝 transitionIntentId
 *    未知字段 → 400 VALIDATION_FAILED(转绿后为各用例钉住的契约形态)。红→绿映射:
 *
 * | 用例组 | 用例                                                         | 当前失败形态            | 转绿任务       |
 * | ------ | ------------------------------------------------------------ | ----------------------- | -------------- |
 * | A1–A7  | next-plans 200 快照/缺集 404/过期 410/目标·序列·历史变化 409/20 上限淘汰+引用保护/目标独立策略 404 | 404 路由未装配 | T055+T059+T060 |
 * | B1–B7  | intent 创建/查询、manual_next 免资格、next 无 receipt 拒绝、同 key 重放/异摘要、显式替换 superseded、单槽冲突、historyChoiceRequired 形态 | 404 路由未装配 | T059+T060 |
 * | C1–C7  | resolve 消费 201/startBasis 映射/epoch 分配/重放 200/consumed 新 key 409/消费重验目标·历史/先停止再消费 | 400 严格入参拒绝(过渡分支未接线) | T059–T061 |
 * | D1–D5  | cancel 赢/重复取消/superseded/expired/取消输给消费 already_consumed | 404 路由未装配          | T059+T060      |
 * | E1–E2  | autoplayNext 消费时重验 + manual_next 免偏好                  | 404 路由未装配(偏好 PATCH 同,T056) | T056+T059–T061 |
 * | F·×5   | 消费事务逐步注入失败 → 500+零残留+intent 保持 pending+重试 201 | 404 路由未装配          | T059–T061      |
 * | G1–G2  | 消费后禁源最小 cleanup(不泄漏目标/重试幂等/标记阻断 renew)/pending 禁源 cleanup | 404 路由未装配          | T062           |
 *
 * 绿基线(窗口内即绿,装配后自动收紧为精确码):
 * H1–H3(授权负向封套/同形 —— 窗口内为 Nest 缺省 404 形状;已装配 resolve 的游客
 * 401 为精确绿锚点)。
 *
 * 预期计数:红 35(A 7 + B 7 + C 7 + D 5 + E 2 + F 5 + G 2)/ 绿 3(H 组);两次运行一致。
 */

/* ------------------------------------------------------------------ */
/* 常量与契约形状                                                       */
/* ------------------------------------------------------------------ */

const NEXT_PLANS_URL = '/api/playback/next-plans';
const INTENTS_URL = '/api/playback/transition-intents';
const RESOLVE_URL = '/api/playback/resolve';

/** NextPlanReply 契约 9 键(api.md §7 I3 / openapi NextPlanReply:additionalProperties:false) */
const NEXT_PLAN_REPLY_KEYS = [
  'detailRevision',
  'expiresAt',
  'history',
  'historyChoiceRequired',
  'historyRevision',
  'label',
  'nextPlanRef',
  'sequenceRevision',
  'targetMediaId',
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

/** TransitionCancelReply 3 键(api.md §5 / openapi) */
const CANCEL_REPLY_KEYS = ['outcome', 'slotRevision', 'successorSessionId'] as const;

/** TransitionCleanupReply 最小 1 键(I5「不返回目标 ID、元数据、位置或票据」) */
const CLEANUP_REPLY_KEYS = ['outcome'] as const;

/** 计划内红统一标注(消息内钉转绿任务号 + 目标契约形态 + 当前失败原因) */
function redLabel(tasks: string, target: string, current: string): string {
  return `计划内红(待 ${tasks} 转绿):${current} —— ${tasks} 落地后应 ${target}`;
}

/** 稳定错误断言:status + RFC 9457 problem+json + 稳定码 */
function expectProblem(res: request.Response, status: number, code: string): void {
  expect(res.status, redLabel('T059–T062', `${status} ${code}(契约稳定码)`, `${res.status} ${JSON.stringify(res.body).slice(0, 220)}`)).toBe(
    status,
  );
  expectProblemContentType(res);
  expect(res.body.code).toBe(code);
}

/**
 * 授权封套断言(T024 E 组同手法,双态可断言):
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

/** 契约未钉码的 4xx 拒绝面(失权 GET/标记后 renew):4xx + problem+json + no-store */
function expect4xxProblem(res: request.Response, label: string): void {
  expect(res.status, `${label}:应落在 4xx 客户错误带`).toBeGreaterThanOrEqual(400);
  expect(res.status, `${label}:不得以 5xx 泄露内部失败`).toBeLessThan(500);
  expectProblemContentType(res);
  expect(res.headers['cache-control'], `${label}:错误响应须 no-store(api §0)`).toBe('no-store');
}

/** 同形断言(窗口安全):两响应 status+code 一致即不可区分(404 窗口 detail 含路径不比对) */
function expectSameShape(a: request.Response, b: request.Response, label: string): void {
  expect(a.status, `${label}:status 应同形`).toBe(b.status);
  expect(a.body.code, `${label}:稳定码应同形(不可借错误判别存在性)`).toBe(b.body.code);
}

interface NextPlanSnapshot {
  readonly nextPlanRef: string;
  readonly targetMediaId: string;
  readonly label: string;
  readonly sequenceRevision: number;
  readonly detailRevision: number;
  readonly historyRevision: number;
  readonly historyChoiceRequired: boolean;
  readonly history: Record<string, unknown> | null;
  readonly expiresAt: string;
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

/* ------------------------------------------------------------------ */
/* 上游 mock(010 T036 rig 手法:受控 CMS 端口 + fixture 路由表派发)       */
/* ------------------------------------------------------------------ */

const activeMediaServers: ControlledMediaServer[] = [];

/** 构建单个健康受控源(三集连续剧[N+1]:EP1→EP2→EP3;EP3 为「无确定下一集」锚点) */
function buildNextTransitionSource(port: number): FixtureUpstreamSource {
  const origin = `http://127.0.0.1:${port}`;
  return createFixtureVodSource({
    sourceId: 'fixture-vod-source-t052',
    displayName: '夹具在线片源(T052)',
    behavior: 'healthy',
    address: { host: '127.0.0.1', port },
    titleWorlds: [createThreeEpisodeSerialWorld(origin)],
  });
}

/* ------------------------------------------------------------------ */
/* rig:受控上游 + 全量迁移 app + 双设备身份 + HTTP 物化在线剧集           */
/* ------------------------------------------------------------------ */

interface NextTransitionRig {
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
  /** 已物化三集连续剧(T031 真实装配链产物) */
  readonly serial: {
    readonly parentMediaId: string;
    readonly ep01MediaId: string;
    readonly ep02MediaId: string;
    /** EP03(末集;无确定下一集锚点) */
    readonly ep03MediaId: string;
    /** EP01 逻辑时长(3×120s;fixture 清单聚合) */
    readonly ep01DurationSeconds: number;
  };
  /** kind=vod media_source 行 id(禁源 DB 直改用) */
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

/** kind=vod 来源行(media_source + vod_source_config 一源一行;对齐 T036 rig 口径) */
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

async function startNextTransitionRig(
  prefix: string,
  options: { unitOfWorkFactory?: () => unknown } = {},
): Promise<NextTransitionRig> {
  const source = buildNextTransitionSource(0);
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
            // 挂起不回包(与 T036 rig 同形态;本文件路由全为健康应答,防御分支)
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

  let app: INestApplication;
  if (options.unitOfWorkFactory) {
    // F 组故障注入:本地 boot + UNIT_OF_WORK 覆盖(T024 手法;不改共享 rig)
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}uow-`));
    setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db`, LAN_ALLOWED_TARGETS: '127.0.0.1' }));
    Database.close();
    Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
    const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
    const names = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const insert = Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
    for (const name of names) {
      const upSqlPath = path.join(migrationsDir, name, 'up.sql');
      expect(fs.existsSync(upSqlPath), `未找到迁移 DDL ${upSqlPath}(须以 apps/server 为工作目录运行)`).toBe(true);
      Database.db.exec(fs.readFileSync(upSqlPath, 'utf8'));
      insert.run(name, new Date().toISOString());
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(UNIT_OF_WORK)
      // Nest 12 覆盖 API:useFactory 收 { factory }(OverrideByFactoryOptions)
      .useFactory({ factory: options.unitOfWorkFactory })
      .compile();
    app = moduleRef.createNestApplication({ logger: ['warn', 'error'] });
    app.setGlobalPrefix('api');
    await app.init();
    localUowRigs.push({ app, dataDir });
  } else {
    const fresh = await startFreshApp({ prefix, env: { LAN_ALLOWED_TARGETS: '127.0.0.1' } });
    app = fresh.app;
  }

  expect((await initialize(app)).status).toBe(201);
  const loggedIn = await login(app, 'admin', 'password-123');
  expect(loggedIn.status).toBe(200);
  const cookieA = cookiePairOf(loggedIn);
  const profileAId = await selectMainAndUnlockSettings(app, cookieA);

  // 第二设备:同账号新登录(新 DeviceSession),选同一主档案(T036 rig 同序)
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
  const ep03 = await materializeEpisodeAt(app, cookieA, 'stardust', 0, 2);

  return {
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
      ep03MediaId: ep03.mediaId,
      ep01DurationSeconds: 360,
    },
    sourceRowId,
  };
}

/* ------------------------------------------------------------------ */
/* F 组故障注入 rig 的本地清理(仅 override boot 路径使用)                */
/* ------------------------------------------------------------------ */

interface LocalUowRig {
  app: INestApplication;
  dataDir: string;
}

const localUowRigs: LocalUowRig[] = [];

async function cleanupLocalUowRigs(): Promise<void> {
  while (localUowRigs.length > 0) {
    const rig = localUowRigs.pop();
    if (rig === undefined) {
      break;
    }
    await rig.app.close();
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
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
  readonly nextPlanId: string | null;
  readonly planSequenceRevision: number | null;
  readonly planDetailRevision: number | null;
  readonly planHistoryRevision: number | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

function intentRowOf(householdId: string, intentId: string): IntentRow | undefined {
  return Database.db
    .prepare(
      `SELECT status, slot_revision AS slotRevision, successor_id AS successorId,
              next_plan_id AS nextPlanId, plan_sequence_revision AS planSequenceRevision,
              plan_detail_revision AS planDetailRevision, plan_history_revision AS planHistoryRevision,
              expires_at AS expiresAt, created_at AS createdAt
       FROM playback_transition_intent WHERE household_id = ? AND id = ?`,
    )
    .get(householdId, intentId) as IntentRow | undefined;
}

function nextPlanIdByRef(householdId: string, ref: string): string | undefined {
  const row = Database.db
    .prepare('SELECT id FROM playback_next_plan WHERE household_id = ? AND ref = ?')
    .get(householdId, ref) as { id: string } | undefined;
  return row?.id;
}

function activeNextPlanCount(householdId: string, deviceSessionId: string): number {
  return scalarOf(
    'SELECT COUNT(*) AS n FROM playback_next_plan WHERE household_id = ? AND device_session_id = ?',
    householdId,
    deviceSessionId,
  );
}

function historyRowCount(householdId: string, mediaId: string): number {
  return scalarOf('SELECT COUNT(*) AS n FROM profile_viewing_history WHERE household_id = ? AND media_id = ?', householdId, mediaId);
}

/**
 * DB 直改:计划 TTL 自然到期后的等价存储事实(成对置过去,保持 CHECK expires_at >
 * created_at;T024 expireVodDetailSnapshots 同口径)。
 */
function expireNextPlans(householdId: string): void {
  Database.db
    .prepare(
      "UPDATE playback_next_plan SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:01:00.000Z' WHERE household_id = ?",
    )
    .run(householdId);
}

/** DB 直改:目标详情修订推进(等价「后台已发布新详情」,data-model §3) */
function bumpSerialDetailRevision(householdId: string, parentMediaId: string): void {
  const bumped = Database.db
    .prepare(
      'UPDATE vod_title SET current_detail_revision = current_detail_revision + 1 WHERE household_id = ? AND parent_media_id = ?',
    )
    .run(householdId, parentMediaId);
  expect(bumped.changes, '夹具错误:vod_title 行不存在(序列详情推进失败)').toBe(1);
}

/** DB 直改:导航序列修订推进(等价「同线成员/顺序变化发布新序列」,data-model §3) */
function bumpSerialSequenceRevision(householdId: string, parentMediaId: string): void {
  const bumped = Database.db
    .prepare(
      `UPDATE vod_episode_sequence SET sequence_revision = sequence_revision + 1
       WHERE household_id = ? AND title_id = (SELECT id FROM vod_title WHERE household_id = ? AND parent_media_id = ?)`,
    )
    .run(householdId, householdId, parentMediaId);
  expect(bumped.changes, '夹具错误:vod_episode_sequence 行不存在(序列修订推进失败)').toBeGreaterThan(0);
}

/** DB 直改:目标历史 revision 推进(等价「他设备再次写入目标历史」) */
function bumpTargetHistoryRevision(householdId: string, mediaId: string): void {
  Database.db
    .prepare('UPDATE profile_viewing_history SET revision = revision + 1 WHERE household_id = ? AND media_id = ?')
    .run(householdId, mediaId);
}

/** DB 直改:禁源(media_source.enabled=0;源启停无 HTTP 端点,playback-authorization 同口径) */
function disableSource(sourceRowId: string): void {
  Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(sourceRowId);
}

/** DB 直改:设备会话身份上下文推进(等价「A→B→A 身份变化」;旧 context 判定素材) */
function bumpDeviceContextVersion(deviceSessionId: string): void {
  Database.db
    .prepare('UPDATE device_session SET profile_context_version = profile_context_version + 1 WHERE id = ?')
    .run(deviceSessionId);
}

/** 种子:终态 writer 会话(历史行 FK 目标;等价「上次观看会话」,T036 rig 同款) */
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

/** 种子:目标未完成历史行(等价「他设备已看 EP02 未完」,T036 rig 同款字段) */
function seedUnfinishedTargetHistory(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly deviceSessionId: string;
  readonly mediaId: string;
  readonly positionSeconds: number;
  readonly durationSeconds: number;
}): void {
  const writerSessionId = seedEndedWriterSession({
    householdId: input.householdId,
    deviceSessionId: input.deviceSessionId,
    profileId: input.profileId,
    mediaId: input.mediaId,
  });
  getDb()
    .insert(profileViewingHistory)
    .values({
      householdId: input.householdId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      writerEpoch: 1,
      writerPlaybackSessionId: writerSessionId,
      lastSampleSeq: 1,
      contentRevision: mediaContentRevisionOf(input.mediaId),
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds,
      lastViewedAt: new Date().toISOString(),
      revision: 1,
      completed: 0,
    })
    .run();
}

/**
 * 种子:finish receipt(工厂事实;等价 T058「finish 已提交且 autoNextEligible=true」
 * 形态 —— T051/T058 未装配窗口内表达「自然完成来源」;字段满足 0007 CHECK/FK)。
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

/**
 * 种子:pending intent + reserved slot(工厂事实;等价 T059+T060「创建后的库内形态」,
 * 供 H 组授权同形/A 组引用保护在端点未装配窗口内钉住行级事实;全部列满足 0007 CHECK/FK)。
 */
function seedPendingIntentWithSlot(input: {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly fromSessionId: string;
  readonly fromGeneration: number;
  readonly targetMediaId: string;
  readonly nextPlanId?: string;
}): string {
  const intentId = randomUUID();
  const now = new Date();
  getDb().transaction((tx) => {
    // 插入次序:intent 先于 slot(slot.active_intent_id 复合 FK 指向 intent 行)
    tx.insert(playbackTransitionIntent)
      .values({
        id: intentId,
        householdId: input.householdId,
        fromSessionId: input.fromSessionId,
        fromGeneration: input.fromGeneration,
        deviceSessionId: input.deviceSessionId,
        profileId: input.profileId,
        profileContextVersion: deviceSessionProfileContextVersionOf(input.deviceSessionId),
        action: 'manual_next',
        targetMediaId: input.targetMediaId,
        targetContentRevision: mediaContentRevisionOf(input.targetMediaId),
        targetContinuityRevision: 1,
        targetLocatorRevision: 1,
        matchRevision: 1,
        matchConfidence: 'high',
        confirmedAmbiguous: 0,
        positionMode: 'beginning',
        operationKey: randomUUID(),
        requestDigest: `fixture-intent-${randomUUID()}`,
        slotRevision: 1,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        status: 'pending',
        successorId: null,
        nextPlanId: input.nextPlanId ?? null,
      })
      .run();
    tx.insert(playbackTransitionSlot)
      .values({
        householdId: input.householdId,
        fromSessionId: input.fromSessionId,
        fromGeneration: input.fromGeneration,
        slotRevision: 1,
        status: 'reserved',
        activeIntentId: intentId,
        successorSessionId: null,
      })
      .run();
  });
  return intentId;
}

/**
 * 种子:活计划行(工厂事实;等价 T055+T060「计划已创建」形态,A 组 20 上限/引用保护
 * 素材;ref 唯一供淘汰断言定位)。
 */
function seedActiveNextPlanRow(input: {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly fromSessionId: string;
  readonly targetMediaId: string;
  readonly ref: string;
  /** 越大越晚过期;淘汰按最早过期 */
  readonly expiresInSeconds: number;
}): string {
  const id = randomUUID();
  const now = new Date();
  getDb()
    .insert(playbackNextPlan)
    .values({
      id,
      householdId: input.householdId,
      deviceSessionId: input.deviceSessionId,
      profileId: input.profileId,
      profileContextVersion: deviceSessionProfileContextVersionOf(input.deviceSessionId),
      fromSessionId: input.fromSessionId,
      fromGeneration: 1,
      action: 'manual_next',
      ref: input.ref,
      targetMediaId: input.targetMediaId,
      sequenceRevision: 1,
      detailRevision: 1,
      targetContentRevision: 1,
      targetContinuityRevision: 1,
      targetLocatorRevision: 1,
      historyRevision: 0,
      historyChoiceRequired: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString(),
    })
    .run();
  return id;
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

function getStatus(app: INestApplication, cookie: string, sessionId: string): request.Test {
  return request(app.getHttpServer()).get(`/api/playback/sessions/${sessionId}`).set('Cookie', cookie);
}

/** 轮询等待会话进入指定状态(在线 hls 候选 probe 免 ffprobe 即时成功,T036 rig 同款) */
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
/* 链式编排(计划内红点集中在此:计划/intent 404 窗口)                     */
/* ------------------------------------------------------------------ */

interface SourceSession {
  readonly sessionId: string;
  readonly generation: number;
}

/** 真实 resolve 源会话并等 ready(活动形态;T031 已装配,绿基线) */
async function resolveSourceSession(rig: NextTransitionRig, cookie?: string, mediaId?: string): Promise<SourceSession> {
  const res = await postResolve(rig.app, cookie ?? rig.cookieA, { mediaId: mediaId ?? rig.serial.ep01MediaId });
  expect(res.status, '夹具错误:源会话 resolve 应 201(T036 已装配)').toBe(201);
  const sessionId = String(res.headers['location']).split('/').pop() ?? '';
  await waitUntilState(rig.app, cookie ?? rig.cookieA, sessionId, 'ready');
  return { sessionId, generation: sessionRowOf(sessionId).generation };
}

/** 服务端先停止来源会话(manual_next「先停止再消费」/next「已结束来源」前置) */
async function stopSourceSession(rig: NextTransitionRig, source: SourceSession, cookie?: string): Promise<void> {
  const res = await postStop(rig.app, cookie ?? rig.cookieA, source.sessionId);
  expect(res.status, '夹具错误:来源会话 stop 应 204(既有 005 语义)').toBe(204);
  expect(sessionRowOf(source.sessionId).state, '夹具错误:stop 后来源会话应为终态 ended').toBe('ended');
}

/** 创建下一集计划(断言 200 NextPlanReply;A 组计划内红点) */
async function createNextPlanOk(
  rig: NextTransitionRig,
  sourceSessionId: string,
  options: { action?: 'next' | 'manual_next'; cookie?: string } = {},
): Promise<NextPlanSnapshot> {
  const res = await postNextPlan(rig.app, options.cookie ?? rig.cookieA, {
    fromSessionId: sourceSessionId,
    expectedGeneration: sessionRowOf(sourceSessionId).generation,
    action: options.action ?? 'manual_next',
  });
  expect(
    res.status,
    redLabel(
      'T055+T059+T060',
      `200 NextPlanReply(9 键服务端计划;POST ${NEXT_PLANS_URL})`,
      `${res.status} ${JSON.stringify(res.body).slice(0, 200)}(路由未装配)`,
    ),
  ).toBe(200);
  return res.body as NextPlanSnapshot;
}

/** 创建 pending intent(断言 201 IntentReply;B 组计划内红点) */
async function createIntentOk(
  rig: NextTransitionRig,
  input: {
    readonly source: SourceSession;
    readonly plan: NextPlanSnapshot;
    readonly action: 'next' | 'manual_next';
    readonly positionMode: 'beginning' | 'target_history';
    readonly expectedSlotRevision?: number;
    readonly operationKey?: string;
    readonly cookie?: string;
  },
): Promise<IntentSnapshot> {
  const res = await postIntent(rig.app, input.cookie ?? rig.cookieA, {
    fromSessionId: input.source.sessionId,
    expectedGeneration: input.source.generation,
    action: input.action,
    nextPlanRef: input.plan.nextPlanRef,
    positionMode: input.positionMode,
    expectedSlotRevision: input.expectedSlotRevision ?? 0,
    operationKey: input.operationKey ?? randomUUID(),
  });
  expect(
    res.status,
    redLabel(
      'T059+T060',
      `201 IntentReply(POST ${INTENTS_URL})`,
      `${res.status} ${JSON.stringify(res.body).slice(0, 200)}(路由未装配)`,
    ),
  ).toBe(201);
  return res.body as IntentSnapshot;
}

interface PendingChain {
  readonly source: SourceSession;
  readonly plan: NextPlanSnapshot;
  readonly intent: IntentSnapshot;
}

/** 全链:resolve 源会话 → 计划 → pending intent(manual_next/beginning 缺省) */
async function createPendingChain(
  rig: NextTransitionRig,
  options: { positionMode?: 'beginning' | 'target_history'; action?: 'next' | 'manual_next'; cookie?: string } = {},
): Promise<PendingChain> {
  const cookie = options.cookie ?? rig.cookieA;
  const source = await resolveSourceSession(rig, cookie);
  const action = options.action ?? 'manual_next';
  const plan = await createNextPlanOk(rig, source.sessionId, { action, cookie });
  const intent = await createIntentOk(rig, {
    source,
    plan,
    action,
    positionMode: options.positionMode ?? 'beginning',
    cookie,
  });
  return { source, plan, intent };
}

/* ------------------------------------------------------------------ */
/* F 组:消费事务故障注入(T024 Proxy 包装 txStores 已验证手法)            */
/* ------------------------------------------------------------------ */

/** app.module.ts UNIT_OF_WORK 的原始 txStores 注册表(逐键同源,不改源码仅覆盖) */
const ORIGINAL_TX_STORE_FACTORIES: Record<string, TxStoreFactory> = {
  identityAccess: createIdentityAccessTxReaders,
  profile: createProfileTxReaders,
  policy: createPolicyTxReaders,
  sources: createSourcesTxParticipants,
  catalog: createMediaCatalogTxParticipants,
  vod: createOnlineVodTxParticipants,
  playback: createPlaybackTxParticipants,
  personalData: createPersonalDataTxParticipants,
};

/**
 * TransitionConsumeWorkSet 步骤名(internal-ports §2/§5「校验 slot → 创建 preparing
 * session → 分配 epoch/ledger → consumed/后继结果」+ playback-state §50 顺序)
 * → 步骤所属上下文的 txStores 注册表键 + 注入 occurrence。
 * 粒度说明(T024 同款):可注入 seam 为「该键 TxStore 参与者的第 N 次触达点」,早于
 * 具名步骤的精确执行点;同键多次触达以 occurrence 区分(若实现合并触达致 occurrence
 * 未达,该用例显式失败暴露粒度协商点,不静默通过)。
 */
const TRANSITION_CONSUME_STEPS: readonly { name: string; txStoreKey: string; occurrence: number }[] = [
  { name: 'transition:reserve-slot', txStoreKey: 'playback', occurrence: 1 }, // slot 校验/CAS(IntentTx/SlotTx)
  { name: 'transition:create-successor-session', txStoreKey: 'playback', occurrence: 2 }, // 新 preparing session(PlaybackSessionTx)
  { name: 'transition:allocate-epoch', txStoreKey: 'personalData', occurrence: 1 }, // epoch/进度绑定(ProgressClockTx)
  { name: 'transition:write-ledger', txStoreKey: 'personalData', occurrence: 2 }, // 会话 ledger/历史写入(SessionLedgerTx)
  { name: 'transition:commit-consume', txStoreKey: 'playback', occurrence: 3 }, // consumed/后继结果提交(最后写入参与者)
];

/** 步骤故障包装工厂:参与者方法第 N 次被触达时 planner.enterStep(命中即抛) */
function stepFailureProxyFactory(
  factory: TxStoreFactory,
  stepName: string,
  planner: FixtureStepFailurePlanner,
): TxStoreFactory {
  return (binding) => {
    const store: object = factory(binding) as object;
    return new Proxy(store, {
      get(target, property, _receiver) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          planner.enterStep(stepName);
          return (value as (...innerArgs: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  };
}

function txStoresWithStepInjection(
  txStoreKey: string,
  stepName: string,
  planner: FixtureStepFailurePlanner,
): TxStoresRegistry {
  const registry: TxStoresRegistry = {};
  for (const [key, factory] of Object.entries(ORIGINAL_TX_STORE_FACTORIES)) {
    registry[key] = key === txStoreKey ? stepFailureProxyFactory(factory, stepName, planner) : factory;
  }
  return registry;
}

/** 消费副作用快照(F 组零残留断言;目标是 EP02,基线内不存在任何 EP02 会话) */
interface TransitionConsumeResidue {
  readonly successorSessions: number;
  readonly successorProgressStates: number;
  readonly successorInputBindings: number;
  readonly nextPlanRows: number;
}

function transitionConsumeResidueOf(householdId: string, targetMediaId: string): TransitionConsumeResidue {
  return {
    successorSessions: scalarOf(
      'SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?',
      householdId,
      targetMediaId,
    ),
    successorProgressStates: scalarOf(
      'SELECT COUNT(*) AS n FROM playback_progress_state WHERE household_id = ? AND media_id = ?',
      householdId,
      targetMediaId,
    ),
    successorInputBindings: scalarOf(
      `SELECT COUNT(*) AS n FROM playback_input_binding b
       JOIN playback_session s ON s.household_id = b.household_id AND s.id = b.session_id
       WHERE b.household_id = ? AND s.media_id = ?`,
      householdId,
      targetMediaId,
    ),
    nextPlanRows: scalarOf('SELECT COUNT(*) AS n FROM playback_next_plan WHERE household_id = ?', householdId),
  };
}

/* ------------------------------------------------------------------ */
/* 通用 afterEach                                                       */
/* ------------------------------------------------------------------ */

afterEach(async () => {
  while (activeMediaServers.length > 0) {
    await activeMediaServers.pop()?.close();
  }
  await cleanupLocalUowRigs();
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* A next-plans 计划快照(§7 I3;data-model §10)                          */
/* ------------------------------------------------------------------ */

describe('T052 · A next-plans 计划快照(api.md §7 I3;data-model §10 playback_next_plan)', () => {
  it('A1 [计划内红·待 T055+T059+T060] manual_next 计划 200 NextPlanReply:9 键快照+N+1 目标 EP02;无 slot/会话/epoch/历史写(不占槽)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-a1-');
    const source = await resolveSourceSession(rig);
    const beforeSessions = scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ?', rig.householdId);
    const beforeProgressStates = scalarOf(
      'SELECT COUNT(*) AS n FROM playback_progress_state WHERE household_id = ?',
      rig.householdId,
    );
    const res = await postNextPlan(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
    });
    expect(
      res.status,
      redLabel(
        'T055+T059+T060',
        `200 NextPlanReply(POST ${NEXT_PLANS_URL})`,
        `${res.status} ${JSON.stringify(res.body).slice(0, 200)}(路由未装配)`,
      ),
    ).toBe(200);
    const body = res.body as NextPlanSnapshot;
    // 计划内红判据:9 键全量(openapi NextPlanReply additionalProperties:false)
    expect(Object.keys(body).sort(), redLabel('T059+T060', `NextPlanReply 键集合 ${NEXT_PLAN_REPLY_KEYS.join(',')}`, `当前键 ${Object.keys(body).sort().join(',')}`)).toEqual([
      ...NEXT_PLAN_REPLY_KEYS,
    ]);
    // 服务端确定目标:同线明确 N+1(EP01→EP02);不接客户端目标 ID
    expect(body.targetMediaId, '计划目标应为序列确定下一集 EP02').toBe(rig.serial.ep02MediaId);
    expect(body.label).toBeTypeOf('string');
    expect((body.label as string).length, '计划应带目标展示标签').toBeGreaterThan(0);
    expect(body.sequenceRevision, '序列修订快照 >=1(data-model §10 sequence_revision>=1)').toBeGreaterThanOrEqual(1);
    expect(body.detailRevision, '详情修订快照 >=1').toBeGreaterThanOrEqual(1);
    expect(body.historyRevision, '无历史快照 historyRevision=0(仅快照语义)').toBe(0);
    expect(body.historyChoiceRequired, '无未完成历史 → 无需显式选择').toBe(false);
    expect(body.history, '无历史快照 history=null').toBeNull();
    expect(body.nextPlanRef, '不透明计划引用非空,不携带可解码 URL').toBeTypeOf('string');
    expect(body.nextPlanRef, '计划引用不得含 URL 形态(api §0 私有 opaque ref)').not.toMatch(/^https?:\/\//);
    expect(new Date(body.expiresAt).getTime(), 'TTL 60s 固定(expiresAt≈now+60s)').toBeGreaterThanOrEqual(Date.now() + 55_000);
    expect(new Date(body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 65_000);
    // 只生成有界计划:不建播放/epoch/历史,不占 slot(I3)
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ?', rig.householdId),
      '计划不得创建会话',
    ).toBe(beforeSessions);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_progress_state WHERE household_id = ?', rig.householdId),
      '计划不得分配 epoch/ledger',
    ).toBe(beforeProgressStates);
    expect(scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId), '计划不得占 slot').toBe(0);
    expect(scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId), '计划不得建 intent').toBe(0);
    expect(historyRowCount(rig.householdId, rig.serial.ep02MediaId), '计划不写个人历史').toBe(0);
    // 库内快照行:绑定设备/Profile/context/来源代次/action
    const planRow = Database.db
      .prepare(
        `SELECT target_media_id AS targetMediaId, action, ref, history_revision AS historyRevision
         FROM playback_next_plan WHERE household_id = ? AND ref = ?`,
      )
      .get(rig.householdId, body.nextPlanRef) as
      | { targetMediaId: string; action: string; ref: string; historyRevision: number }
      | undefined;
    expect(planRow, '计划行应落库(playback_next_plan)').toBeDefined();
    expect(planRow!.targetMediaId).toBe(rig.serial.ep02MediaId);
    expect(planRow!.action).toBe('manual_next');
    expect(planRow!.historyRevision).toBe(0);
  });

  it('A2 [计划内红·待 T055+T060] 无确定下一集(三集连续剧末集 EP03;缺集/季界/末集同归)→ 404 VOD_NEXT_UNAVAILABLE,不落计划', async () => {
    // 素材说明:fixture 缺集世界(mistfiles)镜像线按设计重复 lineKey,整题经真实物化链
    // 入库会触发 (title_id,line_key) 唯一约束(T022 仅覆盖其预览 unsupported 面),
    // 故「无确定下一集」锚点取三集连续剧末集 EP03 —— 同为 VOD_NEXT_UNAVAILABLE 契约
    // 素材(fixture 设计内形态:末集 N+1 耗尽);缺集不跳的序列规则由 T053 单测覆盖。
    const rig = await startNextTransitionRig('hmp-t052-a2-');
    const source = await resolveSourceSession(rig, rig.cookieA, rig.serial.ep03MediaId);
    const beforePlans = activeNextPlanCount(rig.householdId, rig.deviceSessionAId);
    const res = await postNextPlan(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
    });
    // 无确定下一集 → 404 VOD_NEXT_UNAVAILABLE,停止连播(api §6/§7 I3)
    expectProblem(res, 404, 'VOD_NEXT_UNAVAILABLE');
    expect(activeNextPlanCount(rig.householdId, rig.deviceSessionAId), '无确定下一集不落计划行').toBe(beforePlans);
  });

  it('A3 [计划内红·待 T059+T060] 计划超期(DB 直改 expires_at 成对置过去)后建 intent → 410 NEXT_PLAN_EXPIRED,零残留', async () => {
    const rig = await startNextTransitionRig('hmp-t052-a3-');
    const chain = await createPendingChainSansIntent(rig);
    expireNextPlans(rig.householdId);
    const beforeSlots = scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId);
    const beforeIntents = scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId);
    const res = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    // 超期 410 NEXT_PLAN_EXPIRED 并重新展示(I3);过期不再允许新建意图(data-model §10)
    expectProblem(res, 410, 'NEXT_PLAN_EXPIRED');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId),
      '过期计划建 intent 不得占槽',
    ).toBe(beforeSlots);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      '过期计划建 intent 不得落 intent',
    ).toBe(beforeIntents);
  });

  it('A4 [计划内红·待 T059+T060] 目标/序列变化(DB 直推进修订)→ 建 intent 409 NEXT_PLAN_CHANGED;新计划各自快照,零残留', async () => {
    const rig = await startNextTransitionRig('hmp-t052-a4-');
    const chain = await createPendingChainSansIntent(rig);
    // (1) 目标详情修订推进 → 计划 detailRevision 快照失真
    bumpSerialDetailRevision(rig.householdId, rig.serial.parentMediaId);
    const staleDetail = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectProblem(staleDetail, 409, 'NEXT_PLAN_CHANGED');
    // (2) 新计划(新快照)后序列修订推进 → 序列快照失真
    const plan2 = await createNextPlanOk(rig, chain.source.sessionId);
    expect(plan2.detailRevision, '新计划应取推进后的详情修订快照').toBeGreaterThan(chain.plan.detailRevision);
    bumpSerialSequenceRevision(rig.householdId, rig.serial.parentMediaId);
    const staleSequence = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: plan2.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectProblem(staleSequence, 409, 'NEXT_PLAN_CHANGED');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId),
      '计划变化拒绝不消耗槽',
    ).toBe(0);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      '计划变化拒绝不落 intent',
    ).toBe(0);
  });

  it('A5 [计划内红·待 T059+T060] 目标历史变化(plan 后出现 EP02 未完成历史)→ 建 intent 409 NEXT_PLAN_CHANGED(不重新计算后静默消费)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-a5-');
    const chain = await createPendingChainSansIntent(rig);
    expect(chain.plan.historyRevision, '计划时点目标无历史 → 快照 0').toBe(0);
    // DB 直改注明:等价「他设备已看 EP02 未完」——计划后目标历史出现
    seedUnfinishedTargetHistory({
      householdId: rig.householdId,
      profileId: rig.profileAId,
      deviceSessionId: rig.deviceSessionBId,
      mediaId: rig.serial.ep02MediaId,
      positionSeconds: 120,
      durationSeconds: 360,
    });
    const res = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectProblem(res, 409, 'NEXT_PLAN_CHANGED');
    expect(historyRowCount(rig.householdId, rig.serial.ep02MediaId), '目标历史行保留(拒绝不清理他设备事实)').toBe(1);
  });

  it('A6 [计划内红·待 T059+T060] 每设备 20 活计划上限:第 21 个计划创建淘汰最早过期未引用计划;受 pending intent 引用计划不被淘汰;淘汰 ref 同形 404', async () => {
    const rig = await startNextTransitionRig('hmp-t052-a6-');
    const source = await resolveSourceSession(rig);
    // DB 直改注明:20 个活计划(等价历史创建;ref 唯一、过期时间递增,r1 最早)+ 1 个
    // 引用 r5 的 pending intent(等价 T060 创建后的引用形态)
    for (let index = 1; index <= 20; index += 1) {
      seedActiveNextPlanRow({
        householdId: rig.householdId,
        deviceSessionId: rig.deviceSessionAId,
        profileId: rig.profileAId,
        fromSessionId: source.sessionId,
        targetMediaId: rig.serial.ep02MediaId,
        ref: `fixture-plan-ref-${String(index).padStart(2, '0')}`,
        expiresInSeconds: 90 + index,
      });
    }
    const referencedPlanId = nextPlanIdByRef(rig.householdId, 'fixture-plan-ref-05');
    expect(referencedPlanId, '夹具错误:r5 计划行应存在').toBeDefined();
    seedPendingIntentWithSlot({
      householdId: rig.householdId,
      deviceSessionId: rig.deviceSessionAId,
      profileId: rig.profileAId,
      fromSessionId: source.sessionId,
      fromGeneration: source.generation,
      targetMediaId: rig.serial.ep02MediaId,
      nextPlanId: referencedPlanId!,
    });
    expect(activeNextPlanCount(rig.householdId, rig.deviceSessionAId), '夹具基线:20 个活计划').toBe(20);
    // 第 21 个计划(HTTP 创建):触发「最早过期淘汰」—— 只计未引用活计划(data-model §10)
    const newPlan = await createNextPlanOk(rig, source.sessionId);
    expect(activeNextPlanCount(rig.householdId, rig.deviceSessionAId), '引用计划不计上限:20 未引用 + 1 受引用 = 21 行').toBe(21);
    expect(
      scalarOf(
        `SELECT COUNT(*) AS n FROM playback_next_plan p WHERE p.household_id = ? AND p.device_session_id = ?
         AND p.id NOT IN (SELECT next_plan_id FROM playback_transition_intent WHERE household_id = p.household_id AND next_plan_id IS NOT NULL)`,
        rig.householdId,
        rig.deviceSessionAId,
      ),
      '上限 20 只计未引用活计划(data-model §10)',
    ).toBe(20);
    expect(
      nextPlanIdByRef(rig.householdId, 'fixture-plan-ref-01'),
      '最早过期未引用计划(r1)应被淘汰',
    ).toBeUndefined();
    expect(
      nextPlanIdByRef(rig.householdId, 'fixture-plan-ref-05'),
      '受 pending intent 引用计划(r5)不得被活计划配额淘汰',
    ).toBeDefined();
    expect(nextPlanIdByRef(rig.householdId, newPlan.nextPlanRef), '新计划(触发淘汰者)保留').toBeDefined();
    // 淘汰 ref 与随机 ref 同形 404(不可借错误码判别存在性)
    const evictedIntent = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
      nextPlanRef: 'fixture-plan-ref-01',
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectProblem(evictedIntent, 404, ProblemCode.NOT_FOUND);
    const randomIntent = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
      nextPlanRef: `fixture-plan-ref-missing-${randomUUID()}`,
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectSameShape(evictedIntent, randomIntent, '淘汰 ref 与随机 ref 必须同形');
  });

  it('A7 [计划内红·待 T059+T060] 目标独立策略:受限目标(档案B blocked EP02)计划 404 同形;档案A 同目标计划仍 200(按 Profile 独立)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-a7-');
    // 档案B(child,默认拒未评级)先放开等级,再用名单精确 block EP02(目标独立策略素材)
    const createdB = await createProfileViaSettings(rig.app, rig.cookieA, { name: '档案B', type: 'child' });
    expect(createdB.status, JSON.stringify(createdB.body)).toBe(201);
    const profileBId = (createdB.body as { id: string }).id;
    const policyUrl = `/api/settings/profiles/${profileBId}/policy`;
    const get1 = await request(rig.app.getHttpServer()).get(policyUrl).set('Cookie', rig.cookieA);
    expect(get1.status).toBe(200);
    const put1 = await request(rig.app.getHttpServer())
      .put(policyUrl)
      .set('Cookie', rig.cookieA)
      .send({
        expectedVersion: (get1.body as { version: number }).version,
        policy: { maxContentLevel: 18, allowUnrated: true },
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      });
    expect(put1.status, JSON.stringify(put1.body)).toBe(200);
    const get2 = await request(rig.app.getHttpServer()).get(policyUrl).set('Cookie', rig.cookieA);
    const put2 = await request(rig.app.getHttpServer())
      .put(`${policyUrl}/lists`)
      .set('Cookie', rig.cookieA)
      .send({
        expectedVersion: (get2.body as { version: number }).version,
        allowedMediaIds: [],
        blockedMediaIds: [rig.serial.ep02MediaId],
        allowedChannelIds: [],
        ownerPassword: MANAGEMENT_OWNER_PASSWORD,
      });
    expect(put2.status, JSON.stringify(put2.body)).toBe(200);
    // 设备B 切到档案B;档案B 可看 EP01(allowUnrated)但目标 EP02 被名单阻止
    const selectB2 = await request(rig.app.getHttpServer())
      .post(`/api/profiles/${profileBId}/select`)
      .set('Cookie', rig.cookieB)
      .send({});
    expect(selectB2.status).toBe(200);
    const sourceB = await resolveSourceSession(rig, rig.cookieB);
    const denied = await postNextPlan(rig.app, rig.cookieB, {
      fromSessionId: sourceB.sessionId,
      expectedGeneration: sourceB.generation,
      action: 'manual_next',
    });
    // 其他策略拒绝媒体 404(api §0);T022 既有口径 = 404 MEDIA_NOT_FOUND 同形
    expectProblem(denied, 404, ProblemCode.MEDIA_NOT_FOUND);
    const randomTarget = await postNextPlan(rig.app, rig.cookieB, {
      fromSessionId: randomUUID(),
      expectedGeneration: 1,
      action: 'manual_next',
    });
    expectSameShape(denied, randomTarget, '受限目标与不存在来源必须同形 404');
    // 对照:档案A(同家庭另一 Profile)同目标计划不受档案B 名单影响(目标独立)
    const sourceA = await resolveSourceSession(rig, rig.cookieA);
    const allowed = await postNextPlan(rig.app, rig.cookieA, {
      fromSessionId: sourceA.sessionId,
      expectedGeneration: sourceA.generation,
      action: 'manual_next',
    });
    expect(allowed.status, redLabel('T059+T060', '200(档案A 目标独立策略不受档案B 名单影响)', `${allowed.status}`)).toBe(200);
    expect((allowed.body as NextPlanSnapshot).targetMediaId).toBe(rig.serial.ep02MediaId);
  });
});

/** A 组共用:仅「源会话+计划」链(不发 intent;intent 由用例自控载荷) */
async function createPendingChainSansIntent(
  rig: NextTransitionRig,
  options: { action?: 'next' | 'manual_next'; cookie?: string } = {},
): Promise<{ source: SourceSession; plan: NextPlanSnapshot }> {
  const cookie = options.cookie ?? rig.cookieA;
  const source = await resolveSourceSession(rig, cookie);
  const plan = await createNextPlanOk(rig, source.sessionId, { action: options.action ?? 'manual_next', cookie });
  return { source, plan };
}

/* ------------------------------------------------------------------ */
/* B intent 创建(§5 IntentRequest next/manual_next 分支;data-model §7)   */
/* ------------------------------------------------------------------ */

describe('T052 · B intent 创建(api.md §5 IntentRequest next/manual_next 分支;data-model §7)', () => {
  it('B1 [计划内红·待 T059+T060] manual_next 创建 201 IntentReply(11 键 pending/slotRevision>=1)+GET 查询同形;slot reserved/revision>=1 落库', async () => {
    const rig = await startNextTransitionRig('hmp-t052-b1-');
    const chain = await createPendingChain(rig);
    const intent = chain.intent;
    expect(Object.keys(intent).sort(), redLabel('T059+T060', `IntentReply 键集合 ${INTENT_REPLY_KEYS.join(',')}`, `当前键 ${Object.keys(intent).sort().join(',')}`)).toEqual([
      ...INTENT_REPLY_KEYS,
    ]);
    expect(intent.status).toBe('pending');
    expect(intent.action).toBe('manual_next');
    expect(intent.targetMediaId).toBe(rig.serial.ep02MediaId);
    expect(intent.positionMode).toBe('beginning');
    expect(intent.fromSessionId).toBe(chain.source.sessionId);
    expect(intent.fromGeneration).toBe(chain.source.generation);
    expect(intent.successorSessionId, '消费前 successor=null(api §1)').toBeNull();
    expect(intent.slotRevision, '持久 slot revision>=1(api 冻结:持久行 revision>=1)').toBeGreaterThanOrEqual(1);
    expect(new Date(intent.expiresAt).getTime(), '意图 TTL 60s 固定').toBeGreaterThanOrEqual(Date.now() + 55_000);
    // GET 查询:pending 同形(当前上下文归属)
    const got = await getIntent(rig.app, rig.cookieA, intent.id);
    expect(got.status, redLabel('T059+T060', '200 IntentReply(GET 查询)', `${got.status}`)).toBe(200);
    expect(got.body).toEqual(intent);
    // 库内:slot reserved + intent pending + 计划快照冻结
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('reserved');
    expect(slot?.slotRevision).toBe(intent.slotRevision);
    expect(slot?.activeIntentId).toBe(intent.id);
    expect(slot?.successorSessionId).toBeNull();
    const row = intentRowOf(rig.householdId, intent.id);
    expect(row?.status).toBe('pending');
    const planRowId = nextPlanIdByRef(rig.householdId, chain.plan.nextPlanRef);
    expect(row?.nextPlanId).toBe(planRowId);
    expect(row?.planSequenceRevision).toBe(chain.plan.sequenceRevision);
    expect(row?.planDetailRevision).toBe(chain.plan.detailRevision);
    expect(row?.planHistoryRevision).toBe(chain.plan.historyRevision);
  });

  it('B2 [计划内红·待 T059+T060] manual_next 不要求 finish 资格/偏好:来源活动未结束、无 receipt 仍 201', async () => {
    const rig = await startNextTransitionRig('hmp-t052-b2-');
    // 来源保持活动 ready(未 stop、无 finish receipt、偏好缺省)——manual_next 明确豁免
    const chain = await createPendingChain(rig);
    expect(sessionRowOf(chain.source.sessionId).state, '夹具前提:来源仍活动').toBe('ready');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_finish_receipt WHERE household_id = ?', rig.householdId),
      '夹具前提:无 finish receipt',
    ).toBe(0);
    expect(chain.intent.status, redLabel('T059+T060', 'pending(manual_next 不要求完成/偏好)', `${chain.intent.status}`)).toBe('pending');
  });

  it('B3 [计划内红·待 T059+T060] 自动 next 无 finish receipt 拒绝 409 SOURCE_NOT_TERMINAL(§5「next必须有finish receipt」),零残留', async () => {
    const rig = await startNextTransitionRig('hmp-t052-b3-');
    const chain = await createPendingChainSansIntent(rig);
    const beforeSlots = scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId);
    const res = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    // next 资格=已结束来源且 finish.autoNextEligible(playback-state §44;api §5
    // 「next必须有finish receipt」)→ 来源未自然终态拒绝,SOURCE_NOT_TERMINAL 族
    expectProblem(res, 409, 'SOURCE_NOT_TERMINAL');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_slot WHERE household_id = ?', rig.householdId),
      '拒绝路径不占槽',
    ).toBe(beforeSlots);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      '拒绝路径不落 intent',
    ).toBe(0);
    expect(sessionRowOf(chain.source.sessionId).state, '拒绝不改变来源会话状态').toBe('ready');
  });

  it('B4 [计划内红·待 T059+T060] 同 key 重放 200 同 IntentReply 且不续 TTL;同 key 异摘要 409 IDEMPOTENCY_CONFLICT', async () => {
    const rig = await startNextTransitionRig('hmp-t052-b4-');
    const chain = await createPendingChain(rig);
    const operationKey = randomUUID();
    // 契约裁决(lead,2026-10-31):createPendingChain 已在源会话占用槽(revision=1),
    // 首发请求的 expectedSlotRevision 必须匹配当前槽(=1);0 恰为 B6 钉死的 stale
    // 形态(必 409),原值 0 与 B6 自相矛盾。同 key 重放走 scope 幂等,不受此值影响。
    const replayBody = {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 1,
      operationKey,
    };
    // 首次(新 key)201
    const first = await postIntent(rig.app, rig.cookieA, replayBody);
    expect(first.status, redLabel('T059+T060', '201 IntentReply', `${first.status}`)).toBe(201);
    const firstBody = first.body as IntentSnapshot;
    // 丢响应后同 key 同载荷重放 → 200 同结果,不续 TTL
    const replay = await postIntent(rig.app, rig.cookieA, replayBody);
    expect(replay.status, redLabel('T059+T060', '200 同 key 重放', `${replay.status} ${JSON.stringify(replay.body).slice(0, 160)}`)).toBe(200);
    expect(replay.body).toEqual(firstBody);
    expect((replay.body as IntentSnapshot).expiresAt, '同 key 重放不续 TTL(§5)').toBe(firstBody.expiresAt);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      '重放不新建 intent 行',
    ).toBe(2); // createPendingChain 1 条 + 本例 1 条
    // 同 key 异载荷(不同 positionMode)→ 409 IDEMPOTENCY_CONFLICT(同 key 异摘要)
    const conflict = await postIntent(rig.app, rig.cookieA, { ...replayBody, positionMode: 'target_history' });
    expectProblem(conflict, 409, ProblemCode.IDEMPOTENCY_CONFLICT);
    expect(
      (await getIntent(rig.app, rig.cookieA, firstBody.id)).status,
      '冲突不改变既有 intent',
    ).toBe(200);
  });

  it('B5 [计划内红·待 T059+T060] 显式替换:新 key+expectedSlotRevision → 201 新 intent,旧标 superseded、slot revision+1', async () => {
    const rig = await startNextTransitionRig('hmp-t052-b5-');
    const chain = await createPendingChain(rig);
    expect(chain.intent.slotRevision).toBe(1);
    // 显式替换:新 operationKey + 当前 expectedSlotRevision=1 + 不同选择(target_history)
    const replaced = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'target_history',
      expectedSlotRevision: 1,
      operationKey: randomUUID(),
    });
    expect(replaced.status, redLabel('T059+T060', '201(显式替换)', `${replaced.status} ${JSON.stringify(replaced.body).slice(0, 160)}`)).toBe(201);
    const replacedBody = replaced.body as IntentSnapshot;
    expect(replacedBody.id, '替换产生新 intent').not.toBe(chain.intent.id);
    expect(replacedBody.status).toBe('pending');
    expect(replacedBody.slotRevision, '替换后 slot revision+1(data-model §7)').toBe(2);
    // 旧 intent superseded(GET 与库内一致)
    const oldGot = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect(oldGot.status).toBe(200);
    expect((oldGot.body as IntentSnapshot).status, '旧 intent 应标 superseded').toBe('superseded');
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('superseded');
    // 槽:revision 2、active=新 intent
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.slotRevision).toBe(2);
    expect(slot?.activeIntentId).toBe(replacedBody.id);
  });

  it('B6 [计划内红·待 T059+T060] 不同 key 单 slot:陈旧/超前 expectedSlotRevision → 409 TRANSITION_SLOT_CONFLICT,slot 不动', async () => {
    const rig = await startNextTransitionRig('hmp-t052-b6-');
    const chain = await createPendingChain(rig);
    for (const staleRevision of [0, 99]) {
      const conflict = await postIntent(rig.app, rig.cookieA, {
        fromSessionId: chain.source.sessionId,
        expectedGeneration: chain.source.generation,
        action: 'manual_next',
        nextPlanRef: chain.plan.nextPlanRef,
        positionMode: 'beginning',
        expectedSlotRevision: staleRevision,
        operationKey: randomUUID(),
      });
      // 并发不同 operationKey 争用同槽:expectedSlotRevision CAS 失败 409(api §5/§6)
      expectProblem(conflict, 409, 'TRANSITION_SLOT_CONFLICT');
    }
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status, '冲突路径槽保持 reserved').toBe('reserved');
    expect(slot?.slotRevision, '冲突路径槽 revision 不变').toBe(1);
    expect(slot?.activeIntentId, '冲突路径 active intent 不变').toBe(chain.intent.id);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      '冲突路径不落新 intent',
    ).toBe(1);
  });

  it('B7 [计划内红·待 T059+T060] historyChoiceRequired:nextPlanRef 已含选择 —— 拒绝 historyChoiceConfirmed 字段(400),positionMode 即用户选择(201)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-b7-');
    const source = await resolveSourceSession(rig);
    // DB 直改注明:计划前 EP02 已有未完成历史 → historyChoiceRequired=true + history 快照
    seedUnfinishedTargetHistory({
      householdId: rig.householdId,
      profileId: rig.profileAId,
      deviceSessionId: rig.deviceSessionBId,
      mediaId: rig.serial.ep02MediaId,
      positionSeconds: 120,
      durationSeconds: 360,
    });
    const plan = await createNextPlanOk(rig, source.sessionId);
    expect(plan.historyChoiceRequired, '目标有未完成历史 → UI 必须显式选择').toBe(true);
    expect(plan.historyRevision, '历史快照 revision>=1').toBeGreaterThanOrEqual(1);
    expect(plan.history, '计划携带目标历史摘要').not.toBeNull();
    expect((plan.history as Record<string, unknown>)['positionSeconds'], '历史摘要含目标位置').toBe(120);
    // 严格 oneOf:不接受 historyChoiceConfirmed(api §5「不接受 historyChoiceConfirmed」)
    const confirmed = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
      nextPlanRef: plan.nextPlanRef,
      positionMode: 'target_history',
      historyChoiceConfirmed: true,
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectProblem(confirmed, 400, ProblemCode.VALIDATION_FAILED);
    // positionMode 表达用户选择 → 201(服务端不再次询问)
    const intent = await createIntentOk(rig, {
      source,
      plan,
      action: 'manual_next',
      positionMode: 'target_history',
    });
    expect(intent.status).toBe('pending');
    expect(intent.positionMode).toBe('target_history');
  });
});

/* ------------------------------------------------------------------ */
/* C resolve 消费(§4 过渡分支+§5 消费位置语义;data-model §7 消费事务)     */
/* ------------------------------------------------------------------ */

describe('T052 · C resolve 消费(api.md §4 过渡分支+§5 消费位置语义;data-model §7 消费事务)', () => {
  it('C1 [计划内红·待 T059–T061] beginning 消费 201 preparing:startBasis 映射+intent consumed+slot successor 原子+epoch/ledger 分配', async () => {
    const rig = await startNextTransitionRig('hmp-t052-c1-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const res = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(
      res.status,
      redLabel(
        'T059–T061',
        '201 preparing(resolve 过渡分支;当前 strict schema 拒绝 transitionIntentId)',
        `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
      ),
    ).toBe(201);
    expect(res.headers['location']).toMatch(/^\/api\/playback\/sessions\//);
    const body = res.body as Record<string, unknown>;
    const successorId = String(res.headers['location']).split('/').pop();
    expect(body['state']).toBe('preparing');
    expect(body['startBasis'], 'positionMode=beginning 映射唯一 startBasis=beginning(§5 消费位置语义)').toBe('beginning');
    expect(body['playbackUrl'] ?? null, '消费不发票(发票仍走 renew)').toBeNull();
    // 原子结果:intent consumed + slot successor(§7 消费事务「intent consumed与slot successor写入」)
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('consumed');
    expect(intentRowOf(rig.householdId, chain.intent.id)?.successorId).toBe(successorId);
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('consumed');
    expect(slot?.successorSessionId).toBe(successorId);
    expect(slot?.slotRevision, '消费不 bump 槽 revision(仅替换/取消 bump)').toBe(1);
    // epoch/ledger 分配:后继建档 progress_state(新 epoch、未 started、未写历史)
    const state = Database.db
      .prepare(
        `SELECT candidate_epoch AS candidateEpoch, started, last_sample_seq AS lastSampleSeq
         FROM playback_progress_state WHERE playback_session_id = ?`,
      )
      .get(successorId) as { candidateEpoch: number; started: number; lastSampleSeq: number } | undefined;
    expect(state, '后继会话应分配 epoch/ledger 建档').toBeDefined();
    expect(state!.candidateEpoch).toBeGreaterThanOrEqual(1);
    expect(state!.started).toBe(0);
    expect(state!.lastSampleSeq).toBe(0);
    expect(historyRowCount(rig.householdId, rig.serial.ep02MediaId), '准备不建历史(消费路径同 T036 基线)').toBe(0);
    // 输入绑定:start_basis=beginning
    const binding = Database.db
      .prepare('SELECT start_basis AS startBasis FROM playback_input_binding WHERE household_id = ? AND session_id = ?')
      .get(rig.householdId, successorId) as { startBasis: string } | undefined;
    expect(binding?.startBasis, '消费应建 start_basis=beginning 输入绑定(data-model §6)').toBe('beginning');
    // 来源会话保持 ended(不被复活)
    expect(sessionRowOf(chain.source.sessionId).state).toBe('ended');
  });

  it('C2 [计划内红·待 T059–T061] target_history 消费:startBasis=target_history+expectedHistoryRevision 快照;probe 冻结目标历史位置', async () => {
    const rig = await startNextTransitionRig('hmp-t052-c2-');
    const source = await resolveSourceSession(rig);
    // DB 直改注明:计划前 EP02 未完成历史(位置 120)→ 计划快照 historyRevision=1
    seedUnfinishedTargetHistory({
      householdId: rig.householdId,
      profileId: rig.profileAId,
      deviceSessionId: rig.deviceSessionBId,
      mediaId: rig.serial.ep02MediaId,
      positionSeconds: 120,
      durationSeconds: 360,
    });
    const plan = await createNextPlanOk(rig, source.sessionId);
    expect(plan.historyRevision).toBe(1);
    const intent = await createIntentOk(rig, {
      source,
      plan,
      action: 'manual_next',
      positionMode: 'target_history',
    });
    await stopSourceSession(rig, source);
    const res = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: intent.id,
    });
    expect(res.status, redLabel('T059–T061', '201 preparing(target_history 消费)', `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`)).toBe(
      201,
    );
    const successorId = String(res.headers['location']).split('/').pop();
    const body = res.body as Record<string, unknown>;
    expect(body['startBasis']).toBe('target_history');
    // expectedHistoryRevision 快照:intent 冻结计划历史 revision(internal-ports §5)
    expect(intentRowOf(rig.householdId, intent.id)?.planHistoryRevision, 'intent 应冻结计划历史 revision 快照').toBe(1);
    // probe 后冻结一次起点=目标历史位置 120(不是 0、不再读取覆盖)
    await waitUntilState(rig.app, rig.cookieA, successorId!, 'ready');
    const binding = Database.db
      .prepare(
        'SELECT start_basis AS startBasis, frozen_start_seconds AS frozenStartSeconds FROM playback_input_binding WHERE household_id = ? AND session_id = ?',
      )
      .get(rig.householdId, successorId) as { startBasis: string; frozenStartSeconds: number | null } | undefined;
    expect(binding?.startBasis).toBe('target_history');
    expect(
      binding?.frozenStartSeconds,
      redLabel('T041+T061', 'frozen_start_seconds=120(probe 后冻结目标历史位置)', `当前 ${String(binding?.frozenStartSeconds)}`),
    ).toBe(120);
  });

  it('C3 [计划内红·待 T061] 重放同 intent → 200 同后继当前状态(非 201,不产生第二会话)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-c3-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const first = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(first.status, redLabel('T059–T061', '201 首次消费', `${first.status} ${JSON.stringify(first.body).slice(0, 160)}`)).toBe(201);
    const successorId = String(first.headers['location']).split('/').pop();
    const sessionsBefore = scalarOf(
      'SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?',
      rig.householdId,
      rig.serial.ep02MediaId,
    );
    // 消费响应丢失后原样重试:200 同后继当前状态(api §4「相同已消费intent重放200同后继当前状态」)
    const replay = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(replay.status, redLabel('T061', '200 同 intent 重放', `${replay.status} ${JSON.stringify(replay.body).slice(0, 160)}`)).toBe(200);
    expect(String(replay.headers['location']).split('/').pop(), '重放返回同一后继会话').toBe(successorId);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '重放不得新建第二会话',
    ).toBe(sessionsBefore);
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('consumed');
  });

  it('C4 [计划内红·待 T059+T060] consumed 后新 key → 409 TRANSITION_SLOT_CONFLICT 并附原后继引用(仅原上下文可见)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-c4-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const consumed = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(consumed.status, redLabel('T059–T061', '201 首次消费', `${consumed.status}`)).toBe(201);
    const successorId = String(consumed.headers['location']).split('/').pop();
    // consumed 槽任何新 key 也 409 并附原后继引用(api §5;§0 错误收敛)
    const again = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'beginning',
      expectedSlotRevision: 1,
      operationKey: randomUUID(),
    });
    expectProblem(again, 409, 'TRANSITION_SLOT_CONFLICT');
    expect(
      String(again.body.detail ?? ''),
      '409 应附原后继引用(Problem additionalProperties:false → detail 承载)',
    ).toContain(successorId);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId),
      'consumed 槽不得再建第二 intent',
    ).toBe(1);
  });

  it('C5 [计划内红·待 T059–T061] 消费时重验目标:详情修订推进 → 409 NEXT_PLAN_CHANGED,不消耗槽且不建后继', async () => {
    const rig = await startNextTransitionRig('hmp-t052-c5-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    bumpSerialDetailRevision(rig.householdId, rig.serial.parentMediaId);
    const res = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    // 消费再验同一快照,任一改变 409 NEXT_PLAN_CHANGED,不消耗槽且不建后继(I3)
    expectProblem(res, 409, 'NEXT_PLAN_CHANGED');
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status, '拒绝后 intent 保持 pending').toBe('pending');
    expect(slotRowOf(rig.householdId, chain.source.sessionId)?.status, '拒绝不消耗槽').toBe('reserved');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '拒绝不建后继',
    ).toBe(0);
  });

  it('C6 [计划内红·待 T059–T061] 消费时重验历史:目标历史 revision 推进 → 409 NEXT_PLAN_CHANGED(不用新位置替换用户确认)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-c6-');
    const source = await resolveSourceSession(rig);
    seedUnfinishedTargetHistory({
      householdId: rig.householdId,
      profileId: rig.profileAId,
      deviceSessionId: rig.deviceSessionBId,
      mediaId: rig.serial.ep02MediaId,
      positionSeconds: 120,
      durationSeconds: 360,
    });
    const plan = await createNextPlanOk(rig, source.sessionId);
    const intent = await createIntentOk(rig, {
      source,
      plan,
      action: 'manual_next',
      positionMode: 'target_history',
    });
    await stopSourceSession(rig, source);
    // DB 直改注明:等价「确认后他设备再次写入目标历史」→ expectedHistoryRevision 失配
    bumpTargetHistoryRevision(rig.householdId, rig.serial.ep02MediaId);
    const res = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: intent.id,
    });
    expectProblem(res, 409, 'NEXT_PLAN_CHANGED');
    expect(intentRowOf(rig.householdId, intent.id)?.status, 'intent 保持 pending(可重新确认)').toBe('pending');
    // 契约裁决(lead,2026-10-31):夹具 seedUnfinishedTargetHistory 自建 EP02 ended
    // writer 会话(行数恒≥1),「不建后继」按语义收窄为「无活动后继会话(非 ended)」
    // 且总会话数恰为种子 1 条——消费失败不得新增任何会话行。
    expect(
      scalarOf(
        'SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ? AND state != ?',
        rig.householdId,
        rig.serial.ep02MediaId,
        'ended',
      ),
      '不建活动后继',
    ).toBe(0);
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '会话总数恰为夹具种子 1 条',
    ).toBe(1);
  });

  it('C7 [计划内红·待 T059–T061] 先停止再消费:来源未终态 resolve → 409 SOURCE_NOT_TERMINAL(intent 保持 pending);stop 后消费 201', async () => {
    const rig = await startNextTransitionRig('hmp-t052-c7-');
    const chain = await createPendingChain(rig);
    expect(sessionRowOf(chain.source.sessionId).state, '夹具前提:来源活动未停止').toBe('ready');
    const early = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    // manual_next 允许来源活动,但消费必须先停止(§5「先停止再消费」;playback-state §50 来源终态校验)
    expectProblem(early, 409, 'SOURCE_NOT_TERMINAL');
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status, '409 不消耗 intent(C4 同源:未确认终态不消费)').toBe('pending');
    expect(slotRowOf(rig.householdId, chain.source.sessionId)?.status).toBe('reserved');
    await stopSourceSession(rig, chain.source);
    const ok = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(ok.status, redLabel('T059–T061', '201(stop 后消费)', `${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`)).toBe(201);
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('consumed');
  });
});

/* ------------------------------------------------------------------ */
/* D 取消与消费 CAS(§5 cancel;data-model §7)                            */
/* ------------------------------------------------------------------ */

describe('T052 · D 取消与消费 CAS(api.md §5 cancel;data-model §7)', () => {
  it('D1 [计划内红·待 T059+T060] pending cancel 200 cancelled:slot open+revision+1;已取消 intent 不可再消费(409)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-d1-');
    const chain = await createPendingChain(rig);
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancel.status, redLabel('T059+T060', '200 TransitionCancelReply', `${cancel.status} ${JSON.stringify(cancel.body).slice(0, 160)}`)).toBe(200);
    expect(Object.keys(cancel.body).sort()).toEqual([...CANCEL_REPLY_KEYS]);
    expect(cancel.body).toEqual({ outcome: 'cancelled', successorSessionId: null, slotRevision: 1 });
    // 取消成功 slot open+revision,旧意图不可再用(data-model §7)
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('open');
    expect(slot?.slotRevision).toBe(2);
    expect(slot?.activeIntentId).toBeNull();
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('cancelled');
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect(got.status).toBe(200);
    expect((got.body as IntentSnapshot).status).toBe('cancelled');
    // 已取消意图不可消费(旧意图不可再用)
    const consume = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expectProblem(consume, 409, 'TRANSITION_SLOT_CONFLICT');
    expect(
      scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
      '已取消意图不得建后继',
    ).toBe(0);
  });

  it('D2 [计划内红·待 T059+T060] 重复 cancel → already_cancelled(幂等,槽不再变化)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-d2-');
    const chain = await createPendingChain(rig);
    const first = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(first.status, redLabel('T059+T060', '200 首次取消', `${first.status}`)).toBe(200);
    const second = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(second.status, redLabel('T059+T060', '200 already_cancelled', `${second.status} ${JSON.stringify(second.body).slice(0, 160)}`)).toBe(200);
    expect(second.body).toEqual({ outcome: 'already_cancelled', successorSessionId: null, slotRevision: 2 });
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('open');
    expect(slot?.slotRevision, '重复取消不再 bump revision').toBe(2);
  });

  it('D3 [计划内红·待 T059+T060] 取消 superseded intent → outcome superseded(槽归新 intent 不变)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-d3-');
    const chain = await createPendingChain(rig);
    const replaced = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: chain.source.sessionId,
      expectedGeneration: chain.source.generation,
      action: 'manual_next',
      nextPlanRef: chain.plan.nextPlanRef,
      positionMode: 'target_history',
      expectedSlotRevision: 1,
      operationKey: randomUUID(),
    });
    expect(replaced.status, redLabel('T059+T060', '201 替换(前置)', `${replaced.status}`)).toBe(201);
    const cancelOld = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancelOld.status, redLabel('T059+T060', '200 outcome superseded', `${cancelOld.status} ${JSON.stringify(cancelOld.body).slice(0, 160)}`)).toBe(200);
    expect(cancelOld.body).toEqual({ outcome: 'superseded', successorSessionId: null, slotRevision: 2 });
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('superseded');
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status, '取消输家不影响槽归属(新 intent 仍 reserved)').toBe('reserved');
    expect(slot?.activeIntentId, '槽仍归替换者').not.toBe(chain.intent.id);
  });

  it('D4 [计划内红·待 T059+T060] 过期 intent:GET 410 TRANSITION_EXPIRED;cancel → outcome expired+槽释放 open', async () => {
    const rig = await startNextTransitionRig('hmp-t052-d4-');
    const chain = await createPendingChain(rig);
    // DB 直改注明:TTL 60s 自然到期的等价存储事实(成对置过去保持 CHECK)
    Database.db
      .prepare(
        "UPDATE playback_transition_intent SET created_at = '2000-01-01T00:00:00.000Z', expires_at = '2000-01-01T00:01:00.000Z' WHERE household_id = ? AND id = ?",
      )
      .run(rig.householdId, chain.intent.id);
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    // 过期未消费 410,不误作可重新消费(api §5 GET 行)
    expectProblem(got, 410, 'TRANSITION_EXPIRED');
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancel.status, redLabel('T059+T060', '200 outcome expired', `${cancel.status} ${JSON.stringify(cancel.body).slice(0, 160)}`)).toBe(200);
    const reply = cancel.body as { outcome: string; successorSessionId: string | null; slotRevision: number };
    expect(reply.outcome).toBe('expired');
    expect(reply.successorSessionId).toBeNull();
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status, '过期取消释放槽').toBe('open');
  });

  it('D5 [计划内红·待 T059+T060] 取消输给消费 → already_consumed+successorSessionId(仅原上下文),后继不受影响', async () => {
    const rig = await startNextTransitionRig('hmp-t052-d5-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const consumed = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(consumed.status, redLabel('T059–T061', '201 消费(竞争赢家)', `${consumed.status}`)).toBe(201);
    const successorId = String(consumed.headers['location']).split('/').pop();
    const cancel = await postCancel(rig.app, rig.cookieA, chain.intent.id);
    expect(cancel.status, redLabel('T059+T060', '200 already_consumed(取消输家返回 successor)', `${cancel.status} ${JSON.stringify(cancel.body).slice(0, 160)}`)).toBe(200);
    expect(cancel.body).toEqual({ outcome: 'already_consumed', successorSessionId: successorId, slotRevision: 1 });
    // 后继不受取消影响
    const status = await getStatus(rig.app, rig.cookieA, successorId!);
    expect(status.status).toBe(200);
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('consumed');
  });
});

/* ------------------------------------------------------------------ */
/* E 偏好消费时重验(FR-035;api §7 I3 偏好在创建/消费验证集合)             */
/* ------------------------------------------------------------------ */

describe('T052 · E 偏好消费时重验(FR-035「自动下一集在消费时再检查偏好」)', () => {
  it('E1 [计划内红·待 T056+T059–T061] autoplayNext=true 建 next intent(receipt 种子)→ PATCH false → 消费 409 NEXT_PLAN_CHANGED;PATCH true → 消费 201', async () => {
    const rig = await startNextTransitionRig('hmp-t052-e1-');
    const source = await resolveSourceSession(rig);
    await stopSourceSession(rig, source);
    // DB 直改注明:等价 T058 finish 已提交且 autoNextEligible=true(T051/T058 未装配窗口)
    seedAutoNextFinishReceipt({
      householdId: rig.householdId,
      sourceSessionId: source.sessionId,
      durationSeconds: rig.serial.ep01DurationSeconds,
    });
    const plan = await createNextPlanOk(rig, source.sessionId, { action: 'next' });
    const intent = await createIntentOk(rig, { source, plan, action: 'next', positionMode: 'beginning' });
    // 偏好关闭(T056 PATCH;未有行 version=0 起 CAS)
    const prefsGet = await request(rig.app.getHttpServer()).get('/api/me/vod/preferences').set('Cookie', rig.cookieA);
    expect(prefsGet.status, redLabel('T056', '200 Preferences(GET)', `${prefsGet.status}`)).toBe(200);
    const patchOff = await request(rig.app.getHttpServer())
      .patch('/api/me/vod/preferences')
      .set('Cookie', rig.cookieA)
      .send({ expectedVersion: (prefsGet.body as { version: number }).version, autoplayNext: false, operationKey: randomUUID() });
    expect(patchOff.status, redLabel('T056', '200 Preferences(PATCH autoplayNext=false)', `${patchOff.status} ${JSON.stringify(patchOff.body).slice(0, 160)}`)).toBe(200);
    // 消费时重读偏好(FR-035;I3 偏好在消费验证集合)→ 拒绝
    const denied = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: intent.id,
    });
    expectProblem(denied, 409, 'NEXT_PLAN_CHANGED');
    expect(intentRowOf(rig.householdId, intent.id)?.status, '偏好拒绝不消耗 intent').toBe('pending');
    // PATCH 回开后消费行为变化 → 201
    const patchOn = await request(rig.app.getHttpServer())
      .patch('/api/me/vod/preferences')
      .set('Cookie', rig.cookieA)
      .send({ expectedVersion: (patchOff.body as { version: number }).version, autoplayNext: true, operationKey: randomUUID() });
    expect(patchOn.status, redLabel('T056', '200 Preferences(PATCH autoplayNext=true)', `${patchOn.status}`)).toBe(200);
    const allowed = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: intent.id,
    });
    expect(allowed.status, redLabel('T059–T061', '201(偏好回开后消费成功)', `${allowed.status} ${JSON.stringify(allowed.body).slice(0, 160)}`)).toBe(201);
    expect(intentRowOf(rig.householdId, intent.id)?.status).toBe('consumed');
  });

  it('E2 [计划内红·待 T056+T059–T061] manual_next 不受偏好影响:autoplayNext=false 创建+消费均成功', async () => {
    const rig = await startNextTransitionRig('hmp-t052-e2-');
    const prefsGet = await request(rig.app.getHttpServer()).get('/api/me/vod/preferences').set('Cookie', rig.cookieA);
    expect(prefsGet.status, redLabel('T056', '200 Preferences(GET)', `${prefsGet.status}`)).toBe(200);
    const patch = await request(rig.app.getHttpServer())
      .patch('/api/me/vod/preferences')
      .set('Cookie', rig.cookieA)
      .send({ expectedVersion: (prefsGet.body as { version: number }).version, autoplayNext: false, operationKey: randomUUID() });
    expect(patch.status, redLabel('T056', '200 Preferences(PATCH)', `${patch.status}`)).toBe(200);
    // manual_next 是单独用户动作,不借自动开关(playback-state §58)→ 创建+消费不受偏好影响
    const chain = await createPendingChain(rig, { action: 'manual_next' });
    expect(chain.intent.status).toBe('pending');
    await stopSourceSession(rig, chain.source);
    const consumed = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(consumed.status, redLabel('T059–T061', '201(manual_next 免偏好)', `${consumed.status} ${JSON.stringify(consumed.body).slice(0, 160)}`)).toBe(201);
  });
});

/* ------------------------------------------------------------------ */
/* F 消费事务每步故障(internal-ports §2 TransitionConsumeWorkSet)        */
/* ------------------------------------------------------------------ */

describe('T052 · F 消费事务每步故障(Proxy 包装 txStores,T024 已验证手法)', () => {
  for (const step of TRANSITION_CONSUME_STEPS) {
    it(`F·${step.name}(occurrence ${step.occurrence})注入失败 → 500 INTERNAL+整体回滚零残留+intent 保持 pending;解除后同链重试 201`, async () => {
      const plans: FixtureStepFailurePlan[] = [];
      const planner: FixtureStepFailurePlanner = createFixtureStepFailurePlanner(plans);
      const rig = await startNextTransitionRig('hmp-t052-f-', {
        unitOfWorkFactory: () =>
          createUnitOfWork({
            resolveDatabase: () => Database.db,
            txStores: txStoresWithStepInjection(step.txStoreKey, step.name, planner),
          }),
      });
      const chain = await createPendingChain(rig);
      await stopSourceSession(rig, chain.source);
      const baseline = transitionConsumeResidueOf(rig.householdId, rig.serial.ep02MediaId);
      // 武装注入(装配期计划为空 ⇒ 计划/intent 创建已成功;reset 使下一次触达即 occurrence 1)
      plans.push({
        stepName: step.name,
        occurrence: step.occurrence,
        error: { code: 'FIXTURE_STEP_FAILURE', message: `T052 消费事务故障注入:${step.name}` },
      });
      planner.reset();
      const failed = await postResolve(rig.app, rig.cookieA, {
        mediaId: rig.serial.ep02MediaId,
        transitionIntentId: chain.intent.id,
      });
      expect(
        failed.status,
        redLabel(
          'T059–T061',
          `500 INTERNAL(step=${step.name} 抛 FixtureStepFailureError 经 UnitOfWork 整体回滚)`,
          `${failed.status} ${String(failed.body.code)}`,
        ),
      ).toBe(500);
      expectProblem(failed, 500, 'INTERNAL');
      // 整体回滚零残留:后继会话/epoch/输入绑定零新增,计划行不增
      expect(transitionConsumeResidueOf(rig.householdId, rig.serial.ep02MediaId), `step ${step.name} 失败后消费副作用必须零残留`).toEqual(baseline);
      // intent 保持 pending、slot 保持 reserved → 可重试
      expect(intentRowOf(rig.householdId, chain.intent.id)?.status, '失败回滚后 intent 保持 pending').toBe('pending');
      const slot = slotRowOf(rig.householdId, chain.source.sessionId);
      expect(slot?.status).toBe('reserved');
      expect(slot?.slotRevision).toBe(1);
      expect(slot?.successorSessionId).toBeNull();
      // 解除注入:同链重试消费成功(回滚后可恢复)
      plans.splice(0, plans.length);
      planner.reset();
      const retry = await postResolve(rig.app, rig.cookieA, {
        mediaId: rig.serial.ep02MediaId,
        transitionIntentId: chain.intent.id,
      });
      expect(retry.status, redLabel('T059–T061', '201 重试消费成功', `${retry.status} ${JSON.stringify(retry.body).slice(0, 160)}`)).toBe(201);
      expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('consumed');
      expect(
        scalarOf('SELECT COUNT(*) AS n FROM playback_session WHERE household_id = ? AND media_id = ?', rig.householdId, rig.serial.ep02MediaId),
        '重试恰建一个后继',
      ).toBe(baseline.successorSessions + 1);
    });
  }
});

/* ------------------------------------------------------------------ */
/* G 消费后禁源与丢响应最小 cleanup(§7 I5;data-model §10)               */
/* ------------------------------------------------------------------ */

describe('T052 · G 禁源+丢响应的最小 cleanup 及重试(api.md §7 I5;data-model §10 cleanup_requested)', () => {
  it('G1 [计划内红·待 T062] consumed 后禁源:GET 失权拒绝完整结果;cleanup 最小清理(仅 outcome 键,不泄漏目标)+重试幂等+持久标记阻断 renew', async () => {
    const rig = await startNextTransitionRig('hmp-t052-g1-');
    const chain = await createPendingChain(rig);
    await stopSourceSession(rig, chain.source);
    const consumed = await postResolve(rig.app, rig.cookieA, {
      mediaId: rig.serial.ep02MediaId,
      transitionIntentId: chain.intent.id,
    });
    expect(consumed.status, redLabel('T059–T061', '201 消费(前置)', `${consumed.status}`)).toBe(201);
    const successorId = String(consumed.headers['location']).split('/').pop();
    // 消费成功后禁源(DB 直改注明;等价「来源被管理员停用」)
    disableSource(rig.sourceRowId);
    // 失权时不返回完整结果 → 客户端直接走 cleanup(api §5 GET 行;§7 I5)
    const got = await getIntent(rig.app, rig.cookieA, chain.intent.id);
    expect4xxProblem(got, '失权 GET 不返回完整 IntentReply(不借 GET 发票)');
    // 最小清理:200 {outcome} 且不返回目标 ID/元数据/位置/票据(I5)
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(
      cleanup.status,
      redLabel(
        'T062',
        `200 TransitionCleanupReply(POST ${INTENTS_URL}/:id/cleanup)`,
        `${cleanup.status} ${JSON.stringify(cleanup.body).slice(0, 160)}(路由未装配)`,
      ),
    ).toBe(200);
    expect(Object.keys(cleanup.body).sort(), 'cleanup 仅最小结果(I5 不返回目标元数据)').toEqual([...CLEANUP_REPLY_KEYS]);
    const outcome = (cleanup.body as { outcome: string }).outcome;
    expect(['cleanup_pending', 'stopped'], `consumed 分支 outcome ∈ cleanup_pending|stopped(实际 ${outcome})`).toContain(outcome);
    expect(JSON.stringify(cleanup.body), 'cleanup 响应不得泄漏目标 mediaId').not.toContain(rig.serial.ep02MediaId);
    // 持久 cleanup 标记:唯一已关联后继写 cleanup_requested(data-model §10)
    const marker = Database.db
      .prepare('SELECT cleanup_requested AS requested FROM playback_session WHERE id = ?')
      .get(successorId) as { requested: number } | undefined;
    expect(marker?.requested, '后继会话应写持久 cleanup_requested').toBe(1);
    // 标记先阻止新票/资产:renew 被拒(I5;码未钉 → 4xx 封套)
    const renew = await request(rig.app.getHttpServer())
      .post(`/api/playback/sessions/${successorId}/renew`)
      .set('Cookie', rig.cookieA)
      .send({ expectedGeneration: 1 });
    expect4xxProblem(renew, 'cleanup 标记应阻断后继 renew/新资产');
    // 响应丢失重试同入口:仍 200 最小形态(失败/重启扫描重试同语义)
    const retry = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(retry.status, redLabel('T062', '200 重试幂等', `${retry.status} ${JSON.stringify(retry.body).slice(0, 160)}`)).toBe(200);
    expect(Object.keys(retry.body).sort()).toEqual([...CLEANUP_REPLY_KEYS]);
    expect(['cleanup_pending', 'stopped']).toContain((retry.body as { outcome: string }).outcome);
  });

  it('G2 [计划内红·待 T062] pending 禁源:cleanup 取消/释放槽(outcome cancelled,不要求策略放行)+重试 already_cancelled', async () => {
    const rig = await startNextTransitionRig('hmp-t052-g2-');
    const chain = await createPendingChain(rig);
    disableSource(rig.sourceRowId);
    const cleanup = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(cleanup.status, redLabel('T062', '200 cleanup(pending 分支)', `${cleanup.status} ${JSON.stringify(cleanup.body).slice(0, 160)}`)).toBe(200);
    expect(Object.keys(cleanup.body).sort()).toEqual([...CLEANUP_REPLY_KEYS]);
    expect(cleanup.body).toEqual({ outcome: 'cancelled' });
    // 事务内 pending 则取消/释放槽(I5);策略失权不阻止最小清理
    expect(intentRowOf(rig.householdId, chain.intent.id)?.status).toBe('cancelled');
    const slot = slotRowOf(rig.householdId, chain.source.sessionId);
    expect(slot?.status).toBe('open');
    expect(slot?.slotRevision).toBe(2);
    const retry = await postCleanup(rig.app, rig.cookieA, chain.intent.id);
    expect(retry.status, redLabel('T062', '200 already_cancelled', `${retry.status} ${JSON.stringify(retry.body).slice(0, 160)}`)).toBe(200);
    expect(retry.body).toEqual({ outcome: 'already_cancelled' });
  });
});

/* ------------------------------------------------------------------ */
/* H 授权负向(窗口内绿;T059–T062 装配后自动收紧为精确码)                 */
/* ------------------------------------------------------------------ */

describe('T052 · H 授权负向(api §0/§5 同形口径;窗口内绿)', () => {
  it('H1 [绿] 游客/伪造 token:五端点封套(窗口内 Nest 404 形状,装配后 401 SESSION_INVALID);已装配 resolve 游客精确 401', async () => {
    const rig = await startNextTransitionRig('hmp-t052-h1-');
    const source = await resolveSourceSession(rig);
    const guestNextPlan = await postNextPlan(rig.app, '', {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
    });
    expectWiredOrRouteWindow(guestNextPlan, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客 next-plans');
    const guestIntent = await postIntent(rig.app, '', {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
      nextPlanRef: 'fixture-ref',
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
    });
    expectWiredOrRouteWindow(guestIntent, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客 transition-intents');
    const guestGet = await getIntent(rig.app, '', randomUUID());
    expectWiredOrRouteWindow(guestGet, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客 GET intent');
    const guestCancel = await postCancel(rig.app, '', randomUUID());
    expectWiredOrRouteWindow(guestCancel, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客 cancel');
    const guestCleanup = await postCleanup(rig.app, '', randomUUID());
    expectWiredOrRouteWindow(guestCleanup, { status: 401, code: ProblemCode.SESSION_INVALID }, '游客 cleanup');
    // 伪造 token 同形
    const forged = await postNextPlan(rig.app, `${SESSION_COOKIE}=forged-token-not-in-db`, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
    });
    expectWiredOrRouteWindow(forged, { status: 401, code: ProblemCode.SESSION_INVALID }, '伪造 token next-plans');
    // 已装配面精确绿锚点:游客 resolve → 401 SESSION_INVALID(既有语义回归)
    const guestResolve = await postResolve(rig.app, '', { mediaId: rig.serial.ep02MediaId });
    expect(guestResolve.status).toBe(401);
    expectProblemContentType(guestResolve);
    expect(guestResolve.body.code).toBe(ProblemCode.SESSION_INVALID);
  });

  it('H2 [绿] 跨设备/跨 Profile/旧 context/随机 id → 404 同形(seeded pending intent 工厂事实;I5「跨家庭/设备/Profile/旧 context 及不存在均404」)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-h2-');
    const source = await resolveSourceSession(rig);
    // DB 直改注明:pending intent+slot 行种子(等价 T060 创建后的库内归属事实)
    const intentId = seedPendingIntentWithSlot({
      householdId: rig.householdId,
      deviceSessionId: rig.deviceSessionAId,
      profileId: rig.profileAId,
      fromSessionId: source.sessionId,
      fromGeneration: source.generation,
      targetMediaId: rig.serial.ep02MediaId,
    });
    const crossDeviceFaces: request.Response[] = [
      await getIntent(rig.app, rig.cookieB, intentId),
      await postCancel(rig.app, rig.cookieB, intentId),
      await postCleanup(rig.app, rig.cookieB, intentId),
      await getIntent(rig.app, rig.cookieA, randomUUID()),
    ];
    for (const face of crossDeviceFaces) {
      expect(face.status, '跨设备/随机 id 应 404').toBe(404);
      expectProblemContentType(face);
    }
    expectSameShape(crossDeviceFaces[0]!, crossDeviceFaces[1]!, '跨设备 GET 与 cancel 同形');
    expectSameShape(crossDeviceFaces[0]!, crossDeviceFaces[3]!, '跨设备与随机 id 同形(不可判别存在性)');
    // 跨 Profile:设备B 切到新建档案B → 原 intent(档案A 归属)不可见
    const createdB = await createProfileViaSettings(rig.app, rig.cookieA, { name: '档案B', type: 'adult' });
    expect(createdB.status).toBe(201);
    const profileBId = (createdB.body as { id: string }).id;
    const selectB2 = await request(rig.app.getHttpServer())
      .post(`/api/profiles/${profileBId}/select`)
      .set('Cookie', rig.cookieB)
      .send({});
    expect(selectB2.status).toBe(200);
    const crossProfile = await getIntent(rig.app, rig.cookieB, intentId);
    expect(crossProfile.status, '跨 Profile 应 404').toBe(404);
    expectSameShape(crossDeviceFaces[0]!, crossProfile, '跨设备与跨 Profile 同形');
    // 旧 context:DB 直改注明:设备A 身份上下文推进(等价 A→B→A)→ 原 context 失配 404
    bumpDeviceContextVersion(rig.deviceSessionAId);
    const oldContext = await getIntent(rig.app, rig.cookieA, intentId);
    expect(oldContext.status, '旧 context(A→B→A)应 404').toBe(404);
    const oldContextCleanup = await postCleanup(rig.app, rig.cookieA, intentId);
    expect(oldContextCleanup.status, '旧 context cleanup 应 404(I5:context 变更后禁止调用)').toBe(404);
    expectSameShape(crossDeviceFaces[0]!, oldContext, '旧 context 与跨设备同形');
  });

  it('H3 [绿] body 伪造 profileId/householdId → 400 封套(身份只从服务端推导;窗口内 Nest 404 形状)', async () => {
    const rig = await startNextTransitionRig('hmp-t052-h3-');
    const source = await resolveSourceSession(rig);
    const forgedProfile = await postNextPlan(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
      profileId: rig.profileAId,
    });
    expectWiredOrRouteWindow(forgedProfile, { status: 400, code: ProblemCode.VALIDATION_FAILED }, '伪造 profileId next-plans');
    const forgedHousehold = await postIntent(rig.app, rig.cookieA, {
      fromSessionId: source.sessionId,
      expectedGeneration: source.generation,
      action: 'manual_next',
      nextPlanRef: 'fixture-ref',
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: randomUUID(),
      householdId: rig.householdId,
    });
    expectWiredOrRouteWindow(forgedHousehold, { status: 400, code: ProblemCode.VALIDATION_FAILED }, '伪造 householdId intent');
    // 拒绝路径零副作用
    expect(scalarOf('SELECT COUNT(*) AS n FROM playback_next_plan WHERE household_id = ?', rig.householdId), '拒绝路径不落计划').toBe(0);
    expect(scalarOf('SELECT COUNT(*) AS n FROM playback_transition_intent WHERE household_id = ?', rig.householdId), '拒绝路径不落 intent').toBe(0);
  });
});
