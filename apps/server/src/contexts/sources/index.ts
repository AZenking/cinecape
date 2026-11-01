/**
 * sources 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型；实现类禁止导出
 * （RefreshExecutorService 实例经模块令牌 exports 提供）。
 */
export type { IRefreshExecutorService } from './application/ports';
export type { ISourcesService } from './sources.ports';
export { REFRESH_EXECUTOR_PORT, SOURCES_SERVICE_PORT } from './sources.tokens';

// —— 应用服务纯函数(T020 grep 实测跨上下文消费清单)——
export {
  confirmSourceRefresh,
  createSource,
  createVodSourceConfigurationPort,
  discardSourceRefresh,
  getSourceRefresh,
  listSourceRoots,
  listSources,
  requestSourceRefresh,
  testSource,
  updateSource,
  type CreateSourceInput,
  type JobActionBody,
  type ListSourcesQuery,
  type PatchSourceInput,
  type RequestRefreshBody,
  type SourceTestResultDto,
  type TestSourceInput,
  type VodSourceProbePort,
  type VodSourceRuntimeConfigurationPort,
} from './application/sources.service';

// —— 跨上下文必需的领域/基础设施面再导出 ——
export { findNasTargetDenial, isParsableRemoteUrl } from './domain/source-target.validation';
export type { SupportedMediaExtension } from './infrastructure/nas-scanner';

// T022a 补面：Nest 装配入口（settings.module `imports:` 消费；contracts 允许经
// 「Nest module 的 exports 提供者」装配；属装配面而非 application/infrastructure 实现类）
export { SourcesModule } from './sources.module';
