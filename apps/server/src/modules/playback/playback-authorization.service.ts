import { and, eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemCode } from '@hmp/shared';
import {
  account,
  device,
  deviceSession,
  mediaItem,
  mediaSource,
  playbackSource,
  profile,
  profilePolicy,
  sourceEntry,
} from '../../database/schema';
import { createDomainError, DomainError } from '../../common/domain-error';
import type { SessionContext } from '../../common/current-session.decorator';
import { getDb } from '../auth/db';
import { authorizeCurrentProfile, type AuthorizationReason } from '@contexts/policy/application/policy.service';
import { defaultPolicyValues } from '@contexts/policy/domain/policy.rules';
import type { MediaPolicyFacts } from '@contexts/policy/domain/policy.rules';
import { PlaybackRepository } from './playback.repository';
import type { PlaybackDelivery } from './playback.types';

/**
 * 播放内部授权管线(T017,spec 004)—— resolve/控制/提交前重验共用的单一信任源:
 *
 * 顺序(contracts/api.md 控制端点行):认证 → 当前档案/PIN → 最新策略 → 家庭可用资源。
 *
 * - 可信会话:以 device_session id 实时重读库内行,管线与 common/session.guard.ts 逐一
 *   对齐(token 哈希查找→未撤销→未过期→设备未撤销→account/device/activeProfile 归属一致;
 *   边界语义:恰好过期 = 已过期)。Guard 仍是令牌入口唯一权威(T031 @UseGuards);本服务
 *   做的是「授权时刻」的实时重验 —— 撤销/过期/换设备竞态不放行,revalidate 必须独立可用。
 *   身份事实(household/account/device/activeProfile)只从库内行派生:调用方传入的上下文
 *   仅用于定位会话行并做交叉校验,快照与库不符一律 401;公开 API 不接受任何请求体身份声明。
 * - 档案/PIN:activeProfile 必须存在、归属会话家庭+账号且 active(否则 403
 *   ACTIVE_PROFILE_REQUIRED,与 authorizeCurrentProfile 同判);PIN 档案「已解锁」证据 =
 *   会话激活事实(active_profile_id 仅能经 PIN 门 select 写入,授予已在 select 时消费)或
 *   未消费的解锁授予。绑定档案(播放会话/授权快照)≠ 当前激活档案 → 403 拒绝:绑定档案受
 *   PIN 保护复用 403 PROFILE_PIN_REQUIRED,否则 403 ACTIVE_PROFILE_REQUIRED(当前档案一致性
 *   优先,解锁授予不覆盖 —— spec:「当前档案与凭据绑定档案不一致而拒绝」)。
 * - 策略:委托 policy.service 的 authorizeCurrentProfile(唯一判定核心 evaluatePolicy),
 *   每次实时读最新策略,不缓存;拒绝映射见 policyDenialToError(策略拒绝统一 404 同形,
 *   不返回策略明细;策略缺失/损坏 503 fail-closed)。
 * - 家庭可用资源:候选只取「present 条目 × 启用父源 × 播放资源」(本服务直查 Drizzle 只读
 *   投影,join 链与 policy.batch-context 的可用性定义一致;不经 PlaybackRepository 新方法,
 *   保持其 T011 已钉死的 API 面不变);零候选(媒体无启用源/家庭级零可用资源)一律 404
 *   MEDIA_NOT_FOUND 同形 —— T037 裁决 ①:api.md「稳定错误」权威口径「404 MEDIA_NOT_FOUND
 *   (不存在/跨家庭/不可见/无源同形)」,resolve 路径不再使用 503
 *   PLAYBACK_RESOURCE_UNAVAILABLE(该码保留注册表,仅用于流时资源故障)。每候选取最低成本
 *   静态处理方式按 protocol 判定:file→direct,URL(hls/http)→hls_proxy(成本均 0;remux/transcode 属 probe 后
 *   的计划事实,不在授权期猜测),按 (成本, source_id, playback_source_id) 二进制升序。
 * - 候选/快照不携带源位置/URL/凭据;无任何 env/debug 旁路(禁止临时放开鉴权)。
 */

/** 授权候选(对外只暴露 id 与排序/处理方式事实;绝不含源位置) */
export interface PlaybackResourceCandidate {
  readonly playbackSourceId: string;
  readonly sourceId: string;
  /** 该候选当前静态事实下的最低成本处理方式(probe 后的实际计划归 T019/T024) */
  readonly delivery: PlaybackDelivery;
}

/** 授权快照:提交前重验(revalidate)据此核对「授权后是否发生变化」 */
export interface PlaybackAuthorizationSnapshot {
  readonly deviceSessionId: string;
  readonly deviceId: string;
  readonly householdId: string;
  readonly accountId: string;
  readonly profileId: string;
  readonly mediaId: string;
  /**
   * 授权时刻 DeviceSession 身份上下文版本(005 data-model §2):resolve 落库捕获,
   * 控制/交付链路每次与当前版本重验(不等即稳定拒绝,防止 A→B→A 复活旧上下文播放)。
   */
  readonly profileContextVersion: number;
  /** 授权时刻(UTC ISO-8601);仅作签发痕迹,重验语义以库内实时事实为准 */
  readonly authorizedAt: string;
}

/** 授权通过结果:candidates ≥ 1 且已按 data-model 排序(失败一律抛 DomainError) */
export interface PlaybackAuthorizationGrant {
  readonly snapshot: PlaybackAuthorizationSnapshot;
  readonly candidates: readonly PlaybackResourceCandidate[];
  /** 目标媒体类型(startMode 透传校验用:频道 resume → 400 PLAYBACK_SEEK_UNSUPPORTED) */
  readonly mediaType: MediaPolicyFacts['type'];
}

/** 控制授权选项(T051 上下文版本重验) */
export interface PlaybackControlOptions {
  /**
   * `'current'`(缺省):playback_session.profile_context_version 必须等于当前
   * DeviceSession 版本,不等即 404 PLAYBACK_NOT_FOUND 同形(旧上下文不可读/不可控);
   * `'any'`:跳过版本比对(仅限 stop 的「身份撤销后最小幂等清理」语义,api.md §5)。
   */
  readonly contextVersion?: 'current' | 'any';
}

/**
 * 按 playback_source.protocol 判定静态交付拓扑(2026-10-26 真实数据修正):
 * - `file`(NAS 本地文件)→ direct:经 nas-reader 根内安全定位后本地流式读取;
 * - 其余(hls/http 等 URL 形态)→ hls_proxy:统一经同源网关读取上游清单并重写,
 *   源地址永不下发客户端(ADR-0007);上游主机受 LAN_ALLOWED_TARGETS 逐跳许可约束。
 * 依据:003 refresh-publish 对 requires_proxy 硬编码 0(refresh-publish.service.ts:293),
 * 该标志不携带语义,不可作为交付拓扑依据。
 */
export function playbackDeliveryForProtocol(protocol: string): 'direct' | 'hls_proxy' {
  return protocol === 'file' ? ('direct' as const) : ('hls_proxy' as const);
}

/** data-model 交付成本:direct/hls_proxy=0、remux=1、audio_transcode=2、video_transcode=3 */
export function playbackDeliveryCost(delivery: PlaybackDelivery): 0 | 1 | 2 | 3 {
  switch (delivery) {
    case 'direct':
    case 'hls_proxy':
      return 0;
    case 'remux':
      return 1;
    case 'audio_transcode':
      return 2;
    case 'video_transcode':
      return 3;
  }
}

/** 字节序(二进制)字符串比较 —— data-model 的 source_id/playback_source_id 升序口径 */
function compareBinary(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** 候选排序:先交付成本,再 source_id 二进制升序,再 playback_source_id 二进制升序 */
export function comparePlaybackCandidates(a: PlaybackResourceCandidate, b: PlaybackResourceCandidate): number {
  const costDelta = playbackDeliveryCost(a.delivery) - playbackDeliveryCost(b.delivery);
  if (costDelta !== 0) {
    return costDelta;
  }
  const sourceDelta = compareBinary(a.sourceId, b.sourceId);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }
  return compareBinary(a.playbackSourceId, b.playbackSourceId);
}

function sessionInvalid(): DomainError {
  return new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
}

function activeProfileRequired(): DomainError {
  return new DomainError(403, ProblemCode.ACTIVE_PROFILE_REQUIRED, '请先选择当前观看档案');
}

/**
 * 策略/可见性拒绝 → 稳定错误(集中映射,不返回策略明细):
 * - POLICY_UNAVAILABLE(缺失/损坏,fail-closed)→ 503 既有码;
 * - ACTIVE_PROFILE_REQUIRED(管线间隙内会话/档案失效的防御分支)→ 403 既有码;
 * - RESOURCE_UNAVAILABLE(库内无行/跨家庭)与其余策略拒绝(超龄/黑名单/未评级/名单外)
 *   一律 404 MEDIA_NOT_FOUND 同形(api.md:不存在/跨家庭/不可见/无源同形)。
 */
function policyDenialToError(reason: AuthorizationReason): DomainError {
  if (reason === 'POLICY_UNAVAILABLE') {
    return new DomainError(503, ProblemCode.POLICY_UNAVAILABLE, '策略缺失或损坏,已拒绝访问');
  }
  if (reason === 'ACTIVE_PROFILE_REQUIRED') {
    return activeProfileRequired();
  }
  return createDomainError('MEDIA_NOT_FOUND');
}

/** 自联查询投影(id 键控,与 SessionGuard 的 token 键控同管线同字段口径) */
interface TrustedSessionRow {
  sessionId: string;
  sessionHouseholdId: string;
  sessionAccountId: string;
  sessionDeviceId: string;
  activeProfileId: string | null;
  sessionExpiresAt: string;
  sessionRevokedAt: string | null;
  accountUsername: string;
  accountRole: string;
  accountHouseholdId: string;
  deviceRevokedAt: string | null;
  profileHouseholdId: string | null;
  profileAccountId: string | null;
  /** 当前身份上下文版本(005 data-model §2;授权快照捕获与控制链路重验的唯一事实源) */
  profileContextVersion: number;
}

function loadTrustedSessionRow(sessionId: string): TrustedSessionRow | undefined {
  return getDb()
    .select({
      sessionId: deviceSession.id,
      sessionHouseholdId: deviceSession.householdId,
      sessionAccountId: deviceSession.accountId,
      sessionDeviceId: deviceSession.deviceId,
      activeProfileId: deviceSession.activeProfileId,
      sessionExpiresAt: deviceSession.expiresAt,
      sessionRevokedAt: deviceSession.revokedAt,
      accountUsername: account.username,
      accountRole: account.role,
      accountHouseholdId: account.householdId,
      deviceRevokedAt: device.revokedAt,
      profileHouseholdId: profile.householdId,
      profileAccountId: profile.accountId,
      profileContextVersion: deviceSession.profileContextVersion,
    })
    .from(deviceSession)
    .innerJoin(account, eq(account.id, deviceSession.accountId))
    .innerJoin(device, eq(device.id, deviceSession.deviceId))
    .leftJoin(profile, eq(profile.id, deviceSession.activeProfileId))
    .where(eq(deviceSession.id, sessionId))
    .get();
}

function rowToSessionContext(row: TrustedSessionRow): SessionContext {
  return {
    session: {
      id: row.sessionId,
      householdId: row.sessionHouseholdId,
      accountId: row.sessionAccountId,
      deviceId: row.sessionDeviceId,
      activeProfileId: row.activeProfileId,
      expiresAt: row.sessionExpiresAt,
    },
    account: {
      id: row.sessionAccountId,
      householdId: row.accountHouseholdId,
      username: row.accountUsername,
      role: row.accountRole as SessionContext['account']['role'],
    },
  };
}

function buildGrant(
  trusted: SessionContext,
  profileId: string,
  mediaId: string,
  candidates: PlaybackResourceCandidate[],
  mediaType: MediaPolicyFacts['type'],
  profileContextVersion: number,
): PlaybackAuthorizationGrant {
  return {
    snapshot: {
      deviceSessionId: trusted.session.id,
      deviceId: trusted.session.deviceId,
      householdId: trusted.session.householdId,
      accountId: trusted.session.accountId,
      profileId,
      mediaId,
      profileContextVersion,
      authorizedAt: new Date().toISOString(),
    },
    candidates,
    mediaType,
  };
}

@Injectable()
export class PlaybackAuthorizationService {
  // 显式 token:契约测试管线(vitest/esbuild)不产出 design:paramtypes 元数据,
  // 类 provider 的依赖解析必须自带 @Inject(行为与生产 tsc 装配完全一致)
  constructor(@Inject(PlaybackRepository) private readonly repository: PlaybackRepository) {}

  /**
   * resolve 授权(认证→档案/PIN→策略→家庭可用资源;同步完成,不等待 probe)。
   * 通过返回授权与排序候选(快照携带授权时刻 profileContextVersion,resolve 落库捕获);
   * 任一环节失败抛稳定 DomainError,调用方不得创建播放会话。
   */
  async authorizeResolve(context: SessionContext, mediaId: string): Promise<PlaybackAuthorizationGrant> {
    const trusted = this.verifyTrustedSession(context.session.id, context);
    const activeProfile = this.requireActiveProfileRow(trusted);
    const { candidates, mediaType } = await this.authorizeMediaAndCollectCandidates(trusted, mediaId);
    return buildGrant(
      trusted,
      activeProfile.id,
      mediaId,
      candidates,
      mediaType,
      this.currentContextVersion(trusted.session.id),
    );
  }

  /**
   * 控制授权(renew/seek/selection/GET 状态/heartbeat/媒体交付的共用底层):在 resolve 链
   * 之前先核对播放会话归属 —— 非本设备会话(含跨家庭/不存在)统一 404 PLAYBACK_NOT_FOUND;
   * 绑定档案必须仍是当前激活档案(否则 403,绑定 PIN 档案复用 PROFILE_PIN_REQUIRED);
   * 上下文版本重验(T051,005 api.md §5):playback_session.profile_context_version 必须
   * 等于当前 DeviceSession 版本 —— 不等即 404 同形(旧上下文在换档/登出/撤销后不可读、
   * 不可控、不可交付;stop 经 options 传入 'any' 保留最小幂等清理语义)。
   */
  async authorizeControl(
    context: SessionContext,
    playbackSessionId: string,
    options: PlaybackControlOptions = {},
  ): Promise<PlaybackAuthorizationGrant> {
    const trusted = this.verifyTrustedSession(context.session.id, context);
    const loaded = this.repository.getSession(trusted.session.householdId, playbackSessionId);
    if (!loaded.ok || loaded.value.deviceSessionId !== trusted.session.id) {
      // 跨设备/跨家庭/不存在同形 404,不泄露存在性(contracts/api.md)
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
    if ((options.contextVersion ?? 'current') === 'current') {
      this.assertContextVersionCurrent(loaded.value, trusted);
    }
    const activeProfile = this.requireActiveProfileRow(trusted);
    this.assertBoundProfileCurrent(loaded.value.profileId, trusted, activeProfile);
    const { candidates, mediaType } = await this.authorizeMediaAndCollectCandidates(trusted, loaded.value.mediaId);
    return buildGrant(
      trusted,
      activeProfile.id,
      loaded.value.mediaId,
      candidates,
      mediaType,
      this.currentContextVersion(trusted.session.id),
    );
  }

  /**
   * 提交前重验(api.md:renew/seek/selection 最终提交前重验授权,防异步探测窗口变更)。
   * (deviceSessionId, profileId, mediaId) 为授权快照事实:会话/档案/PIN/策略/资源全部
   * 按当前库内状态重跑,任一变化即以对应稳定码拒绝;通过返回全新候选(不缓存授权正结果)。
   * 预期上下文版本(005 §5)由调用方在 authorizeControl/异步准备复查承担 —— 本方法只重验
   * 「当前会话与档案/策略/资源授权链」,不重复做 playback 行归属判定。
   */
  async revalidate(deviceSessionId: string, profileId: string, mediaId: string): Promise<PlaybackAuthorizationGrant> {
    const trusted = this.verifyTrustedSession(deviceSessionId);
    if (profileId.length === 0) {
      throw activeProfileRequired();
    }
    const activeProfile = this.requireActiveProfileRow(trusted);
    this.assertBoundProfileCurrent(profileId, trusted, activeProfile);
    const { candidates, mediaType } = await this.authorizeMediaAndCollectCandidates(trusted, mediaId);
    return buildGrant(
      trusted,
      activeProfile.id,
      mediaId,
      candidates,
      mediaType,
      this.currentContextVersion(trusted.session.id),
    );
  }

  // -------------------------------------------------------------------------
  // 内部管线(顺序固定,勿调换:会话 → 档案 → 策略 → 资源)
  // -------------------------------------------------------------------------

  /** 设备会话当前身份上下文版本(库内实时事实;行缺失按未认证同形拒绝) */
  private currentContextVersion(sessionId: string): number {
    const row = getDb()
      .select({ profileContextVersion: deviceSession.profileContextVersion })
      .from(deviceSession)
      .where(eq(deviceSession.id, sessionId))
      .get();
    if (row === undefined) {
      throw sessionInvalid();
    }
    return row.profileContextVersion;
  }

  /**
   * 上下文版本一致性(T051,005 api.md §5「每次控制、renew、交付…必须等于当前
   * DeviceSession 版本」):不等即 404 PLAYBACK_NOT_FOUND 同形 —— 与「不存在」对客户端
   * 不可区分,不泄露旧上下文存在性(A→B→A 后绑定档案可能再次匹配,版本是唯一拒绝依据)。
   */
  private assertContextVersionCurrent(session: { readonly profileContextVersion: number }, trusted: SessionContext): void {
    if (session.profileContextVersion !== this.currentContextVersion(trusted.session.id)) {
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
  }

  /**
   * 可信会话实时重验(SessionGuard 管线的 id 键控等价形):
   * 行存在 → 未撤销 → 未过期(恰好过期=已过期)→ 设备未撤销 → 归属一致
   * (account/device 与会话同家庭;activeProfile 与会话同家庭同账号)。
   * 提供调用方上下文时,其 household/account/device 必须与库内行一致(快照漂移/伪造 → 401);
   * activeProfileId 快照不参与比较 —— 库内行才是唯一事实。
   */
  private verifyTrustedSession(sessionId: string, context?: SessionContext): SessionContext {
    const row = loadTrustedSessionRow(sessionId);
    if (row === undefined || row.sessionRevokedAt !== null || !(Date.parse(row.sessionExpiresAt) > Date.now())) {
      throw sessionInvalid();
    }
    if (row.deviceRevokedAt !== null) {
      throw sessionInvalid();
    }
    const profileConsistent =
      row.activeProfileId === null ||
      (row.profileHouseholdId === row.sessionHouseholdId && row.profileAccountId === row.sessionAccountId);
    if (!profileConsistent || row.accountHouseholdId !== row.sessionHouseholdId) {
      throw sessionInvalid();
    }
    const trusted = rowToSessionContext(row);
    if (
      context !== undefined &&
      (context.session.householdId !== trusted.session.householdId ||
        context.session.accountId !== trusted.session.accountId ||
        context.session.deviceId !== trusted.session.deviceId)
    ) {
      throw sessionInvalid();
    }
    return trusted;
  }

  /** 当前观看者链:必须存在、归属会话家庭+账号且 active(运行中停用/删除/伪造 → 403) */
  private requireActiveProfileRow(trusted: SessionContext): typeof profile.$inferSelect {
    const activeProfileId = trusted.session.activeProfileId;
    if (activeProfileId === null) {
      throw activeProfileRequired();
    }
    const row = getDb().select().from(profile).where(eq(profile.id, activeProfileId)).get();
    if (
      row === undefined ||
      row.householdId !== trusted.session.householdId ||
      row.accountId !== trusted.session.accountId ||
      row.status !== 'active'
    ) {
      throw activeProfileRequired();
    }
    return row;
  }

  /**
   * 绑定档案一致性(控制/重验路径):绑定档案 ≠ 当前激活档案 → 403。
   * 绑定档案受 PIN 保护时复用 403 PROFILE_PIN_REQUIRED(「PIN 既有错误」槽位);
   * 解锁授予不覆盖该判定 —— 当前档案一致性优先于任何授予(spec:档案与凭据绑定档案
   * 不一致即拒绝)。
   */
  private assertBoundProfileCurrent(
    boundProfileId: string,
    trusted: SessionContext,
    activeProfile: typeof profile.$inferSelect,
  ): void {
    if (boundProfileId === activeProfile.id) {
      return;
    }
    const bound = getDb()
      .select()
      .from(profile)
      .where(and(eq(profile.householdId, trusted.session.householdId), eq(profile.id, boundProfileId)))
      .get();
    if (bound !== undefined && bound.pinHash !== null) {
      throw new DomainError(403, ProblemCode.PROFILE_PIN_REQUIRED, '该 Profile 受 PIN 保护,请先解锁');
    }
    throw activeProfileRequired();
  }

  /** 策略链(委托 authorizeCurrentProfile,实时最新策略)+ 资源候选收集(503/404 分形) */
  private async authorizeMediaAndCollectCandidates(
    trusted: SessionContext,
    mediaId: string,
  ): Promise<{ candidates: PlaybackResourceCandidate[]; mediaType: MediaPolicyFacts['type'] }> {
    // 缺失策略行的惰性默认回填(FR-002:默认值用于创建与回填;经真实创建路径的档案
    // 必有默认策略行,直落库/恢复场景的首欢授权补齐同一默认)——回填后走同一判定链;
    // 已存在(含损坏)行不触碰:损坏行仍由判定核心按 POLICY_UNAVAILABLE fail-closed。
    this.backfillDefaultPolicyRow(trusted);
    const decision = await authorizeCurrentProfile(trusted, mediaId, (householdId, mediaIdToRead) =>
      this.readTrustedMediaFacts(householdId, mediaIdToRead),
    );
    if (!decision.allowed) {
      throw policyDenialToError(decision.reason);
    }
    const mediaType = this.readTrustedMediaType(trusted.session.householdId, mediaId);
    return { candidates: this.collectCandidates(trusted.session.householdId, mediaId), mediaType };
  }

  /** 目标媒体类型(授权已放行后的读取;仅用于 startMode 透传校验,不下发客户端) */
  private readTrustedMediaType(householdId: string, mediaId: string): MediaPolicyFacts['type'] {
    const row = getDb()
      .select({ type: mediaItem.type })
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
    if (row === undefined) {
      // 授权已放行后理论上不可达;防御性归一 MEDIA_NOT_FOUND 同形
      throw createDomainError('MEDIA_NOT_FOUND');
    }
    return row.type as MediaPolicyFacts['type'];
  }

  /**
   * 缺失策略行的默认回填(幂等;并发插入经 onConflictDoNothing 收敛,不覆盖既有行):
   * 仅当该档案确无策略行时按 defaultPolicyValues(档案类型)补种默认行 —— 与
   * createProfile 的默认策略同源同值,使「直落库/迁移恢复」的档案与正常创建路径在
   * 授权时刻具备一致的 FR-002 基线。回填失败(竞态/约束)静默放行,交由判定链裁决。
   */
  private backfillDefaultPolicyRow(trusted: SessionContext): void {
    const activeProfileId = trusted.session.activeProfileId;
    if (activeProfileId === null) {
      return; // 无当前档案:authorizeCurrentProfile 统一 403,不回填
    }
    const existing = getDb()
      .select({ profileId: profilePolicy.profileId })
      .from(profilePolicy)
      .where(eq(profilePolicy.profileId, activeProfileId))
      .get();
    if (existing !== undefined) {
      return; // 已有行(含损坏行):不触碰,fail-closed 语义由判定核心承担
    }
    const row = getDb().select().from(profile).where(eq(profile.id, activeProfileId)).get();
    if (row === undefined) {
      return;
    }
    const defaults = defaultPolicyValues(row.type as 'adult' | 'child');
    try {
      getDb()
        .insert(profilePolicy)
        .values({
          householdId: trusted.session.householdId,
          profileId: activeProfileId,
          maxContentLevel: defaults.maxContentLevel,
          allowUnrated: defaults.allowUnrated ? 1 : 0,
          allowedMediaIds: '[]',
          blockedMediaIds: '[]',
          allowedChannelIds: '[]',
          version: 1,
          updatedAt: new Date().toISOString(),
        })
        .onConflictDoNothing()
        .run();
    } catch {
      // 竞态下另一请求已回填/约束拒绝:交由随后的判定链以库内事实裁决
    }
  }

  /**
   * 可信资源事实读取器:仅以会话家庭为查询键;库内无行/跨家庭 → null(与不存在统一不可
   * 区分,由判定核心归一 RESOURCE_UNAVAILABLE)。householdEnabled 恒为 true:资源可用性
   * 由资源阶段以「无源同形 404」判定(T037 裁决 ①),不折叠进策略事实 —— 策略拒绝(404)
   * 与零可用资源(404 同形)对客户端不可区分,不互相掩盖也不泄露家庭资源面。
   */
  private readTrustedMediaFacts(householdId: string, mediaId: string): MediaPolicyFacts | null {
    const row = getDb()
      .select()
      .from(mediaItem)
      .where(and(eq(mediaItem.householdId, householdId), eq(mediaItem.id, mediaId)))
      .get();
    if (row === undefined) {
      return null;
    }
    const type = row.type as MediaPolicyFacts['type'];
    return {
      householdId: row.householdId,
      mediaId: row.id,
      type,
      channelId: type === 'channel' ? row.id : null,
      contentLevel: row.contentLevel,
      householdEnabled: true,
    };
  }

  /**
   * 家庭可用资源链:候选 = 家庭内「present 条目 × 启用父源 × 播放资源」只读投影。
   * 零候选 → 404 MEDIA_NOT_FOUND 同形(T037 裁决 ①:api.md「稳定错误」权威口径
   * 「404 MEDIA_NOT_FOUND(不存在/跨家庭/不可见/无源同形)」—— 家庭级零可用资源与媒体级
   * 无启用源对客户端同形,不泄露家庭资源面;503 PLAYBACK_RESOURCE_UNAVAILABLE 保留注册表,
   * 仅用于流时资源故障,resolve/控制授权路径不再使用)。
   * 每候选最低成本静态处理方式(2026-10-26 真实数据修正):**按 protocol 判定交付拓扑**——
   * `file`(NAS 本地文件)→ direct(nas-reader 管线);其余(hls/http 等 URL 形态)→ hls_proxy
   * (统一走同源网关读取+重写,ADR-0007「源地址不下发客户端」)。原因:003 refresh-publish
   * 对 requires_proxy 硬编码 0(refresh-publish.service.ts:293),该标志不携带语义;旧映射
   * `requires_proxy→hls_proxy,否则 direct` 会把真实库全部 URL 源错配 direct(NAS 文件管线),
   * 探测定位必然失败 → 会话 failed:PLAYBACK_RESOURCE_UNAVAILABLE。两者成本均 0;
   * 按 (成本, source_id, playback_source_id) 二进制升序输出。
   */
  private collectCandidates(householdId: string, mediaId: string): PlaybackResourceCandidate[] {
    const rows = this.listEnabledPlaybackResources(householdId, mediaId);
    if (rows.length === 0) {
      // 无源同形 404(行为修正:T037 裁决 ①,原家庭级零资源分支的 503 归一为 404)
      throw createDomainError('MEDIA_NOT_FOUND');
    }
    return rows
      .map((row) => ({
        playbackSourceId: row.playbackSourceId,
        sourceId: row.sourceId,
        delivery: playbackDeliveryForProtocol(row.protocol),
      }))
      .sort(comparePlaybackCandidates);
  }

  /**
   * 只读:家庭内某媒体的「已启用可用」播放资源候选行(直查 Drizzle,不经仓储新方法,
   * 保持 PlaybackRepository 的 T011 API 面不变)。join 链与谓词对齐 policy.batch-context
   * 的可用性定义:present 条目 × 启用父源 × 播放资源记录,且 media_item_id 与条目 media_id
   * 指向同一媒体。投影刻意排除 location/mime 等私有字段 —— 授权结果只携带 id 与排序事实。
   */
  private listEnabledPlaybackResources(householdId: string, mediaId: string) {
    const rows = getDb()
      .select({
        playbackSourceId: playbackSource.id,
        sourceId: playbackSource.sourceId,
        protocol: playbackSource.protocol,
      })
      .from(playbackSource)
      .innerJoin(
        mediaSource,
        and(eq(mediaSource.householdId, playbackSource.householdId), eq(mediaSource.id, playbackSource.sourceId)),
      )
      .innerJoin(
        sourceEntry,
        and(eq(sourceEntry.householdId, playbackSource.householdId), eq(sourceEntry.id, playbackSource.sourceEntryId)),
      )
      .where(
        and(
          eq(playbackSource.householdId, householdId),
          eq(playbackSource.mediaItemId, mediaId),
          eq(sourceEntry.mediaId, mediaId),
          eq(mediaSource.enabled, 1),
          eq(sourceEntry.present, 1),
        ),
      )
      .all();
    return rows;
  }
}