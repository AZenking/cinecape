import { describe, expect, it } from 'vitest';
import {
  groupKeyOf,
  normalizeGroupTitle,
  OTHER_GROUP_LABEL,
  pickMainGroupLabel,
  type GroupTitleSource,
} from '@contexts/live-tv/domain/live-grouping';

/**
 * 来源主分组解析单元测试(T058;005 data-model §2 逐字语义):
 * - source_entry.group_title「TEXT NULL,trim 后 1~100 字符,空白为 NULL」;
 * - 「对多来源可用频道,按启用 present 关联 (source_id, entry_id) 升序选第一项
 *   非空 group_title;无分组为其他」;
 * - 「公开返回仅分组显示名及不透明 groupKey,不带来源身份或源 URL」;
 * - FR-023「优先采用频道来源的类型或分组,缺失归入其他,不按标题臆测类型」。
 */

describe('normalizeGroupTitle(存储值域归一化)', () => {
  it('trim 后 1~100 字符保留;前后空白剥离', () => {
    expect(normalizeGroupTitle('央视')).toBe('央视');
    expect(normalizeGroupTitle('  央视  ')).toBe('央视');
    expect(normalizeGroupTitle('\t体育\n')).toBe('体育');
    expect(normalizeGroupTitle('a'.repeat(100))).toBe('a'.repeat(100));
  });

  it('空白(含纯空格/制表/换行)与空串归 NULL', () => {
    expect(normalizeGroupTitle('')).toBeNull();
    expect(normalizeGroupTitle('   ')).toBeNull();
    expect(normalizeGroupTitle('\u3000\t\n')).toBeNull();
  });

  it('非字符串输入按缺失处理(NULL)', () => {
    expect(normalizeGroupTitle(null)).toBeNull();
    expect(normalizeGroupTitle(undefined)).toBeNull();
    expect(normalizeGroupTitle(42)).toBeNull();
  });

  it('上游占位字面量 Undefined(大小写/前后空白不敏感)按缺失处理(NULL)', () => {
    // iptv-org cn.m3u 对未分类频道写 group-title="Undefined"(占位,不是分组名);
    // 按 FR-023「缺失归入其他」处理
    expect(normalizeGroupTitle('Undefined')).toBeNull();
    expect(normalizeGroupTitle('undefined')).toBeNull();
    expect(normalizeGroupTitle(' UNDEFINED ')).toBeNull();
  });

  it('超长(>100)不截断伪造:防御性归一化按缺失处理(写入侧由导入验证失败拦截)', () => {
    expect(normalizeGroupTitle('a'.repeat(101))).toBeNull();
    expect(normalizeGroupTitle(`  ${'b'.repeat(101)}  `)).toBeNull();
  });
});

describe('pickMainGroupLabel(主分组选取)', () => {
  const entry = (sourceId: string, entryId: string, groupTitle: string | null): GroupTitleSource => ({
    sourceId,
    entryId,
    groupTitle,
  });

  it('唯一来源:取该 present 条目的非空 group_title', () => {
    expect(pickMainGroupLabel([entry('s1', 'e1', '央视')])).toBe('央视');
  });

  it('多来源:按 (source_id, entry_id) 升序选第一项非空 group_title(多来源多分组稳定主分组)', () => {
    const sources = [
      entry('s2', 'e1', '备用·体育'),
      entry('s1', 'e2', '央视'),
      entry('s1', 'e1', '卫视'),
    ];
    expect(pickMainGroupLabel(sources)).toBe('卫视');
    // 重复调用稳定(纯函数,同一输入恒同一结果)
    expect(pickMainGroupLabel(sources)).toBe('卫视');
    expect(pickMainGroupLabel([...sources].reverse())).toBe('卫视');
  });

  it('第一项非空优先:前面的来源分组为空白/NULL 时跳过,取下一非空项', () => {
    const sources = [
      entry('s1', 'e1', null),
      entry('s1', 'e2', '   '),
      entry('s2', 'e1', '影视'),
      entry('s3', 'e1', '体育'),
    ];
    expect(pickMainGroupLabel(sources)).toBe('影视');
  });

  it('全部缺失(无行/全 NULL/全空白)→ null,由调用方归入其他,不按标题臆测类型', () => {
    expect(pickMainGroupLabel([])).toBeNull();
    expect(pickMainGroupLabel([entry('s1', 'e1', null), entry('s2', 'e1', '')])).toBeNull();
    expect(pickMainGroupLabel([entry('s1', 'e1', 'CCTV-1 综合频道' as string)])).not.toBe('央视');
  });

  it('归一化在选取前执行:前置空白条目等同缺失,不遮蔽后续非空来源', () => {
    expect(pickMainGroupLabel([entry('s1', 'e1', '  '), entry('s2', 'e1', '纪录')])).toBe('纪录');
  });

  it('上游占位 Undefined 不参与主分组选取:首个非占位分组胜出,全占位归 NULL', () => {
    expect(pickMainGroupLabel([entry('s1', 'e1', 'Undefined'), entry('s1', 'e2', 'News')])).toBe('News');
    expect(pickMainGroupLabel([entry('s1', 'e1', 'Undefined'), entry('s2', 'e1', 'undefined')])).toBeNull();
  });
});

describe('groupKeyOf(不透明分组键)', () => {
  it('同一显示名恒产生同一 key(稳定),不同显示名 key 不同', () => {
    expect(groupKeyOf('央视')).toBe(groupKeyOf('央视'));
    expect(groupKeyOf('央视')).not.toBe(groupKeyOf('卫视'));
    expect(groupKeyOf(OTHER_GROUP_LABEL)).toBe(groupKeyOf('其他'));
  });

  it('key 不携带来源身份或源 URL:与 (source_id, entry_id, url) 全无关', () => {
    const fromEntryA = groupKeyOf('央视');
    // 相同 label 在任何来源/URL 语境下 key 一致 —— 不嵌入来源信息
    expect(fromEntryA).toBe(groupKeyOf('央视'));
    expect(fromEntryA).not.toContain('source');
    expect(fromEntryA).not.toContain('http');
    expect(fromEntryA).toMatch(/^[0-9a-z-]+$/);
  });
});
