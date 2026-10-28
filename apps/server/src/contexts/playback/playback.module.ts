import { spawn as spawnNodeProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type DatabaseConstructor from 'better-sqlite3';
import { and, eq, inArray } from 'drizzle-orm';
import { createPlaybackBudgets } from '../../config/playback-budgets';
import { getConfig } from '../../config/env';
import type { MediaRoots } from '../../config/env.schema';
import { Database } from '../../database/database';
import { playbackConversion, playbackSession } from '../../database/schema';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import { NasReaderService } from '@contexts/playback/infrastructure/nas-reader';
import { HlsProxyService } from '@contexts/playback/infrastructure/hls-proxy.service';
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
import { PlaybackResolverService, type PlaybackConversionLaunchPort, type PlaybackProbeFacts, type PlaybackSessionSourcePort } from '@contexts/playback/application/playback-resolver.service';
import { PlaybackTicketService } from '@contexts/playback/application/playback-ticket.service';
import {
  PlaybackSelectionService,
  type PlaybackRebuildCoordinator,
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
import { PersonalDataModule } from '@contexts/personal-data/personal-data.module';
import {
  ProgressClockService,
  registerPersonalPlaybackFactsPort,
} from '@contexts/personal-data/application/progress-clock.service';
import { ProgressWriteService } from '@contexts/personal-data/application/progress-write.service';
import type { PlaybackFinalProgressPort } from '@contexts/playback/infrastructure/playback-lifecycle.service';
import { CommonModule } from '../../common/common.module';
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
 * 权威实现在 modules/settings(settings-devices.controller/service,POST
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
    const rows = getDb()
      .select({ id: playbackConversion.id, householdId: playbackConversion.householdId })
      .from(playbackConversion)
      .where(
        and(
          eq(playbackConversion.sessionId, sessionId),
          eq(playbackConversion.generation, supersededGeneration),
          inArray(playbackConversion.state, [...PLAYBACK_CONVERSION_ACTIVE_STATES]),
        ),
      )
      .all();
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
      const row = getDb()
        .select({ state: playbackConversion.state, failureCode: playbackConversion.failureCode })
        .from(playbackConversion)
        .where(eq(playbackConversion.id, conversionId))
        .get();
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
    const row = getDb()
      .select({ householdId: playbackSession.householdId })
      .from(playbackSession)
      .where(eq(playbackSession.id, sessionId))
      .get();
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
    },
  ) {}

  async startAndWaitFirstOutput(request: Parameters<PlaybackConversionLaunchPort['startAndWaitFirstOutput']>[0]): Promise<PlaybackResult<{ readonly conversionId: string }>> {
    const located = await this.deps.locator.locate(request.playbackSourceId);
    if (located === null) {
      return playbackErr('PLAYBACK_RESOURCE_UNAVAILABLE', '播放源定位失败,无法启动转换');
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
  imports: [CommonModule, PersonalDataModule],
  controllers: [PlaybackController, PlaybackStreamController],
  providers: [
    // T011 仓储(类 token + 工厂;预算工厂期读取「当前」已校验 env)
    {
      provide: PlaybackRepository,
      useFactory: () => new PlaybackRepository(Database.db, createPlaybackBudgets(getConfig())),
    },
    // T017 授权管线(policy/PIN 既有纯函数模块按惯例具名导入,不重复 provide)
    PlaybackAuthorizationService,
    // T020 NAS 只读安全读取器(mediaRoots 工厂期读取当前 env)
    {
      provide: NasReaderService,
      useFactory: () => new NasReaderService({ mediaRoots: getConfig().MEDIA_ROOTS }),
    },
    // T021 HLS 上游安全代理(LAN 许可读取属请求面:readPlaylist/readAsset 调用期 getConfig())
    {
      provide: HlsProxyService,
      useFactory: () => new HlsProxyService({ budgets: createPlaybackBudgets(getConfig()) }),
    },
    // T022 资产映射与清单重写(entryPathPrefix = 应用全局前缀;与票据 playbackUrl 同构)
    {
      provide: PlaybackAssetsService,
      useFactory: () =>
        new PlaybackAssetsService({
          budgets: createPlaybackBudgets(getConfig()),
          entryPathPrefix: '/api/playback/stream',
        }),
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
    {
      provide: PlaybackSourceLocationReader,
      useFactory: () => new PlaybackSourceLocationReader(Database.db),
    },
    // 换代重建的会话源引用端口:playback_session → playback_source 只读投影(id+location)
    {
      provide: PLAYBACK_SESSION_SOURCE_PORT,
      useFactory: () => new SessionSourceRefReader(Database.db),
    },
    // resolver PlaybackProbePort 真实实现绑定(probe + plan 适配)
    {
      provide: PLAYBACK_PROBE_PORT,
      useFactory: (probe: MediaProbeService, plan: PlaybackPlanService, locator: PlaybackSourceLocationReader) =>
        new MediaProbePlaybackProbePort({ probe, plan, locator, mediaRoots: getConfig().MEDIA_ROOTS }),
      inject: [MediaProbeService, PlaybackPlanService, PlaybackSourceLocationReader],
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
    // T099/T101:进度绑定与续播冻结端口注入 —— 点播 resolve 分配 epoch + resume 冻结位置)
    {
      provide: PlaybackResolverService,
      useFactory: (
        repository: PlaybackRepository,
        authorization: PlaybackAuthorizationService,
        probePort: unknown,
        conversionLaunch: unknown,
        sessionSource: unknown,
        progressClock: ProgressClockService,
      ) =>
        new PlaybackResolverService(repository, authorization, probePort as never, createPlaybackBudgets(getConfig()), {
          conversionLaunch: conversionLaunch as PlaybackConversionLaunchPort,
          sessionSource: sessionSource as PlaybackSessionSourcePort,
          progressBind: progressClock,
          resumePosition: progressClock,
        }),
      inject: [
        PlaybackRepository,
        PlaybackAuthorizationService,
        PLAYBACK_PROBE_PORT,
        PLAYBACK_CONVERSION_LAUNCH_PORT,
        PLAYBACK_SESSION_SOURCE_PORT,
        ProgressClockService,
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
    {
      provide: PlaybackTicketService,
      useFactory: (repository: PlaybackRepository, authorization: PlaybackAuthorizationService) =>
        new PlaybackTicketService(repository, authorization, createPlaybackBudgets(getConfig())),
      inject: [PlaybackRepository, PlaybackAuthorizationService],
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
    // T101:progressFinal 端口 = personal 写入状态机 —— stop final 与终态同事务协作)
    {
      provide: PlaybackLifecycleService,
      useFactory: (
        repository: PlaybackRepository,
        authorization: PlaybackAuthorizationService,
        supervisor: ConversionSupervisorService,
        storage: ConversionStorageService,
        assets: PlaybackAssetsService,
        ledger: PlaybackTaskDirectoryLedger,
        progressWrite: ProgressWriteService,
      ) =>
        new PlaybackLifecycleService({
          repository,
          authorization,
          supervisor,
          budgets: createPlaybackBudgets(getConfig()),
          privateRootDir: path.join(getConfig().DATA_DIR, 'playback'),
          progressFinal: progressWrite satisfies PlaybackFinalProgressPort,
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
        ProgressWriteService,
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
    // resolver 转换启动端口(缺口1):源定位 → bridge.launchAndWaitFirstOutput → 产物窗口登记
    {
      provide: PLAYBACK_CONVERSION_LAUNCH_PORT,
      useFactory: (
        bridge: PlaybackConversionBridge,
        ledger: PlaybackTaskDirectoryLedger,
        assets: PlaybackAssetsService,
        locator: PlaybackSourceLocationReader,
      ) =>
        new ResolverConversionLaunchPort({
          bridge,
          ledger,
          assets,
          locator,
          mediaRoots: getConfig().MEDIA_ROOTS,
          clock: systemMediaProbeClock(),
        }),
      inject: [PlaybackConversionBridge, PlaybackTaskDirectoryLedger, PlaybackAssetsService, PlaybackSourceLocationReader],
    },
    // T029 selection/seek(事实端口 + 字幕目录 + 换代协同端口 + 重回准备端口注入)
    {
      provide: PlaybackSelectionService,
      useFactory: (
        repository: PlaybackRepository,
        authorization: PlaybackAuthorizationService,
        facts: PlaybackTrackFactsPort,
        subtitleCatalog: PlaybackSubtitleCatalogPort,
        rebuildCoordinator: PlaybackRebuildCoordinator,
        resolver: PlaybackResolverService,
      ) =>
        new PlaybackSelectionService({
          repository,
          authorization,
          facts,
          subtitleCatalog,
          rebuildCoordinator,
          // 缺口2:换代提交后经 resolver.prepareRebuild 重回 ready(fire-and-forget)
          reprepare: resolver,
          budgets: createPlaybackBudgets(getConfig()),
        }),
      inject: [
        PlaybackRepository,
        PlaybackAuthorizationService,
        PLAYBACK_TRACK_FACTS_PORT,
        PlaybackSubtitlesService,
        PlaybackConversionBridge,
        PlaybackResolverService,
      ],
    },
    // T031 解析控制限频(每设备滑动窗口;预算数值权威 playback-budgets.rateLimit)
    {
      provide: PlaybackRateLimitService,
      useFactory: () => new PlaybackRateLimitService(createPlaybackBudgets(getConfig())),
    },
    // 启动引导:recoverOnBoot → readyToAcceptConversions → start()(onModuleInit)
    PlaybackBootstrapper,
    // T043 审计:resolve 拒绝旁路落 failure_event(controller catch 接入;零依赖纯服务)
    PlaybackAuditService,
    // T045 每日保留清理(预算工厂期读取「当前」已校验 env;时钟缺省真实系统时钟)
    {
      provide: PlaybackRetentionService,
      useFactory: () => new PlaybackRetentionService({ budgets: createPlaybackBudgets(getConfig()) }),
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
  ],
})
export class PlaybackModule {}
