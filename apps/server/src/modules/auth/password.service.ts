import { argon2id, hash as argon2Hash, verify as argon2Verify } from 'argon2';

/**
 * 口令哈希(T017/T019):argon2id(参数取库默认:64MB / t=3 / p=4)。
 * 哈希仅落库 password_hash / pin_hash,任何 DTO、日志、导出不得携带(FR-007)。
 * 纯函数导出,无需 Nest 注入(对齐 token.service.ts 惯例)。
 */

/** argon2id 编码哈希(含随机盐与参数段) */
export function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, { type: argon2id });
}

export function verifyPassword(digest: string, plain: string): Promise<boolean> {
  return argon2Verify(digest, plain);
}
