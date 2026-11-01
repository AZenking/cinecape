/**
 * media-catalog 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型/纯函数；实现类禁止导出。
 */
export type { ICatalogAdminService } from './media-catalog.ports';
export { MEDIA_CATALOG_CATALOG_ADMIN_PORT } from './media-catalog.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export {
  patchMediaMetadata,
  queryCandidates,
  type CandidateQueryInput,
  type PatchMediaInput,
} from './application/catalog-admin.service';

// —— 跨上下文必需的领域纯函数再导出（domain/public-media-projection）——
export { toPublicMedia } from './domain/public-media-projection';

// —— 010 T046:个人面 TitleProgress 读取(personal-data vod-history.service 消费)——
// ADR-0015 D1 seam 访问器(模块装配期绑定,同 policy loadAvailableMediaIdSet 的发布面
// 函数先例)与只读行类型;实现类(drizzle store)不出发布面。
export { mediaCatalogStore } from './application/media-catalog-store.port';
export type { VodParentFacet, VodEpisodePageRow } from './application/media-catalog-store.port';
