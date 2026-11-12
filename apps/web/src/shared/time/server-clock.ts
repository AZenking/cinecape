/**
 * 服务端基准时钟(类 NTP 偏移校准;016 spec「进度条以服务器返回的基准时间戳
 * 计算漂移差值,防止进度倒流或越界」的统一落点):
 *
 * - **校准**:每个携带 `now` 字段的 API 响应(经 shared/fetch 唯一入口)调用
 *   `syncServerNowIso/syncServerNowMs`,记录 offset = serverNow − 本地钟;
 *   此后任意时刻 `serverNowMs() = Date.now() + offset` 平滑推进(本地钟只作
 *   单调推进的秒表,绝对值由服务端基准决定——浏览器时钟漂移/时区错误不再影响
 *   时间展示与 EPG 进度);
 * - **防倒流**:小幅校准(≤ HARD_CORRECTION)不允许向后跳(每次最多回退
 *   BACKSTEP_TOLERANCE),进度条/NOW 线不回跳;大幅偏差(设备改钟/休眠恢复)
 *   直接吸附真实基准(snap),宁可跳一次也不长期错;
 * - **未校准态**:首个响应到达前 offset 为 null,`serverNowMs()` 返回 null,
 *   消费方回落各自响应快照 `data.now`(不臆造本地时钟,与 GuidePage 既有
 *   语义一致);测试经 `resetServerClockForTests` 隔离模块级状态;
 * - **单一事实源**:NOW 指示线、直播进度百分比、节目四状态裁决、剩余时间
 *   文案等一律消费本模块(直接或经 useServerNow tick),禁止再各自
 *   Date.now()/快照 now 推导。
 */

/** 大幅偏差阈值:超过视为真实重校准(吸附),不视为抖动(|candidate − current|) */
export const SERVER_CLOCK_HARD_CORRECTION_MS = 30_000;

/** 小幅校准的单次最大回退量(防进度倒流的钳制窗口) */
export const SERVER_CLOCK_BACKSTEP_TOLERANCE_MS = 250;

/** 模块级状态:offset=null 表示未校准(首个带 now 的响应到达前) */
let offsetMs: number | null = null;
let lastSyncLocalMs: number | null = null;
let lastSyncServerMs: number | null = null;
let syncCount = 0;

/**
 * 以服务端时刻校准时钟。
 * @param serverNowMs 服务端 now(UTC 毫秒)
 * @param receivedAtLocalMs 本地收到该响应的时刻(缺省 Date.now();测试可注入)
 */
export function syncServerNowMs(serverNowMs: number, receivedAtLocalMs: number = Date.now()): void {
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(receivedAtLocalMs)) {
    return;
  }
  const candidate = serverNowMs - receivedAtLocalMs;
  if (offsetMs === null || Math.abs(candidate - offsetMs) > SERVER_CLOCK_HARD_CORRECTION_MS) {
    // 首次校准或大幅偏差(设备改钟/长休眠):吸附真实基准
    offsetMs = candidate;
  } else {
    // 小幅漂移:允许极小回退(≤ BACKSTEP_TOLERANCE),否则只前进——NOW 线/进度不倒流
    offsetMs = Math.max(offsetMs - SERVER_CLOCK_BACKSTEP_TOLERANCE_MS, candidate);
  }
  lastSyncLocalMs = receivedAtLocalMs;
  lastSyncServerMs = serverNowMs;
  syncCount += 1;
}

/** ISO 字符串校准入口(无效/非字符串静默忽略;响应体缺 now 时不扰动) */
export function syncServerNowIso(serverNowIso: unknown, receivedAtLocalMs: number = Date.now()): void {
  if (typeof serverNowIso !== 'string') {
    return;
  }
  const ms = Date.parse(serverNowIso);
  if (Number.isFinite(ms)) {
    syncServerNowMs(ms, receivedAtLocalMs);
  }
}

/** 服务端基准当前时刻(UTC 毫秒);未校准返回 null(消费方回落响应快照 now) */
export function serverNowMs(): number | null {
  return offsetMs === null ? null : Date.now() + offsetMs;
}

/** 是否已校准(至少见过一个带 now 的响应) */
export function isServerClockCalibrated(): boolean {
  return offsetMs !== null;
}

/** 校准诊断(调试/测试对账用;不参与渲染) */
export function serverClockDebug(): {
  readonly calibrated: boolean;
  readonly offsetMs: number | null;
  readonly lastSyncLocalMs: number | null;
  readonly lastSyncServerMs: number | null;
  readonly syncCount: number;
} {
  return {
    calibrated: offsetMs !== null,
    offsetMs,
    lastSyncLocalMs,
    lastSyncServerMs,
    syncCount,
  };
}

/** 测试隔离:清零模块级校准状态(vitest 每例 beforeEach 调用) */
export function resetServerClockForTests(): void {
  offsetMs = null;
  lastSyncLocalMs = null;
  lastSyncServerMs = null;
  syncCount = 0;
}
