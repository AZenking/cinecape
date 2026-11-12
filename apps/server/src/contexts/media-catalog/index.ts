/**
 * media-catalog 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型/纯函数；实现类禁止导出。
 */
export type { ICatalogAdminService } from './media-catalog.ports';
export { MEDIA_CATALOG_CATALOG_ADMIN_PORT } from './media-catalog.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export {
  addMediaStream,
  batchUpdateMediaVisibility,
  deleteMediaStream,
  listMediaStreams,
  patchMediaMetadata,
  queryCandidates,
  updateMediaStream,
  type AddStreamInput,
  type BatchVisibilityInput,
  type CandidateQueryInput,
  type ChannelStreamDto,
  type PatchMediaInput,
  type UpdateStreamInput,
} from './application/catalog-admin.service';

// —— 跨上下文必需的领域纯函数再导出（domain/public-media-projection）——
export { toPublicMedia } from './domain/public-media-projection';

// —— 010 T046:个人面 TitleProgress 读取(personal-data vod-history.service 消费)——
// ADR-0015 D1 seam 访问器(模块装配期绑定,同 policy loadAvailableMediaIdSet 的发布面
// 函数先例)与只读行类型;实现类(drizzle store)不出发布面。
export { mediaCatalogStore } from './application/media-catalog-store.port';
export type { VodParentFacet, VodEpisodePageRow } from './application/media-catalog-store.port';

// —— 014 T033:事务参与者工厂发布面收敛(sources 发布链消费)——
// internal-ports.md §2「发布参与者(channel_logo 注册表事务镜像)」的绑定工厂:US1 期间
// sources/infrastructure/sources-store.drizzle.ts 曾以唯一的跨上下文 infrastructure 深导入
// 边消费本文件,现经发布面显式导出消除该边(R2:跨上下文 import 唯一合法落点)。
// 仅导出工厂函数与镜像端口类型,实现类不出发布面(文件头白名单);消费者经各自域的
// 结构镜像类型(如 sources-store.port.ts 的 ChannelLogoParticipant)编译期对形。
export { createMediaCatalogTxParticipants } from './infrastructure/transaction-participants';
export type {
  ChannelLogoParticipantMirror,
  ChannelLogoSourceKind,
  ChannelLogoWinnerCommand,
  ChannelLogoWinnerRow,
} from './infrastructure/transaction-participants';
