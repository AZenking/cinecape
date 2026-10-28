import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { DomainError, resolveDomainProblem, type PcProblemCode } from '@platform/http-common/domain-error';

/**
 * RFC 9457 全局异常过滤器(T010):一切错误统一输出 application/problem+json。
 * - DomainError → 其 status / code / detail;注册表码(003)缺省回退 title/detail;
 * - ZodError → 400 VALIDATION_FAILED(detail 含 issue 摘要);
 * - HttpException → response 已是对象(如 healthz 的 503 problem)则原样透传,否则包装;
 * - 未知错误 → 500,不向客户端泄露堆栈;
 * - 注册表码的附加响应头(如 429 IMPORT_QUEUE_FULL 的 Retry-After: 5)在此按 code 统一注入。
 */
const PROBLEM_TYPE_BASE = 'https://homemedia.local/problems';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  /**
   * 稳定错误码全集(T009 放宽):shared ProblemCode ∪ 005 §7 新增码(domain-error 登记处)
   * ∪ 'INTERNAL'(shared ProblemCode 目前缺 `INTERNAL` 键的契约缺口,补充后收紧)。
   */
  code: PcProblemCode | 'INTERNAL';
  detail?: string;
}

function problemType(code: string): string {
  return `${PROBLEM_TYPE_BASE}/${code.toLowerCase().replaceAll('_', '-')}`;
}

function titleFromCode(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function codeFromHttpStatus(status: number): PcProblemCode | 'INTERNAL' {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ProblemCodeConst.VALIDATION_FAILED;
    case HttpStatus.UNAUTHORIZED:
      return ProblemCodeConst.SESSION_INVALID;
    case HttpStatus.FORBIDDEN:
      return ProblemCodeConst.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ProblemCodeConst.NOT_FOUND;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ProblemCodeConst.NOT_READY;
    default:
      return 'INTERNAL';
  }
}

function wrap(status: number, code: PcProblemCode | 'INTERNAL', detail?: string): ProblemBody {
  return {
    type: problemType(code),
    title: titleFromCode(code),
    status,
    code,
    detail,
  };
}

const logger = new Logger('ProblemJsonFilter');

/**
 * 流后边界的安全日志摘要(R6):只含稳定码/状态等稳定定位信息,
 * 绝不包含 exception message/stack —— 原文可能携带路径/URL/query ticket/FFmpeg stderr。
 */
function safeSummary(exception: unknown): string {
  if (exception instanceof DomainError) return `code=${exception.code}`;
  if (exception instanceof ZodError) return 'code=VALIDATION_FAILED';
  if (exception instanceof HttpException) return `status=${exception.getStatus()}`;
  return 'code=UNKNOWN';
}

@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // 流后边界(004 contracts/api.md「媒体端点」:已发字节则关闭流,不能在字节流内注入 JSON):
    // headers 已发出后不再写 status/响应头/体,也不抛二次异常,
    // 只留一条不含原始诊断(路径/URL/stderr)的安全日志。
    if (response.headersSent) {
      logger.warn(`响应头已发送,丢弃迟到错误(流后边界): ${safeSummary(exception)}`);
      return;
    }

    const body = ProblemJsonFilter.buildProblem(exception);
    response.status(body.status);
    // 004 contracts/api.md 开头:所有响应 Cache-Control: no-store、Referrer-Policy: no-referrer。
    // 错误响应(含既有错误)统一附加这两个头 —— 纯新增头,不改变既有响应体语义。
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    // code → 附加响应头统一注入(注册表外无附加头,既有行为不变)
    const extraHeaders =
      exception instanceof DomainError ? resolveDomainProblem(exception.code)?.headers : undefined;
    if (extraHeaders) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        response.setHeader(name, value);
      }
    }
    response.json(body);
  }

  private static buildProblem(exception: unknown): ProblemBody {
    if (exception instanceof DomainError) {
      const spec = resolveDomainProblem(exception.code);
      return {
        type: problemType(exception.code),
        title: spec?.title ?? titleFromCode(exception.code),
        status: exception.status,
        code: exception.code,
        detail: exception.detail ?? spec?.detail,
      };
    }

    if (exception instanceof ZodError) {
      const detail = exception.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return wrap(HttpStatus.BAD_REQUEST, ProblemCodeConst.VALIDATION_FAILED, detail);
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload: unknown = exception.getResponse();
      // 已是 problem+json 结构的对象(如 healthz 的 503 problem,带 status+code)→ 原样透传;
      // Nest 内置错误对象({message,error,statusCode})等其余一律包装为 problem+json
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'status' in payload &&
        'code' in payload
      ) {
        return payload as ProblemBody;
      }
      const detail =
        typeof payload === 'string'
          ? payload
          : payload !== null && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
            ? payload.message
            : exception.message;
      return wrap(status, codeFromHttpStatus(status), detail);
    }

    // 未知错误:服务端日志保留诊断,响应不泄露堆栈
    logger.error(`未处理异常: ${exception instanceof Error ? exception.stack : String(exception)}`);
    return {
      type: problemType('INTERNAL'),
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL',
    };
  }
}
