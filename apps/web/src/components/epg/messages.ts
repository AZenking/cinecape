/**
 * EPG 手动匹配共享文案与工具(T072,User Story 5)。
 *
 * - 错误只映射稳定 code 到固定中文文案,不透传 detail/原始上游信息
 *   (003 contracts/api.md「错误」与 UI 脱敏要求);与 components/sources/messages.ts、
 *   components/catalog/messages.ts 的登记表互相独立,不跨域共用;
 * - 绑定状态/失效原因文案(契约 EpgBinding.status/invalidReason):invalid 不回退,
 *   固定提示「保留配置,恢复后自动生效」,不提供自动回退入口(FR-025);
 * - 409/422/403 稳定码另以常量导出,供对话框按语义分流(清候选/提示重开等),
 *   文案本身仍集中在下方登记表,不在组件内散落硬编码。
 */
import { ApiError } from '../../lib/api';
import type { EpgBindingDto } from '@hmp/shared';

/** 409:绑定版本冲突(绑定已被其他操作更新,须重新查询绑定后再操作) */
export const CODE_EPG_BINDING_VERSION_CONFLICT = 'EPG_BINDING_VERSION_CONFLICT';

/** 409:候选已过期(EPG 已更新,保存所带 generation 旧于服务端,须重查候选) */
export const CODE_EPG_CANDIDATE_STALE = 'EPG_CANDIDATE_STALE';

/** invalid 原因中文文案(契约 invalidReason 三态;null 不展示) */
export const EPG_INVALID_REASON_LABELS: Record<
  Exclude<EpgBindingDto['invalidReason'], null>,
  string
> = {
  source_disabled: '目标 EPG 源已停用',
  channel_missing: '目标频道在 EPG 中不存在',
  channel_conflict: '目标频道数据冲突',
};

/** 手动绑定失效时的固定提示(FR-025:保留配置、不静默回退、目标恢复即重新生效) */
export const EPG_INVALID_RETAINED_HINT = '已保留该配置，目标恢复后自动生效；不会自动回退到其他 EPG，可解除绑定恢复自动匹配。';

/** 绑定模式+状态的一行中文摘要(对话框「当前绑定」区标题) */
export function bindingModeStatusText(binding: EpgBindingDto): string {
  if (binding.mode === 'auto') {
    return '自动匹配';
  }
  return binding.status === 'invalid' ? '手动绑定(已失效)' : '手动绑定(生效中)';
}

/**
 * 手动 EPG 匹配的稳定错误码 → 友好文案(仅覆盖契约登记的 code):
 * - 409 两码:EPG_BINDING_VERSION_CONFLICT / EPG_CANDIDATE_STALE;
 * - 422 两码:EPG_SOURCE_NOT_READY / EPG_CANDIDATE_INVALID;
 * - 403 三态:FORBIDDEN / PARENT_VERIFICATION_REQUIRED / PARENT_VERIFICATION_FAILED
 *   (另含 423 PARENT_VERIFICATION_LOCKED,同一验证链路一并登记);
 * - 通用:VALIDATION_FAILED / NOT_FOUND / INTERNAL。
 */
const EPG_PROBLEM_MESSAGES: Record<string, string> = {
  EPG_BINDING_VERSION_CONFLICT: '绑定已被其他操作更新，请重新打开后重试。',
  EPG_CANDIDATE_STALE: 'EPG 已更新，请重新查询候选。',
  EPG_SOURCE_NOT_READY: '该 EPG 来源未启用或尚未成功导入，请先在来源管理完成刷新。',
  EPG_CANDIDATE_INVALID: '目标频道不可用或已失效，请重新选择候选。',
  FORBIDDEN: '当前账号无权执行此操作。',
  PARENT_VERIFICATION_REQUIRED: '请输入主账号密码完成验证。',
  PARENT_VERIFICATION_FAILED: '主账号密码验证未通过，请重试。',
  PARENT_VERIFICATION_LOCKED: '验证失败次数过多，已临时锁定，请稍后再试。',
  VALIDATION_FAILED: '输入未通过校验，请检查后重试。',
  NOT_FOUND: '目标不存在或不属于当前家庭。',
  INTERNAL: '服务暂时不可用，请稍后重试。',
};

/**
 * 把任意错误转为可安全展示的中文文案:
 * - 401 统一提示重新登录(会话恢复由 SessionProvider/路由守卫接管);
 * - 已登记 code → 固定文案;其余(含未知 detail)一律用兜底文案,不渲染上游细节。
 */
export function friendlyEpgMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return '登录状态已失效，请重新登录。';
    }
    if (error.code !== undefined) {
      const mapped = EPG_PROBLEM_MESSAGES[error.code];
      if (mapped !== undefined) {
        return mapped;
      }
    }
  }
  return fallback;
}
