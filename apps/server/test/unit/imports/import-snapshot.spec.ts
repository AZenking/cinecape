import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import {
  captureStream,
  decodeSnapshotPrefix,
  findImportSnapshot,
  listImportSnapshots,
  saveImportSnapshot,
} from '@contexts/sources/infrastructure/import-snapshot';
import { cleanupRigs, startFreshApp } from '../../helpers';

/**
 * 021 · 原始导入快照基础设施:
 * - captureStream 边解析边捕获,超预算放弃快照但继续透传;
 * - 存储 gzip 化、元数据列表、UTF-8 安全前缀预览。
 */


const HOUSEHOLD_ID = 'h-snapshot';
const SOURCE_ID = 's-snapshot';

beforeAll(async () => {
  await startFreshApp({ prefix: 'hmp-snapshot-' });
  Database.db
    .prepare(
      `INSERT INTO household (id, name, timezone, created_at, version, main_profile_version)
       VALUES (?, '快照家庭', 'Asia/Shanghai', '2026-11-13T00:00:00.000Z', 1, 1)`,
    )
    .run(HOUSEHOLD_ID);
  Database.db
    .prepare(
      `INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, created_at, updated_at)
       VALUES (?, ?, 'iptv', '快照源', 'http://example.com/a.m3u', 1, '2026-11-13T00:00:00.000Z', '2026-11-13T00:00:00.000Z')`,
    )
    .run(SOURCE_ID, HOUSEHOLD_ID);
});

afterAll(async () => {
  await cleanupRigs();
});

describe('021 · import snapshot', () => {
  it('captureStream 透传全部 chunk 并保序拼接;超预算返回 null', async () => {
    async function* chunks(): AsyncIterable<Buffer> {
      yield Buffer.from('#EXTM3U\n');
      yield Buffer.from('中文频道');
    }
    const captured = captureStream(chunks(), 1024);
    const seen: Buffer[] = [];
    for await (const chunk of captured.stream) seen.push(chunk);
    expect(Buffer.concat(seen).toString('utf8')).toBe('#EXTM3U\n中文频道');
    expect(captured.snapshot()?.toString('utf8')).toBe('#EXTM3U\n中文频道');

    const overflow = captureStream(chunks(), 4);
    for await (const _chunk of overflow.stream) {
      // drain
    }
    expect(overflow.snapshot()).toBeNull();
  });

  it('save/list/find/preview:原文 gzip 存储,预览只返回前缀', async () => {
    const raw = Buffer.from('<tv><channel id="c1"><display-name>频道一</display-name></channel></tv>', 'utf8');
    const id = saveImportSnapshot({
      householdId: HOUSEHOLD_ID,
      sourceId: SOURCE_ID,
      refreshId: 'r-1',
      kind: 'epg',
      raw,
      capturedAtIso: '2026-11-13T08:00:00.000Z',
    });
    const list = listImportSnapshots(HOUSEHOLD_ID, SOURCE_ID);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(id);
    expect(list[0]?.byteSize).toBe(raw.length);

    const row = findImportSnapshot(HOUSEHOLD_ID, SOURCE_ID, id);
    expect(row).toBeDefined();
    expect(row?.content[0]).toBe(0x1f);
    expect(row?.content[1]).toBe(0x8b);

    const preview = await decodeSnapshotPrefix(row!.content, 16);
    expect(preview.truncated).toBe(true);
    expect(preview.text.startsWith('<tv><channel id=')).toBe(true);
    expect(Buffer.byteLength(preview.text, 'utf8')).toBeLessThanOrEqual(16);
  });
});
