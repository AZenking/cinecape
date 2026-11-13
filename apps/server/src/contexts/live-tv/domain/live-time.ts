import type { ExperienceProgrammeDto } from '@hmp/shared';

/**
 * 直播时间判定核心(T057/T063;005 data-model §8、contracts/api.md §2、research R8):
 * - 当前节目 MUST 满足开始时间包含、结束时间不包含:start<=now<end;
 * - 重叠节目:「重叠当前节目选 startsAt 最近、同起点按 key 升序」—— 覆盖 now 的多条
 *   节目中取 startsAt 最大者,同起点按不透明 programme key 升序取第一;
 *   因此同一频道结构上至多返回一个当前节目;
 * - 下一节目为最早未来节目:start>now 的 startsAt 最小项;并列同起点同样按 key 升序;
 * - 节目间空档:无覆盖条目时 current=null(不误取相邻节目);无未来条目时 next=null;
 * - 跨午夜节目按 UTC 区间归属:区间覆盖 now 即当前,不做日历日截断
 *   (存储为 UTC ISO 文本,Date.parse 后做毫秒区间比较)。
 *
 * 本模块为纯函数:输入已解析的节目窗口(含不透明 key),输出引用同元素,不做 IO。
 */

/** 直播节目窗口输入(内部读取形态;key 已是公共不透明标识) */
export type LiveProgrammeInput = Pick<
  ExperienceProgrammeDto,
  'key' | 'title' | 'description' | 'posterRef' | 'startsAt' | 'endsAt'
>;

export interface LiveProgrammeWindows {
  readonly current: ExperienceProgrammeDto | null;
  readonly next: ExperienceProgrammeDto | null;
}

function toDto(input: LiveProgrammeInput): ExperienceProgrammeDto {
  return {
    key: input.key,
    title: input.title,
    description: input.description,
    posterRef: input.posterRef,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  };
}

/**
 * 从已排序或未排序的节目行中判定 current/next(固定 nowMs,不读系统时钟)。
 * 单次扫描:current 取覆盖 now 中 startsAt 最大者(同起点 key 升序),
 * next 取 startsAt>now 中 startsAt 最小者(同起点 key 升序)。
 */
export function pickCurrentNext(rows: readonly LiveProgrammeInput[], nowMs: number): LiveProgrammeWindows {
  let current: LiveProgrammeInput | null = null;
  let next: LiveProgrammeInput | null = null;
  for (const row of rows) {
    const startsAtMs = Date.parse(row.startsAt);
    const endsAtMs = Date.parse(row.endsAt);
    if (Number.isNaN(startsAtMs) || Number.isNaN(endsAtMs)) {
      continue; // 存储层不产生非法时间;防御性跳过,不伪造节目
    }
    if (startsAtMs <= nowMs && nowMs < endsAtMs) {
      // 重叠:startsAt 最近者胜;同起点 key 升序(稳定标识,不依赖行序)
      if (
        current === null ||
        startsAtMs > Date.parse(current.startsAt) ||
        (startsAtMs === Date.parse(current.startsAt) && row.key < current.key)
      ) {
        current = row;
      }
      continue;
    }
    if (startsAtMs > nowMs) {
      if (next === null || startsAtMs < Date.parse(next.startsAt) || (startsAtMs === Date.parse(next.startsAt) && row.key < next.key)) {
        next = row;
      }
    }
  }
  return { current: current === null ? null : toDto(current), next: next === null ? null : toDto(next) };
}
