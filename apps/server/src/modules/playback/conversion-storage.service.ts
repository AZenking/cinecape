import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { PlaybackBudgets } from '../../config/playback-budgets';
import { playbackErr, playbackOk, type PlaybackResult } from './playback.types';

/**
 * 转换私有存储(T026,spec 004)—— household/session/generation 三级私有滚动 HLS 窗口:
 *
 * - 私有目录按实体 ID 派生:<rootDir>/playback/<householdId>/<sessionId>/<generation>/
 *   (生产装配传 DATA_DIR 作 rootDir;测试注入 os.tmpdir 临时目录)。实体 ID 一律经
 *   pathSegment 白名单清洗,禁止路径穿越;产物不公开 —— 本服务无任何静态路由语义,
 *   交付只能经网关资产流(T031 端点逐请求鉴权重写,plan.md Technical Context);
 * - 记账式写入(append):按字节计额。任一预算触顶 —— 任务 512MiB(storage.perTaskCacheMaxBytes)、
 *   全局 2GiB(计入他任务,storage.globalCacheMaxBytes)、数据卷余量 <1GiB
 *   (storage.minDiskFreeBytes)→ PLAYBACK_STORAGE_LIMIT 且此后该窗口持续拒绝写入
 *   (R4:禁止新转换并停止继续写入,被拒字节不计账本);
 * - 滚动窗口(budgets.timeline:分片 4 秒/窗口 120 秒):写入过程周期性修剪窗口外分片,
 *   逐步删除(失败即停,预算不回冲),窗口只代表当前生产段,不伪装完整 VOD(R8);
 * - 清理语义(R5/cleanup_state):releaseTask 删除目录;删除失败保持 pending 计预算
 *   (不因回收失败释放磁盘账本),每 cleanupRetrySeconds(60 秒)重试;成功后账本释放;
 * - 账本为本进程内存态(重启后由 T028 启动扫描重算),生产装配可经仓储 markConversion
 *   同步 bytes_on_disk;预算检查在本地账本内先行,绝不跨异步过程持数据库事务;
 * - 暂停有界预取/节流属生产节拍控制,由监督者(conversion-supervisor)对 ffmpeg 进程执行,
 *   本服务只提供窗口记账与修剪;R8 判罚排除由 T027 看门狗 legitimate wait 承担。
 */

/** 结构化最小时钟(ManualClock / systemClock 结构兼容) */
export interface StorageClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

export interface StorageTaskRef {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
}

export interface ConversionTaskWriterLike {
  /** 稳定任务键(pendingCleanupTasks 以此报告) */
  readonly taskKey: string;
  /** 私有产物目录(私有根按 household/session/generation 派生) */
  readonly directory: string;
  /** 记账式写入:按字节计额;超任务/全局/磁盘余量阈值 → PLAYBACK_STORAGE_LIMIT 且此后拒绝写入 */
  append(sizeBytes: number): Promise<PlaybackResult<{ readonly bytesOnDisk: number }>>;
  bytesOnDisk(): number;
}

export interface ConversionStorageDeps {
  readonly budgets: PlaybackBudgets;
  readonly rootDir: string;
  /** 缺省 systemClock(真实时间);测试注入 ManualClock */
  readonly clock?: StorageClock;
  /** 数据卷剩余字节(注入,替代真实 statfs);缺省对 rootDir 做 statfs,失败视为不设限 */
  readonly freeDiskBytes?: () => number;
  /** 目录删除(注入可失败实现验证清理重试);缺省 fs.rm recursive+force */
  readonly removeDirectory?: (directory: string) => Promise<void>;
}

/** 任务账本条目:清理成功前 bytes 始终计入全局(清理失败仍计预算,R5) */
interface TaskEntry {
  readonly key: string;
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly directory: string;
  bytes: number;
  poisoned: boolean;
  closed: boolean;
  appends: number;
}

/** 待重试清理条目:entryKey 为空表示从未开户的裸目录 */
interface PendingCleanup {
  readonly key: string;
  readonly directory: string;
  readonly entryKey: string | null;
}

/** 实体 ID → 安全路径段(白名单清洗,防路径穿越;UUID 形态不受影响) */
function pathSegment(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 0 ? safe : '_';
}

function taskKeyOf(task: StorageTaskRef): string {
  return `${pathSegment(task.householdId)}/${pathSegment(task.sessionId)}/${pathSegment(String(task.generation))}`;
}

function systemClock(): StorageClock {
  return {
    now: () => Date.now(),
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

/** 滚动窗口内允许保留的最大分片数(目标分片 4 秒 × 窗口 120 秒 → 30 片) */
function rollingWindowMaxSegments(budgets: PlaybackBudgets): number {
  const { targetSegmentSeconds, rollingWindowSeconds } = budgets.timeline;
  return Math.max(1, Math.ceil(rollingWindowSeconds / Math.max(1, targetSegmentSeconds)));
}

export class ConversionStorageService {
  private readonly clock: StorageClock;
  private readonly freeDiskBytes: () => number;
  private readonly removeDirectory: (directory: string) => Promise<void>;
  private readonly entries = new Map<string, TaskEntry>();
  private readonly pendingCleanup = new Map<string, PendingCleanup>();

  constructor(private readonly deps: ConversionStorageDeps) {
    this.clock = deps.clock ?? systemClock();
    this.freeDiskBytes = deps.freeDiskBytes ?? defaultFreeDiskBytes(deps.rootDir);
    this.removeDirectory = deps.removeDirectory ?? ((directory) => fsp.rm(directory, { recursive: true, force: true }));
  }

  /**
   * 打开任务私有窗口:余量 <1GiB 拒绝新转换(PLAYBACK_STORAGE_LIMIT);目录按实体 ID 派生并创建;
   * 同键重复打开复用既有账本;清理重试中的键拒绝重复打开(避免账本双记)。
   */
  async openTask(task: StorageTaskRef): Promise<PlaybackResult<ConversionTaskWriterLike>> {
    if (this.freeDiskBytes() < this.deps.budgets.storage.minDiskFreeBytes) {
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '数据卷剩余空间低于阈值,禁止新转换');
    }
    const key = taskKeyOf(task);
    const existing = this.entries.get(key);
    if (existing !== undefined && this.pendingCleanup.has(key)) {
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '同名任务窗口正在清理重试,拒绝重复打开');
    }
    const directory = this.directoryOf(task);
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch {
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '私有任务目录创建失败');
    }
    const entry: TaskEntry =
      existing ??
      {
        key,
        householdId: task.householdId,
        sessionId: task.sessionId,
        generation: task.generation,
        directory,
        bytes: 0,
        poisoned: false,
        closed: false,
        appends: 0,
      };
    this.entries.set(key, entry);
    return playbackOk(new ConversionTaskWriter(entry, this));
  }

  /** 全局在册字节(含清理重试中条目 —— 清理失败仍计预算,R5) */
  totalBytesOnDisk(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.bytes;
    }
    return total;
  }

  /** 清理失败仍计预算:处于 pending 重试态的任务键(cleanup_state=pending 语义) */
  pendingCleanupTasks(): readonly string[] {
    return [...this.pendingCleanup.keys()];
  }

  /** 删除任务目录;失败保持 pending 计预算并按 cleanupRetrySeconds 重试 */
  async releaseTask(task: StorageTaskRef): Promise<void> {
    const key = taskKeyOf(task);
    const entry = this.entries.get(key);
    const directory = entry?.directory ?? this.directoryOf(task);
    if (entry !== undefined) {
      entry.closed = true;
    }
    try {
      await this.removeDirectory(directory);
      this.finishCleanup(key, entry !== undefined ? key : null);
    } catch {
      // 目录暂不可删除(EBUSY 等):保持 pending 计预算,每 cleanupRetrySeconds 重试(R5)
      this.pendingCleanup.set(key, { key, directory, entryKey: entry !== undefined ? key : null });
      this.scheduleCleanupRetry(key);
    }
  }

  /** 释放指定 generation(换代回收便捷入口) */
  async releaseGeneration(householdId: string, sessionId: string, generation: number): Promise<void> {
    await this.releaseTask({ householdId, sessionId, generation });
  }

  /** 释放整会话全部代窗口(stop/失联回收便捷入口) */
  async releaseSession(householdId: string, sessionId: string): Promise<void> {
    const householdSegment = pathSegment(householdId);
    const sessionSegment = pathSegment(sessionId);
    const keys = [...this.entries.keys()].filter((key) => key.startsWith(`${householdSegment}/${sessionSegment}/`));
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry !== undefined) {
        await this.releaseTask({ householdId: entry.householdId, sessionId: entry.sessionId, generation: entry.generation });
      }
    }
  }

  /** 记账式写入(ConversionTaskWriter 委托):预算检查 → 提交账本 */
  async appendTo(entry: TaskEntry, sizeBytes: number): Promise<PlaybackResult<{ readonly bytesOnDisk: number }>> {
    const storage = this.deps.budgets.storage;
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '非法写入字节数');
    }
    if (entry.closed) {
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '任务窗口已释放,拒绝写入');
    }
    if (entry.poisoned) {
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '任务窗口已触顶,存量停止继续写入');
    }
    if (this.freeDiskBytes() < storage.minDiskFreeBytes) {
      entry.poisoned = true;
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '数据卷剩余空间低于阈值,存量任务停止继续写入');
    }
    if (entry.bytes + sizeBytes > storage.perTaskCacheMaxBytes) {
      entry.poisoned = true;
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '任务缓存超过每任务上限,此后拒绝写入');
    }
    if (this.totalBytesOnDisk() + sizeBytes > storage.globalCacheMaxBytes) {
      entry.poisoned = true;
      return playbackErr('PLAYBACK_STORAGE_LIMIT', '全局缓存(计入他任务)超过上限,此后拒绝写入');
    }
    entry.bytes += sizeBytes;
    entry.appends += 1;
    // 周期性滚动窗口修剪(逐步删除窗口外分片);失败静默,不影响记账
    if (entry.appends % 8 === 0) {
      void this.pruneEntryWindow(entry).catch(() => {});
    }
    return playbackOk({ bytesOnDisk: entry.bytes });
  }

  /**
   * 滚动窗口修剪:按 mtime 保留最近 N 片(窗口 120 秒/分片 4 秒),窗口外逐片删除并回冲账本;
   * 单片删除失败立即停止(预算不回冲未删除分片)。
   */
  async pruneEntryWindow(entry: TaskEntry): Promise<number> {
    let names: string[];
    try {
      names = await fsp.readdir(entry.directory);
    } catch {
      return 0;
    }
    const segments: { name: string; sizeBytes: number; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.endsWith('.ts') && !name.endsWith('.m4s')) {
        continue;
      }
      try {
        const stat = await fsp.stat(path.join(entry.directory, name));
        segments.push({ name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件在枚举与 stat 之间消失:跳过
      }
    }
    segments.sort((left, right) => right.mtimeMs - left.mtimeMs);
    let removedBytes = 0;
    for (const segment of segments.slice(rollingWindowMaxSegments(this.deps.budgets))) {
      try {
        await fsp.unlink(path.join(entry.directory, segment.name));
        removedBytes += segment.sizeBytes;
      } catch {
        break;
      }
    }
    if (removedBytes > 0) {
      entry.bytes = Math.max(0, entry.bytes - removedBytes);
    }
    return removedBytes;
  }

  /**
   * 清理重试链:先续排下一次重试(链不断,与注入时钟推进粒度无关),再尝试删除;
   * 成功 → 释放账本并移出 pending;已释放键的重试到期即空转终止。
   */
  private scheduleCleanupRetry(key: string): void {
    const pending = this.pendingCleanup.get(key);
    if (pending === undefined) {
      return;
    }
    void this.clock.delay(this.deps.budgets.lifecycle.cleanupRetrySeconds * 1000).then(() => {
      const current = this.pendingCleanup.get(key);
      if (current === undefined || current !== pending) {
        return;
      }
      this.scheduleCleanupRetry(key);
      void this.removeDirectory(current.directory).then(
        () => {
          if (this.pendingCleanup.get(key) !== current) {
            return;
          }
          this.pendingCleanup.delete(key);
          if (current.entryKey !== null) {
            this.releaseEntry(current.entryKey);
          }
        },
        () => {
          // 删除仍失败:保持 pending 计预算,等待下一次定时重试
        },
      );
    });
  }

  /** 清理成功:账本释放(字节离开全局),键移出 pending */
  private finishCleanup(key: string, entryKey: string | null): void {
    this.pendingCleanup.delete(key);
    if (entryKey !== null) {
      this.releaseEntry(entryKey);
    }
  }

  private releaseEntry(key: string): void {
    this.entries.delete(key);
  }

  private directoryOf(task: StorageTaskRef): string {
    return path.join(
      this.deps.rootDir,
      'playback',
      pathSegment(task.householdId),
      pathSegment(task.sessionId),
      pathSegment(String(task.generation)),
    );
  }
}

/** 私有任务窗口写入器:固定绑定账本条目(薄委托,契约见 ConversionTaskWriterLike) */
export class ConversionTaskWriter implements ConversionTaskWriterLike {
  readonly taskKey: string;
  readonly directory: string;

  constructor(
    private readonly entry: TaskEntry,
    private readonly storage: ConversionStorageService,
  ) {
    this.taskKey = entry.key;
    this.directory = entry.directory;
  }

  append(sizeBytes: number): Promise<PlaybackResult<{ readonly bytesOnDisk: number }>> {
    return this.storage.appendTo(this.entry, sizeBytes);
  }

  bytesOnDisk(): number {
    return this.entry.bytes;
  }

  /** 滚动窗口修剪(窗口外分片逐步删除并回冲账本) */
  pruneWindow(): Promise<number> {
    return this.storage.pruneEntryWindow(this.entry);
  }
}

/** 真实数据卷余量(statfs;失败视为不设限,不因探测失败误停生产) */
function defaultFreeDiskBytes(rootDir: string): () => number {
  return () => {
    try {
      const stats = fs.statfsSync(rootDir);
      return stats.bavail * stats.bsize;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
}
