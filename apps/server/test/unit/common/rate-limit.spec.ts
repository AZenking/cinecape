import { describe, expect, it } from 'vitest';
import { RateLimitService } from '../../../src/common/rate-limit/rate-limit.service';
import { RATE_LIMIT_POLICIES, RATE_LIMIT_WINDOW_MS } from '../../../src/common/rate-limit/rate-limit.policies';
import { clientIpOf } from '../../../src/common/rate-limit/client-ip.util';
import { loadEnv, type Env } from '../../../src/config/env.schema';
import { setEnvOverride } from '../../../src/config/env';
import type { Request } from 'express';

/**
 * T009 限频底座(005 contracts/api.md §1)——
 * - 滑动窗口计数、429 Retry-After 余量、窗口滑动恢复、TTL 修剪与 key 数上限清扫;
 * - 策略间计数隔离(public/guide/progress 各自独立桶);
 * - client-ip:TRUST_PROXY=false 忽略 X-Forwarded-For;true 取首项。
 */

const T0 = 1_700_000_000_000;

/** 记录式灌入:返回 service 本身供断言窗口状态 */
function fillWith(policy: 'public' | 'guide' | 'progress', scope: string, times: number, atMs: number): RateLimitService {
  const service = new RateLimitService();
  for (let index = 0; index < times; index += 1) {
    const outcome = service.acquire(policy, scope, atMs);
    if (!outcome.ok) {
      throw new Error(`第 ${index + 1} 次即被限频,夹具配额不足`);
    }
  }
  return service;
}

describe('契约限额(每分钟)', () => {
  it('public=120/guide=30/progress=60,窗口 60s', () => {
    expect(RATE_LIMIT_POLICIES.public.limitPerMinute).toBe(120);
    expect(RATE_LIMIT_POLICIES.guide.limitPerMinute).toBe(30);
    expect(RATE_LIMIT_POLICIES.progress.limitPerMinute).toBe(60);
    expect(RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });
});

describe('滑动窗口与 Retry-After', () => {
  it('达到限额后拒绝,Retry-After 为最旧时刻出窗剩余秒(向上取整,≥1)', () => {
    const service = fillWith('public', 'ip:203.0.113.9', 120, T0);
    // +1ms:全部 120 个时刻仍在窗口内,第 121 个被拒;最旧时刻 T0 在 (T0+60000)ms 出窗
    const denied = service.acquire('public', 'ip:203.0.113.9', T0 + 1);
    expect(denied).toEqual({ ok: false, retryAfterSeconds: 60 });
  });

  it('窗口滑动:最旧时刻出窗后槽位释放', () => {
    const service = fillWith('guide', 'ip:198.51.100.7', 30, T0);
    expect(service.acquire('guide', 'ip:198.51.100.7', T0 + 1).ok).toBe(false);
    // T0 时刻的请求出窗(> T0+60s),释放 1 个槽位
    expect(service.acquire('guide', 'ip:198.51.100.7', T0 + RATE_LIMIT_WINDOW_MS + 1).ok).toBe(true);
  });

  it('窗口外历史被修剪(TTL):全部出窗后计数归零', () => {
    const service = fillWith('public', 'ip:192.0.2.1', 120, T0);
    const later = service.acquire('public', 'ip:192.0.2.1', T0 + RATE_LIMIT_WINDOW_MS * 2);
    expect(later).toEqual({ ok: true });
  });

  it('策略与 scope 隔离:互不占额', () => {
    const service = new RateLimitService();
    for (let index = 0; index < 120; index += 1) {
      service.acquire('public', 'ip:10.0.0.1', T0);
    }
    // public 已满:同 IP guide 桶不受影响;不同 IP public 桶不受影响
    expect(service.acquire('guide', 'ip:10.0.0.1', T0 + 1).ok).toBe(true);
    expect(service.acquire('public', 'ip:10.0.0.2', T0 + 1).ok).toBe(true);
    expect(service.acquire('public', 'ip:10.0.0.1', T0 + 1).ok).toBe(false);
  });

  it('key 数超软上限触发清扫:整体出窗的 key 被移除(数量上限兜底)', () => {
    const service = new RateLimitService();
    // 100 个 guide key 落在 T0;随后以 T0+61s(全部出窗之后)灌入越过软上限的 key
    for (let index = 0; index < 100; index += 1) {
      service.acquire('guide', `ip:10.1.${Math.floor(index / 256)}.${index % 256}`, T0);
    }
    for (let index = 0; index < 10_001; index += 1) {
      const outcome = service.acquire('public', `ip:10.2.${Math.floor(index / 256)}.${index % 256}`, T0 + 61_000);
      if (!outcome.ok) throw new Error('public 灌入不应触发限频(每 key 首次)');
    }
    // 清扫移除了 100 个已出窗 guide key:表中仅剩 10_001 个 public key
    expect(service.size()).toBe(10_001);
  });
});

describe('client-ip(T009:代理信任显式配置)', () => {
  function fakeRequest(headers: Record<string, string>, remoteAddress: string | undefined): Request {
    return {
      headers,
      socket: remoteAddress === undefined ? undefined : { remoteAddress },
    } as unknown as Request;
  }

  function withEnv(trustProxy: 'true' | 'false', run: () => void): void {
    const previous: Env | null = null;
    setEnvOverride(loadEnv({ NODE_ENV: 'test', TRUST_PROXY: trustProxy }));
    try {
      run();
    } finally {
      setEnvOverride(previous);
    }
  }

  it('TRUST_PROXY=false(默认):忽略 X-Forwarded-For,按连接地址计数', () => {
    withEnv('false', () => {
      const request = fakeRequest({ 'x-forwarded-for': '8.8.8.8' }, '172.16.0.5');
      expect(clientIpOf(request)).toBe('172.16.0.5');
    });
  });

  it('TRUST_PROXY=true:取 X-Forwarded-For 首项', () => {
    withEnv('true', () => {
      const request = fakeRequest({ 'x-forwarded-for': '203.0.113.5, 10.0.0.3' }, '10.0.0.3');
      expect(clientIpOf(request)).toBe('203.0.113.5');
    });
  });

  it('TRUST_PROXY=true 但无转发头:回落连接地址', () => {
    withEnv('true', () => {
      expect(clientIpOf(fakeRequest({}, '192.168.1.4'))).toBe('192.168.1.4');
      expect(clientIpOf(fakeRequest({}, undefined))).toBe('unknown');
    });
  });
});
