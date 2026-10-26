/**
 * 策略名单/家长候选共享文案与工具(T052,User Story 3)。
 *
 * - 错误只映射稳定 code 到固定中文文案,不透传 detail/原始上游信息
 *   (003 contracts/api.md「错误」与 UI 脱敏要求);本表登记候选查询与名单保存
 *   (含 409 POLICY_VERSION_CONFLICT、403/423 家长验证语义)的 code,
 *   不改动 components/sources/messages.ts 与 components/catalog/messages.ts;
 * - 候选响应契约不含路径/地址等敏感字段,展示层也不拼接任何敏感信息。
 */
import { ApiError } from '../../lib/api';

/** 候选查询与名单保存的稳定错误码 → 友好文案(仅覆盖契约登记的 code) */
const POLICY_LISTS_PROBLEM_MESSAGES: Record<string, string> = {
  POLICY_VERSION_CONFLICT: '策略已更新，请重新加载。',
  PARENT_VERIFICATION_REQUIRED: '请输入主账号密码完成验证。',
  PARENT_VERIFICATION_FAILED: '主账号密码验证未通过，请重试。',
  PARENT_VERIFICATION_LOCKED: '验证失败次数过多，已临时锁定，请稍后再试。',
  VALIDATION_FAILED: '输入未通过校验，请检查所选资源与名单后重试。',
  NOT_FOUND: '目标档案不存在或不属于当前家庭。',
  FORBIDDEN: '当前账号无权执行此操作。',
  POLICY_UNAVAILABLE: '观看策略暂不可用，请稍后重试。',
  INTERNAL: '服务暂时不可用，请稍后重试。',
};

/**
 * 把任意错误转为可安全展示的中文文案:
 * - 401 统一提示重新登录(会话恢复由 SessionProvider/路由守卫接管);
 * - 已登记 code → 固定文案;其余(含未知 detail)一律用兜底文案,不渲染上游细节。
 */
export function friendlyPolicyErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return '登录状态已失效，请重新登录。';
    }
    if (error.code !== undefined) {
      const mapped = POLICY_LISTS_PROBLEM_MESSAGES[error.code];
      if (mapped !== undefined) {
        return mapped;
      }
    }
  }
  return fallback;
}
