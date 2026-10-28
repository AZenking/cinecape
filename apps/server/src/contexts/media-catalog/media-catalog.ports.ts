/**
 * media-catalog 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致（仅提取类型；实现对象在 media-catalog.module.ts 以
 * useValue + satisfies 对齐本文件接口）。
 */
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { CandidatePageDto, MediaDto } from '@hmp/shared';
import type { CandidateQueryInput, PatchMediaInput } from './application/catalog-admin.service';

/** catalog-admin.service 发布面（消费方：settings 候选/人工修正契约路由） */
export interface ICatalogAdminService {
  queryCandidates(context: SessionContext, input: CandidateQueryInput): Promise<CandidatePageDto>;
  patchMediaMetadata(mediaId: string, context: SessionContext, input: PatchMediaInput): Promise<MediaDto>;
}
