import { Module } from '@nestjs/common';
import { PublicContextService } from './public-context/public-context.service';
import { RateLimitService } from './rate-limit/rate-limit.service';

/**
 * common 基础设施模块(T009)—— 仅有状态、需要跨模块共享单例的服务入组:
 * - PublicContextService:公开范围解析(/setup/status 与 /public/context 共用);
 * - RateLimitService:限频窗口表(全应用共享同一内存表,限频才跨路由累计)。
 *
 * 无状态 Guard/管道/装饰器(SessionGuard、CurrentProfileGuard、SettingsAccessGuard、
 * SameOriginGuard、RateLimitGuard、StrictBodyPipe 等)沿用既有惯例:具名导入直接
 * @UseGuards 挂载,不入模块 providers。消费方在自己的模块 `imports: [CommonModule]`
 * 后即可注入上述两个服务;RateLimitGuard 的构造依赖(Reflector + RateLimitService)
 * 由消费方模块注入器解析,同样要求先 import CommonModule。
 */
@Module({
  providers: [PublicContextService, RateLimitService],
  exports: [PublicContextService, RateLimitService],
})
export class CommonModule {}
