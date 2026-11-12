import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 引擎边界 mock(vod-autoplay/vod-resume 同款):jsdom 无媒体实现,video.js 对不可加载
 * src 会异步抛 error → onFatalError → playing→unavailable。本规格断言换源/过渡行为
 * 而非引擎行为 —— 模块边界替换 video.js 为无副作用假引擎,媒体事件由测试直接派发到
 * <video> 元素。T069 追加:假引擎记录 error 处理器(F 组媒体故障经 emitEngineFatalError
 * 直触 onFatalError,模拟流中断;videojs 包装同一 <video> 节点,语义同原生 error)。
 */
const fakePlayerState = vi.hoisted(() => ({
  /** 非 null 时 FakePlayer.play() 以该错误拒绝(NotAllowedError 自动播放拒绝) */
  rejectPlayWith: null as DOMException | null,
  /** video-player 经 player.on('error',…) 注册的致命错误处理器(F 组媒体故障触发) */
  errorHandlers: [] as Array<() => void>,
}));
vi.mock('video.js', () => {
  class FakePlayer {
    on(event: string, handler: () => void): void {
      if (event === 'error') {
        fakePlayerState.errorHandlers.push(handler);
      }
    }
    addClass(): void {}
    controls(): void {}
    src(): void {}
    play(): Promise<void> | undefined {
      if (fakePlayerState.rejectPlayWith !== null) {
        return Promise.reject(fakePlayerState.rejectPlayWith);
      }
      return undefined;
    }
    dispose(): void {}
  }
  return { default: () => new FakePlayer() };
});
import { act, fireEvent, render, screen, within, type RenderResult } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { ActionCoordinator, usePlayAction } from '../src/app/action-coordinator';
import { SessionProvider, useSession } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { PlayerView } from '../src/features/playback/player-view';
import {
  usePlaybackProgress,
  type AcceptedCheckpoint,
  type PlaybackProgressApi,
} from '../src/features/playback/use-playback-progress';
import { createQueryWrapper, createTestQueryClient } from './helpers/query-test-utils';
import type { AccountSession } from '../src/app/session-types';
import type { Vod } from '@hmp/shared';

/**
 * T069(010 US4 测试先行)—— 播放器内换源/过渡前端契约钉(vod-switch 面)。
 *
 * 覆盖 tasks.md T069 原文:pause 非接受、用更早 ledger/从头、目标历史三选一、停前
 * 失败恢复/停后不复活、取消输给消费需追查并 stop、重复 key/不同目标并发及切档旧响应。
 * 对照契约:
 * - docs/specs/010-online-vod/contracts/api.md §1(SwitchCandidate/ProbeResult/
 *   IntentReply/Materialized.candidateRef·registeredCandidateRef/TransitionCancelReply)、
 *   §5(switch/recover_switch:positionMode carry|target_history|beginning 三互斥;
 *   carry 必带 sourceCheckpoint 且事务 ledger 精确相等,否则 409 SOURCE_PROGRESS_PENDING;
 *   更早位置=显式确认已显示游标+新 operationKey+allowEarlierAcceptedPosition=true;
 *   beginning/target_history 禁止 sourceCheckpoint 与 allowEarlierAcceptedPosition 字段;
 *   ambiguous 需 confirmedAmbiguous,conflict 禁 carry;正常 switch 旧源先 stop 到 ended,
 *   stop 响应丢失先恢复状态,未确认终态不消费;取消输给消费返回 successor,协调器显式
 *   stop 不需要的后继;同 key 重放幂等不续 TTL)、§7 I1(candidateRef 物化取登记引用)、
 *   I2(暂停保存超时不自动回退,用户选明确已接受位置或从头)/I5(失权仅清理分支 cleanup)、
 *   §6(TRANSITION_SLOT_CONFLICT 恢复已有操作/slot 不能无限新建 key;recover_switch 仅
 *   媒体故障 failed 后 60s,过期明确新播放;不自动循环尝试来源);
 * - contracts/ui.md §2(内部控制子状态 idle→pausing/flushing→…→resolvingTarget;操作
 *   上下文含 uiOperationRevision,每个 await 后核对;可创建后继的旧响应必须追查/清理,
 *   不能仅丢弃)、§4(抽屉列候选,默认最多 3 候选测速,显示首响应延迟不标带宽;high 默认
 *   carry;ambiguous 具体目标+版本警告确认;conflict 不允许源位置;目标有历史三个清楚
 *   选择;停源前错误可恢复原播放,停后错误重试或重新播放,不能继续用旧 ticket;媒体故障
 *   60s recover_switch 路径,过期明确新播放;取消返回 already_consumed 等待找回后继并
 *   stop)、§5(切档/退出清个人缓存、倒计时、测速和意图;旧请求 AbortSignal 取消且结果
 *   回写带身份守卫)、§6(candidateRef 物化取得 registeredCandidateRef 再用已确认
 *   checkpoint 创建意图;pause 超时显示「等待保存/使用已确认位置/从头」;失权完整恢复
 *   失败时对已知 intent 调 cleanup,不需要后继 ID);
 * - spec.md US4 场景 1–6(候选可达性/自身已确认位置/歧义确认冲突禁携/仅投递不算已保存/
 *   停前恢复停后不复活/连点多标签取消竞争单后继)、FR-029–FR-038。
 *
 * mock 层沿用 005 T048/010 T032/T047/T063 惯例:vi.stubGlobal('fetch') 路由式 mock
 * (后注册优先)、DTO 以 @hmp/shared `Vod` 生成形状手写最小合法对象、零真实网络;
 * PlayerView 直挂(props 驱动)为主基座(候选抽屉/换源串行流),协调器完整基座
 * (SessionProvider+ActionCoordinator+MemoryRouter)承担关闭/追查/清理面(T075)与
 * recover_switch 提示面;假定时器 + awaitUi 泵送(vod-autoplay 同款)。
 *
 * ── 文件头映射表(基线 2026-10-31;T074/T075 未实现,现状无换源 UI)──
 * 现状缺位形态:换源入口/抽屉/recover 面均不存在 → UI 驱动用例在入口查询处按缺位红
 * (组件缺位形态);网络面用例同因前置 UI 缺位而红。B0/F3 钉既有 T048 泵/故障不自动
 * 循环语义,现状绿。T074/T075 落地后本文件应整体转绿(无需改动)。
 *
 * | 用例                                        | 契约锚点                                             | 现状基线     |
 * | ------------------------------------------- | ---------------------------------------------------- | ------------ |
 * | A1 换源入口→候选渲染(matchConfidence 徽标) | api.md §5/§1 SwitchCandidate、ui.md §4/FR-029        | 绿(T074) |
 * | A2 最多 3 个测速(refs 恰 3)               | api.md §5 probes 行(candidateRefs 1–3)/ui.md §4     | 绿(T074) |
 * | A3 测速延迟展示/timeout 状态                | api.md §1 ProbeResult(首响应延迟不标带宽)/ui.md §4 | 绿(T074) |
 * | A4 conflict 版本警告+carry 禁用             | api.md §5(conflict 禁 carry)/ui.md §4/FR-030       | 绿(T074) |
 * | A5 ambiguous 版本警告+确认 confirmedAmbiguous | api.md §5(ambiguous 需确认)/ui.md §4              | 绿(T074) |
 * | B0 [现状绿] pause 非接受 checkpoint 决议    | api.md §1 ProgressReply/§5(pause 非接受不作 carry 输入) | 绿(T048) |
 * | B1 carry 携带接受游标 sourceCheckpoint      | api.md §5(carry 冻结 ledger)/§7 I1                  | 绿(T074) |
 * | B2 更早游标显式确认 allowEarlierAcceptedPosition | api.md §5(更早位置=显示游标+新 key)/§7 I2       | 绿(T074) |
 * | B2b ledger 前进 409 重新展示不自动重试      | api.md §5 SOURCE_PROGRESS_PENDING/ui.md §6           | 绿(T074) |
 * | B3 从头=beginning 无 checkpoint 字段        | api.md §5(beginning 禁 checkpoint 字段)             | 绿(T074) |
 * | B4 目标历史三选一→target_history            | api.md §5(positionMode 三互斥)/ui.md §4/FR-031      | 绿(T074) |
 * | C1 串行序 pause→物化→intent→stop→resolve    | tasks.md T074/ui.md §6/§7 I1(registeredCandidateRef) | 绿(T074) |
 * | C2a 物化 410 停前恢复(源继续/零 stop)     | api.md §6 VOD_PREVIEW_EXPIRED/ui.md §4(停源前可恢复) | 绿(T074) |
 * | C2b slotRevision 冲突恢复(重读 slot 再提交)| api.md §6 TRANSITION_SLOT_CONFLICT/T075              | 绿(T074/T075)|
 * | C3 stop 响应丢失→恢复状态→确认后才 resolve  | api.md §5(未确认终态不消费)/ui.md §4                | 绿(T074) |
 * | C4 停后 resolve 失败不复活旧源              | api.md §5/ui.md §4/spec 场景 5                       | 绿(T074/T075)|
 * | D1 cancel 输给消费→追查 successor 显式 stop | api.md §5 cancel 行/ui.md §4/T075                    | 绿(T075) |
 * | D2 不同 ui 操作号并发→旧 intent 显式 cancel | api.md §5(显式 replace)/ui.md §2(不能仅丢弃)     | 绿(T075) |
 * | D3 重复 key 幂等(响应丢失同载荷重放)     | api.md §5(同 key 重放)/ui.md §2(不可变载荷)      | 绿(T074) |
 * | E1 切档旧 candidates 响应不回写不链 probe   | ui.md §5(身份守卫)/playback-state §8               | 绿(T074) |
 * | E2 旧 probes 响应不回写不推进               | ui.md §5(切档清测速)                              | 绿(T074) |
 * | E3 关闭后迟到 intent 响应必须追查清理       | ui.md §2(可创建后继的旧响应追查/清理)/T075        | 绿(T075) |
 * | F1 媒体故障 60s 内 recover 提示→recover_switch | api.md §5 recover_switch/§6/ui.md §4              | 绿(T075) |
 * | F2 60s 过期→新普通播放(resolve startMode) | api.md §6(过期明确新播放)/ui.md §4                  | 绿(T075) |
 * | F3 [现状绿] 故障后零自动循环尝试来源        | api.md §6(不自动换源)/FR-038                        | 绿           |
 *
 * ── 钉死的 T074/T075 稳定面(实现按此对齐;组件内部结构与样式不钉)──
 * - 稳定 UI 面(PlayerView 挂载的换源抽屉,「不退出播放器重搜」):
 *   - 入口:可访问名「换源」的按钮(播放面内);
 *   - 候选容器 data-testid="vod-switch-candidates";候选行 data-testid=
 *     "vod-switch-candidate"(行文本含 title 与 sourceLabel);匹配徽标 data-testid=
 *     "vod-switch-confidence"(文本为 high|ambiguous|conflict 枚举值);
 *   - 测速延迟 data-testid="vod-switch-latency"(文本含 latencyMs 数值);timeout 行
 *     文本含「超时|不可达」;
 *   - 版本警告 data-testid="vod-switch-version-warning"(文本含「版本」);
 *   - 位置选择按钮可访问名:「接当前播放位置」(carry)/「继续目标记录」(target_history)/
 *     「从头播放」(beginning);抽屉取消:「取消换源」;
 * - 串行流(T074 use-vod-transition):确认后按序 pause(POST progress reason=pause)→
 *   必要物化(POST /vod/materializations {candidateRef,previewRevision,operationKey})
 *   → intent(POST /playback/transition-intents,targetCandidateRef=物化回包
 *   registeredCandidateRef)→ stopOnce 确认(POST …/stop)→ resolve(POST /playback/
 *   resolve {mediaId,transitionIntentId},禁止 startMode 字段);
 * - recover 面(T075 协调器 unavailable 相位):60s 内可访问名匹配 /换源恢复|恢复播放/
 *   的入口;过期后由「重新播放」按钮承载新普通播放(resolve 带 startMode,不借 intent);
 * - 网络/状态钉(B/C/D/E/F 各用例内断言),operationKey 一律 UUID。
 *
 * 契约钉边界(避免过度约束):
 * - 候选选择交互(行点击/选择按钮)、三选一出 现 时机(物化前/后查询目标历史均可)不钉,
 *   只钉显式选择与提交载荷;版本警告文案只钉「版本」词面;
 * - B2 的「已确认位置」展示格式(秒/分)不钉,精确游标以 intent 载荷断言为准;
 * - C2b 的冲突恢复策略(GET 重读 slot 或 409 problem 携带 revision 后重提)不钉,只钉
 *   重试载荷 expectedSlotRevision=1 且尝试有界(不无限新建 key);
 * - D 组在协调器完整基座跑:追查/清理可落在 use-vod-transition 或 ActionCoordinator
 *   任一层(T075 两文件共同负责),本文件只钉网络副作用;
 * - F 组 60s 窗口按客户端故障时刻起算(服务端 failed+60s 为权威,UI 镜像即可),
 *   过期面的具体文案不钉,只钉「重新播放」按钮与 resolve 语义。
 */

type SwitchCandidateDto = Vod.components['schemas']['SwitchCandidate'];
type ProbeResultDto = Vod.components['schemas']['ProbeResult'];
type IntentReplyDto = Vod.components['schemas']['IntentReply'];
type MaterializedDto = Vod.components['schemas']['Materialized'];
type HistorySummaryDto = Vod.components['schemas']['HistorySummary'];
type TitleProgressDto = Vod.components['schemas']['TitleProgress'];
type VodPlaybackDto = Vod.components['schemas']['PlaybackDto'];

// ────────────────────────── 夹具(按 @hmp/shared 生成类型手写最小合法对象) ──────────────────────────

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

/** operationKey 必须为 UUID(api.md §5 IntentRequest) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sessionFixture(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    sessionId: 'web-session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: {
      id: 'profile-a',
      name: '妈妈',
      avatar: null,
      type: 'adult',
      isDefault: true,
      isMain: true,
      pinProtected: false,
      status: 'active',
      createdAt: '2026-10-26T00:00:00.000Z',
      version: 1,
    },
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
    ...overrides,
  };
}

/** 010 扩展 PlaybackDto 夹具(T003 冻结形状;与 vod-resume/vod-autoplay 同形) */
function playbackDto(overrides: Partial<VodPlaybackDto> = {}): VodPlaybackDto {
  return {
    id: 'sess-vod-1',
    state: 'ready',
    version: 1,
    generation: 1,
    desiredPaused: false,
    delivery: 'hls_proxy',
    positionSeconds: 0,
    durationSeconds: 3600,
    timelineOffsetSeconds: 0,
    presentationStartSeconds: 0,
    ticketExpiresAt: null,
    playbackUrl: null,
    tracks: { audio: [], subtitles: [] },
    startBasis: 'beginning',
    resumeDisposition: 'beginning',
    resumeReason: null,
    transitionSlot: { revision: 0, status: 'open', activeIntentId: null, successorSessionId: null },
    seekCapability: 'client',
    playbackStarted: false,
    ...overrides,
  };
}

/** SwitchCandidate 夹具(high 为默认形态;ambiguous/conflict 经 overrides 收敛) */
function switchCandidate(overrides: Partial<SwitchCandidateDto> = {}): SwitchCandidateDto {
  return {
    candidateRef: 'cand-1',
    title: '同名剧集',
    label: '第1集',
    year: '2024',
    season: null,
    versionLabel: null,
    sourceLabel: '源甲',
    lineLabel: '线路一',
    matchConfidence: 'high',
    matchReasons: [],
    previewRevision: 3,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

/** 默认世界候选集:4 候选(2 high + 1 ambiguous + 1 conflict);测速默认恰取前 3 */
const WORLD_CANDIDATES: SwitchCandidateDto[] = [
  switchCandidate({ candidateRef: 'cand-1', sourceLabel: '源甲', lineLabel: '线路一', matchConfidence: 'high' }),
  switchCandidate({ candidateRef: 'cand-2', sourceLabel: '源乙', lineLabel: '线路二', matchConfidence: 'high' }),
  switchCandidate({
    candidateRef: 'cand-3',
    sourceLabel: '源丙',
    lineLabel: '线路三',
    matchConfidence: 'ambiguous',
    year: null,
    matchReasons: ['年份缺失,版本信息不足'],
  }),
  switchCandidate({
    candidateRef: 'cand-4',
    sourceLabel: '源丁',
    lineLabel: '线路四',
    matchConfidence: 'conflict',
    versionLabel: '国语配音版',
    matchReasons: ['语言/版本明确不同'],
  }),
];

/** 候选→测速延迟(单位 ms);null=timeout(api.md §1 ProbeResult.latencyMs:number|null) */
const PROBE_LATENCY_MS: Record<string, number | null> = {
  'cand-1': 128,
  'cand-2': 256,
  'cand-3': null,
  'cand-4': 512,
};

function probeResult(overrides: Partial<ProbeResultDto> = {}): ProbeResultDto {
  return {
    candidateRef: 'cand-1',
    status: 'reachable',
    latencyMs: 128,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Materialized 夹具(I1 候选物化形态;registeredCandidateRef 为 intent 唯一合法目标) */
function materialized(overrides: Partial<MaterializedDto> = {}): MaterializedDto {
  return {
    parentMediaId: 'parent-target-1',
    mediaId: 'media-target-1',
    detailRevision: 3,
    catalogRevision: 5,
    replayed: false,
    candidateRef: 'cand-1',
    registeredCandidateRef: 'rc-1',
    ...overrides,
  };
}

/** IntentReply 夹具(switch 创建形态) */
function intentReply(overrides: Partial<IntentReplyDto> = {}): IntentReplyDto {
  return {
    id: 'intent-1',
    fromSessionId: 'sess-vod-1',
    fromGeneration: 1,
    action: 'switch',
    targetMediaId: 'media-target-1',
    positionMode: 'carry',
    matchConfidence: 'high',
    slotRevision: 1,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    successorSessionId: null,
    ...overrides,
  };
}

/** 目标未完成历史摘要(B4 三选一;target 记录形态) */
function historySummary(overrides: Partial<HistorySummaryDto> = {}): HistorySummaryDto {
  return {
    mediaId: 'media-target-1',
    parentMediaId: 'parent-target-1',
    lineLabel: '线路一',
    episodeLabel: '第1集',
    lastViewedAt: '2026-10-29T20:00:00.000Z',
    positionSeconds: 300,
    durationSeconds: 3600,
    completed: false,
    canAttemptResume: true,
    resumeReason: null,
    resumeConfidence: 'verified',
    revision: 4,
    ...overrides,
  };
}

/** TitleProgress 夹具(默认三 null;B4 注入目标 resumeCandidate) */
function titleProgress(overrides: Partial<TitleProgressDto> = {}): TitleProgressDto {
  return {
    latest: null,
    resumeCandidate: null,
    nextEpisodeAction: null,
    ...overrides,
  };
}

// ────────────────────────── fetch mock 布线(005 T048 路由式惯例) ──────────────────────────

let fetchMock: Mock;
type MockRoute = (method: string, path: string, body: unknown) => Response | Promise<Response> | null;
let routes: MockRoute[];

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recorded(): RecordedCall[] {
  return (fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit | undefined]>).map(([input, init]) => ({
    url: String(input),
    init: init ?? {},
  }));
}

function bodiesEndingWith(suffix: string): Array<Record<string, unknown>> {
  return recorded()
    .filter((call) => call.url.endsWith(suffix) && typeof call.init.body === 'string')
    .map((call) => JSON.parse(call.init.body as string) as Record<string, unknown>);
}

const switchCandidateCalls = (): RecordedCall[] => recorded().filter((call) => call.url.includes('/vod/switch-candidates'));
const switchProbeRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/vod/switch-probes');
const materializationRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/vod/materializations');
const intentRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/playback/transition-intents');
const resolveBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/playback/resolve');

/** 过渡消费(带 transitionIntentId;与普通播放 resolve 区分——协调器基座起播本身有一次基础 resolve) */
function transitionResolveBodies(): Array<Record<string, unknown>> {
  return resolveBodies().filter((body) => 'transitionIntentId' in body);
}

const progressBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/progress');

function cancelCalls(): RecordedCall[] {
  return recorded().filter((call) => /\/playback\/transition-intents\/[^/]+\/cancel$/.test(call.url));
}

function cleanupCalls(): RecordedCall[] {
  return recorded().filter((call) => /\/playback\/transition-intents\/[^/]+\/cleanup$/.test(call.url));
}

function stopCallsFor(sessionId: string): RecordedCall[] {
  return recorded().filter((call) => call.url.endsWith(`/playback/sessions/${sessionId}/stop`));
}

type RouteHandler = (body: unknown, path: string) => Response | Promise<Response>;

/** 后注册优先:用例级覆盖压过世界级缺省(vod-autoplay 同款) */
function when(method: string, pathPattern: RegExp, handler: RouteHandler): void {
  routes.unshift((reqMethod, path, reqBody) => {
    if (reqMethod !== method || !pathPattern.test(path)) {
      return null as unknown as Response;
    }
    return handler(reqBody, path);
  });
}

/** 手动决议的响应闸门(在途/迟到响应编排;忽略 abort 模拟「服务端已受理」的竞态) */
interface ResponseGate {
  readonly promise: Promise<Response>;
  release: (response: Response) => void;
}

function gatedResponse(): ResponseGate {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** 默认世界:已选档会话 + sess-vod-1 播放全链 + 候选/测速/物化/intent/取消换源链;
 *  后继会话 sess-next-1 全链;未命中 404 problem。 */
function installDefaultWorld(): void {
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  // 通用会话控制面(任意会话;用例级覆盖压过)
  when('POST', /\/playback\/sessions\/[^/]+\/renew$/, () =>
    jsonResponse({
      playbackUrl: '/api/playback/stream/sess-vod-1/1/index?ticket=t',
      ticketExpiresAt: '2026-11-26T00:00:00.000Z',
      generation: 1,
    }),
  );
  when('POST', /\/playback\/sessions\/[^/]+\/progress$/, (body) => {
    // 回显服务端接受游标:acceptedSampleSeq=收到样本 seq(carry checkpoint 确定性)
    const sample = (body ?? {}) as { sampleSeq?: unknown; expectedGeneration?: unknown; positionSeconds?: unknown };
    return jsonResponse({
      applied: true,
      reason: 'accepted',
      historyRevision: 4,
      sessionAccepted: true,
      acceptedSampleSeq: typeof sample.sampleSeq === 'number' ? sample.sampleSeq : 1,
      acceptedPositionSeconds: typeof sample.positionSeconds === 'number' ? sample.positionSeconds : 0,
      acceptedGeneration: typeof sample.expectedGeneration === 'number' ? sample.expectedGeneration : 1,
      sessionStarted: true,
    });
  });
  when('POST', /\/playback\/sessions\/[^/]+\/observations$/, () =>
    jsonResponse({ accepted: true, lastEventSeq: 1, playbackStarted: true }),
  );
  when('POST', /\/playback\/sessions\/[^/]+\/heartbeat$/, () => new Response(null, { status: 204 }));
  when('POST', /\/playback\/sessions\/[^/]+\/stop$/, () => new Response(null, { status: 204 }));
  // 播放 resolve(010 T075 基座修正:有状态 stub)—— 首次=基础起播,返回源会话
  // sess-vod-1;其后=过渡消费,返回后继 sess-next-1(preparing,协调器基座按既有
  // prepare 链续跑)。原无状态 stub 把 id 覆写为 sess-next-1,使基础起播会话=后继
  // 会话,D1 的停源闸门(sess-vod-1/stop)与 F1 的 fromSessionId 钉面结构上不可达
  // (已实测:协调器基座播放会话=sess-next-1,换源 stop 打到 sess-next-1/stop)。
  let resolveCalls = 0;
  when('POST', /\/playback\/resolve$/, () => {
    resolveCalls += 1;
    const id = resolveCalls === 1 ? 'sess-vod-1' : 'sess-next-1';
    return jsonResponse(playbackDto({ id, state: 'preparing', ticketExpiresAt: null, playbackUrl: null }), 201, {
      Location: `/api/playback/sessions/${id}`,
    });
  });
  when('GET', /\/playback\/sessions\/sess-vod-1$/, () => jsonResponse(playbackDto({ state: 'ready' })));
  when('GET', /\/playback\/sessions\/sess-next-1$/, () => jsonResponse(playbackDto({ id: 'sess-next-1', state: 'ready' })));
  // 换源链(api.md §5)
  // 契约裁决(lead,2026-10-31):mock 正则须兼容查询参数(服务端契约 required
  // fromSessionId/expectedGeneration;实现按契约带 query,原 $ 死锚定使带参请求 404)。
  when('GET', /\/vod\/switch-candidates(?:\?.*)?$/, () =>
    jsonResponse({ items: WORLD_CANDIDATES, nextCursor: null, partial: false, reasons: [] }),
  );
  when('POST', /\/vod\/switch-probes$/, (body) => {
    const request = (body ?? {}) as { candidateRefs?: unknown };
    const refs = Array.isArray(request.candidateRefs) ? (request.candidateRefs as string[]) : [];
    return jsonResponse({
      items: refs.map((ref) =>
        probeResult({
          candidateRef: ref,
          status: PROBE_LATENCY_MS[ref] === null ? 'timeout' : 'reachable',
          latencyMs: PROBE_LATENCY_MS[ref] ?? null,
        }),
      ),
    });
  });
  when('POST', /\/vod\/materializations$/, (body) => {
    // I1 候选物化:cand-N → 登记引用 rc-N(intent 只接受已登记目标的候选映射)
    const request = (body ?? {}) as { candidateRef?: unknown };
    const ref = typeof request.candidateRef === 'string' ? request.candidateRef : '';
    const ordinal = ref.slice(-1);
    return jsonResponse(
      materialized({ candidateRef: ref === '' ? null : ref, registeredCandidateRef: `rc-${ordinal}` }),
      201,
    );
  });
  when('GET', /\/me\/vod\/titles\/parent-target-1\/progress$/, () => jsonResponse(titleProgress()));
  when('POST', /\/playback\/transition-intents$/, () => jsonResponse(intentReply(), 201));
}

// ────────────────────────── 渲染基座 ──────────────────────────

let terminated: Mock;

function getVideo(): HTMLVideoElement {
  const el = document.querySelector('video');
  expect(el).not.toBeNull();
  return el as HTMLVideoElement;
}

/** PlayerView 直挂(props 驱动;票据远期避免续期定时器干扰;fake timers 下心跳可控) */
function renderPlayerView(
  props: { readonly sessionId?: string } = {},
): RenderResult {
  const sessionId = props.sessionId ?? 'sess-vod-1';
  return render(
    <PlayerView
      sessionId={sessionId}
      generation={1}
      playbackUrl={`/api/playback/stream/${sessionId}/1/index?ticket=t`}
      ticketExpiresAt="2026-11-26T00:00:00.000Z"
      delivery="hls_proxy"
      durationSeconds={3600}
      onTerminated={terminated}
      onRenew={() => undefined}
    />,
  );
}

/** 播放意图观察面(vod-autoplay 同款探针):播放入口 + 当前阶段 */
function PlayProbe(): ReactNode {
  const { play, playback } = usePlayAction();
  const sessionStatus = useSession().status;
  return (
    <div>
      <span data-testid="session-status">{sessionStatus}</span>
      <span data-testid="phase">{playback?.phase ?? '-'}</span>
      <button type="button" data-testid="play-a" onClick={() => play({ mediaId: 'media-1', title: '例牌单集' })}>
        play-a
      </button>
    </div>
  );
}

/** 协调器完整基座(D/E3/F 组:关闭追查、迟到响应清理、recover 面挂在播放相位面) */
function renderCoordinatorProbe(): void {
  const client = createTestQueryClient();
  render(
    <MemoryRouter initialEntries={['/vod']}>
      <SessionProvider>
        <SettingsAccessProvider>
          <ActionCoordinator>
            <PlayProbe />
          </ActionCoordinator>
        </SettingsAccessProvider>
      </SessionProvider>
    </MemoryRouter>,
    { wrapper: createQueryWrapper(client) },
  );
}

/** B0 泵探针:直挂 usePlaybackProgress(pause 非接受 checkpoint 决议面) */
let progressApi: PlaybackProgressApi | null = null;
function ProgressProbe(): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  progressApi = usePlaybackProgress({ sessionId: 'sess-vod-1', generation: 1, videoRef });
  return <video ref={videoRef} data-testid="probe-video" />;
}

// ────────────────────────── 假定时器/媒体事件/断言助手(vod-autoplay 同款) ──────────────────────────

async function pumpTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * 假定时器下的 UI 就绪等待:反复泵送 50ms 直至断言通过或预算耗尽
 * (耗尽后重新执行 read 抛出真实断言错误;testing-library waitFor 不适配假定时器)。
 */
async function awaitUi(read: () => void, budgetMs = 3_000): Promise<void> {
  let waited = 0;
  for (;;) {
    try {
      read();
      return;
    } catch {
      // 未就绪:泵送假定时器后重试,直至预算耗尽
    }
    if (waited >= budgetMs) {
      read();
    }
    await pumpTimers(50);
    waited += 50;
  }
}

/** 实际 playing 观测(泵 started 门的唯一触发;T048 语义) */
async function startPlayback(positionSeconds: number): Promise<void> {
  const videoEl = getVideo();
  videoEl.currentTime = positionSeconds;
  await act(async () => {
    videoEl.dispatchEvent(new Event('playing'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** 媒体故障(假引擎 error 处理器直触 onFatalError;F 组 recover_switch 准时源) */
function emitEngineFatalError(): void {
  const handlers = fakePlayerState.errorHandlers.splice(0, fakePlayerState.errorHandlers.length);
  for (const handler of handlers) {
    handler();
  }
}

/** 契约断言消息(T074/T075 未落地;保留契约锚点,便于缺位红定位应然形态) */
function contractNote(current: string, target: string): string {
  return `${current} —— 依契约应 ${target}`;
}

/** 打开换源抽屉并等待候选渲染(缺位形态:入口不存在 → 红在入口查询) */
async function openSwitchDrawer(): Promise<void> {
  // 换源入口已收敛到「播放设置」面板内(控制栏只保留高频道具):
  // 先开设置,再点其中的「换源」
  fireEvent.click(screen.getByRole('button', { name: '播放设置' }));
  await awaitUi(
    () =>
      expect(
        screen.getByRole('button', { name: '换源' }),
        contractNote('播放面无换源入口', 'T074 vod-source-switcher 挂载 PlayerView,入口可访问名「换源」'),
      ).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: '换源' }));
  await awaitUi(
    () =>
      expect(
        screen.getByTestId('vod-switch-candidates'),
        contractNote('换源抽屉未出现', 'ui.md §4 播放器内抽屉列当前线路/跨源候选'),
      ).toBeInTheDocument(),
  );
}

/** 按标题+来源定位候选行 */
function candidateRow(title: string, sourceLabel: string): HTMLElement {
  const rows = screen.getAllByTestId('vod-switch-candidate');
  const row = rows.find(
    (el) => (el.textContent ?? '').includes(title) && (el.textContent ?? '').includes(sourceLabel),
  );
  if (row === undefined) {
    throw new Error(`候选行未渲染:${title}/${sourceLabel}`);
  }
  return row;
}

/** 选择候选(行点击;交互形态不钉,行可点即算选择) */
async function selectCandidate(title: string, sourceLabel: string): Promise<void> {
  await awaitUi(() => expect(screen.getAllByTestId('vod-switch-candidate').length).toBeGreaterThan(0));
  fireEvent.click(candidateRow(title, sourceLabel));
}

// ────────────────────────── 调用序断言助手(C 组串行流) ──────────────────────────

function isPauseProgress(call: RecordedCall): boolean {
  if (!call.url.endsWith('/progress') || typeof call.init.body !== 'string') {
    return false;
  }
  return (JSON.parse(call.init.body) as { reason?: string }).reason === 'pause';
}

function firstIndex(match: (call: RecordedCall) => boolean, label: string): number {
  const index = recorded().findIndex(match);
  if (index < 0) {
    throw new Error(`预期调用未发生:${label}`);
  }
  return index;
}

beforeEach(() => {
  fetchMock = vi.fn();
  routes = [];
  terminated = vi.fn();
  fakePlayerState.errorHandlers.length = 0;
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = String(input);
    for (const route of routes) {
      const matched = await route(method, url, init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      if (matched !== null && matched !== undefined) {
        return matched;
      }
    }
    return problemResponse(404, 'NOT_FOUND');
  });
  installDefaultWorld();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fakePlayerState.rejectPlayWith = null;
  progressApi = null;
});

// ────────────────────────── A · 候选与测速(→T074) ──────────────────────────

describe('010 T069 · A 候选与测速(→T074)', () => {
  it('A1 换源入口→GET switch-candidates(fromSessionId/expectedGeneration)→候选渲染含 matchConfidence 徽标,不暴露地址', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    // 查询参数契约(api.md §5:写参数经 query,fromSessionId+expectedGeneration 必带)
    await awaitUi(() => expect(switchCandidateCalls().length).toBeGreaterThanOrEqual(1));
    const candidateCall = switchCandidateCalls()[0];
    if (candidateCall === undefined) {
      throw new Error('switch-candidates 调用未记录');
    }
    const requestUrl = new URL(candidateCall.url, 'http://localhost');
    expect(requestUrl.searchParams.get('fromSessionId')).toBe('sess-vod-1');
    expect(requestUrl.searchParams.get('expectedGeneration')).toBe('1');
    // 候选渲染:标题/来源可辨,matchConfidence 徽标为枚举值
    await awaitUi(() => expect(screen.getAllByTestId('vod-switch-candidate')).toHaveLength(4));
    const first = candidateRow('同名剧集', '源甲');
    expect(within(first).getByTestId('vod-switch-confidence').textContent).toBe('high');
    const third = candidateRow('同名剧集', '源丙');
    expect(within(third).getByTestId('vod-switch-confidence').textContent).toBe('ambiguous');
    const fourth = candidateRow('同名剧集', '源丁');
    expect(within(fourth).getByTestId('vod-switch-confidence').textContent).toBe('conflict');
    // 不暴露地址(FR-029/spec 场景 1:候选只元数据,source 内部 ID/位置不下发)
    const drawerText = screen.getByTestId('vod-switch-candidates').textContent ?? '';
    expect(drawerText).not.toMatch(/https?:\/\//);
    expect(drawerText).not.toMatch(/\.m3u8|\.mp4/);
  });

  it('A2 默认最多 3 个候选测速:恰一次 POST switch-probes 且 candidateRefs 恰 3 个不重复', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    // 默认测速(ui.md §4「默认最多3候选测速」):单次请求 refs 1–3
    await awaitUi(() => expect(switchProbeRequests().length).toBeGreaterThanOrEqual(1));
    await pumpTimers(1_000);
    expect(switchProbeRequests(), contractNote('测速请求不收敛', '默认最多 3 候选一次测速')).toHaveLength(1);
    const probe = switchProbeRequests()[0];
    expect(probe?.fromSessionId).toBe('sess-vod-1');
    expect(probe?.expectedGeneration).toBe(1);
    const refs = probe?.candidateRefs;
    expect(Array.isArray(refs)).toBe(true);
    expect(refs as string[]).toHaveLength(3);
    expect(new Set(refs as string[]).size).toBe(3);
    for (const ref of refs as string[]) {
      expect(WORLD_CANDIDATES.some((candidate) => candidate.candidateRef === ref)).toBe(true);
    }
  });

  it('A3 测速结果展示首响应延迟(ms);timeout 候选展示不可达态而非延迟', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await awaitUi(() => expect(switchProbeRequests()).toHaveLength(1));
    // 可达候选:显示首响应延迟数值(api.md §1 ProbeResult.latencyMs;ui.md §4 不标带宽)
    await awaitUi(() => {
      const first = candidateRow('同名剧集', '源甲');
      expect(within(first).getByTestId('vod-switch-latency').textContent).toContain('128');
    });
    const second = candidateRow('同名剧集', '源乙');
    expect(within(second).getByTestId('vod-switch-latency').textContent).toContain('256');
    // timeout 候选:不可达状态文字,不显示延迟数字
    const third = candidateRow('同名剧集', '源丙');
    expect(third.textContent).toMatch(/超时|不可达/);
  });

  it('A4 conflict 候选:版本警告展示且 carry 按钮禁用;从头仍可选', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源丁');
    // 版本警告(api.md §5 conflict 禁 carry;ui.md §4 版本警告)
    await awaitUi(() =>
      expect(
        screen.getByTestId('vod-switch-version-warning'),
        contractNote('conflict 候选无版本警告', 'ui.md §4 conflict 不允许源位置并展示版本警告'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('vod-switch-version-warning').textContent).toContain('版本');
    const carryButton = screen.getByRole('button', { name: '接当前播放位置' });
    expect(carryButton, contractNote('conflict 候选 carry 未禁用', 'api.md §5 conflict 不能继承源位置')).toBeDisabled();
    // 从头出路保留
    expect(screen.getByRole('button', { name: '从头播放' })).toBeEnabled();
  });

  it('A5 ambiguous 候选:版本警告展示;显式确认携带位置→intent confirmedAmbiguous=true', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源丙');
    await awaitUi(() => expect(screen.getByTestId('vod-switch-version-warning')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() => expect(intentRequests(), 'ambiguous carry 未建意图').toHaveLength(1));
    const intent = intentRequests()[0];
    expect(
      intent?.confirmedAmbiguous,
      contractNote('ambiguous carry 未确认', 'api.md §5 ambiguous 需 confirmedAmbiguous=true 且具体候选集'),
    ).toBe(true);
    // I1:intent 目标=登记引用(materializations 回包 registeredCandidateRef),非原始 candidateRef
    expect(intent?.targetCandidateRef).toBe('rc-3');
  });
});

// ────────────────────────── B · checkpoint(T048 泵绿钉 + →T074) ──────────────────────────

describe('010 T069 · B checkpoint(pause 游标语义)', () => {
  it('B0 [现状绿] pause 非接受:pauseAndFlush 决议 sessionAccepted=false + 服务端最后接受游标,不虚构成已接受(T048 泵钉面)', async () => {
    vi.useFakeTimers();
    render(<ProgressProbe />);
    const videoEl = screen.getByTestId('probe-video') as HTMLVideoElement;
    videoEl.currentTime = 5;
    await act(async () => {
      videoEl.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(progressApi?.startedAcked).toBe(true);
    // stale 形态:2xx 但 sessionAccepted=false,服务端下发最后接受游标(api.md §1)
    when('POST', /\/playback\/sessions\/sess-vod-1\/progress$/, () =>
      jsonResponse({
        applied: false,
        reason: 'stale_sample',
        historyRevision: null,
        sessionAccepted: false,
        acceptedSampleSeq: 7,
        acceptedPositionSeconds: 42,
        acceptedGeneration: 1,
        sessionStarted: false,
      }),
    );
    let checkpoint: AcceptedCheckpoint | null = null;
    await act(async () => {
      checkpoint = (await progressApi?.pauseAndFlush()) ?? null;
    });
    // 仅投递成功不等于接受(spec 场景 4):pause 决议必须暴露非接受事实+服务端游标,
    // T074 据此分支(不得把该 checkpoint 当 carry 输入)
    expect(checkpoint).toEqual({
      sessionAccepted: false,
      acceptedSampleSeq: 7,
      acceptedPositionSeconds: 42,
      acceptedGeneration: 1,
    });
  });

  it('B1 [T074] 继续当前位置(carry):pause 接受→intent 携带 sourceCheckpoint{generation,sampleSeq=接受 seq} 全形', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() => expect(intentRequests(), contractNote('carry 未建意图', 'ui.md §6 确认 checkpoint 后创建意图')).toHaveLength(1));
    // started(seq1) 已接受;pause(seq2) 接受游标=2 → sourceCheckpoint 精确冻结
    expect(intentRequests()[0]).toEqual({
      fromSessionId: 'sess-vod-1',
      expectedGeneration: 1,
      action: 'switch',
      targetCandidateRef: 'rc-1',
      previewRevision: 3,
      positionMode: 'carry',
      confirmedAmbiguous: false,
      sourceCheckpoint: { expectedGeneration: 1, sampleSeq: 2 },
      expectedSlotRevision: 0,
      operationKey: expect.any(String),
    });
    expect(UUID_PATTERN.test(String(intentRequests()[0]?.operationKey)), 'operationKey 必须为 UUID').toBe(true);
  });

  it('B2 [T074] pause 非接受:不自动 carry;显式确认已显示游标→新 key+该游标+allowEarlierAcceptedPosition=true', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    // pause 返回 stale(sessionAccepted=false,服务端最后接受游标 seq=7/42s)
    when('POST', /\/playback\/sessions\/sess-vod-1\/progress$/, () =>
      jsonResponse({
        applied: false,
        reason: 'stale_sample',
        historyRevision: null,
        sessionAccepted: false,
        acceptedSampleSeq: 7,
        acceptedPositionSeconds: 42,
        acceptedGeneration: 1,
        sessionStarted: true,
      }),
    );
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    // 非接受 checkpoint 不得直接作为 carry 提交:必须出现显式选择面(ui.md §6「使用已确认位置」)
    await awaitUi(() =>
      expect(
        screen.getByRole('button', { name: /使用已确认位置/ }),
        contractNote('pause 非接受仍直接 carry', 'api.md §5 未接受样本不作为 checkpoint;ui.md §6 暂停超时三出路'),
      ).toBeInTheDocument(),
    );
    await pumpTimers(1_000);
    expect(intentRequests(), '非接受 checkpoint 被静默提交').toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /使用已确认位置/ }));
    await awaitUi(() => expect(intentRequests()).toHaveLength(1));
    const intent = intentRequests()[0];
    expect(intent?.positionMode).toBe('carry');
    expect(intent?.sourceCheckpoint).toEqual({ expectedGeneration: 1, sampleSeq: 7 });
    expect(
      intent?.allowEarlierAcceptedPosition,
      contractNote('更早游标缺显式标记', 'api.md §5 更早位置须 allowEarlierAcceptedPosition=true'),
    ).toBe(true);
    expect(UUID_PATTERN.test(String(intent?.operationKey))).toBe(true);
    // 同面提供从头出路(I2:不自动回退,用户选明确位置或从头)
    expect(screen.getByRole('button', { name: '从头播放' })).toBeInTheDocument();
  });

  it('B2b [T074] carry 撞 409 SOURCE_PROGRESS_PENDING(ledger 前进):重新展示选择面,不自动重试旧游标', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    when('POST', /\/playback\/transition-intents$/, () => problemResponse(409, 'SOURCE_PROGRESS_PENDING'));
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() => expect(intentRequests()).toHaveLength(1));
    // 409 后:重新展示「等待保存/使用已确认位置/从头」,不静默换游标重试(api.md §5「重新展示/确认」)
    await awaitUi(() =>
      expect(
        screen.getByRole('button', { name: /使用已确认位置/ }),
        contractNote('409 后无重新选择面', 'SOURCE_PROGRESS_PENDING → 重新展示/确认,不自动挑另一个位置'),
      ).toBeInTheDocument(),
    );
    await pumpTimers(2_000);
    expect(intentRequests(), contractNote('409 后自动重试', 'ledger 前进须用户重新确认')).toHaveLength(1);
  });

  it('B3 [T074] 从头(beginning):intent 严格缺省 sourceCheckpoint 与 allowEarlierAcceptedPosition 字段', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '从头播放' }));
    await awaitUi(() => expect(intentRequests(), contractNote('从头未建意图', '选择即 positionMode')).toHaveLength(1));
    const intent = intentRequests()[0];
    expect(intent?.positionMode).toBe('beginning');
    expect(intent?.action).toBe('switch');
    expect(intent?.targetCandidateRef).toBe('rc-1');
    expect(
      Object.prototype.hasOwnProperty.call(intent, 'sourceCheckpoint'),
      contractNote('beginning 携带 checkpoint', 'api.md §5 beginning/target_history 禁止 sourceCheckpoint 字段'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(intent, 'allowEarlierAcceptedPosition'),
      'beginning 携带 allowEarlierAcceptedPosition',
    ).toBe(false);
  });

  it('B4 [T074] 目标有自己的历史:三选一(接当前播放位置/继续目标记录/从头);继续目标记录→target_history 且无 checkpoint', async () => {
    vi.useFakeTimers();
    when('GET', /\/me\/vod\/titles\/parent-target-1\/progress$/, () =>
      jsonResponse(titleProgress({ latest: historySummary(), resumeCandidate: historySummary() })),
    );
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    // 三个清楚选择(ui.md §4);出现时机(物化前后查询目标历史)不钉
    await awaitUi(() => {
      expect(screen.getByRole('button', { name: '接当前播放位置' }), contractNote('缺 carry 选项', 'ui.md §4 三选一')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '继续目标记录' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '从头播放' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '继续目标记录' }));
    await awaitUi(() => expect(intentRequests()).toHaveLength(1));
    const intent = intentRequests()[0];
    expect(intent?.positionMode, contractNote('目标记录选择未映射 target_history', 'api.md §5 选择即 positionMode')).toBe('target_history');
    expect(Object.prototype.hasOwnProperty.call(intent, 'sourceCheckpoint')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(intent, 'allowEarlierAcceptedPosition')).toBe(false);
  });
});

// ────────────────────────── C · 串行流与失败恢复(→T074) ──────────────────────────

describe('010 T069 · C 串行流:暂停确认→物化→intent→stopOnce→resolve(→T074)', () => {
  it('C1 串行序:pause→物化(candidateRef/previewRevision/UUID)→intent(registeredCandidateRef)→stopOnce 确认→resolve(无 startMode)', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(
      () => expect(transitionResolveBodies(), contractNote('串行流未走完', 'T074 intent→stopOnce 确认→resolve')).toHaveLength(1),
    );
    // 严格相对顺序(tasks.md T074:串行暂停确认→必要物化→intent→stopOnce 确认→resolve)
    const pauseIdx = firstIndex(isPauseProgress, 'pause 样本');
    const materializeIdx = firstIndex((call) => call.url.endsWith('/vod/materializations'), '物化');
    const intentIdx = firstIndex((call) => call.url.endsWith('/playback/transition-intents'), 'intent');
    const stopIdx = firstIndex((call) => call.url.endsWith('/playback/sessions/sess-vod-1/stop'), 'stopOnce');
    const resolveIdx = firstIndex((call) => call.url.endsWith('/playback/resolve'), 'resolve');
    expect(pauseIdx, 'pause 必须先于物化').toBeLessThan(materializeIdx);
    expect(materializeIdx, '物化必须先于 intent').toBeLessThan(intentIdx);
    expect(intentIdx, 'intent 必须先于 stop').toBeLessThan(stopIdx);
    expect(stopIdx, 'stop 必须先于 resolve(正常 switch 旧源先 stop 到 ended)').toBeLessThan(resolveIdx);
    // 物化请求:I1 候选分支(candidateRef+previewRevision+UUID key)
    const materialization = materializationRequests()[0];
    expect(materialization).toEqual({
      candidateRef: 'cand-1',
      previewRevision: 3,
      operationKey: expect.any(String),
    });
    expect(UUID_PATTERN.test(String(materialization?.operationKey))).toBe(true);
    // intent 目标=登记引用 registeredCandidateRef(§7 I1),不是原始 candidateRef
    expect(intentRequests()[0]?.targetCandidateRef, contractNote('intent 使用原始 candidateRef', 'api.md §7 I1 intent 只接受已登记映射引用')).toBe('rc-1');
    // 消费请求:严格 {mediaId,transitionIntentId},禁止 startMode 混入(VodResolveTransitionRequest)
    expect(transitionResolveBodies()[0]).toEqual({ mediaId: 'media-target-1', transitionIntentId: 'intent-1' });
  });

  it('C2a 物化 410(VOD_PREVIEW_EXPIRED):停源前失败可恢复——零 stop/零 resolve,源会话继续存活,展示可恢复错误', async () => {
    vi.useFakeTimers();
    when('POST', /\/vod\/materializations$/, () => problemResponse(410, 'VOD_PREVIEW_EXPIRED'));
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() =>
      expect(
        screen.getAllByRole('alert').some((el) => /重新选择|重试|稍后|失败|过期/.test(el.textContent ?? '')),
        contractNote('物化失败无用户可见恢复面', 'ui.md §4 停源前错误可恢复原播放'),
      ).toBe(true),
    );
    await pumpTimers(2_000);
    expect(stopCallsFor('sess-vod-1'), contractNote('停源前失败仍 stop 旧源', 'spec 场景 5 停前失败可恢复原播放')).toHaveLength(0);
    expect(resolveBodies()).toHaveLength(0);
    // 源播放不被中断:周期样本继续(periodic 数量随时间增长)
    const periodicsBefore = progressBodies().filter((body) => body.reason === 'periodic').length;
    await pumpTimers(11_000);
    const periodicsAfter = progressBodies().filter((body) => body.reason === 'periodic').length;
    expect(periodicsAfter, '停源前失败不得中断源播放').toBeGreaterThan(periodicsBefore);
  });

  it('C2b slotRevision 冲突(409 TRANSITION_SLOT_CONFLICT):恢复读取新 revision→以 expectedSlotRevision=1 重提,尝试有界', async () => {
    vi.useFakeTimers();
    // 挂载时 slot revision=0;此后他端占用 slot → 重读得到 revision=1
    let statusGets = 0;
    when('GET', /\/playback\/sessions\/sess-vod-1$/, () => {
      statusGets += 1;
      const slot =
        statusGets === 1
          ? { revision: 0, status: 'open' as const, activeIntentId: null, successorSessionId: null }
          : { revision: 1, status: 'reserved' as const, activeIntentId: 'intent-stale', successorSessionId: null };
      return jsonResponse(playbackDto({ transitionSlot: slot }));
    });
    let intentAttempts = 0;
    when('POST', /\/playback\/transition-intents$/, () => {
      intentAttempts += 1;
      if (intentAttempts === 1) {
        return problemResponse(409, 'TRANSITION_SLOT_CONFLICT');
      }
      return jsonResponse(intentReply({ id: `intent-${intentAttempts}`, slotRevision: intentAttempts }), 201);
    });
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    // 冲突后恢复(api.md §6:恢复已有操作/slot,不能无限新建 key)
    await awaitUi(() => expect(intentAttempts, contractNote('409 后未恢复重试', 'TRANSITION_SLOT_CONFLICT → 恢复 slot')).toBeGreaterThanOrEqual(2));
    await pumpTimers(2_000);
    expect(intentAttempts, contractNote('冲突恢复无限循环', '不能无限新建 key')).toBeLessThanOrEqual(3);
    const retries = intentRequests();
    expect(retries.length).toBeGreaterThanOrEqual(2);
    const first = retries[0];
    const second = retries[1];
    expect(first?.expectedSlotRevision).toBe(0);
    expect(second?.expectedSlotRevision, contractNote('重提未更新 slot revision', '恢复后按新 revision 显式提交')).toBe(1);
    expect(second?.operationKey).not.toBe(first?.operationKey);
  });

  it('C3 stop 响应丢失:先恢复状态(GET 会话),未确认终态不消费;终态确认后恰一次 resolve', async () => {
    vi.useFakeTimers();
    let stopAttempts = 0;
    when('POST', /\/playback\/sessions\/sess-vod-1\/stop$/, () => {
      stopAttempts += 1;
      if (stopAttempts === 1) {
        throw new TypeError('network lost');
      }
      return new Response(null, { status: 204 });
    });
    when('GET', /\/playback\/sessions\/sess-vod-1$/, () =>
      jsonResponse(playbackDto({ state: stopAttempts > 0 ? 'ended' : 'ready' })),
    );
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() =>
      expect(transitionResolveBodies(), contractNote('stop 丢失后直接消费', 'api.md §5 未确认终态不消费')).toHaveLength(1),
      5_000,
    );
    // 顺序:失败的 stop < 恢复状态读(GET) < resolve
    const failedStopIdx = firstIndex((call) => call.url.endsWith('/playback/sessions/sess-vod-1/stop'), 'stop');
    const recoveryGets = recorded()
      .map((call, index) => ({ call, index }))
      .filter(
        (entry) =>
          entry.index > failedStopIdx &&
          /\/playback\/sessions\/sess-vod-1$/.test(entry.call.url),
      );
    expect(recoveryGets.length, contractNote('stop 丢失后未恢复状态', 'api.md §5 stop 响应丢失先恢复状态')).toBeGreaterThanOrEqual(1);
    const resolveIdx = firstIndex((call) => call.url.endsWith('/playback/resolve'), 'resolve');
    expect(recoveryGets[0]?.index, '恢复状态读必须先于消费').toBeLessThan(resolveIdx);
    expect(transitionResolveBodies(), '终态确认后恰一次消费').toHaveLength(1);
  });

  it('C4 停后 resolve 失败:不复活旧播放(零 renew/零二次 resolve),失败面提供重试或重新播放出路', async () => {
    vi.useFakeTimers();
    when('POST', /\/playback\/resolve$/, () => problemResponse(409, 'TRANSITION_SLOT_CONFLICT'));
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    // stop 已成功(源已 ended)后 resolve 失败:失败面可见(ui.md §4 停后错误显示重试或重新播放)
    await awaitUi(() =>
      expect(
        screen.getAllByRole('alert').some((el) => /重试|重新播放|失败/.test(el.textContent ?? '')),
        contractNote('停后失败无出路面', 'ui.md §4 停后错误显示重试或重新播放原源'),
      ).toBe(true),
      5_000,
    );
    await pumpTimers(3_000);
    // 不复活旧播放(spec 场景 5):不借旧票续期、不自动以普通 resolve 重放旧源、不二次消费
    expect(recorded().filter((call) => call.url.endsWith('/playback/sessions/sess-vod-1/renew')), '停后不得复活旧票').toHaveLength(0);
    const resolves = transitionResolveBodies();
    expect(resolves).toHaveLength(1);
    expect(stopCallsFor('sess-vod-1').length).toBeGreaterThanOrEqual(1);
  });
});

// ────────────────────────── D · 竞争:取消/并发/幂等(→T075) ──────────────────────────

describe('010 T069 · D 竞争:取消输家追查/并发操作号/重复 key(→T075)', () => {
  it('D1 cancel 输给消费(already_consumed+successor):追查后继并显式 stop,不静默丢弃', async () => {
    vi.useFakeTimers();
    // 换源流进行到 stop 在途时用户取消;服务端裁决:他端消费已赢 → 返回后继引用
    const stopGate = gatedResponse();
    when('POST', /\/playback\/sessions\/sess-vod-1\/stop$/, () => stopGate.promise);
    when('POST', /\/playback\/transition-intents\/[^/]+\/cancel$/, () =>
      jsonResponse({ outcome: 'already_consumed', successorSessionId: 'sess-rogue', slotRevision: 1 }),
    );
    renderCoordinatorProbe();
    await awaitUi(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'), 4_000);
    fireEvent.click(screen.getByTestId('play-a'));
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), 5_000);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() => expect(intentRequests(), '取消前 intent 未创建').toHaveLength(1));
    await awaitUi(() => expect(stopCallsFor('sess-vod-1').length).toBeGreaterThanOrEqual(1));
    // 用户取消换源(抽屉「取消换源」):取消输给消费 → 追查 successor 并显式 stop
    fireEvent.click(screen.getByRole('button', { name: '取消换源' }));
    await pumpTimers(200);
    await awaitUi(() => expect(cancelCalls().length).toBeGreaterThanOrEqual(1), 4_000);
    // cancel 落在 intent-1 上(服务端已创建的意图);响应=already_consumed+successor(api.md §5 cancel 行)
    const cancelPath = cancelCalls()[0]?.url ?? '';
    const intentIdFromCancel = cancelPath.split('/playback/transition-intents/')[1]?.split('/cancel')[0] ?? '';
    expect(intentIdFromCancel).toBe('intent-1');
    // 追查后继:对不需要的后继显式 stop(ui.md §4 等待找回后继并 stop;T075 赢家追查)
    await awaitUi(
      () =>
        expect(
          stopCallsFor('sess-rogue').length,
          contractNote('取消输给消费后后继无人管理', 'api.md §5 协调器显式 stop 不需要的后继'),
        ).toBeGreaterThanOrEqual(1),
      5_000,
    );
    // 不消费:取消方不得再 resolve 造第二播放
    expect(transitionResolveBodies(), '取消输家仍发起消费').toHaveLength(0);
  });

  it('D2 不同 ui 操作号并发(连点不同目标):旧操作已创建的 intent 显式 cancel,不静默丢弃;新操作独立完成', async () => {
    vi.useFakeTimers();
    // 第一个操作的 intent 响应闸门(在用户已换目标后才到达)
    let intentCalls = 0;
    const firstIntentGate = gatedResponse();
    when('POST', /\/playback\/transition-intents$/, () => {
      intentCalls += 1;
      if (intentCalls === 1) {
        return firstIntentGate.promise;
      }
      return jsonResponse(intentReply({ id: `intent-${intentCalls}`, slotRevision: intentCalls }), 201);
    });
    renderCoordinatorProbe();
    await awaitUi(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'), 4_000);
    fireEvent.click(screen.getByTestId('play-a'));
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), 5_000);
    await startPlayback(5);
    await openSwitchDrawer();
    // 操作一:候选甲 + carry → intent 请求在途(闸门扣住)
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() => expect(intentRequests()).toHaveLength(1));
    // 操作二(不同 ui 操作号):候选乙 + carry → 独立走完整串行流
    await selectCandidate('同名剧集', '源乙');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(
      () => expect(transitionResolveBodies(), contractNote('新操作未独立完成', '不同目标并发须单后继归新操作')).toHaveLength(1),
      6_000,
    );
    expect(transitionResolveBodies()[0]?.transitionIntentId).toBe('intent-2');
    // 旧操作的后到 201:intent-1 已在服务端创建 → 必须显式 cancel(ui.md §2 不能仅丢弃)
    firstIntentGate.release(jsonResponse(intentReply({ id: 'intent-1', slotRevision: 1 }), 201));
    await awaitUi(
      () =>
        expect(
          cancelCalls().some((call) => call.url.includes('/playback/transition-intents/intent-1/cancel')),
          contractNote('旧操作已创建 intent 被静默丢弃', 'ui.md §2 可创建后继的旧响应必须追查/清理'),
        ).toBe(true),
      5_000,
    );
    // 旧操作不得产生第二个消费/第二后继(spec 场景 6:一个来源阶段最多一个成功后继)
    expect(transitionResolveBodies()).toHaveLength(1);
  });

  it('D3 重复 key 幂等:intent 响应丢失→同 operationKey 同载荷原样重放,恰一次推进(单 resolve)', async () => {
    vi.useFakeTimers();
    let intentCalls = 0;
    when('POST', /\/playback\/transition-intents$/, () => {
      intentCalls += 1;
      if (intentCalls === 1) {
        throw new TypeError('network lost');
      }
      return jsonResponse(intentReply(), 201);
    });
    renderCoordinatorProbe();
    await awaitUi(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'), 4_000);
    fireEvent.click(screen.getByTestId('play-a'));
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), 5_000);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(
      () =>
        expect(intentRequests().length, contractNote('intent 未重放', 'api.md §5 同 key 重放幂等;ui.md §2 不可变载荷')).toBeGreaterThanOrEqual(2),
      5_000,
    );
    await pumpTimers(1_000);
    // 重放载荷逐字节一致(同 operationKey/同选择;重放不换 key)
    const attempts = intentRequests();
    expect(new Set(attempts.map((body) => JSON.stringify(body))).size, '重放载荷被改写').toBe(1);
    expect(UUID_PATTERN.test(String(attempts[0]?.operationKey))).toBe(true);
    // 幂等收口:恰一次消费(重放不产生第二后继)
    expect(transitionResolveBodies(), '重放导致重复消费').toHaveLength(1);
  });
});

// ────────────────────────── E · 旧响应守卫(切档/关闭) ──────────────────────────

describe('010 T069 · E 切档旧响应守卫(→T074/T075)', () => {
  it('E1 [T074] 切档后迟到 candidates 响应不回写:不渲染旧候选,不链发测速', async () => {
    vi.useFakeTimers();
    const candidatesGate = gatedResponse();
    // 同上:兼容查询参数(契约裁决 lead 2026-10-31)
    when('GET', /\/vod\/switch-candidates(?:\?.*)?$/, () => candidatesGate.promise);
    const { rerender } = renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    // 打开换源(候选请求在途;闸门扣住响应——候选容器是否先渲染不钉,只钉请求已发出)
    fireEvent.click(screen.getByRole('button', { name: '播放设置' }));
    await awaitUi(() => expect(screen.getByRole('button', { name: '换源' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '换源' }));
    await awaitUi(() => expect(switchCandidateCalls().length).toBeGreaterThanOrEqual(1));
    // 切档(会话身份变化;vod-resume B6 同形):旧会话候选请求必须作废
    rerender(
      <PlayerView
        sessionId="sess-vod-2"
        generation={1}
        playbackUrl="/api/playback/stream/sess-vod-2/1/index?ticket=t"
        ticketExpiresAt="2026-11-26T00:00:00.000Z"
        delivery="hls_proxy"
        durationSeconds={3600}
        onTerminated={terminated}
        onRenew={() => undefined}
      />,
    );
    candidatesGate.release(
      jsonResponse({ items: WORLD_CANDIDATES, nextCursor: null, partial: false, reasons: [] }),
    );
    await pumpTimers(500);
    await pumpTimers(1_000);
    expect(
      screen.queryAllByTestId('vod-switch-candidate'),
      contractNote('切档后旧候选回写渲染', 'ui.md §5 结果回写带身份守卫'),
    ).toHaveLength(0);
    // 旧响应不得链发测速(切档清测速,ui.md §5)
    expect(switchProbeRequests(), '迟到候选链发测速').toHaveLength(0);
    expect(intentRequests()).toHaveLength(0);
  });

  it('E2 [T074] 切档后迟到 probes 响应不回写:延迟不渲染,不推进意图', async () => {
    vi.useFakeTimers();
    const probesGate = gatedResponse();
    when('POST', /\/vod\/switch-probes$/, () => probesGate.promise);
    const { rerender } = renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await openSwitchDrawer();
    await awaitUi(() => expect(switchProbeRequests()).toHaveLength(1));
    rerender(
      <PlayerView
        sessionId="sess-vod-2"
        generation={1}
        playbackUrl="/api/playback/stream/sess-vod-2/1/index?ticket=t"
        ticketExpiresAt="2026-11-26T00:00:00.000Z"
        delivery="hls_proxy"
        durationSeconds={3600}
        onTerminated={terminated}
        onRenew={() => undefined}
      />,
    );
    probesGate.release(
      jsonResponse({
        items: WORLD_CANDIDATES.slice(0, 3).map((candidate) =>
          probeResult({ candidateRef: candidate.candidateRef, latencyMs: 999 }),
        ),
      }),
    );
    await pumpTimers(500);
    await pumpTimers(1_000);
    expect(screen.queryAllByTestId('vod-switch-latency'), contractNote('旧测速延迟回写', 'ui.md §5 切档清测速')).toHaveLength(0);
    expect(intentRequests(), '迟到测速推进意图').toHaveLength(0);
  });

  it('E3 [T075] 关闭播放器后迟到 intent 201:必须追查清理(显式 cancel),不能仅丢弃', async () => {
    vi.useFakeTimers();
    const intentGate = gatedResponse();
    when('POST', /\/playback\/transition-intents$/, () => intentGate.promise);
    renderCoordinatorProbe();
    await awaitUi(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'), 4_000);
    fireEvent.click(screen.getByTestId('play-a'));
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), 5_000);
    await startPlayback(5);
    await openSwitchDrawer();
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '接当前播放位置' }));
    await awaitUi(() => expect(intentRequests()).toHaveLength(1));
    // 关闭播放器(统一 close 路径;播放面与换源流一并废弃)
    fireEvent.click(screen.getByRole('button', { name: '退出播放' }));
    await pumpTimers(100);
    expect(screen.queryByTestId('playback-surface')).not.toBeInTheDocument();
    // 关闭前 intent 响应未决:迟到 201 表示服务端已创建 pending intent → 必须追查清理
    intentGate.release(jsonResponse(intentReply({ id: 'intent-1' }), 201));
    await awaitUi(
      () =>
        expect(
          cancelCalls().some((call) => call.url.includes('/playback/transition-intents/intent-1/cancel')) ||
            cleanupCalls().some((call) => call.url.includes('/playback/transition-intents/intent-1/cleanup')),
          contractNote('关闭后迟到 intent 被静默丢弃', 'ui.md §2 可创建后继的旧响应必须追查/清理'),
        ).toBe(true),
      5_000,
    );
    // 清理后不得再消费旧意图(不复活换源流)
    expect(transitionResolveBodies(), '关闭后迟到 intent 仍被消费').toHaveLength(0);
  });
});

// ────────────────────────── F · recover_switch 提示(→T075) ──────────────────────────

describe('010 T069 · F recover_switch 提示与过期(→T075)', () => {
  /** 协调器基座起播后注入媒体故障,进入 unavailable 相位 */
  async function bootAndFail(): Promise<void> {
    renderCoordinatorProbe();
    await awaitUi(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'), 4_000);
    fireEvent.click(screen.getByTestId('play-a'));
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), 5_000);
    await startPlayback(5);
    emitEngineFatalError();
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('unavailable'), 4_000);
  }

  it('F1 媒体故障 60s 内:recover 提示出现;确认后 intent action=recover_switch', async () => {
    vi.useFakeTimers();
    await bootAndFail();
    // 60s 恢复窗口内:换源恢复入口可见(api.md §5 recover_switch;ui.md §4)
    await awaitUi(
      () =>
        expect(
          screen.getByRole('button', { name: /换源恢复|恢复播放/ }),
          contractNote('媒体故障无 recover_switch 提示', 'ui.md §4 媒体故障提供 60s recover_switch 路径'),
        ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /换源恢复|恢复播放/ }));
    // recover 走同一候选流(不退出播放器重搜);抽屉容器以候选面承载
    await awaitUi(() =>
      expect(screen.getByTestId('vod-switch-candidates'), contractNote('恢复入口无候选面', 'T075 复用 T074 候选流')).toBeInTheDocument(),
    );
    await selectCandidate('同名剧集', '源甲');
    fireEvent.click(screen.getByRole('button', { name: '从头播放' }));
    await awaitUi(() => expect(intentRequests()).toHaveLength(1));
    expect(
      intentRequests()[0]?.action,
      contractNote('恢复未走 recover_switch', 'api.md §5 恢复分支 action=recover_switch(仅故障后 60s)'),
    ).toBe('recover_switch');
    expect(intentRequests()[0]?.fromSessionId).toBe('sess-vod-1');
  });

  it('F2 60s 过期:recover 入口收口,由「重新播放」承载新普通播放(resolve 带 startMode,零 intent)', async () => {
    vi.useFakeTimers();
    await bootAndFail();
    await awaitUi(() => expect(screen.getByRole('button', { name: /换源恢复|恢复播放/ })).toBeInTheDocument());
    // 越过 60s 恢复窗口:recover 路径过期 → 明确新播放(api.md §6「过期明确新播放」)
    await pumpTimers(61_000);
    expect(
      screen.queryByRole('button', { name: /换源恢复|恢复播放/ }),
      contractNote('过期后仍可 recover_switch', 'failed 可恢复来源仅 60s'),
    ).not.toBeInTheDocument();
    await awaitUi(() =>
      expect(screen.getByRole('button', { name: '重新播放' }), contractNote('过期后无新普通播放出路', 'T075 60s 过期新普通播放')).toBeInTheDocument(),
    );
    const resolvesBeforeReplay = resolveBodies().length;
    fireEvent.click(screen.getByRole('button', { name: '重新播放' }));
    await awaitUi(() => expect(resolveBodies()).toHaveLength(resolvesBeforeReplay + 1));
    const replay = resolveBodies()[resolveBodies().length - 1];
    expect(
      Object.prototype.hasOwnProperty.call(replay, 'startMode'),
      contractNote('过期恢复借 intent', '过期须新普通播放,不自动携带过期 carry/意图'),
    ).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(replay, 'transitionIntentId')).toBe(false);
    expect(intentRequests(), '过期后仍创建过渡意图').toHaveLength(0);
  });

  it('F3 [现状绿] 故障后不自动循环尝试来源:零自动 candidates/probes/intents(等待用户显式动作)', async () => {
    vi.useFakeTimers();
    await bootAndFail();
    const resolvesAtFailure = resolveBodies().length;
    await pumpTimers(10_000);
    expect(switchCandidateCalls(), '故障后自动拉取候选').toHaveLength(0);
    expect(switchProbeRequests(), '故障后自动测速').toHaveLength(0);
    expect(intentRequests(), '故障后自动建意图').toHaveLength(0);
    expect(resolveBodies(), '故障后自动重播').toHaveLength(resolvesAtFailure);
  });
});
