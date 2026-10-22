import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.service';

/**
 * T017(US1 单元):口令哈希 —— argon2id 哈希/验证;哈希不含明文;长度合理。
 * 对应 FR-007:密码仅保存哈希,任何响应/日志/导出不得包含明文或哈希以外的凭据形态。
 */
describe('password.service(argon2id)', () => {
  it('正确密码验证通过,错误密码验证失败', async () => {
    const digest = await hashPassword('correct-horse-battery-staple');

    await expect(verifyPassword(digest, 'correct-horse-battery-staple')).resolves.toBe(true);
    await expect(verifyPassword(digest, 'wrong-password')).resolves.toBe(false);
  });

  it('哈希为 argon2id 编码格式、不含明文且长度合理', async () => {
    const plain = 'S3cret-Passw0rd-含中文';
    const digest = await hashPassword(plain);

    expect(digest.startsWith('$argon2id$')).toBe(true);
    expect(digest).not.toContain(plain);
    // argon2 编码串(salt+hash+参数段)合理长度区间
    expect(digest.length).toBeGreaterThanOrEqual(90);
    expect(digest.length).toBeLessThanOrEqual(200);
  });

  it('相同口令每次哈希使用不同随机盐', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');

    expect(first).not.toBe(second);
    await expect(verifyPassword(first, 'same-password')).resolves.toBe(true);
    await expect(verifyPassword(second, 'same-password')).resolves.toBe(true);
  });
});
