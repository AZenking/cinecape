/**
 * 观看目录共享文案与工具(T037/T038,User Story 2)。
 *
 * - 错误只映射稳定 code 到固定中文文案,不透传 detail/原始上游信息
 *   (003 contracts/api.md「错误」与 UI 脱敏要求);US2 语义的
 *   ACTIVE_PROFILE_REQUIRED/POLICY_UNAVAILABLE/NOT_FOUND 在此登记,
 *   不改动 components/sources/messages.ts;
 * - 媒体类型/分级标签与节目起止时间格式化供目录页与详情页共用。
 */
import { ApiError } from '../../lib/api';
import type { MediaDto } from '@hmp/shared';

/** 媒体类型(契约 Media.type) */
export type MediaType = MediaDto['type'];

/** 媒体类型中文标签(类型徽标文案) */
export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  channel: '频道',
  movie: '电影',
  series: '剧集',
  episode: '分集',
  video: '视频',
};

/** 403 语义码:当前会话未选择观看档案(UI 引导去档案选择页) */
export const CODE_ACTIVE_PROFILE_REQUIRED = 'ACTIVE_PROFILE_REQUIRED';

/** 分级标签:null 为「未评级」;0-18 为「N+」风格(契约 contentLevel 语义) */
export function contentLevelLabel(contentLevel: number | null): string {
  return contentLevel === null ? '未评级' : `${contentLevel}+`;
}

/** 分级徽标颜色:未评级中性,已评级用警示色(文字为主,颜色仅强化) */
export function contentLevelChipColor(contentLevel: number | null): 'default' | 'warning' {
  return contentLevel === null ? 'default' : 'warning';
}

/** 观看目录/详情接口的稳定错误码 → 友好文案(仅覆盖契约登记的 US2 code) */
const CATALOG_PROBLEM_MESSAGES: Record<string, string> = {
  ACTIVE_PROFILE_REQUIRED: '请先选择观看档案。',
  POLICY_UNAVAILABLE: '观看策略暂不可用，请稍后重试。',
  NOT_FOUND: '内容不存在或当前档案不可见。',
  FORBIDDEN: '当前账号无权查看此内容。',
  VALIDATION_FAILED: '搜索条件未通过校验，请调整后重试。',
  INTERNAL: '服务暂时不可用，请稍后重试。',
};

/**
 * 把任意错误转为可安全展示的中文文案:
 * - 401 统一提示重新登录(会话恢复由 SessionProvider/路由守卫接管);
 * - 已登记 code → 固定文案;其余(含未知 detail)一律用兜底文案,不渲染上游细节。
 */
export function friendlyCatalogErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return '登录状态已失效，请重新登录。';
    }
    if (error.code !== undefined) {
      const mapped = CATALOG_PROBLEM_MESSAGES[error.code];
      if (mapped !== undefined) {
        return mapped;
      }
    }
  }
  return fallback;
}

/**
 * 节目起止时间展示:同日「HH:mm–HH:mm」,跨日「MM-DD HH:mm–HH:mm」。
 * 按「家庭时区展示」渲染:单家庭局域网部署下家庭时区即浏览器本地时区,
 * 直接用本地 Intl.DateTimeFormat 格式化即可(服务端存储仍为 UTC)。
 * 非法/缺失时间显示「—」(与全站 formatDateTime 的兜底风格一致)。
 */
export function formatProgrammeRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return '—';
  }
  const timeFormat = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) {
    return `${timeFormat.format(start)}–${timeFormat.format(end)}`;
  }
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' });
  return `${dateFormat.format(start)} ${timeFormat.format(start)}–${timeFormat.format(end)}`;
}
