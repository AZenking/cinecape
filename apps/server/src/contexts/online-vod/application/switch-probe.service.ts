/**
 * 010 T071 — 换源候选有界测速用例(application)。
 *
 * 纯函数模块惯例(对齐 switch-candidates.service):依赖经参数注入函数束
 * (SwitchProbeServiceDeps,供接口层组合根装配);本服务零 DB 写、零会话写、
 * 零历史写、零票据签发——「不登记媒体、不创建 session/epoch」由依赖面钉死
 * (类型面没有任何 store/uow/participant 入口),internal-ports.md §3。
 *
 * 行为契约(逐条即语义,docs/specs/010-online-vod/contracts/api.md §5 测速行 +
 * §1 ProbeResult + §0 限流 + internal-ports.md §3 + tasks.md T071 原文):
 * - 授权序:同上下文只读来源授权(PlaybackTransitionSourcePort 消费面,404 同形,
 *   与 T070 候选同端口)→ 代次校验(expectedGeneration ≠ 当前 generation 与未授权
 *   同形 404,api §0「不存在/跨家庭/非本设备/旧上下文按既有 404 同形」)。测速是
 *   「播放中的可达性诊断」(api §5「逐候选预览有效+策略检查后有界请求」;FR-029
 *   「用户无需退出重搜」),不设消费侧终态门——终态资格归 transition 消费(US4
 *   T072 面),failed 60s 恢复窗语义同样不属测速面;
 * - 未授权目标不探测(FR-029):candidateRef 必须解析为本家庭在册、未过期
 *   (isSwitchCandidateFresh,T070 签发同判)、kind='preview' 且载荷为
 *   candidate-binding、绑定原 fromSessionId/generation 的候选绑定;任一失配与
 *   「从未签发」同形 404 整单拒绝(不可借错误判别存在性),且此时零上游请求
 *   (先授权再测,T071 原文「先授权再测」);绑定过期语义同形 404(过期引用不可
 *   判别于伪造引用,api §6「同形」口径);
 * - 逐候选策略授权(服务端事实先授权再测):来源必须启用且定位修订与绑定一致
 *   (失配先失效缓存再判不可用,对齐 T028 preview「先失效缓存再拒绝旧页」);
 *   目标内容策略经注入的 SwitchProbePolicyGate 以服务端已有映射事实判定
 *   (internal-ports §3「临时候选策略使用同一预分配/已有映射事实,不能把 ref 当
 *   媒体 ID 或只按 adult 展示模式放行」——本服务不构造伪媒体事实,策略输入完全
 *   由装配面供给);策略拒绝 → 该候选 unavailable,零上游请求;
 * - 有界请求:单候选 3s/1MiB、全次 5s 总截止、内部并发 3(api §5 逐字;数值经
 *   SwitchProbeBudgetShape 注入,缺省 SWITCH_PROBE_BUDGETS 契约值);候选定位地址
 *   取自服务端绑定载荷(私有面,绝不进任何 DTO/日志);上游读取经注入的
 *   VodProbeUpstreamFn(装配面接 SafeUpstreamPort:协议/DNS/每跳重定向/许可/
 *   AbortSignal 全维度校验,internal-ports §1);
 * - 取消传播(api §6「取消传播 AbortSignal,不能仅取消 UI 等待」):命令面携带
 *   外部 AbortSignal(接口层接请求断连),与全次总截止、单候选预算任一到期即
 *   abort 该候选上游读取;挂起上游在预算内收敛,不无界等待;
 * - 分类形态(api §1 ProbeResult.status):reachable=清单可读(首响应延迟;
 *   「名称是首清单/有限首片延迟,不宣称带宽/画质」);timeout=预算内未收敛
 *   (单候选/全次截止、上游空闲超时、外部中止);incompatible=上游自认 HLS
 *   (mpegurl)但响应体不是合法清单;unavailable=其余不可用(来源禁用/定位
 *   失配/策略拒绝/传输故障/非清单响应/字节超限)。latencyMs 仅 reachable 携带,
 *   其余恒 null;checkedAt 为该候选结论定格时刻(UTC ISO8601);
 * - 回执与请求候选引用一一对应、按输入序(api §5「200{items:ProbeResult[]}」);
 *   上游地址、清单内容、定位物料零下发(响应只有 4 键纯值)。
 */

import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import type { VodSourceConfigurationPort } from './publication-work-set.port';
import { isSwitchCandidateFresh } from '../domain/source-match.rules';
import type { VodCache } from '../infrastructure/vod-cache';
import type {
  PlaybackTransitionSourcePort,
  SwitchSourceContextFacts,
  SwitchSourceContextRequest,
} from './switch-candidates.service';
import type { VodCandidateBindingPayload } from './switch-candidates.service';

/* ------------------------------------------------------------------ */
/* 预算(契约冻结值;api §5「单候选3s/1MiB、全次5s,内部并发3」)            */
/* ------------------------------------------------------------------ */

/** 测速预算契约快照(api §5 逐字;装配面可整体注入收窄形态,不许放大) */
export const SWITCH_PROBE_BUDGETS = {
  /** 单候选上游总期限 ms(「单候选3s」) */
  perCandidateTimeoutMs: 3_000,
  /** 单候选响应字节上限(「1MiB」) */
  perCandidateMaxBytes: 1024 * 1024,
  /** 全次总截止 ms(「全次5s」) */
  totalTimeoutMs: 5_000,
  /** 内部并发(「内部并发3」;≤ ref 数) */
  concurrency: 3,
} as const;

/** 宽化预算形态(测试/装配可注入更小值;字段与 SWITCH_PROBE_BUDGETS 一一对应) */
export interface SwitchProbeBudgetShape {
  readonly perCandidateTimeoutMs: number;
  readonly perCandidateMaxBytes: number;
  readonly totalTimeoutMs: number;
  readonly concurrency: number;
}

/* ------------------------------------------------------------------ */
/* 上游读取与策略门(装配面注入;测试注入受控 stub)                        */
/* ------------------------------------------------------------------ */

/** 单候选上游读取请求(绝对期限;url 为服务端绑定内的私有定位,绝不入日志/DTO) */
export interface VodProbeUpstreamRequest {
  readonly url: string;
  /** 绝对截止 epoch ms(单候选预算与全次总截止的较早者) */
  readonly deadlineMs: number;
  readonly maxBytes: number;
  /** 取消传播:外部命令信号与预算计时合并后的候选级信号 */
  readonly signal: AbortSignal;
}

/** 上游读取结论(装配面按 SafeUpstream 稳定错误码/清单形态分类;服务照单映射) */
export type VodProbeUpstreamOutcome =
  | { readonly kind: 'reachable'; readonly latencyMs: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'incompatible' }
  | { readonly kind: 'unavailable' };

export type VodProbeUpstreamFn = (request: VodProbeUpstreamRequest) => Promise<VodProbeUpstreamOutcome>;

/**
 * 候选目标内容策略门(服务端事实;装配面实现):以已有稳定映射/预分配事实 +
 * 当前 Profile 策略判定(internal-ports §3)。返回 false 即策略拒绝——该候选
 * unavailable,零上游请求。本服务不提供任何按 ref 直判/按展示模式放行的捷径。
 */
export interface SwitchProbePolicyGate {
  evaluateCandidateTarget(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly sourceId: string;
    readonly upstreamVodId: string;
  }): boolean;
}

/* ------------------------------------------------------------------ */
/* 命令/响应纯值(api §5 200 形态;与冻结 ProbeResult 4 键逐字段对齐)       */
/* ------------------------------------------------------------------ */

/** 测速命令(Profile+原设备上下文由守卫推导;面内无 URL/客户端定位字段) */
export interface SwitchProbeCommand {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly profileId: string;
  readonly profileContextVersion: number;
  readonly fromSessionId: string;
  readonly expectedGeneration: number;
  /** 1–3 个候选引用(界外由接口层严格 DTO 拒绝;服务面再按逐条绑定校验) */
  readonly candidateRefs: readonly string[];
  /** 取消传播入口(接口层接请求断连;缺省 = 无外部取消) */
  readonly signal?: AbortSignal;
}

/** 单候选测速结论(api §1 ProbeResult 4 键;additionalProperties:false 同形) */
export interface SwitchProbeResultValues {
  readonly candidateRef: string;
  readonly status: 'reachable' | 'timeout' | 'incompatible' | 'unavailable';
  readonly latencyMs: number | null;
  readonly checkedAt: string;
}

/* ------------------------------------------------------------------ */
/* 依赖注入面                                                           */
/* ------------------------------------------------------------------ */

export interface SwitchProbeServiceDeps {
  /** 运行期预算(缺省 SWITCH_PROBE_BUDGETS;数值来源装配面,不硬编码扩张) */
  readonly config: SwitchProbeBudgetShape;
  /** 有界缓存 registry(与 T028/T070 同一单例;候选绑定载体,TTL 惰性判定) */
  readonly cache: VodCache;
  /** 来源配置端口(T015 发布面;启用来源清单/定位修订 CAS 读) */
  readonly sourceConfig: VodSourceConfigurationPort;
  /** 过渡来源只读端口(playback 所有;与 T070 候选同端口消费) */
  readonly transitionSource: PlaybackTransitionSourcePort;
  /** 候选目标内容策略门(服务端已有映射事实;见类型注释) */
  readonly policyGate: SwitchProbePolicyGate;
  /** 有界上游读取函数束(装配面接 SafeUpstreamPort;测试注入 stub,零真实网络) */
  readonly probeUpstream: VodProbeUpstreamFn;
  /** 注入时钟(测试确定性);缺省 Date.now */
  readonly nowMs?: () => number;
}

/* ------------------------------------------------------------------ */
/* 内部判定辅助                                                          */
/* ------------------------------------------------------------------ */

/** 与来源授权 404 完全同形的拒绝(不可借错误判别存在性;api §0) */
function sourceNotFound(): DomainError {
  return new DomainError(404, ProblemCode.PLAYBACK_NOT_FOUND, '播放会话不存在');
}

/** 来源定位是否健康(启用 + 绑定定位修订一致 + apple-cms-json;对齐 T028/T031 门) */
function isSourceAlive(
  sourceConfig: VodSourceConfigurationPort,
  householdId: string,
  sourceId: string,
  locatorRevision: number,
): boolean {
  const enabled = sourceConfig
    .listEnabledVodSources(householdId)
    .find((endpoint) => endpoint.sourceId === sourceId);
  const currentRevision = sourceConfig.readLocatorRevision(householdId, sourceId);
  const adapter = sourceConfig.findSourceConfig(householdId, sourceId)?.adapter;
  return (
    enabled !== undefined &&
    enabled.locatorRevision === locatorRevision &&
    currentRevision === locatorRevision &&
    adapter === 'apple-cms-json'
  );
}

/** http(s) 定位词法门(SafeUpstream 仍会做协议/内网/重定向全量校验;此处仅快筛) */
function isProbableHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 服务工厂                                                             */
/* ------------------------------------------------------------------ */

/**
 * 创建换源候选有界测速用例。返回面即接口层接线点:`probe(command)`。
 * 候选绑定随 VodCache 单例生存(TTL 惰性判定);本用例不落任何持久状态。
 */
export function createSwitchProbeService(deps: SwitchProbeServiceDeps): {
  probe(command: SwitchProbeCommand): Promise<readonly SwitchProbeResultValues[]>;
} {
  const now = deps.nowMs ?? (() => Date.now());

  /** 授权链:同上下文只读授权(404 同形)→ 代次(404 同形;无消费侧终态门) */
  function authorizeProbeSource(command: SwitchProbeCommand): SwitchSourceContextFacts {
    const request: SwitchSourceContextRequest = {
      householdId: command.householdId,
      deviceSessionId: command.deviceSessionId,
      profileId: command.profileId,
      profileContextVersion: command.profileContextVersion,
      fromSessionId: command.fromSessionId,
    };
    const context = deps.transitionSource.authorizeReadonlySourceContext(request);
    if (command.expectedGeneration !== context.generation) {
      // 未授权/旧代次同形 404(api §0「旧上下文按既有 404 同形」;不泄露代次事实)
      throw sourceNotFound();
    }
    return context;
  }

  /**
   * 候选绑定解析(T070 签发形态):绑定条目以 candidateRef 为 id 直存于缓存注册表
   * (与 T031 resolveStableTarget 的 titleRef 直读同形;任一失配即未授权 → 404 同形
   * 整单拒绝,零上游请求)。
   */
  function loadCandidateBinding(
    command: SwitchProbeCommand,
    context: SwitchSourceContextFacts,
    candidateRef: string,
  ): VodCandidateBindingPayload {
    const view = deps.cache.get<VodCandidateBindingPayload>(candidateRef);
    const payload = view?.payload;
    if (
      view === undefined ||
      view.householdId !== command.householdId ||
      view.kind !== 'preview' ||
      // TTL 把门(与 T070 签发同判:now < expiresAtMs;恰界即过期)
      view.expired ||
      !isSwitchCandidateFresh({ expiresAtMs: view.expiresAtMs }, now()) ||
      payload?.kind !== 'candidate-binding' ||
      // 绑定必须属于本来源会话与当前代次(api §7 I1 候选溯源)
      payload.fromSessionId !== command.fromSessionId ||
      payload.sourceGeneration !== context.generation
    ) {
      throw sourceNotFound();
    }
    return payload;
  }

  /** 绑定内锚定集定位地址(私有面;无锚定/无地址 → undefined → unavailable) */
  function locatorUrlOf(binding: VodCandidateBindingPayload): string | undefined {
    const line = binding.lines.find((entry) => entry.lineKey === binding.lineKey);
    const episode = line?.episodes.find((entry) => entry.episodeKey === binding.episodeKey);
    const url = episode?.locatorUrl ?? undefined;
    return url !== undefined && url.length > 0 && isProbableHttpUrl(url) ? url : undefined;
  }

  return {
    async probe(command: SwitchProbeCommand): Promise<readonly SwitchProbeResultValues[]> {
      // ── 授权链(任一候选未授权整单 404,零上游请求)──
      const context = authorizeProbeSource(command);
      const bindings = command.candidateRefs.map((candidateRef) =>
        loadCandidateBinding(command, context, candidateRef),
      );

      // ── 预算与取消传播(外部信号/全次总截止合并;候选级再取单候选较早截止)──
      const startedAtMs = now();
      const totalDeadlineMs = startedAtMs + deps.config.totalTimeoutMs;
      const external = new AbortController();
      const abortAll = (): void => {
        external.abort();
      };
      command.signal?.addEventListener('abort', abortAll, { once: true });
      const totalTimer = setTimeout(abortAll, Math.max(0, deps.config.totalTimeoutMs));
      totalTimer.unref?.();

      // ── 逐候选有界任务(并发 ≤ min(concurrency, ref 数);结论按输入序)──
      let cursor = 0;
      const outcomes: SwitchProbeResultValues[] = new Array(bindings.length);
      const workerCount = Math.max(1, Math.min(deps.config.concurrency, bindings.length));
      const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < bindings.length) {
          const slot = cursor;
          cursor += 1;
          const binding = bindings[slot];
          const candidateRef = command.candidateRefs[slot];
          if (binding === undefined || candidateRef === undefined) continue;
          outcomes[slot] = await probeOne(command, candidateRef, binding, totalDeadlineMs, external.signal);
        }
      });
      try {
        await Promise.all(workers);
      } finally {
        // 全次收敛即解除外部信号监听与总截止计时(不驻留事件循环)
        command.signal?.removeEventListener('abort', abortAll);
        clearTimeout(totalTimer);
      }
      return outcomes;
    },
  };

  /** 单候选:策略/来源/定位授权(零上游短路)→ 有界上游读取 → 4 键结论 */
  async function probeOne(
    command: SwitchProbeCommand,
    candidateRef: string,
    binding: VodCandidateBindingPayload,
    totalDeadlineMs: number,
    externalSignal: AbortSignal,
  ): Promise<SwitchProbeResultValues> {
    const checkedAt = new Date(now()).toISOString();
    const unavailable = (): SwitchProbeResultValues => ({
      candidateRef,
      status: 'unavailable',
      latencyMs: null,
      checkedAt,
    });

    // ── 先授权再测(任一授权失败零上游请求)──
    if (!isSourceAlive(deps.sourceConfig, command.householdId, binding.sourceId, binding.locatorRevision)) {
      // 来源禁用/配置失配:先失效该源缓存页再判不可用(对齐 T028 preview 语义)
      deps.cache.invalidateSource(command.householdId, binding.sourceId);
      return unavailable();
    }
    if (
      !deps.policyGate.evaluateCandidateTarget({
        householdId: command.householdId,
        profileId: command.profileId,
        sourceId: binding.sourceId,
        upstreamVodId: binding.upstreamVodId,
      })
    ) {
      return unavailable();
    }
    const locatorUrl = locatorUrlOf(binding);
    if (locatorUrl === undefined) {
      return unavailable();
    }

    // ── 有界读取:单候选预算 min(单候选, 全次剩余);候选级信号 = 外部 ∧ 计时 ──
    const candidateDeadlineMs = Math.min(
      now() + deps.config.perCandidateTimeoutMs,
      totalDeadlineMs,
    );
    const controller = new AbortController();
    const abortFromExternal = (): void => {
      if (externalSignal.aborted) {
        controller.abort();
      }
    };
    externalSignal.addEventListener('abort', abortFromExternal, { once: true });
    const candidateTimer = setTimeout(
      () => {
        controller.abort();
      },
      Math.max(0, candidateDeadlineMs - now()),
    );
    candidateTimer.unref?.();
    try {
      const outcome = await deps.probeUpstream({
        url: locatorUrl,
        deadlineMs: candidateDeadlineMs,
        maxBytes: deps.config.perCandidateMaxBytes,
        signal: controller.signal,
      });
      return {
        candidateRef,
        status: outcome.kind,
        latencyMs: outcome.kind === 'reachable' ? Math.max(0, outcome.latencyMs) : null,
        checkedAt,
      };
    } catch {
      // 上游函数未按结论形态收敛(编程错误面):按不可用收敛,不向客户端泄露
      return unavailable();
    } finally {
      externalSignal.removeEventListener('abort', abortFromExternal);
      clearTimeout(candidateTimer);
    }
  }
}
