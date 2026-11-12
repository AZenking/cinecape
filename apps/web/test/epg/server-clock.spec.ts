import { beforeEach, describe, expect, it } from 'vitest';
import {
  SERVER_CLOCK_BACKSTEP_TOLERANCE_MS,
  SERVER_CLOCK_HARD_CORRECTION_MS,
  resetServerClockForTests,
  serverClockDebug,
  serverNowMs,
  syncServerNowIso,
  syncServerNowMs,
} from '../../src/shared/time/server-clock';

/**
 * 服务端基准时钟单测(016 spec「进度条以服务器返回的基准时间戳计算漂移差值,
 * 防止进度倒流或越界」的模块级行为锁定;server-clock.ts 文件头契约):
 * - 未校准态:首个带 now 的响应到达前 serverNowMs() = null(消费方回落响应快照);
 * - 首次校准吸附:offset = serverNow − 本地钟,此后平滑推进;
 * - 防倒流钳制:小幅校准(|Δ| ≤ HARD_CORRECTION)最多回退 BACKSTEP_TOLERANCE,
 *   前向不受限 —— NOW 线/进度条不回跳;
 * - 大幅偏差(> HARD_CORRECTION,设备改钟/休眠恢复)直接吸附新基准;
 * - 输入卫生:syncServerNowIso 非字符串/非法 ISO、syncServerNowMs 非有限值
 *   一律静默忽略,不扰动既有校准状态;
 * - 测试隔离:resetServerClockForTests 清零模块级状态。
 *
 * 时间约定:一律显式注入 receivedAtLocalMs 控制本地钟,不依赖真实 Date.now();
 * offset 断言走 serverClockDebug()(调试对账出口;不参与渲染)。
 */

/** 本地钟基线(任意固定即时;仅作为注入 receivedAtLocalMs 的原点,与真实钟无关) */
const LOCAL_BASE_MS = 1_700_000_000_000;

/** 服务端与本地钟的约定偏移(首次校准目标;服务端快 5 秒) */
const SERVER_AHEAD_MS = 5_000;

beforeEach(() => {
  // 模块级 offset/lastSync/syncCount 清零,保证每例从「未校准态」出发
  resetServerClockForTests();
});

// ────────────────────────── ① 未校准态 ──────────────────────────

describe('server-clock · 未校准态', () => {
  it('未 sync 前 serverNowMs() 返回 null、calibrated=false,不臆造本地时钟', () => {
    expect(serverNowMs()).toBeNull();
    expect(serverClockDebug().calibrated).toBe(false);
    expect(serverClockDebug().offsetMs).toBeNull();
  });
});

// ────────────────────────── ② 首次校准吸附 ──────────────────────────

describe('server-clock · 首次校准吸附', () => {
  it('首次 sync 记录 offset = serverNow − receivedAt,serverNowMs 随本地钟平滑推进', () => {
    // 服务端时刻 = 本地收到时刻 + 5s → 目标 offset = +5000
    syncServerNowMs(LOCAL_BASE_MS + SERVER_AHEAD_MS, LOCAL_BASE_MS);

    const debug = serverClockDebug();
    expect(debug.calibrated).toBe(true);
    expect(debug.offsetMs).toBe(SERVER_AHEAD_MS);
    expect(debug.lastSyncLocalMs).toBe(LOCAL_BASE_MS);
    expect(debug.lastSyncServerMs).toBe(LOCAL_BASE_MS + SERVER_AHEAD_MS);
    expect(debug.syncCount).toBe(1);

    // serverNowMs = Date.now() + offset:与本地钟的差应恒等于 offset
    // (断言经 serverNowMs() − Date.now() 间接验证,不依赖具体钟面)
    const observed = serverNowMs();
    expect(observed).not.toBeNull();
    // serverNowMs() 内部取一次 Date.now(),断言处再取一次:两次调用可能跨毫秒刻度
    // (满载并行时更明显),因此允许 ±2ms 的读数误差,语义仍是"差值恒等于 offset"。
    const delta = (observed as number) - Date.now();
    expect(delta).toBeGreaterThanOrEqual(SERVER_AHEAD_MS - 2);
    expect(delta).toBeLessThanOrEqual(SERVER_AHEAD_MS + 2);
  });

  it('ISO 字符串入口等价:合法 ISO 校准成功,offset 与 ms 入口一致', () => {
    syncServerNowIso(new Date(LOCAL_BASE_MS + SERVER_AHEAD_MS).toISOString(), LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(SERVER_AHEAD_MS);
  });
});

// ────────────────────────── ③ 小幅漂移:防倒流钳制 ──────────────────────────

describe('server-clock · 小幅漂移钳制(≤ HARD_CORRECTION)', () => {
  it('小幅前向漂移:offset 完全跟随(前向不受限)', () => {
    syncServerNowMs(LOCAL_BASE_MS, LOCAL_BASE_MS); // offset = 0
    // 服务端钟快了 10s(≤30s)→ 前向平滑跟随
    syncServerNowMs(LOCAL_BASE_MS + 10_000, LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(10_000);
  });

  it('小幅回退 ≤ BACKSTEP_TOLERANCE:允许回退(钳制窗口内)', () => {
    syncServerNowMs(LOCAL_BASE_MS + 10_000, LOCAL_BASE_MS); // offset = +10000
    // 回退 100ms(≤ 250ms 容忍窗)→ 允许
    syncServerNowMs(LOCAL_BASE_MS + 10_000 - 100, LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(10_000 - 100);
  });

  it('小幅回退 > BACKSTEP_TOLERANCE:钳制,单次最多回退 250ms(进度不倒流)', () => {
    syncServerNowMs(LOCAL_BASE_MS + 10_000, LOCAL_BASE_MS); // offset = +10000
    // 回退 5s(仍 ≤ 30s 属抖动级)→ offset 只允许 −250
    syncServerNowMs(LOCAL_BASE_MS + 5_000, LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(10_000 - SERVER_CLOCK_BACKSTEP_TOLERANCE_MS);
  });

  it('恰在 HARD_CORRECTION 边界(=30s)仍属小幅:钳制不吸附', () => {
    syncServerNowMs(LOCAL_BASE_MS, LOCAL_BASE_MS); // offset = 0
    // |candidate − offset| = 30000,不满足「> 30s」→ 走小幅分支
    syncServerNowMs(LOCAL_BASE_MS + SERVER_CLOCK_HARD_CORRECTION_MS, LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(SERVER_CLOCK_HARD_CORRECTION_MS);
  });
});

// ────────────────────────── ④ 大幅偏差:吸附新基准 ──────────────────────────

describe('server-clock · 大幅偏差吸附(> HARD_CORRECTION)', () => {
  it('前向大幅偏差:直接吸附新 offset(snap),宁可跳一次不长期错', () => {
    syncServerNowMs(LOCAL_BASE_MS, LOCAL_BASE_MS); // offset = 0
    // 设备钟被改快 40s → 真实重校准,offset 吸附 +40000
    syncServerNowMs(LOCAL_BASE_MS + 40_000, LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(40_000);
  });

  it('后向大幅偏差(休眠恢复):同样吸附,不走钳制分支', () => {
    syncServerNowMs(LOCAL_BASE_MS + 10_000, LOCAL_BASE_MS); // offset = +10000
    // 设备钟回拨 60s → |Δ| = 70000 > 30000 → 吸附真实候选
    syncServerNowMs(LOCAL_BASE_MS - 60_000, LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(-60_000);
    expect(serverClockDebug().lastSyncServerMs).toBe(LOCAL_BASE_MS - 60_000);
  });
});

// ────────────────────────── ⑤ 输入卫生 ──────────────────────────

describe('server-clock · 非法输入静默忽略', () => {
  it('syncServerNowIso 非字符串/非法 ISO:忽略,不建立校准、不扰动既有 offset', () => {
    // 未校准态下非法输入不得臆造 offset
    syncServerNowIso(undefined);
    syncServerNowIso(null);
    syncServerNowIso(123);
    syncServerNowIso('not-an-iso');
    syncServerNowIso('2026-13-99T99:99:99Z'); // Date.parse = NaN
    expect(serverNowMs()).toBeNull();
    expect(serverClockDebug().syncCount).toBe(0);

    // 已校准态下非法输入不改变 offset/syncCount(响应缺 now 时不扰动)
    syncServerNowMs(LOCAL_BASE_MS, LOCAL_BASE_MS);
    syncServerNowIso(undefined);
    syncServerNowIso('garbage');
    expect(serverClockDebug().offsetMs).toBe(0);
    expect(serverClockDebug().syncCount).toBe(1);
  });

  it('syncServerNowMs 非有限值:忽略(含 NaN/±Infinity),本地 receivedAt 非有限同样忽略', () => {
    syncServerNowMs(Number.NaN);
    syncServerNowMs(Number.POSITIVE_INFINITY);
    syncServerNowMs(Number.NEGATIVE_INFINITY);
    syncServerNowMs(LOCAL_BASE_MS, Number.NaN); // receivedAt 非有限
    expect(serverNowMs()).toBeNull();
    expect(serverClockDebug().syncCount).toBe(0);
  });
});

// ────────────────────────── ⑥ 测试隔离 ──────────────────────────

describe('server-clock · resetServerClockForTests 清零', () => {
  it('校准后 reset:回到未校准态,全部诊断字段清零', () => {
    syncServerNowMs(LOCAL_BASE_MS + SERVER_AHEAD_MS, LOCAL_BASE_MS);
    expect(serverClockDebug().calibrated).toBe(true);

    resetServerClockForTests();
    const debug = serverClockDebug();
    expect(debug.calibrated).toBe(false);
    expect(debug.offsetMs).toBeNull();
    expect(debug.lastSyncLocalMs).toBeNull();
    expect(debug.lastSyncServerMs).toBeNull();
    expect(debug.syncCount).toBe(0);
    expect(serverNowMs()).toBeNull();
  });

  it('reset 后可重新校准(首个响应重新吸附,不残留旧 offset 影响)', () => {
    syncServerNowMs(LOCAL_BASE_MS + SERVER_AHEAD_MS, LOCAL_BASE_MS);
    resetServerClockForTests();
    // 新基准:服务端慢 3s → 吸附 −3000(而非从 +5000 钳制逼近)
    syncServerNowMs(LOCAL_BASE_MS - 3_000, LOCAL_BASE_MS);
    expect(serverClockDebug().offsetMs).toBe(-3_000);
    expect(serverClockDebug().syncCount).toBe(1);
  });
});
