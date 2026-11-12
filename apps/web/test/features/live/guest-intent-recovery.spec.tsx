import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import type { ChannelRowDto, GuideWindowDto, Vod } from '@hmp/shared';
import type { AccountSession, ProfileSummary } from '../../../src/app/session-types';
import { ActionCoordinator, usePlayAction } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { LivePage } from '../../../src/features/live/LivePage';
import { GuidePage } from '../../../src/features/epg/GuidePage';
import {
  LIVE_REDESIGN_CATALOG_REVISION,
  LIVE_REDESIGN_CHANNELS_BY_GROUP,
  LIVE_REDESIGN_NOW_ISO,
  LIVE_REDESIGN_TIMEZONE,
  buildChannelListPage,
  buildChannelRow,
  buildGroupPage,
  windowFromMinutes,
} from '../../fixtures/live-redesign-fixtures';
import {
  LIVE_SESSION_STATES,
  LiveSessionProbe,
  liveSessionFixture,
  renderLiveWorld,
} from '../../helpers/live-world';
import { installNetworkCounter } from '../../helpers/network-assertions';

/**
 * 015 T021 [US5] · 游客起播意图「入口层」全链路恢复单测(测试先行)。
 *
 * 权威:docs/specs/015-live-flow-redesign/
 * - spec.md US5 验收 2/3/4 + FR-014(授权前绝不请求媒体流);
 * - quickstart.md 场景 5(Network 零媒体流请求 + 取消回原视口);
 * - research.md R7(intentId/PlayTarget{mediaId,title,startMode:'beginning'},
 *   认证后消费意图发起 resolve,取消保留原视口);
 * - data-model.md §3.2(游客意图状态转移:GuestBrowsing → IntentCaptured →
 *   AuthModal → ResolvedAndPlaying / 回 GuestBrowsing)。
 *
 * 与既有覆盖的分工:协调器级意图保存/恢复/取消生命周期已由
 * test/live-intent-coordinator.spec.tsx(reducer 级)与
 * test/playback/action-coordinator.spec.tsx(探针按钮级)钉住;本文件钉
 * 「入口层」——游客在三个真实起播端点(Hero 大屏 / ChannelTile 中央 ▶ /
 * EPG current 节目块)上的全链路:点击 → 统一认证 Modal → 授权前零
 * /playback/ 与 /me/ 请求(network-assertions)→ 完成登录+选档 → Modal
 * 关闭、协调器自动消费暂存意图 → resolve 请求体精确等于最初点击的
 * { mediaId, startMode: 'beginning' } → 全局播放面呈现该频道。
 *
 * 关键范式(沿用既有约定):
 * - 真实 ActionCoordinator 全链(与 live-watch-page.spec 同形):video.js 换
 *   无副作用假引擎(jsdom 无媒体实现,断言面为协调器链路);路由式 fetch 桩
 *   覆盖 resolve(201 preparing)→ sessions 轮询(ready)→ renew(换票)→
 *   stop/heartbeat/observations(204)/progress(accepted);
 * - 游客模态链会把弹层外内容 aria-hidden(HeroUI Modal.Backdrop),弹层打开
 *   期间的背景断言一律用 getByTestId 探针(播放意图/路由/页面在位性),
 *   角色查询只用于弹层内部(live-watch-page.spec 偏离记录同款);
 * - 登录 → 选档编排原样复用 test/playback/action-coordinator.spec.tsx:
 *   凭据提交(用户名/密码 + 登录按钮)→ 选择 Profile(妈妈,无 PIN 直选);
 * - returnTo 语义(非缺陷,留档):jsdom 的 window.location 恒为
 *   `http://localhost:3000/`,currentPathTarget() 读到的原视口即 '/',
 *   故选档完成后的 navigate(returnTo) 在 MemoryRouter 里落到 '/'(015
 *   路由元素未在测试世界注册,探针页 path="*" 恒挂载,播放链不受影响);
 *   取消路径不导航(协调器契约:用户本就停留在原页面),④ 据此断言路由不变。
 *
 * 数据层:015 fixtures(live-redesign-fixtures)——NOW 锚点
 * 2026-11-15T12:00Z(家庭时区 Asia/Shanghai 20:00),Hero = now 区首频道
 * 星光影城,卡片入口取同组第二频道经典电影台(与 Hero 目标可区分),
 * EPG 入口为单频道墙窗(与 NOW 严格相交的 current 块)。
 */

// ────────────────────────── 引擎边界 mock(jsdom;live-watch-page 同款) ──────────────────────────

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

/** 最小合法 PlaybackDto(直播契约:durationSeconds=null/seekCapability=none;live-watch-page 同款) */
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
  const group = LIVE_REDESIGN_CHANNELS_BY_GROUP['movie'];
  const row = group?.[index];
  if (row === undefined) {
    throw new Error(`015 fixtures 异常:电影组第 ${index} 个频道缺失`);
  }
  return row;
}

/** Hero 入口频道(= now 区服务端稳定排序首频道「星光影城」,与 LivePage 取行同源) */
const HERO = movieChannel(0);
/** 卡片入口频道(经典电影台;与 Hero 目标可区分,钉「暂存的是最初点击的那张卡」) */
const TILE = movieChannel(1);

/** EPG 入口频道(单频道墙窗;current 与 NOW 严格相交) */
const EPG_CH_ID = 'b0000000-0000-4000-8000-0000000000f5';
const EPG_CH_TITLE = 'EPG 意图台';

/** GuideWindow 夹具:单频道,current 块与 NOW 相交、next 在 NOW 之后(live-routing-epg 同形) */
function guideWindowFixture(): GuideWindowDto {
  const row = buildChannelRow({
    id: EPG_CH_ID,
    title: EPG_CH_TITLE,
    groupKey: 'movie',
    groupLabel: '电影',
    current: {
      key: 'lr-guest:current',
      title: '正在播出的新闻直播',
      description: '与 NOW 红线相交的当前节目',
      startsAtMinutes: -20,
      endsAtMinutes: 40,
    },
    next: {
      key: 'lr-guest:next',
      title: '未开播的下一档',
      startsAtMinutes: 40,
      endsAtMinutes: 100,
    },
  });
  const span = windowFromMinutes(-120, 180);
  return {
    date: '2026-11-15',
    timezone: LIVE_REDESIGN_TIMEZONE,
    now: LIVE_REDESIGN_NOW_ISO,
    allowedDates: ['2026-11-15'],
    from: span.startsAt,
    to: span.endsAt,
    page: 1,
    pageSize: 20,
    totalChannels: 1,
    catalogRevision: LIVE_REDESIGN_CATALOG_REVISION,
    channels: [
      {
        media: row.media,
        programmes: [row.current, row.next].filter(
          (programme): programme is NonNullable<typeof programme> => programme !== null,
        ),
      },
    ],
  };
}

/** 登录成功但未选档的会话(bootstrapRequired=false → 登录后直达选档步) */
function loginSession(): AccountSession {
  return liveSessionFixture(LIVE_SESSION_STATES.authedWithProfile, { activeProfile: null });
}

/** 选档完成后的会话(主档案「妈妈」,无 PIN 直选) */
function selectedSession(): AccountSession {
  return liveSessionFixture(LIVE_SESSION_STATES.authedWithProfile);
}

/** 选档列表中的可直选档案(与 selectedSession().activeProfile 同一身份) */
function pickerProfile(): ProfileSummary {
  const profile = liveSessionFixture(LIVE_SESSION_STATES.authedWithProfile).activeProfile;
  if (profile === null) {
    throw new Error('live-world 夹具异常:主档案缺失');
  }
  return profile;
}

// ────────────────────────── fetch 路由桩(公共浏览 + 登录选档 + resolve→playing 全链) ──────────────────────────

/** POST /playback/resolve 请求体捕获(意图消费的精确断言面) */
let resolveBodies: Array<Record<string, unknown>> = [];

function installIntentFlowRouter(): void {
  resolveBodies = [];
  let resolveCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.pathname;
      if (method === 'GET' && path === '/api/setup/status') {
        return Promise.resolve(jsonResponse({ initialized: true }));
      }
      // 公共浏览数据(LivePage 三分区共用同一端点;section 参数不影响桩内容)
      if (method === 'GET' && path === '/api/public/live/channels') {
        return Promise.resolve(jsonResponse(buildChannelListPage()));
      }
      if (method === 'GET' && path === '/api/public/live/groups') {
        return Promise.resolve(jsonResponse(buildGroupPage()));
      }
      // EPG 墙窗(GuidePage)
      if (method === 'GET' && path === '/api/public/guide') {
        return Promise.resolve(jsonResponse(guideWindowFixture()));
      }
      // 登录 → 选档(认证期间零 /playback/ 的前提:这些端点均不在计数面前缀)
      if (method === 'POST' && path === '/api/auth/login') {
        return Promise.resolve(jsonResponse(loginSession()));
      }
      if (method === 'GET' && path === '/api/profiles') {
        return Promise.resolve(jsonResponse([pickerProfile()]));
      }
      if (method === 'POST' && /^\/api\/profiles\/profile-a\/select$/.test(path)) {
        return Promise.resolve(jsonResponse(selectedSession()));
      }
      // 意图消费后的播放链:resolve(201 preparing)→ 轮询(ready)→ renew(换票)
      if (method === 'POST' && path === '/api/playback/resolve') {
        resolveBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        resolveCount += 1;
        return Promise.resolve(jsonResponse(playbackDto({ id: `ps-${resolveCount}`, state: 'preparing' }), 201));
      }
      const sessionMatch = /^\/api\/playback\/sessions\/([^/]+)$/.exec(path);
      if (sessionMatch !== null && sessionMatch[1] !== undefined && method === 'GET') {
        return Promise.resolve(jsonResponse(playbackDto({ id: sessionMatch[1], state: 'ready' })));
      }
      const renewMatch = /^\/api\/playback\/sessions\/([^/]+)\/renew$/.exec(path);
      if (renewMatch !== null && renewMatch[1] !== undefined) {
        return Promise.resolve(
          jsonResponse({
            playbackUrl: `/api/playback/stream/${renewMatch[1]}/1/index.m3u8?ticket=t-${renewMatch[1]}`,
            ticketExpiresAt: '2099-01-01T00:00:00.000Z',
            generation: 1,
          }),
        );
      }
      if (/^\/api\/playback\/sessions\/[^/]+\/(stop|heartbeat|observations)$/.test(path)) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (/^\/api\/playback\/sessions\/[^/]+\/progress$/.test(path)) {
        return Promise.resolve(
          jsonResponse({
            applied: true,
            reason: 'accepted',
            historyRevision: 1,
            sessionAccepted: true,
            acceptedSampleSeq: 1,
            acceptedPositionSeconds: 0,
            acceptedGeneration: 1,
            sessionStarted: true,
          }),
        );
      }
      return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
    }),
  );
}

beforeEach(() => {
  installIntentFlowRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ────────────────────────── 探针与挂载基座 ──────────────────────────

/** 内存路由探针:④ 取消路径断言「停留原视口,路由不变」(弹层开时背景 aria-hidden,用 testid 读) */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="guest-location">{location.pathname}{location.search}</span>;
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

interface GuestWorldOptions {
  readonly initialEntry: string;
  readonly page: 'home' | 'guide';
}

/** 挂载真实页面入口(MemoryRouter path="*" 直挂;页面元素在 returnTo 导航后仍恒在) */
function renderGuestWorld(options: GuestWorldOptions) {
  // 顺序:先装路由桩(stubGlobal,见 beforeEach)→ 计数器包装其上 → renderLiveWorld 会话 mock 包在最外层
  const counter = installNetworkCounter();
  const world = renderLiveWorld(
    <>
      <Routes>
        <Route
          path="*"
          element={options.page === 'home' ? <LivePage /> : <GuidePage />}
        />
      </Routes>
      <LiveSessionProbe />
      <LocationProbe />
      <PlaybackIntentProbe />
    </>,
    {
      session: LIVE_SESSION_STATES.guest,
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

/** 游客世界就绪(会话恢复为 anonymous:none) */
async function waitForGuestSession(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('anonymous:none'));
}

/**
 * 统一认证弹层内完成登录 + 选档(编排复用 test/playback/action-coordinator.spec.tsx):
 * 登录表单提交 → 选档列表(无 PIN 直选「妈妈」)。弹层打开期间背景 aria-hidden,
 * 仅允许弹层内部的角色查询(live-watch-page.spec 偏离记录)。
 */
async function completeLoginAndPickProfile(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
  expect(screen.getByRole('heading', { name: '登录' })).toBeVisible();
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password-123' } });
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  // 等「妈妈」按钮本体挂载(标题先渲染、/profiles fetch 后到是已知竞态;waitFor 轮询消除窗口期)
  await waitFor(() => expect(screen.getByRole('button', { name: /妈妈/ })).toBeVisible());
  fireEvent.click(screen.getByRole('button', { name: /妈妈/ }));
}

/** 弹层静默期负向断言:授权前零 /playback/ 与 /me/ 请求、resolve 从未发起、播放面为空 */
function expectNoAuthorizeBeforeAuth(): void {
  expect(resolveBodies).toEqual([]);
  expect(screen.getByTestId('playback-intent').textContent).toBe('-');
  expect(screen.queryByTestId('playback-surface')).toBeNull();
}

// ────────────────────────── ① Hero 入口(游客在 /live 直接收看) ──────────────────────────

describe('T021 · Hero 入口:游客「直接收看」→ 统一认证 → 意图自动消费(FR-014/R7/§3.2)', () => {
  it('游客点击 LiveHeroPlayer「直接收看」:弹层拦截且授权前零 /playback/ 与 /me/ 请求;完成登录选档后 resolve 请求体精确等于最初点击的频道,播放面呈现该频道', async () => {
    const { counter, world } = renderGuestWorld({ initialEntry: '/live', page: 'home' });
    try {
      await waitForGuestSession();
      // Hero 就绪(now 区首频道 = 星光影城;游客呈现「直接收看」入口)
      const heroPlay = await screen.findByRole('button', { name: `直接收看 ${HERO.media.title}` });
      // 浏览期零授权面(公共元数据全走 /public/*,不在计数面前缀)
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);

      fireEvent.click(heroPlay);

      // 统一认证 Modal 拦截;授权前零媒体流请求(Network 零断言,quickstart 场景 5)
      await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
      expectNoAuthorizeBeforeAuth();
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);

      // 完成登录 + 选档:弹层关闭,协调器自动消费暂存意图(resolve → prepare → playing)
      await completeLoginAndPickProfile();
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${HERO.media.id}@playing`),
        { timeout: 3_000 },
      );

      // 意图消费精确面:resolve 请求体 = { mediaId: 最初点击的频道, startMode: 'beginning' }(R7)
      expect(resolveBodies).toEqual([{ mediaId: HERO.media.id, startMode: 'beginning' }]);
      // 播放面呈现该频道(全局唯一播放浮层;认证弹层已关闭)
      const surface = screen.getByTestId('playback-surface');
      expect(surface.getAttribute('aria-label')).toBe(`播放 ${HERO.media.title}`);
      expect(within(surface).getByRole('heading', { name: HERO.media.title })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull();
      // 全链零个人数据读取(登录/选档走 /auth /profiles,非 /me/*)
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

// ────────────────────────── ② 卡片入口(ChannelTile 中央 ▶) ──────────────────────────

describe('T021 · 卡片入口:游客 ChannelTile 中央 ▶ → 同一全链(R5 双层交互/FR-014)', () => {
  it('游客点击卡片中央 ▶(经典电影台):弹层拦截、授权前零请求;完成登录选档后 resolve mediaId 为卡片频道', async () => {
    const { counter, world } = renderGuestWorld({ initialEntry: '/live', page: 'home' });
    try {
      await waitForGuestSession();
      // 中央 ▶ 恒在 DOM(jsdom 不计算 hover 样式);频道在 Now/Next/泳道多行出现,任取其一
      const tilePlay = await screen.findAllByRole('button', { name: `播放 ${TILE.media.title}` });
      fireEvent.click(tilePlay[0] as HTMLElement);

      // 统一认证 Modal 拦截;授权前零媒体流请求
      await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
      expectNoAuthorizeBeforeAuth();
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);

      await completeLoginAndPickProfile();
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${TILE.media.id}@playing`),
        { timeout: 3_000 },
      );

      // 暂存意图正是最初点击的卡片频道(非 Hero 频道):请求体与播放面双证
      expect(resolveBodies).toEqual([{ mediaId: TILE.media.id, startMode: 'beginning' }]);
      const surface = screen.getByTestId('playback-surface');
      expect(surface.getAttribute('aria-label')).toBe(`播放 ${TILE.media.title}`);
      expect(within(surface).getByRole('heading', { name: TILE.media.title })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull();
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

// ────────────────────────── ③ EPG 入口(GuidePage current 墙块) ──────────────────────────

describe('T021 · EPG 入口:游客 current 节目块点击 → 同一全链(R6/FR-008/FR-014)', () => {
  it('游客在 /live/guide 点击与 NOW 相交的 current 墙块:弹层拦截、授权前零请求;完成登录选档后 resolve mediaId 为墙块频道', async () => {
    const { counter, world } = renderGuestWorld({ initialEntry: '/live/guide', page: 'guide' });
    try {
      await waitForGuestSession();
      // current 墙块(aria-label = 频道,节目,档期,正在直播;live-routing-epg 同款查询)
      const block = await screen.findByRole('button', { name: /EPG 意图台,正在播出的新闻直播/ });

      fireEvent.click(block);

      // 产品统一:current 块先开详情抽屉;播放主操作在详情内显式发起
      const detail = await screen.findByRole('dialog', { name: /节目详情/ });
      fireEvent.click(within(detail).getByRole('button', { name: '播放当前频道' }));
      // 统一认证 Modal 拦截;授权前零媒体流请求
      await waitFor(() => expect(screen.getByRole('dialog', { name: '登录' })).toBeVisible());
      expectNoAuthorizeBeforeAuth();
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);

      await completeLoginAndPickProfile();
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${EPG_CH_ID}@playing`),
        { timeout: 3_000 },
      );

      expect(resolveBodies).toEqual([{ mediaId: EPG_CH_ID, startMode: 'beginning' }]);
      const surface = screen.getByTestId('playback-surface');
      expect(surface.getAttribute('aria-label')).toBe(`播放 ${EPG_CH_TITLE}`);
      expect(within(surface).getByRole('heading', { name: EPG_CH_TITLE })).toBeVisible();
      expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull();
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

// ────────────────────────── ④ 取消路径(意图销毁,停留原视口) ──────────────────────────

describe('T021 · 取消路径:认证弹层关闭 → 意图销毁,停留原视口(spec US5 验收 4/§3.2)', () => {
  it('游客在认证弹层点击取消:不发起任何 resolve、无播放面、路由不变、原页面探针仍在、零 /playback/ 与 /me/ 请求', async () => {
    const { counter, world } = renderGuestWorld({ initialEntry: '/live', page: 'home' });
    try {
      await waitForGuestSession();
      fireEvent.click(await screen.findByRole('button', { name: `直接收看 ${HERO.media.title}` }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
      expect(screen.getByRole('heading', { name: '登录' })).toBeVisible();

      // 取消(登录步取消按钮;遮罩/Esc 与其同路):弹层收口
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      // 意图销毁:静默后仍零 resolve、零播放面、零重复弹窗
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole('dialog')).toBeNull();
      expectNoAuthorizeBeforeAuth();
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);

      // 停留原视口:路由未变,原页面(Hero 大屏)仍在(弹层关闭后背景恢复可查)
      expect(screen.getByTestId('guest-location').textContent).toBe('/live');
      expect(screen.getByTestId('live-hero-player')).toBeVisible();
      expect(screen.getByRole('heading', { name: '直播' })).toBeVisible();
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

// ────────────────────────── ⑤ 认证后第二入口:免二次登录直接授权(加分面) ──────────────────────────

describe('T021 · 会话激活后点击第二入口:直接授权,无需二次登录', () => {
  it('完成一次登录选档后再点另一张卡片:不弹认证层,新点击即时以新 mediaId authorize(会话已激活)', async () => {
    const { counter, world } = renderGuestWorld({ initialEntry: '/live', page: 'home' });
    try {
      await waitForGuestSession();
      // 第一次:Hero 入口全链(游客 → 登录选档 → 播放星光影城)
      fireEvent.click(await screen.findByRole('button', { name: `直接收看 ${HERO.media.title}` }));
      await completeLoginAndPickProfile();
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${HERO.media.id}@playing`),
        { timeout: 3_000 },
      );
      expect(resolveBodies).toEqual([{ mediaId: HERO.media.id, startMode: 'beginning' }]);
      // 会话已激活(登录 + 选档事实已回填 SessionProvider)
      expect(screen.getByTestId('live-session').textContent).toBe('authenticated:profile-a');

      // 第二次:卡片入口(经典电影台)——新意图直接 authorize,零认证弹层
      const tilePlay = await screen.findAllByRole('button', { name: `播放 ${TILE.media.title}` });
      fireEvent.click(tilePlay[0] as HTMLElement);
      await waitFor(
        () => expect(screen.getByTestId('playback-intent').textContent).toBe(`${TILE.media.id}@playing`),
        { timeout: 3_000 },
      );

      expect(resolveBodies).toEqual([
        { mediaId: HERO.media.id, startMode: 'beginning' },
        { mediaId: TILE.media.id, startMode: 'beginning' },
      ]);
      // 认证层全程未再出现(播放面浮层的 role=dialog 名称不同,可精确区分)
      expect(screen.queryByRole('dialog', { name: '登录' })).toBeNull();
      expect(screen.queryByRole('dialog', { name: '选择 Profile' })).toBeNull();
      const surface = screen.getByTestId('playback-surface');
      expect(surface.getAttribute('aria-label')).toBe(`播放 ${TILE.media.title}`);
      expect(counter.counts.personal).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});
