import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { listEpgCandidates } from '@contexts/epg/application/manual-epg-binding.service';

/** 候选排序(US5 反馈优化):当前/未来有节目的候选排前面,同组内 id 升序;无节目数据行由前端打「暂无节目数据」标 */
const rigs: string[] = [];

function bootstrap(): { householdId: string; epgSourceId: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-cand-order-'));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db`, LAN_ALLOWED_TARGETS: '127.0.0.1' }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  const root = path.join(process.cwd(), 'src/database/migrations');
  for (const name of ['0001_init', '0002_profile_policy', '0003_media_catalog', '0004_manual_epg_binding']) {
    Database.db.transaction(() => {
      Database.db.exec(fs.readFileSync(path.join(root, name, 'up.sql'), 'utf8'));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  rigs.push(dataDir);
  const householdId = randomUUID();
  Database.db.prepare('INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)').run(householdId, '排序测试家庭', 'zh-CN', 'Asia/Shanghai', new Date().toISOString());
  const epgSourceId = randomUUID();
  Database.db.prepare("INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, epg_generation, last_success_at, created_at, updated_at) VALUES (?, ?, 'epg', '排序EPG', 'http://lan.test/guide.xml', 1, 1, 1, ?, ?, ?)").run(epgSourceId, householdId, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  return { householdId, epgSourceId };
}

function seedChannel(householdId: string, epgSourceId: string, xmltvId: string, displayName: string): void {
  Database.db.prepare('INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, 0)').run(householdId, epgSourceId, xmltvId, displayName);
}

function seedProgramme(householdId: string, epgSourceId: string, xmltvId: string, startMin: number, endMin: number, title: string): void {
  const iso = (min: number): string => new Date(Date.now() + min * 60000).toISOString();
  Database.db.prepare('INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)').run(randomUUID(), householdId, epgSourceId, xmltvId, title, iso(startMin), iso(endMin));
}

function cleanup(): void {
  while (rigs.length > 0) {
    const dir = rigs.pop();
    if (dir === undefined) break;
    Database.close();
    setEnvOverride(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(cleanup);

describe('listEpgCandidates 候选排序(US5 反馈优化)', () => {
  it('当前/未来有节目的候选排在无节目数据之前,组内 id 升序', () => {
    const { householdId, epgSourceId } = bootstrap();
    // id 字典序:zz 有节目,aa 无节目 —— 若未排序则 aa 在前
    seedChannel(householdId, epgSourceId, 'zz-live', '有节目台');
    seedChannel(householdId, epgSourceId, 'aa-empty', '无节目台');
    seedProgramme(householdId, epgSourceId, 'zz-live', -30, 30, '当前');
    const page = listEpgCandidates(householdId, { epgSourceId, page: 1, pageSize: 20 });
    expect(page.items.map((i) => i.xmltvChannelId)).toEqual(['zz-live', 'aa-empty']);
    expect(page.total).toBe(2);
    expect(page.epgGeneration).toBe(1);
  });

  it('两组各有多个候选时,有节目组整体在前且组内升序', () => {
    const { householdId, epgSourceId } = bootstrap();
    seedChannel(householdId, epgSourceId, 'b-empty', 'E1');
    seedChannel(householdId, epgSourceId, 'a-live', 'E2');
    seedChannel(householdId, epgSourceId, 'c-live', 'E3');
    seedProgramme(householdId, epgSourceId, 'a-live', -10, 10, 'cur');
    seedProgramme(householdId, epgSourceId, 'c-live', 30, 60, 'next-only');
    const page = listEpgCandidates(householdId, { epgSourceId, page: 1, pageSize: 20 });
    expect(page.items.map((i) => i.xmltvChannelId)).toEqual(['a-live', 'c-live', 'b-empty']);
  });

  it('全部无节目数据时保持 id 升序(前端将逐行打「暂无节目数据」标)', () => {
    const { householdId, epgSourceId } = bootstrap();
    seedChannel(householdId, epgSourceId, 'bb', 'X');
    seedChannel(householdId, epgSourceId, 'aa', 'Y');
    const page = listEpgCandidates(householdId, { epgSourceId, page: 1, pageSize: 20 });
    expect(page.items.map((i) => i.xmltvChannelId)).toEqual(['aa', 'bb']);
  });

  it('过期节目(ends_at 已过)不算有节目:排序归入无节目组且 current/next 为空', () => {
    const { householdId, epgSourceId } = bootstrap();
    seedChannel(householdId, epgSourceId, 'live-id', '有窗口节目但已过期');
    seedChannel(householdId, epgSourceId, 'empty-id', '无节目');
    seedProgramme(householdId, epgSourceId, 'live-id', -600, -300, '已播完');
    const page = listEpgCandidates(householdId, { epgSourceId, page: 1, pageSize: 20 });
    expect(page.items.map((i) => i.xmltvChannelId)).toEqual(['empty-id', 'live-id']);
    expect(page.items[0]?.current).toBeNull();
    expect(page.items[0]?.next).toBeNull();
  });
});
