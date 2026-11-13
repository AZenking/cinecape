/**
 * 020 TMDB 节目海报补全服务（EPG 应用层）。
 *
 * 关键约束：
 * - 读取路径零 TMDB 调用；本服务只在 EPG 刷新发布后/CLI 中运行。
 * - 先恢复本地有效缓存（零网络），再只对缺失/过期标题联网。
 * - 串行 1 in-flight；最小间隔、单次上限、总预算、401/429/5xx 熔断全部生效。
 * - 网络循环在事务外；缓存 upsert + 节目 ref 回写 + GC 在同一个短事务内。
 * - 任何失败不抛给刷新执行器；返回计数并记录一行脱敏汇总。
 */

import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { getConfig } from '@platform/config/env';
import {
  normalizeProgrammeTitle,
  type NormalizedProgrammeTitle,
} from '@contexts/epg/domain/programme-title';
import { matchProgrammePoster } from '@contexts/epg/domain/programme-poster-match';
import { epgStore, type EpgStore, type ProgrammePosterRow } from './epg-store.port';
import { TmdbError, type TmdbClient } from '@contexts/epg/infrastructure/tmdb.client';

export interface ProgrammePosterRef {
  readonly matchKey: string;
  readonly ref: string;
}

export interface ProgrammePosterEnrichmentSummary {
  readonly titles: number;
  readonly cacheHits: number;
  readonly lookups: number;
  readonly matched: number;
  readonly noMatch: number;
  readonly failed: number;
  readonly skipped: number;
  readonly durationMs: number;
}

export interface ProgrammePosterService {
  resolveCachedRefs(input: {
    readonly householdId: string;
    readonly titles: readonly string[];
    readonly nowMs: number;
  }): ReadonlyMap<string, ProgrammePosterRef>;
  enrichAfterEpgPublish(input: {
    readonly householdId: string;
    readonly titles: readonly string[];
    readonly nowMs: number;
  }): Promise<ProgrammePosterEnrichmentSummary>;
  backfillMatchKeys(input: { readonly householdId: string; readonly limit: number }): number;
  /** 规则升级后全量重算 match_key（--rekey；变更行清空旧 poster_ref，随后由补全重写） */
  rekeyProgrammeMatchKeys(input: { readonly householdId: string; readonly limit: number }): number;
}

export interface ProgrammePosterServiceDeps {
  readonly client: TmdbClient;
  /** 测试注入；缺省用模块 seam epgStore() */
  readonly store?: Pick<
    EpgStore,
    | 'listProgrammePosterRows'
    | 'withTransaction'
    | 'listProgrammeMatchKeyCandidateRows'
    | 'listProgrammeRowsForRekey'
  >;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const CACHE_GC_GRACE_MS = 30 * DAY_MS;
const BACKFILL_PAGE_SIZE = 500;
const logger = new Logger('TmdbPoster');

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function newRef(): string {
  return randomBytes(16).toString('hex');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function collectNormalized(titles: readonly string[]): {
  readonly byKey: ReadonlyMap<string, NormalizedProgrammeTitle>;
  readonly keyByTitle: ReadonlyMap<string, string>;
} {
  const byKey = new Map<string, NormalizedProgrammeTitle>();
  const keyByTitle = new Map<string, string>();
  for (const raw of titles) {
    const normalized = normalizeProgrammeTitle(raw);
    if (normalized.matchKey === null) {
      continue;
    }
    byKey.set(normalized.matchKey, normalized);
    keyByTitle.set(raw, normalized.matchKey);
  }
  return { byKey, keyByTitle };
}

function rowUsable(row: ProgrammePosterRow | undefined, nowMs: number): row is ProgrammePosterRow {
  return row !== undefined && Date.parse(row.expiresAt) > nowMs;
}

function matchedRowOf(
  householdId: string,
  matchKey: string,
  previous: ProgrammePosterRow | undefined,
  match: NonNullable<ReturnType<typeof matchProgrammePoster>>,
  nowMs: number,
  yearHint: number | null,
  attempts: number,
): ProgrammePosterRow {
  const nowIso = iso(nowMs);
  // 同 tmdb_id + poster_path 保留旧 ref，保住浏览器缓存；poster 变化才轮换。
  const ref =
    previous !== undefined &&
    previous.state === 'matched' &&
    previous.ref !== null &&
    previous.tmdbId === match.tmdbId &&
    previous.posterPath === match.posterPath
      ? previous.ref
      : newRef();
  return {
    householdId,
    matchKey,
    ref,
    state: 'matched',
    tmdbId: match.tmdbId,
    mediaType: match.mediaType,
    title: match.title,
    originalTitle: match.originalTitle,
    posterPath: match.posterPath,
    releaseDate: match.releaseDate,
    voteAverage: match.voteAverage,
    popularity: match.popularity,
    matchScore: match.matchScore,
    yearHint,
    attempts,
    lastAttemptAt: nowIso,
    expiresAt: iso(nowMs + getConfig().TMDB_MATCHED_TTL_DAYS * DAY_MS),
    createdAt: previous?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

function negativeRowOf(
  householdId: string,
  matchKey: string,
  previous: ProgrammePosterRow | undefined,
  state: 'no_match' | 'failed',
  nowMs: number,
  attempts: number,
): ProgrammePosterRow {
  const nowIso = iso(nowMs);
  const ttlMs =
    state === 'no_match'
      ? getConfig().TMDB_NEGATIVE_TTL_DAYS * DAY_MS
      : getConfig().TMDB_FAILURE_TTL_MINUTES * MINUTE_MS;
  return {
    householdId,
    matchKey,
    ref: null,
    state,
    tmdbId: null,
    mediaType: null,
    title: null,
    originalTitle: null,
    posterPath: null,
    releaseDate: null,
    voteAverage: null,
    popularity: null,
    matchScore: null,
    yearHint: null,
    attempts,
    lastAttemptAt: nowIso,
    expiresAt: iso(nowMs + ttlMs),
    createdAt: previous?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
}

export function createProgrammePosterService(deps: ProgrammePosterServiceDeps): ProgrammePosterService {
  const now = deps.nowMs ?? (() => Date.now());
  const sleep = deps.sleep ?? sleepDefault;
  const store = (): Pick<
    EpgStore,
    | 'listProgrammePosterRows'
    | 'withTransaction'
    | 'listProgrammeMatchKeyCandidateRows'
    | 'listProgrammeRowsForRekey'
  > => deps.store ?? epgStore();

  function resolveCachedRefs(input: {
    readonly householdId: string;
    readonly titles: readonly string[];
    readonly nowMs: number;
  }): ReadonlyMap<string, ProgrammePosterRef> {
    const { byKey, keyByTitle } = collectNormalized(input.titles);
    if (byKey.size === 0) {
      return new Map();
    }
    const rows = store().listProgrammePosterRows(input.householdId, [...byKey.keys()]);
    const validByKey = new Map<string, ProgrammePosterRow>();
    for (const row of rows) {
      if (rowUsable(row, input.nowMs) && row.state === 'matched' && row.ref !== null) {
        validByKey.set(row.matchKey, row);
      }
    }
    const result = new Map<string, ProgrammePosterRef>();
    for (const [rawTitle, matchKey] of keyByTitle) {
      const row = validByKey.get(matchKey);
      if (row !== undefined && row.ref !== null) {
        result.set(rawTitle, { matchKey, ref: row.ref });
      }
    }
    return result;
  }

  async function enrichAfterEpgPublish(input: {
    readonly householdId: string;
    readonly titles: readonly string[];
    readonly nowMs: number;
  }): Promise<ProgrammePosterEnrichmentSummary> {
    const started = now();
    const config = getConfig();
    const { byKey } = collectNormalized(input.titles);
    const keys = [...byKey.keys()].sort();
    const existingRows = store().listProgrammePosterRows(input.householdId, keys);
    const existingByKey = new Map(existingRows.map((row) => [row.matchKey, row] as const));

    const updates: Array<{ matchKey: string; ref: string | null }> = [];
    const lookupKeys: string[] = [];
    let cacheHits = 0;
    for (const key of keys) {
      const row = existingByKey.get(key);
      if (rowUsable(row, input.nowMs)) {
        cacheHits += 1;
        updates.push({
          matchKey: key,
          ref: row.state === 'matched' && row.ref !== null ? row.ref : null,
        });
        continue;
      }
      lookupKeys.push(key);
    }

    const writes: ProgrammePosterRow[] = [];
    let lookups = 0;
    let matched = 0;
    let noMatch = 0;
    let failed = 0;
    let skipped = 0;

    if (lookupKeys.length > 0 && !deps.client.isEnabled()) {
      skipped += lookupKeys.length;
    } else {
      for (let index = 0; index < lookupKeys.length; index += 1) {
        const key = lookupKeys[index]!;
        if (lookups >= config.TMDB_MAX_LOOKUPS_PER_RUN) {
          skipped += lookupKeys.length - index;
          break;
        }
        if (now() - started >= config.TMDB_RUN_BUDGET_MS) {
          skipped += lookupKeys.length - index;
          break;
        }
        if (lookups > 0 && config.TMDB_LOOKUP_INTERVAL_MS > 0) {
          await sleep(config.TMDB_LOOKUP_INTERVAL_MS);
        }
        const normalized = byKey.get(key);
        if (normalized === undefined || normalized.searchQuery === null) {
          continue;
        }
        const previous = existingByKey.get(key);
        const attempts = (previous?.attempts ?? 0) + 1;
        lookups += 1;
        try {
          const candidates = await deps.client.searchMulti({
            query: normalized.searchQuery,
            language: config.TMDB_LANGUAGE,
            region: config.TMDB_REGION,
          });
          const match = matchProgrammePoster(normalized, candidates);
          const attemptNow = now();
          if (match === null) {
            writes.push(negativeRowOf(input.householdId, key, previous, 'no_match', attemptNow, attempts));
            updates.push({ matchKey: key, ref: null });
            noMatch += 1;
          } else {
            const row = matchedRowOf(
              input.householdId,
              key,
              previous,
              match,
              attemptNow,
              normalized.yearHint,
              attempts,
            );
            writes.push(row);
            updates.push({ matchKey: key, ref: row.ref });
            matched += 1;
          }
        } catch (error) {
          const attemptNow = now();
          writes.push(negativeRowOf(input.householdId, key, previous, 'failed', attemptNow, attempts));
          updates.push({ matchKey: key, ref: null });
          failed += 1;
          if (
            error instanceof TmdbError &&
            (error.kind === 'disabled' || error.kind === 'auth' || error.kind === 'circuit_open')
          ) {
            skipped += lookupKeys.length - index - 1;
            break;
          }
        }
      }
    }

    store().withTransaction((tx) => {
      for (const row of writes) {
        tx.upsertProgrammePoster(row);
      }
      if (updates.length > 0) {
        tx.updateProgrammePosterRefs(input.householdId, updates);
      }
      tx.deleteExpiredProgrammePosterRows(
        input.householdId,
        iso(input.nowMs - CACHE_GC_GRACE_MS),
      );
    });

    const durationMs = now() - started;
    const summary: ProgrammePosterEnrichmentSummary = {
      titles: byKey.size,
      cacheHits,
      lookups,
      matched,
      noMatch,
      failed,
      skipped,
      durationMs,
    };
    logger.log(
      `household=${input.householdId} titles=${summary.titles} cacheHits=${summary.cacheHits} lookups=${summary.lookups} matched=${summary.matched} noMatch=${summary.noMatch} failed=${summary.failed} skipped=${summary.skipped} durationMs=${summary.durationMs}`,
    );
    return summary;
  }

  function backfillMatchKeys(input: { readonly householdId: string; readonly limit: number }): number {
    let updated = 0;
    let cursor: string | null = null;
    while (updated < input.limit) {
      const pageSize = Math.min(BACKFILL_PAGE_SIZE, input.limit - updated);
      const rows = store().listProgrammeMatchKeyCandidateRows(input.householdId, cursor, pageSize);
      if (rows.length === 0) {
        break;
      }
      const entries: Array<{ id: string; matchKey: string }> = [];
      for (const row of rows) {
        const key = normalizeProgrammeTitle(row.title).matchKey;
        if (key !== null) {
          entries.push({ id: row.id, matchKey: key });
        }
      }
      if (entries.length > 0) {
        store().withTransaction((tx) => {
          tx.updateProgrammeMatchKeys(input.householdId, entries);
        });
        updated += entries.length;
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < pageSize) {
        break;
      }
    }
    return updated;
  }

  function rekeyProgrammeMatchKeys(input: { readonly householdId: string; readonly limit: number }): number {
    let updated = 0;
    let cursor: string | null = null;
    while (updated < input.limit) {
      const pageSize = Math.min(BACKFILL_PAGE_SIZE, Math.max(1, input.limit - updated));
      const rows = store().listProgrammeRowsForRekey(input.householdId, cursor, pageSize);
      if (rows.length === 0) {
        break;
      }
      const entries: Array<{ id: string; matchKey: string | null }> = [];
      for (const row of rows) {
        const matchKey = normalizeProgrammeTitle(row.title).matchKey;
        if (matchKey !== row.posterMatchKey) {
          entries.push({ id: row.id, matchKey });
        }
      }
      if (entries.length > 0) {
        store().withTransaction((tx) => {
          tx.updateProgrammeMatchKeys(input.householdId, entries);
        });
        updated += entries.length;
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < pageSize) {
        break;
      }
    }
    return updated;
  }

  return { resolveCachedRefs, enrichAfterEpgPublish, backfillMatchKeys, rekeyProgrammeMatchKeys };
}