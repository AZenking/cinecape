import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { GuideWindowDto } from '@hmp/shared';
import type { ReactNode } from 'react';
import { GuideChannelList } from '../../../src/features/epg/GuideChannelList';
import { HomePage } from '../../../src/features/home/HomePage';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { LIVE_SESSION_STATES, renderLiveWorld } from '../../helpers/live-world';

/**
 * 014 T025/T026–T028 · US3 呈现接入测试(节目单频道列头 + 收藏列表)。
 *
 * 契约:docs/specs/014-channel-logos/contracts/ui.md §2 接入点 3/4/5、spec.md US3:
 * - GuideChannelList 频道列头小尺寸 ChannelLogo:行高与布局不因 Logo 有无变化
 *   (US3-1;结构保证 = 固定尺寸身份盒 + 装饰层绝对定位不参与行盒,列头文字保留);
 * - 收藏频道列表渲染面(apps/web/src/features/home/personal-area.tsx FavoritesSection,
 *   aria-label="收藏频道列表"——grep 全仓无独立 /favorites 路由,个人区收藏区即
 *   ui.md §2「收藏页频道列表」当前唯一渲染面):有 Logo 显示小图、无 Logo 维持
 *   现状文字(US3-3);有/无 Logo 均保持标题文字呈现。
 * - 范围守护(SC-006)在 channel-logo.spec.tsx T022 块(GuideWall/GuideScrollContainer img=0)。
 */

/** 形如 014 不透明 logoRef 的示意引用(URL 安全字符,encodeURIComponent 恒等) */
const LOGO_REF = 'l3-us3-opaque';

/* ---------------- GuideChannelList:列头小 Logo,行高不因 Logo 有无变化 ---------------- */

function guideMedia(id: string, title: string, posterRef: string | null) {
  return {
    id,
    type: 'channel' as const,
    title,
    description: null,
    posterRef,
    contentLevel: null,
    availability: 'available' as const,
  };
}

function guideProgramme(key: string, title: string) {
  return {
    key,
    title,
    description: null,
    posterRef: null,
    startsAt: '2026-11-04T11:00:00.000Z',
    endsAt: '2026-11-04T12:30:00.000Z',
  };
}

/** 频道甲(带 Logo)+ 频道乙(无 Logo):同一窗口内对照行高 */
function guideWindowFixture(): GuideWindowDto {
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
      { media: guideMedia('ch-a', '频道甲', LOGO_REF), programmes: [guideProgramme('pg-a1', '早间新闻')] },
      { media: guideMedia('ch-b', '频道乙', null), programmes: [] },
    ],
  };
}

describe('T026 · GuideChannelList 频道列头小尺寸 ChannelLogo(ui.md §2 接入点 3;US3-1)', () => {
  it('有 Logo:列头渲染小尺寸 ChannelLogo(img 指向 /api/public/media/logos),列头文字保留', () => {
    render(
      <GuideChannelList data={guideWindowFixture()} selectedKey={null} onSelectProgramme={vi.fn()} onPlayChannel={vi.fn()} />,
    );
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(`/api/public/media/logos/${LOGO_REF}`);
    expect(img?.getAttribute('alt')).toBe('');
    // 列头文字仍保留(列头不因 Logo 而省略)
    expect(screen.getByText('频道甲')).toBeVisible();
    // Logo 装饰层绝对定位于身份盒内,不参与行盒(行高不变的结构保证)
    const wrapper = img?.parentElement as Element;
    expect(wrapper.className).toContain('absolute');
    expect(wrapper.className).toContain('inset-0');
    // 身份盒固定尺寸 + 不伸缩 + 裁切:行高由列头行盒决定,与 Logo 有无无关
    const box = wrapper.parentElement as Element;
    expect(box.className).toContain('size-5');
    expect(box.className).toContain('shrink-0');
    expect(box.className).toContain('overflow-hidden');
  });

  it('无 Logo:维持现状纯文字列头,不渲染 img 与身份盒(FR-008 现状保留)', () => {
    render(
      <GuideChannelList data={guideWindowFixture()} selectedKey={null} onSelectProgramme={vi.fn()} onPlayChannel={vi.fn()} />,
    );
    expect(screen.getByText('频道乙')).toBeVisible();
    // 频道乙 section 内无 img(全文档唯一 img 属频道甲)
    const sectionB = screen.getByText('频道乙').closest('section') as Element;
    expect(sectionB.querySelector('img')).toBeNull();
  });

  it('行高不因 Logo 有无变化:两频道列头 h3 类名一致(同一行盒档位),身份盒为列头唯一布局内子元素差异', () => {
    const { container } = render(
      <GuideChannelList data={guideWindowFixture()} selectedKey={null} onSelectProgramme={vi.fn()} onPlayChannel={vi.fn()} />,
    );
    const headers = Array.from(container.querySelectorAll('h3'));
    expect(headers).toHaveLength(2);
    // 列头行盒类名逐字一致:行高由同一档位决定,不因 Logo 有无产生任何布局差异
    expect(headers[0]?.className).toBe(headers[1]?.className);
  });
});

/* ---------------- 收藏频道列表渲染面(T027/T028):个人区收藏区 ---------------- */

/**
 * 收藏列表渲染面(home personal-area FavoritesSection)挂载:
 * 全仓 grep 无独立 /favorites 路由页,ui.md §2「收藏页频道列表条目」当前唯一
 * 渲染面 = 首页个人区收藏频道列表(aria-label="收藏频道列表")。挂载沿
 * home-personal-area.spec 先例:HomePage + 会话/公共上下文 + /me fetch 路由桩。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 已选档会话下的收藏列表(单条 favorite-card;posterRef 可控) */
function stubFavoriteChannel(posterRef: string | null): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/setup/status')) return jsonResponse({ initialized: true });
    if (url.endsWith('/public/context')) {
      return jsonResponse({
        initialized: true,
        displayName: '幸福之家',
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        now: '2026-10-26T00:00:00.000Z',
        catalogRevision: 1,
      });
    }
    if (url.includes('/me/favorites/channels')) {
      return jsonResponse({
        items: [
          {
            media: { id: 'ch-fav-1', type: 'channel', title: '收藏夹具台', description: null, posterRef, contentLevel: 0, availability: 'available' },
            createdAt: '2026-10-26T01:00:00.000Z',
            current: null,
            next: null,
          },
        ],
        nextCursor: null,
      });
    }
    if (url.includes('/me/history')) return jsonResponse({ items: [], nextCursor: null });
    return jsonResponse({ status: 404, code: 'NOT_FOUND', title: 'NOT_FOUND' }, 404);
  });
}

function renderHomePersonal(): { restore: () => void } {
  const view = renderLiveWorld(<HomePage />, {
    session: LIVE_SESSION_STATES.authedWithProfile,
    initialEntries: ['/'],
    decorate: (children: ReactNode): ReactNode => (
      <SettingsAccessProvider>
        <ActionCoordinator>{children}</ActionCoordinator>
      </SettingsAccessProvider>
    ),
  });
  return { restore: view.restore };
}

describe('T027/T028 · 收藏频道列表渲染面:有 Logo 显示小图、无 Logo 维持现状文字(ui.md §2 接入点 4/5;US3-3)', () => {
  it('有 Logo:收藏卡显示小尺寸 ChannelLogo(img 同源代理路径),标题文字保留', async () => {
    stubFavoriteChannel(LOGO_REF);
    const view = renderHomePersonal();
    try {
      const card = await waitFor(() => screen.getByTestId('favorite-card'));
      const img = card.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe(`/api/public/media/logos/${LOGO_REF}`);
      expect(img?.getAttribute('alt')).toBe('');
      // Logo 装饰层绝对定位于固定尺寸身份盒内(不撑高卡片行盒)
      const wrapper = img?.parentElement as Element;
      expect(wrapper.className).toContain('absolute');
      const box = wrapper.parentElement as Element;
      expect(box.className).toContain('size-6');
      expect(box.className).toContain('overflow-hidden');
      // 标题文字保留
      expect(screen.getByText('收藏夹具台')).toBeVisible();
    } finally {
      view.restore();
    }
  });

  it('无 Logo:收藏卡维持现状纯文字呈现,无 img(FR-008 现状保留)', async () => {
    stubFavoriteChannel(null);
    const view = renderHomePersonal();
    try {
      const card = await waitFor(() => screen.getByTestId('favorite-card'));
      expect(card.querySelector('img')).toBeNull();
      // 现状文字照旧:标题 + 直播状态文案
      expect(screen.getByText('收藏夹具台')).toBeVisible();
    } finally {
      view.restore();
    }
  });
});
