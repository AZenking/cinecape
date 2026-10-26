import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { DomainError } from '../domain-error';

/**
 * 当前 Profile 上下文(T009,005 contracts/api.md §1 Profile 边界)——
 * CurrentProfileGuard 在 SessionGuard 之后校验「服务端当前 activeProfile」并写入请求,
 * 控制器经 `CurrentProfile()` 读取。me/播放等 Profile 边界专用。
 */
export interface ProfileContext {
  readonly id: string;
  readonly householdId: string;
  readonly accountId: string;
  readonly name: string;
  readonly avatar: string | null;
  readonly type: 'adult' | 'child';
}

export interface ProfileRequest extends Request {
  hmpProfileContext?: ProfileContext;
}

export function attachProfileContext(request: Request, profile: ProfileContext): void {
  (request as ProfileRequest).hmpProfileContext = profile;
}

export const CurrentProfile = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): ProfileContext =>
    resolveProfileContext(executionContext),
);

/** 参数解析器(守卫写入 → decorator 读取的唯一逻辑;可独立单测) */
export function resolveProfileContext(executionContext: ExecutionContext): ProfileContext {
  const request = executionContext.switchToHttp().getRequest<Request>();
  const profile = (request as ProfileRequest).hmpProfileContext;
  if (profile === undefined) {
    // 未经过 CurrentProfileGuard 即取用 = 边界装配错误,按未认证同形拒绝(不泄露装配细节)
    throw new DomainError(401, ProblemCodeConst.SESSION_INVALID, undefined);
  }
  return profile;
}
