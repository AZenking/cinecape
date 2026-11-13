import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import type { GuideWindowDto } from '@hmp/shared';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { LiveHeroPlayer } from '../../../src/features/live/components/LiveHeroPlayer';
import { ChannelTile } from '../../../src/features/live/components/ChannelTile';
import { MediaScroller } from '../../../src/features/live/components/MediaScroller';
import { SameTypeLiveStrip } from '../../../src/features/live/components/SameTypeLiveStrip';
import { ChannelGridPage } from '../../../src/features/live/pages/ChannelGridPage';
import { LiveWatchPage } from '../../../src/features/live/pages/LiveWatchPage';
import { GuideScrollContainer } from '../../../src/features/epg/GuideScrollContainer';
import { GuideWall } from '../../../src/features/epg/GuideWall';
import type { ChannelRowDto } from '@hmp/shared';
import {
  LIVE_REDESIGN_NOW_ISO,
  LIVE_REDESIGN_TIMEZONE,
  buildChannelListPage,
  buildChannelRow,
  buildGroupPage,
} from '../../fixtures/live-redesign-fixtures';
import { LIVE_SESSION_STATES, renderLiveWorld } from '../../helpers/live-world';
import type { LiveSessionState } from '../../helpers/live-world';
import { resetServerClockForTests } from '../../../src/shared/time/server-clock';

/**
 * 015 T024 · 响应式视口与键盘可访问性走查(jsdom 可断言面钉面)。
 *
 * 定位:quickstart.md 人工走查(1440/1920 宽屏、768~1024 窄屏、Tab/方向键焦点环)的
 * **可静态化/可 jsdom 验证子集**——本地无 IPTV/EPG 真实数据源,无法起全真环境;
 * 本 spec 只钉「class/aria/role 存在性」与 DOM 焦点序语义,真实画面自适应、hover
 * 手感、200% 缩放等留待人工走查(清单见 walkthrough-t024.md §C)。
 *
 * 权威:docs/specs/015-live-flow-redesign/
 * - quickstart.md 场景 1~4;contracts/ui-layout.md §1.2/§2.2/§3.2/§4.2;
 * - DESIGN.md Interaction(焦点环可见、状态不只颜色、尊重 reduced-motion);
 * - apps/web/src/shared/theme/a11y.css(reduced-motion 全局基线 + :focus-visible/
 *   data-focus-visible 双通道焦点环)。
 *
 * 证据分层(与 walkthrough-t024.md 对齐):
 * - 静态文件钉面:§13(a11y.css 基线、播放面 16:9 上限表达式);
 * - jsdom 运行时钉面:§1~§12(class/aria/role 存在性、DOM 焦点序、RAC Tabs 方向键)。
 */

// ────────────────────────── 引擎边界 mock(jsdom;channel-grid-page 同款) ──────────────────────────

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

// ────────────────────────── fetch 路由桩(setup/status + live 公共元数据 + resolve 403) ──────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

function installFetchRouter(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.pathname;
      if (method === 'GET' && path === '/api/setup/status') {
        return jsonResponse({ initialized: true });
      }
      if (method === 'GET' && path === '/api/public/live/groups') {
        return jsonResponse(buildGroupPage());
      }
      if (method === 'GET' && path === '/api/public/live/channels') {
        const section = url.searchParams.get('section');
        const groupKey = url.searchParams.get('groupKey');
        const q = url.searchParams.get('q') ?? '';
        const base =
          section === 'group' && groupKey !== null && groupKey !== ''
            ? buildChannelListPage({ groupKey })
            : buildChannelListPage();
        const items = q === '' ? base.items : base.items.filter((row) => row.media.title.includes(q));
        return jsonResponse({ ...base, items, total: items.length, pageSize: Math.max(items.length, 1) });
      }
      if (method === 'POST' && path === '/api/playback/resolve') {
        // 403:走查用例不起播真实媒体流(live-hero-player 同款轻量拦截)
        return jsonResponse({ status: 403, code: 'PROFILE_CONTENT_LEVEL_DENIED', title: 'Forbidden' }, 403);
      }
      return jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404);
    }),
  );
}

/** 路由位置探针(Tabs 方向键 → URL 同步断言用) */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="location-probe">{location.pathname + location.search}</span>;
}

/** 统一挂载(统一协调器为 usePlayAction 必需宿主;会话档位显式声明)
 *  watchRoute=true 时挂于 /live/watch/:channelId 路由(LiveWatchPage 消费 useParams) */
function renderWorld(
  ui: ReactNode,
  options: { session?: LiveSessionState; entries?: string[]; watchRoute?: boolean } = {},
): ReturnType<typeof renderLiveWorld> {
  return renderLiveWorld(
    <>
      {options.watchRoute === true ? (
        <Routes>
          <Route path="/live/watch/:channelId" element={ui} />
        </Routes>
      ) : (
        ui
      )}
      <LocationProbe />
    </>,
    {
      session: options.session ?? LIVE_SESSION_STATES.guest,
      initialEntries: options.entries ?? ['/live'],
      decorate: (inner: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{inner}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
}

/* ---------------- 走查夹具 ---------------- */

/** Hero/瓦片走查频道(现播 -20min→+40min:进度 33%;下一档 +40min 起) */
const WALKTHROUGH_CHANNEL: ChannelRowDto = buildChannelRow({
  id: 'b0000000-0000-4000-8000-000000000001',
  title: '星光影城',
  groupKey: 'movie',
  groupLabel: '电影',
  posterRef: 'lr-movie-01',
  current: { title: '星际回响', startsAtMinutes: -20, endsAtMinutes: 40 },
  next: { title: '午夜场:雾都疑云', startsAtMinutes: 40, endsAtMinutes: 100 },
});

/** EPG 墙走查窗口(04:00Z~次日 04:00Z 全天;now=12:00Z 落在 ch-a 现播块内) */
function guideWindowFixture(): GuideWindowDto {
  const media = (id: string, title: string, posterRef: string | null) => ({
    id,
    type: 'channel' as const,
    title,
    description: null,
    posterRef,
    contentLevel: null,
    availability: 'available' as const,
  });
  const programme = (key: string, title: string, startsAt: string, endsAt: string) => ({
    key,
    title,
    description: null,
    posterRef: null,
    startsAt,
    endsAt,
  });
  return {
    date: '2026-11-04',
    timezone: 'Asia/Shanghai',
    now: '2026-11-04T12:00:00.000Z',
    allowedDates: ['2026-11-04', '2026-11-05'],
    from: '2026-11-04T04:00:00.000Z',
    to: '2026-11-05T04:00:00.000Z',
    page: 1,
    pageSize: 20,
    totalChannels: 2,
    catalogRevision: 1,
    channels: [
      {
        media: media('ch-a', '频道甲', null),
        programmes: [programme('pg-a1', '早间新闻', '2026-11-04T11:00:00.000Z', '2026-11-04T12:30:00.000Z')],
      },
      {
        media: media('ch-b', '频道乙', null),
        programmes: [programme('pg-b1', '晚间剧场', '2026-11-04T13:00:00.000Z', '2026-11-04T14:00:00.000Z')],
      },
    ],
  };
}

beforeEach(() => {
  installFetchRouter();
  // 服务端基准钟隔离(016 基准时间条款):清零模块级 offset,避免前例桩响应校准
  // 残留污染本例(尤其 B4 vi.setSystemTime 锚定场景——offset 非零会破坏锚点)
  resetServerClockForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ────────────────────────── A · 响应式视口 ──────────────────────────

describe('T024-A · 响应式视口(jsdom 可断言面)', () => {
  it('A1 Hero 16:9 舞台:aspect-video + w-full 容器约束,md 字阶/角标偏移随视口抬升(quickstart 场景 1)', async () => {
    renderWorld(
      <LiveHeroPlayer
        row={WALKTHROUGH_CHANNEL}
        timezone={LIVE_REDESIGN_TIMEZONE}
        nowIso={LIVE_REDESIGN_NOW_ISO}
        onOpenProgramme={vi.fn()}
      />,
      { session: LIVE_SESSION_STATES.authedWithProfile },
    );
    const hero = await screen.findByRole('region', { name: '直播精选大屏' });
    // 外层 min-w-0(泳道/网格父链防横向溢出),舞台 16:9 语义 token(非固定像素)
    expect(hero.className).toContain('min-w-0');
    const stage = hero.querySelector('[data-testid="live-hero-stage"]') as HTMLElement;
    expect(stage).toBeTruthy();
    expect(stage.className).toContain('aspect-video');
    expect(stage.className).toContain('w-full');
    expect(stage.className).toContain('overflow-hidden');
    // 宽窄视口两档:角标/状态签/静音的 md: 偏移 + 信息层 md 内边距 + 标题 md 字阶
    const badge = hero.querySelector('[data-testid="identity-badge"]') as HTMLElement;
    expect(badge.className).toContain('md:right-6');
    expect(badge.className).toContain('md:top-6');
    const liveBadge = hero.querySelector('[data-testid="live-hero-live-badge"]') as HTMLElement;
    expect(liveBadge.className).toContain('md:left-6');
    expect(liveBadge.className).toContain('md:top-6');
    const mute = hero.querySelector('[data-testid="live-hero-mute"]') as HTMLElement;
    expect(mute.className).toContain('md:top-20');
    expect(mute.className).toContain('md:right-6');
    const h2 = hero.querySelector('h2') as HTMLElement;
    expect(h2.className).toContain('text-2xl');
    // 进度线语义(非仅颜色):aria-hidden 装饰 + 「已播出 N%」文字并行
    expect(hero.textContent).toContain('已播出 33%');
  });

  it('A1 泳道行横向滚动溢出限于行内:ul overflow-x-auto + 外层 min-w-0;无溢出(jsdom)不渲染箭头(quickstart 场景 1)', () => {
    const { container } = renderWorld(
      <MediaScroller label="走查行">
        <li className="w-60 shrink-0 snap-start">甲</li>
        <li className="w-60 shrink-0 snap-start">乙</li>
      </MediaScroller>,
    );
    // 行容器 min-w-0 + group 命名空间(箭头浮现态挂 group-hover/scroller)
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('min-w-0');
    expect(wrapper.className).toContain('group/scroller');
    // 滚动语义收在行内:overflow-x-auto + snap 吸附 + 细滚动条(页面级无横向溢出容器)
    const list = wrapper.querySelector('ul') as HTMLElement;
    expect(list).toBeTruthy();
    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('snap-x');
    expect(list.className).toContain('snap-proximity');
    // jsdom scrollWidth=0:左右箭头自然不渲染(内容不溢出不出箭头,勿虚占 Tab 位)
    expect(screen.queryByRole('button', { name: '向左滚动 走查行' })).toBeNull();
    expect(screen.queryByRole('button', { name: '向右滚动 走查行' })).toBeNull();
  });

  it('A2 分类网格断点带:grid-cols-1→md 2→lg 3→min-[1440px] 4→2xl 5,映射 ui-layout §2.2(quickstart 场景 3)', async () => {
    renderWorld(<ChannelGridPage />, { entries: ['/live/channels'] });
    // 数据就绪后骨架卸载;网格容器 = 卡片 article 的直接父 div
    await screen.findAllByText('星光影城');
    const grid = Array.from(document.querySelectorAll('div')).find((el) =>
      el.className.includes('grid-cols-1'),
    );
    expect(grid).toBeTruthy();
    const cls = (grid as HTMLElement).className;
    expect(cls).toContain('grid-cols-1'); // <768(线框未定义,取单列降级)
    expect(cls).toContain('md:grid-cols-2'); // 768~1023 两列
    expect(cls).toContain('lg:grid-cols-3'); // 1024~1439 三列
    expect(cls).toContain('min-[1440px]:grid-cols-4'); // ≥1440 四列
    expect(cls).toContain('2xl:grid-cols-5'); // ≥1536 五列(契约 4~5 列上沿)
  });

  it('A2 view=list 降级:多列网格退出,紧凑列表行 + 行尾播放按钮接管(routing §2.2 view 参数)', async () => {
    renderWorld(<ChannelGridPage />, { entries: ['/live/channels?view=list'] });
    await screen.findAllByText('星光影城');
    // 网格容器不渲染;列表为 ul 行结构(频道名 + 正在播 + PlayButton)
    expect(Array.from(document.querySelectorAll('div')).find((el) => el.className.includes('grid-cols-1'))).toBeUndefined();
    const list = document.querySelector('ul.divide-y') as HTMLElement;
    expect(list).toBeTruthy();
    const playButtons = within(list).getAllByRole('button', { name: '播放 星光影城 当前直播' });
    expect(playButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('A3 Screen 4 分栏断点:宽屏 lg 左右 2fr/1fr 分栏、窄屏单列堆叠;播放器容器位 16:9 约束(quickstart 场景 4)', async () => {
    renderWorld(<LiveWatchPage />, {
      session: LIVE_SESSION_STATES.guest,
      entries: ['/live/watch/b0000000-0000-4000-8000-000000000001?from=live'],
      watchRoute: true,
    });
    const page = await screen.findByTestId('live-watch-page');
    // 分栏网格:lg 起两列(2fr 播放器位 + 1fr 伴随面板),窄屏缺省单列堆叠
    const columns = Array.from(page.querySelectorAll('div')).find((el) =>
      el.className.includes('lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]'),
    );
    expect(columns).toBeTruthy();
    expect((columns as HTMLElement).className).toContain('lg:items-start');
    const playerSlot = page.querySelector('[data-testid="watch-player-slot"]') as HTMLElement;
    expect(playerSlot.className).toContain('aspect-video'); // 播放器容器位 16:9 语义约束
    expect(playerSlot.className).toContain('lg:order-1');
    const metaPanel = page.querySelector('[data-testid="watch-meta-panel"]') as HTMLElement;
    expect(metaPanel.className).toContain('lg:order-2');
  });

  it('A4 EPG 墙横向滚动收在容器内:GuideScrollContainer w-full max-w-full overflow-auto + 可聚焦焦点环(quickstart 场景 2)', () => {
    const { container } = renderWorld(
      <GuideScrollContainer ariaLabel="节目单时间轴" describedById="guide-window-title">
        <GuideWall
          data={guideWindowFixture()}
          focusSignal={0}
          selectedKey={null}
          onSelectProgramme={vi.fn()}
          onPlayChannel={vi.fn()}
        />
      </GuideScrollContainer>,
    );
    const scroller = container.firstElementChild as HTMLElement;
    expect(scroller.getAttribute('role')).toBe('region');
    expect(scroller.className).toContain('w-full');
    expect(scroller.className).toContain('max-w-full'); // 整页不被墙撑破(溢出限于容器内)
    expect(scroller.className).toContain('overflow-auto'); // 双轴滚动墙内消化(768 窄窗/限高)
    expect(scroller.className).toContain('focus-visible:ring-2');
    expect(scroller.className).toContain('focus-visible:ring-focus');
    // sticky 列静态存在:时间头 sticky top + 频道列 sticky left(窄屏横滚时列不漂移)
    const wall = scroller.firstElementChild as HTMLElement;
    const stickyTop = Array.from(wall.querySelectorAll('div')).find((el) =>
      el.className.includes('sticky'),
    );
    expect(stickyTop).toBeTruthy();
    // 频道列已改为整格按钮(sticky left),故连同 button 一起统计
    const stickyLeft = Array.from(wall.querySelectorAll('div, button')).filter(
      (el) => el.className.includes('sticky') && el.className.includes('left-0'),
    );
    expect(stickyLeft.length).toBeGreaterThanOrEqual(2); // 时间头角标 + 每行频道列
  });
});

// ────────────────────────── B · 键盘可访问性 ──────────────────────────

describe('T024-B · 键盘可访问性(jsdom 可断言面)', () => {
  it('B1 Hero 全部交互元素 Tab 可达且 DOM 序=焦点序:静音 → 接下来 → 主操作 → 节目详情;静音 aria-pressed', async () => {
    renderWorld(
      <LiveHeroPlayer
        row={WALKTHROUGH_CHANNEL}
        timezone={LIVE_REDESIGN_TIMEZONE}
        nowIso={LIVE_REDESIGN_NOW_ISO}
        onOpenProgramme={vi.fn()}
      />,
      { session: LIVE_SESSION_STATES.authedWithProfile },
    );
    const hero = await screen.findByRole('region', { name: '直播精选大屏' });
    const buttons = Array.from(hero.querySelectorAll('button')).map(
      (b) => b.getAttribute('aria-label') ?? (b.textContent ?? ''),
    );
    expect(buttons).toEqual([
      '取消静音', // 静音切换(isIconOnly,aria-label 全称)
      expect.stringContaining('接下来:'), // 下一档预告入口
      '全屏播放 星光影城', // 主操作(已选档形态)
      '节目详情 星光影城', // 次操作
    ]);
    const mute = hero.querySelector('[data-testid="live-hero-mute"]') as HTMLElement;
    expect(mute.getAttribute('aria-pressed')).toBe('true'); // 默认静音意图(状态可感知)
  });

  it('B1 卡片中央 ▶ 恒在 DOM(键盘 Tab 可达),hover:hover 基线隐藏 + group-focus-within 浮现双通道', () => {
    const { container } = renderWorld(
      <ChannelTile
        row={WALKTHROUGH_CHANNEL}
        nowIso={LIVE_REDESIGN_NOW_ISO}
        onOpenProgramme={vi.fn()}
        onRequireAuth={vi.fn()}
      />,
    );
    // 瓦片为 group 容器(focus-within 联动中央 ▶ 与抬升)
    const article = container.querySelector('article') as HTMLElement;
    expect(article.className).toContain('group');
    expect(article.className).toContain('focus-within:-translate-y-0.5');
    // 中央 ▶ 按钮恒在 DOM(jsdom 无 hover 也存在=Tab 可达);hover:hover 下缺省
    // pointer-events-none+opacity-0,键盘聚焦(group-focus-within)恢复可点+浮现
    const hoverPlay = article.querySelector('button[aria-label="播放 星光影城"]') as HTMLElement;
    expect(hoverPlay).toBeTruthy();
    const cls = hoverPlay.className;
    expect(cls).toContain('[@media(hover:hover)]:pointer-events-none');
    expect(cls).toContain('[@media(hover:hover)]:opacity-0');
    expect(cls).toContain('[@media(hover:hover)]:group-focus-within:pointer-events-auto');
    expect(cls).toContain('[@media(hover:hover)]:group-focus-within:opacity-100');
    expect(cls).toContain('group-hover:opacity-100'); // 指示设备悬浮浮现
    expect(cls).toContain('transition-opacity'); // 动效仅 opacity(全局 reduced-motion 收敛)
    // 恒驻右下播放入口(键盘/触屏不依赖 hover 也不丢失)
    expect(article.querySelector('button[aria-label="播放 星光影城 当前直播"]')).toBeTruthy();
    // 信息区节目名按钮(HeroUI ghost sm,焦点环走组件原生状态)
    expect(screen.getByRole('button', { name: '星际回响' })).toBeTruthy();
  });

  it('B1 无节目占位按钮显式焦点环:自建原生 button 佩 focus-visible:ring-2 ring-focus(a11y.css 兜底之外的自证)', () => {
    const noProgrammeRow = buildChannelRow({
      id: 'b0000000-0000-4000-8000-000000000099',
      title: '无节目单频道',
      groupKey: 'movie',
      groupLabel: '电影',
      current: null,
      next: null,
    });
    const { container } = renderWorld(
      <ChannelTile
        row={noProgrammeRow}
        nowIso={LIVE_REDESIGN_NOW_ISO}
        onOpenProgramme={vi.fn()}
        onRequireAuth={vi.fn()}
      />,
    );
    const placeholder = container.querySelector('[data-testid="no-programme"]') as HTMLElement;
    expect(placeholder).toBeTruthy();
    expect(placeholder.className).toContain('focus-visible:ring-2');
    expect(placeholder.className).toContain('focus-visible:ring-focus');
    expect(placeholder.textContent).toContain('暂无节目');
  });

  it('B1/B2 分类 Tabs:tablist/tab 语义 + RAC 方向键切换(ArrowRight → 电影选中 → URL ?group=movie 同步)', async () => {
    renderWorld(<ChannelGridPage />, { entries: ['/live/channels'] });
    await screen.findAllByText('星光影城');
    const tablist = screen.getByRole('tablist', { name: '频道分类' });
    const allTab = within(tablist).getByRole('tab', { name: '全部' });
    expect(allTab.getAttribute('aria-selected')).toBe('true');
    // RAC Tabs(useSelectableCollection)方向键语义:焦点移动即选中(jsdom keyDown 可驱动)
    fireEvent.keyDown(allTab, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(within(tablist).getByRole('tab', { name: '电影' }).getAttribute('aria-selected')).toBe('true');
    });
    expect(within(tablist).getByRole('tab', { name: '全部' }).getAttribute('aria-selected')).toBe('false');
    // 选择变化 → URL 同步(ui-layout §2.2 契约 1)
    expect(screen.getByTestId('location-probe').textContent).toBe('/live/channels?group=movie');
  });

  it('B1 工具条控件可达名:SearchField 搜索框/一键清空、视图切换 ToggleButtonGroup aria 语义', async () => {
    renderWorld(<ChannelGridPage />, { entries: ['/live/channels'] });
    await screen.findAllByText('星光影城');
    // 搜索框(Label 关联 + aria-label)与内置清空按钮均有可读名
    expect(screen.getByPlaceholderText('按频道名称搜索')).toBeTruthy();
    expect(screen.getByRole('button', { name: '清空搜索' })).toBeTruthy();
    // 视图切换:RAC ToggleButtonGroup(单选)渲染 radiogroup/radio 语义 + roving tabindex
    const viewGroup = screen.getByRole('radiogroup', { name: '视图切换' });
    const gridBtn = within(viewGroup).getByRole('radio', { name: '网格视图' });
    const listBtn = within(viewGroup).getByRole('radio', { name: '列表视图' });
    expect(gridBtn.getAttribute('data-selected')).toBe('true'); // 缺省 grid 选中
    expect(listBtn.getAttribute('data-selected')).not.toBe('true'); // data-selected 仅在选中态出现
    expect(gridBtn.getAttribute('aria-checked')).toBe('true'); // radio 语义选中态
    expect(listBtn.getAttribute('aria-checked')).toBe('false');
    expect(gridBtn.getAttribute('tabindex')).toBe('0'); // roving tabindex(方向键在组内移动)
  });

  it('B1 同类横条卡片:整卡单 Button(切换到 <频道名>)+ 状态签文字非仅颜色 + focus-visible 描边', async () => {
    renderWorld(
      <SameTypeLiveStrip groupKey="movie" activeChannelId={null} onSwitch={vi.fn()} />,
    );
    const strip = await screen.findByTestId('same-type-live-strip');
    const cardA = within(strip).getByRole('button', { name: '切换到 星光影城' });
    expect(cardA).toBeTruthy();
    expect(cardA.className).toContain('focus-visible:border-accent/40');
    // 状态标注 = 红点(aria-hidden 装饰)+「正在直播」文字(状态不只靠颜色)
    expect(within(strip).getAllByText('正在直播').length).toBeGreaterThanOrEqual(1);
    const dot = cardA.querySelector('span[aria-hidden="true"].rounded-full') as HTMLElement;
    expect(dot).toBeTruthy();
  });

  it('B1/B4 GuideWall:节目块/频道列按钮焦点环 + LIVE 块 aria「正在直播」(非仅颜色)+ NOW 线 role=status', () => {
    const onPlayChannel = vi.fn();
    renderWorld(
      <GuideScrollContainer ariaLabel="节目单时间轴">
        <GuideWall
          data={guideWindowFixture()}
          focusSignal={0}
          selectedKey={null}
          onSelectProgramme={vi.fn()}
          onPlayChannel={onPlayChannel}
        />
      </GuideScrollContainer>,
    );
    // 频道列播放按钮:显式焦点环 + 全称 aria
    const liveBtn = screen.getByRole('button', { name: '播放 频道甲 当前直播' });
    expect(liveBtn.className).toContain('focus-visible:ring-2');
    expect(liveBtn.className).toContain('focus-visible:ring-focus');
    // 现播块(pg-a1 覆盖 now):aria-label 携带「,正在直播」语义 + 可见 LIVE 文字角标
    const currentBlock = screen.getByRole('button', { name: /频道甲,早间新闻.*正在直播/ });
    expect(currentBlock.className).toContain('focus-visible:ring-2');
    expect(within(currentBlock).getByText('LIVE')).toBeVisible();
    // 未来块(pg-b1):aria 无直播语义,不渲染 LIVE 角标(禁止误读可播)
    const futureBlock = screen.getByRole('button', { name: /频道乙,晚间剧场/ });
    expect(futureBlock.getAttribute('aria-label')).not.toContain('正在直播');
    expect(within(futureBlock).queryByText('LIVE')).toBeNull();
    // NOW 线:role=status + 全称 aria-label(时间锚可被读屏感知,非纯视觉红线)
    const nowLine = document.querySelector('[role="status"][aria-label^="当前时间"]') as HTMLElement;
    expect(nowLine).toBeTruthy();
  });

  it('B3/B4 全局基线钉面:a11y.css reduced-motion 收敛 + :focus-visible/data-focus-visible 双通道焦点环;播放面 16:9 上限表达式(a11y.css / action-coordinator.tsx)', () => {
    // 静态文件钉面:相对 apps/web 包根(vitest cwd)解析,避免 jsdom 环境下 import.meta.url 非 file 协议
    const webRoot = process.cwd();
    const a11y = readFileSync(resolve(webRoot, 'src/shared/theme/a11y.css'), 'utf8');
    // reduced-motion:全局动画/过渡/平滑滚动收敛
    expect(a11y).toContain('@media (prefers-reduced-motion: reduce)');
    expect(a11y).toContain('transition-duration: 0.01ms');
    expect(a11y).toContain('scroll-behavior: auto');
    // 焦点环双通道:UA :focus-visible + RAC data-focus-visible,important 兜底
    expect(a11y).toContain('[data-focus-visible');
    expect(a11y).toContain('outline: var(--hmp-focus-ring-width) solid var(--focus');
    expect(a11y).toContain('!important');
    // 播放面 16:9 上限(以视口可用高度反推宽度,矮视口不遮蔽公共导航)
    const coordinator = readFileSync(resolve(webRoot, 'src/app/action-coordinator.tsx'), 'utf8');
    expect(coordinator).toContain('w-[min(94vw,1120px,calc((100vh-12rem)*16/9))]');
    expect(coordinator).toContain('aspect-video');
  });

  it('B4 状态不依赖单一颜色(watch 页):进度条 aria 语义(valueLabel 已播 N%)+ 「正在直播」文字标注', async () => {
    // 016 T011:进度改经 useCurrentProgramme 智能时钟(本地钟)——仅改写系统时钟
    // (vi.setSystemTime,定时器保持真实)锚定 015 夹具 NOW,使「快照 12:00Z →
    // 已播 33%」按锚点复算继续成立(真实 Date.now() 相对夹具为过去 → 恒钳 0,
    // 原覆盖意图丢失);不引入 fake 定时器以免扰动登录弹层/异步链路时序。
    vi.setSystemTime(new Date(Date.parse(LIVE_REDESIGN_NOW_ISO)));
    try {
      renderWorld(<LiveWatchPage />, {
        session: LIVE_SESSION_STATES.guest,
        entries: ['/live/watch/b0000000-0000-4000-8000-000000000001?from=live'],
        watchRoute: true,
      });
      // 现播 -20→+40 分钟(快照 12:00Z):进度 20/60 ≈ 33%
      const progress = await screen.findByRole('progressbar', { name: '当前节目播出进度' });
      expect(progress.getAttribute('aria-valuetext')).toBe('已播 33%');
      // 伴随面板文字标注(红点仅装饰):「正在直播」文字并行
      const metaPanel = screen.getByTestId('watch-meta-panel');
      expect(within(metaPanel).getByText('正在直播')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });
});
