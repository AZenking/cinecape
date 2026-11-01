import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, type ReactNode, type RefObject } from 'react';
import type { Vod } from '@hmp/shared';
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

/**
 * ── 010 T047 新增映射表(下方「010 session 生命周期」describe;T048 已落地转绿)──
 *
 * 权威:docs/specs/010-online-vod/contracts/api.md §1 ProgressReply + §4 progress 行、
 * playback-state.md §1/§2/§4/§7、ui.md §2 命令泵。DTO 夹具取 @hmp/shared `Vod` 生成形状。
 *
 * | 用例                        | 契约锚点                                         | 现状基线 |
 * | --------------------------- | ------------------------------------------------ | -------- |
 * | generation 只更新 phase     | playback-state §1(seq 跨代单调)/§7(不 stop)   | 绿(T048)|
 * | 队列合并未分配号 periodic   | playback-state §1/ui.md §2(不能排重复 seq)     | 绿(T048)|
 * | 样本载荷不可变              | playback-state §1(载荷一经发送不变)            | 绿       |
 * | 2xx≠接受(stale)          | api.md §1 ProgressReply/playback-state §2       | 绿(T048)|
 * | superseded 提示态           | api.md §1/playback-state §2/ui.md §2            | 绿(T048)|
 * | pauseAndFlush 接口形态      | ui.md §2/api.md §5(精确接受游标)              | 绿(T048)|
 * | requestStop+卸载单次 stop   | ui.md §2(唯一命令;卸载兜底同命令)            | 绿       |
 * | stopOnce 接口形态           | ui.md §2(唯一 Promise)/playback-state §4       | 绿(T048)|
 *
 * T047 的局部 `PlannedProgressApi` 计划内钉面已随 T048 落地收编为正式
 * `PlaybackProgressApi` 成员(historyApplied/pauseAndFlush/stopOnce,字段名逐字),
 * 本文件不再持有局部类型占位,断言直接走实现导出面。
 * 组件/UI 面的契约钉(起播门/seek/续播降级/切档/duration_unknown)见 test/vod-resume.spec.tsx。
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

// ════════════════ 010 T047 · session 生命周期(T048 前端进度泵契约钉) ════════════════

type ProgressReplyDto = Vod.components['schemas']['ProgressReply'];

/** 合法 ProgressReply 夹具(accepted 形态;stale/superseded 场景经 overrides 收敛) */
function progressReply(overrides: Partial<ProgressReplyDto> = {}): ProgressReplyDto {
  return {
    applied: true,
    reason: 'accepted',
    historyRevision: 4,
    sessionAccepted: true,
    acceptedSampleSeq: 1,
    acceptedPositionSeconds: 5,
    acceptedGeneration: 1,
    sessionStarted: true,
    ...overrides,
  };
}

describe('010 session 生命周期 · seq 分配(T048 落地)', () => {
  it('generation 更新只更新 phase:同 session 换代不重置 seq、不发 session stop', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) return jsonResponse(progressReply());
      return new Response(null, { status: 204 });
    });
    const { rerender } = renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // 周期 seq=2
    });
    // 同 session 换 generation(服务端重建 seek/换轨):ProgressController 生命周期=session,
    // generation 只是上下文更新(playback-state §7「不能发 session stop」、§1「seq 不重置」)
    rerender(createElement(Harness, { sessionId: 'sess-1', generation: 2 }));
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    // 契约 1:generation 推进绝不补发 session stop(含 finalProgress 形态)
    expect(stopCalls()).toEqual([]);
    // 契约 2:seq 跨 generation 单调,唯一分配,不因换代归零(不得出现第二个 seq=1)
    const seqs = progressBodies().map((body) => Number(body.sampleSeq));
    expect(seqs.filter((seq) => seq === 1)).toHaveLength(1);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? 0);
    }
    // 契约 3:换代后的样本携带新 expectedGeneration(phase 更新面)
    expect(progressBodies().filter((body) => body.expectedGeneration === 2).length).toBeGreaterThanOrEqual(1);
  });

  it('有界队列合并未分配号的 periodic:在途期间多拍只保留最新周期样本,seq 全程唯一', async () => {
    let releaseStarted: ((reply: ProgressReplyDto) => void) | null = null;
    let startedSeen = false;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) {
        if (!startedSeen) {
          startedSeen = true;
          return await new Promise<Response>((resolve) => {
            releaseStarted = (reply: ProgressReplyDto): void => resolve(jsonResponse(reply));
          });
        }
        return jsonResponse(progressReply());
      }
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0); // started 在途挂起
    });
    // started 未确认期间两个周期拍:periodic 尚未分配 seq,只能合并(保留最新位置),
    // 不得排多个相同 seq(playback-state §1/ui.md §2)
    video.currentTime = 30;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    video.currentTime = 40;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(progressBodies().filter((body) => body.reason === 'periodic')).toHaveLength(0);
    // 确认 started 后 flush:仅一个合并后的周期样本
    await act(async () => {
      releaseStarted?.(progressReply());
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const bodies = progressBodies();
    // seq 全程唯一(入队即分配且不重复)
    const seqs = bodies.map((body) => Number(body.sampleSeq));
    expect(new Set(seqs).size).toBe(seqs.length);
    // periodic 合并:恰好一个,携带合并时刻最新位置
    const periodics = bodies.filter((body) => body.reason === 'periodic');
    expect(periodics).toHaveLength(1);
    expect(periodics[0]?.positionSeconds).toBe(40);
  });
});

describe('010 session 生命周期 · 2xx≠接受与载荷不变性(T047)', () => {
  it('样本载荷不可变:重试与排队期间不改写已入队样本的 seq/位置(现行为绿)', async () => {
    let startedAttempts = 0;
    let pauseCalls = 0;
    let releasePause: (() => void) | null = null;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/progress')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (body.reason === 'started') {
          startedAttempts += 1;
          if (startedAttempts === 1) {
            throw new TypeError('network down'); // 首发失败 → 同 seq/payload 重试
          }
          return jsonResponse(progressReply());
        }
        if (body.reason === 'pause') {
          pauseCalls += 1;
          if (pauseCalls === 1) {
            // 在途 pause(seq=2)挂起:期间再 pause 只能排队,载荷以入队时刻冻结
            return await new Promise<Response>((resolve) => {
              releasePause = (): void => resolve(jsonResponse(progressReply()));
            });
          }
          return jsonResponse(progressReply());
        }
        return jsonResponse(progressReply());
      }
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0); // started 首发失败
    });
    // 重试退避期间观看位置大幅前进:重试载荷不得改写(样本一经发送不可变)
    video.currentTime = 500;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600); // 500ms 退避 → 二发成功
    });
    const starts = progressBodies().filter((body) => body.reason === 'started');
    expect(starts).toHaveLength(2);
    for (const body of starts) {
      expect(body).toEqual({ sampleSeq: 1, expectedGeneration: 1, positionSeconds: 5, reason: 'started' });
    }
    expect(acked()).toBe(true);
    // 排队样本同样冻结:started 已确认,in-flight pause(seq=2,pos=100)挂起期间再 pause
    video.currentTime = 100;
    await act(async () => {
      video.dispatchEvent(new Event('pause'));
      await vi.advanceTimersByTimeAsync(0);
    });
    video.currentTime = 120;
    await act(async () => {
      video.dispatchEvent(new Event('pause'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // 噪声位置不得渗入任何已入队载荷
    video.currentTime = 999;
    await act(async () => {
      releasePause?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const pauses = progressBodies().filter((body) => body.reason === 'pause');
    expect(pauses).toEqual([
      { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 100, reason: 'pause' },
      { sampleSeq: 3, expectedGeneration: 1, positionSeconds: 120, reason: 'pause' },
    ]);
    expect(progressBodies().some((body) => body.positionSeconds === 999)).toBe(false);
  });

  it('2xx≠接受:HTTP 200 + stale 形态(sessionAccepted=false)不推进确认游标,按下发游标恢复', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) {
        // stale:seq 低于服务端最新 → sessionAccepted=false,返回最后会话接受游标供恢复
        return jsonResponse(
          progressReply({
            applied: false,
            reason: 'stale_sample',
            historyRevision: null,
            sessionAccepted: false,
            acceptedSampleSeq: 7,
            acceptedPositionSeconds: 42,
            acceptedGeneration: 1,
            sessionStarted: false,
          }),
        );
      }
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // 确认游标不推进:startedAcked 依据 sessionAccepted+sessionStarted(playback-state §2),
    // 2xx 本身不等于接受(privateFetch<void> 语义退役)
    expect(acked()).toBe(false);
    expect(progress?.canSeek).toBe(false);
    // 恢复:后续样本必须越过服务端最后接受游标(acceptedSampleSeq=7),不得原 seq 原载荷撞同一堵墙
    video.currentTime = 45;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const periodics = progressBodies().filter((body) => body.reason === 'periodic');
    expect(periodics.length).toBeGreaterThanOrEqual(1);
    for (const body of periodics) {
      expect(Number(body.sampleSeq)).toBeGreaterThan(7);
    }
  });

  it('superseded(sessionAccepted=true/applied=false):按接受处理不重发 started,暴露历史未应用状态供提示', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) {
        return jsonResponse(
          progressReply({
            applied: false,
            reason: 'superseded',
            historyRevision: null,
            sessionAccepted: true,
            sessionStarted: true,
          }),
        );
      }
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // sessionAccepted=true:投递已接受,不得无限重发 started(playback-state §2)
    expect(progressBodies().filter((body) => body.reason === 'started')).toHaveLength(1);
    expect(acked()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // 后继 periodic 同样按接受处理
    });
    expect(progressBodies().filter((body) => body.reason === 'periodic')).toHaveLength(1);
    // applied=false:历史未由本会话写入 —— 必须暴露 historyApplied=false 供 UI 呈现
    // 「历史已由其他设备更新」提示,绝不显示「已同步到个人历史」(ui.md §2);
    // 状态面属 PlaybackProgressApi(已收编),PlayerView 渲染面由 vod-resume.spec.tsx 钉。
    expect(progress?.historyApplied).toBe(false);
  });
});

describe('010 session 生命周期 · awaitable 命令泵接口(T048 落地)', () => {
  it('pauseAndFlush:awaitable,决议为精确接受 checkpoint(api.md §5 carry 输入)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/progress')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        // 服务端按收到的样本下发接受游标
        return jsonResponse(
          progressReply({ acceptedSampleSeq: Number(body.sampleSeq), acceptedPositionSeconds: Number(body.positionSeconds) }),
        );
      }
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acked()).toBe(true);
    video.currentTime = 33;
    // 接口形态:函数存在、返回 Promise、决议为该 pause 样本的服务端接受游标
    expect(typeof progress?.pauseAndFlush).toBe('function');
    const checkpoint = await progress?.pauseAndFlush();
    expect(checkpoint).toBeDefined();
    expect(checkpoint).toEqual({
      sessionAccepted: true,
      acceptedSampleSeq: 2,
      acceptedPositionSeconds: 33,
      acceptedGeneration: 1,
    });
    // pause 已立即上报且按序确认(不与其他样本并流)
    const pauses = progressBodies().filter((body) => body.reason === 'pause');
    expect(pauses).toEqual([{ sampleSeq: 2, expectedGeneration: 1, positionSeconds: 33, reason: 'pause' }]);
  });

  it('停止唯一性(现行为绿钉面):requestStop 仅标记不直接发网络;卸载兜底恰发一次 final stop', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) return jsonResponse(progressReply());
      return new Response(null, { status: 204 });
    });
    const { unmount } = renderHarness('sess-1', 1);
    video.currentTime = 120;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acked()).toBe(true);
    // requestStop:标记停止(后续样本不再入队),本身不发 stop 网络——stop 由卸载兜底统一 flush
    progress?.requestStop();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stopCalls()).toEqual([]);
    video.currentTime = 130;
    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    // 卸载兜底复用同一命令语义:恰一次 final stop,不重复、不伪造多份 final
    expect(stopCalls()).toEqual([
      { finalProgress: { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 130 } },
    ]);
  });

  it('stopOnce:awaitable 幂等,唯一 Promise 恰一次 /stop(ui.md §2)', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) return jsonResponse(progressReply());
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    video.currentTime = 25;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acked()).toBe(true);
    expect(typeof progress?.stopOnce).toBe('function');
    // 唯一 Promise:并发两次调用复用同一命令(不可变 final 载荷,不生成第二份 final)
    const first = progress?.stopOnce();
    const second = progress?.stopOnce();
    expect(second).toBe(first);
    await first;
    await second;
    expect(stopCalls()).toHaveLength(1);
    expect(stopCalls()[0]).toEqual({
      finalProgress: { sampleSeq: 2, expectedGeneration: 1, positionSeconds: 25 },
    });
  });
});

// ════════════════ 010 T064 · 泵增量(finish 队列与 playing 观测;转绿钉面) ════════════════

/**
 * 权威:docs/specs/010-online-vod/contracts/api.md §4(finish 行:cause=natural_end/
 * operationKey UUID/唯一 Promise 不可变载荷)、§7 I4(playing 观测是 readyAt+60s
 * 未起播期限的唯一客户端解除通道)、ui.md §2(finish 与 stopOnce 同拥唯一 Promise,
 * finish 已发起后卸载不补 final/stop)。行为级契约(回执→倒计时/重试/取消/切档)
 * 见 test/vod-autoplay.spec.tsx;此处仅钉泵增量本身的单元回归面。
 */
describe('010 T064 · 泵增量(finish 队列与 playing 观测)', () => {
  function observationBodies(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith('/observations'))
      .map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
  }

  function finishBodies(): Array<Record<string, unknown>> {
    return fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith('/finish'))
      .map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('真实 playing 上报 event=playing 观测(I4 期限解除通道);未实际 playing 零伪造', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) return jsonResponse(progressReply());
      return new Response(null, { status: 204 });
    });
    renderHarness('sess-1', 1);
    // 未实际 playing:静置周期拍不伪造 playing 观测(D2 拒绝期零伪造的泵语义)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(observationBodies()).toHaveLength(0);
    // 手势恢复/正常播放:真实 playing 事件 → 恰一次 event=playing 观测
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    const playing = observationBodies().filter((body) => body.event === 'playing');
    expect(playing).toHaveLength(1);
    expect(playing[0]).toMatchObject({ event: 'playing', expectedGeneration: 1, positionSeconds: 5 });
    // 后续 pause/周期样本不追加 playing 观测(playing 观测只由真实 playing 事件驱动)
    await act(async () => {
      video.dispatchEvent(new Event('pause'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(observationBodies().filter((body) => body.event === 'playing')).toHaveLength(1);
  });

  it('自然结束:唯一 finish(cause=natural_end/UUID key/不可变载荷),重复 ended 幂等;回执后卸载零补 stop', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/progress')) return jsonResponse(progressReply());
      return new Response(null, { status: 204 });
    });
    const { unmount } = renderHarness('sess-1', 1);
    video.currentTime = 5;
    await act(async () => {
      video.dispatchEvent(new Event('playing'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(acked()).toBe(true);
    // 自然结束 → 唯一 finish;final seq 恰一次分配(不越过已确认 started 的 seq=1)
    video.currentTime = 3600;
    await act(async () => {
      video.dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(finishBodies()).toHaveLength(1);
    const finish = finishBodies()[0];
    expect(finish?.cause).toBe('natural_end');
    expect(UUID_PATTERN.test(String(finish?.operationKey))).toBe(true);
    expect(finish?.finalProgress).toEqual({
      sampleSeq: 2,
      expectedGeneration: 1,
      positionSeconds: 3600,
    });
    // 重复 ended 幂等:不重复 finish、不造第二 final(spec 场景 4)
    await act(async () => {
      video.dispatchEvent(new Event('ended'));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(finishBodies()).toHaveLength(1);
    // 回执已取得:卸载不补 final/stop(ui.md §2 一次 final;E2 泵语义)
    await act(async () => {
      unmount();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(finishBodies()).toHaveLength(1);
    expect(stopCalls()).toHaveLength(0);
  });
});
