/**
 * 014 频道 Logo 引用签发(data-model §6「引用生成」/tasks T007):
 *
 * - 形态:随机 128-bit,`crypto.randomBytes(16)` → 32 字符小写 hex
 *   (对齐项目「sha256 截断/十六进制」既有习惯,如 programme key);
 * - 非确定性派生(不用 URL/HMAC):避免泄漏上游结构,撤销即失效不依赖密钥;
 * - 纯函数模块(本上下文 domain 惯例):字节源可注入(测试确定性;缺省
 *   crypto.randomBytes),冲突重签策略(同家庭 ref 唯一约束兜底)由调用方
 *   (事务参与者 upsertChannelLogoWinner)持有——签发器只负责「产出新引用」。
 */

import { randomBytes } from 'node:crypto';

/** 引用字节长度:128-bit(32 字符小写 hex 的唯一来源) */
export const LOGO_REF_BYTES = 16;

/** 引用形态:32 字符小写 hex(data-model §2 `ref` 列值域) */
export type LogoRef = string;

/** 随机字节源(测试注入确定性字节;生产为 node:crypto randomBytes) */
export type RandomBytesFn = (size: number) => Buffer;

/**
 * 签发一个新引用:randomBytes(16) → 32 字符小写 hex。
 * 调用方(发布事务参与者)在 UNIQUE(household_id, ref) 冲突时重新调用本函数
 * 重签(唯一约束兜底重试,internal-ports §2「引用签发在参与者内完成」)。
 */
export function issueLogoRef(random: RandomBytesFn = randomBytes): LogoRef {
  return random(LOGO_REF_BYTES).toString('hex');
}

/** 引用形态校验(防御面:非 32 字符小写 hex 视为伪造,与未签发同形 404) */
export function isWellFormedLogoRef(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}
