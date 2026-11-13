import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { Vod } from '@hmp/shared';
import * as schema from '@platform/database/schema';
import type { Db } from '@platform/database/drizzle';
import { DomainError } from '@platform/http-common/domain-error';
import type { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { PublicCatalogService } from '@contexts/media-catalog/application/public-catalog.service';
import { bindMediaCatalogStore } from '@contexts/media-catalog/application/media-catalog-store.port';
import { drizzleMediaCatalogStore } from '@contexts/media-catalog/infrastructure/media-catalog-store.drizzle';
import { loadAvailableMediaIdSet, loadBatchCatalogContext } from '@contexts/policy';
import { bindPolicyStore } from '@contexts/policy/application/policy-store.port';
import { drizzlePolicyStore } from '@contexts/policy/infrastructure/policy-store.drizzle';

/**
 * T030(010-online-vod · US1)服务级单元:media-catalog 公共目录的 vod 父级投影 ——
 * - 真实内存库 DDL(0001–0007 权威迁移)+ 真实 store(drizzleMediaCatalogStore 绑定),
 *   PublicContextService 以桩注入(范围恒 hh-1;范围解析自身已有专项单元);
 * - D 组语义逐条钉住(api.md §2 / e2e online-vod-catalog D3–D5 同形):
 *   每页总计 100 子项、修订绑定 cursor(变化 409 VOD_DETAIL_CHANGED)、非父 400
 *   VOD_EPISODE_REQUIRED、父不可用/不存在/跨家庭 404 同形、sequenceOrdinal 映射
 *   (ordered 取 ordinal;ambiguous/special/缺序 null);
 * - 线路聚合语义:lineRef=vod_line.id 跨页稳定,线路可跨页重复,消费者按 lineRef 聚合;
 * - 公共列表/详情:NAS/IPTV(standalone)投影零变化(七键逐字对照 public-media-projection
 *   基线),vod 父项「已物化+可用」准入、子项不重复铺卡片、detailKind/parentMediaId 加字段;
 * - 父不进可播放候选集合:loadAvailableMediaIdSet/loadBatchCatalogContext 候选树=子项层;
 * - 分集页单查询守卫:prepare 语句数与子项规模/页码无关(禁 N+1)。
 * 全程内存库同步读取,不发任何网络请求。
 */

const NOW_ISO = '2026-01-01T00:00:00.000Z';
const FUTURE_ISO = '2099-01-01T00:00:00.000Z';
const HOUSEHOLD_ID = 'hh-1';

/** 010 StableEpisodes 契约形状(Vod 命名空间;与 e2e expectExactKeys 同表) */
type StableEpisodesDto = Vod.components['schemas']['StableEpisodes'];
type StableEpisodeLineDto = Vod.components['schemas']['StableEpisodeLine'];
type StableEpisodeItemDto = Vod.components['schemas']['StableEpisodeItem'];

const STABLE_EPISODES_KEYS = ['parentMediaId', 'detailRevision', 'fetchedAt', 'stale', 'lines', 'nextCursor'] as const;
const STABLE_EPISODE_LINE_KEYS = ['lineRef', 'name', 'episodes'] as const;
const STABLE_EPISODE_ITEM_KEYS = ['mediaId', 'label', 'availability', 'sequenceOrdinal'] as const;
/** 005 PublicMedia 白名单七键(NAS/IPTV 零变化基线;public-media-projection.spec 同表) */
const PUBLIC_MEDIA_KEYS = ['availability', 'contentLevel', 'description', 'id', 'posterRef', 'title', 'type'] as const;

/* ------------------------------------------------------------------ */
/* rig:真实 DDL(0001–0010)+ 真实 store + 桩范围                          */
/* ------------------------------------------------------------------ */

/* 016 收敛:补 0008~0010(代际 2 尾段增量表/列)。0010 的 media_source.priority NOT NULL
 * 列为 drizzle schema(mediaSource)插入形态所必需,缺列将令 seedSource 造数失败。 */
const MIGRATIONS = [
  '0001_init',
  '0002_profile_policy',
  '0003_media_catalog',
  '0004_manual_epg_binding',
  '0005_playback',
  '0006_pc_experience',
  '0007_online_vod',
  '0008_profile_preferences',
  '0009_channel_logos',
  '0010_multi_source_priority',
  '0011_channel_visibility',
  '0012_programme_posters',
  '0013_source_governance',
] as const;

const openConnections: DatabaseConstructor.Database[] = [];

afterEach(() => {
  while (openConnections.length > 0) {
    openConnections.pop()?.close();
  }
});

interface Rig {
  conn: DatabaseConstructor.Database;
  db: Db;
  service: PublicCatalogService;
}

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

function createRig(): Rig {
  const conn = new DatabaseConstructor(':memory:');
  conn.pragma('foreign_keys = ON');
  for (const name of MIGRATIONS) {
    conn.exec(migrationSql(name));
  }
  openConnections.push(conn);
  const db = drizzle(conn, { schema });
  bindMediaCatalogStore(drizzleMediaCatalogStore(db, conn));
  bindPolicyStore(drizzlePolicyStore(db));
  const service = new PublicCatalogService({
    requireScope: () => ({
      initialized: true,
      household: {
        householdId: HOUSEHOLD_ID,
        displayName: '单元之家',
        timezone: 'Asia/Shanghai',
        language: 'zh-CN',
      },
    }),
  } as unknown as PublicContextService);
  return { conn, db, service };
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/* ------------------------------------------------------------------ */
/* seed(工厂事实;对齐 e2e online-vod-catalog seedVodTitleWorld 数据形态)   */
/* ------------------------------------------------------------------ */

function seedIdentity(db: Db): void {
  const now = NOW_ISO;
  db.insert(schema.household)
    .values({ id: HOUSEHOLD_ID, name: '单元之家', defaultLanguage: 'zh-CN', timezone: 'Asia/Shanghai', createdAt: now })
    .run();
  db.insert(schema.account)
    .values({ id: 'acc-1', householdId: HOUSEHOLD_ID, username: 'admin', usernameNormalized: 'admin', passwordHash: 'unit-hash', role: 'owner', createdAt: now })
    .run();
  db.insert(schema.device)
    .values({ id: 'dev-1', householdId: HOUSEHOLD_ID, name: null, type: 'web', lastSeenAt: null, revokedAt: null, createdAt: now })
    .run();
  db.insert(schema.profile)
    .values({ id: 'prof-adult', householdId: HOUSEHOLD_ID, accountId: 'acc-1', name: '成人', avatar: null, type: 'adult', isDefault: 0, pinHash: null, status: 'active', failedPinCount: 0, pinLockedUntil: null, createdAt: now })
    .run();
  db.insert(schema.deviceSession)
    .values({ id: 'ses-adult', householdId: HOUSEHOLD_ID, accountId: 'acc-1', deviceId: 'dev-1', tokenHash: 'hash-adult', activeProfileId: 'prof-adult', expiresAt: FUTURE_ISO, revokedAt: null, lastActiveAt: now, createdAt: now })
    .run();
  db.insert(schema.profilePolicy)
    .values({ householdId: HOUSEHOLD_ID, profileId: 'prof-adult', maxContentLevel: 18, allowUnrated: 1, allowedMediaIds: '[]', blockedMediaIds: '[]', allowedChannelIds: '[]', version: 1, updatedAt: now })
    .run();
}

/** 启用来源行(kind:iptv/vod 必须 remoteUrl;nas 必须 rootKey+relativeDirectory);返回 sourceId */
function seedSource(db: Db, input: { id: string; kind: 'iptv' | 'vod' | 'nas'; enabled?: 0 | 1; remoteUrl?: string }): string {
  db.insert(schema.mediaSource)
    .values({
      id: input.id,
      householdId: HOUSEHOLD_ID,
      kind: input.kind,
      name: `夹具源-${input.id}`,
      remoteUrl: input.remoteUrl ?? null,
      rootKey: input.kind === 'nas' ? 'nas-root' : null,
      relativeDirectory: input.kind === 'nas' ? 'media' : null,
      enabled: input.enabled ?? 1,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })
    .run();
  return input.id;
}

/**
 * standalone(NAS/IPTV)可用链:media_item(media_role 缺省 standalone)+ source_entry
 * (present=1)+ playback_source(static locator)——既有可用性链的权威形态。
 */
function seedStandaloneChain(db: Db, input: { mediaId: string; sourceId: string; type: 'channel' | 'movie'; title: string; present?: 0 | 1 }): void {
  db.insert(schema.mediaItem)
    .values({ id: input.mediaId, householdId: HOUSEHOLD_ID, type: input.type, title: input.title, description: null, contentLevel: input.type === 'channel' ? 0 : 3, version: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO })
    .run();
  const entryId = `entry-${input.mediaId}`;
  db.insert(schema.sourceEntry)
    .values({
      id: entryId,
      householdId: HOUSEHOLD_ID,
      sourceId: input.sourceId,
      identityKind: input.type === 'channel' ? 'url' : 'path',
      identityDigest: sha256(`${input.sourceId}:${input.mediaId}`),
      mediaId: input.mediaId,
      present: input.present ?? 1,
      firstSeenAt: NOW_ISO,
      lastSeenAt: NOW_ISO,
    })
    .run();
  db.insert(schema.playbackSource)
    .values({
      id: `pb-${input.mediaId}`,
      householdId: HOUSEHOLD_ID,
      sourceId: input.sourceId,
      sourceEntryId: entryId,
      mediaItemId: input.mediaId,
      protocol: input.type === 'channel' ? 'http' : 'file',
      location: input.type === 'channel' ? 'http://unit-seed.example/stream.m3u8' : '/nas-media/unit.mp4',
      priority: 100,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    })
    .run();
}

interface WorldEpisodeSpec {
  episodeKey: string;
  label: string;
  /** 确定序列序号;undefined = 缺序列(不落 vod_episode_sequence 行 → sequenceOrdinal null) */
  ordinal?: number;
  status: 'ordered' | 'ambiguous' | 'special';
  /** 子项是否带可解析候选链(source_entry+playback_source online);缺省 false → unavailable */
  resolvable?: boolean;
}

interface WorldLineSpec {
  lineKey: string;
  displayName: string;
  sortOrder: number;
  episodes: WorldEpisodeSpec[];
}

interface SeededVodWorld {
  titleId: string;
  parentMediaId: string;
  lineIds: string[];
  episodeMediaIds: string[];
  detailRevision: number;
}

/** 已物化 vod 标题世界(公共目录身份链;无 source_entry/playback 行 → 父级链可浏览) */
function seedVodTitleWorld(db: Db, input: { sourceId: string; upstreamVodId: string; name: string; lines: WorldLineSpec[]; detailRevision?: number }): SeededVodWorld {
  const detailRevision = input.detailRevision ?? 1;
  const titleId = `vt-${input.upstreamVodId}`;
  const parentMediaId = `parent-${input.upstreamVodId}`;
  const lineIds: string[] = [];
  const episodeMediaIds: string[] = [];
  let relationSortOrder = 0;
  db.insert(schema.mediaItem)
    .values({ id: parentMediaId, householdId: HOUSEHOLD_ID, type: 'series', mediaRole: 'vod_title', title: input.name, description: null, contentLevel: 0, version: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO })
    .run();
  db.insert(schema.vodTitle)
    .values({ id: titleId, householdId: HOUSEHOLD_ID, sourceId: input.sourceId, upstreamVodId: input.upstreamVodId, parentMediaId, currentDetailRevision: detailRevision, materializedAt: NOW_ISO })
    .run();
  db.insert(schema.vodDetailSnapshot)
    .values({ householdId: HOUSEHOLD_ID, titleId, revision: detailRevision, locatorRevision: 1, validatedPrivatePayload: JSON.stringify({ fixture: input.upstreamVodId }), fetchedAt: NOW_ISO, expiresAt: FUTURE_ISO })
    .run();
  for (const line of input.lines) {
    const lineId = `vl-${input.upstreamVodId}-${line.lineKey}`;
    lineIds.push(lineId);
    db.insert(schema.vodLine)
      .values({ id: lineId, householdId: HOUSEHOLD_ID, titleId, lineKey: line.lineKey, displayName: line.displayName, sortOrder: line.sortOrder })
      .run();
    for (const episode of line.episodes) {
      const episodeRowId = `ve-${input.upstreamVodId}-${line.lineKey}-${episode.episodeKey}`;
      const childMediaId = `media-${input.upstreamVodId}-${line.lineKey}-${episode.episodeKey}`;
      episodeMediaIds.push(childMediaId);
      db.insert(schema.mediaItem)
        .values({ id: childMediaId, householdId: HOUSEHOLD_ID, type: 'episode', mediaRole: 'vod_episode', title: episode.label, description: null, contentLevel: 0, version: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO })
        .run();
      relationSortOrder += 1;
      db.insert(schema.mediaRelation)
        .values({ householdId: HOUSEHOLD_ID, parentId: parentMediaId, childId: childMediaId, kind: 'vod_episode', sortOrder: relationSortOrder })
        .run();
      db.insert(schema.vodEpisode)
        .values({ id: episodeRowId, householdId: HOUSEHOLD_ID, lineId, episodeKey: episode.episodeKey, label: episode.label, mediaId: childMediaId, contentVersionState: 'unverified' })
        .run();
      if (episode.ordinal !== undefined) {
        db.insert(schema.vodEpisodeSequence)
          .values({ householdId: HOUSEHOLD_ID, titleId, lineId, detailRevision, sequenceRevision: 1, episodeId: episodeRowId, seasonKey: 'S01', ordinal: episode.ordinal, sequenceStatus: episode.status })
          .run();
      }
      if (episode.resolvable === true) {
        const entryId = `entry-${childMediaId}`;
        db.insert(schema.sourceEntry)
          .values({ id: entryId, householdId: HOUSEHOLD_ID, sourceId: input.sourceId, identityKind: 'vod_episode', identityDigest: sha256(`${input.sourceId}:${line.lineKey}:${episode.episodeKey}`), mediaId: childMediaId, present: 1, firstSeenAt: NOW_ISO, lastSeenAt: NOW_ISO })
          .run();
        db.insert(schema.playbackSource)
          .values({ id: `pb-${childMediaId}`, householdId: HOUSEHOLD_ID, sourceId: input.sourceId, sourceEntryId: entryId, mediaItemId: childMediaId, protocol: 'hls', location: null, locatorKind: 'online', vodEpisodeId: episodeRowId, requiresProxy: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO })
          .run();
      }
    }
  }
  return { titleId, parentMediaId, lineIds, episodeMediaIds, detailRevision };
}

/** 当前修订前进一步(等价 T029 详情推进:指针 + 一致快照行) */
function advanceDetailRevision(db: Db, world: SeededVodWorld): void {
  const next = world.detailRevision + 1;
  db.insert(schema.vodDetailSnapshot)
    .values({ householdId: HOUSEHOLD_ID, titleId: world.titleId, revision: next, locatorRevision: 1, validatedPrivatePayload: JSON.stringify({ fixture: `${world.titleId}-r${next}` }), fetchedAt: NOW_ISO, expiresAt: FUTURE_ISO })
    .run();
  db.update(schema.vodTitle)
    .set({ currentDetailRevision: next })
    .where(and(eq(schema.vodTitle.householdId, HOUSEHOLD_ID), eq(schema.vodTitle.id, world.titleId)))
    .run();
}

/* ------------------------------------------------------------------ */
/* 断言助手                                                              */
/* ------------------------------------------------------------------ */

function expectDomainError(action: () => unknown, status: number, code: ProblemCode): void {
  let caught: unknown;
  try {
    action();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DomainError);
  const domain = caught as DomainError;
  expect(domain.status).toBe(status);
  expect(domain.code).toBe(code);
}

function expectExactKeys(value: unknown, keys: readonly string[], label: string): void {
  expect(value, `${label} 应为对象`).toBeTypeOf('object');
  expect(Array.isArray(value), `${label} 不应为数组`).toBe(false);
  expect(Object.keys(value as Record<string, unknown>).sort(), `${label} 键集合`).toEqual([...keys].sort());
}

/** 全页扁平子项(线路顺序保持) */
function flattenEpisodes(page: StableEpisodesDto): StableEpisodeItemDto[] {
  return page.lines.flatMap((line: StableEpisodeLineDto) => line.episodes);
}

/** 测试侧 cursor 构造(与服务同形 base64url(JSON);用于越界/伪造形态) */
function craftCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** prepare 语句计数代理(N+1 守卫;drizzle 与原生 prepare 都经此计数) */
function countPrepares(conn: DatabaseConstructor.Database): { delta(): number; counted: DatabaseConstructor.Database } {
  let statements = 0;
  const counted = new Proxy(conn, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (...args: unknown[]) => {
          statements += 1;
          return (target as DatabaseConstructor.Database).prepare(...(args as [string]));
        };
      }
      return Reflect.get(target, prop, target);
    },
  }) as DatabaseConstructor.Database;
  return { delta: () => statements, counted };
}

/* ------------------------------------------------------------------ */
/* D 组语义:分集分页/修订绑定/非父/不可用/sequenceOrdinal                  */
/* ------------------------------------------------------------------ */

describe('T030 · episodes 分页与修订绑定(api.md §2 StableEpisodes)', () => {
  it('每页总计 100 子项:105 子项单线剧首页 100 + nextCursor;翻页 5 + null;跨页并集不重不漏', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9001',
      name: 'fixture·百集分页剧',
      lines: [
        {
          lineKey: 'main',
          displayName: 'fixture正片',
          sortOrder: 1,
          episodes: Array.from({ length: 105 }, (_unused, index) => ({
            episodeKey: String(index + 1).padStart(3, '0'),
            label: `第${String(index + 1).padStart(3, '0')}集`,
            ordinal: index + 1,
            status: 'ordered' as const,
          })),
        },
      ],
    });
    const first = rig.service.listEpisodes(world.parentMediaId);
    expectExactKeys(first, STABLE_EPISODES_KEYS, 'StableEpisodes');
    expect(first.parentMediaId).toBe(world.parentMediaId);
    expect(first.detailRevision).toBe(1);
    expect(first.stale).toBe(false);
    expect(Number.isNaN(Date.parse(first.fetchedAt)), 'fetchedAt 应为 ISO8601').toBe(false);
    expect(first.lines, '单线剧首页单线路').toHaveLength(1);
    expect(flattenEpisodes(first), '每页总计 100 子项(api.md §2)').toHaveLength(100);
    expect(typeof first.nextCursor).toBe('string');

    // 同形态重放稳定:无 cursor 首页重放、同 cursor 页重放,均逐字段不变(页序全序确定)
    expect(rig.service.listEpisodes(world.parentMediaId)).toEqual(first);
    expect(rig.service.listEpisodes(world.parentMediaId, first.nextCursor ?? undefined)).toEqual(
      rig.service.listEpisodes(world.parentMediaId, first.nextCursor ?? undefined),
    );

    const second = rig.service.listEpisodes(world.parentMediaId, first.nextCursor ?? '');
    expect(flattenEpisodes(second), '第二页为余下 5 条').toHaveLength(5);
    expect(second.nextCursor, '取尽后 nextCursor=null').toBeNull();
    expect(second.lines[0]?.lineRef, '线路跨页重复:同一 lineRef(消费者按其聚合)').toBe(first.lines[0]?.lineRef);

    // 跨页并集 = 全集,不重不漏且页序确定(ordinal 升序)
    const all = [...flattenEpisodes(first), ...flattenEpisodes(second)];
    expect(new Set(all.map((episode) => episode.mediaId))).toHaveLength(105);
    expect(all.map((episode) => episode.sequenceOrdinal)).toEqual(Array.from({ length: 105 }, (_unused, index) => index + 1));
    expect(world.episodeMediaIds).toEqual(expect.arrayContaining(all.map((episode) => episode.mediaId)));
  });

  it('修订绑定 cursor:详情修订前进后旧 cursor 409 VOD_DETAIL_CHANGED;无 cursor 重读 200 新修订', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9002',
      name: 'fixture·修订绑定剧',
      lines: [
        {
          lineKey: 'main',
          displayName: 'fixture正片',
          sortOrder: 1,
          episodes: Array.from({ length: 105 }, (_unused, index) => ({
            episodeKey: String(index + 1).padStart(3, '0'),
            label: `第${String(index + 1).padStart(3, '0')}集`,
            ordinal: index + 1,
            status: 'ordered' as const,
          })),
        },
      ],
    });
    const first = rig.service.listEpisodes(world.parentMediaId);
    expect(first.detailRevision).toBe(1);
    advanceDetailRevision(rig.db, world);
    expectDomainError(
      () => rig.service.listEpisodes(world.parentMediaId, first.nextCursor ?? ''),
      409,
      ProblemCode.VOD_DETAIL_CHANGED,
    );
    // 无 cursor = 重读:新修订 200(旧位置不复用)
    const fresh = rig.service.listEpisodes(world.parentMediaId);
    expect(fresh.detailRevision).toBe(2);
    expect(fresh.fetchedAt).toBe(NOW_ISO);
  });

  it('cursor 严格形态:非法编码/跨父重放/伪造越界形态 400 VALIDATION_FAILED;越界 offset 空页稳定', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9003',
      name: 'fixture·cursor形态剧',
      lines: [
        {
          lineKey: 'main',
          displayName: 'fixture正片',
          sortOrder: 1,
          episodes: Array.from({ length: 3 }, (_unused, index) => ({
            episodeKey: `0${index + 1}`,
            label: `第0${index + 1}集`,
            ordinal: index + 1,
            status: 'ordered' as const,
          })),
        },
      ],
    });
    const other = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9004',
      name: 'fixture·另一部剧',
      lines: [{ lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes: [{ episodeKey: '01', label: '第01集', ordinal: 1, status: 'ordered' }] }],
    });
    // 非法编码(base64url 可解但 JSON 破损)/未知版本 → 400
    expectDomainError(() => rig.service.listEpisodes(world.parentMediaId, craftCursor({ broken: true })), 400, ProblemCode.VALIDATION_FAILED);
    expectDomainError(() => rig.service.listEpisodes(world.parentMediaId, 'not-base64url!!'), 400, ProblemCode.VALIDATION_FAILED);
    expectDomainError(
      () => rig.service.listEpisodes(world.parentMediaId, craftCursor({ v: 2, p: world.parentMediaId, o: 0, r: 1 })),
      400,
      ProblemCode.VALIDATION_FAILED,
    );
    // 跨父重放:cursor 绑定其它父媒体 → 400(不静默给另一部剧的分页)
    expectDomainError(
      () => rig.service.listEpisodes(world.parentMediaId, craftCursor({ v: 1, p: other.parentMediaId, o: 0, r: 1 })),
      400,
      ProblemCode.VALIDATION_FAILED,
    );
    // 越界 offset(合法形态):200 空页 + nextCursor null(稳定,不 404/409)
    const beyond = rig.service.listEpisodes(world.parentMediaId, craftCursor({ v: 1, p: world.parentMediaId, o: 500, r: 1 }));
    expect(beyond.lines).toStrictEqual([]);
    expect(beyond.nextCursor).toBeNull();
    expect(beyond.detailRevision).toBe(1);
  });

  it('非父 400/不可用与不存在 404 同形:可用频道与可解析子项 400,不可见/停源父项/未知 404', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    seedSource(rig.db, { id: 'src-iptv', kind: 'iptv', remoteUrl: 'http://iptv-unit.example/list.m3u8' });
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    seedStandaloneChain(rig.db, { mediaId: 'ch-1', sourceId: 'src-iptv', type: 'channel', title: '夹具频道' });
    seedStandaloneChain(rig.db, { mediaId: 'm-invisible', sourceId: 'src-iptv', type: 'movie', title: '缺条目片', present: 0 });
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9005',
      name: 'fixture·非父判定剧',
      lines: [{ lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes: [{ episodeKey: '01', label: '第01集', ordinal: 1, status: 'ordered', resolvable: true }] }],
    });
    // 可见非父(standalone 频道)→ 400 VOD_EPISODE_REQUIRED(e2e D3 同形)
    expectDomainError(() => rig.service.listEpisodes('ch-1'), 400, ProblemCode.VOD_EPISODE_REQUIRED);
    // 可解析候选子项也是「非父」→ 400(候选树=子项层,子项不是分集父)
    expectDomainError(() => rig.service.listEpisodes(world.episodeMediaIds[0]!), 400, ProblemCode.VOD_EPISODE_REQUIRED);
    // 不可见 standalone(present=0)→ 404 同形,不泄露存在性
    expectDomainError(() => rig.service.listEpisodes('m-invisible'), 404, ProblemCode.NOT_FOUND);
    // 未知 id → 404 同形
    expectDomainError(() => rig.service.listEpisodes('no-such-media'), 404, ProblemCode.NOT_FOUND);
    // 父不可用(来源停用)→ 404;来源再启用 → 200(可用性实时判定)
    rig.db
      .update(schema.mediaSource)
      .set({ enabled: 0 })
      .where(and(eq(schema.mediaSource.householdId, HOUSEHOLD_ID), eq(schema.mediaSource.id, sourceId)))
      .run();
    expectDomainError(() => rig.service.listEpisodes(world.parentMediaId), 404, ProblemCode.NOT_FOUND);
    rig.db
      .update(schema.mediaSource)
      .set({ enabled: 1 })
      .where(and(eq(schema.mediaSource.householdId, HOUSEHOLD_ID), eq(schema.mediaSource.id, sourceId)))
      .run();
    expect(rig.service.listEpisodes(world.parentMediaId).lines).toHaveLength(1);
  });

  it('sequenceOrdinal 映射:ordered 取 ordinal,ambiguous/special/缺序列为 null;availability 区分候选与摘要', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9006',
      name: 'fixture·序列映射剧',
      lines: [
        {
          lineKey: 'main',
          displayName: 'fixture正片',
          sortOrder: 1,
          episodes: [
            { episodeKey: '01', label: '第01集', ordinal: 1, status: 'ordered', resolvable: true },
            { episodeKey: '02', label: '第02集', ordinal: 2, status: 'ordered' },
            { episodeKey: '04', label: '第04集', ordinal: 4, status: 'ordered' },
            { episodeKey: 'SP', label: '特别篇', ordinal: 9, status: 'special' },
            { episodeKey: 'AM', label: '重编号集', ordinal: 5, status: 'ambiguous' },
            { episodeKey: 'NA', label: '缺序列集', status: 'ordered' },
          ],
        },
      ],
    });
    const page = rig.service.listEpisodes(world.parentMediaId);
    const episodes = flattenEpisodes(page);
    expect(episodes.map((episode) => episode.label)).toEqual(['第01集', '第02集', '第04集', '特别篇', '重编号集', '缺序列集']);
    expect(episodes.map((episode) => episode.sequenceOrdinal)).toEqual([1, 2, 4, null, null, null]);
    // candidate=子可解析候选;unavailable=仅摘要保留(浏览≠可播放)
    expect(episodes.map((episode) => episode.availability)).toEqual(['candidate', 'unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable']);
    for (const episode of episodes) {
      expectExactKeys(episode, STABLE_EPISODE_ITEM_KEYS, 'StableEpisodeItem');
    }
    expectExactKeys(page.lines[0], STABLE_EPISODE_LINE_KEYS, 'StableEpisodeLine');
  });
});

/* ------------------------------------------------------------------ */
/* 线路聚合:lineRef 跨页稳定,跨线分页                                     */
/* ------------------------------------------------------------------ */

describe('T030 · 线路聚合语义(lineRef 跨页稳定)', () => {
  it('双线 60+60:首页 100 跨两线;次页 20 同线延续;lineRef 集合一致不把跨页线当新线', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const episodesOf = (prefix: string, count: number) =>
      Array.from({ length: count }, (_unused, index) => ({
        episodeKey: `${prefix}${String(index + 1).padStart(3, '0')}`,
        label: `${prefix}第${String(index + 1).padStart(3, '0')}集`,
        ordinal: index + 1,
        status: 'ordered' as const,
      }));
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9100',
      name: 'fixture·双线聚合剧',
      lines: [
        { lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes: episodesOf('A', 60) },
        { lineKey: 'backup', displayName: 'fixture备用线', sortOrder: 2, episodes: episodesOf('B', 60) },
      ],
    });
    const first = rig.service.listEpisodes(world.parentMediaId);
    expect(flattenEpisodes(first), '每页总计 100 子项(跨线合计)').toHaveLength(100);
    expect(first.lines.map((line) => line.name)).toEqual(['fixture正片', 'fixture备用线']);
    // 首页:线1 60 集 + 线2 前 40 集(全序:线序→子序)
    expect(first.lines[0]?.episodes).toHaveLength(60);
    expect(first.lines[1]?.episodes).toHaveLength(40);

    const second = rig.service.listEpisodes(world.parentMediaId, first.nextCursor ?? '');
    expect(flattenEpisodes(second)).toHaveLength(20);
    // 次页 20 条全为备用线余量:lineRef 与首页备用线同一身份(不把跨页线当新线)
    expect(second.lines.map((line) => line.lineRef)).toEqual([first.lines[1]?.lineRef]);
    expect(second.lines.map((line) => line.name)).toEqual(['fixture备用线']);
    expect(second.lines[0]?.episodes).toHaveLength(20);

    // 跨页聚合:两页线并集 = 全部线路,lineRef 逐一相等;子项并集不重不漏
    expect(new Set([...first.lines, ...second.lines].map((line) => line.lineRef))).toEqual(new Set(world.lineIds));
    const all = [...flattenEpisodes(first), ...flattenEpisodes(second)];
    expect(new Set(all.map((episode) => episode.mediaId))).toHaveLength(120);
    expect(all.map((episode) => episode.mediaId)).toStrictEqual(world.episodeMediaIds);
    // 响应零泄漏:无家庭/来源/上游痕迹
    const serialized = JSON.stringify(first) ?? '';
    for (const marker of ['householdId', 'src-vod', 'cms-unit', 'http://']) {
      expect(serialized, `StableEpisodes 不得包含「${marker}」`).not.toContain(marker);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 公共列表/详情投影:NAS/IPTV 零变化 + vod 父子形态                        */
/* ------------------------------------------------------------------ */

describe('T030 · 公共列表/详情投影(NAS/IPTV 零变化 + vod 父子形态)', () => {
  it('NAS/IPTV 回归:standalone 七键逐字(对照 public-media-projection 基线),不可用不进目录', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    seedSource(rig.db, { id: 'src-iptv', kind: 'iptv', remoteUrl: 'http://iptv-unit.example/list.m3u8' });
    seedSource(rig.db, { id: 'src-nas', kind: 'nas' });
    seedStandaloneChain(rig.db, { mediaId: 'ch-1', sourceId: 'src-iptv', type: 'channel', title: '夹具频道' });
    seedStandaloneChain(rig.db, { mediaId: 'm-1', sourceId: 'src-nas', type: 'movie', title: '夹具影片' });
    seedStandaloneChain(rig.db, { mediaId: 'm-off', sourceId: 'src-nas', type: 'movie', title: '失效影片', present: 0 });

    const page = rig.service.listMedia({ page: 1, pageSize: 20 });
    expect(page.total).toBe(2);
    for (const item of page.items) {
      // 七键精确(零变化:无 detailKind/parentMediaId)
      expectExactKeys(item, PUBLIC_MEDIA_KEYS, 'PublicMedia(standalone)');
      expect(item.availability).toBe('available');
    }
    expect(JSON.stringify(page), 'standalone 目录面零 010 字段(NAS/IPTV 行为零变化)').not.toContain('detailKind');
    expect(JSON.stringify(page)).not.toContain('parentMediaId');
    // 不可用不进目录;q/type 只影响筛选
    expect(rig.service.listMedia({ q: '失效', page: 1, pageSize: 20 }).total).toBe(0);
    expect(rig.service.listMedia({ type: 'channel', page: 1, pageSize: 20 }).items.map((item) => item.id)).toEqual(['ch-1']);
    // 详情:七键精确 + 404 同形
    const detail = rig.service.getMedia('m-1');
    expectExactKeys(detail, PUBLIC_MEDIA_KEYS, 'PublicMedia 详情(standalone)');
    expectDomainError(() => rig.service.getMedia('m-off'), 404, ProblemCode.NOT_FOUND);
    expectDomainError(() => rig.service.getMedia('no-such'), 404, ProblemCode.NOT_FOUND);
  });

  it('vod 形态:可用父项进目录(detailKind=vod_title),子项不铺卡片;子详情带 parentMediaId;停源父项 404', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9200',
      name: 'fixture·投影剧',
      lines: [
        { lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes: [{ episodeKey: '01', label: '第01集', ordinal: 1, status: 'ordered', resolvable: true }, { episodeKey: '02', label: '第02集', ordinal: 2, status: 'ordered' }] },
      ],
    });
    const page = rig.service.listMedia({ page: 1, pageSize: 20 });
    // 父项进目录,子项不铺(不重复铺卡片)
    expect(page.items.map((item) => item.id)).toEqual([world.parentMediaId]);
    const parentCard = page.items[0]!;
    expect(parentCard.detailKind).toBe('vod_title');
    expect(parentCard.parentMediaId).toBeNull();
    expect(parentCard.availability).toBe('available');
    expect(page.items.some((item) => world.episodeMediaIds.includes(item.id)), '子项不重复铺卡片').toBe(false);

    // 父详情:detailKind=vod_title + parentMediaId null
    const parentDetail = rig.service.getMedia(world.parentMediaId);
    expect(parentDetail.detailKind).toBe('vod_title');
    expect(parentDetail.parentMediaId).toBeNull();

    // 子详情(可解析候选在链):detailKind=vod_episode + parentMediaId=父
    const childDetail = rig.service.getMedia(world.episodeMediaIds[0]!);
    expect(childDetail.detailKind).toBe('vod_episode');
    expect(childDetail.parentMediaId).toBe(world.parentMediaId);
    // 不可解析子项详情 404 同形(可见性=可解析候选链,与父可浏览分开)
    expectDomainError(() => rig.service.getMedia(world.episodeMediaIds[1]!), 404, ProblemCode.NOT_FOUND);

    // 停源:父项退出目录且详情 404(已物化但不可用);可解析子项随源停用同退
    rig.db
      .update(schema.mediaSource)
      .set({ enabled: 0 })
      .where(and(eq(schema.mediaSource.householdId, HOUSEHOLD_ID), eq(schema.mediaSource.id, sourceId)))
      .run();
    expect(rig.service.listMedia({ page: 1, pageSize: 20 }).total).toBe(0);
    expectDomainError(() => rig.service.getMedia(world.parentMediaId), 404, ProblemCode.NOT_FOUND);
    expectDomainError(() => rig.service.getMedia(world.episodeMediaIds[0]!), 404, ProblemCode.NOT_FOUND);
  });

  it('未物化父级形态:media_role=vod_title 但稳定映射/子项缺失 → 不进目录且详情 404(与不存在同形)', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    // 孤儿父卡(无 vod_title/vod_line/vod_episode 行):父级可浏览链不成立
    rig.db
      .insert(schema.mediaItem)
      .values({ id: 'parent-orphan', householdId: HOUSEHOLD_ID, type: 'series', mediaRole: 'vod_title', title: '孤儿父卡', description: null, contentLevel: 0, version: 1, createdAt: NOW_ISO, updatedAt: NOW_ISO })
      .run();
    expect(rig.service.listMedia({ page: 1, pageSize: 20 }).total).toBe(0);
    expectDomainError(() => rig.service.getMedia('parent-orphan'), 404, ProblemCode.NOT_FOUND);
    expectDomainError(() => rig.service.listEpisodes('parent-orphan'), 404, ProblemCode.NOT_FOUND);
    // 纯 vod 来源但零标题:父级可用集合为空,查询不抛(N+1 守卫前置稳定性)
    expect(seedSource(rig.db, { id: 'src-empty', kind: 'vod', remoteUrl: 'http://cms-empty.example/api.php' })).toBe('src-empty');
    expect(loadAvailableMediaIdSet(HOUSEHOLD_ID).has('parent-orphan')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 父不进可播放候选集合(候选树=子项层)                                    */
/* ------------------------------------------------------------------ */

describe('T030 · 父不进可播放候选集合', () => {
  it('可用集合与策略候选树:父项恒不可用不进 allowed;已登记子项进候选层', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const world = seedVodTitleWorld(rig.db, {
      sourceId,
      upstreamVodId: '9300',
      name: 'fixture·候选树剧',
      lines: [
        { lineKey: 'main', displayName: 'fixture正片', sortOrder: 1, episodes: [{ episodeKey: '01', label: '第01集', ordinal: 1, status: 'ordered', resolvable: true }, { episodeKey: '02', label: '第02集', ordinal: 2, status: 'ordered' }] },
      ],
    });
    // 可用集合(「子可解析候选」链):子项按各自链判定,父项恒不在集合
    const availableIds = loadAvailableMediaIdSet(HOUSEHOLD_ID);
    expect(availableIds.has(world.parentMediaId), '父项不进可播放候选集合').toBe(false);
    expect(availableIds.has(world.episodeMediaIds[0]!), '已登记子项进候选层').toBe(true);
    expect(availableIds.has(world.episodeMediaIds[1]!), '未登记子项不可解析').toBe(false);

    // 策略候选树(loadBatchCatalogContext):candidates 含父项(available=false 诊断面),
    // evaluatePolicy 可用性先于策略 → allowed 只含子项层
    const context = loadBatchCatalogContext({ householdId: HOUSEHOLD_ID, sessionId: 'ses-adult' });
    const parentCandidate = context.candidates.find((candidate) => candidate.id === world.parentMediaId);
    expect(parentCandidate, '父项保留在家庭候选全集(诊断)').toBeDefined();
    expect(parentCandidate?.available).toBe(false);
    expect(context.allowed.map((candidate) => candidate.id)).not.toContain(world.parentMediaId);
    expect(context.allowed.map((candidate) => candidate.id)).toContain(world.episodeMediaIds[0]!);
  });
});

/* ------------------------------------------------------------------ */
/* N+1 守卫:语句数与子项规模/页码无关                                      */
/* ------------------------------------------------------------------ */

describe('T030 · 分集查询禁 N+1(单查询 + 内存分组)', () => {
  it('prepare 语句数:同标题跨页相同;105 → 305 子项语句数不变;listMedia 与子项规模无关', () => {
    const rig = createRig();
    seedIdentity(rig.db);
    const sourceId = seedSource(rig.db, { id: 'src-vod', kind: 'vod', remoteUrl: 'http://cms-unit.example/api.php' });
    const lineOf = (upstream: string, count: number) => [
      {
        lineKey: 'main',
        displayName: 'fixture正片',
        sortOrder: 1,
        episodes: Array.from({ length: count }, (_unused, index) => ({
          episodeKey: String(index + 1).padStart(3, '0'),
          label: `第${String(index + 1).padStart(3, '0')}集`,
          ordinal: index + 1,
          status: 'ordered' as const,
        })),
      },
    ];
    const small = seedVodTitleWorld(rig.db, { sourceId, upstreamVodId: '9401', name: '夹具小剧', lines: lineOf('9401', 105) });
    seedVodTitleWorld(rig.db, { sourceId, upstreamVodId: '9402', name: '夹具大剧', lines: lineOf('9402', 305) });

    const counted = countPrepares(rig.conn);
    bindMediaCatalogStore(drizzleMediaCatalogStore(rig.db, counted.counted));
    try {
      const beforeFirst = counted.delta();
      const first = rig.service.listEpisodes(small.parentMediaId);
      const firstPageStatements = counted.delta() - beforeFirst;
      const beforeSecond = counted.delta();
      rig.service.listEpisodes(small.parentMediaId, first.nextCursor ?? '');
      expect(counted.delta() - beforeSecond, '翻页语句数与首页相同(无逐条装载)').toBe(firstPageStatements);

      const beforeBig = counted.delta();
      rig.service.listEpisodes('parent-9402');
      expect(counted.delta() - beforeBig, '子项规模 105→305,语句数不变(单查询禁 N+1)').toBe(firstPageStatements);

      const beforeList = counted.delta();
      rig.service.listMedia({ page: 1, pageSize: 100 });
      const listStatements = counted.delta() - beforeList;
      const beforeListAgain = counted.delta();
      rig.service.listMedia({ page: 2, pageSize: 100 });
      expect(counted.delta() - beforeListAgain, '列表语句数与页码/规模无关').toBe(listStatements);
      expect(firstPageStatements).toBeLessThanOrEqual(4);
    } finally {
      bindMediaCatalogStore(drizzleMediaCatalogStore(rig.db, rig.conn));
    }
  });
});
