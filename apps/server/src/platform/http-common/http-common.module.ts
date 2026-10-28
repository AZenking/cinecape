import { Module } from '@nestjs/common';
import { PublicContextService } from '@platform/http-common/public-context/public-context.service';
import { RateLimitService } from '@platform/http-common/rate-limit/rate-limit.service';

/**
 * http-common 基础设施模块(007-T018:原 src/common/common.module.ts 的 CommonModule
 * 随 common 迁入 platform/http-common 拆并更名,类名 HttpCommonModule,providers/exports 不变)
 * —— 仅有状态、需要跨模块共享单例的服务入组:
 * - PublicContextService:公开范围解析(/setup/status 与 /public/context 共用);
 * - RateLimitService:限频窗口表(全应用共享同一内存表,限频才跨路由累计)。
 *
 * 无状态 Guard/管道/装饰器(SessionGuard、CurrentProfileGuard、SettingsAccessGuard、
 * SameOriginGuard、RateLimitGuard、StrictBodyPipe 等)沿用既有惯例:具名导入直接
 * @UseGuards 挂载,不入模块 providers。消费方在自己的模块 `imports: [HttpCommonModule]`
 * 后即可注入上述两个服务;RateLimitGuard 的构造依赖(Reflector + RateLimitService)
 * 由消费方模块注入器解析,同样要求先 import HttpCommonModule。
 */
@Module({
  providers: [PublicContextService, RateLimitService],
  exports: [PublicContextService, RateLimitService],
})
export class HttpCommonModule {}
