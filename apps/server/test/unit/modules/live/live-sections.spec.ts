import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginate,
  sortChannelRows,
  type SectionSortableRow,
} from '@contexts/live-tv/domain/live-sections';

/**
 * 直播分区排序与分页单元测试(T059;A-007 原文):
 * 「正在直播与即将播放分别按当前节目结束时间、下一节目开始时间排序,
 *   同时间按频道名称和稳定标识排序」
 * - section=now/next/group/all 顺序在重复运行下稳定;
 * - 即将播放不施加未确认的 2 小时窗口限制(ui.md §5);
 * - 每区默认 20 项可继续查看;pageSize 上限 50(api.md §2「pageSize=20/max50」);
 * - 分页可遍历包含无 EPG 可用频道(current/next=null 的行也参与 all/group 分页)。
 */

/** 固定锚点(不依赖系统时钟;仅用于构造可比较的结束/开始时间) */
const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function row(input: {
  mediaId: string;
  title: string;
  currentEndsAtMs?: number;
  nextStartsAtMs?: number;
  groupKey?: string;
}): SectionSortableRow {
  return {
    mediaId: input.mediaId,
    title: input.title,
    groupKey: input.groupKey ?? 'g-other',
    current:
      input.currentEndsAtMs === undefined
        ? null
        : { endsAt: iso(input.currentEndsAtMs) },
    next:
      input.nextStartsAtMs === undefined
        ? null
        : { startsAt: iso(input.nextStartsAtMs) },
  };
}

const SAMPLE: SectionSortableRow[] = [
  row({ mediaId: 'm-3', title: 'Chan-C', currentEndsAtMs: NOW_MS + 1_800_000 }),
  row({ mediaId: 'm-1', title: 'Chan-A', currentEndsAtMs: NOW_MS + 600_000 }),
  row({ mediaId: 'm-2', title: 'Chan-B', currentEndsAtMs: NOW_MS + 600_000 }),
  row({ mediaId: 'm-4', title: 'Chan-D', currentEndsAtMs: NOW_MS + 600_000, nextStartsAtMs: NOW_MS + 3_600_000 }),
];

describe('sortChannelRows(A-007 排序)', () => {
  it('section=now 按当前节目结束时间升序;同时间按频道名称、稳定标识排序', () => {
    const sorted = sortChannelRows(SAMPLE, 'now');
    expect(sorted.map((item) => item.mediaId)).toEqual(['m-1', 'm-2', 'm-4', 'm-3']);
    // m-1/m-2/m-4 结束时间相同 → 频道名称升序;若同名再按 mediaId
  });

  it('section=next 按下一节目开始时间升序;同时间按频道名称、稳定标识排序', () => {
    const rows: SectionSortableRow[] = [
      row({ mediaId: 'b-2', title: 'Same-Name', nextStartsAtMs: NOW_MS + 1_800_000 }),
      row({ mediaId: 'a-9', title: 'Same-Name', nextStartsAtMs: NOW_MS + 1_800_000 }),
      row({ mediaId: 'c-1', title: 'Alpha', nextStartsAtMs: NOW_MS + 600_000 }),
      row({ mediaId: 'd-1', title: 'Omega', nextStartsAtMs: NOW_MS + 7 * 3_600_000 }),
    ];
    const sorted = sortChannelRows(rows, 'next');
    expect(sorted.map((item) => item.mediaId)).toEqual(['c-1', 'a-9', 'b-2', 'd-1']);
  });

  it('同时间同名频道按稳定标识(mediaId)排序,重复运行结果稳定', () => {
    const rows: SectionSortableRow[] = [
      row({ mediaId: 'm-b', title: '同名', currentEndsAtMs: NOW_MS + 600_000 }),
      row({ mediaId: 'm-a', title: '同名', currentEndsAtMs: NOW_MS + 600_000 }),
    ];
    const first = sortChannelRows(rows, 'now').map((item) => item.mediaId);
    const second = sortChannelRows(rows, 'now').map((item) => item.mediaId);
    expect(first).toEqual(['m-a', 'm-b']);
    expect(first).toEqual(second);
  });

  it('section=all/group 按频道名称与稳定标识排序;无节目频道(current/next=null)同样参与', () => {
    const rows: SectionSortableRow[] = [
      row({ mediaId: 'm-2', title: 'Chan-B' }),
      row({ mediaId: 'm-1', title: 'Chan-A', currentEndsAtMs: NOW_MS + 600_000 }),
    ];
    expect(sortChannelRows(rows, 'all').map((item) => item.mediaId)).toEqual(['m-1', 'm-2']);
    expect(sortChannelRows(rows, 'group').map((item) => item.mediaId)).toEqual(['m-1', 'm-2']);
  });

  it('中文频道名按稳定码元序排序(跨运行确定,不做 ICU 语言排序)', () => {
    // 丁(U+4E01) < 乙(U+4E59) < 甲(U+7532):实现按 UTF-16 码元升序,重复运行稳定
    const rows: SectionSortableRow[] = [
      row({ mediaId: 'm-jia', title: '频道甲', currentEndsAtMs: NOW_MS + 600_000 }),
      row({ mediaId: 'm-yi', title: '频道乙', currentEndsAtMs: NOW_MS + 600_000 }),
      row({ mediaId: 'm-ding', title: '频道丁', currentEndsAtMs: NOW_MS + 600_000 }),
    ];
    expect(sortChannelRows(rows, 'now').map((item) => item.mediaId)).toEqual(['m-ding', 'm-yi', 'm-jia']);
  });

  it('即将播放不施加 2 小时窗口:next 在数小时/跨日之外仍进入 next 区排序', () => {
    const far = row({ mediaId: 'm-far', title: '远期频道', nextStartsAtMs: NOW_MS + 26 * 3_600_000 });
    const sorted = sortChannelRows([far, row({ mediaId: 'm-near', title: '近期频道', nextStartsAtMs: NOW_MS + 600_000 })], 'next');
    expect(sorted.map((item) => item.mediaId)).toEqual(['m-near', 'm-far']);
  });
});

describe('paginate(每区 20 项可继续查看;pageSize 上限 50)', () => {
  it('默认 pageSize=20;total 为全集大小,可继续翻页', () => {
    const items = Array.from({ length: 45 }, (_, index) => row({ mediaId: `m-${index}`, title: `频道 ${index}` }));
    const page1 = paginate(items, 1, DEFAULT_PAGE_SIZE);
    expect(page1.pageSize).toBe(20);
    expect(page1.items).toHaveLength(20);
    expect(page1.total).toBe(45);
    const page3 = paginate(items, 3, DEFAULT_PAGE_SIZE);
    expect(page3.items).toHaveLength(5);
    // 越界页返回空列表而非报错
    expect(paginate(items, 4, DEFAULT_PAGE_SIZE).items).toHaveLength(0);
  });

  it('pageSize 防御性钳制到上限 50(契约上限由查询管道 400 兜底)', () => {
    const items = Array.from({ length: 120 }, (_, index) => row({ mediaId: `m-${index}`, title: `频道 ${index}` }));
    expect(MAX_PAGE_SIZE).toBe(50);
    expect(paginate(items, 1, 500).items).toHaveLength(50);
    expect(paginate(items, 1, 500).pageSize).toBe(50);
    expect(paginate(items, 1, 0).items).toHaveLength(20); // 非法值回落默认
  });

  it('分页遍历覆盖无 EPG 可用频道:current/next=null 的行保留在 all/group 页中', () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      row({ mediaId: `m-${String(index).padStart(2, '0')}`, title: `频道 ${index}` }),
    );
    const page2 = paginate(items, 2, 20);
    expect(page2.items).toHaveLength(5);
    expect(page2.items.every((item) => item.current === null && item.next === null)).toBe(true);
  });
});
