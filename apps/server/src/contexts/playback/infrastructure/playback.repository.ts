import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import * as schema from '@platform/database/schema';
import {
  playbackConversion,
  playbackFailureEvent,
  playbackSession,
  playbackTicket,
  type PlaybackConversion,
  type PlaybackSession,
  type PlaybackTicket,
} from '@platform/database/schema';
import {
  PLAYBACK_ACTIVE_SESSION_STATES,
  PLAYBACK_CONVERSION_ACTIVE_STATES,
  isPlaybackDelivery,
  isPlaybackSessionTransition,
  isPlaybackConversionTransition,
  isPlaybackStableErrorCode,
  playbackErr,
  playbackOk,
  terminalGuardCode,
  type BeginRebuildInput,
  type CreateSessionInput,
  type DeleteExpiredTicketsInput,
  type EndSessionInput,
  type FailSessionInput,
  type HeartbeatInput,
  type IssueTicketInput,
  type MarkConversionInput,
  type MarkInterruptedInput,
  type MarkPausedInput,
  type MarkPlayingInput,
  type MarkReadyInput,
  type PlaybackCas,
  type PlaybackConversionState,
  type PlaybackConversionView,
  type PlaybackDelivery,
  type PlaybackErr,
  type PlaybackErrorCode,
  type PlaybackFailureEventView,
  type PlaybackResult,
  type PlaybackSessionState,
  type PlaybackSessionView,
  type PlaybackTicketView,
  type RecordFailureEventInput,
  type ReleaseOnExitInput,
  type ReserveConversionInput,
  type SubtitleSwitchInput,
} from '@contexts/playback/domain/playback.types';

/**
 * 播放仓储(T011,spec 004)—— better-sqlite3 同步驱动的短事务实现:
 *
 * - 全部写路径走 drizzle `transaction(..., { behavior: 'immediate' })`(BEGIN IMMEDIATE):
 *   写锁在事务开始即获取,「校验 + 计数 + 写入」对并发原子;方法体全部同步(无 await),
 *   事务绝不跨越 probe/spawn 等异步过程(data-model:不得跨异步过程持写事务);
 * - 状态机唯一入口:`transitionSession` 集中「终态守卫 → CAS → 合法迁移表」三道闸,
 *   违约一律返回 err 且不产生任何写入(不部分提交);
 * - 转换额度:reserve 在 BEGIN IMMEDIATE 内按全部 reserved～stopping 行计全局额度
 *   (跨家庭/跨会话,remux 与转码共用);direct 交付根本不建行、不占额;
 *   退出后(markConversion/releaseOnExit 落终态)释放;spawn 失败走 compensateRelease 补偿;
 * - 输入不可变:身份绑定四列(device_session_id/device_id/profile_id/media_id)与 household_id
 *   只在 createSession 写入一次,此后不存在任何更新入口(见各方法 patch 白名单);
 * - 领域失败以 PlaybackResult(ok/err) 返回,稳定码对齐 contracts/api.md;编程性约定违反
 *   (如非稳定失败码)抛 Error,不伪装成领域结果;
 * - 归属边界:读路径(getSession/listActiveByDevice/revokeTicket/compensateRelease)显式携带
 *   household_id;按全局主键定位的写路径由服务层先做归属校验(T014/T017/T029),
 *   仓储内 household_id 只从既有行复制,永不接受外部改写。
 */

/** 事务句柄与普通句柄同型(drizzle better-sqlite3) */
type PlaybackDb = BetterSQLite3Database<typeof schema>;
type SessionPatch = Partial<typeof playbackSession.$inferInsert>;
type ConversionPatch = Partial<typeof playbackConversion.$inferInsert>;

/** UTC ISO-8601(毫秒,Z);at 缺省取当前时刻 */
function nowIso(at?: string): string {
  return at ?? new Date().toISOString();
}

/** CAS 基准校验:version 不一致 → VERSION_CONFLICT;generation 不一致 → GENERATION_STALE */
function casGuard(currentVersion: number, currentGeneration: number, cas: PlaybackCas): PlaybackErr | null {
  if (cas.expectedVersion !== currentVersion) {
    return playbackErr('PLAYBACK_VERSION_CONFLICT', `version 已推进为 ${currentVersion},请基于最新状态重试`);
  }
  if (cas.expectedGeneration !== undefined && cas.expectedGeneration !== currentGeneration) {
    return playbackErr('PLAYBACK_GENERATION_STALE', `generation 已推进为 ${currentGeneration},旧代不可操作`);
  }
  return null;
}

/** 终态守卫(集中一处):终态不可复活,任何迁移先被此拦截 */
function terminalGuard(state: PlaybackSessionState): PlaybackErr | null {
  const code = terminalGuardCode(state);
  return code === null ? null : playbackErr(code, `会话已终态(${state}),不可复活或改写`);
}

function rowToSessionView(row: PlaybackSession): PlaybackSessionView {
  return {
    id: row.id,
    householdId: row.householdId,
    deviceSessionId: row.deviceSessionId,
    deviceId: row.deviceId,
    profileId: row.profileId,
    mediaId: row.mediaId,
    state: row.state as PlaybackSessionState,
    delivery: (row.delivery as PlaybackDelivery | null) ?? null,
    generation: row.generation,
    version: row.version,
    positionSeconds: row.positionSeconds,
    audioTrackId: row.audioTrackId,
    subtitleTrackId: row.subtitleTrackId,
    desiredPaused: row.desiredPaused === 1,
    profileContextVersion: row.profileContextVersion,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
    failureCode: row.failureCode,
  };
}

function rowToTicketView(row: PlaybackTicket): PlaybackTicketView {
  return {
    id: row.id,
    householdId: row.householdId,
    sessionId: row.sessionId,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    generation: row.generation,
    revokedAt: row.revokedAt,
  };
}

function rowToConversionView(row: PlaybackConversion): PlaybackConversionView {
  return {
    id: row.id,
    householdId: row.householdId,
    sessionId: row.sessionId,
    generation: row.generation,
    mode: row.mode as PlaybackConversionView['mode'],
    state: row.state as PlaybackConversionState,
    hardwareBackend: row.hardwareBackend,
    outputVideoCodec: row.outputVideoCodec,
    outputAudioCodec: row.outputAudioCodec,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    failureCode: row.failureCode,
    cleanupState: row.cleanupState,
    bytesOnDisk: row.bytesOnDisk,
    lastProgressAt: row.lastProgressAt,
  };
}

/**
 * 会话状态迁移唯一入口(短事务):读取 → 终态守卫 → CAS → 合法迁移表 → 补丁写入 → 回读。
 * patch 由调用方基于当前行计算(递增规则/generation 演进),聚合后与 state 一并单条 UPDATE。
 */
function transitionSession(
  handle: PlaybackDb,
  sessionId: string,
  plan: {
    to: PlaybackSessionState;
    cas: PlaybackCas;
    at?: string;
    patch?: (row: PlaybackSession, at: string) => SessionPatch;
  },
): PlaybackResult<PlaybackSessionView> {
  return handle.transaction(
    (tx) => {
      const row = tx.select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
      if (row === undefined) {
        return playbackErr('PLAYBACK_NOT_FOUND', '播放会话不存在');
      }
      const terminal = terminalGuard(row.state as PlaybackSessionState);
      if (terminal !== null) {
        return terminal;
      }
      const cas = casGuard(row.version, row.generation, plan.cas);
      if (cas !== null) {
        return cas;
      }
      const from = row.state as PlaybackSessionState;
      if (!isPlaybackSessionTransition(from, plan.to)) {
        return playbackErr('PLAYBACK_NOT_READY', `非法状态迁移 ${from} → ${plan.to}`);
      }
      const at = nowIso(plan.at);
      const patch: SessionPatch = { ...(plan.patch?.(row, at) ?? {}), state: plan.to };
      tx.update(playbackSession).set(patch).where(eq(playbackSession.id, sessionId)).run();
      const updated = tx.select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
      return playbackOk(rowToSessionView(updated as PlaybackSession));
    },
    { behavior: 'immediate' },
  );
}

/** 转换状态迁移入口(短事务);终态重复标记幂等(确认退出的双重通知无副作用) */
function mutateConversion(
  handle: PlaybackDb,
  conversionId: string,
  plan: {
    state: PlaybackConversionState;
    hardwareBackend?: string;
    failureCode?: PlaybackErrorCode;
    at?: string;
  },
): PlaybackResult<PlaybackConversionView> {
  if (plan.state === 'failed' && (plan.failureCode === undefined || !isPlaybackStableErrorCode(plan.failureCode))) {
    throw new Error(`转换失败必须携带稳定失败码,收到:${String(plan.failureCode)}`);
  }
  return handle.transaction(
    (tx) => {
      const row = tx.select().from(playbackConversion).where(eq(playbackConversion.id, conversionId)).get();
      if (row === undefined) {
        return playbackErr('PLAYBACK_NOT_FOUND', '转换记录不存在');
      }
      const from = row.state as PlaybackConversionState;
      if (from === plan.state) {
        // 终态幂等:同态重复标记(如监督者双重确认)直接返回现状,无写操作
        return playbackOk(rowToConversionView(row));
      }
      if (!isPlaybackConversionTransition(from, plan.state)) {
        return playbackErr('PLAYBACK_NOT_READY', `非法转换迁移 ${from} → ${plan.state}`);
      }
      const at = nowIso(plan.at);
      const patch: ConversionPatch = { state: plan.state };
      // started_at 为进程成功启动:进入 starting 且此前从未启动时一次性写入
      if (plan.state === 'starting' && row.startedAt === null) {
        patch.startedAt = at;
      }
      if (plan.hardwareBackend !== undefined) {
        patch.hardwareBackend = plan.hardwareBackend;
      }
      // failure_code 仅 failed 非空(CHECK 双向);终态必设 ended_at
      if (plan.state === 'failed') {
        patch.failureCode = plan.failureCode as string;
      }
      if (plan.state === 'ended' || plan.state === 'failed' || plan.state === 'interrupted') {
        patch.endedAt = at;
      }
      tx.update(playbackConversion).set(patch).where(eq(playbackConversion.id, conversionId)).run();
      const updated = tx.select().from(playbackConversion).where(eq(playbackConversion.id, conversionId)).get();
      return playbackOk(rowToConversionView(updated as PlaybackConversion));
    },
    { behavior: 'immediate' },
  );
}

export class PlaybackRepository {
  private readonly handle: PlaybackDb;

  constructor(
    db: DatabaseConstructor.Database,
    /** 转换并发上限来源(budgets.conversion.concurrency);显式注入,便于测试压缩额度 */
    private readonly budgets: PlaybackBudgets,
  ) {
    this.handle = drizzle(db, { schema });
  }

  /**
   * 创建 preparing 会话:generation=version=1、position=0、desired_paused=0、
   * created_at=last_heartbeat_at=now。家庭内至少一启用资源的预校验由调用方负责 —— 仓储只存。
   * profile_context_version(005 §2)按调用方捕获的授权时刻 DeviceSession 版本一次性落库,
   * 此后不可变(身份绑定面);与 DeviceSession 失衡由服务层控制链路重验(T051)。
   */
  createSession(input: CreateSessionInput): PlaybackResult<PlaybackSessionView> {
    return this.handle.transaction(
      (tx) => {
        const at = nowIso(input.at);
        const id = input.id ?? randomUUID();
        tx.insert(playbackSession)
          .values({
            id,
            householdId: input.householdId,
            deviceSessionId: input.deviceSessionId,
            deviceId: input.deviceId,
            profileId: input.profileId,
            mediaId: input.mediaId,
            playbackSourceId: null,
            state: 'preparing',
            delivery: null,
            generation: 1,
            version: 1,
            positionSeconds: 0,
            audioTrackId: null,
            subtitleTrackId: null,
            desiredPaused: 0,
            profileContextVersion: input.profileContextVersion ?? 1,
            createdAt: at,
            startedAt: null,
            endedAt: null,
            lastHeartbeatAt: at,
            failureCode: null,
          })
          .run();
        const row = tx.select().from(playbackSession).where(eq(playbackSession.id, id)).get();
        return playbackOk(rowToSessionView(row as PlaybackSession));
      },
      { behavior: 'immediate' },
    );
  }

  /** 家庭边界内的会话读取;不存在返回 PLAYBACK_NOT_FOUND */
  getSession(householdId: string, sessionId: string): PlaybackResult<PlaybackSessionView> {
    const row = this.handle
      .select()
      .from(playbackSession)
      .where(and(eq(playbackSession.householdId, householdId), eq(playbackSession.id, sessionId)))
      .get();
    if (row === undefined) {
      return playbackErr('PLAYBACK_NOT_FOUND', '播放会话不存在');
    }
    return playbackOk(rowToSessionView(row));
  }

  /** 设备维度活动会话(preparing/ready/playing/paused),按 (created_at,id) 稳定序 */
  listActiveByDevice(householdId: string, deviceId: string): PlaybackSessionView[] {
    const rows = this.handle
      .select()
      .from(playbackSession)
      .where(
        and(
          eq(playbackSession.householdId, householdId),
          eq(playbackSession.deviceId, deviceId),
          inArray(playbackSession.state, [...PLAYBACK_ACTIVE_SESSION_STATES]),
        ),
      )
      .orderBy(asc(playbackSession.createdAt), asc(playbackSession.id))
      .all();
    return rows.map(rowToSessionView);
  }

  /** 心跳:更新 last_heartbeat_at,可携带位置推进与暂停意图;绝不递增 version/generation */
  heartbeat(sessionId: string, input: HeartbeatInput): PlaybackResult<PlaybackSessionView> {
    if (input.positionSeconds !== undefined && (!Number.isFinite(input.positionSeconds) || input.positionSeconds < 0)) {
      return playbackErr('PLAYBACK_SEEK_UNSUPPORTED', '播放位置必须为非负数');
    }
    return this.handle.transaction(
      (tx) => {
        const row = tx.select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
        if (row === undefined) {
          return playbackErr('PLAYBACK_NOT_FOUND', '播放会话不存在');
        }
        const terminal = terminalGuard(row.state as PlaybackSessionState);
        if (terminal !== null) {
          return terminal;
        }
        const cas = casGuard(row.version, row.generation, input.cas);
        if (cas !== null) {
          return cas;
        }
        const patch: SessionPatch = { lastHeartbeatAt: nowIso(input.at) };
        if (input.positionSeconds !== undefined) {
          patch.positionSeconds = input.positionSeconds;
        }
        if (input.desiredPaused !== undefined) {
          patch.desiredPaused = input.desiredPaused ? 1 : 0;
        }
        tx.update(playbackSession).set(patch).where(eq(playbackSession.id, sessionId)).run();
        const updated = tx.select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
        return playbackOk(rowToSessionView(updated as PlaybackSession));
      },
      { behavior: 'immediate' },
    );
  }

  /** preparing→ready:同时确定源与交付模式(活动态 CHECK 非空;禁止补造);不递增 version/generation */
  markReady(sessionId: string, input: MarkReadyInput): PlaybackResult<PlaybackSessionView> {
    if (!isPlaybackDelivery(input.delivery) || input.playbackSourceId.length === 0) {
      return playbackErr('PLAYBACK_NOT_READY', '准备完成必须同时确定源与交付模式,禁止补造');
    }
    return transitionSession(this.handle, sessionId, {
      to: 'ready',
      cas: input.cas,
      at: input.at,
      patch: () => ({
        playbackSourceId: input.playbackSourceId,
        delivery: input.delivery,
        ...(input.audioTrackId !== undefined ? { audioTrackId: input.audioTrackId } : {}),
        ...(input.subtitleTrackId !== undefined ? { subtitleTrackId: input.subtitleTrackId } : {}),
      }),
    });
  }

  /** ready→playing:首次交付设定 started_at(一次且不重置);清除暂停意图 */
  markPlaying(sessionId: string, input: MarkPlayingInput): PlaybackResult<PlaybackSessionView> {
    return transitionSession(this.handle, sessionId, {
      to: 'playing',
      cas: input.cas,
      at: input.at,
      patch: (row, at) => ({ startedAt: row.startedAt ?? at, desiredPaused: 0 }),
    });
  }

  /** playing→paused(ready 亦可直达 paused):落下暂停意图,started_at 不变 */
  markPaused(sessionId: string, input: MarkPausedInput): PlaybackResult<PlaybackSessionView> {
    return transitionSession(this.handle, sessionId, {
      to: 'paused',
      cas: input.cas,
      at: input.at,
      patch: () => ({ desiredPaused: 1 }),
    });
  }

  /**
   * seek/需重建输出的换轨:ready/playing/paused→preparing,generation 与 version 各 +1;
   * 保留 desired_paused(seek 保持暂停意图)与已选定源(同 session 跨代源不变);started_at 不动。
   */
  beginRebuild(sessionId: string, input: BeginRebuildInput): PlaybackResult<PlaybackSessionView> {
    if (input.positionSeconds !== undefined && (!Number.isFinite(input.positionSeconds) || input.positionSeconds < 0)) {
      return playbackErr('PLAYBACK_SEEK_UNSUPPORTED', 'seek 位置必须为非负数');
    }
    return transitionSession(this.handle, sessionId, {
      to: 'preparing',
      cas: input.cas,
      at: input.at,
      patch: (row) => ({
        generation: row.generation + 1,
        version: row.version + 1,
        ...(input.positionSeconds !== undefined ? { positionSeconds: input.positionSeconds } : {}),
        ...(input.audioTrackId !== undefined ? { audioTrackId: input.audioTrackId } : {}),
        ...(input.subtitleTrackId !== undefined ? { subtitleTrackId: input.subtitleTrackId } : {}),
      }),
    });
  }

  /** 纯字幕切换:仅 version +1,generation/状态/started_at 全不变(无需重建输出) */
  applySubtitleSwitch(sessionId: string, input: SubtitleSwitchInput): PlaybackResult<PlaybackSessionView> {
    return this.handle.transaction(
      (tx) => {
        const row = tx.select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
        if (row === undefined) {
          return playbackErr('PLAYBACK_NOT_FOUND', '播放会话不存在');
        }
        const terminal = terminalGuard(row.state as PlaybackSessionState);
        if (terminal !== null) {
          return terminal;
        }
        const cas = casGuard(row.version, row.generation, input.cas);
        if (cas !== null) {
          return cas;
        }
        const state = row.state as PlaybackSessionState;
        if (state !== 'ready' && state !== 'playing' && state !== 'paused') {
          return playbackErr('PLAYBACK_NOT_READY', '纯字幕切换仅限活动交付态(ready/playing/paused)');
        }
        tx.update(playbackSession)
          .set({ version: row.version + 1, subtitleTrackId: input.subtitleTrackId })
          .where(eq(playbackSession.id, sessionId))
          .run();
        const updated = tx.select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
        return playbackOk(rowToSessionView(updated as PlaybackSession));
      },
      { behavior: 'immediate' },
    );
  }

  /** 活动态→ended:ended_at 必设(CHECK);failure_code 保持为空;重复 stop 的幂等由服务层基于当前态实现 */
  endSession(sessionId: string, input: EndSessionInput): PlaybackResult<PlaybackSessionView> {
    return transitionSession(this.handle, sessionId, {
      to: 'ended',
      cas: input.cas,
      at: input.at,
      patch: (_row, at) => ({ endedAt: at }),
    });
  }

  /** 活动态→failed:ended_at 必设,失败码必须为稳定码(CHECK:failure_code 仅 failed 非空) */
  failSession(sessionId: string, input: FailSessionInput): PlaybackResult<PlaybackSessionView> {
    if (!isPlaybackStableErrorCode(input.failureCode)) {
      throw new Error(`failSession 需要稳定失败码,收到:${String(input.failureCode)}`);
    }
    return transitionSession(this.handle, sessionId, {
      to: 'failed',
      cas: input.cas,
      at: input.at,
      patch: (_row, at) => ({ endedAt: at, failureCode: input.failureCode }),
    });
  }

  /** 活动态→interrupted(失联/重启恢复;正式回收扫描属 T028):ended_at 必设,失败码为空 */
  markInterrupted(sessionId: string, input: MarkInterruptedInput): PlaybackResult<PlaybackSessionView> {
    return transitionSession(this.handle, sessionId, {
      to: 'interrupted',
      cas: input.cas,
      at: input.at,
      patch: (_row, at) => ({ endedAt: at }),
    });
  }

  /**
   * 签发票(短事务):仅 ready/playing/paused 可签发;短事务内比较 expectedGeneration,
   * 不一致返回 PLAYBACK_GENERATION_STALE 且不写票行;新票新行,旧票一律不动。
   * ticket.household_id 复制自会话行,复合外键 (household_id,session_id) 天然一致;
   * 明文 ticket 不入库,仓储只收 hash。
   */
  issueTicket(sessionId: string, input: IssueTicketInput): PlaybackResult<PlaybackTicketView> {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 1) {
      throw new Error(`票据 TTL 必须为正整数秒,收到:${String(input.ttlSeconds)}`);
    }
    if (input.tokenHash.length === 0) {
      throw new Error('票据 tokenHash 不得为空');
    }
    return this.handle.transaction(
      (tx) => {
        const session = tx.select().from(playbackSession).where(eq(playbackSession.id, sessionId)).get();
        if (session === undefined) {
          return playbackErr('PLAYBACK_NOT_FOUND', '播放会话不存在');
        }
        const terminal = terminalGuard(session.state as PlaybackSessionState);
        if (terminal !== null) {
          return terminal;
        }
        const state = session.state as PlaybackSessionState;
        if (state === 'preparing') {
          return playbackErr('PLAYBACK_NOT_READY', '准备未完成,不可签发票');
        }
        if (session.generation !== input.expectedGeneration) {
          // 契约:短事务内比较 generation,不一致 409 PLAYBACK_GENERATION_STALE 且不写票
          return playbackErr('PLAYBACK_GENERATION_STALE', `generation 已推进为 ${session.generation},旧代不可签票`);
        }
        const issuedAt = nowIso(input.at);
        const expiresAt = new Date(Date.parse(issuedAt) + input.ttlSeconds * 1000).toISOString();
        const id = input.id ?? randomUUID();
        tx.insert(playbackTicket)
          .values({
            id,
            householdId: session.householdId,
            sessionId,
            tokenHash: input.tokenHash,
            issuedAt,
            expiresAt,
            generation: session.generation,
            revokedAt: null,
          })
          .run();
        return playbackOk({ id, householdId: session.householdId, sessionId, issuedAt, expiresAt, generation: session.generation, revokedAt: null });
      },
      { behavior: 'immediate' },
    );
  }

  /** 撤销票据:已撤销则幂等返回现状;撤销不删除行(过期清理走 deleteExpiredTickets) */
  revokeTicket(householdId: string, ticketId: string, options: { at?: string } = {}): PlaybackResult<PlaybackTicketView> {
    return this.handle.transaction(
      (tx) => {
        const where = and(eq(playbackTicket.householdId, householdId), eq(playbackTicket.id, ticketId));
        const row = tx.select().from(playbackTicket).where(where).get();
        if (row === undefined) {
          return playbackErr('PLAYBACK_NOT_FOUND', '票据不存在');
        }
        if (row.revokedAt === null) {
          tx.update(playbackTicket).set({ revokedAt: nowIso(options.at) }).where(where).run();
        }
        const updated = tx.select().from(playbackTicket).where(where).get();
        return playbackOk(rowToTicketView(updated as PlaybackTicket));
      },
      { behavior: 'immediate' },
    );
  }

  /** 过期票清理支撑:仅删除「过期且超过保留期」的票(契约:过期票 24 小时内清除);返回删除行数 */
  deleteExpiredTickets(input: DeleteExpiredTicketsInput): number {
    const cutoff = new Date(Date.parse(input.now) - input.retentionSeconds * 1000).toISOString();
    const result = this.handle.delete(playbackTicket).where(lt(playbackTicket.expiresAt, cutoff)).run();
    return result.changes;
  }

  /**
   * 预留转换额度(BEGIN IMMEDIATE 内「计数 → 预留」原子):
   * - 全局额度:按全部 reserved～stopping 行计数,跨家庭/跨会话,remux 与转码共用
   *   (data-model:无队列,满额不排队直接忙);
   * - direct 交付根本不调用本方法、不建行、不占额(见 ReserveConversionInput 使用方约定);
   * - 同 (household,session,generation) 重复预留视作忙(UNIQUE 槽位已被占用)。
   */
  reserveConversion(input: ReserveConversionInput): PlaybackResult<PlaybackConversionView> {
    return this.handle.transaction(
      (tx) => {
        const counted = tx
          .select({ active: sql<number>`count(*)` })
          .from(playbackConversion)
          .where(inArray(playbackConversion.state, [...PLAYBACK_CONVERSION_ACTIVE_STATES]))
          .get();
        if ((counted?.active ?? 0) >= this.budgets.conversion.concurrency) {
          return playbackErr('PLAYBACK_CONVERSION_BUSY', '全局转换并发额度已满,不排队直接忙');
        }
        const values = {
          id: input.id ?? randomUUID(),
          householdId: input.householdId,
          sessionId: input.sessionId,
          generation: input.generation,
          mode: input.mode,
          state: 'reserved',
          hardwareBackend: null,
          outputVideoCodec: input.outputVideoCodec,
          outputAudioCodec: input.outputAudioCodec,
          startedAt: null,
          endedAt: null,
          failureCode: null,
          cleanupState: 'pending',
          bytesOnDisk: 0,
          lastProgressAt: null,
        };
        try {
          tx.insert(playbackConversion).values(values).run();
        } catch (error) {
          if (error instanceof Error && error.message.includes('playback_conversion_session_generation_key')) {
            return playbackErr('PLAYBACK_CONVERSION_BUSY', '同会话同代已存在转换记录');
          }
          throw error;
        }
        return playbackOk(rowToConversionView(values as PlaybackConversion));
      },
      { behavior: 'immediate' },
    );
  }

  /** 转换状态推进(probing/starting/running/stopping/ended/failed/interrupted;合法表见 playback.types) */
  markConversion(conversionId: string, input: MarkConversionInput): PlaybackResult<PlaybackConversionView> {
    return mutateConversion(this.handle, conversionId, {
      state: input.state,
      hardwareBackend: input.hardwareBackend,
      failureCode: input.failureCode,
      at: input.at,
    });
  }

  /** 确认退出后的释放:仅允许落入终态;额度自 state 离开 reserved～stopping 起释放 */
  releaseOnExit(conversionId: string, input: ReleaseOnExitInput): PlaybackResult<PlaybackConversionView> {
    return mutateConversion(this.handle, conversionId, {
      state: input.finalState,
      failureCode: input.failureCode,
      at: input.at,
    });
  }

  /**
   * spawn 失败补偿:物理删除「从未成功启动」的预留行(reserved/probing/starting 且 started_at 为空),
   * 释放 UNIQUE(household,session,generation) 槽位,使同代可重新预留;
   * 已启动任务(started_at 非空)必须走 markConversion/releaseOnExit 的确认退出路径,不可被补偿误删;
   * 行不存在(重复补偿)为无副作用 no-op。
   */
  compensateRelease(householdId: string, conversionId: string): PlaybackResult<{ deleted: boolean }> {
    return this.handle.transaction(
      (tx) => {
        const result = tx
          .delete(playbackConversion)
          .where(
            and(
              eq(playbackConversion.householdId, householdId),
              eq(playbackConversion.id, conversionId),
              inArray(playbackConversion.state, ['reserved', 'probing', 'starting']),
              isNull(playbackConversion.startedAt),
            ),
          )
          .run();
        return playbackOk({ deleted: result.changes > 0 });
      },
      { behavior: 'immediate' },
    );
  }

  /** 当前全局活跃转换计数(观察用;计额判定只发生在 reserve 短事务内) */
  countActiveConversions(): number {
    const counted = this.handle
      .select({ active: sql<number>`count(*)` })
      .from(playbackConversion)
      .where(inArray(playbackConversion.state, [...PLAYBACK_CONVERSION_ACTIVE_STATES]))
      .get();
    return counted?.active ?? 0;
  }

  /**
   * 写入播放失败事件(审计):stableCode 必须为稳定码词表成员(编程性违反直接抛错);
   * 媒体不可见/跨家庭时 media_id 省略(不存客户端原始目标 ID);不关联所选资源,不产生 session。
   */
  recordFailureEvent(input: RecordFailureEventInput): PlaybackResult<PlaybackFailureEventView> {
    if (!isPlaybackStableErrorCode(input.stableCode)) {
      throw new Error(`失败事件必须使用稳定失败码,收到:${String(input.stableCode)}`);
    }
    return this.handle.transaction(
      (tx) => {
        const at = nowIso(input.at);
        const id = input.id ?? randomUUID();
        tx.insert(playbackFailureEvent)
          .values({
            id,
            householdId: input.householdId,
            deviceSessionId: input.deviceSessionId,
            deviceId: input.deviceId,
            profileId: input.profileId ?? null,
            mediaId: input.mediaId ?? null,
            occurredAt: at,
            stableCode: input.stableCode,
          })
          .run();
        return playbackOk({ id, householdId: input.householdId, occurredAt: at, stableCode: input.stableCode });
      },
      { behavior: 'immediate' },
    );
  }
}
