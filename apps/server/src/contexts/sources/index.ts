/**
 * sources 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型；实现类禁止导出
 * （RefreshExecutorService 实例经模块令牌 exports 提供）。
 */
export type { IRefreshExecutorService } from './application/ports';
export type { ISourcesService } from './sources.ports';
export { REFRESH_EXECUTOR_PORT, SOURCES_SERVICE_PORT } from './sources.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单）——
export {
  confirmSourceRefresh,
  createSource,
  discardSourceRefresh,
  getSourceRefresh,
  listSourceRoots,
  listSources,
  requestSourceRefresh,
  updateSource,
  type CreateSourceInput,
  type JobActionBody,
  type ListSourcesQuery,
  type PatchSourceInput,
  type RequestRefreshBody,
} from './application/sources.service';

// —— 跨上下文必需的领域/基础设施面再导出 ——
export { findNasTargetDenial, isParsableRemoteUrl } from './domain/source-target.validation';
export type { SupportedMediaExtension } from './infrastructure/nas-scanner';
