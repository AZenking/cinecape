import type { ExperienceProgrammeDto } from '@hmp/shared';

/**
 * 直播分区排序与分页核心(T059/T065;A-007 原文):
 * 「正在直播与即将播放分别按当前节目结束时间、下一节目开始时间排序,
 *   同时间按频道名称和稳定标识排序」
 * - section=now:仅含 current 非 null 的行,按 current.endsAt 升序 → title → mediaId;
 * - section=next:仅含 next 非 null 的行,按 next.startsAt 升序 → title → mediaId;
 *   不施加任何未确认的时间窗口限制(如「2 小时内」),远期 next 同样进入排序;
 * - section=all/group:按 title → mediaId(无节目可用频道同样参与,可分页遍历);
 * - 分页:默认 20(api.md §2「pageSize=20/max50」),上限 50 由查询管道以 400 兜底,
 *   本核心对调用方传入值做防御性钳制;total 为过滤后全集大小,越界页返回空列表。
 *
 * 本模块为纯函数;比较全部基于原始字符串/ID,重复运行结果稳定。
 */

export type LiveSectionName = 'now' | 'next' | 'group' | 'all';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** 参与分区排序的行投影(ChannelRow 的可排序子集) */
export interface SectionSortableRow {
  readonly mediaId: string;
  readonly title: string;
  readonly groupKey: string;
  readonly current: Pick<ExperienceProgrammeDto, 'endsAt'> | null;
  readonly next: Pick<ExperienceProgrammeDto, 'startsAt'> | null;
}

/** 频道名称、稳定标识的次级排序(全 section 通用,保证同键稳定) */
function byTitleThenId(left: SectionSortableRow, right: SectionSortableRow): number {
  if (left.title !== right.title) {
    return left.title < right.title ? -1 : 1;
  }
  if (left.mediaId !== right.mediaId) {
    return left.mediaId < right.mediaId ? -1 : 1;
  }
  return 0;
}

/**
 * 分区排序:返回新数组(不修改入参);now/next 区剔除无节目行,
 * all/group 区保留全部行(含无 EPG 可用频道)。
 */
export function sortChannelRows<T extends SectionSortableRow>(rows: readonly T[], section: LiveSectionName): T[] {
  const copy = [...rows];
  if (section === 'now') {
    return copy
      .filter((row): row is T & { current: NonNullable<T['current']> } => row.current !== null)
      .sort((left, right) => {
        if (left.current.endsAt !== right.current.endsAt) {
          return left.current.endsAt < right.current.endsAt ? -1 : 1;
        }
        return byTitleThenId(left, right);
      });
  }
  if (section === 'next') {
    return copy
      .filter((row): row is T & { next: NonNullable<T['next']> } => row.next !== null)
      .sort((left, right) => {
        if (left.next.startsAt !== right.next.startsAt) {
          return left.next.startsAt < right.next.startsAt ? -1 : 1;
        }
        return byTitleThenId(left, right);
      });
  }
  // all / group:名称 + 稳定标识
  return copy.sort(byTitleThenId);
}

export interface PagedResult<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/**
 * 页码分页(防御性钳制:pageSize 超上限钳到 50;<1/非整数回落默认 20;page ≥1 非法回落 1)。
 * 契约级上限(>50 → 400)由控制器查询管道负责,此处不抛错。
 */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): PagedResult<T> {
  let safeSize: number;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    safeSize = DEFAULT_PAGE_SIZE;
  } else {
    safeSize = Math.min(pageSize, MAX_PAGE_SIZE);
  }
  const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total: items.length,
  };
}
