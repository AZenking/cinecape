/**
 * media-catalog 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - catalog-admin.service（queryCandidates / patchMediaMetadata）：settings 消费。
 *
 * 本上下文服务为纯函数模块惯例（PublicCatalogService 仅本上下文控制器消费，不入
 * 令牌面）；令牌绑定经 useValue 函数束（T021，`satisfies` 对齐对应接口）。
 * domain/public-media-projection 的 toPublicMedia 为跨上下文必需的领域纯函数，
 * 经 index.ts 再导出（非令牌面）。
 */
export const MEDIA_CATALOG_CATALOG_ADMIN_PORT = Symbol('MEDIA_CATALOG_CATALOG_ADMIN_PORT');
