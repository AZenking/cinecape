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
import type { ProblemCode } from '@hmp/shared';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { DomainError } from './domain-error';

/**
 * RFC 9457 全局异常过滤器(T010):一切错误统一输出 application/problem+json。
 * - DomainError → 其 status / code / detail;
 * - ZodError → 400 VALIDATION_FAILED(detail 含 issue 摘要);
 * - HttpException → response 已是对象(如 healthz 的 503 problem)则原样透传,否则包装;
 * - 未知错误 → 500,不向客户端泄露堆栈。
 */
const PROBLEM_TYPE_BASE = 'https://homemedia.local/problems';

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  /**
   * ⚠️ shared ProblemCode 目前缺 `INTERNAL` 键(契约缺口,补充后收紧为 ProblemCode);
   * 本文件不另建常量,仅在 500 分支使用该字面量并已上报。
   */
  code: ProblemCode | 'INTERNAL';
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

function codeFromHttpStatus(status: number): ProblemCode | 'INTERNAL' {
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

function wrap(status: number, code: ProblemCode | 'INTERNAL', detail?: string): ProblemBody {
  return {
    type: problemType(code),
    title: titleFromCode(code),
    status,
    code,
    detail,
  };
}

const logger = new Logger('ProblemJsonFilter');

@Catch()
export class ProblemJsonFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = ProblemJsonFilter.buildProblem(exception);
    response.status(body.status);
    response.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    response.json(body);
  }

  private static buildProblem(exception: unknown): ProblemBody {
    if (exception instanceof DomainError) {
      return {
        type: problemType(exception.code),
        title: titleFromCode(exception.code),
        status: exception.status,
        code: exception.code,
        detail: exception.detail,
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
