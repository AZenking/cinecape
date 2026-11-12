import { ProblemCode } from '@hmp/shared';
import type { PlaybackDelivery, PlaybackSessionState } from '@contexts/playback';
import { DomainError } from '@platform/http-common/domain-error';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import {
  requireManagementRole,
  verifyParentPassword,
  listHouseholdDevices,
  revokeHouseholdDevice,
  type DeviceDtoBody,
} from '@contexts/identity-access';
import { requireMainProfileTx } from '@contexts/settings/application/settings-access-grant.service';
import {
  settingsStore,
  type PlaybackFailureEventRow,
  type PlaybackSessionRow,
  type SettingsTxStore,
} from '@contexts/settings/application/settings-store.port';

/**
 * 设备与会话服务(T130,005 contracts/api.md §6「devices 三组」;FR-039/FR-040;
 * 013-role-differentiated-settings/ADR-0017):
 * - GET /settings/devices:家庭设备列表(含已撤销,revokedAt 标注);
 * - POST /{deviceId}/revoke:{ownerPassword} 必填(不可逆高危操作,保留单次当次密码;
 *   api.md §6)→ 204;撤销目标设备全部会话与授予(域核心 revokeHouseholdDevice 零改动,
 *   语义见其注释);
 * - POST /{deviceId}/playback-records/query:播放记录查询(013 起免当次密码,仅保留
 *   owner-only 角色与主档案解锁边界;不能用作个人历史)。
 *
 * 记录查询/DTO 所有权(005 US8 收口):设备播放记录入口已随管理迁移整体收口到
 * settings(005 api.md §6 末行 + §8「不保留旧 /devices 管理入口」)——旧
 * 旧 playback 管理控制器 playback-records.controller(POST /api/devices/...)已删除,
 * playback.module 不再注册;本文件为记录查询与 openapi 记录 DTO 的唯一权威实现
 * (键集分页语义与被删除的 004 控制器逐义相同:记录只含脱敏字段、(time,id) 倒序、
 * base64url 游标;服务层额外承担 Settings 授予重验与 owner-only)。
 *
 * 008-repository-extraction(T012,ADR-0015 D1):数据访问经 SettingsStore 端口
 * (查询逐字迁往 infrastructure/settings-store.drizzle.ts,含 (time,id) 游标谓词;
 * requireDeviceOfHousehold 收敛为端口调用;行→DTO 映射与游标编解码留 application)。
 */

/* ------------------------------------------------------------------ */
/* 记录响应契约(openapi components/schemas 权威;T044 定形,T130 收口所有) */
/* ------------------------------------------------------------------ */

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

export function listDevices(householdId: string): DeviceDtoBody[] {
  return listHouseholdDevices(householdId);
}

export interface RevokeDeviceInput {
  ownerPassword: string | undefined;
}

export async function revokeDevice(context: SessionContext, deviceId: string, input: RevokeDeviceInput): Promise<void> {
  requireManagementRole(context);
  await requireParentVerification(context, input.ownerPassword);
  revokeHouseholdDevice(context.session.householdId, deviceId);
}

/**
 * 撤销设备的当次密码验证(013/ADR-0017:撤销设备为不可逆高危操作,保留单次密码;
 * 缺失/空串统一 403 REQUIRED;错误沿用既有计数/锁定)+ 验证后重验会话行
 * (已撤销/过期 401)。仅 revoke 消费;常规查询端点不经过本闸门。
 */
async function requireParentVerification(context: SessionContext, ownerPassword: string | undefined): Promise<void> {
  if (ownerPassword === undefined || ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, ownerPassword);
  const sessionRow = settingsStore().findSessionRowById(context.session.id);
  if (sessionRow === undefined || sessionRow.revokedAt !== null || !(Date.parse(sessionRow.expiresAt) > Date.now())) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, undefined);
  }
}

/* ------------------------------------------------------------------ */
/* 设备播放记录(keyset:(time,id) 倒序;与被收口的 004 控制器同语义)      */
/* ------------------------------------------------------------------ */

export interface DevicePlaybackRecordsInput {
  cursor?: string;
  limit?: number;
}

/** base64url(JSON 外的内部形态);时间/ID 均为库内文本,以 \0 分隔避免歧义 */
function encodeCursor(time: string, id: string): string {
  return Buffer.from(`${time}\u0000${id}`, 'utf8').toString('base64url');
}

/** 畸形/越权构造游标 → 400 VALIDATION_FAILED(不静默当作首页,防绕过分页边界) */
function decodeCursor(cursor: string): { time: string; id: string } {
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

/** (time,id) 倒序全序:time 为 session.created_at / failure.occurred_at(ISO 文本字典序=时间序) */
function compareRecordDesc(a: { id: string; time: string }, b: { id: string; time: string }): number {
  if (a.time !== b.time) {
    return a.time < b.time ? 1 : -1;
  }
  return a.id < b.id ? 1 : -1;
}

function toSessionRecord(row: PlaybackSessionRow): PlaybackSessionRecordDto {
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

function toFailureRecord(row: PlaybackFailureEventRow): PlaybackFailureRecordDto {
  return {
    kind: 'failure',
    id: row.id,
    occurredAt: row.occurredAt,
    stableCode: row.stableCode,
    profileId: row.profileId,
    mediaId: row.mediaId,
  };
}

/** 设备归属重验:不存在/跨家庭统一 404 同形(与随机 id 不可区分,不泄漏存在性/归属) */
function requireDeviceOfHousehold(db: SettingsTxStore, householdId: string, deviceId: string): void {
  const row = db.findDeviceHousehold(deviceId);
  if (row === undefined || row.householdId !== householdId) {
    throw new DomainError(404, ProblemCode.NOT_FOUND);
  }
}

/**
 * 设备播放记录查询仅主账号(继承 004 语义「家长查询仅 owner」:admin 属管理角色但不
 * 放行家长记录查询;与被收口的旧 PlaybackRecordsController.requireOwner 一致)。
 */
function requireOwnerRole(context: SessionContext): void {
  if (context.account.role !== 'owner') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以查询设备播放记录');
  }
}

export async function queryDevicePlaybackRecords(
  context: SessionContext,
  deviceId: string,
  input: DevicePlaybackRecordsInput,
): Promise<PlaybackRecordPageDto> {
  // api.md §7 次序(一般设置主体):Session → 角色(此处 owner-only)→ grant →
  // 严格入参(控制器 StrictBodyPipe)→ 目标归属 → 查询
  // 013/ADR-0017:播放记录查询属常规只读运维,不再要求当次主账号密码。
  requireOwnerRole(context);
  const store = settingsStore();
  requireMainProfileTx(store, context);
  requireDeviceOfHousehold(store, context.session.householdId, deviceId);
  const limit = input.limit ?? 20;
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const householdId = context.session.householdId;

  const sessionRows = store.listPlaybackSessionRows(householdId, deviceId, cursor, limit);
  const failureRows = store.listPlaybackFailureRows(householdId, deviceId, cursor, limit);

  const merged: Array<{ id: string; time: string; item: PlaybackRecordItemDto }> = [
    ...sessionRows.map((row) => ({ id: row.id, time: row.createdAt, item: toSessionRecord(row) })),
    ...failureRows.map((row) => ({ id: row.id, time: row.occurredAt, item: toFailureRecord(row) })),
  ].sort(compareRecordDesc);

  const items = merged.slice(0, limit).map((entry) => entry.item);
  const hasMore = merged.length > limit;
  const last = merged[limit - 1];
  const page: PlaybackRecordPageDto = {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last.time, last.id) : null,
  };
  return page;
}
