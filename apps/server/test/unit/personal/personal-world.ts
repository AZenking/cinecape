import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { hashToken, generateToken } from '@contexts/identity-access/infrastructure/token.service';
import {
  device,
  deviceSession,
  epgChannel,
  epgProgramme,
  household,
  account,
  mediaItem,
  mediaSource,
  playbackSession,
  playbackSource,
  profile,
  profilePolicy,
  profileChannelFavorite,
  playbackProgressState,
  profileViewingHistory,
  sourceEntry,
  type ProfileChannelFavorite,
  type ProfileViewingHistory,
  type PlaybackProgressState,
} from '../../../src/database/schema';
import type { TestRig } from '../../helpers';

/**
 * 个人数据单测夹具(T088/T089/T090 共用;纯数据构造,无路由):
 * - 主档案 A(无 PIN,默认选中)+ 次档案 B(无 PIN),两台设备会话各选一个档案;
 * - 可用频道(条目 present=1 × 启用 IPTV 源 × 播放资源)/ 失效频道(present=0);
 * - 可用点播(NAS file)/ 失效点播(present=0);
 * - 频道 EPG(一条覆盖 FIXED_NOW 的当前节目 + 一条未来节目,断言 current/next)。
 */

/** 夹具固定时刻(当前节目窗口锚点) */
export const PERSONAL_FIXTURE_NOW = '2026-10-23T08:00:00.000Z';
const FAR_FUTURE = '2027-01-01T00:00:00.000Z';

export interface PersonalWorld {
  readonly householdId: string;
  readonly accountId: string;
  /** 主档案 A(默认) */
  readonly profileAId: string;
  /** 次档案 B */
  readonly profileBId: string;
  readonly deviceIdA: string;
  readonly deviceIdB: string;
  readonly deviceSessionAId: string;
  readonly deviceSessionBId: string;
  readonly sessionAToken: string;
  readonly sessionBToken: string;
  /** 可用频道(含 EPG current/next) */
  readonly channel: { readonly mediaId: string; readonly sourceId: string; readonly entryId: string; readonly playbackSourceId: string };
  /** 失效频道(present=0,无播放资源) */
  readonly unavailableChannelMediaId: string;
  /** 可用点播(NAS file;content_revision 可指定) */
  readonly vod: { readonly mediaId: string; readonly sourceId: string; readonly entryId: string; readonly playbackSourceId: string };
  /** 失效点播 */
  readonly unavailableVodMediaId: string;
  /** 非频道(点播)媒体,用于「仅频道可收藏」负向 */
  readonly movieMediaId: string;
}

export interface SeedPersonalWorldOptions {
  /** 全部 created_at 基准 */
  readonly now?: string;
  /** 可用点播的 content_revision(默认 1) */
  readonly vodContentRevision?: number;
}

export function seedPersonalWorld(rig: TestRig, options: SeedPersonalWorldOptions = {}): PersonalWorld {
  void rig;
  const now = options.now ?? PERSONAL_FIXTURE_NOW;
  const db = getDb();
  const householdId = randomUUID();
  const accountId = randomUUID();
  const profileAId = randomUUID();
  const profileBId = randomUUID();
  const deviceIdA = randomUUID();
  const deviceIdB = randomUUID();
  const deviceSessionAId = randomUUID();
  const deviceSessionBId = randomUUID();
  const sessionAToken = generateToken();
  const sessionBToken = generateToken();
  const channelSourceId = randomUUID();
  const channelEntryId = randomUUID();
  const channelMediaId = randomUUID();
  const channelPlaybackSourceId = randomUUID();
  const unavailableChannelMediaId = randomUUID();
  const vodSourceId = randomUUID();
  const vodEntryId = randomUUID();
  const vodMediaId = randomUUID();
  const vodPlaybackSourceId = randomUUID();
  const unavailableVodMediaId = randomUUID();
  const movieMediaId = randomUUID();
  const epgSourceId = randomUUID();

  db.transaction((tx) => {
    tx.insert(household).values({ id: householdId, name: '个人单测家庭', createdAt: now }).run();
    tx.insert(account).values({
      id: accountId,
      householdId,
      username: 'personal',
      usernameNormalized: 'personal',
      passwordHash: 'x-not-verified',
      role: 'owner',
      createdAt: now,
    }).run();
    tx.insert(profile).values({
      id: profileAId, householdId, accountId, name: '档案A', type: 'adult', isDefault: 1, pinHash: null, status: 'active', createdAt: now,
    }).run();
    tx.insert(profile).values({
      id: profileBId, householdId, accountId, name: '档案B', type: 'adult', isDefault: 0, pinHash: null, status: 'active', createdAt: now,
    }).run();
    tx.insert(profilePolicy).values({
      householdId, profileId: profileAId, maxContentLevel: 18, allowUnrated: 1, version: 1, updatedAt: now,
    }).run();
    tx.insert(profilePolicy).values({
      householdId, profileId: profileBId, maxContentLevel: 18, allowUnrated: 1, version: 1, updatedAt: now,
    }).run();
    tx.insert(device).values({ id: deviceIdA, householdId, name: '设备A', type: 'web', createdAt: now }).run();
    tx.insert(device).values({ id: deviceIdB, householdId, name: '设备B', type: 'web', createdAt: now }).run();
    tx.insert(deviceSession).values({
      id: deviceSessionAId, householdId, accountId, deviceId: deviceIdA, tokenHash: hashToken(sessionAToken),
      activeProfileId: profileAId, expiresAt: FAR_FUTURE, lastActiveAt: now, createdAt: now,
    }).run();
    tx.insert(deviceSession).values({
      id: deviceSessionBId, householdId, accountId, deviceId: deviceIdB, tokenHash: hashToken(sessionBToken),
      activeProfileId: profileBId, expiresAt: FAR_FUTURE, lastActiveAt: now, createdAt: now,
    }).run();

    // EPG 源先建(iptv.epg_source_id 复合自引用外键 → media_source(household_id,id))
    tx.insert(mediaSource).values({
      id: epgSourceId, householdId, kind: 'epg', name: '夹具EPG', remoteUrl: 'http://epg.personal-fixture.test/xmltv.xml',
      enabled: 1, version: 1, createdAt: now, updatedAt: now,
    }).run();
    tx.insert(mediaSource).values({
      id: channelSourceId, householdId, kind: 'iptv', name: '夹具IPTV', remoteUrl: 'http://iptv.personal-fixture.test/list.m3u8',
      epgSourceId, enabled: 1, version: 1, createdAt: now, updatedAt: now,
    }).run();
    tx.insert(mediaSource).values({
      id: vodSourceId, householdId, kind: 'nas', name: '夹具NAS', rootKey: 'personal-fixture-nas', relativeDirectory: 'media',
      privateAccessApproved: 1, enabled: 1, version: 1, createdAt: now, updatedAt: now,
    }).run();

    tx.insert(mediaItem).values({
      id: channelMediaId, householdId, type: 'channel', title: '夹具频道', contentLevel: 0, version: 1, createdAt: now, updatedAt: now,
    }).run();
    tx.insert(mediaItem).values({
      id: unavailableChannelMediaId, householdId, type: 'channel', title: '失效频道', contentLevel: 0, version: 1, createdAt: now, updatedAt: now,
    }).run();
    tx.insert(mediaItem).values({
      id: vodMediaId, householdId, type: 'movie', title: '夹具影片', contentLevel: 0, version: 1,
      contentRevision: options.vodContentRevision ?? 1, createdAt: now, updatedAt: now,
    }).run();
    tx.insert(mediaItem).values({
      id: unavailableVodMediaId, householdId, type: 'movie', title: '失效影片', contentLevel: 0, version: 1, createdAt: now, updatedAt: now,
    }).run();
    tx.insert(mediaItem).values({
      id: movieMediaId, householdId, type: 'movie', title: '不可收藏影片', contentLevel: 0, version: 1, createdAt: now, updatedAt: now,
    }).run();

    tx.insert(sourceEntry).values({
      id: channelEntryId, householdId, sourceId: channelSourceId, identityKind: 'url',
      identityDigest: hashToken(`${channelSourceId}:channel`), mediaId: channelMediaId, present: 1,
      upstreamChannelId: 'personal-fixture-ch', // 自动 EPG 精确关联锚点(= epg_channel.xmltv_channel_id)
      firstSeenAt: now, lastSeenAt: now,
    }).run();
    tx.insert(sourceEntry).values({
      id: randomUUID(), householdId, sourceId: channelSourceId, identityKind: 'url',
      identityDigest: hashToken(`${channelSourceId}:unavailable-channel`), mediaId: unavailableChannelMediaId, present: 0,
      firstSeenAt: now, lastSeenAt: now, missingSince: now,
    }).run();
    tx.insert(sourceEntry).values({
      id: vodEntryId, householdId, sourceId: vodSourceId, identityKind: 'path',
      identityDigest: hashToken(`${vodSourceId}:movie.mp4`), mediaId: vodMediaId, present: 1,
      fileSizeText: '1073741824', fileMtimeNs: '1735000000000000000',
      firstSeenAt: now, lastSeenAt: now,
    }).run();
    tx.insert(sourceEntry).values({
      id: randomUUID(), householdId, sourceId: vodSourceId, identityKind: 'path',
      identityDigest: hashToken(`${vodSourceId}:gone.mp4`), mediaId: unavailableVodMediaId, present: 0,
      firstSeenAt: now, lastSeenAt: now, missingSince: now,
    }).run();

    tx.insert(playbackSource).values({
      id: channelPlaybackSourceId, householdId, sourceId: channelSourceId, sourceEntryId: channelEntryId,
      mediaItemId: channelMediaId, protocol: 'http', location: 'http://iptv.personal-fixture.test/stream.m3u8', createdAt: now, updatedAt: now,
    }).run();
    tx.insert(playbackSource).values({
      id: vodPlaybackSourceId, householdId, sourceId: vodSourceId, sourceEntryId: vodEntryId,
      mediaItemId: vodMediaId, protocol: 'file', location: '/nas-media/movie.mp4', mimeType: 'video/mp4', createdAt: now, updatedAt: now,
    }).run();

    // 节目窗口以真实 now 为锚(current/next 判定用 Date.now();避免绝对时刻过期失效)
    const nowMs = Date.now();
    const iso = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString();
    tx.insert(epgChannel).values({ householdId, sourceId: epgSourceId, xmltvChannelId: 'personal-fixture-ch', displayName: '夹具频道' }).run();
    tx.insert(epgProgramme).values({
      id: randomUUID(), householdId, sourceId: epgSourceId, xmltvChannelId: 'personal-fixture-ch',
      title: '正在直播节目', description: null, startsAt: iso(-30 * 60_000), endsAt: iso(30 * 60_000),
    }).run();
    tx.insert(epgProgramme).values({
      id: randomUUID(), householdId, sourceId: epgSourceId, xmltvChannelId: 'personal-fixture-ch',
      title: '下一档节目', description: null, startsAt: iso(30 * 60_000), endsAt: iso(60 * 60_000),
    }).run();
  });

  return {
    householdId,
    accountId,
    profileAId,
    profileBId,
    deviceIdA,
    deviceIdB,
    deviceSessionAId,
    deviceSessionBId,
    sessionAToken,
    sessionBToken,
    channel: { mediaId: channelMediaId, sourceId: channelSourceId, entryId: channelEntryId, playbackSourceId: channelPlaybackSourceId },
    unavailableChannelMediaId,
    vod: { mediaId: vodMediaId, sourceId: vodSourceId, entryId: vodEntryId, playbackSourceId: vodPlaybackSourceId },
    unavailableVodMediaId,
    movieMediaId,
  };
}

/* ---------------- 播放会话/进度种子(T089/T090) ---------------- */

export interface SeedPlaybackSessionRowOptions {
  readonly id?: string;
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly playbackSourceId: string;
  readonly state: 'preparing' | 'ready' | 'playing' | 'paused' | 'ended' | 'failed' | 'interrupted';
  readonly generation?: number;
  readonly version?: number;
  readonly positionSeconds?: number;
  readonly at?: string;
}

export interface SeededPlaybackSession {
  readonly sessionId: string;
  readonly generation: number;
  readonly version: number;
}

/** 直接构造指定状态 playback_session(来源/交付已解析;状态机 CHECK 全满足) */
export function seedPlaybackSessionRow(options: SeedPlaybackSessionRowOptions): SeededPlaybackSession {
  const generation = options.generation ?? 1;
  const version = options.version ?? 1;
  const at = options.at ?? PERSONAL_FIXTURE_NOW;
  const terminal = options.state === 'ended' || options.state === 'failed' || options.state === 'interrupted';
  const activeStates = options.state === 'ready' || options.state === 'playing' || options.state === 'paused';
  const sessionId = options.id ?? randomUUID();
  getDb()
    .insert(playbackSession)
    .values({
      id: sessionId,
      householdId: options.householdId,
      deviceSessionId: options.deviceSessionId,
      deviceId: options.deviceId,
      profileId: options.profileId,
      mediaId: options.mediaId,
      playbackSourceId: options.playbackSourceId,
      state: options.state,
      delivery: 'direct',
      generation,
      version,
      positionSeconds: options.positionSeconds ?? 0,
      audioTrackId: null,
      subtitleTrackId: null,
      desiredPaused: options.state === 'paused' ? 1 : 0,
      profileContextVersion: 1,
      createdAt: at,
      startedAt: activeStates || terminal ? at : null,
      endedAt: terminal ? at : null,
      lastHeartbeatAt: at,
      failureCode: options.state === 'failed' ? 'PLAYBACK_RESOURCE_UNAVAILABLE' : null,
    })
    .run();
  return { sessionId, generation, version };
}

/** 直接构造 resolve 绑定形态的 progress_state(等价 bindVodResolveCandidate 输出) */
export function seedProgressState(input: {
  readonly householdId: string;
  readonly playbackSessionId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly candidateEpoch: number;
  readonly contentRevision?: number;
  readonly started?: boolean;
  readonly lastSampleSeq?: number;
  readonly lastSampleDigest?: string | null;
  readonly lastGeneration?: number;
  readonly lastResult?: string | null;
  readonly profileContextVersion?: number;
}): void {
  getDb()
    .insert(playbackProgressState)
    .values({
      householdId: input.householdId,
      playbackSessionId: input.playbackSessionId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      candidateEpoch: input.candidateEpoch,
      contentRevision: input.contentRevision ?? 1,
      profileContextVersion: input.profileContextVersion ?? 1,
      started: input.started ? 1 : 0,
      lastSampleSeq: input.lastSampleSeq ?? 0,
      lastSampleDigest: input.lastSampleDigest ?? null,
      lastGeneration: input.lastGeneration ?? 1,
      lastResult: input.lastResult ?? null,
    })
    .run();
}

/** 历史行 upsert(T090/T093 前置事实) */
export function seedHistoryRow(input: {
  readonly householdId: string;
  readonly profileId: string;
  readonly mediaId: string;
  readonly writerEpoch: number;
  readonly writerPlaybackSessionId: string;
  readonly lastSampleSeq?: number;
  readonly contentRevision?: number;
  readonly positionSeconds: number;
  readonly durationSeconds?: number | null;
  readonly lastViewedAt?: string;
  readonly revision?: number;
}): void {
  getDb()
    .insert(profileViewingHistory)
    .values({
      householdId: input.householdId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      writerEpoch: input.writerEpoch,
      writerPlaybackSessionId: input.writerPlaybackSessionId,
      lastSampleSeq: input.lastSampleSeq ?? 0,
      contentRevision: input.contentRevision ?? 1,
      positionSeconds: input.positionSeconds,
      durationSeconds: input.durationSeconds ?? null,
      lastViewedAt: input.lastViewedAt ?? PERSONAL_FIXTURE_NOW,
      revision: input.revision ?? 1,
    })
    .onConflictDoUpdate({
      target: [profileViewingHistory.householdId, profileViewingHistory.profileId, profileViewingHistory.mediaId],
      set: {
        writerEpoch: input.writerEpoch,
        writerPlaybackSessionId: input.writerPlaybackSessionId,
        lastSampleSeq: input.lastSampleSeq ?? 0,
        contentRevision: input.contentRevision ?? 1,
        positionSeconds: input.positionSeconds,
        durationSeconds: input.durationSeconds ?? null,
        lastViewedAt: input.lastViewedAt ?? PERSONAL_FIXTURE_NOW,
        revision: input.revision ?? 1,
      },
    })
    .run();
}

/* ---------------- 读取辅助(断言用) ---------------- */

export function readFavorite(householdId: string, profileId: string, mediaId: string): ProfileChannelFavorite | undefined {
  return getDb()
    .select()
    .from(profileChannelFavorite)
    .where(
      and(
        eq(profileChannelFavorite.householdId, householdId),
        eq(profileChannelFavorite.profileId, profileId),
        eq(profileChannelFavorite.mediaId, mediaId),
      ),
    )
    .get();
}

export function readProgressStateRow(householdId: string, sessionId: string): PlaybackProgressState | undefined {
  return getDb()
    .select()
    .from(playbackProgressState)
    .where(and(eq(playbackProgressState.householdId, householdId), eq(playbackProgressState.playbackSessionId, sessionId)))
    .get();
}

export function readHistoryRowFor(householdId: string, profileId: string, mediaId: string): ProfileViewingHistory | undefined {
  return getDb()
    .select()
    .from(profileViewingHistory)
    .where(
      and(
        eq(profileViewingHistory.householdId, householdId),
        eq(profileViewingHistory.profileId, profileId),
        eq(profileViewingHistory.mediaId, mediaId),
      ),
    )
    .get();
}
