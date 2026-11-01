/**
 * 010 在线点播组合世界夹具(T005)。
 *
 * ⚠️ 顶部声明:本文件无任何真实凭据/密钥/令牌,全部标识(Profile/设备/会话/策略/
 *    地址)均为合成占位,仅供隔离测试使用;不发起任何真实网络请求。
 *
 * 零依赖声明:本目录夹具不 import 任何 src 业务模块与外部运行时依赖,仅引用
 * './fixture-upstream' 的纯构造器;所有钩子只定义接口与默认实现,由各故事测试
 * 注入被测代码(T010+ 落地后经由端口/Seam 注入,夹具不反向感知实现)。
 *
 * 组合面(与 tasks.md T005 一致):
 * - 两 Profile(成人/儿童,各含 policy 允许/阻止素材)+ 两 DeviceSession 标识;
 * - 来源×影片×线路×分集引用 fixture-upstream 构造器(3 健康 + 1 必超时源);
 * - 可控钩子:fixtureFakeClock(可推进 monotonic 时钟)、abort 注册表(模拟
 *   AbortSignal 触发)、step-failure planner(按步骤名/第 N 次注入事务故障,
 *   如 'materialize:map-resource')。
 *
 * 各故事用途(供后续测试直接消费):
 * - US1 搜索/预览/物化(T023/T024/T032…):upstream 源与影片世界 + stepFailure
 *   (materialize:* 步骤故障注入,验证整体回滚/幂等重放);
 * - US2 连续性/续播(T037/T038):不同 duration 媒体、key 清单、duration 未知
 *   形态 + fakeClock(推进超时/租约)+ abort(取消准备/换绑);
 * - US3 序列/完播(T053…):三集 N+1、缺集/重复编号/special、短片时长;
 * - US4 换源匹配/过渡(T068…):同名版本冲突两端 + 两 DeviceSession(跨设备
 *   过渡/他设备更新不改变起点);
 * - T008 单元事务:T005 只提供钩子接口与默认实现,事务行为断言由该任务编写。
 */
import {
  createFixtureUpstreamSet,
  FIXTURE_TITLE_KEYS,
  FIXTURE_UPSTREAM_FIXED_NOW_MS,
  type FIXTURE_SOURCE_IDS,
  type FixtureSourceAddress,
  type FixtureTitleWorld,
  type FixtureUpstream,
  type FixtureUpstreamSource,
} from './fixture-upstream';

/* ------------------------------------------------------------------ */
/* 主类型/构造器再导出(单一入口;详见 fixture-upstream.ts)                */
/* (010 T090 knip 清理:仅保留测试实际消费的面——未消费的种子/HLS/路由等   */
/*  类型与构造器再导出已删除,需要时自 './fixture-upstream' 直接 import)   */
/* ------------------------------------------------------------------ */

export type { FixtureSourceAddress, FixtureTitleWorld, FixtureUpstream, FixtureUpstreamSource } from './fixture-upstream';
export {
  FIXTURE_SOURCE_IDS,
  FIXTURE_TITLE_KEYS,
  FIXTURE_UPSTREAM_FIXED_NOW_MS,
} from './fixture-upstream';

/* ------------------------------------------------------------------ */
/* Profile 与 DeviceSession                                             */
/* ------------------------------------------------------------------ */

/** 夹具策略快照(纯数据占位;真实策略上下文由 policy 上下文实现,此处仅提供
 *  允许/阻止素材的确定性映射,供策略测试安排期望) */
export interface FixtureProfilePolicyStub {
  policyVersion: number;
  /** 未评级素材是否拒绝(对齐 spec「未评级拒绝」用例) */
  unratedBlocked: boolean;
  /** 允许的最高素材分级(夹具占位两级:general/mature) */
  maxRating: 'general' | 'mature';
  /** 允许名单(ADR0006 允许名单规则的夹具形态),元素为 FIXTURE_TITLE_KEYS 值 */
  allowedTitleKeys: readonly string[];
  blockedTitleKeys: readonly string[];
}

export interface FixtureProfile {
  profileId: string;
  displayName: string;
  kind: 'adult' | 'child';
  isMain: boolean;
  policy: FixtureProfilePolicyStub;
}

/** DeviceSession 标识(仅标识与版本/代数占位;真实会话由 identity/playback 建) */
export interface FixtureDeviceSession {
  deviceId: string;
  sessionKey: string;
  contextVersion: number;
  generation: number;
}

/* (010 T090 knip 清理:原 FixturePolicyDecision 类型与 evaluateFixturePolicyStub
 *  纯函数已删除——零消费,policy spec 以 judgmentFromStub 自行映射
 *  FixtureProfilePolicyStub → PolicyJudgment) */

/* ------------------------------------------------------------------ */
/* 可控钩子一:fakeClock(可推进 monotonic 时钟)                          */
/* ------------------------------------------------------------------ */

export interface FixtureFakeClock {
  /** 当前虚拟时间(毫秒);单调不减,不可回拨 */
  nowMs(): number;
  /** 等待给定毫秒;由 advanceMs 推进到期,不真实睡眠 */
  delay(ms: number): Promise<void>;
  /** 推进虚拟时间 now+ms,按到期顺序唤醒 delay 等待者(含推进期间新注册者) */
  advanceMs(ms: number): Promise<void>;
  /** 尚未到期的 delay 等待者数量(断言用) */
  pendingDelayCount(): number;
}

export function createFixtureFakeClock(options: { startMs?: number } = {}): FixtureFakeClock {
  let currentMs = options.startMs ?? FIXTURE_UPSTREAM_FIXED_NOW_MS;
  const waiters = new Set<{ dueAtMs: number; resolve: () => void }>();

  const takeNextDue = (limitMs: number): { dueAtMs: number; resolve: () => void } | undefined => {
    let next: { dueAtMs: number; resolve: () => void } | undefined;
    for (const waiter of waiters) {
      if (waiter.dueAtMs > limitMs) {
        continue;
      }
      if (next === undefined || waiter.dueAtMs < next.dueAtMs) {
        next = waiter;
      }
    }
    return next;
  };

  return {
    nowMs: () => currentMs,
    delay: (ms) =>
      new Promise<void>((resolve) => {
        waiters.add({ dueAtMs: currentMs + Math.max(0, ms), resolve });
      }),
    advanceMs: async (ms) => {
      const targetMs = currentMs + Math.max(0, ms);
      for (let next = takeNextDue(targetMs); next !== undefined; next = takeNextDue(targetMs)) {
        waiters.delete(next);
        currentMs = Math.max(currentMs, next.dueAtMs);
        next.resolve();
        // 让等待者 continuation 先运行(其可能再注册新的 delay),再继续推进
        await Promise.resolve();
      }
      currentMs = targetMs;
    },
    pendingDelayCount: () => waiters.size,
  };
}

/* ------------------------------------------------------------------ */
/* 可控钩子二:abort 注册表(模拟 AbortSignal 触发)                       */
/* ------------------------------------------------------------------ */

/** 结构性兼容 Node AbortSignal 的最小只读面(不依赖 DOM lib) */
export interface FixtureAbortSignal {
  readonly label: string;
  readonly aborted: boolean;
  readonly reason: string | null;
  /** 注册 abort 监听;已中止则立即以当前 reason 调用;返回退订函数 */
  addAbortListener(listener: (reason: string) => void): () => void;
}

export interface FixtureAbortHandle extends FixtureAbortSignal {
  /** 触发该信号(幂等;仅首次生效),reason 缺省 'fixture-abort' */
  abort(reason?: string): void;
}

export interface FixtureAbortRegistry {
  /** 创建(或复用同 label)可触发的中止信号 */
  create(label: string): FixtureAbortHandle;
  /** 只读视图;未创建过返回 null */
  get(label: string): FixtureAbortSignal | null;
  /** 按 label 触发;返回是否实际触发(首次) */
  abort(label: string, reason?: string): boolean;
  /** 触发全部信号,返回实际触发数量 */
  abortAll(reason?: string): number;
  /** 已创建的 label 清单(断言用) */
  labels(): readonly string[];
}

export function createFixtureAbortRegistry(): FixtureAbortRegistry {
  interface AbortRecord {
    label: string;
    aborted: boolean;
    reason: string | null;
    listeners: Set<(reason: string) => void>;
  }
  const records = new Map<string, AbortRecord>();

  const ensureRecord = (label: string): AbortRecord => {
    const existing = records.get(label);
    if (existing !== undefined) {
      return existing;
    }
    const record: AbortRecord = { label, aborted: false, reason: null, listeners: new Set() };
    records.set(label, record);
    return record;
  };

  const fire = (record: AbortRecord, reason: string): boolean => {
    if (record.aborted) {
      return false;
    }
    record.aborted = true;
    record.reason = reason;
    for (const listener of [...record.listeners]) {
      listener(reason);
    }
    return true;
  };

  return {
    create: (label) => {
      const record = ensureRecord(label);
      return {
        get label() {
          return record.label;
        },
        get aborted() {
          return record.aborted;
        },
        get reason() {
          return record.reason;
        },
        addAbortListener: (listener) => {
          if (record.aborted) {
            listener(record.reason ?? 'fixture-abort');
            return () => undefined;
          }
          record.listeners.add(listener);
          return () => record.listeners.delete(listener);
        },
        abort: (reason) => fire(record, reason ?? 'fixture-abort'),
      };
    },
    get: (label) => {
      const record = records.get(label);
      if (record === undefined) {
        return null;
      }
      return {
        label: record.label,
        get aborted() {
          return record.aborted;
        },
        get reason() {
          return record.reason;
        },
        addAbortListener: (listener) => {
          if (record.aborted) {
            listener(record.reason ?? 'fixture-abort');
            return () => undefined;
          }
          record.listeners.add(listener);
          return () => record.listeners.delete(listener);
        },
      };
    },
    abort: (label, reason) => {
      const record = records.get(label);
      return record === undefined ? false : fire(record, reason ?? 'fixture-abort');
    },
    abortAll: (reason) => {
      let fired = 0;
      for (const record of records.values()) {
        if (fire(record, reason ?? 'fixture-abort')) {
          fired += 1;
        }
      }
      return fired;
    },
    labels: () => [...records.keys()],
  };
}

/* ------------------------------------------------------------------ */
/* 可控钩子三:step-failure planner(按步骤名注入事务故障)                 */
/* ------------------------------------------------------------------ */

/** materialize 工作集步骤名(对齐 internal-ports.md §MaterializeWorkSet 顺序;
 *  命名以待实现的 application 用例为准,测试按需注入其中任意步骤) */
export const FIXTURE_MATERIALIZE_STEP_NAMES = [
  'materialize:idempotent-replay',
  'materialize:revalidate-context',
  'materialize:allocate-identity',
  'materialize:verify-policy',
  'materialize:cas-detail',
  'materialize:check-quota',
  'materialize:map-resource',
  'materialize:record-operation',
  'materialize:bump-revision',
  'materialize:commit',
] as const;

export type FixtureMaterializeStepName = (typeof FIXTURE_MATERIALIZE_STEP_NAMES)[number];

export interface FixtureStepFailurePlan {
  /** 要注入失败的步骤名(如 'materialize:map-resource';非枚举值亦可,按名字匹配) */
  stepName: string;
  /** 第几次进入该步骤时注入(1 起);缺省 1 */
  occurrence?: number;
  error: { code: string; message: string };
}

/** planner 命中计划时抛出;测试据此断言错误码与整体回滚 */
export class FixtureStepFailureError extends Error {
  readonly stepName: string;
  readonly occurrence: number;
  readonly code: string;

  constructor(stepName: string, occurrence: number, code: string, message: string) {
    super(`fixture step-failure[${stepName}#${occurrence}] ${code}: ${message}`);
    this.name = 'FixtureStepFailureError';
    this.stepName = stepName;
    this.occurrence = occurrence;
    this.code = code;
  }
}

export interface FixtureStepFailurePlanner {
  /** 每个事务步骤进入前调用;记录执行轨迹,命中计划时抛 FixtureStepFailureError */
  enterStep(stepName: string): void;
  /** 已执行步骤轨迹 [{stepName, occurrence}](断言回滚后哪些步骤已跑过) */
  executedSteps(): readonly { stepName: string; occurrence: number }[];
  /** 指定步骤已执行次数(0=从未执行) */
  stepExecutedCount(stepName: string): number;
  /** 清空轨迹与计数(不改变计划) */
  reset(): void;
}

export function createFixtureStepFailurePlanner(
  plans: readonly FixtureStepFailurePlan[] = [],
): FixtureStepFailurePlanner {
  const executed: { stepName: string; occurrence: number }[] = [];
  const counts = new Map<string, number>();

  return {
    enterStep: (stepName) => {
      const occurrence = (counts.get(stepName) ?? 0) + 1;
      counts.set(stepName, occurrence);
      executed.push({ stepName, occurrence });
      const plan = plans.find(
        (candidate) => candidate.stepName === stepName && (candidate.occurrence ?? 1) === occurrence,
      );
      if (plan !== undefined) {
        throw new FixtureStepFailureError(stepName, occurrence, plan.error.code, plan.error.message);
      }
    },
    executedSteps: () => [...executed],
    stepExecutedCount: (stepName) => counts.get(stepName) ?? 0,
    reset: () => {
      executed.length = 0;
      counts.clear();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 组合世界                                                             */
/* ------------------------------------------------------------------ */

export interface FixtureWorldHooks {
  /** 可推进 monotonic 时钟(超时/租约/过期推进) */
  clock: FixtureFakeClock;
  /** abort 注册表(模拟 AbortSignal 触发,按 label 取消) */
  abort: FixtureAbortRegistry;
  /** 事务故障注入(按步骤名/第 N 次抛错,验证回滚与幂等) */
  stepFailure: FixtureStepFailurePlanner;
}

export interface FixtureWorld {
  /** 来源×影片×线路×分集全部来自 fixture-upstream 构造器 */
  upstream: FixtureUpstream;
  /** 两 Profile:[成人, 儿童];儿童策略阻止版本冲突影片与超时源独占影片 */
  profiles: readonly [FixtureProfile, FixtureProfile];
  /** 两 DeviceSession 标识:[主设备, 副设备](跨设备过渡/续播场景) */
  deviceSessions: readonly [FixtureDeviceSession, FixtureDeviceSession];
  /** 跨源全部影片世界(按源注册顺序展开) */
  titleWorlds: readonly FixtureTitleWorld[];
  hooks: FixtureWorldHooks;
  findProfile(profileId: string): FixtureProfile | null;
  findDeviceSession(deviceId: string): FixtureDeviceSession | null;
  findTitleWorld(titleKey: string): FixtureTitleWorld | null;
  findSource(sourceId: string): FixtureUpstreamSource | null;
}

export interface FixtureWorldOptions {
  /** fakeClock 虚拟起点;缺省 FIXTURE_UPSTREAM_FIXED_NOW_MS */
  clockStartMs?: number;
  /** 必超时源超时毫秒;缺省 FIXTURE_SOURCE_DEFAULT_TIMEOUT_MS */
  timeoutSourceTimeoutMs?: number;
  /** 健康源超时毫秒;缺省同上 */
  healthySourceTimeoutMs?: number;
  /** 按源覆盖地址(默认回环/保留段占位地址) */
  sourceAddressOverrides?: Partial<Record<keyof typeof FIXTURE_SOURCE_IDS, FixtureSourceAddress>>;
}

function buildAdultProfile(): FixtureProfile {
  const allowedTitleKeys = Object.values(FIXTURE_TITLE_KEYS);
  return {
    profileId: 'fixture-profile-adult',
    displayName: '夹具·成人',
    kind: 'adult',
    isMain: true,
    policy: {
      policyVersion: 1,
      unratedBlocked: false,
      maxRating: 'mature',
      allowedTitleKeys,
      blockedTitleKeys: [],
    },
  };
}

function buildChildProfile(): FixtureProfile {
  return {
    profileId: 'fixture-profile-child',
    displayName: '夹具·儿童',
    kind: 'child',
    isMain: false,
    policy: {
      policyVersion: 1,
      unratedBlocked: true,
      maxRating: 'general',
      allowedTitleKeys: [FIXTURE_TITLE_KEYS.threeEpisodeSerial, FIXTURE_TITLE_KEYS.gappedDuplicateSeries],
      blockedTitleKeys: [
        FIXTURE_TITLE_KEYS.echoTheatrical,
        FIXTURE_TITLE_KEYS.echoDirectorsCut,
        FIXTURE_TITLE_KEYS.standaloneMovie,
      ],
    },
  };
}

function buildDeviceSessions(): readonly [FixtureDeviceSession, FixtureDeviceSession] {
  return [
    { deviceId: 'fixture-device-primary', sessionKey: 'fixture-device-session-primary', contextVersion: 1, generation: 1 },
    { deviceId: 'fixture-device-secondary', sessionKey: 'fixture-device-session-secondary', contextVersion: 1, generation: 1 },
  ];
}

/** 组合完整世界:上游集 + 两 Profile + 两 DeviceSession + 三类可控钩子 */
export function createFixtureWorld(options: FixtureWorldOptions = {}): FixtureWorld {
  const upstream = createFixtureUpstreamSet({
    timeoutSourceTimeoutMs: options.timeoutSourceTimeoutMs,
    healthySourceTimeoutMs: options.healthySourceTimeoutMs,
    sourceAddressOverrides: options.sourceAddressOverrides,
  });
  const profiles: [FixtureProfile, FixtureProfile] = [buildAdultProfile(), buildChildProfile()];
  const deviceSessions = buildDeviceSessions();

  return {
    upstream,
    profiles,
    deviceSessions,
    titleWorlds: upstream.sources.flatMap((source) => [...source.titleWorlds]),
    hooks: {
      clock: createFixtureFakeClock({ startMs: options.clockStartMs }),
      abort: createFixtureAbortRegistry(),
      stepFailure: createFixtureStepFailurePlanner(),
    },
    findProfile: (profileId) => profiles.find((profile) => profile.profileId === profileId) ?? null,
    findDeviceSession: (deviceId) =>
      deviceSessions.find((session) => session.deviceId === deviceId) ?? null,
    findTitleWorld: (titleKey) =>
      upstream.sources
        .flatMap((source) => [...source.titleWorlds])
        .find((world) => world.titleKey === titleKey) ?? null,
    findSource: (sourceId) => upstream.findSource(sourceId),
  };
}
/* 010 T090 knip 清理:policyDecisionFor 便捷封装已删除(零消费;测试经
 * evaluateFixturePolicyStub 直判) */
