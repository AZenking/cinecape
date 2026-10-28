import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../../src/database/database';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import { PlaybackModule } from '../../../src/contexts/playback/playback.module';
import { cleanupRigs, startFreshApp } from '../../helpers';
import { seedPlaybackSession, seedPlaybackWorld } from '../../fixtures/playback';

/**
 * 播放测试夹具冒烟测试(T013,spec 004):
 * - seedPlaybackWorld 在 startFreshApp 全量迁移库上创建身份/会话/目录/播放资源最小代表行;
 * - seedPlaybackSession 构造六态 playback_session(+可选 playback_ticket);
 * - 全部行以 SQL 读回断言存在与状态机初始值(generation=version=1 等);
 * - 经真实启动路径断言 PlaybackModule 装配(app.get(PlaybackRepository)),不引入任何测试路由。
 *
 * RED 约定:本文件先于夹具/模块落地编写;fixtures/playback 与 playback.module 不存在时
 * 整文件加载失败,即为 T013 的 RED 证据。
 */

/** 与 playback-migration.e2e-spec.ts 同款固定 UTC 时刻,保证确定性 */
const NOW = '2026-10-23T08:00:00.000Z';
const FAR_FUTURE = '2027-01-01T00:00:00.000Z';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

afterEach(async () => {
  await cleanupRigs();
});

describe('PlaybackModule 装配(T013:经真实 AppModule 启动路径)', () => {
  it('AppModule 注册后可解析 PlaybackRepository 单例 provider', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const repo = rig.app.get(PlaybackRepository);
    expect(repo).toBeInstanceOf(PlaybackRepository);
    expect(rig.app.get(PlaybackModule)).toBeInstanceOf(PlaybackModule);
  });
});

describe('seedPlaybackWorld:身份/会话/目录/播放资源最小代表行', () => {
  it('默认种子:owner 账号、无 PIN 默认档案 + 有 PIN 档案、有效设备会话、启用 IPTV + 停用 NAS 两类源、可见与不可见媒体', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW });

    const conn = Database.db;
    // 家庭 + owner 账号
    const household = conn.prepare('SELECT id, name FROM household WHERE id = ?').get(world.householdId) as
      | { id: string; name: string }
      | undefined;
    expect(household).toBeDefined();
    const account = conn
      .prepare('SELECT role, username FROM account WHERE household_id = ?')
      .get(world.householdId) as { role: string; username: string };
    expect(account.role).toBe('owner');
    expect(account.username).toBe('player');

    // 两个档案:无 PIN(默认激活)+ 有 PIN(pin_hash 落库)
    const plainProfile = conn
      .prepare('SELECT is_default, status, pin_hash FROM profile WHERE id = ?')
      .get(world.profileId) as { is_default: number; status: string; pin_hash: string | null };
    expect(plainProfile.is_default).toBe(1);
    expect(plainProfile.status).toBe('active');
    expect(plainProfile.pin_hash).toBeNull();
    const pinProfile = conn.prepare('SELECT pin_hash FROM profile WHERE id = ?').get(world.profileWithPinId) as {
      pin_hash: string | null;
    };
    expect(pinProfile.pin_hash).not.toBeNull();
    expect(world.pin.length).toBeGreaterThanOrEqual(4);

    // 有效设备会话:未撤销、远未过期、激活无 PIN 档案;明文 token 可按 SessionGuard 同款算法反查
    const session = conn
      .prepare(
        'SELECT token_hash, active_profile_id, expires_at, revoked_at FROM device_session WHERE id = ?',
      )
      .get(world.deviceSessionId) as {
      token_hash: string;
      active_profile_id: string | null;
      expires_at: string;
      revoked_at: string | null;
    };
    expect(session.token_hash).toBe(sha256Hex(world.sessionToken));
    expect(session.active_profile_id).toBe(world.profileId);
    expect(session.revoked_at).toBeNull();
    expect(session.expires_at > NOW).toBe(true);

    // 两类来源:LAN IPTV(启用,http+受控代理)与 NAS 文件源(默认停用,file)
    const iptvSource = conn
      .prepare('SELECT kind, enabled, remote_url FROM media_source WHERE id = ?')
      .get(world.iptv.sourceId) as { kind: string; enabled: number; remote_url: string | null };
    expect(iptvSource.kind).toBe('iptv');
    expect(iptvSource.enabled).toBe(1);
    expect(iptvSource.remote_url).not.toBeNull();
    const nasSource = conn
      .prepare('SELECT kind, enabled, remote_url, root_key FROM media_source WHERE id = ?')
      .get(world.nas.sourceId) as { kind: string; enabled: number; remote_url: string | null; root_key: string | null };
    expect(nasSource.kind).toBe('nas');
    expect(nasSource.enabled).toBe(0);
    expect(nasSource.remote_url).toBeNull();
    expect(nasSource.root_key).not.toBeNull();

    // 两个条目 present=1,各挂一条 playback_source(http/file 协议区分两类)
    for (const ref of [world.iptv, world.nas]) {
      const entry = conn
        .prepare('SELECT present, media_id FROM source_entry WHERE id = ?')
        .get(ref.entryId) as { present: number; media_id: string | null };
      expect(entry.present).toBe(1);
      expect(entry.media_id).toBe(ref.mediaId);
      const source = conn
        .prepare('SELECT protocol, location, requires_proxy FROM playback_source WHERE id = ?')
        .get(ref.playbackSourceId) as { protocol: string; location: string; requires_proxy: number };
      expect(source.location.length).toBeGreaterThan(0);
      expect(source.protocol).toBe(ref === world.iptv ? 'http' : 'file');
    }
    expect(
      (conn.prepare('SELECT requires_proxy FROM playback_source WHERE id = ?').get(world.iptv.playbackSourceId) as {
        requires_proxy: number;
      }).requires_proxy,
    ).toBe(1);

    // 可见媒体(IPTV 频道 + NAS 影片,条目回链 media_id)与不可见媒体(无条目/无资源)
    const visibleCount = conn
      .prepare('SELECT count(*) AS n FROM media_item WHERE id IN (?, ?)')
      .get(world.iptv.mediaId, world.nas.mediaId) as { n: number };
    expect(visibleCount.n).toBe(2);
    const invisible = conn.prepare('SELECT id FROM media_item WHERE id = ?').get(world.invisibleMediaId) as {
      id: string;
    };
    expect(invisible).toBeDefined();
    const invisibleLinked = conn
      .prepare('SELECT count(*) AS n FROM source_entry WHERE media_id = ?')
      .get(world.invisibleMediaId) as { n: number };
    expect(invisibleLinked.n).toBe(0);
  });

  it('options:nasEnabled/uhd 可覆盖(NAS 启用 + 4K 标记媒体追加)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW, nasEnabled: true, uhd: true });
    const conn = Database.db;
    const nas = conn.prepare('SELECT enabled FROM media_source WHERE id = ?').get(world.nas.sourceId) as {
      enabled: number;
    };
    expect(nas.enabled).toBe(1);
    expect(world.uhdMediaId).not.toBeNull();
    const uhd = conn
      .prepare('SELECT title FROM media_item WHERE id = ?')
      .get(world.uhdMediaId as string) as { title: string };
    expect(uhd.title).toContain('4K');
  });
});

describe('seedPlaybackSession:六态 playback_session 状态机初始值', () => {
  it('preparing:generation=version=1、position=0、desired_paused=0、source/delivery 为空', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW });
    const fixture = seedPlaybackSession(world, { state: 'preparing', at: NOW });
    const row = Database.db.prepare('SELECT * FROM playback_session WHERE id = ?').get(fixture.sessionId) as
      | Record<string, unknown>
      | undefined;
    expect(row).toBeDefined();
    expect(row?.['state']).toBe('preparing');
    expect(row?.['generation']).toBe(1);
    expect(row?.['version']).toBe(1);
    expect(row?.['position_seconds']).toBe(0);
    expect(row?.['desired_paused']).toBe(0);
    expect(row?.['playback_source_id']).toBeNull();
    expect(row?.['delivery']).toBeNull();
    expect(row?.['started_at']).toBeNull();
    expect(row?.['ended_at']).toBeNull();
    expect(row?.['failure_code']).toBeNull();
    expect(row?.['created_at']).toBe(NOW);
    expect(row?.['last_heartbeat_at']).toBe(NOW);
  });

  it('ready/playing/paused:source/delivery 必非空;playing/paused 有 started_at;paused 落 desired_paused=1', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW });
    const conn = Database.db;
    for (const state of ['ready', 'playing', 'paused'] as const) {
      const fixture = seedPlaybackSession(world, { state, at: NOW });
      const row = conn.prepare('SELECT * FROM playback_session WHERE id = ?').get(fixture.sessionId) as Record<
        string,
        unknown
      >;
      expect(row['state']).toBe(state);
      expect(row['playback_source_id']).toBe(world.iptv.playbackSourceId);
      expect(row['delivery']).toBe('direct');
      expect(row['generation']).toBe(1);
      expect(row['version']).toBe(1);
      if (state === 'ready') {
        expect(row['started_at']).toBeNull();
        expect(row['desired_paused']).toBe(0);
      } else {
        expect(row['started_at']).toBe(NOW);
      }
      if (state === 'paused') {
        expect(row['desired_paused']).toBe(1);
      }
      expect(row['ended_at']).toBeNull();
    }
  });

  it('终态 ended/failed/interrupted:ended_at 必设;failed 稳定失败码非空、其余为空', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW });
    const conn = Database.db;
    const ended = seedPlaybackSession(world, { state: 'ended', at: NOW });
    const endedRow = conn.prepare('SELECT state, ended_at, failure_code FROM playback_session WHERE id = ?').get(
      ended.sessionId,
    ) as { state: string; ended_at: string | null; failure_code: string | null };
    expect(endedRow.state).toBe('ended');
    expect(endedRow.ended_at).toBe(NOW);
    expect(endedRow.failure_code).toBeNull();

    const failed = seedPlaybackSession(world, { state: 'failed', at: NOW });
    const failedRow = conn.prepare('SELECT state, ended_at, failure_code FROM playback_session WHERE id = ?').get(
      failed.sessionId,
    ) as { state: string; ended_at: string | null; failure_code: string | null };
    expect(failedRow.state).toBe('failed');
    expect(failedRow.ended_at).toBe(NOW);
    expect(failedRow.failure_code).toBe('PLAYBACK_RESOURCE_UNAVAILABLE');

    const interrupted = seedPlaybackSession(world, { state: 'interrupted', at: NOW });
    const interruptedRow = conn
      .prepare('SELECT state, ended_at, failure_code FROM playback_session WHERE id = ?')
      .get(interrupted.sessionId) as { state: string; ended_at: string | null; failure_code: string | null };
    expect(interruptedRow.state).toBe('interrupted');
    expect(interruptedRow.ended_at).toBe(NOW);
    expect(interruptedRow.failure_code).toBeNull();
  });

  it('可覆盖:seek 后代(generation/version)、位置、remux 交付 + NAS 源、显式失败码', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW, nasEnabled: true });
    const fixture = seedPlaybackSession(world, {
      state: 'paused',
      generation: 2,
      version: 5,
      positionSeconds: 12.5,
      delivery: 'remux',
      playbackSourceId: world.nas.playbackSourceId,
      mediaId: world.nas.mediaId,
      failureCode: 'PLAYBACK_FORMAT_UNSUPPORTED',
    });
    const row = Database.db.prepare('SELECT * FROM playback_session WHERE id = ?').get(fixture.sessionId) as Record<
      string,
      unknown
    >;
    expect(row['generation']).toBe(2);
    expect(row['version']).toBe(5);
    expect(row['position_seconds']).toBe(12.5);
    expect(row['delivery']).toBe('remux');
    expect(row['playback_source_id']).toBe(world.nas.playbackSourceId);
    expect(row['media_id']).toBe(world.nas.mediaId);
  });
});

describe('seedPlaybackSession 可选票据:token_hash=明文 SHA-256', () => {
  it('票据行落库 hash、TTL 正区间、generation 与会话一致;明文只在句柄中', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW });
    const fixture = seedPlaybackSession(world, {
      state: 'ready',
      at: NOW,
      ticket: { token: 'opaque-ticket-plaintext', ttlSeconds: 60 },
    });
    expect(fixture.ticket).not.toBeNull();
    const ticket = fixture.ticket!;
    expect(ticket.token).toBe('opaque-ticket-plaintext');
    const row = Database.db.prepare('SELECT * FROM playback_ticket WHERE id = ?').get(ticket.ticketId) as Record<
      string,
      unknown
    >;
    expect(row).toBeDefined();
    expect(row['token_hash']).toBe(sha256Hex('opaque-ticket-plaintext'));
    expect(row['session_id']).toBe(fixture.sessionId);
    expect(row['household_id']).toBe(world.householdId);
    expect(row['generation']).toBe(fixture.generation);
    expect(row['revoked_at']).toBeNull();
    expect(String(row['issued_at'])).toBe(NOW);
    expect(String(row['expires_at']) > String(row['issued_at'])).toBe(true);
    // TTL 60s → expires = issued + 60s
    expect(Date.parse(String(row['expires_at'])) - Date.parse(String(row['issued_at']))).toBe(60_000);
  });

  it('未传票据时不建票行;撤销时间可注入', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-playback-fix-' });
    const world = await seedPlaybackWorld(rig, { now: NOW });
    const plain = seedPlaybackSession(world, { state: 'ready', at: NOW });
    expect(plain.ticket).toBeNull();
    const revoked = seedPlaybackSession(world, {
      state: 'ready',
      at: NOW,
      ticket: { revokedAt: FAR_FUTURE },
    });
    const row = Database.db.prepare('SELECT revoked_at FROM playback_ticket WHERE id = ?').get(
      revoked.ticket!.ticketId,
    ) as { revoked_at: string | null };
    expect(row.revoked_at).toBe(FAR_FUTURE);
  });
});
