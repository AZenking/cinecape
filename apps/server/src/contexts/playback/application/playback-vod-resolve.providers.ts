/**
 * playback VOD resolve 装配私有 provider(010 T043,US2;playback.module 工厂装配,
 * 不经上下文发布面导出)。职责边界(T043 接线点逐一对应):
 *
 * - PlaybackResolveWorkSetAdapter(internal-ports §2):普通 resolve 的「session +
 *   epoch/ledger 同用例事务」建档(避免 createSession 先成功而后 bind 失败的半建档)
 *   + FR-021「probe 后只冻结一次」接缝(freezeOnce 经 InputBindingTx,frozen_at 守卫)
 *   + 绑定行回读(ready 提交的冻结值/start_basis 透传基准);
 * - VodTreePolicyGate(T017 复用):在线父子树有效策略判定端口 —— 父子事实由服务端
 *   media-catalog 读面构造(对齐 T029 materialization 的接线方式:目录行等级为权威,
 *   批量装载禁逐集 N+1),判定经发布端口 evaluateEffectiveMediaPolicy 纯函数,
 *   不把普通查询构造实体(仅 vod 树构造事实);
 * - VodResolvedFactsReader + ResolverVodInputBridge(T042 接线):固定输入绑定端口桥 —
 *   解析事实(目录/来源修订 + 私有入口 locator)在事务外读取(§2「网络不在事务」;
 *   本读取面零网络,本地目录投影),经 playback-input-store(T042)落「每 session/
 *   generation 最多一有效绑定」「frozen_start_seconds NULL 直到 probe」「start_basis
 *   三值」;ready 提交经 assertFixedInputCurrent 四维修订重验。
 *
 * 隐私纪律(internal-ports §3/§4):私有入口 locator/entryUrl 只在私有载荷 → 内存
 * registry → 私有值对象之间流转;本文件不产生任何含地址的日志/DTO/错误消息(错误
 * detail 只含脱敏语义),不落任何持久列(0007「入口 URL 不入库」)。
 *
 * R2 纪律:跨上下文仅消费发布面(@contexts/policy 纯函数;T042 store 为本上下文
 * infrastructure,R1b(c) 合法面;UnitOfWork 以结构镜像类型承载,不深导 platform/database,
 * 对齐 materialization.service 的镜像先例)。
 */
import { randomUUID } from 'node:crypto';
import { createDomainError } from '@platform/http-common/domain-error';
import {
  evaluateEffectiveMediaPolicy,
  parseStoredList,
  type EffectiveMediaPolicyInput,
  type ParentChildMediaFacts,
} from '@contexts/policy';
import { freezeOnce, type VodStartPointDecision } from '@contexts/playback/application/vod-start-position.service';
import type { PlaybackVodPolicyGatePort } from '@contexts/playback/application/playback-authorization.service';
import type {
  InputBindingRow,
  InputBindingTx,
  PlaybackSessionTx,
  ProgressClockTx,
  SessionLedgerTx,
} from '@contexts/playback/application/playback-work-set.port';
import type {
  PlaybackResolveWorkSetPort,
  PlaybackResolverVodInputPort,
  PlaybackVodInputRevisionExpectation,
} from '@contexts/playback/application/playback-resolver.service';
import type { VodInputStore, VodResolvedInputFacts } from '@contexts/playback/infrastructure/playback-input-store.drizzle';

/* ------------------------------------------------------------------ */
/* UnitOfWork 结构镜像(不深导 platform/database;对齐 T029 先例)           */
/* ------------------------------------------------------------------ */

/**
 * 结构化 SQLite 只读句柄(类型面;与 better-sqlite3 Database 结构相容 ——
 * application 层不引入基础设施包类型,008 R1b 数据访问实现细节禁令同旨;
 * 事务写面一律经 UnitOfWork 参与者,句柄仅承载只读投影)。
 */
export interface SqliteReadHandle {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** resolve 建档工作集消费的绑定后 txStores(键名与组合根注册表一致,按需取用) */
export type ResolveTxBoundStores = {
  readonly credential: { readonly transactionId: string; readonly behavior: 'immediate' };
  readonly playback: PlaybackSessionTx & InputBindingTx;
  readonly personalData: ProgressClockTx & SessionLedgerTx;
};
/** 平台 UnitOfWork.run 的同步返回形态镜像(thenable 压 never;与平台逐字同构) */
export type ResolveSyncResult<T> = [T] extends [PromiseLike<unknown>] ? never : T;

/**
 * 平台 UnitOfWork 的结构镜像(方法语法 → 参数双向协变;装配面
 * UnitOfWork<TxStoresRegistry> → 本镜像的编译期结构校验成立)。
 */
export interface PlaybackResolveUnitOfWork {
  run<TWorkSet, TResult>(
    workSetFactory: (txStores: ResolveTxBoundStores) => TWorkSet,
    callback: (workSet: TWorkSet) => TResult,
    options: { readonly behavior: 'immediate'; readonly busyBudgetMs?: number },
  ): ResolveSyncResult<TResult>;
}

/* ------------------------------------------------------------------ */
/* 事务建档工作集适配(§2:session + epoch/ledger 同用例事务 + 冻结一次)     */
/* ------------------------------------------------------------------ */

/** 建档时的 ledger 基线事实(目录/子项修订;子项无证据 → 1 基线,旧义同形) */
interface VodLedgerBaseline {
  readonly contentRevision: number;
  readonly continuityRevision: number;
}

/**
 * T043 事务建档工作集:UNIT_OF_WORK 桥(BEGIN IMMEDIATE 同步事务,任一参与者抛错
 * 即整体回滚;T008/T016 契约)+ 非事务只读投影(目录基线/绑定行回读,对齐模块级
 * SessionSourceRefReader 只读先例)。
 */
export class PlaybackResolveWorkSetAdapter implements PlaybackResolveWorkSetPort {
  constructor(
    private readonly uow: PlaybackResolveUnitOfWork,
    private readonly db: SqliteReadHandle,
  ) {}

  /** 事务建档:preparing session + epoch 分配 + 完整 ledger 首次建档(同 commit) */
  createSessionWithLedger(input: {
    readonly householdId: string;
    readonly deviceSessionId: string;
    readonly deviceId: string;
    readonly profileId: string;
    readonly mediaId: string;
    readonly profileContextVersion: number;
    readonly at?: string;
  }): { readonly sessionId: string; readonly generation: number; readonly version: number } {
    const at = input.at ?? new Date().toISOString();
    const baseline = this.readLedgerBaseline(input.householdId, input.mediaId);
    return this.uow.run(
      (txStores) => ({ playback: txStores.playback, personalData: txStores.personalData }),
      (workSet) => {
        const sessionId = randomUUID();
        // 与 repository.createSession 同列形态(preparing/source/delivery 空,generation=version=1)
        workSet.playback.insertPreparingSession({
          sessionId,
          householdId: input.householdId,
          deviceSessionId: input.deviceSessionId,
          deviceId: input.deviceId,
          profileId: input.profileId,
          mediaId: input.mediaId,
          generation: 1,
          version: 1,
          profileContextVersion: input.profileContextVersion,
          createdAt: at,
          lastHeartbeatAt: at,
        });
        // epoch 短分配(可跳号不可重置;失败随事务回滚不消耗号)
        const candidateEpoch = workSet.personalData.allocateProgressEpoch(input.householdId, input.profileId);
        workSet.personalData.insertLedgerRow({
          householdId: input.householdId,
          playbackSessionId: sessionId,
          profileId: input.profileId,
          mediaId: input.mediaId,
          candidateEpoch,
          contentRevision: baseline.contentRevision,
          profileContextVersion: input.profileContextVersion,
          lastGeneration: 1,
          continuityRevision: baseline.continuityRevision,
          lastResult: null,
        });
        return { sessionId, generation: 1, version: 1 };
      },
      { behavior: 'immediate' },
    );
  }

  /** FR-021 冻结一次接缝:freezeOnce 经事务工作集 InputBindingTx(frozen_at 守卫,仅首冻结落值) */
  freezeStartOnce(input: {
    readonly householdId: string;
    readonly bindingId: string;
    readonly decision: VodStartPointDecision;
  }): void {
    this.uow.run(
      (txStores) => ({ inputBinding: txStores.playback }),
      (workSet) => {
        freezeOnce({
          householdId: input.householdId,
          bindingId: input.bindingId,
          decision: input.decision,
          inputBinding: workSet.inputBinding,
        });
      },
      { behavior: 'immediate' },
    );
  }

  /** 绑定行回读(冻结值/start_basis 透传与 ready 重验期望基准;只读投影,无行 undefined) */
  findActiveBinding(householdId: string, sessionId: string, generation: number): InputBindingRow | undefined {
    return this.db
      .prepare(
        `SELECT
          id,
          household_id AS householdId,
          session_id AS sessionId,
          generation,
          playback_source_id AS playbackSourceId,
          source_id AS sourceId,
          locator_revision AS locatorRevision,
          detail_revision AS detailRevision,
          content_revision AS contentRevision,
          continuity_revision AS continuityRevision,
          evidence_state AS evidenceState,
          evidence_digest AS evidenceDigest,
          resolved_input_id AS resolvedInputId,
          resolved_at AS resolvedAt,
          expires_at AS expiresAt,
          start_basis AS startBasis,
          frozen_start_seconds AS frozenStartSeconds,
          frozen_at AS frozenAt,
          cleanup_requested AS cleanupRequested,
          cleanup_reason AS cleanupReason,
          cleanup_state AS cleanupState
        FROM playback_input_binding
        WHERE household_id = ? AND session_id = ? AND generation = ?`,
      )
      .get(householdId, sessionId, generation) as InputBindingRow | undefined;
  }

  /** ledger 基线(目录内容修订 + 子项连续性修订;子项无证据 → 1 基线,与 resolve 绑定旧义同形) */
  private readLedgerBaseline(householdId: string, mediaId: string): VodLedgerBaseline {
    const row = this.db
      .prepare(
        `SELECT mi.content_revision AS contentRevision, ve.continuity_revision AS continuityRevision
         FROM media_item mi
         LEFT JOIN vod_episode ve ON ve.household_id = mi.household_id AND ve.media_id = mi.id
         WHERE mi.household_id = ? AND mi.id = ?`,
      )
      .get(householdId, mediaId) as { contentRevision?: unknown; continuityRevision?: unknown } | undefined;
    const contentRevision = typeof row?.contentRevision === 'number' && row.contentRevision >= 1 ? row.contentRevision : 1;
    const continuityRevision =
      typeof row?.continuityRevision === 'number' && row.continuityRevision >= 1 ? row.continuityRevision : 1;
    return { contentRevision, continuityRevision };
  }
}

/* ------------------------------------------------------------------ */
/* 在线父子有效策略门(T017 发布端口复用;父子事实经 media-catalog 读面构造)  */
/* ------------------------------------------------------------------ */

/** 目录媒体行投影(角色/等级;策略判定输入) */
interface CatalogMediaProjection {
  readonly mediaId: string;
  readonly role: string;
  readonly contentLevel: number | null;
}

/** profile_policy 行投影(判定视图输入) */
interface PolicyRowProjection {
  readonly maxContentLevel: unknown;
  readonly allowUnrated: unknown;
  readonly allowedMediaIds: string;
  readonly blockedMediaIds: string;
  readonly allowedChannelIds: string;
  readonly version: unknown;
}

/** 策略行 → 判定视图;缺失(null 行)与损坏(不变量破坏)统一返回 null(503 fail-closed 由门归一) */
function toPolicyJudgment(row: PolicyRowProjection | undefined): EffectiveMediaPolicyInput['policy'] {
  if (row === undefined) {
    return null;
  }
  const maxContentLevel = row.maxContentLevel;
  const allowUnrated = row.allowUnrated;
  const version = row.version;
  if (
    !Number.isInteger(maxContentLevel) ||
    (maxContentLevel as number) < 0 ||
    (maxContentLevel as number) > 18 ||
    (allowUnrated !== 0 && allowUnrated !== 1) ||
    !Number.isInteger(version) ||
    (version as number) < 1
  ) {
    return null;
  }
  try {
    return {
      maxContentLevel: maxContentLevel as number,
      allowUnrated: allowUnrated === 1,
      allowedMediaIds: parseStoredList(row.allowedMediaIds, 'allowedMediaIds'),
      blockedMediaIds: parseStoredList(row.blockedMediaIds, 'blockedMediaIds'),
      allowedChannelIds: parseStoredList(row.allowedChannelIds, 'allowedChannelIds'),
    };
  } catch {
    return null;
  }
}

/**
 * 在线父子树有效策略门:目标子项的父级(唯一父媒体)与全 sibling 子轴一次集合装载
 * (禁逐集 N+1),判定经发布端口纯函数;父轴或目标子轴任一拒绝即整体拒绝。
 * 映射损坏/判定异常统一按「不可用」归一(调用方 404/503 同形),不泄露内部细节。
 */
export class VodTreePolicyGate implements PlaybackVodPolicyGatePort {
  constructor(private readonly db: SqliteReadHandle) {}

  evaluateOnlineTreePolicy(input: {
    readonly householdId: string;
    readonly profileId: string;
    readonly mediaId: string;
  }): { readonly policyAvailable: boolean; readonly allowed: boolean } {
    // 父轴:目标子项 → 线路 → 标题 → 唯一父媒体(映射缺失 = 目录损坏,按不可用拒绝)
    const parent = this.db
      .prepare(
        `SELECT mi.id AS mediaId, mi.type AS role, mi.content_level AS contentLevel
         FROM vod_episode ve
         JOIN vod_line vl ON vl.household_id = ve.household_id AND vl.id = ve.line_id
         JOIN vod_title vt ON vt.household_id = vl.household_id AND vt.id = vl.title_id
         JOIN media_item mi ON mi.household_id = vt.household_id AND mi.id = vt.parent_media_id
         WHERE ve.household_id = ? AND ve.media_id = ?`,
      )
      .get(input.householdId, input.mediaId) as CatalogMediaProjection | undefined;
    if (parent === undefined) {
      return { policyAvailable: false, allowed: false };
    }
    // 子轴:同标题全部子项媒体(一次集合查询;目标子项按 mediaId 对齐)
    const children = this.db
      .prepare(
        `SELECT c.id AS mediaId, c.type AS role, c.content_level AS contentLevel
         FROM media_item c
         WHERE c.household_id = ?
           AND c.id IN (
             SELECT sib.media_id FROM vod_episode sib
             JOIN vod_line vl ON vl.household_id = sib.household_id AND vl.id = sib.line_id
             JOIN vod_title vt ON vt.household_id = vl.household_id AND vt.id = vl.title_id
             WHERE vt.household_id = ? AND vt.parent_media_id = ?
           )`,
      )
      .all(input.householdId, input.householdId, parent.mediaId) as CatalogMediaProjection[];
    if (children.length === 0) {
      return { policyAvailable: false, allowed: false };
    }
    const policyRow = this.db
      .prepare(
        `SELECT max_content_level AS maxContentLevel, allow_unrated AS allowUnrated,
                allowed_media_ids AS allowedMediaIds, blocked_media_ids AS blockedMediaIds,
                allowed_channel_ids AS allowedChannelIds, version
         FROM profile_policy WHERE profile_id = ?`,
      )
      .get(input.profileId) as PolicyRowProjection | undefined;
    const judgment = toPolicyJudgment(policyRow);
    if (policyRow !== undefined && judgment === null) {
      // 策略行存在但损坏:503 fail-closed(与授权管线 POLICY_UNAVAILABLE 同义)
      return { policyAvailable: false, allowed: false };
    }
    const facts: ParentChildMediaFacts = {
      householdId: input.householdId,
      parent: {
        mediaId: parent.mediaId,
        role: parent.role as ParentChildMediaFacts['parent']['role'],
        contentLevel: parent.contentLevel,
        householdEnabled: true,
      },
      children: children.map((child) => ({
        mediaId: child.mediaId,
        role: child.role as ParentChildMediaFacts['children'][number]['role'],
        contentLevel: child.contentLevel,
        householdEnabled: true,
      })),
    };
    try {
      // 发布端口 = 领域纯函数提升(与 T029 装配同款:位置参数 (policy, facts))
      const decision = evaluateEffectiveMediaPolicy(judgment, facts);
      // 子项判定按输入顺序逐项对齐(PolicyDecision 无 mediaId;目标子项按数组下标取)
      const targetIndex = facts.children.findIndex((child) => child.mediaId === input.mediaId);
      const targetAllowed = targetIndex >= 0 ? (decision.children[targetIndex]?.allowed ?? false) : false;
      return { policyAvailable: true, allowed: decision.parent.allowed && targetAllowed };
    } catch {
      // 父子事实损坏(角色/等级/自环/重复):整组拒绝,不泄露判定轴
      return { policyAvailable: true, allowed: false };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 固定输入解析事实与 T042 store 桥                                        */
/* ------------------------------------------------------------------ */

/** 输入租约有界秒数(§6「租约必须可取消/有界」;内存 registry 持有,T045 回收/撤销接续) */
const VOD_INPUT_LEASE_SECONDS = 24 * 60 * 60;

/** 目录/来源解析事实投影(与 T042 CATALOG_REVISION_SELECT 同 JOIN 口径) */
interface ResolvedFactsRow {
  readonly contentRevision: number;
  readonly locatorRevision: number | null;
  readonly detailRevision: number | null;
  readonly continuityRevision: number | null;
  readonly contentVersionState: string | null;
  readonly evidenceDigest: string | null;
  readonly episodeKey: string | null;
  readonly lineKey: string | null;
  readonly titleId: string | null;
}

/** 私有载荷形状(interface/materialization.controller 落库口径;与 online-vod 同源) */
interface VodDetailPrivatePayload {
  readonly kind?: unknown;
  readonly lines?: readonly {
    readonly lineKey?: unknown;
    readonly episodes?: readonly {
      readonly episodeKey?: unknown;
      readonly locatorUrl?: unknown;
    }[];
  }[];
}

/**
 * 解析事实读取面(事务外;本地目录/来源投影,零网络):修订事实与 T042 重验 JOIN
 * 同口径,私有入口 locator 经 vod_detail_snapshot.validated_private_payload 提取 —
 * ⚠️ entryUrl 只进入 T042 store 内存 registry,绝不落库/打日志/进 DTO。
 */
export class VodResolvedFactsReader {
  constructor(private readonly db: SqliteReadHandle) {}

  async readResolvedInputFacts(householdId: string, mediaId: string, playbackSourceId: string): Promise<VodResolvedInputFacts> {
    const row = this.db
      .prepare(
        `SELECT mi.content_revision AS contentRevision,
                ms.locator_revision AS locatorRevision,
                vt.current_detail_revision AS detailRevision,
                ve.continuity_revision AS continuityRevision,
                ve.content_version_state AS contentVersionState,
                ve.evidence_digest AS evidenceDigest,
                ve.episode_key AS episodeKey,
                vl.line_key AS lineKey,
                vt.id AS titleId
         FROM media_item mi
         JOIN playback_source ps ON ps.household_id = mi.household_id AND ps.id = ?
         LEFT JOIN media_source ms ON ms.household_id = ps.household_id AND ms.id = ps.source_id
         LEFT JOIN vod_episode ve ON ve.household_id = mi.household_id AND ve.media_id = mi.id
         LEFT JOIN vod_line vl ON vl.household_id = ve.household_id AND vl.id = ve.line_id
         LEFT JOIN vod_title vt ON vt.household_id = vl.household_id AND vt.id = vl.title_id
         WHERE mi.household_id = ? AND mi.id = ?`,
      )
      .get(playbackSourceId, householdId, mediaId) as ResolvedFactsRow | undefined;
    if (row === undefined || row.locatorRevision === null || row.locatorRevision === undefined) {
      throw createDomainError('PLAYBACK_RESOURCE_UNAVAILABLE', '在线播放来源不可用,不能固定输入');
    }
    const entryUrl =
      row.titleId !== null && row.lineKey !== null && row.episodeKey !== null && row.detailRevision !== null
        ? this.readPrivateEntryLocator(householdId, row.titleId, row.detailRevision, row.lineKey, row.episodeKey)
        : null;
    if (entryUrl === null) {
      // 物化不完整(无当前快照/该集私有定位缺失):拒绝而非猜测地址(与 location.service 同语义)
      throw createDomainError('PLAYBACK_RESOURCE_UNAVAILABLE', '该集私有定位缺失,请重新物化后再播放');
    }
    return {
      entryUrl,
      locatorRevision: row.locatorRevision,
      detailRevision: row.detailRevision,
      contentRevision: row.contentRevision,
      continuityRevision: row.continuityRevision,
      evidenceState: row.contentVersionState === 'verified' ? 'verified' : 'unverified',
      evidenceDigest: row.evidenceDigest ?? '',
      leaseSeconds: VOD_INPUT_LEASE_SECONDS,
    };
  }

  /** 私有 locator 提取(kind 校验 + lineKey/episodeKey 精确匹配;缺失返回 null,不猜测) */
  private readPrivateEntryLocator(
    householdId: string,
    titleId: string,
    revision: number,
    lineKey: string,
    episodeKey: string,
  ): string | null {
    const snapshot = this.db
      .prepare(
        'SELECT validated_private_payload AS payload FROM vod_detail_snapshot WHERE household_id = ? AND title_id = ? AND revision = ?',
      )
      .get(householdId, titleId, revision) as { payload?: unknown } | undefined;
    if (snapshot === undefined || typeof snapshot.payload !== 'string') {
      return null;
    }
    let payload: VodDetailPrivatePayload;
    try {
      payload = JSON.parse(snapshot.payload) as VodDetailPrivatePayload;
    } catch {
      return null;
    }
    if (payload.kind !== 'vod-detail-private' || !Array.isArray(payload.lines)) {
      return null;
    }
    for (const line of payload.lines) {
      if (line.lineKey !== lineKey || !Array.isArray(line.episodes)) {
        continue;
      }
      for (const episode of line.episodes) {
        if (episode.episodeKey === episodeKey && typeof episode.locatorUrl === 'string' && episode.locatorUrl.length > 0) {
          return episode.locatorUrl;
        }
      }
    }
    return null;
  }
}

/**
 * T042 store ↔ resolver 端口桥:resolve 建档(幂等固定解析 + start_basis 绑定;
 * 同一 facts 闭包 —— 解析恰一次,代内重入不重读)与 ready 重验/修订失配终止的适配。
 */
export class ResolverVodInputBridge implements PlaybackResolverVodInputPort {
  constructor(
    private readonly store: VodInputStore,
    private readonly facts: VodResolvedFactsReader,
  ) {}

  async bindFixedInput(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly mediaId: string;
    readonly playbackSourceId: string;
    readonly sourceId: string;
    readonly startBasis: 'beginning' | 'target_history' | 'transition_carry';
  }): Promise<{ readonly bindingId: string }> {
    // 解析事实恰一次(同一闭包):resolveVodInput 幂等固定,bindFixedInput 确认最终 basis;
    // 首次插入落 frozen_start_seconds=NULL(直到 probe,data-model §6)
    const facts = await this.facts.readResolvedInputFacts(input.householdId, input.mediaId, input.playbackSourceId);
    const io = { resolveUpstream: async (): Promise<VodResolvedInputFacts> => facts };
    await this.store.resolveVodInput(
      { householdId: input.householdId, sessionId: input.sessionId, generation: input.generation, sourceId: input.sourceId },
      io,
    );
    return this.store.bindFixedInput(
      {
        householdId: input.householdId,
        sessionId: input.sessionId,
        generation: input.generation,
        sourceId: input.sourceId,
        startBasis: input.startBasis,
      },
      io,
    );
  }

  assertCurrent(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly expected: PlaybackVodInputRevisionExpectation;
  }): void {
    this.store.assertFixedInputCurrent({
      householdId: input.householdId,
      sessionId: input.sessionId,
      generation: input.generation,
      expected: input.expected,
    });
  }

  failOnRevisionMismatch(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly reason: string;
  }): void {
    // 撤交付 + failed 同提交(终态不可复活;data-model §3「准备转failed,需新resolve」);
    // 绑定清理标记随同提交,错误形态由调用方按稳定失败码收口
    this.store.failSessionOnRevisionMismatch({
      householdId: input.householdId,
      sessionId: input.sessionId,
      generation: input.generation,
      reason: input.reason,
    });
  }
}
