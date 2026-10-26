import type { ProblemCode } from '@hmp/shared';

/**
 * 领域错误 —— 携带 HTTP status 与稳定 ProblemCode(shared 契约常量),
 * 由 ProblemJsonFilter 统一渲染为 RFC 9457 application/problem+json。
 */
export class DomainError extends Error {
  constructor(
    public status: number,
    public code: ProblemCode,
    public detail?: string,
  ) {
    super(detail ?? code);
    this.name = 'DomainError';
  }
}

/** 单个错误码的 RFC 9457 默认映射(T011,对照 003 contracts/api.md 错误节) */
export interface DomainProblemSpec {
  readonly status: number;
  readonly title: string;
  /**
   * 缺省 detail 模板 —— 仅含稳定业务语义,
   * 禁止携带上游原始数据(报文/URL/物理路径/凭据等)。
   */
  readonly detail?: string;
  /** ProblemJsonFilter 按 code 统一注入的响应头(如 429 的 Retry-After) */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 领域错误码注册表 —— code → status/title/detail/headers。
 * - 003 媒体目录:409:SOURCE_VERSION_CONFLICT、MEDIA_VERSION_CONFLICT、POLICY_VERSION_CONFLICT(阶段 2 已有常量)、
 *   REFRESH_STATE_CONFLICT、REFRESH_STALE、SOURCE_BUSY、IDEMPOTENCY_CONFLICT、
 *   EPG_CANDIDATE_STALE、EPG_BINDING_VERSION_CONFLICT(US5 手动 EPG 绑定增补);
 *   429:IMPORT_QUEUE_FULL(附 Retry-After: 5);422:SOURCE_TARGET_DENIED、SOURCE_DISABLED;
 *   422:EPG_SOURCE_NOT_READY、EPG_CANDIDATE_INVALID(US5 T071)。
 * - 004 播放稳定码(T012,contracts/api.md「稳定错误」节):见下方「阶段 4」注释块。
 * 注册表外的既有错误码不在此登记,渲染行为保持不变。
 */
export const DOMAIN_PROBLEM_REGISTRY = {
  SOURCE_VERSION_CONFLICT: {
    status: 409,
    title: 'Source Version Conflict',
    detail: '来源配置已被其他操作修改,请刷新后重试',
  },
  MEDIA_VERSION_CONFLICT: {
    status: 409,
    title: 'Media Version Conflict',
    detail: '媒体条目已被其他操作修改,请刷新后重试',
  },
  POLICY_VERSION_CONFLICT: {
    status: 409,
    title: 'Policy Version Conflict',
    detail: '策略已被其他会话修改,请重新加载',
  },
  REFRESH_STATE_CONFLICT: {
    status: 409,
    title: 'Refresh State Conflict',
    detail: '刷新任务已进入终态,不能重复执行该操作',
  },
  REFRESH_STALE: {
    status: 409,
    title: 'Refresh Stale',
    detail: '来源或目录基线已变化,请重新加载后重试',
  },
  SOURCE_BUSY: {
    status: 409,
    title: 'Source Busy',
    detail: '该来源已有进行中的刷新任务,请等待完成',
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    title: 'Idempotency Conflict',
    detail: 'operationKey 已被语义不同的请求使用',
  },
  IMPORT_QUEUE_FULL: {
    status: 429,
    title: 'Import Queue Full',
    detail: '导入队列已满,请稍后重试',
    headers: { 'Retry-After': '5' },
  },
  SOURCE_TARGET_DENIED: {
    status: 422,
    title: 'Source Target Denied',
    detail: '远程地址或挂载目标不在许可范围内',
  },
  SOURCE_DISABLED: {
    status: 422,
    title: 'Source Disabled',
    detail: '来源已停用,无法发起刷新',
  },
  /**
   * US5 增补(ADR-0008,data-model「## 0004 增补」/contracts api.md「EPG 手动匹配增补」):
   * 两个 409 绑定冲突码 —— detail 均为静态脱敏文案,不携带候选 ID/来源位置等私有信息。
   */
  EPG_CANDIDATE_STALE: {
    status: 409,
    title: 'Epg Candidate Stale',
    detail: '候选指南已刷新,请重新查询候选后重试',
  },
  EPG_BINDING_VERSION_CONFLICT: {
    status: 409,
    title: 'Epg Binding Version Conflict',
    detail: '绑定已被其他操作修改,请重新加载后重试',
  },
  /**
   * US5 T071(003 contracts/api.md「EPG 手动匹配增补」错误表):
   * 候选来源未启用/从未成功导入 → 422 EPG_SOURCE_NOT_READY;
   * 同家庭来源内目标频道不存在/冲突 → 422 EPG_CANDIDATE_INVALID(重查也无法成功,不引导 409 循环)。
   */
  EPG_SOURCE_NOT_READY: {
    status: 422,
    title: 'Epg Source Not Ready',
    detail: '候选来源未启用或尚未成功导入,暂不能使用',
  },
  EPG_CANDIDATE_INVALID: {
    status: 422,
    title: 'Epg Candidate Invalid',
    detail: '候选频道在该 EPG 来源中无效,请重新查询候选',
  },
  /**
   * 阶段 4(004 contracts/api.md「稳定错误」节,T012):播放稳定码接入,与 T011 词表一致。
   * - status 逐一对照契约:401 票据无效/过期;404 媒体不可见同形(MEDIA_NOT_FOUND)与会话
   *   非本设备(PLAYBACK_NOT_FOUND);409 未就绪/版本冲突/代次过期/已结束;
   *   400 选择无效/定位不支持;422 格式不支持;503 转换忙/存储上限/性能不足/资源不可用;
   *   504 准备超时/定位超时;429 限流;
   * - detail 均为静态脱敏文案:不携带源路径/URL/上游诊断(research R6);
   * - PLAYBACK_RATE_LIMITED 的 Retry-After 由限流接线(T031+)按窗口余量动态计算,
   *   不在注册表给静态值(维持「全注册表仅 IMPORT_QUEUE_FULL 携带静态附加头」不变);
   * - SESSION_INVALID(401)/ACTIVE_PROFILE_REQUIRED(403)复用既有码,不进注册表,渲染不变。
   */
  MEDIA_NOT_FOUND: {
    status: 404,
    title: 'Media Not Found',
    detail: '媒体不存在或当前不可见',
  },
  PLAYBACK_TICKET_INVALID: {
    status: 401,
    title: 'Playback Ticket Invalid',
    detail: '播放票据无效,请重新申请',
  },
  PLAYBACK_TICKET_EXPIRED: {
    status: 401,
    title: 'Playback Ticket Expired',
    detail: '播放票据已过期,请重新申请',
  },
  PLAYBACK_NOT_FOUND: {
    status: 404,
    title: 'Playback Not Found',
    detail: '播放会话不存在或不属于当前设备',
  },
  PLAYBACK_NOT_READY: {
    status: 409,
    title: 'Playback Not Ready',
    detail: '播放会话尚未准备就绪,请稍后重试',
  },
  PLAYBACK_VERSION_CONFLICT: {
    status: 409,
    title: 'Playback Version Conflict',
    detail: '会话版本已被其他操作修改,请刷新后重试',
  },
  PLAYBACK_GENERATION_STALE: {
    status: 409,
    title: 'Playback Generation Stale',
    detail: '播放代次已更新,请以最新代次重试',
  },
  PLAYBACK_ENDED: {
    status: 409,
    title: 'Playback Ended',
    detail: '播放会话已结束,不能继续该操作',
  },
  PLAYBACK_SELECTION_INVALID: {
    status: 400,
    title: 'Playback Selection Invalid',
    detail: '轨道选择无效,只能引用已探测的轨道',
  },
  PLAYBACK_SEEK_UNSUPPORTED: {
    status: 400,
    title: 'Playback Seek Unsupported',
    detail: '该内容不支持定位操作',
  },
  PLAYBACK_FORMAT_UNSUPPORTED: {
    status: 422,
    title: 'Playback Format Unsupported',
    detail: '媒体格式不受支持,无法交付',
  },
  PLAYBACK_CONVERSION_BUSY: {
    status: 503,
    title: 'Playback Conversion Busy',
    detail: '转码额度已满,请稍后重试',
  },
  PLAYBACK_STORAGE_LIMIT: {
    status: 503,
    title: 'Playback Storage Limit',
    detail: '存储预算不足,已停止新的转换',
  },
  PLAYBACK_PERFORMANCE_INSUFFICIENT: {
    status: 503,
    title: 'Playback Performance Insufficient',
    detail: '转码性能不足,无法维持实时播放',
  },
  PLAYBACK_RESOURCE_UNAVAILABLE: {
    status: 503,
    title: 'Playback Resource Unavailable',
    detail: '播放资源当前不可用,请稍后重试',
  },
  PLAYBACK_PREPARE_TIMEOUT: {
    status: 504,
    title: 'Playback Prepare Timeout',
    detail: '播放准备超时,请重试',
  },
  PLAYBACK_SEEK_TIMEOUT: {
    status: 504,
    title: 'Playback Seek Timeout',
    detail: '定位准备超时,请重试',
  },
  PLAYBACK_RATE_LIMITED: {
    status: 429,
    title: 'Playback Rate Limited',
    detail: '操作过于频繁,请稍后重试',
  },
} as const satisfies Partial<Record<ProblemCode, DomainProblemSpec>>;

/** 注册表覆盖的错误码(003 catalog 契约码 + 004 播放稳定码;可据此获得 status 免重复硬编码的构造) */
export type CatalogProblemCode = keyof typeof DOMAIN_PROBLEM_REGISTRY;

/** 注册表外的既有码返回 undefined(渲染沿用既有推导,行为不变) */
export function resolveDomainProblem(code: ProblemCode): DomainProblemSpec | undefined {
  const lookup = DOMAIN_PROBLEM_REGISTRY as Partial<Record<ProblemCode, DomainProblemSpec>>;
  return lookup[code];
}

/** 按注册表默认映射构造 DomainError;可覆盖 detail(不得携带上游原始数据) */
export function createDomainError(code: CatalogProblemCode, detail?: string): DomainError {
  const spec = DOMAIN_PROBLEM_REGISTRY[code];
  return new DomainError(spec.status, code, detail ?? spec.detail);
}
