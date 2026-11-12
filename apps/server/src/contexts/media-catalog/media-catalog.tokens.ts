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
 *
 * 008-repository-extraction（T010，ADR-0015 D1）：MEDIA_CATALOG_STORE 为装配期
 * 仓储 seam 绑定令牌（useFactory → bindMediaCatalogStore(drizzleMediaCatalogStore())），
 * 仅供 media-catalog.module.ts 内部装配使用，不入发布面（FR-006）。
 */
export const MEDIA_CATALOG_CATALOG_ADMIN_PORT = Symbol('MEDIA_CATALOG_CATALOG_ADMIN_PORT');

/** 装配期仓储 seam 绑定令牌（008-repository-extraction；不导出实现类，不入 index.ts） */
export const MEDIA_CATALOG_STORE = Symbol('MEDIA_CATALOG_STORE');

/**
 * 014 T010:频道 Logo 同源代理用例绑定令牌（createLogoProxyService 函数束；注入
 * SAFE_UPSTREAM_PORT + 部署许可列表，与 online-vod 海报代理装配同款）。本上下文
 * 控制器消费，不入跨上下文发布面（internal-ports §5:上游地址不进任何公共面）。
 */
export const MEDIA_CATALOG_LOGO_PROXY_SERVICE = Symbol('MEDIA_CATALOG_LOGO_PROXY_SERVICE');
