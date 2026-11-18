import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ActionCoordinator } from '../../../src/app/action-coordinator';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { ChannelTile } from '../../../src/features/live/components/ChannelTile';
import {
  LIVE_REDESIGN_NOW_ISO,
  LIVE_REDESIGN_TIMEZONE,
  buildChannelRow,
} from '../../fixtures/live-redesign-fixtures';
import { LIVE_SESSION_STATES, renderLiveWorld } from '../../helpers/live-world';

/**
 * 卡面进度条(恢复 016 T010 行为)。
 *
 * - 正在直播卡显示「节目播放进度」progressbar,值来自服务端快照 now 与节目时间窗;
 * - 即将播放卡与无节目卡不显示卡面进度(current=null 不臆造进度)。
 */

const CURRENT_ROW = buildChannelRow({
  id: 'b0000000-0000-4000-8000-000000000020',
  title: '进度测试台',
  groupKey: 'movie',
  groupLabel: '电影',
  current: { title: '当前节目', startsAtMinutes: -20, endsAtMinutes: 40 },
  next: { title: '下一档节目', startsAtMinutes: 40, endsAtMinutes: 100 },
});

const NO_CURRENT_ROW = buildChannelRow({
  id: 'b0000000-0000-4000-8000-000000000021',
  title: '无节目台',
  groupKey: 'movie',
  groupLabel: '电影',
  current: null,
  next: null,
});

function renderTile(row: typeof CURRENT_ROW, slot: 'current' | 'upcoming'): void {
  renderLiveWorld(
    <ChannelTile
      row={row}
      slot={slot}
      nowIso={LIVE_REDESIGN_NOW_ISO}
      timezone={LIVE_REDESIGN_TIMEZONE}
      onOpenProgramme={vi.fn()}
    />,
    {
      session: LIVE_SESSION_STATES.authedWithProfile,
      initialEntries: ['/live'],
      decorate: (ui: ReactNode): ReactNode => (
        <SettingsAccessProvider>
          <ActionCoordinator>{ui}</ActionCoordinator>
        </SettingsAccessProvider>
      ),
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(LIVE_REDESIGN_NOW_ISO));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ChannelTile · 卡面进度条', () => {
  it('正在直播卡显示当前节目进度(20/60 ≈ 33%)', () => {
    renderTile(CURRENT_ROW, 'current');
    const progress = screen.getByRole('progressbar', { name: '节目播放进度' });
    expect(progress.getAttribute('aria-valuenow')).toBe('33');
  });

  it('即将播放卡不显示卡面进度', () => {
    renderTile(CURRENT_ROW, 'upcoming');
    expect(screen.queryByRole('progressbar', { name: '节目播放进度' })).toBeNull();
  });

  it('无节目卡不显示卡面进度', () => {
    renderTile(NO_CURRENT_ROW, 'current');
    expect(screen.queryByRole('progressbar', { name: '节目播放进度' })).toBeNull();
  });
});