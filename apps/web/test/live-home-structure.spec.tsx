import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { LivePage } from '../src/features/live/LivePage';
import { panelStatusOf } from '../src/features/live/LivePage';
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
 * 012 T014(US2,测试先行)· 直播首页结构与 Now Hero 语义(FR-010/FR-012、ui.md §2):
 *
 * - 页面顺序(FR-010):所有节目单入口 → 此刻直播精选 Hero(第一视觉,非分区)→
 *   正在直播 → 即将播放 → 按类型(各来源主分组);断言 region 锚点在 DOM 中的出现顺序;
 * - Now Hero 六信息(FR-010):频道标识(频道名)、当前节目、直播状态、进度、
 *   起止时间(家庭时区)、「播放」主按钮;且必须是直播状态横幅而非点播宣传位;
 * - 无节目单频道(FR-012/T018):卡片保留频道身份 +「暂无节目」占位 + 仍可播放;
 *   面板侧(共享详情面板宿主,T016)双 null 频道映射为 status='none'——
 *   面板保留频道身份 +「暂无节目单」且主操作仍可播放(ui.md §2.5);
 * - 面板状态映射(T016/T018):now/upcoming 由 kind+serverNowIso 推导,
 *   upcoming 无「播放当前频道」主操作(ui.md §1.6)。
 *
 * 实现前置说明:T014 落笔时 Now Hero 尚无进度表达、无节目面板入口尚未接线 ——
 * 对应断言预期先红,随 T016/T017/T018 转绿(测试先行,不以 skip 掩盖)。
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

/** renderLiveWorld 挂载 LivePage(guest 会话;统一协调器为 PlayButton/Notice 必需宿主) */
function renderLivePage(initialEntry = '/live'): ReturnType<typeof renderLiveWorld> {
  return renderLiveWorld(<LivePage />, {
    session: LIVE_SESSION_STATES.guest,
    initialEntries: [initialEntry],
    decorate: (ui: ReactNode) => (
      <SettingsAccessProvider>
        <ActionCoordinator>{ui}</ActionCoordinator>
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
// 1 · 页面顺序(FR-010:节目单入口 → 正在直播 → 接下来 → 按类型;Hero 第一视觉)
// ---------------------------------------------------------------------------

describe('T014 · 直播首页页面顺序(FR-010)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('顺序为 所有节目单入口 → 此刻直播精选(Hero)→ 正在直播 → 即将播放 → 按类型分组', async () => {
    installLiveFetchMock();
    renderLivePage();

    const entry = await screen.findByRole('region', { name: '所有节目单入口' });
    const hero = await screen.findByRole('region', { name: '此刻直播精选' });
    const now = screen.getByRole('region', { name: '正在直播' });
    const next = screen.getByRole('region', { name: '即将播放' });
    const groupNews = screen.getByRole('region', { name: '例牌新闻 · 正在直播' });
    const groupDrama = screen.getByRole('region', { name: '例牌剧场 · 正在直播' });
    const groupKids = screen.getByRole('region', { name: '例牌少儿 · 正在直播' });

    expectDocumentOrder([entry, hero, now, next, groupNews, groupDrama, groupKids]);
  });
});

// ---------------------------------------------------------------------------
// 2 · Now Hero 六信息(FR-010;T017 对照补缺落点:进度此前缺失,预期先红)
// ---------------------------------------------------------------------------

describe('T014 · Now Hero 六信息(FR-010;T017 核对落点)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('表达 频道标识、当前节目、直播状态、进度、起止时间与「播放」主按钮(直播状态横幅,非点播宣传)', async () => {
    installLiveFetchMock();
    renderLivePage();

    const hero = await screen.findByRole('region', { name: '此刻直播精选' });
    const heroScope = within(hero);

    // ① 频道标识(频道名出现在信息层「频道 · 时段 · 进度」整行文本中)
    expect(heroScope.getByText(/例牌新闻台/)).toBeVisible();
    // ② 当前节目(标题为 hero 主标题)
    expect(heroScope.getByRole('heading', { name: '例牌正播节目' })).toBeVisible();
    // ③ 直播状态(文字 + 形状点,非仅颜色)
    expect(heroScope.getByText('正在直播')).toBeVisible();
    // ④ 起止时间:家庭时区 Asia/Shanghai 19:30–20:30
    expect(heroScope.getByText(/19:30–20:30/)).toBeVisible();
    // ⑤ 进度:当前时刻 LIVE_NOW(12:00Z)落在 11:30–12:30Z 中点 → 已播出 50%
    expect(heroScope.getByText(/已播出\s*50%/)).toBeVisible();
    // ⑥ 「播放」主按钮:统一播放入口(PlayButton;频道语义,指向当前直播)
    expect(heroScope.getByRole('button', { name: '播放 例牌新闻台 当前直播' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// 3 · 无节目单频道保留身份(FR-012 卡片半边:T004 桩 例牌电影频道 current/next 双 null)
// ---------------------------------------------------------------------------

describe('T014 · 无节目单频道保留身份(FR-012 卡片)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('卡片保留频道身份并显示「暂无节目」占位,播放入口仍在(频道可用即可播)', async () => {
    installLiveFetchMock();
    renderLivePage();

    // 桩频道行会同时出现在 正在直播/即将播放/分组 三区(分区查询均返回同集),取任一瓦片断言
    const title = (await screen.findAllByText('例牌电影频道'))[0]!;
    const card = title.closest('article');
    expect(card).not.toBeNull();
    const cardScope = within(card as HTMLElement);

    expect(cardScope.getByTestId('no-programme')).toHaveTextContent('暂无节目');
    // 频道可用时仍可播放当前内容(FR-012)
    expect(cardScope.getByRole('button', { name: '播放 例牌电影频道 当前直播' })).toBeEnabled();
  });

  it('无节目频道打开详情面板:保留频道身份 +「暂无节目单」+ 主操作仍可播放(ui.md §2.5;T016/T018 接线,预期先红)', async () => {
    installLiveFetchMock();
    renderLivePage();
    const user = userEvent.setup();

    const title = (await screen.findAllByText('例牌电影频道'))[0]!;
    const card = title.closest('article');
    expect(card).not.toBeNull();
    await user.click(within(card as HTMLElement).getByTestId('no-programme'));

    const dialog = await screen.findByRole('dialog');
    const dialogScope = within(dialog);
    // 频道身份保留 + 无节目单语义 + 主操作仍可播放(共享面板 none 态契约)
    expect(dialogScope.getByText('例牌电影频道')).toBeVisible();
    expect(dialogScope.getByText('暂无节目数据')).toBeVisible();
    expect(dialogScope.getByText('暂无节目单')).toBeVisible();
    expect(dialogScope.getByRole('button', { name: '播放当前频道' })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// 4 · 面板状态映射(T016 宿主闭包:kind+serverNowIso → now/upcoming;ui.md §1.6)
// ---------------------------------------------------------------------------

describe('T014 · 直播宿主面板状态映射(FR-013;T016 接线)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('当前节目面板:状态「正在直播」、起止时间与时长、主操作「播放当前频道」可用', async () => {
    installLiveFetchMock();
    renderLivePage();
    const user = userEvent.setup();

    const currentButton = (await screen.findAllByRole('button', { name: /例牌正播节目/ }))[0]!;
    await user.click(currentButton);

    const dialog = await screen.findByRole('dialog');
    const dialogScope = within(dialog);
    expect(dialogScope.getByText('例牌新闻台')).toBeVisible();
    expect(dialogScope.getByText('正在直播')).toBeVisible();
    expect(dialogScope.getByText(/19:30–20:30/)).toBeVisible();
    expect(dialogScope.getByText(/时长/).textContent).toMatch(/60\s*分钟/);
    expect(dialogScope.getByRole('button', { name: '播放当前频道' })).toBeEnabled();
    // 次操作(六要素)
    expect(dialogScope.getByRole('button', { name: '收藏频道' })).toBeVisible();
    expect(dialogScope.getByRole('button', { name: '查看节目单' })).toBeVisible();
  });

  it('即将播放节目面板:状态「即将开始」+ 开播时间,无「播放当前频道」主操作(ui.md §1.6)', async () => {
    installLiveFetchMock();
    renderLivePage();
    const user = userEvent.setup();

    const upcomingButton = (await screen.findAllByRole('button', { name: /例牌预告节目/ }))[0]!;
    await user.click(upcomingButton);

    const dialog = await screen.findByRole('dialog');
    const dialogScope = within(dialog);
    expect(dialogScope.getByText('即将开始')).toBeVisible();
    // 开播时间:13:00Z → 家庭时区 21:00(「开播」行)
    expect(dialogScope.getByText('21:00')).toBeVisible();
    expect(dialogScope.queryByRole('button', { name: '播放当前频道' })).toBeNull();
    expect(dialogScope.getByRole('button', { name: '查看节目单' })).toBeVisible();
  });

  it('宿主映射纯函数:current+时段含 now→now;current+时段不含 now→ended;current+now 缺失→ended;双 null→none;upcoming→upcoming(T018 none 映射钉面)', () => {
    const nowProgramme = LIVE_PROGRAMME_STATES.now;
    const endedProgramme = LIVE_PROGRAMME_STATES.ended;

    // kind=current 且 LIVE_NOW(12:00Z)落在 11:30–12:30Z 内 → now
    expect(panelStatusOf('current', nowProgramme, LIVE_NOW)).toBe('now');
    // 时段不含 now(ended 样本 09:30–10:30Z)→ ended
    expect(panelStatusOf('current', endedProgramme, LIVE_NOW)).toBe('ended');
    // serverNow 缺失无法核实「此刻」→ 其余归 ended(宿主裁决,不臆造本地时钟)
    expect(panelStatusOf('current', nowProgramme, null)).toBe('ended');
    // 双 null 频道(无节目单)→ none(FR-012/T018)
    expect(panelStatusOf('current', null, LIVE_NOW)).toBe('none');
    expect(panelStatusOf('upcoming', null, LIVE_NOW)).toBe('none');
    // kind=upcoming → upcoming(不受 now 影响)
    expect(panelStatusOf('upcoming', LIVE_PROGRAMME_STATES.upcoming, LIVE_NOW)).toBe('upcoming');
  });
});

// ---------------------------------------------------------------------------
// 夹具自检:本文件时间断言依赖的数据桩窗口(挪动桩时先改这里)
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
