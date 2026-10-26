import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';
import { Database } from '../../src/database/database';
import { loadEnv } from '../../src/config/env.schema';
import { setEnvOverride } from '../../src/config/env';
import { hashPassword } from '../../src/modules/auth/password.service';
import { hashToken } from '../../src/modules/auth/token.service';
import { createManualClock, type ManualClock } from './clock';

/**
 * 规模测试夹具生成器(005 T012,quickstart.md §1):
 * 200 频道 / 500 点播 / 每频道每天 48 节目 / 7 天共 67,200 排期,
 * 供 US1/US4/US5/US6 契约测试与 Playwright e2e 共用。
 *
 * 使用方式:
 * - 程序化 API(vitest):先经 test/helpers.ts 的 startFreshApp 建库,
 *   再 `await seedScaleFixture(Database.db)`;或独立建库用
 *   `await createScaleFixtureDatabase({ dir })`(迁移+种子一步完成,返回路径与统计)。
 * - CLI(Playwright e2e 等外部消费):`pnpm --filter @hmp/server exec tsx test/fixtures/scale-fixture.cli.ts [--dir <目录>]`,
 *   产出独立 SQLite 库文件,后续以 DATA_DIR=<目录> 启动服务即可。
 *
 * 固定时钟:全部时间锚定 SCALE_FIXTURE_FIXED_NOW_MS(2026-11-04T12:05:00Z =
 * 2026-11-04 20:05 Asia/Shanghai,处于 20:00~20:30 档内 → 可断言「正在直播」)。
 * 注入方式与既有夹具一致:被测代码面向 Clock 接口取时,测试用
 * `createScaleFixtureClock()`(= createManualClock({ startMs: SCALE_FIXTURE_FIXED_NOW_MS }))注入;
 * 需要真实时间的组件在故事任务里另行注入。
 *
 * 结构与代际:DDL 全部来自权威迁移(src/database/migrations,默认全量应用),
 * 生成器不自带建表语句。profile.is_main / source_entry.group_title /
 * media_item.content_revision 等代际 2 列(0006_pc_experience,T006)存在时自动写入,
 * 缺失时跳过对应列,保证夹具在两代库上均可生成;stats.generation2Columns 报告实际写入情况。
 *
 * 可用性语义(与 004/005 投影约定一致,schema 无独立可用性列):
 *   available   = 存在 present=1 的 source_entry(频道/点播同口径);
 *   unavailable = 条目 present=0 且 missing_since 非空(失效媒体,US1 摘要口径);
 *   孤立媒体    = 无任何条目的 media_item(完全不可见)。
 */

/* ------------------------------------------------------------------ */
/* 固定时钟与排期窗口                                                   */
/* ------------------------------------------------------------------ */

/** 固定 nowMs:2026-11-04T12:05:00.000Z = 2026-11-04 20:05(Asia/Shanghai),
 *  落在 20:00~20:30 直播档内 5 分钟处(非档边界),便于「正在直播」断言。 */
export const SCALE_FIXTURE_FIXED_NOW_MS = Date.UTC(2026, 10, 4, 12, 5, 0);

/** 夹具家庭时区(homeMedia 域默认;无 DST,日界恒为 UTC+8) */
export const SCALE_FIXTURE_TIMEZONE = 'Asia/Shanghai';

const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 排期窗口:以固定 now 所在日为准的 7 个 Asia/Shanghai 日历日
 *  ([2026-11-04 00:00 CST, 2026-11-11 00:00 CST) = UTC [2026-11-03T16:00Z, 2026-11-10T16:00Z)),
 *  与 guide 契约「今天~today+6」对齐;now 在第 0 天。 */
export const SCHEDULE_WINDOW_START_UTC_MS =
  Math.floor((SCALE_FIXTURE_FIXED_NOW_MS + SHANGHAI_OFFSET_MS) / 86_400_000) * 86_400_000 - SHANGHAI_OFFSET_MS;
export const SCHEDULE_WINDOW_DAYS = 7;
export const SCHEDULE_WINDOW_END_UTC_MS = SCHEDULE_WINDOW_START_UTC_MS + SCHEDULE_WINDOW_DAYS * 86_400_000;

/** 每天档位数(30 分钟一档 × 48 = 24 小时) */
export const SLOTS_PER_DAY = 48;
const SLOT_MS = 1_800_000;

/** 第 day 天第 slot 档的 [startMs, endMs)(day/slot 越界由调用方约束;纯函数供测试反推) */
export function scheduleSlotUtcMs(day: number, slot: number): { startMs: number; endMs: number } {
  const startMs = SCHEDULE_WINDOW_START_UTC_MS + day * 86_400_000 + slot * SLOT_MS;
  return { startMs, endMs: startMs + SLOT_MS };
}

/** 固定 now 落在的直播档:第 0 天第 40 档(20:00~20:30 CST) */
export const SCALE_FIXTURE_LIVE_SLOT = (() => {
  const localMs = SCALE_FIXTURE_FIXED_NOW_MS + SHANGHAI_OFFSET_MS;
  const dayIndex = Math.floor((localMs - SCHEDULE_WINDOW_START_UTC_MS - SHANGHAI_OFFSET_MS) / 86_400_000);
  const minuteOfDay = Math.floor((localMs % 86_400_000) / 60_000);
  return {
    dayIndex,
    slotIndex: Math.floor(minuteOfDay / 30),
    startsAtUtc: new Date(scheduleSlotUtcMs(dayIndex, Math.floor(minuteOfDay / 30)).startMs).toISOString(),
    endsAtUtc: new Date(scheduleSlotUtcMs(dayIndex, Math.floor(minuteOfDay / 30)).endMs).toISOString(),
  } as const;
})();

/** 固定时钟注入工具(与 fixtures/clock.ts 的 ManualClock 同一实现) */
export function createScaleFixtureClock(): ManualClock {
  return createManualClock({ startMs: SCALE_FIXTURE_FIXED_NOW_MS });
}

/* ------------------------------------------------------------------ */
/* 规模与覆盖预算(表头账,种入后 seed 内断言总账)                        */
/* ------------------------------------------------------------------ */

/** 频道媒体总数(media_item type='channel') */
export const CHANNEL_TOTAL = 200;
/** 无 EPG 频道(1 起编频道号;无 epg_channel/programme 行,仍可播放) */
export const CHANNELS_WITHOUT_EPG = [197, 198, 199, 200] as const;
/** 不可用频道:有 EPG 数据但 source_entry present=0(可用性变化样本) */
export const CHANNEL_UNAVAILABLE_NO = 15;
/** 仅主源不可用频道:主源条目 present=0,备用源条目顶上(多来源可用性/分组回落样本) */
export const MAIN_SOURCE_UNAVAILABLE_CHANNEL_NO = 8;
/** 空档频道:每天 02:00~04:00(CST,档 8~11)无节目 */
export const CHANNEL_GAP_NO = 20;
export const GAP_SLOTS = [8, 9, 10, 11] as const;
/** 重叠节目频道(1~14):每天 14 条与栅格部分重叠的额外节目 */
export const OVERLAP_CHANNEL_RANGE = [1, 14] as const;
/** 每重叠频道每天额外节目数(14 条/天 × 7 天 = 每频道 98 条) */
export const EXTRAS_PER_CHANNEL_PER_DAY = 14;

/** 点播媒体总数 */
export const VOD_TOTAL = 500;
/** 可用点播(1~480):present 条目 + playback_source */
export const VOD_AVAILABLE_COUNT = 480;
/** 失效点播(481~492):present=0 + missing_since(availability 变化样本) */
export const VOD_UNAVAILABLE_COUNT = 12;
/** 孤立点播(493~500):无任何条目 */
export const VOD_ORPHAN_COUNT = 8;

/** 目标排期总数:196 频道 × 7 天 × 48 档 − 空档 4×7 + 重叠 14 频道 × 14 × 7 = 67,200 */
export const EXPECTED_PROGRAMME_TOTAL = 67_200;

/** EPG 栅格频道数(200 − 4 无 EPG) */
export const EPG_CHANNEL_COUNT = CHANNEL_TOTAL - CHANNELS_WITHOUT_EPG.length;

/* ------------------------------------------------------------------ */
/* 固定标识与凭据(全部确定性,库中只存哈希)                              */
/* ------------------------------------------------------------------ */

/** 全部行主键(确定性;测试可直接引用) */
export const SCALE_FIXTURE_IDS = {
  householdId: 'fx-household',
  accountId: 'fx-account-owner',
  /** 主成人档案(0006 落地后 is_main=1) */
  mainProfileId: 'fx-profile-main',
  /** 儿童档案(max_content_level=6 策略) */
  childProfileId: 'fx-profile-child',
  deviceId: 'fx-device-pc-1',
  deviceSessionId: 'fx-session-1',
  /** IPTV 主源(源 id 字典序在备用源之前 → 多分组按 (source_id, entry_id) 升序取主源分组) */
  iptvMainSourceId: 'fx-src-a-iptv-main',
  /** IPTV 备用源(仅频道 5~10 有条目,分组名不同) */
  iptvAltSourceId: 'fx-src-b-iptv-alt',
  epgSourceId: 'fx-src-a-epg-xmltv',
  nasSourceId: 'fx-src-a-nas-vod',
} as const;

/** 明文凭据(仅夹具句柄/文档持有;库中只有 argon2id/sha256 哈希) */
export const SCALE_FIXTURE_CREDENTIALS = {
  username: 'fixtureadmin',
  password: 'password-123',
  /** 主档案 PIN(6 位数字) */
  mainPin: '135790',
  /** 儿童档案 PIN(6 位数字) */
  childPin: '246800',
  /** 设备会话明文令牌(Cookie hmp_session=… 或 Bearer) */
  sessionToken: 'fx-scale-session-token',
} as const;

/** xmltv 频道 id / 媒体 id 等命名约定 */
export function scaleChannelMediaId(channelNo: number): string {
  return `fx-ch-${String(channelNo).padStart(3, '0')}`;
}
export function scaleXmltvChannelId(channelNo: number): string {
  return `fx-xmltv-${String(channelNo).padStart(3, '0')}`;
}
export function scaleVodMediaId(vodNo: number): string {
  return `fx-vod-${String(vodNo).padStart(3, '0')}`;
}
export function scaleChannelStreamUrl(channelNo: number): string {
  return `http://iptv.scale-fixture.test/stream/${scaleChannelMediaId(channelNo)}.m3u8`;
}
export function scaleVodPath(vodNo: number): string {
  return `/nas-media/${scaleVodMediaId(vodNo)}.mp4`;
}

/** 身份行等元数据的安装时刻(早于排期窗口,确定性) */
const INSTALLED_AT_MS = SCHEDULE_WINDOW_START_UTC_MS - 3_600_000;
const INSTALLED_AT = new Date(INSTALLED_AT_MS).toISOString();
/** 会话过期(远未来,与 playback 夹具同惯例) */
const SESSION_EXPIRES_AT = '2027-01-01T00:00:00.000Z';
/** 失效条目的 missing_since(可用性变化时间戳) */
const MISSING_SINCE = INSTALLED_AT;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/* ------------------------------------------------------------------ */
/* 统计                                                                 */
/* ------------------------------------------------------------------ */

export interface ScaleFixtureStats {
  readonly household: number;
  readonly account: number;
  readonly profile: number;
  readonly device: number;
  readonly deviceSession: number;
  readonly mediaSource: number;
  readonly sourceRefresh: number;
  readonly mediaItemChannel: number;
  readonly mediaItemVod: number;
  readonly sourceEntryIptvMain: number;
  readonly sourceEntryIptvAlt: number;
  readonly sourceEntryNas: number;
  readonly epgChannel: number;
  readonly epgProgrammeGrid: number;
  readonly epgProgrammeExtra: number;
  readonly epgProgrammeTotal: number;
  readonly playbackSource: number;
  readonly profilePolicy: number;
  readonly catalogState: number;
  /** 0006(T006)列存在时为 true = 已写入对应代际 2 数据 */
  readonly generation2Columns: {
    readonly profileIsMain: boolean;
    readonly sourceEntryGroupTitle: boolean;
    readonly mediaItemContentRevision: boolean;
  };
  readonly facts: {
    readonly channelsWithoutEpg: number;
    readonly unavailableChannels: number;
    readonly vodAvailable: number;
    readonly vodUnavailable: number;
    readonly vodOrphan: number;
    /** 跨日节目(每天一条,23:45~次日 00:15 CST,频道 2) */
    readonly crossDayProgrammes: number;
    /** 与固定 now 相交的重叠「正在直播」样本(频道 1 每天 20:02~21:02 CST) */
    readonly liveOverlapProgrammes: number;
    readonly liveSlot: typeof SCALE_FIXTURE_LIVE_SLOT;
    readonly scheduleWindowStartUtc: string;
    readonly scheduleWindowEndUtc: string;
    readonly fixedNowIso: string;
  };
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

type Conn = DatabaseConstructor.Database;

function hasColumn(conn: Conn, table: string, column: string): boolean {
  return (conn.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);
}

function migrationsDir(): string {
  return path.join(process.cwd(), 'src/database/migrations');
}

/** 应用全部权威迁移 up.sql(与 test/helpers.ts 同语义;独立实现避免 helpers↔fixtures 循环引用) */
function applyAllMigrations(conn: Conn): void {
  const names = fs
    .readdirSync(migrationsDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  conn.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
  );
  const insert = conn.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const name of names) {
    const upSqlPath = path.join(migrationsDir(), name, 'up.sql');
    if (!fs.existsSync(upSqlPath)) {
      throw new Error(
        `未找到迁移 DDL ${upSqlPath} —— 本夹具须以 apps/server 为工作目录运行(pnpm --filter @hmp/server …)`,
      );
    }
    conn.exec(fs.readFileSync(upSqlPath, 'utf8'));
    insert.run(name, INSTALLED_AT);
  }
}

/** 节目标题池(确定性轮换;可作 q 搜索样本) */
const PROGRAMME_TITLE_POOL = [
  '晨间新闻', '早间剧场', '午间新闻', '午后剧场',
  '儿童动画', '生活服务', '体育赛事', '纪录片场',
  '黄金剧场', '晚间新闻', '午夜剧场', '音乐现场',
  '科技前沿', '财经纵横', '天气预报', '法治在线',
] as const;

/** 主源分组轮换(多分组 group_title 样本;频道号 1 起编,按 6 取模轮换) */
const MAIN_GROUPS = ['央视', '卫视', '影视', '体育', '纪录', '少儿'] as const;
/** 备用源分组(与主源不同,验证「取第一个有效分组」忽略备用) */
const ALT_GROUPS = ['备用·影视', '备用·体育', '备用·纪录'] as const;

function mainGroupOf(channelNo: number): string {
  if (CHANNELS_WITHOUT_EPG.includes(channelNo as (typeof CHANNELS_WITHOUT_EPG)[number])) {
    return '其他';
  }
  return MAIN_GROUPS[(channelNo - 1) % MAIN_GROUPS.length] ?? '央视';
}

/** 栅格节目单条构造(空档由调用方跳过档位) */
function gridProgrammeRow(channelNo: number, day: number, slot: number): {
  id: string; title: string; description: string | null; startsAt: string; endsAt: string;
} {
  const { startMs, endMs } = scheduleSlotUtcMs(day, slot);
  const hhmm = new Date(startMs + SHANGHAI_OFFSET_MS).toISOString().slice(11, 16);
  const title = `${PROGRAMME_TITLE_POOL[(slot + day + channelNo) % PROGRAMME_TITLE_POOL.length] ?? '晚间新闻'} ${hhmm}`;
  return {
    id: `fx-prog-c${String(channelNo).padStart(3, '0')}-d${day}-s${String(slot).padStart(2, '0')}`,
    title,
    description: slot % 4 === 0 ? `频道 ${channelNo} 第 ${day + 1} 天第 ${slot} 档(规模夹具)` : null,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
  };
}

/**
 * 重叠节目构造:每频道每天 14 条。
 * - k=0~12(13 条):起点 = 档(3k+1) 开始后 +10 分钟,时长 40 分钟(与两档栅格部分重叠);
 * - k=13:频道 1 为「正在直播」重叠样本(每天 20:02~21:02 CST,与固定 now 相交且
 *   startsAt 晚于 20:00 栅格 → 可断言「重叠取 startsAt 最近」);其余频道为
 *   19:40~20:20(同样压住黄金档)。频道 2 的 k=0 改为跨日样本(23:45~次日 00:15)。
 */
function extraProgrammeRow(channelNo: number, day: number, k: number): {
  id: string; title: string; description: string; startsAt: string; endsAt: string; kind: 'overlap' | 'cross-day';
} {
  const dayStartMs = SCHEDULE_WINDOW_START_UTC_MS + day * 86_400_000;
  let startMs: number;
  let durationMs: number;
  let kind: 'overlap' | 'cross-day';
  if (channelNo === 2 && k === 0) {
    kind = 'cross-day';
    startMs = dayStartMs + ((23 * 60 + 45) * 60_000);
    durationMs = 30 * 60_000;
  } else if (k === 13 && channelNo === 1) {
    kind = 'overlap';
    startMs = dayStartMs + ((20 * 60 + 2) * 60_000);
    durationMs = 60 * 60_000;
  } else {
    kind = 'overlap';
    if (k === 13) {
      startMs = dayStartMs + ((19 * 60 + 40) * 60_000);
      durationMs = 40 * 60_000;
    } else {
      startMs = dayStartMs + ((3 * k + 1) * SLOT_MS) + 10 * 60_000;
      durationMs = 40 * 60_000;
    }
  }
  const hhmm = new Date(startMs + SHANGHAI_OFFSET_MS).toISOString().slice(11, 16);
  const label = kind === 'cross-day' ? '跨日特别节目' : '加播特别报道';
  return {
    id: `fx-prog-c${String(channelNo).padStart(3, '0')}-d${day}-x${k}`,
    title: `${label} ${hhmm}`,
    description: `频道 ${channelNo} 第 ${day + 1} 天${kind === 'cross-day' ? '跨日' : '重叠'}样本(规模夹具)`,
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + durationMs).toISOString(),
    kind,
  };
}

/* ------------------------------------------------------------------ */
/* 种子入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 在「已应用全部迁移且业务表为空」的库连接上种入规模夹具(单事务,同步;
 * 异步仅因 argon2id 真哈希须先于事务完成 —— 与 playback 夹具同惯例)。
 * 返回逐表行数与覆盖事实;排期总数 ≠ 67,200 时抛错(总账自检)。
 */
export async function seedScaleFixture(conn: Conn): Promise<ScaleFixtureStats> {
  const existing = conn.prepare('SELECT COUNT(*) AS n FROM media_item').get() as { n: number };
  if (existing.n > 0) {
    throw new Error(`scale fixture 要求空业务库,media_item 已有 ${existing.n} 行;请改用全新临时库`);
  }

  const {
    householdId, accountId, mainProfileId, childProfileId, deviceId, deviceSessionId,
    iptvMainSourceId, iptvAltSourceId, epgSourceId, nasSourceId,
  } = SCALE_FIXTURE_IDS;
  const { username, password, mainPin, childPin, sessionToken } = SCALE_FIXTURE_CREDENTIALS;

  // 昂贵操作先算(事务外):argon2id 真哈希,供 US4 登录/PIN 类用例直接复用
  const [passwordHash, mainPinHash, childPinHash] = await Promise.all([
    hashPassword(password),
    hashPassword(mainPin),
    hashPassword(childPin),
  ]);

  // 代际 2 条件列(0006 缺席时跳过对应写入)
  const g2ProfileIsMain = hasColumn(conn, 'profile', 'is_main');
  const g2GroupTitle = hasColumn(conn, 'source_entry', 'group_title');
  const g2ContentRevision = hasColumn(conn, 'media_item', 'content_revision');

  const insertHousehold = conn.prepare(
    'INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const insertAccount = conn.prepare(
    'INSERT INTO account (id, household_id, username, username_normalized, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const insertProfile = g2ProfileIsMain
    ? conn.prepare(
        'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at, is_main) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)',
      )
    : conn.prepare(
        'INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status, failed_pin_count, pin_locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)',
      );
  const insertDevice = conn.prepare(
    'INSERT INTO device (id, household_id, name, type, last_seen_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
  );
  const insertDeviceSession = conn.prepare(
    'INSERT INTO device_session (id, household_id, account_id, device_id, token_hash, active_profile_id, expires_at, revoked_at, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
  );
  const insertMediaSource = conn.prepare(
    `INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory,
       private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  );
  const insertSourceRefresh = conn.prepare(
    `INSERT INTO source_refresh (id, household_id, source_id, initiator_account_id, initiator_session_id,
       operation_key, status, version, source_version, baseline_revision, snapshot_digest, item_count,
       summary_json, error_code, created_at, started_at, finished_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'succeeded', 1, 1, 1, NULL, ?, NULL, NULL, ?, ?, ?, NULL)`,
  );
  const insertChannelMedia = conn.prepare(
    `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
       title_overridden, type_overridden, version, created_at, updated_at)
     VALUES (?, ?, 'channel', ?, ?, NULL, ?, 0, 0, 1, ?, ?)`,
  );
  const insertVodMedia = g2ContentRevision
    ? conn.prepare(
        `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
           title_overridden, type_overridden, version, created_at, updated_at, content_revision)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?, ?)`,
      )
    : conn.prepare(
        `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
           title_overridden, type_overridden, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 0, 0, 1, ?, ?)`,
      );
  const insertSourceEntryBase = g2GroupTitle
    ? `INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id,
         upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since,
         file_size_text, file_mtime_ns, group_title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO source_entry (id, household_id, source_id, identity_kind, identity_digest, media_id,
         upstream_channel_id, present, last_seen_job_id, first_seen_at, last_seen_at, missing_since,
         file_size_text, file_mtime_ns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`;
  const insertSourceEntry = conn.prepare(insertSourceEntryBase);
  const insertPlaybackSource = conn.prepare(
    `INSERT INTO playback_source (id, household_id, source_id, source_entry_id, media_item_id,
       protocol, location, mime_type, priority, requires_proxy, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?)`,
  );
  const insertEpgChannel = conn.prepare(
    'INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, 0)',
  );
  const insertProgramme = conn.prepare(
    'INSERT INTO epg_programme (id, household_id, source_id, xmltv_channel_id, title, description, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insertProfilePolicy = conn.prepare(
    `INSERT INTO profile_policy (household_id, profile_id, max_content_level, allow_unrated,
       allowed_media_ids, blocked_media_ids, allowed_channel_ids, version, updated_at)
     VALUES (?, ?, ?, ?, '[]', '[]', '[]', 1, ?)`,
  );
  const insertCatalogState = conn.prepare(
    'INSERT INTO catalog_state (household_id, revision) VALUES (?, 1)',
  );

  const run = conn.transaction(() => {
    /* ---- 身份:一家庭一 owner 账号,主成人 + 儿童双档案,一台 PC 设备与有效会话 ---- */
    insertHousehold.run(householdId, '规模夹具家庭', 'zh-CN', SCALE_FIXTURE_TIMEZONE, INSTALLED_AT);
    insertAccount.run(accountId, householdId, username, username, passwordHash, 'owner', INSTALLED_AT);
    // 主成人档案:adult/active/pin_hash 非空,满足 0006 主档案 CHECK;0006 在场时 is_main=1
    if (g2ProfileIsMain) {
      insertProfile.run(mainProfileId, householdId, accountId, '主档案', null, 'adult', 1, mainPinHash, 'active', INSTALLED_AT, 1);
    } else {
      insertProfile.run(mainProfileId, householdId, accountId, '主档案', null, 'adult', 1, mainPinHash, 'active', INSTALLED_AT);
    }
    // 儿童档案:content_level≤6 策略样本(quickstart §1「主成人 + 儿童」)
    if (g2ProfileIsMain) {
      insertProfile.run(childProfileId, householdId, accountId, '儿童档案', null, 'child', 0, childPinHash, 'active', INSTALLED_AT, 0);
    } else {
      insertProfile.run(childProfileId, householdId, accountId, '儿童档案', null, 'child', 0, childPinHash, 'active', INSTALLED_AT);
    }
    insertDevice.run(deviceId, householdId, '夹具 PC 浏览器', 'web', INSTALLED_AT, INSTALLED_AT);
    insertDeviceSession.run(
      deviceSessionId, householdId, accountId, deviceId,
      hashToken(sessionToken), mainProfileId, SESSION_EXPIRES_AT, INSTALLED_AT, INSTALLED_AT,
    );

    /* ---- 来源:主/备 IPTV + EPG + NAS(全部启用;IPTV 绑定 EPG 源) ----
       last_job_id 引用 source_refresh,而 source_refresh 又引用 media_source,
       故先以 NULL 落源行,导入痕迹插完后再回填(foreign_keys=ON 即时校验)。 */
    insertMediaSource.run(
      epgSourceId, householdId, 'epg', '夹具 XMLTV',
      'http://epg.scale-fixture.test/xmltv.xml', null, null, 1, null, 1,
      null, null, INSTALLED_AT, INSTALLED_AT,
    );
    insertMediaSource.run(
      iptvMainSourceId, householdId, 'iptv', '夹具 IPTV 主源',
      'http://iptv.scale-fixture.test/list.m3u8', null, null, 1, epgSourceId, 1,
      null, null, INSTALLED_AT, INSTALLED_AT,
    );
    insertMediaSource.run(
      iptvAltSourceId, householdId, 'iptv', '夹具 IPTV 备用源',
      'http://iptv.scale-fixture.test/alt.m3u8', null, null, 1, epgSourceId, 1,
      null, null, INSTALLED_AT, INSTALLED_AT,
    );
    insertMediaSource.run(
      nasSourceId, householdId, 'nas', '夹具 NAS 影库',
      null, 'fixture-vod', 'media', 1, null, 1,
      null, null, INSTALLED_AT, INSTALLED_AT,
    );

    /* ---- 导入任务痕迹(来源「已成功发布」状态) ---- */
    insertSourceRefresh.run(
      `fx-refresh-${iptvMainSourceId}`, householdId, iptvMainSourceId, accountId, deviceSessionId,
      'fx-op-iptv-main', CHANNEL_TOTAL, INSTALLED_AT, INSTALLED_AT, INSTALLED_AT,
    );
    insertSourceRefresh.run(
      `fx-refresh-${iptvAltSourceId}`, householdId, iptvAltSourceId, accountId, deviceSessionId,
      'fx-op-iptv-alt', 6, INSTALLED_AT, INSTALLED_AT, INSTALLED_AT,
    );
    insertSourceRefresh.run(
      `fx-refresh-${epgSourceId}`, householdId, epgSourceId, accountId, deviceSessionId,
      'fx-op-epg', EPG_CHANNEL_COUNT, INSTALLED_AT, INSTALLED_AT, INSTALLED_AT,
    );
    insertSourceRefresh.run(
      `fx-refresh-${nasSourceId}`, householdId, nasSourceId, accountId, deviceSessionId,
      'fx-op-nas', VOD_AVAILABLE_COUNT + VOD_UNAVAILABLE_COUNT, INSTALLED_AT, INSTALLED_AT, INSTALLED_AT,
    );

    // 回填来源「最近成功任务」(FK 顺序:source_refresh 先于 media_source.last_job_id)
    const linkSourceRefresh = conn.prepare(
      'UPDATE media_source SET last_success_at = ?, last_job_id = ? WHERE household_id = ? AND id = ?',
    );
    for (const sourceId of [iptvMainSourceId, iptvAltSourceId, epgSourceId, nasSourceId]) {
      linkSourceRefresh.run(INSTALLED_AT, `fx-refresh-${sourceId}`, householdId, sourceId);
    }

    /* ---- 频道媒体 + 主源条目 + 播放资源(200 频道;15 号不可用) ---- */
    const iptvEntry = g2GroupTitle
      ? (id: string, sourceId: string, mediaId: string, upstream: string, present: number, group: string | null) =>
          insertSourceEntry.run(
            id, householdId, sourceId, 'url', sha256Hex(`${sourceId}:${upstream}`), mediaId, upstream,
            present, INSTALLED_AT, INSTALLED_AT, present === 1 ? null : MISSING_SINCE, null, null, group,
          )
      : (id: string, sourceId: string, mediaId: string, upstream: string, present: number) =>
          insertSourceEntry.run(
            id, householdId, sourceId, 'url', sha256Hex(`${sourceId}:${upstream}`), mediaId, upstream,
            present, INSTALLED_AT, INSTALLED_AT, present === 1 ? null : MISSING_SINCE, null, null,
          );
    const channelLevels = [0, 6, 12, 18, null, 3, 16, null] as const;
    for (let channelNo = 1; channelNo <= CHANNEL_TOTAL; channelNo += 1) {
      const mediaId = scaleChannelMediaId(channelNo);
      insertChannelMedia.run(
        mediaId, householdId,
        `夹具频道 ${String(channelNo).padStart(3, '0')}`,
        channelNo <= 3 ? `夹具频道 ${String(channelNo).padStart(3, '0')} 的频道简介(规模夹具)` : null,
        channelLevels[channelNo % channelLevels.length] ?? null,
        INSTALLED_AT, INSTALLED_AT,
      );
      // 15 号整体不可用;8 号仅主源不可用(备用源顶上 → 可用性/分组「取第一个 present」样本)
      const unavailable =
        channelNo === CHANNEL_UNAVAILABLE_NO || channelNo === MAIN_SOURCE_UNAVAILABLE_CHANNEL_NO;
      iptvEntry(
        `fx-ent-main-ch-${String(channelNo).padStart(3, '0')}`,
        iptvMainSourceId, mediaId, scaleXmltvChannelId(channelNo), unavailable ? 0 : 1,
        // 频道 7 主源分组为空 → 多分组选择回落到备用源(0006 在场时)
        channelNo === 7 && g2GroupTitle ? null : mainGroupOf(channelNo),
      );
      if (!unavailable) {
        insertPlaybackSource.run(
          `fx-ps-${mediaId}`, householdId, iptvMainSourceId,
          `fx-ent-main-ch-${String(channelNo).padStart(3, '0')}`, mediaId,
          'http', scaleChannelStreamUrl(channelNo), null, 1, INSTALLED_AT, INSTALLED_AT,
        );
      }
    }
    // 备用源条目:频道 5~10(分组不同;频道 8 主源不可用 → 备用条目顶上并携带播放资源)
    for (let channelNo = 5; channelNo <= 10; channelNo += 1) {
      iptvEntry(
        `fx-ent-alt-ch-${String(channelNo).padStart(3, '0')}`,
        iptvAltSourceId, scaleChannelMediaId(channelNo), scaleXmltvChannelId(channelNo), 1,
        ALT_GROUPS[(channelNo - 5) % ALT_GROUPS.length] ?? '备用·影视',
      );
      if (channelNo === MAIN_SOURCE_UNAVAILABLE_CHANNEL_NO) {
        insertPlaybackSource.run(
          `fx-ps-alt-${scaleChannelMediaId(channelNo)}`, householdId, iptvAltSourceId,
          `fx-ent-alt-ch-${String(channelNo).padStart(3, '0')}`, scaleChannelMediaId(channelNo),
          'http', `http://iptv.scale-fixture.test/alt/${scaleChannelMediaId(channelNo)}.m3u8`,
          null, 1, INSTALLED_AT, INSTALLED_AT,
        );
      }
    }

    /* ---- 点播媒体 + NAS 条目 + 播放资源(500:480 可用 / 12 失效 / 8 孤立) ---- */
    const vodLevel = (vodNo: number): number | null =>
      [0, 6, 12, 18, null, 3, 16, null][vodNo % 8] ?? null;
    const vodType = (vodNo: number): 'movie' | 'series' | 'episode' | 'video' => {
      if (vodNo <= 300) return 'movie';
      if (vodNo <= 360) return 'series';
      if (vodNo <= 480) return 'episode';
      return 'video';
    };
    const nasEntry = g2GroupTitle
      ? (id: string, mediaId: string, present: number) =>
          insertSourceEntry.run(
            id, householdId, nasSourceId, 'path', sha256Hex(`${nasSourceId}:${mediaId}`), mediaId, null,
            present, INSTALLED_AT, INSTALLED_AT, present === 1 ? null : MISSING_SINCE,
            present === 1 ? '1073741824' : null, present === 1 ? '1735689600000000000' : null, null,
          )
      : (id: string, mediaId: string, present: number) =>
          insertSourceEntry.run(
            id, householdId, nasSourceId, 'path', sha256Hex(`${nasSourceId}:${mediaId}`), mediaId, null,
            present, INSTALLED_AT, INSTALLED_AT, present === 1 ? null : MISSING_SINCE,
            present === 1 ? '1073741824' : null, present === 1 ? '1735689600000000000' : null,
          );
    for (let vodNo = 1; vodNo <= VOD_TOTAL; vodNo += 1) {
      const mediaId = scaleVodMediaId(vodNo);
      const kind = vodType(vodNo);
      const title =
        vodNo === 1 ? '夹具影片 001(修订样本)' : `夹具影片 ${String(vodNo).padStart(3, '0')}`;
      // 内容修订样本:0006 在场时 vod-001 content_revision=2(进度按修订失效的断言锚点)
      const contentRevision = vodNo === 1 ? 2 : 1;
      if (g2ContentRevision) {
        insertVodMedia.run(
          mediaId, householdId, kind, title,
          kind === 'movie' ? `夹具影片 ${vodNo} 的简介(规模夹具)` : null,
          vodLevel(vodNo), INSTALLED_AT, INSTALLED_AT, contentRevision,
        );
      } else {
        insertVodMedia.run(
          mediaId, householdId, kind, title,
          kind === 'movie' ? `夹具影片 ${vodNo} 的简介(规模夹具)` : null,
          vodLevel(vodNo), INSTALLED_AT, INSTALLED_AT,
        );
      }
      if (vodNo <= VOD_AVAILABLE_COUNT) {
        const entryId = `fx-ent-nas-${String(vodNo).padStart(3, '0')}`;
        nasEntry(entryId, mediaId, 1);
        insertPlaybackSource.run(
          `fx-ps-${mediaId}`, householdId, nasSourceId, entryId, mediaId,
          'file', scaleVodPath(vodNo), 'video/mp4', 0, INSTALLED_AT, INSTALLED_AT,
        );
      } else if (vodNo <= VOD_AVAILABLE_COUNT + VOD_UNAVAILABLE_COUNT) {
        nasEntry(`fx-ent-nas-${String(vodNo).padStart(3, '0')}`, mediaId, 0);
      }
      // 孤立点播(493~500):无条目、无播放资源
    }

    /* ---- EPG:196 频道 × 7 天 × 48 档栅格 + 频道 1~14 重叠/跨日样本 ---- */
    const guideChannels: number[] = [];
    for (let channelNo = 1; channelNo <= CHANNEL_TOTAL; channelNo += 1) {
      if (!CHANNELS_WITHOUT_EPG.includes(channelNo as (typeof CHANNELS_WITHOUT_EPG)[number])) {
        guideChannels.push(channelNo);
      }
    }
    for (const channelNo of guideChannels) {
      insertEpgChannel.run(householdId, epgSourceId, scaleXmltvChannelId(channelNo), `夹具频道 ${String(channelNo).padStart(3, '0')}`);
    }
    let gridCount = 0;
    let extraOverlap = 0;
    let extraCrossDay = 0;
    for (const channelNo of guideChannels) {
      const xmltvId = scaleXmltvChannelId(channelNo);
      const isGapChannel = channelNo === CHANNEL_GAP_NO;
      for (let day = 0; day < SCHEDULE_WINDOW_DAYS; day += 1) {
        for (let slot = 0; slot < SLOTS_PER_DAY; slot += 1) {
          if (isGapChannel && (GAP_SLOTS as readonly number[]).includes(slot)) continue;
          const row = gridProgrammeRow(channelNo, day, slot);
          insertProgramme.run(row.id, householdId, epgSourceId, xmltvId, row.title, row.description, row.startsAt, row.endsAt);
          gridCount += 1;
        }
      }
    }
    const [overlapFrom, overlapTo] = OVERLAP_CHANNEL_RANGE;
    for (let channelNo = overlapFrom; channelNo <= overlapTo; channelNo += 1) {
      const xmltvId = scaleXmltvChannelId(channelNo);
      for (let day = 0; day < SCHEDULE_WINDOW_DAYS; day += 1) {
        for (let k = 0; k < EXTRAS_PER_CHANNEL_PER_DAY; k += 1) {
          const row = extraProgrammeRow(channelNo, day, k);
          insertProgramme.run(row.id, householdId, epgSourceId, xmltvId, row.title, row.description, row.startsAt, row.endsAt);
          if (row.kind === 'cross-day') extraCrossDay += 1; else extraOverlap += 1;
        }
      }
    }
    const epgProgrammeTotal = gridCount + extraOverlap + extraCrossDay;
    if (epgProgrammeTotal !== EXPECTED_PROGRAMME_TOTAL) {
      throw new Error(
        `排期总账不符:实际 ${epgProgrammeTotal} ≠ 预算 ${EXPECTED_PROGRAMME_TOTAL}(栅格 ${gridCount} + 重叠 ${extraOverlap} + 跨日 ${extraCrossDay})`,
      );
    }

    /* ---- 策略/目录版本:成人全量、儿童 ≤6;目录 revision=1 ---- */
    insertProfilePolicy.run(householdId, mainProfileId, 18, 1, INSTALLED_AT);
    insertProfilePolicy.run(householdId, childProfileId, 6, 0, INSTALLED_AT);
    insertCatalogState.run(householdId);

    const countOf = (table: string): number => (conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const countChannelType = (sql: string): number => (conn.prepare(sql).get() as { n: number }).n;
    const nasEntries = VOD_AVAILABLE_COUNT + VOD_UNAVAILABLE_COUNT;
    const mainEntries = CHANNEL_TOTAL;
    const altEntries = 6;
    return {
      household: countOf('household'),
      account: countOf('account'),
      profile: countOf('profile'),
      device: countOf('device'),
      deviceSession: countOf('device_session'),
      mediaSource: countOf('media_source'),
      sourceRefresh: countOf('source_refresh'),
      mediaItemChannel: countChannelType("SELECT COUNT(*) AS n FROM media_item WHERE type = 'channel'"),
      mediaItemVod: countChannelType("SELECT COUNT(*) AS n FROM media_item WHERE type <> 'channel'"),
      sourceEntryIptvMain: mainEntries,
      sourceEntryIptvAlt: altEntries,
      sourceEntryNas: nasEntries,
      epgChannel: countOf('epg_channel'),
      epgProgrammeGrid: gridCount,
      epgProgrammeExtra: extraOverlap + extraCrossDay,
      epgProgrammeTotal,
      playbackSource: countOf('playback_source'),
      profilePolicy: countOf('profile_policy'),
      catalogState: countOf('catalog_state'),
      generation2Columns: {
        profileIsMain: g2ProfileIsMain,
        sourceEntryGroupTitle: g2GroupTitle,
        mediaItemContentRevision: g2ContentRevision,
      },
      facts: {
        channelsWithoutEpg: CHANNELS_WITHOUT_EPG.length,
        unavailableChannels: 1,
        vodAvailable: VOD_AVAILABLE_COUNT,
        vodUnavailable: VOD_UNAVAILABLE_COUNT,
        vodOrphan: VOD_ORPHAN_COUNT,
        crossDayProgrammes: extraCrossDay,
        liveOverlapProgrammes: SCHEDULE_WINDOW_DAYS,
        liveSlot: SCALE_FIXTURE_LIVE_SLOT,
        scheduleWindowStartUtc: new Date(SCHEDULE_WINDOW_START_UTC_MS).toISOString(),
        scheduleWindowEndUtc: new Date(SCHEDULE_WINDOW_END_UTC_MS).toISOString(),
        fixedNowIso: new Date(SCALE_FIXTURE_FIXED_NOW_MS).toISOString(),
      },
    } satisfies ScaleFixtureStats;
  });

  return run();
}

/* ------------------------------------------------------------------ */
/* 独立建库(一步:迁移 + 种子;CLI 与 e2e 前置用)                        */
/* ------------------------------------------------------------------ */

export interface CreateScaleFixtureDatabaseOptions {
  /** 目标目录;缺省在 os.tmpdir 下新建 hmp-scale-fixture-* 随机目录 */
  readonly dir?: string;
  /** 库文件名;缺省 scale-fixture.hmp.db */
  readonly dbFilename?: string;
}

export interface ScaleFixtureLibrary {
  readonly dataDir: string;
  readonly dbFilename: string;
  readonly dbPath: string;
  readonly stats: ScaleFixtureStats;
}

/**
 * 全新独立临时库:应用全部权威迁移后种入规模夹具,收尾检查点 WAL 并关闭连接。
 * 复用 apps/server/src/database 的 Database 单例 + env override(与 test/helpers.ts 同方式);
 * 后续以 DATA_DIR=<返回的 dataDir> DB_FILENAME=<dbFilename> 启动服务即可消费。
 */
export async function createScaleFixtureDatabase(
  options: CreateScaleFixtureDatabaseOptions = {},
): Promise<ScaleFixtureLibrary> {
  const dataDir = options.dir
    ? path.resolve(options.dir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-scale-fixture-'));
  const dbFilename = options.dbFilename ?? 'scale-fixture.hmp.db';
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: dbFilename }));
  Database.close();
  const conn = Database.db;
  applyAllMigrations(conn);
  const stats = await seedScaleFixture(conn);
  conn.pragma('wal_checkpoint(TRUNCATE)');
  Database.close();
  return { dataDir, dbFilename, dbPath: path.join(dataDir, dbFilename), stats };
}
