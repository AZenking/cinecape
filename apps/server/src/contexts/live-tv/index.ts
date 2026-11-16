/**
 * live-tv 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型/纯函数；实现类禁止导出。
 */
export type { ILiveProjectionService } from './live-tv.ports';
export { LIVE_TV_LIVE_PROJECTION_PORT } from './live-tv.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export {
  loadChannelAssociationCore,
  loadLiveChannelWindows,
  programmeKeyOf,
  type ChannelAssociationCore,
  type ChannelMetaRow,
  type LiveChannelProjection,
} from './application/live-projection.service';

// —— 跨上下文必需的领域纯函数再导出（domain/live-clock、domain/live-time）——
export { liveNowMs } from './domain/live-clock';
export { pickCurrentNext } from './domain/live-time';
export { normalizeChannelName } from './domain/channel-normalizer';
