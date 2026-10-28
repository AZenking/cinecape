/**
 * live-tv 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - live-projection.service（loadLiveChannelWindows / programmeKeyOf /
 *   loadChannelAssociationCore）：personal-data / epg 消费。
 *
 * 本上下文服务为纯函数模块（见 live-tv.module.ts 头注释惯例），无 @Injectable 类；
 * 令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口）。
 * domain/live-clock（liveNowMs）与 domain/live-time（pickCurrentNext）为跨上下文必需的
 * 领域纯函数，经 index.ts 再导出（非令牌面）。
 */
export const LIVE_TV_LIVE_PROJECTION_PORT = Symbol('LIVE_TV_LIVE_PROJECTION_PORT');
