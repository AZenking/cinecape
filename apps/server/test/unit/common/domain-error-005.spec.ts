import type { ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import {
  createDomainError,
  DomainError,
  PC_005_PROBLEM_CODES,
  resolveDomainProblem,
  type DomainProblemSpec,
} from '../../../src/common/domain-error';
import { ProblemJsonFilter } from '../../../src/common/problem-json.filter';

/**
 * T009(005 contracts/api.md §7「稳定错误」)—— 新增稳定码登记与渲染:
 * - 每个新码与契约状态逐一对应(403/423/409/422/400/503);
 * - 渲染为 RFC 9457 problem+json,code/type 稳定可判读,detail 为脱敏静态文案
 *   (不携带内部策略/源位置);
 * - 新码不带附加响应头(Retry-After 由限频器动态注入,不进注册表静态值);
 * - 新码常量与 shared ProblemCode 无键冲突(PROFILE_PIN_LOCKED /
 *   PLAYBACK_GENERATION_STALE 属既有 shared 码,不重复登记常量)。
 */

/** api.md §7 新增码 → 契约状态映射(逐字对照) */
const PC005_CODE_STATUS = {
  SETTINGS_PIN_REQUIRED: 403,
  SETTINGS_ACCESS_REQUIRED: 403,
  SETTINGS_ACCESS_EXPIRED: 403,
  PROFILE_PIN_LOCKED: 423,
  BOOTSTRAP_ALREADY_DONE: 409,
  MAIN_PROFILE_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  GUIDE_DATE_EXPIRED: 409,
  GUIDE_WINDOW_TOO_LARGE: 422,
  INVALID_CURSOR: 400,
  PROGRESS_NOT_READY: 409,
  PROGRESS_SAMPLE_CONFLICT: 409,
  PROGRESS_RESOURCE_CHANGED: 409,
  STORAGE_GENERATION_UNSUPPORTED: 503,
} as const;

const ALL_PC005_CODES = Object.keys(PC005_CODE_STATUS) as Array<keyof typeof PC005_CODE_STATUS>;

function mockResponse(): { res: Response; headers: Map<string, string>; bodies: unknown[] } {
  const headers = new Map<string, string>();
  const bodies: unknown[] = [];
  const res = {
    status() {
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
  return { res, headers, bodies };
}

function render(exception: unknown): { headers: Map<string, string>; body: Record<string, unknown> } {
  const { res, headers, bodies } = mockResponse();
  const host = {
    switchToHttp: () => ({
      getRequest: () => undefined,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
  new ProblemJsonFilter().catch(exception, host);
  expect(bodies).toHaveLength(1);
  return { headers, body: bodies[0] as Record<string, unknown> };
}

describe('api.md §7 新增码登记(T009)', () => {
  it('全部新增码均在注册表且 status 与契约逐一对应', () => {
    for (const code of ALL_PC005_CODES) {
      const spec = resolveDomainProblem(code);
      expect(spec, code).toBeDefined();
      expect(spec?.status, code).toBe(PC005_CODE_STATUS[code]);
      expect(createDomainError(code).status, code).toBe(PC005_CODE_STATUS[code]);
    }
  });

  it('新增码常量与 shared ProblemCode 无键冲突;既有码不重复登记', () => {
    for (const [key, value] of Object.entries(PC_005_PROBLEM_CODES)) {
      expect(key, key).toBe(value);
      expect(ProblemCodeConst, key).not.toHaveProperty(key);
    }
    expect(PC_005_PROBLEM_CODES).not.toHaveProperty('PLAYBACK_GENERATION_STALE');
  });

  it('新码渲染为稳定 problem+json,不携带附加响应头', () => {
    const { headers, body } = render(
      new DomainError(503, PC_005_PROBLEM_CODES.STORAGE_GENERATION_UNSUPPORTED),
    );
    expect(body).toMatchObject({
      type: 'https://homemedia.local/problems/storage-generation-unsupported',
      title: 'Storage Generation Unsupported',
      status: 503,
      code: 'STORAGE_GENERATION_UNSUPPORTED',
    });
    expect(headers.has('Retry-After')).toBe(false);
    // detail 回退注册表脱敏模板:不含内部策略/源位置/路径
    expect(body.detail).toBe('存储形态与当前代际不符,服务暂不可用');
  });

  it('423 PROFILE_PIN_LOCKED 渲染契约状态;显式 detail 优先于注册表模板', () => {
    const { body } = render(
      new DomainError(423, ProblemCodeConst.PROFILE_PIN_LOCKED, 'PIN 已锁定,请稍后重试'),
    );
    expect(body).toMatchObject({ status: 423, code: 'PROFILE_PIN_LOCKED' });
    expect(body.detail).toBe('PIN 已锁定,请稍后重试');
  });

  it('注册表仅 IMPORT_QUEUE_FULL 持静态附加头(新增条目不变更该约束)', () => {
    for (const code of ALL_PC005_CODES) {
      const spec: DomainProblemSpec | undefined = resolveDomainProblem(code);
      expect(spec?.headers ?? undefined, code).toBeUndefined();
    }
  });
});
