import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';

/**
 * API 安全响应头拦截器(T009,005 contracts/api.md §1)——
 * 「所有响应包括错误 Cache-Control: no-store;播放与凭据相关响应
 * Referrer-Policy: no-referrer。」
 *
 * 实现方式选择(报告口径):**全局 NestJS 拦截器**,不按路径前缀白名单 ——
 * 契约要求的是「所有响应包括错误」一律 no-store,豁免清单恒为空,按前缀筛选
 * 只会增加漏挂面;拦截器作用域 = 全部控制器路由(/api/**,含错误经
 * ProblemJsonFilter 渲染的响应,过滤器另有一层同值兜底),静态 Web 资源
 * (web/dist,express static 直接交付)天然不在拦截器管线内,保持可缓存。
 * Referrer-Policy 对全部 API 响应下发,是「播放与凭据相关」要求的严格超集,
 * 避免「凭据相关」的判定面扩散。
 *
 * 头部在进入控制器前设置;若某端点未来显式覆盖 Cache-Control(当前无此需求),
 * 以端点为准 —— 契约变更时应收紧而非依赖本拦截器兜底。
 */
@Injectable()
export class ApiSecurityHeadersInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    if (!response.headersSent) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
    }
    return next.handle();
  }
}
