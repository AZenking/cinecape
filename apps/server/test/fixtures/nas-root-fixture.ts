import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 临时 NAS 只读根夹具(T012;FR-014/research R4):
 * - os.tmpdir 下随机 base 目录,内含 root/(对应 MEDIA_ROOTS 授权根)与 outside/(根外越界样本区);
 * - 仅提供写入/链接/变更/删除/清理原语,不做任何扫描与授权逻辑;
 * - 越界路径样本:用 makeSymlink 让根内符号链接指向 outsidePath(或任意绝对路径);
 * - mtimeNs 经 utimesSync(双精度秒)尽力写入,亚毫秒存在百纳秒级误差;
 *   mutateSizeOrMtime 缺省 +1 字节并把 mtime 推进 ≥2ms,保证 stat 可观测变化。
 */

export interface NasWriteOptions {
  /** 写入后精确截断/循环填充到该字节数 */
  sizeHint?: number;
  /** 写入后尽力设置的 mtime(纳秒) */
  mtimeNs?: bigint;
}

export interface NasMutateOptions {
  /** 字节增量,默认 +1;负数为截断(不低于 0) */
  sizeDelta?: number;
  /** 显式设置 mtime(纳秒);缺省为当前值 +2ms */
  mtimeNs?: bigint;
}

export interface NasRootFixture {
  /** NAS 根(对应 MEDIA_ROOTS 的绝对只读挂载路径) */
  rootPath: string;
  /** 随机 rootKey(可用 options.rootKey 覆盖) */
  rootKey: string;
  /** 根外样本目录(越界符号链接目标等),随 cleanup 一并删除 */
  outsidePath: string;
  /** 在根内写文件(自动建父目录),返回绝对路径;relPath 越界抛错 */
  write(relPath: string, content: string | Buffer, options?: NasWriteOptions): string;
  /** 在根外样本区写文件,返回绝对路径 */
  writeOutside(relPath: string, content: string | Buffer, options?: NasWriteOptions): string;
  /** 在根内建符号链接;target 可为相对/绝对路径(含根外目标) */
  makeSymlink(relPath: string, target: string): string;
  /** 变更文件大小与/或 mtime,保证 stat 可观测地变化 */
  mutateSizeOrMtime(relPath: string, options?: NasMutateOptions): void;
  /** 删除根内文件/目录/符号链接(幂等) */
  remove(relPath: string): void;
  /** 删除整个临时 base 目录(幂等) */
  cleanup(): void;
}

export interface NasRootFixtureOptions {
  rootKey?: string;
  /** os.tmpdir 下临时目录前缀 */
  prefix?: string;
}

/** 缺省 mtime 推进量:2ms,远大于 utimesSync 双精度误差 */
const MUTATE_DEFAULT_MTIME_ADVANCE_NS = 2_000_000n;

function toBuffer(content: string | Buffer): Buffer {
  return typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
}

function applyMtimeNs(filePath: string, mtimeNs: bigint): void {
  // Node 仅暴露 utimesSync(秒);纳秒为尽力精度,但可保证可观测的变化
  const seconds = Number(mtimeNs) / 1e9;
  fs.utimesSync(filePath, seconds, seconds);
}

function fitToSizeHint(data: Buffer, sizeHint: number): Buffer {
  if (data.length === sizeHint) {
    return data;
  }
  if (data.length > sizeHint) {
    return data.subarray(0, sizeHint);
  }
  const padded = Buffer.alloc(sizeHint);
  if (data.length === 0) {
    return padded;
  }
  data.copy(padded, 0);
  // 循环填充原内容,避免全零样本
  for (let offset = data.length; offset < padded.length; offset += data.length) {
    data.copy(padded, offset, 0, Math.min(data.length, padded.length - offset));
  }
  return padded;
}

export function createNasRootFixture(options: NasRootFixtureOptions = {}): NasRootFixture {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? 'hmp-nas-'));
  const rootPath = path.join(baseDir, 'root');
  const outsidePath = path.join(baseDir, 'outside');
  fs.mkdirSync(rootPath);
  fs.mkdirSync(outsidePath);
  const rootKey = options.rootKey ?? `nas-${randomUUID().slice(0, 8)}`;
  let cleaned = false;

  function resolveInside(base: string, relPath: string, label: string): string {
    const abs = path.resolve(base, relPath);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      throw new Error(`${label}越界已拒绝: ${relPath}(越界样本请用 outsidePath + makeSymlink 构造)`);
    }
    return abs;
  }

  function writeUnder(
    base: string,
    relPath: string,
    content: string | Buffer,
    writeOptions: NasWriteOptions,
    label: string,
  ): string {
    const abs = resolveInside(base, relPath, label);
    if (writeOptions.sizeHint !== undefined && (!Number.isInteger(writeOptions.sizeHint) || writeOptions.sizeHint < 0)) {
      throw new Error('sizeHint 必须为非负整数');
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let data = toBuffer(content);
    if (writeOptions.sizeHint !== undefined) {
      data = fitToSizeHint(data, writeOptions.sizeHint);
    }
    fs.writeFileSync(abs, data);
    if (writeOptions.mtimeNs !== undefined) {
      applyMtimeNs(abs, writeOptions.mtimeNs);
    }
    return abs;
  }

  function statOf(relPath: string): fs.BigIntStats {
    return fs.statSync(resolveInside(rootPath, relPath, '读取'), { bigint: true });
  }

  return {
    rootPath,
    rootKey,
    outsidePath,
    write: (relPath, content, writeOptions = {}) => writeUnder(rootPath, relPath, content, writeOptions, '根内写入'),
    writeOutside: (relPath, content, writeOptions = {}) =>
      writeUnder(outsidePath, relPath, content, writeOptions, '根外样本写入'),
    makeSymlink: (relPath, target) => {
      const abs = resolveInside(rootPath, relPath, '符号链接创建');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(target, abs);
      return abs;
    },
    mutateSizeOrMtime: (relPath, mutateOptions = {}) => {
      const abs = resolveInside(rootPath, relPath, '变更');
      const sizeDelta = mutateOptions.sizeDelta ?? 1;
      if (sizeDelta > 0) {
        fs.appendFileSync(abs, Buffer.alloc(sizeDelta, 0x78)); // 'x'
      } else if (sizeDelta < 0) {
        const currentSize = statOf(relPath).size;
        const shrinkBy = BigInt(-sizeDelta);
        const nextSize = currentSize > shrinkBy ? currentSize - shrinkBy : 0n;
        fs.truncateSync(abs, Number(nextSize));
      }
      const mtimeNs = mutateOptions.mtimeNs ?? statOf(relPath).mtimeNs + MUTATE_DEFAULT_MTIME_ADVANCE_NS;
      applyMtimeNs(abs, mtimeNs);
    },
    remove: (relPath) => {
      const abs = resolveInside(rootPath, relPath, '删除');
      fs.rmSync(abs, { recursive: true, force: true });
    },
    cleanup: () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      fs.rmSync(baseDir, { recursive: true, force: true });
    },
  };
}
