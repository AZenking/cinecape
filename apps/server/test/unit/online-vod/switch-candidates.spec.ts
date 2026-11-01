/**
 * 010 T070 — 换源候选服务级单测(真实 DDL + 受控上游 stub,T028 手法)。
 *
 * 被测:contexts/online-vod/application/switch-candidates.service.ts
 * (+domain/source-match.rules.ts 评分面经真实消费路径覆盖)。
 *
 * 装配方式(与 T029 服务级 rig 同构,不经 HTTP/Nest):
 * - 独立临时文件库 + 全量权威迁移 DDL(0001～0007,foreign_keys=ON 真实约束);
 * - 来源授权走真实 T059 TransitionSourceContextService + 真实
 *   drizzleTransitionStore(playback_session 真实行;同上下文 404 同形/终态可读);
 * - 来源可信标题事实钩子按 T071 生产接线形态对真实 store 投影(vod store 物化事实
 *   + continuitySignature JSON + 目录标题回退),非测试私设捷径;
 * - 上游搜索/详情为内存受控 stub(注入 VodSearchUpstreamFn/VodDetailUpstreamFn,
 *   零真实网络;请求被捕获用于断言「搜索词来自可信标题」「不接任意 q」);
 * - 有界缓存为真实 createVodCache(注入 FakeClock;TTL/游标/候选绑定全真路径);
 * - 时钟注入 fixture-world FakeClock(failed 60s 恢复窗/候选 TTL 恰界可推进验证)。
 *
 * 覆盖清单(T070 交付 3):候选评分(ambiguous/conflict + reasons 全量)、签发
 * (opaque ref/注册表可逆/私有绑定溯源)、TTL(60s/恰界/列过期 410)、分页
 * (20/页、续页、重放不变、伪造游标 410)、partial/reasons(源失败汇总、单源详情
 * 全败降级、全源失败 502/全部超时 504/无启用源 502)、未授权 404 同形(跨设备/
 * 跨 Profile/旧 context/不存在同码同形)、代次 409、终态门 409、failed 恢复窗 410、
 * 非 VOD 404、预览修订(已物化对齐指针/新标题计数)、零历史零会话写入、来源自身
 * (sourceId, upstreamVodId) 整题排除(010 T070 修复,FR-029「当前线路和跨来源」)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { createVodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import { VOD_BUDGETS, type VodBudgetShape } from '@contexts/online-vod/domain/vod-budgets';
import type { ParsedVodSearchItem, ParsedVodTitleDetail } from '@contexts/online-vod/domain/provider-model';
import type { ContinuitySignature } from '@contexts/online-vod/domain/continuity.rules';
import { drizzleOnlineVodStore } from '@contexts/online-vod/infrastructure/online-vod-store.drizzle';
import {
  createSwitchCandidatesService,
  type SwitchCandidatesPage,
  type SwitchSourceTitleFactsLoader,
} from '@contexts/online-vod/application/switch-candidates.service';
import type { VodCandidateBindingPayload } from '@contexts/online-vod/application/switch-candidates.service';
import {
  VodUpstreamTimeoutError,
  VOD_UPSTREAM_PROBLEM_CODES,
  type VodSearchUpstreamFn,
} from '@contexts/online-vod/application/search.service';
import type { VodDetailUpstreamFn } from '@contexts/online-vod/application/preview.service';
import type {
  VodSourceConfigurationPort,
  VodSourceEndpointSnapshot,
} from '@contexts/online-vod/application/publication-work-set.port';
import { TransitionSourceContextService } from '@contexts/playback/application/transition-source-context.service';
import { drizzleTransitionStore } from '@contexts/playback/infrastructure/playback-transition-store.drizzle';
import { createFixtureFakeClock, type FixtureFakeClock } from '../../fixtures/online-vod/fixture-world';

/* ------------------------------------------------------------------ */
/* rig:真实 DDL + 真实 T059 授权 + 受控上游 stub + FakeClock              */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

const CLOCK_START_MS = Date.parse('2026-10-30T08:00:00.000Z');
const HH = 'hh-t070';
const ACCOUNT = 'acc-t070';
const PROFILE = 'prof-t070';
const DEVICE = 'dev-t070';
const DEVICE_SESSION = 'ds-t070';
const SRC_A = 'src-a-t070';
const SRC_B = 'src-b-t070';
const SESSION_ENDED = 'ps-ended-t070';
/** 夹具语言/标题事实(与 T005 夹具素材同名,便于对照 source-match.spec 判定表) */
const SERIAL_NAME = 'fixture·星尘信使';
const SERIAL_SIGNATURE: ContinuitySignature = {
  canonicalName: SERIAL_NAME,
  year: '2024',
  seasonKey: 'S01',
  languageVersion: '夹具语言',
  knownVersionLabel: null,
  matchRuleVersion: 'online-vod-source-match-v1',
};
const ECHO_NAME = 'fixture·回声双城';
const ECHO_THEATRICAL_SIGNATURE: ContinuitySignature = {
  canonicalName: ECHO_NAME,
  year: '2019',
  seasonKey: null,
  languageVersion: '夹具语言',
  knownVersionLabel: '剧场版',
  matchRuleVersion: 'online-vod-source-match-v1',
};

/** 服务级预算:契约值收窄总期限(上游 stub 全部即时结算;仅超时用例依赖真实计时) */
const SPEC_BUDGETS: VodBudgetShape = {
  ...VOD_BUDGETS,
  search: { ...VOD_BUDGETS.search, totalTimeoutMs: 250 },
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 全量权威迁移(与 T029 rig 同源;FK ON) */
function applyAuthoritativeMigrations(conn: SqliteConnection): void {
  const migrationsDir = path.join(process.cwd(), 'src/platform/database/migrations');
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const upSqlPath = path.join(migrationsDir, name, 'up.sql');
    expect(fs.existsSync(upSqlPath), `未找到迁移 DDL ${upSqlPath}(须以 apps/server 为工作目录运行)`).toBe(true);
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
  }
}

/* ---------- seed(真实 DDL 列面) ---------- */

function seedIdentityFacts(conn: SqliteConnection): void {
  const now = iso(CLOCK_START_MS);
  conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(HH, 'T070 夹具家庭', now);
  conn
    .prepare(
      'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(ACCOUNT, HH, 'admin', 'admin', 'hash', 'admin', now);
  conn
    .prepare(
      "INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, created_at) VALUES (?, ?, ?, '主档案', 'adult', 1, 'active', ?)",
    )
    .run(PROFILE, HH, ACCOUNT, now);
  conn.prepare("INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, 'web', ?)").run(DEVICE, HH, now);
  conn
    .prepare(
      'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(DEVICE_SESSION, HH, ACCOUNT, DEVICE, 'token-hash', PROFILE, iso(CLOCK_START_MS + 7 * 24 * 3600_000), now, now);
  conn
    .prepare(
      'INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated, allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    )
    .run(HH, PROFILE, 18, 1, '[]', '[]', '[]', now);
  conn.prepare('INSERT INTO catalog_state (household_id) VALUES (?)').run(HH);
}

function seedVodSource(conn: SqliteConnection, sourceId: string, name: string, enabled: 0 | 1 = 1): void {
  const now = iso(CLOCK_START_MS);
  conn
    .prepare(
      "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', ?, 'http://127.0.0.1:9/api.php/provide/vod/', ?, 1, ?, ?, ?)",
    )
    .run(sourceId, HH, name, enabled, enabled === 1 ? 1 : 2, now, now);
  conn
    .prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')")
    .run(HH, sourceId);
}

/** 来源播放会话(playback_session 真实行;终态必填 ended_at/failed 必填 failure_code) */
function seedPlaybackSession(
  conn: SqliteConnection,
  opts: {
    sessionId: string;
    mediaId: string;
    state?: string;
    generation?: number;
    endedAtMs?: number | null;
    deviceSessionId?: string;
    profileId?: string;
    profileContextVersion?: number;
  },
): void {
  const now = iso(CLOCK_START_MS);
  const state = opts.state ?? 'ended';
  const isTerminal = state === 'ended' || state === 'failed' || state === 'interrupted';
  const active = state === 'ready' || state === 'playing' || state === 'paused';
  conn
    .prepare(
      "INSERT INTO playback_session (id, household_id, device_session_id, device_id, profile_id, profile_context_version, media_id, playback_source_id, state, delivery, generation, version, position_seconds, ended_at, failure_code, last_heartbeat_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)",
    )
    .run(
      opts.sessionId,
      HH,
      opts.deviceSessionId ?? DEVICE_SESSION,
      DEVICE,
      opts.profileId ?? PROFILE,
      opts.profileContextVersion ?? 1,
      opts.mediaId,
      active ? 'psrc-fixture-t070' : null,
      state,
      active ? 'hls_proxy' : null,
      opts.generation ?? 1,
      // 终态必填 ended_at(DDL CHECK);活动态必空
      isTerminal ? iso(opts.endedAtMs ?? CLOCK_START_MS) : null,
      state === 'failed' ? 'media_upstream' : null,
      now,
      now,
    );
}

/** 已物化 VOD 事实(父/子媒体 + 关系 + vod_title/vod_line/vod_episode;签名可选) */
function seedVodFacts(
  conn: SqliteConnection,
  opts: {
    sourceId: string;
    upstreamVodId: string;
    titleName: string;
    lineKey: string;
    episodeKey: string;
    episodeLabel: string;
    parentMediaId: string;
    episodeMediaId: string;
    currentDetailRevision?: number;
    signature?: ContinuitySignature | null;
  },
): void {
  const now = iso(CLOCK_START_MS);
  conn
    .prepare(
      "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', ?, 1, 'vod_title', ?, ?)",
    )
    .run(opts.parentMediaId, HH, opts.titleName, now, now);
  conn
    .prepare(
      "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', ?, 1, 'vod_episode', ?, ?)",
    )
    .run(opts.episodeMediaId, HH, opts.episodeLabel, now, now);
  conn
    .prepare("INSERT INTO media_relation (household_id, parent_id, child_id, kind, sort_order) VALUES (?, ?, ?, 'vod_episode', 1)")
    .run(HH, opts.parentMediaId, opts.episodeMediaId);
  conn
    .prepare(
      'INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(`vt-${opts.episodeMediaId}`, HH, opts.sourceId, opts.upstreamVodId, opts.parentMediaId, opts.currentDetailRevision ?? 1, now);
  conn
    .prepare(
      'INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, 1)',
    )
    .run(`vl-${opts.episodeMediaId}`, HH, `vt-${opts.episodeMediaId}`, opts.lineKey, 'fixture正片');
  conn
    .prepare(
      "INSERT INTO vod_episode (id, household_id, line_id, episode_key, label, media_id, content_version_state, continuity_signature) VALUES (?, ?, ?, ?, ?, ?, 'unverified', ?)",
    )
    .run(
      `ve-${opts.episodeMediaId}`,
      HH,
      `vl-${opts.episodeMediaId}`,
      opts.episodeKey,
      opts.episodeLabel,
      opts.episodeMediaId,
      opts.signature === undefined || opts.signature === null ? null : JSON.stringify(opts.signature),
    );
}

/* ---------- 来源可信标题事实钩子(T071 生产接线形态;真实 store 投影) ---------- */

function parseContinuitySignature(raw: string | null): ContinuitySignature | null {
  if (raw === null || raw === '') return null;
  try {
    const value = JSON.parse(raw) as Partial<ContinuitySignature>;
    if (typeof value.canonicalName !== 'string' || typeof value.matchRuleVersion !== 'string') return null;
    return {
      canonicalName: value.canonicalName,
      year: value.year ?? null,
      seasonKey: value.seasonKey ?? null,
      languageVersion: value.languageVersion ?? null,
      knownVersionLabel: value.knownVersionLabel ?? null,
      matchRuleVersion: value.matchRuleVersion,
    };
  } catch {
    return null;
  }
}

function createRealSourceTitleFactsLoader(conn: SqliteConnection, store: ReturnType<typeof drizzleOnlineVodStore>): SwitchSourceTitleFactsLoader {
  return (householdId, mediaId) => {
    const episode = store.findEpisodeByMedia(householdId, mediaId);
    if (episode === undefined) return undefined;
    const line = store.findLine(householdId, episode.lineId);
    const title = line === undefined ? undefined : store.findTitle(householdId, line.titleId);
    const parentTitle =
      title === undefined
        ? undefined
        : (conn
            .prepare('SELECT title FROM media_item WHERE household_id = ? AND id = ?')
            .get(householdId, title.parentMediaId) as { title: string } | undefined)?.title;
    const signature = parseContinuitySignature(episode.continuitySignature);
    const canonicalName = (signature?.canonicalName ?? parentTitle ?? '').normalize('NFC').trim();
    if (canonicalName.length === 0) return undefined;
    return {
      canonicalName,
      year: signature?.year ?? null,
      seasonKey: signature?.seasonKey ?? null,
      episodeKey: episode.episodeKey,
      languageVersion: signature?.languageVersion ?? null,
      knownVersionLabel: signature?.knownVersionLabel ?? null,
    };
  };
}

/* ---------- 受控上游 stub(零真实网络;请求捕获断言) ---------- */

interface UpstreamStub {
  readonly searchCalls: { readonly sourceId: string; readonly query: string }[];
  readonly detailCalls: { readonly sourceId: string; readonly upstreamVodId: string }[];
  setSearch(sourceId: string, query: string, items: readonly ParsedVodSearchItem[] | 'reject' | 'timeout'): void;
  setDetail(sourceId: string, upstreamVodId: string, detail: ParsedVodTitleDetail | 'reject'): void;
  readonly searchUpstream: VodSearchUpstreamFn;
  readonly fetchDetailUpstream: VodDetailUpstreamFn;
}

function stubItem(input: {
  upstreamVodId: string;
  name: string;
  year?: string | null;
  version?: string | null;
}): ParsedVodSearchItem {
  return {
    identity: {
      upstreamVodId: input.upstreamVodId,
      name: input.name,
      year: input.year ?? null,
      version: input.version ?? null,
    },
    title: input.name,
    year: input.year ?? null,
    remarks: null,
  };
}

type StubEpisode = { readonly key: string; readonly label: string; readonly unsupported?: boolean };

function stubDetail(input: {
  upstreamVodId: string;
  name: string;
  year?: string | null;
  version?: string | null;
  lines: readonly { readonly lineKey: string; readonly lineLabel: string; readonly episodes: readonly StubEpisode[] }[];
}): ParsedVodTitleDetail {
  return {
    identity: {
      upstreamVodId: input.upstreamVodId,
      name: input.name,
      year: input.year ?? null,
      version: input.version ?? null,
    },
    title: input.name,
    year: input.year ?? null,
    synopsis: null,
    evidence: 'unverified',
    lines: input.lines.map((line, index) => ({
      lineKey: line.lineKey,
      displayName: line.lineLabel,
      sortOrder: index + 1,
      status: 'candidate',
      episodes: line.episodes.map((episode) => ({
        episodeKey: episode.unsupported === true ? null : episode.key,
        label: episode.label,
        status: episode.unsupported === true ? 'unsupported' : 'candidate',
        reason: episode.unsupported === true ? 'identity_ambiguous' : null,
        locatorUrl: `http://127.0.0.1:9/hls/${input.upstreamVodId}/${episode.key}/index.m3u8`,
      })),
    })),
  };
}

function createUpstreamStub(): UpstreamStub {
  const searchRoutes = new Map<string, readonly ParsedVodSearchItem[] | 'reject' | 'timeout'>();
  const detailRoutes = new Map<string, ParsedVodTitleDetail | 'reject'>();
  const searchCalls: { sourceId: string; query: string }[] = [];
  const detailCalls: { sourceId: string; upstreamVodId: string }[] = [];

  const stub: UpstreamStub = {
    searchCalls,
    detailCalls,
    setSearch(sourceId, query, items) {
      searchRoutes.set(`${sourceId}|${query}`, items);
    },
    setDetail(sourceId, upstreamVodId, detail) {
      detailRoutes.set(`${sourceId}|${upstreamVodId}`, detail);
    },
    searchUpstream: (request) => {
      searchCalls.push({ sourceId: request.sourceId, query: request.query });
      const route = searchRoutes.get(`${request.sourceId}|${request.query}`);
      if (route === 'timeout') {
        return new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new VodUpstreamTimeoutError()), { once: true });
        });
      }
      if (route === 'reject' || route === undefined) {
        return Promise.reject(new Error('上游连接失败(受控 stub)'));
      }
      return Promise.resolve({ items: route, hasMore: false });
    },
    fetchDetailUpstream: (request) => {
      detailCalls.push({ sourceId: request.sourceId, upstreamVodId: request.upstreamVodId });
      const route = detailRoutes.get(`${request.sourceId}|${request.upstreamVodId}`);
      if (route === 'reject' || route === undefined) {
        return Promise.reject(new Error('上游详情失败(受控 stub)'));
      }
      return Promise.resolve(route);
    },
  };
  return stub;
}

/* ---------- 来源配置端口(读真实 DDL 表) ---------- */

function createDbSourceConfig(conn: SqliteConnection): VodSourceConfigurationPort {
  return {
    listEnabledVodSources(householdId): VodSourceEndpointSnapshot[] {
      const rows = conn
        .prepare(
          "SELECT id AS sourceId, name, locator_revision AS locatorRevision FROM media_source WHERE household_id = ? AND kind = 'vod' AND enabled = 1 ORDER BY rowid",
        )
        .all(householdId) as { sourceId: string; name: string; locatorRevision: number }[];
      return rows.map((row) => ({
        sourceId: row.sourceId,
        name: row.name,
        adapter: 'apple-cms-json' as const,
        locatorRevision: row.locatorRevision,
      }));
    },
    readLocatorRevision(householdId, sourceId) {
      const row = conn
        .prepare('SELECT locator_revision AS locatorRevision FROM media_source WHERE household_id = ? AND id = ?')
        .get(householdId, sourceId) as { locatorRevision: number } | undefined;
      return row?.locatorRevision;
    },
    findSourceConfig(householdId, sourceId) {
      return conn
        .prepare('SELECT household_id AS householdId, source_id AS sourceId, adapter FROM vod_source_config WHERE household_id = ? AND source_id = ?')
        .get(householdId, sourceId) as { householdId: string; sourceId: string; adapter: 'apple-cms-json' } | undefined;
    },
  };
}

/* ---------- rig 装配 ---------- */

interface Rig {
  conn: SqliteConnection;
  clock: FixtureFakeClock;
  stub: UpstreamStub;
  cache: ReturnType<typeof createVodCache>;
  service: { listCandidates(command: Parameters<ReturnType<typeof createSwitchCandidatesService>['listCandidates']>[0]): Promise<SwitchCandidatesPage> };
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];

function createRig(
  options: {
    session?: {
      sessionId?: string;
      state?: string;
      generation?: number;
      endedAtMs?: number | null;
      mediaId?: string;
      deviceSessionId?: string;
      profileId?: string;
      profileContextVersion?: number;
    };
    world?: 'serial' | 'echo' | 'static' | 'none';
    seedSources?: boolean;
    originDetailRevision?: number;
  } = {},
): Rig {
  const world = options.world ?? 'serial';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t070-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  seedIdentityFacts(conn);
  if (options.seedSources ?? true) {
    seedVodSource(conn, SRC_A, '夹具源A');
    seedVodSource(conn, SRC_B, '夹具源B');
  } else {
    // 无启用来源场景:来源行仍需存在(vod_title 来源 FK),但停用
    seedVodSource(conn, SRC_A, '夹具源A(停用)', 0);
  }

  const serialMedia = 'media-serial-t070';
  const echoMedia = 'media-echo-t070';
  if (world === 'serial') {
    seedVodFacts(conn, {
      sourceId: SRC_A,
      upstreamVodId: '1001',
      titleName: SERIAL_NAME,
      lineKey: 'main',
      episodeKey: '02',
      episodeLabel: '第02集',
      parentMediaId: 'media-parent-serial-t070',
      episodeMediaId: serialMedia,
      currentDetailRevision: options.originDetailRevision ?? 1,
      signature: SERIAL_SIGNATURE,
    });
  } else if (world === 'echo') {
    seedVodFacts(conn, {
      sourceId: SRC_A,
      upstreamVodId: '1003',
      titleName: ECHO_NAME,
      lineKey: 'main',
      episodeKey: 'movie',
      episodeLabel: '正片',
      parentMediaId: 'media-parent-echo-t070',
      episodeMediaId: echoMedia,
      signature: ECHO_THEATRICAL_SIGNATURE,
    });
  } else if (world === 'static') {
    // 静态媒体:无任何 vod_* 事实(loader undefined 面)
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, created_at, updated_at) VALUES ('media-static-t070', ?, 'movie', '静态影片', 1, ?, ?)",
      )
      .run(HH, iso(CLOCK_START_MS), iso(CLOCK_START_MS));
  }

  const session = options.session ?? {};
  const mediaId = session.mediaId ?? (world === 'echo' ? echoMedia : world === 'static' ? 'media-static-t070' : serialMedia);
  seedPlaybackSession(conn, {
    sessionId: session.sessionId ?? SESSION_ENDED,
    mediaId,
    state: session.state ?? 'ended',
    generation: session.generation,
    endedAtMs: session.endedAtMs,
    deviceSessionId: session.deviceSessionId,
    profileId: session.profileId,
    profileContextVersion: session.profileContextVersion,
  });
  openRigs.push({ conn, dataDir });

  const clock = createFixtureFakeClock({ startMs: CLOCK_START_MS });
  const store = drizzleOnlineVodStore(conn);
  const cache = createVodCache({ nowMs: () => clock.nowMs() });
  const stub = createUpstreamStub();
  const service = createSwitchCandidatesService({
    config: SPEC_BUDGETS,
    cache,
    sourceConfig: createDbSourceConfig(conn),
    searchUpstream: stub.searchUpstream,
    fetchDetailUpstream: stub.fetchDetailUpstream,
    transitionSource: new TransitionSourceContextService(drizzleTransitionStore(conn)),
    loadSourceTitleFacts: createRealSourceTitleFactsLoader(conn, store),
    store,
    nowMs: () => clock.nowMs(),
  });

  const rig: Rig & { command?: never } = {
    conn,
    clock,
    stub,
    cache,
    service,
  };
  return rig;
}

/** 默认命令(ended 会话 + 当前代次;变体按字段覆盖) */
function baseCommand(sessionId: string = SESSION_ENDED, generation = 1): Parameters<ReturnType<typeof createSwitchCandidatesService>['listCandidates']>[0] {
  return {
    householdId: HH,
    deviceSessionId: DEVICE_SESSION,
    profileId: PROFILE,
    profileContextVersion: 1,
    fromSessionId: sessionId,
    expectedGeneration: generation,
    cursor: null,
  };
}

function errorCodeOf(error: unknown): { status: number; code: string } {
  expect(error).toBeInstanceOf(DomainError);
  const domainError = error as DomainError;
  return { status: domainError.status, code: String(domainError.code) };
}

async function expectDomainError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`期望 DomainError(${status} ${code})但成功返回`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('期望 DomainError')) throw error;
    const actual = errorCodeOf(error);
    expect(actual.status).toBe(status);
    expect(actual.code).toBe(code);
  }
}

function tableCountOf(conn: SqliteConnection, table: string): number {
  const row = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** 夹具序列世界 stub:srcA 单线 01/02/03;srcB main+backup 双线各含 02 */
function seedSerialStub(rig: Rig, lineCountA = 1, lineCountB = 2): void {
  rig.stub.setSearch(SRC_A, SERIAL_NAME, [stubItem({ upstreamVodId: '1001', name: SERIAL_NAME, year: '2024' })]);
  rig.stub.setSearch(SRC_B, SERIAL_NAME, [stubItem({ upstreamVodId: '9001', name: SERIAL_NAME, year: '2024' })]);
  rig.stub.setDetail(
    SRC_A,
    '1001',
    stubDetail({
      upstreamVodId: '1001',
      name: SERIAL_NAME,
      year: '2024',
      lines: Array.from({ length: lineCountA }, (_unused, index) => ({
        lineKey: index === 0 ? 'main' : `mirror-${index}`,
        lineLabel: index === 0 ? 'fixture正片' : `fixture镜像线${index}`,
        episodes: [
          { key: '01', label: '第01集' },
          { key: '02', label: '第02集' },
          { key: '03', label: '第03集' },
        ],
      })),
    }),
  );
  rig.stub.setDetail(
    SRC_B,
    '9001',
    stubDetail({
      upstreamVodId: '9001',
      name: SERIAL_NAME,
      year: '2024',
      lines: Array.from({ length: lineCountB }, (_unused, index) => ({
        lineKey: index === 0 ? 'main' : `backup-${index}`,
        lineLabel: index === 0 ? 'fixture正片' : `fixture备用线${index}`,
        episodes: [{ key: '02', label: '第02集' }],
      })),
    }),
  );
}

afterEach(() => {
  while (openRigs.length > 0) {
    const rig = openRigs.pop();
    if (rig === undefined) break;
    rig.conn.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* A. 授权链:未授权 404 同形/代次 409/终态门 409/failed 恢复窗 60s        */
/* ------------------------------------------------------------------ */

describe('A. 授权链:T059 同上下文 404 同形 → 代次 409 → 终态门 409 → failed 恢复窗 60s', () => {
  it('未授权 404 同形:不存在/跨设备会话/跨 Profile/旧 contextVersion 同码同形(不判别存在性)', async () => {
    const rig = createRig();
    seedSerialStub(rig);
    await expectDomainError(rig.service.listCandidates(baseCommand('ps-missing-t070')), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    await expectDomainError(rig.service.listCandidates({ ...baseCommand(), deviceSessionId: 'ds-other' }), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    await expectDomainError(rig.service.listCandidates({ ...baseCommand(), profileId: 'prof-other' }), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    await expectDomainError(rig.service.listCandidates({ ...baseCommand(), profileContextVersion: 2 }), 404, ProblemCode.PLAYBACK_NOT_FOUND);
    // 全部 404 且未触达上游(授权先于搜索;不可借错误/上游行为判别会话存在性)
    expect(rig.stub.searchCalls).toHaveLength(0);
  });

  it('expectedGeneration 不符 → 409 PLAYBACK_GENERATION_STALE(上下文授权失败优先于专用错误)', async () => {
    const rig = createRig({ session: { generation: 3 } });
    seedSerialStub(rig);
    await expectDomainError(rig.service.listCandidates(baseCommand(SESSION_ENDED, 2)), 409, ProblemCode.PLAYBACK_GENERATION_STALE);
    expect(rig.stub.searchCalls).toHaveLength(0);
  });

  it('终态门:活动态(preparing)来源不列候选 → 409 SOURCE_NOT_TERMINAL(先 stop 到 ended)', async () => {
    const rig = createRig({ session: { state: 'preparing' } });
    seedSerialStub(rig);
    await expectDomainError(rig.service.listCandidates(baseCommand()), 409, ProblemCode.SOURCE_NOT_TERMINAL);
    expect(rig.stub.searchCalls).toHaveLength(0);
  });

  it('failed 恢复窗:窗内可列候选;恰界(60s)即过期 → 410 TRANSITION_EXPIRED', async () => {
    const rig = createRig({ session: { state: 'failed', endedAtMs: CLOCK_START_MS } });
    seedSerialStub(rig);
    // 窗内(failedAt + 60s > now)
    const page = await rig.service.listCandidates(baseCommand());
    expect(page.items.length).toBeGreaterThan(0);
    // 推进到恰界:now == failedAt + 60s → 过期(与候选 TTL 同族常量,恰界失效)
    await rig.clock.advanceMs(60_000);
    await expectDomainError(rig.service.listCandidates(baseCommand()), 410, ProblemCode.TRANSITION_EXPIRED);
  });

  it('非 VOD 播放会话(静态媒体,无可信标题事实)→ 404 同形', async () => {
    const rig = createRig({ world: 'static' });
    await expectDomainError(rig.service.listCandidates(baseCommand()), 404, ProblemCode.NOT_FOUND);
    expect(rig.stub.searchCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* B. 候选评分/签发:ambiguous 默认面/版本冲突/opaque ref/私有绑定溯源      */
/* ------------------------------------------------------------------ */

describe('B. 候选评分与签发:服务端构造搜索 → matchCandidate 评分 → opaque 具体集', () => {
  it('序列剧跨源:搜索词=可信标题(canonicalName);3 候选全 ambiguous(reasons 按枚举序;解析面缺季/语言降歧义)', async () => {
    const rig = createRig();
    seedSerialStub(rig);
    const page = await rig.service.listCandidates(baseCommand());
    // 搜索词来自服务端可信标题事实;命令面无 q/URL(stub 只收到 canonicalName)
    expect(rig.stub.searchCalls).toEqual([
      { sourceId: SRC_A, query: SERIAL_NAME },
      { sourceId: SRC_B, query: SERIAL_NAME },
    ]);
    expect(page.items).toHaveLength(2); // 010 T070 修复适配:自身 (SRC_A,'1001') 整题排除,3→2
    expect(page.partial).toBe(false);
    expect(page.reasons).toEqual([]);
    expect(page.nextCursor).toBeNull();
    const expectedReasons = ['title_match', 'year_match', 'season_episode_missing', 'language_missing'];
    for (const item of page.items) {
      expect(item.title).toBe(SERIAL_NAME);
      expect(item.label).toBe('第02集');
      expect(item.year).toBe('2024');
      expect(item.season).toBeNull();
      expect(item.versionLabel).toBeNull();
      expect(item.matchConfidence).toBe('ambiguous');
      expect(item.matchReasons).toEqual(expectedReasons);
      expect(item.expiresAt).toBe(iso(CLOCK_START_MS + 60_000));
    }
    // 候选顺序:启用源配置序(srcA 先,其自身候选已排除)→ srcB 双线两锚
    expect(page.items[0]?.sourceLabel).toBe('夹具源B');
    expect(page.items[0]?.lineLabel).toBe('fixture正片');
    expect(page.items[1]?.sourceLabel).toBe('夹具源B');
    expect(page.items[1]?.lineLabel).toBe('fixture备用线1');
  });

  it('010 T070 修复：FR-029 排除来源自身候选 —— 与来源自身相同 (sourceId, upstreamVodId) 的整题不出现在候选列表', async () => {
    const rig = createRig();
    seedSerialStub(rig);
    const page = await rig.service.listCandidates(baseCommand());
    // 在播标题即 (SRC_A,'1001'):公共值面无源内部 ID/上游键,经私有绑定载荷核验
    // (sourceId, upstreamVodId) 组合 —— 自身整题(含其全部线锚)缺席
    const payloads = page.items.map(
      (item) => rig.cache.get<VodCandidateBindingPayload>(item.candidateRef)?.payload,
    );
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(`${payload?.sourceId ?? ''} ${payload?.upstreamVodId ?? ''}`).not.toBe(`${SRC_A} 1001`);
      // 排除是精确 (sourceId, upstreamVodId) 粒度:跨源同题候选 (SRC_B,'9001') 照常在列
      expect(payload?.sourceId).toBe(SRC_B);
      expect(payload?.upstreamVodId).toBe('9001');
    }
    expect(page.items.map((item) => item.lineLabel)).toEqual(['fixture正片', 'fixture备用线1']);
    // 组装前剔除:来源自身标题零详情抓取(不为排除项发上游请求;搜索仍两源照常)
    expect(rig.stub.detailCalls).toEqual([{ sourceId: SRC_B, upstreamVodId: '9001' }]);
    // 自身源搜索照常执行且其「ok」状态不受排除影响(源失败汇总无虚假 partial)
    expect(page.partial).toBe(false);
    expect(page.reasons).toEqual([]);
  });

  it('版本冲突世界:同题不同年/版本 → conflict;同版实例 → ambiguous(结论原样下发,不改写不提升)', async () => {
    const rig = createRig({ world: 'echo' });
    rig.stub.setSearch(SRC_A, ECHO_NAME, [
      stubItem({ upstreamVodId: '1003', name: ECHO_NAME, year: '2019', version: '剧场版' }),
      stubItem({ upstreamVodId: '2003', name: ECHO_NAME, year: '2023', version: '导演剪辑版' }),
    ]);
    rig.stub.setDetail(SRC_A, '1003', stubDetail({
      upstreamVodId: '1003', name: ECHO_NAME, year: '2019', version: '剧场版',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: 'movie', label: '正片' }] }],
    }));
    rig.stub.setDetail(SRC_A, '2003', stubDetail({
      upstreamVodId: '2003', name: ECHO_NAME, year: '2023', version: '导演剪辑版',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: 'movie', label: '正片' }] }],
    }));
    // 010 T070 修复适配:(SRC_A,'1003') 为来源自身候选(在播实例)已被排除;
    // 「同版实例 → ambiguous」钉面改由跨源同版实例 (SRC_B,'1003') 保持。
    rig.stub.setSearch(SRC_B, ECHO_NAME, [stubItem({ upstreamVodId: '1003', name: ECHO_NAME, year: '2019', version: '剧场版' })]);
    rig.stub.setDetail(SRC_B, '1003', stubDetail({
      upstreamVodId: '1003', name: ECHO_NAME, year: '2019', version: '剧场版',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: 'movie', label: '正片' }] }],
    }));
    const page = await rig.service.listCandidates(baseCommand());
    expect(page.items).toHaveLength(2);
    // 顺序:启用源配置序(srcA 先,其自身 1003 已排除)→ srcA 2003 conflict + srcB 1003 ambiguous
    const directorsCut = page.items[0];
    const theatrical = page.items[1];
    expect(theatrical?.versionLabel).toBe('剧场版');
    expect(theatrical?.matchConfidence).toBe('ambiguous');
    expect(theatrical?.matchReasons).toEqual([
      'title_match',
      'year_match',
      'season_episode_missing',
      'language_missing',
      'version_label_match',
    ]);
    expect(directorsCut?.versionLabel).toBe('导演剪辑版');
    expect(directorsCut?.matchConfidence).toBe('conflict');
    // 版本标签明确冲突关闭季集位(域规则钉面);冲突候选仍在列(api §5:conflict 只 beginning/target_history)
    expect(directorsCut?.matchReasons).toEqual(['title_match', 'year_conflict', 'language_missing', 'version_label_conflict']);
  });

  it('无锚定集标题整题跳过 + unsupported 集不入锚:只返回可绑定的具体集候选', async () => {
    const rig = createRig();
    // srcB 标题无 02(缺集形态主线),另一 unsupported 重复键集不参与
    // 010 T070 修复适配:srcA 追加同源异题 1101(可锚定)提供正面候选 —— 自身 1001
    // (同样可锚定)经 FR-029 排除不再入列,断言面(1 条/夹具源A/正片线)保持不变。
    rig.stub.setSearch(SRC_A, SERIAL_NAME, [
      stubItem({ upstreamVodId: '1001', name: SERIAL_NAME, year: '2024' }),
      stubItem({ upstreamVodId: '1101', name: SERIAL_NAME, year: '2024' }),
    ]);
    rig.stub.setSearch(SRC_B, SERIAL_NAME, [stubItem({ upstreamVodId: '9002', name: SERIAL_NAME, year: '2024' })]);
    rig.stub.setDetail(SRC_A, '1001', stubDetail({
      upstreamVodId: '1001', name: SERIAL_NAME, year: '2024',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: '01', label: '第01集' }, { key: '02', label: '第02集' }] }],
    }));
    rig.stub.setDetail(SRC_A, '1101', stubDetail({
      upstreamVodId: '1101', name: SERIAL_NAME, year: '2024',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: '01', label: '第01集' }, { key: '02', label: '第02集' }] }],
    }));
    rig.stub.setDetail(SRC_B, '9002', stubDetail({
      upstreamVodId: '9002', name: SERIAL_NAME, year: '2024',
      lines: [
        { lineKey: 'main', lineLabel: 'fixture主线', episodes: [{ key: '01', label: '第01集' }, { key: '04', label: '第04集' }] },
        { lineKey: 'backup', lineLabel: 'fixture备用线路', episodes: [{ key: '02', label: '第02集', unsupported: true }, { key: 'SP', label: '特典' }] },
      ],
    }));
    const page = await rig.service.listCandidates(baseCommand());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sourceLabel).toBe('夹具源A');
    expect(page.items[0]?.lineLabel).toBe('fixture正片');
  });

  it('opaque 签发:candidateRef 不可解码、注册表可逆绑定本列列表;公共值无源内部 ID/上游键/地址', async () => {
    const rig = createRig();
    seedSerialStub(rig);
    const page = await rig.service.listCandidates(baseCommand());
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain(SRC_A);
    expect(serialized).not.toContain(SRC_B);
    expect(serialized).not.toContain('1001');
    expect(serialized).not.toContain('9001');
    expect(serialized).not.toContain('http');
    const refs = new Set(page.items.map((item) => item.candidateRef));
    expect(refs.size).toBe(page.items.length);
    for (const item of page.items) {
      const resolved = rig.cache.resolveRef(item.candidateRef);
      expect(resolved).toBeDefined();
      expect(resolved?.local ?? '').toMatch(/^candidate:\d+$/);
      // 同一列列表签发(注册表可逆;全部 candidateRef 绑定同一 listingId)
      expect(resolved?.entryId).toBe(rig.cache.resolveRef(page.items[0]?.candidateRef ?? '')?.entryId);
      // 公共值面无私有键:绑定载荷持有,响应面不含
      expect(item).not.toHaveProperty('sourceId');
      expect(item).not.toHaveProperty('upstreamVodId');
    }
  });

  it('私有绑定:candidateRef → 注册表载荷含准确键/预览修订/候选溯源(fromSession/generation),TTL=60s', async () => {
    const rig = createRig({ session: { generation: 2 } });
    seedSerialStub(rig);
    const page = await rig.service.listCandidates(baseCommand(SESSION_ENDED, 2));
    const first = page.items[0];
    expect(first).toBeDefined();
    const view = rig.cache.get<VodCandidateBindingPayload>(first?.candidateRef ?? '');
    expect(view).toBeDefined();
    expect(view?.expired).toBe(false);
    const payload = view?.payload;
    expect(payload?.kind).toBe('candidate-binding');
    // 010 T070 修复适配:items[0] 现为首个跨源候选 (SRC_B,'9001');自身 (SRC_A,'1001') 已排除
    expect(payload?.sourceId).toBe(SRC_B);
    expect(payload?.upstreamVodId).toBe('9001');
    expect(payload?.lineKey).toBe('main');
    expect(payload?.episodeKey).toBe('02');
    expect(payload?.title).toBe(SERIAL_NAME);
    expect(payload?.previewRevision).toBe(1);
    // api §7 I1:候选映射绑定原 session/Profile/context/来源代次
    expect(payload?.fromSessionId).toBe(SESSION_ENDED);
    expect(payload?.sourceGeneration).toBe(2);
    expect(payload?.matchConfidence).toBe('ambiguous');
    expect(payload?.matchRuleVersion.length).toBeGreaterThan(0);
    // 私有定位物料(resolver 原料;不进公共 DTO)
    expect(payload?.lines[0]?.episodes.some((episode) => episode.locatorUrl !== null)).toBe(true);
    expect(view?.expiresAtMs).toBe(CLOCK_START_MS + 60_000);
  });

  it('预览修订:已物化标题对齐当前详情指针(3),新标题按计数器自 1 起', async () => {
    const rig = createRig({ originDetailRevision: 3 });
    seedSerialStub(rig);
    // 010 T070 修复适配:自身 (SRC_A,'1001') 已排除,「已物化对齐指针(3)」改钉跨源
    // 已物化标题 (SRC_B,'9001');「新标题计数自 1 起」改由跨源新标题 (SRC_B,'9005') 保持。
    seedVodFacts(rig.conn, {
      sourceId: SRC_B,
      upstreamVodId: '9001',
      titleName: SERIAL_NAME,
      lineKey: 'main',
      episodeKey: '02',
      episodeLabel: '第02集',
      parentMediaId: 'media-parent-serial-b-t070',
      episodeMediaId: 'media-serial-b-t070',
      currentDetailRevision: 3,
    });
    rig.stub.setSearch(SRC_B, SERIAL_NAME, [
      stubItem({ upstreamVodId: '9001', name: SERIAL_NAME, year: '2024' }),
      stubItem({ upstreamVodId: '9005', name: SERIAL_NAME, year: '2024' }),
    ]);
    rig.stub.setDetail(SRC_B, '9005', stubDetail({
      upstreamVodId: '9005', name: SERIAL_NAME, year: '2024',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: '02', label: '第02集' }] }],
    }));
    const page = await rig.service.listCandidates(baseCommand());
    expect(page.items).toHaveLength(3);
    expect(page.items[0]?.previewRevision).toBe(3);
    expect(page.items[1]?.previewRevision).toBe(3);
    expect(page.items[2]?.previewRevision).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* C. TTL 与分页:列 60s/游标续页/重放不变/伪造游标 410                     */
/* ------------------------------------------------------------------ */

describe('C. TTL 与分页:候选 TTL=60s;cursor 分页/续页/重放不变', () => {
  it('>20 候选分页:每页 20、nextCursor 续页、末页 null;同游标重放逐字段不变', async () => {
    const rig = createRig();
    // 21 候选:srcA 11 线(自身 (SRC_A,'1001') 整题已排除,不入列)+ srcB 21 线(各含锚定 02)
    seedSerialStub(rig, 11, 21);
    const firstPage = await rig.service.listCandidates(baseCommand());
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.nextCursor).not.toBeNull();
    const cursor = firstPage.nextCursor ?? '';
    const secondPage = await rig.service.listCandidates({ ...baseCommand(), cursor });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    // 已生成页重放不变(T028 同语义:冻结快照逐字段同值)
    const replayedSecond = await rig.service.listCandidates({ ...baseCommand(), cursor });
    expect(JSON.stringify(replayedSecond)).toBe(JSON.stringify(secondPage));
    // 第一页重放(缺 cursor = 新列;同游标重放需持游标)
    const replayedFirst = await rig.service.listCandidates({ ...baseCommand(), cursor });
    expect(JSON.stringify(replayedFirst)).toBe(JSON.stringify(secondPage));
  });

  it('伪造/未签发游标 → 410 VOD_SEARCH_EXPIRED(与列过期同形恢复动作)', async () => {
    const rig = createRig();
    seedSerialStub(rig, 11, 21); // 010 T070 修复适配:自身整题排除后候选总量由 srcB 供给
    const firstPage = await rig.service.listCandidates(baseCommand());
    await expectDomainError(
      rig.service.listCandidates({ ...baseCommand(), cursor: 'c1-not-a-real-ref' }),
      410,
      ProblemCode.VOD_SEARCH_EXPIRED,
    );
    void firstPage;
  });

  it('列 TTL:60s 内游标可续页;恰界过期后游标 410(候选不可再作为可验证目标)', async () => {
    const rig = createRig();
    seedSerialStub(rig, 11, 21); // 010 T070 修复适配:自身整题排除后候选总量由 srcB 供给(21 条)
    const firstPage = await rig.service.listCandidates(baseCommand());
    const cursor = firstPage.nextCursor ?? '';
    await rig.clock.advanceMs(59_999);
    const secondPage = await rig.service.listCandidates({ ...baseCommand(), cursor });
    expect(secondPage.items).toHaveLength(1);
    await rig.clock.advanceMs(1);
    await expectDomainError(
      rig.service.listCandidates({ ...baseCommand(), cursor }),
      410,
      ProblemCode.VOD_SEARCH_EXPIRED,
    );
  });
});

/* ------------------------------------------------------------------ */
/* D. partial/reasons 与全源失败:源失败汇总(opaque ref)/502/504/详情降级   */
/* ------------------------------------------------------------------ */

describe('D. partial/reasons:源失败汇总不下发源配置 ID;全源失败 502/全部超时 504', () => {
  it('单源搜索失败:partial=true + reasons `<opaqueRef>@unavailable`(不含源配置 ID);健康源候选照常', async () => {
    const rig = createRig();
    // 010 T070 修复适配:srcA 自身 1001 已排除,健康源正面候选改由同源异题 1101 提供
    rig.stub.setSearch(SRC_A, SERIAL_NAME, [
      stubItem({ upstreamVodId: '1001', name: SERIAL_NAME, year: '2024' }),
      stubItem({ upstreamVodId: '1101', name: SERIAL_NAME, year: '2024' }),
    ]);
    rig.stub.setSearch(SRC_B, SERIAL_NAME, 'reject');
    rig.stub.setDetail(SRC_A, '1101', stubDetail({
      upstreamVodId: '1101', name: SERIAL_NAME, year: '2024',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: '02', label: '第02集' }] }],
    }));
    const page = await rig.service.listCandidates(baseCommand());
    expect(page.partial).toBe(true);
    expect(page.reasons).toHaveLength(1);
    expect(page.reasons[0]).toMatch(/^[^ ]+@unavailable$/);
    expect(page.reasons.join(' ')).not.toContain(SRC_B);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.sourceLabel).toBe('夹具源A');
  });

  it('单源搜索成功但候选详情全败 → 该源降级 unavailable(源失败汇总);健康源照常', async () => {
    const rig = createRig();
    // 010 T070 修复适配:srcA 自身 1001 已排除,健康源正面候选改由同源异题 1101 提供
    rig.stub.setSearch(SRC_A, SERIAL_NAME, [
      stubItem({ upstreamVodId: '1001', name: SERIAL_NAME, year: '2024' }),
      stubItem({ upstreamVodId: '1101', name: SERIAL_NAME, year: '2024' }),
    ]);
    rig.stub.setSearch(SRC_B, SERIAL_NAME, [stubItem({ upstreamVodId: '9001', name: SERIAL_NAME, year: '2024' })]);
    rig.stub.setDetail(SRC_A, '1101', stubDetail({
      upstreamVodId: '1101', name: SERIAL_NAME, year: '2024',
      lines: [{ lineKey: 'main', lineLabel: 'fixture正片', episodes: [{ key: '02', label: '第02集' }] }],
    }));
    rig.stub.setDetail(SRC_B, '9001', 'reject');
    const page = await rig.service.listCandidates(baseCommand());
    expect(page.partial).toBe(true);
    expect(page.reasons).toHaveLength(1);
    expect(page.reasons[0]).toMatch(/@unavailable$/);
    expect(page.items).toHaveLength(1);
  });

  it('全部源搜索失败 → 502 VOD_UPSTREAM_FAILED(整次失败,无候选)', async () => {
    const rig = createRig();
    rig.stub.setSearch(SRC_A, SERIAL_NAME, 'reject');
    rig.stub.setSearch(SRC_B, SERIAL_NAME, 'reject');
    await expectDomainError(rig.service.listCandidates(baseCommand()), 502, VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED);
  });

  it('全部源超时 → 504 VOD_UPSTREAM_TIMEOUT(共享 deadline 收敛,不无界等待)', async () => {
    const rig = createRig();
    rig.stub.setSearch(SRC_A, SERIAL_NAME, 'timeout');
    rig.stub.setSearch(SRC_B, SERIAL_NAME, 'timeout');
    await expectDomainError(rig.service.listCandidates(baseCommand()), 504, VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT);
  }, 10_000);

  it('无启用来源 → 502(与搜索同形恢复动作)', async () => {
    const rig = createRig({ seedSources: false });
    await expectDomainError(rig.service.listCandidates(baseCommand()), 502, VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED);
  });
});

/* ------------------------------------------------------------------ */
/* E. 零副作用:零历史/零会话/零物化/零登记写入(列候选只读+进程内缓存)      */
/* ------------------------------------------------------------------ */

describe('E. 零历史零会话写入:列候选只读,零 DB 写(含成功/失败路径)', () => {
  it('成功列候选:全部持久表行数前后不变(会话/历史/物化/登记映射零写)', async () => {
    const rig = createRig();
    seedSerialStub(rig, 11, 21); // 010 T070 修复适配:自身整题排除后由 srcB 21 线供给续页候选
    const tables = [
      'playback_session',
      'media_item',
      'media_relation',
      'vod_title',
      'vod_line',
      'vod_episode',
      'vod_detail_snapshot',
      'vod_materialization_operation',
      'vod_registered_candidate',
      'source_entry',
      'playback_source',
      'device_session',
    ];
    const before = new Map(tables.map((table) => [table, tableCountOf(rig.conn, table)]));
    const firstPage = await rig.service.listCandidates(baseCommand());
    await rig.service.listCandidates({ ...baseCommand(), cursor: firstPage.nextCursor ?? '' });
    for (const table of tables) {
      expect(tableCountOf(rig.conn, table)).toBe(before.get(table));
    }
  });

  it('失败路径(全源失败)同样零写入', async () => {
    const rig = createRig();
    rig.stub.setSearch(SRC_A, SERIAL_NAME, 'reject');
    rig.stub.setSearch(SRC_B, SERIAL_NAME, 'reject');
    const before = tableCountOf(rig.conn, 'playback_session');
    await expectDomainError(rig.service.listCandidates(baseCommand()), 502, VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED);
    expect(tableCountOf(rig.conn, 'playback_session')).toBe(before);
    expect(tableCountOf(rig.conn, 'vod_registered_candidate')).toBe(0);
  });
});
