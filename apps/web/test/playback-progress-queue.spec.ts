import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode, type RefObject } from 'react';
import { usePlaybackProgress, type PlaybackProgressApi } from '../src/features/playback/use-playback-progress';

/**
 * T095(005 US4 前端单元测试;tasks.md 路径 test/playback-progress-queue.test.ts,
 * 按仓库 vitest include 规则落地为 *.spec.ts)—— 进度上报队列:
 *
 * - 首次实际 playing 上报 reason=started;未收到 ACK 前按同 sampleSeq/payload 重试,
 *   周期/暂停样本排队不越过首次样本;
 * - 每 10 秒周期与暂停立即上报;
 * - ACK 前禁用/排队用户 seek 与会重建输出的音轨切换,确认后再执行;
 * - 未确认即停止:发送空 stop(不伪造 final);
 * - 断网:保留最后成功保存值并提示同步失败;恢复后以原 seq/payload 重试;
 * - 换档/退出(sessionId 变化):废弃在途请求,新会话 seq 重新开始。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 视频元素桩:currentTime 可控,事件经 dispatch 派发 */
let video: HTMLVideoElement;

let fetchMock: Mock;
let progress: PlaybackProgressApi | null;

function Harness({ sessionId, generation }: { readonly sessionId: string; readonly generation: number }): ReactNode {
  const ref: RefObject<HTMLVideoElement | null> = { current: video };
  progress = usePlaybackProgress({
    sessionId,
    generation,
    videoRef: ref,
  });
  return createElement(
    'span',
    null,
    createElement('span', { 'data-testid': 'acked' }, String(progress.startedAcked)),
    createElement('span', { 'data-testid': 'sync-failed' }, String(progress.syncFailed)),
  );
}

function renderHarness(sessionId: string, generation: number) {
  return render(createElement(Harness, { sessionId, generation }));
}

function progressBodies(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith('/progress'))
    .map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
}

function stopCalls(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith('/stop'))
    .map((call) => JSON.parse(String(call[1]?.body ?? '{}')) as Record<string, unknown>);
}

function acked(): boolean {
  return document.querySelector('[data-testid="acked"]')?.textContent === 'true';
}

function syncFailed(): boolean {
  return document.querySelector('[data-testid="sync-failed"]')?.textContent === 'true';
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  video = document.createElement('video');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('T095 · 播放进度上报队列', () => {
  it('首次 playing 上报 started;未 ACK 前按同 seq/payload 重试;确认后解除 seek/音轨切换禁用', async () => {
    let startedCalls = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) {
        startedCalls += 1;
        if (startedCalls <= 2) {
          throw new TypeError('network down'); // 断网:同 seq/payload 重试
        }
        return jsonResponse({});
      }
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // 两次失败(0ms 立即 + 500ms 退避 + 1000ms 退避)→ 第三次成功
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(acked()).toBe(true);
    const starts = progressBodies().filter((body) => body.reason === 'started');
    expect(starts.length).toBe(3);
    for (const body of starts) {
      // 同 sampleSeq/payload 重试
      expect(body).toEqual({ sampleSeq: 1, expectedGeneration: 1, positionSeconds: 5, reason: 'started' });
    }
    // 恢复后同步失败提示清除
    expect(syncFailed()).toBe(false);
    // ACK 后:seek 与重建输出的音轨切换放行
    expect(progress?.canSeek).toBe(true);
    expect(progress?.canSwitchTracks).toBe(true);
  });

  it('ACK 前 pause 样本排队不越过首次样本;确认后按序上报;10 秒周期推进 seq', async () => {
    let gate = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) {
        gate += 1;
        if (gate === 1) {
          // 首个 started 挂起:期间 pause/periodic 只能排队
          await new Promise((resolve) => setTimeout(resolve, 50));
          return jsonResponse({});
        }
        return jsonResponse({});
      }
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 10;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(20); // started 在途
    });
    // 未确认时暂停:入队,不上报
    await act(async () => {
      video.dispatchEvent(new Event('pause'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(progressBodies().filter((body) => body.reason === 'pause')).toHaveLength(0);
    // 确认后:排队的 pause 按序 flush(seq=2),随后 10 秒周期 seq=3
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(acked()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const bodies = progressBodies();
    const pauseBodies = bodies.filter((body) => body.reason === 'pause');
    const periodicBodies = bodies.filter((body) => body.reason === 'periodic');
    expect(pauseBodies.length).toBe(1);
    expect(pauseBodies[0]?.sampleSeq).toBe(2);
    expect(periodicBodies.length).toBe(1);
    expect(periodicBodies[0]?.sampleSeq).toBe(3);
    // seq 单调:started=1 → pause=2 → periodic=3
    expect(bodies.map((body) => body.sampleSeq)).toEqual([1, 2, 3]);
  });

  it('ACK 前 seeking 回弹(禁用);卸载:未确认 → 空 stop(不伪造 final)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) throw new TypeError('network down');
      return new Response(null, { status: 204 });
    });
    const { unmount } = renderHarness('sess-1', 1);
    video.currentTime = 10;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // ACK 前 seek:回弹到确认前位置;音轨切换禁用
    await act(async () => {
      video.currentTime = 200;
      video.dispatchEvent(new Event('seeking'));
    });
    expect(video.currentTime).toBe(10);
    expect(progress?.canSeek).toBe(false);
    expect(progress?.canSwitchTracks).toBe(false);
    // 未确认即卸载:空 stop(不伪造 final;未保存提示由 onUnsavedProgress 承担)
    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stopCalls()).toEqual([{}]);
  });

  it('已确认后卸载:携带 finalProgress(sampleSeq 单调推进)停止', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) return jsonResponse({});
      return new Response(null, { status: 204 });
    });
    const { unmount } = renderHarness('sess-1', 1);
    video.currentTime = 120;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acked()).toBe(true);
    await act(async () => {
      video.currentTime = 130;
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stopCalls()).toEqual([
      { finalProgress: { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 130 } },
    ]);
  });

  it('断网保留最后成功值并提示同步失败;恢复后以原 seq/payload 重试;换档废弃在途', async () => {
    let periodicFail = true;
    const attempted: Array<Record<string, unknown>> = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/progress')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        attempted.push(body);
        if (periodicFail && body.reason === 'periodic') {
          throw new TypeError('offline');
        }
        return jsonResponse({});
      }
      return new Response(null, { status: 204 });
    });
    const { rerender } = renderHarness('sess-1', 1);
    video.currentTime = 30;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acked()).toBe(true);
    // 周期样本失败 → 提示同步失败(保留最后成功值 30)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(syncFailed()).toBe(true);
    // 恢复网络 → 原 seq/payload(2,30)重试成功 → 提示清除
    periodicFail = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_600);
    });
    expect(syncFailed()).toBe(false);
    const periodics = attempted.filter((body) => body.reason === 'periodic');
    expect(periodics.length).toBeGreaterThanOrEqual(2);
    for (const body of periodics) {
      expect(body.sampleSeq).toBe(2);
      expect(body.positionSeconds).toBe(30);
    }
    // 换档(sessionId 变化):重置 —— 新会话从 seq=1 重新开始,不向旧会话回写
    rerender(createElement(Harness, { sessionId: 'sess-2', generation: 2 }));
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    const sess2Bodies = attempted.filter((body) => body.expectedGeneration === 2);
    expect(sess2Bodies.length).toBeGreaterThanOrEqual(1);
    expect(sess2Bodies[0]?.sampleSeq).toBe(1);
  });
});
