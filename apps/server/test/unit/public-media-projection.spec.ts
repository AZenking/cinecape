import { describe, expect, it } from 'vitest';
import { toPublicMedia, type PublicMediaRow } from '../../src/modules/public-catalog/public-media-projection';

/**
 * T017(US1 单元):公共投影服务逐字执行 PublicMedia 白名单(data-model.md §9):
 * 「PublicMedia:id、type、title、description、posterRef、contentLevel、availability;
 *   posterRef 仅服务端认可的同源展示资源或 null,导入任意外部 URL 不直接渲染。
 *   只有可用资源进入目录;个人记录的失效媒体使用 unavailable 摘要。」
 * - 白名单外的源字段(含 source_entry 原始 URL 与来源身份)不得进入 DTO;
 * - 未认可外部 posterRef 置 null;availability 由家庭级可用性映射;
 * - 本测试为纯函数单元(无 DB),逐字段钉死投影行为。
 */

/** 投影输入行的富形态:混入白名单外内部列(模拟直接查询 media_item + 来源身份) */
function richRow(overrides: Partial<PublicMediaRow> = {}): PublicMediaRow {
  return {
    id: 'm-1',
    type: 'movie',
    title: '某影片',
    description: '简介',
    posterRef: null,
    contentLevel: 12,
    available: true,
    ...overrides,
  };
}

describe('PublicMedia 白名单投影(toPublicMedia,T017)', () => {
  it('白名单键面精确:id/type/title/description/posterRef/contentLevel/availability,无多余字段', () => {
    const dto = toPublicMedia(richRow());
    expect(Object.keys(dto).sort()).toEqual([
      'availability',
      'contentLevel',
      'description',
      'id',
      'posterRef',
      'title',
      'type',
    ]);
  });

  it('白名单外源字段不进入 DTO:含 source_entry 原始 URL 与来源身份(值面反向断言)', () => {
    const row = richRow() as PublicMediaRow & Record<string, unknown>;
    // 模拟富内部行:即使上游误传内部列,投影也不得携带
    row.householdId = 'hh-1';
    row.sourceUrl = 'http://secret-upstream.example/stream.m3u8?token=topsecret';
    row.upstreamChannelId = 'upstream-tvg-secret-id';
    row.sourceId = 'src-a';
    row.location = '/nas-media/m-1.mp4';
    row.version = 3;
    row.contentRevision = 2;

    const serialized = JSON.stringify(toPublicMedia(row));
    expect(serialized).not.toContain('secret-upstream');
    expect(serialized).not.toContain('topsecret');
    expect(serialized).not.toContain('upstream-tvg-secret-id');
    expect(serialized).not.toContain('/nas-media/');
    expect(serialized).not.toContain('householdId');
    expect(serialized).not.toContain('sourceId');
    expect(serialized).not.toContain('location');
    expect(serialized).not.toContain('version');
    expect(serialized).not.toContain('contentRevision');
  });

  it('未认可外部 posterRef 置 null:任意外部 URL 不直接渲染', () => {
    for (const external of [
      'http://poster.example/x.jpg',
      'https://cdn.example/p/abc.png',
      '//cdn.example/protocol-relative.jpg',
      'data:image/png;base64,AAAA',
      '/nas-media/poster.jpg',
    ]) {
      const dto = toPublicMedia(richRow({ posterRef: external }));
      expect(dto.posterRef, `外部 posterRef 必须置 null:${external}`).toBeNull();
    }
  });

  it('posterRef 为 null 输入 → null(当前部署无同源海报端点,认可集合为空)', () => {
    expect(toPublicMedia(richRow({ posterRef: null })).posterRef).toBeNull();
  });

  it('availability 映射:家庭级可用 → available;失效 → unavailable 摘要', () => {
    expect(toPublicMedia(richRow({ available: true })).availability).toBe('available');
    expect(toPublicMedia(richRow({ available: false })).availability).toBe('unavailable');
    // 失效摘要仍保留元数据(title/等级),不丢字段
    const unavailable = toPublicMedia(richRow({ available: false }));
    expect(unavailable.title).toBe('某影片');
    expect(unavailable.contentLevel).toBe(12);
  });

  it('nullable 字段透传:description/contentLevel 为 null 保留 null(不被空串/0 替换)', () => {
    const dto = toPublicMedia(richRow({ description: null, contentLevel: null }));
    expect(dto.description).toBeNull();
    expect(dto.contentLevel).toBeNull();
  });

  it('全部媒体类型原样投影(channel/movie/series/episode/video)', () => {
    for (const type of ['channel', 'movie', 'series', 'episode', 'video'] as const) {
      expect(toPublicMedia(richRow({ type })).type).toBe(type);
    }
  });
});
