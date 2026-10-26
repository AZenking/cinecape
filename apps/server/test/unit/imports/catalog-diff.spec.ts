import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import type { LoadedStagedEntry, StageEntriesResult } from '../../../src/modules/imports/refresh-staging.service';
import {
  clearStagedEntries,
  computeSnapshotDigest as computeStagedSnapshotDigest,
  loadStagedEntries,
  stageEntries,
  STAGE_WRITE_BATCH_SIZE,
} from '../../../src/modules/imports/refresh-staging.service';
import {
  canonicalJson,
  DELETION_RATIO_THRESHOLD,
  IDENTITY_DUPLICATED,
  IDENTITY_MISSING_URL,
  CatalogDiffFailure,
  computeBatchEntryIdentities,
  computeEntryIdentity,
  computeSnapshotDigest,
  diffSnapshot,
  evaluateExceptions,
  type EntryIdentity,
  type EvaluateExceptionsInput,
  type IptvEntryInput,
  type NasEntryInput,
  type SnapshotDigestItem,
} from '../../../src/modules/imports/catalog-diff';

/**
 * 目录刷新暂存/差异纯函数测试(T017;FR-005/research R5/R6,满足 T025 的纯函数部分):
 * - 身份材料规则:tvg-id 原文大小写敏感、完整 URL 不删 query、NAS 相对路径 POSIX 原文,
 *   identity_digest = SHA-256(类型标签 + '\u0000' + 标识原文) 输出 64 位小写 hex;
 * - 重复身份:同一批次重复 entry_key 整批拒绝(IDENTITY_DUPLICATED),不以最后一条覆盖,
 *   错误信息不携带 URL/tvg-id 原文(地址可能带凭据,research R3);
 * - snapshot_digest:对 entry_key+payload 规范化(键排序)后 SHA-256,顺序无关——
 *   输入顺序不同/对象键插入顺序不同均得到相同摘要,任一条目变化即摘要不同;
 * - 差异计数:added/updated/missing 按身份集合计算(baseline 传 present=true 投影,
 *   present 标志为防御性字段);
 * - 异常判定:合法空快照→empty_snapshot、missing/currentPresent≥25%→deletion_ratio_exceeded
 *   (分母=当前 present 条目数,不是历史所有行;恰好 25% 触发),首次导入豁免一切确认。
 */

/** 与实现无关地推导期望摘要:SHA-256(标签 + NUL + 标识原文) */
function expectedDigest(kindTag: string, identityValue: string): string {
  return createHash('sha256').update(`${kindTag}\u0000${identityValue}`, 'utf8').digest('hex');
}

/** 运行批量身份计算并断言失败为 CatalogDiffFailure 且携带期望稳定 code */
function failureCodeOf(run: () => unknown, expectedCode: string): CatalogDiffFailure {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望失败(${expectedCode})但成功返回`).toBeInstanceOf(CatalogDiffFailure);
  const failure = caught as CatalogDiffFailure;
  expect(failure.code).toBe(expectedCode);
  return failure;
}

/** 构造 IPTV 条目(形状与 parseM3U 输出一致) */
function iptv(tvgId: string | null, url: string, title = '频道'): IptvEntryInput {
  return { tvgId, title, url };
}

/** 构造 NAS 条目(形状与 scanNasRoot 输出一致) */
function nas(relativePath: string, sizeText = '1024', mtimeNsText = '1729600000000000000'): NasEntryInput {
  return { relativePath, sizeText, mtimeNsText };
}

/** 断言身份四元组:kind/value 原文/digest=SHA-256(标签+NUL+原文)/entryKey 前缀拼接 */
function expectIdentity(
  identity: EntryIdentity,
  kindTag: 'tvg_id' | 'url' | 'path',
  identityValue: string,
): void {
  expect(identity.identityKind).toBe(kindTag);
  expect(identity.identityValue).toBe(identityValue);
  expect(identity.identityDigest).toBe(expectedDigest(kindTag, identityValue));
  expect(identity.identityDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(identity.entryKey).toBe(`${kindTag}:${expectedDigest(kindTag, identityValue)}`);
}

describe('computeEntryIdentity:身份与摘要规则(FR-005/research R6)', () => {
  it('IPTV 有 tvg-id:identity_kind=tvg_id,标识=tvg-id 原文,entry_key=kind:digest', () => {
    expectIdentity(computeEntryIdentity('iptv', iptv('cctv-1', 'http://stream.example/1')), 'tvg_id', 'cctv-1');
  });

  it('tvg-id 大小写敏感:CCTV-1 与 cctv-1 是不同身份(不做归一化)', () => {
    const upper = computeEntryIdentity('iptv', iptv('CCTV-1', 'http://stream.example/1'));
    const lower = computeEntryIdentity('iptv', iptv('cctv-1', 'http://stream.example/1'));
    expectIdentity(upper, 'tvg_id', 'CCTV-1');
    expectIdentity(lower, 'tvg_id', 'cctv-1');
    expect(upper.entryKey).not.toBe(lower.entryKey);
  });

  it('IPTV 无 tvg-id:回退完整 URL 身份,query 原样保留(不删 query、不脱敏)', () => {
    const url = 'http://stream.example/live?token=abc&ch=1';
    expectIdentity(computeEntryIdentity('iptv', iptv(null, url)), 'url', url);
  });

  it('URL 仅 query 不同即不同身份(大小写敏感材料规则)', () => {
    const plain = computeEntryIdentity('iptv', iptv(null, 'http://stream.example/live'));
    const withQuery = computeEntryIdentity('iptv', iptv(null, 'http://stream.example/live?token=abc'));
    expect(plain.entryKey).not.toBe(withQuery.entryKey);
    // 同一路径不同大小写同理
    const mixedCase = computeEntryIdentity('iptv', iptv(null, 'http://stream.example/Live'));
    expect(mixedCase.entryKey).not.toBe(plain.entryKey);
  });

  it('tvg-id 为空串视为缺失:回退 URL 身份(「非空」语义)', () => {
    expectIdentity(computeEntryIdentity('iptv', iptv('', 'http://stream.example/1')), 'url', 'http://stream.example/1');
  });

  it('tvg-id 缺失且 URL 为空:稳定 code IDENTITY_MISSING_URL', () => {
    const failure = failureCodeOf(() => computeEntryIdentity('iptv', iptv(null, '')), IDENTITY_MISSING_URL);
    // 错误信息不携带地址原文(无 URL 可携带,锁定脱敏边界)
    expect(failure.message).not.toContain('http');
  });

  it('NAS:path 身份=相对路径原文(POSIX / 分隔),大小写敏感', () => {
    expectIdentity(computeEntryIdentity('nas', nas('Movies/纪录片/a.mkv')), 'path', 'Movies/纪录片/a.mkv');
    const lower = computeEntryIdentity('nas', nas('movies/a.mkv'));
    const upper = computeEntryIdentity('nas', nas('Movies/A.mkv'));
    expect(lower.entryKey).not.toBe(upper.entryKey);
  });
});

describe('重复身份:同一批次重复 entry_key 整批拒绝(FR-005)', () => {
  it('IPTV 两条 tvg-id 相同(即使 URL 不同)→ IDENTITY_DUPLICATED,不以最后一条覆盖', () => {
    const entries = [iptv('cctv-1', 'http://stream.example/1'), iptv('cctv-1', 'http://stream.example/2')];
    const failure = failureCodeOf(() => computeBatchEntryIdentities('iptv', entries), IDENTITY_DUPLICATED);
    // 消息只含序号与 entry_key(哈希),不携带 URL/tvg-id 原文
    expect(failure.message).not.toContain('http://stream.example');
    expect(failure.message).not.toContain('cctv-1');
  });

  it('IPTV 无 tvg-id 时完整 URL 重复(含 query)→ 拒绝;仅 query 不同 → 不拒绝', () => {
    expect(() =>
      computeBatchEntryIdentities('iptv', [iptv(null, 'http://s/1?token=a'), iptv(null, 'http://s/1?token=a')]),
    ).toThrow(CatalogDiffFailure);
    const identities = computeBatchEntryIdentities('iptv', [
      iptv(null, 'http://s/1?token=a'),
      iptv(null, 'http://s/1?token=b'),
    ]);
    expect(identities).toHaveLength(2);
  });

  it('NAS 重复相对路径 → IDENTITY_DUPLICATED', () => {
    failureCodeOf(() => computeBatchEntryIdentities('nas', [nas('a/a.mkv'), nas('a/a.mkv')]), IDENTITY_DUPLICATED);
  });

  it('无重复时按输入顺序返回逐条身份(供暂存层对齐 payload)', () => {
    const identities = computeBatchEntryIdentities('iptv', [
      iptv('ch-1', 'http://s/1'),
      iptv(null, 'http://s/2'),
      iptv('ch-3', 'http://s/3'),
    ]);
    expect(identities.map((identity) => identity.identityKind)).toEqual(['tvg_id', 'url', 'tvg_id']);
    expectIdentity(identities[1]!, 'url', 'http://s/2');
  });
});

describe('computeSnapshotDigest:顺序无关规范化摘要(research R5/R6)', () => {
  /** 由条目构造摘要输入;keyOrder 控制对象键插入顺序以验证键序无关 */
  function digestItems(count: number, keyOrder: 'natural' | 'reversed' = 'natural'): SnapshotDigestItem[] {
    return Array.from({ length: count }, (_, index) => {
      const entryKey = `url:${expectedDigest('url', `http://s/${index}`)}`;
      const fields: Record<string, unknown> = { url: `http://s/${index}`, title: `频道${index}`, tvgId: null };
      const payload =
        keyOrder === 'natural'
          ? fields
          : { tvgId: fields.tvgId, title: fields.title, url: fields.url };
      return { entryKey, payload };
    });
  }

  it('内容相同、输入顺序不同 → 摘要相同(顺序无关)', () => {
    const forward = computeSnapshotDigest(digestItems(5));
    const backward = computeSnapshotDigest([...digestItems(5)].reverse());
    expect(backward).toBe(forward);
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
  });

  it('payload 对象键插入顺序不同 → 摘要相同(规范化按键排序)', () => {
    expect(computeSnapshotDigest(digestItems(3, 'natural'))).toBe(computeSnapshotDigest(digestItems(3, 'reversed')));
  });

  it('任一条目变化(title/entryKey/payload 字段) → 摘要不同', () => {
    const base = computeSnapshotDigest(digestItems(4));
    const retitled = digestItems(4);
    retitled[2] = { ...retitled[2]!, payload: { ...(retitled[2]!.payload as Record<string, unknown>), title: '改名' } };
    expect(computeSnapshotDigest(retitled)).not.toBe(base);

    const rekeyed = digestItems(4);
    rekeyed[1] = { ...rekeyed[1]!, entryKey: `url:${expectedDigest('url', 'http://s/changed')}` };
    expect(computeSnapshotDigest(rekeyed)).not.toBe(base);

    const resized = digestItems(4);
    resized[0] = { ...resized[0]!, payload: { ...(resized[0]!.payload as Record<string, unknown>), sizeText: '2048' } };
    expect(computeSnapshotDigest(resized)).not.toBe(base);
  });

  it('空快照摘要确定(与 SHA-256 空输入一致),不抛错', () => {
    expect(computeSnapshotDigest([])).toBe(createHash('sha256').update('').digest('hex'));
  });
});

describe('diffSnapshot:added/updated/missing 计数(research R5)', () => {
  it('空基线(首次导入):全部 staged 计入 added', () => {
    expect(
      diffSnapshot([], [{ entryKey: 'url:a' }, { entryKey: 'url:b' }, { entryKey: 'url:c' }]).counts,
    ).toEqual({ added: 3, updated: 0, missing: 0 });
  });

  it('混合:baseline(A,B,C present) × staged(B,C,D) → added=1 updated=2 missing=1', () => {
    expect(
      diffSnapshot(
        [{ entryKey: 'a', present: true }, { entryKey: 'b', present: true }, { entryKey: 'c', present: true }],
        [{ entryKey: 'b' }, { entryKey: 'c' }, { entryKey: 'd' }],
      ).counts,
    ).toEqual({ added: 1, updated: 2, missing: 1 });
  });

  it('staged 顺序无关:同一内容不同顺序计数一致', () => {
    const baseline = [{ entryKey: 'a', present: true }, { entryKey: 'b', present: true }];
    const staged = [{ entryKey: 'a' }, { entryKey: 'c' }];
    expect(diffSnapshot(baseline, staged).counts).toEqual(diffSnapshot(baseline, [...staged].reverse()).counts);
  });

  it('present=false 的 baseline 行:matched staged 条目不进 added/updated(执行器约定只传 present=true 投影,此处锁定防御语义)', () => {
    // 'gone' 命中 present=false 的历史行 → 既非 added 也非 updated;
    // 'a' present=true 且 staged 缺席 → 正常计入 missing
    const counts = diffSnapshot(
      [{ entryKey: 'a', present: true }, { entryKey: 'gone', present: false }],
      [{ entryKey: 'gone' }],
    ).counts;
    expect(counts).toEqual({ added: 0, updated: 0, missing: 1 });
    // present=true 的行在 staged 缺席时才计入 missing
    expect(
      diffSnapshot([{ entryKey: 'a', present: true }, { entryKey: 'gone', present: false }], []).counts.missing,
    ).toBe(1);
  });

  it('staged 全部消失:missing 计满 baseline present 数', () => {
    expect(diffSnapshot([{ entryKey: 'a', present: true }, { entryKey: 'b', present: true }], []).counts).toEqual({
      added: 0,
      updated: 0,
      missing: 2,
    });
  });
});

describe('evaluateExceptions:确认豁免与异常判定(research R5)', () => {
  function input(overrides: Partial<EvaluateExceptionsInput>): EvaluateExceptionsInput {
    return {
      counts: { added: 0, updated: 1, missing: 0 },
      baselinePresentCount: 1,
      isFirstImport: false,
      emptySnapshotAllowed: false,
      ...overrides,
    };
  }

  it('阈值常量为 0.25(锁定规格:缺失比例 ≥25% 触发)', () => {
    expect(DELETION_RATIO_THRESHOLD).toBe(0.25);
  });

  it('首次导入(baseline 空)不触发任何确认——含空快照', () => {
    expect(evaluateExceptions(input({ isFirstImport: true, counts: { added: 5, updated: 0, missing: 0 }, baselinePresentCount: 0 }))).toEqual({
      requiresConfirmation: false,
      reason: null,
    });
    expect(evaluateExceptions(input({ isFirstImport: true, counts: { added: 0, updated: 0, missing: 0 }, baselinePresentCount: 0 }))).toEqual({
      requiresConfirmation: false,
      reason: null,
    });
  });

  it('合法空快照:staged 为空且 baselinePresentCount>0 → empty_snapshot', () => {
    expect(
      evaluateExceptions(input({ counts: { added: 0, updated: 0, missing: 2 }, baselinePresentCount: 2 })),
    ).toEqual({ requiresConfirmation: true, reason: 'empty_snapshot' });
  });

  it('emptySnapshotAllowed=true:空快照豁免确认(且不落入 deletion_ratio 分支)', () => {
    expect(
      evaluateExceptions(
        input({ emptySnapshotAllowed: true, counts: { added: 0, updated: 0, missing: 4 }, baselinePresentCount: 4 }),
      ),
    ).toEqual({ requiresConfirmation: false, reason: null });
  });

  it('缺失比例语义边界 24.9% / 恰好 25% / 25.1%:仅 ≥25% 触发(分母=当前 present 数)', () => {
    // 249/1000 = 24.9%:不触发
    expect(
      evaluateExceptions(
        input({ counts: { added: 0, updated: 751, missing: 249 }, baselinePresentCount: 1000 }),
      ),
    ).toEqual({ requiresConfirmation: false, reason: null });
    // 250/1000 = 恰好 25%:触发
    expect(
      evaluateExceptions(
        input({ counts: { added: 0, updated: 750, missing: 250 }, baselinePresentCount: 1000 }),
      ),
    ).toEqual({ requiresConfirmation: true, reason: 'deletion_ratio_exceeded' });
    // 251/1000 = 25.1%:触发
    expect(
      evaluateExceptions(
        input({ counts: { added: 0, updated: 749, missing: 251 }, baselinePresentCount: 1000 }),
      ),
    ).toEqual({ requiresConfirmation: true, reason: 'deletion_ratio_exceeded' });
  });

  it('分母是当前 present 条目数,不是历史所有行:present=false 行不摊薄比例', () => {
    // 基线投影含 4 个 present=true + 12 个 present=false(历史 16 行);
    // staged 非空且缺 1 条:1/4=25% 必须触发(若错用 16 行分母则仅 6.25% 不触发)
    const baseline = [
      { entryKey: 'a', present: true },
      { entryKey: 'b', present: true },
      { entryKey: 'c', present: true },
      { entryKey: 'd', present: true },
      ...Array.from({ length: 12 }, (_, index) => ({ entryKey: `gone-${index}`, present: false })),
    ];
    const counts = diffSnapshot(baseline, [{ entryKey: 'b' }, { entryKey: 'c' }, { entryKey: 'd' }, { entryKey: 'new' }]).counts;
    expect(counts).toEqual({ added: 1, updated: 3, missing: 1 });
    expect(evaluateExceptions(input({ counts, baselinePresentCount: 4 }))).toEqual({
      requiresConfirmation: true,
      reason: 'deletion_ratio_exceeded',
    });
  });

  it('正常差异:staged 非空且比例低于阈值 → 不需确认,reason=null', () => {
    expect(
      evaluateExceptions(input({ counts: { added: 3, updated: 98, missing: 2 }, baselinePresentCount: 100 })),
    ).toEqual({ requiresConfirmation: false, reason: null });
  });
});

describe('refresh_stage_entry 暂存持久化(refresh-staging.service;真实 SQLite + 0003 DDL)', () => {
  /**
   * 内联临时库夹具(照 catalog-migration.e2e-spec.ts 的做法,不改 test/helpers.ts):
   * 独立临时 DATA_DIR/DB → 依序直读应用 0001/0002/0003 的权威 up.sql →
   * 直写 household/account/device/device_session/media_source/source_refresh 最小链路
   * (满足 refresh_stage_entry 的复合外键),用例级 afterEach 关闭并清理。
   */

  interface DbRig {
    dataDir: string;
    dbFilename: string;
  }

  interface RefreshScope {
    householdId: string;
    sourceId: string;
    refreshId: string;
  }

  const rigs: DbRig[] = [];

  function migrationsDir(): string {
    return path.join(process.cwd(), 'src/database/migrations');
  }

  function migrationSql(name: string): string {
    const migrationPath = path.join(migrationsDir(), name, 'up.sql');
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
    }
    return fs.readFileSync(migrationPath, 'utf8');
  }

  /** 全新临时库:仅创建版本表(不经 Database.isReady),迁移由本文件内联直读应用 */
  function startFreshDb(): void {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-catalog-diff-'));
    const dbFilename = `${randomUUID()}.hmp.db`;
    setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename }));
    Database.close();
    Database.db.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
    );
    rigs.push({ dataDir, dbFilename });
  }

  function applyMigration(name: string): void {
    const conn = Database.db;
    conn.transaction(() => {
      conn.exec(migrationSql(name));
      conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }

  /** 建一套完整外键链并返回 (household, source, refresh) 作用域;每套独立,互不干扰 */
  function seedRefreshScope(operationKey: string): RefreshScope {
    const ids: RefreshScope = { householdId: randomUUID(), sourceId: randomUUID(), refreshId: randomUUID() };
    const now = new Date().toISOString();
    const db = Database.db;
    db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(
      ids.householdId,
      '暂存测试家庭',
      'zh-CN',
      'Asia/Shanghai',
      now,
    );
    db.prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), ids.householdId, `stager-${operationKey}`, `stager-${operationKey}`, '$argon2id$fixture-hash', 'owner', now);
    const accountId = db.prepare('SELECT id FROM account WHERE household_id = ?').get(ids.householdId) as {
      id: string;
    };
    const deviceId = randomUUID();
    db.prepare('INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      deviceId,
      ids.householdId,
      null,
      'web',
      null,
      null,
      now,
    );
    db.prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(randomUUID(), ids.householdId, accountId.id, deviceId, `hash-${operationKey}`, null, '2099-01-01T00:00:00Z', null, now, now);
    const sessionId = db.prepare('SELECT id FROM device_session WHERE household_id = ?').get(ids.householdId) as {
      id: string;
    };
    db.prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, 'iptv', ?, ?, NULL, NULL, 1, NULL, 1, 1, NULL, NULL, ?, ?)",
    ).run(ids.sourceId, ids.householdId, '暂存测试来源', 'http://lan.example/stage.m3u8', now, now);
    db.prepare(
      "INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id, operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count, summary_json, error_code, created_at, started_at, finished_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'running', 1, 1, 1, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL)",
    ).run(ids.refreshId, ids.householdId, ids.sourceId, accountId.id, sessionId.id, operationKey, now);
    return ids;
  }

  function cleanupRig(): void {
    while (rigs.length > 0) {
      const rig = rigs.pop();
      if (rig === undefined) {
        break;
      }
      Database.close();
      setEnvOverride(null);
      fs.rmSync(rig.dataDir, { recursive: true, force: true });
    }
  }

  function rawStagedRowCount(householdId: string, refreshId: string): number {
    const row = Database.db
      .prepare('SELECT COUNT(*) AS n FROM refresh_stage_entry WHERE household_id = ? AND refresh_id = ?')
      .get(householdId, refreshId) as { n: number };
    return row.n;
  }

  function expectEntryKeyOrder(loaded: LoadedStagedEntry[]): void {
    const sorted = [...loaded].sort((left, right) => (left.entryKey < right.entryKey ? -1 : 1));
    expect(loaded.map((entry) => entry.entryKey)).toEqual(sorted.map((entry) => entry.entryKey));
  }

  // 每个用例独立临时库(照 catalog-migration.e2e-spec.ts 的模式),afterEach 关闭并清理:
  // 暂存行虽按 (household_id,refresh_id) 天然隔离,独立建库让用例间无任何共享状态。
  const bootstrapRig = (): void => {
    startFreshDb();
    for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog']) {
      applyMigration(name);
    }
  };
  afterEach(cleanupRig);

  it('stageEntries 写入 IPTV 条目:payload 含原始字段+identity,payload_json 为规范化 JSON,回读按键升序', () => {
    bootstrapRig();
    const scope = seedRefreshScope('op-stage-iptv');
    const entries = [
      iptv('cctv-1', 'http://stream.example/1', '频道一'),
      iptv(null, 'http://stream.example/2?token=abc', '频道二'),
      iptv('cctv-3', 'http://stream.example/3', '频道三'),
    ];

    const result: StageEntriesResult = stageEntries(Database.db, {
      householdId: scope.householdId,
      refreshId: scope.refreshId,
      kind: 'iptv',
      entries,
    });

    expect(result.stagedCount).toBe(3);
    expect(result.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);

    const loaded = loadStagedEntries(Database.db, { householdId: scope.householdId, refreshId: scope.refreshId });

    expect(loaded).toHaveLength(3);
    expectEntryKeyOrder(loaded);
    // 回读按键升序,与插入顺序无关:按 entryKey 映射回原条目再逐字段比对
    const entryByKey = new Map(
      entries.map((entry) => [computeEntryIdentity('iptv', entry).entryKey, entry] as const),
    );
    expect(new Set(loaded.map((row) => row.entryKey))).toEqual(new Set(entryByKey.keys()));
    for (const row of loaded) {
      const source = entryByKey.get(row.entryKey);
      expect(source, `回读行 ${row.entryKey} 应能映射回原条目`).toBeDefined();
      const expected = computeEntryIdentity('iptv', source!);
      expect(row.entryKey).toBe(expected.entryKey);
      expect(row.kind).toBe('iptv');
      // payload 回读 = 原始条目 + identity 字段(位置信息保持私有,仅供发布/摘要)
      expect(row.payload).toEqual({
        tvgId: source!.tvgId,
        title: source!.title,
        url: source!.url,
        identityKind: expected.identityKind,
        identityDigest: expected.identityDigest,
        entryKey: expected.entryKey,
      });
      // 存储文本本身即规范化 JSON(键排序,摘要输入稳定)
      expect(row.payloadJson).toBe(canonicalJson(row.payload));
    }
    // stageEntries 返回的摘要与回读行计算的摘要一致(单一事实源)
    expect(result.snapshotDigest).toBe(computeStagedSnapshotDigest(loaded));
  });

  it('重复 IPTV 身份整批拒绝(IDENTITY_DUPLICATED):事务回滚,零写入,不以最后一条覆盖', () => {
    bootstrapRig();
    const scope = seedRefreshScope('op-stage-dup');

    expect(() =>
      stageEntries(Database.db, {
        householdId: scope.householdId,
        refreshId: scope.refreshId,
        kind: 'iptv',
        entries: [iptv('cctv-1', 'http://stream.example/1'), iptv('cctv-1', 'http://stream.example/9', '后来者')],
      }),
    ).toThrow(CatalogDiffFailure);
    expect(rawStagedRowCount(scope.householdId, scope.refreshId)).toBe(0);
    expect(loadStagedEntries(Database.db, { householdId: scope.householdId, refreshId: scope.refreshId })).toEqual([]);
  });

  it(`默认分批大小常量为 ${500} 条/批(与规格建议一致)`, () => {
    expect(STAGE_WRITE_BATCH_SIZE).toBe(500);
  });

  it('NAS 分批写入(writeBatchSize=3,7 条跨 3 批含 1 条尾批)全部落库;幂等重暂存整批替换不追加', () => {
    bootstrapRig();
    const scope = seedRefreshScope('op-stage-nas');
    // mtimeNs 用 BigInt 构造十进制文本:与 NAS 扫描器一致,避开 JS number 在 1e18 量级的精度截断。
    // 经 writeBatchSize 测试缝以 7 条跨 3 批(3/3/1)验证分批语义:小体量即可锁定
    // 「跨界完整落库 + 分批顺序无关 + 幂等重暂存」,不依赖大体量构造。
    const entries = Array.from({ length: 7 }, (_, index) =>
      nas(`media/dir-${index % 3}/file-${index}.mp4`, String(1000 + index), (1729600000000000000n + BigInt(index)).toString()),
    );

    const first = stageEntries(Database.db, {
      householdId: scope.householdId,
      refreshId: scope.refreshId,
      kind: 'nas',
      entries,
      writeBatchSize: 3,
    });

    expect(first.stagedCount).toBe(7);
    expect(rawStagedRowCount(scope.householdId, scope.refreshId)).toBe(7);

    // 越过批边界的条目(第 4 条为第二批首位、第 7 条为尾批)同样完整落库
    const loaded = loadStagedEntries(Database.db, { householdId: scope.householdId, refreshId: scope.refreshId });

    expect(loaded).toHaveLength(7);
    expectEntryKeyOrder(loaded);
    // 回读按键升序,与插入顺序无关:按 entryKey 查回原条目再比对
    for (const index of [0, 3, 6] as const) {
      const identity = computeEntryIdentity('nas', entries[index]!);
      const sampled = loaded.find((row) => row.entryKey === identity.entryKey);
      expect(sampled, `第 ${index + 1} 条应完整落库`).toBeDefined();
      expect(sampled!.kind).toBe('nas');
      expect(sampled!.payload).toMatchObject({
        relativePath: `media/dir-${index % 3}/file-${index}.mp4`,
        sizeText: String(1000 + index),
        mtimeNsText: (1729600000000000000n + BigInt(index)).toString(),
      });
      expect(sampled!.entryKey).toBe(identity.entryKey);
    }

    // 幂等重暂存(同一 refresh 重试):整批替换而非追加,摘要一致
    const again = stageEntries(Database.db, {
      householdId: scope.householdId,
      refreshId: scope.refreshId,
      kind: 'nas',
      entries,
      writeBatchSize: 3,
    });
    expect(again.snapshotDigest).toBe(first.snapshotDigest);
    expect(rawStagedRowCount(scope.householdId, scope.refreshId)).toBe(7);
  });

  it('computeSnapshotDigest(暂存层):同内容不同插入顺序摘要相同;内容变化摘要不同', () => {
    bootstrapRig();
    const scopeA = seedRefreshScope('op-digest-a');
    const scopeB = seedRefreshScope('op-digest-b');
    const scopeC = seedRefreshScope('op-digest-c');
    const shared = [
      nas('media/a.mkv', '1', '11'),
      nas('media/b.mkv', '2', '22'),
      nas('media/c.mkv', '3', '33'),
    ];
    stageEntries(Database.db, { householdId: scopeA.householdId, refreshId: scopeA.refreshId, kind: 'nas', entries: shared });
    stageEntries(Database.db, {
      householdId: scopeB.householdId,
      refreshId: scopeB.refreshId,
      kind: 'nas',
      entries: [...shared].reverse(),
    });
    stageEntries(Database.db, {
      householdId: scopeC.householdId,
      refreshId: scopeC.refreshId,
      kind: 'nas',
      entries: [nas('media/a.mkv', '1', '11'), nas('media/b.mkv', '2', '22'), nas('media/c.mkv', '999999', '33')],
    });

    const loadedA = loadStagedEntries(Database.db, { householdId: scopeA.householdId, refreshId: scopeA.refreshId });
    const loadedB = loadStagedEntries(Database.db, { householdId: scopeB.householdId, refreshId: scopeB.refreshId });
    const loadedC = loadStagedEntries(Database.db, { householdId: scopeC.householdId, refreshId: scopeC.refreshId });
    expect(computeStagedSnapshotDigest(loadedB)).toBe(computeStagedSnapshotDigest(loadedA));
    expect(computeStagedSnapshotDigest(loadedC)).not.toBe(computeStagedSnapshotDigest(loadedA));
    // 空暂存摘要确定(与纯函数空集摘要一致)
    expect(computeStagedSnapshotDigest([])).toBe(computeSnapshotDigest([]));
  });

  it('clearStagedEntries:按 (household, refresh) 清理并返回删除行数;其他 refresh 不受影响', () => {
    bootstrapRig();
    const scopeA = seedRefreshScope('op-clear-a');
    const scopeB = seedRefreshScope('op-clear-b');
    stageEntries(Database.db, {
      householdId: scopeA.householdId,
      refreshId: scopeA.refreshId,
      kind: 'iptv',
      entries: [iptv('ch-a1', 'http://s/a1'), iptv('ch-a2', 'http://s/a2')],
    });
    stageEntries(Database.db, {
      householdId: scopeB.householdId,
      refreshId: scopeB.refreshId,
      kind: 'iptv',
      entries: [iptv('ch-b1', 'http://s/b1')],
    });

    expect(clearStagedEntries(Database.db, { householdId: scopeA.householdId, refreshId: scopeA.refreshId })).toBe(2);
    expect(loadStagedEntries(Database.db, { householdId: scopeA.householdId, refreshId: scopeA.refreshId })).toEqual([]);
    // 隔离:B 的暂存不受 A 清理影响
    expect(loadStagedEntries(Database.db, { householdId: scopeB.householdId, refreshId: scopeB.refreshId })).toHaveLength(1);
    // 重复清理幂等,返回 0
    expect(clearStagedEntries(Database.db, { householdId: scopeA.householdId, refreshId: scopeA.refreshId })).toBe(0);
  });

  it('串联:回读暂存 → diffSnapshot → evaluateExceptions,缺失 1/3(≥25%)触发确认', () => {
    bootstrapRig();
    const scope = seedRefreshScope('op-diff-chain');
    // 基线 = 已发布条目 a/b/c(present);本次快照 = b/c/d
    const baselineMaterials = [iptv('ch-a', 'http://s/a'), iptv('ch-b', 'http://s/b'), iptv('ch-c', 'http://s/c')];
    const baseline = baselineMaterials.map((entry) => ({
      entryKey: computeEntryIdentity('iptv', entry).entryKey,
      present: true,
    }));

    stageEntries(Database.db, {
      householdId: scope.householdId,
      refreshId: scope.refreshId,
      kind: 'iptv',
      entries: [iptv('ch-b', 'http://s/b', '频道乙'), iptv('ch-c', 'http://s/c', '频道丙'), iptv(null, 'http://s/d', '频道丁')],
    });
    const staged = loadStagedEntries(Database.db, { householdId: scope.householdId, refreshId: scope.refreshId });

    const { counts } = diffSnapshot(baseline, staged);
    expect(counts).toEqual({ added: 1, updated: 2, missing: 1 });
    expect(evaluateExceptions({ counts, baselinePresentCount: 3, isFirstImport: false, emptySnapshotAllowed: false })).toEqual({
      requiresConfirmation: true,
      reason: 'deletion_ratio_exceeded',
    });
  });
});
