import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createVodCache, type VodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import { createVodPosterService, VOD_POSTER_BUDGETS, type VodPosterContent } from '@contexts/online-vod/infrastructure/poster.service';
import type { VodTitlePayload } from '@contexts/online-vod/application/preview.service';
import { RemoteReadFailure } from '@platform/upstream/safe-upstream-reader';
import type { SafeUpstreamOpenRequest, SafeUpstreamReadResult } from '@platform/upstream/safe-upstream.port';
import { DomainError } from '@platform/http-common/domain-error';

/**
 * 海报代理服务单元契约(api.md §2「GET /public/vod/posters/:posterRef」行):
 * - p 级 ref 门:伪造/未签发/非 poster 级(titleRef 冒用)→ 404 同形;过期 410;
 *   跨家庭 404 同形;无海报条目(防御)404;
 * - SafeUpstream 请求形态:url=私有 posterUrl、allowedTargets 原样贯通、
 *   byteBudget/timeBudgets 取 VOD_POSTER_BUDGETS;
 * - 仅接受 image/* 未编码响应,否则 502;传输失败按稳定码映射 502/504。
 * 传输层本体(SSRF/预算/重定向)由 safe-upstream.spec.ts / safe-http-reader.spec.ts 钉面。
 */

const HOUSEHOLD = 'hh-poster';
const OTHER_HOUSEHOLD = 'hh-poster-other';
const POSTER_URL = 'http://127.0.0.1:9/pic/poster.jpg';
const ALLOWED_TARGETS = [{ kind: 'hostPort', host: '127.0.0.1', port: 9 }] as const;

type ReadOutcome =
  | { readonly kind: 'image'; readonly contentType?: string; readonly contentEncoding?: string | null }
  | { readonly kind: 'html' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'idle-timeout' }
  | { readonly kind: 'oversize' };

interface Fixture {
  readonly cache: VodCache;
  readonly titleRef: string;
  readonly posterRef: string;
  readonly reads: SafeUpstreamOpenRequest[];
  setReadOutcome(outcome: ReadOutcome): void;
  fetch(householdId: string, posterRef: string): Promise<VodPosterContent>;
}

/** 一个夹具 = 一个独立 cache(含海报绑定)+ 可切换 stub 的服务 */
function makeFixture(): Fixture {
  const cache = createVodCache();
  const titleRef = `t1-${randomUUID()}`;
  const posterRef = cache.allocateRef(titleRef, `poster:${randomUUID()}`, 'poster');
  const payload: VodTitlePayload = {
    kind: 'title-binding',
    sourceId: 'src-poster',
    sourceLabel: '海报源',
    upstreamVodId: '1001',
    title: '海报片',
    year: '2024',
    locatorRevision: 1,
    searchId: `s1-${randomUUID()}`,
    posterUrl: POSTER_URL,
    posterRef,
  };
  const putOk = cache.put<VodTitlePayload>({
    id: titleRef,
    householdId: HOUSEHOLD,
    kind: 'preview',
    sourceIds: [payload.sourceId],
    expiresAtMs: Date.now() + 600_000,
    payload,
  });
  if (!putOk) throw new Error('binding put failed');

  const reads: SafeUpstreamOpenRequest[] = [];
  let outcome: ReadOutcome = { kind: 'image' };
  const safeUpstream = {
    // poster 服务仅消费 read;open(流式面)不在此钉面,stub 显式不可达
    open: async (): Promise<never> => {
      throw new Error('poster service must not use open()');
    },
    read: async (request: SafeUpstreamOpenRequest): Promise<SafeUpstreamReadResult> => {
      reads.push(request);
      if (outcome.kind === 'denied') throw new RemoteReadFailure('SOURCE_TARGET_DENIED', '目标未列入许可');
      if (outcome.kind === 'idle-timeout') throw new RemoteReadFailure('SOURCE_IDLE_TIMEOUT', '空闲超预算');
      if (outcome.kind === 'oversize') throw new RemoteReadFailure('SOURCE_BUDGET_EXCEEDED', '字节超预算');
      if (outcome.kind === 'html') {
        return { bytes: Buffer.from('<html/>'), contentType: 'text/html', contentEncoding: null, finalUrl: POSTER_URL, redirectsFollowed: 0 };
      }
      return {
        bytes: Buffer.from('fake-image-bytes'),
        contentType: outcome.contentType ?? 'image/jpeg',
        contentEncoding: outcome.contentEncoding ?? null,
        finalUrl: POSTER_URL,
        redirectsFollowed: 0,
      };
    },
  };
  const service = createVodPosterService({ cache, safeUpstream, allowedTargets: ALLOWED_TARGETS });
  return {
    cache,
    titleRef,
    posterRef,
    reads,
    setReadOutcome(next) {
      outcome = next;
    },
    fetch: (householdId: string, ref: string) => service.fetch({ householdId, posterRef: ref }),
  };
}

async function expectDomainError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    const domain = error as DomainError;
    expect(domain.status).toBe(status);
    expect(domain.code).toBe(code);
    return;
  }
  throw new Error(`应抛 DomainError(${status} ${code}),实际正常返回`);
}

describe('海报代理服务(api.md §2 海报代理行)', () => {
  it('H1 happy path:ref 反查私有 posterUrl → 有界读取 → image/* 字节与类型回传', async () => {
    const rig = makeFixture();
    const content = await rig.fetch(HOUSEHOLD, rig.posterRef);
    expect(content.contentType).toBe('image/jpeg');
    expect(content.bytes.toString('utf8')).toBe('fake-image-bytes');
  });

  it('H2 请求形态贯通:url=私有 posterUrl;预算取 VOD_POSTER_BUDGETS;allowedTargets 原样', async () => {
    const rig = makeFixture();
    await rig.fetch(HOUSEHOLD, rig.posterRef);
    expect(rig.reads).toHaveLength(1);
    expect(rig.reads[0]?.url).toBe(POSTER_URL);
    expect(rig.reads[0]?.allowedTargets).toBe(ALLOWED_TARGETS);
    expect(rig.reads[0]?.byteBudget).toBe(VOD_POSTER_BUDGETS.maxBytes);
    expect(rig.reads[0]?.timeBudgets).toEqual({
      totalTimeoutMs: VOD_POSTER_BUDGETS.totalTimeoutMs,
      idleTimeoutMs: VOD_POSTER_BUDGETS.idleTimeoutMs,
      maxRedirects: VOD_POSTER_BUDGETS.maxRedirects,
    });
  });

  it('H3 ref 门:伪造 ref 404;titleRef 冒用 404;跨家庭 404;过期 410;无海报防御 404', async () => {
    const rig = makeFixture();
    await expectDomainError(rig.fetch(HOUSEHOLD, `p1-${randomUUID()}`), 404, 'NOT_FOUND');
    await expectDomainError(rig.fetch(HOUSEHOLD, rig.titleRef), 404, 'NOT_FOUND');
    await expectDomainError(rig.fetch(OTHER_HOUSEHOLD, rig.posterRef), 404, 'NOT_FOUND');
    // 过期:同 id 替换到期(替换语义保留已签发 ref;expired=410 非 404)
    const view = rig.cache.get<VodTitlePayload>(rig.titleRef);
    rig.cache.put({
      id: rig.titleRef,
      householdId: HOUSEHOLD,
      kind: 'preview',
      sourceIds: ['src-poster'],
      expiresAtMs: Date.now() - 1,
      payload: view?.payload as VodTitlePayload,
    });
    await expectDomainError(rig.fetch(HOUSEHOLD, rig.posterRef), 410, 'VOD_PREVIEW_EXPIRED');
    // 无海报绑定不签发 ref;防御面:手动签发后置 null 海报 → 404(不泄露内部形态)
    const nullTitleRef = `t1-${randomUUID()}`;
    const payload: VodTitlePayload = {
      kind: 'title-binding',
      sourceId: 'src-poster',
      sourceLabel: '海报源',
      upstreamVodId: '1002',
      title: '无海报片',
      year: null,
      locatorRevision: 1,
      searchId: `s1-${randomUUID()}`,
      posterUrl: null,
      posterRef: null,
    };
    rig.cache.put<VodTitlePayload>({
      id: nullTitleRef,
      householdId: HOUSEHOLD,
      kind: 'preview',
      sourceIds: [payload.sourceId],
      expiresAtMs: Date.now() + 600_000,
      payload,
    });
    const defensiveRef = rig.cache.allocateRef(nullTitleRef, `poster:${randomUUID()}`, 'poster');
    await expectDomainError(rig.fetch(HOUSEHOLD, defensiveRef), 404, 'NOT_FOUND');
  });

  it('H4 响应与失败映射:非 image 502;gzip 编码 502;许可拒绝 502;空闲/字节超预算 504', async () => {
    const rig = makeFixture();
    const cases: readonly (readonly [ReadOutcome, number, string])[] = [
      [{ kind: 'html' }, 502, 'VOD_UPSTREAM_FAILED'],
      [{ kind: 'image', contentEncoding: 'gzip' }, 502, 'VOD_UPSTREAM_FAILED'],
      [{ kind: 'denied' }, 502, 'VOD_UPSTREAM_FAILED'],
      [{ kind: 'idle-timeout' }, 504, 'VOD_UPSTREAM_TIMEOUT'],
      [{ kind: 'oversize' }, 504, 'VOD_UPSTREAM_TIMEOUT'],
    ];
    for (const [outcome, status, code] of cases) {
      rig.setReadOutcome(outcome);
      await expectDomainError(rig.fetch(HOUSEHOLD, rig.posterRef), status, code);
    }
    // 失败后 ref 与绑定不受影响:恢复 image 后同 ref 仍可用(纯读,无状态副作用)
    rig.setReadOutcome({ kind: 'image' });
    const content = await rig.fetch(HOUSEHOLD, rig.posterRef);
    expect(content.bytes.toString('utf8')).toBe('fake-image-bytes');
  });
});
