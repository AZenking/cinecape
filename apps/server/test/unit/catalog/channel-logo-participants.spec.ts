import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import {
  CHANNEL_LOGO_TOMBSTONE_WINDOW_MS,
  createMediaCatalogTxParticipants,
  type ChannelLogoWinnerRow,
} from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createUnitOfWork, type UnitOfWork } from '@platform/database/unit-of-work';
import { DomainError } from '@platform/http-common/domain-error';

/**
 * channel_logo 事务镜像单元契约(tasks T008;internal-ports.md §2 / data-model §4 M1–M4):
 * - 真实内存库 DDL(0001–0008 权威迁移 + channel_logo 表,data-model §2 逐列;
 *   0009 迁移目录存在时以其为准,缺省按 data-model §2 等值 DDL 兜底——并行迁移
 *   任务落地前后测试均可运行,列集/约束以 §2 为唯一事实源);
 * - 经平台 UnitOfWork 真实事务绑定执行(键 'catalog';同事务读算写原子);
 * - M1:IPTV 发布写胜者(缺行新签 ref revision=1;active 同源同 url 无操作不换 ref;
 *   换 url 同行覆盖 revision+1;epg 胜者被 iptv 接管);
 * - M2/M4:撤销转墓碑(清 upstream_url、置 revoked_at;无行/已墓碑 no-op);
 * - M3:EPG 写/复 active(墓碑同行复活 revision+1 清 revoked_at;同 url active(epg)
 *   无操作;active(iptv) 绝不被 epg 覆盖);
 * - GC:revoked_at ≤ olderThanIso 集合 DELETE,active 不受影响;
 * - setChannelPosterRef 落值/清值;
 * - CHECK/FK 非法写入被拒(墓碑不留地址、source_kind 词汇、revision>=1、媒体复合 FK);
 * - ref 同家庭冲突重签(唯一约束兜底重试,T007)。
 */

const HOUSEHOLD = 'hh-logo';
const NOW = '2026-01-01T00:00:00.000Z';

const MIGRATIONS = [
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
  '0005_playback',
  '0006_pc_experience',
  '0007_online_vod',
  '0008_profile_preferences',
] as const;

/** channel_logo 等值 DDL(data-model §2 逐列/约束;0009 迁移缺失时的测试兜底) */
const CHANNEL_LOGO_DDL = `
  CREATE TABLE IF NOT EXISTS channel_logo (
    household_id TEXT NOT NULL REFERENCES household(id),
    media_id     TEXT NOT NULL,
    ref          TEXT NOT NULL,
    upstream_url TEXT,
    source_kind  TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CONSTRAINT channel_logo_media_fk FOREIGN KEY (household_id, media_id)
      REFERENCES media_item (household_id, id) ON DELETE CASCADE,
    CONSTRAINT channel_logo_source_fk FOREIGN KEY (household_id, source_id)
      REFERENCES media_source (household_id, id),
    CONSTRAINT channel_logo_source_kind_check CHECK (source_kind IN ('iptv', 'epg')),
    CONSTRAINT channel_logo_revision_check CHECK (revision >= 1),
    CONSTRAINT channel_logo_tombstone_check CHECK (revoked_at IS NULL OR upstream_url IS NULL),
    CONSTRAINT channel_logo_household_media_key UNIQUE (household_id, media_id),
    CONSTRAINT channel_logo_household_ref_key UNIQUE (household_id, ref)
  );
`;

const openConnections: DatabaseConstructor.Database[] = [];

afterEach(() => {
  while (openConnections.length > 0) {
    openConnections.pop()?.close();
  }
});

interface Rig {
  conn: DatabaseConstructor.Database;
  /** TxStoresRegistry 以 TxStore 工厂为值(playback rig 同形:typeof createXxxTxParticipants) */
  uow: UnitOfWork<{ catalog: typeof createMediaCatalogTxParticipants }>;
  /** 确定性重签驱动:依次弹出的 ref(耗尽后回落随机 128-bit) */
  refQueue: string[];
}

function migrationSql(name: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql'), 'utf8');
}

/** 0009 迁移已落库时以其 DDL 为准;未落地(并行任务在途)按 data-model §2 兜底 */
function applyChannelLogoTable(conn: DatabaseConstructor.Database): void {
  const migrationUp = path.join(process.cwd(), 'src/platform/database/migrations', '0009_channel_logos', 'up.sql');
  if (fs.existsSync(migrationUp)) {
    conn.exec(fs.readFileSync(migrationUp, 'utf8'));
    return;
  }
  conn.exec(CHANNEL_LOGO_DDL);
}

function createRig(): Rig {
  const conn = new DatabaseConstructor(':memory:');
  conn.pragma('foreign_keys = ON');
  for (const name of MIGRATIONS) {
    conn.exec(migrationSql(name));
  }
  applyChannelLogoTable(conn);
  openConnections.push(conn);
  // 部署形态种子:家庭 + 频道媒体 + iptv/epg 来源(复合 FK 目标)
  conn.exec(
    `INSERT INTO household (id, name, default_language, timezone, created_at)
     VALUES ('${HOUSEHOLD}', 'Logo之家', 'zh-CN', 'Asia/Shanghai', '${NOW}')`,
  );
  const insertMedia = conn.prepare(
    `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
       title_overridden, type_overridden, version, media_role, created_at, updated_at)
     VALUES (?, ?, 'channel', ?, NULL, NULL, NULL, 0, 0, 1, 'standalone', ?, ?)`,
  );
  for (const mediaId of ['ch-1', 'ch-2']) {
    insertMedia.run(mediaId, HOUSEHOLD, `频道${mediaId}`, NOW, NOW);
  }
  const insertSource = conn.prepare(
    `INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  );
  insertSource.run('src-iptv', HOUSEHOLD, 'iptv', 'IPTV源', 'http://127.0.0.1:9/playlist.m3u', NOW, NOW);
  insertSource.run('src-epg', HOUSEHOLD, 'epg', 'EPG源', 'http://127.0.0.1:9/xmltv.xml', NOW, NOW);

  const refQueue: string[] = [];
  let fallbackCounter = 0;
  const uow = createUnitOfWork({
    resolveDatabase: () => conn,
    txStores: {
      catalog: (binding) => createMediaCatalogTxParticipants(binding, (size) => {
        const queued = refQueue.shift();
        if (queued !== undefined) {
          return Buffer.from(queued, 'hex').length === 16 ? Buffer.from(queued, 'hex') : Buffer.alloc(size, 0x77);
        }
        // 回退源:单调计数(每次签发不同值;确定性且不互相冲突)
        fallbackCounter += 1;
        const buffer = Buffer.alloc(size, 0);
        buffer.writeUInt32BE(fallbackCounter, 0);
        return buffer;
      }),
    },
  });
  return { conn, uow, refQueue };
}

/** 事务内执行参与者调用(真实 BEGIN IMMEDIATE 绑定) */
function runInTx<T>(rig: Rig, fn: (catalog: ReturnType<typeof createMediaCatalogTxParticipants>) => T): T {
  return rig.uow.run((txStores) => txStores.catalog, fn, { behavior: 'immediate' });
}

function winnerOf(rig: Rig, mediaId: string): ChannelLogoWinnerRow | undefined {
  return runInTx(rig, (catalog) => catalog.findChannelLogo(HOUSEHOLD, mediaId));
}

function upsert(
  rig: Rig,
  overrides: Partial<{ mediaId: string; upstreamUrl: string; sourceKind: 'iptv' | 'epg'; sourceId: string; nowIso: string }> = {},
): { ref: string } {
  return runInTx(rig, (catalog) =>
    catalog.upsertChannelLogoWinner({
      householdId: HOUSEHOLD,
      mediaId: overrides.mediaId ?? 'ch-1',
      upstreamUrl: overrides.upstreamUrl ?? 'http://127.0.0.1:9/logo.png',
      sourceKind: overrides.sourceKind ?? 'iptv',
      sourceId: overrides.sourceId ?? 'src-iptv',
      nowIso: overrides.nowIso ?? NOW,
    }),
  );
}

function revoke(rig: Rig, mediaId: string, nowIso: string): void {
  runInTx(rig, (catalog) => catalog.revokeChannelLogo(HOUSEHOLD, mediaId, nowIso));
}

describe('channel_logo 事务镜像(T008;M1–M4)', () => {
  it('M1a 缺行新签:IPTV 写胜者 → active(iptv),ref 32 hex,revision=1', () => {
    const rig = createRig();
    const { ref } = upsert(rig);
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    const row = winnerOf(rig, 'ch-1');
    expect(row).toMatchObject({
      mediaId: 'ch-1',
      ref,
      upstreamUrl: 'http://127.0.0.1:9/logo.png',
      sourceKind: 'iptv',
      sourceId: 'src-iptv',
      revision: 1,
      revokedAt: null,
    });
  });

  it('M1b active 同源同 url ⇒ 无操作不换 ref(data-model §6 ref 稳定性)', () => {
    const rig = createRig();
    const first = upsert(rig, { nowIso: '2026-01-01T00:00:00.000Z' });
    const second = upsert(rig, { nowIso: '2026-01-02T00:00:00.000Z' });
    expect(second.ref).toBe(first.ref);
    const row = winnerOf(rig, 'ch-1');
    expect(row).toMatchObject({ ref: first.ref, revision: 1, upstreamUrl: 'http://127.0.0.1:9/logo.png' });
  });

  it('M1c 换 url:同行覆盖,新 ref,revision+1,revoked_at 保持 NULL', () => {
    const rig = createRig();
    const first = upsert(rig);
    const second = upsert(rig, { upstreamUrl: 'http://127.0.0.1:9/logo-v2.png', nowIso: '2026-01-03T00:00:00.000Z' });
    expect(second.ref).not.toBe(first.ref);
    const row = winnerOf(rig, 'ch-1');
    expect(row).toMatchObject({
      ref: second.ref,
      upstreamUrl: 'http://127.0.0.1:9/logo-v2.png',
      revision: 2,
      revokedAt: null,
      sourceKind: 'iptv',
    });
  });

  it('M1d epg 胜者被 iptv 接管:url 相同也换源换 ref(iptv 必胜)', () => {
    const rig = createRig();
    const epg = upsert(rig, { sourceKind: 'epg', sourceId: 'src-epg' });
    const iptv = upsert(rig, { sourceKind: 'iptv', sourceId: 'src-iptv', nowIso: '2026-01-04T00:00:00.000Z' });
    expect(iptv.ref).not.toBe(epg.ref);
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ sourceKind: 'iptv', revision: 2, revokedAt: null });
  });

  it('M2 撤销转墓碑:清 upstream_url + 置 revoked_at;已墓碑/无行 no-op', () => {
    const rig = createRig();
    upsert(rig);
    revoke(rig, 'ch-1', '2026-01-05T00:00:00.000Z');
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ upstreamUrl: null, revokedAt: '2026-01-05T00:00:00.000Z' });
    // 幂等:重复撤销不刷新 revoked_at(墓碑窗口以首次撤销时间计)
    revoke(rig, 'ch-1', '2026-01-06T00:00:00.000Z');
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ revokedAt: '2026-01-05T00:00:00.000Z' });
    // 无行撤销 no-op
    revoke(rig, 'ch-2', '2026-01-06T00:00:00.000Z');
    expect(winnerOf(rig, 'ch-2')).toBeUndefined();
  });

  it('M3a/M3c EPG 写/复 active:缺行写入;同 url active(epg) 无操作不换 ref', () => {
    const rig = createRig();
    const first = upsert(rig, { sourceKind: 'epg', sourceId: 'src-epg' });
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ sourceKind: 'epg', revision: 1, revokedAt: null });
    const second = upsert(rig, { sourceKind: 'epg', sourceId: 'src-epg', nowIso: '2026-01-07T00:00:00.000Z' });
    expect(second.ref).toBe(first.ref);
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ revision: 1 });
  });

  it('M3b 墓碑同行复 active:清 revoked_at、新 ref、revision+1', () => {
    const rig = createRig();
    const first = upsert(rig);
    revoke(rig, 'ch-1', '2026-01-05T00:00:00.000Z');
    const revived = upsert(rig, { upstreamUrl: 'http://127.0.0.1:9/logo-v3.png', nowIso: '2026-01-08T00:00:00.000Z' });
    expect(revived.ref).not.toBe(first.ref);
    expect(winnerOf(rig, 'ch-1')).toMatchObject({
      ref: revived.ref,
      upstreamUrl: 'http://127.0.0.1:9/logo-v3.png',
      revision: 2,
      revokedAt: null,
    });
  });

  it('M3d active(iptv) 且 epg 发布 ⇒ 不动(epg 绝不覆盖 iptv;url 同异皆然)', () => {
    const rig = createRig();
    const iptv = upsert(rig);
    // url 不同
    const kept = upsert(rig, { sourceKind: 'epg', sourceId: 'src-epg', upstreamUrl: 'http://127.0.0.1:9/epg-logo.png' });
    expect(kept.ref).toBe(iptv.ref);
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ sourceKind: 'iptv', revision: 1 });
    // url 相同
    const keptSameUrl = upsert(rig, { sourceKind: 'epg', sourceId: 'src-epg' });
    expect(keptSameUrl.ref).toBe(iptv.ref);
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ sourceKind: 'iptv', revision: 1 });
  });

  it('M4 active(epg) 撤销转墓碑(active(iptv) 的撤销由调用方证据门决定,执行体对 active 行生效)', () => {
    const rig = createRig();
    upsert(rig, { sourceKind: 'epg', sourceId: 'src-epg' });
    revoke(rig, 'ch-1', '2026-01-09T00:00:00.000Z');
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ sourceKind: 'epg', upstreamUrl: null, revokedAt: '2026-01-09T00:00:00.000Z' });
  });

  it('GC:revoked_at ≤ olderThanIso 集合 DELETE;active 行与新墓碑不受影响', () => {
    const rig = createRig();
    upsert(rig, { mediaId: 'ch-1' });
    revoke(rig, 'ch-1', '2025-12-01T00:00:00.000Z'); // 远超 7d 窗口 → 应删
    upsert(rig, { mediaId: 'ch-2' });
    revoke(rig, 'ch-2', '2025-12-30T00:00:00.000Z'); // 窗口内 → 应留
    const gcAt = '2026-01-01T00:00:00.000Z';
    const olderThan = new Date(new Date(gcAt).getTime() - CHANNEL_LOGO_TOMBSTONE_WINDOW_MS).toISOString();
    expect(olderThan).toBe('2025-12-25T00:00:00.000Z');
    runInTx(rig, (catalog) => catalog.gcExpiredChannelLogoTombstones(HOUSEHOLD, olderThan));
    expect(winnerOf(rig, 'ch-1')).toBeUndefined();
    expect(winnerOf(rig, 'ch-2')).toMatchObject({ revokedAt: '2025-12-30T00:00:00.000Z' });
    // GC 后旧 ref 解析单查为 undefined(404 同形的存储依据)
    const gone = runInTx(rig, (catalog) => catalog.findChannelLogo(HOUSEHOLD, 'ch-1'));
    expect(gone).toBeUndefined();
  });

  it('setChannelPosterRef:落引用值与清 NULL(发布事务内 poster_ref 承载)', () => {
    const rig = createRig();
    const { ref } = upsert(rig);
    runInTx(rig, (catalog) => catalog.setChannelPosterRef(HOUSEHOLD, 'ch-1', ref));
    expect(rig.conn.prepare('SELECT poster_ref AS ref FROM media_item WHERE id = ?').get('ch-1')).toMatchObject({ ref });
    runInTx(rig, (catalog) => catalog.setChannelPosterRef(HOUSEHOLD, 'ch-1', null));
    expect(rig.conn.prepare('SELECT poster_ref AS ref FROM media_item WHERE id = ?').get('ch-1')).toMatchObject({ ref: null });
  });

  it('CHECK/FK 非法写入被拒:墓碑不留地址/source_kind 词汇/revision>=1/媒体复合 FK', () => {
    const rig = createRig();
    const insertRaw = rig.conn.prepare(
      `INSERT INTO channel_logo (household_id, media_id, ref, upstream_url, source_kind, source_id, revision, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // 墓碑态保留 upstream_url → CHECK 拒绝(data-model §2「墓碑不留地址」)
    expect(() =>
      insertRaw.run(HOUSEHOLD, 'ch-1', 'a'.repeat(32), 'http://127.0.0.1:9/x.png', 'iptv', 'src-iptv', 1, NOW, NOW, NOW),
    ).toThrowError(/CHECK|constraint/i);
    // source_kind 越界词汇 → CHECK 拒绝
    expect(() =>
      insertRaw.run(HOUSEHOLD, 'ch-1', 'b'.repeat(32), 'http://127.0.0.1:9/x.png', 'nas', 'src-iptv', 1, null, NOW, NOW),
    ).toThrowError(/CHECK|constraint/i);
    // revision < 1 → CHECK 拒绝
    expect(() =>
      insertRaw.run(HOUSEHOLD, 'ch-1', 'c'.repeat(32), 'http://127.0.0.1:9/x.png', 'iptv', 'src-iptv', 0, null, NOW, NOW),
    ).toThrowError(/CHECK|constraint/i);
    // 跨家庭媒体复合 FK(ch-1 不属其他家庭)→ FK 拒绝
    expect(() =>
      insertRaw.run('hh-other', 'ch-1', 'd'.repeat(32), 'http://127.0.0.1:9/x.png', 'iptv', 'src-iptv', 1, null, NOW, NOW),
    ).toThrowError(/FOREIGN KEY|constraint/i);
    expect(winnerOf(rig, 'ch-1')).toBeUndefined();
  });

  it('ref 同家庭冲突重签:预置冲突 ref → 唯一约束兜底重签成功且落库一致', () => {
    const rig = createRig();
    // 先占位:ch-2 持有 ref "11..1"
    const occupiedRef = '1'.repeat(32);
    upsert(rig, { mediaId: 'ch-2', upstreamUrl: 'http://127.0.0.1:9/other.png' });
    rig.conn.prepare('UPDATE channel_logo SET ref = ? WHERE media_id = ?').run(occupiedRef, 'ch-2');
    // 注入确定性重签序列:第一次撞 ch-2 已占 ref,第二次换新值成功
    rig.refQueue.push(occupiedRef, '2'.repeat(32));
    const result = upsert(rig, { mediaId: 'ch-1' });
    expect(result.ref).toBe('2'.repeat(32));
    expect(winnerOf(rig, 'ch-1')).toMatchObject({ ref: '2'.repeat(32), revision: 1 });
    // 重签不破坏 ch-2 行(仅新行受影响)
    expect(winnerOf(rig, 'ch-2')).toMatchObject({ ref: occupiedRef });
  });

  it('upsert 非法 mediaId(无频道媒体行)→ FK 拒绝并整体回滚(发布失败无半状态)', () => {
    const rig = createRig();
    expect(() =>
      runInTx(rig, (catalog) => {
        catalog.upsertChannelLogoWinner({
          householdId: HOUSEHOLD,
          mediaId: 'ch-missing',
          upstreamUrl: 'http://127.0.0.1:9/logo.png',
          sourceKind: 'iptv',
          sourceId: 'src-iptv',
          nowIso: NOW,
        });
        catalog.setChannelPosterRef(HOUSEHOLD, 'ch-1', 'x'.repeat(32));
      }),
    ).toThrowError(/FOREIGN KEY|constraint/i);
    // 回滚:无半状态(ch-1 poster_ref 未被写值)
    expect(rig.conn.prepare('SELECT poster_ref AS ref FROM media_item WHERE id = ?').get('ch-1')).toMatchObject({ ref: null });
  });

  it('DomainError 410/502/504 映射所需的 shared 问题码已注册(T005 前置)', () => {
    expect(ProblemCode.MEDIA_LOGO_REVOKED).toBe('MEDIA_LOGO_REVOKED');
    expect(ProblemCode.MEDIA_LOGO_UPSTREAM_FAILED).toBe('MEDIA_LOGO_UPSTREAM_FAILED');
    expect(ProblemCode.MEDIA_LOGO_UPSTREAM_TIMEOUT).toBe('MEDIA_LOGO_UPSTREAM_TIMEOUT');
    const error = new DomainError(410, ProblemCode.MEDIA_LOGO_REVOKED, '频道 Logo 引用已失效,请刷新列表');
    expect(error.status).toBe(410);
    expect(error.code).toBe('MEDIA_LOGO_REVOKED');
  });
});
