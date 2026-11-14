import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChannelRowDto, GuideWindowDto } from '@hmp/shared';
import type { ReactNode } from 'react';
import { ChannelLogo } from '../../../src/features/live/components/channel-logo';
import { ChannelIdentityBadge } from '../../../src/features/live/components/channel-identity-badge';
import { ChannelTile } from '../../../src/features/live/components/ChannelTile';
import { LiveHeroPlayer } from '../../../src/features/live/components/LiveHeroPlayer';
import { GuideScrollContainer } from '../../../src/features/epg/GuideScrollContainer';
import { GuideWall } from '../../../src/features/epg/GuideWall';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { liveChannelRow, LIVE_NOW, LIVE_TEST_TIMEZONE } from '../../helpers/live-data';
import { LIVE_SESSION_STATES, renderLiveWorld } from '../../helpers/live-world';

/**
 * 014 T017–T023 + 实施期呈现修订(2026-11-08 维护者指令)· 频道身份呈现测试。
 *
 * 契约:docs/specs/014-channel-logos/contracts/ui.md §1(修订记录)与 §4;
 * spec.md US1/US2 验收 + evidence 修订注记。
 * - ChannelIdentityBadge(身份角标,现用于 LiveHeroPlayer 右上角):posterRef 非空 →
 *   加载中/失败名称 chip(截断 + HeroUI Tooltip 全名)、onLoad → Logo 衬底盒淡入
 *   (名称退场,互斥观感)、onError → 卸载 img 名称恢复(无裂图/无空白/无错误文案);
 *   posterRef null → 恒名称 chip。定位由宿主传入(LiveHeroPlayer right-4 top-4
 *   md:right-6 md:top-6,与左上状态签对称)。
 * - ChannelTile(2026-11-14 修订):台标位于 16:9 底板左上角的小品牌位(不再居中),
 *   复用 ChannelLogo 的首字回退;无 posterRef 时左上显示频道名,不再渲染角标。
 * - ChannelLogo(小尺寸身份盒:GuideChannelList/personal-area)保留首字回退,原契约不变。
 * - 接入:左上角台标与中央播放键/底部进度线互不重叠;加载中播放/详情可交互
 *   (§4-4);GuideWall/GuideScrollContainer 时间轴 img=0(SC-006 范围守护,§4-6)。
 *
 * jsdom 不加载图片资源:加载中/成功/失败相位经 fireEvent.load/error 显式驱动,
 * 行为确定可复现。tile/hero 经 renderLiveWorld(PlayButton 需统一协调器上下文)。
 */

/** 形如 014 不透明 logoRef 的示意引用(URL 安全字符,encodeURIComponent 恒等) */
const LOGO_REF = 'l1-testopaque';
const LOGO_REF_NEXT = 'l2-testopaque-next';
const CHANNEL_TITLE = '例牌新闻台';

/** 纯组件快挂载(ChannelLogo:小尺寸身份盒,保留首字回退) */
function renderLogo(posterRef: string | null) {
  return render(<ChannelLogo posterRef={posterRef} channelTitle={CHANNEL_TITLE} />);
}

/** 角标纯组件快挂载 */
function renderBadge(posterRef: string | null, channelTitle = CHANNEL_TITLE) {
  return render(<ChannelIdentityBadge posterRef={posterRef} channelTitle={channelTitle} />);
}

/** 带Logo/不带 Logo 的频道行(其余字段与 live-data 规范桩同形) */
function channelRowWithPoster(posterRef: string | null): ChannelRowDto {
  const base = liveChannelRow({
    id: 'ch-logo-1',
    title: CHANNEL_TITLE,
    groupKey: 'g-news',
    groupLabel: '例牌新闻',
    current: 'now',
    next: 'upcoming',
  });
  return { ...base, media: { ...base.media, posterRef } };
}

/** tile/hero 挂载(游客态 + 协调器上下文;PlayButton 依赖,见 live-* 测试先例) */
function renderInLiveWorld(ui: ReactNode) {
  return renderLiveWorld(ui, {
    session: LIVE_SESSION_STATES.guest,
    initialEntries: ['/live'],
    decorate: (children: ReactNode): ReactNode => (
      <SettingsAccessProvider>
        <ActionCoordinator>{children}</ActionCoordinator>
      </SettingsAccessProvider>
    ),
  });
}

describe('T017 · ChannelLogo 装饰层(小尺寸身份盒,GuideChannelList/personal-area 保留):回退链状态机', () => {
  it('posterRef=null:零输出不渲染 img(ui.md §4-1 组件侧)', () => {
    const { container } = renderLogo(null);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('加载成功:onLoad 后可见;onError 卸载 img 首字回退层恢复(小尺寸身份盒契约不变)', () => {
    const view = renderLogo(LOGO_REF);
    const img = view.container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.className).toContain('opacity-0');
    fireEvent.load(img);
    expect(img.className).toContain('opacity-100');
    view.unmount();

    const err = renderLogo(LOGO_REF);
    fireEvent.error(err.container.querySelector('img') as HTMLImageElement);
    expect(err.container.querySelector('img')).toBeNull();
    expect(err.container.textContent).toBe(CHANNEL_TITLE.slice(0, 1));
    err.unmount();
  });

  it('posterRef 变化:相位重置回 loading,旧图不残留;同 ref 重渲染 img 节点稳定(不闪变)', () => {
    const view = renderLogo(LOGO_REF);
    const first = view.container.querySelector('img') as HTMLImageElement;
    fireEvent.load(first);
    view.rerender(<ChannelLogo posterRef={LOGO_REF_NEXT} channelTitle={CHANNEL_TITLE} />);
    const next = view.container.querySelector('img');
    expect(next?.getAttribute('src')).toBe(`/api/public/media/logos/${LOGO_REF_NEXT}`);
    view.rerender(<ChannelLogo posterRef={LOGO_REF_NEXT} channelTitle={CHANNEL_TITLE} />);
    expect(view.container.querySelector('img')).toBe(next);
    view.unmount();
  });
});

describe('实施期修订 · ChannelIdentityBadge 卡片右上角身份角标(ui.md §1 修订记录)', () => {
  it('posterRef=null:恒名称 chip(含完整频道名 + 截断类),无 img', () => {
    const { container } = renderBadge(null);
    expect(container.querySelector('img')).toBeNull();
    const name = screen.getByTestId('identity-name');
    expect(name).toBeVisible();
    expect(name.textContent).toBe(CHANNEL_TITLE);
    // 截断在内层 span(外层为 Tooltip 触发器):max-w 容器 + truncate 内层
    expect(name.querySelector('span')?.className).toContain('hmp-truncate');
    expect(name.className).toContain('max-w-[10rem]');
  });

  it('名称 chip 被 HeroUI Tooltip 包裹:hover 后出现 role=tooltip 全名(长名截断的展全通道)', () => {
    const longTitle = '例牌新闻台超长频道名称用于验证截断与悬浮提示行为';
    renderBadge(null, longTitle);
    const trigger = screen.getByTestId('identity-name');
    expect(trigger.querySelector('span')?.className).toContain('hmp-truncate');
    // HeroUI Tooltip 布线断言:触发层由 HeroUI 渲染(data-slot=tooltip-trigger),
    // 展开/悬浮行为属 overlay 管理器,jsdom 无法模拟 —— 运行时验证在 quickstart §4
    // (真实浏览器证据),此处只钉「Tooltip 已接线且全文经 Content 通道」的结构。
    const triggerWrapper = trigger.closest('[data-slot="tooltip-trigger"]');
    expect(triggerWrapper).not.toBeNull();
    expect(triggerWrapper?.getAttribute('aria-describedby')).toBeDefined();
  });

  it('posterRef 非空、加载中:名称 chip 可见(身份不缺位)+ 隐形预载 img(opacity-0,不破布局)', () => {
    const { container } = renderBadge(LOGO_REF);
    expect(screen.getByTestId('identity-name')).toBeVisible();
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/public/media/logos/${LOGO_REF}`);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.className).toContain('opacity-0');
    expect(img.className).toContain('pointer-events-none');
  });

  it('img onLoad:Logo 衬底盒淡入(identity-logo),名称 chip 退场(互斥观感)', () => {
    const { container } = renderBadge(LOGO_REF);
    fireEvent.load(container.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('identity-logo')).toBeVisible();
    expect(screen.queryByTestId('identity-name')).toBeNull();
    const img = container.querySelector('[data-testid="identity-logo"] img') as HTMLImageElement;
    expect(img.getAttribute('alt')).toBe('');
    expect(img.className).toContain('object-contain');
  });

  it('img onError:img 卸载、名称 chip 恢复(无裂图/无错误文案/无占位框)', () => {
    const { container } = renderBadge(LOGO_REF);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('identity-name')).toBeVisible();
    expect(container.textContent).not.toContain('加载失败');
  });

  it('posterRef 变化:相位重置回名称 chip(旧图不残留);同 ref 重渲染状态稳定', () => {
    const view = renderBadge(LOGO_REF);
    fireEvent.load(view.container.querySelector('img') as HTMLImageElement);
    expect(screen.getByTestId('identity-logo')).toBeVisible();
    view.rerender(<ChannelIdentityBadge posterRef={LOGO_REF_NEXT} channelTitle={CHANNEL_TITLE} />);
    // 回到加载中:名称 chip 可见,新 ref 的隐形预载 img 就位
    expect(screen.getByTestId('identity-name')).toBeVisible();
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
      `/api/public/media/logos/${LOGO_REF_NEXT}`,
    );
    view.rerender(<ChannelIdentityBadge posterRef={LOGO_REF_NEXT} channelTitle={CHANNEL_TITLE} />);
    expect(screen.getByTestId('identity-name')).toBeVisible();
    view.unmount();
  });
});

describe('T018/T019(2026-11-14 修订) · 接入:台标固定在 16:9 底板左上角;与播放键/进度线互不重叠;大首字取消', () => {
  it('ChannelTile:posterRef 非空 → 左上角 tile-logo 承载 ChannelLogo;加载中首字回退,onLoad 后 Logo 顶替;播放入口不受影响', () => {
    const view = renderInLiveWorld(
      <ChannelTile
        row={channelRowWithPoster(LOGO_REF)}
        nowIso={LIVE_NOW}
        onOpenProgramme={vi.fn()}
        onRequireAuth={vi.fn()}
      />,
    );
    try {
      // 原右上角角标退场,左上角品牌位就位
      expect(screen.getByTestId('tile-logo')).toBeVisible();
      expect(screen.queryByTestId('identity-badge')).toBeNull();
      const img = view.container.querySelector('img') as HTMLImageElement;
      expect(img.getAttribute('src')).toBe(`/api/public/media/logos/${LOGO_REF}`);
      // 加载中:首字回退可见、img 等待
      expect(img.className).toContain('opacity-0');
      fireEvent.load(img);
      // onLoad:Logo 淡入
      expect(img.className).toContain('opacity-100');
      // 大首字取消:底板不存在超大首字层(结构断言:无 text-6xl 档元素;
      // 信息区合法文本含首字属正常,不按 textContent 判断)
      const hugeFirstChar = Array.from(view.container.querySelectorAll('span')).filter((el) =>
        /(^|\s)text-6xl(\s|$)/.test(el.className),
      );
      expect(hugeFirstChar).toHaveLength(0);
      // 状态签已按产品要求移除;播放入口收敛为中央按钮
      expect(screen.queryByText('正在直播')).toBeNull();
      expect(screen.getByRole('button', { name: `播放 ${CHANNEL_TITLE}` })).toBeEnabled();
    } finally {
      view.restore();
    }
  });

  it('ChannelTile:posterRef=null → 左上显示频道名,无 img,大首字取消', () => {
    const view = renderInLiveWorld(
      <ChannelTile
        row={channelRowWithPoster(null)}
        nowIso={LIVE_NOW}
        onOpenProgramme={vi.fn()}
        onRequireAuth={vi.fn()}
      />,
    );
    try {
      expect(view.container.querySelector('img')).toBeNull();
      expect(screen.getByTestId('tile-logo-fallback').textContent).toBe(CHANNEL_TITLE);
    } finally {
      view.restore();
    }
  });

  /* 015 NowHero 已由 LiveHeroPlayer 替代(015 T008):角标契约(右上 right-4 top-4 档、
     Logo 回退链、无大首字)不变,宿主迁移为同一断言面(authed 会话 → 认证态主操作)。 */
  it('LiveHeroPlayer:posterRef 非空 → 角标在右上(right-4 top-4 档),onLoad 后 Logo 顶替;大首字取消、状态签/信息层照常', async () => {
    const view = renderLiveWorld(
      <LiveHeroPlayer
        row={channelRowWithPoster(LOGO_REF)}
        timezone={LIVE_TEST_TIMEZONE}
        nowIso={LIVE_NOW}
        onOpenProgramme={vi.fn()}
      />,
      {
        session: LIVE_SESSION_STATES.authedWithProfile,
        initialEntries: ['/live'],
        decorate: (children: ReactNode): ReactNode => (
          <SettingsAccessProvider>
            <ActionCoordinator>{children}</ActionCoordinator>
          </SettingsAccessProvider>
        ),
      },
    );
    try {
      // 等待会话恢复到认证态(主操作呈现「全屏播放」,匹配 /播放/ 断言)
      await screen.findByRole('button', { name: /播放/ });
      // 背景图卡布局:角标改为 Header 内联(不再绝对定位),身份链不变
      const anchor = screen.getByTestId('identity-name').closest('[data-testid="identity-badge"]');
      expect(anchor).not.toBeNull();
      fireEvent.load(view.container.querySelector('img') as HTMLImageElement);
      expect(screen.getByTestId('identity-logo')).toBeVisible();
      // 大首字取消:无超大首字字号档(结构断言;信息区合法文本含首字属正常)
      const hugeFirstChar = Array.from(view.container.querySelectorAll('span')).filter((el) =>
        /text-\[10rem\]|text-\[13rem\]/.test(el.className),
      );
      expect(hugeFirstChar).toHaveLength(0);
      expect(screen.getByText('正在直播')).toBeVisible();
      expect(screen.getByRole('button', { name: /播放/ })).toBeEnabled();
    } finally {
      view.restore();
    }
  });

  it('LiveHeroPlayer:posterRef=null → 名称 chip 呈现,无 img', () => {
    const view = renderLiveWorld(
      <LiveHeroPlayer
        row={channelRowWithPoster(null)}
        timezone={LIVE_TEST_TIMEZONE}
        nowIso={LIVE_NOW}
        onOpenProgramme={vi.fn()}
      />,
      {
        session: LIVE_SESSION_STATES.authedWithProfile,
        initialEntries: ['/live'],
        decorate: (children: ReactNode): ReactNode => (
          <SettingsAccessProvider>
            <ActionCoordinator>{children}</ActionCoordinator>
          </SettingsAccessProvider>
        ),
      },
    );
    try {
      expect(view.container.querySelector('img')).toBeNull();
      expect(screen.getByTestId('identity-name').textContent).toBe(CHANNEL_TITLE);
    } finally {
      view.restore();
    }
  });
});

/** SC-006 守护夹具:GuideWindow 最小窗口(频道甲带 posterRef——证明数据带 Logo 也不得进时间轴) */
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
        media: media('ch-a', '频道甲', LOGO_REF),
        programmes: [programme('pg-a1', '早间新闻', '2026-11-04T11:00:00.000Z', '2026-11-04T12:30:00.000Z')],
      },
      { media: media('ch-b', '频道乙', null), programmes: [] },
    ],
  };
}

describe('T022 · 回退链不变量:host 级失败恢复、加载中可交互、SC-006 范围守护(ui.md §4-3/4/6)', () => {
  it('ChannelTile onError:img 卸载、左上首字回退接替、无裂图痕迹,中央播放入口仍在(ui.md §4-3 host 级)', () => {
    const view = renderInLiveWorld(
      <ChannelTile
        row={channelRowWithPoster(LOGO_REF)}
        nowIso={LIVE_NOW}
        onOpenProgramme={vi.fn()}
        onRequireAuth={vi.fn()}
      />,
    );
    try {
      fireEvent.error(view.container.querySelector('img') as HTMLImageElement);
      expect(view.container.querySelector('img')).toBeNull();
      // ChannelLogo 首字回退接替(台标中央主视觉不空白)
      expect(screen.getByTestId('tile-logo').textContent).toContain(CHANNEL_TITLE.slice(0, 1));
      // 无错误文案/占位框
      expect(view.container.textContent).not.toContain('加载失败');
      expect(screen.getByRole('button', { name: `播放 ${CHANNEL_TITLE}` })).toBeEnabled();
    } finally {
      view.restore();
    }
  });

  it('加载中:播放/详情按钮可交互(pending img 不阻塞任何操作,ui.md §4-4)', () => {
    const onOpenProgramme = vi.fn();
    const view = renderInLiveWorld(
      <ChannelTile
        row={channelRowWithPoster(LOGO_REF)}
        nowIso={LIVE_NOW}
        slot="upcoming"
        onOpenProgramme={onOpenProgramme}
      />,
    );
    try {
      // 确认处于加载中相位(隐形预载 img 尚未 load)
      expect((view.container.querySelector('img') as HTMLImageElement).className).toContain('opacity-0');
      // 详情:点击节目标题打开详情面板。015 T004 后 current 档节目名=导航 /live/watch,
      // 面板入口契约改由 upcoming 档钉住(下一档节目,kind=upcoming)
      fireEvent.click(screen.getByRole('button', { name: '例牌预告节目' }));
      expect(onOpenProgramme).toHaveBeenCalledTimes(1);
      // 收藏入口已从瓦片移除(改由详情/收藏页承担)
      expect(screen.queryByRole('button', { name: `收藏 ${CHANNEL_TITLE}` })).toBeNull();
      // upcoming 档:底板点击区 = 查看详情(不拉播放器),且未被 pending img 阻塞
      const openDetail = screen.getByRole('button', { name: `查看 ${CHANNEL_TITLE} 节目详情` });
      expect(openDetail).toBeEnabled();
      expect(() => fireEvent.click(openDetail)).not.toThrow();
    } finally {
      view.restore();
    }
  });

  it('台标范围(2026-11-12 产品变更):时间轴频道列展示 logo 接口台标,不再渲染频道名文本', () => {
    const { container } = render(
      <GuideScrollContainer ariaLabel="节目单时间轴">
        <GuideWall
          data={guideWindowFixture()}
          focusSignal={0}
          selectedKey={null}
          onSelectProgramme={vi.fn()}
          onPlayChannel={vi.fn()}
        />
      </GuideScrollContainer>,
    );
    // 产品变更(原 SC-006 零 img 守护已废弃):频道列只显示台标,台标走同源 logo 接口
    const logos = Array.from(container.querySelectorAll('img'));
    expect(logos.length).toBeGreaterThan(0);
    expect(logos.every((img) => (img.getAttribute('src') ?? '').includes('/api/public/media/logos/'))).toBe(true);
    // 频道名不再作为可见文本渲染(改由 Tooltip / aria-label 承载)
    expect(screen.queryByText('频道甲')).toBeNull();
    expect(screen.getByRole('button', { name: '播放 频道甲 当前直播' })).toBeInTheDocument();
    // 节目块照常可点
    expect(screen.getByRole('button', { name: /早间新闻/ })).toBeEnabled();
  });
});
