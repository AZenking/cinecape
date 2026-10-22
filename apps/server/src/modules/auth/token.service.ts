import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 不透明会话令牌(T011):明文令牌只在签发响应中出现一次,落库的只有 SHA-256 哈希。
 * 纯函数导出,无需 Nest 注入。
 */

/** 32 字节 CSPRNG → base64url 明文令牌 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex,device_session.token_hash 落库值 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 常数时间比对,防时序侧信道 */
export function verifyTokenHash(storedHash: string, token: string): boolean {
  const computed = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (stored.length !== computed.length) {
    return false;
  }
  return timingSafeEqual(computed, stored);
}
