/**
 * 认证/会话端点数据访问(T026;006 contracts/data-access.md 分层不变式)。
 *
 * - 登录、初始化、首建主档案、PIN 恢复、会话恢复/登出的唯一端点出口:
 *   统一收口到本模块,features/auth 各步骤与 app/session-provider 只经此处触网,
 *   传输一律 `privateFetch`(credentials:'same-origin'——登录/首建等 Set-Cookie
 *   流程必须同源携带与接收 Cookie,不得改用 publicFetch 的 omit 档);
 * - 敏感动作语义(登录/首建/PIN 恢复)= `confirmed`(契约 mutation 契约行):
 *   等待态由调用方本地 busy 门控,无乐观写、无查询缓存参与;
 * - 密码/PIN/会话令牌只经参数进请求体,本模块不存储、不缓存、不写 localStorage
 *   (宪法原则三/六;遗留 lib/session.ts 的 Bearer 备用通道已废弃,不再复刻);
 * - 错误保持 `FetchApiError` 原样上抛(数据层不吞错、不转字符串),文案由
 *   各表单步骤按 status/code/detail 呈现(内联 FormError,错误映射链同
 *   shared/query/error.ts 的语义但不经 toast —— 表单内联错误为现行交互契约);
 * - 未走 useAppQuery/useAppMutation 的理由(记录,避免后人误改):
 *   1) shared/query/keys.ts 键工厂(本任务只读)无认证/会话键,手写键违反
 *      「唯一键来源」不变式;凭据类数据也不得进入查询缓存(原则三);
 *   2) useAppMutation 强制 toast 错误呈现,与既有步骤内联 FormError 交互冲突;
 *      契约「单表面积简单变更优先 UI variables + isPending 变体」即本形态。
 */
import { privateFetch } from '../../shared/fetch';
import type { AccountSession, InitializedReply, ProfileSummary } from '../../app/session-types';

/** 登录输入(密码仅经此进请求体;调用方不落任何持久存储) */
export interface LoginInput {
  /** 用户名(调用方负责 trim) */
  username: string;
  /** 明文密码(仅表单内存 → 请求体) */
  password: string;
}

/**
 * POST /auth/login:显式登录(FR-007)。
 * 成功返回含 bootstrapRequired 的 AccountSession(服务端 Set-Cookie 同源写入);
 * 401 = 凭据错误(INVALID_CREDENTIALS),由步骤统一提示、不区分账号存在性。
 */
export function loginRequest(input: LoginInput): Promise<AccountSession> {
  return privateFetch<AccountSession>('/auth/login', {
    method: 'POST',
    body: { username: input.username, password: input.password, deviceType: 'web' },
  });
}

/** 初始化输入(仅家庭与主账号基础;契约 strictObject,多余字段服务端 400) */
export interface SetupInitializeInput {
  /** 家庭名称(调用方负责 trim) */
  householdName: string;
  /** 管理员用户名(调用方负责 trim) */
  username: string;
  /** 明文密码(仅表单内存 → 请求体) */
  password: string;
}

/**
 * POST /setup/initialize:首次部署配置(FR-006)。
 * 201 仅建家庭与账号、不自动登录;409 = 已初始化;503 = 状态未知(不开放配置)。
 * 档位说明:当前实现即为 privateFetch(同源档),本迁移不改凭据档位 ——
 * 该端点虽为部署前匿名地址,但改档属行为变更,保持现状(与现行行为逐字一致)。
 */
export function initializeSetup(input: SetupInitializeInput): Promise<InitializedReply> {
  return privateFetch<InitializedReply>('/setup/initialize', {
    method: 'POST',
    body: { householdName: input.householdName, username: input.username, password: input.password },
  });
}

/** 首建主档案输入(客户端先行校验名称与 6 位数字 PIN 后才调用) */
export interface BootstrapProfileInput {
  /** 档案名称(调用方负责 trim) */
  name: string;
  /** 6 位数字 PIN(仅表单内存 → 请求体) */
  pin: string;
  /** 当次账号密码(每次都需服务端重验,不缓存 —— FR-030/ADR-0011) */
  ownerPassword: string;
}

/**
 * POST /auth/bootstrap-profile:零档案会话创建成人主 Profile(FR-030)。
 * 成功返回新建 ProfileSummary(服务端不设置 active_profile_id,不自动激活);
 * 409 = 已有档案;403 = 密码验证失败;423 = 密码验证锁定(计数在服务端)。
 */
export function bootstrapMainProfile(input: BootstrapProfileInput): Promise<ProfileSummary> {
  return privateFetch<ProfileSummary>('/auth/bootstrap-profile', {
    method: 'POST',
    body: { name: input.name, pin: input.pin, ownerPassword: input.ownerPassword },
  });
}

/** 主档案 PIN 恢复输入(受限入口:当前账号密码 + 新 6 位 PIN) */
export interface PinRecoveryInput {
  /** 新 6 位数字 PIN(仅表单内存 → 请求体) */
  newPin: string;
  /** 当次账号密码(当次验证,服务端计数,不缓存) */
  ownerPassword: string;
}

/**
 * POST /auth/main-profile/pin-recovery:重设主档案 PIN(FR-030/ADR-0011 决议 6)。
 * 契约 204 无内容;成功后服务端已撤销一切旧选档授予,需用新 PIN 重新验证;
 * 403 = 密码验证失败;423 = 密码验证锁定(计数在服务端,客户端仅呈现)。
 */
export function recoverMainProfilePin(input: PinRecoveryInput): Promise<void> {
  return privateFetch<void>('/auth/main-profile/pin-recovery', {
    method: 'POST',
    body: { newPin: input.newPin, ownerPassword: input.ownerPassword },
  });
}

/**
 * GET /auth/session:启动恢复/回读服务端会话(服务端是唯一信任源,research D5)。
 * 返回形态不含 sessionToken(令牌在 httpOnly Cookie);401 = 无会话/已失效,
 * 由调用方(SessionProvider)按 restoring→anonymous 收敛,不经全局 401 引导。
 */
export function fetchSession(): Promise<AccountSession> {
  return privateFetch<AccountSession>('/auth/session');
}

/**
 * POST /auth/logout:幂等登出(契约 204)。
 * 网络失败由调用方忽略并照常清空本地(不阻断退出);本模块不处理任何本地状态。
 */
export function logoutRequest(): Promise<void> {
  return privateFetch<void>('/auth/logout', { method: 'POST' });
}
