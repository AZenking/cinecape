/**
 * US2 会话契约类型(T040;005 contracts/api.md §3、data-model §9)。
 *
 * 仅 type 层本地镜像(契约:B001ProfileDto / B001SessionDto),不改动 packages/shared
 * 的导出面 —— US2 前端按白名单字段逐字声明,服务端 DTO 即此形状:
 * - ProfileSummary:id、name、avatar、type、isDefault、isMain、pinProtected、
 *   status、createdAt、version;
 * - AccountSession:sessionId、account(id/username/role)、activeProfile、expiresAt、
 *   householdId、bootstrapRequired、profileContextVersion;sessionToken 仅登录响应
 *   出现一次(本 Provider 仅经 /auth/session 恢复,不含该字段)。
 */

/** 契约 B001ProfileDto(选档/首建/会话共用的 ProfileSummary 投影) */
export interface ProfileSummary {
  id: string;
  name: string;
  avatar: string | null;
  type: 'adult' | 'child';
  isDefault: boolean;
  isMain: boolean;
  pinProtected: boolean;
  status: 'active' | 'disabled';
  createdAt: string;
  version: number;
}

/** 契约 B001SessionDto(不含 sessionToken 的恢复形态) */
export interface AccountSession {
  sessionId: string;
  account: { id: string; username: string; role: 'owner' | 'admin' };
  activeProfile: ProfileSummary | null;
  expiresAt: string;
  householdId: string;
  bootstrapRequired: boolean;
  profileContextVersion: number;
}

/** GET /setup/status 响应(契约 Initialized) */
export interface SetupStatus {
  initialized: boolean;
}

/** 契约 Initialized(POST /setup/initialize 201 响应) */
export interface InitializedReply {
  initialized: true;
}
