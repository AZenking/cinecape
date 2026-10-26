import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PlaybackBudgets } from '../../config/playback-budgets';
import type { PlaybackRepository } from './playback.repository';
import { playbackErr, playbackOk, type PlaybackConversionMode, type PlaybackErrorCode, type PlaybackResult } from './playback.types';

const execFile = promisify(execFileCallback);

/**
 * 转换监督者(T025,spec 004)—— 原子 reserve → 参数数组启动 → 进度监督 → 确认退出释放:
 *
 * - 原子额度:repository.reserveConversion 在 BEGIN IMMEDIATE 内按全部 reserved～stopping 行
 *   计全局额度(remux 与转码共用,FR-016);满额立即返回 PLAYBACK_CONVERSION_BUSY —— 不排队、
 *   绝不 spawn;direct 交付(plan.mode=null)不建行、不占额,由计划层保证,此处兜底拒绝;
 * - 启动:shell=false 参数数组(ffmpeg),参数由 plan 输出 + budgets 构造(remux=-c copy、
 *   audio_transcode=-c:v copy/-c:a aac 192k、video_transcode=libx264 8Mbps/上限 12Mbps/≤1080p,
 *   硬件后端 -c:v h264_<backend>);硬件运行探测优先(注入探测函数,失败返回 null,不假定硬件 R7),
 *   硬件启动失败(退出且无任何输出=初始化失败)最多软件回退一次且共用原 deadlineAtMs 绝不重置
 *   (R8);硬件+软件均失败 → PLAYBACK_RESOURCE_UNAVAILABLE,最多两次 spawn 不无限切换;
 * - 期限:deadlineAtMs 为共享绝对期限(30s/15s 硬超时由上层按 budgets.watchdog 计算);任一尝试
 *   产出首帧输出即解除期限,否则到期 SIGTERM → sigtermGraceSeconds(5s)宽限 → SIGKILL,退出确认
 *   后按相位映射 PLAYBACK_PREPARE_TIMEOUT/PLAYBACK_SEEK_TIMEOUT;
 * - 进度:解析 -progress 管道行(out_time_us/out_time_ms/out_time=)与 stderr time= 行,跟踪
 *   累计输出媒体秒(T031 装配时同步给看门狗 noteOutput 与存储窗口记账);
 * - 退出处理:自然退出(0)→ 先 stopping 再 ended;SIGTERM/取消/换代 → interrupted;spawn 抛错 →
 *   compensateRelease 补偿释放从未启动的预留行;全部终态经 releaseOnExit 确认退出后才释放额度
 *   (R4/R5:确认退出后才释放,不双占);
 * - start 返回值语义:reserve+spawn 成功后即可观察 ok({conversionId});若全部尝试无法启动,
 *   await 该结果得到稳定 err(观察时点裁决 —— 终态经仓储行/额度观察,监督为 fire-and-forget);
 * - 暂停有界预取/节流(R8):pauseProduction 进入有界预取(默认再产 2 个目标分片时长)到量即
 *   SIGSTOP,resumeProduction SIGCONT 恢复;装配层(T031)应与 T027 看门狗
 *   enterLegitimateWait/exitLegitimateWait 对称调用以排除判罚。
 */

/** 结构化最小时钟(ManualClock / systemClock 结构兼容) */
export interface SupervisorClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

export interface ConversionSpawnRequest {
  readonly conversionId: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  /** 0=硬件首选,1=软件回退(最多一次,R8) */
  readonly attemptIndex: number;
  readonly backend: 'hardware' | 'software';
  /** shell=false 参数数组(ffmpeg) */
  readonly argv: readonly string[];
  /** 共用绝对期限(毫秒域注入时钟);硬件失败回退不重置(R8) */
  readonly deadlineAtMs: number;
}

export interface ConversionProcessHandle {
  readonly pid: number;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): ConversionProcessHandle;
  on(event: 'stderr', listener: (chunk: string) => void): ConversionProcessHandle;
  /** FFmpeg 机器可读 progress 行(-progress 管道;T025 进度读取) */
  on(event: 'progress', listener: (line: string) => void): ConversionProcessHandle;
  kill(signal: string): boolean;
}

/** 计划输入(与 T024 PlaybackPlanService 输出的 ConversionPlan 结构一致) */
export interface ConversionPlanInput {
  readonly delivery: 'direct' | 'remux' | 'audio_transcode' | 'video_transcode';
  readonly mode: PlaybackConversionMode | null;
  readonly outputVideoCodec: string;
  readonly outputAudioCodec: string;
  readonly reason: string;
}

export interface ConversionSupervisorDeps {
  readonly repository: PlaybackRepository;
  readonly budgets: PlaybackBudgets;
  readonly clock: SupervisorClock;
  /** 参数数组启动(shell=false 由实现保证);测试注入假进程句柄 */
  readonly spawn: (request: ConversionSpawnRequest) => ConversionProcessHandle;
  /** 硬件后端探测:null = 无可用硬件(直接软件路径);非空 = 后端标识(R7:不假定硬件);缺省内置按平台探测 */
  readonly hardwareBackend?: () => Promise<string | null>;
  /** ffmpeg 可执行名(缺省 PATH 上的 ffmpeg) */
  readonly ffmpegBin?: string;
  /** 私有产物目录解析(T026 ConversionStorageService 的任务目录;缺省相对 cwd) */
  readonly resolveOutputDirectory?: (request: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
  }) => string | undefined;
}

export interface ConversionStartInput {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly plan: ConversionPlanInput;
  readonly phase: 'prepare' | 'seek';
  /** 共用绝对期限(毫秒域注入时钟):prepare 首帧 30 秒 / seek 15 秒硬超时 */
  readonly deadlineAtMs: number;
  /** 源输入路径(T031 装配提供;缺省省略 -i,参数由装配层补齐) */
  readonly inputPath?: string;
}

/**
 * 启动观察结果:reserve+spawn 链为 fire-and-forget,结果按「await 观察时点」裁决 ——
 * 观察时仍有活动尝试(或已优雅终局)→ ok;观察时全部尝试无法启动/已稳定失败 → err。
 * (真实 Promise 单次结算无法同时满足「spawn 后即可 ok」与「启动失败序列后 err」。)
 */
class StartupObservation {
  constructor(private readonly observe: () => PlaybackResult<{ readonly conversionId: string }>) {}

  then<TResult1 = PlaybackResult<{ readonly conversionId: string }>, TResult2 = never>(
    onfulfilled?: ((value: PlaybackResult<{ readonly conversionId: string }>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      const value = this.observe();
      if (onfulfilled == null) {
        return Promise.resolve(value as unknown as TResult1);
      }
      return Promise.resolve(onfulfilled(value));
    } catch (error) {
      if (onrejected == null) {
        return Promise.reject(error);
      }
      return Promise.resolve(onrejected(error));
    }
  }
}

/** 监督中的转换任务(进程内持有;任务 PID 不入库不作重启依据,data-model) */
interface SupervisorTask {
  readonly conversionId: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly plan: ConversionPlanInput;
  readonly phase: 'prepare' | 'seek';
  readonly deadlineAtMs: number;
  readonly inputPath: string | undefined;
  attemptIndex: number;
  backend: 'hardware' | 'software';
  handle: ConversionProcessHandle | null;
  sawOutput: boolean;
  firstOutputSeen: boolean;
  mediaSecondsProduced: number;
  cancelRequested: boolean;
  deadlineTriggered: boolean;
  pauseBoundMediaSeconds: number | null;
  pauseArmed: boolean;
  settled: boolean;
  outcome: PlaybackResult<{ readonly conversionId: string }> | null;
  deadlineToken: number;
  graceToken: number;
}

/** 硬件后端探测缓存(进程级一次;探测失败/无后端 → null,R7 不假定硬件) */
let hardwareBackendProbe: Promise<string | null> | null = null;

/** 按平台硬件后端探测:ffmpeg -encoders 列表匹配 h264_<backend>;失败返回 null */
function detectHardwareBackend(ffmpegBin: string): Promise<string | null> {
  hardwareBackendProbe ??= (async () => {
    const candidates =
      process.platform === 'darwin'
        ? ['videotoolbox']
        : process.platform === 'linux'
          ? ['vaapi', 'qsv', 'nvenc']
          : process.platform === 'win32'
            ? ['nvenc', 'qsv', 'amf']
            : [];
    if (candidates.length === 0) {
      return null;
    }
    try {
      const listing = await execFile(ffmpegBin, ['-hide_banner', '-encoders'], { timeout: 5_000 });
      for (const backend of candidates) {
        if (listing.stdout.includes(`h264_${backend}`)) {
          return backend;
        }
      }
      return null;
    } catch {
      return null;
    }
  })();
  return hardwareBackendProbe;
}

export class ConversionSupervisorService {
  private readonly tasks = new Map<string, SupervisorTask>();

  constructor(private readonly deps: ConversionSupervisorDeps) {}

  /**
   * 启动转换:原子 reserve(满 → 立即 PLAYBACK_CONVERSION_BUSY,不排队不 spawn)→ 硬件探测 →
   * 参数数组 spawn(失败最多软件回退一次,共用原期限)。返回启动观察结果:
   * 活动尝试存在 → ok({conversionId});观察时全部尝试无法启动/已稳定失败 → err。
   */
  start(input: ConversionStartInput): Promise<PlaybackResult<{ readonly conversionId: string }>> {
    if (input.plan.mode === null) {
      // direct 交付不建转换行、不占额度(额度用例由计划层保证,此处兜底)
      return Promise.resolve(playbackErr('PLAYBACK_NOT_READY', 'direct 交付不创建转换任务'));
    }
    const reserved = this.deps.repository.reserveConversion({
      householdId: input.householdId,
      sessionId: input.sessionId,
      generation: input.generation,
      mode: input.plan.mode,
      outputVideoCodec: input.plan.outputVideoCodec,
      outputAudioCodec: input.plan.outputAudioCodec,
    });
    if (!reserved.ok) {
      // 满额(或同槽位重复预留):立即忙,不排队、绝不 spawn(R4)
      return Promise.resolve(reserved);
    }
    const conversionId = reserved.value.id;
    const task: SupervisorTask = {
      conversionId,
      householdId: input.householdId,
      sessionId: input.sessionId,
      generation: input.generation,
      plan: input.plan,
      phase: input.phase,
      deadlineAtMs: input.deadlineAtMs,
      inputPath: input.inputPath,
      attemptIndex: 0,
      backend: 'hardware',
      handle: null,
      sawOutput: false,
      firstOutputSeen: false,
      mediaSecondsProduced: 0,
      cancelRequested: false,
      deadlineTriggered: false,
      pauseBoundMediaSeconds: null,
      pauseArmed: false,
      settled: false,
      outcome: null,
      deadlineToken: 0,
      graceToken: 0,
    };
    this.tasks.set(conversionId, task);
    this.armDeadline(task);
    const hardwareBackend = this.deps.hardwareBackend ?? (() => detectHardwareBackend(this.deps.ffmpegBin ?? 'ffmpeg'));
    void (async () => {
      const backendLabel = await hardwareBackend();
      const first =
        backendLabel === null
          ? ({ backend: 'software', label: 'software' } as const)
          : ({ backend: 'hardware', label: backendLabel } as const);
      this.launchAttempt(task, 0, first.backend, first.label);
    })().catch(() => {
      // 探测意外失败:补偿释放从未启动的预留行(额度/槽位即刻可用)
      this.abandonWithoutStart(task);
    });
    return new StartupObservation(() => this.observeStartOutcome(task)) as unknown as Promise<
      PlaybackResult<{ readonly conversionId: string }>
    >;
  }

  /** 请求终止(换代/停止用):SIGTERM → 5 秒宽限 → SIGKILL;退出确认后才释放额度 */
  async cancel(conversionId: string): Promise<void> {
    const task = this.tasks.get(conversionId);
    if (task === undefined || task.settled) {
      return;
    }
    task.cancelRequested = true;
    this.signalStop(task);
  }

  /**
   * 暂停生产(主动暂停/节流,R8):有界预取 —— 允许再产出至多 prefetchMediaSeconds(缺省
   * 2 个目标分片时长)后 SIGSTOP;装配层应对称进入 T027 看门狗 legitimate wait。
   */
  pauseProduction(conversionId: string, options: { readonly prefetchMediaSeconds?: number } = {}): void {
    const task = this.tasks.get(conversionId);
    if (task === undefined || task.settled) {
      return;
    }
    const prefetch =
      options.prefetchMediaSeconds ?? this.deps.budgets.timeline.targetSegmentSeconds * 2;
    task.pauseBoundMediaSeconds = task.mediaSecondsProduced + prefetch;
  }

  /** 恢复生产:SIGCONT;装配层应对称退出看门狗 legitimate wait(无输出计时重新武装) */
  resumeProduction(conversionId: string): void {
    const task = this.tasks.get(conversionId);
    if (task === undefined) {
      return;
    }
    task.pauseBoundMediaSeconds = null;
    if (task.pauseArmed) {
      task.pauseArmed = false;
      task.handle?.kill('SIGCONT');
    }
  }

  /** 当前任务累计输出媒体秒(进度观察;T031 装配给看门狗/存储记账) */
  producedMediaSeconds(conversionId: string): number {
    return this.tasks.get(conversionId)?.mediaSecondsProduced ?? 0;
  }

  /** 观察时点裁决:全部尝试无法启动/已稳定失败 → err;仍有活动尝试/优雅终局 → ok */
  private observeStartOutcome(task: SupervisorTask): PlaybackResult<{ readonly conversionId: string }> {
    if (task.settled && task.outcome !== null) {
      return task.outcome;
    }
    return playbackOk({ conversionId: task.conversionId });
  }

  /** 单次尝试:参数数组构造 → spawn → 状态推进(reserved→starting 记 hardware_backend→running) */
  private launchAttempt(task: SupervisorTask, attemptIndex: number, backend: 'hardware' | 'software', backendLabel: string): boolean {
    const request: ConversionSpawnRequest = {
      conversionId: task.conversionId,
      householdId: task.householdId,
      sessionId: task.sessionId,
      generation: task.generation,
      attemptIndex,
      backend,
      argv: this.buildArgv(task, backend, backendLabel),
      deadlineAtMs: task.deadlineAtMs,
    };
    let handle: ConversionProcessHandle;
    try {
      handle = this.deps.spawn(request);
    } catch {
      if (attemptIndex === 0) {
        this.abandonWithoutStart(task);
      } else {
        this.settle(task, 'failed', 'PLAYBACK_RESOURCE_UNAVAILABLE');
      }
      return false;
    }
    task.attemptIndex = attemptIndex;
    task.backend = backend;
    task.handle = handle;
    task.sawOutput = false;
    if (attemptIndex === 0) {
      // started_at=进程成功启动;hardware_backend 于进入 starting 时一次性补记
      this.mark(task, 'starting', backendLabel);
      this.mark(task, 'running');
    }
    handle.on('exit', (code, signal) => this.onExit(task, code, signal));
    handle.on('stderr', (chunk) => this.onStderrChunk(task, chunk));
    handle.on('progress', (line) => this.onProgressLine(task, line));
    return true;
  }

  /** 退出分类:取消→interrupted;期限触发→相位超时;自然 0→stopping+ended;启动失败→回退/稳定失败 */
  private onExit(task: SupervisorTask, code: number | null, signal: string | null): void {
    if (task.settled) {
      return;
    }
    if (task.cancelRequested) {
      this.settle(task, 'interrupted');
      return;
    }
    if (task.deadlineTriggered) {
      this.settle(
        task,
        'failed',
        task.phase === 'prepare' ? 'PLAYBACK_PREPARE_TIMEOUT' : 'PLAYBACK_SEEK_TIMEOUT',
      );
      return;
    }
    if (code === 0 && signal === null) {
      this.settle(task, 'ended');
      return;
    }
    if (!task.sawOutput) {
      // 无任何输出即退出 = 初始化失败:硬件首选最多软件回退一次,共用原期限(R8)
      if (task.backend === 'hardware' && task.attemptIndex === 0) {
        this.launchAttempt(task, 1, 'software', 'software');
        return;
      }
      this.settle(task, 'failed', 'PLAYBACK_RESOURCE_UNAVAILABLE');
      return;
    }
    // 已产出后非自然退出:不做隐藏无限重试(R8),稳定资源/转换失败
    this.settle(task, 'failed', 'PLAYBACK_RESOURCE_UNAVAILABLE');
  }

  /** 共享绝对期限:任一尝试产出首帧即解除;否则 SIGTERM → 宽限 SIGKILL,退出后按相位映射 */
  private armDeadline(task: SupervisorTask): void {
    task.deadlineToken += 1;
    const token = task.deadlineToken;
    const waitMs = Math.max(0, task.deadlineAtMs - this.deps.clock.now());
    void this.deps.clock.delay(waitMs).then(() => {
      if (task.settled || token !== task.deadlineToken || task.firstOutputSeen) {
        return;
      }
      task.deadlineTriggered = true;
      this.signalStop(task);
    });
  }

  /** SIGTERM → sigtermGraceSeconds 宽限 → SIGKILL(确认退出前额度保持,R4/R5) */
  private signalStop(task: SupervisorTask): void {
    task.handle?.kill('SIGTERM');
    task.graceToken += 1;
    const token = task.graceToken;
    void this.deps.clock.delay(this.deps.budgets.watchdog.sigtermGraceSeconds * 1000).then(() => {
      if (task.settled || token !== task.graceToken) {
        return;
      }
      task.handle?.kill('SIGKILL');
    });
  }

  /** 确认退出终局:ended 先 stopping;failed 携带稳定码;interrupted 用于取消/换代 */
  private settle(task: SupervisorTask, finalState: 'ended' | 'failed' | 'interrupted', failureCode?: PlaybackErrorCode): void {
    if (task.settled) {
      return;
    }
    task.settled = true;
    task.outcome =
      finalState === 'failed'
        ? playbackErr(failureCode ?? 'PLAYBACK_RESOURCE_UNAVAILABLE', '转换任务稳定失败')
        : playbackOk({ conversionId: task.conversionId });
    this.tasks.delete(task.conversionId);
    if (finalState === 'ended') {
      this.mark(task, 'stopping');
    }
    this.deps.repository.releaseOnExit(task.conversionId, {
      finalState,
      ...(failureCode !== undefined ? { failureCode } : {}),
    });
  }

  /** spawn 从未成功:补偿删除预留行,额度与 UNIQUE 槽位即刻可用 */
  private abandonWithoutStart(task: SupervisorTask): void {
    if (task.settled) {
      return;
    }
    task.settled = true;
    task.outcome = playbackErr('PLAYBACK_RESOURCE_UNAVAILABLE', '转换进程无法启动');
    this.tasks.delete(task.conversionId);
    this.deps.repository.compensateRelease(task.householdId, task.conversionId);
  }

  /** 状态推进(非法迁移静默忽略 —— 终局路径已由 settle 释放) */
  private mark(task: SupervisorTask, state: 'starting' | 'running' | 'stopping', hardwareBackend?: string): void {
    this.deps.repository.markConversion(task.conversionId, {
      conversionId: task.conversionId,
      householdId: task.householdId,
      state,
      ...(hardwareBackend !== undefined ? { hardwareBackend } : {}),
    });
  }

  /** 进度行(-progress 管道):out_time_us/out_time_ms(均为微秒)/out_time= 时钟 */
  private onProgressLine(task: SupervisorTask, line: string): void {
    const trimmed = line.trim();
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return;
    }
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1).trim();
    let micros: number | null = null;
    if (key === 'out_time_us' || key === 'out_time_ms') {
      const parsed = Number(value);
      micros = Number.isFinite(parsed) ? parsed : null;
    } else if (key === 'out_time') {
      micros = parseClockToMicros(value);
    }
    this.noteActivity(task, micros === null ? undefined : micros / 1_000_000);
  }

  /** stderr 进度:time=HH:MM:SS.mmm 行(缺省 stderr 编码输出) */
  private onStderrChunk(task: SupervisorTask, chunk: string): void {
    let latestSeconds: number | null = null;
    for (const match of chunk.matchAll(/time=(\d+):(\d{2}):(\d+(?:\.\d+)?)/g)) {
      const hours = Number(match[1] ?? '0');
      const minutes = Number(match[2] ?? '0');
      const seconds = Number(match[3] ?? '0');
      latestSeconds = hours * 3600 + minutes * 60 + seconds;
    }
    this.noteActivity(task, latestSeconds ?? undefined);
  }

  /** 输出活动:解除共享期限(首帧产出);推进媒体秒;有界预取到量 SIGSTOP(R8 节流) */
  private noteActivity(task: SupervisorTask, mediaSeconds?: number): void {
    task.sawOutput = true;
    if (!task.firstOutputSeen) {
      task.firstOutputSeen = true;
      task.deadlineToken += 1;
    }
    if (mediaSeconds !== undefined && Number.isFinite(mediaSeconds) && mediaSeconds > task.mediaSecondsProduced) {
      task.mediaSecondsProduced = mediaSeconds;
    }
    const bound = task.pauseBoundMediaSeconds;
    if (bound !== null && !task.pauseArmed && task.mediaSecondsProduced >= bound) {
      task.pauseArmed = true;
      task.handle?.kill('SIGSTOP');
    }
  }

  /** 参数数组构造(shell=false):plan 输出 + budgets 数值 → ffmpeg argv */
  private buildArgv(task: SupervisorTask, backend: 'hardware' | 'software', backendLabel: string): string[] {
    const args: string[] = ['-hide_banner', '-nostdin', '-y'];
    if (task.inputPath !== undefined) {
      args.push('-i', task.inputPath);
    }
    args.push('-map', '0:v:0', '-map', '0:a:0?');
    const conversion = this.deps.budgets.conversion;
    switch (task.plan.mode) {
      case 'remux':
        // 转封装保留原始编码(FR-012);静音合法视频显式 -an
        args.push('-c:v', 'copy');
        if (task.plan.outputAudioCodec === 'none') {
          args.push('-an');
        } else {
          args.push('-c:a', 'copy');
        }
        break;
      case 'audio_transcode':
        // 仅音频转码,视频 copy 不重编码
        args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', String(conversion.audioTargetBitrateBps));
        break;
      case 'video_transcode': {
        // 硬件优先:h264_<backend>;软件回退 libx264 + budgets 线程/码率/1080p 上限
        if (backend === 'hardware') {
          args.push('-c:v', `h264_${backendLabel}`);
        } else {
          args.push('-c:v', 'libx264', '-threads', String(conversion.softwareThreadsPerTask), '-preset', 'veryfast');
        }
        args.push(
          '-b:v',
          String(conversion.videoTargetBitrateBps),
          '-maxrate',
          String(conversion.videoMaxBitrateBps),
          '-bufsize',
          String(conversion.videoMaxBitrateBps * 2),
          '-vf',
          `scale=-2:min(ih\\,${conversion.targetHeightPx})`,
          '-pix_fmt',
          'yuv420p',
        );
        if (task.plan.outputAudioCodec === 'none') {
          args.push('-an');
        } else {
          args.push('-c:a', 'aac', '-b:a', String(conversion.audioTargetBitrateBps));
        }
        break;
      }
      default:
        break;
    }
    // 私有滚动 HLS(T026 目录;不公开静态产物,交付经网关资产流)
    const timeline = this.deps.budgets.timeline;
    const outputDirectory = this.deps.resolveOutputDirectory?.({
      householdId: task.householdId,
      sessionId: task.sessionId,
      generation: task.generation,
    });
    const playlistPath = outputDirectory === undefined ? 'window.m3u8' : path.join(outputDirectory, 'window.m3u8');
    const segmentPattern = outputDirectory === undefined ? 'seg%05d.ts' : path.join(outputDirectory, 'seg%05d.ts');
    args.push(
      '-f',
      'hls',
      '-hls_time',
      String(timeline.targetSegmentSeconds),
      '-hls_list_size',
      String(Math.max(1, Math.ceil(timeline.rollingWindowSeconds / Math.max(1, timeline.targetSegmentSeconds)))),
      '-hls_delete_threshold',
      '1',
      '-hls_flags',
      'delete_segments+independent_segments',
      '-hls_segment_filename',
      segmentPattern,
      playlistPath,
    );
    return args;
  }
}

/** "HH:MM:SS(.ffffff)" → 微秒(负值仅出现在异常流,按符号处理) */
function parseClockToMicros(value: string): number | null {
  const match = /^(-)?(\d+):(\d{2}):(\d+(?:\.\d+)?)$/.exec(value);
  if (match === null) {
    return null;
  }
  const sign = match[1] === undefined ? 1 : -1;
  const hours = Number(match[2] ?? '0');
  const minutes = Number(match[3] ?? '0');
  const seconds = Number(match[4] ?? '0');
  return sign * Math.round((hours * 3600 + minutes * 60 + seconds) * 1_000_000);
}
