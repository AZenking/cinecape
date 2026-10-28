/**
 * epg 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型/纯函数；实现类禁止导出。
 */
export type { IEpgManualBindingService, IEpgService } from './epg.ports';
export { EPG_MANUAL_BINDING_PORT, EPG_SERVICE_PORT } from './epg.tokens';

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
