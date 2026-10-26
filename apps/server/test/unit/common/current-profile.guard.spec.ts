import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { CurrentProfileGuard } from '../../../src/common/profile-context/current-profile.guard';
import {
  attachProfileContext,
  CurrentProfile,
  resolveProfileContext,
  type ProfileContext,
} from '../../../src/common/profile-context/current-profile.decorator';
import { DomainError } from '../../../src/common/domain-error';
import type { SessionContext } from '../../../src/common/current-session.decorator';

/**
 * T009 CurrentProfileGuard(Profile 边界,Session 之后)—— 无 DB 负向路径:
 * - 未挂 SessionGuard(无会话上下文)→ 401 SESSION_INVALID fail-closed;
 * - activeProfileId 为空(未选档)→ 403 ACTIVE_PROFILE_REQUIRED;
 * - CurrentProfile decorator 未经守卫写入 → 401 同形(装配错误不泄露)。
 * (档案停用/跨家庭归属等 DB 路径由 US2/US3 契约测试覆盖。)
 */

const NOW = Date.now();

function stubContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request as unknown as Request,
      getResponse: () => undefined,
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function sessionOf(activeProfileId: string | null): { hmpSessionContext: SessionContext } {
  return {
    hmpSessionContext: {
      session: {
        id: 's1',
        householdId: 'hh-1',
        accountId: 'acc-1',
        deviceId: 'dev-1',
        activeProfileId,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      account: { id: 'acc-1', householdId: 'hh-1', username: 'admin', role: 'owner' },
    },
  };
}

function expectProblem(action: () => unknown): { status: number; code: string } {
  try {
    action();
    throw new Error('应当拒绝(测试夹具错误)');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domain = error as DomainError;
    return { status: domain.status, code: domain.code };
  }
}

describe('CurrentProfileGuard(fail-closed 负向)', () => {
  it('未挂 SessionGuard:无会话上下文 → 401 SESSION_INVALID', () => {
    const outcome = expectProblem(() => new CurrentProfileGuard().canActivate(stubContext({})));
    expect(outcome).toEqual({ status: 401, code: ProblemCodeConst.SESSION_INVALID });
  });

  it('会话有效但未选档(activeProfileId=null)→ 403 ACTIVE_PROFILE_REQUIRED', () => {
    const guard = new CurrentProfileGuard();
    const outcome = expectProblem(() => guard.canActivate(stubContext(sessionOf(null))));
    expect(outcome).toEqual({ status: 403, code: ProblemCodeConst.ACTIVE_PROFILE_REQUIRED });
  });
});

describe('CurrentProfile 装配(createParamDecorator → resolveProfileContext)', () => {
  it('未经 CurrentProfileGuard 写入 → 401 同形拒绝(装配错误不泄露)', () => {
    const outcome = expectProblem(() => resolveProfileContext(stubContext({})));
    expect(outcome).toEqual({ status: 401, code: ProblemCodeConst.SESSION_INVALID });
  });

  it('守卫经 attachProfileContext 写入后,解析器返回 ProfileContext', () => {
    const profile: ProfileContext = {
      id: 'p1',
      householdId: 'hh-1',
      accountId: 'acc-1',
      name: '家长',
      avatar: null,
      type: 'adult',
    };
    const request: Record<string, unknown> = {};
    attachProfileContext(request as unknown as Request, profile);
    expect(resolveProfileContext(stubContext(request))).toEqual(profile);
    // decorator 即解析器的参数化包装(createParamDecorator 单行,装配面不另设逻辑)
    expect(typeof CurrentProfile).toBe('function');
  });
});
