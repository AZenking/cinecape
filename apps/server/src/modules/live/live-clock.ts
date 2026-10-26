/**
 * 直播只读时钟缝(T063;005 tasks T062/SC-005 支撑):
 * - 单个请求内的「冻结 now」由控制器/服务层取一次 liveNowMs() 后全链传递,
 *   一次响应内的 now/timezone/catalogRevision 来自同一同步读快照;
 * - HMP_CLOCK_OFFSET_MS:可选毫秒偏移(服务端时钟 = 真实时间 + 偏移),供
 *   验收运行把服务端 now 锚进 T012 规模夹具排期窗口;
 *   未设置或非整数时进入下方 E2E_SEED_SCALE 缺省锚定或 0(真实时间);
 * - E2E_SEED_SCALE=1(e2e-servers.sh 规模夹具运行)且未显式给偏移时,缺省把
 *   now 锚定到 SCALE_FIXTURE_FIXED_NOW_MS(2026-11-04T12:05Z,CST 20:05,
 *   ch001 20:02~21:02 重叠档内)——此后与真实时间 1:1 流动,标准 e2e 命令
 *   无需额外环境变量即可断言「正在直播」;生产/单测不设置该变量,不受影响;
 * - 除本文件外,直播模块一律不直接调用 Date.now()。
 */

/** T012 规模夹具固定锚点(SCALE_FIXTURE_FIXED_NOW_MS;test/fixtures/scale-fixture.ts 权威) */
const SCALE_FIXTURE_ANCHOR_MS = 1_793_793_900_000;

let cachedOffset: { raw: string | undefined; offsetMs: number } | null = null;

function readOffsetMs(): number {
  const raw = process.env.HMP_CLOCK_OFFSET_MS;
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  // 规模夹具 e2e(E2E_SEED_SCALE=1)缺省锚定:锚点 − 首次取时时刻,此后 1:1 流动
  if (process.env.E2E_SEED_SCALE === '1') {
    return SCALE_FIXTURE_ANCHOR_MS - Date.now();
  }
  return 0;
}

/** 直播投影当前时刻(毫秒);每请求由调用方取一次并冻结传递 */
export function liveNowMs(): number {
  // env 在进程生命周期内不变;按值缓存,避免每请求重复解析
  const raw = process.env.HMP_CLOCK_OFFSET_MS;
  if (cachedOffset === null || cachedOffset.raw !== raw) {
    cachedOffset = { raw, offsetMs: readOffsetMs() };
  }
  return Date.now() + cachedOffset.offsetMs;
}
