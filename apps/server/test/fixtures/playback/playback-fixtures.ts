import { randomUUID } from 'node:crypto';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { hashPassword } from '@contexts/identity-access/infrastructure/password.service';
import { generateToken, hashToken } from '@contexts/identity-access/infrastructure/token.service';
import { createPlaybackBudgets } from '../../../src/config/playback-budgets';
import { getConfig } from '../../../src/config/env';
import {
  account,
  device,
  deviceSession,
  household,
  mediaItem,
  mediaSource,
  playbackSession,
  playbackSource,
  playbackTicket,
  profile,
  sourceEntry,
} from '../../../src/database/schema';
import {
  isPlaybackStableErrorCode,
  type PlaybackDelivery,
  type PlaybackErrorCode,
  type PlaybackSessionState,
} from '../../../src/contexts/playback/domain/playback.types';
import type { TestRig } from '../../helpers';

/**
 * 播放契约测试种子夹具(T013,spec 004)—— US1/US2 共用的纯数据构造,无任何路由:
 * - seedPlaybackWorld:在 startFreshApp 的全量迁移库上创建身份(household/owner account/
 *   双档案含 PIN 与无 PIN)/设备与有效设备会话/两类播放来源(启用 LAN IPTV + 默认停用
 *   NAS 文件源)/可见与不可见媒体,返回各实体 id 句柄;
 * - seedPlaybackSession:构造指定状态 playback_session(preparing/ready/playing/paused/
 *   ended/failed/interrupted)+ 可选 playback_ticket(token_hash=明文 SHA-256),
 *   返回 session/ticket 句柄。
 *
 * 惯例(对齐既有契约/仓储测试):
 * - 全部走 Drizzle schema.ts 类型插入(经 auth/db 的 getDb() 共享 SQLite 单例,
 *   Database.close() 后自动重建句柄);better-sqlite3 为同步驱动,事务回调必须同步
 *   (与 playback.repository.ts 同约束),argon2id 真哈希先算后入事务;
 * - 时间一律 UTC ISO-8601 文本;明文凭据只在句柄中出现:device_session/playback_ticket
 *   落库的是 hashToken(明文)的 SHA-256 hex(与 SessionGuard/T018 票据同算法),
 *   PIN/密码为 argon2id 真哈希,供 PIN 校验与 owner 登录类用例直接使用;
 * - 「可见性」为派生事实(schema 无可见列):可见 = 存在 source_entry(present=1)回链
 *   media_id 且挂 playback_source;不可见 = 无条目/无资源的孤立 media_item;
 * - 「启用/停用」落在 media_source.enabled(父源开关;playback_source 本身无 enabled 列):
 *   默认 IPTV 启用、NAS 停用,使默认世界同时含两类启用状态的代表行。
 */

/** 固定 UTC 时刻(与 playback-migration.e2e-spec.ts 的 T0 同源),保证种子确定性 */
export const PLAYBACK_FIXTURE_NOW = '2026-10-23T08:00:00.000Z';

/** 远未来时刻(设备会话默认过期时间) */
export const PLAYBACK_FIXTURE_FAR_FUTURE = '2027-01-01T00:00:00.000Z';

/** LAN IPTV(启用代表行):受控代理路径,协议 http + requires_proxy=1 */
const IPTV_PLAYLIST_URL = 'http://iptv.playback-fixture.test/list.m3u8';
const IPTV_STREAM_URL = 'http://iptv.playback-fixture.test/stream/fixture-channel.m3u8';
/** NAS 文件源(停用代表行):私有路径,协议 file */
const NAS_MOVIE_PATH_1080P = '/nas-media/fixture-movie-1080p.mp4';
const NAS_MOVIE_PATH_2160P = '/nas-media/fixture-movie-2160p.mp4';

/** 一类播放来源的句柄(父源 + 条目 + 媒体 + 播放资源) */
export interface PlaybackSourceRef {
  readonly sourceId: string;
  readonly entryId: string;
  readonly mediaId: string;
  readonly playbackSourceId: string;
}

/** seedPlaybackWorld 返回的实体 id 句柄(明文凭据仅出现于此,库中只有哈希) */
export interface PlaybackWorld {
  readonly householdId: string;
  readonly accountId: string;
  /** 无 PIN 默认档案(device_session.active_profile_id 指向它) */
  readonly profileId: string;
  /** 有 PIN 档案(pin_hash = argon2id(pin)) */
  readonly profileWithPinId: string;
  /** 有 PIN 档案明文 PIN */
  readonly pin: string;
  /** owner 明文密码(登录类用例用;库中为 argon2id 哈希) */
  readonly password: string;
  readonly deviceId: string;
  readonly deviceSessionId: string;
  /** 设备会话明文令牌(Cookie hmp_session=… 或 Authorization: Bearer … 均可) */
  readonly sessionToken: string;
  /** LAN IPTV 来源(默认启用,http+代理) */
  readonly iptv: PlaybackSourceRef;
  /** NAS 文件来源(默认停用,file;nasEnabled 可翻转) */
  readonly nas: PlaybackSourceRef;
  /** 不可见媒体:无条目/无播放资源的孤立 media_item */
  readonly invisibleMediaId: string;
  /** 4K 标记媒体(options.uhd 时创建;挂 NAS 来源,分辨率仅以标题/路径标注,schema 无分辨率列) */
  readonly uhdMediaId: string | null;
}

export interface SeedPlaybackWorldOptions {
  /** 全部 created_at/last_active_at 基准(UTC ISO-8601;默认固定时刻,保证确定性) */
  now?: string;
  householdName?: string;
  username?: string;
  password?: string;
  /** 有 PIN 档案明文 PIN(4~12 字符,默认 6 位数字) */
  pin?: string;
  /** LAN IPTV 来源是否启用(默认 true) */
  iptvEnabled?: boolean;
  /** NAS 文件来源是否启用(默认 false —— 提供「停用」代表行) */
  nasEnabled?: boolean;
  /** 追加 4K 标记媒体(默认 false) */
  uhd?: boolean;
  /** device_session.expires_at(默认远未来) */
  sessionExpiresAt?: string;
}

/**
 * 在既有 rig 的完整迁移库上创建播放世界最小代表行(一次 rig 调一次,幂等由调用方保证)。
 * 异步仅因 PIN/密码 argon2id 真哈希;插入在单个同步事务内原子完成。
 */
export async function seedPlaybackWorld(rig: TestRig, options: SeedPlaybackWorldOptions = {}): Promise<PlaybackWorld> {
  void rig; // rig 仅约束调用时序(必须先 startFreshApp);数据访问经 Database 单例句柄 getDb()
  const now = options.now ?? PLAYBACK_FIXTURE_NOW;
  const pin = options.pin ?? '135790';
  const password = options.password ?? 'password-123';
  const db = getDb();
  // argon2id 真哈希先算(异步),事务体保持同步(better-sqlite3 驱动约束)
  const [passwordHash, pinHash] = await Promise.all([hashPassword(password), hashPassword(pin)]);

  const householdId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const profileWithPinId = randomUUID();
  const deviceId = randomUUID();
  const deviceSessionId = randomUUID();
  const iptv: PlaybackSourceRef = {
    sourceId: randomUUID(),
    entryId: randomUUID(),
    mediaId: randomUUID(),
    playbackSourceId: randomUUID(),
  };
  const nas: PlaybackSourceRef = {
    sourceId: randomUUID(),
    entryId: randomUUID(),
    mediaId: randomUUID(),
    playbackSourceId: randomUUID(),
  };
  const invisibleMediaId = randomUUID();
  const uhdMediaId = options.uhd === true ? randomUUID() : null;
  const uhdEntryId = uhdMediaId === null ? null : randomUUID();
  const uhdPlaybackSourceId = uhdMediaId === null ? null : randomUUID();
  const sessionToken = generateToken();

  db.transaction((tx) => {
    // 身份:一家庭一 owner 账号(account UNIQUE(household_id)),双档案共享该账号
    tx.insert(household)
      .values({
        id: householdId,
        name: options.householdName ?? '播放夹具家庭',
        createdAt: now,
      })
      .run();
    tx.insert(account)
      .values({
        id: accountId,
        householdId,
        username: options.username ?? 'player',
        usernameNormalized: (options.username ?? 'player').toLowerCase(),
        passwordHash,
        role: 'owner',
        createdAt: now,
      })
      .run();
    tx.insert(profile)
      .values({
        id: profileId,
        householdId,
        accountId,
        name: '无码档案',
        type: 'adult',
        isDefault: 1,
        pinHash: null,
        status: 'active',
        createdAt: now,
      })
      .run();
    tx.insert(profile)
      .values({
        id: profileWithPinId,
        householdId,
        accountId,
        name: '有码档案',
        type: 'adult',
        isDefault: 0,
        pinHash,
        status: 'active',
        createdAt: now,
      })
      .run();
    tx.insert(device)
      .values({
        id: deviceId,
        householdId,
        name: '客厅电视',
        type: 'tv',
        createdAt: now,
      })
      .run();
    tx.insert(deviceSession)
      .values({
        id: deviceSessionId,
        householdId,
        accountId,
        deviceId,
        tokenHash: hashToken(sessionToken),
        activeProfileId: profileId,
        expiresAt: options.sessionExpiresAt ?? PLAYBACK_FIXTURE_FAR_FUTURE,
        revokedAt: null,
        lastActiveAt: now,
        createdAt: now,
      })
      .run();

    // 目录:启用 LAN IPTV + 停用 NAS(「启用/停用」落在父源 media_source.enabled)
    tx.insert(mediaSource)
      .values({
        id: iptv.sourceId,
        householdId,
        kind: 'iptv',
        name: '夹具LAN IPTV',
        remoteUrl: IPTV_PLAYLIST_URL,
        enabled: options.iptvEnabled === false ? 0 : 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(mediaSource)
      .values({
        id: nas.sourceId,
        householdId,
        kind: 'nas',
        name: '夹具NAS 影库',
        rootKey: 'playback-fixture-nas',
        relativeDirectory: 'media',
        privateAccessApproved: 1,
        enabled: options.nasEnabled === true ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // 媒体:可见(IPTV 频道 + NAS 1080p 影片)/ 不可见(孤立行)/ 可选 4K 标记
    tx.insert(mediaItem)
      .values({
        id: iptv.mediaId,
        householdId,
        type: 'channel',
        title: '夹具频道',
        contentLevel: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(mediaItem)
      .values({
        id: nas.mediaId,
        householdId,
        type: 'movie',
        title: '夹具影片-1080p',
        contentLevel: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(mediaItem)
      .values({
        id: invisibleMediaId,
        householdId,
        type: 'movie',
        title: '不可见影片',
        contentLevel: 0,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (uhdMediaId !== null) {
      tx.insert(mediaItem)
        .values({
          id: uhdMediaId,
          householdId,
          type: 'movie',
          title: '夹具影片-4K(2160p)',
          contentLevel: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // 条目(present=1,回链 media_id;NAS 条目带文件大小/mtime 的十进制文本)
    tx.insert(sourceEntry)
      .values({
        id: iptv.entryId,
        householdId,
        sourceId: iptv.sourceId,
        identityKind: 'url',
        identityDigest: hashToken(IPTV_PLAYLIST_URL),
        mediaId: iptv.mediaId,
        present: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    tx.insert(sourceEntry)
      .values({
        id: nas.entryId,
        householdId,
        sourceId: nas.sourceId,
        identityKind: 'path',
        identityDigest: hashToken(NAS_MOVIE_PATH_1080P),
        mediaId: nas.mediaId,
        present: 1,
        fileSizeText: '1073741824',
        fileMtimeNs: '1794000000000000000',
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .run();
    if (uhdMediaId !== null && uhdEntryId !== null) {
      tx.insert(sourceEntry)
        .values({
          id: uhdEntryId,
          householdId,
          sourceId: nas.sourceId,
          identityKind: 'path',
          identityDigest: hashToken(NAS_MOVIE_PATH_2160P),
          mediaId: uhdMediaId,
          present: 1,
          fileSizeText: '4294967296',
          fileMtimeNs: '1794000000000000001',
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .run();
    }

    // 播放资源:私有 location 不对下发;IPTV 走受控代理,文件源直读
    tx.insert(playbackSource)
      .values({
        id: iptv.playbackSourceId,
        householdId,
        sourceId: iptv.sourceId,
        sourceEntryId: iptv.entryId,
        mediaItemId: iptv.mediaId,
        protocol: 'http',
        location: IPTV_STREAM_URL,
        mimeType: 'application/vnd.apple.mpegurl',
        priority: 100,
        requiresProxy: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    tx.insert(playbackSource)
      .values({
        id: nas.playbackSourceId,
        householdId,
        sourceId: nas.sourceId,
        sourceEntryId: nas.entryId,
        mediaItemId: nas.mediaId,
        protocol: 'file',
        location: NAS_MOVIE_PATH_1080P,
        mimeType: 'video/mp4',
        priority: 100,
        requiresProxy: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (uhdMediaId !== null && uhdEntryId !== null && uhdPlaybackSourceId !== null) {
      tx.insert(playbackSource)
        .values({
          id: uhdPlaybackSourceId,
          householdId,
          sourceId: nas.sourceId,
          sourceEntryId: uhdEntryId,
          mediaItemId: uhdMediaId,
          protocol: 'file',
          location: NAS_MOVIE_PATH_2160P,
          mimeType: 'video/mp4',
          priority: 90,
          requiresProxy: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  });

  return {
    householdId,
    accountId,
    profileId,
    profileWithPinId,
    pin,
    password,
    deviceId,
    deviceSessionId,
    sessionToken,
    iptv,
    nas,
    invisibleMediaId,
    uhdMediaId,
  };
}

/** 可选票据构造入参(明文 token 只在句柄返回,库中仅存 SHA-256) */
export interface SeedPlaybackTicketOptions {
  /** 明文票据(缺省随机生成;多次签发需各自唯一 —— token_hash 全局 UNIQUE) */
  token?: string;
  /** 缺省 = 会话 generation */
  generation?: number;
  /** 缺省 = 当前 env 派生的票据 TTL(budgets.ticket.ttlSeconds) */
  ttlSeconds?: number;
  /** issued_at(缺省 = 会话 at) */
  at?: string;
  /** 撤销时间(缺省 null = 有效票) */
  revokedAt?: string | null;
}

export interface SeedPlaybackSessionOptions {
  /** 目标状态(preparing/ready/playing/paused/ended/failed/interrupted;显式必填,避免默认态漂移) */
  state: PlaybackSessionState;
  id?: string;
  /** 缺省 1(data-model:首代 generation=version=1) */
  generation?: number;
  /** 缺省 1 */
  version?: number;
  /** 影片逻辑位置秒,缺省 0 */
  positionSeconds?: number;
  /** 暂停意图,缺省:paused→1 其余→0 */
  desiredPaused?: 0 | 1;
  /** 交付模式(资源已解析时缺省 direct) */
  delivery?: PlaybackDelivery;
  /** 播放资源(缺省:preparing 强制无源;其余默认 IPTV 源;显式 null 表示未解析源) */
  playbackSourceId?: string | null;
  profileId?: string;
  deviceSessionId?: string;
  deviceId?: string;
  mediaId?: string;
  /** created_at/last_heartbeat_at 基准(UTC;缺省固定时刻) */
  at?: string;
  /** failed 态稳定失败码(缺省 PLAYBACK_RESOURCE_UNAVAILABLE;其余状态强制为空) */
  failureCode?: PlaybackErrorCode;
  /** 可选票据(缺省不建票) */
  ticket?: SeedPlaybackTicketOptions;
}

/** seedPlaybackSession 返回句柄(明文票据仅在 ticket.token) */
export interface PlaybackSessionFixture {
  readonly sessionId: string;
  readonly state: PlaybackSessionState;
  readonly generation: number;
  readonly version: number;
  readonly playbackSourceId: string | null;
  readonly delivery: PlaybackDelivery | null;
  readonly ticket: {
    readonly ticketId: string;
    readonly token: string;
    readonly tokenHash: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly generation: number;
    readonly revokedAt: string | null;
  } | null;
}

/**
 * 构造指定状态的 playback_session(直接落库,状态机 CHECK 约束全部满足):
 * - preparing:source/delivery/started_at/ended_at/failure_code 全空,generation=version=1;
 * - ready:source+delivery 非空、started_at 空(首次交付才写);
 * - playing/paused:source+delivery+started_at 非空;paused 落 desired_paused=1;
 * - ended/failed/interrupted:ended_at 必设;failed 稳定失败码非空,其余为空;
 * - 票据:token_hash = hashToken(明文),expires = issued + TTL(TTL 缺省取当前 env 预算)。
 * 同步实现(SHA-256 为纯函数;无 argon2 异步开销)。
 */
export function seedPlaybackSession(world: PlaybackWorld, options: SeedPlaybackSessionOptions): PlaybackSessionFixture {
  const state = options.state;
  const at = options.at ?? PLAYBACK_FIXTURE_NOW;
  const generation = options.generation ?? 1;
  const version = options.version ?? 1;
  if (!Number.isInteger(generation) || generation < 1 || !Number.isInteger(version) || version < 1) {
    throw new Error(`generation/version 必须为 >=1 整数,收到:${String(generation)}/${String(version)}`);
  }
  const isPreparing = state === 'preparing';
  const isTerminal = state === 'ended' || state === 'failed' || state === 'interrupted';

  // 资源解析语义:preparing 强制无源(准备未完成禁止补造);显式 null 亦可表示未解析源
  const playbackSourceId = isPreparing
    ? null
    : options.playbackSourceId !== undefined
      ? options.playbackSourceId
      : world.iptv.playbackSourceId;
  if (playbackSourceId !== null && options.delivery === null) {
    throw new Error('已解析源必须携带交付模式(禁止 source 非空而 delivery 为空)');
  }
  const delivery: PlaybackDelivery | null = playbackSourceId === null ? null : (options.delivery ?? 'direct');
  // 与已解析资源同源的缺省媒体(preparing 默认指向 IPTV 媒体,作为解析目标)
  const sourceRef =
    playbackSourceId === world.iptv.playbackSourceId
      ? world.iptv
      : playbackSourceId === world.nas.playbackSourceId
        ? world.nas
        : null;
  const mediaId = options.mediaId ?? sourceRef?.mediaId ?? world.iptv.mediaId;

  const desiredPaused = options.desiredPaused ?? (state === 'paused' ? 1 : 0);
  const startedAt =
    state === 'playing' || state === 'paused' || (isTerminal && playbackSourceId !== null) ? at : null;
  const endedAt = isTerminal ? at : null;
  const failureCode = state === 'failed' ? (options.failureCode ?? 'PLAYBACK_RESOURCE_UNAVAILABLE') : null;
  if (failureCode !== null && !isPlaybackStableErrorCode(failureCode)) {
    throw new Error(`failed 态失败码必须为稳定码,收到:${String(failureCode)}`);
  }

  const sessionId = options.id ?? randomUUID();
  getDb()
    .insert(playbackSession)
    .values({
      id: sessionId,
      householdId: world.householdId,
      deviceSessionId: options.deviceSessionId ?? world.deviceSessionId,
      deviceId: options.deviceId ?? world.deviceId,
      profileId: options.profileId ?? world.profileId,
      mediaId,
      playbackSourceId,
      state,
      delivery,
      generation,
      version,
      positionSeconds: options.positionSeconds ?? 0,
      audioTrackId: null,
      subtitleTrackId: null,
      desiredPaused,
      createdAt: at,
      startedAt,
      endedAt,
      lastHeartbeatAt: at,
      failureCode,
    })
    .run();

  // 可选票据:直插(T018 前的契约测试用;hash 算法与 SessionGuard/仓储一致)
  let ticket: PlaybackSessionFixture['ticket'] = null;
  if (options.ticket !== undefined) {
    const issuedAt = options.ticket.at ?? at;
    const ttlSeconds = options.ticket.ttlSeconds ?? createPlaybackBudgets(getConfig()).ticket.ttlSeconds;
    const token = options.ticket.token ?? generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.parse(issuedAt) + ttlSeconds * 1000).toISOString();
    const ticketGeneration = options.ticket.generation ?? generation;
    const ticketId = randomUUID();
    getDb()
      .insert(playbackTicket)
      .values({
        id: ticketId,
        householdId: world.householdId,
        sessionId,
        tokenHash,
        issuedAt,
        expiresAt,
        generation: ticketGeneration,
        revokedAt: options.ticket.revokedAt ?? null,
      })
      .run();
    ticket = {
      ticketId,
      token,
      tokenHash,
      issuedAt,
      expiresAt,
      generation: ticketGeneration,
      revokedAt: options.ticket.revokedAt ?? null,
    };
  }

  return { sessionId, state, generation, version, playbackSourceId, delivery, ticket };
}
