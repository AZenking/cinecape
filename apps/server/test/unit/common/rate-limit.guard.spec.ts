import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { RateLimitGuard } from '../../../src/common/rate-limit/rate-limit.guard';
import { RateLimitService } from '../../../src/common/rate-limit/rate-limit.service';
import { DomainError } from '../../../src/common/domain-error';
import type { SessionContext } from '../../../src/common/current-session.decorator';

/**
 * T009 限频守卫(T009 底座,不挂路由)——
 * - 无 @RateLimit 标注:直接放行(不改变未接入路由行为);
 * - ip 策略超限:429 PLAYBACK_RATE_LIMITED + Retry-After 动态注入响应头;
 * - progress 策略:按 SessionGuard 写入的 DeviceSession 计数,会话间隔离;
 *   上下文缺失回落 IP 计数(不产生放行窗口)。
 */

const NOW = Date.now();

function stubReflector(policy: string | undefined): Reflector {
  return { getAllAndOverride: () => policy } as unknown as Reflector;
}

interface StubResponseState {
  headers: Map<string, string>;
}

function stubContext(request: Record<string, unknown>): { context: ExecutionContext; response: StubResponseState } {
  const headers = new Map<string, string>();
  const response = { setHeader: (name: string, value: string) => void headers.set(name, value) } as unknown as Response;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request as unknown as Request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  return { context, response: { headers } };
}

function sessionContextOf(sessionId: string): { hmpSessionContext: SessionContext } {
  return {
    hmpSessionContext: {
      session: {
        id: sessionId,
        householdId: 'hh',
        accountId: 'acc',
        deviceId: 'dev',
        activeProfileId: null,
        expiresAt: new Date(NOW + 60_000).toISOString(),
      },
      account: { id: 'acc', householdId: 'hh', username: 'u', role: 'owner' },
    },
  };
}

describe('RateLimitGuard', () => {
  it('无 @RateLimit 标注:放行且不计数', () => {
    const service = new RateLimitService();
    const guard = new RateLimitGuard(service, stubReflector(undefined));
    const { context } = stubContext({});
    expect(guard.canActivate(context)).toBe(true);
    expect(service.size()).toBe(0);
  });

  it('public 策略:超额 429 + Retry-After 响应头', () => {
    const service = new RateLimitService();
    for (let index = 0; index < 120; index += 1) {
      expect(service.acquire('public', 'ip:unknown', NOW).ok).toBe(true);
    }
    const guard = new RateLimitGuard(service, stubReflector('public'));
    const { context, response } = stubContext({}); // 无 socket → 'unknown' 与上方同一桶
    try {
      guard.canActivate(context);
      expect.unreachable('超额应被拒绝');
    } catch (error) {
      const domain = error as DomainError;
      expect(domain.status).toBe(429);
      expect(domain.code).toBe(ProblemCodeConst.PLAYBACK_RATE_LIMITED);
      expect(response.headers.get('Retry-After')).toMatch(/^[1-9]\d*$/);
    }
  });

  it('progress 策略:按 DeviceSession 计数,会话间隔离', () => {
    const service = new RateLimitService();
    for (let index = 0; index < 60; index += 1) {
      expect(service.acquire('progress', 'device-session:s1', NOW).ok).toBe(true);
    }
    const guard = new RateLimitGuard(service, stubReflector('progress'));
    // s1 已满 → 429
    const full = stubContext(sessionContextOf('s1'));
    expect(() => guard.canActivate(full.context)).toThrow(DomainError);
    // s2 独立桶 → 放行
    const fresh = stubContext(sessionContextOf('s2'));
    expect(guard.canActivate(fresh.context)).toBe(true);
  });

  it('progress 策略无会话上下文:回落 IP 计数(不产生放行窗口)', () => {
    const service = new RateLimitService();
    for (let index = 0; index < 60; index += 1) {
      expect(service.acquire('progress', 'ip:unknown', NOW).ok).toBe(true);
    }
    const guard = new RateLimitGuard(service, stubReflector('progress'));
    const { context } = stubContext({}); // 无 hmpSessionContext
    expect(() => guard.canActivate(context)).toThrow(DomainError);
  });
});
