/**
 * live-tv 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致（仅提取类型；实现对象在 live-tv.module.ts 以
 * useValue + satisfies 对齐本文件接口）。
 */
import type { ChannelAssociationCore, LiveChannelProjection } from './application/live-projection.service';

/** live-projection.service 发布面（消费方：personal-data favorites / epg 关联核心与 key 映射） */
export interface ILiveProjectionService {
  loadChannelAssociationCore(
    householdId: string,
    options?: { readonly mediaIds?: readonly string[] },
  ): ChannelAssociationCore;
  loadLiveChannelWindows(
    householdId: string,
    nowMs: number,
    options?: { readonly mediaIds?: readonly string[]; readonly includeProgrammes?: boolean },
  ): LiveChannelProjection[];
  programmeKeyOf(internalId: string): string;
}
