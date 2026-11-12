import { describe, expect, it } from 'vitest';
import { createLogoProxyService, MEDIA_LOGO_BUDGETS, MEDIA_LOGO_PROBLEM_CODES, type LogoProxyServiceDeps, type MediaLogoContent } from '@contexts/media-catalog/application/logo.service';
import type { ChannelLogoResolveRow } from '@contexts/media-catalog/infrastructure/channel-logo.repository';
import { RemoteReadFailure } from '@platform/upstream/safe-upstream-reader';
import type { SafeUpstreamOpenRequest, SafeUpstreamReadResult } from '@platform/upstream/safe-upstream.port';
import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';

/**
 * 频道 Logo 代理服务单元契约(tasks T009;internal-ports.md §3 / api.md §1 / research R7):
 * - 解析门:命中 active → upstreamUrl/mediaId;墓碑 → 'revoked';未命中/伪造/
 *   格式非法/跨家庭 → undefined(404 同形由 fetch 面构造,不透露「曾存在」);
 * - 请求形态:SafeUpstream read url=私有 upstream_url、allowedTargets 原样贯通、
 *   byteBudget/timeBudgets = MEDIA_LOGO_BUDGETS(数值沿用 010 VOD_POSTER_BUDGETS);
 * - 响应门:仅接受 image/* 且 identity 编码,否则 502;
 * - 失败映射(R7 分类逐字对照 poster.service mapUpstreamFailure):
 *   IDLE_TIMEOUT/ABORTED/BUDGET_EXCEEDED → 504 MEDIA_LOGO_UPSTREAM_TIMEOUT,
 *   其余传输失败 → 502 MEDIA_LOGO_UPSTREAM_FAILED;
 * - 全部错误体 detail 为静态脱敏文案,不携带上游 URL 片段(api.md §1「不回显」)。
 * 传输层本体(SSRF/预算/重定向)由 safe-upstream.spec.ts 钉面。
 */

const HOUSEHOLD = 'hh-logo';
const OTHER_HOUSEHOLD = 'hh-logo-other';
const LOGO_URL = 'http://127.0.0.1:9/logo/channel.png';
const ALLOWED_TARGETS = [{ kind: 'hostPort', host: '127.0.0.1', port: 9 }] as const;

type ReadOutcome =
  | { readonly kind: 'image'; readonly contentType?: string | null; readonly contentEncoding?: string | null }
  | { readonly kind: 'html' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'idle-timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'budget-exceeded' }
  | { readonly kind: 'unreachable' };

interface Fixture {
  readonly reads: SafeUpstreamOpenRequest[];
  setReadOutcome(outcome: ReadOutcome): void;
  setRow(row: ChannelLogoResolveRow | undefined): void;
  resolve(householdId: string, ref: string): ReturnType<ReturnType<typeof createLogoProxyService>['resolveForHousehold']>;
  fetch(householdId: string, ref: string): Promise<MediaLogoContent>;
}

const ACTIVE_ROW: ChannelLogoResolveRow = {
  mediaId: 'ch-1',
  ref: 'a'.repeat(32),
  upstreamUrl: LOGO_URL,
  sourceKind: 'iptv',
  revision: 1,
  revokedAt: null,
};

const TOMBSTONE_ROW: ChannelLogoResolveRow = {
  mediaId: 'ch-1',
  ref: 'a'.repeat(32),
  upstreamUrl: null,
  sourceKind: 'iptv',
  revision: 2,
  revokedAt: '2025-12-30T00:00:00.000Z',
};

function makeFixture(initialRow: ChannelLogoResolveRow | undefined = ACTIVE_ROW): Fixture {
  const reads: SafeUpstreamOpenRequest[] = [];
  let outcome: ReadOutcome = { kind: 'image' };
  let row: ChannelLogoResolveRow | undefined = initialRow;
  const safeUpstream = {
    open: async (): Promise<never> => {
      throw new Error('logo service must not use open()');
    },
    read: async (request: SafeUpstreamOpenRequest): Promise<SafeUpstreamReadResult> => {
      reads.push(request);
      if (outcome.kind === 'denied') throw new RemoteReadFailure('SOURCE_TARGET_DENIED', '目标未列入许可');
      if (outcome.kind === 'idle-timeout') throw new RemoteReadFailure('SOURCE_IDLE_TIMEOUT', '空闲超预算');
      if (outcome.kind === 'aborted') throw new RemoteReadFailure('SOURCE_ABORTED', '外部中止');
      if (outcome.kind === 'budget-exceeded') throw new RemoteReadFailure('SOURCE_BUDGET_EXCEEDED', '预算耗尽');
      if (outcome.kind === 'unreachable') throw new RemoteReadFailure('SOURCE_REMOTE_UNREACHABLE', '传输失败');
      if (outcome.kind === 'html') {
        return { bytes: Buffer.from('<html/>'), contentType: 'text/html', contentEncoding: null, finalUrl: LOGO_URL, redirectsFollowed: 0 };
      }
      return {
        bytes: Buffer.from('fake-logo-bytes'),
        contentType: outcome.contentType === undefined ? 'image/png' : outcome.contentType,
        contentEncoding: outcome.contentEncoding ?? null,
        finalUrl: LOGO_URL,
        redirectsFollowed: 0,
      };
    },
  };
  const deps: LogoProxyServiceDeps = {
    resolveByRef: (householdId, _ref) => (householdId === HOUSEHOLD ? row : undefined),
    safeUpstream,
    allowedTargets: ALLOWED_TARGETS,
  };
  const service = createLogoProxyService(deps);
  return {
    reads,
    setReadOutcome(next) {
      outcome = next;
    },
    setRow(next) {
      row = next;
    },
    resolve: (householdId, ref) => service.resolveForHousehold(householdId, ref),
    fetch: (householdId: string, ref: string) => service.fetch({ householdId, logoRef: ref }),
  };
}

async function expectDomainError(promise: Promise<unknown>, status: number, code: string, forbiddenUrlFragment = '127.0.0.1'): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domain = error as DomainError;
    expect(domain.status).toBe(status);
    expect(domain.code).toBe(code);
    // 脱敏面:错误文案不回显上游地址片段
    expect(domain.message.includes(forbiddenUrlFragment)).toBe(false);
    return;
  }
  throw new Error(`应抛 DomainError(${status} ${code}),实际正常返回`);
}

describe('频道 Logo 代理服务(T009;internal-ports §3)', () => {
  it('解析门:命中 active → {upstreamUrl, mediaId}', () => {
    const rig = makeFixture();
    expect(rig.resolve(HOUSEHOLD, 'a'.repeat(32))).toEqual({ upstreamUrl: LOGO_URL, mediaId: 'ch-1' });
  });

  it('解析门:墓碑 → revoked(410 语义);未命中/伪造/格式非法/跨家庭 → undefined(404 同形)', () => {
    const rig = makeFixture();
    rig.setRow(TOMBSTONE_ROW);
    expect(rig.resolve(HOUSEHOLD, 'a'.repeat(32))).toBe('revoked');
    rig.setRow(undefined);
    expect(rig.resolve(HOUSEHOLD, 'b'.repeat(32))).toBeUndefined();
    expect(rig.resolve(HOUSEHOLD, 'z'.repeat(40))).toBeUndefined(); // 格式非法(40 hex)
    expect(rig.resolve(HOUSEHOLD, 'A'.repeat(32))).toBeUndefined(); // 大写判伪造
    expect(rig.resolve(OTHER_HOUSEHOLD, 'a'.repeat(32))).toBeUndefined(); // 跨家庭同形
  });

  it('fetch 映射:命中 200 内容;墓碑 410 MEDIA_LOGO_REVOKED;未命中/跨家庭 404 NOT_FOUND 同形', async () => {
    const rig = makeFixture();
    const content = await rig.fetch(HOUSEHOLD, 'a'.repeat(32));
    expect(content.contentType).toBe('image/png');
    expect(content.bytes.toString('utf8')).toBe('fake-logo-bytes');

    rig.setRow(TOMBSTONE_ROW);
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 410, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_REVOKED);

    rig.setRow(undefined);
    await expectDomainError(rig.fetch(HOUSEHOLD, 'c'.repeat(32)), 404, ProblemCode.NOT_FOUND);
    await expectDomainError(rig.fetch(OTHER_HOUSEHOLD, 'a'.repeat(32)), 404, ProblemCode.NOT_FOUND);
    // 两类 404 完全同形(负向验收:跨家庭探测不得有差异)
    const miss = (await rig.fetch(HOUSEHOLD, 'c'.repeat(32)).catch((error: DomainError) => error)) as DomainError;
    const cross = (await rig.fetch(OTHER_HOUSEHOLD, 'a'.repeat(32)).catch((error: DomainError) => error)) as DomainError;
    expect(miss.message).toBe(cross.message);
    expect(miss.code).toBe(cross.code);
  });

  it('请求形态贯通:url=私有 upstream_url;预算取 MEDIA_LOGO_BUDGETS(数值沿用 010 VOD_POSTER_BUDGETS);allowedTargets 原样', async () => {
    const rig = makeFixture();
    await rig.fetch(HOUSEHOLD, 'a'.repeat(32));
    expect(rig.reads).toHaveLength(1);
    expect(rig.reads[0]?.url).toBe(LOGO_URL);
    expect(rig.reads[0]?.allowedTargets).toBe(ALLOWED_TARGETS);
    expect(rig.reads[0]?.byteBudget).toBe(MEDIA_LOGO_BUDGETS.maxBytes);
    expect(rig.reads[0]?.timeBudgets).toEqual({
      totalTimeoutMs: MEDIA_LOGO_BUDGETS.totalTimeoutMs,
      idleTimeoutMs: MEDIA_LOGO_BUDGETS.idleTimeoutMs,
      maxRedirects: MEDIA_LOGO_BUDGETS.maxRedirects,
    });
    // 预算数值 = 010 VOD_POSTER_BUDGETS(2MiB/8s/4s/3 跳;R7 数值常量复用)
    expect(MEDIA_LOGO_BUDGETS).toEqual({ maxBytes: 2 * 1024 * 1024, totalTimeoutMs: 8_000, idleTimeoutMs: 4_000, maxRedirects: 3 });
  });

  it('响应门:非 image 502;gzip 编码 502;content-type 缺失 502(全部脱敏)', async () => {
    const rig = makeFixture();
    rig.setReadOutcome({ kind: 'html' });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 502, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED);
    rig.setReadOutcome({ kind: 'image', contentEncoding: 'gzip' });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 502, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED);
    rig.setReadOutcome({ kind: 'image', contentType: null });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 502, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED);
    // identity 编码可接受
    rig.setReadOutcome({ kind: 'image', contentEncoding: 'identity' });
    const content = await rig.fetch(HOUSEHOLD, 'a'.repeat(32));
    expect(content.bytes.toString('utf8')).toBe('fake-logo-bytes');
  });

  it('失败映射(R7 分类):空闲超时/外部中止/预算耗尽 → 504 TIMEOUT;许可拒绝/不可达 → 502 FAILED', async () => {
    const rig = makeFixture();
    rig.setReadOutcome({ kind: 'idle-timeout' });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 504, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_TIMEOUT);
    rig.setReadOutcome({ kind: 'aborted' });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 504, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_TIMEOUT);
    rig.setReadOutcome({ kind: 'budget-exceeded' });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 504, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_TIMEOUT);
    rig.setReadOutcome({ kind: 'denied' });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 502, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED);
    rig.setReadOutcome({ kind: 'unreachable' });
    await expectDomainError(rig.fetch(HOUSEHOLD, 'a'.repeat(32)), 502, MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED);
    // 失败后注册表行不受影响:恢复 image 后同 ref 仍可用(纯读,无状态副作用)
    rig.setReadOutcome({ kind: 'image' });
    const content = await rig.fetch(HOUSEHOLD, 'a'.repeat(32));
    expect(content.bytes.toString('utf8')).toBe('fake-logo-bytes');
  });

  it('fetchLogoBytes 直连形态:私有地址 → 有界读取(解析门外的独立端口面)', async () => {
    const deps: LogoProxyServiceDeps = {
      resolveByRef: () => ACTIVE_ROW,
      safeUpstream: {
        open: async () => {
          throw new Error('unreachable');
        },
        read: async () => ({
          bytes: Buffer.from('direct-bytes'),
          contentType: 'image/jpeg',
          contentEncoding: null,
          finalUrl: LOGO_URL,
          redirectsFollowed: 0,
        }),
      },
      allowedTargets: ALLOWED_TARGETS,
    };
    const service = createLogoProxyService(deps);
    const content = await service.fetchLogoBytes(LOGO_URL);
    expect(content.contentType).toBe('image/jpeg');
    expect(content.bytes.toString('utf8')).toBe('direct-bytes');
  });
});
