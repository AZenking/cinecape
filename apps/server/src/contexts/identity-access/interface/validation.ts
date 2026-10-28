import type { ZodType } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';

/**
 * zod 请求体校验小管道:safeParse 失败统一抛 400 VALIDATION_FAILED,
 * detail 携带 issue 摘要(由 ProblemJsonFilter 渲染为 RFC 9457 problem+json)。
 */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, detail);
  }
  return result.data;
}
