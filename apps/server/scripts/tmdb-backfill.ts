/**
 * 020 TMDB 节目海报回填 CLI。
 *
 * 用法：
 *   pnpm --filter @hmp/server tmdb:backfill -- --limit=500 --dry-run
 *   pnpm --filter @hmp/server tmdb:backfill -- --limit=500
 *   pnpm --filter @hmp/server tmdb:backfill -- --household=<id>
 *
 * 行为：
 * 1) 先补齐旧 epg_programme 行的 poster_match_key（归一化无法在 SQLite 中复现）；
 * 2) 取当前窗口内贴图缺失的 distinct 标题，调用与刷新链路同一个 enrichAfterEpgPublish；
 * 3) 串行/间隔/单次上限/熔断/TTL 全部复用服务配置；
 * 4) --dry-run 只统计，不联网；不打印标题/Key。
 *
 * 建议避开 EPG 刷新时段运行（服务内串行；CLI 与服务并行时最多 2 条 in-flight）。
 */

import { Database } from '../src/platform/database/database';
import { getConfig } from '../src/platform/config/env';
import { bindEpgStore } from '../src/contexts/epg/application/epg-store.port';
import { drizzleEpgStore } from '../src/contexts/epg/infrastructure/epg-store.drizzle';
import { createTmdbClient } from '../src/contexts/epg/infrastructure/tmdb.client';
import { createProgrammePosterService } from '../src/contexts/epg/application/programme-poster.service';

interface Args {
  readonly limit: number;
  readonly dryRun: boolean;
  readonly householdId: string | null;
  readonly rekey: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let limit = 500;
  let dryRun = false;
  let householdId: string | null = null;
  let rekey = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--rekey') {
      rekey = true;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000) {
        limit = parsed;
      }
      continue;
    }
    if (arg.startsWith('--household=')) {
      const value = arg.slice('--household='.length).trim();
      if (value !== '') {
        householdId = value;
      }
    }
  }
  return { limit, dryRun, householdId, rekey };
}

function countPending(householdId: string): { missingKey: number; missingRef: number } {
  const db = Database.db;
  const missingKey = (
    db.prepare('SELECT COUNT(*) AS n FROM epg_programme WHERE household_id = ? AND poster_match_key IS NULL').get(householdId) as { n: number }
  ).n;
  const missingRef = (
    db.prepare('SELECT COUNT(*) AS n FROM epg_programme WHERE household_id = ? AND poster_ref IS NULL').get(householdId) as { n: number }
  ).n;
  return { missingKey, missingRef };
}

function listTitles(householdId: string, limit: number): string[] {
  // 跳过仍有效的 no_match/failed 负缓存，保证分批回填会向前推进（否则每轮都会
  // 重复选中同一批「无 ref 且 no_match」标题，永远到不了后面的标题）。
  // 只处理已具备归一化键的行；通用槽位（key=NULL）没有匹配意义。
  const nowIso = new Date().toISOString();
  return (
    Database.db
      .prepare(
        `SELECT DISTINCT ep.title
         FROM epg_programme ep
         WHERE ep.household_id = ?
           AND ep.poster_ref IS NULL
           AND ep.poster_match_key IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM programme_poster pp
             WHERE pp.household_id = ep.household_id
               AND pp.match_key = ep.poster_match_key
               AND pp.state IN ('no_match', 'failed')
               AND pp.expires_at > ?
           )
         ORDER BY ep.title
         LIMIT ?`,
      )
      .all(householdId, nowIso, limit) as { title: string }[]
  ).map((row) => row.title);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  bindEpgStore(drizzleEpgStore());
  const config = getConfig();
  const enabled = config.TMDB_API_KEY !== '' || config.TMDB_READ_ACCESS_TOKEN !== '';
  console.log(
    `[tmdb:backfill] enabled=${enabled} limit=${args.limit} dryRun=${args.dryRun} rekey=${args.rekey} language=${config.TMDB_LANGUAGE} region=${config.TMDB_REGION}`,
  );

  const households = (
    args.householdId === null
      ? (Database.db.prepare('SELECT id FROM household ORDER BY id').all() as { id: string }[])
      : [{ id: args.householdId }]
  ).filter((row) => row.id !== '');

  if (households.length === 0) {
    console.log('[tmdb:backfill] no household; nothing to do');
    return;
  }

  if (args.dryRun) {
    for (const household of households) {
      const pending = countPending(household.id);
      console.log(
        `[tmdb:backfill] dry-run household=${household.id} missingKey=${pending.missingKey} missingRef=${pending.missingRef}`,
      );
    }
    return;
  }

  if (!enabled) {
    console.log('[tmdb:backfill] TMDB_API_KEY / TMDB_READ_ACCESS_TOKEN empty; only local cache would be restored');
  }

  const service = createProgrammePosterService({ client: createTmdbClient() });
  for (const household of households) {
    const before = countPending(household.id);
    // --rekey 只做本地 match_key 重算（便宜、无网络）；标题补全仍受 --limit 限制
    const rekeyed = args.rekey
      ? service.rekeyProgrammeMatchKeys({ householdId: household.id, limit: 1_000_000 })
      : 0;
    const keys = args.rekey ? 0 : service.backfillMatchKeys({ householdId: household.id, limit: args.limit });
    const titles = listTitles(household.id, args.limit);
    const summary =
      titles.length === 0
        ? null
        : await service.enrichAfterEpgPublish({
            householdId: household.id,
            titles,
            nowMs: Date.now(),
          });
    const after = countPending(household.id);
    console.log(
      `[tmdb:backfill] household=${household.id} rekeyed=${rekeyed} keys=${keys} titles=${titles.length} lookups=${summary?.lookups ?? 0} matched=${summary?.matched ?? 0} noMatch=${summary?.noMatch ?? 0} failed=${summary?.failed ?? 0} skipped=${summary?.skipped ?? 0} missingRef ${before.missingRef}->${after.missingRef}`,
    );
  }
}

void main()
  .catch((error: unknown) => {
    console.error('[tmdb:backfill] failed:', error instanceof Error ? error.message : 'unknown');
    process.exitCode = 1;
  })
  .finally(() => {
    Database.close();
  });