import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sharedHooks from '../../src/shared/hooks';
import { useDebouncedValue, useInterval, useMediaQuery } from '../../src/shared/hooks';

/**
 * shared/hooks 出口单测(T036;006 US4 收编车道):
 * - allowlist re-export 全量解析冒烟(index.ts 即事实:恰好 10 个、全部解析为函数,
 *   防止 allowlist 与 @mantine/hooks 实际导出漂移);
 * - 关键 re-export 行为抽样,作为收编决议的语义等价凭证:
 *   · useMediaQuery —— T033(原 features/settings/use-media-query.ts 已删除,消费方
 *     SettingsLayout 改经本出口;jsdom 垫片默认不匹配 → false,宽窗 → true,与原
 *     useSyncExternalStore 版在测试环境逐点一致);
 *   · useInterval —— T034(use-live-refresh 的 interval 原语由手写 setInterval 换为
 *     autoInvoke 版:挂载即启动、按期触发、卸载清理、intervalMs 变更重启,30s 契约不变);
 *   · useDebouncedValue —— 值 hook 抽样(防抖窗口内取最新值)。
 * 本目录当前零自研 hook;日后自研必须附「为何不用现成库」理由并在本文件补单测。
 */

/** index.ts curated allowlist(与 README「库存盘点」表一致;增删须同步) */
const ALLOWLIST = [
  'useClipboard',
  'useDebouncedValue',
  'useDocumentVisibility',
  'useElementSize',
  'useEventListener',
  'useFocusWithin',
  'useInterval',
  'useLocalStorage',
  'useMediaQuery',
  'useThrottledValue',
] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shared/hooks 出口(T036)', () => {
  it('allowlist 恰好 10 个 re-export 且全部解析为函数(冒烟)', () => {
    expect(Object.keys(sharedHooks).sort()).toEqual([...ALLOWLIST].sort());
    for (const value of Object.values(sharedHooks)) {
      expect(typeof value).toBe('function');
    }
  });

  it('useMediaQuery:jsdom 垫片默认不匹配返回 false;宽窗垫片返回 true(T033 语义凭证)', () => {
    // test/setup.ts 的 matchMedia 垫片默认 matches:false(窄窗语义,同原页面级 hook)
    const narrow = renderHook(() => useMediaQuery('(min-width: 900px)'));
    expect(narrow.result.current).toBe(false);
    narrow.unmount();

    // 宽窗垫片:min-width 查询恒匹配(SettingsLayout「宽窗」分支语义)
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('min-width'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const wide = renderHook(() => useMediaQuery('(min-width: 900px)'));
    expect(wide.result.current).toBe(true);
    wide.unmount();
  });

  it('useInterval autoInvoke:按 interval 触发,卸载后清理不再触发(T034 语义凭证)', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const { unmount } = renderHook(() => useInterval(tick, 1_000, { autoInvoke: true }));
    act(() => {
      vi.advanceTimersByTime(3_500);
    });
    // 3.5s → 1s/2s/3s 三次触发(等价原手写 setInterval)
    expect(tick).toHaveBeenCalledTimes(3);
    unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // 卸载后定时器已清理,不再积累触发
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('useInterval:intervalMs 变更重启(等价原 effect [intervalMs] 重建)', () => {
    vi.useFakeTimers();
    const tick = vi.fn();
    const { rerender, unmount } = renderHook(({ ms }) => useInterval(tick, ms, { autoInvoke: true }), {
      initialProps: { ms: 1_000 },
    });
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(tick).toHaveBeenCalledTimes(1);
    rerender({ ms: 500 });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    // 换 500ms 周期后:+500ms、+1000ms 各一次(旧 1000ms 定时器已被清理)
    expect(tick).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('useDebouncedValue:防抖窗口内高频变更只取最新值(值 hook 抽样)', () => {
    vi.useFakeTimers();
    const { rerender, result } = renderHook(({ value }) => useDebouncedValue(value, 300), {
      initialProps: { value: 'a' },
    });
    expect(result.current[0]).toBe('a');
    rerender({ value: 'ab' });
    rerender({ value: 'abc' });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    // 防抖窗口未到:仍为旧值
    expect(result.current[0]).toBe('a');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // 窗口到:取窗口内最新值
    expect(result.current[0]).toBe('abc');
  });
});
