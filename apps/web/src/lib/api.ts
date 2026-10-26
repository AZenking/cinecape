/**
 * 类型化 API 客户端(T014)。
 *
 * - 契约单一事实源:`docs/specs/001-scaffold-identity-foundation/contracts/openapi.yaml`,
 *   经 openapi-typescript 生成为 `packages/shared/src/schema.d.ts`。
 * - 契约类型经工作区依赖 `@hmp/shared`(`workspace:*`)引入,仅作
 *   `import type`(构建期擦除,零运行时代价)。
 * - 传输通道(research D5):httpOnly Cookie 为主(`credentials: 'include'`);
 *   若本地存有一次性 sessionToken,则附带 `Authorization: Bearer` 作为备用通道。
 */
import type { components, paths, PolicyDto, UpdatePolicyRequest } from '@hmp/shared';
import type { ProblemCode } from '@hmp/shared';
// 阶段 3 契约类型(T029;独立生成产物 catalog-schema.d.ts,经 @hmp/shared 转出口,仅 type import)
import type {
  CandidatePageDto,
  CandidateQueryRequest,
  CreateSourceRequest,
  EpgBindingDto,
  EpgBindingQueryRequest,
  EpgCandidatePageDto,
  EpgCandidateQueryRequest,
  JobAction,
  MediaDto,
  MediaPageDto,
  PatchMediaRequest,
  PatchSourceRequest,
  PlaybackRecordPage,
  ProgrammesDto,
  RecordQueryRequest,
  RefreshDto,
  RefreshRequest,
  RootDto,
  SourceDto,
  SourcePageDto,
  UpdateEpgBindingRequest,
} from '@hmp/shared';
// 阶段 4 播放契约类型(独立生成产物 playback-schema.d.ts,经 @hmp/shared 转出口,仅 type import;
// T046 记录查询/T049 播放控制共用)。PlaybackSessionState/PlaybackDelivery 等播放器侧类型
// 已由 @hmp/shared 导出,T050–T053 可直接 import type,无需经本文件转发。
import type {
  HeartbeatPlaybackRequest,
  PlaybackDto,
  PlaybackStableErrorCode,
  RenewPlaybackRequest,
  ResolvePlaybackRequest,
  SeekPlaybackRequest,
  SelectionPlaybackRequest,
  TicketReply,
} from '@hmp/shared';

/** 所有 API 路径的统一前缀(开发期由 Vite 代理到 :3000,生产同源部署) */
export const API_BASE_URL = '/api';

/** Bearer 备用通道的本地存储键(Cookie 为主通道,此键仅兜底) */
export const BEARER_STORAGE_KEY = 'hmp_bearer';

type HttpMethod = 'get' | 'post' | 'patch';

/** RFC 9457 problem+json(契约 components.schemas.Problem) */
export type ProblemDto = components['schemas']['Problem'];

export interface ApiErrorInit {
  status: number;
  code?: ProblemCode | (string & {});
  title: string;
  detail?: string;
}

/** 非 2xx 响应抛出:字段与 RFC 9457 problem+json 一一对应 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: ProblemCode | (string & {});
  readonly title: string;
  readonly detail?: string;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
  }
}

/* ---------------------------------- 类型辅助 ---------------------------------- */

/** 筛出声明了某 HTTP 方法的路径字面量(未声明处生成的类型为可选 never) */
type PathsWith<M extends HttpMethod> = {
  [P in keyof paths]: paths[P] extends { [K in M]: unknown } ? P : never;
}[keyof paths];

/** 取路径某方法对应的 operation 类型 */
export type OperationOf<P extends keyof paths, M extends HttpMethod> = paths[P] extends {
  [K in M]: infer TOperation;
}
  ? TOperation
  : never;

/** 提取 operation 的 2xx application/json 响应体;204 等无内容响应为 undefined */
export type ApiResponse<TOperation> = TOperation extends { responses: infer TResponses }
  ? {
      [TStatus in keyof TResponses & (200 | 201 | 202 | 204)]: TResponses[TStatus] extends {
        content: { 'application/json': infer TBody };
      }
        ? TBody
        : undefined;
    }[keyof TResponses & (200 | 201 | 202 | 204)]
  : never;

/** 提取 operation 的请求体类型(兼容 required 与 optional requestBody);无请求体的操作为 undefined */
export type RequestBodyOf<P extends keyof paths, M extends HttpMethod> =
  OperationOf<P, M> extends { requestBody?: { content: { 'application/json': infer TBody } } }
    ? TBody
    : undefined;

/* ---------------------------------- 本地令牌 ---------------------------------- */

function getStoredBearer(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(BEARER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 登录成功后写入一次性 sessionToken;注销/恢复失败时清除(传 null) */
export function storeBearer(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token === null) {
      window.localStorage.removeItem(BEARER_STORAGE_KEY);
    } else {
      window.localStorage.setItem(BEARER_STORAGE_KEY, token);
    }
  } catch {
    // localStorage 不可用(隐私模式等):静默降级为纯 Cookie 通道
  }
}

/* ---------------------------------- 请求实现 ---------------------------------- */

async function toApiError(response: Response): Promise<ApiError> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/problem+json')) {
    try {
      const problem = (await response.json()) as ProblemDto;
      return new ApiError({
        status: response.status,
        code: typeof problem.code === 'string' ? problem.code : undefined,
        title: typeof problem.title === 'string' && problem.title ? problem.title : '请求失败',
        detail: typeof problem.detail === 'string' ? problem.detail : undefined,
      });
    } catch {
      // problem+json 解析失败:落回通用错误
    }
  }
  return new ApiError({
    status: response.status,
    title: response.statusText || `请求失败(${response.status})`,
  });
}

/* ---------------------------------- 查询参数 ---------------------------------- */

/** 把可选查询参数编码为 query string;undefined 一律省略,全部缺省时返回空串(不带 '?') */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

/** GET /media 查询参数(契约 listMedia operation;q/type/page/pageSize,均可选) */
export type ListMediaParams = {
  q?: string;
  type?: MediaDto['type'];
  page?: number;
  pageSize?: number;
};

/**
 * request 的带响应元数据变体:额外返回 Location 头(POST /playback/resolve 的
 * 201 + Location 需要;Headers 取头大小写不敏感)。传输语义与 request 完全一致
 * (Accept/Content-Type、Bearer 备用通道、credentials、problem+json 映射、204 空体)。
 */
async function requestWithLocation<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ body: T; location: string | null }> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const bearer = getStoredBearer();
  if (bearer) {
    headers.set('Authorization', `Bearer ${bearer}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    throw await toApiError(response);
  }
  const location = response.headers.get('Location');
  if (response.status === 204) {
    return { body: undefined as T, location };
  }
  return { body: (await response.json()) as T, location };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { body } = await requestWithLocation<T>(path, init);
  return body;
}

/* ---------------------------------- 客户端 ---------------------------------- */

/** 类型化 ApiClient:路径与响应/请求体类型均由契约生成类型约束 */
export class ApiClient {
  /** GET:仅允许契约中声明了 get 的路径 */
  async get<P extends PathsWith<'get'>>(
    path: P,
    init?: Omit<RequestInit, 'method' | 'body'>,
  ): Promise<ApiResponse<OperationOf<P, 'get'>>> {
    return request(path, { ...init, method: 'GET' });
  }

  /** POST:请求体按契约 InitializeRequest/LoginRequest 等约束 */
  async post<P extends PathsWith<'post'>>(
    path: P,
    body?: RequestBodyOf<P, 'post'>,
    init?: Omit<RequestInit, 'method' | 'body'>,
  ): Promise<ApiResponse<OperationOf<P, 'post'>>> {
    return request(path, {
      ...init,
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** PATCH:Profile 编辑等 */
  async patch<P extends PathsWith<'patch'>>(
    path: P,
    body?: RequestBodyOf<P, 'patch'>,
    init?: Omit<RequestInit, 'method' | 'body'>,
  ): Promise<ApiResponse<OperationOf<P, 'patch'>>> {
    return request(path, {
      ...init,
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /* ---------------- 阶段 2:ProfilePolicy(002 contracts/openapi.yaml) ---------------- */

  /** GET /profiles/{profileId}/policy → PolicyDto(owner;目标经归属校验) */
  async getProfilePolicy(profileId: string): Promise<PolicyDto> {
    return request(`/profiles/${profileId}/policy`);
  }

  /**
   * PUT /profiles/{profileId}/policy:整体保存可编辑配置(家长验证 + 版本检查)。
   * 非空 ownerPassword 由调用方保证;失败抛 ApiError(403/409/423/503 等按契约)。
   */
  async updateProfilePolicy(profileId: string, body: UpdatePolicyRequest): Promise<PolicyDto> {
    return request(`/profiles/${profileId}/policy`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /* ------------- 阶段 3:来源管理(003 contracts/api.md「来源管理」) ------------- */

  /** GET /sources?page&pageSize → SourcePageDto(owner;仅脱敏概览,无 raw URL/路径) */
  async listSources(page?: number, pageSize?: number): Promise<SourcePageDto> {
    return request(`/sources${buildQuery({ page, pageSize })}`);
  }

  /**
   * POST /sources → 201 SourceDto(version=1)。
   * ownerPassword 仅随 body 传输(writeOnly);跨字段校验失败 400,身份/密码 403。
   */
  async createSource(body: CreateSourceRequest): Promise<SourceDto> {
    return request('/sources', { method: 'POST', body: JSON.stringify(body) });
  }

  /**
   * PATCH /sources/{sourceId} → SourceDto(version+1;待确认旧快照标 stale)。
   * expectedVersion 必填,冲突 409 SOURCE_VERSION_CONFLICT;kind 不可变。
   */
  async patchSource(sourceId: string, body: PatchSourceRequest): Promise<SourceDto> {
    return request(`/sources/${sourceId}`, { method: 'PATCH', body: JSON.stringify(body) });
  }

  /** GET /source-roots → RootDto[](仅 rootKey 与展示名,不含绝对目录;NAS 创建选择用) */
  async listSourceRoots(): Promise<RootDto[]> {
    return request('/source-roots');
  }

  /* ------------- 阶段 3:刷新与待确认(003 contracts/api.md「刷新与待确认」) ------------- */

  /**
   * POST /sources/{sourceId}/refresh → 202 RefreshDto(服务端另返回 Location 头,
   * 其任务 id 即 RefreshDto.id,客户端无需单独解析)。不等待导入结束;
   * 幂等冲突 409 IDEMPOTENCY_CONFLICT,同来源忙 409 SOURCE_BUSY,队列满 429 IMPORT_QUEUE_FULL。
   */
  async startSourceRefresh(sourceId: string, body: RefreshRequest): Promise<RefreshDto> {
    return request(`/sources/${sourceId}/refresh`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * GET /refreshes/{refreshId} → RefreshDto(终态同样 200 返回,后台失败不伪装成 5xx)。
   * init.signal 由 pollRefresh 透传,支持请求在途中止。
   */
  async getRefresh(refreshId: string, init?: Pick<RequestInit, 'signal'>): Promise<RefreshDto> {
    return request(`/refreshes/${refreshId}`, { ...init, method: 'GET' });
  }

  /**
   * POST /refreshes/{refreshId}/confirm → 200 RefreshDto(status=succeeded)。
   * 仅 awaiting_confirmation 可执行;终态重复 409 REFRESH_STATE_CONFLICT,基线变化 409 REFRESH_STALE。
   */
  async confirmRefresh(refreshId: string, body: JobAction): Promise<RefreshDto> {
    return request(`/refreshes/${refreshId}/confirm`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /** POST /refreshes/{refreshId}/discard → 200 RefreshDto(status=discarded),释放来源锁 */
  async discardRefresh(refreshId: string, body: JobAction): Promise<RefreshDto> {
    return request(`/refreshes/${refreshId}/discard`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /* ------------- 阶段 3:观看目录(003 contracts/api.md「观看目录」) ------------- */

  /**
   * GET /media → MediaPageDto(先策略过滤再搜索/排序/计数/分页;无记录为 200 空列表)。
   * q 最多 100 字符,trim 后按标题大小写不敏感字面包含(通配符不当语法,由服务端处理)。
   */
  async listMedia(params: ListMediaParams = {}): Promise<MediaPageDto> {
    return request(`/media${buildQuery(params)}`);
  }

  /** GET /media/{mediaId} → MediaDto;不可用/不可见/跨家庭/不存在统一同形 404 */
  async getMedia(mediaId: string): Promise<MediaDto> {
    return request(`/media/${mediaId}`);
  }

  /** GET /media/{mediaId}/programmes → ProgrammesDto(current/next 均可为 null) */
  async getMediaProgrammes(mediaId: string): Promise<ProgrammesDto> {
    return request(`/media/${mediaId}/programmes`);
  }

  /* ------- 阶段 3:家长候选与人工修正(003 contracts/api.md「家长候选与人工修正」) ------- */

  /**
   * POST /catalog/candidates/query → CandidatePageDto(绕过观看策略的家长管理候选,
   * 含 unavailable 与 available 布尔)。ownerPassword 仅随 body 传输,禁止拼入 URL/query;
   * 契约同时禁止将密码本地持久化或长期驻留内存缓存,由调用方(页面)遵守。
   */
  async queryCandidates(body: CandidateQueryRequest): Promise<CandidatePageDto> {
    return request('/catalog/candidates/query', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * PATCH /catalog/media/{mediaId} → MediaDto(人工修正;media.version+1、catalogRevision+1)。
   * expectedVersion 必填,冲突 409 MEDIA_VERSION_CONFLICT;密码同样仅随 body 传输。
   */
  async patchMediaMetadata(mediaId: string, body: PatchMediaRequest): Promise<MediaDto> {
    return request(`/catalog/media/${mediaId}`, { method: 'PATCH', body: JSON.stringify(body) });
  }

  /* ------- 阶段 3 增补:手动 EPG 匹配(003 contracts/api.md「EPG 手动匹配增补」) ------- */

  /**
   * POST /catalog/media/{mediaId}/epg-binding/query → EpgBindingDto(无行返回 auto/version=0;
   * 管理失效绑定仍可读取)。owner+当次密码,密码仅随 body 传输;管理响应 no-store。
   * 403 家长验证 REQUIRED/FAILED、423 LOCKED、404 同形按契约。
   */
  async queryManualEpgBinding(mediaId: string, body: EpgBindingQueryRequest): Promise<EpgBindingDto> {
    return request(`/catalog/media/${mediaId}/epg-binding/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * POST /catalog/media/{mediaId}/epg-candidates/query → EpgCandidatePageDto(排除 conflicted;
   * 页级 epgGeneration 供保存携带,过期即 409 EPG_CANDIDATE_STALE)。服务端要求来源启用且
   * 已成功导入(否则 422 EPG_SOURCE_NOT_READY);q≤100 字面大小写不敏感包含;密码仅随 body 传输。
   */
  async queryEpgCandidates(mediaId: string, body: EpgCandidateQueryRequest): Promise<EpgCandidatePageDto> {
    return request(`/catalog/media/${mediaId}/epg-candidates/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * PUT /catalog/media/{mediaId}/epg-binding → EpgBindingDto(mode=manual 保存即锁定,
   * mode=auto 解除恢复自动;成功 version+1)。expectedVersion 旧值 409 EPG_BINDING_VERSION_CONFLICT,
   * expectedEpgGeneration 旧值 409 EPG_CANDIDATE_STALE;错误不改变配置;密码仅随 body 传输。
   */
  async updateEpgBinding(mediaId: string, body: UpdateEpgBindingRequest): Promise<EpgBindingDto> {
    return request(`/catalog/media/${mediaId}/epg-binding`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /* ------------- 阶段 4:播放记录查询(004 contracts/openapi.yaml「playback-records」) ------------- */

  /**
   * POST /devices/{deviceId}/playback-records/query → PlaybackRecordPage(T046,US2b/FR-007)。
   * owner+当次密码重验家庭目标;密码仅随 body 传输,禁止拼入 URL/query,响应 no-store。
   * 返回 session/failure 判别联合的脱敏记录页(不含源位置/路径/ticket),按时间/id 倒序,
   * nextCursor=null 表示没有更多;limit 默认 20、最大 100,由调用方(组件)给定。
   * 错误按契约:400 VALIDATION_FAILED、401 SESSION_INVALID、403 家长验证 REQUIRED/FAILED、
   * 423 PARENT_VERIFICATION_LOCKED、404 设备不存在/跨家庭统一同形(不泄漏归属)。
   * signal 由调用方透传,支持请求在途中止(组件卸载/重新查询时 abort)。
   */
  async queryDevicePlaybackRecords(
    deviceId: string,
    body: RecordQueryRequest,
    signal?: AbortSignal,
  ): Promise<PlaybackRecordPage> {
    return request(`/devices/${deviceId}/playback-records/query`, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    });
  }

  /* -------- 阶段 4:播放控制(004 contracts/api.md「控制端点」;T049,供 T050–T053 使用) -------- */

  /**
   * 安全约束:播放票仅存在于 renew 响应对象内,本文件与后续 T050–T053 均不得把
   * playbackUrl/ticketExpiresAt(含 opaque ticket)写入 localStorage/sessionStorage 或日志;
   * 后端 DTO 本就不含票明文(播放票只出现在 /playback/stream 入口 URL query)。
   * 既有 storeBearer 仅服务登录会话令牌,与播放票无关,保持不变。
   */

  /**
   * POST /playback/resolve → 201 PlaybackDto + Location(统一播放解析入口,T050 使用)。
   * 同步授权/家庭可用资源通过后建立 preparing 会话:delivery 与 playbackUrl/ticketExpiresAt
   * 为 null、tracks 为空,201 仅表示接受,不等待完整 probe;无法授权不建会话(4xx)。
   * 不可见/被禁/跨家庭/无可用资源统一 404 MEDIA_NOT_FOUND 同形;主动重复请求各建新会话。
   * location 为响应 Location 头(同源相对路径,如 /api/playback/sessions/{sessionId});
   * fetch 封装经 requestWithLocation 已露头,正常返回;会话 id 以 dto.id 为权威,
   * location 仅作展示/调试用途,媒体入口地址一律由 renew 的 playbackUrl 提供。
   * signal 由调用方透传,支持请求在途中止。
   */
  async resolvePlayback(
    mediaId: ResolvePlaybackRequest['mediaId'],
    signal?: AbortSignal,
  ): Promise<{ dto: PlaybackDto; location: string | null }> {
    const { body, location } = await requestWithLocation<PlaybackDto>('/playback/resolve', {
      method: 'POST',
      body: JSON.stringify({ mediaId } satisfies ResolvePlaybackRequest),
      signal,
    });
    return { dto: body, location };
  }

  /**
   * GET /playback/sessions/{sessionId} → 200 PlaybackDto(轮询 preparing→ready 与失败原因)。
   * 仅原有效设备会话+原当前档案可查;跨设备/家庭统一 404 PLAYBACK_NOT_FOUND 同形。
   * GET 不重签也不复现旧票:playbackUrl/ticketExpiresAt 恒为 null,ready 后以该
   * generation 调 renewPlayback 取票;stop 后仍可查询终态,但终态不能签票。
   * signal 由轮询方透传(组件卸载/换代时 abort),支持请求在途中止。
   */
  async getPlaybackSession(sessionId: string, signal?: AbortSignal): Promise<PlaybackDto> {
    return request(`/playback/sessions/${sessionId}`, { method: 'GET', signal });
  }

  /**
   * POST /playback/sessions/{sessionId}/renew → 200 TicketReply(换票/续期,T050 使用)。
   * 仅 ready/playing/paused 可签发:preparing 409 PLAYBACK_NOT_READY、终态 409 PLAYBACK_ENDED;
   * expectedGeneration 在签发票的短事务内比较,不一致 409 PLAYBACK_GENERATION_STALE 且不写票;
   * 每次续期重走完整授权链,媒体因策略/资源变化不可见统一 404 同形。首次 ready 后立即申请,
   * 以后到期前 PLAYBACK_RENEW_LEAD_SECONDS 秒续期。调用方(T053)须以本地 operationEpoch
   * 匹配且 session/generation 一致才可安装响应,不能只按响应 generation 判断。
   */
  async renewPlayback(sessionId: string, body: RenewPlaybackRequest): Promise<TicketReply> {
    return request(`/playback/sessions/${sessionId}/renew`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * POST /playback/sessions/{sessionId}/heartbeat → 204(每 15 秒一次,暂停期间继续)。
   * positionSeconds 为非授权遥测(影片逻辑时间,仅用于本次播放,不作观看进度持久化);
   * paused 更新服务器保留的暂停意图 desiredPaused。终态不可复活:409 PLAYBACK_ENDED。
   */
  async heartbeatPlayback(sessionId: string, body: HeartbeatPlaybackRequest): Promise<void> {
    await request<void>(`/playback/sessions/${sessionId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * POST /playback/sessions/{sessionId}/stop → 204(幂等:原设备可重复停止,重复仍 204;
   * 取消准备中的转换同用此接口)。契约要求请求体为空对象(StopRequest)。
   * 停止后会话进入 ended 终态,GET 仍可查询终态但不能以终态签票。
   */
  async stopPlayback(sessionId: string): Promise<void> {
    await request<void>(`/playback/sessions/${sessionId}/stop`, {
      method: 'POST',
      body: JSON.stringify({} satisfies Record<string, never>),
    });
  }

  /**
   * PUT /playback/sessions/{sessionId}/selection → 200 PlaybackDto(授权后原子换轨/字幕)。
   * trackId 只能引用已探测轨道(PlaybackDto.tracks.*[].id),否则 400 PLAYBACK_SELECTION_INVALID;
   * subtitleTrackId 传 null 表示关闭字幕。纯字幕切换仅 version+1 并返回现状态,不重启视频;
   * 重建音轨 generation/version 各+1、进入 preparing 无票,ready 后以新 generation renew,
   * 不新增 session。expectedVersion CAS 冲突 409 PLAYBACK_VERSION_CONFLICT;preparing 中
   * 拒绝第二次 selection(409 PLAYBACK_NOT_READY);终态 409 PLAYBACK_ENDED;需重建输出时
   * 可能同步 503 PLAYBACK_CONVERSION_BUSY/PLAYBACK_STORAGE_LIMIT/PLAYBACK_RESOURCE_UNAVAILABLE
   * (不排队,可稍后重试)。响应含新 timelineOffsetSeconds 与目标 positionSeconds、服务器
   * 读取并保留的 desiredPaused;playbackUrl 恒为 null(控制响应不携票)。
   */
  async selectTracks(sessionId: string, body: SelectionPlaybackRequest): Promise<PlaybackDto> {
    return request(`/playback/sessions/${sessionId}/selection`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  /**
   * POST /playback/sessions/{sessionId}/seek → 200 PlaybackDto(NAS 影片定位;直播不支持)。
   * 受理产生新 generation+version,旧票立即失效,响应为 preparing 无票,ready 后以新
   * generation renew;目标位置恢复上限 15 秒,超时 504 PLAYBACK_SEEK_TIMEOUT。直播
   * (durationSeconds=null)400 PLAYBACK_SEEK_UNSUPPORTED;position 越过已探测 duration
   * 或非有限数值 400 VALIDATION_FAILED;expectedVersion CAS 409 PLAYBACK_VERSION_CONFLICT;
   * preparing 中拒绝第二次 seek(409 PLAYBACK_NOT_READY);终态 409 PLAYBACK_ENDED;
   * 资源性 503 同 selection。响应含新 timelineOffsetSeconds 与目标 positionSeconds、
   * 保留暂停意图 desiredPaused;playbackUrl 恒为 null。前端发送前先递增本地
   * operationEpoch,旧响应按 session/generation 丢弃(T053 守卫)。
   */
  async seekPlayback(sessionId: string, body: SeekPlaybackRequest): Promise<PlaybackDto> {
    return request(`/playback/sessions/${sessionId}/seek`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}

/** 应用级单例 */
export const api = new ApiClient();

/* -------------------------- 阶段 4:播放控制常量(004 contracts/api.md) -------------------------- */

/**
 * 票据到期前提前续期的秒数(renew 契约:首次 ready 后立即申请,以后到期前 60 秒续期;
 * T050 播放器按 ticketExpiresAt - 本值调度 renewPlayback)。
 *
 * 注意:apps/server/src/modules/playback/playback-ticket.service.ts 已导出同名常量(=60,
 * 与 budgets.ticket.renewLeadSeconds 同值),但 packages/shared 目前未转出;按 T049 文件
 * 边界(shared 包禁改)暂在此以同值本地导出,shared 转出后应改为从 @hmp/shared 引入
 * 以维持单一权威。
 */
export const PLAYBACK_RENEW_LEAD_SECONDS = 60;

/**
 * 播放稳定错误码 → 中文友好文案(004 contracts/api.md「稳定错误」节;T051 控件提示用)。
 * 文案面向观看者:不含源信息/技术细节/内部诊断。键覆盖 @hmp/shared 的
 * PLAYBACK_STABLE_ERROR_CODES 全词表外加 MEDIA_NOT_FOUND(resolve/404 同形码),
 * 由 Record 类型保证逐码完备——shared 词表增删时此处编译期即报错。
 * 用法:`err instanceof ApiError && err.code ? PLAYBACK_ERROR_LABELS[err.code] ?? 兜底文案 : 兜底文案`
 * (码经 toApiError 原样保留在 ApiError.code,未知码由调用方自行兜底)。
 * 本表仅作展示映射,不落任何存储(播放票/播放地址不入 localStorage/sessionStorage)。
 */
export const PLAYBACK_ERROR_LABELS: Record<PlaybackStableErrorCode | 'MEDIA_NOT_FOUND', string> = {
  PLAYBACK_NOT_READY: '内容还在准备中,请稍候',
  PLAYBACK_VERSION_CONFLICT: '操作已过期,请重试',
  PLAYBACK_GENERATION_STALE: '播放进度已更新,正在同步最新状态',
  PLAYBACK_ENDED: '播放已结束',
  PLAYBACK_CONVERSION_BUSY: '当前播放任务较多,请稍后重试',
  PLAYBACK_STORAGE_LIMIT: '服务存储空间不足,暂时无法播放,请稍后重试',
  PLAYBACK_PERFORMANCE_INSUFFICIENT: '当前设备性能不足以流畅播放该内容',
  PLAYBACK_RESOURCE_UNAVAILABLE: '服务资源暂时紧张,请稍后重试',
  PLAYBACK_PREPARE_TIMEOUT: '内容准备超时,请重试',
  PLAYBACK_SEEK_TIMEOUT: '跳转超时,请重试',
  PLAYBACK_FORMAT_UNSUPPORTED: '该内容格式暂不支持在当前设备播放',
  PLAYBACK_NOT_FOUND: '播放会话不存在或已结束',
  PLAYBACK_TICKET_INVALID: '播放凭据已失效,请重新开始播放',
  PLAYBACK_TICKET_EXPIRED: '播放链接已过期,请重新开始播放',
  PLAYBACK_SELECTION_INVALID: '所选音轨/字幕不可用,请重新选择',
  PLAYBACK_SEEK_UNSUPPORTED: '该内容不支持拖动进度',
  PLAYBACK_RATE_LIMITED: '操作太频繁,请稍后再试',
  MEDIA_NOT_FOUND: '内容不存在或暂不可观看',
};

/* ---------------------------------- 刷新轮询 ---------------------------------- */

/** 契约约定的刷新任务轮询间隔:每 2 秒(003 contracts/api.md「UI 路由」) */
export const REFRESH_POLL_INTERVAL_MS = 2000;

/** 刷新任务终态(进入终态轮询停止;awaiting_confirmation/queued/running 继续) */
export type RefreshTerminalStatus =
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'discarded'
  | 'expired'
  | 'stale';

/** 判断任务状态是否为终态(类型守卫;非法/未知状态按非终态继续轮询,由服务端契约兜底) */
export function isRefreshTerminalStatus(status: RefreshDto['status']): status is RefreshTerminalStatus {
  switch (status) {
    case 'succeeded':
    case 'failed':
    case 'interrupted':
    case 'discarded':
    case 'expired':
    case 'stale':
      return true;
    default:
      return false;
  }
}

export interface PollRefreshOptions {
  /** 任务 id(startSourceRefresh 返回的 RefreshDto.id) */
  refreshId: string;
  /** 轮询间隔,默认 REFRESH_POLL_INTERVAL_MS(2000) */
  intervalMs?: number;
  /**
   * 取消信号:页面离开/组件卸载由调用方 abort,轮询立即以 DOMException('AbortError')
   * reject(不等当前 sleep 或在途 fetch);未提供则仅终态停止。
   */
  signal?: AbortSignal;
  /** 额外停止判据:返回 true 时以当前快照 resolve(默认仅终态停止) */
  shouldStop?: (refresh: RefreshDto) => boolean;
}

/** 构造取消异常(浏览器与 Node 18+ 均内置 DOMException) */
function createAbortError(): DOMException {
  return new DOMException('刷新轮询已中止', 'AbortError');
}

/**
 * 轮询刷新任务直至终态(T029/T030)。
 *
 * - 立即查询一次,此后每 intervalMs 调 getRefresh;
 *   queued/running/awaiting_confirmation 继续,succeeded/failed/interrupted/
 *   discarded/expired/stale 六个终态以该快照 resolve。
 * - signal 取消(含已在途的请求)立即以 AbortError reject,调用方按取消静默处理;
 *   查询失败(网络/404/401 等)同样终止轮询并上抛,由调用方决定提示与重试。
 * - 页面离开由调用方 abort(配合 useEffect cleanup),本函数不自行监听路由事件。
 */
export function pollRefresh(options: PollRefreshOptions): Promise<RefreshDto> {
  const { refreshId, intervalMs = REFRESH_POLL_INTERVAL_MS, signal, shouldStop } = options;

  return new Promise<RefreshDto>((resolve, reject) => {
    // 发起前已取消:立即 reject,不发起任何请求
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    /** 下一次轮询的定时器句柄(取消时清理,避免中止后仍触发) */
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    /** 摘除 abort 监听后结算 Promise(已结算时后续 reject/resolve 均为 no-op) */
    const finish = (settle: () => void): void => {
      signal?.removeEventListener('abort', onAbort);
      settle();
    };

    const tick = async (): Promise<void> => {
      try {
        // 单次查询也透传 signal:请求在途中止时 fetch 直接抛 AbortError
        const refresh = await api.getRefresh(refreshId, signal ? { signal } : undefined);
        // fetch 完成与 abort 事件存在竞态:以取消为准,丢弃已完成查询的结果
        if (signal?.aborted) {
          finish(() => reject(createAbortError()));
          return;
        }
        if (isRefreshTerminalStatus(refresh.status) || shouldStop?.(refresh)) {
          finish(() => resolve(refresh));
          return;
        }
        timer = setTimeout(run, Math.max(0, intervalMs));
      } catch (error) {
        // 查询失败(含被中止的 fetch):终止轮询并上抛,保留原 ApiError/AbortError 语义
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    };

    const run = (): void => {
      void tick();
    };

    run();
  });
}

/* ---------------------------------- 会话代次守卫 ---------------------------------- */

/**
 * 会话代次守卫(T029/T037):Profile 切换等会话语境变化后废弃旧在途响应。
 *
 * 用法:进入页面/语境时 `const gen = guard.begin()`;请求完成回写 state 前
 * `guard.isCurrent(gen)` 为 false 则丢弃该响应。再次 `begin()` 即开启新一代次,
 * 所有旧代次的在途响应随之失效,避免旧数据覆盖新语境(契约「UI 路由」:
 * Profile 切换立即废弃原目录和节目请求结果)。
 */
export interface GenerationGuard {
  /** 开启新一代次并返回其代次号(调用方保存于局部变量/闭包) */
  begin(): number;
  /** 该代次号是否仍为当前代次(回写 state 前判断) */
  isCurrent(generation: number): boolean;
  /** 当前代次号(只读快照,主要用于调试/测试) */
  readonly current: number;
}

/** 创建会话代次守卫;api.ts 无既有同类机制,按最小语义独立实现(模块内可多实例并存) */
export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
    get current() {
      return generation;
    },
  };
}
