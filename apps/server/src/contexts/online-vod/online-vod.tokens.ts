/**
 * online-vod 注入令牌集中地（010 contracts/internal-ports.md §1，T006）。
 *
 * 骨架阶段只定义 Symbol 令牌；对应端口接口由后续任务在各自文件中声明并绑定：
 * - ONLINE_VOD_PROVIDER_PORT：OnlineVodProviderPort（搜索/详情/候选匹配/导航），
 *   playback 等跨上下文消费；实现绑定归 T025/T028。
 * - ONLINE_VOD_LOCATION_PORT：OnlineVodLocationPort（playback 授权后取
 *   ResolvedVodInput，网络由基础设施实现）；实现绑定归 T042。
 * - ONLINE_VOD_STORE：装配期仓储 seam（对齐 SOURCES_STORE 惯例，ADR-0015 D1），
 *   useFactory 绑定 Drizzle 实现；不属跨上下文消费面，不进 index.ts 之外的发布。
 * - ONLINE_VOD_PUBLICATION_PARTICIPANT：OnlineVodPublicationParticipant 事务参与者，
 *   由 UnitOfWork 工作集经构造器注入（T016）；非 HTTP 发布面。
 *
 * 实现类一律不经 index.ts 导出；application 只引用纯 TS 端口。
 *
 * T085 注：VodMaterializationAssembly 的两处 `import()` 类型注解改为顶部
 * `import type`（eslint consistent-type-imports;纯类型改动,运行时零变化;
 * materialization.service 不回引本文件,无环）。
 */
import type {
  MaterializationServiceDeps,
  MaterializeTargetResolver,
} from './application/materialization.service';

export const ONLINE_VOD_PROVIDER_PORT = Symbol('ONLINE_VOD_PROVIDER_PORT');
export const ONLINE_VOD_LOCATION_PORT = Symbol('ONLINE_VOD_LOCATION_PORT');
export const ONLINE_VOD_STORE = Symbol('ONLINE_VOD_STORE');
export const ONLINE_VOD_PUBLICATION_PARTICIPANT = Symbol('ONLINE_VOD_PUBLICATION_PARTICIPANT');

/* ------------------------------------------------------------------ */
/* T031 装配令牌(模块内 provider 绑定;非跨上下文发布面,控制器同模块注入)  */
/* ------------------------------------------------------------------ */

/** VodCache 有界缓存单例(online-vod.module.ts 工厂;T028 search/preview 与 T031 resolveTarget 桥共享同一实例) */
export const VOD_CACHE = Symbol('VOD_CACHE');
/** 公共搜索用例(createVodSearchService 产物;public-vod.controller 注入) */
export const VOD_SEARCH_SERVICE = Symbol('VOD_SEARCH_SERVICE');
/** 公共预览用例(createVodPreviewService 产物;public-vod.controller 注入) */
export const VOD_PREVIEW_SERVICE = Symbol('VOD_PREVIEW_SERVICE');
/** 物化装配束(T031:materialize 依赖 + resolveTarget 桥 + 会话上下文版本读) */
export const VOD_MATERIALIZATION = Symbol('VOD_MATERIALIZATION');

/**
 * 物化装配束(T031 组合面;module 工厂产出,VodMaterializationController 注入)。
 * deps 形状即 T029 MaterializationServiceDeps;resolveTarget 为事务外目标解析桥
 * (interface/materialization.controller.ts createVodMaterializationTargetResolver)。
 */
export interface VodMaterializationAssembly {
  readonly deps: MaterializationServiceDeps;
  readonly resolveTarget: MaterializeTargetResolver;
  /** 设备会话当前 profile_context_version(幂等 scope 服务端现值;会话缺失 401) */
  readonly readProfileContextVersion: (deviceSessionId: string) => number;
}
