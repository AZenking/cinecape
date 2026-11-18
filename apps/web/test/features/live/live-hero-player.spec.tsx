import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { LiveHeroPlayer } from '../../../src/features/live/components/LiveHeroPlayer';
import type { ChannelRowDto } from '@hmp/shared';
import {
  LIVE_REDESIGN_NOW_ISO,
  LIVE_REDESIGN_TIMEZONE,
  buildChannelRow,
} from '../../fixtures/live-redesign-fixtures';
import { LIVE_SESSION_STATES, LiveSessionProbe, renderLiveWorld } from '../../helpers/live-world';
import { installNetworkCounter } from '../../helpers/network-assertions';

/**
 * 015 T006(US1,测试先行)· LiveHeroPlayer 顶部直接播放大屏(FR-002、FR-014;
 * research.md R2、contracts/ui-layout.md §1.1/§1.2、quickstart.md 场景 1):
 *
 * - ①舞台容器:16:9 语义舞台(aspect-video)渲染频道身份(ChannelIdentityBadge)、
 *   「正在直播」语义标注(文字 + 状态点,非仅颜色)、当前节目标题与档期信息;
 * - ②静音切换:aria-pressed/aria-label 双语义可切换,默认静音意图(R2「静音起播免打扰」);
 *   注:全局播放面(PlayerView/ActionCoordinator)当前无 muted/音量 API,该开关承载
 *   意图状态,播放面暴露音量控制后接线(不臆造 API)——见组件头注;
 * - ③展开大屏入口:[▶ 全屏播放] 点击经 usePlayAction().play() 发起(唯一播放管线,
 *   Hero 不自建播放器实例),授权链路走通后全局播放面(playback-surface)浮现;
 *   本规格经真实 ActionCoordinator 断言:resolve 请求体 = { mediaId, startMode }、
 *   播放面标题携带频道名(mediaId+title 双证 play() 以正确参数被调用);
 * - ④节目详情次操作:打开既有 ProgrammeDetailPanel 回调链(kind='current',
 *   由宿主 panelStatusOf 裁决 now/ended/none);
 * - ⑤游客态:高保真预览海报(posterRef Logo 链路)+「直接收看」醒目入口,点击同样
 *   play()——统一协调器拦截进登录意图,授权前零媒体流请求(FR-014,SC-005);
 * - ⑥无节目单频道降级:节目标题位「暂无节目单」,播放入口保留(FR-023 可用性不由 EPG 决定);
 *   数据未就绪(row 缺失)由 LivePage 不渲染 Hero(隐藏降级,不白屏)。
 *
 * 时间锚:T005 夹具 LIVE_REDESIGN_NOW_ISO(2026-11-15T12:00Z,家庭时区 20:00);
 * 缺省当前节目窗 NOW−20 → NOW+40 → 19:40–20:40,进度 20/60 ≈ 33%。
 */

const HERO_CHANNEL = buildChannelRow({
  id: 'b0000000-0000-4000-8000-000000000001',
  title: '星光影城',
  groupKey: 'movie',
  groupLabel: '电影',
  posterRef: 'lr-movie-01',
  current: { title: '星际回响', startsAtMinutes: -20, endsAtMinutes: 40 },
  next: { title: '午夜场:雾都疑云', startsAtMinutes: 40, endsAtMinutes: 100 },
});

/* ---------------- fetch 路由桩(setup/status + resolve 403;其余 404) ---------------- */

let resolveBodies: unknown[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchRouter(): void {
  resolveBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && url.pathname === '/api/playback/resolve') {
        resolveBodies.push(JSON.parse(String(init?.body ?? '{}')));
        // 403:轻量证明「进入统一授权链路」,不起播媒体流(home-live-entry.spec 同款)
        return Promise.resolve(jsonResponse({ status: 403, code: 'PROFILE_CONTENT_LEVEL_DENIED', title: 'Forbidden' }, 403));
      }
      if (method === 'GET' && url.pathname === '/api/setup/status') {
        return Promise.resolve(jsonResponse({ initialized: true }));
      }
      return Promise.resolve(jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404));
    }),
  );
}

/** renderLiveWorld 挂载 Hero(统一协调器为 usePlayAction 必需宿主;会话档位显式声明) */
function renderHero(session: (typeof LIVE_SESSION_STATES)[keyof typeof LIVE_SESSION_STATES], row: ChannelRowDto = HERO_CHANNEL) {
  const counter = installNetworkCounter();
  const onOpenProgramme = vi.fn();
  const world = renderLiveWorld(
    <>
      <LiveHeroPlayer row={row} timezone={LIVE_REDESIGN_TIMEZONE} nowIso={LIVE_REDESIGN_NOW_ISO} onOpenProgramme={onOpenProgramme} />
      <LiveSessionProbe />
    </>,
    {
      session,
      initialEntries: ['/live'],
      decorate: (ui: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
  return { counter, onOpenProgramme, world };
}

beforeEach(() => {
  installFetchRouter();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T006 · LiveHeroPlayer 舞台容器与直播语义(FR-002)', () => {
  it('挂载 16:9 语义舞台:频道身份 + 「正在直播」标注 + 当前节目标题与档期进度(家庭时区)', async () => {
    renderHero(LIVE_SESSION_STATES.authedWithProfile);
    const hero = await screen.findByRole('region', { name: '直播精选大屏' });
    const heroScope = within(hero);

    // 舞台容器:16:9 语义 token(aspect-video),非固定像素(手稿 §1.1「16:9 高度自适应」)
    const stage = hero.querySelector('[data-testid="live-hero-stage"]') as HTMLElement;
    expect(stage).toBeTruthy();
    expect(stage.className).toContain('aspect-video');

    // 频道身份:频道名 + posterRef Logo 预载链路(高保真海报呈现在舞台右上角)
    expect(heroScope.getAllByText(/星光影城/).length).toBeGreaterThanOrEqual(1);
    const posterImg = hero.querySelector('img[src*="/api/public/media/logos/"]');
    expect(posterImg).toBeTruthy();
    expect(posterImg?.getAttribute('src')).toBe('/api/public/media/logos/lr-movie-01');
    fireEvent.load(posterImg as HTMLImageElement);
    expect(hero.querySelector('[data-testid="identity-logo"]')).toBeTruthy();

    // 「正在直播」语义标注(文字,非仅颜色)
    expect(heroScope.getByText('正在直播')).toBeVisible();
    // 当前节目 = h2 主标题;分组 · 此刻直播信息层
    expect(heroScope.getByRole('heading', { name: '星际回响' })).toBeVisible();
    expect(heroScope.getByText(/电影 · 星光影城/)).toBeVisible();
    // 档期(家庭时区 Asia/Shanghai:11:40Z→19:40、12:40Z→20:40)与进度(20/60 ≈ 33%)
    expect(heroScope.getByText(/19:40–20:40/)).toBeVisible();
    expect(heroScope.getByText(/已播出\s*33%/)).toBeVisible();
    // 接下来预告(下一档节目)
    expect(heroScope.getByRole('button', { name: /接下来 20:40 · 午夜场:雾都疑云/ })).toBeVisible();
  });

  it('静音切换:默认静音意图,aria-pressed/aria-label 随切换翻转(意图状态,播放面暂无音量 API)', async () => {
    renderHero(LIVE_SESSION_STATES.authedWithProfile);
    const mute = await screen.findByTestId('live-hero-mute');
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(mute.getAttribute('aria-label')).toBe('取消静音');

    fireEvent.click(mute);
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    expect(mute.getAttribute('aria-label')).toBe('静音');
  });
});

describe('T006 · 全屏播放主操作与节目详情次操作(唯一播放管线)', () => {
  it('已选档点击 [全屏播放]:play() 以 { mediaId, title, startMode: beginning } 发起,授权后全局播放面浮现(零第二播放器)', async () => {
    const { counter, world } = renderHero(LIVE_SESSION_STATES.authedWithProfile);
    try {
      await waitForSession('authenticated:profile-a');
      const fullscreen = await screen.findByRole('button', { name: '全屏观看 星光影城' });
      expect(counter.counts.playback).toBe(0);
      fireEvent.click(fullscreen);

      // 统一协调器 authorize:请求体 = 频道语义 { mediaId, startMode }(title 由播放面承载)
      await waitForResolveBody();
      expect(resolveBodies[0]).toEqual({ mediaId: HERO_CHANNEL.media.id, startMode: 'beginning' });
      const surface = await screen.findByTestId('playback-surface');
      expect(surface.getAttribute('aria-label')).toBe('播放 星光影城');
      expect(counter.counts.playback).toBeGreaterThan(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });

  it('点击 [节目详情]:打开既有 ProgrammeDetailPanel 回调链(kind=current,频道身份齐备),不发起播放', async () => {
    const { counter, onOpenProgramme, world } = renderHero(LIVE_SESSION_STATES.authedWithProfile);
    try {
      await waitForSession('authenticated:profile-a');
      fireEvent.click(await screen.findByRole('button', { name: '节目详情 星光影城' }));

      expect(onOpenProgramme).toHaveBeenCalledTimes(1);
      expect(onOpenProgramme.mock.calls[0]?.[0]).toMatchObject({
        mediaId: HERO_CHANNEL.media.id,
        channelTitle: '星光影城',
        groupLabel: '电影',
        kind: 'current',
        programme: expect.objectContaining({ title: '星际回响' }),
      });
      expect(counter.counts.playback).toBe(0);
      expect(screen.queryByTestId('playback-surface')).toBeNull();
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

describe('T006 · 游客态:预览海报 + 直接收看入口 + 授权前零媒体流请求(FR-014)', () => {
  it('游客展示「直接收看」入口,点击经 play() 进统一登录意图;授权前零 /playback/ 请求(SC-005)', async () => {
    const { counter, world } = renderHero(LIVE_SESSION_STATES.guest);
    try {
      await waitForSession('anonymous:none');
      // 高保真预览海报(posterRef Logo)已挂载;认证态主操作「全屏播放」不出现
      expect(screen.getByTestId('live-hero-player')).toBeTruthy();
      expect(screen.getByRole('button', { name: '直接收看 星光影城' })).toBeVisible();
      expect(screen.queryByRole('button', { name: '全屏观看 星光影城' })).toBeNull();

      expect(counter.counts.playback).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: '直接收看 星光影城' }));

      // 统一协调器拦截:登录意图弹层(登录标题),全称零媒体流请求
      expect(await screen.findByRole('heading', { name: '登录' })).toBeVisible();
      expect(counter.counts.playback).toBe(0);
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

describe('T006 · 无节目单频道降级(FR-023)', () => {
  it('current/next 双 null:舞台保留频道身份与「暂无节目单」占位,播放入口保留', async () => {
    const noProgrammeRow = buildChannelRow({
      id: 'b0000000-0000-4000-8000-000000000099',
      title: '无节目单频道',
      groupKey: 'movie',
      groupLabel: '电影',
      current: null,
      next: null,
    });
    const { counter, world } = renderHero(LIVE_SESSION_STATES.authedWithProfile, noProgrammeRow);
    try {
      await waitForSession('authenticated:profile-a');
      const hero = screen.getByRole('region', { name: '直播精选大屏' });
      expect(within(hero).getByText('暂无节目单')).toBeVisible();
      // 播放入口保留(频道可用即可播,可用性不由 EPG 决定)
      fireEvent.click(within(hero).getByRole('button', { name: '全屏观看 无节目单频道' }));
      await waitForResolveBody();
      expect(resolveBodies[0]).toEqual({ mediaId: noProgrammeRow.media.id, startMode: 'beginning' });
    } finally {
      world.restore();
      counter.restore();
    }
  });
});

/* ---------------- 会话就绪等待(noUncheckedIndexedAccess 守卫) ---------------- */

async function waitForSession(expected: string): Promise<void> {
  await screen.findByText(expected, { selector: '[data-testid="live-session"]' });
}

async function waitForResolveBody(): Promise<void> {
  await waitFor(() => expect(resolveBodies.length).toBeGreaterThan(0));
}
