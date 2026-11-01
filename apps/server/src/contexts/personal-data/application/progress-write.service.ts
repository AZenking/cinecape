import { createHash } from 'node:crypto';
import { DomainError, createDomainError } from '@platform/http-common/domain-error';
import {
  decodeStoredResult,
  encodeStoredResult,
  historyEpochDecisionOf,
  personalTrustedDurationSeconds,
  progressSampleDigest,
  sessionAcceptedCursorOf,
  type SessionAcceptedCursor,
  type StoredSampleResult,
} from '@contexts/personal-data/application/progress-clock.service';
import {
  personalDataStore,
  type PersonalDataTxStore,
  type PlaybackSessionRow,
  type VodEpisodeEvidenceFacts,
} from '@contexts/personal-data/application/personal-data-store.port';
import type { IProgressWriteService } from '@contexts/personal-data/application/ports';

/**
 * 进度写入状态机(T100,005 api.md §5 progress、data-model.md §6/§7「写入状态转换」;
 * 010 T040:会话 ledger 与 epoch 历史分离,data-model 010 §5):
 *
 * 1. resolve 只建 progress_state;不写可见历史(见 progress-clock.service);
 * 2. first started:会话、真实交付、当前 generation、资源修订和位置校验通过;
 *    若历史无行或 candidate_epoch > writer_epoch,取得写入权并 upsert 历史;
 *    同 owner 继续;旧 candidate 返回 applied=false/superseded(不终止其合法播放);
 *    较新 session 仅 resolve 未起播不能抢占历史(抢占只发生在有效 started 样本);
 * 3. periodic/pause/final:仅已 started 且 owner 匹配的 session 可更新;
 *    允许 position 降低(后退 seek/从头播放),绝不 MAX(position);
 * 4. seq==last 且 digest 相同 → 返回上次结果(duplicate,不更新排序/revision);
 *    seq==last 异 digest → 409 PROGRESS_SAMPLE_CONFLICT;seq<last → 200 applied=false/
 *    stale_sample;generation 不同 → 409 PLAYBACK_GENERATION_STALE 不消耗新序号;
 * 5. duration 未知 409 PROGRESS_NOT_READY(不由客户端提供时长);资源修订变化
 *    409 PROGRESS_RESOURCE_CHANGED;会话终态拒绝;直播不建点播历史;
 * 6. stop 的 finalProgress 在调用方事务内经 applyFinalInTransaction 执行:
 *    先验证保存再终态化,失败整体回滚;stale/superseded final 停止成功但不覆盖。
 *
 * 010 T040 编排(data-model 010 §5「seq 跨 generation 递增;新有效样本先更新 ledger,
 * 再按 epoch 决定历史;superseded 仍 sessionAccepted=true;stale 不更新;与历史同事务」):
 * - 新有效样本(seq 前进且校验全通过)在同一事务内:①先推进会话 ledger 接受游标
 *   (seq/digest/generation/continuity_revision + ledger_position/duration/generation/
 *   accepted_at + session_started 只升不降)→ ②按 epoch 裁决历史(superseded 历史不写,
 *   applied=false 旧义保留,但 ledger 已接受 = sessionAccepted=true)→ ③结果簿记
 *   (last_result 编码全量 8 键结果,duplicate 重放原样返回);
 * - stale 零更新(ledger 游标与历史都不动),响应按 ledger 更新前快照回最后会话接受
 *   游标供恢复(api.md §1「stale 返回最后会话接受游标」);
 * - 在线媒体(probe 未知)不得回落历史 duration 兜底(409 PROGRESS_NOT_READY,E 组);
 *   静态媒体历史可信值兜底旧义保留;在线保存证据(continuity_revision/evidence_state/
 *   evidence_digest)与 ledger 同事务写入历史(静态媒体证据列保持 NULL 旧义);
 * - applied 旧义逐字保留:applied 只指历史写入。
 *
 * sampleSeq 为会话生命周期内单调序号(换轨/seek/重渲染不重置);seq 簿记仅在接受
 * (generation/校验全通过)后推进 —— generation 冲突不消耗序号。
 *
 * 008-repository-extraction(T005):数据访问经 PersonalDataStore 端口(ADR-0015 D1);
 * 事务经 withTransaction 端口 —— applyFinalInTransaction 在调用方 lifecycle 事务内被
 * 调用时保持 better-sqlite3 嵌套事务自动 savepoint 的既有行为。
 *
 * T046 接线点:applySampleDetailed 返回 ProgressSampleOutcome(api.md §1 ProgressReply
 * 8 键形态);既有 applySample 返回 3 键投影 —— 控制器接线(T046)前不得扩大 HTTP
 * 响应形状(T092 断言恰好 3 键);接线后控制器改消费 applySampleDetailed。
 */

/** 契约样本输入(reason=started|periodic|pause;stop 的 final 走独立入口) */
export interface ProgressSampleInput {
  readonly sampleSeq: number;
  readonly expectedGeneration: number;
  readonly positionSeconds: number;
  readonly reason: 'started' | 'periodic' | 'pause';
}

/** 契约响应:200 {applied,reason,historyRevision}(applied 旧义:只指历史写入) */
export interface ProgressSampleReply {
  readonly applied: boolean;
  readonly reason: 'accepted' | 'duplicate' | 'stale_sample' | 'superseded';
  readonly historyRevision: number | null;
}

/**
 * 010 T040 全量结果(api.md §1 ProgressReply 8 键形态;结构与 playback 工作集端口
 * ProgressApplyOutcome 逐字段一致,T046 接线消费):
 * - applied 只指历史写入;superseded 可 sessionAccepted=true/applied=false(ledger
 *   已接受、历史不写);duplicate 返回原存储结果不再次写;stale sessionAccepted=false
 *   并返回最后会话接受游标。
 */
export interface ProgressSampleOutcome {
  readonly applied: boolean;
  readonly reason: 'accepted' | 'duplicate' | 'stale_sample' | 'superseded';
  readonly historyRevision: number | null;
  readonly sessionAccepted: boolean;
  readonly acceptedSampleSeq: number;
  readonly acceptedPositionSeconds: number | null;
  readonly acceptedGeneration: number;
  readonly sessionStarted: boolean;
}

/** 8 键 → 3 键投影(控制器接线前的既有响应形状;T092 断言恰好 3 键) */
function replyOf(outcome: ProgressSampleOutcome): ProgressSampleReply {
  return { applied: outcome.applied, reason: outcome.reason, historyRevision: outcome.historyRevision };
}

/** 会话缺失/跨家庭统一 404 同形(不泄露存在性) */
function sessionRowNotFound(): never {
  throw createDomainError('PLAYBACK_NOT_FOUND');
}

/** 终态稳定码映射(ended→PLAYBACK_ENDED;failed/interrupted→PLAYBACK_NOT_READY) */
function terminalGuardCodeOf(state: string): 'PLAYBACK_ENDED' | 'PLAYBACK_NOT_READY' | null {
  if (state === 'ended') {
    return 'PLAYBACK_ENDED';
  }
  if (state === 'failed' || state === 'interrupted') {
    return 'PLAYBACK_NOT_READY';
  }
  return null;
}

/** 位置校验(400 VALIDATION_FAILED;位置不超过可信时长) */
function assertValidPosition(positionSeconds: number, trustedDuration: number | null, isChannel: boolean): void {
  if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
    throw new DomainError(400, 'VALIDATION_FAILED', '进度位置必须为有限非负秒数');
  }
  if (!isChannel && trustedDuration !== null && positionSeconds > trustedDuration) {
    throw new DomainError(400, 'VALIDATION_FAILED', '进度位置超出可信时长');
  }
}

function readSessionRow(tx: PersonalDataTxStore, householdId: string, sessionId: string): PlaybackSessionRow {
  const session = tx.findPlaybackSessionRow(householdId, sessionId);
  if (session === undefined) {
    sessionRowNotFound();
  }
  return session;
}

/**
 * 在线保存证据摘要(T040;历史 evidence_digest 保存面):以保存产生时的稳定来源事实
 * (会话交付/播放资源/代次/内容与连续性修订/本次受信时长)派生的规范化 SHA-256 摘要,
 * 记录「本条历史由哪个来源证据产生」;子项已有证据摘要(verified 证据集)时优先透传,
 * 不以派生值冒充上游证据(derived 仅补齐 unverified 形态,字段非空可恢复)。
 */
function onlineEvidenceDigestOf(input: {
  readonly mediaId: string;
  readonly playbackSourceId: string | null;
  readonly delivery: string | null;
  readonly generation: number;
  readonly contentRevision: number;
  readonly continuityRevision: number;
  readonly trustedDuration: number | null;
}): string {
  const payload = JSON.stringify({
    v: 1,
    kind: 'online-progress',
    m: input.mediaId,
    s: input.playbackSourceId,
    d: input.delivery,
    g: input.generation,
    c: input.contentRevision,
    k: input.continuityRevision,
    t: input.trustedDuration,
  });
  return createHash('sha256').update(`hmp-online-progress-evidence\u0000${payload}`, 'utf8').digest('hex');
}

/** 样本生效范围(会话归属防御输入) */
interface ProgressScope {
  readonly householdId: string;
  readonly deviceSessionId: string;
  readonly sessionId: string;
}

/** 规范化样本载荷(digest/簿记共用的 reason 形态;final 走独立 digest reason) */
interface NormalizedSample {
  readonly sampleSeq: number;
  readonly expectedGeneration: number;
  readonly positionSeconds: number;
  readonly digestReason: 'started' | 'periodic' | 'pause' | 'final';
  readonly bookkeepReason: 'started' | 'periodic' | 'pause';
}

/**
 * ProgressWriteService(纯类;单测直接 new 注入时钟,生产经模块工厂装配)。
 * applySample 面向 progress 端点(独立短事务,3 键既有形状);applySampleDetailed
 * 为同编排的 8 键形态(T046 接线点);applyFinalInTransaction 面向 stop 同事务协作
 * (调用方持有事务,本方法只做同一机器的校验与写入,不自行 BEGIN)。
 */
export class ProgressWriteService implements IProgressWriteService {
  private readonly clock: { now(): number };

  constructor(clock?: { now(): number }) {
    this.clock = clock ?? { now: () => Date.now() };
  }

  /**
   * 样本写入(progress 端点;独立短事务;既有 3 键响应形状):
   * 校验序:会话存在 → 终态 → generation → 状态行 → 资源修订 → 可信时长/位置 →
   * seq/digest 机器 → started 门 → ledger 接受游标 → epoch 历史 → 结果簿记。
   */
  applySample(
    context: ProgressScope,
    input: ProgressSampleInput,
  ): ProgressSampleReply {
    return replyOf(this.applySampleDetailed(context, input));
  }

  /**
   * 010 T040:同编排的会话接受+历史应用全量形态(api.md §1 ProgressReply 8 键;
   * T046 接线点 —— 控制器在接线前继续消费 applySample 的 3 键投影)。
   */
  applySampleDetailed(
    context: ProgressScope,
    input: ProgressSampleInput,
  ): ProgressSampleOutcome {
    const at = new Date(this.clock.now()).toISOString();
    return personalDataStore().withTransaction((tx): ProgressSampleOutcome => {
      const session = readSessionRow(tx, context.householdId, context.sessionId);
      // 1. 归属防御(端点授权链之外的第二道;非本设备会话同形 404)
      if (session.deviceSessionId !== context.deviceSessionId) {
        sessionRowNotFound();
      }
      // 2. 会话终态拒绝(终态不可复活,也不再接收 progress)
      const terminal = terminalGuardCodeOf(session.state);
      if (terminal !== null) {
        throw new DomainError(409, terminal);
      }
      // 3. 当前 generation 必须匹配(不消耗新序号)
      if (session.generation !== input.expectedGeneration) {
        throw createDomainError('PLAYBACK_GENERATION_STALE');
      }
      // 4. 直播:合法遥测但绝不建点播历史(200 accepted,historyRevision=null)
      const mediaType = tx.findMediaType(context.householdId, session.mediaId);
      const isChannel = mediaType === 'channel';
      if (isChannel) {
        assertValidPosition(input.positionSeconds, null, true);
        return {
          applied: true,
          reason: 'accepted',
          historyRevision: null,
          sessionAccepted: true,
          acceptedSampleSeq: input.sampleSeq,
          acceptedPositionSeconds: input.positionSeconds,
          acceptedGeneration: input.expectedGeneration,
          sessionStarted: true,
        };
      }
      // 5. progress_state 必须存在(resolve 绑定;缺失 = 未曾在 resolve 接受进度绑定)
      const state = tx.findProgressStateRow(context.householdId, context.sessionId);
      if (state === undefined) {
        throw new DomainError(409, 'PLAYBACK_NOT_READY', '该会话未绑定进度状态,不能保存进度');
      }
      // 6. 资源修订变化:旧播放不改新资源历史(T043 continuity 拒绝接点同位于本
      //    校验段:接线时以绑定 continuity_revision 与当前子项修订比对,失配即在此
      //    段 409 拒绝,先于任何 ledger/历史写入)
      const currentRevision = tx.findMediaContentRevision(context.householdId, session.mediaId);
      if (currentRevision === undefined || currentRevision !== state.contentRevision) {
        throw createDomainError('PROGRESS_RESOURCE_CHANGED');
      }
      // 6.5 T043 continuity 拒绝接点(先于任何 ledger/历史写入;reason 稳定形态):
      // data-model §3「旧会话修订不匹配时拒绝新交付/进度,准备转failed,需新resolve」。
      // 比对基准 = resolve 绑定行逐样本记录的子项修订(continuity_revision):
      // - 子项无已发布证据(NULL)→ 绑定基线为 1(静态/无证据集旧义);此后证据发布出
      //   修订即「稳定定位/版本匹配条件」变化,会话基线仍是「无证据」形态 → 失配拒绝
      //   (需新 resolve;e2e F2 形态:NULL→发布);
      // - 绑定基线已是真实发布修订(>1)→ ledger 按接受样本记录当时修订(T040「保存
      //   产生时快照,不批量升级」语义),固定输入绑定行的完整失配拒绝面归 playback
      //   ready 重验(assertFixedInputCurrent 连续性维度)与交付面,本接点不重复拒绝。
      const continuityEvidence = tx.findVodEpisodeEvidenceFacts(context.householdId, session.mediaId);
      if (
        continuityEvidence !== undefined &&
        state.lastSampleSeq > 0 &&
        state.continuityRevision === 1 &&
        continuityEvidence.continuityRevision !== null &&
        continuityEvidence.continuityRevision !== state.continuityRevision
      ) {
        throw createDomainError(
          'PROGRESS_RESOURCE_CHANGED',
          `子项连续性修订已变化(会话绑定无证据基线 × 当前已发布 ${continuityEvidence.continuityRevision}),需新 resolve`,
        );
      }
      // 7. 可信 duration(probe 事实 → 静态媒体历史可信值兜底;在线未知拒绝)
      const trusted = this.trustedDurationOf(tx, context.householdId, session.mediaId, context.sessionId, session.generation);
      if (trusted.duration === null) {
        throw createDomainError('PROGRESS_NOT_READY');
      }
      assertValidPosition(input.positionSeconds, trusted.duration, false);

      const digest = progressSampleDigest({
        expectedGeneration: input.expectedGeneration,
        positionSeconds: input.positionSeconds,
        reason: input.reason,
      });
      // 8. seq/digest 机器(先幂等/冲突/stale,后接受)
      if (input.sampleSeq === state.lastSampleSeq && state.lastSampleSeq > 0) {
        if (state.lastSampleDigest === digest) {
          // 相同序号+相同规范化载荷:返回上次结果(原存储结果,含会话接受面),
          // 不改变排序/revision,零写入
          return this.duplicateOutcomeOf(state.lastResult, state);
        }
        throw createDomainError('PROGRESS_SAMPLE_CONFLICT');
      }
      if (input.sampleSeq < state.lastSampleSeq) {
        // stale 零更新:ledger 游标与历史都不动,按更新前快照回最后接受游标
        return this.staleOutcomeOf(state);
      }
      // 9. started 门:pause/periodic 不能伪造首次 started
      if (state.started === 0 && input.reason !== 'started') {
        throw new DomainError(409, 'PLAYBACK_NOT_READY', '尚未确认首次播放,不能保存后续进度');
      }
      // 10. 编排:先 ledger 后 epoch 历史(同事务;superseded 仍 sessionAccepted=true)
      return this.applyAcceptedSampleInTransaction(tx, {
        scope: context,
        session,
        state,
        sample: {
          sampleSeq: input.sampleSeq,
          expectedGeneration: input.expectedGeneration,
          positionSeconds: input.positionSeconds,
          digestReason: input.reason,
          bookkeepReason: input.reason,
        },
        digest,
        trustedDuration: trusted.duration,
        evidenceFacts: trusted.facts,
        at,
      });
    });
  }

  /**
   * stop 协作(调用方事务内执行;不自行开启事务):
   * - 硬性非法(位置/时长/generation/seq 冲突/未 started)→ 抛 DomainError,调用方
   *   整体回滚(final 与终态同事务,失败不部分保存);
   * - stale/superseded → 返回 applied=false(停止成功,不覆盖历史);
   * - 无进度绑定(准备取消/直播)→ 返回 null(空 stop 语义,不建历史)。
   */
  applyFinalInTransaction(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly at: string;
    readonly final: { readonly sampleSeq: number; readonly expectedGeneration: number; readonly positionSeconds: number };
  }): ProgressSampleReply | null {
    return personalDataStore().withTransaction((tx): ProgressSampleReply | null => {
      const session = readSessionRow(tx, input.householdId, input.sessionId);
      const state = tx.findProgressStateRow(input.householdId, input.sessionId);
      // 无进度绑定的会话(准备取消/直播):final 不可伪造 → 无写入
      if (state === undefined) {
        return null;
      }
      if (session.generation !== input.final.expectedGeneration) {
        throw createDomainError('PLAYBACK_GENERATION_STALE');
      }
      const currentRevision = tx.findMediaContentRevision(input.householdId, session.mediaId);
      if (currentRevision === undefined || currentRevision !== state.contentRevision) {
        throw createDomainError('PROGRESS_RESOURCE_CHANGED');
      }
      const trusted = this.trustedDurationOf(tx, input.householdId, session.mediaId, input.sessionId, session.generation);
      if (trusted.duration === null) {
        throw createDomainError('PROGRESS_NOT_READY');
      }
      assertValidPosition(input.final.positionSeconds, trusted.duration, false);
      // 必须已 started:未确认 started 即停止 → final 不可用(客户端可改发空 stop)
      if (state.started === 0) {
        throw new DomainError(409, 'PLAYBACK_NOT_READY', '尚未确认首次播放,final 不能建立历史');
      }
      const digest = progressSampleDigest({
        expectedGeneration: input.final.expectedGeneration,
        positionSeconds: input.final.positionSeconds,
        reason: 'final',
      });
      if (input.final.sampleSeq === state.lastSampleSeq && state.lastSampleSeq > 0) {
        if (state.lastSampleDigest !== digest) {
          throw createDomainError('PROGRESS_SAMPLE_CONFLICT');
        }
        // 同 seq 同载荷(final 重试):幂等,返回上次结果,不重复写历史
        const stored = state.lastResult !== null ? decodeStoredResult(state.lastResult) : null;
        if (stored !== null) {
          return { applied: stored.applied, reason: stored.reason, historyRevision: stored.historyRevision };
        }
        return null;
      }
      if (input.final.sampleSeq < state.lastSampleSeq) {
        return { applied: false, reason: 'stale_sample', historyRevision: null }; // 停止成功,不覆盖
      }
      const outcome = this.applyAcceptedSampleInTransaction(tx, {
        scope: { householdId: input.householdId, deviceSessionId: session.deviceSessionId, sessionId: input.sessionId },
        session,
        state,
        sample: {
          sampleSeq: input.final.sampleSeq,
          expectedGeneration: input.final.expectedGeneration,
          positionSeconds: input.final.positionSeconds,
          digestReason: 'final',
          bookkeepReason: 'pause',
        },
        digest,
        trustedDuration: trusted.duration,
        evidenceFacts: trusted.facts,
        at: input.at,
      });
      return replyOf(outcome);
    });
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 可信时长与在线证据事实(010 T040):probe 事实优先;在线媒体(vod_episode 事实
   * 存在)probe 未知 → null 拒绝(绝不以历史 duration 兜底,E 组);静态媒体历史可信
   * 值兜底旧义保留。facts 供 ledger continuity 与历史保存证据使用。
   */
  private trustedDurationOf(
    tx: PersonalDataTxStore,
    householdId: string,
    mediaId: string,
    sessionId: string,
    generation: number,
  ): { readonly duration: number | null; readonly facts: VodEpisodeEvidenceFacts | undefined } {
    const facts = tx.findVodEpisodeEvidenceFacts(householdId, mediaId);
    const probed = personalTrustedDurationSeconds(sessionId, generation);
    if (probed !== null && Number.isFinite(probed) && probed > 0) {
      return { duration: probed, facts };
    }
    if (facts !== undefined) {
      // 本次 probe 未知:在线媒体不得以历史 duration 冒充本次可信时长(data-model §5)
      return { duration: null, facts };
    }
    const row = personalDataStore().findHistoryDurationByMedia(householdId, mediaId);
    if (
      row?.durationSeconds !== undefined &&
      row.durationSeconds !== null &&
      Number.isFinite(row.durationSeconds) &&
      row.durationSeconds > 0
    ) {
      return { duration: row.durationSeconds, facts };
    }
    return { duration: null, facts };
  }

  /**
   * 接受分支编排(校验全通过后的同一事务尾段;data-model 010 §5 顺序):
   * ①先更新会话 ledger(接受游标/continuity/session_started,accept 不分 epoch)→
   * ②epoch 裁决历史(superseded 历史不写,applied=false;write 路径 upsert,
   * from-head 原样落位置不取 MAX、新活动重置 completed、在线证据随行落库)→
   * ③结果簿记(last_result 编码全量 8 键结果,供 duplicate 原样重放)。
   */
  private applyAcceptedSampleInTransaction(
    tx: PersonalDataTxStore,
    input: {
      readonly scope: ProgressScope;
      readonly session: PlaybackSessionRow;
      readonly state: { readonly profileId: string; readonly mediaId: string; readonly candidateEpoch: number; readonly contentRevision: number };
      readonly sample: NormalizedSample;
      readonly digest: string;
      readonly trustedDuration: number;
      readonly evidenceFacts: VodEpisodeEvidenceFacts | undefined;
      readonly at: string;
    },
  ): ProgressSampleOutcome {
    const { scope, sample } = input;
    // 写入权判定(first started 与后续样本共用;较新 epoch 才能抢占)——先裁决,
    // 再按「先 ledger 后历史」顺序落库(裁决为纯读,不产生库内顺序差异)
    const history = tx.findHistoryRow(scope.householdId, input.state.profileId, input.state.mediaId);
    const decision = historyEpochDecisionOf({
      history:
        history === undefined
          ? null
          : { writerEpoch: history.writerEpoch, writerPlaybackSessionId: history.writerPlaybackSessionId, revision: history.revision },
      candidateEpoch: input.state.candidateEpoch,
      playbackSessionId: scope.sessionId,
    });
    // ① 会话 ledger 接受游标(先于 epoch 历史;superseded 亦接受 → sessionAccepted=true;
    //    seq 跨 generation 递增,游标 generation 随本次样本代次前进)
    const continuityRevision = input.evidenceFacts?.continuityRevision ?? 1;
    tx.applyLedgerSample(scope.householdId, scope.sessionId, {
      sampleSeq: sample.sampleSeq,
      sampleDigest: input.digest,
      generation: sample.expectedGeneration,
      positionSeconds: sample.positionSeconds,
      durationSeconds: input.trustedDuration,
      continuityRevision,
      acceptedAt: input.at,
      sessionStarted: true,
    });
    if (decision.action === 'superseded') {
      // 旧 candidate 输给较新已起播意图:applied=false/superseded,不终止其合法播放
      // (历史不因非 owner 样本改变;ledger 已接受,sessionAccepted=true)
      const outcome: ProgressSampleOutcome = {
        applied: false,
        reason: 'superseded',
        historyRevision: null,
        sessionAccepted: true,
        acceptedSampleSeq: sample.sampleSeq,
        acceptedPositionSeconds: sample.positionSeconds,
        acceptedGeneration: sample.expectedGeneration,
        sessionStarted: true,
      };
      this.bookkeepState(tx, scope.householdId, scope.sessionId, {
        sampleSeq: sample.sampleSeq,
        digest: input.digest,
        bookkeepReason: sample.bookkeepReason,
        expectedGeneration: sample.expectedGeneration,
        result: outcome,
      });
      return outcome;
    }
    // ② epoch 历史写入(acquire/owner;在线证据与 ledger 同事务落库)
    const evidence =
      input.evidenceFacts === undefined
        ? undefined
        : {
            continuityRevision: input.evidenceFacts.continuityRevision ?? 1,
            evidenceState: input.evidenceFacts.contentVersionState,
            evidenceDigest:
              input.evidenceFacts.evidenceDigest ??
              onlineEvidenceDigestOf({
                mediaId: input.state.mediaId,
                playbackSourceId: input.session.playbackSourceId,
                delivery: input.session.delivery,
                generation: sample.expectedGeneration,
                contentRevision: input.state.contentRevision,
                continuityRevision,
                trustedDuration: input.trustedDuration,
              }),
          };
    const historyRevision = tx.upsertHistoryRow({
      householdId: scope.householdId,
      profileId: input.state.profileId,
      mediaId: input.state.mediaId,
      candidateEpoch: input.state.candidateEpoch,
      playbackSessionId: scope.sessionId,
      sampleSeq: sample.sampleSeq,
      contentRevision: input.state.contentRevision,
      positionSeconds: sample.positionSeconds,
      trustedDuration: input.trustedDuration,
      evidence,
      at: input.at,
    });
    // ③ 结果簿记(accepted;last_result 存全量形态)
    const outcome: ProgressSampleOutcome = {
      applied: true,
      reason: 'accepted',
      historyRevision,
      sessionAccepted: true,
      acceptedSampleSeq: sample.sampleSeq,
      acceptedPositionSeconds: sample.positionSeconds,
      acceptedGeneration: sample.expectedGeneration,
      sessionStarted: true,
    };
    this.bookkeepState(tx, scope.householdId, scope.sessionId, {
      sampleSeq: sample.sampleSeq,
      digest: input.digest,
      bookkeepReason: sample.bookkeepReason,
      expectedGeneration: sample.expectedGeneration,
      result: outcome,
    });
    return outcome;
  }

  /** duplicate 形态:原存储结果(含会话接受面)原样返回;旧存量 3 键行以 ledger 游标回填 */
  private duplicateOutcomeOf(lastResult: string | null, state: { readonly lastSampleSeq: number; readonly lastGeneration: number; readonly ledgerPosition: number | null; readonly ledgerGeneration: number | null; readonly sessionStarted: number }): ProgressSampleOutcome {
    const stored: StoredSampleResult | null = lastResult !== null ? decodeStoredResult(lastResult) : null;
    if (stored === null) {
      // 损坏/缺缓存:按 duplicate 语义返回当前 ledger 接受面(不写库)
      const cursor = sessionAcceptedCursorOf({
        lastSampleSeq: state.lastSampleSeq,
        ledgerPosition: state.ledgerPosition,
        ledgerGeneration: state.ledgerGeneration,
        lastGeneration: state.lastGeneration,
        sessionStarted: state.sessionStarted,
      });
      return {
        applied: true,
        reason: 'duplicate',
        historyRevision: null,
        sessionAccepted: cursor.sessionAccepted,
        acceptedSampleSeq: cursor.acceptedSampleSeq,
        acceptedPositionSeconds: cursor.acceptedPositionSeconds,
        acceptedGeneration: cursor.acceptedGeneration,
        sessionStarted: cursor.sessionStarted,
      };
    }
    if (stored.sessionAccepted !== undefined && stored.acceptedSampleSeq !== undefined && stored.acceptedGeneration !== undefined) {
      return {
        applied: stored.applied,
        reason: stored.reason,
        historyRevision: stored.historyRevision,
        sessionAccepted: stored.sessionAccepted,
        acceptedSampleSeq: stored.acceptedSampleSeq,
        acceptedPositionSeconds: stored.acceptedPositionSeconds ?? null,
        acceptedGeneration: stored.acceptedGeneration,
        sessionStarted: stored.sessionStarted ?? false,
      };
    }
    // 旧存量行(3 键):会话接受面按 ledger 更新前快照回填(接受样本必有接受游标)
    const cursor = sessionAcceptedCursorOf({
      lastSampleSeq: state.lastSampleSeq,
      ledgerPosition: state.ledgerPosition,
      ledgerGeneration: state.ledgerGeneration,
      lastGeneration: state.lastGeneration,
      sessionStarted: state.sessionStarted,
    });
    return {
      applied: stored.applied,
      reason: stored.reason,
      historyRevision: stored.historyRevision,
      sessionAccepted: cursor.sessionAccepted,
      acceptedSampleSeq: cursor.acceptedSampleSeq,
      acceptedPositionSeconds: cursor.acceptedPositionSeconds,
      acceptedGeneration: cursor.acceptedGeneration,
      sessionStarted: cursor.sessionStarted,
    };
  }

  /** stale 形态:零更新,按 ledger 更新前快照回最后会话接受游标供恢复 */
  private staleOutcomeOf(state: {
    readonly lastSampleSeq: number;
    readonly lastGeneration: number;
    readonly ledgerPosition: number | null;
    readonly ledgerGeneration: number | null;
    readonly sessionStarted: number;
  }): ProgressSampleOutcome {
    const cursor: SessionAcceptedCursor = sessionAcceptedCursorOf({
      lastSampleSeq: state.lastSampleSeq,
      ledgerPosition: state.ledgerPosition,
      ledgerGeneration: state.ledgerGeneration,
      lastGeneration: state.lastGeneration,
      sessionStarted: state.sessionStarted,
    });
    return {
      applied: false,
      reason: 'stale_sample',
      historyRevision: null,
      sessionAccepted: false,
      acceptedSampleSeq: cursor.acceptedSampleSeq,
      acceptedPositionSeconds: cursor.acceptedPositionSeconds,
      acceptedGeneration: cursor.acceptedGeneration,
      sessionStarted: cursor.sessionStarted,
    };
  }

  /** 状态簿记(seq/digest/started/last_result);仅接受路径推进序号;last_result 存全量形态 */
  private bookkeepState(
    tx: PersonalDataTxStore,
    householdId: string,
    sessionId: string,
    input: {
      readonly sampleSeq: number;
      readonly digest: string;
      readonly bookkeepReason: ProgressSampleInput['reason'];
      readonly expectedGeneration: number;
      readonly result: ProgressSampleOutcome;
    },
  ): void {
    tx.updateProgressStateRow(householdId, sessionId, {
      started: input.bookkeepReason === 'started' ? 1 : undefined,
      lastSampleSeq: input.sampleSeq,
      lastSampleDigest: input.digest,
      lastGeneration: input.expectedGeneration,
      lastResult: encodeStoredResult(input.result),
    });
  }
}
