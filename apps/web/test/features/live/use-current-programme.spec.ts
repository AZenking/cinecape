import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { RenderHookResult } from '@testing-library/react';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { buildProgramme, LIVE_REDESIGN_NOW_ISO } from '../../fixtures/live-redesign-fixtures';
import {
  useCurrentProgramme,
  type UseCurrentProgrammeOptions,
  type UseCurrentProgrammeResult,
} from '../../../src/features/live/hooks/use-current-programme';

/**
 * 016 T006(测试先行;User Story 1 前端全链路)· useCurrentProgramme 智能事件定时器单测。
 *
 * 权威:docs/specs/016-multi-source-live-epg/contracts/ui-experience.md §2
 * - 15s 本地 interval 推进 progressPercent(0~100,钳制;零网络请求);
 * - 基于 current.end 的单次 setTimeout(end − now + 1000ms)到点翻转:
 *   本地将 next 提升为 current + 恰调一次 onProgrammeAdvance(拉取由触发方负责,
 *   Hook 不发请求);翻转后对新 current 重新武装(连播场景);
 * - 无 next 翻转 → 空档态(current = null)并停止全部定时器;
 * - initial props 变化(外部数据刷新)按 current.key 锚重置内部状态与定时器;
 * - 卸载清理全部定时器(无泄漏);remainingText 中文(还剩 X 分钟 / 还剩 X 秒)。
 *
 * 时间约定:fake timers 钟面锚定 015 夹具 NOW(2026-11-15T12:00:00.000Z),
 * 节目窗经 buildProgramme 分钟偏移相对该锚推导 —— 进度/剩余时间全部可离线复算,
 * 不依赖真实 Date.now()(Hook 以本地钟为基准,测试用 fake now 等价替换)。
 * 纯 Hook 断言走 RTL renderHook(.ts 文件,无 JSX)。
 */

// ────────────────────────── 探针与时间工具 ──────────────────────────

const MIN = 60_000;

/** renderHook 句柄(每例重挂;直读 result.current 断言,不经过 DOM) */
let view: RenderHookResult<UseCurrentProgrammeResult, UseCurrentProgrammeOptions>;

/** 非空读取(assertion 形式,TS strict 收窄) */
function result(): UseCurrentProgrammeResult {
  const value = view.result.current;
  if (value === undefined) {
    throw new Error('Hook 尚未渲染(result.current 为 undefined)');
  }
  return value;
}

/** act 内推进 fake 时钟(interval tick 与单次 boundary timeout 依调度次序触发) */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 以分钟偏移构造节目(key 显式声明 —— 翻转/重置锚断言依赖稳定 key) */
function programme(
  key: string,
  title: string,
  startsAtMinutes: number,
  endsAtMinutes: number,
): ExperienceProgrammeDto {
  return buildProgramme({ key, title, startsAtMinutes, endsAtMinutes });
}

/** 挂载 Hook(返回句柄供 rerender/unmount) */
function mount(options: UseCurrentProgrammeOptions): typeof view {
  view = renderHook((props: UseCurrentProgrammeOptions) => useCurrentProgramme(props), {
    initialProps: options,
  });
  return view;
}

beforeEach(() => {
  // 钟面锚 = 015 夹具 NOW:buildProgramme 的分钟偏移窗相对该即时精确推导
  vi.useFakeTimers({ now: Date.parse(LIVE_REDESIGN_NOW_ISO) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ────────────────────────── ① 进度百分比(含 0/100 钳制)+ remainingText ──────────────────────────

describe('T006 · 进度百分比与剩余时间(15s 本地 tick,零网络)', () => {
  it('挂载即按本地钟给出正确百分比,15s tick 平滑推进;remainingText 中文分钟', async () => {
    // 窗 NOW−15min → NOW+30min(45 分钟,已播 15 分钟 → 33%)
    mount({
      initialCurrent: programme('k:a', '正播节目', -15, 30),
      initialNext: null,
    });
    expect(result().progressPercent).toBe(33);
    expect(result().remainingText).toBe('还剩 30 分钟');

    // 一个 15s tick:15.25/45 ≈ 33.9 → 34%(平滑推进,非永久冻结)
    await advance(15_000);
    expect(result().progressPercent).toBe(34);
    expect(result().remainingText).toBe('还剩 29 分钟');
  });

  it('钳制:未开播钳 0、已播完钳 100;临近结束以秒计(还剩 X 秒)', () => {
    // 未开播(服务端称 current 但本地钟尚未到 start)→ 钳 0
    mount({
      initialCurrent: programme('k:future', '未来节目', 10, 70),
      initialNext: null,
    });
    expect(result().progressPercent).toBe(0);
    expect(result().remainingText).toBe('还剩 70 分钟');
    cleanup();

    // 已播完(窗 NOW−90 → NOW−30)→ 钳 100(翻转 timeout 尚未到点的同步窗口内)
    mount({
      initialCurrent: programme('k:ended', '结束节目', -90, -30),
      initialNext: null,
    });
    expect(result().progressPercent).toBe(100);
    expect(result().remainingText).toBe('还剩 0 秒');
    cleanup();

    // 临近结束(剩余 30 秒 < 1 分钟)→ 秒计
    mount({
      initialCurrent: programme('k:ending', '收尾节目', -1, 0.5),
      initialNext: null,
    });
    expect(result().progressPercent).toBe(67); // 1/1.5 ≈ 66.7 → 67
    expect(result().remainingText).toBe('还剩 30 秒');
  });
});

// ────────────────────────── ② 到点精准翻转 ──────────────────────────

describe('T006 · 到点翻转(end − now + 1s 单次 setTimeout)', () => {
  it('到点后 current 恰变为 next、next 清空、onProgrammeAdvance 恰调一次,并对新 current 重新武装定时器', async () => {
    const onAdvance = vi.fn();
    const first = programme('k:a', '正播节目', -20, 5); // NOW+5min 结束
    const second = programme('k:b', '下一档', 5, 35); // 紧接 +5min → +35min
    mount({
      initialCurrent: first,
      initialNext: second,
      onProgrammeAdvance: onAdvance,
    });

    // 越过 current.end 1s(契约安全余量)→ 翻转
    await advance(5 * MIN + 1_000);
    expect(result().current).toBe(second); // 本地提升(同一对象引用)
    expect(result().next).toBeNull();
    expect(onAdvance).toHaveBeenCalledTimes(1); // 恰一次,不重复触发
    // 新 current(next)尚未开播 → 进度钳 0
    expect(result().progressPercent).toBe(0);
    // 重新武装:15s interval + 新 current 的单次 boundary timeout = 2 个定时器
    expect(vi.getTimerCount()).toBe(2);
  });
});

// ────────────────────────── ③ 翻转后新定时器再翻转(连播) ──────────────────────────

describe('T006 · 连播场景(翻转后对新 current 再武装、再翻转)', () => {
  it('A→B 翻转后继续推进到 B 末端再次翻转进入空档,回调累计恰两次,定时器归零', async () => {
    const onAdvance = vi.fn();
    const first = programme('k:a', '正播节目', -20, 2); // NOW+2min 结束
    const second = programme('k:b', '下一档', 2, 6); // +2min → +6min
    mount({
      initialCurrent: first,
      initialNext: second,
      onProgrammeAdvance: onAdvance,
    });

    await advance(2 * MIN + 1_000); // 第一次翻转 A → B
    expect(result().current).toBe(second);
    expect(onAdvance).toHaveBeenCalledTimes(1);

    await advance(4 * MIN); // B 末端(+6min+1s)→ 第二次翻转(B 无后继 → 空档)
    expect(result().current).toBeNull();
    expect(result().next).toBeNull();
    expect(onAdvance).toHaveBeenCalledTimes(2); // 每次翻转恰一次,无重复/无遗漏
    expect(vi.getTimerCount()).toBe(0); // 空档态:全部定时器停止
  });
});

// ────────────────────────── ④ 无 next 翻转 → 空档态 ──────────────────────────

describe('T006 · 空档态(current == null,「暂无节目单」前置状态)', () => {
  it('初始即空档:零定时器、进度 0、剩余文案空;到点翻转无 next 时进入空档并停表', async () => {
    // 初始即无节目:不武装任何定时器(零网络、零计时成本)
    mount({ initialCurrent: null, initialNext: null });
    expect(result().current).toBeNull();
    expect(result().progressPercent).toBe(0);
    expect(result().remainingText).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    cleanup();

    // current 到点翻转且无 next → 空档态 + 停表 + 回调仍恰一次(触发方去拉新数据)
    const onAdvance = vi.fn();
    mount({
      initialCurrent: programme('k:a', '正播节目', -20, 2),
      initialNext: null,
      onProgrammeAdvance: onAdvance,
    });
    await advance(2 * MIN + 1_000);
    expect(result().current).toBeNull();
    expect(result().progressPercent).toBe(0);
    expect(result().remainingText).toBe('');
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ────────────────────────── ⑤ initial props 变化重置(key 锚) ──────────────────────────

describe('T006 · 外部数据刷新重置(以 initialCurrent.key 为比较锚)', () => {
  it('key 变化即重置内部状态与定时器:旧 boundary 不再触发、新 current/next 生效、新定时器恰一份', async () => {
    const onAdvance = vi.fn();
    const first = programme('k:a', '正播节目', -20, 2); // 旧翻转点 NOW+2min+1s
    const view1 = mount({
      initialCurrent: first,
      initialNext: null,
      onProgrammeAdvance: onAdvance,
    });

    // 外部刷新交付新节目(key 变化)→ 重置
    const refreshed = programme('k:c', '刷新节目', -20, 10);
    const refreshedNext = programme('k:d', '刷新下一档', 10, 40);
    view1.rerender({
      initialCurrent: refreshed,
      initialNext: refreshedNext,
      onProgrammeAdvance: onAdvance,
    });

    // 状态按新 props 重置(进度按刷新节目窗复算:20/30 ≈ 66.7 → 67)
    expect(result().current).toBe(refreshed);
    expect(result().next).toBe(refreshedNext);
    expect(result().progressPercent).toBe(67);

    // 越过旧 A 的翻转点:旧定时器已被清理,不触发翻转、不触发回调
    await advance(2 * MIN + 1_000);
    expect(result().current).toBe(refreshed);
    expect(onAdvance).not.toHaveBeenCalled();

    // 推进到新 current 末端 → 恰一次翻转(新定时器只有一份,无重复武装)
    await advance(8 * MIN); // +2min+1s → +10min+1s
    expect(result().current).toBe(refreshedNext);
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────── ⑥ 卸载无泄漏 ──────────────────────────

describe('T006 · 卸载清理(无定时器泄漏)', () => {
  it('挂载武装 interval + boundary timeout,卸载后定时器全部清零(含 pending 的翻转 timeout)', async () => {
    const view2 = mount({
      initialCurrent: programme('k:a', '正播节目', -20, 2),
      initialNext: programme('k:b', '下一档', 2, 6),
    });
    expect(vi.getTimerCount()).toBe(2); // interval + 单次 timeout
    await advance(1 * MIN); // 推进一段时间(timeout 仍 pending)
    expect(vi.getTimerCount()).toBe(2);
    view2.unmount();
    expect(vi.getTimerCount()).toBe(0); // 全部清理,无泄漏
  });
});
