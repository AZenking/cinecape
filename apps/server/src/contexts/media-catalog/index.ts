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
