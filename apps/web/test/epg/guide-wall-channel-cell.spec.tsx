import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GuideWindowDto } from '@hmp/shared';
import { GuideWall } from '../../src/features/epg/GuideWall';

/**
 * 频道列展示契约(2026-11-12 产品变更):
 * - 列内只显示台标(logo 接口),不显示频道名文本;
 * - 频道名由 Tooltip 承载(悬浮/聚焦出现),可访问名仍为「播放 {频道} 当前直播」;
 * - 点击整格 = 播放该频道当前直播(不再单列直播按钮)。
 */

function media(id: string, title: string, posterRef: string | null) {
  return {
    id,
    type: 'channel' as const,
    title,
    description: null,
    posterRef,
    contentLevel: 0,
    availability: 'available' as const,
  };
}

const DATA: GuideWindowDto = {
  date: '2026-11-12',
  timezone: 'Asia/Shanghai',
  now: '2026-11-12T09:00:00.000Z',
  allowedDates: ['2026-11-12'],
  from: '2026-11-11T16:00:00.000Z',
  to: '2026-11-12T16:00:00.000Z',
  page: 1,
  pageSize: 20,
  totalChannels: 2,
  catalogRevision: 1,
  channels: [
    {
      media: media('ch-1', '例牌新闻台', 'logo-ref-1'),
      programmes: [
        {
          key: 'pg-1',
          title: '早间新闻',
          description: null,
          startsAt: '2026-11-12T01:00:00.000Z',
          endsAt: '2026-11-12T02:00:00.000Z',
        },
      ],
    },
    { media: media('ch-2', '例牌体育台', null), programmes: [] },
  ],
} as unknown as GuideWindowDto;

function renderWall() {
  const onPlayChannel = vi.fn();
  render(
    <GuideWall
      data={DATA}
      focusSignal={0}
      selectedKey={null}
      onSelectProgramme={vi.fn()}
      onPlayChannel={onPlayChannel}
    />,
  );
  return { onPlayChannel };
}

afterEach(() => {
  cleanup();
});

describe('GuideWall · 频道列只展示台标 + Tooltip 名称', () => {
  it('列内渲染 logo 接口台标,不渲染频道名文本', () => {
    renderWall();
    const cell = screen.getByRole('button', { name: '播放 例牌新闻台 当前直播' });
    const img = cell.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('/api/public/media/logos/');
    // 频道名不再作为可见文本
    expect(screen.queryByText('例牌新闻台')).toBeNull();
  });

  it('无 posterRef 的频道回退首字,同样不显示全名', () => {
    renderWall();
    const cell = screen.getByRole('button', { name: '播放 例牌体育台 当前直播' });
    expect(cell.querySelector('img')).toBeNull();
    expect(cell.textContent).toContain('例');
    expect(screen.queryByText('例牌体育台')).toBeNull();
  });

  it('频道格挂在 Tooltip 触发器上(名称走悬浮提示,不占列宽)', () => {
    renderWall();
    const cell = screen.getByRole('button', { name: '播放 例牌新闻台 当前直播' });
    // Tooltip.Trigger 包裹整格(sticky 在触发器上,保证横滚时列不漂移)
    const trigger = cell.closest('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.className).toContain('sticky');
    // 名称文案在 Tooltip.Content(仅在打开时挂载,这里断言触发器已接线)
    expect(trigger?.contains(cell)).toBe(true);
  });

  it('点击整格 = 播放该频道当前直播', () => {
    const { onPlayChannel } = renderWall();
    fireEvent.click(screen.getByRole('button', { name: '播放 例牌新闻台 当前直播' }));
    expect(onPlayChannel).toHaveBeenCalledWith('ch-1', '例牌新闻台');
  });
});