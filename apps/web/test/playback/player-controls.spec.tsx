import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { PlayerControls } from '../../src/features/playback/player-controls';

/**
 * 控制栏自动隐藏 / 悬浮唤回(产品回归:控制栏隐藏后必须能再次唤出)。
 *
 * 真实浏览器里媒体起播后控制栏 3 秒自动隐藏;隐藏时控制栏自身是
 * pointer-events-none,所以唤出监听必须挂在**播放器容器**上 —— 若只挂在栏内,
 * 隐藏后鼠标移到画面不会有任何事件,表现为「控制栏再也出不来」。
 * jsdom 无媒体实现,这里用可写 paused 属性 + play 事件模拟播放态。
 */

function Harness(): ReactNode {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  return (
    <div data-testid="player-host">
      <video ref={videoRef} data-testid="fake-video" />
      <PlayerControls videoRef={videoRef} isLive canSeek={false} />
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
});