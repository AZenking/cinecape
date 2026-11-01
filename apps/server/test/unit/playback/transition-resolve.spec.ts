/**
 * 010-online-vod T061(US3)—— resolve 消费事务精化语义单元契约(零网络)。
 *
 * 覆盖面(T061 交付 1/2/3/4 的单元面;编排级 HTTP 契约归 T052 e2e C 组):
 * - A. resolve 请求严格判别 union(api §4):基础分支 {mediaId,startMode?} 与过渡分支
 *   {mediaId,transitionIntentId} 互斥 —— 两分支 .strict() additionalProperties 互斥,
 *   过渡请求携 startMode / 基础请求携 transitionIntentId / 未知字段一律 400 形态;
 * - B. prepareTransitionSuccessor 精化(resolver 过渡终段,时序复用 T043 finalize 先例):
 *   probe 后经 T041 computeStartPosition 带 expectedHistoryRevision 重读当前历史
 *   (内部 compareTargetHistoryRevision 经过渡快照)—— 重验通过冻结消费时刻位置
 *   (FR-021 冻结一次)/ 漂移 → 会话 failed(注册词表修订冲突族,HTTP/客户端面映射
 *   409 NEXT_PLAN_CHANGED;不冻结不 ready 不复活源)/ beginning 冻结 0 且不受计划
 *   历史漂移影响 / probe 未知 duration 按 E1 语义(不做历史时长兜底)/ 非计划路径
 *   (无 expectedHistoryRevision)不重验;
 * - C. resolveTransition 消费事务精化:consumed 重放经 successorPreparer.toDto 全保真
 *   (PlaybackDto 形态;缺位装配回退最小状态视图)/ 来源只读上下文授权(T059 完整端口)
 *   进消费事务首步(未终态 409 SOURCE_NOT_TERMINAL / 跨上下文 404 同形,零消费写);
 * - D. 过渡桶限频接入(10/min/DeviceSession;api §0):budgets 数值权威 +
 *   'transition_intent' 桶词表 + 服务两入口(next-plans/transition-intents)共享桶。
 *
 * 夹具分层(零网络):resolver 以记录型 stub 仓储/端口 + 真实 T041
 * VodStartPositionService(裁决注入真实 T039 resolveStartPoint 纯函数)+ 真实
 * PlaybackRateLimitService;transition 服务以最小记录型端口直构。probe 永不触网
 * (probe stub 直接返回成功事实);FFmpeg/上游零接触。
 *
 * 权威依据:docs/specs/010-online-vod/contracts/api.md §4/§0/§7 I3(重放 200 同后继
 * 当前状态;严格 oneOf;10/min/DeviceSession;target_history 在 probe 后仍读取当前
 * 历史,漂移准备失败 NEXT_PLAN_CHANGED,会话 failed 不复活源,冻结起点后历史更新不改
 * 起点)+ internal-ports §2(消费事务首步来源授权;probe 在 commit 后)+ ui.md §47
 * (probe 后历史变化导致失败,提示重新选择,不自动连跳)。
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '@platform/http-common/domain-error';
import { createPlaybackBudgets, type PlaybackBudgets } from '@platform/config/playback-budgets';
import { loadEnv } from '@platform/config/env.schema';
import { ProblemCode } from '@hmp/shared';
import { resolveRequestContractSchema } from '@contexts/playback/interface/playback.controller';
import {
  PlaybackResolverService,
  type PlaybackProbeFacts,
  type PlaybackProbePort,
  type PlaybackResolverPorts,
} from '@contexts/playback/application/playback-resolver.service';
import { VodStartPositionService } from '@contexts/playback/application/vod-start-position.service';
import { resolveStartPoint } from '@contexts/online-vod';
import { PlaybackRateLimitService } from '@contexts/playback/application/playback-rate-limit.service';
import {
  PlaybackTransitionService,
  type TransitionConsumeTxPort,
  type TransitionConsumeWorkSetStores,
  type TransitionSessionStorePort,
} from '@contexts/playback/application/playback-transition.service';
import { TransitionSourceContextService } from '@contexts/playback/application/transition-source-context.service';
import { bindPlaybackStore } from '@contexts/playback/application/playback-store.port';
import type { PlaybackStore } from '@contexts/playback/application/playback-store.port';
import type { PlaybackSessionView } from '@contexts/playback/domain/playback.types';
import type { PlaybackDto } from '@contexts/playback/application/playback-resolver.service';
import type {
  InputBindingRow,
  TransitionIntentRow,
} from '@contexts/playback/application/playback-work-set.port';
import type { PlaybackTransitionStore } from '@contexts/playback/application/playback-transition-store.port';

/* ------------------------------------------------------------------ */
/* 共享夹具(记录型 stub;零网络)                                          */
/* ------------------------------------------------------------------ */

const HOUSEHOLD_ID = 'hh-t061';
const PROFILE_ID = 'prof-t061';
const MEDIA_ID = 'media-ep2-t061';
const SESSION_ID = 'sess-succ-t061';
const BINDING_ID = 'bind-t061';

function probeFacts(durationSeconds: number | null): PlaybackProbeFacts {
  return { durationSeconds, audioTracks: [], subtitleTracks: [] };
}

/** 会话视图(消费事务建档产物形态;state/failureCode 可换出) */
function sessionView(state: PlaybackSessionView['state'] = 'preparing', failureCode: string | null = null): PlaybackSessionView {
  return {
    id: SESSION_ID,
    householdId: HOUSEHOLD_ID,
    deviceSessionId: 'dsess-t061',
    deviceId: 'dev-t061',
    profileId: PROFILE_ID,
    mediaId: MEDIA_ID,
    state,
    delivery: null,
    generation: 1,
    version: 1,
    positionSeconds: 0,
    audioTrackId: null,
    subtitleTrackId: null,
    desiredPaused: false,
    profileContextVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: state === 'preparing' ? null : '2026-01-01T00:00:01.000Z',
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    failureCode,
  } as PlaybackSessionView;
}

/** 绑定行(冻结回读;start_basis 透传 —— 消费绑定面写入的 basis) */
function bindingRow(startBasis: InputBindingRow['startBasis']): InputBindingRow {
  return {
    id: BINDING_ID,
    householdId: HOUSEHOLD_ID,
    sessionId: SESSION_ID,
    generation: 1,
    playbackSourceId: 'psrc-t061',
    sourceId: 'src-t061',
    locatorRevision: 1,
    detailRevision: 1,
    contentRevision: 1,
    continuityRevision: 1,
    evidenceState: null,
    evidenceDigest: null,
    resolvedInputId: 'rin-t061',
    resolvedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    startBasis,
    frozenStartSeconds: null,
  } as InputBindingRow;
}

interface ResolverRig {
  resolver: PlaybackResolverService;
  readonly frozen: { readonly decisions: unknown[] };
  readonly readied: { count: number };
  readonly failures: { codes: string[] };
  /** 消费时刻目标历史(用例可改写制造漂移);null = 无历史 */
  history: { revision: number; positionSeconds: number; durationSeconds: number | null } | null;
  /** 仓储 stub 换出的最新会话视图(失败路径=failed 视图) */
  latestView: PlaybackSessionView;
  /** 消费绑定面写入的 start_basis(回读行透传用) */
  boundStartBasis: 'beginning' | 'target_history';
}

/**
 * resolver rig:probe stub(直接成功,duration 可注入)+ 真实 T041 起点计算(裁决注入
 * 真实 T039 resolveStartPoint)+ 记录型工作集(冻结/回读/ready/失败)+ seam 身份重验。
 */
function openResolverRig(options: { probeDurationSeconds: number | null }): ResolverRig {
  const rig: ResolverRig = {
    resolver: null as unknown as PlaybackResolverService,
    frozen: { decisions: [] },
    readied: { count: 0 },
    failures: { codes: [] },
    // 消费时刻:目标历史 revision=1、位置 120、时长 360(probe 后可被用例改写为漂移)
    history: { revision: 1, positionSeconds: 120, durationSeconds: 360 },
    latestView: sessionView(),
    boundStartBasis: 'target_history',
  };
  const startPosition = new VodStartPositionService({
    targetHistory: {
      readTargetHistory: () =>
        rig.history === null
          ? null
          : {
              mediaId: MEDIA_ID,
              positionSeconds: rig.history.positionSeconds,
              durationSeconds: rig.history.durationSeconds,
              completed: false,
              contentRevision: 1,
              continuityRevision: 1,
              revision: rig.history.revision,
              writerEpoch: 1,
            },
      readTargetMediaFacts: () => ({ online: true, contentRevision: 1, continuityRevision: 1 }),
    },
    adjudicator: { resolveStartPoint },
    staticResumeFreeze: { readResumeFreeze: () => 0 },
  });
  const repository = {
    failSession: (_sessionId: string, input: { failureCode: string }) => {
      rig.failures.codes.push(input.failureCode);
      rig.latestView = sessionView('failed', input.failureCode);
      return { ok: true, value: rig.latestView };
    },
    markReady: () => {
      rig.readied.count += 1;
      rig.latestView = { ...sessionView('ready'), delivery: 'direct' } as PlaybackSessionView;
      return { ok: true, value: rig.latestView };
    },
  };
  const ports = {
    startPosition,
    resolveWorkSet: {
      createSessionWithLedger: () => {
        throw new Error('夹具错误:过渡后继路径不得再次建档');
      },
      freezeStartOnce: (input: { decision: unknown }) => {
        rig.frozen.decisions.push(input.decision);
      },
      findActiveBinding: () => bindingRow(rig.boundStartBasis),
    },
  } as unknown as PlaybackResolverPorts;
  const probePort: PlaybackProbePort = {
    probeFirstAvailable: async () => ({
      playbackSourceId: 'psrc-t061',
      delivery: 'direct',
      facts: probeFacts(options.probeDurationSeconds),
    }),
  };
  // 身份上下文重验(T051 seam):绑定版本恒等当前版本 → ready 放行(生产装配经
  // PLAYBACK_STORE provider;单测 rig 直绑最小投影)
  bindPlaybackStore({
    findSessionContextBinding: () => ({ deviceSessionId: 'dsess-t061', profileContextVersion: 1 }),
    findDeviceSessionContextVersion: () => ({ profileContextVersion: 1 }),
  } as unknown as PlaybackStore);
  const budgets = { watchdog: { prepareTimeoutSeconds: 30, seekTimeoutSeconds: 15 } } as PlaybackBudgets;
  rig.resolver = new PlaybackResolverService(repository as never, {} as never, probePort, budgets, ports);
  return rig;
}

function prepareTransitionSuccessor(rig: ResolverRig, overrides: Record<string, unknown> = {}): Promise<void> {
  // 消费绑定面已按 positionMode 写入 start_basis(回读行透传基准)
  rig.boundStartBasis = (overrides['startBasis'] as ResolverRig['boundStartBasis'] | undefined) ?? 'target_history';
  return rig.resolver.prepareTransitionSuccessor({
    householdId: HOUSEHOLD_ID,
    profileId: PROFILE_ID,
    sessionId: SESSION_ID,
    generation: 1,
    version: 1,
    bindingId: BINDING_ID,
    mediaId: MEDIA_ID,
    deviceSessionId: 'dsess-t061',
    candidates: [{ playbackSourceId: 'psrc-t061', sourceId: 'src-t061' } as never],
    startBasis: 'target_history',
    frozenStartSeconds: 120,
    expectedHistoryRevision: 1,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* A. resolve 请求严格判别 union(api §4;T061 交付 1)                     */
/* ------------------------------------------------------------------ */

describe('T061 · A resolve 请求严格判别 union(分支互斥面)', () => {
  it('A1 过渡分支/基础分支各自解析;分支判别面正确', () => {
    const transition = resolveRequestContractSchema.parse({ mediaId: 'm-1', transitionIntentId: 'i-1' });
    expect('transitionIntentId' in transition).toBe(true);
    const base = resolveRequestContractSchema.parse({ mediaId: 'm-1', startMode: 'resume' });
    expect('transitionIntentId' in base).toBe(false);
    const defaultBase = resolveRequestContractSchema.parse({ mediaId: 'm-1' });
    expect('transitionIntentId' in defaultBase).toBe(false);
  });

  it('A2 互斥:过渡请求携 startMode / 基础请求携 transitionIntentId → 400 形态(两分支 additionalProperties 互斥)', () => {
    // 过渡分支携 startMode:startMode 是过渡分支的未知字段(strict)
    const bothKeys = resolveRequestContractSchema.safeParse({ mediaId: 'm-1', transitionIntentId: 'i-1', startMode: 'beginning' });
    expect(bothKeys.success, '过渡请求禁止 startMode 字段').toBe(false);
    // 基础分支携 transitionIntentId:transitionIntentId 是基础分支的未知字段(strict)
    const baseWithIntent = resolveRequestContractSchema.safeParse({ mediaId: 'm-1', startMode: 'resume', transitionIntentId: 'i-1' });
    expect(baseWithIntent.success, '基础请求禁止 transitionIntentId 字段').toBe(false);
  });

  it('A3 strict:未知字段与非法形态一律拒绝', () => {
    expect(resolveRequestContractSchema.safeParse({ mediaId: 'm-1', profileId: 'p-1' }).success).toBe(false);
    expect(resolveRequestContractSchema.safeParse({ mediaId: 'm-1', transitionIntentId: '' }).success).toBe(false);
    expect(resolveRequestContractSchema.safeParse({ mediaId: 'm-1', startMode: 'target_history' }).success).toBe(false);
    expect(resolveRequestContractSchema.safeParse({}).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* B. prepareTransitionSuccessor 精化(probe 后漂移重验/冻结一次)          */
/* ------------------------------------------------------------------ */

describe('T061 · B 过渡后继起点终段(probe 后重验 + FR-021 冻结一次)', () => {
  it('B1 target_history 重验通过:probe 后冻结消费时刻位置 120(T041 决策;ready 照常)', async () => {
    const rig = openResolverRig({ probeDurationSeconds: 90 });
    await prepareTransitionSuccessor(rig);
    expect(rig.failures.codes, '重验通过不失败').toEqual([]);
    expect(rig.readied.count).toBe(1);
    expect(rig.frozen.decisions.length).toBe(1);
    const decision = rig.frozen.decisions[0] as { startBasis: string; disposition: string; resumeReason: string; startSeconds: number };
    expect(decision.startBasis).toBe('target_history');
    expect(decision.disposition).toBe('resume');
    expect(decision.resumeReason).toBe('accepted');
    expect(decision.startSeconds, '冻结消费时刻目标历史位置(revision 相等 ⇒ 与 probe 时刻读取一致)').toBe(120);
    // DTO 全形态:冻结后起点视图透传 + presentationStart 冻结值
    const dto = rig.resolver.toDto(rig.latestView);
    expect(dto.startBasis).toBe('target_history');
    expect(dto.resumeDisposition).toBe('resume');
    expect(dto.presentationStartSeconds).toBe(120);
  });

  it('B2 历史漂移(probe 后 revision 推进)→ 会话 failed + NEXT_PLAN_CHANGED 语义;不冻结、不 ready', async () => {
    const rig = openResolverRig({ probeDurationSeconds: 90 });
    // 消费后、probe 后他设备再次写入目标历史:revision 1 → 2(位置亦变,但不用新位置替换)
    rig.history = { revision: 2, positionSeconds: 130, durationSeconds: 360 };
    await prepareTransitionSuccessor(rig);
    expect(rig.failures.codes, '漂移即准备失败(注册词表修订冲突族;HTTP/客户端面映射 409 NEXT_PLAN_CHANGED)').toEqual([
      'PLAYBACK_VERSION_CONFLICT',
    ]);
    expect(rig.frozen.decisions, '漂移不冻结起点(不用新位置替换用户确认)').toEqual([]);
    expect(rig.readied.count, '漂移不提交 ready').toBe(0);
    const dto = rig.resolver.toDto(rig.latestView);
    expect(dto.state).toBe('failed');
    expect(dto.failureCode).toBe('PLAYBACK_VERSION_CONFLICT');
  });

  it('B3 beginning 冻结 0(T041 显式从头);计划历史漂移不影响 beginning', async () => {
    const rig = openResolverRig({ probeDurationSeconds: 90 });
    rig.history = { revision: 2, positionSeconds: 130, durationSeconds: 360 };
    await prepareTransitionSuccessor(rig, { startBasis: 'beginning', frozenStartSeconds: undefined, expectedHistoryRevision: 1 });
    expect(rig.failures.codes, 'beginning 不受计划历史变化影响(T041 同语义)').toEqual([]);
    expect(rig.readied.count).toBe(1);
    const decision = rig.frozen.decisions[0] as { startBasis: string; disposition: string; resumeReason: string; startSeconds: number };
    expect(decision.startBasis).toBe('beginning');
    expect(decision.resumeReason).toBe('requested_beginning');
    expect(decision.startSeconds, 'beginning 冻结 0').toBe(0);
    const dto = rig.resolver.toDto(rig.latestView);
    expect(dto.startBasis).toBe('beginning');
    expect(dto.presentationStartSeconds).toBe(0);
  });

  it('B4 probe 未知 duration(E1):重验/冻结照常,duration 不从历史兜底', async () => {
    const rig = openResolverRig({ probeDurationSeconds: null });
    await prepareTransitionSuccessor(rig);
    expect(rig.failures.codes, 'probe 未知 duration 不作准备失败(未知 ≠ 漂移)').toEqual([]);
    expect(rig.readied.count).toBe(1);
    const decision = rig.frozen.decisions[0] as { startSeconds: number };
    expect(decision.startSeconds).toBe(120);
    const dto = rig.resolver.toDto(rig.latestView);
    expect(dto.durationSeconds, '线上 duration 不从历史(360)兜底 —— E1 语义').toBeNull();
    expect(dto.presentationStartSeconds).toBe(120);
  });

  it('B5 非计划路径(无 expectedHistoryRevision)不重验:target_history 直接冻结消费时刻位置', async () => {
    const rig = openResolverRig({ probeDurationSeconds: 90 });
    rig.history = { revision: 2, positionSeconds: 130, durationSeconds: 360 };
    await prepareTransitionSuccessor(rig, { expectedHistoryRevision: undefined });
    expect(rig.failures.codes, '省略基准 = 非计划路径不比对(compareTargetHistoryRevision 语义)').toEqual([]);
    const decision = rig.frozen.decisions[0] as { startSeconds: number };
    expect(decision.startSeconds).toBe(120);
  });
});

/* ------------------------------------------------------------------ */
/* C. resolveTransition 消费事务精化(重放保真/来源授权进事务)              */
/* ------------------------------------------------------------------ */

/** intent 行(状态可换出;pending 行 createdAt 取当前时钟 −1s 保证未过 TTL) */
function intentRowOf(status: 'pending' | 'consumed', successorId: string | null): TransitionIntentRow {
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  return {
    id: 'intent-t061',
    householdId: HOUSEHOLD_ID,
    fromSessionId: 'sess-src-t061',
    fromGeneration: 1,
    deviceSessionId: 'dsess-t061',
    profileId: PROFILE_ID,
    profileContextVersion: 1,
    action: 'manual_next',
    targetMediaId: MEDIA_ID,
    targetContentRevision: 1,
    targetContinuityRevision: 1,
    targetLocatorRevision: 1,
    matchRevision: 1,
    matchConfidence: 'high',
    confirmedAmbiguous: 0,
    positionMode: 'target_history',
    carryPositionSeconds: null,
    carryDurationSeconds: null,
    sourceLedgerSeq: null,
    sourceCheckpointGeneration: null,
    sourceCheckpointSeq: null,
    allowEarlierAcceptedPosition: null,
    finishReceiptId: null,
    operationKey: 'op-1',
    requestDigest: 'digest-1',
    slotRevision: 1,
    createdAt,
    expiresAt: new Date(Date.now() + 59_000).toISOString(),
    status,
    successorId,
    nextPlanId: null,
    planSequenceRevision: null,
    planDetailRevision: null,
    planHistoryRevision: null,
    planHistoryChoiceRequired: 0,
  } as TransitionIntentRow;
}

interface ServiceRig {
  service: PlaybackTransitionService;
  readonly calls: {
    readonly order: string[];
    consumeTransition: number;
    readonly txEntered: { value: boolean };
  };
  /** 来源会话只读投影(store stub 返回值;undefined = 来源不存在) */
  sourceRow: { deviceSessionId: string; profileId: string; profileContextVersion: number; state: string } | undefined;
  intentStatus: 'pending' | 'consumed';
}

/** SessionContext 形态(测试构造;身份字段取服务端行事实) */
function sessionContextOf(): never {
  return {
    session: {
      id: 'dsess-t061',
      householdId: HOUSEHOLD_ID,
      accountId: 'acc-t061',
      deviceId: 'dev-t061',
      activeProfileId: PROFILE_ID,
      expiresAt: '2026-01-02T00:00:00.000Z',
    },
    account: { id: 'acc-t061', householdId: HOUSEHOLD_ID, username: 'admin', role: 'admin' },
  } as never;
}

/** 消费服务最小 rig(重放/事务首步/限频面;记录型端口,零持久) */
function openServiceRig(options: {
  successorToDto?: (session: PlaybackSessionView) => PlaybackDto;
  rateLimit?: { acquire(deviceId: string): { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number } };
}): ServiceRig {
  const rig: ServiceRig = {
    service: null as unknown as PlaybackTransitionService,
    calls: { order: [], consumeTransition: 0, txEntered: { value: false } },
    sourceRow: undefined,
    intentStatus: 'consumed',
  };
  const storeStub = {
    findIntentById: (householdId: string, intentId: string) => {
      rig.calls.order.push('findIntentById');
      void householdId;
      return intentId === 'intent-t061' ? intentRowOf(rig.intentStatus, rig.intentStatus === 'consumed' ? SESSION_ID : null) : undefined;
    },
    findSourceSessionContext: (householdId: string, sessionId: string) => {
      rig.calls.order.push('findSourceSessionContext');
      void householdId;
      void sessionId;
      return rig.sourceRow === undefined
        ? undefined
        : { id: 'sess-src-t061', generation: 1, mediaId: 'media-ep1', endedAt: null, ...rig.sourceRow };
    },
    // 只读来源上下文的伴随投影(T059 授权返回面;本 rig 无绑定/receipt/ledger 行)
    findSourceActiveBinding: () => undefined,
    findFinishReceiptBySession: () => undefined,
    findSourceLedgerCheckpoint: () => undefined,
    findSlot: () => undefined,
    consumeTransition: () => {
      rig.calls.consumeTransition += 1;
      throw new Error('夹具错误:重放/拒绝路径不得触达消费提交');
    },
  };
  const sourceContext = new TransitionSourceContextService(storeStub as unknown as PlaybackTransitionStore);
  const consumeTx: TransitionConsumeTxPort = {
    runConsumeTx: (work: (stores: TransitionConsumeWorkSetStores) => void) => {
      rig.calls.txEntered.value = true;
      rig.calls.order.push('tx:enter');
      work({
        playback: {
          findIntent: () => undefined,
          findSlot: () => undefined,
          findPlan: () => undefined,
          insertPreparingSession: () => undefined,
        },
        personalData: {
          findVodPreferences: () => ({ autoplayNext: true }),
          allocateProgressEpoch: () => 1,
          insertLedgerRow: () => undefined,
        },
      });
    },
  };
  const sessionStore: TransitionSessionStorePort = {
    getSession: (householdId: string, sessionId: string) => {
      rig.calls.order.push('getSession');
      void householdId;
      void sessionId;
      return { ok: true, value: sessionView() };
    },
    failSession: () => undefined,
  };
  rig.service = new PlaybackTransitionService({
    store: storeStub as unknown as ConstructorParameters<typeof PlaybackTransitionService>[0]['store'],
    sourceContext,
    identity: {
      findTrustedSession: (deviceSessionId: string) => {
        rig.calls.order.push('identity');
        void deviceSessionId;
        return { activeProfileId: PROFILE_ID, profileContextVersion: 1 };
      },
    },
    vodFacts: {} as never,
    personalFacts: { findTargetHistory: () => null },
    targetAuthorizer: {
      authorizeResolve: async () => ({
        snapshot: { deviceId: 'dev-t061', profileContextVersion: 1 },
        candidates: [],
      }),
    },
    consumeTx,
    inputBinder: {} as never,
    successorPreparer: {
      prepareTransitionSuccessor: () => undefined,
      ...(options.successorToDto !== undefined ? { toDto: options.successorToDto } : {}),
    },
    sessionStore,
    ...(options.rateLimit !== undefined ? { transitionRateLimit: options.rateLimit } : {}),
  });
  return rig;
}

describe('T061 · C consumed 重放全保真 + 来源授权进事务', () => {
  it('C1 重放经 successorPreparer.toDto 全保真(PlaybackDto 形态,含起点视图/时长/冻结起点)', async () => {
    const rig = openServiceRig({
      successorToDto: (session) => ({
        id: session.id,
        state: session.state,
        version: session.version,
        generation: session.generation,
        desiredPaused: session.desiredPaused,
        delivery: session.delivery,
        positionSeconds: session.positionSeconds,
        durationSeconds: 90,
        timelineOffsetSeconds: 0,
        presentationStartSeconds: 120,
        ticketExpiresAt: null,
        playbackUrl: null,
        tracks: { audio: [], subtitles: [] },
        startBasis: 'target_history',
        resumeDisposition: 'resume',
        resumeReason: 'accepted',
      }),
    });
    const outcome = await rig.service.resolveTransition(sessionContextOf(), { mediaId: MEDIA_ID, transitionIntentId: 'intent-t061' });
    expect(outcome.kind).toBe('replayed');
    expect(outcome.sessionId).toBe(SESSION_ID);
    const dto = outcome.dto as Record<string, unknown>;
    expect(dto['startBasis'], '重放全保真:起点视图透传').toBe('target_history');
    expect(dto['resumeDisposition']).toBe('resume');
    expect(dto['durationSeconds'], '重放全保真:probe facts 时长透传').toBe(90);
    expect(dto['presentationStartSeconds'], '重放全保真:冻结起点透传').toBe(120);
    expect(rig.calls.order, '重放不触达消费事务/消费提交(成功重放不再执行计划过期/变化检查)').toEqual([
      'identity',
      'findIntentById',
      'getSession',
    ]);
    expect(rig.calls.consumeTransition).toBe(0);
  });

  it('C2 toDto 缺位(单测装配)回退最小状态视图;零消费写', async () => {
    const rig = openServiceRig({});
    const outcome = await rig.service.resolveTransition(sessionContextOf(), { mediaId: MEDIA_ID, transitionIntentId: 'intent-t061' });
    expect(outcome.kind).toBe('replayed');
    const keys = Object.keys(outcome.dto as Record<string, unknown>).sort();
    expect(keys, '最小回退视图保持 T060 键面(无起点视图)').toEqual([
      'delivery',
      'desiredPaused',
      'durationSeconds',
      'generation',
      'id',
      'playbackUrl',
      'positionSeconds',
      'presentationStartSeconds',
      'state',
      'ticketExpiresAt',
      'timelineOffsetSeconds',
      'tracks',
      'version',
    ]);
    expect(rig.calls.consumeTransition).toBe(0);
  });

  it('C3 来源只读上下文授权进消费事务首步:未终态 409 SOURCE_NOT_TERMINAL(事务内,零消费写)', async () => {
    const rig = openServiceRig({});
    rig.intentStatus = 'pending';
    rig.sourceRow = { deviceSessionId: 'dsess-t061', profileId: PROFILE_ID, profileContextVersion: 1, state: 'ready' };
    try {
      await rig.service.resolveTransition(sessionContextOf(), { mediaId: MEDIA_ID, transitionIntentId: 'intent-t061' });
      expect.unreachable('未终态来源应 409 SOURCE_NOT_TERMINAL');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).status).toBe(409);
      expect((error as DomainError).code).toBe(ProblemCode.SOURCE_NOT_TERMINAL);
    }
    expect(rig.calls.txEntered.value, '来源授权发生在消费事务内(§2 消费事务首步)').toBe(true);
    expect(rig.calls.order.indexOf('findSourceSessionContext')).toBeGreaterThan(rig.calls.order.indexOf('tx:enter'));
    expect(rig.calls.consumeTransition, '拒绝零消费写(intent 保持 pending 由回滚承担)').toBe(0);
  });

  it('C4 来源上下文失配(跨设备)→ 事务内 404 同形(不可判别存在性);零消费写', async () => {
    const rig = openServiceRig({});
    rig.intentStatus = 'pending';
    rig.sourceRow = { deviceSessionId: 'dsess-other', profileId: PROFILE_ID, profileContextVersion: 1, state: 'ended' };
    try {
      await rig.service.resolveTransition(sessionContextOf(), { mediaId: MEDIA_ID, transitionIntentId: 'intent-t061' });
      expect.unreachable('跨设备来源上下文应 404 同形');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).status).toBe(404);
      expect((error as DomainError).code).toBe(ProblemCode.PLAYBACK_NOT_FOUND);
    }
    expect(rig.calls.consumeTransition).toBe(0);
  });
});

describe('T061 · D 过渡桶限频接入(10/min/DeviceSession;api §0)', () => {
  it('D1 预算数值权威:transitionIntentsPerDeviceSessionPerMinute = 10', () => {
    const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
    expect(budgets.rateLimit.transitionIntentsPerDeviceSessionPerMinute).toBe(10);
  });

  it("D2 'transition_intent' 桶:10 次放行后拒绝 + Retry-After;按 DeviceSession 隔离且不影响 control 桶", () => {
    const budgets = createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' }));
    const limiter = new PlaybackRateLimitService(budgets);
    for (let index = 0; index < 10; index += 1) {
      expect(limiter.acquire('dev-1', 'transition_intent').ok, `第 ${index + 1} 次放行`).toBe(true);
    }
    const denied = limiter.acquire('dev-1', 'transition_intent');
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
    expect(limiter.acquire('dev-2', 'transition_intent').ok, '其他 DeviceSession 不受影响').toBe(true);
    expect(limiter.acquire('dev-1', 'control').ok, 'control 桶独立计数').toBe(true);
  });

  it('D3 服务接入:createIntent/createNextPlan 共享过渡桶,超限 429 PLAYBACK_RATE_LIMITED(先于身份/持久面)', async () => {
    let allowed = 2;
    const acquireCalls: string[] = [];
    const rig = openServiceRig({
      rateLimit: {
        acquire: (deviceId: string) => {
          acquireCalls.push(deviceId);
          allowed -= 1;
          return allowed >= 0 ? { ok: true } : { ok: false, retryAfterSeconds: 7 };
        },
      },
    });
    const intentCommand = {
      fromSessionId: 'sess-src-t061',
      expectedGeneration: 1,
      action: 'manual_next' as const,
      nextPlanRef: 'ref',
      positionMode: 'beginning' as const,
      expectedSlotRevision: 0,
      operationKey: 'op',
    };
    // (1) createNextPlan 计数 1(放行;后续校验拒绝与本面无关);
    await rig.service.createNextPlan(sessionContextOf(), { fromSessionId: 'sess-src-t061', expectedGeneration: 1, action: 'manual_next' }).catch(() => undefined);
    // (2) createIntent 计数 2(放行;后续校验拒绝与本面无关);
    await rig.service.createIntent(sessionContextOf(), intentCommand).catch(() => undefined);
    // (3) 第 4 次请求(桶容量 3)→ 429,且先于身份/持久面
    let denied: unknown;
    try {
      await rig.service.createIntent(sessionContextOf(), { ...intentCommand, operationKey: 'op-2' });
      expect.unreachable('超限应 429');
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(DomainError);
    expect((denied as DomainError).status).toBe(429);
    expect((denied as DomainError).code).toBe(ProblemCode.PLAYBACK_RATE_LIMITED);
    expect(acquireCalls, 'next-plans 与 transition-intents 共享同一过渡桶(api §0/§7)').toEqual([
      'dev-t061',
      'dev-t061',
      'dev-t061',
    ]);
    expect(rig.calls.order, '限频先于身份读取(计数点=进入服务的请求,防绕过)').toEqual([
      'identity',
      'findSourceSessionContext',
      'identity',
      'findSourceSessionContext',
    ]);
  });
});
