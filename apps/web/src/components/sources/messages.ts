/**
 * 来源管理页共享文案与工具(T030)。
 *
 * - 错误只映射稳定 code 到固定中文文案,不透传 detail/原始上游信息
 *   (003 contracts/api.md「错误」与 UI 脱敏要求);
 * - kind / 任务状态 / 待确认原因的展示标签与图标:状态反馈为「文字 + 图标」,
 *   不依赖颜色 alone(键盘可操作惯例的一部分)。
 */
import { ApiError } from '../../lib/api';
import type { RefreshDto, SourceDto } from '@hmp/shared';

/** 来源类型(契约 Source.kind) */
export type SourceKind = SourceDto['kind'];

/** 刷新任务状态(契约 Refresh.status) */
export type RefreshStatus = RefreshDto['status'];

/** 来源类型中文标签(类型徽标文案) */
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  iptv: 'IPTV',
  epg: 'EPG',
  nas: 'NAS',
};

/** 任务状态中文文案 */
export const REFRESH_STATUS_LABELS: Record<RefreshStatus, string> = {
  queued: '排队中',
  running: '执行中',
  awaiting_confirmation: '待确认',
  succeeded: '成功',
  failed: '失败',
  interrupted: '已中断',
  discarded: '已丢弃',
  expired: '已过期',
  stale: '已失效',
};

/** 任务状态前缀图标(与文字配合,颜色之外的第二通道) */
export const REFRESH_STATUS_ICONS: Record<RefreshStatus, string> = {
  queued: '…',
  running: '◐',
  awaiting_confirmation: '!',
  succeeded: '✓',
  failed: '✕',
  interrupted: '⚠',
  discarded: '—',
  expired: '⌛',
  stale: '⚠',
};

/** 待确认原因文案(契约 confirmationReason) */
export function confirmationReasonText(reason: RefreshDto['confirmationReason']): string {
  switch (reason) {
    case 'empty_snapshot':
      return '快照为空';
    case 'deletion_ratio_exceeded':
      return '缺失比例达到 25%';
    default:
      return '需要人工确认';
  }
}

/** EPG 表单副标题(FR-018):首次保存后用刷新完成导入,无单独导入/连通性检查入口 */
export const EPG_IMPORT_HINT = '首次保存后使用「刷新」完成节目指南导入；不提供单独的导入或连通性检查入口。';

/** IPTV 关联已停用 EPG 的提示(契约允许关联禁用 EPG,观看时显示「暂无节目」) */
export const EPG_DISABLED_ASSOCIATION_HINT = '该 EPG 已停用，观看时将显示暂无节目；可以正常保存。';

/**
 * 稳定错误码 → 友好文案。仅覆盖契约登记的 code;
 * 未知 code 一律落到调用方传入的兜底文案,不显示原始错误细节。
 */
const PROBLEM_MESSAGES: Record<string, string> = {
  SOURCE_VERSION_CONFLICT: '配置已更新，请刷新后重试。',
  REFRESH_STATE_CONFLICT: '任务状态已变化，请刷新列表后重试。',
  REFRESH_STALE: '目录基线已变化，该任务已失效，请重新发起刷新。',
  SOURCE_BUSY: '该来源已有任务在执行，请等待完成后再试。',
  IDEMPOTENCY_CONFLICT: '刷新请求与之前的请求冲突，请重新发起。',
  IMPORT_QUEUE_FULL: '任务队列已满，请稍后再试。',
  SOURCE_DISABLED: '来源已停用，启用后才能刷新。',
  SOURCE_TARGET_DENIED: '远程地址或挂载目标不可用或未获授权，请检查来源配置。',
  VALIDATION_FAILED: '输入未通过校验，请检查后重试。',
  NOT_FOUND: '目标不存在或不属于当前家庭。',
  FORBIDDEN: '当前账号无权执行此操作。',
  PARENT_VERIFICATION_REQUIRED: '请输入主账号密码完成验证。',
  PARENT_VERIFICATION_FAILED: '主账号密码验证未通过，请重试。',
  PARENT_VERIFICATION_LOCKED: '验证失败次数过多，已临时锁定，请稍后再试。',
  INTERNAL: '服务暂时不可用，请稍后重试。',
};

/**
 * 把任意错误转为可安全展示的中文文案:
 * - 401 统一提示重新登录(会话恢复由 SessionProvider/路由守卫接管);
 * - 已登记 code → 固定文案;其余(含未知 detail)一律用兜底文案,不渲染上游细节。
 */
export function friendlyErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return '登录状态已失效，请重新登录。';
    }
    if (error.code !== undefined) {
      const mapped = PROBLEM_MESSAGES[error.code];
      if (mapped !== undefined) {
        return mapped;
      }
    }
    return fallback;
  }
  return fallback;
}

/** 刷新任务失败(errorCode)的友好文案;未知 code 不展示原始细节 */
export function jobFailureMessage(errorCode: string | null): string {
  if (errorCode !== null) {
    const mapped = PROBLEM_MESSAGES[errorCode];
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return '刷新失败，已保留上次成功目录；请检查来源配置后重试。';
}

/** date-time → 本地化展示;空/非法值显示「—」(与 Devices 页一致) */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

/**
 * 按 kind 取相关性的 counts 展示项(003 contracts/api.md「刷新与待确认」):
 * - IPTV:新增/更新/不可用/失败/频道;EPG:频道/节目;NAS:新增/更新/不可用/失败。
 */
export function jobCountEntries(
  kind: SourceKind | undefined,
  counts: RefreshDto['counts'],
): Array<{ label: string; value: number }> {
  if (kind === 'epg') {
    return [
      { label: '频道', value: counts.channels },
      { label: '节目', value: counts.programmes },
    ];
  }
  const entries = [
    { label: '新增', value: counts.added },
    { label: '更新', value: counts.updated },
    { label: '不可用', value: counts.missing },
    { label: '失败', value: counts.failed },
  ];
  if (kind === 'iptv') {
    entries.push({ label: '频道', value: counts.channels });
  }
  return entries;
}
