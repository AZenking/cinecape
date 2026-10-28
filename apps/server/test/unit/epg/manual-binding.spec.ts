import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { DomainError } from '@platform/http-common/domain-error';
import {
  getBindingState,
  saveBinding,
  unbindBinding,
  type ManualEpgBindingState,
} from '@contexts/epg/application/manual-epg-binding.service';
import {
  RefreshExecutorService,
  type RefreshJobView,
} from '@contexts/sources/application/refresh-executor.service';
import { RefreshPublishService } from '@contexts/sources/application/refresh-publish.service';
import {
  buildXmltv,
  createControlledMediaServer,
  malformedPayloads,
  type ControlledMediaServer,
} from '../../helpers';

/**
 * 手动 EPG 绑定服务单元测试(T069/T070;data-model「## 0004 增补」/ADR-0008/quickstart H3/H4):
 * - 版本生命周期:无行 0 → manual 1 → 解除(auto 墓碑) 2 → 再次 manual 3;墓碑不删行;
 *   auto 之后再解除版本继续 +1(幂等语义由版本保护,不额外报错);
 * - 冲突矩阵:expectedVersion 旧 → 409 EPG_BINDING_VERSION_CONFLICT;候选 generation 旧 →
 *   409 EPG_CANDIDATE_STALE(即使目标仍存在);两冲突均原配置不变;
 * - 校验矩阵:非频道 400、无 IPTV 条目 400、跨家庭/未知 EPG 源 404 同形、非 epg kind 400、
 *   候选长度非法 400/不存在/冲突 422 EPG_CANDIDATE_INVALID、禁用源新绑定 422 EPG_SOURCE_NOT_READY;
 * - 派生状态:source_disabled / channel_missing / channel_conflict 动态派生;
 *   目标有效但无节目仍 valid(无节目 ≠ 失效);读取字段白名单不泄漏候选/源位置;
 * - 原子性:保存/解除与 catalog_state.revision+1 同事务;注入写失败(RAISE ABORT 触发器)
 *   → revision 不变、无部分提交;
 * - EPG generation:成功发布同事务 +1;解析失败/发布注入失败/stale 均不加;
 *   EPG 刷新全程不写/删 manual_epg_binding(手动配置跨刷新保留)。
 * 环境硬约束:小体量(每用例 ≤4 来源/≤2 条目),内联临时 DATA_DIR(照 refresh-executor.spec 模式)。
 */

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];
const servers: ControlledMediaServer[] = [];

function migrationsDir(): string {
  return path.join(process.cwd(), 'src/platform/database/migrations');
}

function migrationSql(name: string): string {
  const migrationPath = path.join(migrationsDir(), name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function bootstrapRig(extraEnv: Record<string, string> = {}): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-manual-binding-'));
  const dbFilename = `${randomUUID()}.hmp.db`;
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: dbFilename,
      LAN_ALLOWED_TARGETS: '127.0.0.1',
      ...extraEnv,
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  // 0004 已由 T068 落地(只读):manual_epg_binding 表 + media_source.epg_generation
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  rigs.push({ dataDir });
}

async function cleanupRigs(): Promise<void> {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server === undefined) {
      break;
    }
    await server.close();
  }
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

afterEach(() => {
  void cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* 造数辅助(最小链路)                                                   */
/* ------------------------------------------------------------------ */

interface HouseholdScope {
  householdId: string;
  accountId: string;
  sessionId: string;
}

function seedHousehold(name = '绑定测试家庭'): HouseholdScope {
  const db = Database.db;
  const ids: HouseholdScope = {
    householdId: randomUUID(),
    accountId: randomUUID(),
    sessionId: randomUUID(),
  };
  const now = new Date().toISOString();
  db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(
    ids.householdId,
    name,
    'zh-CN',
    'Asia/Shanghai',
    now,
  );
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(ids.accountId, ids.householdId, `owner-${ids.householdId.slice(0, 8)}`, `owner-${ids.householdId.slice(0, 8)}`, '$argon2id$fixture-hash', 'owner', now);
  db.prepare('INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, NULL, ?, NULL, NULL, ?)').run(
    randomUUID(),
    ids.householdId,
    'web',
    now,
  );
  const deviceId = db.prepare('SELECT id FROM device WHERE household_id = ?').get(ids.householdId) as { id: string };
  db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
  ).run(ids.sessionId, ids.householdId, ids.accountId, deviceId.id, `hash-${ids.sessionId}`, '2099-01-01T00:00:00Z', now, now);
  db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(ids.householdId);
  return ids;
}

function seedSource(
  householdId: string,
  kind: 'iptv' | 'epg' | 'nas',
  options: { remoteUrl?: string; enabled?: number; epgSourceId?: string | null } = {},
): string {
  const sourceId = randomUUID();
  const now = new Date().toISOString();
  Database.db
    .prepare(
      'INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, 1, NULL, NULL, ?, ?)',
    )
    .run(
      sourceId,
      householdId,
      kind,
      `${kind} 来源`,
      kind === 'nas' ? null : (options.remoteUrl ?? 'http://lan.example/guide.xml'),
      options.epgSourceId ?? null,
      options.enabled ?? 1,
      now,
      now,
    );
  return sourceId;
}

/** 身份摘要(DDL CHECK 要求 SHA-256 hex;输入串仅需测试内稳定) */
function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 频道媒体 + IPTV 来源条目(present 可指定:绑定允许条目暂时 missing) */
function seedChannelMedia(householdId: string, iptvSourceId: string, tvgId: string, present: 0 | 1 = 1): string {
  const db = Database.db;
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)",
  ).run(mediaId, householdId, `频道-${tvgId}`, now, now);
  db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(randomUUID(), householdId, iptvSourceId, digestOf(`tvg_id:${iptvSourceId}:${tvgId}`), mediaId, tvgId, present, now, now);
  return mediaId;
}

/** 非频道媒体(带 IPTV 条目:证明 400 来自类型校验而非条目校验) */
function seedNonChannelMedia(householdId: string, iptvSourceId: string): string {
  const db = Database.db;
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'movie', ?, NULL, NULL, 3, 0, 0, 1, ?, ?)",
  ).run(mediaId, householdId, '电影甲', now, now);
  db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'url', ?, ?, NULL, 1, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(randomUUID(), householdId, iptvSourceId, digestOf(`url:${iptvSourceId}:${mediaId}`), mediaId, now, now);
  return mediaId;
}

/** 无任何来源条目的频道 */
function seedBareChannel(householdId: string): string {
  const mediaId = randomUUID();
  const now = new Date().toISOString();
  Database.db
    .prepare(
      "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', ?, NULL, NULL, NULL, 0, 0, 1, ?, ?)",
    )
    .run(mediaId, householdId, '裸频道', now, now);
  return mediaId;
}

function seedEpgChannel(householdId: string, epgSourceId: string, xmltvChannelId: string, conflicted: 0 | 1 = 0): void {
  Database.db
    .prepare('INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)')
    .run(householdId, epgSourceId, xmltvChannelId, `名称-${xmltvChannelId}`, conflicted);
}

function setGeneration(sourceId: string, value: number): void {
  Database.db.prepare('UPDATE media_source SET epg_generation = ? WHERE id = ?').run(value, sourceId);
}

function generationOf(sourceId: string): number {
  return (
    Database.db.prepare('SELECT epg_generation FROM media_source WHERE id = ?').get(sourceId) as { epg_generation: number }
  ).epg_generation;
}

function revisionOf(householdId: string): number {
  return (Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as { revision: number })
    .revision;
}

function bindingRow(householdId: string, mediaId: string): Record<string, unknown> {
  return Database.db.prepare('SELECT * FROM manual_epg_binding WHERE household_id = ? AND media_id = ?').get(
    householdId,
    mediaId,
  ) as Record<string, unknown>;
}

function bindingCount(): number {
  return (Database.db.prepare('SELECT COUNT(*) AS n FROM manual_epg_binding').get() as { n: number }).n;
}

function domainErrorOf(run: () => unknown, expectedStatus?: number): DomainError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, '期望抛出 DomainError').toBeInstanceOf(DomainError);
  const error = caught as DomainError;
  if (expectedStatus !== undefined) {
    expect(error.status).toBe(expectedStatus);
  }
  return error;
}

/* ------------------------------------------------------------------ */
/* 场景与保存/解除包装(默认:同家庭 + 有效会话/账号)                      */
/* ------------------------------------------------------------------ */

interface Scene {
  household: HouseholdScope;
  iptvSourceId: string;
  epgA: string; // 默认 EPG(启用,generation 5)
  epgB: string; // 非默认 EPG(启用,generation 2)——「同家庭不同默认 EPG 可选」
  epgOff: string; // 禁用 EPG
  mediaId: string; // 绑定目标频道(条目 tvg cctv-1 挂 IPTV)
}

function sceneWithManual(): Scene {
  const household = seedHousehold();
  const iptvSourceId = seedSource(household.householdId, 'iptv');
  const epgA = seedSource(household.householdId, 'epg');
  const epgB = seedSource(household.householdId, 'epg');
  const epgOff = seedSource(household.householdId, 'epg', { enabled: 0 });
  Database.db.prepare('UPDATE media_source SET epg_source_id = ? WHERE id = ?').run(epgA, iptvSourceId);
  setGeneration(epgA, 5);
  setGeneration(epgB, 2);
  setGeneration(epgOff, 0);
  seedEpgChannel(household.householdId, epgA, 'cctv-1');
  seedEpgChannel(household.householdId, epgA, 'cctv-conflict', 1);
  seedEpgChannel(household.householdId, epgB, 'b-channel-1');
  seedEpgChannel(household.householdId, epgOff, 'off-1');
  const mediaId = seedChannelMedia(household.householdId, iptvSourceId, 'cctv-1');
  return { household, iptvSourceId, epgA, epgB, epgOff, mediaId };
}

function saveManual(scene: Scene, overrides: Partial<Parameters<typeof saveBinding>[1]> = {}): ManualEpgBindingState {
  return saveBinding(Database.db, {
    householdId: scene.household.householdId,
    mediaId: scene.mediaId,
    epgSourceId: scene.epgB,
    xmltvChannelId: 'b-channel-1',
    expectedVersion: 0,
    candidateEpgGeneration: 2,
    accountId: scene.household.accountId,
    sessionId: scene.household.sessionId,
    ...overrides,
  });
}

function unbind(scene: Scene, overrides: Partial<Parameters<typeof unbindBinding>[1]> = {}): ManualEpgBindingState {
  return unbindBinding(Database.db, {
    householdId: scene.household.householdId,
    mediaId: scene.mediaId,
    expectedVersion: 0,
    accountId: scene.household.accountId,
    sessionId: scene.household.sessionId,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* 管理读取与派生状态                                                    */
/* ------------------------------------------------------------------ */

describe('getBindingState:管理读取与派生状态(data-model「0004 增补」)', () => {
  it('无行:mode=none、version=0、valid=true;字段白名单不泄漏候选/源位置', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    const state = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(state).toEqual({
      mediaId: scene.mediaId,
      mode: 'none',
      version: 0,
      epgSourceId: null,
      xmltvChannelId: null,
      valid: true,
      invalidReason: null,
      updatedAt: null,
    });
    // 契约字段白名单:结构冻结,出现私有字段(源地址/候选集/凭据)即为泄漏
    expect(Object.keys(state).sort()).toEqual(
      ['epgSourceId', 'invalidReason', 'mediaId', 'mode', 'updatedAt', 'valid', 'version', 'xmltvChannelId'].sort(),
    );
  });

  it('manual 读取 valid;解除后 auto 墓碑:mode=auto、version 保留、目标两列为 null、行不删除', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', candidateEpgGeneration: 5 });
    const manual = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(manual.mode).toBe('manual');
    expect(manual.version).toBe(1);
    expect(manual.valid).toBe(true);
    expect(manual.invalidReason).toBeNull();
    expect(manual.epgSourceId).toBe(scene.epgA);
    expect(manual.xmltvChannelId).toBe('cctv-1');
    expect(manual.updatedAt).not.toBeNull();

    unbind(scene, { expectedVersion: 1 });
    const tombstone = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(tombstone.mode).toBe('auto');
    expect(tombstone.version).toBe(2);
    expect(tombstone.epgSourceId).toBeNull();
    expect(tombstone.xmltvChannelId).toBeNull();
    expect(tombstone.valid).toBe(true);
    expect(tombstone.invalidReason).toBeNull();
    // 墓碑行保留(防 ABA),不删除
    expect(bindingCount()).toBe(1);
    expect(bindingRow(scene.household.householdId, scene.mediaId).mode).toBe('auto');
  });

  it('目标源禁用 → invalid(source_disabled);恢复启用后同 ID 回 valid,版本不变', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', candidateEpgGeneration: 5 });
    Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(scene.epgA);
    const disabled = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(disabled.valid).toBe(false);
    expect(disabled.invalidReason).toBe('source_disabled');
    expect(disabled.mode).toBe('manual');
    expect(disabled.version).toBe(1);

    Database.db.prepare('UPDATE media_source SET enabled = 1 WHERE id = ?').run(scene.epgA);
    const recovered = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(recovered.valid).toBe(true);
    expect(recovered.invalidReason).toBeNull();
    expect(recovered.version).toBe(1);
  });

  it('目标频道在该源缺失 → invalid(channel_missing)', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', candidateEpgGeneration: 5 });
    Database.db.prepare('DELETE FROM epg_channel WHERE household_id = ? AND source_id = ? AND xmltv_channel_id = ?').run(
      scene.household.householdId,
      scene.epgA,
      'cctv-1',
    );
    const state = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(state.valid).toBe(false);
    expect(state.invalidReason).toBe('channel_missing');
  });

  it('conflicted 候选保存被拒;保存后目标被标冲突 → invalid(channel_conflict)', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    // 前置:conflicted 候选本身不可保存(422,T071 契约)
    expect(
      domainErrorOf(
        () => saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-conflict', expectedVersion: 0, candidateEpgGeneration: 5 }),
        422,
      ).code,
    ).toBe('EPG_CANDIDATE_INVALID');
    // 保存合法目标后,该频道在后续窗口被标冲突 → 派生失效
    saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', candidateEpgGeneration: 5 });
    Database.db
      .prepare('UPDATE epg_channel SET conflicted = 1 WHERE household_id = ? AND source_id = ? AND xmltv_channel_id = ?')
      .run(scene.household.householdId, scene.epgA, 'cctv-1');
    const state = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(state.valid).toBe(false);
    expect(state.invalidReason).toBe('channel_conflict');
  });

  it('来源启用且目标有效但无任何节目 → 仍 valid(无当前节目 ≠ 绑定失效)', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', candidateEpgGeneration: 5 });
    const programmeCount = Database.db.prepare('SELECT COUNT(*) AS n FROM epg_programme').get() as { n: number };
    expect(programmeCount.n).toBe(0); // 前置:全库无任何节目行
    const state = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(state.valid).toBe(true);
    expect(state.invalidReason).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 版本生命周期与并发防护                                                */
/* ------------------------------------------------------------------ */

describe('saveBinding/unbindBinding:版本生命周期(quickstart H4)', () => {
  it('无行 0 → manual 1 → 解除 auto 2 → 再次 manual 3;全程恒一行(墓碑不删行);非默认同家庭 EPG 可选', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    // 目标为非默认 EPG(epgB,generation 2):手动绑定可选同家庭任一启用 EPG
    expect(saveManual(scene).version).toBe(1);
    expect(bindingCount()).toBe(1);
    expect(getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId }).mode).toBe('manual');

    expect(unbind(scene, { expectedVersion: 1 }).version).toBe(2);
    expect(bindingCount()).toBe(1);

    expect(saveManual(scene, { expectedVersion: 2 }).version).toBe(3);
    expect(bindingCount()).toBe(1);
    const row = bindingRow(scene.household.householdId, scene.mediaId);
    expect(row.mode).toBe('manual');
    expect(row.epg_source_id).toBe(scene.epgB);
    expect(row.xmltv_channel_id).toBe('b-channel-1');
  });

  it('auto 之后再解除:版本继续 +1(幂等语义由版本保护,不额外报错)', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    unbind(scene, { expectedVersion: 0 }); // 无行解除 → v1 auto 墓碑
    expect(getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId }).version).toBe(1);
    const again = unbind(scene, { expectedVersion: 1 }); // auto 再解除 → v2
    expect(again.mode).toBe('auto');
    expect(again.version).toBe(2);
    expect(bindingCount()).toBe(1);
  });

  it('expectedVersion 旧 → 409 EPG_BINDING_VERSION_CONFLICT,原配置逐字段不变', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', candidateEpgGeneration: 5 });
    const before = bindingRow(scene.household.householdId, scene.mediaId);
    const error = domainErrorOf(() => saveManual(scene, { expectedVersion: 0 }), 409);
    expect(error.code).toBe('EPG_BINDING_VERSION_CONFLICT');
    expect(bindingRow(scene.household.householdId, scene.mediaId)).toEqual(before);
  });

  it('candidateEpgGeneration 过期(人为 +1)→ 409 EPG_CANDIDATE_STALE,即使目标仍存在;原配置不变', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', candidateEpgGeneration: 5 });
    const before = bindingRow(scene.household.householdId, scene.mediaId);
    setGeneration(scene.epgA, 6); // 模拟候选查询后 EPG 又成功发布
    const error = domainErrorOf(
      () => saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-1', expectedVersion: 1, candidateEpgGeneration: 5 }),
      409,
    );
    expect(error.code).toBe('EPG_CANDIDATE_STALE');
    expect(bindingRow(scene.household.householdId, scene.mediaId)).toEqual(before);
  });

  it('解除 expectedVersion 旧 → 409 EPG_BINDING_VERSION_CONFLICT,墓碑原样', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene);
    unbind(scene, { expectedVersion: 1 });
    const before = bindingRow(scene.household.householdId, scene.mediaId);
    const error = domainErrorOf(() => unbind(scene, { expectedVersion: 0 }), 409);
    expect(error.code).toBe('EPG_BINDING_VERSION_CONFLICT');
    expect(bindingRow(scene.household.householdId, scene.mediaId)).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* 目标与媒体校验矩阵                                                    */
/* ------------------------------------------------------------------ */

describe('saveBinding:媒体/目标/候选校验矩阵', () => {
  it('非频道媒体(带 IPTV 条目)→ 400 VALIDATION_FAILED', () => {
    bootstrapRig();
    const household = seedHousehold();
    const iptv = seedSource(household.householdId, 'iptv');
    const epg = seedSource(household.householdId, 'epg');
    const movieId = seedNonChannelMedia(household.householdId, iptv);
    const error = domainErrorOf(
      () =>
        saveBinding(Database.db, {
          householdId: household.householdId,
          mediaId: movieId,
          epgSourceId: epg,
          xmltvChannelId: 'cctv-1',
          expectedVersion: 0,
          candidateEpgGeneration: 0,
          accountId: household.accountId,
          sessionId: household.sessionId,
        }),
      400,
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(bindingCount()).toBe(0);
  });

  it('无 IPTV 来源条目的频道 → 400(条目允许 missing,但必须存在)', () => {
    bootstrapRig();
    const household = seedHousehold();
    const epg = seedSource(household.householdId, 'epg');
    const bareChannelId = seedBareChannel(household.householdId);
    const error = domainErrorOf(
      () =>
        saveBinding(Database.db, {
          householdId: household.householdId,
          mediaId: bareChannelId,
          epgSourceId: epg,
          xmltvChannelId: 'cctv-1',
          expectedVersion: 0,
          candidateEpgGeneration: 0,
          accountId: household.accountId,
          sessionId: household.sessionId,
        }),
      400,
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(bindingCount()).toBe(0);
  });

  it('跨家庭 EPG 源与未知源统一 404 同形,不泄漏归属(NOT_FOUND 走既有 404 惯例,非 createDomainError 注册表)', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    const other = seedHousehold('邻居家');
    const foreignEpg = seedSource(other.householdId, 'epg');
    seedEpgChannel(other.householdId, foreignEpg, 'cctv-1');
    expect(domainErrorOf(() => saveManual(scene, { epgSourceId: foreignEpg, candidateEpgGeneration: 0 }), 404).code).toBe('NOT_FOUND');
    expect(domainErrorOf(() => saveManual(scene, { epgSourceId: randomUUID(), candidateEpgGeneration: 2 }), 404).code).toBe('NOT_FOUND');
    expect(bindingCount()).toBe(0);
  });

  it('目标 kind=iptv → 400;候选不存在 → 422 EPG_CANDIDATE_INVALID;候选 conflicted → 422;空串/超长 xmltv id → 400', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    const base = { expectedVersion: 0, candidateEpgGeneration: 2 } as const;
    expect(domainErrorOf(() => saveManual(scene, { epgSourceId: scene.iptvSourceId, ...base }), 400).code).toBe('VALIDATION_FAILED');
    expect(domainErrorOf(() => saveManual(scene, { xmltvChannelId: 'no-such-channel', ...base }), 422).code).toBe('EPG_CANDIDATE_INVALID');
    expect(
      domainErrorOf(
        () => saveManual(scene, { epgSourceId: scene.epgA, xmltvChannelId: 'cctv-conflict', expectedVersion: 0, candidateEpgGeneration: 5 }),
        422,
      ).code,
    ).toBe('EPG_CANDIDATE_INVALID');
    expect(domainErrorOf(() => saveManual(scene, { xmltvChannelId: '', ...base }), 400).code).toBe('VALIDATION_FAILED');
    expect(domainErrorOf(() => saveManual(scene, { xmltvChannelId: 'x'.repeat(256), ...base }), 400).code).toBe('VALIDATION_FAILED');
    expect(bindingCount()).toBe(0);
  });

  it('禁用 EPG 源新绑定 → 422 EPG_SOURCE_NOT_READY(手动目标须当前启用,ADR-0008「已启用成功导入」;T071 契约码)', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    const error = domainErrorOf(
      () => saveManual(scene, { epgSourceId: scene.epgOff, xmltvChannelId: 'off-1', expectedVersion: 0, candidateEpgGeneration: 0 }),
      422,
    );
    expect(error.code).toBe('EPG_SOURCE_NOT_READY');
    expect(bindingCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 写入前置:session/account 重验(data-model「家长验证后重验」)           */
/* ------------------------------------------------------------------ */

describe('saveBinding/unbindBinding:session/account 重验(写入前置)', () => {
  it('会话已撤销 → 401 SESSION_INVALID;跨家庭会话 → 401;跨家庭账号 → 403 FORBIDDEN;均不产生写入', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    const revisionBefore = revisionOf(scene.household.householdId);

    // 跨家庭账号(会话仍有效,先命中账号校验)→ 403
    const other = seedHousehold('另一家');
    expect(domainErrorOf(() => saveManual(scene, { accountId: other.accountId }), 403).code).toBe('FORBIDDEN');

    // 会话撤销/跨家庭会话 → 401(会话校验先于账号)
    Database.db.prepare('UPDATE device_session SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), scene.household.sessionId);
    expect(domainErrorOf(() => saveManual(scene), 401).code).toBe('SESSION_INVALID');
    expect(domainErrorOf(() => saveManual(scene, { sessionId: other.sessionId }), 401).code).toBe('SESSION_INVALID');
    expect(domainErrorOf(() => unbind(scene), 401).code).toBe('SESSION_INVALID');

    expect(bindingCount()).toBe(0);
    expect(revisionOf(scene.household.householdId)).toBe(revisionBefore);
  });
});

/* ------------------------------------------------------------------ */
/* 原子性:绑定写入与 catalog revision 同事务                             */
/* ------------------------------------------------------------------ */

describe('保存/解除与 catalog_state.revision 同事务(quickstart H4 原子提交)', () => {
  it('保存与解除各推进 revision +1', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    const before = revisionOf(scene.household.householdId);
    saveManual(scene);
    expect(revisionOf(scene.household.householdId)).toBe(before + 1);
    unbind(scene, { expectedVersion: 1 });
    expect(revisionOf(scene.household.householdId)).toBe(before + 2);
  });

  it('注入保存写失败(RAISE ABORT 触发器)→ 无行、revision 不变(无部分提交)', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    const before = revisionOf(scene.household.householdId);
    Database.db.exec("CREATE TRIGGER fail_binding_insert BEFORE INSERT ON manual_epg_binding BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    let caught: unknown;
    try {
      saveManual(scene);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(bindingCount()).toBe(0);
    expect(revisionOf(scene.household.householdId)).toBe(before);
  });

  it('注入解除写失败(RAISE ABORT 触发器)→ 原 manual 行原样、revision 不变', () => {
    bootstrapRig();
    const scene = sceneWithManual();
    saveManual(scene);
    const before = bindingRow(scene.household.householdId, scene.mediaId);
    const revisionBefore = revisionOf(scene.household.householdId);
    // BEFORE UPDATE 覆盖 upsert 冲突路径;BEFORE INSERT 兜底(防触发器语义差异绕过注入)
    Database.db.exec("CREATE TRIGGER fail_binding_update BEFORE UPDATE ON manual_epg_binding BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    Database.db.exec("CREATE TRIGGER fail_binding_insert2 BEFORE INSERT ON manual_epg_binding BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    let caught: unknown;
    try {
      unbind(scene, { expectedVersion: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(bindingRow(scene.household.householdId, scene.mediaId)).toEqual(before);
    expect(revisionOf(scene.household.householdId)).toBe(revisionBefore);
  });
});

/* ------------------------------------------------------------------ */
/* EPG generation:成功 +1、失败不加;刷新不触碰绑定表                     */
/* ------------------------------------------------------------------ */

/** XMLTV 时间戳:UTC +0000 形态(照 refresh-executor.spec) */
function xmltvStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())} +0000`
  );
}

describe('EPG 发布与 epg_generation(T070 最小修改)', () => {
  interface EpgScene {
    household: HouseholdScope;
    epgSourceId: string;
    mediaId: string;
    executor: RefreshExecutorService;
    server: ControlledMediaServer;
  }

  const HOUR_MS = 3_600_000;

  /** 含目标频道节目的 XMLTV(cctv-1 当前节目 + cctv-2 频道) */
  function xmlWithTarget(baseMs: number): string {
    return buildXmltv(
      [
        { id: 'cctv-1', displayName: '央视一套' },
        { id: 'cctv-2', displayName: '央视二套' },
      ],
      [{ channel: 'cctv-1', start: xmltvStamp(baseMs), stop: xmltvStamp(baseMs + HOUR_MS), title: '新闻' }],
    );
  }

  /**
   * EPG 发布场景:频道媒体(条目 tvg cctv-1)+ EPG 来源 + 已保存 manual 绑定(目标 cctv-1)。
   * 绑定在首个刷新前保存:验证后续 EPG 刷新全程不触碰该行。
   */
  async function epgSceneWithBinding(initialXml: string): Promise<EpgScene> {
    const server = await createControlledMediaServer();
    servers.push(server);
    bootstrapRig();
    const household = seedHousehold();
    const iptv = seedSource(household.householdId, 'iptv');
    const epgSourceId = seedSource(household.householdId, 'epg', { remoteUrl: `${server.baseUrl}/guide.xml` });
    const mediaId = seedChannelMedia(household.householdId, iptv, 'cctv-1');
    seedEpgChannel(household.householdId, epgSourceId, 'cctv-1');
    server.setRoute('/guide.xml', { kind: 'xmltv', content: initialXml });
    saveBinding(Database.db, {
      householdId: household.householdId,
      mediaId,
      epgSourceId,
      xmltvChannelId: 'cctv-1',
      expectedVersion: 0,
      candidateEpgGeneration: 0,
      accountId: household.accountId,
      sessionId: household.sessionId,
    });
    return {
      household,
      epgSourceId,
      mediaId,
      executor: new RefreshExecutorService(new RefreshPublishService()),
      server,
    };
  }

  async function runEpgRefresh(scene: EpgScene, operationKey: string): Promise<RefreshJobView | null> {
    scene.executor.requestRefresh({
      householdId: scene.household.householdId,
      accountId: scene.household.accountId,
      sessionId: scene.household.sessionId,
      sourceId: scene.epgSourceId,
      expectedVersion: 1,
      operationKey,
      ownerPasswordVerified: true,
    });
    return scene.executor.runQueuedOnce();
  }

  it('EPG 发布成功 → generation 同事务 +1(重复发布继续 +1);绑定行逐字段不变;新窗口不含目标 → 行仍在且派生 channel_missing', async () => {
    const scene = await epgSceneWithBinding(xmlWithTarget(Date.now() + HOUR_MS));
    const bindingBefore = bindingRow(scene.household.householdId, scene.mediaId);
    expect(generationOf(scene.epgSourceId)).toBe(0);

    const first = await runEpgRefresh(scene, 'op-epg-gen-1');
    expect(first?.status).toBe('succeeded');
    expect(generationOf(scene.epgSourceId)).toBe(1);
    // EPG 刷新不写/删 manual_epg_binding:手动配置跨刷新保留
    expect(bindingRow(scene.household.householdId, scene.mediaId)).toEqual(bindingBefore);

    // 第二次成功发布(内容不同):同事务再 +1
    scene.server.setRoute('/guide.xml', {
      kind: 'xmltv',
      content: buildXmltv([{ id: 'cctv-2', displayName: '央视二套' }]), // 新窗口不含 cctv-1
    });
    const second = await runEpgRefresh(scene, 'op-epg-gen-2');
    expect(second?.status).toBe('succeeded');
    expect(generationOf(scene.epgSourceId)).toBe(2);
    expect(bindingRow(scene.household.householdId, scene.mediaId)).toEqual(bindingBefore);
    // 目标频道随窗口替换消失:绑定行保留(无 FK 到 epg_channel),派生动态失效
    const state = getBindingState(Database.db, { householdId: scene.household.householdId, mediaId: scene.mediaId });
    expect(state.mode).toBe('manual');
    expect(state.valid).toBe(false);
    expect(state.invalidReason).toBe('channel_missing');
  });

  it('XMLTV 解析失败 → failed,generation 不加', async () => {
    const scene = await epgSceneWithBinding(xmlWithTarget(Date.now() + HOUR_MS));
    expect((await runEpgRefresh(scene, 'op-epg-fail-0'))?.status).toBe('succeeded');
    expect(generationOf(scene.epgSourceId)).toBe(1);

    scene.server.setRoute('/guide.xml', { kind: 'body', body: malformedPayloads.brokenXml(), contentType: 'application/xml' });
    const failed = await runEpgRefresh(scene, 'op-epg-fail-1');
    expect(failed?.status).toBe('failed');
    expect(generationOf(scene.epgSourceId)).toBe(1);
  });

  it('发布事务注入失败(节目写入 RAISE ABORT)→ failed、generation 不加、旧窗口保留', async () => {
    const scene = await epgSceneWithBinding(xmlWithTarget(Date.now() + HOUR_MS));
    expect((await runEpgRefresh(scene, 'op-epg-inject-0'))?.status).toBe('succeeded');
    expect(generationOf(scene.epgSourceId)).toBe(1);
    const programmeCount = (): number =>
      (Database.db.prepare('SELECT COUNT(*) AS n FROM epg_programme WHERE household_id = ?').get(scene.household.householdId) as { n: number }).n;
    const before = programmeCount();

    Database.db.exec("CREATE TRIGGER fail_programme_insert BEFORE INSERT ON epg_programme BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    scene.server.setRoute('/guide.xml', { kind: 'xmltv', content: xmlWithTarget(Date.now() + 2 * HOUR_MS) });
    const failed = await runEpgRefresh(scene, 'op-epg-inject-1');
    expect(failed?.status).toBe('failed');
    expect(generationOf(scene.epgSourceId)).toBe(1);
    expect(programmeCount()).toBe(before); // 旧窗口原子保留
  });

  it('stale(基线 revision 已变化)→ 不加 generation、绑定行不动', async () => {
    const scene = await epgSceneWithBinding(xmlWithTarget(Date.now() + HOUR_MS));
    const bindingBefore = bindingRow(scene.household.householdId, scene.mediaId);
    const queued = scene.executor.requestRefresh({
      householdId: scene.household.householdId,
      accountId: scene.household.accountId,
      sessionId: scene.household.sessionId,
      sourceId: scene.epgSourceId,
      expectedVersion: 1,
      operationKey: 'op-epg-stale',
      ownerPasswordVerified: true,
    });
    // 基线失效:候选/绑定在此期间被人工操作推进 revision
    Database.db.prepare('UPDATE catalog_state SET revision = revision + 1 WHERE household_id = ?').run(scene.household.householdId);
    const outcome = new RefreshPublishService().publishEpgWindow({
      householdId: scene.household.householdId,
      sourceId: scene.epgSourceId,
      refreshId: queued.id,
      jobVersion: queued.version,
      sourceVersion: queued.sourceVersion,
      baselineRevision: queued.baselineRevision,
      snapshotDigest: 'stale-digest',
      channels: [],
      programmes: [],
      conflictedChannelIds: [],
      nowMs: Date.now(),
    });
    expect(outcome).toBe('stale');
    expect(generationOf(scene.epgSourceId)).toBe(0);
    expect(bindingRow(scene.household.householdId, scene.mediaId)).toEqual(bindingBefore);
  });
});
