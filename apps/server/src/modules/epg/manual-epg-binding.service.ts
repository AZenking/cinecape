import type DatabaseConstructor from 'better-sqlite3';
import { ProblemCode } from '@hmp/shared';
import { DomainError, createDomainError } from '../../common/domain-error';

/**
 * 手动 EPG 绑定服务(T070;US5/ADR-0008,data-model「## 0004 增补」为权威):
 * - 读取(getBindingState):一次同步读取快照内派生管理状态 —— 无行 mode='none'/version=0;
 *   auto 墓碑保留 version、目标两列为 null(节目匹配沿用 FR-007,由 epg.service T071 消费);
 *   manual 派生:目标源禁用 → source_disabled,目标频道在该源缺失 → channel_missing,
 *   conflicted=1 → channel_conflict;来源启用且目标有效但无当前节目仍 valid
 *   (无节目 ≠ 失效,current/next 由节目查询负责)。只返回契约字段,不泄漏候选集/源位置/凭据。
 * - 写入(saveBinding/unbindBinding):家长验证(ownerPassword)由调用方(T071 控制器)完成后,
 *   本服务在事务前重验 session/device/account 归属(data-model「家长验证后重验」);
 *   校验次序:媒体(404 同形 → 非频道 400 → 无 IPTV 条目 400)→ 目标(404 同形 → kind 400 →
 *   禁用 422 EPG_SOURCE_NOT_READY → 频道 ID 长度 400/存在/冲突 422 EPG_CANDIDATE_INVALID)→
 *   候选 generation(409 EPG_CANDIDATE_STALE,即使目标仍存在)→ 绑定 expectedVersion(409 EPG_BINDING_VERSION_CONFLICT)→
 *   单事务 upsert(manual 锁定 / auto 墓碑不删行)+ version+1 + catalog_state.revision+1;
 *   任一校验失败整体回滚,旧请求不能通过删除/重建绕过版本(防 ABA)。
 * - 跨家庭 EPG 源/媒体 → 404 NOT_FOUND 同形:NOT_FOUND 不在 createDomainError 注册表
 *   (注册表仅登记 003 新增契约码),按既有服务(catalog/sources)的 404 同形惯例直接构造,
 *   不给跨家庭目标回 400 以免泄漏归属;kind≠epg 等形态错误用 400 VALIDATION_FAILED。
 * - db 句柄传递惯例与 refresh-staging/catalog-diff 一致:传入 better-sqlite3 连接
 *   (与 Database.db 同型,列名与 schema.ts 一一对应),不内部取单例,便于测试与事务复用。
 */

/** 单个 better-sqlite3 连接句柄(Database.db 同型;refresh-staging 同惯例) */
type DbHandle = DatabaseConstructor.Database;

/** 绑定模式:none=无行,manual=家长锁定,auto=解除后的版本墓碑 */
export type ManualBindingMode = 'none' | 'manual' | 'auto';

/** manual 绑定的动态失效原因(data-model「读取状态派生」;auto/none 恒 null) */
export type ManualBindingInvalidReason = 'source_disabled' | 'channel_missing' | 'channel_conflict';

/** 管理读取快照(契约字段白名单;T071 映射 BindingDto,mode='none' 在 DTO 层映射为 auto) */
export interface ManualEpgBindingState {
  mediaId: string;
  mode: ManualBindingMode;
  /** 无行=0,首写=1,其后每次保存/解除 +1 */
  version: number;
  epgSourceId: string | null;
  xmltvChannelId: string | null;
  valid: boolean;
  invalidReason: ManualBindingInvalidReason | null;
  updatedAt: string | null;
}

export interface BindingStateQuery {
  householdId: string;
  mediaId: string;
}

/** 保存(manual 锁定)入参:家长验证由调用方完成后传入当次会话/账号供重验 */
export interface SaveManualBindingInput {
  householdId: string;
  mediaId: string;
  epgSourceId: string;
  xmltvChannelId: string;
  /** 当前行期望版本(无行=0);不等 → 409 EPG_BINDING_VERSION_CONFLICT */
  expectedVersion: number;
  /** 候选响应携带的 epgGeneration;不等于目标源当前值 → 409 EPG_CANDIDATE_STALE */
  candidateEpgGeneration: number;
  accountId: string;
  sessionId: string;
}

/** 解除入参:写 auto 墓碑(不删行);无行且 expectedVersion=0 亦创建 version=1 墓碑 */
export interface UnbindManualBindingInput {
  householdId: string;
  mediaId: string;
  expectedVersion: number;
  accountId: string;
  sessionId: string;
}

interface BindingRow {
  mode: string;
  epg_source_id: string | null;
  xmltv_channel_id: string | null;
  version: number;
  updated_at: string;
}

/** XMLTV 频道 ID 长度按字符数计(与 SQLite length() 文本语义一致),1~255、大小写敏感 */
function xmltvChannelIdLength(value: string): number {
  return [...value].length;
}

function notFound(): DomainError {
  // 不存在/跨家庭统一同形,不泄漏归属(与 catalog/sources 服务一致)
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

function validationFailed(detail: string): DomainError {
  return new DomainError(400, ProblemCode.VALIDATION_FAILED, detail);
}

/**
 * 写入前置:当次会话/设备与账号重验(data-model「家长验证后重验 session/device/account/Household」)。
 * 会话必须存在且归属同家庭、未撤销、未过期且设备未撤销(401);账号必须存在且归属同家庭(403)。
 */
function reassertWriter(db: DbHandle, input: { householdId: string; accountId: string; sessionId: string }): void {
  const nowMs = Date.now();
  const session = db
    .prepare(
      'SELECT s.revoked_at AS session_revoked_at, s.expires_at AS expires_at, d.revoked_at AS device_revoked_at FROM device_session s JOIN device d ON d.id = s.device_id WHERE s.id = ? AND s.household_id = ?',
    )
    .get(input.sessionId, input.householdId) as
    | { session_revoked_at: string | null; expires_at: string; device_revoked_at: string | null }
    | undefined;
  if (
    session === undefined ||
    session.session_revoked_at !== null ||
    session.device_revoked_at !== null ||
    !(Date.parse(session.expires_at) > nowMs)
  ) {
    throw new DomainError(401, ProblemCode.SESSION_INVALID, '会话无效或已撤销');
  }
  const account = db
    .prepare('SELECT id FROM account WHERE id = ? AND household_id = ?')
    .get(input.accountId, input.householdId);
  if (account === undefined) {
    throw new DomainError(403, ProblemCode.FORBIDDEN);
  }
}

/**
 * 媒体侧校验(保存/解除共用):存在且同家庭(404 同形)→ type=channel(400)→
 * 存在 IPTV 来源条目(400;条目允许暂时 missing,present 不参与判定)。
 */
function requireBindableChannel(db: DbHandle, householdId: string, mediaId: string): void {
  const media = db.prepare('SELECT type FROM media_item WHERE id = ? AND household_id = ?').get(mediaId, householdId) as
    | { type: string }
    | undefined;
  if (media === undefined) {
    throw notFound();
  }
  if (media.type !== 'channel') {
    throw validationFailed('仅频道条目支持手动 EPG 绑定');
  }
  const iptvEntry = db
    .prepare(
      "SELECT 1 FROM source_entry se JOIN media_source ms ON ms.household_id = se.household_id AND ms.id = se.source_id AND ms.kind = 'iptv' WHERE se.household_id = ? AND se.media_id = ? LIMIT 1",
    )
    .get(householdId, mediaId);
  if (iptvEntry === undefined) {
    throw validationFailed('频道需存在 IPTV 来源条目(允许暂时缺失)');
  }
}

/** 当前行版本(无行=0);供版本冲突判定 */
function currentBindingVersion(db: DbHandle, householdId: string, mediaId: string): number {
  const row = db
    .prepare('SELECT version FROM manual_epg_binding WHERE household_id = ? AND media_id = ?')
    .get(householdId, mediaId) as { version: number } | undefined;
  return row?.version ?? 0;
}

/**
 * 事务内写入(保存与解除共用):upsert 当前行(manual 锁定 / auto 墓碑,不删行防 ABA)+
 * version+1 + catalog_state.revision+1,同一事务原子提交;
 * catalog_state 缺失按「创建后应为 2」补建(与 catalog-admin.service 的 bump 惯例一致,行 CHECK ≥1)。
 * better-sqlite3 事务回调不注入句柄:语句统一走传入的 db 连接(refresh-publish 同惯例)。
 */
function upsertBinding(
  db: DbHandle,
  householdId: string,
  mediaId: string,
  mode: 'manual' | 'auto',
  target: { epgSourceId: string | null; xmltvChannelId: string | null },
  nextVersion: number,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO manual_epg_binding (household_id, media_id, mode, epg_source_id, xmltv_channel_id, version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(household_id, media_id) DO UPDATE SET
       mode = excluded.mode,
       epg_source_id = excluded.epg_source_id,
       xmltv_channel_id = excluded.xmltv_channel_id,
       version = excluded.version,
       updated_at = excluded.updated_at`,
  ).run(householdId, mediaId, mode, target.epgSourceId, target.xmltvChannelId, nextVersion, nowIso);
  db.prepare(
    `INSERT INTO catalog_state (household_id, revision) VALUES (?, 2)
     ON CONFLICT(household_id) DO UPDATE SET revision = revision + 1`,
  ).run(householdId);
}

/**
 * 管理读取:一次同步快照内完成绑定行读取与 manual 派生判定
 * (better-sqlite3 同步执行,三次查询之间无并发写穿插;节目匹配语义不在本读取内)。
 */
export function getBindingState(db: DbHandle, query: BindingStateQuery): ManualEpgBindingState {
  const row = db
    .prepare('SELECT mode, epg_source_id, xmltv_channel_id, version, updated_at FROM manual_epg_binding WHERE household_id = ? AND media_id = ?')
    .get(query.householdId, query.mediaId) as BindingRow | undefined;
  if (row === undefined) {
    // 无行:自动语义(FR-007)由节目查询负责,绑定层无失效可派生
    return {
      mediaId: query.mediaId,
      mode: 'none',
      version: 0,
      epgSourceId: null,
      xmltvChannelId: null,
      valid: true,
      invalidReason: null,
      updatedAt: null,
    };
  }
  if (row.mode !== 'manual') {
    // auto 墓碑:不代表自动匹配结果;同 FR-007 语义,version 保留、目标两列为 null
    return {
      mediaId: query.mediaId,
      mode: 'auto',
      version: row.version,
      epgSourceId: null,
      xmltvChannelId: null,
      valid: true,
      invalidReason: null,
      updatedAt: row.updated_at,
    };
  }
  // manual 派生(动态,不落库):禁用 → 缺失 → 冲突;无节目不参与判定
  const epgSourceId = row.epg_source_id as string;
  const xmltvChannelId = row.xmltv_channel_id as string;
  const source = db.prepare('SELECT enabled FROM media_source WHERE id = ? AND household_id = ?').get(
    epgSourceId,
    query.householdId,
  ) as { enabled: number } | undefined;
  if (source === undefined || source.enabled !== 1) {
    // 来源无硬删除,行缺失仅剩防御路径:与禁用同因(来源侧不可用)
    return { mediaId: query.mediaId, mode: 'manual', version: row.version, epgSourceId, xmltvChannelId, valid: false, invalidReason: 'source_disabled', updatedAt: row.updated_at };
  }
  const channel = db
    .prepare('SELECT conflicted FROM epg_channel WHERE household_id = ? AND source_id = ? AND xmltv_channel_id = ?')
    .get(query.householdId, epgSourceId, xmltvChannelId) as { conflicted: number } | undefined;
  if (channel === undefined) {
    return { mediaId: query.mediaId, mode: 'manual', version: row.version, epgSourceId, xmltvChannelId, valid: false, invalidReason: 'channel_missing', updatedAt: row.updated_at };
  }
  if (channel.conflicted === 1) {
    return { mediaId: query.mediaId, mode: 'manual', version: row.version, epgSourceId, xmltvChannelId, valid: false, invalidReason: 'channel_conflict', updatedAt: row.updated_at };
  }
  return { mediaId: query.mediaId, mode: 'manual', version: row.version, epgSourceId, xmltvChannelId, valid: true, invalidReason: null, updatedAt: row.updated_at };
}

/**
 * 保存 manual 绑定(保存即锁定;目标来源/频道成对)。
 * 校验次序:会话/账号 → 媒体 → 目标(存在/kind/启用/候选)→ generation → expectedVersion → 事务。
 * 任一失败整体回滚:不产生行、不推进 revision。
 */
export function saveBinding(db: DbHandle, input: SaveManualBindingInput): ManualEpgBindingState {
  reassertWriter(db, input);
  requireBindableChannel(db, input.householdId, input.mediaId);

  // 目标来源:同家庭(404 同形)→ kind=epg(400)→ 当前启用(422;ADR-0008「已启用成功导入」)
  const source = db.prepare('SELECT kind, enabled, epg_generation FROM media_source WHERE id = ? AND household_id = ?').get(
    input.epgSourceId,
    input.householdId,
  ) as { kind: string; enabled: number; epg_generation: number } | undefined;
  if (source === undefined) {
    throw notFound();
  }
  if (source.kind !== 'epg') {
    throw validationFailed('绑定目标必须是 EPG 来源');
  }
  if (source.enabled !== 1) {
    throw createDomainError('EPG_SOURCE_NOT_READY', '目标 EPG 来源已停用,不能建立手动绑定');
  }
  if (xmltvChannelIdLength(input.xmltvChannelId) < 1 || xmltvChannelIdLength(input.xmltvChannelId) > 255) {
    throw validationFailed('XMLTV 频道 ID 长度须为 1~255');
  }
  // 候选有效性:目标频道须存在于该源当前窗口且未冲突(422 EPG_CANDIDATE_INVALID;
  // 失效候选走 422 而非 409 —— 目标不存在时重查永远无法成功,不应引导客户端循环重试)
  const channel = db
    .prepare('SELECT conflicted FROM epg_channel WHERE household_id = ? AND source_id = ? AND xmltv_channel_id = ?')
    .get(input.householdId, input.epgSourceId, input.xmltvChannelId) as { conflicted: number } | undefined;
  if (channel === undefined) {
    throw createDomainError('EPG_CANDIDATE_INVALID', '候选频道在该 EPG 来源中不存在');
  }
  if (channel.conflicted === 1) {
    throw createDomainError('EPG_CANDIDATE_INVALID', '候选频道存在标识冲突,不能作为绑定目标');
  }

  // 候选 generation:必须等于目标源当前值(即使目标仍存在;变化后要求重新查询候选)
  if (input.candidateEpgGeneration !== source.epg_generation) {
    throw createDomainError('EPG_CANDIDATE_STALE');
  }
  // 绑定版本:防并发/ABA(无行=0)
  const version = currentBindingVersion(db, input.householdId, input.mediaId);
  if (version !== input.expectedVersion) {
    throw createDomainError('EPG_BINDING_VERSION_CONFLICT');
  }

  const nowIso = new Date().toISOString();
  db.transaction(() => {
    upsertBinding(db, input.householdId, input.mediaId, 'manual', { epgSourceId: input.epgSourceId, xmltvChannelId: input.xmltvChannelId }, version + 1, nowIso);
  })();
  return getBindingState(db, { householdId: input.householdId, mediaId: input.mediaId });
}

/**
 * 解除绑定:写 auto 墓碑(不删行,恢复 FR-007 来源级精确匹配)。
 * 不需要目标/候选校验;无行且 expectedVersion=0 亦创建 version=1 墓碑
 * (契约「解除无行且 expectedVersion=0 创建 version=1 auto 墓碑」);版本保护与保存一致。
 */
export function unbindBinding(db: DbHandle, input: UnbindManualBindingInput): ManualEpgBindingState {
  reassertWriter(db, input);
  requireBindableChannel(db, input.householdId, input.mediaId);

  const version = currentBindingVersion(db, input.householdId, input.mediaId);
  if (version !== input.expectedVersion) {
    throw createDomainError('EPG_BINDING_VERSION_CONFLICT');
  }

  const nowIso = new Date().toISOString();
  db.transaction(() => {
    upsertBinding(db, input.householdId, input.mediaId, 'auto', { epgSourceId: null, xmltvChannelId: null }, version + 1, nowIso);
  })();
  return getBindingState(db, { householdId: input.householdId, mediaId: input.mediaId });
}
