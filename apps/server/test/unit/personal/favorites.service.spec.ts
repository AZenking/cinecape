import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupRigs,
  startFreshApp,
  type TestRig,
} from '../../helpers';
import { seedPersonalWorld, readFavorite, type PersonalWorld } from './personal-world';
import {
  addFavoriteChannel,
  listFavoriteChannels,
  removeFavoriteChannel,
} from '../../../src/modules/personal/favorites.service';
import { decodePersonalCursor } from '../../../src/modules/personal/signed-cursor';
import { DomainError } from '../../../src/common/domain-error';
import { getDb } from '../../../src/modules/auth/db';
import { hashToken as hashTokenFor } from '../../../src/modules/auth/token.service';
import { mediaItem, playbackSource, sourceEntry } from '../../../src/database/schema';
import { eq } from 'drizzle-orm';

/**
 * T088(005 US4 单元测试,先 FAIL 后 GREEN)—— 收藏服务单元:
 *
 * 权威:data-model.md §4(主键三元组/created_at 语义/键集分页/不可用保留)、
 * contracts/api.md §4(PUT/DELETE 幂等与 204)、tasks.md T088。
 * 矩阵:
 * - 主键 (household_id,profile_id,media_id):同 Profile 同媒体仅一行;
 * - created_at 首次收藏固定,重复 PUT 不更新;DELETE 不存在也 204;取消后重新收藏为新时间;
 * - 非频道或不可用媒体添加拒绝;
 * - 列表按 (created_at DESC,media_id DESC) 键集分页;signed cursor 绑定家庭/Profile/列表类型;
 * - 不可用频道保留关系并返回 unavailable 状态,可取消但不可(重新)收藏;
 * - current/next 节目窗口来自直播批量投影(暂无节目为 null 占位)。
 */

describe('T088 · 收藏服务(data-model §4 / api §4)', () => {
  let rig: TestRig;
  let world: PersonalWorld;

  beforeEach(async () => {
    rig = await startFreshApp({ prefix: 'hmp-t088-fav-' });
    world = seedPersonalWorld(rig);
  });
  afterEach(cleanupRigs);

  it('主键三元组:重复 PUT 同一媒体仅一行,不报错(幂等)', () => {
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T08:00:00.000Z' });
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T09:00:00.000Z' });
    const rows = listFavoriteChannels({ householdId: world.householdId, profileId: world.profileAId, limit: 20 });
    expect(rows.items).toHaveLength(1);
    expect(readFavorite(world.householdId, world.profileAId, world.channel.mediaId)).toBeDefined();
  });

  it('created_at 首次收藏固定,重复 PUT 不更新;取消后重新收藏为新时间', () => {
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T08:00:00.000Z' });
    // 重复 PUT:不更新 created_at
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T10:00:00.000Z' });
    expect(readFavorite(world.householdId, world.profileAId, world.channel.mediaId)?.createdAt).toBe('2026-10-23T08:00:00.000Z');
    // 取消后重新收藏 → 新时间
    removeFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId });
    expect(readFavorite(world.householdId, world.profileAId, world.channel.mediaId)).toBeUndefined();
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T11:00:00.000Z' });
    expect(readFavorite(world.householdId, world.profileAId, world.channel.mediaId)?.createdAt).toBe('2026-10-23T11:00:00.000Z');
  });

  it('DELETE 不存在也 204(服务层不抛错);删除幂等', () => {
    expect(() => removeFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: 'no-such-media' })).not.toThrow();
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T08:00:00.000Z' });
    removeFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId });
    expect(() => removeFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId })).not.toThrow();
  });

  it('非频道媒体添加拒绝(400 VALIDATION_FAILED);点播不可收藏', () => {
    expect(() => addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.movieMediaId })).toThrowError(DomainError);
    try {
      addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.movieMediaId });
      expect.unreachable('非频道收藏必须拒绝');
    } catch (error) {
      expect((error as DomainError).status).toBe(400);
      expect((error as DomainError).code).toBe('VALIDATION_FAILED');
    }
  });

  it('不可用频道添加拒绝;不可用媒体收藏 → 400;不存在/跨家庭 → 404 同形', () => {
    // 失效频道(present=0)
    expect(() => addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.unavailableChannelMediaId })).toThrowError(DomainError);
    try {
      addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.unavailableChannelMediaId });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).status).toBe(400);
    }
    // 不存在 → 404 MEDIA_NOT_FOUND
    try {
      addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: 'no-such-media' });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).status).toBe(404);
      expect((error as DomainError).code).toBe('MEDIA_NOT_FOUND');
    }
    // 跨家庭:他家庭频道不存在于本家庭 → 同形 404
    try {
      addFavoriteChannel({ householdId: 'another-household', profileId: world.profileAId, mediaId: world.channel.mediaId });
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).status).toBe(404);
    }
  });

  it('列表按 (created_at DESC,media_id DESC) 键集分页;nextCursor 续页不重不漏', () => {
    // 25 个可用频道,created_at 依次递增
    const db = getDb();
    const mediaIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const mediaId = `fav-ch-${String(index).padStart(2, '0')}`;
      mediaIds.push(mediaId);
      db.insert(mediaItem).values({
        id: mediaId, householdId: world.householdId, type: 'channel', title: `频道${index}`, contentLevel: 0, version: 1,
        createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
      }).run();
      db.insert(sourceEntry).values({
        id: `fav-ent-${index}`, householdId: world.householdId, sourceId: world.channel.sourceId, identityKind: 'url',
        identityDigest: `f${String(index).padStart(3, '0')}`.padEnd(64, '0'), mediaId, present: 1, firstSeenAt: '2026-10-23T00:00:00.000Z', lastSeenAt: '2026-10-23T00:00:00.000Z',
      }).run();
      // 可用性 = 条目 × 启用源 × 播放资源:合成频道补播放资源行
      db.insert(playbackSource).values({
        id: `fav-ps-${index}`, householdId: world.householdId, sourceId: world.channel.sourceId, sourceEntryId: `fav-ent-${index}`,
        mediaItemId: mediaId, protocol: 'http', location: `http://iptv.personal-fixture.test/stream/${index}.m3u8`,
        createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
      }).run();
      addFavoriteChannel({
        householdId: world.householdId, profileId: world.profileAId, mediaId,
        at: new Date(Date.UTC(2026, 9, 23, 8, 0, index)).toISOString(),
      });
    }
    const identity = { householdId: world.householdId, profileId: world.profileAId };
    const page1 = listFavoriteChannels({ ...identity, limit: 10 });
    expect(page1.items).toHaveLength(10);
    expect(page1.nextCursor).not.toBeNull();
    // 第一页:created_at DESC(第 24 分 → 第 15 分)
    expect(page1.items[0]?.createdAt).toBe(new Date(Date.UTC(2026, 9, 23, 8, 0, 24)).toISOString());
    expect(page1.items[9]?.createdAt).toBe(new Date(Date.UTC(2026, 9, 23, 8, 0, 15)).toISOString());

    const page2 = listFavoriteChannels({ ...identity, limit: 10, cursor: page1.nextCursor ?? undefined });
    expect(page2.items).toHaveLength(10);
    expect(page2.items[0]?.createdAt).toBe(new Date(Date.UTC(2026, 9, 23, 8, 0, 14)).toISOString());

    const page3 = listFavoriteChannels({ ...identity, limit: 10, cursor: page2.nextCursor ?? undefined });
    expect(page3.items).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();

    // 不重不漏:三页合起来 = 全集倒序
    const all = [...page1.items, ...page2.items, ...page3.items].map((item) => item.media.id);
    expect(all).toEqual([...mediaIds].reverse());

    // 同 created_at 时按 media_id DESC 稳定次序(两个新频道同刻收藏)
    const tiePair = ['fav-ch-tie-b', 'fav-ch-tie-a'];
    for (const tieId of tiePair) {
      db.insert(mediaItem).values({
        id: tieId, householdId: world.householdId, type: 'channel', title: tieId, contentLevel: 0, version: 1,
        createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
      }).run();
      db.insert(sourceEntry).values({
        id: `fav-ent-${tieId}`, householdId: world.householdId, sourceId: world.channel.sourceId, identityKind: 'url',
        identityDigest: hashTokenFor(tieId), mediaId: tieId, present: 1,
        firstSeenAt: '2026-10-23T00:00:00.000Z', lastSeenAt: '2026-10-23T00:00:00.000Z',
      }).run();
      db.insert(playbackSource).values({
        id: `fav-ps-${tieId}`, householdId: world.householdId, sourceId: world.channel.sourceId, sourceEntryId: `fav-ent-${tieId}`,
        mediaItemId: tieId, protocol: 'http', location: `http://iptv.personal-fixture.test/stream/${tieId}.m3u8`,
        createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
      }).run();
      addFavoriteChannel({ ...identity, mediaId: tieId, at: '2026-10-23T20:00:00.000Z' });
    }
    const tie = listFavoriteChannels({ ...identity, limit: 2 });
    // 同刻:media_id DESC('b' > 'a')
    expect(tie.items.map((item) => item.media.id)).toEqual(['fav-ch-tie-b', 'fav-ch-tie-a']);
  });

  it('signed cursor 绑定家庭/Profile/列表类型:他档案/他列表/篡改 → INVALID_CURSOR,不回落', () => {
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T08:00:00.000Z' });
    const identityA = { householdId: world.householdId, profileId: world.profileAId };
    const page = listFavoriteChannels({ ...identityA, limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    const cursor = page.nextCursor as string;

    // 档案 B 解析档案 A 的游标 → 400
    expect(() =>
      decodePersonalCursor(cursor, { type: 'favorites', householdId: world.householdId, profileId: world.profileBId }),
    ).toThrowError(DomainError);
    // 列表类型不匹配 → 400
    expect(() =>
      decodePersonalCursor(cursor, { type: 'history', householdId: world.householdId, profileId: world.profileAId }),
    ).toThrowError(DomainError);
    // 篡改载荷 → 400
    expect(() =>
      decodePersonalCursor(`${cursor}x`, { type: 'favorites', householdId: world.householdId, profileId: world.profileAId }),
    ).toThrowError(DomainError);
    expect(() => decodePersonalCursor('not-a-cursor', { type: 'favorites', ...identityA })).toThrowError(DomainError);
  });

  it('不可用频道保留关系:列表返回 unavailable 摘要,可取消但不可播放/重新收藏', async () => {
    // 先收藏可用频道,再令其失效(条目 present=0)
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T08:00:00.000Z' });
    getDb().update(sourceEntry).set({ present: 0, missingSince: '2026-10-23T12:00:00.000Z' }).where(eq(sourceEntry.id, world.channel.entryId)).run();

    const page = listFavoriteChannels({ householdId: world.householdId, profileId: world.profileAId, limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.media.availability).toBe('unavailable');
    expect(page.items[0]?.media.title).toBe('夹具频道');

    // 仍可取消(204 语义:服务层不抛)
    expect(() => removeFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId })).not.toThrow();
    // 不可重新收藏(添加时要求可用)
    expect(() => addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId })).toThrowError(DomainError);
  });

  it('收藏卡 current/next 来自直播批量投影:有节目返回窗口,档案隔离空列表形态正确', () => {
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T08:00:00.000Z' });
    const page = listFavoriteChannels({ householdId: world.householdId, profileId: world.profileAId, limit: 20 });
    expect(page.items[0]?.current?.title).toBe('正在直播节目');
    expect(page.items[0]?.next?.title).toBe('下一档节目');
    // 未收藏档案:空列表形态(空 items + null 游标;文字占位由前端承担)
    const narrowed = listFavoriteChannels({ householdId: world.householdId, profileId: world.profileBId, limit: 20 });
    expect(narrowed.items).toHaveLength(0);
    expect(narrowed.nextCursor).toBeNull();
  });

  it('数据不依赖 Account 作为观看归属:同账号双档案各自独立收藏', () => {
    addFavoriteChannel({ householdId: world.householdId, profileId: world.profileAId, mediaId: world.channel.mediaId, at: '2026-10-23T08:00:00.000Z' });
    const pageA = listFavoriteChannels({ householdId: world.householdId, profileId: world.profileAId, limit: 20 });
    const pageB = listFavoriteChannels({ householdId: world.householdId, profileId: world.profileBId, limit: 20 });
    expect(pageA.items).toHaveLength(1);
    expect(pageB.items).toHaveLength(0);
  });
});
