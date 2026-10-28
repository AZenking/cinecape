import { afterEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { assertSameOrigin, SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { DomainError } from '@platform/http-common/domain-error';
import { loadEnv } from '@platform/config/env.schema';
import { setEnvOverride } from '@platform/config/env';

/**
 * T009 同源校验(005 contracts/api.md §1)——
 * - Origin 存在时与 PUBLIC_ORIGIN 精确匹配;不匹配 403;
 * - 未配置 PUBLIC_ORIGIN 时携带 Origin 一律 403(fail-closed);
 * - 无 Origin:通过(absence 不放宽 Cookie 语义,认证仍由 SessionGuard 权威);
 * - 写方法携带非 JSON 简单表单体 → 400;无体写请求(幂等 DELETE)不查 Content-Type。
 */

function fakeRequest(input: {
  method?: string;
  origin?: string;
  contentType?: string;
  contentLength?: string;
  transferEncoding?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (input.origin !== undefined) headers['origin'] = input.origin;
  if (input.contentType !== undefined) headers['content-type'] = input.contentType;
  if (input.contentLength !== undefined) headers['content-length'] = input.contentLength;
  if (input.transferEncoding !== undefined) headers['transfer-encoding'] = input.transferEncoding;
  return { method: input.method ?? 'GET', headers } as unknown as Request;
}

function withEnv(publicOrigin: string, run: () => void): void {
  setEnvOverride(loadEnv({ NODE_ENV: 'test', PUBLIC_ORIGIN: publicOrigin }));
  try {
    run();
  } finally {
    setEnvOverride(null);
  }
}

afterEach(() => {
  setEnvOverride(null);
});

describe('Origin 精确匹配(配置 http://home.local:3000)', () => {
  it('同源 Origin 放行;跨源 403 FORBIDDEN', () => {
    withEnv('http://home.local:3000', () => {
      expect(() => assertSameOrigin(fakeRequest({ origin: 'http://home.local:3000' }))).not.toThrow();
      try {
        assertSameOrigin(fakeRequest({ origin: 'http://evil.example' }));
        expect.unreachable('跨源应被拒绝');
      } catch (error) {
        const domain = error as DomainError;
        expect(domain.status).toBe(403);
        expect(domain.code).toBe(ProblemCodeConst.FORBIDDEN);
      }
    });
  });

  it('Origin 大小写/尾缀差异不构成精确匹配', () => {
    withEnv('http://home.local:3000', () => {
      for (const origin of ['http://home.local:3000/', 'HTTP://HOME.LOCAL:3000', 'http://home.local:3001']) {
        expect(() => assertSameOrigin(fakeRequest({ origin })), origin).toThrow(DomainError);
      }
    });
  });

  it('未配置 PUBLIC_ORIGIN:携带 Origin 一律 403(fail-closed);无 Origin 放行', () => {
    withEnv('', () => {
      expect(() => assertSameOrigin(fakeRequest({ origin: 'http://home.local:3000' }))).toThrow(DomainError);
      expect(() => assertSameOrigin(fakeRequest({}))).not.toThrow();
    });
  });

  it('无 Origin 的写请求通过(absence 不放宽 Cookie 语义,仅不做来源判定)', () => {
    withEnv('http://home.local:3000', () => {
      expect(() =>
        assertSameOrigin(fakeRequest({ method: 'POST', contentType: 'application/json', contentLength: '13' })),
      ).not.toThrow();
    });
  });
});

describe('非 JSON 简单表单拒绝(写方法 + 有体)', () => {
  it('POST form/urlencoded → 400 VALIDATION_FAILED;text/plain 同拒', () => {
    withEnv('http://home.local:3000', () => {
      for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data']) {
        try {
          assertSameOrigin(
            fakeRequest({ method: 'POST', origin: 'http://home.local:3000', contentType, contentLength: '9' }),
          );
          expect.unreachable(`${contentType} 应被拒绝`);
        } catch (error) {
          const domain = error as DomainError;
          expect(domain.status, contentType).toBe(400);
          expect(domain.code, contentType).toBe(ProblemCodeConst.VALIDATION_FAILED);
        }
      }
    });
  });

  it('写方法 JSON 体放行;无体写请求不检查 Content-Type', () => {
    withEnv('http://home.local:3000', () => {
      expect(() =>
        assertSameOrigin(
          fakeRequest({ method: 'POST', origin: 'http://home.local:3000', contentType: 'application/json; charset=utf-8', contentLength: '2' }),
        ),
      ).not.toThrow();
      expect(() => assertSameOrigin(fakeRequest({ method: 'DELETE', origin: 'http://home.local:3000' }))).not.toThrow();
    });
  });
});

describe('SameOriginGuard 可挂载', () => {
  it('canActivate 委托同一判定(跨源拒绝,同源 true)', () => {
    const guard = new SameOriginGuard();
    const ctxOf = (request: Request) =>
      ({
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => undefined, getNext: () => undefined }),
      }) as never;
    withEnv('http://home.local:3000', () => {
      expect(guard.canActivate(ctxOf(fakeRequest({ origin: 'http://home.local:3000' })))).toBe(true);
      expect(() => guard.canActivate(ctxOf(fakeRequest({ origin: 'http://evil.example' })))).toThrow(DomainError);
    });
  });
});
