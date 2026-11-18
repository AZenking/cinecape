import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { PlayerControls, type PlayerLiveWindow } from '../../src/features/playback/player-controls';

/**
 * 控制栏自动隐藏 / 悬浮唤回(产品回归:控制栏隐藏后必须能再次唤出)。
 *
 * 真实浏览器里媒体起播后控制栏 3 秒自动隐藏;隐藏时控制栏自身是
 * pointer-events-none,所以唤出监听必须挂在**播放器容器**上 —— 若只挂在栏内,
 * 隐藏后鼠标移到画面不会有任何事件,表现为「控制栏再也出不来」。
 * jsdom 无媒体实现,这里用可写 paused 属性 + play 事件模拟播放态。
 */

function Harness({
  isLive = true,
  liveWindow = null,
  keepVisible = false,
}: {
  readonly isLive?: boolean;
  readonly liveWindow?: PlayerLiveWindow | null;
  readonly keepVisible?: boolean;
}): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  return (
    <div data-testid="player-host">
      <video ref={videoRef} data-testid="fake-video" />
      <PlayerControls
        videoRef={videoRef}
        isLive={isLive}
        canSeek={!isLive}
        liveWindow={liveWindow}
        keepVisible={keepVisible}
      />
    </div>
  );
}

/** 标记媒体处于播放态(jsdom 的 paused 恒为 true,需按实例覆写) */
function markPlaying(): HTMLVideoElement {
  const video = screen.getByTestId('fake-video') as HTMLVideoElement;
  Object.defineProperty(video, 'paused', { configurable: true, get: () => false });
  fireEvent(video, new Event('play'));
  return video;
}

function controlsClass(): string {
  return screen.getByTestId('player-controls').className;
}

describe('PlayerControls · 自动隐藏与悬浮唤回', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('播放中 3 秒无操作隐藏;鼠标在画面上移动即重新唤出', () => {
    render(<Harness />);
    markPlaying();

    // 初始可见
    expect(controlsClass()).toContain('opacity-100');

    // 3 秒后自动隐藏(隐藏态同时 pointer-events-none,不拦截画面点击)
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(controlsClass()).toContain('opacity-0');
    expect(controlsClass()).toContain('pointer-events-none');

    // 关键回归:鼠标在播放器容器(画面)上移动 —— 必须重新出现
    act(() => {
      fireEvent.pointerMove(screen.getByTestId('player-host'));
    });
    expect(controlsClass()).toContain('opacity-100');
  });

  it('指针停在控制栏上不自动隐藏(避免正要点就消失)', () => {
    render(<Harness />);
    markPlaying();
    const bar = screen.getByTestId('player-controls');

    fireEvent.pointerEnter(bar);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(controlsClass()).toContain('opacity-100');

    // 指针离开后恢复自动隐藏
    fireEvent.pointerLeave(bar);
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(controlsClass()).toContain('opacity-0');
  });

  it('暂停态保持可见(不隐藏静止画面上的控件)', () => {
    render(<Harness />);
    // 不触发 play:媒体保持 paused=true
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(controlsClass()).toContain('opacity-100');
  });

  it('keepVisible(播放设置面板打开):强制可见且不自动隐藏;关闭后恢复 3 秒计时', () => {
    const { rerender } = render(<Harness />);
    markPlaying();
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(controlsClass()).toContain('opacity-0');

    // 打开面板:立刻强制可见,且超时后仍不隐藏(触发钮是面板锚点)
    rerender(<Harness keepVisible />);
    expect(controlsClass()).toContain('opacity-100');
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(controlsClass()).toContain('opacity-100');

    // 面板关闭:恢复自动隐藏
    rerender(<Harness keepVisible={false} />);
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(controlsClass()).toContain('opacity-0');
  });
});
describe('PlayerControls · 两行控制栏(019 操作台 mock)', () => {
  it('直播:第 1 行呈现节目起止时间 + 只读节目进度;第 2 行中央为 LIVE Chip', () => {
    render(<Harness isLive liveWindow={{ startLabel: '20:00', endLabel: '21:00', progress: 42 }} />);
    expect(screen.getByText('20:00')).toBeInTheDocument();
    expect(screen.getByText('21:00')).toBeInTheDocument();
    expect(screen.getByLabelText('节目进度')).toBeInTheDocument();
    expect(screen.getByText('LIVE · 正在直播')).toBeInTheDocument();
  });

  it('直播无节目元数据:第 1 行整行隐藏(不以假数据占位)', () => {
    render(<Harness isLive liveWindow={null} />);
    expect(screen.queryByLabelText('节目进度')).toBeNull();
    expect(screen.queryByText('20:00')).toBeNull();
    expect(screen.getByText('LIVE · 正在直播')).toBeInTheDocument();
  });

  it('点播:第 1 行两端为当前时间与总时长,中央承载播放/暂停,不渲染 LIVE Chip', () => {
    render(<Harness isLive={false} />);
    const video = screen.getByTestId('fake-video') as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { configurable: true, get: () => 3600 });
    fireEvent(video, new Event('durationchange'));
    expect(screen.getByText('00:00')).toBeInTheDocument();
    expect(screen.getByText('1:00:00')).toBeInTheDocument();
    expect(screen.getByLabelText('播放进度')).toBeInTheDocument();
    expect(screen.queryByText('LIVE · 正在直播')).toBeNull();
    expect(screen.getByRole('button', { name: '播放' })).toBeInTheDocument();
  });
});
