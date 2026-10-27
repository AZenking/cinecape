/**
 * 统一错误文案映射(T021;006 contracts/data-access.md「错误文案映射」行 + FR-011/017)。
 *
 * 映射链(逐级回退):`errors.{code}` 稳定码词表 → `error.detail` → `error.title`
 * → 通用兜底 '请求失败，请稍后重试'。
 * - `type`(RFC 9457 问题类型 URI)永不直接展示;
 * - `FetchApiError` 保持原样上抛(数据层不吞错、不转字符串),仅 UI 呈现时经本链取文案;
 * - 非 FetchApiError(网络失败/中止)一律落通用兜底,不暴露浏览器原始报文。
 */
import type { ProblemCode } from '@hmp/shared';
import { isFetchApiError } from '../fetch';

/**
 * 稳定错误码 → zh-CN 文案(known ProblemCode 词表的面向观看者子集)。
 * 服务端 `detail` 通常更具体,故此处只收编"detail 缺失或过于技术化"仍需可读文案的码;
 * 未收录的码按映射链落到 detail/title/兜底。
 */
export const PROBLEM_MESSAGES: Partial<Record<ProblemCode, string>> = {
  // ── 身份与会话(005) ──
  INITIALIZATION_ALREADY_DONE: '系统已初始化，请直接登录',
  INVALID_CREDENTIALS: '账号或密码不正确，请重试',
  SESSION_INVALID: '登录状态已失效，请重新登录',
  PROFILE_PIN_REQUIRED: '该档案已上锁，请输入 PIN 解锁',
  PROFILE_PIN_LOCKED: 'PIN 错误次数过多，请稍后再试',
  PROFILE_NOT_SELECTABLE: '该档案当前不可选择',
  LAST_ACTIVE_PROFILE: '至少需要保留一个可用档案',
  ACTIVE_PROFILE_REQUIRED: '请先选择一个档案',
  // ── 通用(001) ──
  NOT_FOUND: '内容不存在或已被移除',
  FORBIDDEN: '没有权限执行此操作',
  VALIDATION_FAILED: '输入内容有误，请检查后重试',
  NOT_READY: '内容尚未就绪，请稍后重试',
  INTERNAL: '服务暂时不可用，请稍后重试',
  // ── 家长验证与策略(002) ──
  PARENT_VERIFICATION_REQUIRED: '需要家长验证后才能继续',
  PARENT_VERIFICATION_FAILED: '家长验证未通过，请重试',
  PARENT_VERIFICATION_LOCKED: '家长验证错误次数过多，请稍后再试',
  POLICY_VERSION_CONFLICT: '策略已被其他设备修改，请刷新后重试',
  POLICY_UNAVAILABLE: '家长策略暂不可用，请稍后重试',
  // ── 来源与目录(003) ──
  SOURCE_VERSION_CONFLICT: '来源已被修改，请刷新后重试',
  MEDIA_VERSION_CONFLICT: '媒体信息已更新，请刷新后重试',
  REFRESH_STATE_CONFLICT: '刷新任务状态已变化，请刷新后重试',
  REFRESH_STALE: '刷新结果已过期，请重新发起',
  SOURCE_BUSY: '来源正忙，请稍后重试',
  IDEMPOTENCY_CONFLICT: '操作正在处理中，请勿重复提交',
  IMPORT_QUEUE_FULL: '导入队列已满，请稍后重试',
  SOURCE_TARGET_DENIED: '目标地址不被允许',
  SOURCE_DISABLED: '来源已停用，请先启用后再试',
  EPG_SOURCE_NOT_READY: 'EPG 来源尚未就绪，请先完成导入',
  EPG_CANDIDATE_INVALID: 'EPG 匹配候选无效，请重新选择',
  EPG_CANDIDATE_STALE: 'EPG 匹配结果已过期，请重新获取',
  EPG_BINDING_VERSION_CONFLICT: 'EPG 绑定已被修改，请刷新后重试',
  // ── 播放(004) ──
  MEDIA_NOT_FOUND: '内容不存在或已被移除',
  PLAYBACK_TICKET_INVALID: '播放凭据无效，请重新播放',
  PLAYBACK_TICKET_EXPIRED: '播放会话已过期，请重新播放',
  PLAYBACK_NOT_FOUND: '播放会话不存在，请重新播放',
  PLAYBACK_NOT_READY: '播放尚未就绪，请稍后重试',
  PLAYBACK_VERSION_CONFLICT: '播放状态已变化，请刷新后重试',
  PLAYBACK_GENERATION_STALE: '播放代次已过期，请重新播放',
  PLAYBACK_ENDED: '播放已结束',
  PLAYBACK_SELECTION_INVALID: '播放选择无效，请重新选择',
  PLAYBACK_SEEK_UNSUPPORTED: '当前内容不支持此进度跳转',
  PLAYBACK_FORMAT_UNSUPPORTED: '当前设备不支持此格式',
  PLAYBACK_CONVERSION_BUSY: '转码进行中，请稍后重试',
  PLAYBACK_STORAGE_LIMIT: '存储空间已达上限',
  PLAYBACK_PERFORMANCE_INSUFFICIENT: '设备性能不足，无法播放此内容',
  PLAYBACK_RESOURCE_UNAVAILABLE: '播放资源不可用，请稍后重试',
  PLAYBACK_PREPARE_TIMEOUT: '播放准备超时，请重试',
  PLAYBACK_SEEK_TIMEOUT: '进度跳转超时，请重试',
  PLAYBACK_RATE_LIMITED: '操作过于频繁，请稍后重试',
};

/** 用户可读文案的通用兜底(映射链终点) */
const FALLBACK_MESSAGE = '请求失败，请稍后重试';

/**
 * FetchApiError → 用户可读文案;非 FetchApiError(网络失败/中止)直接落兜底。
 * 映射链:PROBLEM_MESSAGES[code] → detail → title → 兜底;`type` URI 永不参与。
 */
export function formatApiError(error: unknown): string {
  if (isFetchApiError(error)) {
    if (error.code !== null) {
      const mapped = PROBLEM_MESSAGES[error.code as ProblemCode];
      if (mapped !== undefined) {
        return mapped;
      }
    }
    if (error.detail !== null && error.detail !== '') {
      return error.detail;
    }
    if (error.title !== '') {
      return error.title;
    }
  }
  return FALLBACK_MESSAGE;
}

/** 401 判定:会话失效/未登录;调用方据此分流登出引导(FR-017) */
export function isUnauthorizedError(error: unknown): boolean {
  return isFetchApiError(error) && error.status === 401;
}
