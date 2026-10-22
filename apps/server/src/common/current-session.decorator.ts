import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { DomainError } from './domain-error';

/**
 * 会话上下文(T012):SessionGuard 校验通过后写入请求,
 * 控制器经 `CurrentSession()` 读取。
 */
export interface SessionContext {
  session: {
    id: string;
    householdId: string;
    accountId: string;
    deviceId: string;
    /** 服务端维护的当前观看者,可能为空(未选择 Profile) */
    activeProfileId: string | null;
    expiresAt: string;
  };
  account: {
    id: string;
    householdId: string;
    username: string;
    role: 'owner' | 'admin';
  };
}

export interface SessionRequest extends Request {
  hmpSessionContext?: SessionContext;
}

export function attachSessionContext(request: Request, context: SessionContext): void {
  (request as SessionRequest).hmpSessionContext = context;
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, executionContext: ExecutionContext): SessionContext => {
    const request = executionContext.switchToHttp().getRequest<Request>();
    const context = (request as SessionRequest).hmpSessionContext;
    if (context === undefined) {
      throw new DomainError(401, ProblemCodeConst.SESSION_INVALID, undefined);
    }
    return context;
  },
);
