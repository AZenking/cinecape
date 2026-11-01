import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile as execFileCb, execFileSync, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type DatabaseConstructor from 'better-sqlite3';
import { createManualClock, type ManualClock } from '../../fixtures/clock';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '@platform/config/playback-budgets';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import {
  PLAYBACK_CONVERSION_TRANSITIONS,
  PLAYBACK_STABLE_ERROR_CODES,
  isPlaybackConversionTransition,
  isPlaybackStableErrorCode,
  type PlaybackConversionMode,
  type PlaybackErrorCode,
  type PlaybackOk,
  type PlaybackResult,
} from '../../../src/contexts/playback/domain/playback.types';

/**
 * T016(spec 004,US1)—— 转换域失败矩阵单元测试(TDD 先行:只写失败测试,不实现)。
 *
 * 权威依据(先读后写):
 * - research.md R4:probe 并发 2/队列 8/10 秒/1MiB;并发额度原子 reserve 不排队;
 *   首次准备 30 秒/seek 15 秒硬超时;每 10 秒采样最近 30 秒速度,连续 3 次 <1x 且
 *   可播放缓冲 <8 秒判 PLAYBACK_PERFORMANCE_INSUFFICIENT;磁盘 512MiB/任务、2GiB 全局、
 *   余量 <1GiB 禁新转换并停止写入(PLAYBACK_STORAGE_LIMIT)。
 * - research.md R8:硬件初始化/编码失败最多回退软件一次且共用原期限;已开始交付不隐藏重试;
 *   速度判罚排除主动暂停/生产窗口节流/客户端暂停;15 秒无输出且非正常等待终止;
 *   SIGTERM 5 秒宽限后 SIGKILL。
 * - data-model.md「## 资源选择与模型权威性」:probe 失败/不支持试下一候选,共用首次 30 秒期限,
 *   无可用路径稳定失败,不隐藏无限重试;「## playback_conversion」:state 8 枚举、
 *   cleanup_state 仅 pending/complete、UNIQUE(household,session,generation)、reserved～stopping 计额。
 * - spec.md FR-012/FR-014/FR-015/FR-016/FR-018:direct→remux→audio_transcode→video_transcode
 *   优先级;MP4/MKV/AVI/MOV/TS × H.264/8-10bit HEVC/MPEG-4 × AAC/AC-3/E-AC-3/DTS,最高 1080p SDR;
 *   4K/HDR 仅尽力直放,不保证转换、不自动降分辨率;转封装保留原始编码;直接播放不占额度。
 * - tasks.md T016:本文件;时钟/进程夹具与真实 FFmpeg 测试明确分层。
 *
 * 分层(任务要求的「假时钟/假进程为主,真实 FFmpeg 单独 describe」):
 * - 第 0 层:playback.types 纯数据表先行断言(允许绿;T011 已实现);
 * - 第 1 层:假时钟(test/fixtures/clock ManualClock)+ 假进程句柄工厂(可编程 exit/kill/
 *   stdout/stderr/progress 事件序列),覆盖 probe/格式计划/软件回退/额度/看门狗/磁盘/generation/取消;
 * - 第 2 层:「真实FFmpeg层」describe:本机 ffmpeg/ffprobe(8.1.1)生成 2 秒 testsrc+aac 源,
 *   真实 -c copy 转封装冒烟;无 ffmpeg 时 skip 而非 fail(本机已确认可用,应执行)。
 *
 * 对 T023–T027 的接口契约(实现即转绿):
 * - 本文件为 TDD 先行,T023 media-probe.service.ts / T024 playback-plan.service.ts /
 *   T025 conversion-supervisor.service.ts / T026 conversion-storage.service.ts /
 *   T027 conversion-watchdog.service.ts 尚不存在;
 * - 装载器 loadFutureModule 用「计算型相对路径动态 import」:tsc 不静态解析(本文件不新增
 *   typecheck 错误),运行时由 vite-node 解析;模块缺失 → 用例以「T0xx 未实现」清晰失败(RED),
 *   实现后自动装载转绿;
 * - 各服务的最小结构契约以本文件内 XxxLike 接口为准(见各 describe 前注释),导出名:
 *   MediaProbeService / PlaybackPlanService / ConversionSupervisorService /
 *   ConversionStorageService / ConversionWatchdogService;
 * - 时间常量一律读 createPlaybackBudgets(不写魔数),数值正确性由 T010 config.spec 权威覆盖。
 */

/* ------------------------------------------------------------------ */
/* 未来模块装载器(TDD RED 通道)                                        */
/* ------------------------------------------------------------------ */

/** 007-T017:模块按四层落位,动态装载路径按各文件所在层解析 */
function playbackModuleDir(moduleName: string): string {
  return moduleName === 'playback-plan.service' || moduleName === 'conversion-watchdog.service'
    ? '../../../src/contexts/playback/application'
    : '../../../src/contexts/playback/infrastructure';
}

async function loadFutureModule(moduleName: string, task: string, exportName: string): Promise<unknown> {
  let mod: unknown;
  try {
    // 刻意使用模板字符串拼接:tsc 无法静态解析,缺失模块在运行时才拒绝 → 逐用例 RED。
    mod = await import(`${playbackModuleDir(moduleName)}/${moduleName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${task}] src/contexts/playback/**/${moduleName}.ts 尚未实现 —— T016 先行失败测试(RED 属预期,实现后本用例自动转绿): ${message}`);
  }
  const exported = (mod as Record<string, unknown>)[exportName];
  if (typeof exported !== 'function') {
    throw new Error(`[${task}] ${moduleName}.ts 缺少函数导出 ${exportName}(契约见 conversion.spec.ts 头部与各 describe 注释)`);
  }
  return exported;
}

/* ------------------------------------------------------------------ */
/* 结构契约:T023 probe                                                 */
/* ------------------------------------------------------------------ */

/** 结构化最小时钟(test/fixtures/clock 的 ManualClock 结构兼容) */
interface TestClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

interface ProbeSpawnRequest {
  readonly candidateId: string;
  readonly inputPath: string;
  /** shell=false 参数数组(ffprobe);服务负责构造,夹具只记录断言 */
  readonly argv: readonly string[];
}

interface ProbeProcessHandle {
  readonly pid: number;
  on(event: 'stdout', listener: (chunk: string | Uint8Array) => void): ProbeProcessHandle;
  on(event: 'stderr', listener: (chunk: string) => void): ProbeProcessHandle;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): ProbeProcessHandle;
  kill(signal?: string): boolean;
}

/** 可信 probe 事实(T023 输出;T024 输入):container 归一化 ∈ mp4/mkv/avi/mov/ts */
interface ProbeVideoFacts {
  readonly codec: string;
  readonly bitDepth: number;
  readonly pixFmt: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly hdr: boolean;
}

interface ProbeFacts {
  readonly container: string;
  readonly durationSeconds: number;
  readonly video: ProbeVideoFacts | null;
  readonly audio: { readonly codec: string } | null;
  /** 服务器分配的稳定轨道 ID(选轨只接受服务器返回 ID;R3/T023) */
  readonly tracks: readonly { readonly id: string; readonly kind: 'video' | 'audio' | 'subtitle'; readonly codec: string }[];
}

interface MediaProbeServiceDeps {
  readonly budgets: PlaybackBudgets;
  readonly clock: TestClock;
  readonly spawn: (request: ProbeSpawnRequest) => ProbeProcessHandle;
}

/**
 * probe 服务契约:按候选顺序尝试;probe 失败(10 秒超时/输出超 1MiB/非零退出/输出不可解析)
 * 尝试下一候选;全部候选共用同一绝对期限,超期后不再尝试剩余候选。
 */
interface MediaProbeServiceLike {
  probeFirstAvailable(
    candidates: readonly { readonly candidateId: string; readonly inputPath: string }[],
    deadline: { readonly atMs: number },
  ): Promise<PlaybackResult<ProbeFacts>>;
}

type MediaProbeServiceCtor = new (deps: MediaProbeServiceDeps) => MediaProbeServiceLike;

async function loadMediaProbeService(): Promise<MediaProbeServiceCtor> {
  return loadFutureModule('media-probe.service', 'T023', 'MediaProbeService') as Promise<MediaProbeServiceCtor>;
}

/* ------------------------------------------------------------------ */
/* 结构契约:T024 格式计划                                              */
/* ------------------------------------------------------------------ */

/** 计划结果:direct 时 mode=null(不建转换行、不占额度);remux 直通轨道 copy;静音 'none' */
interface ConversionPlan {
  readonly delivery: 'direct' | 'remux' | 'audio_transcode' | 'video_transcode';
  readonly mode: PlaybackConversionMode | null;
  readonly outputVideoCodec: string;
  readonly outputAudioCodec: string;
  readonly reason: string;
}

interface PlaybackPlanServiceDeps {
  readonly budgets: PlaybackBudgets;
}

interface PlaybackPlanServiceLike {
  plan(facts: ProbeFacts): PlaybackResult<ConversionPlan>;
}

type PlaybackPlanServiceCtor = new (deps: PlaybackPlanServiceDeps) => PlaybackPlanServiceLike;

async function loadPlaybackPlanService(): Promise<PlaybackPlanServiceCtor> {
  return loadFutureModule('playback-plan.service', 'T024', 'PlaybackPlanService') as Promise<PlaybackPlanServiceCtor>;
}

/* ------------------------------------------------------------------ */
/* 结构契约:T025 转换监督                                              */
/* ------------------------------------------------------------------ */

interface ConversionSpawnRequest {
  readonly conversionId: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  /** 0=硬件首选,1=软件回退(最多一次,R8) */
  readonly attemptIndex: number;
  readonly backend: 'hardware' | 'software';
  /** shell=false 参数数组(ffmpeg);夹具断言为数组且元素全为字符串 */
  readonly argv: readonly string[];
  /** 共用绝对期限(毫秒域注入时钟);硬件失败回退不重置(R8) */
  readonly deadlineAtMs: number;
}

interface ConversionProcessHandle {
  readonly pid: number;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): ConversionProcessHandle;
  on(event: 'stderr', listener: (chunk: string) => void): ConversionProcessHandle;
  /** FFmpeg 机器可读 progress 行(-progress 管道;T025 进度读取) */
  on(event: 'progress', listener: (line: string) => void): ConversionProcessHandle;
  kill(signal: string): boolean;
}

interface ConversionSupervisorDeps {
  readonly repository: PlaybackRepository;
  readonly budgets: PlaybackBudgets;
  readonly clock: TestClock;
  readonly spawn: (request: ConversionSpawnRequest) => ConversionProcessHandle;
  /** 硬件后端探测:null = 无可用硬件(直接软件路径);非空 = 后端标识(R7:不假定硬件) */
  readonly hardwareBackend: () => Promise<string | null>;
}

/**
 * 监督器契约:start 在 reserve+spawn 成功后即 resolve(监督为 fire-and-forget,
 * 终态经仓储行/额度观察);无法启动任何尝试时 resolve err 稳定码。
 * 期限(30s/15s 硬超时)、SIGTERM→5s→SIGKILL、退出确认后释放额度均为监督器职责。
 */
interface ConversionSupervisorServiceLike {
  start(request: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly plan: ConversionPlan;
    readonly phase: 'prepare' | 'seek';
    readonly deadlineAtMs: number;
  }): Promise<PlaybackResult<{ readonly conversionId: string }>>;
  cancel(conversionId: string): Promise<void>;
}

type ConversionSupervisorServiceCtor = new (deps: ConversionSupervisorDeps) => ConversionSupervisorServiceLike;

async function loadConversionSupervisorService(): Promise<ConversionSupervisorServiceCtor> {
  return loadFutureModule('conversion-supervisor.service', 'T025', 'ConversionSupervisorService') as Promise<ConversionSupervisorServiceCtor>;
}

/* ------------------------------------------------------------------ */
/* 结构契约:T026 转换存储                                              */
/* ------------------------------------------------------------------ */

interface StorageTaskRef {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
}

interface ConversionTaskWriterLike {
  /** 稳定任务键(pendingCleanupTasks 以此报告) */
  readonly taskKey: string;
  /** 私有产物目录(私有根按 household/session/generation 派生;plan.md Technical Context) */
  readonly directory: string;
  /** 记账式写入:按字节计额;超任务 512MiB/全局 2GiB/磁盘余量阈值 → PLAYBACK_STORAGE_LIMIT 且此后拒绝写入 */
  append(sizeBytes: number): Promise<PlaybackResult<{ readonly bytesOnDisk: number }>>;
  bytesOnDisk(): number;
}

interface ConversionStorageDeps {
  readonly budgets: PlaybackBudgets;
  readonly rootDir: string;
  readonly clock: TestClock;
  /** 数据卷剩余字节(注入,替代真实 statfs) */
  readonly freeDiskBytes: () => number;
  /** 目录删除(注入可失败实现:验证清理失败保持 pending 计额并 60 秒重试,R5) */
  readonly removeDirectory: (directory: string) => Promise<void>;
}

interface ConversionStorageServiceLike {
  openTask(task: StorageTaskRef): Promise<PlaybackResult<ConversionTaskWriterLike>>;
  totalBytesOnDisk(): number;
  /** 删除目录;失败保持 pending(cleanup_state 语义)并按 cleanupRetrySeconds 重试 */
  releaseTask(task: StorageTaskRef): Promise<void>;
  /** 清理失败仍计预算:处于 pending 重试态的任务键 */
  pendingCleanupTasks(): readonly string[];
}

type ConversionStorageServiceCtor = new (deps: ConversionStorageDeps) => ConversionStorageServiceLike;

async function loadConversionStorageService(): Promise<ConversionStorageServiceCtor> {
  return loadFutureModule('conversion-storage.service', 'T026', 'ConversionStorageService') as Promise<ConversionStorageServiceCtor>;
}

/* ------------------------------------------------------------------ */
/* 结构契约:T027 看门狗                                                */
/* ------------------------------------------------------------------ */

interface ConversionWatchdogDeps {
  readonly budgets: PlaybackBudgets;
  readonly clock: TestClock;
  /** 当前可播放缓冲秒数(监督者提供;速度判罚要求 <8 秒才成立) */
  readonly playableBufferSeconds: () => number;
  /** 看门狗裁决:监督者据此执行终止并映射稳定失败;恰一次 */
  readonly onTerminate: (code: PlaybackErrorCode, detail: string) => void;
}

/**
 * 看门狗契约(T027/R4/R8):
 * - begin('prepare'|'seek')武装相位硬超时(30s→PLAYBACK_PREPARE_TIMEOUT / 15s→PLAYBACK_SEEK_TIMEOUT),
 *   noteFirstOutput 解除;
 * - noteOutput(累计输出媒体秒)驱动:每 10 秒采样最近 30 秒窗口速度(窗口不足 30 秒按可用历史
 *   计算;开始后每 10 秒即采样),连续 3 次 speed<1 且缓冲<8 秒 → PLAYBACK_PERFORMANCE_INSUFFICIENT;
 * - 15 秒无输出且非正常等待 → PLAYBACK_RESOURCE_UNAVAILABLE(R8 资源/转换稳定失败);
 *   enterLegitimateWait(主动暂停/有界预取节流/客户端暂停)期间挂起无输出与速度判罚,
 *   exitLegitimateWait 后无输出计时重新武装完整 15 秒(暂停期不计罚,避免误杀)。
 */
interface ConversionWatchdogServiceLike {
  begin(phase: 'prepare' | 'seek'): void;
  noteFirstOutput(): void;
  noteOutput(mediaSeconds: number): void;
  enterLegitimateWait(): void;
  exitLegitimateWait(): void;
  dispose(): void;
}

type ConversionWatchdogServiceCtor = new (deps: ConversionWatchdogDeps) => ConversionWatchdogServiceLike;

async function loadConversionWatchdogService(): Promise<ConversionWatchdogServiceCtor> {
  return loadFutureModule('conversion-watchdog.service', 'T027', 'ConversionWatchdogService') as Promise<ConversionWatchdogServiceCtor>;
}

/* ------------------------------------------------------------------ */
/* 通用夹具                                                            */
/* ------------------------------------------------------------------ */

/** 结果断言:ok 展开值;err 时失败并携带 code/detail 便于定位(与 repository.spec 同款) */
function expectOk<T>(result: PlaybackResult<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as PlaybackOk<T>).value;
}

/** 结果断言:稳定失败码必须精确匹配 */
function expectErr<T>(result: PlaybackResult<T>, code: PlaybackErrorCode): void {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

/** 排空微任务队列(等待服务内部 await 链推进到下一个 spawn/落库点) */
async function flushMicrotasks(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 带越界失败的索引访问(noUncheckedIndexedAccess 下统一收窄,断言可读) */
function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`索引越界:index=${index},length=${items.length}`);
  }
  return item;
}

function testBudgets(envOverrides: Record<string, string> = {}): PlaybackBudgets {
  return createPlaybackBudgets(
    loadEnv({ NODE_ENV: 'test', DATA_DIR: os.tmpdir(), DB_FILENAME: 't016-budgets.hmp.db', ...envOverrides }),
  );
}

const execFileAsync = promisify(execFileCb);

/* ------------------------------------------------------------------ */
/* 第 0 层:playback.types 纯数据表先行断言(T011 已实现,允许绿)          */
/* ------------------------------------------------------------------ */

describe('T016 第0层:转换域纯数据表先行断言(T011 playback.types,允许绿)', () => {
  it('转换迁移表:spawn 前可选 probing;退出先 stopping 再 ended;失败/中断可从任一非终态直接进入;终态空表', () => {
    // 预留后可先探测或直接启动(spawn 前可选 probing)
    expect(isPlaybackConversionTransition('reserved', 'probing')).toBe(true);
    expect(isPlaybackConversionTransition('reserved', 'starting')).toBe(true);
    expect(isPlaybackConversionTransition('probing', 'starting')).toBe(true);
    expect(isPlaybackConversionTransition('starting', 'running')).toBe(true);
    // 运行退出必须先 stopping 再 ended(确认退出后才释放额度)
    expect(isPlaybackConversionTransition('running', 'stopping')).toBe(true);
    expect(isPlaybackConversionTransition('stopping', 'ended')).toBe(true);
    // 失败/中断可从任一非终态直接进入
    expect(isPlaybackConversionTransition('running', 'failed')).toBe(true);
    expect(isPlaybackConversionTransition('stopping', 'interrupted')).toBe(true);
    expect(isPlaybackConversionTransition('reserved', 'interrupted')).toBe(true);
    // 非法:跳过启动/重新探测/starting 直落 stopping
    expect(isPlaybackConversionTransition('reserved', 'running')).toBe(false);
    expect(isPlaybackConversionTransition('running', 'probing')).toBe(false);
    expect(isPlaybackConversionTransition('starting', 'stopping')).toBe(false);
    // 终态空表(不可复活)
    for (const terminal of ['ended', 'failed', 'interrupted'] as const) {
      expect(PLAYBACK_CONVERSION_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('本文件失败矩阵使用的稳定码全部落在 T011 的 17 稳定码词表内', () => {
    expect(PLAYBACK_STABLE_ERROR_CODES).toHaveLength(17);
    const usedInThisMatrix: readonly PlaybackErrorCode[] = [
      'PLAYBACK_PREPARE_TIMEOUT',
      'PLAYBACK_SEEK_TIMEOUT',
      'PLAYBACK_PERFORMANCE_INSUFFICIENT',
      'PLAYBACK_STORAGE_LIMIT',
      'PLAYBACK_CONVERSION_BUSY',
      'PLAYBACK_FORMAT_UNSUPPORTED',
      'PLAYBACK_RESOURCE_UNAVAILABLE',
    ];
    for (const code of usedInThisMatrix) {
      expect(isPlaybackStableErrorCode(code), code).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 假进程句柄工厂(第 1 层核心夹具)                                      */
/* ------------------------------------------------------------------ */

interface FakeProbeProcess {
  readonly handle: ProbeProcessHandle;
  readonly signals: string[];
  emitStdout(chunk: string | Uint8Array): void;
  emitStderr(chunk: string): void;
  emitExit(code: number | null, signal: string | null): void;
}

function createFakeProbeProcess(pid: number): FakeProbeProcess {
  const signals: string[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let exited = false;
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };
  const handle: ProbeProcessHandle = {
    pid,
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      listeners.set(event, list);
      return handle;
    },
    kill(signal) {
      if (exited) {
        return false;
      }
      signals.push(signal ?? 'SIGTERM');
      return true;
    },
  };
  return {
    handle,
    signals,
    emitStdout: (chunk) => emit('stdout', chunk),
    emitStderr: (chunk) => emit('stderr', chunk),
    emitExit: (code, signal) => {
      exited = true;
      emit('exit', code, signal);
    },
  };
}

interface ProbeHarness {
  readonly requests: ProbeSpawnRequest[];
  readonly processes: FakeProbeProcess[];
  readonly spawn: (request: ProbeSpawnRequest) => ProbeProcessHandle;
}

function createProbeHarness(): ProbeHarness {
  const requests: ProbeSpawnRequest[] = [];
  const processes: FakeProbeProcess[] = [];
  return {
    requests,
    processes,
    spawn: (request) => {
      requests.push(request);
      const fake = createFakeProbeProcess(3000 + processes.length);
      processes.push(fake);
      return fake.handle;
    },
  };
}

interface FakeConversionProcess {
  readonly handle: ConversionProcessHandle;
  readonly signals: string[];
  emitStderr(chunk: string): void;
  emitProgressLine(line: string): void;
  emitExit(code: number | null, signal: string | null): void;
}

function createFakeConversionProcess(pid: number): FakeConversionProcess {
  const signals: string[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let exited = false;
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args);
    }
  };
  const handle: ConversionProcessHandle = {
    pid,
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      listeners.set(event, list);
      return handle;
    },
    kill(signal) {
      if (exited) {
        return false;
      }
      signals.push(signal);
      return true;
    },
  };
  return {
    handle,
    signals,
    emitStderr: (chunk) => emit('stderr', chunk),
    emitProgressLine: (line) => emit('progress', line),
    emitExit: (code, signal) => {
      exited = true;
      emit('exit', code, signal);
    },
  };
}

interface SupervisorSpawnHarness {
  readonly requests: ConversionSpawnRequest[];
  readonly processes: FakeConversionProcess[];
  readonly spawn: (request: ConversionSpawnRequest) => ConversionProcessHandle;
  last(): FakeConversionProcess;
}

function createSupervisorSpawnHarness(): SupervisorSpawnHarness {
  const requests: ConversionSpawnRequest[] = [];
  const processes: FakeConversionProcess[] = [];
  return {
    requests,
    processes,
    spawn: (request) => {
      requests.push(request);
      const fake = createFakeConversionProcess(4000 + processes.length);
      processes.push(fake);
      return fake.handle;
    },
    last: () => {
      const fake = processes[processes.length - 1];
      if (fake === undefined) {
        throw new Error('尚无被 spawn 的假进程');
      }
      return fake;
    },
  };
}

/* ------------------------------------------------------------------ */
/* ffprobe JSON 夹具(第 1 层 probe 用;canonical -show_streams -show_format) */
/* ------------------------------------------------------------------ */

interface ffprobeStreamOverrides {
  readonly pixFmt?: string;
  readonly bitDepth?: number;
  readonly widthPx?: number;
  readonly heightPx?: number;
  readonly colorTransfer?: string;
}

function ffprobeVideoStream(codec: string, overrides: ffprobeStreamOverrides = {}): Record<string, unknown> {
  return {
    index: 0,
    codec_name: codec,
    codec_type: 'video',
    pix_fmt: overrides.pixFmt ?? 'yuv420p',
    bits_per_raw_sample: String(overrides.bitDepth ?? 8),
    width: overrides.widthPx ?? 1920,
    height: overrides.heightPx ?? 1080,
    color_transfer: overrides.colorTransfer ?? 'bt709',
  };
}

function ffprobeAudioStream(codec: string): Record<string, unknown> {
  return { index: 1, codec_name: codec, codec_type: 'audio', sample_fmt: 'fltp' };
}

function ffprobeJson(formatName: string, durationSeconds: number, streams: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    streams,
    format: { format_name: formatName, duration: durationSeconds.toFixed(6) },
  });
}

/* ------------------------------------------------------------------ */
/* DB 夹具(仅监督器/额度用例需要;模式与 repository.spec 一致)            */
/* ------------------------------------------------------------------ */

interface ConversionDbRig {
  readonly dataDir: string;
  readonly repo: PlaybackRepository;
  readonly budgets: PlaybackBudgets;
  readonly db: DatabaseConstructor.Database;
  readonly ids: {
    readonly householdId: string;
    readonly accountId: string;
    readonly profileId: string;
    readonly deviceId: string;
    readonly deviceSessionId: string;
    readonly mediaId: string;
  };
}

const rigs: ConversionDbRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function bootstrapConversionRig(): ConversionDbRig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t016-conversion-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
      PLAYBACK_CONVERSION_CONCURRENCY: '1',
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  // 010 收敛:rig 迁移清单补到 0007(playback 查询面已含 0007 列,如 playback_session.cleanup_state)
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience', '0007_online_vod']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  // 转换并发额度压缩为 1(R4 默认 1):监督器/额度用例只允许一个活动任务
  const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_CONVERSION_CONCURRENCY: '1' }));
  const now = new Date().toISOString();
  const ids = {
    householdId: randomUUID(),
    accountId: randomUUID(),
    profileId: randomUUID(),
    deviceId: randomUUID(),
    deviceSessionId: randomUUID(),
    mediaId: randomUUID(),
  };
  Database.db.transaction(() => {
    Database.db.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(ids.householdId, 'T016 转换测试家庭', now);
    Database.db.prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(ids.accountId, ids.householdId, 't016', 't016', 'hash', 'owner', now);
    Database.db.prepare(
      'INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, failed_pin_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(ids.profileId, ids.householdId, ids.accountId, 'T016 档案', 'adult', 0, 'active', 0, now);
    Database.db.prepare('INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, ?, ?)').run(ids.deviceId, ids.householdId, 'tv', now);
    Database.db.prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(ids.deviceSessionId, ids.householdId, ids.accountId, ids.deviceId, `hash-${ids.deviceSessionId}`, '2030-01-01T00:00:00.000Z', now, now);
    Database.db.prepare(
      'INSERT INTO media_item (id, household_id, type, title, version, title_overridden, type_overridden, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?)',
    ).run(ids.mediaId, ids.householdId, 'movie', 'T016 测试影片', now, now);
  })();
  const rig: ConversionDbRig = { dataDir, repo: new PlaybackRepository(Database.db, budgets), budgets, db: Database.db, ids };
  rigs.push(rig);
  return rig;
}

/** 仓储建 preparing 会话(满足 playback_conversion 复合外键) */
function createRigSession(rig: ConversionDbRig): string {
  const created = rig.repo.createSession({
    householdId: rig.ids.householdId,
    deviceSessionId: rig.ids.deviceSessionId,
    deviceId: rig.ids.deviceId,
    profileId: rig.ids.profileId,
    mediaId: rig.ids.mediaId,
  });
  return expectOk(created).id;
}

interface ConversionRowSnapshot {
  readonly state: string;
  readonly hardwareBackend: string | null;
  readonly failureCode: string | null;
}

function readConversionRow(conversionId: string): ConversionRowSnapshot {
  const row = Database.db
    .prepare('SELECT state, hardware_backend, failure_code FROM playback_conversion WHERE id = ?')
    .get(conversionId) as { state: string; hardware_backend: string | null; failure_code: string | null } | undefined;
  if (row === undefined) {
    throw new Error(`转换行应存在:${conversionId}`);
  }
  return { state: row.state, hardwareBackend: row.hardware_backend, failureCode: row.failure_code };
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 第 1 层:probe 失败矩阵(T023)                                       */
/* ------------------------------------------------------------------ */

describe('T016 第1层:probe 失败矩阵(T023 media-probe.service;R4/data-model 资源选择)', () => {
  it('probe 进程 10 秒无退出 → 终止子进程并返回 PLAYBACK_PREPARE_TIMEOUT(ffprobe 硬超时)', async () => {
    const Ctor = await loadMediaProbeService();
    const harness = createProbeHarness();
    const clock = createManualClock();
    const service = new Ctor({ budgets: testBudgets(), clock, spawn: harness.spawn });

    const pending = service.probeFirstAvailable([{ candidateId: 'c1', inputPath: '/nas/a.mkv' }], {
      atMs: clock.now() + 30_000,
    });
    await flushMicrotasks();
    expect(harness.requests).toHaveLength(1);
    // shell=false 参数数组
    expect(Array.isArray(nth(harness.requests, 0).argv)).toBe(true);
    for (const arg of nth(harness.requests, 0).argv) {
      expect(typeof arg).toBe('string');
    }

    await clock.advance(testBudgets().probe.timeoutSeconds * 1000 - 1);
    expect(nth(harness.processes, 0).signals, '10 秒硬超时前不得终止').toHaveLength(0);
    await clock.advance(1);
    expect(nth(harness.processes, 0).signals.length, '超时后必须终止 probe 子进程').toBeGreaterThan(0);

    expectErr(await pending, 'PLAYBACK_PREPARE_TIMEOUT');
  });

  it('probe 输出超 1MiB → 截断拒绝视为 probe 失败,终止该进程并尝试下一候选', async () => {
    const Ctor = await loadMediaProbeService();
    const harness = createProbeHarness();
    const clock = createManualClock();
    const service = new Ctor({ budgets: testBudgets(), clock, spawn: harness.spawn });

    const pending = service.probeFirstAvailable(
      [
        { candidateId: 'overflow', inputPath: '/nas/big.json.mkv' },
        { candidateId: 'good', inputPath: '/nas/good.mp4' },
      ],
      { atMs: clock.now() + 30_000 },
    );
    await flushMicrotasks();
    nth(harness.processes, 0).emitStdout('x'.repeat(testBudgets().probe.maxOutputBytes + 1));
    nth(harness.processes, 0).emitExit(0, null);
    await flushMicrotasks();

    expect(harness.requests.length, '超限候选被拒绝后必须尝试下一候选').toBe(2);
    expect(nth(harness.processes, 0).signals.length, '超限进程必须被终止(有界输出预算)').toBeGreaterThan(0);

    nth(harness.processes, 1).emitStdout(ffprobeJson('mov,mp4,m4a,3gp,3g2,mj2', 600, [ffprobeVideoStream('h264'), ffprobeAudioStream('aac')]));
    nth(harness.processes, 1).emitExit(0, null);

    const facts = expectOk(await pending);
    expect(facts.video?.codec).toBe('h264');
    expect(nth(harness.requests, 1).candidateId).toBe('good');
  });

  it('probe 非零退出 → 视为失败并尝试下一候选,后续候选成功返回可信事实', async () => {
    const Ctor = await loadMediaProbeService();
    const harness = createProbeHarness();
    const clock = createManualClock();
    const service = new Ctor({ budgets: testBudgets(), clock, spawn: harness.spawn });

    const pending = service.probeFirstAvailable(
      [
        { candidateId: 'broken', inputPath: '/nas/broken.avi' },
        { candidateId: 'good', inputPath: '/nas/good.mp4' },
      ],
      { atMs: clock.now() + 30_000 },
    );
    await flushMicrotasks();
    nth(harness.processes, 0).emitStderr('Invalid data found when processing input');
    nth(harness.processes, 0).emitExit(1, null);
    await flushMicrotasks();

    expect(harness.requests.length).toBe(2);
    nth(harness.processes, 1).emitStdout(ffprobeJson('mov,mp4,m4a,3gp,3g2,mj2', 600, [ffprobeVideoStream('h264'), ffprobeAudioStream('aac')]));
    nth(harness.processes, 1).emitExit(0, null);

    const facts = expectOk(await pending);
    // 可信事实:container 归一化、duration、codec、位深、SDR、服务器轨道 ID
    expect(facts.container).toBe('mp4');
    expect(Math.abs(facts.durationSeconds - 600)).toBeLessThan(0.01);
    expect(facts.video).toMatchObject({ codec: 'h264', bitDepth: 8, pixFmt: 'yuv420p', widthPx: 1920, heightPx: 1080, hdr: false });
    expect(facts.audio?.codec).toBe('aac');
    expect(facts.tracks.map((t) => t.kind).sort()).toEqual(['audio', 'video']);
    expect(new Set(facts.tracks.map((t) => t.id)).size).toBe(facts.tracks.length);
  });

  it('候选共享 30 秒总期限:逐候选超时耗尽期限后终止,不再尝试剩余候选(data-model 资源选择)', async () => {
    const Ctor = await loadMediaProbeService();
    const harness = createProbeHarness();
    const clock = createManualClock();
    const service = new Ctor({ budgets: testBudgets(), clock, spawn: harness.spawn });

    const pending = service.probeFirstAvailable(
      [
        { candidateId: 'c1', inputPath: '/nas/1.mkv' },
        { candidateId: 'c2', inputPath: '/nas/2.mkv' },
        { candidateId: 'c3', inputPath: '/nas/3.mkv' },
        { candidateId: 'c4-never', inputPath: '/nas/4.mkv' },
      ],
      { atMs: clock.now() + 30_000 },
    );
    await flushMicrotasks();
    expect(harness.requests).toHaveLength(1);

    await clock.advance(10_000);
    await flushMicrotasks();
    expect(harness.requests, '第 1 候选 10 秒超时后试第 2 候选').toHaveLength(2);

    await clock.advance(10_000);
    await flushMicrotasks();
    expect(harness.requests, '第 2 候选超时后试第 3 候选').toHaveLength(3);

    await clock.advance(10_000);
    await flushMicrotasks();
    // 30 秒总期限耗尽:c3 在期限点被终止,c4 绝不再尝试(共用期限,不隐藏无限重试)
    expect(harness.requests, '总期限耗尽后不得尝试剩余候选').toHaveLength(3);
    expect(nth(harness.processes, 2).signals.length, '期限点活动 probe 必须被终止').toBeGreaterThan(0);

    expectErr(await pending, 'PLAYBACK_PREPARE_TIMEOUT');
  });
});

/* ------------------------------------------------------------------ */
/* 第 1 层:格式计划矩阵(T024;FR-012/FR-014)                           */
/* ------------------------------------------------------------------ */

describe('T016 第1层:格式计划矩阵(T024 playback-plan.service;FR-014 direct→remux→audio→video)', () => {
  async function makePlanner(): Promise<PlaybackPlanServiceLike> {
    const Ctor = await loadPlaybackPlanService();
    return new Ctor({ budgets: testBudgets() });
  }

  function makeFacts(
    overrides: {
      container?: string;
      videoCodec?: string;
      bitDepth?: number;
      pixFmt?: string;
      widthPx?: number;
      heightPx?: number;
      hdr?: boolean;
      audioCodec?: string | null;
    } = {},
  ): ProbeFacts {
    const video: ProbeVideoFacts = {
      codec: overrides.videoCodec ?? 'h264',
      bitDepth: overrides.bitDepth ?? 8,
      pixFmt: overrides.pixFmt ?? 'yuv420p',
      widthPx: overrides.widthPx ?? 1920,
      heightPx: overrides.heightPx ?? 1080,
      hdr: overrides.hdr ?? false,
    };
    const audio = overrides.audioCodec === null ? null : { codec: overrides.audioCodec ?? 'aac' };
    const tracks: ProbeFacts['tracks'] = [
      ...(audio === null ? [] : [{ id: 'a0', kind: 'audio' as const, codec: audio.codec }]),
      { id: 'v0', kind: 'video', codec: video.codec },
    ];
    return {
      container: overrides.container ?? 'mp4',
      durationSeconds: 600,
      video,
      audio,
      tracks,
    };
  }

  type PlanExpectation =
    | {
        readonly kind: 'plan';
        readonly delivery: 'direct' | 'remux' | 'audio_transcode' | 'video_transcode';
        readonly mode: PlaybackConversionMode | null;
        readonly outputVideoCodec: string;
        readonly outputAudioCodec: string;
      }
    | { readonly kind: 'unsupported' };

  interface PlanCaseRow {
    readonly name: string;
    readonly facts: ProbeFacts;
    readonly expected: PlanExpectation;
  }

  async function expectPlanRow(planner: PlaybackPlanServiceLike, row: PlanCaseRow): Promise<void> {
    const result = planner.plan(row.facts);
    if (row.expected.kind === 'unsupported') {
      expectErr(result, 'PLAYBACK_FORMAT_UNSUPPORTED');
      return;
    }
    const plan = expectOk(result);
    expect(plan.delivery, row.name).toBe(row.expected.delivery);
    expect(plan.mode, row.name).toBe(row.expected.mode);
    expect(plan.outputVideoCodec, row.name).toBe(row.expected.outputVideoCodec);
    expect(plan.outputAudioCodec, row.name).toBe(row.expected.outputAudioCodec);
    // data-model PlaybackPlan:输出模式必须携带兼容原因
    expect(typeof plan.reason).toBe('string');
    expect(plan.reason.length).toBeGreaterThan(0);
  }

  it('direct:MP4 + H.264 8bit yuv420p + AAC(浏览器可直接渐进播放,优先直接播放 FR-012)', async () => {
    const planner = await makePlanner();
    const rows: PlanCaseRow[] = [
      { name: '1080p SDR', facts: makeFacts(), expected: { kind: 'plan', delivery: 'direct', mode: null, outputVideoCodec: 'h264', outputAudioCodec: 'aac' } },
      {
        name: '720p SDR',
        facts: makeFacts({ widthPx: 1280, heightPx: 720 }),
        expected: { kind: 'plan', delivery: 'direct', mode: null, outputVideoCodec: 'h264', outputAudioCodec: 'aac' },
      },
    ];
    for (const row of rows) {
      await expectPlanRow(planner, row);
    }
  });

  it('remux:容器不兼容但 H.264/AAC 全兼容 → 转封装保留原始编码(MKV/TS/MOV/静音视频)', async () => {
    const planner = await makePlanner();
    const rows: PlanCaseRow[] = [
      {
        name: 'MKV/H.264/AAC',
        facts: makeFacts({ container: 'mkv' }),
        expected: { kind: 'plan', delivery: 'remux', mode: 'remux', outputVideoCodec: 'copy', outputAudioCodec: 'copy' },
      },
      {
        name: 'TS/H.264/AAC',
        facts: makeFacts({ container: 'ts' }),
        expected: { kind: 'plan', delivery: 'remux', mode: 'remux', outputVideoCodec: 'copy', outputAudioCodec: 'copy' },
      },
      {
        name: 'MOV/H.264/AAC',
        facts: makeFacts({ container: 'mov' }),
        expected: { kind: 'plan', delivery: 'remux', mode: 'remux', outputVideoCodec: 'copy', outputAudioCodec: 'copy' },
      },
      {
        name: 'MKV/H.264/无音频轨(output_audio_codec=none)',
        facts: makeFacts({ container: 'mkv', audioCodec: null }),
        expected: { kind: 'plan', delivery: 'remux', mode: 'remux', outputVideoCodec: 'copy', outputAudioCodec: 'none' },
      },
    ];
    for (const row of rows) {
      await expectPlanRow(planner, row);
    }
  });

  it('audio_transcode:视频兼容 + AC3/EAC3/DTS → 仅音频转码,视频 copy 不重编码(FR-012)', async () => {
    const planner = await makePlanner();
    const rows: PlanCaseRow[] = [
      {
        name: 'MP4/H.264/AC3',
        facts: makeFacts({ audioCodec: 'ac3' }),
        expected: { kind: 'plan', delivery: 'audio_transcode', mode: 'audio_transcode', outputVideoCodec: 'copy', outputAudioCodec: 'aac' },
      },
      {
        name: 'MP4/H.264/EAC3',
        facts: makeFacts({ audioCodec: 'eac3' }),
        expected: { kind: 'plan', delivery: 'audio_transcode', mode: 'audio_transcode', outputVideoCodec: 'copy', outputAudioCodec: 'aac' },
      },
      {
        name: 'MKV/H.264/DTS',
        facts: makeFacts({ container: 'mkv', audioCodec: 'dts' }),
        expected: { kind: 'plan', delivery: 'audio_transcode', mode: 'audio_transcode', outputVideoCodec: 'copy', outputAudioCodec: 'aac' },
      },
    ];
    for (const row of rows) {
      await expectPlanRow(planner, row);
    }
  });

  it('video_transcode:HEVC 8/10bit、MPEG-4、4:2:2 → 必要视频转换,输出 h264 8bit yuv420p/AAC', async () => {
    const planner = await makePlanner();
    const rows: PlanCaseRow[] = [
      {
        name: 'MKV/HEVC 8bit SDR',
        facts: makeFacts({ container: 'mkv', videoCodec: 'hevc' }),
        expected: { kind: 'plan', delivery: 'video_transcode', mode: 'video_transcode', outputVideoCodec: 'h264', outputAudioCodec: 'aac' },
      },
      {
        name: 'MKV/HEVC 10bit SDR(输出仍 8bit,不按 HDR 处理)',
        facts: makeFacts({ container: 'mkv', videoCodec: 'hevc', bitDepth: 10 }),
        expected: { kind: 'plan', delivery: 'video_transcode', mode: 'video_transcode', outputVideoCodec: 'h264', outputAudioCodec: 'aac' },
      },
      {
        name: 'AVI/MPEG-4(ASP)',
        facts: makeFacts({ container: 'avi', videoCodec: 'mpeg4' }),
        expected: { kind: 'plan', delivery: 'video_transcode', mode: 'video_transcode', outputVideoCodec: 'h264', outputAudioCodec: 'aac' },
      },
      {
        name: 'MP4/H.264 8bit yuv422p(色度抽样不兼容)',
        facts: makeFacts({ pixFmt: 'yuv422p' }),
        expected: { kind: 'plan', delivery: 'video_transcode', mode: 'video_transcode', outputVideoCodec: 'h264', outputAudioCodec: 'aac' },
      },
    ];
    for (const row of rows) {
      await expectPlanRow(planner, row);
    }
  });

  it('4K/HDR:可直放的尽力直放(FR-014 仅尽力直接播放);需转换的稳定失败且绝不降分辨率转码', async () => {
    const planner = await makePlanner();
    const rows: PlanCaseRow[] = [
      {
        name: '4K SDR + 全兼容编码 MP4 → 尽力直放 direct,不产生转换',
        facts: makeFacts({ widthPx: 3840, heightPx: 2160 }),
        expected: { kind: 'plan', delivery: 'direct', mode: null, outputVideoCodec: 'h264', outputAudioCodec: 'aac' },
      },
      {
        name: '1080p HDR10 + 全兼容编码 MP4 → 尽力直放,不得误当 SDR 转码(R1)',
        facts: makeFacts({ hdr: true }),
        expected: { kind: 'plan', delivery: 'direct', mode: null, outputVideoCodec: 'h264', outputAudioCodec: 'aac' },
      },
      {
        name: '4K SDR HEVC MKV → PLAYBACK_FORMAT_UNSUPPORTED(无 4K 转换)',
        facts: makeFacts({ container: 'mkv', videoCodec: 'hevc', widthPx: 3840, heightPx: 2160 }),
        expected: { kind: 'unsupported' },
      },
      {
        name: '1080p HDR HEVC MKV → PLAYBACK_FORMAT_UNSUPPORTED(HDR 不保证转换)',
        facts: makeFacts({ container: 'mkv', videoCodec: 'hevc', hdr: true }),
        expected: { kind: 'unsupported' },
      },
      {
        name: '4K SDR H.264 + AC3 MP4 → PLAYBACK_FORMAT_UNSUPPORTED(宁可失败也不降分辨率转码)',
        facts: makeFacts({ widthPx: 3840, heightPx: 2160, audioCodec: 'ac3' }),
        expected: { kind: 'unsupported' },
      },
    ];
    // 第 2 行需要 hdr=true 的 facts 已直接构造,无需后处理
    for (const row of rows) {
      await expectPlanRow(planner, row);
    }
  });

  it('非法容器/编码组合、范围外容器、无视频轨 → 稳定失败且不算缺陷(FR-014 不承诺非法组合)', async () => {
    const planner = await makePlanner();
    const rows: PlanCaseRow[] = [
      {
        name: 'AVI/HEVC(非法编码-容器组合)',
        facts: makeFacts({ container: 'avi', videoCodec: 'hevc' }),
        expected: { kind: 'unsupported' },
      },
      {
        name: 'WMV(FR-014 五容器之外)',
        facts: makeFacts({ container: 'wmv' }),
        expected: { kind: 'unsupported' },
      },
      {
        name: '无视频轨(纯音频输入)',
        facts: {
          container: 'mp4',
          durationSeconds: 600,
          video: null,
          audio: { codec: 'aac' },
          tracks: [{ id: 'a0', kind: 'audio', codec: 'aac' }],
        },
        expected: { kind: 'unsupported' },
      },
    ];
    for (const row of rows) {
      await expectPlanRow(planner, row);
    }
  });

  it('direct 计划不产生转换模式(mode=null):交付不建转换行、不占转换额度(R4/FR-016)', async () => {
    const planner = await makePlanner();
    const plan = expectOk(planner.plan(makeFacts()));
    expect(plan.delivery).toBe('direct');
    expect(plan.mode).toBeNull();
    // 该路径不存在 ReserveConversionInput 的构造输入(mode 是必填非空字段):
    // direct 的「不占额度」由计划层无转换模式 + 仓储 direct 不建行共同保证(额度用例见下)。
  });
});

/* ------------------------------------------------------------------ */
/* 第 1 层:软件回退(T025;R8)                                          */
/* ------------------------------------------------------------------ */

/** 监督器用例公共装置:concurrency=1 的 rig + 假时钟 + 可编程 spawn + 硬件探测注入 */
interface SupervisorRig {
  readonly rig: ConversionDbRig;
  readonly clock: ManualClock;
  readonly harness: SupervisorSpawnHarness;
  readonly supervisor: ConversionSupervisorServiceLike;
  readonly deadlineAtMs: number;
  readonly sessionId: string;
}

async function bootstrapSupervisorRig(hardwareBackend: () => Promise<string | null>): Promise<SupervisorRig> {
  const Ctor = await loadConversionSupervisorService();
  const rig = bootstrapConversionRig();
  const clock = createManualClock();
  const harness = createSupervisorSpawnHarness();
  const supervisor = new Ctor({
    repository: rig.repo,
    budgets: rig.budgets,
    clock,
    spawn: harness.spawn,
    hardwareBackend,
  });
  return {
    rig,
    clock,
    harness,
    supervisor,
    deadlineAtMs: clock.now() + rig.budgets.watchdog.prepareTimeoutSeconds * 1000,
    sessionId: createRigSession(rig),
  };
}

const REMUX_PLAN: ConversionPlan = {
  delivery: 'remux',
  mode: 'remux',
  outputVideoCodec: 'copy',
  outputAudioCodec: 'copy',
  reason: 'T016 夹具:容器不兼容、编码全兼容',
};

const VIDEO_TRANSCODE_PLAN: ConversionPlan = {
  delivery: 'video_transcode',
  mode: 'video_transcode',
  outputVideoCodec: 'h264',
  outputAudioCodec: 'aac',
  reason: 'T016 夹具:HEVC 需视频转换',
};

describe('T016 第1层:软件回退(T025 conversion-supervisor.service;R8 最多回退一次共用原期限)', () => {
  it('硬件可用且启动成功 → 仅一次 spawn(参数数组),hardware_backend 记录后端,退出后释放额度', async () => {
    const env = await bootstrapSupervisorRig(async () => 'vaapi');
    const pending = env.supervisor.start({
      householdId: env.rig.ids.householdId,
      sessionId: env.sessionId,
      generation: 1,
      plan: VIDEO_TRANSCODE_PLAN,
      phase: 'prepare',
      deadlineAtMs: env.deadlineAtMs,
    });
    await flushMicrotasks();

    expect(env.harness.requests).toHaveLength(1);
    expect(nth(env.harness.requests, 0).backend).toBe('hardware');
    expect(nth(env.harness.requests, 0).attemptIndex).toBe(0);
    expect(nth(env.harness.requests, 0).deadlineAtMs).toBe(env.deadlineAtMs);
    expect(Array.isArray(nth(env.harness.requests, 0).argv)).toBe(true);
    for (const arg of nth(env.harness.requests, 0).argv) {
      expect(typeof arg).toBe('string');
    }

    const started = expectOk(await pending);
    env.harness.last().emitExit(0, null);
    await flushMicrotasks();

    const row = readConversionRow(started.conversionId);
    expect(row.state).toBe('ended');
    expect(row.hardwareBackend).toBe('vaapi');
    expect(env.rig.repo.countActiveConversions()).toBe(0);
  });

  it('硬件启动失败 → 软件回退一次且共用原 30 秒期限(期限绝对值不重置,到期终止回退尝试)', async () => {
    const env = await bootstrapSupervisorRig(async () => 'vaapi');
    const pending = env.supervisor.start({
      householdId: env.rig.ids.householdId,
      sessionId: env.sessionId,
      generation: 1,
      plan: VIDEO_TRANSCODE_PLAN,
      phase: 'prepare',
      deadlineAtMs: env.deadlineAtMs,
    });
    await flushMicrotasks();

    // 硬件尝试启动即失败(无任何进度输出 = 初始化失败)
    env.harness.last().emitExit(1, null);
    await flushMicrotasks();

    expect(env.harness.requests).toHaveLength(2);
    expect(nth(env.harness.requests, 1).backend).toBe('software');
    expect(nth(env.harness.requests, 1).attemptIndex).toBe(1);
    // 共用原期限:两次尝试的绝对期限完全一致(R8 共用原 30 秒期限,不重置)
    expect(nth(env.harness.requests, 0).deadlineAtMs).toBe(env.deadlineAtMs);
    expect(nth(env.harness.requests, 1).deadlineAtMs).toBe(env.deadlineAtMs);

    const started = expectOk(await pending);
    // 回退尝试挂在原期限上:推进到 t0+30s 必须收到 SIGTERM(若期限被重置则此刻不会终止)
    await env.clock.advance(env.rig.budgets.watchdog.prepareTimeoutSeconds * 1000);
    expect(nth(env.harness.processes, 1).signals, '原期限到期必须终止回退尝试').toContain('SIGTERM');
    await env.clock.advance(env.rig.budgets.watchdog.sigtermGraceSeconds * 1000);
    expect(nth(env.harness.processes, 1).signals).toEqual(['SIGTERM', 'SIGKILL']);
    nth(env.harness.processes, 1).emitExit(null, 'SIGKILL');
    await flushMicrotasks();

    const row = readConversionRow(started.conversionId);
    expect(row.state).toBe('failed');
    expect(row.failureCode).toBe('PLAYBACK_PREPARE_TIMEOUT');
    expect(env.rig.repo.countActiveConversions()).toBe(0);
  });

  it('硬件+软件均启动失败 → 稳定失败 PLAYBACK_RESOURCE_UNAVAILABLE,最多 2 次 spawn 不无限切换,额度释放', async () => {
    const env = await bootstrapSupervisorRig(async () => 'vaapi');
    const pending = env.supervisor.start({
      householdId: env.rig.ids.householdId,
      sessionId: env.sessionId,
      generation: 1,
      plan: VIDEO_TRANSCODE_PLAN,
      phase: 'prepare',
      deadlineAtMs: env.deadlineAtMs,
    });
    await flushMicrotasks();
    env.harness.last().emitExit(1, null);
    await flushMicrotasks();
    env.harness.last().emitExit(1, null);
    await flushMicrotasks();

    expectErr(await pending, 'PLAYBACK_RESOURCE_UNAVAILABLE');
    // 不无限切换:硬件一次 + 软件一次,绝无第 3 次尝试
    expect(env.harness.requests).toHaveLength(2);
    expect(env.rig.repo.countActiveConversions()).toBe(0);
  });

  it('硬件探测不可用 → 直接走软件路径且仅一次 spawn(R7:arm64 不假定硬件)', async () => {
    const env = await bootstrapSupervisorRig(async () => null);
    const pending = env.supervisor.start({
      householdId: env.rig.ids.householdId,
      sessionId: env.sessionId,
      generation: 1,
      plan: REMUX_PLAN,
      phase: 'prepare',
      deadlineAtMs: env.deadlineAtMs,
    });
    await flushMicrotasks();

    expect(env.harness.requests).toHaveLength(1);
    expect(nth(env.harness.requests, 0).backend).toBe('software');

    const started = expectOk(await pending);
    env.harness.last().emitExit(0, null);
    await flushMicrotasks();

    const row = readConversionRow(started.conversionId);
    expect(row.state).toBe('ended');
    expect(row.hardwareBackend).toBe('software');
  });
});

/* ------------------------------------------------------------------ */
/* 第 1 层:转换额度(仓储已实现部分允许绿 + 监督器集成)                   */
/* ------------------------------------------------------------------ */

describe('T016 第1层:转换额度(并发原子 reserve 不排队;direct 不占额;退出释放)', () => {
  it('[仓储已实现] 并发额度满 → reserve 立即 PLAYBACK_CONVERSION_BUSY,不排队', () => {
    const rig = bootstrapConversionRig();
    const sessionA = createRigSession(rig);
    const sessionB = createRigSession(rig);
    const reserve = (sessionId: string, generation: number) =>
      rig.repo.reserveConversion({
        householdId: rig.ids.householdId,
        sessionId,
        generation,
        mode: 'remux',
        outputVideoCodec: 'copy',
        outputAudioCodec: 'copy',
      });

    expectOk(reserve(sessionA, 1));
    expect(rig.repo.countActiveConversions()).toBe(1);
    // 同槽位重复预留(UNIQUE)与跨会话抢额(全局额度 1)都必须立即忙:
    // 同步返回 err(仓储方法为同步函数),不存在排队等待位
    expectErr(reserve(sessionA, 1), 'PLAYBACK_CONVERSION_BUSY');
    expectErr(reserve(sessionB, 1), 'PLAYBACK_CONVERSION_BUSY');
    expect(rig.repo.countActiveConversions()).toBe(1);
  });

  it('[仓储已实现] 任务确认退出(ended/failed)释放额度后可再次 reserve', () => {
    const rig = bootstrapConversionRig();
    const sessionId = createRigSession(rig);
    const reserve = (generation: number) =>
      rig.repo.reserveConversion({
        householdId: rig.ids.householdId,
        sessionId,
        generation,
        mode: 'video_transcode',
        outputVideoCodec: 'h264',
        outputAudioCodec: 'aac',
      });

    // ended 释放路径:优雅退出必须先 running→stopping 再 ended(迁移表;running 可从 starting 进入)
    const first = expectOk(reserve(1));
    expectErr(reserve(2), 'PLAYBACK_CONVERSION_BUSY');
    const advance = (state: 'starting' | 'running' | 'stopping') =>
      rig.repo.markConversion(first.id, { conversionId: first.id, householdId: rig.ids.householdId, state });
    expectOk(advance('starting'));
    expectOk(advance('running'));
    expectOk(advance('stopping'));
    expectOk(rig.repo.releaseOnExit(first.id, { finalState: 'ended' }));
    expect(rig.repo.countActiveConversions()).toBe(0);
    const second = expectOk(reserve(2));

    // failed 释放路径:reserved 可直接落 failed(带稳定失败码),额度即释放
    expectErr(reserve(3), 'PLAYBACK_CONVERSION_BUSY');
    expectOk(rig.repo.releaseOnExit(second.id, { finalState: 'failed', failureCode: 'PLAYBACK_PREPARE_TIMEOUT' }));
    expect(rig.repo.countActiveConversions()).toBe(0);
    expectOk(reserve(3));
  });

  it('[监督器] 活动任务占额时新任务立即忙:不排队、不产生额外 spawn;退出后可再启动', async () => {
    const env = await bootstrapSupervisorRig(async () => null);
    const startArgs = (sessionId: string, generation: number) => ({
      householdId: env.rig.ids.householdId,
      sessionId,
      generation,
      plan: REMUX_PLAN,
      phase: 'prepare' as const,
      deadlineAtMs: env.deadlineAtMs,
    });

    const firstSession = createRigSession(env.rig);
    const started = expectOk(await env.supervisor.start(startArgs(firstSession, 1)));
    expect(env.harness.requests).toHaveLength(1);

    // 额度满(concurrency=1):新任务立即忙,且绝不排队等待 spawn
    const secondSession = createRigSession(env.rig);
    expectErr(await env.supervisor.start(startArgs(secondSession, 1)), 'PLAYBACK_CONVERSION_BUSY');
    expect(env.harness.requests, '忙拒绝不得触发排队 spawn').toHaveLength(1);

    // 首个任务取消并确认退出(SIGTERM→5s→SIGKILL)后额度释放,可立即再启动
    await env.supervisor.cancel(started.conversionId);
    await flushMicrotasks();
    await env.clock.advance(env.rig.budgets.watchdog.sigtermGraceSeconds * 1000);
    env.harness.last().emitExit(null, 'SIGKILL');
    await flushMicrotasks();
    expect(env.rig.repo.countActiveConversions()).toBe(0);

    expectOk(await env.supervisor.start(startArgs(secondSession, 1)));
    expect(env.harness.requests).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* 第 1 层:超时与速度看门狗(T027)                                      */
/* ------------------------------------------------------------------ */

interface WatchdogHarness {
  readonly clock: ManualClock;
  readonly budgets: PlaybackBudgets;
  readonly terminations: { code: PlaybackErrorCode; detail: string }[];
  readonly buffer: { value: number };
  create(): Promise<ConversionWatchdogServiceLike>;
}

function createWatchdogHarness(): WatchdogHarness {
  const clock = createManualClock();
  const budgets = testBudgets();
  const terminations: { code: PlaybackErrorCode; detail: string }[] = [];
  const buffer = { value: 2 };
  return {
    clock,
    budgets,
    terminations,
    buffer,
    create: async () => {
      const Ctor = await loadConversionWatchdogService();
      return new Ctor({
        budgets,
        clock,
        playableBufferSeconds: () => buffer.value,
        onTerminate: (code, detail) => terminations.push({ code, detail }),
      });
    },
  };
}

describe('T016 第1层:超时与速度看门狗(T027 conversion-watchdog.service;R4/R8)', () => {
  it('首帧 30 秒无输出 → 终止 PLAYBACK_PREPARE_TIMEOUT,恰好一次(FR-018 首帧硬超时)', async () => {
    const h = createWatchdogHarness();
    const wd = await h.create();
    try {
      wd.begin('prepare');
      await h.clock.advance(h.budgets.watchdog.prepareTimeoutSeconds * 1000 - 1_000);
      expect(h.terminations, '29 秒时不得提前判罚').toHaveLength(0);
      await h.clock.advance(1_000);
      expect(h.terminations).toHaveLength(1);
      expect(nth(h.terminations, 0).code).toBe('PLAYBACK_PREPARE_TIMEOUT');
    } finally {
      wd.dispose();
    }
  });

  it('seek 相位 15 秒硬超时 → PLAYBACK_SEEK_TIMEOUT(prepare 的 30 秒期限不适用)', async () => {
    const h = createWatchdogHarness();
    const wd = await h.create();
    try {
      wd.begin('seek');
      await h.clock.advance(h.budgets.watchdog.seekTimeoutSeconds * 1000 - 1_000);
      expect(h.terminations).toHaveLength(0);
      await h.clock.advance(1_000);
      expect(h.terminations).toHaveLength(1);
      expect(nth(h.terminations, 0).code).toBe('PLAYBACK_SEEK_TIMEOUT');
    } finally {
      wd.dispose();
    }
  });

  it('每 10 秒采样 30 秒窗口:连续 3 次 speed<1 且缓冲<8 秒 → 第 3 次判 PLAYBACK_PERFORMANCE_INSUFFICIENT', async () => {
    const h = createWatchdogHarness();
    h.buffer.value = 2; // <8 秒:速度判罚条件成立
    const wd = await h.create();
    try {
      wd.begin('prepare');
      await h.clock.advance(1_000);
      wd.noteFirstOutput();
      wd.noteOutput(0);
      // 持续 0.2x 欠速:每 5 秒墙钟输出 1 秒媒体;采样点 +10/+20/+30 全部 speed<1
      for (let wallSec = 5; wallSec <= 20; wallSec += 5) {
        await h.clock.advance(5_000);
        wd.noteOutput(wallSec * 0.2);
        expect(h.terminations, `${wallSec}s 时判罚次数不足 3`).toHaveLength(0);
      }
      await h.clock.advance(5_000);
      wd.noteOutput(25 * 0.2);
      expect(h.terminations, '+25s 仅 2 次欠速采样,不得判罚').toHaveLength(0);
      await h.clock.advance(5_000); // +30s:第 3 次连续欠速采样
      expect(h.terminations).toHaveLength(1);
      expect(nth(h.terminations, 0).code).toBe('PLAYBACK_PERFORMANCE_INSUFFICIENT');
    } finally {
      wd.dispose();
    }
  });

  it('速度恢复 ≥1x 打断连续计数 → 不判罚(避免以初始瞬时 speed 误杀,R4)', async () => {
    const h = createWatchdogHarness();
    h.buffer.value = 2;
    const wd = await h.create();
    try {
      wd.begin('prepare');
      await h.clock.advance(1_000);
      wd.noteFirstOutput();
      wd.noteOutput(0);
      // +10s:0.2x(speed≈0.2,<1,计 1 次)
      await h.clock.advance(5_000);
      wd.noteOutput(1);
      await h.clock.advance(5_000);
      wd.noteOutput(2);
      // +20s:爆发 2x(累计 22s 媒体,窗口速度≈1.1 ≥1,连续计数清零)
      await h.clock.advance(5_000);
      wd.noteOutput(12);
      await h.clock.advance(5_000);
      wd.noteOutput(22);
      // +30s 起维持 ≥1x:连续欠速永不达到 3 次
      for (let wallSec = 35; wallSec <= 60; wallSec += 5) {
        await h.clock.advance(5_000);
        wd.noteOutput(22 + (wallSec - 20) * 1.5);
      }
      expect(h.terminations, '连续性被打断后不得判罚').toHaveLength(0);
    } finally {
      wd.dispose();
    }
  });

  it('speed<1 但可播放缓冲 ≥8 秒 → 不判罚(有播放余量,条件不成立)', async () => {
    const h = createWatchdogHarness();
    h.buffer.value = 10; // ≥8 秒:判罚条件被缓冲余量否定
    const wd = await h.create();
    try {
      wd.begin('prepare');
      await h.clock.advance(1_000);
      wd.noteFirstOutput();
      wd.noteOutput(0);
      for (let wallSec = 5; wallSec <= 40; wallSec += 5) {
        await h.clock.advance(5_000);
        wd.noteOutput(wallSec * 0.2);
      }
      expect(h.terminations, '缓冲 ≥8 秒时持续欠速也不判罚').toHaveLength(0);
    } finally {
      wd.dispose();
    }
  });

  it('主动暂停/有界预取节流期不采样判罚:全等待期零输出也不终止(R8 排除正常等待)', async () => {
    const h = createWatchdogHarness();
    h.buffer.value = 2;
    const wd = await h.create();
    try {
      wd.begin('prepare');
      await h.clock.advance(1_000);
      wd.noteFirstOutput();
      wd.noteOutput(0.4);
      wd.enterLegitimateWait(); // 主动暂停/有界预取节流:生产停止属正常等待
      await h.clock.advance(60_000); // 等待期零输出、零采样判罚
      expect(h.terminations, '正常等待期不得判性能不足/无输出').toHaveLength(0);
    } finally {
      wd.dispose();
    }
  });

  it('恢复生产后重新武装完整 15 秒无输出期限:14 秒仍安全,15 秒即判罚(暂停期不计入)', async () => {
    const h = createWatchdogHarness();
    h.buffer.value = 2;
    const wd = await h.create();
    try {
      wd.begin('prepare');
      await h.clock.advance(1_000);
      wd.noteFirstOutput();
      wd.noteOutput(0.4);
      wd.enterLegitimateWait();
      await h.clock.advance(40_000);
      wd.exitLegitimateWait(); // 恢复生产,但此后仍无输出 → 无输出计时从恢复点重新武装 15 秒
      await h.clock.advance(14_000);
      expect(h.terminations, '恢复后 14 秒无输出仍安全').toHaveLength(0);
      await h.clock.advance(1_000);
      expect(h.terminations).toHaveLength(1);
      expect(nth(h.terminations, 0).code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    } finally {
      wd.dispose();
    }
  });

  it('非正常等待 15 秒无输出 → 终止 PLAYBACK_RESOURCE_UNAVAILABLE(R8 资源/转换稳定失败)', async () => {
    const h = createWatchdogHarness();
    h.buffer.value = 2;
    const wd = await h.create();
    try {
      wd.begin('prepare');
      await h.clock.advance(1_000);
      wd.noteFirstOutput();
      wd.noteOutput(0.5); // 此后无任何输出,且不在正常等待态
      await h.clock.advance(14_000);
      expect(h.terminations, '15 秒无输出期限未到不得终止').toHaveLength(0);
      await h.clock.advance(1_000);
      expect(h.terminations).toHaveLength(1);
      expect(nth(h.terminations, 0).code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');
    } finally {
      wd.dispose();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 第 1 层:磁盘上限(T026)                                              */
/* ------------------------------------------------------------------ */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

interface StorageHarness {
  readonly clock: ManualClock;
  readonly freeBytes: { value: number };
  readonly failRemoval: { value: boolean };
  readonly rootDir: string;
  create(): Promise<ConversionStorageServiceLike>;
}

const storageTempDirs: string[] = [];

function createStorageHarness(): StorageHarness {
  const clock = createManualClock();
  const freeBytes = { value: 100 * GIB };
  const failRemoval = { value: false };
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t016-storage-'));
  storageTempDirs.push(rootDir);
  return {
    clock,
    freeBytes,
    failRemoval,
    rootDir,
    create: async () => {
      const Ctor = await loadConversionStorageService();
      return new Ctor({
        budgets: testBudgets(),
        clock,
        rootDir,
        freeDiskBytes: () => freeBytes.value,
        removeDirectory: async () => {
          if (failRemoval.value) {
            throw new Error('fake EBUSY: 目录暂不可删除');
          }
        },
      });
    },
  };
}

afterAll(() => {
  while (storageTempDirs.length > 0) {
    const dir = storageTempDirs.pop();
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('T016 第1层:磁盘上限(T026 conversion-storage.service;R4 存储预算/ R5 清理重试)', () => {
  function taskRef(generation: number): StorageTaskRef {
    return { householdId: randomUUID(), sessionId: randomUUID(), generation };
  }

  it('任务累计超 512MiB → PLAYBACK_STORAGE_LIMIT 并停止继续写入', async () => {
    const h = createStorageHarness();
    const storage = await h.create();
    const budgets = testBudgets();
    const writer = expectOk(await storage.openTask(taskRef(1)));

    const near = expectOk(await writer.append(budgets.storage.perTaskCacheMaxBytes - MIB));
    expect(near.bytesOnDisk).toBe(budgets.storage.perTaskCacheMaxBytes - MIB);

    expectErr(await writer.append(2 * MIB), 'PLAYBACK_STORAGE_LIMIT');
    // 超限后持续拒绝(存量停止写入,不只是单次拒绝)
    expectErr(await writer.append(MIB), 'PLAYBACK_STORAGE_LIMIT');
  });

  it('全局 2GiB 计入他任务 → 新任务写入被拒绝', async () => {
    const h = createStorageHarness();
    const storage = await h.create();
    const budgets = testBudgets();
    // 4 个任务各恰好 512MiB → 全局恰好 2GiB(计入他任务)
    for (let generation = 1; generation <= 4; generation += 1) {
      const writer = expectOk(await storage.openTask(taskRef(generation)));
      expectOk(await writer.append(budgets.storage.perTaskCacheMaxBytes));
    }
    expect(storage.totalBytesOnDisk()).toBe(budgets.storage.globalCacheMaxBytes);

    const newcomer = expectOk(await storage.openTask(taskRef(9)));
    expectErr(await newcomer.append(MIB), 'PLAYBACK_STORAGE_LIMIT');
  });

  it('数据卷余量 <1GiB → 拒绝新转换(openTask 稳定失败)', async () => {
    const h = createStorageHarness();
    const storage = await h.create();
    h.freeBytes.value = testBudgets().storage.minDiskFreeBytes - MIB; // 低于 1GiB 阈值
    expectErr(await storage.openTask(taskRef(1)), 'PLAYBACK_STORAGE_LIMIT');
  });

  it('余量 <1GiB → 存量任务停止继续写入(R4:禁止新转换并停止继续写入)', async () => {
    const h = createStorageHarness();
    const storage = await h.create();
    const writer = expectOk(await storage.openTask(taskRef(1)));
    expectOk(await writer.append(100 * MIB));

    h.freeBytes.value = testBudgets().storage.minDiskFreeBytes - MIB;
    expectErr(await writer.append(MIB), 'PLAYBACK_STORAGE_LIMIT');
    expect(storage.totalBytesOnDisk(), '被拒绝的写入不得计入账本').toBe(100 * MIB);
  });

  it('清理失败仍计预算(pending),60 秒重试成功后释放(R5 cleanup_state 语义)', async () => {
    const h = createStorageHarness();
    const storage = await h.create();
    const ref = taskRef(1);
    const writer = expectOk(await storage.openTask(ref));
    expectOk(await writer.append(100 * MIB));

    h.failRemoval.value = true;
    await storage.releaseTask(ref);
    expect(storage.pendingCleanupTasks(), '删除失败必须保持 pending').toContain(writer.taskKey);
    expect(storage.totalBytesOnDisk(), '清理失败仍计预算').toBe(100 * MIB);

    // 失败每 60 秒重试:两次重试仍失败 → 依旧 pending 且计额
    await h.clock.advance(testBudgets().lifecycle.cleanupRetrySeconds * 1000);
    await h.clock.advance(testBudgets().lifecycle.cleanupRetrySeconds * 1000);
    expect(storage.pendingCleanupTasks()).toContain(writer.taskKey);
    expect(storage.totalBytesOnDisk()).toBe(100 * MIB);

    // 重试成功 → 释放账本并移出 pending
    h.failRemoval.value = false;
    await h.clock.advance(testBudgets().lifecycle.cleanupRetrySeconds * 1000);
    expect(storage.totalBytesOnDisk()).toBe(0);
    expect(storage.pendingCleanupTasks()).not.toContain(writer.taskKey);
  });
});

/* ------------------------------------------------------------------ */
/* 第 1 层:generation/取消/回收(T025 + T026;R4/R5/R8)                 */
/* ------------------------------------------------------------------ */

describe('T016 第1层:generation/取消/回收(SIGTERM 宽限、额度释放、换代隔离)', () => {
  it('seek 升 generation 后旧任务收到 SIGTERM→5 秒宽限→SIGKILL 序列并标记 interrupted(R8)', async () => {
    const env = await bootstrapSupervisorRig(async () => null);
    const started = expectOk(
      await env.supervisor.start({
        householdId: env.rig.ids.householdId,
        sessionId: env.sessionId,
        generation: 1,
        plan: REMUX_PLAN,
        phase: 'prepare',
        deadlineAtMs: env.deadlineAtMs,
      }),
    );
    await flushMicrotasks();

    // seek 升 generation:旧转换任务收到取消
    await env.supervisor.cancel(started.conversionId);
    await flushMicrotasks();
    const grace = env.rig.budgets.watchdog.sigtermGraceSeconds * 1000;
    expect(env.harness.last().signals, '取消首先 SIGTERM').toEqual(['SIGTERM']);
    await env.clock.advance(grace - 1_000);
    expect(env.harness.last().signals, '5 秒宽限内不得 SIGKILL').toEqual(['SIGTERM']);
    await env.clock.advance(1_000);
    expect(env.harness.last().signals, '宽限耗尽仍未退出 → SIGKILL').toEqual(['SIGTERM', 'SIGKILL']);

    env.harness.last().emitExit(null, 'SIGKILL');
    await flushMicrotasks();
    const row = readConversionRow(started.conversionId);
    expect(row.state).toBe('interrupted');
    expect(env.rig.repo.countActiveConversions(), '确认退出后才释放额度').toBe(0);
  });

  it('取消并确认退出后额度释放:可立即再次 reserve(R4 串行换代,不同时占两个额度)', async () => {
    const env = await bootstrapSupervisorRig(async () => null);
    const sessionId = createRigSession(env.rig);
    const started = expectOk(
      await env.supervisor.start({
        householdId: env.rig.ids.householdId,
        sessionId,
        generation: 1,
        plan: REMUX_PLAN,
        phase: 'prepare',
        deadlineAtMs: env.deadlineAtMs,
      }),
    );
    await flushMicrotasks();

    await env.supervisor.cancel(started.conversionId);
    await flushMicrotasks();
    await env.clock.advance(env.rig.budgets.watchdog.sigtermGraceSeconds * 1000);
    env.harness.last().emitExit(null, 'SIGKILL');
    await flushMicrotasks();

    // 额度已释放:同会话下一代可立即 reserve(R4:换代串行,不双占)
    expectOk(
      env.rig.repo.reserveConversion({
        householdId: env.rig.ids.householdId,
        sessionId,
        generation: 2,
        mode: 'remux',
        outputVideoCodec: 'copy',
        outputAudioCodec: 'copy',
      }),
    );
    expect(env.rig.repo.countActiveConversions()).toBe(1);
  });

  it('generation 隔离:新旧代私有目录互斥,旧代写入不污染新代窗口(R4/R8)', async () => {
    const h = createStorageHarness();
    const storage = await h.create();
    const base = { householdId: randomUUID(), sessionId: randomUUID() };

    const oldGen = expectOk(await storage.openTask({ ...base, generation: 1 }));
    const newGen = expectOk(await storage.openTask({ ...base, generation: 2 }));

    // 私有产物目录按 generation 派生,新旧代互斥(plan.md:DATA_DIR/playback/<household>/<session>/<generation>)
    expect(oldGen.directory).not.toBe(newGen.directory);
    expect(oldGen.directory.startsWith(h.rootDir)).toBe(true);
    expect(newGen.directory.startsWith(h.rootDir)).toBe(true);

    // 旧代写入只进旧代账本,新代窗口从零开始(旧 generation 产物不污染新窗口)
    expectOk(await oldGen.append(64 * MIB));
    expect(oldGen.bytesOnDisk()).toBe(64 * MIB);
    expect(newGen.bytesOnDisk()).toBe(0);
    expect(storage.totalBytesOnDisk()).toBe(64 * MIB);
  });
});

/* ------------------------------------------------------------------ */
/* 第 2 层:真实FFmpeg层(本机 ffmpeg 8.1.1;无 ffmpeg 时 skip 而非 fail)   */
/* ------------------------------------------------------------------ */

function resolveRealBinary(envVar: string, candidates: readonly string[]): string | null {
  const fromEnv = process.env[envVar];
  const ordered = [...(fromEnv ? [fromEnv] : []), ...candidates];
  for (const candidate of ordered) {
    if (candidate.includes(path.sep)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    try {
      const found = execFileSync('which', [candidate], { encoding: 'utf8' }).trim();
      if (found.length > 0 && fs.existsSync(found)) {
        return found;
      }
    } catch {
      // 不在 PATH,继续下一候选
    }
  }
  return null;
}

const REAL_FFMPEG_BIN = resolveRealBinary('HMP_TEST_FFMPEG', ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', 'ffmpeg']);
const REAL_FFPROBE_BIN = resolveRealBinary('HMP_TEST_FFPROBE', ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe', 'ffprobe']);
const REAL_LAYER_AVAILABLE = REAL_FFMPEG_BIN !== null && REAL_FFPROBE_BIN !== null;

describe.skipIf(!REAL_LAYER_AVAILABLE)('T016 第2层:真实FFmpeg层(本机 ffmpeg/ffprobe;缺失时 skip)', () => {
  // skipIf 已保证可用性;局部收窄供 TS 使用
  const FFMPEG_BIN = REAL_FFMPEG_BIN as string;
  const FFPROBE_BIN = REAL_FFPROBE_BIN as string;
  let realRootDir: string;
  let sourcePath: string;
  let realCaseDir: string | null = null;

  function newCaseDir(): string {
    realCaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t016-real-'));
    return realCaseDir;
  }

  beforeAll(async () => {
    realRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t016-real-src-'));
    sourcePath = path.join(realRootDir, 'src-2s.mp4');
    // 2 秒 testsrc + 440Hz 正弦 AAC(H.264 8bit yuv420p),供 probe/转封装复用
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-y',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-shortest',
        sourcePath,
      ],
    );
  }, 20_000);

  afterEach(() => {
    if (realCaseDir !== null) {
      fs.rmSync(realCaseDir, { recursive: true, force: true });
      realCaseDir = null;
    }
  });

  afterAll(() => {
    fs.rmSync(realRootDir, { recursive: true, force: true });
  });

  it('[真实FFmpeg层] 生成 2 秒 testsrc+aac 源,probe 服务事实提取与 ffprobe 原始解析一致', async () => {
    // 基准:直接 ffprobe 解析真实文件
    const direct = JSON.parse(
      (await execFileAsync(FFPROBE_BIN, ['-v', 'error', '-show_streams', '-show_format', '-print_format', 'json', sourcePath])).stdout,
    ) as {
      streams: Array<{ codec_type: string; codec_name: string; pix_fmt?: string; bits_per_raw_sample?: string }>;
      format: { format_name: string; duration: string };
    };
    const directVideo = direct.streams.find((s) => s.codec_type === 'video');
    const directAudio = direct.streams.find((s) => s.codec_type === 'audio');
    expect(directVideo?.codec_name).toBe('h264');
    expect(directAudio?.codec_name).toBe('aac');

    // 被测:probe 服务对同一真实文件的事实提取(服务未实现则 RED)
    const Ctor = await loadMediaProbeService();
    const clock = createManualClock();
    const service = new Ctor({
      budgets: testBudgets(),
      clock,
      spawn: (request) => spawnProcess(FFPROBE_BIN, [...request.argv], { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ProbeProcessHandle,
    });
    const facts = expectOk(
      await service.probeFirstAvailable([{ candidateId: 'real', inputPath: sourcePath }], { atMs: clock.now() + testBudgets().probe.timeoutSeconds * 1000 }),
    );
    expect(facts.container).toBe('mp4');
    expect(Math.abs(facts.durationSeconds - Number.parseFloat(direct.format.duration))).toBeLessThan(0.5);
    expect(facts.video?.codec).toBe(directVideo?.codec_name);
    expect(facts.video?.pixFmt).toBe(directVideo?.pix_fmt);
    expect(facts.audio?.codec).toBe(directAudio?.codec_name);
  }, 20_000);

  it('[真实FFmpeg层] ffmpeg -c copy 转封装冒烟:产物含 .m3u8 与 .ts 分片结构(夹具自检)', async () => {
    const caseDir = newCaseDir();
    const playlistPath = path.join(caseDir, 'window.m3u8');
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-y',
        '-i', sourcePath,
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_segment_filename', path.join(caseDir, 'seg%03d.ts'),
        playlistPath,
      ],
    );

    // 产物结构:m3u8 存在、EXTM3U/EXTINF 头、被引用分片真实存在且非空
    expect(fs.existsSync(playlistPath)).toBe(true);
    const playlist = fs.readFileSync(playlistPath, 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('#EXTINF');
    const segmentNames = playlist
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(segmentNames.length).toBeGreaterThan(0);
    for (const name of segmentNames) {
      const segmentPath = path.join(caseDir, name);
      expect(fs.existsSync(segmentPath), `分片应存在:${name}`).toBe(true);
      expect(fs.statSync(segmentPath).size).toBeGreaterThan(0);
    }
  }, 20_000);

  it('[真实FFmpeg层] 转封装产物经存储服务进入私有任务窗口并计入账本(服务未实现则 RED)', async () => {
    const caseDir = newCaseDir();
    const playlistPath = path.join(caseDir, 'window.m3u8');
    await execFileAsync(
      FFMPEG_BIN,
      [
        '-y',
        '-i', sourcePath,
        '-c', 'copy',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_segment_filename', path.join(caseDir, 'seg%03d.ts'),
        playlistPath,
      ],
    );
    const segmentSizes = fs
      .readdirSync(caseDir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => fs.statSync(path.join(caseDir, name)).size);
    expect(segmentSizes.length).toBeGreaterThan(0);

    // 被测:存储服务接收真实转封装产物的字节量并计入私有任务窗口(T026 未实现则 RED)
    const h = createStorageHarness();
    const storage = await h.create();
    const writer = expectOk(
      await storage.openTask({ householdId: randomUUID(), sessionId: randomUUID(), generation: 1 }),
    );
    for (const size of segmentSizes) {
      expectOk(await writer.append(size));
    }
    expect(writer.bytesOnDisk()).toBe(segmentSizes.reduce((sum, size) => sum + size, 0));
    expect(storage.totalBytesOnDisk()).toBe(writer.bytesOnDisk());
  }, 20_000);
});
