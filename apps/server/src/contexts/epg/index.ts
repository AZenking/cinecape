/**
 * epg 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型/纯函数；实现类禁止导出。
 */
export type {
  IEpgManualBindingService,
  IEpgProgrammePosterProxyService,
  IEpgProgrammePosterService,
  IEpgService,
} from './epg.ports';
export {
  EPG_MANUAL_BINDING_PORT,
  EPG_PROGRAMME_POSTER_PORT,
  EPG_PROGRAMME_POSTER_PROXY_PORT,
  EPG_SERVICE_PORT,
  TMDB_CLIENT_PORT,
} from './epg.tokens';

// —— 应用服务纯函数（T020 grep 实测跨上下文消费清单；008-T007 起无 db 参数，ADR-0015 D2）——
export {
  getBindingState,
  listEpgCandidates,
  saveBinding,
  unbindBinding,
  type BindingStateQuery,
  type ManualEpgBindingState,
  type SaveManualBindingInput,
  type UnbindManualBindingInput,
} from './application/manual-epg-binding.service';
export { getMediaProgrammes } from './application/epg.service';

// —— 跨上下文消费的基础设施纯函数再导出（infrastructure/catalog-revision.service）——
export { readCatalogRevision } from './infrastructure/catalog-revision.service';

// —— 020 TMDB 节目海报：纯函数/类型/服务工厂（sources/CLI 经发布面消费）——
export {
  normalizeProgrammeTitle,
  posterMatchKeyOf,
  type NormalizedProgrammeTitle,
} from './domain/programme-title';
export {
  matchProgrammePoster,
  type ProgrammePosterMatch,
  type TmdbPosterCandidate,
} from './domain/programme-poster-match';
export {
  createProgrammePosterService,
  type ProgrammePosterEnrichmentSummary,
  type ProgrammePosterRef,
  type ProgrammePosterService,
} from './application/programme-poster.service';
export { createTmdbClient, type TmdbClient } from './infrastructure/tmdb.client';

// T022a 补面：Nest 装配入口（sources.module `imports:` 消费；与 SourcesModule 惯例一致）
export { EpgModule } from './epg.module';
