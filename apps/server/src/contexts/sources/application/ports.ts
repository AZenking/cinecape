/**
 * sources 发布面接口（实现类 implements 用，置于 application 层供同层 import；
 * 签名不含 platform 类型，无 r1-application 渗漏）。
 * IRefreshExecutorService 从类公开方法逐字提取（Nest 生命周期钩子不入发布面）；
 * ISourcesService（纯函数束签名）见根目录 sources.ports.ts。
 * 方法签名与实现逐字一致，仅提取类型。
 */
import type {
  RefreshDecisionInput,
  RefreshJobView,
  RequestRefreshInput,
} from './refresh-executor.service';

/** RefreshExecutorService 发布面（消费方：settings sources 契约路由；Nest 生命周期钩子不入发布面） */
export interface IRefreshExecutorService {
  requestRefresh(input: RequestRefreshInput): RefreshJobView;
  getRefreshJob(householdId: string, refreshId: string): RefreshJobView | null;
  runQueuedOnce(nowMs?: number): Promise<RefreshJobView | null>;
  recoverInterrupted(nowMs?: number): number;
  expireStaleConfirmations(nowMs?: number): number;
  confirmRefresh(input: RefreshDecisionInput): RefreshJobView;
  discardRefresh(input: RefreshDecisionInput): RefreshJobView;
}
