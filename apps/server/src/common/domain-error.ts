import type { ProblemCode } from '@hmp/shared';

/**
 * 领域错误 —— 携带 HTTP status 与稳定 ProblemCode(shared 契约常量),
 * 由 ProblemJsonFilter 统一渲染为 RFC 9457 application/problem+json。
 */
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: ProblemCode,
    public detail?: string,
  ) {
    super(detail ?? code);
    this.name = 'DomainError';
  }
}
