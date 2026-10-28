import { randomUUID } from 'node:crypto';
import { ProblemCode } from '@hmp/shared';
import type { Device, NewDevice } from '@platform/database/schema';
import { DomainError } from '@platform/http-common/domain-error';
import { identityAccessStore } from '@contexts/identity-access/application/identity-access-store.port';
import { clearDeviceSessionsProfile } from '@contexts/profile';

/**
 * 设备注册(T019/FR-009):设备身份由服务端记录,不依赖客户端上报的浏览器特征。
 *
 * 策略取舍(契约 LoginRequest 无 deviceId 入参 → 选「每次登录新建 Device 记录」):
 * - 按「类型 + 客户端提供名」去重会把同名同型的两台物理设备误合并为同一 Device,
 *   设备撤销(FR-011/012)将波及无关会话,违背"撤销影响该设备全部会话"的边界;
 * - 无稳定客户端设备标识时逐次新建,保证「一会话 ↔ 一设备」的最小正确性;
 * - 设备合并/改名/复用留待 US3 设备管理(届时由服务端下发并持久化 deviceId)。
 *
 * 008-repository-extraction(T011,ADR-0015 D1):设备/会话读写与撤销事务逐字迁往
 * infrastructure/identity-access-store.drizzle.ts;身份清理经 profile 上下文
 * identity-transition 挂钩(clearDeviceSessionsProfile)以 txHandle() 不透明连接
 * 凭证加入同一事务,调用形态与迁移前一致。
 */
export type DeviceType = 'web' | 'mobile' | 'tv' | 'nas' | 'other';

export interface RegisterDeviceInput {
  householdId: string;
  type: DeviceType;
  name?: string | null;
}

export function registerDevice(input: RegisterDeviceInput): Device {
  const now = new Date().toISOString();
  const row: NewDevice = {
    id: randomUUID(),
    householdId: input.householdId,
    name: input.name ?? null,
    type: input.type,
    lastSeenAt: now,
    revokedAt: null,
    createdAt: now,
  };
  identityAccessStore().insertDevice(row);
  return row as Device;
}

// ---------------------------------------------------------------------------
// US3 设备管理(T035/FR-011/FR-012)
// ---------------------------------------------------------------------------

/** DeviceDto(契约 components/schemas/DeviceDto) */
export interface DeviceDtoBody {
  id: string;
  name: string | null;
  type: DeviceType;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function toDeviceDto(row: Device): DeviceDtoBody {
  return {
    id: row.id,
    name: row.name,
    type: row.type as DeviceType,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

/** GET /devices:当前家庭设备列表(含已撤销,以 revokedAt 标注;边界 FR-006) */
export function listHouseholdDevices(householdId: string): DeviceDtoBody[] {
  return identityAccessStore()
    .listDevicesByHousehold(householdId)
    .map(toDeviceDto);
}

/**
 * POST /devices/{deviceId}/revoke(T035/FR-011/012):
 * - 设备必须属于当前 Household,否则 404(与他家庭「不存在」同形,不泄露存在性);
 * - 事务内:device.revoked_at = now(已撤销则跳过)+ 该设备全部未注销会话
 *   revoked_at = now(立即全量失效);
 * - 身份清理(T052,005 data-model §2,同一事务):按旧档案分组终态化持有身份会话的
 *   活动播放并撤票、撤销设置授予、清空 active_profile_id 并递增
 *   profile_context_version —— 不依赖前端 stop,也不只靠撤销后的后台权限复核兜底;
 * - 幂等:重复调用 204 且无任何写副作用。
 */
export function revokeHouseholdDevice(householdId: string, deviceId: string): void {
  identityAccessStore().withTransaction((tx) => {
    const row = tx.findDeviceRevocationState(deviceId, householdId);
    if (row === undefined) {
      // 不存在 / 属于其他家庭:同形 404,不泄露跨家庭存在性
      throw new DomainError(404, ProblemCode.NOT_FOUND);
    }
    if (row.revokedAt !== null) {
      return; // 幂等:已撤销 no-op
    }
    const identified = tx.listUnrevokedSessionsByDevice(deviceId);
    const now = new Date().toISOString();
    tx.revokeDevice(deviceId, now);
    tx.revokeDeviceSessions(deviceId, now);
    const byProfile = new Map<string, string[]>();
    for (const session of identified) {
      if (session.activeProfileId === null) {
        continue;
      }
      const ids = byProfile.get(session.activeProfileId) ?? [];
      ids.push(session.id);
      byProfile.set(session.activeProfileId, ids);
    }
    for (const [profileId, sessionIds] of byProfile) {
      clearDeviceSessionsProfile(tx.txHandle(), { householdId, deviceSessionIds: sessionIds, profileId });
    }
  });
}
