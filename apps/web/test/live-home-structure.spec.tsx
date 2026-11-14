import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { LivePage } from '../src/features/live/LivePage';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import {
  LIVE_NOW,
  LIVE_PROGRAMME_STATES,
  LIVE_PROGRAMME_WINDOWS,
  LIVE_TEST_TIMEZONE,
  liveChannelPage,
  liveGroupPage,
} from './helpers/live-data';
import { LIVE_SESSION_STATES, renderLiveWorld } from './helpers/live-world';

/**
 * 012 T014(US2,测试先行;015 T010 装配更新)· 直播首页结构与 Hero 语义
 * (012 FR-010/FR-012、ui.md §2 → 015 FR-002、ui-layout.md §1):
 *
 * - 页面顺序:直播精选大屏(直接播放 Hero,第一视觉,非分区;015 T008 起
 *   替代 012 此刻直播精选静态横幅)→
 *   正在直播 → 即将播放 → 各分类逐行平铺泳道(015 CategorySwimlanes);
 *   断言 region 锚点在 DOM 中的出现顺序;
 * - Hero 信息(FR-002/012 FR-010 语义延续):频道标识(频道名)、当前节目、
 *   直播状态(文字 + 状态点)、进度、起止时间(家庭时区)、全屏播放主操作
 *   (统一播放入口;游客态呈现「直接收看」);且必须是直播状态大屏而非点播宣传位;
 * - 无节目单频道(FR-012/T018):卡片保留频道身份 +「暂无节目」占位 + 仍可播放;
 *   面板侧(共享详情面板宿主,T016)双 null 频道映射为 status='none'——
 *   面板保留频道身份 +「暂无节目单」且主操作仍可播放(ui.md §2.5);
 * - 面板状态映射(T016/T018):now/upcoming 由 kind+serverNowIso 推导,
 *   upcoming 无「播放当前频道」主操作(ui.md §1.6)。
 *
 * 运行环境:jsdom(vitest.config.ts);会话档位 guest(公共浏览,FR-004)。
 */

// ---------------------------------------------------------------------------
// 夹具:直播世界 fetch mock(setup/status + groups + channels;逐次 revision 递增)
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problemResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ status, code, title: code }), {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

export interface LiveFetchMock {
  /** /public/live/channels 请求次数(供安静刷新等断言重取发生) */
  channelsCalls(): number;
}

/** 安装直播世界 fetch mock:公共端点返回 T004 数据桩,其余一律 404 problem */
function installLiveFetchMock(channelOverrides?: Record<string, unknown>): LiveFetchMock {
  let channels = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const pathname = new URL(url, 'http://redroad.invalid').pathname;
    if (method === 'GET' && pathname.endsWith('/setup/status')) {
      return jsonResponse({ initialized: true });
    }
    if (method === 'GET' && pathname.endsWith('/public/live/groups')) {
      return jsonResponse(liveGroupPage());
    }
    if (method === 'GET' && pathname.endsWith('/public/live/channels')) {
      channels += 1;
      return jsonResponse(
        liveChannelPage({
          overrides: { catalogRevision: 1 + channels, ...(channelOverrides ?? {}) },
        }),
      );
    }
    return problemResponse(404, 'NOT_FOUND');
  });
  vi.stubGlobal('fetch', fetchMock);
  return { channelsCalls: () => channels };
}

/** 内存路由探针(015 T004):断言瓦片卡 current 档文字区导航 /live/watch/:channelId */
function RouteProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="route-probe">{location.pathname}</span>;
}

/** renderLiveWorld 挂载 LivePage(guest 会话;统一协调器为 PlayButton/Notice 必需宿主) */
function renderLivePage(initialEntry = '/live'): ReturnType<typeof renderLiveWorld> {
  return renderLiveWorld(<LivePage />, {
    session: LIVE_SESSION_STATES.guest,
    initialEntries: [initialEntry],
    decorate: (ui: ReactNode) => (
      <SettingsAccessProvider>
        <ActionCoordinator>
          {ui}
          <RouteProbe />
        </ActionCoordinator>
      </SettingsAccessProvider>
    ),
  });
}

/** 断言元素按给定顺序在 DOM 中出现(前项在文档位置上先于后项) */
function expectDocumentOrder(elements: readonly HTMLElement[]): void {
  expect(elements.length).toBeGreaterThan(1);
  for (let index = 0; index < elements.length - 1; index += 1) {
    const current = elements[index]!;
    const next = elements[index + 1]!;
    expect(
      current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
}

// ---------------------------------------------------------------------------
// 1 · 页面顺序(直播精选大屏 → 正在直播 → 即将播放 → 各分类;Hero 第一视觉)
// ---------------------------------------------------------------------------

describe('T014 · 直播首页页面顺序', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('顺序为 直播精选大屏(Hero)→ 正在直播 → 即将播放 → 各分类逐行泳道', async () => {
    installLiveFetchMock();
    renderLivePage();

    const hero = await screen.findByRole('region', { name: '直播精选大屏' });
    const now = screen.getByRole('region', { name: '正在直播' });
    const next = screen.getByRole('region', { name: '即将播放' });
    const groupNews = screen.getByRole('region', { name: '例牌新闻 · 正在直播' });
    const groupDrama = screen.getByRole('region', { name: '例牌剧场 · 正在直播' });
    const groupKids = screen.getByRole('region', { name: '例牌少儿 · 正在直播' });

    expectDocumentOrder([hero, now, next, groupNews, groupDrama, groupKids]);
  });
});

// ---------------------------------------------------------------------------
// 2 · Hero 信息(FR-002;012 FR-010 六信息语义延续,主操作升级为全屏播放)
// ---------------------------------------------------------------------------

describe('T014 · Hero 信息(FR-002;015 T008 起 = LiveHeroPlayer 直接播放大屏)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('表达 频道标识、当前节目、直播状态、进度、起止时间与「全屏播放」主操作(直播状态大屏,非点播宣传)', async () => {
    installLiveFetchMock();
    renderLivePage();

    const hero = await screen.findByRole('region', { name: '直播精选大屏' });
    const heroScope = within(hero);

    // ① 频道标识(014 实施期修订:右上角身份角标名称 chip + 信息层「频道 · 时段 · 进度」
    //    各出现一次,故按 ≥1 断言而非唯一)
    expect(heroScope.getAllByText(/例牌新闻台/).length).toBeGreaterThanOrEqual(1);
    // ② 当前节目(标题为 hero 主标题)
    expect(heroScope.getByRole('heading', { name: '例牌正播节目' })).toBeVisible();
    // ③ 直播状态(文字 + 形状点,非仅颜色)
    expect(heroScope.getByText('正在直播')).toBeVisible();
    // ④ 起止时间:家庭时区 Asia/Shanghai 19:30–20:30
    expect(heroScope.getByText(/19:30–20:30/)).toBeVisible();
    // ⑤ 进度:当前时刻 LIVE_NOW(12:00Z)落在 11:30–12:30Z 中点 → 已播出 50%
    expect(heroScope.getByText(/已播出\s*50%/)).toBeVisible();
    // ⑥ 主操作:统一播放入口(play();本文件会话档位 guest → 游客呈现「直接收看」,
    //    认证态呈现「全屏播放」,行为同为直接发起播放,015 T008)
    expect(heroScope.getByRole('button', { name: '直接收看 例牌新闻台' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// 3 · 无节目单频道保留身份(FR-012 卡片半边:T004 桩 例牌电影频道 current/next 双 null)
// ---------------------------------------------------------------------------

describe('T014 · 夹具自检', () => {
  it('数据桩窗口与断言一致:now=19:30–20:30、upcoming 开播 21:00(家庭时区 Asia/Shanghai)', () => {
    expect(LIVE_TEST_TIMEZONE).toBe('Asia/Shanghai');
    expect(LIVE_NOW).toBe('2026-11-01T12:00:00.000Z');
    expect(LIVE_PROGRAMME_WINDOWS.now.startsAt).toBe('2026-11-01T11:30:00.000Z');
    expect(LIVE_PROGRAMME_WINDOWS.now.endsAt).toBe('2026-11-01T12:30:00.000Z');
    expect(LIVE_PROGRAMME_WINDOWS.upcoming.startsAt).toBe('2026-11-01T13:00:00.000Z');
  });
});
