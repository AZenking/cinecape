import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { DomainError } from '../domain-error';
import type { SessionRequest } from '../current-session.decorator';
import { RATE_LIMIT_POLICY_METADATA_KEY } from './rate-limit.decorator';
import type { RateLimitPolicyName } from './rate-limit.policies';
import { RateLimitService, sharedRateLimitService } from './rate-limit.service';
import { clientIpOf } from './client-ip.util';

/**
 * 限频守卫(T009 底座,005 contracts/api.md §1)—— 与 @RateLimit(policy) 标注配对;
 * 无标注的路由直接放行(本底座不改变未接入路由的行为,T009 不挂任何路由)。
 *
 * key 解析:
 * - scope=ip(public/guide):客户端 IP(env.TRUST_PROXY 显式控制转发头信任,见
 *   client-ip.util);
 * - scope=deviceSession(progress):SessionGuard 写入的会话上下文取 session.id;
 *   上下文缺失(守卫先于 SessionGuard 挂载/装配遗漏)回落按 IP 计数 —— 方向安全:
 *   不产生放行窗口,后续 SessionGuard 仍会拒绝未认证请求。
 *
 * 超限:429 + Retry-After(秒,由窗口余量动态计算后在此注入响应头;问题注册表
 * 不持静态 Retry-After,同 004 播放限频口径)。稳定码沿用既有 429 限频码
 * PLAYBACK_RATE_LIMITED(§7「保留既有……限频 429」,已有码优先);若后续契约
 * 测试钉死新码,仅需调整本处构造,限频器与守卫骨架不变。
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly rateLimit: RateLimitService;
  private readonly reflector: Reflector;

  /**
   * 构造参数带缺省值:本仓库运行时(esbuild/tsx 编译)不产出 design:paramtypes
   * 元数据,Nest DI 解析不到构造参数时以 undefined 调用 —— 缺省回落到共享限频
   * 单例与独立 Reflector,保证 @UseGuards(RateLimitGuard) 免模块装配即可挂载,
   * 且限频表全应用共享一份(「限频才跨路由累计」语义不变)。
   * 经完整 DI 装配的环境传入实例时行为不变。
   */
  constructor(rateLimit?: RateLimitService, reflector?: Reflector) {
    this.rateLimit = rateLimit ?? sharedRateLimitService();
    this.reflector = reflector ?? new Reflector();
  }

  canActivate(context: ExecutionContext): boolean {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicyName>(RATE_LIMIT_POLICY_METADATA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (policy === undefined) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const outcome = this.rateLimit.acquire(policy, scopeValueOf(policy, request));
    if (!outcome.ok) {
      (http.getResponse<Response>()).setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw new DomainError(429, ProblemCodeConst.PLAYBACK_RATE_LIMITED, undefined);
    }
    return true;
  }
}

/** 按策略作用域解析计数键(不含策略名,策略名由限频器拼接) */
function scopeValueOf(policy: RateLimitPolicyName, request: Request): string {
  if (policy === 'progress') {
    const session = (request as SessionRequest).hmpSessionContext;
    if (session !== undefined) {
      return `device-session:${session.session.id}`;
    }
    // 上下文缺失回落 IP:不产生放行窗口(方向安全的保守计数)
  }
  return `ip:${clientIpOf(request)}`;
}
