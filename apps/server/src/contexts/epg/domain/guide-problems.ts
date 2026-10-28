import { HttpException } from '@nestjs/common';

/**
 * guide 契约问题(T108/T115;contracts/api.md §2、§7):
 *
 * - 409 GUIDE_DATE_EXPIRED 需在 problem+json 中携带 `allowedDates` 扩展字段
 *   (openapi.yaml Problem.additionalProperties:allowedDates:string[];契约
 *   「返回 409 GUIDE_DATE_EXPIRED 和新的 allowedDates」)。DomainError 载荷不含
 *   扩展字段且 common/ 注册表不可扩展(本任务边界),故以 HttpException 携带
 *   完整 problem 体:ProblemJsonFilter 对「已含 status+code 的对象」原样透传,
 *   no-store/problem+json 头与既有错误渲染完全一致。
 * - 422 GUIDE_WINDOW_TOO_LARGE 无扩展字段,直接用 common 的 DomainError
 *   (注册表默认 title/detail),不在此重复。
 */

const PROBLEM_TYPE_BASE = 'https://homemedia.local/problems';

interface GuideProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly allowedDates?: readonly string[];
}

/** 409 GUIDE_DATE_EXPIRED(allowedDates = 滚动后的新可选范围) */
export class GuideDateExpiredProblem extends HttpException {
  constructor(allowedDates: readonly string[]) {
    const body: GuideProblemBody = {
      type: `${PROBLEM_TYPE_BASE}/guide-date-expired`,
      title: 'Guide Date Expired',
      status: 409,
      code: 'GUIDE_DATE_EXPIRED',
      detail: '该日期已不在可选范围内,请回到今天重新选择',
      allowedDates,
    };
    super(body, 409);
  }
}
