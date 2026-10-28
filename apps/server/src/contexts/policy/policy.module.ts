import { Module } from '@nestjs/common';
import { POLICY_BATCH_CONTEXT_PORT, POLICY_SERVICE_PORT, POLICY_STORE } from '@contexts/policy/policy.tokens';
import { loadAvailableMediaIdSet, loadBatchCatalogContext } from '@contexts/policy/application/policy.batch-context';
import {
  authorizeCurrentProfile,
  getPolicy,
  replacePolicyLists,
  updatePolicy,
} from '@contexts/policy/application/policy.service';
import { bindPolicyStore } from '@contexts/policy/application/policy-store.port';
import { drizzlePolicyStore } from '@contexts/policy/infrastructure/policy-store.drizzle';
import type { IPolicyBatchContextService, IPolicyService } from '@contexts/policy/policy.ports';

/**
 * Policy 模块(T011):策略管理契约路由。
 * 服务为纯函数模块(对齐 auth/profile 惯例),模块仅承载路由注册。
 * 授权入口 authorizeCurrentProfile 不经 HTTP 暴露;测试夹具经测试专用装配注入可信资源 reader,
 * 不注册到本模块或生产 AppModule(FR-015/plan)。
 *
 * 007-T021:发布面令牌装配 —— 跨上下文消费的应用服务以令牌 provider 发布
 * (纯函数模块经 useValue 函数束 + satisfies 对齐 ports 接口,零行为变化;
 * 测试专用 TrustedResourceReader 注入路径不变:authorizeCurrentProfile 仍以参数
 * 传入 reader,令牌束引用同一函数);exports 仅发布令牌,消费方迁移属 T022。
 *
 * 008-repository-extraction(ADR-0015 D1):装配期绑定仓储 seam ——
 * POLICY_STORE provider 实例化时经 bindPolicyStore 注入 Drizzle 实现
 * (惰性 getDb 解析,Database 单例重开安全);不经 HTTP 暴露,不导出。
 */
@Module({
  controllers: [],
  providers: [
    {
      provide: POLICY_STORE,
      useFactory: () => bindPolicyStore(drizzlePolicyStore()),
    },
    {
      provide: POLICY_BATCH_CONTEXT_PORT,
      useValue: { loadAvailableMediaIdSet, loadBatchCatalogContext } satisfies IPolicyBatchContextService,
    },
    {
      provide: POLICY_SERVICE_PORT,
      useValue: { authorizeCurrentProfile, getPolicy, updatePolicy, replacePolicyLists } satisfies IPolicyService,
    },
  ],
  exports: [POLICY_BATCH_CONTEXT_PORT, POLICY_SERVICE_PORT],
})
export class PolicyModule {}
