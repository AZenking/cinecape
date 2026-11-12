import { useEffect, useRef, useState } from 'react';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { serverNowMs } from '../../../shared/time/server-clock';

/**
 * 智能事件定时器 Hook(016 T009;contracts/ui-experience.md §2 契约逐字段实现):
 *
 * - **15 秒本地进度 tick**:内部 `setInterval` 每 15s 同步一次服务端基准时钟并
 *   复算 progressPercent(0~100,钳制;整数百分比,与 015 面板「已播 N%」同一
 *   舍入语义)。完全零网络请求 —— 网络真值仍由外部数据刷新(react-query 30s
 *   静默更新)承担;
 * - **服务端基准时钟(NTP 式)**:进度与到点判定一律用 server-clock 校准时刻
 *   (016 spec「进度条以服务器返回的基准时间戳计算漂移差值,防止进度倒流或
 *   越界」);未校准(首个带 now 的响应到达前)回落本地钟 —— 本 Hook 的数据
 *   源响应均携带 now,实际运行总是先校准后消费;
 * - **事件驱动推进**:以 `current.end` 与服务端基准时间差设置单次 `setTimeout`
 *   (`max(0, end − now) + 1000ms` 安全余量)到点翻转:本地立即把 next 提升为
 *   current、无 next 则进入空档态(current = null),并恰调一次 onProgrammeAdvance
 *   —— **静默拉取下一档由触发方负责**(Hook 不发任何请求,调用方接既有查询的
 *   refetch);翻转后对新 current 重新武装定时器(连播场景),空档态停止全部定时器;
 * - **外部数据刷新重置**:以 initialCurrent.key 为比较锚,key 变化(外部静默刷新
 *   交付新节目单 / 换台)即重置内部状态与定时器;同 key 的新对象引用不扰动运行中
 *   定时器(避免刷新抖动);onProgrammeAdvance 经 ref 消费最新闭包,回调身份变化
 *   不重置定时器;
 * - **卸载清理**:interval 与单次 timeout 全部清零,无泄漏(T006 ⑥ 钉住)。
 */

/** 本地进度 tick 周期(契约 §2.2「轻量 15 秒间隔」;导出供测试/监控对账) */
export const PROGRESS_TICK_INTERVAL_MS = 15_000;

/** 事件推进安全余量:越过 current.end 1s 后再翻转(契约 §2.2 伪代码 +1000ms;兼覆盖 offset 微调) */
const ADVANCE_MARGIN_MS = 1_000;

/** 服务端基准时钟当前时刻;未校准回落本地钟(见模块头注) */
function calibratedNowMs(): number {
  return serverNowMs() ?? Date.now();
}

/** Hook 内部持有的一对节目(本地真相;外部刷新按 key 锚重置) */
interface ProgrammePair {
  readonly current: ExperienceProgrammeDto | null;
  readonly next: ExperienceProgrammeDto | null;
}

/** 契约 §2.1:调用方入参(字段逐字对齐) */
export interface UseCurrentProgrammeOptions {
  readonly initialCurrent: ExperienceProgrammeDto | null;
  readonly initialNext: ExperienceProgrammeDto | null;
  /** 当节目到点翻转后触发的静默刷新回调(Hook 不发请求;触发方负责拉取下一档) */
  readonly onProgrammeAdvance?: () => void;
}

/** 契约 §2.1:返回面(字段逐字对齐) */
export interface UseCurrentProgrammeResult {
  readonly current: ExperienceProgrammeDto | null;
  readonly next: ExperienceProgrammeDto | null;
  /** 0 ~ 100 范围的平滑数值(整数百分比,钳制) */
  readonly progressPercent: number;
  /** 格式化后的剩余时间文本(如「还剩 12 分钟」;临近「还剩 X 秒」;空档为空串) */
  readonly remainingText: string;
}

/**
 * 进度 0~100(整数,钳制):由节目窗与本地时刻复算;窗无效/未开播钳 0、已播完钳 100。
 * 空档(current = null)返回 0(调用方以 current == null 判定降级,不以进度判定)。
 */
function progressPercentOf(programme: ExperienceProgrammeDto | null, nowMs: number): number {
  if (programme === null) {
    return 0;
  }
  const start = Date.parse(programme.startsAt);
  const end = Date.parse(programme.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  const ratio = (nowMs - start) / (end - start);
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/**
 * 剩余时间中文文案:≥ 1 分钟 → 「还剩 X 分钟」(向下取整);不足 1 分钟 →
 * 「还剩 X 秒」;已过末端/空档 → 「还剩 0 秒」/空串(空档由调用方按 current == null
 * 呈现「暂无节目单」,不展示剩余文案)。
 */
function remainingTextOf(programme: ExperienceProgrammeDto | null, nowMs: number): string {
  if (programme === null) {
    return '';
  }
  const end = Date.parse(programme.endsAt);
  if (!Number.isFinite(end)) {
    return '';
  }
  const remainingMs = Math.max(0, end - nowMs);
  if (remainingMs >= 60_000) {
    return `还剩 ${Math.floor(remainingMs / 60_000)} 分钟`;
  }
  return `还剩 ${Math.floor(remainingMs / 1_000)} 秒`;
}

/**
 * 智能事件定时器(见模块头注;契约 ui-experience.md §2.2)。
 */
export function useCurrentProgramme(options: UseCurrentProgrammeOptions): UseCurrentProgrammeResult {
  const { initialCurrent, initialNext, onProgrammeAdvance } = options;

  // 本地真相:初始取 props,此后由到点翻转/外部 key 锚重置维护
  const [pair, setPair] = useState<ProgrammePair>({ current: initialCurrent, next: initialNext });
  // 服务端基准时钟快照(挂载/翻转/重置/15s tick 时同步;进度与剩余文案由此派生)
  const [nowMs, setNowMs] = useState<number>(() => calibratedNowMs());

  // 最新闭包经 ref 消费:回调身份每渲染变化不重置定时器(仅翻转瞬间取当下回调)
  const advanceRef = useRef(onProgrammeAdvance);
  // 最新 initial 经 ref 消费:重置 effect 以 key 为依赖,取值时读到当次渲染的新值
  const latestInitialRef = useRef<ProgrammePair>({ current: initialCurrent, next: initialNext });
  useEffect(() => {
    advanceRef.current = onProgrammeAdvance;
    latestInitialRef.current = { current: initialCurrent, next: initialNext };
  });

  // 外部数据刷新重置(契约:以 current.key 为比较锚):key 变化才重置,
  // 同 key 新引用(30s 静默刷新同节目)不扰动运行中状态与定时器
  const initialKey = initialCurrent?.key ?? null;
  useEffect(() => {
    setPair(latestInitialRef.current);
    // 锚即 key(契约);initial 取 ref 最新值
  }, [initialKey]);

  // 最新 pair 经 ref 消费:定时器 effect 以锚串为依赖(见下),读取时取当次渲染值
  const pairRef = useRef(pair);
  useEffect(() => {
    pairRef.current = pair;
  });

  // 重武装锚:key + endsAt。到点翻转(next 提升为 current)与外部 key 重置都会
  // 改变锚 → cleanup 旧定时器后重新武装;同 key 同窗的刷新不扰动(无抖动)。
  const rearmAnchor = `${pair.current?.key ?? ''}|${pair.current?.endsAt ?? ''}`;
  useEffect(() => {
    const current = pairRef.current.current;
    if (current === null) {
      return; // 空档态:零定时器(无节目不计时;「暂无节目单」态)
    }
    const endMs = Date.parse(current.endsAt);
    const tick = (): void => {
      setNowMs(calibratedNowMs());
    };
    tick(); // 挂载/翻转/重置后立即同步一次基准钟:首帧进度即正确
    const intervalId = setInterval(tick, PROGRESS_TICK_INTERVAL_MS);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (Number.isFinite(endMs)) {
      // 契约 §2.2:max(0, end − now) + 1000ms 单次到点翻转(now 取服务端基准钟)
      const delay = Math.max(0, endMs - calibratedNowMs()) + ADVANCE_MARGIN_MS;
      timeoutId = setTimeout(() => {
        // 1. 本地状态立刻翻转:next 提升为 current(无 next → 空档 null)
        setPair((prev) => (prev.current === null ? prev : { current: prev.next, next: null }));
        setNowMs(calibratedNowMs());
        // 2. 静默拉取下一档由触发方负责(Hook 零网络;回调经 ref 取最新闭包)
        advanceRef.current?.();
      }, delay);
    }
    return () => {
      clearInterval(intervalId);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
    // 依赖即锚串(契约语义);pair/回调经 ref 读取
  }, [rearmAnchor]);

  return {
    current: pair.current,
    next: pair.next,
    progressPercent: progressPercentOf(pair.current, nowMs),
    remainingText: remainingTextOf(pair.current, nowMs),
  };
}
