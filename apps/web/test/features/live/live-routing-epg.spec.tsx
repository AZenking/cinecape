import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router';
import type { ReactNode } from 'react';
import type { GuideWindowDto } from '@hmp/shared';
import { GuideWall } from '../../../src/features/epg/GuideWall';
import { GuidePage } from '../../../src/features/epg/GuidePage';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import {
  LIVE_REDESIGN_CATALOG_REVISION,
  LIVE_REDESIGN_NOW_ISO,
  LIVE_REDESIGN_TIMEZONE,
  buildChannelRow,
  buildProgramme,
  windowFromMinutes,
} from '../../fixtures/live-redesign-fixtures';
import { installNetworkCounter } from '../../helpers/network-assertions';
import { LIVE_SESSION_STATES, LiveSessionProbe, renderLiveWorld } from '../../helpers/live-world';

/**
 * 015 T011 [US2] · Live 行直达 EPG 节目单时间墙:与 NOW 相交节目块直接起播(单测钉面)。
 *
 * 契约:research.md R6、contracts/ui-layout.md §3.2、spec.md US2 验收 3/4、quickstart 场景 2。
 * 实现侧(T013)在 GuideWall 节目块点击处分流:
 * - 与 NOW 相交的节目块(pickCurrentProgramme 判定的 current:start<=now<end)点击
 *   **直接触发 playChannel**(断言 onPlayChannel 以频道 mediaId/channelTitle 调用;
 *   onSelectProgramme 零调用;零媒体流请求——播放统一经 US3 usePlayAction,游客先
 *   登录选档,登录前不发 /playback/* 请求,network-assertions 计数钉面);
 * - 未来节目块(NOW 右侧 upcoming)与已播完块(ended)点击**仍打开轻量详情**
 *   (onSelectProgramme 被调用;playChannel 零调用)——不伪装可播放未来节目
 *   (FR-024 延续:「未来内容不提供播放」)。
 *
 * 分层:
 * - GuideWall 层:纯 props vi.fn 挂载(行为分流是墙自身的输出契约);
 * - GuidePage 层:游客挂载宿主,点击 current 墙块断言统一登录链路被拉起
 *   (墙 → onPlayChannel → usePlayAction 全链接线),零媒体请求、不导航。
 *
 * 夹具:015 T005 live-redesign-fixtures(LIVE_REDESIGN_NOW_ISO 固定服务端快照,
 * windowFromMinutes 相对时间窗,buildChannelRow 实名 current/.next 字段),
 * 与 NOW 相交判定在任何时区/运行时刻稳定。
 */

/* ---------------- GuideWindow 夹具(单频道三态节目:ended / current / upcoming) ---------------- */

const CH_ID = 'b0000000-0000-4000-8000-0000000000f1';
const CH_TITLE = 'EPG 墙测试台';

/** 规范频道行(015 夹具;current 与 NOW 严格相交、next 起始在 NOW 之后) */
const WALL_ROW = buildChannelRow({
  id: CH_ID,
  title: CH_TITLE,
  groupKey: 'movie',
  groupLabel: '电影',
  current: {
    key: 'lr-wall:current',
    title: '正在播出的纪录片',
    description: '与 NOW 红线相交的当前节目',
    startsAtMinutes: -20,
    endsAtMinutes: 40,
  },
  next: {
    key: 'lr-wall:next',
    title: '未开播的下一档',
    description: 'NOW 右侧的未来节目',
    startsAtMinutes: 40,
    endsAtMinutes: 100,
  },
});

/** 已播完块(窗口整体在 NOW 左侧;与 current 不同窗,先后不重叠) */
const ENDED_PROGRAMME = buildProgramme({
  key: 'lr-wall:ended',
  title: '已播完的早间档',
  startsAtMinutes: -120,
  endsAtMinutes: -60,
});

/** 单频道墙窗:窗口覆盖 [NOW−2h, NOW+3h],NOW 在窗内(R6 相交判定取服务端 now) */
function guideWindowFixture(): GuideWindowDto {
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
        media: WALL_ROW.media,
        programmes: [ENDED_PROGRAMME, WALL_ROW.current, WALL_ROW.next].filter(
          (programme): programme is NonNullable<typeof programme> => programme !== null,
        ),
      },
    ],
  };
}

/* ---------------- 媒体流请求守卫:任何 fetch 调用都视为违规 ---------------- */

let fetchMock: ReturnType<typeof vi.fn>;

function installNoNetworkGuard(): void {
  fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }), {
        status: 404,
        headers: { 'Content-Type': 'application/problem+json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
}

/* ---------------- GuideWall 层(015 T013 输出契约) ---------------- */

describe('T011 · GuideWall 相交节目块直接起播(T013 分流;R6/ui-layout §3.2)', () => {
  let counter: ReturnType<typeof installNetworkCounter> | null = null;

  beforeEach(() => {
    installNoNetworkGuard();
    // 计数器包在路由 mock 外:既记 /playback/、/me/ 前缀,又兜底暴露任何意外请求
    counter = installNetworkCounter();
  });

  afterEach(() => {
    counter?.restore();
    counter = null;
    vi.unstubAllGlobals();
  });

  function renderWall(overrides: {
    onSelectProgramme?: ReturnType<typeof vi.fn>;
    onPlayChannel?: ReturnType<typeof vi.fn>;
  } = {}) {
    const onSelectProgramme = overrides.onSelectProgramme ?? vi.fn();
    const onPlayChannel = overrides.onPlayChannel ?? vi.fn();
    render(
      <GuideWall
        data={guideWindowFixture()}
        focusSignal={0}
        selectedKey={null}
        onSelectProgramme={onSelectProgramme}
        onPlayChannel={onPlayChannel}
      />,
    );
    return { onSelectProgramme, onPlayChannel };
  }

  function wallBlock(programmeTitle: string): HTMLElement {
    const button = screen
      .getAllByRole('button')
      .find((candidate) => (candidate.getAttribute('aria-label') ?? '').includes(programmeTitle));
    if (button === undefined) {
      throw new Error(`未找到节目块:${programmeTitle}`);
    }
    return button;
  }

  it('current 块(与 NOW 相交)点击直接触发 playChannel:onPlayChannel 以 (mediaId, channelTitle) 调用,onSelectProgramme 零调用', () => {
    const { onSelectProgramme, onPlayChannel } = renderWall();

    fireEvent.click(wallBlock('正在播出的纪录片'));

    expect(onPlayChannel).toHaveBeenCalledTimes(1);
    expect(onPlayChannel).toHaveBeenCalledWith(CH_ID, CH_TITLE);
    expect(onSelectProgramme).not.toHaveBeenCalled();
    // 零媒体流请求:点击不起播链路的网络面(US3 usePlayAction 才是唯一出海口)
    expect(fetchMock).not.toHaveBeenCalled();
    expect(counter?.counts.playback).toBe(0);
    expect(counter?.counts.personal).toBe(0);
  });

  it('current 块渲染绿色 LIVE 角标:文字语义(LIVE + aria「正在直播」)+ success 语义 token,非仅颜色区分', () => {
    renderWall();

    const block = wallBlock('正在播出的纪录片');
    // 可读名保留「正在直播」语义(键盘/读屏不依赖颜色)
    expect(block.getAttribute('aria-label')).toContain(',正在直播');
    // 角标本体:HeroUI Chip(success 色系语义 token),文字 LIVE 可见
    const chip = block.querySelector('[data-slot="chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.className).toContain('chip--success');
    expect(within(block).getByText('LIVE')).toBeVisible();
    // 非 current 块无角标(未来/已播完块不冒充直播)
    expect(wallBlock('未开播的下一档').querySelector('[data-slot="chip"]')).toBeNull();
    expect(wallBlock('已播完的早间档').querySelector('[data-slot="chip"]')).toBeNull();
  });

  it('未来节目块(NOW 右侧)点击仍打开轻量详情:onSelectProgramme 调用、playChannel 零调用(FR-024 不伪装可播)', () => {
    const { onSelectProgramme, onPlayChannel } = renderWall();

    fireEvent.click(wallBlock('未开播的下一档'));

    expect(onSelectProgramme).toHaveBeenCalledTimes(1);
    const ref = onSelectProgramme.mock.calls[0]?.[0] as { mediaId: string; channelTitle: string; programme: { key: string } };
    expect(ref.mediaId).toBe(CH_ID);
    expect(ref.channelTitle).toBe(CH_TITLE);
    expect(ref.programme.key).toBe('lr-wall:next');
    expect(onPlayChannel).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('已播完节目块点击同样走详情:ended 块不触发播放', () => {
    const { onSelectProgramme, onPlayChannel } = renderWall();

    fireEvent.click(wallBlock('已播完的早间档'));

    expect(onSelectProgramme).toHaveBeenCalledTimes(1);
    expect(onPlayChannel).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ---------------- GuidePage 层(墙 → usePlayAction 全链接线;游客) ---------------- */

function LocationProbe(): ReactNode {
  const location = useLocation();
  return (
    <span data-testid="loc">
      {location.pathname}
      {location.search}
    </span>
  );
}

describe('T011 · GuidePage 宿主接线:current 墙块点击 → 统一登录链路(游客)', () => {
  /** 页面级路由桩:放行墙窗数据与部署探测,其余一律 404(夹具世界内不出网) */
  function installPageFetchRouter(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), 'http://localhost:3000');
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && url.pathname === '/api/setup/status') {
          return Promise.resolve(
            new Response(JSON.stringify({ initialized: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        if (method === 'GET' && url.pathname === '/api/public/guide') {
          return Promise.resolve(
            new Response(JSON.stringify(guideWindowFixture()), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }), {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
        );
      }),
    );
  }

  beforeEach(() => {
    // 先装页面路由 mock,再由 renderLiveWorld 叠会话 mock、installNetworkCounter 叠计数层
    installPageFetchRouter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('游客点击 current 墙块:拉起统一登录弹层(播放意图经协调器)、不打开详情面板、零 /playback/ 与 /me/ 请求、不导航', async () => {
    const counter = installNetworkCounter();
    const world = renderLiveWorld(
      <>
        <GuidePage />
        <LiveSessionProbe />
        <LocationProbe />
      </>,
      {
        session: LIVE_SESSION_STATES.guest,
        initialEntries: ['/live/guide'],
        decorate: (ui: ReactNode): ReactNode => (
          <SettingsAccessProvider>
            <ActionCoordinator>{ui}</ActionCoordinator>
          </SettingsAccessProvider>
        ),
      },
    );
    try {
      await waitFor(() => expect(screen.getByTestId('live-session').textContent).toBe('anonymous:none'));
      const block = await screen.findByRole('button', { name: /EPG 墙测试台,正在播出的纪录片/ });
      fireEvent.click(block);

      // 统一登录弹层出现(播放意图经 usePlayAction/ActionCoordinator;至多一层)
      await waitFor(() => expect(screen.getByRole('dialog', { name: '登录' })).toBeVisible());
      // 详情面板未打开(播放 ≠ 详情)
      expect(screen.queryByRole('dialog', { name: /节目详情/ })).toBeNull();
      // 登录前零媒体流请求(US3 契约:授权前不请求 /playback/*)
      expect(counter.counts.playback).toBe(0);
      expect(counter.counts.personal).toBe(0);
      // 不导航(播放不走路由)
      expect(screen.getByTestId('loc').textContent).toBe('/live/guide');
    } finally {
      world.restore();
      counter.restore();
    }
  });
});
