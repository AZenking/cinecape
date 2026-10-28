/**
 * epg 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致（仅提取类型；实现对象在 epg.module.ts 以
 * useValue + satisfies 对齐本文件接口）。
 */
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { EpgCandidatePageDto, EpgCandidateQueryRequest, ProgrammesDto } from '@hmp/shared';
import type {
  BindingStateQuery,
  DbHandle,
  ManualEpgBindingState,
  SaveManualBindingInput,
  UnbindManualBindingInput,
} from './application/manual-epg-binding.service';

/** manual-epg-binding.service 发布面（消费方：settings EPG 绑定契约路由） */
export interface IEpgManualBindingService {
  getBindingState(db: DbHandle, query: BindingStateQuery): ManualEpgBindingState;
  listEpgCandidates(householdId: string, input: EpgCandidateQueryRequest): EpgCandidatePageDto;
  saveBinding(db: DbHandle, input: SaveManualBindingInput): ManualEpgBindingState;
  unbindBinding(db: DbHandle, input: UnbindManualBindingInput): ManualEpgBindingState;
}

/** epg.service 发布面（消费方：media-catalog 详情页节目单） */
export interface IEpgService {
  getMediaProgrammes(context: SessionContext, mediaId: string): ProgrammesDto;
}
