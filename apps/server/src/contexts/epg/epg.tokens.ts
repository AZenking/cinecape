/**
 * epg 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - manual-epg-binding.service（getBindingState / listEpgCandidates / saveBinding /
 *   unbindBinding）：settings 消费；
 * - epg.service（getMediaProgrammes）：media-catalog 消费。
 *
 * 本上下文服务为纯函数模块（见 epg.module.ts 头注释惯例），无 @Injectable 类；
 * 令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口）。
 * infrastructure/catalog-revision.service 的 readCatalogRevision 为跨上下文消费的
 * 基础设施纯函数（live-tv），经 index.ts 再导出（非令牌面）。
 */
export const EPG_MANUAL_BINDING_PORT = Symbol('EPG_MANUAL_BINDING_PORT');
export const EPG_SERVICE_PORT = Symbol('EPG_SERVICE_PORT');
