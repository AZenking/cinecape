import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import type { Vod } from '@hmp/shared';
import type { ChannelRowDto } from '@hmp/shared';
import { ActionCoordinator, usePlayAction } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { LiveWatchPage } from '../../../src/features/live/pages/LiveWatchPage';
import {
  buildChannelListPage,
  LIVE_REDESIGN_CHANNELS_BY_GROUP,
  LIVE_REDESIGN_NOW_ISO,
} from '../../fixtures/live-redesign-fixtures';
import { LIVE_SESSION_STATES, renderLiveWorld } from '../../helpers/live-world';
import { installNetworkCounter } from '../../helpers/network-assertions';

/**
 * 015 T014 · US4 播放与详情一体化页(LiveWatchPage)单测。
 *
 * 权威:docs/specs/015-live-flow-redesign/
 * - spec.md US4 验收 1~4、FR-010/011/012/013、quickstart.md 场景 4;
 * - research.md R4(就地换台)、data-model.md §2.3 + §3.1(切台状态机)、
 *   contracts/routing-and-url-state.md §2.4(:channelId 必选 + from 返回 + replace 同步)、
 *   contracts/ui-layout.md §4(Screen 4 线框)、contracts/api-reuse.md(公共元数据 +
 *   resolve 强鉴权行)。
 *
 * 播放架构硬约束:页面零独立播放管线 —— 全部播放只经 usePlayAction().play()
 * (ActionCoordinator 唯一状态机;播放面 = data-testid="playback-surface" 全局浮层)。
 * 断言方式与 test/live-identity-switch.spec.tsx 同形:
 * - video.js 换为无副作用假引擎(jsdom 无媒体实现;断言面为协调器链路而非引擎);
 * - 路由式 fetch 桩覆盖 resolve(201 preparing)→ sessions 轮询(ready)→ renew
 *   (换票)→ stop/heartbeat/observations(204)/progress(accepted);
 * - PlaybackIntentProbe 直读 usePlayAction().playback(意图面),断言 play 以
 *   「当前路由 channelId」自动发起(进入即起播,零交互);
 * - 游客:网络计数器钉「授权前零 /playback 与 /me 请求」+ 统一登录弹层拦截
 *   (拦截行为归 ActionCoordinator,本文件不自写登录判断);
 * - 就地换台:点击同类卡片 → 恰好第二次 resolve 且 mediaId 为新频道、页面根 DOM
 *   节点身份不变(组件不卸载 = 不整页重载)、内存路由 URL 已同步为新频道地址、
 *   伴随面板随缓存派生即时更新。
 *
 * 数据层:015 fixtures(live-redesign-fixtures)——NOW 锚点 2026-11-15T12:00Z,
 * 家庭时区 Asia/Shanghai(20:00);电影组 3 频道当前节目窗各异,进度百分比可复算:
 * 星光影城 NOW−20→NOW+40 → 33%;经典电影台 NOW−35→NOW+25 → 58%。
 */

// ────────────────────────── 引擎边界 mock(jsdom;live-identity-switch 同款) ──────────────────────────

vi.mock('video.js', () => {
  class FakePlayer {
    on(): void {}
    addClass(): void {}
    src(): void {}
    play(): undefined {
      return undefined;
    }
    dispose(): void {}
  }
  return { default: () => new FakePlayer() };
});

// ────────────────────────── 夹具与频道选取 ──────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function problemResponse(status: number, code: string): Response {
  return jsonResponse({ status, code, title: code }, status);
}

type PlaybackDto = Vod.components['schemas']['PlaybackDto'];

/** 最小合法 PlaybackDto(直播契约:durationSeconds=null/seekCapability=none;identity-switch 同款) */
function playbackDto(overrides: Partial<PlaybackDto> = {}): PlaybackDto {
  return {
    id: 'ps-1',
    state: 'ready',
    version: 1,
    generation: 1,
    desiredPaused: false,
    delivery: 'hls_proxy',
    positionSeconds: 0,
    durationSeconds: null,
    timelineOffsetSeconds: 0,
    presentationStartSeconds: 0,
    ticketExpiresAt: null,
    playbackUrl: null,
    tracks: { audio: [], subtitles: [] },
    startBasis: 'beginning',
    resumeDisposition: 'beginning',
    resumeReason: null,
    transitionSlot: { revision: 0, status: 'open', activeIntentId: null, successorSessionId: null },
    seekCapability: 'none',
    playbackStarted: false,
    ...overrides,
  };
}

/** 电影组频道选取(015 fixtures:电影组 [星光影城, 经典电影台, 动作影院]) */
function movieChannel(index: number): ChannelRowDto {
  const row = LIVE_REDESIGN_CHANNELS_BY_GROUP['movie']?.[index];
  if (row === undefined) {
    throw new Error(`015 fixtures 异常:电影组第 ${index} 个频道缺失`);
  }
  return row;
}

/** 初始入场频道(星光影城;ChannelTile 015 双层交互导航目标同源) */
const STAR = movieChannel(0);
/** 就地换台目标频道(经典电影台) */
const CLASSIC = movieChannel(1);

// ────────────────────────── fetch 路由桩(公共元数据 + resolve→playing 全链) ──────────────────────────

let resolveBodies: Array<Record<string, unknown>> = [];
let fetchMock: Mock;

function installWatchFetchRouter(): void {
  resolveBodies = [];
  let resolveCount = 0;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost:3000');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    if (method === 'GET' && path === '/api/setup/status') {
      return jsonResponse({ initialized: true });
    }
    // 公共频道列表(section=all 频道元数据查询 + section=group 同类推荐查询,同一端点)
    if (method === 'GET' && path === '/api/public/live/channels') {
      const groupKey = url.searchParams.get('groupKey');
      return jsonResponse(buildChannelListPage(groupKey !== null ? { groupKey } : {}));
    }
    if (method === 'POST' && path === '/api/playback/resolve') {
      resolveBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      resolveCount += 1;
      const id = `ps-${resolveCount}`;
      return jsonResponse(playbackDto({ id, state: 'preparing' }), 201);
    }
    const sessionMatch = /^\/api\/playback\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null && sessionMatch[1] !== undefined && method === 'GET') {
      return jsonResponse(playbackDto({ id: sessionMatch[1], state: 'ready' }));
    }
    const renewMatch = /^\/api\/playback\/sessions\/([^/]+)\/renew$/.exec(path);
    if (renewMatch !== null && renewMatch[1] !== undefined) {
      return jsonResponse({
        playbackUrl: `/api/playback/stream/${renewMatch[1]}/1/index.m3u8?ticket=t-${renewMatch[1]}`,
        ticketExpiresAt: '2099-01-01T00:00:00.000Z',
        generation: 1,
      });
    }
    if (/^\/api\/playback\/sessions\/[^/]+\/(stop|heartbeat|observations)$/.test(path)) {
      return new Response(null, { status: 204 });
    }
    if (/^\/api\/playback\/sessions\/[^/]+\/progress$/.test(path)) {
      return jsonResponse({
        applied: true,
        reason: 'accepted',
        historyRevision: 1,
        sessionAccepted: true,
        acceptedSampleSeq: 1,
        acceptedPositionSeconds: 0,
        acceptedGeneration: 1,
        sessionStarted: true,
      });
    }
    return problemResponse(404, 'NOT_FOUND');
  });
  vi.stubGlobal('fetch', fetchMock);
}

// ────────────────────────── 探针与挂载基座 ──────────────────────────

/** 内存路由探针:断言 URL 同步(replace 语义由实现经 navigate(..., {replace:true}) 承担) */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="watch-location">{location.pathname}{location.search}</span>;
}

/** 播放意图探针:直读 usePlayAction().playback(唯一播放管线),断言目标与相位 */
function PlaybackIntentProbe(): ReactNode {
  const { playback } = usePlayAction();
  return (
    <span data-testid="playback-intent">
      {playback === null ? '-' : `${playback.target.mediaId}@${playback.phase}`}
    </span>
  );
}

interface WatchHarnessOptions {
  readonly session: (typeof LIVE_SESSION_STATES)[keyof typeof LIVE_SESSION_STATES];
  readonly initialEntry: string;
}

/** 挂载 LiveWatchPage(MemoryRouter + Route 直挂路由参数;不依赖 Wave 3 真实路由注册) */
function renderWatchPage(options: WatchHarnessOptions) {
  // 顺序:先装路由桩(stubGlobal)→ 计数器包装其上 → renderLiveWorld 会话 mock 包在最外层
  const counter = installNetworkCounter();
  const world = renderLiveWorld(
    <>
      <Routes>
        <Route path="/live/watch/:channelId" element={<LiveWatchPage />} />
      </Routes>
      <LocationProbe />
      <PlaybackIntentProbe />
    </>,
    {
      session: options.session,
      initialEntries: [options.initialEntry],
      decorate: (ui: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
  return { counter, world };
}

beforeEach(() => {
  // 016 T011:伴随面板进度接入 useCurrentProgramme 智能时钟(本地钟)。fake 定时器
  // 钟面锚定 015 夹具 NOW(2026-11-15T12:00Z),使「NOW 锚点复算 33%/58%」断言继续
  // 按锚点精确成立(真实 Date.now() 相对夹具为过去 → 进度恒钳 0,原覆盖意图丢失);
  // shouldAdvanceTime 保持真实时间流速,播放管线/waitFor 异步链路与真实时钟同形。
  vi.useFakeTimers({ now: Date.parse(LIVE_REDESIGN_NOW_ISO), shouldAdvanceTime: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ────────────────────────── ① 自动起播(进入即 resolve,零交互) ──────────────────────────

describe('T014 · Screen 4 进入即起播(FR-010;usePlayAction 唯一管线)', () => {
  it('已选档:页面加载后自动以「当前路由 channelId」发起 play(resolve body 断言),全链到 playing 播放面', async () => {
    installWatchFetchRouter();
    const { counter, world } = renderWatchPage({
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntry: `/live/watch/${STAR.media.id}`,
    });
    try {
      // 意图自动发起(零点击):目标 = 路由 channelId,经 authorize→prepare→playing
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${STAR.media.id}@playing`),
        { timeout: 3_000 },
      );
      // play 请求形状:{mediaId: 路由 channelId, startMode: 'beginning'}(直播恒从头)
      expect(resolveBodies).toEqual([{ mediaId: STAR.media.id, startMode: 'beginning' }]);
      // 播放画面由全局播放面呈现(页面零独立播放管线/第二个 PlayerView)
      expect(document.querySelector('[data-testid="playback-surface"]')).not.toBeNull();
      // 浏览行为零个人数据读取(收藏不点击;元数据全走公共只读)
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });

  it('游客:自动起播被统一协调器拦截进入登录弹层;授权前零 /playback 与 /me 请求(FR-014)', async () => {
    installWatchFetchRouter();
    const { counter, world } = renderWatchPage({
      session: LIVE_SESSION_STATES.guest,
      initialEntry: `/live/watch/${STAR.media.id}`,
    });
    try {
      // 拦截行为归 ActionCoordinator:统一登录弹层出现(本文件不自写登录判断)
      await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
      expect(screen.getByRole('heading', { name: '登录' })).toBeVisible();
      // 意图暂存期间:播放面为空,零媒体流请求(resolve 从未发起)
      expect(screen.getByTestId('playback-intent').textContent).toBe('-');
      expect(resolveBodies).toEqual([]);
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
      // 取消登录:弹层收口、意图废弃;仍零请求,不自动播放
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(screen.getByTestId('playback-intent').textContent).toBe('-');
      expect(counter.counts.playback).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

// ────────────────────────── ② 右侧元数据伴随渲染(FR-011;ui-layout §4.2) ──────────────────────────

describe('T014 · 右侧伴随面板:频道名/当前节目/进度条/简介/收藏/Next', () => {
  it('展示频道名、当前节目标题、进度百分比条(NOW 锚点复算 33%)、简介、收藏按钮与 Next 预告', async () => {
    installWatchFetchRouter();
    // 已选档会话:自动起播直达 playing(全局播放面),背景不被登录弹层 aria-hidden,
    // 伴随面板可被角色查询断言(游客路径的拦截语义已由上一用例钉住)
    const { world } = renderWatchPage({
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntry: `/live/watch/${STAR.media.id}`,
    });
    try {
      // 频道名(伴随面板标题)
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '星光影城' })).toBeVisible());
      // 当前节目标题
      expect(screen.getByText('星际回响')).toBeVisible();
      // 进度百分比条:服务端快照 NOW(2026-11-15T12:00Z),窗 NOW−20→NOW+40 → 已播 33%
      const bar = screen.getByRole('progressbar', { name: '当前节目播出进度' });
      expect(bar).toHaveAttribute('aria-valuenow', '33');
      // 简介(当前节目描述)
      expect(screen.getByText('科幻大片:深空殖民舰收到无法解析的信号')).toBeVisible();
      // 收藏按钮(游客态:登录引导语义,与 ChannelTile 同形)
      expect(screen.getByRole('button', { name: '收藏 星光影城' })).toBeVisible();
      // Next 预告:节目标题 + 开播时刻(NOW+40min = 12:40Z = 家庭时区 20:40)
      expect(screen.getByText('午夜场:雾都疑云')).toBeVisible();
      expect(screen.getByText('20:40')).toBeVisible();
      expect(LIVE_REDESIGN_NOW_ISO).toBe('2026-11-15T12:00:00.000Z'); // 锚点自检(进度复算依据)
    } finally {
      world.restore();
    }
  });
});

// ────────────────────────── ③ 就地换台(R4;FR-013;data-model §3.1) ──────────────────────────

describe('T014 · 点击同类卡片就地换流(页面不卸载;URL 静默同步;面板即时更新)', () => {
  it('点击「切换到 经典电影台」:恰好第二次 resolve 且 mediaId 为新频道,页面根 DOM 节点身份不变,内存路由更新,伴随面板随新频道派生', async () => {
    installWatchFetchRouter();
    const { world } = renderWatchPage({
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntry: `/live/watch/${STAR.media.id}`,
    });
    try {
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${STAR.media.id}@playing`),
        { timeout: 3_000 },
      );
      // 页面根节点快照(换台后同一节点仍连接 = 组件未卸载/未整页重载)
      const rootNode = document.querySelector('[data-testid="live-watch-page"]');
      expect(rootNode).not.toBeNull();

      fireEvent.click(screen.getByRole('button', { name: `切换到 ${CLASSIC.media.title}` }));

      // 新意图即时取代旧意图(play 新 mediaId):Playing → Resolving → Playing(§3.1)
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${CLASSIC.media.id}@playing`),
        { timeout: 3_000 },
      );
      expect(resolveBodies).toHaveLength(2);
      expect(resolveBodies[1]).toEqual({ mediaId: CLASSIC.media.id, startMode: 'beginning' });

      // 地址栏静默同步为 /live/watch/:newChannelId(routing-and-url-state §2.4)
      expect(screen.getByTestId('watch-location').textContent).toBe(`/live/watch/${CLASSIC.media.id}`);

      // 页面组件未因换台重挂载:同一 DOM 根节点仍在文档中
      expect(document.querySelector('[data-testid="live-watch-page"]')).toBe(rootNode);
      expect(rootNode?.isConnected).toBe(true);

      // 伴随面板即时更新(数据随 channelId 派生):频道名/当前节目/进度(经典电影台 58%)
      expect(screen.getByRole('heading', { level: 1, name: '经典电影台' })).toBeVisible();
      expect(screen.getByText('罗马假日')).toBeVisible();
      expect(screen.getByRole('progressbar', { name: '当前节目播出进度' })).toHaveAttribute('aria-valuenow', '58');

      // 新的当前频道已从同类横条排除(activeChannelId 前端过滤)
      expect(screen.queryByRole('button', { name: `切换到 ${CLASSIC.media.title}` })).toBeNull();
    } finally {
      world.restore();
    }
  });
});

// ────────────────────────── ④ 同类横条排除当前频道(§2.3 sameTypeLiveChannels) ──────────────────────────

describe('T014 · 同类型直播横条(sam type live)', () => {
  it('仅展示同组其他频道(排除当前 activeChannelId),组外频道不出现', async () => {
    installWatchFetchRouter();
    const { world } = renderWatchPage({
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntry: `/live/watch/${STAR.media.id}`,
    });
    try {
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: '星光影城' })).toBeVisible());
      expect(screen.getByText('同类型直播')).toBeVisible();
      // 同组(电影)其他频道在列,当前频道被排除
      expect(screen.getByRole('button', { name: '切换到 经典电影台' })).toBeVisible();
      expect(screen.getByRole('button', { name: '切换到 动作影院' })).toBeVisible();
      expect(screen.queryByRole('button', { name: '切换到 星光影城' })).toBeNull();
      // 组外(音乐/体育)频道不出现
      expect(screen.queryByRole('button', { name: '切换到 流行音乐台' })).toBeNull();
      expect(screen.queryByRole('button', { name: '切换到 体育赛事台' })).toBeNull();
    } finally {
      world.restore();
    }
  });
});

// ────────────────────────── 左上返回按钮(from 参数;routing-and-url-state §2.4) ──────────────────────────

describe('T014 · 返回按钮按 ?from= 显式导航(缺省 /live)', () => {
  it('from=guide → 返回 /live/guide', async () => {
    installWatchFetchRouter();
    const { world } = renderWatchPage({
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntry: `/live/watch/${STAR.media.id}?from=guide`,
    });
    try {
      await waitFor(() => expect(screen.getByRole('button', { name: '返回节目单' })).toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: '返回节目单' }));
      expect(screen.getByTestId('watch-location').textContent).toBe('/live/guide');
    } finally {
      world.restore();
    }
  });

  it('未携带 from → 返回 /live', async () => {
    installWatchFetchRouter();
    const { world } = renderWatchPage({
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntry: `/live/watch/${STAR.media.id}`,
    });
    try {
      await waitFor(() => expect(screen.getByRole('button', { name: '返回直播首页' })).toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: '返回直播首页' }));
      expect(screen.getByTestId('watch-location').textContent).toBe('/live');
    } finally {
      world.restore();
    }
  });
});
