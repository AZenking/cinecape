import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicyName } from './rate-limit.policies';

/**
 * 限频策略标注(T009 底座)—— 与 RateLimitGuard 配对,本任务不挂任何路由:
 *
 *   @Controller('public')
 *   @UseGuards(RateLimitGuard)                    // 守卫读本标注;无标注直接放行
 *   export class PublicCatalogController {
 *     @Get('media')
 *     @RateLimit('public')                        // 每 IP 120 次/分钟
 *     listMedia() { ... }
 *   }
 *
 * 标注可挂在方法或控制器类上(方法优先);类级标注适合同策略整组路由。
 */
export const RATE_LIMIT_POLICY_METADATA_KEY = 'hmp:rate-limit-policy';

export const RateLimit = (policy: RateLimitPolicyName): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_POLICY_METADATA_KEY, policy);
