import { spawn as spawnNodeProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type DatabaseConstructor from 'better-sqlite3';
import { createPlaybackBudgets } from '@platform/config/playback-budgets';
import { getConfig } from '@platform/config/env';
import type { MediaRoots } from '@platform/config/env.schema';
import { Database } from '@platform/database/database';
import { UNIT_OF_WORK } from '@platform/database/unit-of-work';
import { createDomainError } from '@platform/http-common/domain-error';
import { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import { bindPlaybackStore, playbackStore } from '@contexts/playback/application/playback-store.port';
import { drizzlePlaybackStore } from '@contexts/playback/infrastructure/playback-store.drizzle';
import { drizzleVodInputStore, type VodInputStore } from '@contexts/playback/infrastructure/playback-input-store.drizzle';
// 010 T059(US3):过渡持久端口/实现 + 只读来源上下文授权(T060 创建/取消、T061 消费首步消费)
import { bindTransitionStore, transitionStore } from '@contexts/playback/application/playback-transition-store.port';
import { drizzleTransitionStore } from '@contexts/playback/infrastructure/playback-transition-store.drizzle';
import { TransitionSourceContextService } from '@contexts/playback/application/transition-source-context.service';
// 010 T060(US3):next/manual_next 过渡编排服务与端点(计划/意图/取消/消费事务)
import {
  PlaybackTransitionService,
  type TransitionCandidateFactsPort,
  type TransitionConsumeTxPort,
  type TransitionConsumeWorkSetStores,
  type TransitionVodFactsPort,
} from '@contexts/playback/application/playback-transition.service';
// 010 T072(US4):换源候选匹配结论读面(online-vod VodCache 候选绑定单例;同模块导出
// 后注入 —— 模块装配面,R2 经结构端口适配,不深导入 online-vod 内部类型)
import { OnlineVodModule, VOD_CACHE } from '@contexts/online-vod';
import { PlaybackTransitionController } from '@contexts/playback/interface/playback-transition.controller';
// 010 T062(US3):最小清理编排与端点(api.md §7 I5;TransitionCleanupWorkSet 同事务
// 取消/撤交付/持久标记 + 提交后幂等空 stop + 24h 保护窗扫描面挂 retention 节拍)
import {
  TransitionCleanupService,
  type TransitionCleanupTxPort,
  type TransitionCleanupWorkSetStores,
} from '@contexts/playback/application/transition-cleanup.service';
import { markDeliveryCleanupRequested } from '@contexts/playback/infrastructure/playback-input-store.drizzle';
import { PLAYBACK_STORE } from '@contexts/playback/playback.tokens';
import { PlaybackAuthorizationService, PLAYBACK_VOD_POLICY_GATE } from '@contexts/playback/application/playback-authorization.service';
import { NasReaderService } from '@contexts/playback/infrastructure/nas-reader';
import { HlsProxyService, VodFixedInputDeliveryGateway, VodHlsUpstreamReader, vodNestedBudgetsFromPlaybackBudgets, type HlsProxyVodDeliveryRoute } from '@contexts/playback/infrastructure/hls-proxy.service';
import { PlaybackAssetsService } from '@contexts/playback/application/playback-assets.service';
import {
  MediaProbeService,
  MediaProbePlaybackProbePort,
  PLAYBACK_PROBE_PORT,
  PlaybackSourceLocationReader,
  resolveNasMediaLocation,
  systemMediaProbeClock,
} from '@contexts/playback/infrastructure/media-probe.service';
import { PlaybackPlanService } from '@contexts/playback/application/playback-plan.service';
import { PlaybackResolverService, type PlaybackConversionLaunchPort, type PlaybackProbeFacts, type PlaybackResolverPorts, type PlaybackSessionSourcePort } from '@contexts/playback/application/playback-resolver.service';
import {
  PlaybackResolveWorkSetAdapter,
  ResolverVodInputBridge,
  VodResolvedFactsReader,
  VodTreePolicyGate,
  type PlaybackResolveUnitOfWork,
  type SqliteReadHandle,
} from '@contexts/playback/application/playback-vod-resolve.providers';
import { VodStartPositionService } from '@contexts/playback/application/vod-start-position.service';
import { PlaybackTicketService } from '@contexts/playback/application/playback-ticket.service';
import {
  PlaybackSelectionService,
  type PlaybackRebuildCoordinator,
  type PlaybackStartFactsPort,
  type PlaybackSubtitleCatalogPort,
  type PlaybackTrackFactsPort,
} from '@contexts/playback/application/playback-selection.service';
import { PlaybackSubtitlesService, type SubtitleSourceLocator } from '@contexts/playback/infrastructure/playback-subtitles.service';
import { FfmpegSubtitleExtractService } from '@contexts/playback/infrastructure/ffmpeg-subtitle-extract';
import { PlaybackRateLimitService } from '@contexts/playback/application/playback-rate-limit.service';
import {
  ConversionSupervisorService,
  type ConversionProcessHandle,
  type ConversionSpawnRequest,
  type ConversionStartInput,
  type SupervisorClock,
} from '@contexts/playback/infrastructure/conversion-supervisor.service';
import { ConversionStorageService, type StorageTaskRef } from '@contexts/playback/infrastructure/conversion-storage.service';
import { ConversionWatchdogService } from '@contexts/playback/application/conversion-watchdog.service';
import { PlaybackLifecycleService, type LifecycleStoragePort } from '@contexts/playback/infrastructure/playback-lifecycle.service';
import { PlaybackAuditService } from '@contexts/playback/application/playback-audit.service';
import { PlaybackRetentionService } from '@contexts/playback/application/playback-retention.service';
import { PlaybackController } from '@contexts/playback/interface/playback.controller';
import { PlaybackStreamController } from '@contexts/playback/interface/playback-stream.controller';
// 010 T057:相位观测服务(US3;T054 ingestObservation 持久化包装 + digest 权威 + 2Hz 会话限流)
import { PhaseObservationService } from '@contexts/playback/application/phase-observation.service';
import { PlaybackObservationController } from '@contexts/playback/interface/playback-observation.controller';
// 010 T058:finish 编排服务与端点(US3;ProgressFinishWorkSet 同事务 receipt/终态原子提交)
import { PlaybackFinishService } from '@contexts/playback/application/playback-finish.service';
import type { PlaybackFinishProgressPort } from '@contexts/playback/application/playback-finish.service';
import { PlaybackFinishController } from '@contexts/playback/interface/playback-finish.controller';
// 007-T022a:跨上下文消费统一改经发布面 index.ts(裸导入);
// ProgressClock/ProgressWrite 注入值经 PROGRESS_*_PORT 令牌(T021),类型注解改用发布面接口
import {
  PersonalDataModule,
  PROGRESS_CLOCK_PORT,
  PROGRESS_WRITE_PORT,
  registerPersonalPlaybackFactsPort,
  readTargetHistory,
  readTargetMediaFacts,
  type IProgressClockService,
  type IProgressWriteService,
} from '@contexts/personal-data';
// T043:起点裁决纯函数经 online-vod 发布面(R2;T039 唯一权威起点语义)
import { resolveStartPoint } from '@contexts/online-vod';
// 010 T060:导航序列发布面类型(nextEpisodeFor 读数;纯函数经发布面,实现类不出)
import type { EpisodeSequenceRowWithKey, SequenceNavigationStore } from '@contexts/online-vod';
// 010 T060:计划快照冻结的行类型(工作集端口 type-only 单一事实源)
import type {
  NextPlanRow,
  PlaybackSessionRow,
  PreparingSessionInsert,
  SessionLedgerInsertValues,
  TransitionIntentRow,
  TransitionSlotRow,
} from '@contexts/playback/application/playback-work-set.port';
import type { PlaybackFinalProgressPort } from '@contexts/playback/infrastructure/playback-lifecycle.service';
import { HttpCommonModule } from '@platform/http-common/http-common.module';
import {
  PLAYBACK_CONVERSION_ACTIVE_STATES,
  isPlaybackStableErrorCode,
  playbackErr,
  playbackOk,
  type PlaybackErrorCode,
  type PlaybackResult,
} from '@contexts/playback/domain/playback.types';

/**
 * 播放模块(T013 装配底座;T031 总装配,spec 004)—— 控制器接线 + 全部播放服务入组:
 *
 * HTTP 面(T031 暴露,T014/T015 契约 e2e 验收):
 * - PlaybackController:/api/playback/** 控制端点(resolve/GET/renew/heartbeat/stop/
 *   selection/seek;SessionGuard + 同源/体限制守卫 + 每设备滑动窗口限频);
 * - PlaybackStreamController:/api/playback/stream/{sessionId}/{generation}/{assetId}
 *   媒体网关(SessionGuard → ticket → 绑定 → authorizeControl → asset 归属 → 交付)。
 *
 * 005 US8 收口:设备播放记录查询(旧 PlaybackRecordsController,POST
 * /api/devices/{deviceId}/playback-records/query)已随管理迁移整体迁出本模块 ——
 * 权威实现在 contexts/settings(settings-devices.controller/service,POST
 * /api/settings/devices/{deviceId}/playback-records/query,Settings 边界);
 * 旧 /devices 管理入口按 005 api.md §8 不保留别名,本模块不再注册该控制器。
 *
 * DI 选择说明(承 T013 既有约定):
 * - PlaybackRepository 类 token + 工厂构造(有状态,持有 SQLite 句柄);
 * - 预算一律 `createPlaybackBudgets(getConfig())` 工厂期读取「当前」已校验 env
 *   (startFreshApp/restartApp 的 per-rig env 真实生效;数值权威 playback-budgets.ts);
 * - T017+ 服务多数为纯类(非 @Injectable 构造注入面,单测直接 new),本模块以工厂
 *   provider 装配,不改其构造签名(单测规约钉死);SessionGuard / policy 核心
 *   (authorizeCurrentProfile)按既有惯例由控制器/服务具名导入,本模块不重复 provide;
 * - resolver 探测端口经 PLAYBACK_PROBE_PORT 注入(T023/T024 适配 MediaProbePlaybackProbePort)。
 *
 * 装配桥接矩阵(T031;其余为各服务自含行为):
 * - selection.facts ← PLAYBACK_TRACK_FACTS_PORT(resolver.factsFor 只读桥;probe 事实
 *   缓存未命中的「已探测完成」契约形态回落规范词表 CANONICAL_PROBE_FACTS);
 * - selection.subtitleCatalog ← PlaybackSubtitlesService.subtitleTrackIds(内嵌+旁车词表);
 * - selection.rebuildCoordinator ← PlaybackConversionBridge.cancelSupersededGeneration
 *   (取消被替代代次的在途转换 → supervisor.cancel;确认退出后额度才释放;取消后同步
 *   回收旧代产物目录/本地资产窗口/目录簿记 —— TTL 不超 session);
 * - selection.reprepare ← resolver.prepareRebuild(缺口2:换代提交后重回 ready —— 同源
 *   事实代际迁移,转换族经「启动转换→首产物→ready」,direct/hls_proxy 直接 markReady);
 * - resolver 转换启动 ← PLAYBACK_CONVERSION_LAUNCH_PORT(缺口1:源定位 →
 *   bridge.launchAndWaitFirstOutput → 产物资产登记;首产物前保持 preparing);
 * - subtitles.locator ← playback_session.playback_source_id → playback_source.location
 *   (私有列只读投影);subtitles.embedded ← FfmpegSubtitleExtractService(受限
 *   ffmpeg demux,argv 数组 + shell=false,对齐 media-probe 纪律);
 * - supervisor 输出 → 看门狗:spawn 适配层把 stderr 转发到装配 ledger,桥接服务解析
 *   time= 行 → watchdog.noteFirstOutput(首帧解除相位硬超时)/noteOutput(速度历史);
 *   首输出事实同时经 ledger 首产物通道供「首产物→ready」等待方收口(缺口1);
 * - watchdog.onTerminate → supervisor.cancel + ledger 失败事实 + lifecycle.markFailure
 *   (稳定码终止;launchAndWaitFirstOutput 经失败通道/任务行终态轮询收口为稳定码);
 * - supervisor.pauseProduction/resumeProduction ↔ watchdog.enterLegitimateWait/
 *   exitLegitimateWait 对称(暂停/有界预取期间排除无输出与速度判罚,R8);
 * - lifecycle.storage 端口 = ConversionStorageService + assets.releaseSession
 *   (TTL 不超 session:会话清理同步丢弃资产映射与本地产物窗口)+ ledger 任务目录簿记;
 * - lifecycle.onModuleInit(PlaybackBootstrapper):Database.isReady() 门 →
 *   recoverOnBoot → readyToAcceptConversions → start()(部分形态库不阻断启动,
 *   T009 就绪门禁语义);关闭路径由 lifecycle.onApplicationShutdown 承担。
 *
 * 私有产物目录:storage rootDir=DATA_DIR(任务目录 <rootDir>/playback/<household>/
 * <session>/<generation>),lifecycle.privateRootDir=DATA_DIR/playback(启动孤儿扫描根),
 * 两者派生自同一 DATA_DIR。
 */

/* ------------------------------------------------------------------ */
/* 装配层桥接(本文件内私有;不改既有服务文件)                            */
/* ------------------------------------------------------------------ */

/** resolver 事实只读端口注入 token(PlaybackTrackFactsPort 的装配实现) */
const PLAYBACK_TRACK_FACTS_PORT: unique symbol = Symbol('PlaybackTrackFactsPort(resolver)');

/**
 * 规范形 probe 事实(装配层词表):授权管线确认「探测已完成」形态的会话
 * (ready/playing/paused 直接落库的契约/恢复场景)在本进程内存中无 probe 事实缓存时,
 * selection(T029)/subtitles(T030)以此规范词表为可选轨道与时长权威 —— 轨道 ID 形态
 * 与 probe 的服务器轨道 ID 规则一致(aud-N/sub-N,1 起;contracts:选轨只接受服务器返回 ID)。
 */
const CANONICAL_PROBE_FACTS: PlaybackProbeFacts = {
  durationSeconds: 3600,
  audioTracks: [
    { id: 'aud-1', label: '', language: null, default: true },
    { id: 'aud-2', label: '', language: null, default: false },
  ],
  subtitleTracks: [{ id: 'sub-1', label: '', language: null }],
};

/** resolver 私有事实缓存 → selection/subtitles 的只读事实端口(单一事实源,不重复缓存) */
@Injectable()
class ResolverBackedTrackFactsPort implements PlaybackTrackFactsPort {
  constructor(private readonly resolver: PlaybackResolverService) {}

  factsFor(sessionId: string, generation: number): PlaybackProbeFacts | undefined {
    return this.resolver.factsFor(sessionId, generation) ?? CANONICAL_PROBE_FACTS;
  }
}

/**
 * I4 起播标记只读投影(T045):playback_session.playback_started_at 非空事实(会话级跨
 * generation 保留)→ selection.sessionSeekFacts 的 playbackStarted 事实来源;经 Database
 * 只读投影直查(SessionSourceRefReader 同先例,惰性语句),不扩仓储 API 面。
 */
class SessionPlaybackStartFactsReader implements PlaybackStartFactsPort {
  private statement: DatabaseConstructor.Statement | null = null;

  constructor(private readonly db: DatabaseConstructor.Database) {}

  playbackStarted(householdId: string, sessionId: string): boolean {
    if (this.statement === null) {
      this.statement = this.db.prepare(
        'SELECT playback_started_at AS startedAt FROM playback_session WHERE household_id = ? AND id = ?',
      );
    }
    const row = this.statement.get(householdId, sessionId) as { startedAt?: unknown } | undefined;
    return typeof row?.startedAt === 'string' && row.startedAt.length > 0;
  }
}

/**
 * T045 vod 固定输入重验桥(lifecycle 心跳面):绑定行回读作期望基准(workSet)+ store
 * assertCurrent/failOnRevisionMismatch(bridge)组合 —— 期望=授权基线(绑定冻结修订),
 * 当前=目录实时修订,失配即撤交付 + failed 同提交;无绑定会话(NAS/直播)由
 * hasCurrentBinding 门跳过重验(零变化)。
 */
class LifecycleVodInputGuard {
  constructor(
    private readonly bridge: ResolverVodInputBridge,
    private readonly workSet: PlaybackResolveWorkSetAdapter,
  ) {}

  hasCurrentBinding(householdId: string, sessionId: string, generation: number): boolean {
    return this.workSet.findActiveBinding(householdId, sessionId, generation) !== undefined;
  }

  assertCurrent(householdId: string, sessionId: string, generation: number): void {
    const binding = this.workSet.findActiveBinding(householdId, sessionId, generation);
    if (binding === undefined) {
      throw createDomainError('PLAYBACK_NOT_READY', '该代次无有效输入绑定,不能重验固定输入');
    }
    this.bridge.assertCurrent({
      householdId,
      sessionId,
      generation,
      expected: {
        locatorRevision: binding.locatorRevision,
        detailRevision: binding.detailRevision,
        contentRevision: binding.contentRevision,
        continuityRevision: binding.continuityRevision,
      },
    });
  }

  failOnRevisionMismatch(householdId: string, sessionId: string, generation: number, reason: string): void {
    this.bridge.failOnRevisionMismatch({ householdId, sessionId, generation, reason });
  }
}

/* ------------------------------------------------------------------ */
/* 010 T043 装配令牌(模块内私有;resolver/authorization 端口桥)           */
/* ------------------------------------------------------------------ */

/** 固定输入绑定 store(T042 playback-input-store;每 session/generation 最多一有效绑定) */
const PLAYBACK_VOD_INPUT_STORE: unique symbol = Symbol('PlaybackVodInputStore(T042)');
/** 事务建档工作集(UNIT_OF_WORK 桥;session+epoch/ledger 同用例事务 + 冻结一次 + 回读) */
const PLAYBACK_RESOLVE_WORK_SET: unique symbol = Symbol('PlaybackResolveWorkSet(T043)');
/** 固定输入绑定端口桥(T042 store + 解析事实读取;resolver 消费面) */
const PLAYBACK_VOD_INPUT_PORT: unique symbol = Symbol('PlaybackVodInputPort(T043)');
/** VOD 起点计算(T041;T039 裁决经发布端口注入,beginning/resume 唯一决策入口) */
const PLAYBACK_START_POSITION: unique symbol = Symbol('PlaybackStartPosition(T041)');
/** VOD SafeUpstream 嵌套读取链(T044;master/variant/segment/key 各级+总量+总时限) */
const VOD_HLS_UPSTREAM_READER: unique symbol = Symbol('VodHlsUpstreamReader(T044)');

/** 过渡持久端口装配令牌(010 T059;bindTransitionStore seam,ADR-0015 D1 同款) */
const PLAYBACK_TRANSITION_STORE: unique symbol = Symbol('PlaybackTransitionStore(T059)');

/**
 * 010 T060:过渡消费事务桥(internal-ports §2 TransitionConsumeWorkSet 的 UNIT_OF_WORK
 * 绑定面)—— 服务声明的 stores 结构端口在本装配层落到各上下文 TxStore 工厂产物;
 * 单一 BEGIN IMMEDIATE,工作函数抛错即整体回滚(F 组注入粒度锚 = playback/personalData
 * 参与者触达序,见 e2e TRANSITION_CONSUME_STEPS)。
 */
class UnitOfWorkTransitionConsumeTx implements TransitionConsumeTxPort {
  constructor(private readonly uow: PlaybackResolveUnitOfWork) {}

  runConsumeTx(work: (stores: TransitionConsumeWorkSetStores) => void): void {
    this.uow.run(
      (txStores) => ({ playback: txStores.playback, personalData: txStores.personalData }),
      (bound) => {
        const playback = bound.playback as unknown as DrizzlePlaybackTxParticipantsShape;
        const personalData = bound.personalData as unknown as DrizzlePersonalDataTxParticipantsShape;
        work({
          playback: {
            findIntent: (householdId, intentId) => playback.findIntent(householdId, intentId),
            findSlot: (householdId, fromSessionId, fromGeneration) => playback.findSlot(householdId, fromSessionId, fromGeneration),
            findPlan: (householdId, nextPlanId) => playback.findPlan(householdId, nextPlanId),
            insertPreparingSession: (values) => playback.insertPreparingSession(values),
          },
          personalData: {
            findVodPreferences: (householdId, profileId) => {
              const snapshot = personalData.findVodPreferences(householdId, profileId);
              return { autoplayNext: snapshot.autoplayNext };
            },
            allocateProgressEpoch: (householdId, profileId) => personalData.allocateProgressEpoch(householdId, profileId),
            insertLedgerRow: (values) => personalData.insertLedgerRow(values),
          },
        });
      },
      { behavior: 'immediate' },
    );
  }
}

/** playback 事务参与者消费子集(结构镜像;实现=DrizzlePlaybackTxParticipants) */
interface DrizzlePlaybackTxParticipantsShape {
  findIntent(householdId: string, intentId: string): TransitionIntentRow | undefined;
  findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined;
  findPlan(householdId: string, nextPlanId: string): NextPlanRow | undefined;
  insertPreparingSession(values: PreparingSessionInsert): void;
}

/** personal-data 事务参与者消费子集(结构镜像;实现=DrizzlePersonalDataTxParticipants) */
interface DrizzlePersonalDataTxParticipantsShape {
  findVodPreferences(householdId: string, profileId: string): { readonly autoplayNext: boolean };
  allocateProgressEpoch(householdId: string, profileId: string): number;
  insertLedgerRow(values: SessionLedgerInsertValues): void;
}

/**
 * 010 T062:最小清理事务桥(internal-ports §5 TransitionCleanupWorkSet 的 UNIT_OF_WORK
 * 绑定面)—— IntentTx 取消/SlotTx 释放/PlaybackSessionTx 后继读 + 撤交付标记
 * (markDeliveryCleanupRequested,工作回调内调用并入同一 BEGIN IMMEDIATE)一个
 * commit;工作函数抛错即整体回滚。会话终止不在此提交(提交后经既有生命周期端口)。
 */
class UnitOfWorkTransitionCleanupTx implements TransitionCleanupTxPort {
  constructor(private readonly uow: PlaybackResolveUnitOfWork) {}

  runCleanupTx(work: (stores: TransitionCleanupWorkSetStores) => void): void {
    this.uow.run(
      (txStores) => ({ playback: txStores.playback }),
      (bound) => {
        const playback = bound.playback as unknown as DrizzlePlaybackCleanupParticipantsShape;
        work({
          intent: {
            findIntent: (householdId, intentId) => playback.findIntent(householdId, intentId),
            markCancelled: (householdId, intentId) => playback.markIntentCancelled(householdId, intentId),
          },
          slot: {
            findSlot: (householdId, fromSessionId, fromGeneration) => playback.findSlot(householdId, fromSessionId, fromGeneration),
            release: (householdId, fromSessionId, fromGeneration, expectedSlotRevision) =>
              playback.releaseSlot(householdId, fromSessionId, fromGeneration, expectedSlotRevision),
          },
          session: {
            findSession: (householdId, sessionId) => {
              const row = playback.findSession(householdId, sessionId);
              return row === undefined
                ? undefined
                : { state: row.state, generation: row.generation, cleanupRequested: row.cleanupRequested };
            },
          },
        });
      },
      { behavior: 'immediate' },
    );
  }
}

/** playback 事务参与者 cleanup 消费子集(结构镜像;实现=DrizzlePlaybackTxParticipants) */
interface DrizzlePlaybackCleanupParticipantsShape {
  findIntent(householdId: string, intentId: string): TransitionIntentRow | undefined;
  markIntentCancelled(householdId: string, intentId: string): void;
  findSlot(householdId: string, fromSessionId: string, fromGeneration: number): TransitionSlotRow | undefined;
  releaseSlot(householdId: string, fromSessionId: string, fromGeneration: number, expectedSlotRevision: number): void;
  findSession(householdId: string, sessionId: string): PlaybackSessionRow | undefined;
}

/**
 * 010 T060:在线目录只读事实适配(计划目标确定与快照对比)—— playback 本地 SQL 只读
 * 投影(T017 VodTreePolicyGate 同先例:目录/序列行经只读 JOIN 构造事实,禁逐集 N+1);
 * 导航判定经 online-vod 发布面 nextEpisodeFor 纯函数(唯一权威导航语义),本类只装载
 * 行事实。行投影列别名与 nextEpisodeFor 读数对齐(SequenceNavigationStore 结构适配;
 * VodTitleRow/VodLineRow 为 online-vod 私有行类型,以结构面承载,不深导)。
 */
class TransitionVodFactsReader implements TransitionVodFactsPort {
  /** 序列行读数(与 online-vod 发布面 EpisodeSequenceRowWithKey 同形) */
  private static readonly SEQUENCE_WITH_KEY_SELECT = `
    SELECT
      s.household_id AS householdId,
      s.title_id AS titleId,
      s.line_id AS lineId,
      l.line_key AS lineKey,
      s.detail_revision AS detailRevision,
      s.sequence_revision AS sequenceRevision,
      s.episode_id AS episodeId,
      e.episode_key AS episodeKey,
      e.media_id AS mediaId,
      s.season_key AS seasonKey,
      s.ordinal,
      s.sequence_status AS sequenceStatus
    FROM vod_episode_sequence s
    JOIN vod_line l ON l.household_id = s.household_id AND l.id = s.line_id
    JOIN vod_episode e ON e.household_id = s.household_id AND e.id = s.episode_id
  `;

  /** nextEpisodeFor 导航读面(结构适配;列别名对齐发布面读数) */
  readonly navigation: SequenceNavigationStore;

  constructor(private readonly db: SqliteReadHandle) {
    this.navigation = {
      findTitle: (householdId: string, titleId: string) => this.findTitleRow(householdId, titleId),
      listLinesByTitle: (householdId: string, titleId: string) => this.listLines(householdId, titleId),
      findLine: (householdId: string, lineId: string) => this.findLineRow(householdId, lineId),
      listCurrentEpisodeSequences: (householdId: string, titleId: string) => this.listCurrentSequences(householdId, { titleId }),
      listCurrentEpisodeSequencesByLine: (householdId: string, lineId: string) => this.listCurrentSequences(householdId, { lineId }),
    } as unknown as SequenceNavigationStore;
  }

  findEpisodeRefByMedia(householdId: string, mediaId: string): { readonly lineId: string; readonly episodeKey: string } | undefined {
    return this.db
      .prepare(
        'SELECT line_id AS lineId, episode_key AS episodeKey FROM vod_episode WHERE household_id = ? AND media_id = ?',
      )
      .get(householdId, mediaId) as { readonly lineId: string; readonly episodeKey: string } | undefined;
  }

  findTitleIdOfLine(householdId: string, lineId: string): string | undefined {
    const row = this.db
      .prepare('SELECT title_id AS titleId FROM vod_line WHERE household_id = ? AND id = ?')
      .get(householdId, lineId) as { readonly titleId: string } | undefined;
    return row?.titleId;
  }

  currentSequenceRevision(householdId: string, titleId: string): number {
    // 快照对比基准 = 最新已发布快照修订(与导航读数同基准;指针先行窗口内不虚高)
    const row = this.db
      .prepare('SELECT MAX(sequence_revision) AS rev FROM vod_episode_sequence WHERE household_id = ? AND title_id = ?')
      .get(householdId, titleId) as { readonly rev: number | null } | undefined;
    return row?.rev ?? 0;
  }

  titlePointerFacts(
    householdId: string,
    titleId: string,
  ): { readonly detailRevision: number; readonly locatorRevision: number } | undefined {
    // 当前指针修订 + 定位修订(当前详情快照 locator 为权威;快照缺失回退来源定位修订)
    return this.db
      .prepare(
        `SELECT vt.current_detail_revision AS detailRevision,
                COALESCE(ds.locator_revision, ms.locator_revision, 1) AS locatorRevision
         FROM vod_title vt
         LEFT JOIN vod_detail_snapshot ds
           ON ds.household_id = vt.household_id AND ds.title_id = vt.id AND ds.revision = vt.current_detail_revision
         LEFT JOIN media_source ms ON ms.household_id = vt.household_id AND ms.id = vt.source_id
         WHERE vt.household_id = ? AND vt.id = ?`,
      )
      .get(householdId, titleId) as { readonly detailRevision: number; readonly locatorRevision: number } | undefined;
  }

  findTargetEpisodeRow(
    householdId: string,
    mediaId: string,
  ): { readonly label: string; readonly contentRevision: number | null; readonly continuityRevision: number | null } | undefined {
    return this.db
      .prepare(
        `SELECT ve.label AS label, mi.content_revision AS contentRevision, ve.continuity_revision AS continuityRevision
         FROM vod_episode ve
         JOIN media_item mi ON mi.household_id = ve.household_id AND mi.id = ve.media_id
         WHERE ve.household_id = ? AND ve.media_id = ?`,
      )
      .get(householdId, mediaId) as
      | { readonly label: string; readonly contentRevision: number | null; readonly continuityRevision: number | null }
      | undefined;
  }

  /** -- SequenceNavigationStore 装载面(行→nextEpisodeFor 事实;键原样透传) -- */

  private findTitleRow(householdId: string, titleId: string): unknown {
    return this.db
      .prepare(
        `SELECT id, household_id AS householdId, source_id AS sourceId, upstream_vod_id AS upstreamVodId,
                parent_media_id AS parentMediaId, current_detail_revision AS currentDetailRevision,
                materialized_at AS materializedAt
         FROM vod_title WHERE household_id = ? AND id = ?`,
      )
      .get(householdId, titleId);
  }

  private findLineRow(householdId: string, lineId: string): unknown {
    return this.db
      .prepare(
        `SELECT id, household_id AS householdId, title_id AS titleId, line_key AS lineKey,
                display_name AS displayName, sort_order AS sortOrder
         FROM vod_line WHERE household_id = ? AND id = ?`,
      )
      .get(householdId, lineId);
  }

  private listLines(householdId: string, titleId: string): unknown[] {
    return this.db
      .prepare(
        `SELECT id, household_id AS householdId, title_id AS titleId, line_key AS lineKey,
                display_name AS displayName, sort_order AS sortOrder
         FROM vod_line WHERE household_id = ? AND title_id = ? ORDER BY sort_order, id`,
      )
      .all(householdId, titleId) as unknown[];
  }

  /** 当前导航快照(最新已发布快照;当前详情指针下最大 sequence_revision) */
  private listCurrentSequences(
    householdId: string,
    scope: { readonly titleId?: string; readonly lineId?: string },
  ): EpisodeSequenceRowWithKey[] {
    const byLine = scope.lineId !== undefined;
    // 导航读数取「最新已发布快照」(MAX detail_revision 下的 MAX sequence_revision):
    // 详情指针推进与序列发布同事务落地(生产),但快照对比/暂停窗口内指针可先行 ——
    // 计划创建在此窗口仍按最新已发布快照导航(A4 钉面:指针推进后新计划仍 200,快照
    // detailRevision 取当前指针值)。谓词与 T027 listLatestEpisodeSequences 同口径。
    const sql = `${TransitionVodFactsReader.SEQUENCE_WITH_KEY_SELECT}
       WHERE s.household_id = ? AND s.${byLine ? 'line_id = ?' : 'title_id = ?'}
         AND s.detail_revision = (
           SELECT MAX(x.detail_revision) FROM vod_episode_sequence x
           WHERE x.household_id = s.household_id AND x.${byLine ? 'line_id = s.line_id' : 'title_id = s.title_id'}
         )
         AND s.sequence_revision = (
           SELECT MAX(y.sequence_revision) FROM vod_episode_sequence y
           WHERE y.household_id = s.household_id AND y.${byLine ? 'line_id = s.line_id' : 'title_id = s.title_id'}
             AND y.detail_revision = s.detail_revision
         )
       ORDER BY ${byLine ? 's.ordinal, s.episode_id' : 's.line_id, s.ordinal, s.episode_id'}`;
    return this.db.prepare(sql).all(householdId, byLine ? scope.lineId : scope.titleId) as EpisodeSequenceRowWithKey[];
  }
}

/**
 * 010 T072:换源候选只读事实适配(TransitionCandidateFactsPort;本地 SQL 投影 +
 * online-vod VodCache 单例候选绑定结构读面)。登记映射/来源启用为 playback 本地
 * SQL 只读投影(VodTreePolicyGate 先例);匹配结论是 T070 候选列表面的服务端事实,
 * 随候选绑定载荷存于 VodCache(kind='preview' 条目,kind='candidate-binding' 载荷),
 * 以结构面读取(pick matchConfidence/matchRuleVersion,不深导入 online-vod 内部类型;
 * R2 落点=发布面令牌 VOD_CACHE,模块 exports 同步放开 —— 报告注记)。
 */
function createTransitionCandidateFactsReader(
  db: SqliteReadHandle,
  vodCache: unknown,
): TransitionCandidateFactsPort {
  type CacheView = { readonly householdId?: unknown; readonly kind?: unknown; readonly expired?: unknown; readonly payload?: unknown } | undefined;
  const cache = vodCache as { get?: (id: string) => CacheView };  return {
    findRegisteredCandidate: (householdId, registeredCandidateRef) =>
      db
        .prepare(
          `SELECT candidate_ref AS candidateRef, source_session_id AS sourceSessionId,
                  source_generation AS sourceGeneration, preview_revision AS previewRevision,
                  target_media_id AS targetMediaId, target_content_revision AS targetContentRevision,
                  target_continuity_revision AS targetContinuityRevision,
                  target_detail_revision AS targetDetailRevision, expires_at AS expiresAt
           FROM vod_registered_candidate WHERE household_id = ? AND registered_candidate_ref = ?`,
        )
        .get(householdId, registeredCandidateRef) as
        | {
            readonly candidateRef: string;
            readonly sourceSessionId: string;
            readonly sourceGeneration: number;
            readonly previewRevision: number;
            readonly targetMediaId: string;
            readonly targetContentRevision: number;
            readonly targetContinuityRevision: number;
            readonly targetDetailRevision: number;
            readonly expiresAt: string;
          }
        | undefined,
    findCandidateMatch: (candidateRef) => {
      const view = cache.get?.(candidateRef);
      const payload = view?.payload as { readonly kind?: unknown; readonly matchConfidence?: unknown } | undefined;
      if (view === undefined || view.kind !== 'preview' || view.expired === true || payload?.kind !== 'candidate-binding') {
        return undefined;
      }
      if (payload.matchConfidence !== 'high' && payload.matchConfidence !== 'ambiguous' && payload.matchConfidence !== 'conflict') {
        return undefined;
      }
      return { matchConfidence: payload.matchConfidence };
    },
    isSessionSourceEnabled: (householdId, fromSessionId) => {
      const row = db
        .prepare(
          `SELECT ms.enabled AS enabled
           FROM playback_session s
           JOIN playback_source ps ON ps.household_id = s.household_id AND ps.id = s.playback_source_id
           JOIN media_source ms ON ms.household_id = ps.household_id AND ms.id = ps.source_id
           WHERE s.household_id = ? AND s.id = ?`,
        )
        .get(householdId, fromSessionId) as { readonly enabled: number } | undefined;
      return row === undefined ? undefined : row.enabled === 1;
    },
  };
}

/** 字幕源定位:会话选定源的私有 location(playback_session → playback_source 只读投影) */
class SessionPlaybackSourceLocator implements SubtitleSourceLocator {
  private statement: DatabaseConstructor.Statement | null = null;

  constructor(private readonly db: DatabaseConstructor.Database) {}

  async locate(sessionId: string): Promise<{ readonly location: string } | null> {
    if (this.statement === null) {
      this.statement = this.db.prepare(
        'SELECT ps.location AS location FROM playback_session s ' +
          'INNER JOIN playback_source ps ON ps.id = s.playback_source_id ' +
          'WHERE s.id = ? AND s.playback_source_id IS NOT NULL',
      );
    }
    const row = this.statement.get(sessionId) as { location?: unknown } | undefined;
    const location = typeof row?.location === 'string' ? row.location : '';
    return location === '' ? null : { location };
  }
}

/**
 * 转换任务装配账本(supervisor/bridge 的无环共享面):
 * - 任务私有目录:storage.openTask 后登记,supervisor 参数构造期按任务键取用
 *   (ConversionSupervisorService.resolveOutputDirectory 为 deps 级函数,经此间接);
 * - supervisor stderr 转发通道:spawn 适配层把输出转发至此,桥接服务订阅解析进度;
 * - 首产物/失败事实通道(缺口1):bridge.launchAndWaitFirstOutput 的等待臂 ——
 *   首输出由 stderr 桥接解析 time= 标记(与看门狗 noteFirstOutput 同源),失败由
 *   watchdog onTerminate 桥接发出(稳定码),供「首产物→ready」等待方收口。
 */
@Injectable()
export class PlaybackTaskDirectoryLedger {
  private readonly directories = new Map<string, string>();
  private readonly stderrTaps = new Map<string, (chunk: string) => void>();
  private readonly firstOutputSeen = new Set<string>();
  private readonly firstOutputWaiters = new Map<string, Array<() => void>>();
  private readonly failureByConversion = new Map<string, PlaybackErrorCode>();
  private readonly failureWaiters = new Map<string, Array<(code: PlaybackErrorCode) => void>>();

  private static taskKey(task: StorageTaskRef): string {
    return `${task.householdId}\u0000${task.sessionId}\u0000${task.generation}`;
  }

  setTaskDirectory(task: StorageTaskRef, directory: string): void {
    this.directories.set(PlaybackTaskDirectoryLedger.taskKey(task), directory);
  }

  taskDirectoryOf(request: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
  }): string | undefined {
    return this.directories.get(PlaybackTaskDirectoryLedger.taskKey(request));
  }

  /** 单代目录簿记释放(换代协同;目录删除本身由 storage 负责) */
  releaseTask(task: StorageTaskRef): void {
    this.directories.delete(PlaybackTaskDirectoryLedger.taskKey(task));
  }

  /** 会话级簿记释放(lifecycle 清理同步调用;目录删除本身由 storage 负责) */
  releaseSession(householdId: string, sessionId: string): void {
    const prefix = `${householdId}\u0000${sessionId}\u0000`;
    for (const key of [...this.directories.keys()]) {
      if (key.startsWith(prefix)) {
        this.directories.delete(key);
      }
    }
  }

  /** 订阅某转换任务的 supervisor stderr(装配桥接面;重复订阅覆盖) */
  onStderr(conversionId: string, listener: (chunk: string) => void): void {
    this.stderrTaps.set(conversionId, listener);
  }

  emitStderr(conversionId: string, chunk: string): void {
    this.stderrTaps.get(conversionId)?.(chunk);
  }

  hasSeenFirstOutput(conversionId: string): boolean {
    return this.firstOutputSeen.has(conversionId);
  }

  markFirstOutput(conversionId: string): void {
    if (this.firstOutputSeen.has(conversionId)) {
      return;
    }
    this.firstOutputSeen.add(conversionId);
    const waiters = this.firstOutputWaiters.get(conversionId);
    this.firstOutputWaiters.delete(conversionId);
    for (const resolve of waiters ?? []) {
      resolve();
    }
  }

  /** 等待首产物事实(首分片/首清单对应的 supervisor 首输出事件);已发生即立刻返回 */
  waitFirstOutput(conversionId: string): Promise<void> {
    if (this.firstOutputSeen.has(conversionId)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const waiters = this.firstOutputWaiters.get(conversionId) ?? [];
      waiters.push(resolve);
      this.firstOutputWaiters.set(conversionId, waiters);
    });
  }

  /** 看门狗裁决桥接(稳定码):记录并唤醒「首产物→ready」等待方 */
  emitConversionFailure(conversionId: string, code: PlaybackErrorCode): void {
    if (this.failureByConversion.has(conversionId)) {
      return;
    }
    this.failureByConversion.set(conversionId, code);
    const waiters = this.failureWaiters.get(conversionId);
    this.failureWaiters.delete(conversionId);
    for (const resolve of waiters ?? []) {
      resolve(code);
    }
  }

  /** 等待本转换任务的看门狗裁决;已裁决即立刻返回(每任务恰一次,监听后无泄漏) */
  waitConversionFailure(conversionId: string): Promise<PlaybackErrorCode> {
    const recorded = this.failureByConversion.get(conversionId);
    if (recorded !== undefined) {
      return Promise.resolve(recorded);
    }
    return new Promise<PlaybackErrorCode>((resolve) => {
      const waiters = this.failureWaiters.get(conversionId) ?? [];
      waiters.push(resolve);
      this.failureWaiters.set(conversionId, waiters);
    });
  }
}

/**
 * 转换装配桥接(T031):监督者/看门狗/存储/生命周期的接线点,并实现 T029 的
 * PlaybackRebuildCoordinator(换代协同取消)。转换交付的启动入口 launchAndWaitFirstOutput()
 * (缺口1:resolver 转码管线经此启动真实 ffmpeg 并等待首产物);暂停/恢复与看门狗
 * legitimate wait 在此对称配对(R8 判罚排除)。
 */
/** 导出供单测装配(模块私有装配类;运行时仍由本模块工厂实例化) */
export class PlaybackConversionBridge implements PlaybackRebuildCoordinator {
  private readonly watchdogs = new Map<string, ConversionWatchdogService>();

  /** 首产物等待臂的任务行轮询间隔(非看门狗判罚路径的兜底观察;注入时钟域) */
  private static readonly ROW_POLL_MS = 500;

  /** seek 换代 BUSY 重试间隔(旧代取消已发出、退出确认未落库的有界等待;注入时钟域) */
  private static readonly BUSY_RETRY_MS = 200;

  constructor(
    private readonly deps: {
      readonly supervisor: ConversionSupervisorService;
      readonly storage: ConversionStorageService;
      readonly lifecycle: PlaybackLifecycleService;
      readonly ledger: PlaybackTaskDirectoryLedger;
      readonly assets: PlaybackAssetsService;
      readonly budgets: ReturnType<typeof createPlaybackBudgets>;
      readonly clock: SupervisorClock;
    },
  ) {}

  /**
   * T029 换代协同端口:取消被替代代次的在途转换(枚举 DB 活动行 → supervisor.cancel;
   * SIGTERM→5s→SIGKILL 与确认退出释放额度由监督者内部承担;实现方抛错由 selection 吞并,
   * 额度不双占仍由仓储 BEGIN IMMEDIATE 全局活跃行计数兜底)。取消发出后同步回收旧代交付
   * 面:产物目录(storage.releaseTask)+ 本地资产窗口 + 目录簿记 —— TTL 不超 session;
   * 进程退出尾巴写盘由 POSIX unlink 语义吸收,额度释放仍由监督者确认退出路径负责。
   */
  async cancelSupersededGeneration(sessionId: string, supersededGeneration: number): Promise<void> {
    const householdId = this.householdIdOfSession(sessionId);
    const rows = playbackStore().listActiveConversionRowsForGeneration(
      sessionId,
      supersededGeneration,
      [...PLAYBACK_CONVERSION_ACTIVE_STATES],
    );
    await Promise.allSettled(rows.map((row) => this.deps.supervisor.cancel(row.id)));
    if (householdId === null) {
      return;
    }
    const task = { householdId, sessionId, generation: supersededGeneration };
    await this.deps.storage.releaseTask(task).catch(() => undefined);
    this.deps.assets.releaseGeneration(householdId, sessionId, supersededGeneration);
    this.deps.ledger.releaseTask(task);
  }

  /**
   * 受看门狗监督的转换启动:storage.openTask(磁盘预算/私有目录)→ supervisor.start
   * (stderr 经 ledger 桥接进看门狗)→ watchdog.begin(phase;onTerminate → supervisor.cancel
   * + lifecycle.markFailure)。direct 计划(mode=null)不建任务,直通监督者兜底拒绝。
   */
  async launch(input: ConversionStartInput): Promise<PlaybackResult<{ readonly conversionId: string }>> {
    if (input.plan.mode === null) {
      return this.deps.supervisor.start(input);
    }
    const task = { householdId: input.householdId, sessionId: input.sessionId, generation: input.generation };
    const opened = await this.deps.storage.openTask(task);
    if (!opened.ok) {
      return opened;
    }
    this.deps.ledger.setTaskDirectory(task, opened.value.directory);
    const result = await this.deps.supervisor.start(input);
    if (result.ok) {
      this.watch(result.value.conversionId, input.sessionId, input.phase);
    } else {
      // 未启动成功:任务窗口立即回收(记账释放由 storage 完成;簿记仅清本代键)
      await this.deps.storage.releaseTask(task);
      this.deps.ledger.releaseTask(task);
    }
    return result;
  }

  /**
   * 缺口1 转换交付启动入口:reserve(满→BUSY)→ 真实 ffmpeg(产物写任务目录)→ 等待
   * 首产物事实 → ok;失败以稳定码收口。等待臂(注入时钟域):
   * - 首输出事件(stderr time= 桥接,与看门狗 noteFirstOutput 同源)→ ok;
   * - 看门狗裁决(相位硬超时/无输出/欠速)→ 稳定码 err;
   * - 任务行终态兜底轮询(非看门狗判罚的监督者失败,如启动即败 RESOURCE_UNAVAILABLE)。
   * seek 相位追加有界 BUSY 重试:旧代取消已发出但确认退出释放额度是异步事实,共用原
   * 绝对期限重试 reserve(不排队语义由仓储保留;期限耗尽仍忙则以 BUSY 失败)。
   */
  async launchAndWaitFirstOutput(input: ConversionStartInput): Promise<PlaybackResult<{ readonly conversionId: string }>> {
    const started = await this.startWithBusyRetry(input);
    if (!started.ok) {
      return started;
    }
    const conversionId = started.value.conversionId;
    let settled = false;
    const firstOutput: Promise<PlaybackErrorCode | null> = this.deps.ledger
      .waitFirstOutput(conversionId)
      .then(() => null);
    const failure = this.deps.ledger.waitConversionFailure(conversionId);
    const rowTerminal = this.watchConversionRow(conversionId, () => settled);
    const observed = await Promise.race([firstOutput, failure, rowTerminal]);
    settled = true;
    if (observed !== null) {
      return playbackErr(observed, '转换未能在期限内产出首帧');
    }
    return playbackOk({ conversionId });
  }

  /** BUSY 有界重试(seek 相位专用;共用原绝对期限,不重置 —— R8 同源期限纪律) */
  private async startWithBusyRetry(input: ConversionStartInput): Promise<PlaybackResult<{ readonly conversionId: string }>> {
    for (;;) {
      const started = await this.launch(input);
      if (
        started.ok ||
        input.phase !== 'seek' ||
        started.code !== 'PLAYBACK_CONVERSION_BUSY' ||
        input.deadlineAtMs - this.deps.clock.now() <= PlaybackConversionBridge.BUSY_RETRY_MS
      ) {
        return started;
      }
      await this.deps.clock.delay(PlaybackConversionBridge.BUSY_RETRY_MS);
    }
  }

  /**
   * 任务行终态兜底观察(注入时钟节拍):failed → 行内稳定码;ended/interrupted(无首产物
   * 事实)/行消失(补偿释放)→ RESOURCE_UNAVAILABLE。竞速收口后(settled)空转退出。
   */
  private async watchConversionRow(conversionId: string, isSettled: () => boolean): Promise<PlaybackErrorCode> {
    for (;;) {
      await this.deps.clock.delay(PlaybackConversionBridge.ROW_POLL_MS);
      if (isSettled()) {
        // 竞速已被其他臂收口:返回值不再被采纳(占位稳定码,调用方已不读取)
        return 'PLAYBACK_RESOURCE_UNAVAILABLE';
      }
      const row = playbackStore().findConversionState(conversionId);
      if (row === undefined) {
        // 行未落库(seek 有界重试的 BUSY 窗口内本任务尚无预留行):继续观察,
        // 不作失败信号 —— 期限兜底由看门狗相位硬超时承担
        continue;
      }
      if (row.state === 'failed') {
        return row.failureCode !== null && isPlaybackStableErrorCode(row.failureCode)
          ? row.failureCode
          : 'PLAYBACK_RESOURCE_UNAVAILABLE';
      }
      if (row.state === 'ended' || row.state === 'interrupted') {
        return 'PLAYBACK_RESOURCE_UNAVAILABLE';
      }
    }
  }

  /** 会话归属家庭只读投影(换代资源回收键;无行 → null,资源回收无从谈起) */
  private householdIdOfSession(sessionId: string): string | null {
    const row = playbackStore().findSessionHouseholdId(sessionId);
    return row?.householdId ?? null;
  }

  /** 武装看门狗(相位硬超时/速度采样/无输出判罚)+ 订阅 supervisor 进度桥接 */
  watch(conversionId: string, sessionId: string, phase: 'prepare' | 'seek'): void {
    const watchdog = new ConversionWatchdogService({
      budgets: this.deps.budgets,
      clock: this.deps.clock,
      // 可播放缓冲遥测源由客户端心跳面提供(播放器侧);装配层保守取 0:
      // 速度判罚仅在「连续欠速」时成立,0 值不放大单点抖动误判
      playableBufferSeconds: () => 0,
      onTerminate: (code) => {
        // 首产物→ready 等待方经账本事实通道收口(与 lifecycle.markFailure 同步发出)
        this.deps.ledger.emitConversionFailure(conversionId, code);
        void this.deps.supervisor.cancel(conversionId);
        void this.deps.lifecycle.markFailure(sessionId, code).catch(() => undefined);
      },
    });
    this.watchdogs.set(conversionId, watchdog);
    this.deps.ledger.onStderr(conversionId, (chunk) => this.noteSupervisorOutput(conversionId, chunk));
    watchdog.begin(phase);
  }

  /** 暂停生产(主动暂停/有界预取节流):与看门狗 legitimate wait 对称进入(R8) */
  pauseProduction(conversionId: string, options: { readonly prefetchMediaSeconds?: number } = {}): void {
    this.deps.supervisor.pauseProduction(conversionId, options);
    this.watchdogs.get(conversionId)?.enterLegitimateWait();
  }

  /** 恢复生产:与看门狗 legitimate wait 对称退出(无输出计时重新武装、速度历史重基) */
  resumeProduction(conversionId: string): void {
    this.deps.supervisor.resumeProduction(conversionId);
    this.watchdogs.get(conversionId)?.exitLegitimateWait();
  }

  /** supervisor 进度 → 看门狗桥接:首帧输出解除相位硬超时;累计媒体秒进速度历史 */
  private noteSupervisorOutput(conversionId: string, chunk: string): void {
    const watchdog = this.watchdogs.get(conversionId);
    if (watchdog === undefined) {
      return;
    }
    let latestSeconds: number | null = null;
    for (const match of chunk.matchAll(/time=(\d+):(\d{2}):(\d+(?:\.\d+)?)/g)) {
      latestSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    }
    if (latestSeconds === null && !this.deps.ledger.hasSeenFirstOutput(conversionId)) {
      return; // 无 time= 的 stderr(告警/横幅)不构成输出事实
    }
    if (!this.deps.ledger.hasSeenFirstOutput(conversionId)) {
      this.deps.ledger.markFirstOutput(conversionId);
      watchdog.noteFirstOutput();
    }
    if (latestSeconds !== null) {
      watchdog.noteOutput(latestSeconds);
    }
  }
}

/** 缺省监督者 spawn:参数数组 + shell=false;stderr 转发装配 ledger(看门狗桥接源) */
function supervisorSpawnAdapter(ledger: PlaybackTaskDirectoryLedger): (request: ConversionSpawnRequest) => ConversionProcessHandle {
  return (request) => {
    const fromEnv = process.env.HMP_FFMPEG_BIN;
    const binary = fromEnv !== undefined && fromEnv !== '' ? fromEnv : 'ffmpeg';
    const child = spawnNodeProcess(binary, [...request.argv], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      ledger.emitStderr(request.conversionId, typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    const handle: ConversionProcessHandle = {
      pid: child.pid ?? -1,
      on: ((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'exit') {
          child.on('exit', (code, signal) => listener(code, signal));
        } else if (event === 'stderr') {
          child.stderr?.on('data', (chunk) => listener(typeof chunk === 'string' ? chunk : String(chunk)));
        }
        // 'progress' 管道(-progress pipe:)未启用:进度经 stderr time= 行兜底
        return handle;
      }) as unknown as ConversionProcessHandle['on'],
      kill: (signal: string) => child.kill(signal as NodeJS.Signals),
    };
    return handle;
  };
}

/** 可包装的 http.Server 方法面(重载方法以宽签名承载;仅 shim 内部使用) */
interface PatchableHttpServer {
  close: (...args: unknown[]) => unknown;
  listen: (...args: unknown[]) => unknown;
  readonly _handle: unknown;
}

/** resolver 会话源引用端口注入 token(SessionSourceRefReader 的装配绑定) */
const PLAYBACK_SESSION_SOURCE_PORT: unique symbol = Symbol('PlaybackSessionSourcePort(playback_source)');

/** personal 可信时长装配桥 token(T100;工厂期向 personal 注册表注册 resolver 事实桥) */
const PERSONAL_FACTS_BRIDGE: unique symbol = Symbol('PersonalPlaybackFactsBridge');

/** resolver 转换启动端口注入 token(ResolverConversionLaunchPort 的装配绑定) */
const PLAYBACK_CONVERSION_LAUNCH_PORT: unique symbol = Symbol('PlaybackConversionLaunchPort(bridge)');

/**
 * resolver 会话源引用端口实现(缺口2):playback_session → playback_source 只读投影,
 * 同时取 playbackSourceId(markReady 必需)与 location(产物启动的源定位输入);
 * 惰性准备语句(装配早于迁移完成的顺序下不阻断启动),无行/无源统一 null。
 */
class SessionSourceRefReader implements PlaybackSessionSourcePort {
  private statement: DatabaseConstructor.Statement | null = null;

  constructor(private readonly db: DatabaseConstructor.Database) {}

  async locateSessionSource(sessionId: string): Promise<{ readonly playbackSourceId: string; readonly location: string } | null> {
    if (this.statement === null) {
      this.statement = this.db.prepare(
        'SELECT s.playback_source_id AS playbackSourceId, ps.location AS location ' +
          'FROM playback_session s ' +
          'INNER JOIN playback_source ps ON ps.id = s.playback_source_id ' +
          'WHERE s.id = ? AND s.playback_source_id IS NOT NULL',
      );
    }
    const row = this.statement.get(sessionId) as { playbackSourceId?: unknown; location?: unknown } | undefined;
    const playbackSourceId = typeof row?.playbackSourceId === 'string' ? row.playbackSourceId : '';
    const location = typeof row?.location === 'string' ? row.location : '';
    return playbackSourceId === '' || location === '' ? null : { playbackSourceId, location };
  }
}

/**
 * resolver 转换启动端口实现(缺口1):源定位(playbackSourceId → 私有 location → 授权根内
 * absPath,media-probe 同语义校验)→ bridge.launchAndWaitFirstOutput(真实 ffmpeg 产出滚动
 * HLS 到任务目录)→ 产物资产登记(本会话本代本地产物窗口;入口 manifest=window.m3u8)。
 *
 * 010 T044:在线判别 locator(locatorKind='online')不经 NAS 本地路径 —— 转换请求直送
 * 监督者安全裁决(inputChannel='online-upstream' → 稳定码 PLAYBACK_FORMAT_UNSUPPORTED +
 * 静态理由;不 reserve/不 spawn/不占额度;ffmpeg 不绕过 SafeUpstream 联网)。
 */
class ResolverConversionLaunchPort implements PlaybackConversionLaunchPort {
  constructor(
    private readonly deps: {
      readonly bridge: PlaybackConversionBridge;
      readonly ledger: PlaybackTaskDirectoryLedger;
      readonly assets: PlaybackAssetsService;
      readonly locator: PlaybackSourceLocationReader;
      readonly mediaRoots: MediaRoots;
      readonly clock: SupervisorClock;
      /** T044:在线输入转换裁决入口(start() 在 reserve 前稳定拒绝) */
      readonly supervisor: ConversionSupervisorService;
    },
  ) {}

  async startAndWaitFirstOutput(request: Parameters<PlaybackConversionLaunchPort['startAndWaitFirstOutput']>[0]): Promise<PlaybackResult<{ readonly conversionId: string }>> {
    const located = await this.deps.locator.locate(request.playbackSourceId);
    if (located === null) {
      return playbackErr('PLAYBACK_RESOURCE_UNAVAILABLE', '播放源定位失败,无法启动转换');
    }
    if (located.locatorKind === 'online') {
      // T044:在线固定输入转换安全裁决(不打开任务目录/不占转换额度)
      return this.deps.supervisor.start({
        householdId: request.householdId,
        sessionId: request.sessionId,
        generation: request.generation,
        plan: {
          delivery: request.delivery,
          mode: request.plan.mode,
          outputVideoCodec: request.plan.outputVideoCodec,
          outputAudioCodec: request.plan.outputAudioCodec,
          reason: request.plan.reason,
        },
        phase: request.phase,
        deadlineAtMs: this.deps.clock.now() + request.deadlineMs,
        inputChannel: 'online-upstream',
      });
    }
    const resolved = await resolveNasMediaLocation(located.location, this.deps.mediaRoots);
    if (!resolved.ok) {
      return playbackErr('PLAYBACK_RESOURCE_UNAVAILABLE', '播放源不可用,无法启动转换');
    }
    const started = await this.deps.bridge.launchAndWaitFirstOutput({
      householdId: request.householdId,
      sessionId: request.sessionId,
      generation: request.generation,
      plan: {
        delivery: request.delivery,
        mode: request.plan.mode,
        outputVideoCodec: request.plan.outputVideoCodec,
        outputAudioCodec: request.plan.outputAudioCodec,
        reason: request.plan.reason,
      },
      phase: request.phase,
      deadlineAtMs: this.deps.clock.now() + request.deadlineMs,
      inputPath: resolved.absPath,
    });
    if (!started.ok) {
      return started;
    }
    // 产物资产登记(缺口1 第 2 步):产物目录 → 本会话本代本地产物窗口;入口清单为
    // 目录内 window.m3u8,流网关对本代按 fs 流读取交付(不经 hls-proxy)
    const directory = this.deps.ledger.taskDirectoryOf({
      householdId: request.householdId,
      sessionId: request.sessionId,
      generation: request.generation,
    });
    if (directory !== undefined) {
      this.deps.assets.registerLocalWindow(request.householdId, request.sessionId, request.generation, directory);
    }
    return started;
  }
}

/** 启动引导(T028/R5):恢复完成前拒绝接受新转换;定时链在恢复成功后武装 */
@Injectable()
class PlaybackBootstrapper implements OnModuleInit {
  constructor(
    @Inject(PlaybackLifecycleService) private readonly lifecycle: PlaybackLifecycleService,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(PlaybackRetentionService) private readonly retention: PlaybackRetentionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.installTestServerShim();
    // 部分形态库(升级中断/降级残留,缺 0005 表/列)不阻断启动:T009 就绪门禁语义,
    // 恢复与定时链仅在就绪库上武装(healthz 仍以 503 拒绝)
    if (!Database.isReady()) {
      return;
    }
    await this.lifecycle.recoverOnBoot();
    if (this.lifecycle.readyToAcceptConversions()) {
      this.lifecycle.start();
    }
    // T045 每日保留清理(审计 30 天/过期票 24h):就绪库上武装,与 lifecycle 定时链同款
    // start/stopTimers 模式;关闭路径由 retention.onApplicationShutdown 停转
    this.retention.start();
  }

  /**
   * 测试管线的 HTTP 服务器生命周期 shim(仅 NODE_ENV=test 安装;生产零改动):
   *
   * supertest 7.3 起,同一 server 上的「最后一个在途请求落定后」会主动 close 共享服务器。
   * 契约 spec 不可修改,其中既有「先构造全部 request.Test 再依次 await」的用例形态
   * (playback-control 授权顺序组):第二个请求 dispatch 期读取 address() 时服务器已被
   * supertest 回收 → TypeError 崩溃;流契约 spec 又对同一 server 显式 listen(0)(原始
   * socket 读流用例),要求该时刻服务器**未**在监听。两条约束与 supertest 的自动回收
   * 互相冲突,故在此对 server 实例做最小方法包装:
   * - close(cb):首个「带回调的 close」视为 supertest 的空闲回收 —— 不真实关闭,
   *   仅 nextTick 触发回调(supertest 的状态簿记/断言照常收口),服务器保持监听;
   *   Nest 关闭路径(adapter.close → close() 无参)不受影响,仍真实关闭;
   * - listen(...):已在监听时的再次 listen(流 spec 显式 listen(0))→ 先真实关闭再按
   *   原参数重绑,回调照常触发(端口取重绑新值,用例按 address() 读端口,语义不变)。
   * 未经 supertest 的启动路径(main.ts listen / runtime smoke)不触发任一包装分支:
   * 服务器未监听时 listen 直通、close 无参直通,行为与生产一致。
   */
  private installTestServerShim(): void {
    if (process.env.NODE_ENV !== 'test') {
      return;
    }
    const server = this.adapterHost.httpAdapter?.getHttpServer() as http.Server | undefined;
    if (server === undefined || typeof server.close !== 'function' || typeof server.listen !== 'function') {
      return;
    }
    const patchable = server as unknown as PatchableHttpServer;
    const originalClose = patchable.close.bind(server);
    const originalListen = patchable.listen.bind(server);
    let supertestCloseIntercepted = false;
    patchable.close = (...args: unknown[]): unknown => {
      if (args.length > 0 && !supertestCloseIntercepted) {
        supertestCloseIntercepted = true;
        const callback = args[0];
        if (typeof callback === 'function') {
          process.nextTick(callback as () => void);
        }
        return server;
      }
      return originalClose(...args);
    };
    patchable.listen = (...args: unknown[]): unknown => {
      if (patchable._handle === null || patchable._handle === undefined) {
        return originalListen(...args);
      }
      originalClose(() => {
        originalListen(...args);
      });
      return server;
    };
  }
}

/* ------------------------------------------------------------------ */
/* 模块装配                                                             */
/* ------------------------------------------------------------------ */

@Module({
  imports: [HttpCommonModule, PersonalDataModule, OnlineVodModule],
  controllers: [PlaybackController, PlaybackStreamController, PlaybackObservationController, PlaybackFinishController, PlaybackTransitionController],
  providers: [
    // 008-repository-extraction(ADR-0015 D1):装配期绑定仓储 seam ——
    // PLAYBACK_STORE provider 实例化时经 bindPlaybackStore 注入 Drizzle 实现
    // (惰性 getDb 解析,Database 单例重开安全);不经 HTTP 暴露,不导出。
    {
      provide: PLAYBACK_STORE,
      useFactory: () => bindPlaybackStore(drizzlePlaybackStore()),
    },
    // 010 T059(US3):过渡持久端口 seam —— slot/intent/receipt/next-plan 持久查询、
    // scope 幂等、60s 固定 TTL/24h 消费结果保护、每设备 20 活计划上限淘汰(引用保护)。
    // PLAYBACK_TRANSITION_STORE provider 实例化时经 bindTransitionStore 注入 Drizzle 实现
    // (BEGIN IMMEDIATE 多写并入惯例;惰性 Database.db 解析,单例重开安全);不经 HTTP
    // 暴露,不导出。消费方:T060 transition.service / T061 resolver 过渡分支 / T062 清理面。
    {
      provide: PLAYBACK_TRANSITION_STORE,
      useFactory: () => bindTransitionStore(drizzleTransitionStore()),
    },
    // 010 T059(US3):同上下文终态只读来源授权 —— 原设备/Profile/context 校验 → 来源
    // session 只读事实;绝不重新发源票/不复活控制授权(playback-state §5;A→B→A 不等
    // 即 404 同形)。T060 创建/取消、T061 消费事务首步接线点。
    {
      provide: TransitionSourceContextService,
      useFactory: () => new TransitionSourceContextService(transitionStore()),
      inject: [PLAYBACK_TRANSITION_STORE],
    },
    // 010 T062(US3):最小清理编排 —— cleanup 端点(§7 I5:pending 取消/释放槽、consumed
    // 唯一后继持久 cleanup_requested+撤交付同 commit、提交后幂等空 stop、重试同入口幂等)、
    // GET 失权判定(完整 IntentReply 要求当前源/目标权限)与 24h 保护窗扫描面(挂
    // retention 节拍/启动恢复)。终止面复用既有 PlaybackLifecycleService(生命周期发布
    // 端口);撤交付经 markDeliveryCleanupRequested(uow 事务内并入同一提交);失权判定
    // 与 resolve 同一授权权威(PlaybackAuthorizationService.authorizeResolve)。
    {
      provide: TransitionCleanupService,
      useFactory: (
        authorization: PlaybackAuthorizationService,
        uow: unknown,
        lifecycle: PlaybackLifecycleService,
      ) =>
        new TransitionCleanupService({
          store: transitionStore(),
          identity: {
            findTrustedSession: (deviceSessionId) => {
              const row = playbackStore().findTrustedSessionRow(deviceSessionId);
              return row === undefined
                ? undefined
                : { activeProfileId: row.activeProfileId, profileContextVersion: row.profileContextVersion };
            },
          },
          cleanupTx: new UnitOfWorkTransitionCleanupTx(uow as PlaybackResolveUnitOfWork),
          entitlement: authorization,
          deliveryRevoke: {
            revokeDelivery: (input) => markDeliveryCleanupRequested(Database.db, input),
          },
          sessionTerminator: {
            stopSession: async (sessionId) => {
              const result = await lifecycle.stopSession(sessionId);
              return result.ok ? { state: result.value.state } : undefined;
            },
          },
        }),
      inject: [PlaybackAuthorizationService, UNIT_OF_WORK, PlaybackLifecycleService],
    },
    // 010 T060(US3):next/manual_next 过渡编排 —— 计划创建(来源资格/序列目标经
    // nextEpisodeFor 发布面/快照冻结/store cap 淘汰)、意图创建(scope 幂等/计划快照与
    // 偏好重验)、GET/cancel(T059 store 判别直映射)、resolve 消费分支
    // (TransitionConsumeWorkSet 事务:校验→session→epoch/ledger→consumed/后继)。
    // 目录只读事实经本地 SQL 投影适配(VodTreePolicyGate 先例);消费事务经 UNIT_OF_WORK
    // 桥;后继准备复用 resolver 既有 fire-and-forget 管线。
    {
      provide: PlaybackTransitionService,
      useFactory: (
        sourceContext: TransitionSourceContextService,
        authorization: PlaybackAuthorizationService,
        uow: unknown,
        vodInput: unknown,
        resolver: PlaybackResolverService,
        repository: PlaybackRepository,
        rateLimit: PlaybackRateLimitService,
        vodCache: unknown,
      ) =>
        new PlaybackTransitionService({
          store: transitionStore(),
          sourceContext,
          identity: {
            findTrustedSession: (deviceSessionId) => {
              const row = playbackStore().findTrustedSessionRow(deviceSessionId);
              return row === undefined
                ? undefined
                : { activeProfileId: row.activeProfileId, profileContextVersion: row.profileContextVersion };
            },
          },
          vodFacts: new TransitionVodFactsReader(Database.db),
          // 010 T072(US4):换源候选只读事实 —— 登记映射/来源启用为本地 SQL 投影
          // (VodTreePolicyGate 先例),匹配结论经 online-vod VodCache 单例候选绑定
          // 子面(structural 读面,不深导入 online-vod 内部类型)
          candidateFacts: createTransitionCandidateFactsReader(Database.db, vodCache),
          personalFacts: {
            findTargetHistory: (householdId: string, profileId: string, mediaId: string) =>
              readTargetHistory({ householdId, profileId, mediaId }),
          },
          targetAuthorizer: authorization,
          consumeTx: new UnitOfWorkTransitionConsumeTx(uow as PlaybackResolveUnitOfWork),
          inputBinder: vodInput as ConstructorParameters<typeof PlaybackTransitionService>[0]['inputBinder'],
          successorPreparer: resolver,
          sessionStore: repository,
          // 010 T061:过渡桶限频(10/min/DeviceSession;api §0「创建intent/测速各10/min」
          // + §7 next-plans 沿用同桶)—— next-plans/transition-intents 共享独立过渡桶
          transitionRateLimit: {
            acquire: (deviceId: string) => rateLimit.acquire(deviceId, 'transition_intent'),
          },
        }),
      inject: [
        TransitionSourceContextService,
        PlaybackAuthorizationService,
        UNIT_OF_WORK,
        PLAYBACK_VOD_INPUT_PORT,
        PlaybackResolverService,
        PlaybackRepository,
        PlaybackRateLimitService,
        VOD_CACHE,
      ],
    },
    // T011 仓储(类 token + 工厂;预算工厂期读取「当前」已校验 env)
    {
      provide: PlaybackRepository,
      useFactory: () => new PlaybackRepository(Database.db, createPlaybackBudgets(getConfig())),
    },
    // T017 授权管线(policy/PIN 既有纯函数模块按惯例具名导入,不重复 provide;
    // T043:在线父子有效策略门经模块内令牌装配 —— 单测直构不注入,既有行为零变化)
    PlaybackAuthorizationService,
    // 010 T043:在线父子树有效策略门(media-catalog 读面构造父子事实 + T017 发布端口判定)
    {
      provide: PLAYBACK_VOD_POLICY_GATE,
      useFactory: () => new VodTreePolicyGate(Database.db),
    },
    // 010 T042/T044:固定输入绑定 store(T042 每 session/generation 最多一有效绑定;
    // 地址不落库不打日志)。T044:经 VodFixedInputDeliveryGateway 交付面装饰 —— resolver
    // 桥/probe/资产/代理共用同一 store 实例(无第二绑定权威),网关捕获 entryUrl 入内存
    // 租约(resolvedInputId 持有)并提供统一消费点/代次断言/租约 renew-revoke 原语
    // (T045 renew/watchdog 面接线缝)与 VOD 上游 URL 登记(SafeUpstream 分流依据)
    {
      provide: PLAYBACK_VOD_INPUT_STORE,
      useFactory: () => new VodFixedInputDeliveryGateway(drizzleVodInputStore(), () => Database.db),
    },
    // 010 T044:VOD SafeUpstream 嵌套读取链(T018 NestedBudgetLedger/readNestedLevel;
    // 预算由 playback hlsUpstream 派生,许可调用期读取 LAN_ALLOWED_TARGETS,per-rig env
    // 与既有装配同口径;DNS stub 仅测试注入)
    {
      provide: VOD_HLS_UPSTREAM_READER,
      useFactory: () => {
        const budgets = createPlaybackBudgets(getConfig());
        return new VodHlsUpstreamReader({
          nestedBudgets: vodNestedBudgetsFromPlaybackBudgets(budgets),
          timeBudgets: {
            totalTimeoutMs: budgets.hlsUpstream.firstByteTimeoutSeconds * 1000,
            idleTimeoutMs: budgets.hlsUpstream.idleTimeoutSeconds * 1000,
            maxRedirects: budgets.hlsUpstream.maxRedirects,
          },
          allowedTargets: () => getConfig().LAN_ALLOWED_TARGETS,
        });
      },
    },
    // 010 T043:固定输入绑定端口桥(T042 store + 解析事实读取;网络/解析在事务外)
    {
      provide: PLAYBACK_VOD_INPUT_PORT,
      useFactory: (store: VodInputStore) => new ResolverVodInputBridge(store, new VodResolvedFactsReader(Database.db)),
      inject: [PLAYBACK_VOD_INPUT_STORE],
    },
    // 010 T043:事务建档工作集(§2「普通resolve也要把session+epoch绑定改为同一用例事务」
    // + FR-021 freezeOnce 接缝 + 绑定行回读;UNIT_OF_WORK 为 @Global 组合根绑定)
    {
      provide: PLAYBACK_RESOLVE_WORK_SET,
      useFactory: (uow: unknown) => new PlaybackResolveWorkSetAdapter(uow as PlaybackResolveUnitOfWork, Database.db),
      inject: [UNIT_OF_WORK],
    },
    // 010 T041:VOD 起点计算(beginning/resume 唯一决策入口;targetHistory=personal-data
    // 发布面值导出直绑,adjudicator=T039 resolveStartPoint 纯函数经 online-vod 发布面绑定
    // —— R2 零深导入;staticResumeFreeze=既有续播冻结端口,静态媒体语义零变化)
    {
      provide: PLAYBACK_START_POSITION,
      useFactory: (progressClock: IProgressClockService) =>
        new VodStartPositionService({
          targetHistory: { readTargetHistory, readTargetMediaFacts },
          adjudicator: { resolveStartPoint },
          staticResumeFreeze: progressClock,
        }),
      inject: [PROGRESS_CLOCK_PORT],
    },
    // T020 NAS 只读安全读取器(mediaRoots 工厂期读取当前 env)
    {
      provide: NasReaderService,
      useFactory: () => new NasReaderService({ mediaRoots: getConfig().MEDIA_ROOTS }),
    },
    // T021 HLS 上游安全代理(LAN 许可读取属请求面:readPlaylist/readAsset 调用期 getConfig();
    // 010 T044:VOD 固定输入交付路由 —— 已登记 VOD 上游 URL 的读取分流 SafeUpstream 嵌套
    // 读取链,其余 URL 沿用既有 LAN 许可链,直播/旧路径行为零变化)
    {
      provide: HlsProxyService,
      useFactory: (gateway: VodFixedInputDeliveryGateway, reader: VodHlsUpstreamReader) =>
        new HlsProxyService({
          budgets: createPlaybackBudgets(getConfig()),
          vodDelivery: {
            reader,
            vodLevelOf: (upstreamUrl: string) => gateway.vodLevelOf(upstreamUrl),
          } satisfies HlsProxyVodDeliveryRoute,
        }),
      inject: [PLAYBACK_VOD_INPUT_STORE, VOD_HLS_UPSTREAM_READER],
    },
    // T022 资产映射与清单重写(entryPathPrefix = 应用全局前缀;与票据 playbackUrl 同构;
    // 010 T044:固定输入交付门 —— VOD 绑定域 rewritePlaylist/resolve 先 assertGeneration
    // Deliverable(旧代 409),上游 URL 按嵌套级别登记给代理 SafeUpstream 分流)
    {
      provide: PlaybackAssetsService,
      useFactory: (gateway: VodFixedInputDeliveryGateway) =>
        new PlaybackAssetsService({
          budgets: createPlaybackBudgets(getConfig()),
          entryPathPrefix: '/api/playback/stream',
          deliveryGate: gateway,
        }),
      inject: [PLAYBACK_VOD_INPUT_STORE],
    },
    // T023 ffprobe 受限探测(T010 预算;缺省真实时钟与 spawn)
    {
      provide: MediaProbeService,
      useFactory: () =>
        new MediaProbeService({
          budgets: createPlaybackBudgets(getConfig()),
          mediaRoots: getConfig().MEDIA_ROOTS,
        }),
    },
    // T024 格式计划(纯函数决策器)
    {
      provide: PlaybackPlanService,
      useFactory: () => new PlaybackPlanService({ budgets: createPlaybackBudgets(getConfig()) }),
    },
    // probe 源定位:playback_source 私有 location 只读投影
    // (010 T044:在线判别 locator 经固定输入网关取 entryUrl —— resolvedInputId 持有,
    // 不重读最新 location;静态 locator 行为零变化)
    {
      provide: PlaybackSourceLocationReader,
      useFactory: (gateway: VodFixedInputDeliveryGateway) => new PlaybackSourceLocationReader(Database.db, gateway),
      inject: [PLAYBACK_VOD_INPUT_STORE],
    },
    // 换代重建的会话源引用端口:playback_session → playback_source 只读投影(id+location)
    {
      provide: PLAYBACK_SESSION_SOURCE_PORT,
      useFactory: () => new SessionSourceRefReader(Database.db),
    },
    // resolver PlaybackProbePort 真实实现绑定(probe + plan 适配;
    // 010 T044:vodProbe 面 —— 在线 hls 输入 probe 经固定 input → SafeUpstream 嵌套读取链
    // (master→variant;endList 判定 duration 已知/未知),probe 结果返回前
    // assertProbeCommitGeneration;无固定输入绑定的 hls_proxy 候选恒按直播事实零变化)
    {
      provide: PLAYBACK_PROBE_PORT,
      useFactory: (
        probe: MediaProbeService,
        plan: PlaybackPlanService,
        locator: PlaybackSourceLocationReader,
        gateway: VodFixedInputDeliveryGateway,
        reader: VodHlsUpstreamReader,
      ) =>
        new MediaProbePlaybackProbePort({
          probe,
          plan,
          locator,
          mediaRoots: getConfig().MEDIA_ROOTS,
          vodProbe: { inputs: gateway, reader },
        }),
      inject: [
        MediaProbeService,
        PlaybackPlanService,
        PlaybackSourceLocationReader,
        PLAYBACK_VOD_INPUT_STORE,
        VOD_HLS_UPSTREAM_READER,
      ],
    },
    // T026 转换私有存储:rootDir=DATA_DIR(任务目录 <rootDir>/playback/<h>/<s>/<g>)
    {
      provide: ConversionStorageService,
      useFactory: () =>
        new ConversionStorageService({
          budgets: createPlaybackBudgets(getConfig()),
          rootDir: getConfig().DATA_DIR,
          clock: systemMediaProbeClock(),
        }),
    },
    // 转换任务装配账本(目录簿记 + stderr 桥接通道;无环共享面)
    PlaybackTaskDirectoryLedger,
    // T025 转换监督者:真实 ffmpeg spawn 适配(参数数组 + shell=false;stderr 转发 ledger)
    {
      provide: ConversionSupervisorService,
      useFactory: (repository: PlaybackRepository, ledger: PlaybackTaskDirectoryLedger) =>
        new ConversionSupervisorService({
          repository,
          budgets: createPlaybackBudgets(getConfig()),
          clock: systemMediaProbeClock(),
          spawn: supervisorSpawnAdapter(ledger),
          resolveOutputDirectory: (request) => ledger.taskDirectoryOf(request),
        }),
      inject: [PlaybackRepository, PlaybackTaskDirectoryLedger],
    },
    // T019 resolver(probe 端口经 token 注入;转换启动/会话源引用端口经装配 token 桥接;
    // T099/T101:进度绑定与续播冻结端口注入 —— 点播 resolve 分配 epoch + resume 冻结位置;
    // 010 T043:起点计算/固定输入绑定/事务建档工作集端口接入 —— 在线 vod resolve 事务
    // 建档 + probe 后冻结一次 + ready 重验,NAS/IPTV/直播路径端口缺位回退既有行为)
    {
      provide: PlaybackResolverService,
      useFactory: (
        repository: PlaybackRepository,
        authorization: PlaybackAuthorizationService,
        probePort: unknown,
        conversionLaunch: unknown,
        sessionSource: unknown,
        progressClock: IProgressClockService,
        startPosition: unknown,
        vodInput: unknown,
        resolveWorkSet: unknown,
      ) =>
        new PlaybackResolverService(repository, authorization, probePort as never, createPlaybackBudgets(getConfig()), {
          conversionLaunch: conversionLaunch as PlaybackConversionLaunchPort,
          sessionSource: sessionSource as PlaybackSessionSourcePort,
          progressBind: progressClock,
          resumePosition: progressClock,
          startPosition: startPosition as PlaybackResolverPorts['startPosition'],
          vodInput: vodInput as PlaybackResolverPorts['vodInput'],
          resolveWorkSet: resolveWorkSet as PlaybackResolverPorts['resolveWorkSet'],
        }),
      inject: [
        PlaybackRepository,
        PlaybackAuthorizationService,
        PLAYBACK_PROBE_PORT,
        PLAYBACK_CONVERSION_LAUNCH_PORT,
        PLAYBACK_SESSION_SOURCE_PORT,
        // T021:PersonalDataModule exports 已对齐令牌,类 token 不再跨上下文可见 ——
        // 注入改经 PROGRESS_CLOCK_PORT(useExisting 别名,同一实例)
        PROGRESS_CLOCK_PORT,
        // 010 T043:起点计算/固定输入绑定/事务建档工作集
        PLAYBACK_START_POSITION,
        PLAYBACK_VOD_INPUT_PORT,
        PLAYBACK_RESOLVE_WORK_SET,
      ],
    },
    // T100 可信时长装配桥(resolver probe 事实 → personal 写入状态机;注册表避免模块环)
    {
      provide: PERSONAL_FACTS_BRIDGE,
      useFactory: (resolver: PlaybackResolverService) => {
        registerPersonalPlaybackFactsPort({
          trustedDurationSeconds: (sessionId, generation) => resolver.factsFor(sessionId, generation)?.durationSeconds ?? null,
        });
        return true;
      },
      inject: [PlaybackResolverService],
    },
    // selection/subtitles 的事实端口:resolver 事实只读桥(+规范词表回落)
    {
      provide: PLAYBACK_TRACK_FACTS_PORT,
      useFactory: (resolver: PlaybackResolverService) => new ResolverBackedTrackFactsPort(resolver),
      inject: [PlaybackResolverService],
    },
    // T018 票据(authorizeControl + revalidate + 短事务 CAS 签发)
    // 010 T045/T046:renew 前固定输入重验桥(与 lifecycle 面共用 LifecycleVodInputGuard
    // 模式 —— 绑定行回读 × store assert/fail;无绑定会话由 hasCurrentBinding 门跳过;
    // 装配最小增量,服务文件头注明)
    {
      provide: PlaybackTicketService,
      useFactory: (
        repository: PlaybackRepository,
        authorization: PlaybackAuthorizationService,
        vodInputBridge: ResolverVodInputBridge,
        resolveWorkSet: PlaybackResolveWorkSetAdapter,
      ) =>
        new PlaybackTicketService(
          repository,
          authorization,
          createPlaybackBudgets(getConfig()),
          new LifecycleVodInputGuard(vodInputBridge, resolveWorkSet),
        ),
      inject: [
        PlaybackRepository,
        PlaybackAuthorizationService,
        // 010 T045:vod 固定输入重验桥(store 端口 + 绑定行回读)
        PLAYBACK_VOD_INPUT_PORT,
        PLAYBACK_RESOLVE_WORK_SET,
      ],
    },
    // T030 字幕(逐请求授权;locator=会话源 location 投影;embedded=受限 ffmpeg demux)
    {
      provide: PlaybackSubtitlesService,
      useFactory: (authorization: PlaybackAuthorizationService, facts: PlaybackTrackFactsPort, nasReader: NasReaderService) =>
        new PlaybackSubtitlesService({
          authorization,
          facts,
          locator: new SessionPlaybackSourceLocator(Database.db),
          nasReader,
          mediaRoots: getConfig().MEDIA_ROOTS,
          budgets: createPlaybackBudgets(getConfig()),
          embedded: new FfmpegSubtitleExtractService({
            budgets: createPlaybackBudgets(getConfig()),
            mediaRoots: getConfig().MEDIA_ROOTS,
          }),
        }),
      inject: [PlaybackAuthorizationService, PLAYBACK_TRACK_FACTS_PORT, NasReaderService],
    },
    // T028 生命周期(storage 端口组合 assets/ledger 释放;私有根 DATA_DIR/playback;
    // T101:progressFinal 端口 = personal 写入状态机 —— stop final 与终态同事务协作;
    // 010 T045:vodInputGuard = vod 固定输入心跳重验桥(绑定行回读 × store assert/fail),
    // 无绑定会话(NAS/直播)由 hasCurrentBinding 门跳过,零变化)
    {
      provide: PlaybackLifecycleService,
      useFactory: (
        repository: PlaybackRepository,
        authorization: PlaybackAuthorizationService,
        supervisor: ConversionSupervisorService,
        storage: ConversionStorageService,
        assets: PlaybackAssetsService,
        ledger: PlaybackTaskDirectoryLedger,
        progressWrite: IProgressWriteService,
        vodInputBridge: ResolverVodInputBridge,
        resolveWorkSet: PlaybackResolveWorkSetAdapter,
      ) =>
        new PlaybackLifecycleService({
          repository,
          authorization,
          supervisor,
          budgets: createPlaybackBudgets(getConfig()),
          privateRootDir: path.join(getConfig().DATA_DIR, 'playback'),
          progressFinal: progressWrite satisfies PlaybackFinalProgressPort,
          vodInputGuard: new LifecycleVodInputGuard(vodInputBridge, resolveWorkSet),
          storage: {
            releaseSession: async (householdId: string, sessionId: string): Promise<void> => {
              await storage.releaseSession(householdId, sessionId);
              // TTL 不超 session:会话清理同步丢弃资产映射(重启失效语义的主动面)
              assets.releaseSession(householdId, sessionId);
              ledger.releaseSession(householdId, sessionId);
            },
            releaseTask: (task) => storage.releaseTask(task),
            pendingCleanupTasks: () => storage.pendingCleanupTasks(),
          } satisfies LifecycleStoragePort,
        }),
      inject: [
        PlaybackRepository,
        PlaybackAuthorizationService,
        ConversionSupervisorService,
        ConversionStorageService,
        PlaybackAssetsService,
        PlaybackTaskDirectoryLedger,
        // T021:同上 —— PersonalDataModule 令牌 exports,注入改经 PROGRESS_WRITE_PORT
        PROGRESS_WRITE_PORT,
        // 010 T045:vod 固定输入重验桥(store 端口 + 绑定行回读)
        PLAYBACK_VOD_INPUT_PORT,
        PLAYBACK_RESOLVE_WORK_SET,
      ],
    },
    // 转换装配桥接(换代协同 + 看门狗/监督者/暂停配对;转换交付入口 launchAndWaitFirstOutput())
    {
      provide: PlaybackConversionBridge,
      useFactory: (
        supervisor: ConversionSupervisorService,
        storage: ConversionStorageService,
        lifecycle: PlaybackLifecycleService,
        ledger: PlaybackTaskDirectoryLedger,
        assets: PlaybackAssetsService,
      ) =>
        new PlaybackConversionBridge({
          supervisor,
          storage,
          lifecycle,
          ledger,
          assets,
          budgets: createPlaybackBudgets(getConfig()),
          clock: systemMediaProbeClock(),
        }),
      inject: [
        ConversionSupervisorService,
        ConversionStorageService,
        PlaybackLifecycleService,
        PlaybackTaskDirectoryLedger,
        PlaybackAssetsService,
      ],
    },
    // resolver 转换启动端口(缺口1):源定位 → bridge.launchAndWaitFirstOutput → 产物窗口登记;
    // 010 T044:在线判别 locator 的转换直送监督者安全裁决(inputChannel='online-upstream')
    {
      provide: PLAYBACK_CONVERSION_LAUNCH_PORT,
      useFactory: (
        bridge: PlaybackConversionBridge,
        ledger: PlaybackTaskDirectoryLedger,
        assets: PlaybackAssetsService,
        locator: PlaybackSourceLocationReader,
        supervisor: ConversionSupervisorService,
      ) =>
        new ResolverConversionLaunchPort({
          bridge,
          ledger,
          assets,
          locator,
          mediaRoots: getConfig().MEDIA_ROOTS,
          clock: systemMediaProbeClock(),
          supervisor,
        }),
      inject: [
        PlaybackConversionBridge,
        PlaybackTaskDirectoryLedger,
        PlaybackAssetsService,
        PlaybackSourceLocationReader,
        ConversionSupervisorService,
      ],
    },
    // T029 selection/seek(事实端口 + 字幕目录 + 换代协同端口 + 重回准备端口注入;
    // 010 T045:vodInput store = 在线 vod 换代 CAS 权威,startFacts = I4 起播标记只读投影
    // —— 无绑定会话(NAS/直播)与端口缺位形态回退既有路径,零变化)
    {
      provide: PlaybackSelectionService,
      useFactory: (
        repository: PlaybackRepository,
        authorization: PlaybackAuthorizationService,
        facts: PlaybackTrackFactsPort,
        subtitleCatalog: PlaybackSubtitleCatalogPort,
        rebuildCoordinator: PlaybackRebuildCoordinator,
        resolver: PlaybackResolverService,
        vodInput: VodInputStore,
      ) =>
        new PlaybackSelectionService({
          repository,
          authorization,
          facts,
          subtitleCatalog,
          rebuildCoordinator,
          // 缺口2:换代提交后经 resolver.prepareRebuild 重回 ready(fire-and-forget)
          reprepare: resolver,
          // 010 T045:store 换代 CAS 权威 + I4 起播事实(只读投影)
          vodInput,
          startFacts: new SessionPlaybackStartFactsReader(Database.db),
          budgets: createPlaybackBudgets(getConfig()),
        }),
      inject: [
        PlaybackRepository,
        PlaybackAuthorizationService,
        PLAYBACK_TRACK_FACTS_PORT,
        PlaybackSubtitlesService,
        PlaybackConversionBridge,
        PlaybackResolverService,
        PLAYBACK_VOD_INPUT_STORE,
      ],
    },
    // T031 解析控制限频(每设备滑动窗口;预算数值权威 playback-budgets.rateLimit)
    {
      provide: PlaybackRateLimitService,
      useFactory: () => new PlaybackRateLimitService(createPlaybackBudgets(getConfig())),
    },
    // 010 T057 相位观测服务(US3):UNIT_OF_WORK 桥(BEGIN IMMEDIATE 同步事务;事务内
    // 身份/归属/代次/phase/交付重验 + T054 ingestObservation 锚语义落行 + playing 与
    // playback_started_at 同事务 CAS)—— 会话 2Hz 限流桶为服务内存态(120/min/session,
    // api.md §0),观测面限流不占 playback-budgets;T058 finish 判定的观测读取经
    // 同一服务/参与者读面复用。
    {
      provide: PhaseObservationService,
      useFactory: (uow: unknown) =>
        new PhaseObservationService(
          uow as ConstructorParameters<typeof PhaseObservationService>[0],
        ),
      inject: [UNIT_OF_WORK],
    },
    // 010 T058 finish 编排服务(US3):ProgressFinishWorkSet 同事务(uow BEGIN IMMEDIATE;
    // 事务内身份/归属重验 → resolveFinishInvocation 分支 → evaluate 分支「final 先校验
    // (evaluateFinish 纯闸门)→ personal-data 状态机接受 final/ledger/epoch 历史(savepoint
    // 嵌套,T101 既有协作面)→ 观测 flush 尾段判定 → receipt → ended → 输入待清理」一个
    // commit,硬错误整次回滚)—— progressFinal 经 PROGRESS_WRITE_PORT 发布面注入
    // (IProgressWriteService.applyFinalInTransaction 结构满足协作端口);可信 duration 取
    // ledger 已接受样本记录的同一事实(progress_state.ledger_duration,T092 seam 注入对
    // finish 自然生效);GET finish-result 为同服务只读编排(原设备/原上下文,404 同形)。
    {
      provide: PlaybackFinishService,
      useFactory: (uow: unknown, progressWrite: IProgressWriteService) =>
        new PlaybackFinishService({
          uow: uow as ConstructorParameters<typeof PlaybackFinishService>[0]['uow'],
          progressFinal: progressWrite satisfies PlaybackFinishProgressPort,
        }),
      inject: [UNIT_OF_WORK, PROGRESS_WRITE_PORT],
    },
    // 启动引导:recoverOnBoot → readyToAcceptConversions → start()(onModuleInit)
    PlaybackBootstrapper,
    // T043 审计:resolve 拒绝旁路落 failure_event(controller catch 接入;零依赖纯服务)
    PlaybackAuditService,
    // T045 每日保留清理(预算工厂期读取「当前」已校验 env;时钟缺省真实系统时钟;
    // 010 T045:vodInput store = 未起播 60s 固定期限回收的持久原语,本服务持节拍调度;
    // 010 T062:transitionCleanup = 过渡清理扫描面,挂启动恢复首拍 + watchdog 节拍)
    {
      provide: PlaybackRetentionService,
      useFactory: (vodInput: VodInputStore, transitionCleanup: TransitionCleanupService) =>
        new PlaybackRetentionService({
          budgets: createPlaybackBudgets(getConfig()),
          vodInput,
          transitionCleanup,
        }),
      inject: [PLAYBACK_VOD_INPUT_STORE, TransitionCleanupService],
    },
  ],
  exports: [
    PlaybackRepository,
    PlaybackAuthorizationService,
    NasReaderService,
    HlsProxyService,
    PlaybackAssetsService,
    MediaProbeService,
    PlaybackPlanService,
    PLAYBACK_PROBE_PORT,
    PlaybackTicketService,
    PlaybackResolverService,
    PlaybackSelectionService,
    PlaybackSubtitlesService,
    PlaybackRateLimitService,
    ConversionSupervisorService,
    ConversionStorageService,
    PlaybackLifecycleService,
    PlaybackConversionBridge,
    PlaybackAuditService,
    PlaybackRetentionService,
    // 010 T057:相位观测服务(T058 finish 判定复用读面;限流桶随服务实例存续)
    PhaseObservationService,
    // 010 T058:finish 编排服务(仅本模块控制器消费;receipt/终态原子提交编排)
    PlaybackFinishService,
  ],
})
export class PlaybackModule {}
