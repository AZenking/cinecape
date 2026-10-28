import type { ExperienceProgrammeDto } from '@hmp/shared';
import {
  loadChannelAssociationCore,
  type ChannelAssociationCore,
  type ChannelMetaRow,
} from '../../../modules/live/live-projection.service';
import { pickCurrentNext } from '../../../modules/live/live-time';

/**
 * EPG 关联核心复用层(T113;US6 guide 窗口查询的唯一关联入口):
 *
 * - 「复用T063已提取的不含策略关联核心,不重复新建第二套匹配算法」—— manual 优先、
 *   manual 失效不自动回退、否则自动精确关联的解析核心现位于
 *   modules/live/live-projection.service.ts 的 `loadChannelAssociationCore`
 *   (T063 内联逻辑平移为独立导出,语义逐字不变,live 投影自身同样消费);
 *   本文件不复制任何匹配逻辑,仅作为 modules/epg 侧的类型化引用面,
 *   供 guide-window.service 与单元测试绑定同一实现。
 * - 可用性集合(join 链一致、无 ProfilePolicy 语义)与关联映射先集合计算,
 *   programme 窗口随后批量获取 —— 「不在循环调用单频道授权服务」由消费方
 *   (guide-window.service)保证:每页频道一次批量窗口查询。
 * - 当前判定沿用 R8(start<=now<end;重叠取 startsAt 最近、同起点按不透明 key 升序):
 *   复用 live-time 的 pickCurrentNext 核心,不建第二套时间判定。
 */

/** 关联核心结果类型(与 live 实现同型;guide 消费 channelRows/availableIds/associationByMedia) */
export type { ChannelAssociationCore, ChannelMetaRow };

/** 关联核心装载(固定 6 次集合查询;语义与 live 投影完全一致) */
export const loadChannelAssociations = loadChannelAssociationCore;

/**
 * EPG 墙「当前节目」判定(纯函数;R8 逐字):
 * 取窗口内节目行中覆盖 now(start<=now<end)的 startsAt 最近者,同起点按 key 升序;
 * 无覆盖行为 null(空档不误取相邻节目)。
 */
export function pickGuideCurrent(
  rows: readonly (Pick<ExperienceProgrammeDto, 'key' | 'title' | 'description' | 'startsAt' | 'endsAt'>)[],
  nowMs: number,
): ExperienceProgrammeDto | null {
  return pickCurrentNext(rows, nowMs).current;
}
