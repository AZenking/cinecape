import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { Database } from '@platform/database/database';
import { setEnvOverride } from '@platform/config/env';
import { loadEnv } from '@platform/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '@platform/config/playback-budgets';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import {
  account,
  device,
  deviceSession,
  playbackTicket,
  profilePolicy,
} from '@platform/database/schema';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { PlaybackRepository } from '../../../src/contexts/playback/infrastructure/playback.repository';
import { bindPlaybackStore } from '../../../src/contexts/playback/application/playback-store.port';
import { drizzlePlaybackStore } from '../../../src/contexts/playback/infrastructure/playback-store.drizzle';
import { PlaybackAuthorizationService } from '../../../src/contexts/playback/application/playback-authorization.service';
import {
  PLAYBACK_RENEW_LEAD_SECONDS,
  PlaybackTicketService,
  type TicketReply,
} from '../../../src/contexts/playback/application/playback-ticket.service';

/**
 * 008-T013(ADR-0015 D1):测试 rig 绑定仓储 seam(惰性 Database.db 解析,
 * 每测试 close/重开单例仍正确;AppModule 路径由 PlaybackModule 幂等覆盖)。
 */
bindPlaybackStore(drizzlePlaybackStore());

/**
 * 播放票据服务单元测试(T018,spec 004;playback-ticket.service.ts 的被测底层)。
 *
 * 权威依据(docs/specs/004-playback-resolver):
 * - tasks.md T018:256-bit opaque 票/hash 存储、TTL、绑定 profile/session/generation、
 *   首次 ready 后以 expectedGeneration 申请票,此后提前 60 秒续期;签发短事务 CAS 失败
 *   409 不写票,preparing 拒绝签票;续期不创建 session/转换,旧票原 TTL 且换代后立即拒绝;
 * - data-model.md「## playback_ticket」:随机 256bit ticket 只在创建/续期响应出现一次;
 *   续期新 row,旧票原过期时间不变;seek/换代后旧 generation 无论 TTL 不可用;终态票拒绝;
 * - contracts/api.md:TicketReply={playbackUrl,ticketExpiresAt,generation};renew 默认
 *   5 分钟 TTL;expectedGeneration 在签发票的短事务内比较,不一致 409 且不写票;
 *   preparing 时 409 PLAYBACK_NOT_READY;最终提交前重验授权(revalidate)。
 *
 * 直接实例化(new PlaybackTicketService(repository, authorization, budgets)):
 * authorization 用真实实例 + 夹具种子(startFreshApp + seedPlaybackWorld),
 * budgets 显式注入(票据 TTL 经 env 派生,注入 120s 验证预算生效)。
 */

/** 注入 120s 票据 TTL 的预算(范围 60~900;与默认 300 区分以证明 TTL 取自预算而非硬编码) */
function ticketBudgets(): PlaybackBudgets {
  return createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_TICKET_TTL_SECONDS: '120' }));
}

interface TicketRig {
  dataDir: string;
  world: PlaybackWorld;
  service: PlaybackTicketService;
  budgets: PlaybackBudgets;
  context: SessionContext;
}

/** 纯 DB rig(不经 Nest 容器;repository.spec.ts 同款):临时 DATA_DIR + 权威迁移 DDL 0001~0005 */
const rigs: TicketRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/platform/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

/** 直接构造被测服务(repository/authorization/budgets 均真实实例 + 夹具种子) */
async function bootstrapTicketRig(prefix: string): Promise<TicketRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of [
    '0001_init',
    '0002_profile_policy',
    '0003_media_catalog',
    '0004_manual_epg_binding',
    '0005_playback',
    '0006_pc_experience',
  ]) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  // 夹具仅需 rig 句柄约束调用时序(数据访问走 Database 单例 getDb());不经 Nest app
  const fakeRig = { app: {} as INestApplication, dataDir, dbFilename: `${randomUUID()}.hmp.db` };
  const world = await seedPlaybackWorld(fakeRig);
  // 夹具直插档案无 profile_policy 行(缺失策略默认拒绝):补种默认策略并激活
  getDb()
    .insert(profilePolicy)
    .values({
      householdId: world.householdId,
      profileId: world.profileId,
      maxContentLevel: 18,
      allowUnrated: 1,
      allowedMediaIds: '[]',
      blockedMediaIds: '[]',
      allowedChannelIds: '[]',
      version: 1,
      updatedAt: PLAYBACK_FIXTURE_NOW,
    })
    .run();
  const budgets = ticketBudgets();
  const repository = new PlaybackRepository(Database.db, budgets);
  const authorization = new PlaybackAuthorizationService(repository);
  const service = new PlaybackTicketService(repository, authorization, budgets);
  const session = getDb().select().from(deviceSession).where(eq(deviceSession.id, world.deviceSessionId)).get();
  if (session === undefined) {
    throw new Error('夹具错误:device_session 不存在');
  }
  const acc = getDb().select().from(account).where(eq(account.id, world.accountId)).get();
  if (acc === undefined) {
    throw new Error('夹具错误:account 不存在');
  }
  const context: SessionContext = {
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
  const ticketRig: TicketRig = { dataDir, world, service, budgets, context };
  rigs.push(ticketRig);
  return ticketRig;
}

/** afterEach 调用:关闭并清理全部 rig */
async function cleanupTicketRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 票表全行(按签发时间序) */
function ticketRows(sessionId: string): Array<Record<string, unknown>> {
  return Database.db
    .prepare('SELECT * FROM playback_ticket WHERE session_id = ? ORDER BY issued_at, id')
    .all(sessionId) as Array<Record<string, unknown>>;
}

/** 从 playbackUrl 提取 opaque ticket 明文(?ticket= 之后) */
function tokenOf(reply: TicketReply): string {
  const marker = '?ticket=';
  const at = reply.playbackUrl.indexOf(marker);
  expect(at, `playbackUrl 应携带 ticket:${reply.playbackUrl}`).toBeGreaterThan(0);
  return reply.playbackUrl.slice(at + marker.length);
}

/** 预期 DomainError:断言 status + 稳定码 */
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

afterEach(async () => {
  await cleanupTicketRigs();
});

/* ------------------------------------------------------------------ */
/* 1. 首次签发(ready):TicketReply 三字段 + 明文不落库                  */
/* ------------------------------------------------------------------ */

describe('T018 首次签发(ready 会话)', () => {
  it('ready 签发成功:TicketReply 仅 {playbackUrl,ticketExpiresAt,generation},明文只出现在响应,DB 仅落 sha256 hash', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-ok-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    const reply = await t.service.issueOrRenew(seeded.sessionId, 1, t.context, { at: PLAYBACK_FIXTURE_NOW });

    // 契约形状:TicketReply 恰好三字段
    expect(Object.keys(reply).sort()).toEqual(['generation', 'playbackUrl', 'ticketExpiresAt']);
    expect(reply.generation).toBe(1);
    // 同源路径,无源地址/位置
    expect(reply.playbackUrl.startsWith('/api/playback/stream/')).toBe(true);
    expect(reply.playbackUrl).toContain(`/${seeded.sessionId}/1/`);
    expect(reply.playbackUrl).not.toContain('/nas-media/');
    expect(reply.playbackUrl).not.toContain('iptv.playback-fixture.test');
    // TTL = budgets.ticket.ttlSeconds(注入 120s)
    expect(Date.parse(reply.ticketExpiresAt) - Date.parse(PLAYBACK_FIXTURE_NOW)).toBe(120_000);

    // 明文熵:256bit = 32 字节
    const token = tokenOf(reply);
    const raw = Buffer.from(token, 'base64url');
    expect(raw.length).toBe(32);

    // 库中仅 hash:token_hash === sha256(明文);任何列都不含明文(明文不落库)
    const rows = ticketRows(seeded.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['token_hash']).toBe(sha256Hex(token));
    for (const row of rows) {
      for (const value of Object.values(row)) {
        expect(String(value)).not.toContain(token);
      }
    }
    expect(rows[0]!['generation']).toBe(1);
    expect(rows[0]!['revoked_at']).toBeNull();
  });

  it('256-bit 熵:两次签发明文互不相同且均 32 字节;token_hash 全局唯一(新票新行)', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-entropy-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    const first = await t.service.issueOrRenew(seeded.sessionId, 1, t.context);
    const second = await t.service.issueOrRenew(seeded.sessionId, 1, t.context);
    const tokenA = tokenOf(first);
    const tokenB = tokenOf(second);
    expect(tokenA).not.toBe(tokenB);
    expect(Buffer.from(tokenA, 'base64url').length).toBe(32);
    expect(Buffer.from(tokenB, 'base64url').length).toBe(32);
    expect(sha256Hex(tokenA)).not.toBe(sha256Hex(tokenB));
    expect(ticketRows(seeded.sessionId)).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* 2. 状态门槛:preparing/终态拒绝                                      */
/* ------------------------------------------------------------------ */

describe('T018 状态门槛(仅 ready/playing/paused 可签发)', () => {
  it('preparing → 409 PLAYBACK_NOT_READY 且不写票行', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-prep-');
    const seeded = seedPlaybackSession(t.world, { state: 'preparing', at: PLAYBACK_FIXTURE_NOW });
    await expectDomainError(
      t.service.issueOrRenew(seeded.sessionId, 1, t.context),
      409,
      ProblemCode.PLAYBACK_NOT_READY,
    );
    expect(ticketRows(seeded.sessionId)).toHaveLength(0);
  });

  it('终态:ended → 409 PLAYBACK_ENDED;failed/interrupted → 409 PLAYBACK_NOT_READY(仓储终态守卫语义);均不写票', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-terminal-');
    for (const [state, status, code] of [
      ['ended', 409, ProblemCode.PLAYBACK_ENDED],
      ['failed', 409, ProblemCode.PLAYBACK_NOT_READY],
      ['interrupted', 409, ProblemCode.PLAYBACK_NOT_READY],
    ] as const) {
      const seeded = seedPlaybackSession(t.world, { state, at: PLAYBACK_FIXTURE_NOW });
      await expectDomainError(t.service.issueOrRenew(seeded.sessionId, 1, t.context), status, code);
      expect(ticketRows(seeded.sessionId), state).toHaveLength(0);
    }
  });

  it('playing/paused 同样可签发(活动交付三态)', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-playing-');
    for (const state of ['playing', 'paused'] as const) {
      const seeded = seedPlaybackSession(t.world, { state, at: PLAYBACK_FIXTURE_NOW });
      const reply = await t.service.issueOrRenew(seeded.sessionId, 1, t.context);
      expect(reply.generation).toBe(1);
      expect(ticketRows(seeded.sessionId)).toHaveLength(1);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. generation CAS(短事务):过期代不写行                              */
/* ------------------------------------------------------------------ */

describe('T018 generation CAS(短事务内比较,经仓储既有语义)', () => {
  it('换代后旧票签发路径拒:seek 升代后 expectedGeneration=1 → 409 PLAYBACK_GENERATION_STALE 且不写行;以新代 2 签发成功且票行 generation=2', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-gen-');
    const repo = new PlaybackRepository(Database.db, t.budgets);
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    // seek:ready→preparing,generation/version 各 +1(1→2)
    const rebuilt = repo.beginRebuild(seeded.sessionId, {
      cas: { expectedVersion: 1, expectedGeneration: 1 },
      positionSeconds: 7,
    });
    expect(rebuilt.ok).toBe(true);
    // 新代重新 ready
    const ready = repo.markReady(seeded.sessionId, {
      cas: { expectedVersion: 2, expectedGeneration: 2 },
      playbackSourceId: t.world.iptv.playbackSourceId,
      delivery: 'direct',
    });
    expect(ready.ok).toBe(true);

    // 旧代签票:409 且不写行(即使会话处于可签发态)
    await expectDomainError(
      t.service.issueOrRenew(seeded.sessionId, 1, t.context),
      409,
      ProblemCode.PLAYBACK_GENERATION_STALE,
    );
    expect(ticketRows(seeded.sessionId)).toHaveLength(0);
    // 当前代签票:成功,票行 generation=2
    const reply = await t.service.issueOrRenew(seeded.sessionId, 2, t.context);
    expect(reply.generation).toBe(2);
    const rows = ticketRows(seeded.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['generation']).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 4. 续期复用:session 不变,旧票原 TTL 不动不撤销,票行数递增           */
/* ------------------------------------------------------------------ */

describe('T018 续期(不创建 session/转换,不递增 version/generation)', () => {
  it('两次签发:票行数递增,旧票 issued_at/expires_at/revoked_at 原值不变;session 行 version/generation/state 不变', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-renew-');
    const repo = new PlaybackRepository(Database.db, t.budgets);
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    const first = await t.service.issueOrRenew(seeded.sessionId, 1, t.context, { at: PLAYBACK_FIXTURE_NOW });
    const firstRows = ticketRows(seeded.sessionId);
    expect(firstRows).toHaveLength(1);
    const firstRow = firstRows[0]!;

    // 提前 60 秒续期(客户端 T050 语义):TTL 仍取预算,旧票不动
    const renewAt = new Date(Date.parse(PLAYBACK_FIXTURE_NOW) + 60_000).toISOString();
    const second = await t.service.issueOrRenew(seeded.sessionId, 1, t.context, { at: renewAt });

    // 新票新行:TTL = issued + 120s(预算注入)
    expect(Date.parse(second.ticketExpiresAt) - Date.parse(renewAt)).toBe(120_000);
    const rows = ticketRows(seeded.sessionId);
    expect(rows).toHaveLength(2);
    // 旧票原值不变:issued_at/expires_at 不变,未撤销
    expect(rows[0]!['id']).toBe(firstRow['id']);
    expect(rows[0]!['issued_at']).toBe(firstRow['issued_at']);
    expect(rows[0]!['expires_at']).toBe(firstRow['expires_at']);
    expect(rows[0]!['revoked_at']).toBeNull();
    expect(rows[0]!['expires_at']).toBe(first.ticketExpiresAt);
    // 新行独立
    expect(rows[1]!['id']).not.toBe(firstRow['id']);
    expect(rows[1]!['issued_at']).toBe(renewAt);

    // session 不变:version/generation/state 全不动(续期不递增)
    const sessionRow = Database.db
      .prepare('SELECT state, generation, version FROM playback_session WHERE id = ?')
      .get(seeded.sessionId) as { state: string; generation: number; version: number };
    expect(sessionRow).toEqual({ state: 'ready', generation: 1, version: 1 });
    // 不建转换行
    const conversions = Database.db
      .prepare('SELECT count(*) AS n FROM playback_conversion WHERE session_id = ?')
      .get(seeded.sessionId) as { n: number };
    expect(conversions.n).toBe(0);
    void repo;
  });
});

/* ------------------------------------------------------------------ */
/* 5. 授权集成:revalidate 拒绝路径不签票                               */
/* ------------------------------------------------------------------ */

describe('T018 授权集成(提交前重验,拒绝则不签票)', () => {
  it('授权后策略收紧(blockedMediaIds) → 404 MEDIA_NOT_FOUND 且票表 0 行', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-policy-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    // 首次签发成功,证明基线可签
    await t.service.issueOrRenew(seeded.sessionId, 1, t.context);
    expect(ticketRows(seeded.sessionId)).toHaveLength(1);
    // 策略收紧:媒体进黑名单(异步授权窗口变更模拟)
    const { writePolicyLists } = await import('@contexts/policy/application/policy.service');
    writePolicyLists(t.world.householdId, t.world.profileId, { blockedMediaIds: [t.world.iptv.mediaId] });
    await expectDomainError(
      t.service.issueOrRenew(seeded.sessionId, 1, t.context),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
    expect(ticketRows(seeded.sessionId)).toHaveLength(1); // 未新增
  });

  it('授权后当前档案切走 → 403 ACTIVE_PROFILE_REQUIRED 且不签票', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-profile-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    getDb()
      .update(deviceSession)
      .set({ activeProfileId: null })
      .where(eq(deviceSession.id, t.world.deviceSessionId))
      .run();
    await expectDomainError(
      t.service.issueOrRenew(seeded.sessionId, 1, t.context),
      403,
      ProblemCode.ACTIVE_PROFILE_REQUIRED,
    );
    expect(ticketRows(seeded.sessionId)).toHaveLength(0);
  });

  it('非本设备会话的票据申请 → 404 PLAYBACK_NOT_FOUND(跨设备同形,不泄露存在性);会话行不存在 → 401(授权管线钉死语义)', async () => {
    const t = await bootstrapTicketRig('hmp-ticket-xdev-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    // 同家庭第二台设备 + 有效设备会话(真实第二上下文)
    const deviceId2 = randomUUID();
    const sessionId2 = randomUUID();
    getDb()
      .insert(device)
      .values({ id: deviceId2, householdId: t.world.householdId, name: '卧室电视', type: 'tv', createdAt: PLAYBACK_FIXTURE_NOW })
      .run();
    getDb()
      .insert(deviceSession)
      .values({
        id: sessionId2,
        householdId: t.world.householdId,
        accountId: t.world.accountId,
        deviceId: deviceId2,
        tokenHash: sha256Hex(`second-device:${sessionId2}`),
        activeProfileId: t.world.profileId,
        expiresAt: '2027-01-01T00:00:00.000Z',
        revokedAt: null,
        lastActiveAt: PLAYBACK_FIXTURE_NOW,
        createdAt: PLAYBACK_FIXTURE_NOW,
      })
      .run();
    const acc = getDb().select().from(account).where(eq(account.id, t.world.accountId)).get();
    if (acc === undefined) {
      throw new Error('夹具错误:account 不存在');
    }
    const otherDeviceContext: SessionContext = {
      session: {
        id: sessionId2,
        householdId: t.world.householdId,
        accountId: t.world.accountId,
        deviceId: deviceId2,
        activeProfileId: t.world.profileId,
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      account: {
        id: acc.id,
        householdId: acc.householdId,
        username: acc.username,
        role: acc.role as SessionContext['account']['role'],
      },
    };
    await expectDomainError(
      t.service.issueOrRenew(seeded.sessionId, 1, otherDeviceContext),
      404,
      ProblemCode.PLAYBACK_NOT_FOUND,
    );
    expect(ticketRows(seeded.sessionId)).toHaveLength(0);
    // 设备会话行不存在:授权管线可信会话链先行 401 SESSION_INVALID
    const forged: SessionContext = {
      ...t.context,
      session: { ...t.context.session, id: randomUUID() },
    };
    await expectDomainError(t.service.issueOrRenew(seeded.sessionId, 1, forged), 401, ProblemCode.SESSION_INVALID);
    expect(ticketRows(seeded.sessionId)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 6. 客户端常量:renewLeadSeconds 导出(前端 T050 用)                   */
/* ------------------------------------------------------------------ */

describe('T018 renewLeadSeconds 常量导出', () => {
  it('PLAYBACK_RENEW_LEAD_SECONDS = 60,与 budgets.ticket.renewLeadSeconds 一致(单一权威对齐)', () => {
    expect(PLAYBACK_RENEW_LEAD_SECONDS).toBe(60);
    expect(createPlaybackBudgets(loadEnv({ NODE_ENV: 'test' })).ticket.renewLeadSeconds).toBe(
      PLAYBACK_RENEW_LEAD_SECONDS,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 7. 脱敏与日志面                                                     */
/* ------------------------------------------------------------------ */

describe('T018 响应/库面脱敏', () => {
  it('库内 playbackTicket 行经 redactForLog 不泄漏明文;TicketReply 序列化不含源位置', async () => {
    const { redactForLog } = await import('@platform/http-common/log-redaction.util');
    const t = await bootstrapTicketRig('hmp-ticket-redact-');
    const seeded = seedPlaybackSession(t.world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
    const reply = await t.service.issueOrRenew(seeded.sessionId, 1, t.context);
    const token = tokenOf(reply);
    // 库行(仅 hash)入日志安全;明文 token 本就不在行内
    const row = getDb().select().from(playbackTicket).where(eq(playbackTicket.sessionId, seeded.sessionId)).get();
    expect(row).toBeDefined();
    const logged = JSON.stringify(redactForLog(row));
    expect(logged).not.toContain(token);
    // 响应不含源位置(夹具私有 location)
    expect(JSON.stringify(reply)).not.toContain('/nas-media/');
    expect(JSON.stringify(reply)).not.toContain('iptv.playback-fixture.test');
  });
});
