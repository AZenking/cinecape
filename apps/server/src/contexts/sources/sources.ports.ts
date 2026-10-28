/**
 * sources 发布面接口（跨上下文函数束部分）。
 * ISourcesService 为 sources.service 纯函数束签名（实现对象在 sources.module.ts 以
 * useValue + satisfies 对齐；executor 显式传参形态保持）。方法签名与实现逐字一致，
 * 仅提取类型。本文件置于上下文根目录：签名引用 platform SessionContext 类型
 * （r1-application 对 application 层禁 platform import，根目录文件不受层规则约束）。
 * IRefreshExecutorService（类接口，实现类 implements 用）见 application/ports.ts。
 */
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import type { RefreshDto, RootDto, SourceDto, SourcePageDto } from '@hmp/shared';
import type {
  CreateSourceInput,
  JobActionBody,
  ListSourcesQuery,
  PatchSourceInput,
  RequestRefreshBody,
} from './application/sources.service';
import type { RefreshExecutorService } from './application/refresh-executor.service';

/** sources.service 发布面（消费方：settings sources 契约路由；executor 显式传参形态保持） */
export interface ISourcesService {
  listSources(context: SessionContext, query: ListSourcesQuery): SourcePageDto;
  listSourceRoots(): RootDto[];
  createSource(context: SessionContext, input: CreateSourceInput): Promise<SourceDto>;
  updateSource(sourceId: string, context: SessionContext, input: PatchSourceInput): Promise<SourceDto>;
  requestSourceRefresh(
    executor: RefreshExecutorService,
    context: SessionContext,
    sourceId: string,
    input: RequestRefreshBody,
  ): Promise<RefreshDto>;
  getSourceRefresh(
    executor: RefreshExecutorService,
    context: SessionContext,
    refreshId: string,
  ): RefreshDto;
  confirmSourceRefresh(
    executor: RefreshExecutorService,
    context: SessionContext,
    refreshId: string,
    input: JobActionBody,
  ): Promise<RefreshDto>;
  discardSourceRefresh(
    executor: RefreshExecutorService,
    context: SessionContext,
    refreshId: string,
    input: JobActionBody,
  ): Promise<RefreshDto>;
}
