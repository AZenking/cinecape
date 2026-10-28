import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { cleanupRigs, startFreshApp, type TestRig } from '../../helpers';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackSourceRef,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { Database } from '../../../src/database/database';
import { getConfig } from '../../../src/config/env';
import { createPlaybackBudgets } from '../../../src/config/playback-budgets';
import { getDb } from '../../../src/modules/auth/db';
import { hashToken } from '../../../src/modules/auth/token.service';
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
} from '../../../src/database/schema';
import { DomainError } from '../../../src/common/domain-error';
import type { SessionContext } from '../../../src/common/current-session.decorator';
import { PlaybackRepository } from '../../../src/modules/playback/playback.repository';
import {
  PlaybackAuthorizationService,
  comparePlaybackCandidates,
  playbackDeliveryCost,
  type PlaybackResourceCandidate,
} from '../../../src/modules/playback/playback-authorization.service';
import { createProfile } from '@contexts/profile/application/profile.service';
import { writePolicyLists } from '@contexts/policy/application/policy.service';
import {
  consumeUnlockGrant,
  grantUnlock,
  hasUnlockGrant,
  unlockProfilePin,
} from '@contexts/profile/application/pin.service';

/**
 * 播放内部授权管线单元测试(T017,spec 004;playback-authorization.service.ts 的被测底层)。
 *
 * 权威依据(docs/specs/004-playback-resolver):
 * - tasks.md T017:SessionGuard 可信会话、实时设备/档案/PIN、authorizeCurrentProfile、
 *   家庭可用资源;异步后提交前重验;禁止临时放开鉴权;
 * - contracts/api.md 控制端点行:认证→当前档案/PIN→最新策略/家庭可用资源;
 *   renew/seek/selection 最终提交前重验;解析控制不等待 probe;
 *   「稳定错误」:401 SESSION_INVALID;403 ACTIVE_PROFILE_REQUIRED 或 PIN 既有错误;
 *   404 MEDIA_NOT_FOUND(不存在/跨家庭/不可见/无源同形,策略拒绝不返回明细;家庭级零可用
 *   资源亦归一 404 同形 —— T037 裁决 ① 行为修正,resolve/控制授权路径不再使用 503)。
 * - data-model.md「资源选择与模型权威性」:候选只取最新家庭内已启用可用资源;
 *   每候选最低成本处理方式,按 (direct或hls_proxy=0, remux=1, audio_transcode=2,
 *   video_transcode=3)、source_id 二进制升序、playback_source_id 二进制升序。
 *
 * 信任源约定(用例显式断言):
 * - 身份事实(deviceId/profileId/householdId)只从 device_session 及其关联行实时读取;
 *   服务公开 API 不接受任何请求体身份声明,上下文快照与库不符 → 401;
 * - PIN 档案「已解锁」证据 = 会话激活事实(active_profile_id 仅能经 PIN 门 select 写入)
 *   或未消费的解锁授予(既有 pin.service 语义);select 已消费授予,故激活后播放不要求二次授予;
 * - 绑定档案(既有播放会话/授权快照)≠ 当前激活档案 → 403 拒绝;绑定档案受 PIN 保护时
 *   复用 403 PROFILE_PIN_REQUIRED;
 * - 全部拒绝走 DomainError 稳定码,服务不含任何 env/debug 旁路。
 *
 * 夹具:startFreshApp 全量迁移库 + seedPlaybackWorld(注意:夹具直接落库的 profile 无
 * profile_policy 行 —— 运行时缺失策略默认拒绝;涉及策略放行的用例先按真实创建路径
 * (createProfile)或直接补种默认策略行,再激活)。
 */

/* ------------------------------------------------------------------ */
/* 装配助手                                                            */
/* ------------------------------------------------------------------ */

/** 直接构造被测服务(与 repository.spec 同款:纯 DB rig,不经 Nest 容器) */
function buildService(): PlaybackAuthorizationService {
  return new PlaybackAuthorizationService(
    new PlaybackRepository(Database.db, createPlaybackBudgets(getConfig())),
  );
}

/** 从库内实时行构造会话上下文(与 SessionGuard 校验后的 @CurrentSession 同形) */
function trustedContextOf(world: PlaybackWorld): SessionContext {
  const session = getDb().select().from(deviceSession).where(eq(deviceSession.id, world.deviceSessionId)).get();
  if (session === undefined) {
    throw new Error('夹具错误:device_session 不存在');
  }
  const acc = getDb().select().from(account).where(eq(account.id, world.accountId)).get();
  if (acc === undefined) {
    throw new Error('夹具错误:account 不存在');
  }
  return {
    session: {
      id: session.id,
      householdId: session.householdId,
      accountId: session.accountId,
      deviceId: session.deviceId,
      activeProfileId: session.activeProfileId,
      expiresAt: session.expiresAt,
    },
    account: {
      id: acc.id,
      householdId: acc.householdId,
      username: acc.username,
      role: acc.role as SessionContext['account']['role'],
    },
  };
}

/** 预期 DomainError:断言 status + 稳定码(异步拒绝统一走此助手) */
async function expectDomainError(promise: Promise<unknown>, status: number, code: ProblemCode): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `预期 DomainError(${status} ${code})`).toBeInstanceOf(DomainError);
  const domain = thrown as DomainError;
  expect(domain.status, code).toBe(status);
  expect(domain.code, code).toBe(code);
}

/** 经真实创建路径(profile+默认策略同事务)新建档案并激活为会话当前观看者 */
function createAndActivateProfile(world: PlaybackWorld, type: 'adult' | 'child'): string {
  const created = createProfile({
    householdId: world.householdId,
    accountId: world.accountId,
    name: type === 'child' ? '儿童档案' : '成人档案',
    type,
    isDefault: false,
  });
  getDb().update(deviceSession).set({ activeProfileId: created.id }).where(eq(deviceSession.id, world.deviceSessionId)).run();
  return created.id;
}

/** 为夹具直插的档案补种默认策略行(成人 18/true,空名单;夹具不经 createProfile 故无行) */
function seedDefaultPolicyRow(householdId: string, profileId: string): void {
  getDb()
    .insert(profilePolicy)
    .values({
      householdId,
      profileId,
      maxContentLevel: 18,
      allowUnrated: 1,
      allowedMediaIds: '[]',
      blockedMediaIds: '[]',
      allowedChannelIds: '[]',
      version: 1,
      updatedAt: PLAYBACK_FIXTURE_NOW,
    })
    .run();
}

/** 激活夹具档案(并补种默认策略行),返回该档案 id */
function activateFixtureProfile(world: PlaybackWorld, profileId: string): string {
  seedDefaultPolicyRow(world.householdId, profileId);
  getDb().update(deviceSession).set({ activeProfileId: profileId }).where(eq(deviceSession.id, world.deviceSessionId)).run();
  return profileId;
}

/**
 * 在既有启用源上为既有媒体追加一条播放资源(多候选/协议变体用):
 * 追加 source_entry(present=1)+ playback_source;返回新资源句柄。
 */
function attachExtraResource(
  world: PlaybackWorld,
  mediaId: string,
  via: PlaybackSourceRef,
  opts: { protocol: string; requiresProxy: 0 | 1 },
): PlaybackSourceRef {
  const entryId = randomUUID();
  const playbackSourceId = randomUUID();
  const now = PLAYBACK_FIXTURE_NOW;
  getDb()
    .insert(sourceEntry)
    .values({
      id: entryId,
      householdId: world.householdId,
      sourceId: via.sourceId,
      identityKind: 'url',
      identityDigest: hashToken(`extra-entry:${entryId}`),
      mediaId,
      present: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();
  getDb()
    .insert(playbackSource)
    .values({
      id: playbackSourceId,
      householdId: world.householdId,
      sourceId: via.sourceId,
      sourceEntryId: entryId,
      mediaItemId: mediaId,
      protocol: opts.protocol,
      location: `https://playback-fixture.test/extra/${playbackSourceId}`,
      mimeType: 'video/mp4',
      priority: 100,
      requiresProxy: opts.requiresProxy,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { sourceId: via.sourceId, entryId, mediaId, playbackSourceId };
}

/** 在指定源上种一条新媒体(媒体+条目+播放资源三元组;contentLevel 可控) */
function seedMediaOnSource(
  world: PlaybackWorld,
  via: PlaybackSourceRef,
  opts: { contentLevel: number | null; type?: 'channel' | 'movie'; protocol?: string; requiresProxy?: 0 | 1 },
): PlaybackSourceRef {
  const mediaId = randomUUID();
  const entryId = randomUUID();
  const playbackSourceId = randomUUID();
  const now = PLAYBACK_FIXTURE_NOW;
  getDb()
    .insert(mediaItem)
    .values({
      id: mediaId,
      householdId: world.householdId,
      type: opts.type ?? 'movie',
      title: `扩展媒体-${mediaId.slice(0, 8)}`,
      contentLevel: opts.contentLevel,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getDb()
    .insert(sourceEntry)
    .values({
      id: entryId,
      householdId: world.householdId,
      sourceId: via.sourceId,
      identityKind: 'url',
      identityDigest: hashToken(`media:${mediaId}`),
      mediaId,
      present: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .run();
  getDb()
    .insert(playbackSource)
    .values({
      id: playbackSourceId,
      householdId: world.householdId,
      sourceId: via.sourceId,
      sourceEntryId: entryId,
      mediaItemId: mediaId,
      protocol: opts.protocol ?? 'http',
      location: `https://playback-fixture.test/media/${mediaId}`,
      mimeType: 'video/mp4',
      priority: 100,
      requiresProxy: opts.requiresProxy ?? 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return { sourceId: via.sourceId, entryId, mediaId, playbackSourceId };
}

/** 同库第二家庭(跨家庭负向用;username 必须不同,登录名按 usernameNormalized 全局唯一) */
async function seedOtherHousehold(rig: TestRig, tag: string): Promise<PlaybackWorld> {
  return seedPlaybackWorld(rig, { householdName: `${tag}-乙家庭`, username: `player-b-${tag}` });
}

afterEach(async () => {
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* 1. 可信会话链(SessionGuard 等价实时重验;不信任请求体身份事实)      */
/* ------------------------------------------------------------------ */

describe('可信会话链(SessionGuard 等价;身份事实只从会话与库取)', () => {
  it('有效设备会话+激活档案+可见媒体 → authorizeResolve 通过,快照绑定库内真实身份', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-ok-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileId);
    const grant = await buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.snapshot.deviceSessionId).toBe(world.deviceSessionId);
    expect(grant.snapshot.deviceId).toBe(world.deviceId);
    expect(grant.snapshot.householdId).toBe(world.householdId);
    expect(grant.snapshot.accountId).toBe(world.accountId);
    expect(grant.snapshot.profileId).toBe(world.profileId);
    expect(grant.snapshot.mediaId).toBe(world.iptv.mediaId);
    expect(grant.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('过期会话 → 401 SESSION_INVALID(边界语义与 SessionGuard 一致:恰好过期=已过期)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-exp-' });
    const world = await seedPlaybackWorld(rig, { sessionExpiresAt: '2026-01-01T00:00:00.000Z' });
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });

  it('撤销会话(revoked_at 非空) → 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-rev-' });
    const world = await seedPlaybackWorld(rig);
    getDb().update(deviceSession).set({ revokedAt: PLAYBACK_FIXTURE_NOW }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });

  it('撤销设备(device.revoked_at 非空) → 401 SESSION_INVALID(实时设备事实)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-dev-' });
    const world = await seedPlaybackWorld(rig);
    getDb().update(device).set({ revokedAt: PLAYBACK_FIXTURE_NOW }).where(eq(device.id, world.deviceId)).run();
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });

  it('会话行不存在 → 401 SESSION_INVALID(与失败原因无差别)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-miss-' });
    const world = await seedPlaybackWorld(rig);
    const context = trustedContextOf(world);
    const forged: SessionContext = { ...context, session: { ...context.session, id: randomUUID() } };
    await expectDomainError(buildService().authorizeResolve(forged, world.iptv.mediaId), 401, ProblemCode.SESSION_INVALID);
  });

  it('上下文快照被篡改(householdId/deviceId 与库不符) → 401 SESSION_INVALID(伪造身份声明无效)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-tamper-' });
    const world = await seedPlaybackWorld(rig);
    const context = trustedContextOf(world);
    const service = buildService();
    const forgedHousehold: SessionContext = {
      ...context,
      session: { ...context.session, householdId: randomUUID() },
    };
    await expectDomainError(service.authorizeResolve(forgedHousehold, world.iptv.mediaId), 401, ProblemCode.SESSION_INVALID);
    const forgedDevice: SessionContext = { ...context, session: { ...context.session, deviceId: randomUUID() } };
    await expectDomainError(service.authorizeResolve(forgedDevice, world.iptv.mediaId), 401, ProblemCode.SESSION_INVALID);
    // 跨家庭媒体 ID 同样无效:授权按会话家庭查询,乙家庭媒体统一 404
    const other = await seedOtherHousehold(rig, 'xhh');
    activateFixtureProfile(other, other.profileId);
    await expectDomainError(
      service.authorizeResolve(trustedContextOf(other), world.iptv.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. 档案链(激活/PIN)                                                */
/* ------------------------------------------------------------------ */

describe('档案链(激活档案/PIN 既有语义)', () => {
  it('无激活档案(active_profile_id 为空) → 403 ACTIVE_PROFILE_REQUIRED(不回落默认档案)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-noprof-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileId);
    getDb().update(deviceSession).set({ activeProfileId: null }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
  });

  it('激活档案运行中被停用(status=disabled) → 403 ACTIVE_PROFILE_REQUIRED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-dis-' });
    const world = await seedPlaybackWorld(rig);
    const profileId = createAndActivateProfile(world, 'adult');
    getDb().update(profile).set({ status: 'disabled' }).where(eq(profile.id, profileId)).run();
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
  });

  it('绑定档案行不存在(revalidate 伪造/已删除 profileId) → 403 ACTIVE_PROFILE_REQUIRED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-del-' });
    const world = await seedPlaybackWorld(rig);
    const profileId = createAndActivateProfile(world, 'adult');
    const service = buildService();
    // 正常授权持有快照
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.snapshot.profileId).toBe(profileId);
    // 提交前重验时传入不存在/他人档案 id → 拒绝(不信任该声明)
    await expectDomainError(
      service.revalidate(world.deviceSessionId, randomUUID(), world.iptv.mediaId),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
    const other = await seedOtherHousehold(rig, 'prof');
    await expectDomainError(
      service.revalidate(world.deviceSessionId, other.profileId, world.iptv.mediaId),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
  });

  it('PIN 档案经解锁+select 激活(授予已被消费) → 播放授权通过,不要求二次授予', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-pinok-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileWithPinId);
    // 模拟 select 已消费解锁授予:激活事实(active_profile_id 仅能经 PIN 门 select 写入)即解锁证据
    consumeUnlockGrant(world.deviceSessionId, world.profileWithPinId);
    expect(hasUnlockGrant(world.deviceSessionId, world.profileWithPinId)).toBe(false);
    const grant = await buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.snapshot.profileId).toBe(world.profileWithPinId);
  });

  it('绑定 PIN 档案非当前档案(authorizeControl) → 403 PROFILE_PIN_REQUIRED(复用既有码)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-pinmismatch-' });
    const world = await seedPlaybackWorld(rig);
    // 播放会话绑定 PIN 档案;设备会话当前档案已切回无 PIN 档案
    const seeded = seedPlaybackSession(world, { state: 'ready', profileId: world.profileWithPinId });
    getDb().update(deviceSession).set({ activeProfileId: world.profileId }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    await expectDomainError(
      buildService().authorizeControl(trustedContextOf(world), seeded.sessionId),
      403,
      ProblemCode.PROFILE_PIN_REQUIRED,
    );
    // 解锁授予不覆盖「绑定档案≠当前档案」:授予存在仍拒绝(当前档案一致性优先)
    grantUnlock(world.deviceSessionId, world.profileWithPinId);
    expect(hasUnlockGrant(world.deviceSessionId, world.profileWithPinId)).toBe(true);
    await expectDomainError(
      buildService().authorizeControl(trustedContextOf(world), seeded.sessionId),
      403,
      ProblemCode.PROFILE_PIN_REQUIRED,
    );
  });

  it('绑定无 PIN 档案非当前档案(revalidate) → 403 ACTIVE_PROFILE_REQUIRED(当前档案已切换)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-switch-' });
    const world = await seedPlaybackWorld(rig);
    const profileId = createAndActivateProfile(world, 'adult');
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.snapshot.profileId).toBe(profileId);
    // 当前档案切到另一档案(此处为有 PIN 档案):绑定无 PIN 档案的提交前重验 → 403 ACTIVE_PROFILE_REQUIRED
    getDb().update(deviceSession).set({ activeProfileId: world.profileWithPinId }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    await expectDomainError(
      service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
  });

  it('revalidate 传空 profileId → 403 ACTIVE_PROFILE_REQUIRED(防御性,等同未选择档案)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-empty-' });
    const world = await seedPlaybackWorld(rig);
    createAndActivateProfile(world, 'adult');
    await expectDomainError(
      buildService().revalidate(world.deviceSessionId, '', world.iptv.mediaId),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
  });

  it('PIN 锁定/错误沿用既有 pin.service 语义(授权管线不旁路也不复制)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-pinlock-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileWithPinId);
    const row = getDb().select().from(profile).where(eq(profile.id, world.profileWithPinId)).get();
    if (row === undefined) {
      throw new Error('夹具错误:PIN 档案不存在');
    }
    const service = buildService();
    // 锁定窗口内 unlock → 423 PROFILE_PIN_LOCKED(既有语义;授权不为其开洞)
    getDb()
      .update(profile)
      .set({ failedPinCount: 5, pinLockedUntil: new Date(Date.now() + 60_000).toISOString() })
      .where(eq(profile.id, world.profileWithPinId))
      .run();
    const lockedRow = getDb().select().from(profile).where(eq(profile.id, world.profileWithPinId)).get();
    if (lockedRow === undefined) {
      throw new Error('夹具错误:PIN 档案不存在');
    }
    await expectDomainError(unlockProfilePin(lockedRow, world.pin, world.deviceSessionId), 423, ProblemCode.PROFILE_PIN_LOCKED);
    // 错误 PIN → 既有 403 计数语义(锁定窗口过期后重置为 1)
    getDb().update(profile).set({ failedPinCount: 0, pinLockedUntil: null }).where(eq(profile.id, world.profileWithPinId)).run();
    const resetRow = getDb().select().from(profile).where(eq(profile.id, world.profileWithPinId)).get();
    if (resetRow === undefined) {
      throw new Error('夹具错误:PIN 档案不存在');
    }
    await expectDomainError(unlockProfilePin(resetRow, 'wrong-pin', world.deviceSessionId), 403, ProblemCode.FORBIDDEN);
    const after = getDb().select().from(profile).where(eq(profile.id, world.profileWithPinId)).get();
    expect(after?.failedPinCount).toBe(1);
    // 正确 PIN unlock → 签发授予(既有语义)
    const freshRow = getDb().select().from(profile).where(eq(profile.id, world.profileWithPinId)).get();
    if (freshRow === undefined) {
      throw new Error('夹具错误:PIN 档案不存在');
    }
    await unlockProfilePin(freshRow, world.pin, world.deviceSessionId);
    expect(hasUnlockGrant(world.deviceSessionId, world.profileWithPinId)).toBe(true);
    // 即便授予存活:绑定 PIN 档案 ≠ 当前档案 → revalidate 仍以 PIN 既有码拒绝(一致性优先)
    getDb().update(deviceSession).set({ activeProfileId: world.profileId }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    await expectDomainError(
      service.revalidate(world.deviceSessionId, world.profileWithPinId, world.iptv.mediaId),
      403,
      ProblemCode.PROFILE_PIN_REQUIRED,
    );
    // 当前档案 = 该 PIN 档案(经 select 门激活) → 授权通过
    getDb().update(deviceSession).set({ activeProfileId: world.profileWithPinId }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.snapshot.profileId).toBe(world.profileWithPinId);
  });
});

/* ------------------------------------------------------------------ */
/* 3. 策略链(authorizeCurrentProfile 集成;拒绝统一 404 同形)          */
/* ------------------------------------------------------------------ */

describe('策略链(authorizeCurrentProfile 集成;拒绝统一 404 不返回明细)', () => {
  it('成人默认策略(18/true)对 18 级媒体放行 → 返回授权与候选', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-adult-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    createAndActivateProfile(world, 'adult');
    const adult = seedMediaOnSource(world, world.nas, { contentLevel: 18 });
    const grant = await buildService().authorizeResolve(trustedContextOf(world), adult.mediaId);
    expect(grant.snapshot.mediaId).toBe(adult.mediaId);
    expect(grant.candidates.length).toBe(1);
  });

  it('儿童档案对超龄媒体(contentLevel 18 > 12) → 404 MEDIA_NOT_FOUND(不返回策略明细)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-child-lv-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    createAndActivateProfile(world, 'child');
    const adult = seedMediaOnSource(world, world.nas, { contentLevel: 18 });
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), adult.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('儿童档案黑名单媒体(blockedMediaIds) → 404 MEDIA_NOT_FOUND(禁止优先)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-block-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    const childId = createAndActivateProfile(world, 'child');
    writePolicyLists(world.householdId, childId, { blockedMediaIds: [world.nas.mediaId] });
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.nas.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('儿童档案对未评级媒体(allowUnrated=false) → 404 MEDIA_NOT_FOUND', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-unrated-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    createAndActivateProfile(world, 'child');
    const unrated = seedMediaOnSource(world, world.nas, { contentLevel: null });
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), unrated.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('儿童档案观看名单外频道(allowedChannelIds 空) → 404 MEDIA_NOT_FOUND', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-chchan-' });
    const world = await seedPlaybackWorld(rig);
    createAndActivateProfile(world, 'child');
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('儿童档案允许名单覆盖等级上限(allowedMediaIds 含 18 级) → 放行(真实规则 MEDIA_ALLOWED)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-allow-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    const childId = createAndActivateProfile(world, 'child');
    const adult = seedMediaOnSource(world, world.nas, { contentLevel: 18 });
    writePolicyLists(world.householdId, childId, { allowedMediaIds: [adult.mediaId] });
    const grant = await buildService().authorizeResolve(trustedContextOf(world), adult.mediaId);
    expect(grant.snapshot.mediaId).toBe(adult.mediaId);
  });

  it('策略行损坏(名单元素非法但通过 DB CHECK) → 503 POLICY_UNAVAILABLE(默认拒绝,fail-closed)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-corrupt-' });
    const world = await seedPlaybackWorld(rig);
    const profileId = createAndActivateProfile(world, 'adult');
    // DDL CHECK 仅约束 json_valid + array;空字符串元素通过 CHECK 但破坏存量读取校验
    getDb().update(profilePolicy).set({ allowedMediaIds: '[""]' }).where(eq(profilePolicy.profileId, profileId)).run();
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      503,
      ProblemCode.POLICY_UNAVAILABLE,
    );
  });

  it('策略收紧后 authorize 重新读取最新策略(不缓存):上一请求放行、拉黑后拒绝', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-fresh-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    // 成人档案:频道判定豁免,拉黑前 0 级媒体放行,拉黑后 MEDIA_BLOCKED 拒绝
    const adultId = createAndActivateProfile(world, 'adult');
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.candidates.length).toBe(1);
    writePolicyLists(world.householdId, adultId, { blockedMediaIds: [world.iptv.mediaId] });
    await expectDomainError(
      service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. 家庭可用资源链(候选只取家庭内已启用可用资源)                    */
/* ------------------------------------------------------------------ */

describe('家庭可用资源链(启用过滤 + data-model 排序)', () => {
  it('家庭内无启用源(iptv/nas 全停用) → 404 MEDIA_NOT_FOUND(无源同形;T037 裁决 ① 行为修正:原 503 归一为 api.md「不存在/跨家庭/不可见/无源同形 404」)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-nores-' });
    const world = await seedPlaybackWorld(rig, { iptvEnabled: false });
    activateFixtureProfile(world, world.profileId);
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('媒体无启用源(NAS 停用、家庭内 IPTV 仍启用) → 404 MEDIA_NOT_FOUND(无源同形)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-nosrc-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileId);
    await expectDomainError(
      buildService().authorizeResolve(trustedContextOf(world), world.nas.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('多源候选:IPTV(http+代理)→hls_proxy、NAS(file)→direct;按 (成本, source_id, playback_source_id) 二进制升序', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-multi-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    activateFixtureProfile(world, world.profileId);
    const extra = attachExtraResource(world, world.nas.mediaId, world.iptv, { protocol: 'http', requiresProxy: 1 });
    const grant = await buildService().authorizeResolve(trustedContextOf(world), world.nas.mediaId);
    const expectedSource: readonly PlaybackResourceCandidate[] = [
      { playbackSourceId: world.nas.playbackSourceId, sourceId: world.nas.sourceId, delivery: 'direct' },
      { playbackSourceId: extra.playbackSourceId, sourceId: extra.sourceId, delivery: 'hls_proxy' },
    ];
    const expected = [...expectedSource].sort(comparePlaybackCandidates);    expect(grant.candidates).toEqual(expected);
    // 顺序确由 source_id 二进制比较决定(首位 = 二进制较小者)
    const binaryMin = [world.nas.sourceId, extra.sourceId].sort()[0];
    expect(grant.candidates[0]?.sourceId).toBe(binaryMin);
  });

  it('候选条目 present=0 / 父源停用不入候选(只取启用可用资源)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-present-' });
    // 默认世界:NAS 停用 → 挂在 NAS 上的附加资源不入候选
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileId);
    const extra = attachExtraResource(world, world.iptv.mediaId, world.nas, { protocol: 'file', requiresProxy: 0 });
    // 父源停用:该附加资源不入候选
    let grant = await buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.candidates.map((c) => c.playbackSourceId)).toEqual([world.iptv.playbackSourceId]);
    // 启用 NAS 但条目 present=0:同样不入候选
    getDb().update(mediaSource).set({ enabled: 1 }).where(eq(mediaSource.id, world.nas.sourceId)).run();
    getDb().update(sourceEntry).set({ present: 0 }).where(eq(sourceEntry.id, extra.entryId)).run();
    grant = await buildService().authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    expect(grant.candidates.map((c) => c.playbackSourceId)).toEqual([world.iptv.playbackSourceId]);
  });

  it('源禁用后重验 → 候选消失:媒体级 404(家庭内仍有他源);全部停用 → 404 同形(T037 裁决 ①:家庭级零资源与媒体级无源同形)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-revalidate-src-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    activateFixtureProfile(world, world.profileId);
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.nas.mediaId);
    expect(grant.candidates.length).toBe(1);
    // NAS 禁用:IPTV 仍启用 → 家庭级可用,媒体级候选消失 → 404 同形
    getDb().update(mediaSource).set({ enabled: 0 }).where(eq(mediaSource.id, world.nas.sourceId)).run();
    await expectDomainError(
      service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
    // IPTV 也停用:家庭内无启用源 → 同形 404(api.md「无源同形」,T037 裁决 ① 行为修正,原 503)
    getDb().update(mediaSource).set({ enabled: 0 }).where(eq(mediaSource.id, world.iptv.sourceId)).run();
    await expectDomainError(
      service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. 排序纯函数(data-model 资源排序规则的直接断言)                   */
/* ------------------------------------------------------------------ */

describe('候选排序纯函数((成本, source_id, playback_source_id) 升序)', () => {
  it('成本表:direct/hls_proxy=0、remux=1、audio_transcode=2、video_transcode=3', () => {
    expect(playbackDeliveryCost('direct')).toBe(0);
    expect(playbackDeliveryCost('hls_proxy')).toBe(0);
    expect(playbackDeliveryCost('remux')).toBe(1);
    expect(playbackDeliveryCost('audio_transcode')).toBe(2);
    expect(playbackDeliveryCost('video_transcode')).toBe(3);
  });

  it('成本优先于标识;同成本按 source_id、再按 playback_source_id 二进制升序', () => {
    const highCost: PlaybackResourceCandidate = { playbackSourceId: 'a1', sourceId: 'a', delivery: 'video_transcode' };
    const lowCost: PlaybackResourceCandidate = { playbackSourceId: 'z9', sourceId: 'z', delivery: 'direct' };
    expect(comparePlaybackCandidates(highCost, lowCost)).toBeGreaterThan(0);
    expect(comparePlaybackCandidates(lowCost, highCost)).toBeLessThan(0);

    // 同成本:source_id 二进制(大写 < 小写,无 locale 干扰)
    const s1: PlaybackResourceCandidate = { playbackSourceId: 'p1', sourceId: 'B', delivery: 'direct' };
    const s2: PlaybackResourceCandidate = { playbackSourceId: 'p2', sourceId: 'a', delivery: 'direct' };
    expect(comparePlaybackCandidates(s1, s2)).toBeLessThan(0);
    // 同成本同源:playback_source_id 二进制 —— '1'(0x31) < '2'(0x32),故 'p10' < 'p2'
    // (二进制序非数值序:这正是 data-model 要求的升序口径)
    const p1: PlaybackResourceCandidate = { playbackSourceId: 'p10', sourceId: 'a', delivery: 'hls_proxy' };
    const p2: PlaybackResourceCandidate = { playbackSourceId: 'p2', sourceId: 'a', delivery: 'direct' };
    expect(comparePlaybackCandidates(p1, p2)).toBeLessThan(0);
    // 完全相同 → 0
    expect(comparePlaybackCandidates(p1, { ...p1 })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 异步后提交前重验(revalidate)                                    */
/* ------------------------------------------------------------------ */

describe('异步后提交前重验(revalidate:策略/源/档案/会话任一变化即拒绝)', () => {
  it('授权后无变化 → revalidate 通过并返回最新候选(快照语义可复用)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-rv-ok-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileId);
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    const fresh = await service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId);
    expect(fresh.snapshot.profileId).toBe(grant.snapshot.profileId);
    expect(fresh.candidates.length).toBe(1);
  });

  it('授权后策略收紧 → revalidate 404 MEDIA_NOT_FOUND', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-rv-policy-' });
    const world = await seedPlaybackWorld(rig);
    const profileId = createAndActivateProfile(world, 'adult');
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    writePolicyLists(world.householdId, profileId, { blockedMediaIds: [world.iptv.mediaId] });
    await expectDomainError(
      service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('授权后会话撤销 → revalidate 401 SESSION_INVALID(提交前重验会话)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-rv-rev-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileId);
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    getDb().update(deviceSession).set({ revokedAt: PLAYBACK_FIXTURE_NOW }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    await expectDomainError(
      service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });

  it('授权后会话过期 → revalidate 401 SESSION_INVALID', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-rv-exp-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileId);
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    getDb()
      .update(deviceSession)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(deviceSession.id, world.deviceSessionId))
      .run();
    await expectDomainError(
      service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });

  it('授权后档案切换(PIN 变体) → revalidate 403 PROFILE_PIN_REQUIRED', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-rv-pin-' });
    const world = await seedPlaybackWorld(rig);
    activateFixtureProfile(world, world.profileWithPinId);
    const service = buildService();
    const grant = await service.authorizeResolve(trustedContextOf(world), world.iptv.mediaId);
    // 当前档案切走:绑定 PIN 档案的提交前重验 → PIN 既有码
    getDb().update(deviceSession).set({ activeProfileId: world.profileId }).where(eq(deviceSession.id, world.deviceSessionId)).run();
    await expectDomainError(
      service.revalidate(world.deviceSessionId, grant.snapshot.profileId, grant.snapshot.mediaId),
      403,
      ProblemCode.PROFILE_PIN_REQUIRED,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 7. 控制授权(authorizeControl)与结果脱敏                            */
/* ------------------------------------------------------------------ */

describe('控制授权(authorizeControl)与返回结构脱敏', () => {
  it('原设备会话+原当前档案的播放会话 → 通过,快照携带播放会话绑定事实', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-ctl-ok-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    activateFixtureProfile(world, world.profileId);
    const seeded = seedPlaybackSession(world, {
      state: 'ready',
      mediaId: world.nas.mediaId,
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'direct',
    });
    const grant = await buildService().authorizeControl(trustedContextOf(world), seeded.sessionId);
    expect(grant.snapshot.mediaId).toBe(world.nas.mediaId);
    expect(grant.snapshot.profileId).toBe(world.profileId);
    expect(grant.snapshot.deviceSessionId).toBe(world.deviceSessionId);
    expect(grant.candidates.map((c) => c.delivery)).toEqual(['direct']);
  });

  it('播放会话绑定其他设备会话(同家庭) → 404 PLAYBACK_NOT_FOUND(跨设备统一 404)', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-ctl-xdev-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    activateFixtureProfile(world, world.profileId);
    // 同家庭第二台设备 + 会话
    const deviceId2 = randomUUID();
    const sessionId2 = randomUUID();
    const now = PLAYBACK_FIXTURE_NOW;
    getDb()
      .insert(device)
      .values({ id: deviceId2, householdId: world.householdId, name: '卧室电视', type: 'tv', createdAt: now })
      .run();
    getDb()
      .insert(deviceSession)
      .values({
        id: sessionId2,
        householdId: world.householdId,
        accountId: world.accountId,
        deviceId: deviceId2,
        tokenHash: hashToken(`second-device:${sessionId2}`),
        activeProfileId: world.profileId,
        expiresAt: '2027-01-01T00:00:00.000Z',
        revokedAt: null,
        lastActiveAt: now,
        createdAt: now,
      })
      .run();
    const seeded = seedPlaybackSession(world, {
      state: 'ready',
      deviceSessionId: sessionId2,
      deviceId: deviceId2,
      mediaId: world.nas.mediaId,
      playbackSourceId: world.nas.playbackSourceId,
      delivery: 'direct',
    });
    await expectDomainError(
      buildService().authorizeControl(trustedContextOf(world), seeded.sessionId),
      404,
      ProblemCode.PLAYBACK_NOT_FOUND,
    );
  });

  it('授权结果不含源位置/URL/内部名:候选仅有 playbackSourceId/sourceId/delivery 字段', async () => {
    const rig = await startFreshApp({ prefix: 'hmp-authz-redact-' });
    const world = await seedPlaybackWorld(rig, { nasEnabled: true });
    activateFixtureProfile(world, world.profileId);
    const grant = await buildService().authorizeResolve(trustedContextOf(world), world.nas.mediaId);
    // 结构断言:候选仅 id + 排序/处理方式字段;grant 面为 snapshot + candidates + mediaType
    // (005 T050:startMode 透传校验需要媒体类型;mediaType 仅服务端内部使用,不下发)
    for (const candidate of grant.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(['delivery', 'playbackSourceId', 'sourceId']);
    }
    expect(Object.keys(grant).sort()).toEqual(['candidates', 'mediaType', 'snapshot']);
    expect(Object.keys(grant.snapshot).sort()).toEqual([
      'accountId',
      'authorizedAt',
      'deviceId',
      'deviceSessionId',
      'householdId',
      'mediaId',
      'profileContextVersion',
      'profileId',
    ]);
    // 序列化不含任何位置/URL/内部名(夹具私有 location/rootKey/主机名均不出现)
    const serialized = JSON.stringify(grant);
    expect(serialized).not.toContain('/nas-media/');
    expect(serialized).not.toContain('iptv.playback-fixture.test');
    expect(serialized).not.toContain('playback-fixture-nas');
    expect(serialized).not.toContain('https://');
  });
});
