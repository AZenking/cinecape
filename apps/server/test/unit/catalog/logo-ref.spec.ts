import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LOGO_REF_BYTES, isWellFormedLogoRef, issueLogoRef } from '@contexts/media-catalog/domain/logo-ref';

/**
 * 引用签发工具单元契约(tasks T007 / data-model §6「引用生成」):
 * - 形态:crypto.randomBytes(16) → 32 字符小写 hex;
 * - 随机性:同长度连续签发不重复(128-bit 熵;唯一约束兜底重签的前提是重签可产出新值);
 * - 字节源可注入(发布事务参与者重签循环的确定性测试锚点);
 * - 形态门:非 32 字符小写 hex 一律判伪造(解析面 404 同形的防御依据)。
 */

describe('Logo 引用签发(T007;data-model §6)', () => {
  it('缺省签发:32 字符小写 hex,字节源为 randomBytes(16)', () => {
    const ref = issueLogoRef();
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(ref).toHaveLength(32);
    expect(isWellFormedLogoRef(ref)).toBe(true);
    expect(LOGO_REF_BYTES).toBe(16);
  });

  it('随机性:连续签发互不相同(128-bit 熵;同家庭冲突重签依赖新值产出)', () => {
    const refs = new Set(Array.from({ length: 200 }, () => issueLogoRef()));
    expect(refs.size).toBe(200);
  });

  it('字节源可注入:确定性字节 → 确定性引用(参与者重签循环测试锚点)', () => {
    const deterministic = issueLogoRef(() => Buffer.alloc(16, 0xab));
    expect(deterministic).toBe('ab'.repeat(16));
    expect(deterministic).toBe(issueLogoRef(() => Buffer.alloc(16, 0xab)));
    // 注入源与缺省源同形:仍是 32 字符小写 hex
    expect(isWellFormedLogoRef(issueLogoRef(() => randomBytes(16)))).toBe(true);
  });

  it('形态门:大写/长度/字符集越界一律判伪造', () => {
    expect(isWellFormedLogoRef('A'.repeat(32))).toBe(false);
    expect(isWellFormedLogoRef('a'.repeat(31))).toBe(false);
    expect(isWellFormedLogoRef(`${'a'.repeat(31)}g`)).toBe(false);
    expect(isWellFormedLogoRef('')).toBe(false);
    expect(isWellFormedLogoRef(`${'a'.repeat(32)}extra`)).toBe(false);
  });
});
