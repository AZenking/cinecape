import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProblemCode as ProblemCodeConst } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { parseStrict, strictObject } from '@platform/http-common/strict-input/strict-schema';
import { StrictBodyPipe, StrictQueryPipe } from '@platform/http-common/strict-input/strict-pipes';

/**
 * T009(005 contracts/api.md §1「未知 JSON/query 字段一律拒绝,不能通过
 * householdId/profileId/isAdmin 解锁或扩大权限」)—— 严格入参工具:
 * - strictObject/parseStrict 对未知键一律 400 VALIDATION_FAILED;
 * - 伪造身份声明字段(householdId/profileId/isAdmin)出现在 body/query 即拒绝;
 * - 管道按参数类型路由,非目标参数原样放行。
 */

const bodySchema = strictObject({ name: z.string().min(1), pin: z.string().regex(/^\d{6}$/) });
const querySchema = strictObject({ page: z.coerce.number().int().min(1) });

describe('strictObject / parseStrict —— 未知字段拒绝', () => {
  it('合法输入原样解析', () => {
    expect(parseStrict(bodySchema, { name: '主档案', pin: '123456' })).toEqual({
      name: '主档案',
      pin: '123456',
    });
  });

  it('body 未知键 → 400 VALIDATION_FAILED,detail 含键名', () => {
    try {
      parseStrict(bodySchema, { name: 'x', pin: '123456', isAdmin: true });
      expect.unreachable('应拒绝未知键');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      const domain = error as DomainError;
      expect(domain.status).toBe(400);
      expect(domain.code).toBe(ProblemCodeConst.VALIDATION_FAILED);
      expect(domain.detail).toContain('isAdmin');
    }
  });

  it('伪造身份声明 householdId/profileId 即便位置合法也被拒绝', () => {
    for (const injected of [{ householdId: 'h1' }, { profileId: 'p1' }]) {
      expect(() => parseStrict(querySchema, { page: 1, ...injected }, 'query')).toThrow(DomainError);
    }
  });

  it('query 形态同构拒绝未知键并带 query 前缀', () => {
    try {
      parseStrict(querySchema, { page: 1, q: 'abc' }, 'query');
      expect.unreachable('应拒绝未知 query 键');
    } catch (error) {
      const domain = error as DomainError;
      expect(domain.detail).toMatch(/^query:/);
    }
  });
});

describe('StrictBodyPipe / StrictQueryPipe —— 按参数类型路由', () => {
  const bodyPipe = new StrictBodyPipe(bodySchema);
  const queryPipe = new StrictQueryPipe(querySchema);

  it('body 管道解析 body 参数;未知键拒绝', () => {
    const meta = { type: 'body' } as const;
    expect(bodyPipe.transform({ name: 'a', pin: '654321' }, meta)).toEqual({ name: 'a', pin: '654321' });
    expect(() => bodyPipe.transform({ name: 'a', pin: '654321', profileId: 'p' }, meta)).toThrow(DomainError);
  });

  it('body 管道对非 body 参数原样放行', () => {
    const passthrough = { not: 'parsed' };
    expect(bodyPipe.transform(passthrough, { type: 'query' } as never)).toBe(passthrough);
  });

  it('query 管道解析 query 参数;未知键拒绝;非 query 参数放行', () => {
    const meta = { type: 'query' } as const;
    expect(queryPipe.transform({ page: '2' }, meta)).toEqual({ page: 2 });
    expect(() => queryPipe.transform({ page: '2', isAdmin: '1' }, meta)).toThrow(DomainError);
    const passthrough = { raw: true };
    expect(queryPipe.transform(passthrough, { type: 'body' } as never)).toBe(passthrough);
  });
});
