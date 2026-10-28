/**
 * epg 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - manual-epg-binding.service（getBindingState / listEpgCandidates / saveBinding /
 *   unbindBinding）：settings 消费（008-T007 起无 db 参数，ADR-0015 D2）；
 * - epg.service（getMediaProgrammes）：media-catalog 消费。
 *
 * 本上下文服务为纯函数模块（见 epg.module.ts 头注释惯例），无 @Injectable 类；
 * 令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口）。
 * infrastructure/catalog-revision.service 的 readCatalogRevision 为跨上下文消费的
 * 基础设施纯函数（live-tv），经 index.ts 再导出（非令牌面）。
 *
 * 008-repository-extraction（ADR-0015 D1）：EPG_STORE 为仓储 seam 装配令牌——
 * epg.module.ts 以 useFactory 经 bindEpgStore 注入 Drizzle 实现，不经 HTTP 暴露、不导出。
 */
export const EPG_STORE = Symbol('EPG_STORE');
export const EPG_MANUAL_BINDING_PORT = Symbol('EPG_MANUAL_BINDING_PORT');
export const EPG_SERVICE_PORT = Symbol('EPG_SERVICE_PORT');
