import { createHmac, timingSafeEqual } from 'node:crypto';
import { createDomainError } from '@platform/http-common/domain-error';
import { Database } from '@platform/database/database';

/**
 * 个人列表 signed cursor(T098,005 contracts/api.md §4、data-model.md §4):
 * 「游标包含类型、家庭、Profile、排序时间和 ID,使用部署本地密钥签名;
 *  篡改或当前 Profile 不匹配 400 INVALID_CURSOR,不回落其他身份。」
 *
 * - 载荷 = {type, householdId, profileId, sortAt, mediaId}(键集分页锚点);
 * - 编码 = base64url(JSON) + '.' + hex(HMAC-SHA256,部署本地密钥);
 * - 部署本地密钥派生自 SQLite 库文件路径(同部署重启稳定、跨部署不同),
 *   不进入环境变量、日志或响应;
 * - 校验失败(签名不符/载荷不可解析/类型/家庭/Profile 任一不匹配)一律
 *   INVALID_CURSOR 400,绝不回落为「从头开始」。
 */

/** 个人列表类型(游标绑定;跨列表/跨身份复用即拒绝) */
export type PersonalCursorListType = 'favorites' | 'history';

/** 游标载荷(键集锚点 + 身份绑定三元组) */
export interface PersonalCursorPayload {
  readonly type: PersonalCursorListType;
  readonly householdId: string;
  readonly profileId: string;
  /** 排序列锚点:favorites=created_at;history=last_viewed_at(UTC ISO-8601 文本) */
  readonly sortAt: string;
  /** 同序次锚点:media_id(DESC) */
  readonly mediaId: string;
}

/** HMAC 密钥缓存(部署本地;按库文件路径派生,进程内缓存) */
let deploymentKeyCache: Buffer | null = null;

/** 部署本地密钥:库文件路径派生(better-sqlite3 Database.name = 打开时的库路径) */
function deploymentKey(): Buffer {
  if (deploymentKeyCache === null) {
    let databaseName = '';
    try {
      databaseName = String(Database.db.name ?? '');
    } catch {
      databaseName = '';
    }
    deploymentKeyCache = createHmac('sha256', 'hmp-personal-cursor-v1')
      .update(`deployment\u0000${databaseName}`)
      .digest();
  }
  return deploymentKeyCache;
}

function hmacHex(payload: string): string {
  return createHmac('sha256', deploymentKey()).update(payload).digest('hex');
}

/** 编码 signed cursor(载荷必须与当前身份一致;由调用方保证) */
export function encodePersonalCursor(payload: PersonalCursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${hmacHex(encoded)}`;
}

/** 解码并校验:签名/身份任一不符 → INVALID_CURSOR 400(不回落) */
export function decodePersonalCursor(
  raw: string,
  expected: { readonly type: PersonalCursorListType; readonly householdId: string; readonly profileId: string },
): PersonalCursorPayload {
  const separator = raw.lastIndexOf('.');
  if (separator <= 0) {
    throw createDomainError('INVALID_CURSOR');
  }
  const encoded = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  const expectedSignature = hmacHex(encoded);
  const provided = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    throw createDomainError('INVALID_CURSOR');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw createDomainError('INVALID_CURSOR');
  }
  if (payload === null || typeof payload !== 'object') {
    throw createDomainError('INVALID_CURSOR');
  }
  const candidate = payload as Partial<PersonalCursorPayload>;
  if (
    candidate.type !== expected.type ||
    candidate.householdId !== expected.householdId ||
    candidate.profileId !== expected.profileId ||
    typeof candidate.sortAt !== 'string' ||
    candidate.sortAt === '' ||
    typeof candidate.mediaId !== 'string' ||
    candidate.mediaId === ''
  ) {
    throw createDomainError('INVALID_CURSOR');
  }
  return {
    type: candidate.type,
    householdId: candidate.householdId,
    profileId: candidate.profileId,
    sortAt: candidate.sortAt,
    mediaId: candidate.mediaId,
  };
}
