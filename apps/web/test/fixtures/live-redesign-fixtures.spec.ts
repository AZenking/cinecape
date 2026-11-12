/**
 * 015 T005 · 直播重构夹具自检(纯数据模块,无 React/无网络)。
 *
 * 断言三类不变量,保证后续 US1~US5 消费该夹具时前提成立:
 * 1. 形状:全部导出满足 @hmp/shared 契约类型(编译期注解 + 运行时字段抽查);
 * 2. 时间:每个频道 current 时间窗与 NOW 严格相交(startsAt < NOW < endsAt)、
 *    next 起始在 NOW 之后且与 current 不重叠;相对时间工具可精确复算;
 * 3. 隔离:构造器返回全新实例,边角形态经 overrides 可构造(current/next 双 null)。
 */

import { describe, expect, it } from 'vitest';
import type { ChannelPageDto, ChannelRowDto, GroupPageDto } from '@hmp/shared';
import {
  ALL_GROUP_KEY,
  LIVE_REDESIGN_CATALOG_REVISION,
  LIVE_REDESIGN_CHANNELS,
  LIVE_REDESIGN_CHANNELS_BY_GROUP,
  LIVE_REDESIGN_GROUPS,
  LIVE_REDESIGN_NOW_ISO,
  LIVE_REDESIGN_TIMEZONE,
  buildChannelListPage,
  buildChannelRow,
  buildChannelRows,
  buildGroupPage,
  buildProgramme,
  buildProgrammes,
  minutesFromNow,
  windowFromMinutes,
} from './live-redesign-fixtures';

const NOW_MS = Date.parse(LIVE_REDESIGN_NOW_ISO);

/** 编译期类型满足检查(通过即证明夹具与 @hmp/shared 契约同形) */
const typedGroupPage: GroupPageDto = buildGroupPage();
const typedChannelListPage: ChannelPageDto = buildChannelListPage();
const typedRows: ChannelRowDto[] = buildChannelRows();

describe('015 夹具 · 分组(GROUP)形状', () => {
  it('至少含 3 个分类组,且包含电影/音乐/体育', () => {
    const keys = LIVE_REDESIGN_GROUPS.map((group) => group.key);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(keys).toEqual(expect.arrayContaining(['movie', 'music', 'sports']));
    for (const group of LIVE_REDESIGN_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
    }
  });

  it('buildGroupPage 返回 GroupPageDto 同形快照(now/timezone/catalogRevision)', () => {
    expect(typedGroupPage.items).toHaveLength(LIVE_REDESIGN_GROUPS.length);
    expect(typedGroupPage.now).toBe(LIVE_REDESIGN_NOW_ISO);
    expect(typedGroupPage.timezone).toBe(LIVE_REDESIGN_TIMEZONE);
    expect(typedGroupPage.catalogRevision).toBe(LIVE_REDESIGN_CATALOG_REVISION);
  });

  it('「全部」为前端伪分组键,不混入服务端分组清单', () => {
    const keys = typedGroupPage.items.map((group) => group.key);
    expect(keys).not.toContain(ALL_GROUP_KEY);
  });
});

describe('015 夹具 · 时间工具(NOW 锚定可复算)', () => {
  it('minutesFromNow 由固定 NOW 精确推导(未来/过去)', () => {
    expect(minutesFromNow(60)).toBe('2026-11-15T13:00:00.000Z');
    expect(minutesFromNow(-30)).toBe('2026-11-15T11:30:00.000Z');
    expect(minutesFromNow(0)).toBe(LIVE_REDESIGN_NOW_ISO);
  });

  it('windowFromMinutes 返回有序窗;相交窗严格包含 NOW', () => {
    const window = windowFromMinutes(-20, 40);
    expect(Date.parse(window.startsAt)).toBe(NOW_MS - 20 * 60_000);
    expect(Date.parse(window.endsAt)).toBe(NOW_MS + 40 * 60_000);
    expect(window.startsAt < LIVE_REDESIGN_NOW_ISO).toBe(true);
    expect(window.endsAt > LIVE_REDESIGN_NOW_ISO).toBe(true);
  });
});

describe('015 夹具 · 规范频道集(current 相交 NOW / next 在 NOW 之后)', () => {
  it('共 9 个频道(3 组 × 3),id 唯一且满足 uuid 形状', () => {
    expect(LIVE_REDESIGN_CHANNELS).toHaveLength(9);
    const ids = LIVE_REDESIGN_CHANNELS.map((row) => row.media.id);
    expect(new Set(ids).size).toBe(9);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('每个分组恰有 3 个频道,groupKey/groupLabel 与分组定义一致', () => {
    for (const group of LIVE_REDESIGN_GROUPS) {
      const rows = LIVE_REDESIGN_CHANNELS_BY_GROUP[group.key] ?? [];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.groupKey).toBe(group.key);
        expect(row.groupLabel).toBe(group.label);
      }
    }
  });

  it('每个频道 current 时间窗与 NOW 严格相交(startsAt < NOW < endsAt)', () => {
    for (const row of typedRows) {
      const current = row.current;
      expect(current).not.toBeNull();
      expect(current && current.startsAt < LIVE_REDESIGN_NOW_ISO).toBe(true);
      expect(current && current.endsAt > LIVE_REDESIGN_NOW_ISO).toBe(true);
    }
  });

  it('每个频道 next 起始在 NOW 之后,且不早于 current 结束(无重叠)', () => {
    for (const row of typedRows) {
      const current = row.current;
      const next = row.next;
      expect(next).not.toBeNull();
      expect(next && next.startsAt > LIVE_REDESIGN_NOW_ISO).toBe(true);
      expect(current && next && next.startsAt >= current.endsAt).toBe(true);
    }
  });

  it('每组首个频道带非空 posterRef(Logo 渲染断言用),其余为 null', () => {
    for (const group of LIVE_REDESIGN_GROUPS) {
      const [firstRow, ...restRows] = LIVE_REDESIGN_CHANNELS_BY_GROUP[group.key] ?? [];
      expect(firstRow?.media.posterRef ?? null).not.toBeNull();
      expect(restRows.every((row) => row.media.posterRef === null)).toBe(true);
    }
    for (const row of typedRows) {
      expect(row.media.type).toBe('channel');
      expect(row.media.availability).toBe('available');
    }
  });
});

describe('015 夹具 · 端点响应桩(list page / programmes)', () => {
  it('buildChannelListPage 返回全部分区页(9 频道;快照字段取锚点常量)', () => {
    expect(typedChannelListPage.items).toHaveLength(9);
    expect(typedChannelListPage.total).toBe(9);
    expect(typedChannelListPage.page).toBe(1);
    expect(typedChannelListPage.pageSize).toBe(9);
    expect(typedChannelListPage.now).toBe(LIVE_REDESIGN_NOW_ISO);
    expect(typedChannelListPage.timezone).toBe(LIVE_REDESIGN_TIMEZONE);
    expect(typedChannelListPage.catalogRevision).toBe(LIVE_REDESIGN_CATALOG_REVISION);
  });

  it('按 groupKey 过滤:仅保留对应分组频道并同步分页字段', () => {
    const movie = buildChannelListPage({ groupKey: 'movie' });
    expect(movie.items).toHaveLength(3);
    expect(movie.total).toBe(3);
    expect(movie.items.every((row) => row.groupKey === 'movie')).toBe(true);
  });

  it('overrides 可覆盖整页字段(pageSize/快照即时等)', () => {
    const page = buildChannelListPage({
      overrides: { pageSize: 6, now: minutesFromNow(-1) },
    });
    expect(page.pageSize).toBe(6);
    expect(page.now).toBe(minutesFromNow(-1));
    expect(page.items).toHaveLength(9); // overrides 只动页级字段
  });

  it('buildProgrammes 缺省取规范首频道节目,快照字段同形', () => {
    const programmes = buildProgrammes();
    const [firstRow] = LIVE_REDESIGN_CHANNELS;
    expect(programmes.status).toBe('available');
    expect(programmes.now).toBe(LIVE_REDESIGN_NOW_ISO);
    expect(programmes.timezone).toBe(LIVE_REDESIGN_TIMEZONE);
    const current = programmes.current;
    const next = programmes.next;
    expect(current).not.toBeNull();
    expect(next).not.toBeNull();
    expect(current?.title).toBe(firstRow?.current?.title);
    expect(next?.title).toBe(firstRow?.next?.title);
    expect(current && current.startsAt < LIVE_REDESIGN_NOW_ISO).toBe(true);
    expect(current && current.endsAt > LIVE_REDESIGN_NOW_ISO).toBe(true);
    expect(next && next.startsAt > LIVE_REDESIGN_NOW_ISO).toBe(true);
  });

  it('buildProgrammes 支持 current/next 整档覆盖(含 null 边角形态)', () => {
    const empty = buildProgrammes({ current: null, next: null, status: 'unavailable' });
    expect(empty.current).toBeNull();
    expect(empty.next).toBeNull();
    expect(empty.status).toBe('unavailable');
  });
});

describe('015 夹具 · 构造器隔离与边角形态', () => {
  it('buildChannelRows 每次返回全新数组与全新行对象,改动不污染常量', () => {
    const fresh = buildChannelRows();
    const [freshHead] = fresh;
    const [constantHead] = LIVE_REDESIGN_CHANNELS;
    expect(fresh).not.toBe(LIVE_REDESIGN_CHANNELS);
    expect(freshHead).not.toBe(constantHead);
    fresh.pop();
    if (freshHead) freshHead.groupLabel = '被污染的标签';
    expect(LIVE_REDESIGN_CHANNELS).toHaveLength(9);
    expect(constantHead?.groupLabel).toBe('电影');
    expect(buildChannelListPage().items).toHaveLength(9);
  });

  it('overrides 可构造无节目单频道(current/next 双 null;FR-012 同形)', () => {
    const bare = buildChannelRow(
      {
        id: 'b0000000-0000-4000-8000-0000000000ff',
        title: '信号调试台',
        groupKey: 'movie',
        groupLabel: '电影',
      },
      { current: null, next: null },
    );
    expect(bare.current).toBeNull();
    expect(bare.next).toBeNull();
    expect(bare.media.title).toBe('信号调试台');
  });

  it('buildProgramme 显式时间窗(负偏移=过去窗,构造非相交节目)', () => {
    const ended = buildProgramme({
      key: 'lr-prog-ended',
      title: '已播完节目',
      startsAtMinutes: -120,
      endsAtMinutes: -60,
    });
    expect(ended.endsAt < LIVE_REDESIGN_NOW_ISO).toBe(true);
    expect(Date.parse(ended.endsAt)).toBe(NOW_MS - 60 * 60_000);
  });
});
