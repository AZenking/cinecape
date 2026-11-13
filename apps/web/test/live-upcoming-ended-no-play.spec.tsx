import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { ChannelTile } from '../src/features/live/components/ChannelTile';
import { ProgrammeDetailPanel, type ProgrammeStatus } from '../src/features/shared-programme/ProgrammeDetailPanel';
import { ActionCoordinator } from '../src/app/action-coordinator';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { liveChannelRow, LIVE_NOW, LIVE_PROGRAMME_STATES, LIVE_TEST_TIMEZONE } from './helpers/live-data';
import { LIVE_SESSION_STATES, renderLiveWorld } from './helpers/live-world';
import { installNetworkCounter } from './helpers/network-assertions';

/**
 * 012 T012 · upcoming/ended 播放入口禁用(FR-011、ui.md §1.6/§2.3、SC-002):
 * 「未来/已结束节目出现播放入口的用例为 0」——now/none 才有播放主操作。
 *
 * - 节目详情面板(T022 起 = 共享面板 shared-programme/ProgrammeDetailPanel,旧
 *   features/epg/ProgrammeDetailPanel 已删除):upcoming=即将开始 → 无播放主操作,
 *   显示开播时间;ended=已结束 → 无播放入口;now → 「播放当前频道」(频道语义)。
 *   四状态门组件契约由 test/components/programme-detail-panel.spec.tsx(T003)钉住;
 *   EPG 宿主的 status 推导与动作接线由 test/guide-detail-panel-host.spec.tsx(T022)钉住。
 * - 直播瓦片卡(ChannelTile):播放钮为**频道语义**(播放该频道当前直播,T008 已交付
 *   形态;FR-012 无节目频道保留播放入口),本身不属于"未来节目播放入口";
 *   约束点在节目名:upcoming 档位是「查看详情」控件(开面板回调),按下**不触发播放**
 *   (零 /playback/ 请求,§1.6「upcoming 主操作=查看详情/节目单」);current 档位自
 *   015 T004 起改为导航 /live/watch/:id(research.md R5、ui-layout.md §1.2 第 3 条,
 *   双层交互消灭二级详情阻断),同样**不触发播放**(零 /playback/ 请求)且不再开面板。
 *
 * 时间锚:T004 live-data 固定 LIVE_NOW(2026-11-01T12:00Z,家庭时区 Asia/Shanghai
 * 20:00);upcoming 窗口 13:00–14:00Z(21:00–22:00 开播),ended 窗口 09:30–10:30Z。
 */

const TZ = LIVE_TEST_TIMEZONE;

/* ---------------- 共享面板(纯 props 组件,无需会话/网络) ---------------- */

/** 宿主同形映射:startsAt/endsAt → start/end;status 由宿主按 serverNow 推导(此处直传) */
function renderSharedPanel(status: Exclude<ProgrammeStatus, 'none'>) {
  const programme = LIVE_PROGRAMME_STATES[status];
  const onPlay = vi.fn();
  render(
    <ProgrammeDetailPanel
      open
      channel={{ name: '例牌新闻台', logo: null }}
      programme={{ title: programme.title, description: programme.description, start: programme.startsAt, end: programme.endsAt }}
      status={status}
      timezone={TZ}
      source="guide"
      onPlay={onPlay}
      onFavorite={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { onPlay };
}

describe('T012 · 节目详情面板(共享面板):upcoming/ended 无播放主操作(ui.md §1.6)', () => {
  it('upcoming:不渲染播放主操作,状态=即将开始且显示开播时间;仅保留关闭出口', () => {
    const { onPlay } = renderSharedPanel('upcoming');

    // 无播放入口(播放主操作仅 now/none;§1.6/§2.3)
    expect(screen.queryByRole('button', { name: /当前直播/ })).toBeNull();
    // 状态与开播时间可见(21:00 = 13:00Z 按家庭时区 Asia/Shanghai)
    expect(screen.getByText('即将开始')).toBeVisible();
    expect(screen.getByText('21:00')).toBeVisible();
    // 关闭出口保留(查看详情语义)
    expect(screen.getByRole('button', { name: '关闭' })).toBeVisible();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('ended:不渲染任何播放入口,状态=已结束', () => {
    const { onPlay } = renderSharedPanel('ended');

    expect(screen.queryByRole('button', { name: /当前直播/ })).toBeNull();
    expect(screen.getByText('已结束')).toBeVisible();
    expect(screen.getByRole('button', { name: '关闭' })).toBeVisible();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('now:保留播放主操作「播放当前频道」(频道语义,指向当前直播而非该节目快照)', () => {
    const { onPlay } = renderSharedPanel('now');

    expect(screen.getByRole('button', { name: '播放' })).toBeVisible();
    expect(screen.getByText('正在直播')).toBeVisible();
    expect(onPlay).not.toHaveBeenCalled();
  });
});

/* ---------------- 直播瓦片卡(频道语义播放钮 + upcoming 行=查看详情不播放) ---------------- */

const TILE_CHANNEL_TITLE = '例牌新闻台';

/** 内存路由探针:断言 015 T004 current 档导航(renderLiveWorld 无条件挂载,导航只改内存 location) */
function TileLocationProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="tile-location">{location.pathname}</span>;
}

/** ChannelTile 挂载(PlayButton 需统一协调器上下文;游客态 + 网络计数器) */
function renderTile(current: 'now' | 'none', next: 'upcoming' | 'none', slot: 'current' | 'upcoming' = 'current') {
  const onOpenProgramme = vi.fn();
  const counter = installNetworkCounter({ fetch: async () => new Response(null, { status: 404 }) });
  const view = renderLiveWorld(
    <>
      <ChannelTile
        row={liveChannelRow({
          id: 'ch-tile-1',
          title: TILE_CHANNEL_TITLE,
          groupKey: 'g-news',
          groupLabel: '例牌新闻',
          current,
          next,
        })}
        slot={slot}
        nowIso={LIVE_NOW}
        onOpenProgramme={onOpenProgramme}
        onRequireAuth={vi.fn()}
      />
      <TileLocationProbe />
    </>,
    {
      session: LIVE_SESSION_STATES.guest,
      initialEntries: ['/live'],
      decorate: (ui: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
  return { onOpenProgramme, counter, restore: view.restore };
}

describe('T012 · 直播瓦片卡:节目名不承载播放,播放钮保持频道当前直播语义', () => {
  it('current 档位:播放钮语义为当前直播;节目名点击=导航 /live/watch/:id(015 T004 双层交互),不开面板、零 /playback/ 请求', () => {
    const { onOpenProgramme, counter, restore } = renderTile('now', 'upcoming');
    try {
      // 频道播放钮(频道语义:播放该频道当前直播,不锁具体节目)
      expect(screen.getByRole('button', { name: `播放 ${TILE_CHANNEL_TITLE} 当前直播` })).toBeVisible();

      // 015 T004:current 档节目名 = 导航观看详情页(路由元素稍后由 015 任务注册,
      // 此处断言内存路由已跳转;id = 频道 media.id),不再打开节目时段面板
      fireEvent.click(screen.getByRole('button', { name: LIVE_PROGRAMME_STATES.now.title }));
      expect(screen.getByTestId('tile-location').textContent).toBe('/live/watch/ch-tile-1');
      expect(onOpenProgramme).not.toHaveBeenCalled();
      expect(counter.counts.playback).toBe(0); // 节目名不触发播放(双层交互只导航)
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      restore();
    }
  });

  it('upcoming 档位(即将播放分区):展示下一档节目名,点击=打开详情回调(kind=upcoming),零 /playback/ 请求', () => {
    const { onOpenProgramme, counter, restore } = renderTile('now', 'upcoming', 'upcoming');
    try {
      // 频道播放钮保留(频道语义;未来节目不因此获得播放入口)
      expect(screen.getByRole('button', { name: `播放 ${TILE_CHANNEL_TITLE} 当前直播` })).toBeVisible();

      // upcoming 档位展示下一档节目名,点击仅开详情(kind=upcoming,面板无播放主操作)
      fireEvent.click(screen.getByRole('button', { name: LIVE_PROGRAMME_STATES.upcoming.title }));
      expect(onOpenProgramme).toHaveBeenCalledTimes(1);
      expect(onOpenProgramme.mock.calls[0]?.[0]).toMatchObject({
        mediaId: 'ch-tile-1',
        channelTitle: TILE_CHANNEL_TITLE,
        kind: 'upcoming',
        programme: expect.objectContaining({ key: LIVE_PROGRAMME_STATES.upcoming.key }),
      });
      expect(counter.counts.playback).toBe(0);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      restore();
    }
  });

  it('upcoming-only 频道(无当前节目):upcoming 档位展示下一档节目名,播放钮保留(频道可用即播放当前直播,FR-012),状态标注「即将播放」', () => {
    const { onOpenProgramme, counter, restore } = renderTile('none', 'upcoming', 'upcoming');
    try {
      // 无节目单/无当前节目不撤频道播放入口(可用性不由 EPG 决定)
      expect(screen.getByRole('button', { name: `播放 ${TILE_CHANNEL_TITLE} 当前直播` })).toBeVisible();
      // 状态签标注即将播放(非颜色唯一表达;存在即达标)
      expect(screen.getAllByText('即将播放').length).toBeGreaterThanOrEqual(1);
      // 下一档节目名仍只是详情入口,不播放
      fireEvent.click(screen.getByRole('button', { name: LIVE_PROGRAMME_STATES.upcoming.title }));
      expect(onOpenProgramme).toHaveBeenCalledTimes(1);
      expect(counter.counts.playback).toBe(0);
    } finally {
      restore();
    }
  });
});
