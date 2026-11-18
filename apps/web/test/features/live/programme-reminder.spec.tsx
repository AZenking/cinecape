import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
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
 * 即将播放卡的开播提醒(2026-11-18 设计稿铃铛入口)。
 *
 * 行为契约:
 * - 铃铛只出现在 upcoming 卡;点击后 aria-pressed/可读名翻转,并写入 localStorage
 *   (页面刷新/返回首页后仍保留预约);
 * - 再次点击取消并清除存储;
 * - current 卡不渲染铃铛(正在直播没有「预约开播」语义)。
 */

const UPCOMING_ROW = buildChannelRow({
  id: 'b0000000-0000-4000-8000-000000000010',
  title: '提醒测试台',
  groupKey: 'movie',
  groupLabel: '电影',
  current: { title: '当前节目', startsAtMinutes: -20, endsAtMinutes: 10 },
  next: { title: '下一档节目', startsAtMinutes: 30, endsAtMinutes: 90 },
});

function renderTile(slot: 'current' | 'upcoming'): void {
  renderLiveWorld(
    <ChannelTile
      row={UPCOMING_ROW}
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
  window.localStorage.clear();
});

function readStoredKeys(): readonly string[] {
  const raw = window.localStorage.getItem('hmp.live.programme-reminders');
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('即将播放卡 · 开播提醒', () => {
  it('点击铃铛预约:aria-pressed 翻转 + 持久化;再次点击取消', () => {
    renderTile('upcoming');
    const bell = screen.getByRole('button', { name: '预约《下一档节目》开播提醒' });
    expect(bell.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(bell);
    const active = screen.getByRole('button', { name: '取消《下一档节目》开播提醒' });
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(readStoredKeys()).toContain(UPCOMING_ROW.next?.key);

    fireEvent.click(active);
    expect(screen.getByRole('button', { name: '预约《下一档节目》开播提醒' })).toBeTruthy();
    expect(readStoredKeys()).not.toContain(UPCOMING_ROW.next?.key);
  });

  it('正在直播卡不渲染开播提醒铃铛', () => {
    renderTile('current');
    expect(screen.queryByRole('button', { name: /开播提醒/ })).toBeNull();
  });
});