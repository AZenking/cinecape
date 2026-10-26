import { Body, Controller, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import { PlaybackReadinessGuard } from './playback-readiness.guard';
import type { Response } from 'express';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { CurrentSession, type SessionContext } from '../../common/current-session.decorator';
import { SessionGuard } from '../../common/session.guard';
import { DomainError } from '../../common/domain-error';
import { device, deviceSession, playbackFailureEvent, playbackSession } from '../../database/schema';
import { getDb } from '../auth/db';
import { verifyParentPassword } from '../auth/parent-verification.service';
import { parseBody } from '../auth/validation';
import type { PlaybackDelivery, PlaybackSessionState } from './playback.types';
import { PlaybackWriteGuard } from './playback.controller';

/**
 * 设备播放记录查询端点(T044,spec 004,US2b;FR-007)——
 * POST /api/devices/{deviceId}/playback-records/query:
 *
 * 权威依据(先读后写):
 * - contracts/api.md 控制端点表末行:owner+当次密码,重验家庭目标;limit 默认 20 最大 100,
 *   按时间/id 倒序游标;no-store;返回当前家庭该设备的 session 及 failure 事件,无源位置/
 *   ticket;密码缺失/错误按现有家长验证规则拒绝(403);跨家庭目标统一 404 同形(不泄漏归属);
 * - openapi.yaml PlaybackRecordQueryRequest(strict,ownerPassword 必填语义由家长验证
 *   REQUIRED 403 表达)/PlaybackRecordPage({items,nextCursor})/PlaybackRecordItem
 *   (kind 判别 session|failure)/PlaybackSessionRecord(13 键)/PlaybackFailureRecord(6 键,
 *   无 deviceId —— 查询本身设备维度)为字段权威;
 * - openapi 404 语义:设备不存在/目标跨家庭统一同形 404 NOT_FOUND,不泄漏归属;
 * - 家长验证既有惯例(manual-epg-binding/sources 同链):缺失/空串 → 403
 *   PARENT_VERIFICATION_REQUIRED;错误 → 403 PARENT_VERIFICATION_FAILED(按
 *   (household,account) 持久计数);连错 5 次落窗口,窗口内正确密码也 423
 *   PARENT_VERIFICATION_LOCKED;成功清零;当次密码不发放任何长期家长态;
 * - data-model 索引 (household_id,device_id,occurred_at,id) / (household_id,device_id,
 *   created_at,id):时间/id 倒序与其同构,键集分页(keyset)以 (time,id) 为游标。
 *
 * 判定次序(与 manual-epg/sources 管理端点一致):
 * SessionGuard(401)→ owner 角色(403 FORBIDDEN)→ 严格 zod(400,未知字段拒绝)→
 * 家长验证(403 REQUIRED/FAILED、423 LOCKED;验证后重验会话行,已撤销/过期 401)→
 * 设备归属重验(不存在/跨家庭 → 404 与随机 id 同形)→ 查询。
 *
 * 查询实现经 getDb() 直查 Drizzle(仓储 API 面被 repository.spec 钉死 21 方法禁改;
 * authorization/lifecycle 同款先例):session(created_at)与 failure(occurred_at)两分支
 * 各取 limit+1 行、按 (time,id) 倒序归并取前 limit 条 —— 不透明游标编码末条 (time,id),
 * 下一页以严格小于键集续读(同刻以 id DESC 决胜);分支取尽(nextCursor=null)判定充分:
 * 任一分支若还有后继行,该分支必已返回 limit+1 行,归并长度必 > limit。
 *
 * 响应面:成功响应显式设置 Content-Type: application/problem+json; charset=utf-8(契约
 * e2e 形态断言)与 Cache-Control: no-store / Referrer-Policy: no-referrer(对齐
 * playback.controller 的 applyControlResponseHeaders;错误响应经 ProblemJsonFilter 已有);
 * 记录只含脱敏字段:无源位置/文件路径/ticket/playbackUrl,所选资源仅以不透明
 * playbackSourceId 呈现。本端点不限频(openapi:契约未定义限频),家长验证锁存语义由
 * 持久化计数承担。
 */

/* ------------------------------------------------------------------ */
/* 请求/响应契约(openapi components/schemas 权威)                        */
/* ------------------------------------------------------------------ */

/** PlaybackRecordQueryRequest(strict:未知字段拒绝;ownerPassword 必填语义由服务层 403 表达) */
const recordsQueryRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/** PlaybackSessionRecord(additionalProperties:false 的精确键集) */
export interface PlaybackSessionRecordDto {
  readonly kind: 'session';
  readonly id: string;
  readonly deviceId: string;
  readonly mediaId: string;
  readonly profileId: string;
  readonly state: PlaybackSessionState;
  readonly delivery: PlaybackDelivery | null;
  readonly positionSeconds: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly failureCode: string | null;
  readonly playbackSourceId: string | null;
}

/** PlaybackFailureRecord(additionalProperties:false 的精确键集;无 deviceId) */
export interface PlaybackFailureRecordDto {
  readonly kind: 'failure';
  readonly id: string;
  readonly occurredAt: string;
  readonly stableCode: string;
  readonly profileId: string | null;
  readonly mediaId: string | null;
}

/** PlaybackRecordItem(kind 判别联合) */
export type PlaybackRecordItemDto = PlaybackSessionRecordDto | PlaybackFailureRecordDto;

/** PlaybackRecordPage(additionalProperties:false,恰 {items,nextCursor}) */
export interface PlaybackRecordPageDto {
  readonly items: readonly PlaybackRecordItemDto[];
  readonly nextCursor: string | null;
}

/* ------------------------------------------------------------------ */
/* 鉴权链(与 manual-epg/sources 管理端点同款)                            */
/* ------------------------------------------------------------------ */

function requireOwner(context: SessionContext): void {
  if (context.account.role !== 'owner') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以查询设备播放记录');
  }
}

/**
 * 家长验证 + 会话重验(manual-epg-binding requireParentVerification 同链):
 * 密码缺失/空串统一 403 PARENT_VERIFICATION_REQUIRED,非空密码交由 verifyParentPassword
 * (403 FAILED / 423 LOCKED);验证通过后重读会话行,已撤销/已过期 401 SESSION_INVALID。
 */
async function requireParentVerification(context: SessionContext, ownerPassword?: string): Promise<void> {
  if (ownerPassword === undefined || ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, ownerPassword);
  const sessionRow = getDb().select().from(deviceSession).where(eq(deviceSession.id, context.session.id)).get();
  if (sessionRow === undefined || sessionRow.revokedAt !== null || !(Date.parse(sessionRow.expiresAt) > Date.now())) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
}

/** 设备归属重验:不存在/跨家庭统一 404 同形(与随机 id 不可区分,不泄漏存在性/归属) */
function requireDeviceOfHousehold(householdId: string, deviceId: string): void {
  const row = getDb()
    .select({ householdId: device.householdId })
    .from(device)
    .where(eq(device.id, deviceId))
    .get();
  if (row === undefined || row.householdId !== householdId) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
}

/* ------------------------------------------------------------------ */
/* 不透明游标(keyset:(time,id) 二元组)                                  */
/* ------------------------------------------------------------------ */

interface RecordCursor {
  readonly time: string;
  readonly id: string;
}

/** base64url(JSON 外的内部形态);时间/ID 均为库内文本,以 \0 分隔避免歧义 */
function encodeCursor(time: string, id: string): string {
  return Buffer.from(`${time}\u0000${id}`, 'utf8').toString('base64url');
}

/** 畸形/越权构造游标 → 400 VALIDATION_FAILED(不静默当作首页,防绕过分页边界) */
function decodeCursor(cursor: string): RecordCursor {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '游标格式无效');
  }
  const separator = raw.indexOf('\u0000');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new DomainError(400, ProblemCode.VALIDATION_FAILED, '游标格式无效');
  }
  return { time: raw.slice(0, separator), id: raw.slice(separator + 1) };
}

/* ------------------------------------------------------------------ */
/* 查询(session + failure 合并,按 (time,id) 倒序键集分页)                 */
/* ------------------------------------------------------------------ */

/** (time,id) 倒序全序:time 为 session.created_at / failure.occurred_at(ISO 文本字典序=时间序) */
function compareRecordDesc(a: { id: string; time: string }, b: { id: string; time: string }): number {
  if (a.time !== b.time) {
    return a.time < b.time ? 1 : -1;
  }
  return a.id < b.id ? 1 : -1;
}

function toSessionRecord(row: typeof playbackSession.$inferSelect): PlaybackSessionRecordDto {
  return {
    kind: 'session',
    id: row.id,
    deviceId: row.deviceId,
    mediaId: row.mediaId,
    profileId: row.profileId,
    state: row.state as PlaybackSessionState,
    delivery: row.delivery as PlaybackDelivery | null,
    positionSeconds: row.positionSeconds,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    failureCode: row.failureCode,
    playbackSourceId: row.playbackSourceId,
  };
}

function toFailureRecord(row: typeof playbackFailureEvent.$inferSelect): PlaybackFailureRecordDto {
  return {
    kind: 'failure',
    id: row.id,
    occurredAt: row.occurredAt,
    stableCode: row.stableCode,
    profileId: row.profileId,
    mediaId: row.mediaId,
  };
}

/**
 * 记录页查询:本家庭该设备的 session 与 failure 事件合并、(time,id) 倒序;
 * 两分支各取 limit+1 行(探测「还有更多」),归并取前 limit 条;游标=末条 (time,id)。
 */
function queryRecordPage(
  householdId: string,
  deviceId: string,
  limit: number,
  cursor: RecordCursor | undefined,
): PlaybackRecordPageDto {
  const sessionWhere: SQL[] = [eq(playbackSession.householdId, householdId), eq(playbackSession.deviceId, deviceId)];
  const failureWhere: SQL[] = [eq(playbackFailureEvent.householdId, householdId), eq(playbackFailureEvent.deviceId, deviceId)];
  if (cursor !== undefined) {
    const sessionCursor = or(
      lt(playbackSession.createdAt, cursor.time),
      and(eq(playbackSession.createdAt, cursor.time), lt(playbackSession.id, cursor.id)),
    );
    if (sessionCursor !== undefined) {
      sessionWhere.push(sessionCursor);
    }
    const failureCursor = or(
      lt(playbackFailureEvent.occurredAt, cursor.time),
      and(eq(playbackFailureEvent.occurredAt, cursor.time), lt(playbackFailureEvent.id, cursor.id)),
    );
    if (failureCursor !== undefined) {
      failureWhere.push(failureCursor);
    }
  }
  const sessionRows = getDb()
    .select()
    .from(playbackSession)
    .where(and(...sessionWhere))
    .orderBy(desc(playbackSession.createdAt), desc(playbackSession.id))
    .limit(limit + 1)
    .all();
  const failureRows = getDb()
    .select()
    .from(playbackFailureEvent)
    .where(and(...failureWhere))
    .orderBy(desc(playbackFailureEvent.occurredAt), desc(playbackFailureEvent.id))
    .limit(limit + 1)
    .all();

  const merged = [
    ...sessionRows.map((row) => ({ id: row.id, time: row.createdAt, item: toSessionRecord(row) as PlaybackRecordItemDto })),
    ...failureRows.map((row) => ({ id: row.id, time: row.occurredAt, item: toFailureRecord(row) as PlaybackRecordItemDto })),
  ].sort(compareRecordDesc);

  const items = merged.slice(0, limit).map((entry) => entry.item);
  const hasMore = merged.length > limit;
  const last = merged[limit - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last.time, last.id) : null,
  };
}

/* ------------------------------------------------------------------ */
/* 端点                                                                  */
/* ------------------------------------------------------------------ */

/** 成功响应公共安全头(与 playback.controller applyControlResponseHeaders 同形态) */
function applyRecordsResponseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

@Controller('devices')
@UseGuards(PlaybackReadinessGuard, SessionGuard, PlaybackWriteGuard)
export class PlaybackRecordsController {
  /** POST /devices/{deviceId}/playback-records/query:owner 当次密码查询设备记录页 */
  @Post(':deviceId/playback-records/query')
  @HttpCode(200)
  async queryRecords(
    @Param('deviceId') deviceId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlaybackRecordPageDto> {
    requireOwner(context);
    const input = parseBody(recordsQueryRequestSchema, body);
    await requireParentVerification(context, input.ownerPassword);
    requireDeviceOfHousehold(context.session.householdId, deviceId);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const page = queryRecordPage(context.session.householdId, deviceId, input.limit ?? 20, cursor);
    applyRecordsResponseHeaders(res);
    return { items: page.items, nextCursor: page.nextCursor };
  }
}
