import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { bindEpgStore } from '@contexts/epg/application/epg-store.port';
import { drizzleEpgStore } from '@contexts/epg/infrastructure/epg-store.drizzle';
import { getMediaProgrammes } from '@contexts/epg/application/epg.service';
import { saveBinding, unbindBinding } from '@contexts/epg/application/manual-epg-binding.service';

/**
 * 普通节目查询手动优先语义单元测试(T071;data-model「0004 增补」/FR-023~025):
 * - manual 有效 → 只用 manual 目标(即使 FR-007 自动精确匹配同时命中另一来源,不叠加/不比较);
 * - manual 失效(源禁用/频道缺失)→ 200 unavailable 且**不回退**自动/其他 EPG
 *   (失效是配置事实,自动链命中也不放行);
 * - 无行或 auto 墓碑 → 沿用 FR-007 来源级自动精确匹配(解除后恢复自动)。
 * 授权走零档案家庭兜底路径(本文件不建 profile,家庭无任何档案 → 无政策放行,可用性仍生效),
 * 会话/设备行仍须真实有效(loadProgrammeReadContext 信任源重验)。
 * 环境硬约束:内联临时 DATA_DIR(照 manual-binding.spec 模式),每用例独立 rig。
 */

interface DbRig {
  dataDir: string;
}

const rigs: DbRig[] = [];

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

function bootstrapRig(): void {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-manual-priority-'));
  setEnvOverride(
    loadEnv({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      DB_FILENAME: `${randomUUID()}.hmp.db`,
      LAN_ALLOWED_TARGETS: '127.0.0.1',
    }),
  );
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  // 016 收敛:rig 迁移清单补到 0010(epg store 查询 media_source 已含 0010 列 priority;
  // 0008~0010 均为代际 2 尾段增量表/列,对本用例手动绑定优先级断言面零影响)
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding', '0005_playback', '0006_pc_experience', '0007_online_vod', '0008_profile_preferences', '0009_channel_logos', '0010_multi_source_priority']) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  // 008-T007(ADR-0015 D1/D2):rig 绑定 epg 仓储 seam(惰性 getDb,单例重开安全;
  // 绑定函数已无 db 参数,每次 rig 重建幂等覆盖)
  bindEpgStore(drizzleEpgStore());
  rigs.push({ dataDir });
}

function cleanupRigs(): void {
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
  cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* 造数:家庭/会话 + IPTV(默认 EPG=B,条目 tvg cctv-1)+ 两个 EPG 源        */
/* ------------------------------------------------------------------ */

interface Scene {
  householdId: string;
  accountId: string;
  sessionId: string;
  epgA: string; // 手动目标源(启用;channel alt-1)
  epgB: string; // IPTV 默认 EPG(FR-007 自动命来源;channel cctv-1)
  mediaId: string;
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedScene(): Scene {
  const db = Database.db;
  const householdId = randomUUID();
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const now = nowIso();
  db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(
    householdId,
    '优先级测试家庭',
    'zh-CN',
    'Asia/Shanghai',
    now,
  );
  db.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(accountId, householdId, `owner-${householdId.slice(0, 8)}`, `owner-${householdId.slice(0, 8)}`, '$argon2id$fixture-hash', 'owner', now);
  db.prepare(
    'INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, NULL, ?, NULL, NULL, ?)',
  ).run(randomUUID(), householdId, 'web', now);
  const deviceId = (db.prepare('SELECT id FROM device WHERE household_id = ?').get(householdId) as { id: string }).id;
  db.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)',
  ).run(sessionId, householdId, accountId, deviceId, `hash-${sessionId}`, '2099-01-01T00:00:00Z', now, now);
  db.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)').run(householdId);

  const insertSource = db.prepare(
    'INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, epg_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, 1, ?, NULL, ?, ?, ?)',
  );
  const epgA = randomUUID();
  const epgB = randomUUID();
  const iptv = randomUUID();
  insertSource.run(epgA, householdId, 'epg', '手动目标源', 'http://a.example/guide.xml', null, 1, now, 1, now, now);
  insertSource.run(epgB, householdId, 'epg', '默认指南源', 'http://b.example/guide.xml', null, 1, now, 1, now, now);
  insertSource.run(iptv, householdId, 'iptv', '受控IPTV', 'http://iptv.example/list.m3u8', epgB, 1, now, 0, now, now);

  // 频道媒体 + present 条目(upstream cctv-1)+ 播放资源(可用性链)
  const mediaId = randomUUID();
  db.prepare(
    "INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level, title_overridden, type_overridden, version, created_at, updated_at) VALUES (?, ?, 'channel', '频道甲', NULL, NULL, 0, 0, 0, 1, ?, ?)",
  ).run(mediaId, householdId, now, now);
  db.prepare(
    "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since, file_size_text, file_mtime_ns) VALUES (?, ?, ?, 'tvg_id', ?, ?, 'cctv-1', 1, NULL, ?, ?, NULL, NULL, NULL)",
  ).run(randomUUID(), householdId, iptv, digestOf(`tvg_id:${iptv}:cctv-1`), mediaId, now, now);
  db.prepare(
    "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, mime_type, priority, requires_proxy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'http', 'http://play.example/s.m3u8', NULL, 100, 0, ?, ?)",
  ).run(randomUUID(), householdId, iptv, (db.prepare('SELECT id FROM source_entry WHERE media_id = ?').get(mediaId) as { id: string }).id, mediaId, now, now);

  // EPG 频道与节目:A 源 alt-1(手动目标)、B 源 cctv-1(自动目标),各有当前+未来节目
  const insertChannel = db.prepare(
    'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)',
  );
  insertChannel.run(householdId, epgA, 'alt-1', 'A源频道', 0);
  insertChannel.run(householdId, epgB, 'cctv-1', 'B源频道', 0);
  const insertProgramme = db.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  const hour = 3_600_000;
  const base = Date.now() - 10 * 60_000;
  insertProgramme.run(randomUUID(), householdId, epgA, 'alt-1', 'A源当前节目', new Date(base).toISOString(), new Date(base + hour).toISOString());
  insertProgramme.run(randomUUID(), householdId, epgA, 'alt-1', 'A源下一节目', new Date(base + hour).toISOString(), new Date(base + 2 * hour).toISOString());
  insertProgramme.run(randomUUID(), householdId, epgB, 'cctv-1', 'B源当前节目', new Date(base).toISOString(), new Date(base + hour).toISOString());
  insertProgramme.run(randomUUID(), householdId, epgB, 'cctv-1', 'B源下一节目', new Date(base + hour).toISOString(), new Date(base + 2 * hour).toISOString());

  return { householdId, accountId, sessionId, epgA, epgB, mediaId };
}

function sessionContextOf(scene: Scene): SessionContext {
  return {
    session: {
      id: scene.sessionId,
      householdId: scene.householdId,
      accountId: scene.accountId,
      deviceId: (Database.db.prepare('SELECT device_id FROM device_session WHERE id = ?').get(scene.sessionId) as { device_id: string }).device_id,
      activeProfileId: null,
      expiresAt: '2099-01-01T00:00:00Z',
    },
    account: {
      id: scene.accountId,
      householdId: scene.householdId,
      username: 'owner',
      role: 'owner',
    },
  };
}

function saveManual(scene: Scene, overrides: Partial<Parameters<typeof saveBinding>[0]> = {}): void {
  saveBinding({
    householdId: scene.householdId,
    mediaId: scene.mediaId,
    epgSourceId: scene.epgA,
    xmltvChannelId: 'alt-1',
    expectedVersion: 0,
    candidateEpgGeneration: 1,
    accountId: scene.accountId,
    sessionId: scene.sessionId,
    ...overrides,
  });
}

describe('getMediaProgrammes 手动优先(T071;manual 唯一优先/invalid 不回退/auto 沿用 FR-007)', () => {
  it('manual 有效 → 只用 manual 目标(A 源),不叠加/不比较同时命中的自动匹配(B 源)', () => {
    bootstrapRig();
    const scene = seedScene();
    saveManual(scene);
    const result = getMediaProgrammes(sessionContextOf(scene), scene.mediaId);
    expect(result.status).toBe('available');
    expect(result.current).toMatchObject({ title: 'A源当前节目' });
    expect(result.next).toMatchObject({ title: 'A源下一节目' });
    expect(JSON.stringify(result)).not.toContain('B源'); // 自动链命中也不混入
    expect(JSON.stringify(result)).not.toContain(scene.epgA); // 普通响应不暴露绑定目标
  });

  it('manual 失效(目标源禁用)→ 200 unavailable 且不回退:自动链仍命中 B 源也不放行', () => {
    bootstrapRig();
    const scene = seedScene();
    saveManual(scene);
    Database.db.prepare('UPDATE media_source SET enabled = 0 WHERE id = ?').run(scene.epgA);
    const result = getMediaProgrammes(sessionContextOf(scene), scene.mediaId);
    expect(result).toEqual({ status: 'unavailable', current: null, next: null });
  });

  it('manual 失效(目标频道缺失)→ unavailable 不回退;同 ID 恢复后绑定重新有效', () => {
    bootstrapRig();
    const scene = seedScene();
    saveManual(scene);
    // 窗口替换语义:节目随频道行一起消失(先节目后频道,复合 FK)
    Database.db.prepare('DELETE FROM epg_programme WHERE household_id = ? AND source_id = ? AND xmltv_channel_id = ?').run(
      scene.householdId,
      scene.epgA,
      'alt-1',
    );
    Database.db
      .prepare('DELETE FROM epg_channel WHERE household_id = ? AND source_id = ? AND xmltv_channel_id = ?')
      .run(scene.householdId, scene.epgA, 'alt-1');
    expect(getMediaProgrammes(sessionContextOf(scene), scene.mediaId)).toEqual({ status: 'unavailable', current: null, next: null });

    // 目标同 ID 恢复(FR-025):绑定重新有效,manual 目标回到读取
    Database.db
      .prepare('INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, 0)')
      .run(scene.householdId, scene.epgA, 'alt-1', 'A源频道');
    const hour = 3_600_000;
    const base = Date.now() - 10 * 60_000;
    Database.db
      .prepare('INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
      .run(randomUUID(), scene.householdId, scene.epgA, 'alt-1', 'A源当前节目', new Date(base).toISOString(), new Date(base + hour).toISOString());
    const recovered = getMediaProgrammes(sessionContextOf(scene), scene.mediaId);
    expect(recovered.status).toBe('available');
    expect(recovered.current).toMatchObject({ title: 'A源当前节目' });
  });

  it('无行 → 沿用 FR-007 自动精确匹配(B 源);解除写 auto 墓碑后仍自动', () => {
    bootstrapRig();
    const scene = seedScene();
    const noRow = getMediaProgrammes(sessionContextOf(scene), scene.mediaId);
    expect(noRow.status).toBe('available');
    expect(noRow.current).toMatchObject({ title: 'B源当前节目' });

    // manual → 解除(auto 墓碑):恢复自动
    saveManual(scene);
    unbindBinding({
      householdId: scene.householdId,
      mediaId: scene.mediaId,
      expectedVersion: 1,
      accountId: scene.accountId,
      sessionId: scene.sessionId,
    });
    const afterUnbind = getMediaProgrammes(sessionContextOf(scene), scene.mediaId);
    expect(afterUnbind.status).toBe('available');
    expect(afterUnbind.current).toMatchObject({ title: 'B源当前节目' });
  });
});
