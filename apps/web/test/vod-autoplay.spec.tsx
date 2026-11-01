import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * 引擎边界 mock(009 playback-modal/vod-resume 同款):jsdom 无媒体实现,video.js 对
 * 不可加载 src 会异步抛 error → onFatalError → playing→unavailable。本规格断言连播
 * 行为而非引擎行为 —— 模块边界替换 video.js 为无副作用假引擎,媒体事件由测试直接
 * 派发到 <video> 元素;rejectPlayWith 非 null 时 play() 以该错误拒绝(模拟浏览器
 * 自动播放策略拒绝,NotationError → awaitingGesture 面)。
 */
const fakePlayerState = vi.hoisted(() => ({
  /** 非 null 时 FakePlayer.play() 以该错误拒绝(NotAllowedError 自动播放拒绝) */
  rejectPlayWith: null as DOMException | null,
}));
vi.mock('video.js', () => {
  class FakePlayer {
    on(): void {}
    addClass(): void {}
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
import { act, fireEvent, render, screen, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { ActionCoordinator, usePlayAction } from '../src/app/action-coordinator';
import { SessionProvider, useSession } from '../src/app/session-provider';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { PlayerView } from '../src/features/playback/player-view';
import { createQueryWrapper, createTestQueryClient } from './helpers/query-test-utils';
import type { AccountSession } from '../src/app/session-types';
import type { Vod } from '@hmp/shared';

/**
 * T063(010 US3 测试先行)—— 连播/自动下一集前端契约钉(vod-autoplay 面)。
 *
 * 覆盖 tasks.md T063 原文:自然结束 receipt 驱动倒计时、取消/关闭/切档、目标已有
 * 历史询问、play 拒绝手势恢复、60s 释放及重复事件不造会话;审查补充:倒计时目标
 * 改变重新确认、未知 duration 起播不误杀。对照契约:
 * - docs/specs/010-online-vod/contracts/api.md §1(FinishReceipt.autoNextEligible/
 *   reason 独立值、NextPlanReply、SequentialNextIntentRequest、IntentReply)、
 *   §4(finish 行:cause=natural_end、operationKey UUID、无证据不等于接口失败)、
 *   §5(next/manual_next:nextPlanRef/positionMode;倒计时开始前取计划;目标有未
 *   完成历史时 UI 必须显式选择后提交;自动 next 要求 finish 资格和当前偏好)、
 *   §6(NEXT_PLAN_CHANGED/EXPIRED=409/410 重新取计划并重新确认;自动播放被拒 →
 *   awaitingGesture 不是媒体错误码)、§7 I3(倒计时开始前取计划,选择历史用同一
 *   快照,超期 410 重新展示)/I4(playing 观测解除 readyAt+60s 期限);
 * - contracts/ui.md §3(仅 autoNextEligible 才倒计时 5s;cancel/立即下一集/关闭
 *   均可键盘操作;有历史暂停倒计时;不伪造 started;readyAt 起 60s 服务端确认为
 *   准;点击恢复先校验身份)、§5(切档/退出清个人缓存、倒计时和意图)、
 *   §6(计划过期/变化重新显示目标/历史并确认,不能把先前点击自动套到新目标);
 * - spec.md US3 场景 1–4(5s 可取消倒计时/受限停止不跳过/目标历史先选位置/
 *   重复结束通知只产生一次有效过渡)、FR-025/026/040。
 *
 * mock 层沿用 005 T048/010 T032/T047 惯例:vi.stubGlobal('fetch') 路由式 mock
 * (后注册优先)、DTO 以 @hmp/shared `Vod` 生成形状手写最小合法对象、零真实网络;
 * PlayerView 直挂(props 驱动)为主基座,关闭播放器(B2)走 SessionProvider+
 * ActionCoordinator+MemoryRouter 完整基座(T049 状态探针/seekCapability 分派先例,
 * 见 test/vod-resume.spec.tsx)。T063 钉的计划内红标注已随 T064/T065 落地全部
 * 转绿移除;断言消息经 contractNote 保留契约锚点(回归失败时定位应然形态)。
 *
 * ── 文件头映射表(T064/T065 已落地;21/21 全绿)──
 *
 * | 用例                                | 契约锚点                                              | 状态                |
 * | ----------------------------------- | ----------------------------------------------------- | ------------------- |
 * | A0 未 ended 不 finish/不倒计时      | api.md §4(cause=natural_end 仅自然结束)             | 绿                  |
 * | A1 receipt 资格→5s 倒计时           | ui.md §3/api.md §5(资格+偏好)/§7 I3(倒计时前取计划)| 绿(T064 hook+T065 UI)|
 * | A2 autoNextEligible=false 无倒计时  | api.md §1 FinishReceipt 独立值/ui.md §3               | 绿(T064)          |
 * | A3 倒计时开始前取计划               | api.md §7 I3/ui.md §6(展示绑定目标)                | 绿(T064)          |
 * | A4 立即下一集跳过等待建意图         | ui.md §3(取消/立即下一集可键盘操作)                | 绿(T064 hook+T065 UI)|
 * | B1 倒计时中取消不发 intent          | ui.md §3/spec.md 场景 4                               | 绿(T064 hook+T065 UI)|
 * | B2 关闭播放器取消倒计时             | spec.md FR-026/FR-040/ui.md §5                        | 绿(T064 hook+T065 UI)|
 * | B3 切档(会话身份变化)取消倒计时   | spec.md FR-040/ui.md §5(缓存清除归 identity-purge) | 绿(T064 hook+T065 UI)|
 * | B4 偏好关闭无倒计时(finish 仍保存) | api.md §5(自动 next 要求当前偏好)/ui.md §3          | 绿(T064)          |
 * | C1 目标历史询问(继续→target_history)| api.md §5(ui 必须显式选择)/ui.md §3(暂停倒计时)  | 绿(T065 询问面)    |
 * | C1b 目标历史询问(从头→beginning)  | api.md §5(选择即 positionMode)                      | 绿(T065 询问面)    |
 * | C2 无历史直接倒计时建意图 beginning | api.md §5/§7 I3                                       | 绿(T064/T065)      |
 * | D1 拒绝期零 started/恢复恰一次      | ui.md §3(不伪造 started)/泵 started 门(T048)     | 绿                  |
 * | D2 awaitingGesture 面               | ui.md §3/api.md §6(自动播放被拒行)                 | 绿(T065 手势面)    |
 * | D3 60s 服务端回收为准(UI 不自毁)  | api.md §7 I4/ui.md §3                                 | 绿(T065 手势面)    |
 * | E1 重复 ended 不重复 finish/不造会话| spec.md 场景 4/api.md §4(receipt 不可变)            | 绿(T064)          |
 * | E2 finish 唯一 Promise+卸载不补final| ui.md §2/T064(一次 final Promise)                  | 绿(T064)          |
 * | F1 NEXT_PLAN_CHANGED 重确认         | api.md §6/§7 I3/ui.md §6                              | 绿(T064)          |
 * | F2 NEXT_PLAN_EXPIRED 重确认         | api.md §6(NEXT_PLAN_EXPIRED 行)                     | 绿(T064)          |
 * | G1 未知时长正常播放不阻断           | ui.md §6/api.md §7 I4                                 | 绿(T049)          |
 * | G2 no_duration 资格形态不误杀       | api.md §1(no_duration)/§4(可 ended=true 资格否)   | 绿(T064)          |
 *
 * ── 已落地实现面契约(本文件钉死的稳定面)──
 * - use-vod-autoplay(sessionId, generation, videoRef):仅在 FinishReceipt.
 *   autoNextEligible=true 后动作:偏好门(GET /me/vod/preferences)→ 倒计时开始前
 *   POST /playback/next-plans({fromSessionId,expectedGeneration,action:'next'})
 *   → 5s 倒计时 → 到期/立即 → POST /playback/transition-intents
 *   (SequentialNextIntentRequest:nextPlanRef/positionMode/expectedSlotRevision/
 *   operationKey UUID;取消后零 intent);
 * - 稳定 UI 面:容器 data-testid="autoplay-countdown"(展示 NextPlanReply.label
 *   绑定目标)、"autoplay-history-choice"(目标历史询问)、"autoplay-gesture"
 *   (awaitingGesture);按钮可访问名:取消(取消连播)/立即(立即播放下一集)/
 *   从上次位置继续/从头播放/点击播放;
 * - 60s 期限:UI 只展示等待,不自毁会话;observations event=playing 是 I4 解除
 *   期限的唯一客户端通道(T064 已补齐:泵在真实 playing 媒体事件上报 event=playing);
 * - finish 队列(T064):ended → POST /playback/sessions/:id/finish(cause=
 *   natural_end,operationKey UUID,唯一 Promise 不可变载荷,重复 ended 幂等);
 *   receipt 已取得后卸载不再补 final/stop。
 *
 * 契约钉边界(避免过度约束):
 * - 倒计时/询问/手势层的组件结构与样式不钉,只钉 testid、可访问名、目标 label
 *   可见性与网络副作用;
 * - 立即下一集按钮的 action 允许 next|manual_next(均满足 §5 资格语义);自动到期
 *   路径钉 action=next(计划按 action 绑定,§7 I3);
 * - 切档清个人缓存的行为级断言由 006 unit/identity-purge.spec.tsx 承担,本文件钉
 *   播放链路面(倒计时随会话身份销毁、零 intent);身份变化后播放器消费续播
 *   (resolve transitionIntentId → 后继会话)归 T065/T069,本文件止于 intent;
 * - D2 的 awaitingGesture 文案按 ui.md §3 语义钉「点击播放」词面(完整文案
 *   「下一集已就绪,点击播放」为后继会话场景,T065 可自定);
 * - 倒计时精确逐秒文案不钉(屏幕阅读器不每秒重复整段消息,ui.md §3)。
 */

type FinishReceiptDto = Vod.components['schemas']['FinishReceipt'];
type NextPlanReplyDto = Vod.components['schemas']['NextPlanReply'];
type IntentReplyDto = Vod.components['schemas']['IntentReply'];
type PreferencesDto = Vod.components['schemas']['Preferences'];
type HistorySummaryDto = Vod.components['schemas']['HistorySummary'];
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

/** operationKey 必须为 UUID(api.md §4 finish 行/§5 IntentRequest) */
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

/** 010 扩展 PlaybackDto 夹具(T003 冻结形状;与 vod-resume 同形) */
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

/** FinishReceipt 13 键夹具(autoNextEligible=true/reason=completed 为连播资格形态) */
function finishReceipt(overrides: Partial<FinishReceiptDto> = {}): FinishReceiptDto {
  return {
    sessionId: 'sess-vod-1',
    generation: 1,
    ended: true,
    finalSessionAccepted: true,
    historyApplied: true,
    historyRevision: 5,
    sessionCompleted: true,
    autoNextEligible: true,
    reason: 'completed',
    positionSeconds: 3600,
    durationSeconds: 3600,
    endedAt: '2026-10-30T12:00:00.000Z',
    replayed: false,
    ...overrides,
  };
}

/** NextPlanReply 9 键夹具(无历史形态;C1 经 overrides 注入目标未完成历史) */
function nextPlan(overrides: Partial<NextPlanReplyDto> = {}): NextPlanReplyDto {
  return {
    nextPlanRef: 'plan-1',
    targetMediaId: 'media-2',
    label: '第2集',
    sequenceRevision: 7,
    detailRevision: 3,
    historyRevision: 0,
    historyChoiceRequired: false,
    history: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

/** IntentReply 夹具(201 创建形态) */
function intentReply(overrides: Partial<IntentReplyDto> = {}): IntentReplyDto {
  return {
    id: 'intent-1',
    fromSessionId: 'sess-vod-1',
    fromGeneration: 1,
    action: 'next',
    targetMediaId: 'media-2',
    positionMode: 'beginning',
    matchConfidence: 'high',
    slotRevision: 1,
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    successorSessionId: null,
    ...overrides,
  };
}

/** Preferences 夹具(未有持久行传输初值 version=0;autoplayNext 缺省开) */
function preferences(overrides: Partial<PreferencesDto> = {}): PreferencesDto {
  return {
    autoplayNext: true,
    switchCarryPosition: true,
    version: 0,
    ...overrides,
  };
}

/** 目标未完成历史摘要(C1/C1b;positionSeconds=300/duration=3600/completed=false) */
function historySummary(overrides: Partial<HistorySummaryDto> = {}): HistorySummaryDto {
  return {
    mediaId: 'media-2',
    parentMediaId: 'parent-1',
    lineLabel: '线路一',
    episodeLabel: '第2集',
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

const finishBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/finish');
const nextPlanRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/next-plans');
const intentRequests = (): Array<Record<string, unknown>> => bodiesEndingWith('/transition-intents');
const progressBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/progress');
const observationBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/observations');
const stopBodies = (): Array<Record<string, unknown>> => bodiesEndingWith('/stop');

type RouteHandler = (body: unknown, path: string) => Response | Promise<Response>;

/** 后注册优先:用例级覆盖压过世界级缺省(005 T048 同款) */
function when(method: string, pathPattern: RegExp, handler: RouteHandler): void {
  routes.unshift((reqMethod, path, reqBody) => {
    if (reqMethod !== method || !pathPattern.test(path)) {
      return null as unknown as Response;
    }
    return handler(reqBody, path);
  });
}

/** 默认世界:已选档会话 + sess-vod-1 播放全链 + finish/偏好/计划/intent 连播链;
 *  未命中 404 problem。 */
function installDefaultWorld(): void {
  when('GET', /\/auth\/session$/, () => jsonResponse(sessionFixture()));
  when('GET', /\/setup\/status$/, () => jsonResponse({ initialized: true }));
  when('POST', /\/playback\/resolve$/, () =>
    jsonResponse(playbackDto({ state: 'preparing', ticketExpiresAt: null, playbackUrl: null }), 201, {
      Location: '/api/playback/sessions/sess-vod-1',
    }),
  );
  when('GET', /\/playback\/sessions\/sess-vod-1$/, () => jsonResponse(playbackDto({ state: 'ready' })));
  when('POST', /\/playback\/sessions\/sess-vod-1\/renew$/, () =>
    jsonResponse({
      playbackUrl: '/api/playback/stream/sess-vod-1/1/index?ticket=t',
      ticketExpiresAt: '2026-11-26T00:00:00.000Z',
      generation: 1,
    }),
  );
  when('POST', /\/playback\/sessions\/sess-vod-1\/progress$/, () =>
    jsonResponse({
      applied: true,
      reason: 'accepted',
      historyRevision: 4,
      sessionAccepted: true,
      acceptedSampleSeq: 1,
      acceptedPositionSeconds: 5,
      acceptedGeneration: 1,
      sessionStarted: true,
    }),
  );
  when('POST', /\/playback\/sessions\/sess-vod-1\/observations$/, () =>
    jsonResponse({ accepted: true, lastEventSeq: 1, playbackStarted: true }),
  );
  when('POST', /\/playback\/sessions\/sess-vod-1\/heartbeat$/, () => new Response(null, { status: 204 }));
  when('POST', /\/playback\/sessions\/sess-vod-1\/stop$/, () => new Response(null, { status: 204 }));
  when('POST', /\/playback\/sessions\/sess-vod-1\/finish$/, () => jsonResponse(finishReceipt()));
  when('GET', /\/me\/vod\/preferences$/, () => jsonResponse(preferences()));
  when('POST', /\/playback\/next-plans$/, () => jsonResponse(nextPlan()));
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
  props: { readonly sessionId?: string; readonly durationSeconds?: number | null } = {},
): RenderResult {
  const sessionId = props.sessionId ?? 'sess-vod-1';
  return render(
    <PlayerView
      sessionId={sessionId}
      generation={1}
      playbackUrl={`/api/playback/stream/${sessionId}/1/index?ticket=t`}
      ticketExpiresAt="2026-11-26T00:00:00.000Z"
      delivery="hls_proxy"
      durationSeconds={props.durationSeconds}
      onTerminated={terminated}
      onRenew={() => undefined}
    />,
  );
}

/** 播放意图观察面(005 T048/T047 同款探针):播放入口 + 当前阶段 */
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

/** 完整协调器基座(B2 关闭播放器面;T049 状态探针/分派先例,见 vod-resume) */
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

// ────────────────────────── 假定时器/媒体事件/断言助手 ──────────────────────────

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

/** 自然结束(T064 finish 队列的触发事件;jsdom 直接派发到媒体元素) */
async function naturalEnd(positionSeconds: number): Promise<void> {
  const videoEl = getVideo();
  videoEl.currentTime = positionSeconds;
  await act(async () => {
    videoEl.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** 契约断言消息(T065 已落地全绿;保留契约锚点,便于回归失败时定位应然形态) */
function contractNote(current: string, target: string): string {
  return `${current} —— 依契约应 ${target}`;
}

beforeEach(() => {
  fetchMock = vi.fn();
  routes = [];
  terminated = vi.fn();
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
});

// ────────────────────────── A · receipt 驱动(资格 → 倒计时) ──────────────────────────

describe('010 T063 · receipt 驱动倒计时', () => {
  it('A0 [现状绿] 未自然结束不触发 finish、不出现倒计时:周期拍照常上报、播放不中断', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await pumpTimers(30_000);
    // 未 ended:零 finish/零计划/零意图/零倒计时;周期链活着(≥1 拍)、无终止提示
    expect(finishBodies(), contractNote('未 ended 也有 finish 调用', 'cause=natural_end 仅由 ended 触发')).toHaveLength(0);
    expect(nextPlanRequests()).toHaveLength(0);
    expect(intentRequests()).toHaveLength(0);
    expect(screen.queryByTestId('autoplay-countdown')).not.toBeInTheDocument();
    expect(progressBodies().filter((body) => body.reason === 'periodic').length).toBeGreaterThanOrEqual(1);
    expect(terminated).not.toHaveBeenCalled();
  });

  it('A1 [T064] 自然结束 finish(cause=natural_end/UUID key)→ autoNextEligible=true → 5s 倒计时出现(取消/立即下一集),ended 后周期链停止', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(finishBodies(), contractNote('自然结束未发起 finish', 'POST /finish cause=natural_end')).toHaveLength(1));
    const finish = finishBodies()[0];
    expect(UUID_PATTERN.test(String(finish?.operationKey)), 'operationKey 必须为 UUID(api.md §4)').toBe(true);
    expect(finish?.cause).toBe('natural_end');
    expect(finish?.finalProgress).toEqual({
      sampleSeq: expect.any(Number),
      expectedGeneration: 1,
      positionSeconds: 3600,
    });
    expect(Number((finish?.finalProgress as { sampleSeq: number }).sampleSeq)).toBeGreaterThan(1);
    // receipt(autoNextEligible=true)→ 倒计时出现:展示绑定目标 + 两个出路按钮
    await awaitUi(
      () =>
        expect(
          screen.getByTestId('autoplay-countdown'),
          contractNote('receipt 资格后无倒计时', 'ui.md §3 仅 autoNextEligible 才倒计时 5s'),
        ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('autoplay-countdown').textContent).toContain('第2集');
    expect(screen.getByRole('button', { name: /取消/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /立即/ })).toBeInTheDocument();
    // 倒计时开始前取计划(api.md §7 I3):请求体=来源会话+代次+action=next
    expect(nextPlanRequests()).toEqual([{ fromSessionId: 'sess-vod-1', expectedGeneration: 1, action: 'next' }]);
    // ended 后周期链停止(api.md §4:收到 finish 后停周期链)
    const periodicsAtCountdown = progressBodies().filter((body) => body.reason === 'periodic').length;
    await pumpTimers(20_000);
    expect(progressBodies().filter((body) => body.reason === 'periodic').length).toBe(periodicsAtCountdown);
  });

  it('A2 [T064] autoNextEligible=false(reason=no_tail_observation)→ 无倒计时/无计划/无意图:资格只看 receipt 布尔独立值', async () => {
    vi.useFakeTimers();
    when('POST', /\/playback\/sessions\/sess-vod-1\/finish$/, () =>
      jsonResponse(finishReceipt({ autoNextEligible: false, reason: 'no_tail_observation', sessionCompleted: false })),
    );
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() =>
      expect(finishBodies(), contractNote('自然结束未发起 finish', 'POST /finish 后按 receipt 资格收口')).toHaveLength(1),
    );
    await pumpTimers(6_500);
    expect(screen.queryByTestId('autoplay-countdown'), contractNote('无资格仍出倒计时', 'autoNextEligible=false 不倒计时')).not.toBeInTheDocument();
    expect(nextPlanRequests()).toHaveLength(0);
    expect(intentRequests()).toHaveLength(0);
  });

  it('A3 [T064] 倒计时开始前取计划:计划未返回前不出现倒计时,返回后展示绑定目标(I3 同一快照)', async () => {
    vi.useFakeTimers();
    // 计划闸门:始终可调用的 holder(未决前 no-op;handler 决议后手动放行)
    const planGate: { release: (plan: NextPlanReplyDto) => void } = { release: () => undefined };
    when('POST', /\/playback\/next-plans$/, () => {
      return new Promise<Response>((resolve) => {
        planGate.release = (plan: NextPlanReplyDto): void => resolve(jsonResponse(plan));
      });
    });
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await pumpTimers(1_000);
    // finish 已受理、计划未决:倒计时不得提前出现
    expect(finishBodies()).toHaveLength(1);
    expect(screen.queryByTestId('autoplay-countdown'), '计划未决不得先出倒计时(I3 倒计时开始前取计划)').not.toBeInTheDocument();
    expect(screen.queryByTestId('autoplay-history-choice')).not.toBeInTheDocument();
    planGate.release(nextPlan());
    await pumpTimers(200);
    await awaitUi(
      () =>
        expect(
          screen.getByTestId('autoplay-countdown'),
          contractNote('计划返回后仍无倒计时', 'I3 计划就绪后按快照展示目标并倒计时'),
        ).toBeInTheDocument(),
    );
    expect(screen.getByTestId('autoplay-countdown').textContent).toContain('第2集');
  });

  it('A4 立即下一集跳过剩余倒计时建意图(同计划 ref),后续到点不重复建', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /立即/ }));
    await pumpTimers(300);
    const intents = intentRequests();
    expect(intents, contractNote('立即下一集未建意图', 'ui.md §3 立即下一集立即消费当前计划')).toHaveLength(1);
    expect(String(intents[0]?.nextPlanRef)).toBe('plan-1');
    expect(String(intents[0]?.action)).toMatch(/^(next|manual_next)$/);
    expect(String(intents[0]?.positionMode)).toBe('beginning');
    // 剩余倒计时到点不得二次建意图(延迟操作已消费)
    await pumpTimers(6_000);
    expect(intentRequests()).toHaveLength(1);
  });
});

// ────────────────────────── B · 取消/关闭/切档/偏好开关 ──────────────────────────

describe('010 T063 · 取消/关闭/切档与偏好门', () => {
  it('B1 倒计时中取消:倒计时收口、不发 intent,后续到点仍不发(取消终态)', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    await pumpTimers(200);
    expect(screen.queryByTestId('autoplay-countdown'), '取消后倒计时收口').not.toBeInTheDocument();
    await pumpTimers(10_000);
    expect(intentRequests(), contractNote('取消后仍建意图', 'ui.md §3 cancel 不消费、spec 场景 4')).toHaveLength(0);
    expect(nextPlanRequests()).toHaveLength(1); // 取消不重取计划(不再连播)
  });

  it('B2 关闭播放器:倒计时随之销毁、零 intent(延迟操作不能启动下一集;协调器完整基座)', async () => {
    vi.useFakeTimers();
    renderCoordinatorProbe();
    await awaitUi(() => expect(screen.getByTestId('session-status').textContent).toBe('authenticated'), 4_000);
    fireEvent.click(screen.getByTestId('play-a'));
    await awaitUi(() => expect(screen.getByTestId('phase').textContent).toBe('playing'), 5_000);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(
      () =>
        expect(
          screen.getByTestId('autoplay-countdown'),
          contractNote('自然结束未出倒计时(协调器基座)', '倒计时在播放面内可见'),
        ).toBeInTheDocument(),
      4_000,
    );
    // 关闭播放器(统一 close 路径):倒计时与播放面一并销毁
    fireEvent.click(screen.getByRole('button', { name: '退出播放' }));
    await pumpTimers(100);
    expect(screen.queryByTestId('playback-surface')).not.toBeInTheDocument();
    expect(screen.queryByTestId('autoplay-countdown')).not.toBeInTheDocument();
    await pumpTimers(10_000);
    expect(intentRequests(), contractNote('关闭后仍建意图', 'FR-026/FR-040 延迟操作不能启动下一集')).toHaveLength(0);
  });

  it('B3 切档(会话身份变化):旧会话倒计时销毁、旧/新会话均零 intent(缓存清除归 identity-purge 面)', async () => {
    vi.useFakeTimers();
    const { rerender } = renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown')).toBeInTheDocument());
    // 会话身份变化=切档语义(PlayerView 换 sessionId,与 vod-resume B6 同形)
    rerender(
      <PlayerView
        sessionId="sess-vod-2"
        generation={1}
        playbackUrl="/api/playback/stream/sess-vod-2/1/index?ticket=t"
        ticketExpiresAt="2026-11-26T00:00:00.000Z"
        delivery="hls_proxy"
        onTerminated={terminated}
        onRenew={() => undefined}
      />,
    );
    await pumpTimers(100);
    expect(screen.queryByTestId('autoplay-countdown'), '切档后倒计时必须销毁').not.toBeInTheDocument();
    await pumpTimers(10_000);
    expect(intentRequests(), contractNote('切档后仍建意图', 'FR-040 身份变化终止旧播放与倒计时')).toHaveLength(0);
  });

  it('B4 [T064] 连播偏好关闭:finish 照发(历史照存)、receipt 有资格也不倒计时/不建意图(消费时服务端重验)', async () => {
    vi.useFakeTimers();
    when('GET', /\/me\/vod\/preferences$/, () => jsonResponse(preferences({ autoplayNext: false })));
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() =>
      expect(finishBodies(), contractNote('自然结束未发起 finish', '偏好关闭只关连播,final 保存照常')).toHaveLength(1),
    );
    await pumpTimers(6_500);
    expect(screen.queryByTestId('autoplay-countdown'), contractNote('偏好关闭仍倒计时', 'api.md §5 自动 next 要求当前偏好')).not.toBeInTheDocument();
    expect(nextPlanRequests()).toHaveLength(0);
    expect(intentRequests()).toHaveLength(0);
  });
});

// ────────────────────────── C · 目标历史询问(选择即 positionMode) ──────────────────────────

describe('010 T063 · 目标已有历史询问', () => {
  it('C1 historyChoiceRequired=true:显示继续/从头询问并暂停倒计时;不选择零 intent;选「从上次位置继续」→ target_history', async () => {
    vi.useFakeTimers();
    when('POST', /\/playback\/next-plans$/, () =>
      jsonResponse(
        nextPlan({
          historyRevision: 4,
          historyChoiceRequired: true,
          history: historySummary(),
        }),
      ),
    );
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(
      () =>
        expect(
          screen.getByTestId('autoplay-history-choice'),
          contractNote('目标历史未询问', 'api.md §5 有未完成历史必须显式选择'),
        ).toBeInTheDocument(),
    );
    // 展示绑定目标 + 两个明确位置选项(ui.md §6 重新显示目标/历史)
    expect(screen.getByTestId('autoplay-history-choice').textContent).toContain('第2集');
    expect(screen.getByRole('button', { name: '从上次位置继续' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '从头播放' })).toBeInTheDocument();
    // 询问期间倒计时暂停:超时不静默建意图(ui.md §3)
    await pumpTimers(10_000);
    expect(intentRequests(), contractNote('未选择就建了意图', 'ui.md §3 有历史时暂停倒计时让用户选位置')).toHaveLength(0);
    expect(screen.getByTestId('autoplay-history-choice')).toBeInTheDocument();
    // 显式选择即 positionMode(继续目标记录)
    fireEvent.click(screen.getByRole('button', { name: '从上次位置继续' }));
    await pumpTimers(500);
    const intents = intentRequests();
    expect(intents).toHaveLength(1);
    expect(String(intents[0]?.positionMode)).toBe('target_history');
    expect(String(intents[0]?.nextPlanRef)).toBe('plan-1');
  });

  it('C1b 目标历史询问选「从头播放」→ positionMode=beginning(选择即位置,不静默覆盖)', async () => {
    vi.useFakeTimers();
    when('POST', /\/playback\/next-plans$/, () =>
      jsonResponse(
        nextPlan({
          historyRevision: 4,
          historyChoiceRequired: true,
          history: historySummary(),
        }),
      ),
    );
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getByTestId('autoplay-history-choice')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '从头播放' }));
    await pumpTimers(500);
    const intents = intentRequests();
    expect(intents, contractNote('从头选择未建意图', 'api.md §5 选择即 positionMode')).toHaveLength(1);
    expect(String(intents[0]?.positionMode)).toBe('beginning');
    expect(String(intents[0]?.nextPlanRef)).toBe('plan-1');
  });

  it('C2 [T064] 无目标历史:直接 5s 倒计时、到期自动建意图(action=next/beginning/计划 ref/槽 0/UUID key)', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown')).toBeInTheDocument());
    expect(screen.queryByTestId('autoplay-history-choice')).not.toBeInTheDocument();
    await pumpTimers(5_500);
    const intents = intentRequests();
    expect(intents, contractNote('倒计时到期未建意图', 'ui.md §3 无历史直接倒计时推进')).toHaveLength(1);
    expect(intents[0]).toEqual({
      fromSessionId: 'sess-vod-1',
      expectedGeneration: 1,
      action: 'next',
      nextPlanRef: 'plan-1',
      positionMode: 'beginning',
      expectedSlotRevision: 0,
      operationKey: expect.any(String),
    });
    expect(UUID_PATTERN.test(String(intents[0]?.operationKey)), 'operationKey 必须为 UUID').toBe(true);
  });
});

// ────────────────────────── D · play 拒绝手势恢复与 60s 释放 ──────────────────────────

describe('010 T063 · awaitingGesture 与 60s 释放', () => {
  it('D1 [现状绿] 自动播放拒绝期间零 started;手势恢复(实际 playing)后恰一次 started(泵 started 门,T048)', async () => {
    vi.useFakeTimers();
    fakePlayerState.rejectPlayWith = new DOMException('play() failed', 'NotAllowedError');
    renderPlayerView();
    await pumpTimers(50);
    await pumpTimers(2_000);
    // 拒绝期间:未实际 playing → 零 started 样本(B1 门;不伪造)
    expect(progressBodies().filter((body) => body.reason === 'started')).toHaveLength(0);
    // 手势恢复:用户点击后真实 playing
    fakePlayerState.rejectPlayWith = null;
    await startPlayback(5);
    const starts = progressBodies().filter((body) => body.reason === 'started');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({ sampleSeq: 1, expectedGeneration: 1, positionSeconds: 5, reason: 'started' });
    expect(terminated).not.toHaveBeenCalled();
  });

  it('D2 NotAllowedError → awaitingGesture 面(点击播放):拒绝期零伪造 started/零 playing 观测;点击恢复后 started 恰一次且 playing 观测上报(I4)', async () => {
    vi.useFakeTimers();
    fakePlayerState.rejectPlayWith = new DOMException('play() failed', 'NotAllowedError');
    renderPlayerView();
    await pumpTimers(50);
    await awaitUi(
      () =>
        expect(
          screen.getByTestId('autoplay-gesture'),
          contractNote('自动播放拒绝无 awaitingGesture 面', 'ui.md §3 NotAllowedError → awaitingGesture'),
        ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /点击播放/ })).toBeInTheDocument();
    await pumpTimers(2_000);
    expect(progressBodies().filter((body) => body.reason === 'started'), '拒绝期不得伪造 started').toHaveLength(0);
    expect(observationBodies().filter((body) => body.event === 'playing'), '拒绝期不得伪造 playing 观测').toHaveLength(0);
    // 点击恢复:播放继续且恰一次 started(泵保证)+ playing 观测(I4 期限解除通道)
    fakePlayerState.rejectPlayWith = null;
    fireEvent.click(screen.getByRole('button', { name: /点击播放/ }));
    await startPlayback(5);
    await pumpTimers(100);
    expect(screen.queryByTestId('autoplay-gesture')).not.toBeInTheDocument();
    expect(progressBodies().filter((body) => body.reason === 'started')).toHaveLength(1);
    const playingObservations = observationBodies().filter((body) => body.event === 'playing');
    expect(playingObservations, contractNote('恢复后未发 playing 观测', 'api.md §7 I4 观测是 60s 期限解除通道')).toHaveLength(1);
    expect(playingObservations[0]?.expectedGeneration).toBe(1);
  });

  it('D3 60s 未起播:UI 持续展示等待、不自毁会话(零 stop/finish);服务端回收事实(heartbeat 404)才经既有终止通道呈现', async () => {
    vi.useFakeTimers();
    fakePlayerState.rejectPlayWith = new DOMException('play() failed', 'NotAllowedError');
    renderPlayerView();
    await pumpTimers(50);
    await awaitUi(() => expect(screen.getByTestId('autoplay-gesture')).toBeInTheDocument());
    // readyAt 起 60s:UI 只展示,不自毁(api.md §7 I4/watchdog 为服务端准时源)
    await pumpTimers(61_000);
    expect(screen.getByTestId('autoplay-gesture'), '60s 内 UI 不得自毁等待面').toBeInTheDocument();
    expect(stopBodies(), 'UI 不得自行 stop 释放会话').toHaveLength(0);
    expect(finishBodies(), 'UI 不得自行 finish 释放会话').toHaveLength(0);
    expect(terminated).not.toHaveBeenCalled();
    // 服务端回收事实到达:既有 heartbeat 失效通道呈现终止(不由本地定时器决定)
    when('POST', /\/playback\/sessions\/sess-vod-1\/heartbeat$/, () => problemResponse(404, 'SESSION_INVALID'));
    await pumpTimers(15_000);
    expect(terminated, contractNote('服务端回收未呈现', 'T065 server readyAt60s 为回收准时源')).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────── E · 重复事件不造会话(幂等) ──────────────────────────

describe('010 T063 · 重复事件幂等', () => {
  it('E1 [T064] 重复 ended:恰一次 finish、单一倒计时;取消后再次 ended 不重建倒计时/不补 finish(spec 场景 4)', async () => {
    vi.useFakeTimers();
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getAllByTestId('autoplay-countdown')).toHaveLength(1));
    // 重复 ended 通知:不重复 finish、不出现第二个倒计时
    await naturalEnd(3600);
    await pumpTimers(500);
    expect(finishBodies(), contractNote('重复 ended 重复 finish', 'receipt 不可变,ended 幂等')).toHaveLength(1);
    expect(screen.getAllByTestId('autoplay-countdown')).toHaveLength(1);
    // 取消后再次 ended:已记录的 finish 不重建倒计时(不造第二会话)
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    await pumpTimers(200);
    await naturalEnd(3600);
    await pumpTimers(6_000);
    expect(finishBodies()).toHaveLength(1);
    expect(screen.queryByTestId('autoplay-countdown')).not.toBeInTheDocument();
    expect(intentRequests()).toHaveLength(0);
  });

  it('E2 [T064] finish 网络失败:原 operationKey/载荷原样重试(唯一 Promise 不可变载荷);receipt 后卸载不再补 final/stop', async () => {
    vi.useFakeTimers();
    let finishAttempts = 0;
    when('POST', /\/playback\/sessions\/sess-vod-1\/finish$/, () => {
      finishAttempts += 1;
      if (finishAttempts === 1) {
        throw new TypeError('network down');
      }
      return jsonResponse(finishReceipt());
    });
    const { unmount } = renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(
      () => expect(finishBodies().length, contractNote('finish 未重试', 'T064 一次 final Promise 原样重试')).toBeGreaterThanOrEqual(2),
      4_000,
    );
    const attempts = finishBodies();
    expect(new Set(attempts.map((body) => JSON.stringify(body))).size, '重试载荷必须逐字节一致(不可变载荷)').toBe(1);
    expect(UUID_PATTERN.test(String(attempts[0]?.operationKey))).toBe(true);
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown')).toBeInTheDocument());
    expect(screen.getAllByTestId('autoplay-countdown')).toHaveLength(1);
    // receipt 已取得:卸载不再补 final/stop(T064 一次 final;ui.md §2)
    const finishCountBeforeUnmount = finishBodies().length;
    unmount();
    await pumpTimers(1_000);
    expect(finishBodies()).toHaveLength(finishCountBeforeUnmount);
    expect(stopBodies(), 'receipt 后卸载不得补 stop final').toHaveLength(0);
  });
});

// ────────────────────────── F · 目标改变重新确认(审查补充) ──────────────────────────

describe('010 T063 · 倒计时目标改变重新确认', () => {
  it('F1 [T064] 意图撞 409 NEXT_PLAN_CHANGED:重取计划并重新展示新目标,先前选择不自动套用;显式确认才以新计划 ref 重建意图', async () => {
    vi.useFakeTimers();
    const plans = [
      nextPlan({ nextPlanRef: 'plan-1', label: '第2集' }),
      nextPlan({ nextPlanRef: 'plan-2', targetMediaId: 'media-3', label: '第3集' }),
    ];
    when('POST', /\/playback\/next-plans$/, () => {
      const plan = plans.shift();
      return plan === undefined ? problemResponse(410, 'NEXT_PLAN_EXPIRED') : jsonResponse(plan);
    });
    const intentBodies: Array<Record<string, unknown>> = [];
    when('POST', /\/playback\/transition-intents$/, (body) => {
      intentBodies.push(body as Record<string, unknown>);
      if (intentBodies.length === 1) {
        return problemResponse(409, 'NEXT_PLAN_CHANGED');
      }
      return jsonResponse(intentReply({ id: 'intent-2', targetMediaId: 'media-3' }), 201);
    });
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown')).toBeInTheDocument());
    expect(screen.getByTestId('autoplay-countdown').textContent).toContain('第2集');
    await pumpTimers(5_500);
    // 409 → 重新取计划(api.md §6 恢复动作)
    await awaitUi(() => expect(nextPlanRequests(), contractNote('409 后未重取计划', 'NEXT_PLAN_CHANGED → 重新取计划')).toHaveLength(2));
    await awaitUi(() => {
      const countdown = screen.getByTestId('autoplay-countdown');
      expect(countdown.textContent).toContain('第3集');
      expect(countdown.textContent).not.toContain('第2集');
    });
    // 重新确认:先前到期选择不得自动套到新目标(ui.md §6)
    await pumpTimers(10_000);
    expect(intentBodies, contractNote('新目标被静默消费', '不重新确认不得静默换目标')).toHaveLength(1);
    // 显式确认后以新计划 ref 重建意图
    fireEvent.click(screen.getByRole('button', { name: /立即/ }));
    await pumpTimers(500);
    expect(intentBodies).toHaveLength(2);
    expect(String(intentBodies[1]?.nextPlanRef)).toBe('plan-2');
  });

  it('F2 [T064] 意图撞 410 NEXT_PLAN_EXPIRED:同样重取计划/重新展示,零静默重建,显式确认后用新 ref', async () => {
    vi.useFakeTimers();
    const plans = [
      nextPlan({ nextPlanRef: 'plan-1', label: '第2集' }),
      nextPlan({ nextPlanRef: 'plan-2', targetMediaId: 'media-3', label: '第3集' }),
    ];
    when('POST', /\/playback\/next-plans$/, () => {
      const plan = plans.shift();
      return plan === undefined ? problemResponse(410, 'NEXT_PLAN_EXPIRED') : jsonResponse(plan);
    });
    const intentBodies: Array<Record<string, unknown>> = [];
    when('POST', /\/playback\/transition-intents$/, (body) => {
      intentBodies.push(body as Record<string, unknown>);
      if (intentBodies.length === 1) {
        return problemResponse(410, 'NEXT_PLAN_EXPIRED');
      }
      return jsonResponse(intentReply({ id: 'intent-2', targetMediaId: 'media-3' }), 201);
    });
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /立即/ }));
    await pumpTimers(300);
    expect(intentBodies).toHaveLength(1);
    await awaitUi(() =>
      expect(nextPlanRequests(), contractNote('410 后未重取计划', 'NEXT_PLAN_EXPIRED → 重新取计划并展示')).toHaveLength(2),
    );
    await awaitUi(() => expect(screen.getByTestId('autoplay-countdown').textContent).toContain('第3集'));
    await pumpTimers(10_000);
    expect(intentBodies, '过期计划不得静默重建意图').toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /立即/ }));
    await pumpTimers(500);
    expect(intentBodies).toHaveLength(2);
    expect(String(intentBodies[1]?.nextPlanRef)).toBe('plan-2');
  });
});

// ────────────────────────── G · 未知 duration 起播不误杀(审查补充) ──────────────────────────

describe('010 T063 · 未知 duration 起播不误杀', () => {
  it('G1 [现状绿] duration 未知媒体正常播放:started/周期照发、显示进度不可保存、不终止、无倒计时(T049 面)', async () => {
    vi.useFakeTimers();
    renderPlayerView({ durationSeconds: null });
    await pumpTimers(50);
    await startPlayback(5);
    await pumpTimers(10_000);
    expect(progressBodies().filter((body) => body.reason === 'started')).toHaveLength(1);
    expect(progressBodies().filter((body) => body.reason === 'periodic').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('progress-unsavable')).toBeInTheDocument();
    expect(terminated, '进度不可保存不得终止播放').not.toHaveBeenCalled();
    expect(screen.queryByTestId('autoplay-countdown')).not.toBeInTheDocument();
  });

  it('G2 [T064] 未知时长自然结束:finish 照发(不因进度不可保存跳过)→ receipt no_duration/autoNextEligible=false → 无倒计时/无意图、不悬挂', async () => {
    vi.useFakeTimers();
    when('GET', /\/playback\/sessions\/sess-vod-1$/, () =>
      jsonResponse(playbackDto({ state: 'ready', durationSeconds: null })),
    );
    when('POST', /\/playback\/sessions\/sess-vod-1\/finish$/, () =>
      jsonResponse(
        finishReceipt({
          sessionCompleted: false,
          autoNextEligible: false,
          reason: 'no_duration',
          historyApplied: false,
          historyRevision: null,
          durationSeconds: null,
        }),
      ),
    );
    renderPlayerView();
    await pumpTimers(50);
    await startPlayback(5);
    await naturalEnd(3600);
    await awaitUi(() =>
      expect(finishBodies(), contractNote('未知时长未发起 finish', '§4 无证据不等于接口失败,finish 照发交服务端判定')).toHaveLength(1),
    );
    const finish = finishBodies()[0];
    expect(finish?.cause).toBe('natural_end');
    // 资格判定确定性收口:no_duration → autoNextEligible=false → 无连播、UI 不误杀不悬挂
    await pumpTimers(6_500);
    expect(screen.queryByTestId('autoplay-countdown')).not.toBeInTheDocument();
    expect(nextPlanRequests()).toHaveLength(0);
    expect(intentRequests()).toHaveLength(0);
    expect(terminated, '资格否决不得终止 UI').not.toHaveBeenCalled();
  });
});
