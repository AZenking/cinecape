import { createHash, randomUUID } from 'node:crypto';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { Database } from '@platform/database/database';

/**
 * 原始导入快照(021-source-governance,FR-004/FR-005)。
 *
 * - 只保存 IPTV(M3U)与 EPG(XMLTV)成功读取后的原始传输字节;NAS 无单一原文,不保存;
 * - 存储统一 gzip:上游已是 gzip 则原样保存,否则应用侧 gzip;`content_encoding` 恒 gzip;
 * - `byte_size`/`sha256` 针对原始传输字节(下载时解码回原文,非 .gz);
 * - 预览上限 256 KiB、UTF-8 安全截断;完整下载只在设置边界内提供;
 * - 快照写入是旁路能力:调用方必须捕获失败,不得让刷新失败。
 */

/** 预览字节上限(256 KiB;与 UI 契约一致) */
export const SNAPSHOT_PREVIEW_BYTES = 256 * 1024;

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

export interface ImportSnapshotInput {
  householdId: string;
  sourceId: string;
  refreshId: string;
  kind: 'iptv' | 'epg';
  raw: Buffer;
  capturedAtIso: string;
}

export interface ImportSnapshotMeta {
  id: string;
  kind: 'iptv' | 'epg';
  capturedAt: string;
  byteSize: number;
  sha256: string;
}

function isGzip(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer.subarray(0, 2).equals(GZIP_MAGIC);
}

/** 保存快照(原始传输字节 → gzip BLOB)。返回新行 id。 */
export function saveImportSnapshot(input: ImportSnapshotInput): string {
  const content = isGzip(input.raw) ? input.raw : gzipSync(input.raw);
  const id = randomUUID();
  Database.db
    .prepare(
      `INSERT INTO source_import_snapshot
        (id, household_id, source_id, refresh_id, kind, content_encoding, content, byte_size, sha256, captured_at)
       VALUES (?, ?, ?, ?, ?, 'gzip', ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.householdId,
      input.sourceId,
      input.refreshId,
      input.kind,
      content,
      input.raw.length,
      createHash('sha256').update(input.raw).digest('hex'),
      input.capturedAtIso,
    );
  return id;
}

/** 来源最近 20 条快照元数据(不含原文/上游地址)。 */
export function listImportSnapshots(householdId: string, sourceId: string): ImportSnapshotMeta[] {
  const rows = Database.db
    .prepare(
      `SELECT id, kind, captured_at AS capturedAt, byte_size AS byteSize, sha256
         FROM source_import_snapshot
        WHERE household_id = ? AND source_id = ?
        ORDER BY captured_at DESC, id DESC
        LIMIT 20`,
    )
    .all(householdId, sourceId) as ImportSnapshotMeta[];
  return rows;
}

interface SnapshotContentRow {
  id: string;
  kind: 'iptv' | 'epg';
  capturedAt: string;
  byteSize: number;
  sha256: string;
  content: Buffer;
}

/** 按家庭/来源读取完整快照行;不存在或跨家庭返回 undefined。 */
export function findImportSnapshot(
  householdId: string,
  sourceId: string,
  snapshotId: string,
): SnapshotContentRow | undefined {
  return Database.db
    .prepare(
      `SELECT id, kind, captured_at AS capturedAt, byte_size AS byteSize, sha256, content
         FROM source_import_snapshot
        WHERE household_id = ? AND source_id = ? AND id = ?`,
    )
    .get(householdId, sourceId, snapshotId) as SnapshotContentRow | undefined;
}

/**
 * 解码 gzip 前缀(最多 maxBytes),返回 UTF-8 文本与是否截断。
 * 用流式 gunzip 避免为预览解压整份 128 MiB XML。
 */
export async function decodeSnapshotPrefix(
  content: Buffer,
  maxBytes: number = SNAPSHOT_PREVIEW_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const gunzip = createGunzip();
  const source = Readable.from([content]);
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of source.pipe(gunzip)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (total + buffer.length > maxBytes) {
        chunks.push(buffer);
        total += buffer.length;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      total += buffer.length;
    }
  } catch {
    // 损坏 gzip:返回空预览(下载同样会失败),不让治理页 500
    return { text: '', truncated: true };
  } finally {
    gunzip.destroy();
  }
  const merged = Buffer.concat(chunks);
  let end = Math.min(merged.length, maxBytes);
  // UTF-8 边界安全:结束字节落在 continuation byte 上时回退到字符起始
  while (end > 0 && end < merged.length && (merged[end] ?? 0) >= 0x80 && (merged[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return { text: merged.subarray(0, end).toString('utf8'), truncated: truncated || merged.length > end };
}

/** 完整解码(下载用);损坏时抛错由控制器映射 502。 */
export function decodeSnapshotFull(content: Buffer): Buffer {
  return isGzip(content) ? gunzipSync(content) : content;
}


/**
 * 边解析边捕获原始传输字节(不改变解析器消费节奏)。
 * 超过 maxBytes 即停止收集并标记 overflow;解析器仍按自己的预算继续消费。
 */
export function captureStream(
  input: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number,
): { stream: AsyncIterable<Buffer>; snapshot: () => Buffer | null } {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflow = false;
  const stream = (async function* (): AsyncIterable<Buffer> {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!overflow) {
        if (total + buffer.length > maxBytes) {
          overflow = true;
          chunks.length = 0;
        } else {
          chunks.push(buffer);
          total += buffer.length;
        }
      }
      yield buffer;
    }
  })();
  return {
    stream,
    snapshot: () => (overflow ? null : Buffer.concat(chunks)),
  };
}
