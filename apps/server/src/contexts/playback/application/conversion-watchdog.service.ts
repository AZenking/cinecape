import type { PlaybackBudgets } from '../../../config/playback-budgets';
import type { PlaybackErrorCode } from '@contexts/playback/domain/playback.types';

/**
 * 转换看门狗(T027,spec 004)—— 硬超时与转码速度裁决,权威数值全部来自 budgets.watchdog:
 *
 * - 相位硬超时:begin('prepare') 武装首帧 30 秒 / begin('seek') 武装 15 秒;noteFirstOutput
 *   解除(首帧已产出,持续健康改由速度/无输出判罚接管)。到期终止映射
 *   PLAYBACK_PREPARE_TIMEOUT / PLAYBACK_SEEK_TIMEOUT(FR-018/R4 硬超时,不做隐藏重试);
 * - 速度判罚:开始后每 10 秒采样最近 30 秒窗口(窗口不足 30 秒按可用历史计算),
 *   speed = 窗口内输出媒体秒 / 墙钟秒;连续 3 次 speed<1 且可播放缓冲 <8 秒 →
 *   PLAYBACK_PERFORMANCE_INSUFFICIENT;speed≥1 或 buffer≥8 打断连续计数(R4:避免以
 *   初始瞬时 speed 误杀)。采样只在定时器节拍评估,noteOutput 仅记录历史,避免以单点抖动判罚;
 * - 无输出判罚:15 秒无输出且非正常等待 → PLAYBACK_RESOURCE_UNAVAILABLE(R8 资源/转换
 *   稳定失败);enterLegitimateWait(主动暂停/有界预取节流/客户端暂停)期间挂起无输出与
 *   速度判罚,exitLegitimateWait 后无输出计时重新武装完整 15 秒,速度历史重基(暂停跨度
 *   不参与速度计算,避免误杀正常背压,R8);
 * - 裁决恰一次(onTerminate 至多一次),dispose 后全部定时器失效;所有时间经注入 clock
 *   取得(test/fixtures/clock ManualClock 结构兼容:now()/delay()),不直接使用真实定时器;
 * - 终止通知经 onTerminate 回调由监督者/装配层(T031)执行 supervisor.cancel 与稳定失败映射。
 */

/** 结构化最小时钟(ManualClock / systemClock 结构兼容) */
export interface WatchdogClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

export interface ConversionWatchdogDeps {
  readonly budgets: PlaybackBudgets;
  readonly clock: WatchdogClock;
  /** 当前可播放缓冲秒数(监督者提供;速度判罚要求 <8 秒才成立) */
  readonly playableBufferSeconds: () => number;
  /** 看门狗裁决:监督者据此执行终止并映射稳定失败;恰一次 */
  readonly onTerminate: (code: PlaybackErrorCode, detail: string) => void;
}

/** 输出历史样本:媒体秒为累计单调值(FFmpeg out_time/time=) */
interface OutputSample {
  readonly atMs: number;
  readonly mediaSeconds: number;
}

type WatchPhase = 'prepare' | 'seek';
type TimerKind = 'phase' | 'sample' | 'noOutput';

export class ConversionWatchdogService {
  private readonly timerTokens: Record<TimerKind, number> = { phase: 0, sample: 0, noOutput: 0 };
  private phase: WatchPhase | null = null;
  private disposed = false;
  private terminated = false;
  private waiting = false;
  private history: OutputSample[] = [];
  private slowStreak = 0;

  constructor(private readonly deps: ConversionWatchdogDeps) {}

  /** 武装相位硬超时与速度采样节拍(prepare→30s,seek→15s) */
  begin(phase: WatchPhase): void {
    this.phase = phase;
    this.history = [];
    this.slowStreak = 0;
    const watchdog = this.deps.budgets.watchdog;
    const phaseTimeoutMs = (phase === 'prepare' ? watchdog.prepareTimeoutSeconds : watchdog.seekTimeoutSeconds) * 1000;
    const phaseCode: PlaybackErrorCode = phase === 'prepare' ? 'PLAYBACK_PREPARE_TIMEOUT' : 'PLAYBACK_SEEK_TIMEOUT';
    this.arm('phase', phaseTimeoutMs, () => {
      this.terminate(phaseCode, `相位 ${phase} 硬超时 ${Math.round(phaseTimeoutMs / 1000)} 秒无首帧输出`);
    });
    this.arm('sample', watchdog.speedSampleIntervalSeconds * 1000, () => this.onSampleTick());
  }

  /** 首帧输出:解除相位硬超时,武装无输出判罚计时 */
  noteFirstOutput(): void {
    if (this.terminated || this.disposed) {
      return;
    }
    this.invalidate('phase');
    this.rearmNoOutput();
  }

  /** 累计输出媒体秒(单调);刷新无输出计时并记录速度历史 */
  noteOutput(mediaSeconds: number): void {
    if (this.terminated || this.disposed) {
      return;
    }
    this.history.push({ atMs: this.deps.clock.now(), mediaSeconds });
    this.pruneHistory(this.deps.clock.now());
    if (!this.waiting) {
      this.rearmNoOutput();
    }
  }

  /** 主动暂停/有界预取节流/客户端暂停:挂起无输出与速度判罚(R8 排除正常等待) */
  enterLegitimateWait(): void {
    this.waiting = true;
    this.invalidate('noOutput');
  }

  /** 恢复生产:无输出计时重新武装完整 15 秒;速度历史重基(暂停跨度不参与计算) */
  exitLegitimateWait(): void {
    if (!this.waiting) {
      return;
    }
    this.waiting = false;
    this.history = [];
    this.rearmNoOutput();
  }

  /** 终止本看门狗:已注册定时器到期一律失效,绝不再产生裁决 */
  dispose(): void {
    this.disposed = true;
    this.invalidate('phase');
    this.invalidate('sample');
    this.invalidate('noOutput');
  }

  /** 无输出判罚计时(非等待期);等待恢复后由 exitLegitimateWait 重新武装完整期限 */
  private rearmNoOutput(): void {
    const noOutputMs = this.deps.budgets.watchdog.noOutputTimeoutSeconds * 1000;
    this.arm('noOutput', noOutputMs, () => {
      if (this.waiting) {
        return;
      }
      this.terminate(
        'PLAYBACK_RESOURCE_UNAVAILABLE',
        `非正常等待 ${Math.round(noOutputMs / 1000)} 秒无输出,禁止无限缓冲`,
      );
    });
  }

  /** 采样节拍:等待期只推进节拍不评估;评估后继续下一次采样 */
  private onSampleTick(): void {
    if (this.terminated || this.disposed) {
      return;
    }
    if (!this.waiting) {
      this.evaluateSpeed();
    }
    if (this.terminated || this.disposed) {
      return;
    }
    this.arm('sample', this.deps.budgets.watchdog.speedSampleIntervalSeconds * 1000, () => this.onSampleTick());
  }

  /** 最近 30 秒窗口速度评估:窗口不足 30 秒按可用历史计算 */
  private evaluateSpeed(): void {
    const nowMs = this.deps.clock.now();
    this.pruneHistory(nowMs);
    const base = this.history[0];
    const current = this.history[this.history.length - 1];
    if (base === undefined || current === undefined || current === base) {
      return;
    }
    const wallSeconds = (current.atMs - base.atMs) / 1000;
    if (wallSeconds <= 0) {
      return;
    }
    const speed = (current.mediaSeconds - base.mediaSeconds) / wallSeconds;
    const watchdog = this.deps.budgets.watchdog;
    if (speed < 1 && this.deps.playableBufferSeconds() < watchdog.minPlayableBufferSeconds) {
      this.slowStreak += 1;
      if (this.slowStreak >= watchdog.speedFailConsecutiveSamples) {
        this.terminate(
          'PLAYBACK_PERFORMANCE_INSUFFICIENT',
          `连续 ${this.slowStreak} 次窗口速度 <1x(speed=${speed.toFixed(3)})且缓冲 <${watchdog.minPlayableBufferSeconds} 秒`,
        );
      }
      return;
    }
    this.slowStreak = 0;
  }

  /** 丢弃窗口起点之前的样本(保留窗口基点),历史有界 */
  private pruneHistory(nowMs: number): void {
    const cutoffMs = nowMs - this.deps.budgets.watchdog.speedWindowSeconds * 1000;
    let baseIndex = 0;
    for (let index = 0; index < this.history.length; index += 1) {
      const sample = this.history[index];
      if (sample !== undefined && sample.atMs <= cutoffMs) {
        baseIndex = index;
      }
    }
    if (baseIndex > 0) {
      this.history = this.history.slice(baseIndex);
    }
  }

  /** 裁决恰一次:终止后所有节拍与计时器失效 */
  private terminate(code: PlaybackErrorCode, detail: string): void {
    if (this.terminated || this.disposed) {
      return;
    }
    this.terminated = true;
    this.invalidate('phase');
    this.invalidate('sample');
    this.invalidate('noOutput');
    this.deps.onTerminate(code, detail);
  }

  private arm(kind: TimerKind, ms: number, onFire: () => void): void {
    this.timerTokens[kind] += 1;
    const token = this.timerTokens[kind];
    void this.deps.clock.delay(Math.max(0, ms)).then(() => {
      if (this.disposed || token !== this.timerTokens[kind]) {
        return;
      }
      onFire();
    });
  }

  private invalidate(kind: TimerKind): void {
    this.timerTokens[kind] += 1;
  }
}
