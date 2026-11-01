/**
 * VOD 固定输入 store(010 T042,US2;ADR-0015 D1 infrastructure 角色)。
 *
 * 职责(T042 tasks.md 原文):返回固定 ResolvedVodInput 及私有绑定;逐字落实
 * 「每 session/generation 最多一有效绑定」「frozen_start_seconds(nullable直到probe)」
 * 「start_basis(beginning/target_history/transition_carry)」;地址不进入公共 DTO 或日志。
 *
 * 行为契约:apps/server/test/unit/playback/vod-input-binding.spec.ts 文件头
 * VodInputStoreSuggested 接口与 [T042-B/C/D/E/F] 用例(本文件以使其全绿为完成定义);
 * [T045-*] 4 例(watchdog 扫描面)同为本文件行为契约 —— T045 以真实实现替换扫描面
 * 占位(最小 diff:仅两方法函数体;节拍调度归 playback-retention.service)。
 *
 * 接口依据:
 * - docs/specs/010-online-vod/contracts/internal-ports.md §1 PlaybackInputLifecyclePort
 *   「probe/资产/转换统一消费输入ID及租约」;§3 ResolvedVodInput(resource/source/
 *   locator/detail/content/continuity revision、证据、私有入口、resolvedAt/expiresAt、
 *   请求策略ID)与「playback registry 持有会话引用/租约;probe/HLS代理/ffmpeg输入/seek
 *   均用该ID,不各自重读最新location」;
 * - docs/specs/010-online-vod/data-model.md §6(固定输入、generation及起点):
 *   「CAS推进generation+新绑定同resolved_input_id+旧代撤销/cleanup标记同事务;失败前
 *   无变化…seq不归零」「新代沿用输入,不暗换最新地址」「首次定位允许一次替换未接受的
 *   probe输入;先取消旧probe及输出再原子换引用」;
 * - contracts/playback-state.md §7「probe后结果只可提交当前代」。
 *
 * 私有性设计(§3「不对客户端公开」+ data-model §6「resolved_input/playback私有」):
 * - ResolvedVodInput 的入口 URL 等**网络事实只存本实例内存 registry(playback
 *   registry)**,不落任何表、不打任何日志;持久面 playback_input_binding 行仅持
 *   私有不透明 resolved_input_id(0007 DDL 注释同口径「入口 URL/请求策略不入库」);
 * - 对外返回值只含 resolvedInputId;entryUrl 仅在私有值对象上流转(经 T044 交付面
 *   /SafeUpstream 消费),返回类型即 JSDoc 双重声明(见 ResolvedVodInput私有注记)。
 *
 * 实现形态:与 transaction-participants(T016)/online-vod-store.drizzle(T027)同款 ——
 * better-sqlite3 原生 prepared statements,SELECT 以列别名投影 camelCase 行;多写语句
 * 包 BEGIN IMMEDIATE 短事务(失败整体回滚);若调用时连接已处于事务中(uow run 内)则
 * 并入外层事务,不再嵌套 BEGIN(T043 组合根可按两种形态接线)。resolve/bind 的上游
 * 网络解析(io.resolveUpstream)恒在事务外执行(§2「网络不在事务」),写回前同事务
 * 重读绑定保持幂等(并发双 resolve 只落一行,输赢双方返回同一 resolved_input_id)。
 *
 * 「仅冻结一次」归属说明(T042 缺口修复裁决,选项 b):冻结写面仍归 T016
 * InputBindingTx.freezeStartSeconds(transaction-participants,以 0007 新增持久列
 * frozen_at 守卫「已冻结(无论值)」),本 store 不重复暴露 freeze —— T041 起点冻结
 * 经既有事务参与者接线,新 store 与其共用同一持久判定,无第二冻结语义。
 *
 * 「一次替换」标记说明:replaceUnacceptedProbeInput 的「首次定位仅一次」已消耗标记
 * 随 playback registry(本实例内存)持有;持久面钉死的是其不可逆分支 —— probe 接受
 * (frozen_at 落值)后替换恒 409。未接受窗口本身秒级短暂且重启即中断 preparing
 * (启动恢复语义),不为其增设持久列。
 */
import { randomUUID } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import type { StartBasis } from '@contexts/playback/application/playback-work-set.port';

/* ------------------------------------------------------------------ */
/* 值模型(与 vod-input-binding.spec.ts 文件头逐字对齐)                    */
/* ------------------------------------------------------------------ */

/** 固定输入定位事实(store 经 io.resolveUpstream 注入的唯一上游读取点) */
export interface VodResolvedInputFacts {
  readonly entryUrl: string;
  readonly locatorRevision: number;
  readonly detailRevision: number | null;
  readonly contentRevision: number;
  readonly continuityRevision: number | null;
  readonly evidenceState: 'unverified' | 'verified';
  readonly evidenceDigest: string;
  readonly leaseSeconds: number;
}

/** 修订失配检测期望面(assertFixedInputCurrent 输入;省略维度不参与失配判定) */
export interface VodInputRevisionExpectation {
  readonly locatorRevision?: number;
  readonly detailRevision?: number | null;
  readonly contentRevision?: number;
  readonly continuityRevision?: number | null;
}

/** 回收清单行(watchdog 扫描面;T045 消费) */
export interface VodReclaimableSessionRow {
  readonly householdId: string;
  readonly sessionId: string;
  readonly readyAtMs: number;
}

/**
 * 私有解析事实(playback registry 运行时持有;§3「会话引用/租约」)。
 * ⚠️ entryUrl 为私有入口地址:绝不进入公共 DTO/日志/任何持久行。
 */
interface ResolvedInputRecord {
  readonly resolvedInputId: string;
  readonly entryUrl: string;
  readonly leaseExpiresAtMs: number;
  /** 旧输入租约撤销(replace 原子换引用时置位;§6「旧输入租约一并撤销」) */
  revoked: boolean;
}

/** 绑定行投影(仅含判定所需列;resolved_input_id 私有不透明,任意列零 URL 痕迹) */
interface VodBindingRow {
  readonly id: string;
  readonly generation: number;
  readonly playbackSourceId: string | null;
  readonly sourceId: string;
  readonly locatorRevision: number;
  readonly detailRevision: number | null;
  readonly contentRevision: number;
  readonly continuityRevision: number | null;
  readonly resolvedInputId: string;
  readonly resolvedAt: string;
  readonly expiresAt: string;
  readonly startBasis: string;
  readonly frozenStartSeconds: number | null;
  /** 持久冻结标记(NULL=尚未冻结;非 NULL=已冻结,无论 frozen_start_seconds 取值) */
  readonly frozenAt: string | null;
  readonly cleanupRequested: number;
}

/** 会话行投影(当前代/交付资格判定) */
interface VodSessionRow {
  readonly generation: number;
  readonly state: string;
  readonly playbackSourceId: string | null;
  readonly mediaId: string;
  readonly cleanupRequested: number;
}

/** 目录/来源当前修订投影(修订漂移重验;同 transaction-participants trustedFacts 的 JOIN 口径) */
interface CatalogRevisionRow {
  readonly contentRevision: number | null;
  readonly locatorRevision: number | null;
  readonly continuityRevision: number | null;
  readonly detailRevision: number | null;
}

/** T045/T062/T081 watchdog 扫描面输入/输出面(T045 实现;节拍调度归 playback-retention.service) */
export interface VodInputStore {
  resolveVodInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ resolvedInputId: string }>;
  bindFixedInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string; startBasis: StartBasis },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ bindingId: string }>;
  inputForDelivery(householdId: string, sessionId: string, generation: number): Promise<{ resolvedInputId: string }>;
  replaceUnacceptedProbeInput(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    nextInputId: string;
  }): Promise<void>;
  assertFixedInputCurrent(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    expected: VodInputRevisionExpectation;
  }): void;
  failSessionOnRevisionMismatch(command: { householdId: string; sessionId: string; generation: number; reason: string }): void;
  advanceGenerationWithRebind(command: {
    householdId: string;
    sessionId: string;
    expectedGeneration: number;
    nextGeneration: number;
  }): Promise<void>;
  assertGenerationDeliverable(householdId: string, sessionId: string, generation: number): void;
  assertProbeCommitGeneration(householdId: string, sessionId: string, generation: number): void;
  listReclaimableUnstartedReadySessions(input: { nowMs: number }): Promise<VodReclaimableSessionRow[]>;
  reclaimExpiredUnstartedReadySession(input: { householdId: string; sessionId: string; nowMs: number }): Promise<{ reclaimed: boolean }>;
}

/* ------------------------------------------------------------------ */
/* 语句常量(与 transaction-participants 同源口径;强制 household_id 条件)  */
/* ------------------------------------------------------------------ */

const BINDING_SELECT = `
  SELECT
    id,
    generation,
    playback_source_id AS playbackSourceId,
    source_id AS sourceId,
    locator_revision AS locatorRevision,
    detail_revision AS detailRevision,
    content_revision AS contentRevision,
    continuity_revision AS continuityRevision,
    resolved_input_id AS resolvedInputId,
    resolved_at AS resolvedAt,
    expires_at AS expiresAt,
    start_basis AS startBasis,
    frozen_start_seconds AS frozenStartSeconds,
    frozen_at AS frozenAt,
    cleanup_requested AS cleanupRequested
  FROM playback_input_binding
`;

const SESSION_SELECT = `
  SELECT
    generation,
    state,
    playback_source_id AS playbackSourceId,
    media_id AS mediaId,
    cleanup_requested AS cleanupRequested
  FROM playback_session
`;

/** 目录/来源当前修订(修订漂移重验输入;JOIN 链与 T016 findSessionTrustedFacts 同口径) */
const CATALOG_REVISION_SELECT = `
  SELECT
    mi.content_revision AS contentRevision,
    ms.locator_revision AS locatorRevision,
    ve.continuity_revision AS continuityRevision,
    vt.current_detail_revision AS detailRevision
  FROM playback_session s
  JOIN media_item mi ON mi.household_id = s.household_id AND mi.id = s.media_id
  LEFT JOIN playback_source ps ON ps.household_id = s.household_id AND ps.id = s.playback_source_id
  LEFT JOIN media_source ms ON ms.household_id = ps.household_id AND ms.id = ps.source_id
  LEFT JOIN vod_episode ve ON ve.household_id = s.household_id AND ve.media_id = s.media_id
  LEFT JOIN vod_line vl ON vl.household_id = ve.household_id AND vl.id = ve.line_id
  LEFT JOIN vod_title vt ON vt.household_id = vl.household_id AND vt.id = vl.title_id
  WHERE s.household_id = ? AND s.id = ?
`;

/** UTC ISO-8601(毫秒,Z;与迁移/事务参与者时间列同格式) */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 未起播 ready 会话固定回收期限(data-model §9:readyAt 起 60s,不因等待手势/heartbeat/renew 延长) */
const UNSTARTED_READY_RECLAIM_MS = 60_000;

/** null-aware 相等(detail/continuity 修订可空;NULL 只与 NULL 相等) */
function revisionEquals(frozen: number | null, other: number | null | undefined): boolean {
  if (frozen === null || other === undefined || other === null) {
    return frozen === null && (other === null || other === undefined);
  }
  return frozen === other;
}

/* ------------------------------------------------------------------ */
/* store 实现                                                            */
/* ------------------------------------------------------------------ */

type HandleSource = () => DatabaseConstructor.Database;

class DrizzleVodInputStore implements VodInputStore {
  /** playback registry(§3):resolved_input 网络事实运行时持有,不落库不打日志 */
  private readonly resolvedInputs = new Map<string, ResolvedInputRecord>();
  /** 「首次定位仅一次替换」已消耗标记(键 = household|session|generation;见文件头说明) */
  private readonly consumedReplacements = new Set<string>();

  constructor(
    private readonly handleSource: HandleSource,
    private readonly nowMs: () => number,
  ) {}

  /* ---------- 基础原语 ---------- */

  private handle(): DatabaseConstructor.Database {
    return this.handleSource();
  }

  /** BEGIN IMMEDIATE 短事务;连接已处于事务中(uow run 内)则并入外层,不嵌套 BEGIN */
  private inTx<T>(fn: () => T): T {
    const handle = this.handle();
    if (handle.inTransaction) {
      return fn();
    }
    return handle.transaction(fn).immediate();
  }

  private findBinding(householdId: string, sessionId: string, generation: number): VodBindingRow | undefined {
    return this.handle()
      .prepare(`${BINDING_SELECT} WHERE household_id = ? AND session_id = ? AND generation = ?`)
      .get(householdId, sessionId, generation) as VodBindingRow | undefined;
  }

  private findSession(householdId: string, sessionId: string): VodSessionRow | undefined {
    return this.handle()
      .prepare(`${SESSION_SELECT} WHERE household_id = ? AND id = ?`)
      .get(householdId, sessionId) as VodSessionRow | undefined;
  }

  private requireSession(householdId: string, sessionId: string): VodSessionRow {
    const session = this.findSession(householdId, sessionId);
    if (session === undefined) {
      throw new DomainError(404, ProblemCode.PLAYBACK_NOT_FOUND, '播放会话不存在,不能操作输入绑定');
    }
    return session;
  }

  /** 绑定行 playback_source_id 解析:优先会话行,preparing 缺源时按(家庭,媒体,来源)回查 */
  private resolvePlaybackSourceId(session: VodSessionRow, householdId: string, sourceId: string): string {
    if (session.playbackSourceId !== null) {
      return session.playbackSourceId;
    }
    const fallback = this.handle()
      .prepare(
        `SELECT id FROM playback_source WHERE household_id = ? AND media_item_id = ? AND source_id = ? ORDER BY id ASC LIMIT 1`,
      )
      .get(householdId, session.mediaId, sourceId) as { id: string } | undefined;
    if (fallback === undefined) {
      throw createDomainError('PLAYBACK_NOT_READY', '会话尚未确定播放来源,不能固定输入绑定');
    }
    return fallback.id;
  }

  /** 绑定行落库(frozen_start_seconds/frozen_at 恒 NULL 起:probe 前不冻结,T041 冻结经 T016 面) */
  private insertBinding(values: {
    householdId: string;
    sessionId: string;
    generation: number;
    playbackSourceId: string;
    sourceId: string;
    locatorRevision: number;
    detailRevision: number | null;
    contentRevision: number;
    continuityRevision: number | null;
    evidenceState: 'unverified' | 'verified';
    evidenceDigest: string;
    resolvedInputId: string;
    resolvedAt: string;
    expiresAt: string;
    startBasis: StartBasis;
    frozenStartSeconds: number | null;
  }): string {
    const id = randomUUID();
    this.handle()
      .prepare(
        `INSERT INTO playback_input_binding (
          id, household_id, session_id, generation, playback_source_id, source_id,
          locator_revision, detail_revision, content_revision, continuity_revision,
          evidence_state, evidence_digest, resolved_input_id, resolved_at, expires_at,
          start_basis, frozen_start_seconds, frozen_at, cleanup_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending')`,
      )
      .run(
        id,
        values.householdId,
        values.sessionId,
        values.generation,
        values.playbackSourceId,
        values.sourceId,
        values.locatorRevision,
        values.detailRevision,
        values.contentRevision,
        values.continuityRevision,
        values.evidenceState,
        values.evidenceDigest,
        values.resolvedInputId,
        values.resolvedAt,
        values.expiresAt,
        values.startBasis,
        values.frozenStartSeconds,
      );
    return id;
  }

  /* ---------- T042-B:resolve 幂等固定(上游全程恰一次) ---------- */

  async resolveVodInput(
    command: { householdId: string; sessionId: string; generation: number; sourceId: string },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ resolvedInputId: string }> {
    // 已有绑定即固定:代内重入/probe/资产/转换重复消费不重读最新 location(§3)
    const existing = this.findBinding(command.householdId, command.sessionId, command.generation);
    if (existing !== undefined) {
      return { resolvedInputId: existing.resolvedInputId };
    }
    // 网络解析在事务外(§2);恰一次:仅绑定缺失分支触达
    const facts = await io.resolveUpstream();
    const resolvedInputId = randomUUID();
    this.resolvedInputs.set(resolvedInputId, {
      resolvedInputId,
      entryUrl: facts.entryUrl,
      leaseExpiresAtMs: this.nowMs() + facts.leaseSeconds * 1000,
      revoked: false,
    });
    // 写回前同事务重读:并发 resolve 只落一行(「每 session/generation 最多一有效绑定」),
    // 输赢双方返回同一 resolved_input_id(幂等固定)
    return this.inTx(() => {
      const race = this.findBinding(command.householdId, command.sessionId, command.generation);
      if (race !== undefined) {
        // 并发输家:丢弃本次解析的 registry 记录,返回赢家同一 resolved_input_id
        this.resolvedInputs.delete(resolvedInputId);
        return { resolvedInputId: race.resolvedInputId };
      }
      const session = this.requireSession(command.householdId, command.sessionId);
      const playbackSourceId = this.resolvePlaybackSourceId(session, command.householdId, command.sourceId);
      const resolvedAtMs = this.nowMs();
      this.insertBinding({
        householdId: command.householdId,
        sessionId: command.sessionId,
        generation: command.generation,
        playbackSourceId,
        sourceId: command.sourceId,
        locatorRevision: facts.locatorRevision,
        detailRevision: facts.detailRevision,
        contentRevision: facts.contentRevision,
        continuityRevision: facts.continuityRevision,
        evidenceState: facts.evidenceState,
        evidenceDigest: facts.evidenceDigest,
        resolvedInputId,
        resolvedAt: iso(resolvedAtMs),
        expiresAt: iso(resolvedAtMs + facts.leaseSeconds * 1000),
        // resolve 固定输入时 basis 以中性值落座,bindFixedInput 确认最终 basis
        // (probe 冻结前可修正;冻结后绑定行事实不可变)
        startBasis: 'beginning',
        frozenStartSeconds: null,
      });
      return { resolvedInputId };
    });
  }

  /* ---------- T042-B:bind 固定(三值 start_basis;frozen NULL 直到 probe) ---------- */

  async bindFixedInput(
    command: {
      householdId: string;
      sessionId: string;
      generation: number;
      sourceId: string;
      startBasis: StartBasis;
    },
    io: { resolveUpstream: () => Promise<VodResolvedInputFacts> },
  ): Promise<{ bindingId: string }> {
    const existing = this.findBinding(command.householdId, command.sessionId, command.generation);
    let facts: VodResolvedInputFacts | null = null;
    let resolvedInputId: string;
    if (existing === undefined) {
      // 网络解析在事务外;本分支恰一次
      facts = await io.resolveUpstream();
      resolvedInputId = randomUUID();
      this.resolvedInputs.set(resolvedInputId, {
        resolvedInputId,
        entryUrl: facts.entryUrl,
        leaseExpiresAtMs: this.nowMs() + facts.leaseSeconds * 1000,
        revoked: false,
      });
    } else {
      resolvedInputId = existing.resolvedInputId;
    }
    return this.inTx(() => {
      const race = this.findBinding(command.householdId, command.sessionId, command.generation);
      if (race === undefined) {
        const session = this.requireSession(command.householdId, command.sessionId);
        const playbackSourceId = this.resolvePlaybackSourceId(session, command.householdId, command.sourceId);
        const resolvedAtMs = this.nowMs();
        const bindingId = this.insertBinding({
          householdId: command.householdId,
          sessionId: command.sessionId,
          generation: command.generation,
          playbackSourceId,
          sourceId: command.sourceId,
          locatorRevision: facts?.locatorRevision as number,
          detailRevision: facts?.detailRevision ?? null,
          contentRevision: facts?.contentRevision as number,
          continuityRevision: facts?.continuityRevision ?? null,
          evidenceState: facts?.evidenceState as 'unverified' | 'verified',
          evidenceDigest: facts?.evidenceDigest as string,
          resolvedInputId,
          resolvedAt: iso(resolvedAtMs),
          expiresAt: iso(resolvedAtMs + (facts?.leaseSeconds as number) * 1000),
          startBasis: command.startBasis,
          frozenStartSeconds: null,
        });
        return { bindingId };
      }
      // 已有绑定:确认最终 start_basis(probe 冻结前可修正;冻结后不可变),零新行
      if (race.startBasis !== command.startBasis && race.frozenAt === null) {
        this.handle()
          .prepare(`UPDATE playback_input_binding SET start_basis = ? WHERE household_id = ? AND id = ?`)
          .run(command.startBasis, command.householdId, race.id);
      }
      return { bindingId: race.id };
    });
  }

  /* ---------- T042-B:交付统一消费点(probe/资产/转换同 input) ---------- */

  async inputForDelivery(householdId: string, sessionId: string, generation: number): Promise<{ resolvedInputId: string }> {
    const binding = this.findBinding(householdId, sessionId, generation);
    if (binding === undefined) {
      throw createDomainError('PLAYBACK_NOT_READY', '该代次无有效输入绑定,不能交付');
    }
    return { resolvedInputId: binding.resolvedInputId };
  }

  /* ---------- T042-C:一次准备替换(原子换引用;第二次/已冻结 409) ---------- */

  async replaceUnacceptedProbeInput(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    nextInputId: string;
  }): Promise<void> {
    const session = this.requireSession(command.householdId, command.sessionId);
    // 仅 current generation 可换引用(§6;旧代先经 advanceGenerationWithRebind)
    if (command.generation !== session.generation) {
      throw new DomainError(409, ProblemCode.PLAYBACK_GENERATION_STALE, '旧代不能替换输入引用');
    }
    // probe 接受(frozen_at 持久标记)后恒拒绝 —— ready 提交只重验,不再换引用(§6)
    const binding = this.findBinding(command.householdId, command.sessionId, command.generation);
    if (binding === undefined) {
      throw createDomainError('PLAYBACK_NOT_READY', '该代次无有效输入绑定,不能替换');
    }
    if (binding.frozenAt !== null) {
      throw new DomainError(409, ProblemCode.PLAYBACK_VERSION_CONFLICT, '本次 probe 已接受(起点已冻结),不能替换输入引用');
    }
    const replacementKey = `${command.householdId}|${command.sessionId}|${command.generation}`;
    if (this.consumedReplacements.has(replacementKey)) {
      throw new DomainError(409, ProblemCode.PLAYBACK_VERSION_CONFLICT, '首次定位的一次替换已消耗,不能再次替换');
    }
    // 原子换引用:唯一绑定不变,仅 resolved_input_id 指向新输入(旧 probe/输出取消由
    // 调用方 commit 后执行;旧输入租约在此一并撤销)
    this.inTx(() => {
      this.handle()
        .prepare(
          `UPDATE playback_input_binding SET resolved_input_id = ?
           WHERE household_id = ? AND session_id = ? AND generation = ?`,
        )
        .run(command.nextInputId, command.householdId, command.sessionId, command.generation);
    });
    const superseded = this.resolvedInputs.get(binding.resolvedInputId);
    if (superseded !== undefined) {
      superseded.revoked = true;
    }
    this.consumedReplacements.add(replacementKey);
  }

  /* ---------- T042-D:四维修订失配检测(冻结 × 期望 × 目录当前) ---------- */

  assertFixedInputCurrent(command: {
    householdId: string;
    sessionId: string;
    generation: number;
    expected: VodInputRevisionExpectation;
  }): void {
    const binding = this.findBinding(command.householdId, command.sessionId, command.generation);
    if (binding === undefined) {
      throw createDomainError('PLAYBACK_NOT_READY', '该代次无有效输入绑定,不能重验固定输入');
    }
    const expected = command.expected;
    // 双重失配判定:data-model §3「旧会话修订不匹配时拒绝新交付/进度,准备转failed,需新 resolve」
    // 1) 绑定冻结修订 × 调用方期望修订(授权基线被改绑/漂移);
    // 2) 绑定冻结修订 × 目录当前修订(定位/详情/内容/连续性在冻结后推进;省略维度不参与)。
    const catalog = this.handle()
      .prepare(CATALOG_REVISION_SELECT)
      .get(command.householdId, command.sessionId) as CatalogRevisionRow | undefined;

    const assertDimension = (
      dimension: string,
      frozen: number | null,
      expectedValue: number | null | undefined,
      current: number | null,
    ): void => {
      if (expectedValue === undefined) {
        return; // 省略维度不参与失配判定
      }
      if (!revisionEquals(frozen, expectedValue)) {
        throw createDomainError(
          'MEDIA_VERSION_CONFLICT',
          `固定输入修订失配:${dimension}(冻结 ${String(frozen)} × 期望 ${String(expectedValue)}),需新 resolve`,
        );
      }
      if (!revisionEquals(frozen, current)) {
        throw createDomainError(
          'MEDIA_VERSION_CONFLICT',
          `固定输入修订失配:${dimension}(冻结 ${String(frozen)} × 当前 ${String(current)}),需新 resolve`,
        );
      }
    };

    assertDimension('locator_revision', binding.locatorRevision, expected.locatorRevision, catalog?.locatorRevision ?? null);
    assertDimension('detail_revision', binding.detailRevision, expected.detailRevision, catalog?.detailRevision ?? null);
    assertDimension('content_revision', binding.contentRevision, expected.contentRevision, catalog?.contentRevision ?? null);
    assertDimension('continuity_revision', binding.continuityRevision, expected.continuityRevision, catalog?.continuityRevision ?? null);
  }

  /* ---------- T042-D:修订失配终止(撤交付 + failed 同提交) ---------- */

  failSessionOnRevisionMismatch(command: { householdId: string; sessionId: string; generation: number; reason: string }): void {
    const endedAt = iso(this.nowMs());
    this.inTx(() => {
      // 终态写入(终态不可复活:仅活动态可提交;failed 的 failure_code 必填由 CHECK 落实)
      this.handle()
        .prepare(
          `UPDATE playback_session SET state = 'failed', failure_code = ?, ended_at = ?
           WHERE household_id = ? AND id = ? AND state NOT IN ('ended', 'failed', 'interrupted')`,
        )
        .run('MEDIA_VERSION_CONFLICT', endedAt, command.householdId, command.sessionId);
      // 撤交付资格同提交:session 清理标记(先阻止新票/资产)+ 该代绑定撤销(§6/§10)
      this.handle()
        .prepare(
          `UPDATE playback_session SET cleanup_requested = 1, cleanup_reason = ?, cleanup_state = 'pending'
           WHERE household_id = ? AND id = ?`,
        )
        .run(command.reason, command.householdId, command.sessionId);
      this.handle()
        .prepare(
          `UPDATE playback_input_binding SET cleanup_requested = 1, cleanup_reason = ?, cleanup_state = 'pending'
           WHERE household_id = ? AND session_id = ? AND generation = ?`,
        )
        .run(command.reason, command.householdId, command.sessionId, command.generation);
    });
  }

  /* ---------- T042-E:generation 原子换绑(CAS + 旧代撤销同事务) ---------- */

  async advanceGenerationWithRebind(command: {
    householdId: string;
    sessionId: string;
    expectedGeneration: number;
    nextGeneration: number;
  }): Promise<void> {
    this.inTx(() => {
      const session = this.requireSession(command.householdId, command.sessionId);
      // 代次回退拒绝:「失败后新代failed不倒退」的代次面(§6)
      if (command.nextGeneration <= session.generation) {
        throw new DomainError(
          409,
          ProblemCode.PLAYBACK_VERSION_CONFLICT,
          `代次不得回退(当前 ${session.generation},目标 ${command.nextGeneration})`,
        );
      }
      // CAS:expectedGeneration 与当前代失配即冲突抛错(守卫式 CAS 下读判写原子,
      // BEGIN IMMEDIATE 内无并发写者);零持久变化由整体回滚保证
      if (session.generation !== command.expectedGeneration) {
        throw new DomainError(
          409,
          ProblemCode.PLAYBACK_VERSION_CONFLICT,
          `陈旧 expectedGeneration(${command.expectedGeneration} ≠ 当前 ${session.generation}),换绑冲突`,
        );
      }
      const oldBinding = this.findBinding(command.householdId, command.sessionId, command.expectedGeneration);
      if (oldBinding === undefined) {
        throw createDomainError('PLAYBACK_NOT_READY', '旧代无有效输入绑定,不能换绑');
      }
      // CAS 推进 generation(version+1;同 transaction-participants.advanceGeneration 口径)
      this.handle()
        .prepare(
          `UPDATE playback_session SET generation = ?, version = version + 1
           WHERE household_id = ? AND id = ? AND generation = ?`,
        )
        .run(command.nextGeneration, command.householdId, command.sessionId, command.expectedGeneration);
      // 新绑定同 resolved_input_id:新代沿用输入,不暗换最新地址(§6);
      // frozen_start_seconds/frozen_at 从 NULL 起:新代 probe 后由 T041 冻结一次
      this.insertBinding({
        householdId: command.householdId,
        sessionId: command.sessionId,
        generation: command.nextGeneration,
        playbackSourceId: oldBinding.playbackSourceId as string,
        sourceId: oldBinding.sourceId,
        locatorRevision: oldBinding.locatorRevision,
        detailRevision: oldBinding.detailRevision,
        contentRevision: oldBinding.contentRevision,
        continuityRevision: oldBinding.continuityRevision,
        evidenceState: 'unverified',
        evidenceDigest: 'unverified',
        resolvedInputId: oldBinding.resolvedInputId,
        resolvedAt: oldBinding.resolvedAt,
        expiresAt: oldBinding.expiresAt,
        startBasis: oldBinding.startBasis as StartBasis,
        frozenStartSeconds: null,
      });
      // 旧代撤销(cleanup 标记)与新绑定同一 commit(§6);旧代绑定行保留为历史
      this.handle()
        .prepare(
          `UPDATE playback_input_binding SET cleanup_requested = 1, cleanup_reason = ?, cleanup_state = 'pending'
           WHERE household_id = ? AND session_id = ? AND generation = ?`,
        )
        .run(
          `generation advanced to ${command.nextGeneration}`,
          command.householdId,
          command.sessionId,
          command.expectedGeneration,
        );
    });
  }

  /* ---------- T042-F:仅 current generation 可新交付/probe 提交 ---------- */

  assertGenerationDeliverable(householdId: string, sessionId: string, generation: number): void {
    const session = this.requireSession(householdId, sessionId);
    if (session.state === 'ended' || session.state === 'failed' || session.state === 'interrupted') {
      throw createDomainError('PLAYBACK_ENDED', '播放会话已终态,不能签发新交付');
    }
    if (session.cleanupRequested === 1) {
      throw createDomainError('PLAYBACK_RESOURCE_UNAVAILABLE', '会话已请求清理,不能签发新交付');
    }
    if (generation !== session.generation) {
      // 旧代票据/资产/probe 提交一律 409 PLAYBACK_GENERATION_STALE(§6/playback-state §7)
      throw new DomainError(409, ProblemCode.PLAYBACK_GENERATION_STALE, '播放代次已更新,旧代不能交付');
    }
    const binding = this.findBinding(householdId, sessionId, generation);
    if (binding === undefined) {
      throw createDomainError('PLAYBACK_NOT_READY', '该代次无有效输入绑定,不能交付');
    }
  }

  /** probe 结果只可提交当前代(§7「probe后结果只可提交当前代」):与交付同一资格面 */
  assertProbeCommitGeneration(householdId: string, sessionId: string, generation: number): void {
    this.assertGenerationDeliverable(householdId, sessionId, generation);
  }

  /* ---------- T045/T062/T081 watchdog 扫描面(T045 实现;节拍调度归 playback-retention.service) ---------- */

  /**
   * 回收清单扫描(data-model §9):未有 playback_started_at 的 ready 会话,以
   * created_at(= ready 时刻锚点,T038 夹具钉面)起 60s 固定期限进入清单 ——
   * 等待手势不延长、heartbeat/renew 不续命(本查询只看 created_at/state/
   * playback_started_at,不读 last_heartbeat_at);独立 playback_started_at 由
   * 合格 playing 观测设置后解除期限(已起播/已终态会话不入清单);仅 ready 态:
   * 暂停不重新开启 60s 期限(playing/paused 已越过未起播窗口)。
   */
  async listReclaimableUnstartedReadySessions(input: { nowMs: number }): Promise<VodReclaimableSessionRow[]> {
    const rows = this.handle()
      .prepare(
        `SELECT household_id AS householdId, id AS sessionId, created_at AS readyAtIso
         FROM playback_session
         WHERE state = 'ready' AND playback_started_at IS NULL AND created_at <= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(iso(input.nowMs - UNSTARTED_READY_RECLAIM_MS)) as { householdId: string; sessionId: string; readyAtIso: string }[];
    return rows.map((row) => ({ householdId: row.householdId, sessionId: row.sessionId, readyAtMs: Date.parse(row.readyAtIso) }));
  }

  /**
   * 单会话回收终态写入(data-model §9「固定期限回收」;005 系统回收约定 → interrupted):
   * 两 watcher CAS 由单条条件 UPDATE 承担 —— 仅「ready × 未起播 × 期限满」命中才算
   * 回收成功(changes>0 → {reclaimed:true}),并发第二 watcher/已起播/已终态/期限未满
   * 均零写入返回 {reclaimed:false},终态事实不被覆盖或复活(ended_at 以先到者为准)。
   */
  async reclaimExpiredUnstartedReadySession(input: {
    householdId: string;
    sessionId: string;
    nowMs: number;
  }): Promise<{ reclaimed: boolean }> {
    const result = this.handle()
      .prepare(
        `UPDATE playback_session
         SET state = 'interrupted', ended_at = ?
         WHERE household_id = ? AND id = ? AND state = 'ready'
           AND playback_started_at IS NULL AND created_at <= ?`,
      )
      .run(iso(input.nowMs), input.householdId, input.sessionId, iso(input.nowMs - UNSTARTED_READY_RECLAIM_MS));
    return { reclaimed: result.changes > 0 };
  }
}

/** 装配/测试工厂:缺省 Database.db 惰性解析(生产);显式句柄用于测试 rig(独立库) */
export function drizzleVodInputStore(deps: { handle?: DatabaseConstructor.Database; nowMs?: () => number } = {}): VodInputStore {
  const handleSource: HandleSource = deps.handle === undefined ? () => Database.db : () => deps.handle as DatabaseConstructor.Database;
  return new DrizzleVodInputStore(handleSource, deps.nowMs ?? Date.now);
}

/* ------------------------------------------------------------------ */
/* 010 T062 撤交付标记(独立函数;最小面,报告见 transition-cleanup.service)  */
/* ------------------------------------------------------------------ */

/**
 * 撤交付持久标记(010 T062 TransitionCleanupWorkSet 的 InputBindingTx 写面落点):
 * 会话 + 指定代绑定 cleanup_requested=1 / cleanup_reason / cleanup_state='pending'
 * 同一提交 —— 标记先阻止新票(renew)/新资产(assertGenerationDeliverable)与在途
 * 分片交付(hls-proxy 绑定查询 cleanup_requested=0 谓词);不写终态 —— 会话终止由
 * 既有生命周期发布端口在提交后执行(I5「投递幂等空 stop」)。
 * 连接已处于事务中(uow run 内)则并入外层事务,与 intent/slot 写面同 commit;
 * 幂等:重复标记同值覆盖,零副作用。与 failSessionOnRevisionMismatch 的标记半段同款
 * (后者额外落 failed 终态,本函数按 cleanup 语义不终态化)。
 */
export function markDeliveryCleanupRequested(
  handle: DatabaseConstructor.Database,
  input: { householdId: string; sessionId: string; generation: number; reason: string },
): void {
  const run = (): void => {
    handle
      .prepare(
        `UPDATE playback_session SET cleanup_requested = 1, cleanup_reason = ?, cleanup_state = 'pending'
         WHERE household_id = ? AND id = ?`,
      )
      .run(input.reason, input.householdId, input.sessionId);
    handle
      .prepare(
        `UPDATE playback_input_binding SET cleanup_requested = 1, cleanup_reason = ?, cleanup_state = 'pending'
         WHERE household_id = ? AND session_id = ? AND generation = ?`,
      )
      .run(input.reason, input.householdId, input.sessionId, input.generation);
  };
  if (handle.inTransaction) {
    run();
    return;
  }
  handle.transaction(run).immediate();
}
