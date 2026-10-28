/**
 * guide 契约问题(T108/T115;contracts/api.md §2、§7):
 *
 * - 409 GUIDE_DATE_EXPIRED 需在 problem+json 中携带 `allowedDates` 扩展字段
 *   (openapi.yaml Problem.additionalProperties:allowedDates:string[];契约
 *   「返回 409 GUIDE_DATE_EXPIRED 和新的 allowedDates」)。DomainError 载荷不含
 *   扩展字段且 common/ 注册表不可扩展(本任务边界),故以领域错误携带完整
 *   problem 体:T023 治理裁决(ADR-0014 修正案)后 domain 零框架 —— 本类为纯
 *   Error 子类,只携载荷、不做任何 HTTP 语义;由唯一 interface 消费方
 *   (public-guide.controller)翻译为 HttpException(problem 体原样、status
 *   不变)。ProblemJsonFilter 对「已含 status+code 的对象」原样透传,
 *   no-store/problem+json 头与既有错误渲染完全一致(对外 HTTP 行为零变化,
 *   契约测试 public-guide.spec 守护)。
 * - 422 GUIDE_WINDOW_TOO_LARGE 无扩展字段,直接用 common 的 DomainError
 *   (注册表默认 title/detail),不在此重复。
 */

const PROBLEM_TYPE_BASE = 'https://homemedia.local/problems';

/** RFC 9457 problem 体(guide 扩展形态);翻译点原样交给 HttpException 透传 */
export interface GuideProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly allowedDates?: readonly string[];
}

/**
 * guide 领域问题错误(T023 领域错误纯化):纯 TS,零框架依赖。
 * 携带完整 problem+json 载荷;status 为载荷冗余别名(沿用原 HttpException
 * 实例属性读取形态,供测试与翻译点免解包取用)。渲染/HTTP 语义全部留在
 * 消费方(interface 层翻译点),本类型不感知框架。
 */
export class GuideProblemError extends Error {
  constructor(readonly problem: GuideProblemBody) {
    super(problem.title);
    this.name = 'GuideProblemError';
  }

  get status(): number {
    return this.problem.status;
  }
}

/** 409 GUIDE_DATE_EXPIRED(allowedDates = 滚动后的新可选范围) */
export class GuideDateExpiredProblem extends GuideProblemError {
  constructor(allowedDates: readonly string[]) {
    super({
      type: `${PROBLEM_TYPE_BASE}/guide-date-expired`,
      title: 'Guide Date Expired',
      status: 409,
      code: 'GUIDE_DATE_EXPIRED',
      detail: '该日期已不在可选范围内,请回到今天重新选择',
      allowedDates,
    });
    this.name = 'GuideDateExpiredProblem';
  }
}
