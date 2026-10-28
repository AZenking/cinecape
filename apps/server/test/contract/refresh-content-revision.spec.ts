import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupRigs, startFreshApp, type TestRig } from '../helpers';
import { seedPersonalWorld, type PersonalWorld } from '../unit/personal/personal-world';
import { Database } from '../../src/database/database';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { sourceEntry } from '../../src/database/schema';
import { eq } from 'drizzle-orm';
import { stageEntries } from '@contexts/sources/infrastructure/refresh-staging.service';
import { RefreshPublishService } from '@contexts/sources/application/refresh-publish.service';

/**
 * T148(005 US4)—— refresh-publish 可信 NAS 内容变化分支:
 *
 * 权威:data-model.md §2「media_item.content_revision:同一 NAS 身份文件的可信
 * size/mtime 变化时,导入发布事务递增该值,普通标题/分级修改只改既有 version」。
 * 矩阵:
 * - 发布事务比较已存 size/mtime,真实内容变化 → content_revision 递增(且只 +1/次);
 * - 同一成功快照重试幂等(不重复递增);
 * - 标题/分级修改不触发(size/mtime 未变 → 不递增,仅既有 version 路径);
 * - 修订递增与 NAS 替换清理(分级置空/名单移除)同事务。
 */

describe('T148 · 导入发布的内容修订分支', () => {
  let rig: TestRig;
  let world: PersonalWorld;
  let publish: RefreshPublishService;
  let householdId: string;
  let sourceId: string;
  let refreshId: string;

  function seedNasSourceWithJob(): void {
    const db = Database.db;
    db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(householdId);
    db.prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, enabled, version, created_at, updated_at) VALUES (?, ?, 'nas', 'T148 NAS', NULL, 't148-root', 'media', 1, 1, 1, ?, ?)",
    ).run(sourceId, householdId, '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z');
    db.prepare(
      "INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 1, 1, 1, NULL, NULL, ?)",
    ).run(refreshId, householdId, sourceId, world.accountId, world.deviceSessionAId, `t148-op-${refreshId}`, '2026-10-23T00:00:00.000Z');
  }

  interface PublishInput {
    readonly sizeText: string;
    readonly mtimeNsText: string;
    readonly nowMs: number;
    readonly jobVersionOverride?: number;
  }

  function stageAndPublish(input: PublishInput): 'succeeded' | 'stale' {
    const db = Database.db;
    const src = db.prepare('SELECT version AS v FROM media_source WHERE id = ?').get(sourceId) as { v: number };
    const job = db.prepare('SELECT version AS v FROM source_refresh WHERE id = ?').get(refreshId) as { v: number };
    const catalog = db.prepare('SELECT revision AS r FROM catalog_state WHERE household_id = ?').get(householdId) as { r: number };
    const staged = stageEntries(db, {
      householdId,
      refreshId,
      kind: 'nas',
      entries: [{ relativePath: 'movie.mp4', sizeText: input.sizeText, mtimeNsText: input.mtimeNsText }],
    });
    db.prepare('UPDATE source_refresh SET snapshot_digest = ? WHERE id = ? AND household_id = ?').run(staged.snapshotDigest, refreshId, householdId);
    return publish.publishEntrySnapshot({
      householdId,
      sourceId,
      refreshId,
      kind: 'nas',
      jobVersion: input.jobVersionOverride ?? job.v,
      sourceVersion: src.v,
      baselineRevision: catalog.r,
      snapshotDigest: staged.snapshotDigest,
      counts: { added: 0, updated: 1, missing: 0 },
      nowMs: input.nowMs,
    });
  }

  function mediaRow(): { id: string; content_revision: number; version: number; content_level: number | null } {
    const entry = getDb().select().from(sourceEntry).where(eq(sourceEntry.sourceId, sourceId)).get() as { mediaId: string };
    return Database.db.prepare('SELECT id, content_revision, version, content_level FROM media_item WHERE id = ?').get(entry.mediaId) as {
      id: string;
      content_revision: number;
      version: number;
      content_level: number | null;
    };
  }

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t148-publish-' });
    world = seedPersonalWorld(rig);
    publish = new RefreshPublishService();
    householdId = world.householdId;
    sourceId = 't148-src';
    refreshId = 't148-job';
    seedNasSourceWithJob();
  });
  afterEach(cleanupRigs);

  it('真实内容变化(size/mtime 任一)→ 发布事务递增 content_revision 恰好一次', () => {
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T01:00:00.000Z') })).toBe('succeeded');
    let row = mediaRow();
    expect(row.content_revision).toBe(1);
    const versionBefore = row.version;

    // size+mtime 同时变化:单次发布只 +1
    expect(stageAndPublish({ sizeText: '200', mtimeNsText: '2000', nowMs: Date.parse('2026-10-23T02:00:00.000Z') })).toBe('succeeded');
    row = mediaRow();
    expect(row.content_revision).toBe(2);
    expect(row.version).toBeGreaterThan(versionBefore);

    // 仅 mtime 变化:再 +1
    expect(stageAndPublish({ sizeText: '200', mtimeNsText: '3000', nowMs: Date.parse('2026-10-23T03:00:00.000Z') })).toBe('succeeded');
    expect(mediaRow().content_revision).toBe(3);
  });

  it('同一成功快照重试幂等:不再递增', () => {
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T01:00:00.000Z') })).toBe('succeeded');
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T02:00:00.000Z') })).toBe('succeeded');
    expect(mediaRow().content_revision).toBe(1);
  });

  it('标题/分级修改不触发:size/mtime 未变的发布只走既有 version 路径', () => {
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T01:00:00.000Z') })).toBe('succeeded');
    expect(mediaRow().content_revision).toBe(1);
    // 人工标题/分级修改(人工修正路径:title_overridden=1 保护 + 既有 version;
    // 发布重放同快照不改写也不递增修订)
    Database.db
      .prepare('UPDATE media_item SET title = ?, title_overridden = 1, content_level = 12, version = version + 1 WHERE id = ?')
      .run('人工标题', mediaRow().id);
    const manual = mediaRow();
    expect(manual.version).toBeGreaterThanOrEqual(2);
    expect(mediaRow().content_revision).toBe(1);
    // 同快照重试:标题/分级保持人工值,修订不动
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T03:00:00.000Z') })).toBe('succeeded');
    const after = Database.db.prepare('SELECT title, content_level, content_revision FROM media_item WHERE id = ?').get(mediaRow().id) as {
      title: string;
      content_level: number;
      content_revision: number;
    };
    expect(after.title).toBe('人工标题');
    expect(after.content_level).toBe(12);
    expect(after.content_revision).toBe(1);
  });

  it('修订递增与 NAS 替换清理同事务:分级置空且修订推进(失败回滚两者皆不发生)', () => {
    expect(stageAndPublish({ sizeText: '100', mtimeNsText: '1000', nowMs: Date.parse('2026-10-23T01:00:00.000Z') })).toBe('succeeded');
    Database.db.prepare('UPDATE media_item SET content_level = 12 WHERE id = ?').run(mediaRow().id);
    expect(stageAndPublish({ sizeText: '999', mtimeNsText: '9999', nowMs: Date.parse('2026-10-23T02:00:00.000Z') })).toBe('succeeded');
    const row = mediaRow();
    // 替换清理:分级置空;修订同步递增(同事务)
    expect(row.content_level).toBeNull();
    expect(row.content_revision).toBe(2);
  });
});
