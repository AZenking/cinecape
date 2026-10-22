import { describe, expect, it } from 'vitest';
import { redactForLog } from '../../src/common/log-redaction.util';

describe('log redaction(T041/FR-007)', () => {
  it('命中敏感键(password/pin/token/secret/authorization/cookie)一律替换', () => {
    const input = {
      username: 'admin',
      password: 'plain-text-password',
      passwordHash: 'aaa',
      pin: '1234',
      pinHash: 'bbb',
      sessionToken: 'tok',
      deviceToken: 'tok2',
      clientSecret: 's',
      authorization: 'Bearer x',
      cookie: 'hmp_session=y',
    };
    const out = redactForLog(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key === 'username') continue;
      expect(out[key], key).toBe('[REDACTED]');
    }
    expect(out['username']).toBe('admin');
  });

  it('深嵌套与数组同样生效,普通数据原样保留', () => {
    const out = redactForLog({
      level: 'info',
      rows: [{ id: '1', name: 'a', pin_hash: 'x' }],
      nested: { deep: { refresh_token: 't', ok: true } },
    }) as {
      level: string;
      rows: Array<{ id: string; name: string; pin_hash: string }>;
      nested: { deep: { refresh_token: string; ok: boolean } };
    };
    expect(out.level).toBe('info');
    expect(out.rows[0]?.id).toBe('1');
    expect(out.rows[0]?.pin_hash).toBe('[REDACTED]');
    expect(out.nested.deep.refresh_token).toBe('[REDACTED]');
    expect(out.nested.deep.ok).toBe(true);
  });

  it('循环引用不爆炸,超深截断', () => {
    const a: Record<string, unknown> = { password: 'x' };
    a['self'] = a;
    const out = redactForLog(a) as Record<string, unknown>;
    expect(out['password']).toBe('[REDACTED]');
    expect(out['self']).toBe('[TRUNCATED]');
  });

  it('原始对象不被修改(纯函数)', () => {
    const input = { password: 'secret', keep: 1 };
    redactForLog(input);
    expect(input['password']).toBe('secret');
    expect(input['keep']).toBe(1);
  });
});
