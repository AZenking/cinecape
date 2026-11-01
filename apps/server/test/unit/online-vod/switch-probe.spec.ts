/**
 * 010 T071 — 换源候选有界测速服务级单测(受控上游 stub,零真实网络)。
 *
 * 被测:contexts/online-vod/application/switch-probe.service.ts。
 * 装配方式(与 T070 switch-candidates.spec 同构,不经 HTTP/Nest):
 * - 有界缓存为真实 createVodCache(候选绑定走 T070 签发同形态 kind='preview' 载荷);
 * - 来源授权为受控 stub(404 同形/代次事实,授权语义已由 T070 spec 以真实 T059
 *   服务覆盖,此处不重复装配 playback 持久层);
 * - 上游读取为受控 stub:请求(url/deadlineMs/maxBytes/signal)全量捕获,支持
 *   即时应答/挂起至 abort/按码拒绝;零真实网络;
 * - 来源配置/策略门为受控 stub(启用/禁用、允许/拒绝逐用例设定)。
 *
 * 覆盖清单(T071 交付 1+4):授权面 404 同形零上游(未授权会话/代次失配/伪造与
 * 随机 ref/过期绑定/跨会话绑定)、可达分类(4 键形态/首响应延迟/输入序)、预算
 * (单候选 3s 收敛/全次 5s 总截止/1MiB 字节透传)、内部并发 3、取消传播(外部
 * AbortSignal → 上游 signal aborted)、逐候选授权短路(禁源/策略拒绝/无定位零
 * 上游)、零副作用(无 store 依赖面,stub 调用即全部外部效应)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '@platform/http-common/domain-error';
import { createVodCache } from '@contexts/online-vod/infrastructure/vod-cache';
import {
  SWITCH_PROBE_BUDGETS,
  createSwitchProbeService,
  type SwitchProbeBudgetShape,
  type VodProbeUpstreamFn,
  type VodProbeUpstreamOutcome,
} from '@contexts/online-vod/application/switch-probe.service';
import type { SwitchProbeCommand } from '@contexts/online-vod/application/switch-probe.service';
import type { VodCandidateBindingPayload } from '@contexts/online-vod/application/switch-candidates.service';
import type {
  PlaybackTransitionSourcePort,
  SwitchSourceContextFacts,
  SwitchSourceContextRequest,
} from '@contexts/online-vod/application/switch-candidates.service';
import type {
  VodSourceConfigurationPort,
  VodSourceEndpointSnapshot,
} from '@contexts/online-vod/application/publication-work-set.port';

/* ------------------------------------------------------------------ */
/* 受控 stub                                                             */
/* ------------------------------------------------------------------ */

const HH = 'hh-t071';
const FROM_SESSION = 'ps-t071';
const SOURCE = 'src-t071';
const GENERATION = 1;

const BUDGETS: SwitchProbeBudgetShape = {
  ...SWITCH_PROBE_BUDGETS,
  perCandidateTimeoutMs: 250,
  totalTimeoutMs: 400,
};

interface ProbeCall {
  readonly url: string;
  readonly deadlineMs: number;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
}

type ProbeRoute = VodProbeUpstreamOutcome | 'hang' | 'reject';

function createUpstreamStub(): { calls: ProbeCall[]; routes: Map<string, ProbeRoute>; upstream: VodProbeUpstreamFn } {
  const calls: ProbeCall[] = [];
  const routes = new Map<string, ProbeRoute>();
  return {
    calls,
    routes,
    upstream: (request) => {
      calls.push({ url: request.url, deadlineMs: request.deadlineMs, maxBytes: request.maxBytes, signal: request.signal });
      const route = routes.get(request.url) ?? { kind: 'reachable', latencyMs: 1 };
      if (route === 'hang') {
        return new Promise<VodProbeUpstreamOutcome>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              resolve({ kind: 'timeout' });
            },
            { once: true },
          );
        });
      }
      if (route === 'reject') {
        return Promise.reject(new Error('上游连接失败(受控 stub)'));
      }
      return Promise.resolve(route);
    },
  };
}

function createTransitionSourceStub(
  facts: SwitchSourceContextFacts | undefined,
): PlaybackTransitionSourcePort & { calls: SwitchSourceContextRequest[] } {
  const calls: SwitchSourceContextRequest[] = [];
  return {
    calls,
    authorizeReadonlySourceContext(request) {
      calls.push(request);
      if (facts === undefined) {
        throw new DomainError(404, ProblemCode.PLAYBACK_NOT_FOUND, '播放会话不存在');
      }
      return facts;
    },
  };
}

function createSourceConfigStub(input: {
  readonly enabled: boolean;
  readonly locatorRevision?: number;
}): VodSourceConfigurationPort {
  const snapshot: VodSourceEndpointSnapshot = {
    sourceId: SOURCE,
    name: '夹具源A',
    adapter: 'apple-cms-json',
    locatorRevision: input.locatorRevision ?? 1,
  };
  return {
    listEnabledVodSources: () => (input.enabled ? [snapshot] : []),
    readLocatorRevision: () => input.locatorRevision ?? 1,
    findSourceConfig: () => ({ householdId: HH, sourceId: SOURCE, adapter: 'apple-cms-json' }),
  };
}

function sourceFacts(overrides: Partial<SwitchSourceContextFacts> = {}): SwitchSourceContextFacts {
  return {
    fromSessionId: FROM_SESSION,
    generation: GENERATION,
    state: 'ready',
    mediaId: 'media-t071',
    endedAt: null,
    ...overrides,
  };
}

function baseCommand(overrides: Partial<SwitchProbeCommand> = {}): SwitchProbeCommand {
  return {
    householdId: HH,
    deviceSessionId: 'ds-t071',
    profileId: 'prof-t071',
    profileContextVersion: 1,
    fromSessionId: FROM_SESSION,
    expectedGeneration: GENERATION,
    candidateRefs: [],
    ...overrides,
  };
}

/** 签发 ref 登记表(名称 → allocateRef 产物;测试按名取 ref) */
const refByName = new Map<string, string>();

function refOf(name: string): string {
  const ref = refByName.get(name);
  expect(ref, `夹具错误:候选 ${name} 未签发`).toBeTruthy();
  return ref as string;
}

/** T070 签发同形态候选绑定(kind='preview';TTL 60s;返回 opaque ref) */
function putCandidateBinding(
  cache: ReturnType<typeof createVodCache>,
  candidateRef: string,
  overrides: {
    readonly householdId?: string;
    readonly fromSessionId?: string;
    readonly sourceGeneration?: number;
    readonly expiresAtMs?: number;
    readonly locatorUrl?: string | null;
    readonly sourceId?: string;
  } = {},
): void {
  const payload: VodCandidateBindingPayload = {
    kind: 'candidate-binding',
    sourceId: overrides.sourceId ?? SOURCE,
    sourceLabel: '夹具源A',
    upstreamVodId: '1001',
    lineKey: 'main',
    lineLabel: 'fixture正片',
    episodeKey: '01',
    episodeLabel: '第01集',
    title: 'fixture·星尘信使',
    year: '2024',
    locatorRevision: 1,
    previewRevision: 1,
    fetchedAtMs: Date.now(),
    matchConfidence: 'high',
    matchReasons: ['title_match', 'year_match', 'season_episode_match'],
    matchRuleVersion: 'online-vod-source-match-v1',
    fromSessionId: overrides.fromSessionId ?? FROM_SESSION,
    sourceGeneration: overrides.sourceGeneration ?? GENERATION,
    lines: [
      {
        lineKey: 'main',
        lineLabel: 'fixture正片',
        episodes: [
          {
            episodeKey: '01',
            label: '第01集',
            locatorUrl: overrides.locatorUrl === undefined ? 'http://127.0.0.1:9/hls/ep-01/master.m3u8' : overrides.locatorUrl,
          },
        ],
      },
    ],
  };
  // T070 签发同序:先 allocateRef 签发 opaque ref,绑定载荷以该 ref 为 id 直存注册表
  const ref = cache.allocateRef(candidateRef, 'candidate:0', 'episode');
  const ok = cache.put({
    id: ref,
    householdId: overrides.householdId ?? HH,
    kind: 'preview',
    sourceIds: [SOURCE],
    expiresAtMs: overrides.expiresAtMs ?? Date.now() + 60_000,
    payload,
  });
  expect(ok, '夹具错误:候选绑定 put 应成功').toBe(true);
  refByName.set(candidateRef, ref);
}

/* ------------------------------------------------------------------ */
/* rig                                                                   */
/* ------------------------------------------------------------------ */

interface Rig {
  readonly cache: ReturnType<typeof createVodCache>;
  readonly stub: ReturnType<typeof createUpstreamStub>;
  readonly transition: ReturnType<typeof createTransitionSourceStub>;
  readonly service: ReturnType<typeof createSwitchProbeService>;
}

const openCaches: ReturnType<typeof createVodCache>[] = [];

function createRig(overrides: {
  readonly facts?: SwitchSourceContextFacts | undefined;
  readonly source?: { readonly enabled: boolean; readonly locatorRevision?: number };
  readonly policyAllowed?: boolean;
  readonly budgets?: SwitchProbeBudgetShape;
} = {}): Rig {
  const cache = createVodCache();
  openCaches.push(cache);
  const stub = createUpstreamStub();
  const transition = createTransitionSourceStub('facts' in overrides ? overrides.facts : sourceFacts());
  const service = createSwitchProbeService({
    config: overrides.budgets ?? BUDGETS,
    cache,
    sourceConfig: createSourceConfigStub(overrides.source ?? { enabled: true }),
    transitionSource: transition,
    policyGate: { evaluateCandidateTarget: () => overrides.policyAllowed ?? true },
    probeUpstream: stub.upstream,
  });
  return { cache, stub, transition, service };
}

afterEach(() => {
  while (openCaches.length > 0) {
    openCaches.pop()?.dispose();
  }
});

function expectDomainError(error: unknown, status: number, code: string): void {
  expect(error).toBeInstanceOf(DomainError);
  const domainError = error as DomainError;
  expect(domainError.status).toBe(status);
  expect(String(domainError.code)).toBe(code);
}

/** 断言 promise 以指定形态 DomainError 拒绝(vitest 无 toSatisfy;手工消费拒绝) */
async function expectRejects(pending: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await pending;
    throw new Error(`夹具错误:应当以 ${status} ${code} 拒绝,实际正常收敛`);
  } catch (error) {
    expectDomainError(error, status, code);
  }
}

/* ------------------------------------------------------------------ */
/* 授权面:未授权 404 同形 + 零上游请求(FR-029「未授权目标不得探测」)      */
/* ------------------------------------------------------------------ */

describe('T071 · 授权面(先授权再测;404 同形零上游)', () => {
  it('来源会话未授权(404 同形):整单拒绝且零上游请求', async () => {
    const rig = createRig({ facts: undefined });
    putCandidateBinding(rig.cache, 'vod-candidate-a');
    await expectRejects(
      rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')] })),
      404,
      ProblemCode.PLAYBACK_NOT_FOUND,
    );
    expect(rig.stub.calls, '未授权会话不得产生任何上游请求').toHaveLength(0);
  });

  it('代次失配:与未授权同形 404(不可借错误判别存在性),零上游', async () => {
    const rig = createRig({ facts: sourceFacts({ generation: 2 }) });
    putCandidateBinding(rig.cache, 'vod-candidate-a');
    await expectRejects(
      rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')] })),
      404,
      ProblemCode.PLAYBACK_NOT_FOUND,
    );
    await expectRejects(
      createRig({ facts: undefined }).service.probe(baseCommand({ candidateRefs: ['nope'] })),
      404,
      ProblemCode.PLAYBACK_NOT_FOUND,
    );
    expect(rig.stub.calls).toHaveLength(0);
  });

  it('伪造/随机 candidateRef:404 同形且零上游请求;过期绑定同形 404', async () => {
    const rig = createRig();
    putCandidateBinding(rig.cache, 'vod-candidate-live');
    putCandidateBinding(rig.cache, 'vod-candidate-expired', { expiresAtMs: Date.now() - 1 });
    for (const ref of ['vod-candidate-forged-xyz', '3f1d2a4b-0000-4000-8000-000000000000', 'vod-candidate-expired']) {
      await expectRejects(
        rig.service.probe(baseCommand({ candidateRefs: [ref] })),
        404,
        ProblemCode.PLAYBACK_NOT_FOUND,
      );
    }
    expect(rig.stub.calls, '未授权目标探测不得触达任何上游').toHaveLength(0);
    // 存活绑定不受同单失败影响(逐用例独立)
    const ok = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-live')] }));
    expect(ok).toHaveLength(1);
  });

  it('绑定溯源失配(他会话/跨家庭/旧代次):同形 404,零上游', async () => {
    const rig = createRig();
    putCandidateBinding(rig.cache, 'vod-candidate-other-session', { fromSessionId: 'ps-other' });
    putCandidateBinding(rig.cache, 'vod-candidate-other-household', { householdId: 'hh-other' });
    putCandidateBinding(rig.cache, 'vod-candidate-old-generation', { sourceGeneration: 9 });
    for (const ref of ['vod-candidate-other-session', 'vod-candidate-other-household', 'vod-candidate-old-generation']) {
      await expectRejects(
        rig.service.probe(baseCommand({ candidateRefs: [ref] })),
        404,
        ProblemCode.PLAYBACK_NOT_FOUND,
      );
    }
    expect(rig.stub.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 可达分类与回执形态                                                     */
/* ------------------------------------------------------------------ */

describe('T071 · 可达分类(ProbeResult 4 键;首响应延迟;输入序)', () => {
  it('健康上游 reachable:4 键形态+ref 回显+latencyMs>=0+checkedAt;按输入序返回', async () => {
    const rig = createRig();
    putCandidateBinding(rig.cache, 'vod-candidate-a', { locatorUrl: 'http://127.0.0.1:9/hls/a/master.m3u8' });
    putCandidateBinding(rig.cache, 'vod-candidate-b', { locatorUrl: 'http://127.0.0.1:9/hls/b/master.m3u8' });
    rig.stub.routes.set('http://127.0.0.1:9/hls/b/master.m3u8', { kind: 'reachable', latencyMs: 7 });
    const items = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a'), refOf('vod-candidate-b')] }));
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.candidateRef)).toEqual([refOf('vod-candidate-a'), refOf('vod-candidate-b')]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['candidateRef', 'checkedAt', 'latencyMs', 'status']);
      expect(item.status).toBe('reachable');
      expect(item.latencyMs).toBeGreaterThanOrEqual(0);
      expect(new Date(item.checkedAt).toString()).not.toBe('Invalid Date');
    }
    // 上游请求只携带服务端绑定内定位;预算透传
    expect(rig.stub.calls).toHaveLength(2);
    expect(rig.stub.calls[0]?.maxBytes).toBe(BUDGETS.perCandidateMaxBytes);
    expect(rig.stub.calls[0]?.signal.aborted).toBe(false);
  });

  it('非清单响应/mpegurl 破体/传输故障:incompatible 与 unavailable 分类', async () => {
    const rig = createRig();
    putCandidateBinding(rig.cache, 'vod-candidate-a', { locatorUrl: 'http://127.0.0.1:9/a.m3u8' });
    putCandidateBinding(rig.cache, 'vod-candidate-b', { locatorUrl: 'http://127.0.0.1:9/b.m3u8' });
    putCandidateBinding(rig.cache, 'vod-candidate-c', { locatorUrl: 'http://127.0.0.1:9/c.m3u8' });
    rig.stub.routes.set('http://127.0.0.1:9/a.m3u8', { kind: 'unavailable' });
    rig.stub.routes.set('http://127.0.0.1:9/b.m3u8', { kind: 'incompatible' });
    rig.stub.routes.set('http://127.0.0.1:9/c.m3u8', 'reject');
    const items = await rig.service.probe(
      baseCommand({ candidateRefs: [refOf('vod-candidate-a'), refOf('vod-candidate-b'), refOf('vod-candidate-c')] }),
    );
    expect(items.map((item) => item.status)).toEqual(['unavailable', 'incompatible', 'unavailable']);
    for (const item of items) {
      expect(item.latencyMs, '非 reachable 结论 latencyMs 恒 null').toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 逐候选授权短路(零上游)                                                */
/* ------------------------------------------------------------------ */

describe('T071 · 逐候选授权短路(来源/策略/定位;零上游)', () => {
  it('来源禁用:invalidateSource + unavailable,零上游请求', async () => {
    const rig = createRig({ source: { enabled: false } });
    putCandidateBinding(rig.cache, 'vod-candidate-a');
    const items = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')] }));
    expect(items[0]?.status).toBe('unavailable');
    expect(items[0]?.latencyMs).toBeNull();
    expect(rig.stub.calls, '禁源候选不得触达上游').toHaveLength(0);
  });

  it('策略拒绝:unavailable,零上游请求(先授权再测)', async () => {
    const rig = createRig({ policyAllowed: false });
    putCandidateBinding(rig.cache, 'vod-candidate-a');
    const items = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')] }));
    expect(items[0]?.status).toBe('unavailable');
    expect(rig.stub.calls).toHaveLength(0);
  });

  it('绑定内无可用定位:unavailable,零上游请求', async () => {
    const rig = createRig();
    putCandidateBinding(rig.cache, 'vod-candidate-a', { locatorUrl: null });
    const items = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')] }));
    expect(items[0]?.status).toBe('unavailable');
    expect(rig.stub.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 预算与取消(单候选 3s/全次 5s 收敛;并发 3;外部 AbortSignal 传播)        */
/* ------------------------------------------------------------------ */

describe('T071 · 预算与取消传播', () => {
  it('挂起上游:单候选预算内收敛 timeout,候选级 signal 被 abort', async () => {
    const rig = createRig({ budgets: { ...BUDGETS, perCandidateTimeoutMs: 60, totalTimeoutMs: 5_000 } });
    putCandidateBinding(rig.cache, 'vod-candidate-a');
    rig.stub.routes.set('http://127.0.0.1:9/hls/ep-01/master.m3u8', 'hang');
    const startedAt = Date.now();
    const items = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')] }));
    const elapsedMs = Date.now() - startedAt;
    expect(items[0]?.status).toBe('timeout');
    expect(items[0]?.latencyMs).toBeNull();
    expect(elapsedMs, `单候选预算内收敛(实际 ${elapsedMs}ms)`).toBeLessThanOrEqual(500);
    expect(rig.stub.calls[0]?.signal.aborted, '预算到期必须 abort 上游读取').toBe(true);
  });

  it('全次总截止:多候选挂起在总预算内全部收敛(单候选预算不早于总截止时)', async () => {
    const rig = createRig({
      budgets: { ...BUDGETS, perCandidateTimeoutMs: 5_000, totalTimeoutMs: 120 },
    });
    for (const ref of ['vod-candidate-a', 'vod-candidate-b', 'vod-candidate-c']) {
      putCandidateBinding(rig.cache, ref, { locatorUrl: `http://127.0.0.1:9/hls/${ref}/master.m3u8` });
      rig.stub.routes.set(`http://127.0.0.1:9/hls/${ref}/master.m3u8`, 'hang');
    }
    const startedAt = Date.now();
    const items = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a'), refOf('vod-candidate-b'), refOf('vod-candidate-c')] }));
    const elapsedMs = Date.now() - startedAt;
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.status === 'timeout'), '全次预算内全部 timeout').toBe(true);
    expect(elapsedMs, `全次总截止内收敛(实际 ${elapsedMs}ms)`).toBeLessThanOrEqual(800);
    expect(rig.stub.calls.every((call) => call.signal.aborted), '总截止传播到全部候选上游').toBe(true);
  });

  it('内部并发 ≤3:4 候选挂起时同时在上游的请求不超过 3', async () => {
    const rig = createRig({ budgets: { ...BUDGETS, perCandidateTimeoutMs: 5_000, totalTimeoutMs: 5_000 } });
    const refs = ['a', 'b', 'c', 'd'].map((tag) => `vod-candidate-${tag}`);
    for (const ref of refs) {
      putCandidateBinding(rig.cache, ref, { locatorUrl: `http://127.0.0.1:9/hls/${ref}/master.m3u8` });
      rig.stub.routes.set(`http://127.0.0.1:9/hls/${ref}/master.m3u8`, 'hang');
    }
    let inFlight = 0;
    let maxInFlight = 0;
    const service = createSwitchProbeService({
      config: { ...BUDGETS, perCandidateTimeoutMs: 5_000, totalTimeoutMs: 5_000 },
      cache: rig.cache,
      sourceConfig: createSourceConfigStub({ enabled: true }),
      transitionSource: rig.transition,
      policyGate: { evaluateCandidateTarget: () => true },
      probeUpstream: (request) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<VodProbeUpstreamOutcome>((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => {
              inFlight -= 1;
              resolve({ kind: 'timeout' });
            },
            { once: true },
          );
        });
      },
    });
    const items = await service.probe(baseCommand({ candidateRefs: refs.map((name) => refOf(name)) }));
    expect(items.every((item) => item.status === 'timeout')).toBe(true);
    expect(maxInFlight, `内部并发上界 3(实际峰值 ${maxInFlight})`).toBeLessThanOrEqual(3);
  });

  it('取消传播:外部 AbortSignal 中止挂起上游并在预算内收敛', async () => {
    const rig = createRig({ budgets: { ...BUDGETS, perCandidateTimeoutMs: 5_000, totalTimeoutMs: 5_000 } });
    putCandidateBinding(rig.cache, 'vod-candidate-a', { locatorUrl: 'http://127.0.0.1:9/hls/hang/master.m3u8' });
    rig.stub.routes.set('http://127.0.0.1:9/hls/hang/master.m3u8', 'hang');
    const external = new AbortController();
    const startedAt = Date.now();
    const pending = rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')], signal: external.signal }));
    setTimeout(() => {
      external.abort();
    }, 40);
    const items = await pending;
    const elapsedMs = Date.now() - startedAt;
    expect(items[0]?.status, '外部取消按 timeout 收敛(响应整体已丢弃)').toBe('timeout');
    expect(elapsedMs, `外部取消预算内收敛(实际 ${elapsedMs}ms)`).toBeLessThanOrEqual(500);
    expect(rig.stub.calls[0]?.signal.aborted).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 零副作用                                                              */
/* ------------------------------------------------------------------ */

describe('T071 · 零副作用', () => {
  it('测速不产生任何持久/缓存写入:绑定条目原样存活,服务面无 store 依赖', async () => {
    const rig = createRig();
    putCandidateBinding(rig.cache, 'vod-candidate-a');
    const before = rig.cache.stats();
    const items = await rig.service.probe(baseCommand({ candidateRefs: [refOf('vod-candidate-a')] }));
    expect(items[0]?.status).toBe('reachable');
    const after = rig.cache.stats();
    // 唯一允许的缓存交互是读(绑定解析);条目数/字节/引用数零变化
    expect(after.entries).toBe(before.entries);
    expect(after.bytes).toBe(before.bytes);
    expect(after.refs).toBe(before.refs);
  });
});
