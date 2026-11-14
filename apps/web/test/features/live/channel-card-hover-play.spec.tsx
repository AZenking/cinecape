import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import type * as actionCoordinatorModule from '../../../src/app/action-coordinator';
import { ChannelTile } from '../../../src/features/live/components/ChannelTile';
import { buildChannelRow, LIVE_REDESIGN_NOW_ISO } from '../../fixtures/live-redesign-fixtures';
import { LIVE_SESSION_STATES, renderLiveWorld } from '../../helpers/live-world';

/**
 * 015 T007(US1,测试先行)· ChannelTile Hover 一键起播(FR-005、SC-001;
 * research.md R5、contracts/ui-layout.md §1.2 第 3 条——消灭二级详情阻断):
 *
 * - 悬停/键盘聚焦瓦片时,底板正中央浮现 `▶ 播放` 按钮(aria-label=播放 <频道名>;
 *   jsdom 不计算 hover/focus-within 样式,浮现契约按 class 静态钉面:
 *   group-hover:opacity-100 + group-focus-within:opacity-100,瓦片为 group 容器);
 * - 点击该按钮:直接经 usePlayAction 发起播放(mock 面断言 play 以正确
 *   mediaId/title/startMode 被调用;唯一播放管线,组件不自建第二条);
 * - 点击播放按钮不打开静态二级详情面板:onOpenProgramme 零调用、零弹层;
 * - 点击文字信息区(当前节目名):导航 /live/watch/:channelId(内存路由探针,
 *   live-upcoming-ended-no-play.spec 的 TileLocationProbe 同款),同样零播放、零面板。
 *
 * 数据:T005 015 规范频道集首频道「星光影城」(movie 组,current=星际回响);
 * 会话:游客(公共浏览;播放行为不因会话分流,统一由 ActionCoordinator/统一入口承担)。
 */

/**
 * usePlayAction 动作面 mock:精确断言 play() 入参(vi.mock 工厂懒执行,mock 前缀变量可在工厂内引用)。
 * mock 落在 app/action-coordinator 的导出面(use-play-action 仅 re-export 该消费面):
 * PlayButton/usePlayAction 两条消费路径同源改写,PlayButton 本体保持真件。
 */
const mockPlay = vi.fn();

vi.mock('../../../src/app/action-coordinator', async (importOriginal) => {
  const actual = await importOriginal<typeof actionCoordinatorModule>();
  return {
    ...actual,
    usePlayAction: () => ({ play: mockPlay, close: vi.fn(), playback: null }),
  };
});

const TILE_ROW = buildChannelRow({
  id: 'b0000000-0000-4000-8000-000000000001',
  title: '星光影城',
  groupKey: 'movie',
  groupLabel: '电影',
  current: { title: '星际回响', startsAtMinutes: -20, endsAtMinutes: 40 },
  next: { title: '午夜场:雾都疑云', startsAtMinutes: 40, endsAtMinutes: 100 },
});

/** 内存路由探针:断言文字信息区导航(renderLiveWorld 无条件挂载,导航只改内存 location) */
function TileLocationProbe(): ReactNode {
  const location = useLocation();
  return <span data-testid="tile-location">{location.pathname}</span>;
}

function renderTile(): { onOpenProgramme: ReturnType<typeof vi.fn>; restore: () => void } {
  const onOpenProgramme = vi.fn();
  const view = renderLiveWorld(
    <>
      <ChannelTile
        row={TILE_ROW}
        slot="current"
        nowIso={LIVE_REDESIGN_NOW_ISO}
        onOpenProgramme={onOpenProgramme}
        onRequireAuth={vi.fn()}
      />
      <TileLocationProbe />
    </>,
    {
      session: LIVE_SESSION_STATES.guest,
      initialEntries: ['/live'],
    },
  );
  return { onOpenProgramme, restore: view.restore };
}

beforeEach(() => {
  mockPlay.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('T007 · 频道卡 Hover 一键起播(FR-005;R5 双层交互)', () => {
  it('整块 16:9 底板即播放入口(无可见按钮/图标),aria-label=播放 <频道名>', () => {
    const { restore } = renderTile();
    try {
      const article = screen.getByRole('article', { name: '频道 星光影城' });
      expect(article.className).toContain('group');

      // 播放入口 = 覆盖整块底板的透明热区:无图标/无可见按钮样式,
      // 键盘可聚焦,点击/回车直接起播
      const playTarget = screen.getByRole('button', { name: '播放 星光影城' });
      expect(playTarget.className).toContain('absolute inset-0');
      expect(playTarget.className).not.toContain('bg-accent/80');
      expect(playTarget.querySelector('svg')).toBeNull();
      expect(playTarget).toBeEnabled();

      // 悬停/聚焦模拟:触发事件路径(样式计算归浏览器,不在此断言)
      fireEvent.mouseEnter(article);
      fireEvent.focus(playTarget);
      expect(screen.getByRole('button', { name: '播放 星光影城' })).toBeEnabled();
    } finally {
      restore();
    }
  });

  it('点击中央播放按钮:play() 以正确 mediaId/title/startMode 调用;不打开详情面板、不导航、不发起第二请求', () => {
    const { onOpenProgramme, restore } = renderTile();
    try {
      fireEvent.click(screen.getByRole('button', { name: '播放 星光影城' }));

      expect(mockPlay).toHaveBeenCalledTimes(1);
      expect(mockPlay.mock.calls[0]?.[0]).toEqual({
        mediaId: TILE_ROW.media.id,
        title: '星光影城',
        startMode: 'beginning',
        // 播放面标题栏「logo + 名称」经由 posterRef(仅本地展示,不进请求体)
        posterRef: TILE_ROW.media.posterRef,
      });
      // 消灭二级详情阻断:不弹静态面板
      expect(onOpenProgramme).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
      // 不导航(信息区导航与播放入口互不影响)
      expect(screen.getByTestId('tile-location').textContent).toBe('/live');
    } finally {
      restore();
    }
  });

  it('点击文字信息区(当前节目名):上报宿主(kind=current),瓦片自身不导航、不播放', () => {
    const { onOpenProgramme, restore } = renderTile();
    try {
      fireEvent.click(screen.getByRole('button', { name: '星际回响' }));

      expect(onOpenProgramme).toHaveBeenCalledWith(
        expect.objectContaining({ mediaId: TILE_ROW.media.id, kind: 'current' }),
      );
      expect(screen.getByTestId('tile-location').textContent).toBe('/live');
      expect(mockPlay).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      restore();
    }
  });

  it('播放入口收敛为中央悬浮钮(右下常驻播放/收藏钮已按产品要求移除)', () => {
    const { restore } = renderTile();
    try {
      expect(screen.getByRole('button', { name: '播放 星光影城' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: '播放 星光影城 当前直播' })).toBeNull();
      expect(screen.queryByRole('button', { name: '收藏 星光影城' })).toBeNull();
    } finally {
      restore();
    }
  });
});
