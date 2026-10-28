import { and, eq } from 'drizzle-orm';
import { getDb, type Db } from '../../../modules/auth/db';
import {
  mediaItem,
  playbackProgressState,
  playbackSession,
  profileViewingHistory,
  type PlaybackSession,
  type PlaybackProgressState,
  type ProfileViewingHistory,
} from '../../../database/schema';
import { DomainError, createDomainError } from '../../../common/domain-error';
import {
  decodeStoredResult,
  encodeStoredResult,
  personalTrustedDurationSeconds,
  progressSampleDigest,
  writeRightOf,
  type StoredSampleResult,
} from './progress-clock.service';

/**
 * 进度写入状态机(T100,005 api.md §5 progress、data-model.md §6/§7「写入状态转换」):
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
 * sampleSeq 为会话生命周期内单调序号(换轨/seek/重渲染不重置);seq 簿记仅在接受
 * (generation/校验全通过)后推进 —— generation 冲突不消耗序号。
 */

/** 契约样本输入(reason=started|periodic|pause;stop 的 final 走独立入口) */
export interface ProgressSampleInput {
  readonly sampleSeq: number;
  readonly expectedGeneration: number;
  readonly positionSeconds: number;
  readonly reason: 'started' | 'periodic' | 'pause';
}

/** 契约响应:200 {applied,reason,historyRevision} */
export interface ProgressSampleReply {
  readonly applied: boolean;
  readonly reason: 'accepted' | 'duplicate' | 'stale_sample' | 'superseded';
  readonly historyRevision: number | null;
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

function readSessionRow(tx: Db, householdId: string, sessionId: string): PlaybackSession {
  const session = tx
    .select()
    .from(playbackSession)
    .where(and(eq(playbackSession.householdId, householdId), eq(playbackSession.id, sessionId)))
    .get();
  if (session === undefined) {
    sessionRowNotFound();
  }
  return session;
}

function readProgressStateRow(tx: Db, householdId: string, sessionId: string): PlaybackProgressState | undefined {
  return tx
    .select()
    .from(playbackProgressState)
    .where(
      and(eq(playbackProgressState.householdId, householdId), eq(playbackProgressState.playbackSessionId, sessionId)),
    )
    .get();
}

function readHistoryRow(tx: Db, householdId: string, profileId: string, mediaId: string): ProfileViewingHistory | undefined {
  return tx
    .select()
    .from(profileViewingHistory)
    .where(
      and(
        eq(profileViewingHistory.householdId, householdId),
        eq(profileViewingHistory.profileId, profileId),
        eq(profileViewingHistory.mediaId, mediaId),
      ),
    )
    .get();
}

function readMediaRevision(tx: Db, householdId: string, mediaId: string): number | undefined {
  return tx
    .select({ contentRevision: mediaItem.contentRevision })
    .from(mediaItem)
    .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
    .get()?.contentRevision;
}

/** 历史写入(取得写入权 = upsert;owner 继续 = update;revision 实际更新递增) */
function upsertHistory(
  tx: Db,
  input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly candidateEpoch: number;
    readonly playbackSessionId: string;
    readonly sampleSeq: number;
    readonly contentRevision: number;
    readonly positionSeconds: number;
    readonly trustedDuration: number | null;
    readonly at: string;
  },
): number {
  const existing = readHistoryRow(tx, input.householdId, input.profileId, input.mediaId);
  const nextRevision = (existing?.revision ?? 0) + 1;
  const values = {
    writerEpoch: input.candidateEpoch,
    writerPlaybackSessionId: input.playbackSessionId,
    lastSampleSeq: input.sampleSeq,
    contentRevision: input.contentRevision,
    positionSeconds: input.positionSeconds,
    durationSeconds: input.trustedDuration,
    lastViewedAt: input.at,
    revision: nextRevision,
  };
  tx.insert(profileViewingHistory)
    .values({
      householdId: input.householdId,
      profileId: input.profileId,
      mediaId: input.mediaId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        profileViewingHistory.householdId,
        profileViewingHistory.profileId,
        profileViewingHistory.mediaId,
      ],
      set: values,
    })
    .run();
  return nextRevision;
}

/**
 * ProgressWriteService(纯类;单测直接 new 注入时钟,生产经模块工厂装配)。
 * applySample 面向 progress 端点(独立短事务);applyFinalInTransaction 面向 stop
 * 同事务协作(调用方持有事务,本方法只做同一机器的校验与写入,不自行 BEGIN)。
 */
export class ProgressWriteService {
  private readonly clock: { now(): number };

  constructor(clock?: { now(): number }) {
    this.clock = clock ?? { now: () => Date.now() };
  }

  /**
   * 样本写入(progress 端点;独立短事务):
   * 校验序:会话存在 → 终态 → generation → 状态行 → 资源修订 → 可信时长/位置 →
   * seq/digest 机器 → started 门 → 写入权 → 历史 upsert → 状态簿记。
   */
  applySample(
    context: { readonly householdId: string; readonly deviceSessionId: string; readonly sessionId: string },
    input: ProgressSampleInput,
  ): ProgressSampleReply {
    const db = getDb();
    const at = new Date(this.clock.now()).toISOString();
    return db.transaction((tx): ProgressSampleReply => {
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
      const mediaType = tx
        .select({ type: mediaItem.type })
        .from(mediaItem)
        .where(and(eq(mediaItem.householdId, context.householdId), eq(mediaItem.id, session.mediaId)))
        .get()?.type;
      const isChannel = mediaType === 'channel';
      if (isChannel) {
        assertValidPosition(input.positionSeconds, null, true);
        return { applied: true, reason: 'accepted', historyRevision: null };
      }
      // 5. progress_state 必须存在(resolve 绑定;缺失 = 未曾在 resolve 接受进度绑定)
      const state = readProgressStateRow(tx, context.householdId, context.sessionId);
      if (state === undefined) {
        throw new DomainError(409, 'PLAYBACK_NOT_READY', '该会话未绑定进度状态,不能保存进度');
      }
      // 6. 资源修订变化:旧播放不改新资源历史
      const currentRevision = readMediaRevision(tx, context.householdId, session.mediaId);
      if (currentRevision === undefined || currentRevision !== state.contentRevision) {
        throw createDomainError('PROGRESS_RESOURCE_CHANGED');
      }
      // 7. 可信 duration(probe 事实 → 历史可信值兜底);未知拒绝
      const trustedDuration = this.trustedDurationSeconds(context.householdId, session.mediaId, context.sessionId, session.generation);
      if (trustedDuration === null) {
        throw createDomainError('PROGRESS_NOT_READY');
      }
      assertValidPosition(input.positionSeconds, trustedDuration, false);

      const digest = progressSampleDigest({
        expectedGeneration: input.expectedGeneration,
        positionSeconds: input.positionSeconds,
        reason: input.reason,
      });
      // 8. seq/digest 机器(先幂等/冲突/stale,后接受)
      if (input.sampleSeq === state.lastSampleSeq && state.lastSampleSeq > 0) {
        if (state.lastSampleDigest === digest) {
          // 相同序号+相同规范化载荷:返回上次结果,不改变排序/revision
          const last = state.lastResult !== null ? decodeStoredResult(state.lastResult) : null;
          return last ?? { applied: true, reason: 'duplicate', historyRevision: null };
        }
        throw createDomainError('PROGRESS_SAMPLE_CONFLICT');
      }
      if (input.sampleSeq < state.lastSampleSeq) {
        return { applied: false, reason: 'stale_sample', historyRevision: null };
      }
      // 9. started 门:pause/periodic 不能伪造首次 started
      if (state.started === 0 && input.reason !== 'started') {
        throw new DomainError(409, 'PLAYBACK_NOT_READY', '尚未确认首次播放,不能保存后续进度');
      }
      // 10. 写入权判定(first started 与后续样本共用;较新 epoch 才能抢占)
      const history = readHistoryRow(tx, context.householdId, state.profileId, state.mediaId);
      const right = writeRightOf({
        history:
          history === undefined
            ? null
            : { writerEpoch: history.writerEpoch, writerPlaybackSessionId: history.writerPlaybackSessionId },
        candidateEpoch: state.candidateEpoch,
        playbackSessionId: context.sessionId,
      });
      if (right === 'superseded') {
        // 旧 candidate 输给较新已起播意图:applied=false/superseded,不终止其合法播放
        // (started 与 periodic/pause 同规则:历史不因非 owner 样本改变)
        this.bookkeepState(tx, context.householdId, context.sessionId, {
          sampleSeq: input.sampleSeq,
          digest,
          reason: input.reason,
          expectedGeneration: input.expectedGeneration,
          result: { applied: false, reason: 'superseded', historyRevision: null },
        });
        return { applied: false, reason: 'superseded', historyRevision: null };
      }
      let historyRevision: number | null = null;
      if (right === 'acquire' || right === 'owner') {
        historyRevision = upsertHistory(tx, {
          householdId: context.householdId,
          profileId: state.profileId,
          mediaId: state.mediaId,
          candidateEpoch: state.candidateEpoch,
          playbackSessionId: context.sessionId,
          sampleSeq: input.sampleSeq,
          contentRevision: state.contentRevision,
          positionSeconds: input.positionSeconds,
          trustedDuration,
          at,
        });
      }
      const reply: ProgressSampleReply = { applied: true, reason: 'accepted', historyRevision };
      this.bookkeepState(tx, context.householdId, context.sessionId, {
        sampleSeq: input.sampleSeq,
        digest,
        reason: input.reason,
        expectedGeneration: input.expectedGeneration,
        result: reply,
      });
      return reply;
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
    const db = getDb();
    return db.transaction((tx): ProgressSampleReply | null => {
      const session = readSessionRow(tx, input.householdId, input.sessionId);
      const state = readProgressStateRow(tx, input.householdId, input.sessionId);
      // 无进度绑定的会话(准备取消/直播):final 不可伪造 → 无写入
      if (state === undefined) {
        return null;
      }
      if (session.generation !== input.final.expectedGeneration) {
        throw createDomainError('PLAYBACK_GENERATION_STALE');
      }
      const currentRevision = readMediaRevision(tx, input.householdId, session.mediaId);
      if (currentRevision === undefined || currentRevision !== state.contentRevision) {
        throw createDomainError('PROGRESS_RESOURCE_CHANGED');
      }
      const trustedDuration = this.trustedDurationSeconds(input.householdId, session.mediaId, input.sessionId, session.generation);
      if (trustedDuration === null) {
        throw createDomainError('PROGRESS_NOT_READY');
      }
      assertValidPosition(input.final.positionSeconds, trustedDuration, false);
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
        return state.lastResult !== null ? decodeStoredResult(state.lastResult) : null;
      }
      if (input.final.sampleSeq < state.lastSampleSeq) {
        return { applied: false, reason: 'stale_sample', historyRevision: null }; // 停止成功,不覆盖
      }
      const history = readHistoryRow(tx, input.householdId, state.profileId, state.mediaId);
      const right = writeRightOf({
        history:
          history === undefined
            ? null
            : { writerEpoch: history.writerEpoch, writerPlaybackSessionId: history.writerPlaybackSessionId },
        candidateEpoch: state.candidateEpoch,
        playbackSessionId: input.sessionId,
      });
      if (right === 'superseded') {
        return { applied: false, reason: 'superseded', historyRevision: null }; // 停止成功,不覆盖
      }
      const historyRevision = upsertHistory(tx, {
        householdId: input.householdId,
        profileId: state.profileId,
        mediaId: state.mediaId,
        candidateEpoch: state.candidateEpoch,
        playbackSessionId: input.sessionId,
        sampleSeq: input.final.sampleSeq,
        contentRevision: state.contentRevision,
        positionSeconds: input.final.positionSeconds,
        trustedDuration,
        at: input.at,
      });
      const reply: ProgressSampleReply = { applied: true, reason: 'accepted', historyRevision };
      this.bookkeepState(tx, input.householdId, input.sessionId, {
        sampleSeq: input.final.sampleSeq,
        digest,
        reason: 'pause',
        expectedGeneration: input.final.expectedGeneration,
        result: reply,
      });
      return reply;
    });
  }

  /* ---------------- 内部 ---------------- */

  /** 可信时长:probe 事实优先(装配注册表),历史可信值兜底;都无 → null */
  private trustedDurationSeconds(
    householdId: string,
    mediaId: string,
    sessionId: string,
    generation: number,
  ): number | null {
    const probed = personalTrustedDurationSeconds(sessionId, generation);
    if (probed !== null && Number.isFinite(probed) && probed > 0) {
      return probed;
    }
    const row = getDb()
      .select({ durationSeconds: profileViewingHistory.durationSeconds })
      .from(profileViewingHistory)
      .where(and(eq(profileViewingHistory.householdId, householdId), eq(profileViewingHistory.mediaId, mediaId)))
      .get();
    if (
      row?.durationSeconds !== undefined &&
      row.durationSeconds !== null &&
      Number.isFinite(row.durationSeconds) &&
      row.durationSeconds > 0
    ) {
      return row.durationSeconds;
    }
    return null;
  }

  /** 状态簿记(seq/digest/started/last_result);仅接受路径推进序号 */
  private bookkeepState(
    tx: Db,
    householdId: string,
    sessionId: string,
    input: {
      readonly sampleSeq: number;
      readonly digest: string;
      readonly reason: ProgressSampleInput['reason'];
      readonly expectedGeneration: number;
      readonly result: StoredSampleResult;
    },
  ): void {
    tx.update(playbackProgressState)
      .set({
        started: input.reason === 'started' ? 1 : undefined,
        lastSampleSeq: input.sampleSeq,
        lastSampleDigest: input.digest,
        lastGeneration: input.expectedGeneration,
        lastResult: encodeStoredResult(input.result),
      })
      .where(and(eq(playbackProgressState.householdId, householdId), eq(playbackProgressState.playbackSessionId, sessionId)))
      .run();
  }
}
