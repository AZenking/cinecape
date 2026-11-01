/**
 * 010-online-vod T044 —— VOD 固定输入交付面(租约 + SafeUpstream)行为契约。
 *
 * T044 原文(tasks.md):「在 media-probe.service.ts、hls-proxy.service.ts、
 * application/playback-assets.service.ts 及 conversion-supervisor.service.ts 接固定
 * input/租约和 SafeUpstream;涵盖 master/media/相对URI/key/redirect;ffmpeg 不得直接
 * 任意上游联网,无法安全支持则明确拒绝该转换,不承诺全格式。」
 *
 * 覆盖组(本文件即其行为基线;零真实网络 —— 上游全部为 127.0.0.1 受控夹具 +
 * hostPort 精确许可,无需真实 DNS):
 * - A probe 固定 input:固定输入恰一次上游解析(resolveVodInput/bindFixedInput 幂等
 *   重入不重触 io;重复 probe 不重读最新 location),master/variant 各读恰一次,
 *   duration 事实按 endList 判定(endList=true 已知汇总 / endList=false null);
 * - B 相对 URI/key/redirect 代理路径:redirect 每跳校验后内部跟随(不透传 Location),
 *   相对变体/分片/key 按 master/media 清单基解析为绝对上游 URL;重写后下发清单零
 *   上游地址;segment/key 资产流经 SafeUpstream 嵌套链交付;
 * - C 嵌套预算超限拒绝:级别/总量预算超限 → 稳定拒绝(failureCode SOURCE_BUDGET_
 *   EXCEEDED;probe 归 resource_unavailable),文案静态脱敏(零 URL);
 * - D 旧代资产 409:固定输入域 rewritePlaylist/resolve 先过 assertGenerationDeliverable
 *   (旧代 409 PLAYBACK_GENERATION_STALE;新代沿用同 resolvedInputId);
 * - E seek 拒绝保留:seekCapability 事实来源(none|client;client 需已知 duration)。
 *   hls_proxy 交付恒为直播语义(服务端 seek 400 PLAYBACK_SEEK_UNSUPPORTED 保持既有
 *   selection 判定,本文件钉 facts 形态:delivery 恒 hls_proxy、duration 可 null);
 * - F ffmpeg 在线输入拒绝裁决:inputChannel='online-upstream' → PLAYBACK_FORMAT_
 *   UNSUPPORTED + 静态理由,不 reserve(不占额度)、不 spawn;
 * - G NAS 本地文件转换零变化:inputChannel 缺省/'validated-local-file' 沿用既有链
 *   (reserve+spawn+argv 含 -i 输入路径)。
 *
 * 权威依据:
 * - docs/specs/010-online-vod/contracts/internal-ports.md §3(固定输入与安全访问:
 *   probe/HLS代理/ffmpeg输入/seek 均用 resolvedInputId,不各自重读最新 location;
 *   ffmpeg 不能绕过 SafeUpstream 校验直接对任意嵌套地址联网;无法保证则拒绝转换);
 * - docs/specs/010-online-vod/contracts/api.md §7 I4(seekCapability 事实来源:可信
 *   probe/交付与可用 seek 范围;hls_proxy VOD 第一期仅 client|none)+ §4 资产行;
 * - docs/specs/010-online-vod/tasks.md T044/T045 原文(T045 renew/watchdog 面只留接缝)。
 *
 * 夹具分层(与 vod-input-binding.spec 同构):独立临时文件库 + 全量权威迁移 DDL
 * (0001–0007,foreign_keys=ON)+ 真实 drizzleVodInputStore(经 T044 网关装饰)+
 * createControlledMediaServer(127.0.0.1 随机端口)+ fixture-upstream HLS 呈现
 * (master/media/相对 URI/AES-128 key/302 redirect 链/endList 开关)+ FakeClock。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import DatabaseConstructor from 'better-sqlite3';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlledMediaServer, type ControlledMediaServer } from '../../fixtures';
import { createFixtureFakeClock, type FixtureFakeClock } from '../../fixtures/online-vod/fixture-world';
import {
  FIXTURE_HLS_KEY_IV_HEX,
  FIXTURE_HLS_KEY_MATERIAL,
  FIXTURE_HLS_SEGMENT_BODY,
  createHlsPresentation,
  type FixtureHlsPresentation,
} from '../../fixtures/online-vod/fixture-upstream';
import { DomainError } from '@platform/http-common/domain-error';
import { PLAYBACK_BUDGETS } from '@platform/config/playback-budgets';
import type { UpstreamNestedBudgets } from '@platform/upstream/safe-upstream.port';
import { drizzleVodInputStore } from '@contexts/playback/infrastructure/playback-input-store.drizzle';
import {
  HlsProxyService,
  VodFixedInputDeliveryGateway,
  VodHlsUpstreamReader,
  deriveHlsProxySeekCapability,
} from '@contexts/playback/infrastructure/hls-proxy.service';
import { MediaProbePlaybackProbePort, MediaProbeService } from '@contexts/playback/infrastructure/media-probe.service';
import { PlaybackPlanService } from '@contexts/playback/application/playback-plan.service';
import { PlaybackAssetsService } from '@contexts/playback/application/playback-assets.service';
import type { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import {
  ConversionSupervisorService,
  ONLINE_INPUT_CONVERSION_REFUSAL_REASON,
  type ConversionProcessHandle,
  type ConversionSpawnRequest,
} from '@contexts/playback/infrastructure/conversion-supervisor.service';
import { playbackOk } from '@contexts/playback/domain/playback.types';
import { ProblemCode } from '@hmp/shared';

/* ------------------------------------------------------------------ */
/* 夹具:真实 DDL rig(与 vod-input-binding.spec 同源手法)                  */
/* ------------------------------------------------------------------ */

type SqliteConnection = DatabaseConstructor.Database;

const CLOCK_START_MS = Date.parse('2026-10-30T09:00:00.000Z');
/** 输入租约有界(秒;expiresAt = resolvedAt + leaseSeconds,CHECK expires_at > resolved_at) */
const INPUT_LEASE_SECONDS = 600;

interface RigSeed {
  householdId: string;
  accountId: string;
  profileId: string;
  deviceId: string;
  deviceSessionId: string;
  sourceId: string;
  parentMediaId: string;
  episodeMediaId: string;
  titleId: string;
  lineId: string;
  episodeId: string;
  sourceEntryId: string;
  playbackSourceId: string;
}

interface Rig {
  conn: SqliteConnection;
  dataDir: string;
  clock: FixtureFakeClock;
  gateway: VodFixedInputDeliveryGateway;
  seed: RigSeed;
}

const openRigs: { conn: SqliteConnection; dataDir: string }[] = [];
const openServers: ControlledMediaServer[] = [];

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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** VOD 在线链路种子(FK 依赖序):身份 → vod 源 → 目录(父/集)→ entry → 在线 playback_source */
function seedVodWorld(conn: SqliteConnection, t0: number): RigSeed {
  const now = iso(t0);
  const householdId = `hh-t044-${randomUUID()}`;
  const accountId = `acc-t044-${randomUUID()}`;
  const profileId = `prof-t044-${randomUUID()}`;
  const deviceId = `dev-t044-${randomUUID()}`;
  const deviceSessionId = `dsess-t044-${randomUUID()}`;
  const sourceId = `src-t044-${randomUUID()}`;
  const parentMediaId = `media-parent-t044-${randomUUID()}`;
  const episodeMediaId = `media-ep-t044-${randomUUID()}`;
  const titleId = `vtitle-t044-${randomUUID()}`;
  const lineId = `vline-t044-${randomUUID()}`;
  const episodeId = `vep-t044-${randomUUID()}`;
  const sourceEntryId = `entry-t044-${randomUUID()}`;
  const playbackSourceId = `psrc-t044-${randomUUID()}`;
  conn.transaction(() => {
    conn.prepare('INSERT INTO household (id, name, created_at) VALUES (?, ?, ?)').run(householdId, 'T044 夹具家庭', now);
    conn
      .prepare(
        'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(accountId, householdId, 'admin', 'admin', 'hash', 'admin', now);
    conn
      .prepare(
        "INSERT INTO profile (id, household_id, account_id, name, type, is_default, status, created_at) VALUES (?, ?, ?, '主档案', 'adult', 1, 'active', ?)",
      )
      .run(profileId, householdId, accountId, now);
    conn.prepare("INSERT INTO device (id, household_id, type, created_at) VALUES (?, ?, 'web', ?)").run(deviceId, householdId, now);
    conn
      .prepare(
        'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(deviceSessionId, householdId, accountId, deviceId, `token-hash-${deviceSessionId}`, profileId, iso(t0 + 7 * 24 * 3600_000), now, now);
    conn
      .prepare(
        "INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, locator_revision, created_at, updated_at) VALUES (?, ?, 'vod', 'T044 夹具来源', 'https://upstream.fixture/api.php', 1, 1, 1, ?, ?)",
      )
      .run(sourceId, householdId, now, now);
    conn.prepare("INSERT INTO vod_source_config (household_id, source_id, adapter) VALUES (?, ?, 'apple-cms-json')").run(householdId, sourceId);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'series', 'T044 剧集', 1, 'vod_title', ?, ?)",
      )
      .run(parentMediaId, householdId, now, now);
    conn
      .prepare(
        "INSERT INTO media_item (id, household_id, type, title, version, media_role, created_at, updated_at) VALUES (?, ?, 'episode', '第01集', 1, 'vod_episode', ?, ?)",
      )
      .run(episodeMediaId, householdId, now, now);
    conn
      .prepare(
        'INSERT INTO vod_title (id, household_id, source_id, upstream_vod_id, parent_media_id, current_detail_revision, materialized_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      )
      .run(titleId, householdId, sourceId, 'up-100', parentMediaId, now);
    conn
      .prepare('INSERT INTO vod_line (id, household_id, title_id, line_key, display_name, sort_order) VALUES (?, ?, ?, ?, ?, 1)')
      .run(lineId, householdId, titleId, 'main', '主线');
    conn
      .prepare(
        "INSERT INTO vod_episode (id, household_id, line_id, episode_key, label, media_id, content_version_state) VALUES (?, ?, ?, 'ep-01', '第01集', ?, 'unverified')",
      )
      .run(episodeId, householdId, lineId, episodeMediaId);
    conn
      .prepare(
        "INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id, present, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'vod_episode', ?, ?, 1, ?, ?)",
      )
      .run(sourceEntryId, householdId, sourceId, 'a'.repeat(64), episodeMediaId, now, now);
    // 在线判别联合:locator_kind=online → location NULL + vod 引用非空 + protocol=hls
    conn
      .prepare(
        "INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id, protocol, location, priority, requires_proxy, locator_kind, vod_episode_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'hls', NULL, 100, 0, 'online', ?, ?, ?)",
      )
      .run(playbackSourceId, householdId, sourceId, sourceEntryId, episodeMediaId, episodeId, now, now);
  })();
  return {
    householdId,
    accountId,
    profileId,
    deviceId,
    deviceSessionId,
    sourceId,
    parentMediaId,
    episodeMediaId,
    titleId,
    lineId,
    episodeId,
    sourceEntryId,
    playbackSourceId,
  };
}

/** 直插播放会话(默认 preparing:playback_source_id 置空;可选 ready/delivery) */
function insertPlaybackSession(
  conn: SqliteConnection,
  seed: RigSeed,
  input: {
    sessionId: string;
    atMs: number;
    state?: 'preparing' | 'ready';
    delivery?: string | null;
  },
): void {
  const state = input.state ?? 'preparing';
  const delivery = input.delivery !== undefined ? input.delivery : state === 'preparing' ? null : 'hls_proxy';
  conn
    .prepare(
      `INSERT INTO playback_session (
        id, household_id, device_session_id, device_id, profile_id, media_id,
        playback_source_id, state, delivery, generation, version,
        position_seconds, audio_track_id, subtitle_track_id, desired_paused,
        profile_context_version, playback_started_at, cleanup_requested, cleanup_reason, cleanup_state,
        created_at, started_at, ended_at, last_heartbeat_at, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, NULL, NULL, 0, 1, NULL, 0, NULL, 'pending', ?, NULL, NULL, ?, NULL)`,
    )
    .run(
      input.sessionId,
      seed.householdId,
      seed.deviceSessionId,
      seed.deviceId,
      seed.profileId,
      seed.episodeMediaId,
      state === 'preparing' ? null : seed.playbackSourceId,
      state,
      delivery,
      iso(input.atMs),
      iso(input.atMs),
    );
}

function openRig(): Rig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-t044-vod-delivery-'));
  const conn = new DatabaseConstructor(path.join(dataDir, `${randomUUID()}.db`));
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  applyAuthoritativeMigrations(conn);
  const clock = createFixtureFakeClock({ startMs: CLOCK_START_MS });
  const seed = seedVodWorld(conn, CLOCK_START_MS);
  openRigs.push({ conn, dataDir });
  const store = drizzleVodInputStore({ handle: conn, nowMs: () => clock.nowMs() });
  const gateway = new VodFixedInputDeliveryGateway(store, () => conn, () => clock.nowMs());
  return { conn, dataDir, clock, gateway, seed };
}

/** 固定输入绑定(经 T044 网关:entryUrl 捕获恰一次;io 调用计数可断言) */
async function bindFixedInput(
  rig: Rig,
  input: { sessionId: string; entryUrl: string },
): Promise<{ upstreamResolveCount: () => number }> {
  let upstreamResolves = 0;
  const facts = async () => {
    upstreamResolves += 1;
    return {
      entryUrl: input.entryUrl,
      locatorRevision: 1,
      detailRevision: 1,
      contentRevision: 1,
      continuityRevision: null,
      evidenceState: 'unverified' as const,
      evidenceDigest: 'd'.repeat(64),
      leaseSeconds: INPUT_LEASE_SECONDS,
    };
  };
  await rig.gateway.resolveVodInput(
    { householdId: rig.seed.householdId, sessionId: input.sessionId, generation: 1, sourceId: rig.seed.sourceId },
    { resolveUpstream: facts },
  );
  // 桥(T043)同型幂等重入:已有绑定不重触 io(恰一次)
  await rig.gateway.bindFixedInput(
    {
      householdId: rig.seed.householdId,
      sessionId: input.sessionId,
      generation: 1,
      sourceId: rig.seed.sourceId,
      startBasis: 'beginning',
    },
    { resolveUpstream: facts },
  );
  return { upstreamResolveCount: () => upstreamResolves };
}

/* ------------------------------------------------------------------ */
/* 夹具:HLS 呈现(127.0.0.1 受控上游 + hostPort 精确许可;零真实网络)      */
/* ------------------------------------------------------------------ */

function mountPresentation(server: ControlledMediaServer, presentation: FixtureHlsPresentation): void {
  for (const route of presentation.routes) {
    if (route.response.kind === 'timeout') {
      server.setRoute(route.path, { kind: 'hang' });
      continue;
    }
    const location = route.response.headers['location'];
    if (typeof location === 'string' && location !== '') {
      server.setRoute(route.path, { kind: 'redirect', location, status: route.response.status });
      continue;
    }
    server.setRoute(route.path, {
      kind: 'body',
      body: route.response.body,
      status: route.response.status,
      contentType: route.response.headers['content-type'],
    });
  }
}

function fixturePresentation(
  server: ControlledMediaServer,
  options: { endList?: boolean; redirectHops?: number } = {},
): FixtureHlsPresentation {
  const presentation = createHlsPresentation({
    presentationKey: `t044:ep-01:${options.endList === false ? 'live-window' : 'vod'}`,
    origin: server.baseUrl,
    rootPath: `/vod/t044/ep-01${options.endList === false ? '-live' : ''}${options.redirectHops === undefined ? '' : `-r${options.redirectHops}`}`,
    segments: [
      { uri: 'seg-1.ts', durationSeconds: 4 },
      { uri: 'seg-2.ts', durationSeconds: 6 },
    ],
    key: { method: 'AES-128', uri: 'key.bin', ivHex: FIXTURE_HLS_KEY_IV_HEX },
    endList: options.endList ?? true,
    redirectHops: options.redirectHops ?? 0,
  });
  mountPresentation(server, presentation);
  return presentation;
}

/** 嵌套读取链(127.0.0.1 hostPort 精确许可;可注入微型嵌套预算) */
function fixtureReader(server: ControlledMediaServer, nestedBudgets?: UpstreamNestedBudgets): VodHlsUpstreamReader {
  return new VodHlsUpstreamReader({
    nestedBudgets:
      nestedBudgets ?? {
        perLevelMaxBytes: {
          manifest: 2 * 1024 * 1024,
          variant: 2 * 1024 * 1024,
          segment: 64 * 1024 * 1024,
          key: 16,
        },
        totalMaxBytes: 64 * 1024 * 1024 + 2 * 1024 * 1024 * 4,
        totalTimeoutMs: 8_000,
      },
    timeBudgets: { totalTimeoutMs: 5_000, idleTimeoutMs: 5_000, maxRedirects: 3 },
    allowedTargets: () => [{ kind: 'hostPort', host: '127.0.0.1', port: server.port }],
  });
}

/** VOD probe 面(固定 input → SafeUpstream 嵌套读取链) */
function vodProbePort(rig: Rig, reader: VodHlsUpstreamReader): MediaProbePlaybackProbePort {
  const probeClock = {
    now: () => rig.clock.nowMs(),
    delay: (ms: number) => rig.clock.advanceMs(ms),
  };
  return new MediaProbePlaybackProbePort({
    probe: new MediaProbeService({ budgets: PLAYBACK_BUDGETS, clock: probeClock, mediaRoots: {} }),
    plan: new PlaybackPlanService({ budgets: PLAYBACK_BUDGETS }),
    locator: { locate: async () => null },
    mediaRoots: {},
    vodProbe: { inputs: rig.gateway, reader },
  });
}

/** 收集流全部字节(资产流交付形态断言) */
function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function pathOf(uri: string): string {
  const pathStart = uri.indexOf('/', uri.indexOf('://') + 3);
  return pathStart >= 0 ? uri.slice(pathStart).split('?')[0] ?? uri.slice(pathStart) : uri;
}

afterEach(async () => {
  for (const server of openServers.splice(0)) {
    await server.close();
  }
  for (const rig of openRigs.splice(0)) {
    rig.conn.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* A. probe 固定 input(恰一次上游读取;endList 判定 duration)              */
/* ------------------------------------------------------------------ */

describe('vod-delivery-input(T044):probe 固定 input', () => {
  it('A1 [绿] probe 经固定 input 恰一次上游解析:resolve/bind 幂等重入不重触 io,重复 probe 不重读最新 location', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server, { redirectHops: 1 });
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    const bound = await bindFixedInput(rig, { sessionId, entryUrl: presentation.entryUri });

    const port = vodProbePort(rig, fixtureReader(server));
    const candidate = { playbackSourceId: rig.seed.playbackSourceId, sourceId: rig.seed.sourceId, delivery: 'hls_proxy' as const };
    const first = await port.probeFirstAvailable([candidate], 10_000);
    expect(first).toMatchObject({ playbackSourceId: rig.seed.playbackSourceId, delivery: 'hls_proxy' });
    if (!('facts' in first)) {
      throw new Error('probe 应成功');
    }
    // endList=true → 已知时长 = EXTINF 汇总(4+6)
    expect(first.facts.durationSeconds).toBe(10);
    // 上游解析(io seam)全程恰一次:bridge 型 resolve→bind 幂等重入不二次触达
    expect(bound.upstreamResolveCount()).toBe(1);
    // master 经 redirect 链恰一次,variant 恰一次(相对 URI 按 master 基解析)
    const hopPath = pathOf(presentation.entryUri);
    expect(server.requestCount(hopPath)).toBe(1);
    expect(server.requestCount(pathOf(presentation.masterUri))).toBe(1);
    expect(server.requestCount(pathOf(presentation.mediaPlaylists[0]?.absoluteUri ?? ''))).toBe(1);

    // 重复 probe:固定 input 不重读最新 location(上游解析计数不变),仅清单重读
    const second = await port.probeFirstAvailable([candidate], 10_000);
    expect('facts' in second && second.facts.durationSeconds).toBe(10);
    expect(bound.upstreamResolveCount()).toBe(1);
    expect(server.requestCount(pathOf(presentation.masterUri))).toBe(2);
  });

  it('A2 [绿] endList=false(直播窗口形态)→ duration 未知(null),delivery 恒 hls_proxy(服务端 seek 拒绝事实面不变)', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server, { endList: false });
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: presentation.entryUri });

    const port = vodProbePort(rig, fixtureReader(server));
    const outcome = await port.probeFirstAvailable(
      [{ playbackSourceId: rig.seed.playbackSourceId, sourceId: rig.seed.sourceId, delivery: 'hls_proxy' }],
      10_000,
    );
    expect(outcome).toMatchObject({ delivery: 'hls_proxy' });
    if (!('facts' in outcome)) {
      throw new Error('probe 应成功');
    }
    expect(outcome.facts.durationSeconds).toBeNull();
    expect(deriveHlsProxySeekCapability({ durationSeconds: outcome.facts.durationSeconds })).toBe('none');
  });

  it('A3 [绿] 固定输入可读但内容非可判读 HLS 清单 → 回落直播形态事实(起播资格不被 probe 预读撤销;预算/许可类失败仍稳定拒绝,见 C1)', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    server.setRoute('/vod/t044/not-hls/master.m3u8', {
      kind: 'body',
      body: 'fixture upstream: no route',
      status: 404,
      contentType: 'text/plain; charset=utf-8',
    });
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: `${server.baseUrl}/vod/t044/not-hls/master.m3u8` });

    const port = vodProbePort(rig, fixtureReader(server));
    const outcome = await port.probeFirstAvailable(
      [{ playbackSourceId: rig.seed.playbackSourceId, sourceId: rig.seed.sourceId, delivery: 'hls_proxy' }],
      10_000,
    );
    // 非 HLS 内容 = 内容形态类失败:回落 T044 前 hls_proxy 直播形态(duration null),
    // 会话可继续走 ready/交付;交付面首读仍经 SafeUpstream 链按稳定失败码收口
    expect(outcome).toMatchObject({
      playbackSourceId: rig.seed.playbackSourceId,
      delivery: 'hls_proxy',
      facts: { durationSeconds: null, audioTracks: [], subtitleTracks: [] },
    });
  });
});

/* ------------------------------------------------------------------ */
/* B. 相对 URI / key / redirect 代理路径(SafeUpstream 嵌套链 + 同源重写)   */
/* ------------------------------------------------------------------ */

describe('vod-delivery-input(T044):代理路径', () => {
  it('B1 [绿] 入口清单经 redirect 链内部跟随读取(每跳校验,不透传 Location),重写后下发清单零上游地址', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server, { redirectHops: 2 });
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: presentation.entryUri });
    // 入口登记(manifest 级;网关按其分流 SafeUpstream)
    rig.gateway.registerVodUpstreamUrls(rig.seed.householdId, sessionId, 1, [
      { url: presentation.entryUri, level: 'manifest' },
    ]);

    const reader = fixtureReader(server);
    const hls = new HlsProxyService({
      budgets: PLAYBACK_BUDGETS,
      vodDelivery: { reader, vodLevelOf: (url) => rig.gateway.vodLevelOf(url) },
    });
    const read = await hls.readPlaylist(presentation.entryUri);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error('入口清单读取应成功');
    }
    // redirect 每跳内部跟随(2 跳),收敛 master 文本;finalUrl 为收敛后地址(不下发浏览器)
    expect(read.value.text).toBe(presentation.masterText);
    expect(read.value.finalUrl).toBe(presentation.masterUri);
    expect(server.requestCount(pathOf(presentation.entryUri))).toBe(1);
    expect(server.requestCount(pathOf(presentation.masterUri))).toBe(1);

    // 同源重写:全部 URI → {prefix}/{session}/{gen}/{assetId}?ticket=…;零上游地址
    const assets = new PlaybackAssetsService({ budgets: PLAYBACK_BUDGETS, entryPathPrefix: '/api/playback/stream', deliveryGate: rig.gateway });
    const rewritten = await assets.rewritePlaylist({
      householdId: rig.seed.householdId,
      sessionId,
      generation: 1,
      upstreamUrl: read.value.finalUrl,
      text: read.value.text,
      ticket: 'tkn-t044',
      depth: 0,
    });
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) {
      throw new Error('清单重写应成功');
    }
    expect(rewritten.value.playlist).not.toContain('127.0.0.1');
    expect(rewritten.value.playlist).toContain('/api/playback/stream/');
    // 重写登记的变体(相对 URI → master 基绝对)已进入 VOD 上游 URL 索引(variant 级)
    const mediaAbsolute = presentation.mediaPlaylists[0]?.absoluteUri ?? '';
    expect(rig.gateway.vodLevelOf(mediaAbsolute)).toBe('variant');
    expect(server.requestCount(pathOf(mediaAbsolute))).toBe(0);
  });

  it('B2 [绿] segment/key 资产流经 SafeUpstream 嵌套链交付(相对分片/key URI 已按 media 清单基解析为绝对上游 URL)', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server);
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: presentation.masterUri });

    const reader = fixtureReader(server);
    const hls = new HlsProxyService({
      budgets: PLAYBACK_BUDGETS,
      vodDelivery: { reader, vodLevelOf: (url) => rig.gateway.vodLevelOf(url) },
    });
    const assets = new PlaybackAssetsService({ budgets: PLAYBACK_BUDGETS, entryPathPrefix: '/api/playback/stream', deliveryGate: rig.gateway });
    rig.gateway.registerVodUpstreamUrls(rig.seed.householdId, sessionId, 1, [{ url: presentation.masterUri, level: 'manifest' }]);

    const read = await hls.readPlaylist(presentation.masterUri);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error('清单读取应成功');
    }
    const rewritten = await assets.rewritePlaylist({
      householdId: rig.seed.householdId,
      sessionId,
      generation: 1,
      upstreamUrl: read.value.finalUrl,
      text: read.value.text,
      ticket: 'tkn-t044',
      depth: 0,
    });
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) {
      throw new Error('清单重写应成功');
    }
    // 变体清单(master 重写登记的 playlist 资产)→ 相对分片/key 在此层重写登记
    const media = presentation.mediaPlaylists[0] as { segmentUris: readonly string[]; absoluteUri: string };
    expect(rig.gateway.vodLevelOf(media.absoluteUri)).toBe('variant');
    const mediaRead = await hls.readPlaylist(media.absoluteUri);
    expect(mediaRead.ok).toBe(true);
    if (!mediaRead.ok) {
      throw new Error('变体清单读取应成功');
    }
    const mediaRewritten = await assets.rewritePlaylist({
      householdId: rig.seed.householdId,
      sessionId,
      generation: 1,
      upstreamUrl: mediaRead.value.finalUrl,
      text: mediaRead.value.text,
      ticket: 'tkn-t044',
      depth: 1,
      ancestorUpstreamUrls: [read.value.finalUrl],
    });
    expect(mediaRewritten.ok).toBe(true);
    if (!mediaRewritten.ok) {
      throw new Error('变体清单重写应成功');
    }
    const byKind = (kind: string) => mediaRewritten.value.assets.find((entry) => entry.kind === kind);
    const segmentEntry = byKind('segment');
    const keyEntry = byKind('key');
    // 相对分片/key URI 按 media 清单基解析为绝对上游 URL(fixture 的绝对化口径一致)
    expect(segmentEntry?.upstreamUrl).toBe(media.segmentUris[0]);
    expect(keyEntry?.upstreamUrl).toBe(media.segmentUris[0]?.replace(/seg-1\.ts.*$/, 'key.bin'));
    // 级别登记:segment/key 各按嵌套级别分流(key 16 字节预算、segment 分片预算)
    expect(rig.gateway.vodLevelOf(segmentEntry?.upstreamUrl ?? '')).toBe('segment');
    expect(rig.gateway.vodLevelOf(keyEntry?.upstreamUrl ?? '')).toBe('key');

    const segmentRead = await hls.readAsset(segmentEntry?.upstreamUrl ?? '', { kind: 'segment' });
    expect(segmentRead.ok).toBe(true);
    if (segmentRead.ok) {
      expect(await collect(segmentRead.value.stream)).toStrictEqual(Buffer.from(FIXTURE_HLS_SEGMENT_BODY, "utf8"));
    }
    const keyRead = await hls.readAsset(keyEntry?.upstreamUrl ?? '', { kind: 'key' });
    expect(keyRead.ok).toBe(true);
    if (keyRead.ok) {
      const keyBytes = await collect(keyRead.value.stream);
      expect(keyBytes).toStrictEqual(Buffer.from(FIXTURE_HLS_KEY_MATERIAL, 'utf8'));
      expect(keyBytes.length).toBe(16);
    }
    expect(server.requestCount(pathOf(segmentEntry?.upstreamUrl ?? ''))).toBe(1);
    expect(server.requestCount(pathOf(keyEntry?.upstreamUrl ?? ''))).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* C. 嵌套预算超限拒绝                                                    */
/* ------------------------------------------------------------------ */

describe('vod-delivery-input(T044):嵌套预算', () => {
  it('C1 [绿] 级别预算超限 → 读取链稳定拒绝(SOURCE_BUDGET_EXCEEDED;文案静态脱敏零 URL);probe 回落直播形态事实(时长事实缺席,起播资格不撤销)', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server);
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: presentation.masterUri });

    const tinyBudgets: UpstreamNestedBudgets = {
      perLevelMaxBytes: { manifest: 8, variant: 8, segment: 8, key: 4 },
      totalMaxBytes: 16,
      totalTimeoutMs: 8_000,
    };
    const reader = fixtureReader(server, tinyBudgets);
    const ledger = reader.createLedger();
    const read = await reader.readText({ url: presentation.masterUri, level: 'manifest', ledger });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failureCode).toBe('SOURCE_BUDGET_EXCEEDED');
      expect(read.reason).not.toContain('127.0.0.1');
      expect(read.reason).not.toContain('http');
    }
    ledger.dispose();

    const port = vodProbePort(rig, reader);
    const outcome = await port.probeFirstAvailable(
      [{ playbackSourceId: rig.seed.playbackSourceId, sourceId: rig.seed.sourceId, delivery: 'hls_proxy' }],
      10_000,
    );
    // 读取链超限拒绝后 probe 回落直播形态事实(duration 未知 → seekCapability none;
    // 起播资格不被 probe 预读撤销 —— 可用性语义与 T044 前 hls_proxy probe 兼容)
    expect(outcome).toMatchObject({
      playbackSourceId: rig.seed.playbackSourceId,
      delivery: 'hls_proxy',
      facts: { durationSeconds: null, audioTracks: [], subtitleTracks: [] },
    });
    // 超限发生在首跳读取:上游清单可能已部分送达,但不得进入变体级
    expect(server.requestCount(pathOf(presentation.mediaPlaylists[0]?.absoluteUri ?? ''))).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* D. 旧代资产 409(固定输入域交付资格)                                   */
/* ------------------------------------------------------------------ */

describe('vod-delivery-input(T044):旧代资产 409', () => {
  it('D1 [绿] 换代后旧代 rewritePlaylist/resolve → 409 PLAYBACK_GENERATION_STALE;新代沿用同 resolvedInputId', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server);
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: presentation.masterUri });

    const gen1Input = rig.gateway.findDeliveryInput(rig.seed.householdId, sessionId, 1);
    expect(gen1Input).not.toBeNull();

    // 原子换绑(CAS + 旧代撤销同事务;新代沿用同 resolved_input_id)
    await rig.gateway.advanceGenerationWithRebind({
      householdId: rig.seed.householdId,
      sessionId,
      expectedGeneration: 1,
      nextGeneration: 2,
    });
    const gen2Input = rig.gateway.findDeliveryInput(rig.seed.householdId, sessionId, 2);
    expect(gen2Input?.resolvedInputId).toBe(gen1Input?.resolvedInputId);
    expect(gen2Input?.entryUrl).toBe(presentation.masterUri);

    const assets = new PlaybackAssetsService({ budgets: PLAYBACK_BUDGETS, entryPathPrefix: '/api/playback/stream', deliveryGate: rig.gateway });
    // 旧代资产交付/重写 → 409(data-model §6/playback-state §7)
    expect(() => assets.resolve(rig.seed.householdId, sessionId, 1, 'index')).toThrowError(DomainError);
    let staleCode: string | null = null;
    try {
      assets.resolve(rig.seed.householdId, sessionId, 1, 'index');
    } catch (error) {
      staleCode = error instanceof DomainError ? error.code : null;
    }
    expect(staleCode).toBe(ProblemCode.PLAYBACK_GENERATION_STALE);
    await expect(
      assets.rewritePlaylist({
        householdId: rig.seed.householdId,
        sessionId,
        generation: 1,
        upstreamUrl: presentation.masterUri,
        text: presentation.masterText,
        ticket: 'tkn-t044',
        depth: 0,
      }),
    ).rejects.toMatchObject({ code: ProblemCode.PLAYBACK_GENERATION_STALE });
    // 新代不受旧代资格影响(可正常登记/交付)
    expect(assets.resolve(rig.seed.householdId, sessionId, 2, 'index')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* E. seek 拒绝保留(seekCapability 事实来源)                             */
/* ------------------------------------------------------------------ */

describe('vod-delivery-input(T044):seekCapability 事实', () => {
  it('E1 [绿] 已知 duration → client(仅声明许可);未知/null/非正数 → none', () => {
    expect(deriveHlsProxySeekCapability({ durationSeconds: 3600 })).toBe('client');
    expect(deriveHlsProxySeekCapability({ durationSeconds: 10.5 })).toBe('client');
    expect(deriveHlsProxySeekCapability({ durationSeconds: null })).toBe('none');
    expect(deriveHlsProxySeekCapability({ durationSeconds: undefined })).toBe('none');
    expect(deriveHlsProxySeekCapability({ durationSeconds: 0 })).toBe('none');
    expect(deriveHlsProxySeekCapability({ durationSeconds: Number.NaN })).toBe('none');
  });

  it('E2 [绿] VOD probe 事实形态钉面:delivery 恒 hls_proxy(服务端 seek 400 PLAYBACK_SEEK_UNSUPPORTED 判定输入不变),duration 随 endList', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const known = fixturePresentation(server, { endList: true });
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: known.masterUri });

    const port = vodProbePort(rig, fixtureReader(server));
    const candidate = { playbackSourceId: rig.seed.playbackSourceId, sourceId: rig.seed.sourceId, delivery: 'hls_proxy' as const };
    const outcome = await port.probeFirstAvailable([candidate], 10_000);
    if (!('facts' in outcome)) {
      throw new Error('probe 应成功');
    }
    expect(outcome.delivery).toBe('hls_proxy');
    expect(outcome.facts.durationSeconds).toBe(10);
    expect(deriveHlsProxySeekCapability({ durationSeconds: outcome.facts.durationSeconds })).toBe('client');
  });
});

/* ------------------------------------------------------------------ */
/* F/G. ffmpeg 在线输入拒绝裁决 + NAS 本地文件转换零变化                    */
/* ------------------------------------------------------------------ */

/** 监督者依赖夹具:reserve/spawn 计数 + 常驻假进程(不退出;NAS 零变化断言用) */
function fakeSupervisorDeps(clock: FixtureFakeClock) {
  const supervisorClock = {
    now: () => clock.nowMs(),
    delay: (ms: number) => clock.advanceMs(ms),
  };
  let reserveCount = 0;
  let spawnCount = 0;
  const spawnArgvs: string[][] = [];
  const repository = {
    reserveConversion: () => {
      reserveCount += 1;
      return playbackOk({
        id: `conv-t044-${randomUUID()}`,
        householdId: 'hh',
        sessionId: 'sess',
        generation: 1,
        mode: 'remux' as const,
        state: 'reserved' as const,
        hardwareBackend: null,
        outputVideoCodec: 'copy',
        outputAudioCodec: 'copy',
        startedAt: null,
        endedAt: null,
        failureCode: null,
        cleanupState: 'pending',
        bytesOnDisk: 0,
        lastProgressAt: null,
      });
    },
    markConversion: () => playbackOk({} as never),
    releaseOnExit: () => playbackOk({} as never),
    compensateRelease: () => playbackOk({ deleted: true }),
  } as unknown as PlaybackRepository;
  const spawn = (request: ConversionSpawnRequest): ConversionProcessHandle => {
    spawnCount += 1;
    spawnArgvs.push([...request.argv]);
    const handle: ConversionProcessHandle = {
      pid: 424242,
      on: (() => handle) as unknown as ConversionProcessHandle['on'],
      kill: () => true,
    };
    return handle;
  };
  return {
    repository,
    spawn,
    clock: supervisorClock,
    counts: { reserve: () => reserveCount, spawn: () => spawnCount },
    spawnArgvs,
  };
}

function supervisorInput(clock: FixtureFakeClock, inputChannel?: 'validated-local-file' | 'online-upstream') {
  return {
    householdId: 'hh-t044',
    sessionId: `sess-t044-${randomUUID()}`,
    generation: 1,
    plan: {
      delivery: 'remux' as const,
      mode: 'remux' as const,
      outputVideoCodec: 'copy',
      outputAudioCodec: 'copy',
      reason: '转封装',
    },
    phase: 'prepare' as const,
    deadlineAtMs: clock.nowMs() + 30_000,
    inputPath: '/media/nas-root/movie.mkv',
    ...(inputChannel !== undefined ? { inputChannel } : {}),
  };
}

describe('vod-delivery-input(T044):ffmpeg 在线输入拒绝裁决', () => {
  it('F1 [绿] inputChannel=online-upstream → PLAYBACK_FORMAT_UNSUPPORTED + 静态理由;不 reserve 不 spawn', async () => {
    const clock = createFixtureFakeClock({ startMs: CLOCK_START_MS });
    const deps = fakeSupervisorDeps(clock);
    const supervisor = new ConversionSupervisorService({
      repository: deps.repository,
      budgets: PLAYBACK_BUDGETS,
      clock: deps.clock,
      spawn: deps.spawn,
      hardwareBackend: async () => null,
    });
    const refused = await supervisor.start(supervisorInput(clock, 'online-upstream'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe('PLAYBACK_FORMAT_UNSUPPORTED');
      expect(refused.detail).toBe(ONLINE_INPUT_CONVERSION_REFUSAL_REASON);
      expect(refused.detail).not.toContain('http');
    }
    expect(deps.counts.reserve()).toBe(0);
    expect(deps.counts.spawn()).toBe(0);
  });

  it('G1 [绿] NAS 本地文件转换零变化:inputChannel 缺省 / validated-local-file 沿用既有链(reserve+spawn,-i 输入路径)', async () => {
    const clock = createFixtureFakeClock({ startMs: CLOCK_START_MS });
    for (const inputChannel of [undefined, 'validated-local-file'] as const) {
      const deps = fakeSupervisorDeps(clock);
      const supervisor = new ConversionSupervisorService({
        repository: deps.repository,
        budgets: PLAYBACK_BUDGETS,
        clock: deps.clock,
        spawn: deps.spawn,
        hardwareBackend: async () => null,
      });
      const started = await supervisor.start(supervisorInput(clock, inputChannel));
      // 启动链为 fire-and-forget(硬件探测后 spawn):让渡宏任务边界后观察计数
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(started.ok).toBe(true);
      expect(deps.counts.reserve()).toBe(1);
      expect(deps.counts.spawn()).toBe(1);
      expect(deps.spawnArgvs[0]?.includes('-i')).toBe(true);
      expect(deps.spawnArgvs[0]?.includes('/media/nas-root/movie.mkv')).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 附加钉面:租约原语与固定输入消费点(T045 renew/watchdog 面接线缝)         */
/* ------------------------------------------------------------------ */

describe('vod-delivery-input(T044):固定输入消费点与租约', () => {
  it('H1 [绿] inputForDelivery 统一消费点:probe/资产/转换同 resolvedInputId;非 VOD 域恒 null(NAS/IPTV/直播零变化)', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server);
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: presentation.masterUri });

    const viaStore = await rig.gateway.inputForDelivery(rig.seed.householdId, sessionId, 1);
    const viaGateway = rig.gateway.findDeliveryInput(rig.seed.householdId, sessionId, 1);
    expect(viaGateway?.resolvedInputId).toBe(viaStore.resolvedInputId);
    expect(viaGateway?.entryUrl).toBe(presentation.masterUri);
    expect(rig.gateway.leaseStateOf(viaStore.resolvedInputId)).toBe('active');
    // 无绑定行会话(NAS/IPTV/直播)→ null,交付回落既有路径
    const nasSessionId = `sess-nas-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId: nasSessionId, atMs: CLOCK_START_MS });
    expect(rig.gateway.findDeliveryInput(rig.seed.householdId, nasSessionId, 1)).toBeNull();
    expect(rig.gateway.isFixedInputDelivery(rig.seed.householdId, nasSessionId, 1)).toBe(false);
    // assertVod* 断言对非 VOD 域 no-op(不抛出)
    expect(() => rig.gateway.assertVodGenerationDeliverable(rig.seed.householdId, nasSessionId, 1)).not.toThrow();
  });

  it('H2 [绿] 租约续期/撤销原语(T045 接线缝):renew 延展 expiresAt;revoke 后交付消费点恒 null', async () => {
    const server = await createControlledMediaServer();
    openServers.push(server);
    const presentation = fixturePresentation(server);
    const rig = openRig();
    const sessionId = `sess-t044-${randomUUID()}`;
    insertPlaybackSession(rig.conn, rig.seed, { sessionId, atMs: CLOCK_START_MS });
    await bindFixedInput(rig, { sessionId, entryUrl: presentation.masterUri });
    const input = rig.gateway.findDeliveryInput(rig.seed.householdId, sessionId, 1);
    expect(input).not.toBeNull();
    const resolvedInputId = input?.resolvedInputId ?? '';

    // 过期仅暴露事实(不强制拒交付;过期强制策略归 T045 renew 面)
    await rig.clock.advanceMs((INPUT_LEASE_SECONDS + 1) * 1000);
    expect(rig.gateway.leaseStateOf(resolvedInputId)).toBe('expired');
    expect(rig.gateway.renewInputLease(resolvedInputId)).toBe(true);
    expect(rig.gateway.leaseStateOf(resolvedInputId)).toBe('active');
    // 撤销(换代/清理面)→ 交付消费点同刻不可用
    expect(rig.gateway.revokeInputLease(resolvedInputId)).toBe(true);
    expect(rig.gateway.leaseStateOf(resolvedInputId)).toBe('revoked');
    expect(rig.gateway.findDeliveryInput(rig.seed.householdId, sessionId, 1)).toBeNull();
    expect(rig.gateway.renewInputLease(resolvedInputId)).toBe(false);
  });
});
