import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

/**
 * 访问日志拦截器(T041):只记录 method / url / status / 耗时。
 * **严禁**记录请求体、响应体或任何头部 —— 凭据脱敏的根策略是"不采集",
 * 结构化数据确需入日志时必须先过 redactForLog(log-redaction.util.ts)。
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const method = request.method;
    const url = request.originalUrl ?? request.url;

    return next.handle().pipe(
      tap({
        next: () => {
          const response = http.getResponse<Response>();
          this.logger.log(`${method} ${url} ${response.statusCode} +${Date.now() - start}ms`);
        },
        error: () => {
          // 状态码与耗时由过滤器/框架记录;此处仅补充耗时,不带任何请求上下文数据
          this.logger.warn(`${method} ${url} failed +${Date.now() - start}ms`);
        },
      }),
    );
  }
}
