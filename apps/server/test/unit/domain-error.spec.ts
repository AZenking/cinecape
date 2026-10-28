import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import {
  createDomainError,
  DOMAIN_PROBLEM_REGISTRY,
  DomainError,
  type DomainProblemSpec,
  resolveDomainProblem,
} from '@platform/http-common/domain-error';
import { ProblemJsonFilter } from '@platform/http-common/problem-json.filter';

/**
 * T011(003 媒体目录单元):错误码 → RFC 9457 映射 ——
 * - 409:SOURCE_VERSION_CONFLICT / MEDIA_VERSION_CONFLICT / POLICY_VERSION_CONFLICT /
 *   REFRESH_STATE_CONFLICT / REFRESH_STALE / SOURCE_BUSY / IDEMPOTENCY_CONFLICT;
 * - 429:IMPORT_QUEUE_FULL(响应须带 Retry-After: 5);
 * - 422:SOURCE_TARGET_DENIED / SOURCE_DISABLED;
 * - 注册表外的既有码(未知 code)渲染行为不受影响。
 */

const CONFLICT_409 = [
  ProblemCode.SOURCE_VERSION_CONFLICT,
  ProblemCode.MEDIA_VERSION_CONFLICT,
  ProblemCode.POLICY_VERSION_CONFLICT,
  ProblemCode.REFRESH_STATE_CONFLICT,
  ProblemCode.REFRESH_STALE,
  ProblemCode.SOURCE_BUSY,
  ProblemCode.IDEMPOTENCY_CONFLICT,
] as const;

const UNPROCESSABLE_422 = [ProblemCode.SOURCE_TARGET_DENIED, ProblemCode.SOURCE_DISABLED] as const;

/** 记录式 Response 桩:捕获 status / setHeader / json,不发起真实 HTTP */
function mockResponse(): {
  res: Response;
  headers: Map<string, string>;
  statuses: number[];
  bodies: unknown[];
} {
  const headers = new Map<string, string>();
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  const res = {
    status(code: number) {
      statuses.push(code);
      return res;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return res;
    },
    json(body: unknown) {
      bodies.push(body);
      return res;
    },
  } as unknown as Response;
  return { res, headers, statuses, bodies };
}

function mockHost(res: Response): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => undefined,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

function render(exception: unknown): {
  headers: Map<string, string>;
  statuses: number[];
  body: Record<string, unknown>;
} {
  const { res, headers, statuses, bodies } = mockResponse();
  new ProblemJsonFilter().catch(exception, mockHost(res));
  expect(bodies).toHaveLength(1);
  return { headers, statuses, body: bodies[0] as Record<string, unknown> };
}

describe('注册表映射 —— 409 冲突组(003 contracts/api.md 错误节)', () => {
  it.each(CONFLICT_409)('%s → 409', (code) => {
    const spec = resolveDomainProblem(code);
    expect(spec?.status).toBe(409);

    const error = createDomainError(code);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.status).toBe(409);
    expect(error.code).toBe(code);
  });
});

describe('注册表映射 —— 422 目标不可处理组', () => {
  it.each(UNPROCESSABLE_422)('%s → 422', (code) => {
    const spec = resolveDomainProblem(code);
    expect(spec?.status).toBe(422);
    expect(createDomainError(code).status).toBe(422);
  });
});

describe('IMPORT_QUEUE_FULL —— 429 + Retry-After: 5', () => {
  it('注册表 status 为 429 且 headers 恰为 Retry-After: 5', () => {
    const spec = resolveDomainProblem(ProblemCode.IMPORT_QUEUE_FULL);
    expect(spec?.status).toBe(429);
    expect(spec?.headers).toEqual({ 'Retry-After': '5' });
  });

  it('过滤器对 IMPORT_QUEUE_FULL 统一注入 Retry-After: 5 响应头', () => {
    const { headers, statuses, body } = render(new DomainError(429, ProblemCode.IMPORT_QUEUE_FULL));
    expect(statuses).toEqual([429]);
    expect(headers.get('Retry-After')).toBe('5');
    expect(body).toMatchObject({
      type: 'https://homemedia.local/problems/import-queue-full',
      title: 'Import Queue Full',
      status: 429,
      code: 'IMPORT_QUEUE_FULL',
    });
  });

  it('createDomainError 缺省构造同样映射 429;显式 detail 覆盖缺省模板', () => {
    expect(createDomainError(ProblemCode.IMPORT_QUEUE_FULL).status).toBe(429);

    const custom = createDomainError(ProblemCode.SOURCE_BUSY, '自定义脱敏说明');
    expect(custom.status).toBe(409);
    expect(custom.detail).toBe('自定义脱敏说明');
  });
});

describe('注册表缺省 title/detail 模板', () => {
  it('每个注册表码均有非空 title 与脱敏 detail 模板', () => {
    for (const [code, spec] of Object.entries(DOMAIN_PROBLEM_REGISTRY)) {
      expect(spec.title, code).not.toBe('');
      expect(spec.detail, code).toBeTruthy();
      // detail 模板仅稳定业务语义:不含上游地址/路径等原始数据特征
      expect(spec.detail, code).not.toMatch(/https?:\/\/|\.(m3u8?|xml|xmltv)\b|\//);
    }
  });

  it('全注册表仅 IMPORT_QUEUE_FULL 携带附加响应头', () => {
    const entries = Object.entries(DOMAIN_PROBLEM_REGISTRY) as [string, DomainProblemSpec][];
    for (const [code, spec] of entries) {
      if (code === 'IMPORT_QUEUE_FULL') continue;
      expect(spec.headers, code).toBeUndefined();
    }
  });

  it('DomainError 未传 detail 时过滤器回退注册表模板;显式 detail 优先', () => {
    const fallback = render(createDomainError(ProblemCode.REFRESH_STALE));
    expect(fallback.body.detail).toBe('来源或目录基线已变化,请重新加载后重试');

    const explicit = render(new DomainError(409, ProblemCode.REFRESH_STALE, 'NAS 根或来源版本已变化'));
    expect(explicit.body.detail).toBe('NAS 根或来源版本已变化');
    expect(explicit.headers.has('Retry-After')).toBe(false);
  });
});

describe('未知 code 不受影响 —— 注册表外沿用既有渲染', () => {
  it('既有码不在注册表:resolveDomainProblem 返回 undefined', () => {
    expect(resolveDomainProblem(ProblemCode.NOT_FOUND)).toBeUndefined();
    expect(resolveDomainProblem(ProblemCode.POLICY_UNAVAILABLE)).toBeUndefined();
    expect(resolveDomainProblem(ProblemCode.VALIDATION_FAILED)).toBeUndefined();
  });

  it('既有码经过滤器渲染:title 由 code 推导、无附加头、不注入缺省 detail', () => {
    const { headers, statuses, body } = render(new DomainError(404, ProblemCode.NOT_FOUND));
    expect(statuses).toEqual([404]);
    expect(body).toMatchObject({
      type: 'https://homemedia.local/problems/not-found',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(body.detail).toBeUndefined();
    // T012(004 contracts/api.md):错误响应统一附加 Cache-Control:no-store 与
    // Referrer-Policy:no-referrer —— 合同级新增头,非注册表按 code 注入的附加头。
    expect([...headers.keys()]).toEqual(['Cache-Control', 'Referrer-Policy', 'Content-Type']);
    expect(headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
  });

  it('运行时出现注册表外的新码(类型缺口)也不抛错、不注入附加头', () => {
    const unknownCode = 'FUTURE_CODE' as ProblemCode;
    expect(resolveDomainProblem(unknownCode)).toBeUndefined();

    const { headers, statuses, body } = render(new DomainError(409, unknownCode, '稳定说明'));
    expect(statuses).toEqual([409]);
    expect(body).toMatchObject({
      type: 'https://homemedia.local/problems/future-code',
      title: 'Future Code',
      status: 409,
      code: 'FUTURE_CODE',
      detail: '稳定说明',
    });
    expect(headers.has('Retry-After')).toBe(false);
  });
});
