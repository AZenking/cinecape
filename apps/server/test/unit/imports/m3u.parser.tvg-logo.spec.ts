import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { M3U_LOGO_MAX_LENGTH, parseM3U } from '@contexts/sources/infrastructure/m3u.parser';

/**
 * M3U 解析捕获与归一化矩阵:EXTINF `tvg-logo`(014 T012;FR-001/FR-010;research R1):
 * - 捕获:复用既有 attrValue 机制(tvg-logo="..." 原文),值 trim 后 1~2048 字符且仅
 *   http(s) scheme 为有效 Logo 地址;长度上界与 0009 source_entry.logo_url CHECK 对齐;
 * - 归一化失败一律按缺失处理归 null(绝不抛错、绝不让解析失败——FR-010:Logo 数据
 *   质量绝不阻塞导入),沿 group_title 解析层归一化先例但不走「超长整次拒绝」
 *   (Logo 是装饰性证据,超长/非法仅丢弃,不伪造、不失败);
 * - 值域下界:9 字符(http://x 仅 8 字符会撞 0009 CHECK 下界,归 null 保证发布层
 *   永不写入越界值);与 CHECK 一致,解析产物恒为「NULL 或 http(s) 且 9~2048」。
 */

/** 文本转单块 Buffer 流 */
function streamOf(content: string): Readable {
  return Readable.from([Buffer.from(content, 'utf8')]);
}

/** 构造单条目 M3U:EXTINF 属性区原文 + 标题 + 播放地址 */
function m3uOf(extinfAttrs: string, title = '频道', url = 'http://stream.example/ch'): string {
  const attrPart = extinfAttrs === '' ? '' : ` ${extinfAttrs}`;
  return `#EXTM3U\n#EXTINF:-1${attrPart},${title}\n${url}\n`;
}

describe('M3U 解析捕获与归一化:tvg-logo(T012;FR-001/FR-010;research R1)', () => {
  it('正常捕获:与其他 EXTINF 属性共存,地址原文保留(大小写/query 不归一化)', async () => {
    const content = m3uOf(
      'tvg-id="cctv-1" tvg-logo="http://CDN.example/logos/CCTV-1.png?v=2" tvg-name="CCTV-1" group-title="央视"',
      'CCTV-1 综合',
    );
    const { entries } = await parseM3U(streamOf(content));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tvgLogo).toBe('http://CDN.example/logos/CCTV-1.png?v=2');
    // 其余字段不受 Logo 捕获影响
    expect(entries[0]?.tvgId).toBe('cctv-1');
    expect(entries[0]?.groupTitle).toBe('央视');
    expect(entries[0]?.title).toBe('CCTV-1 综合');
  });

  it('值两侧空白 trim 归一化(沿 group_title 先例);纯空白值归 null', async () => {
    const padded = await parseM3U(streamOf(m3uOf('tvg-logo="  http://cdn.example/logo.png  "')));
    expect(padded.entries[0]?.tvgLogo).toBe('http://cdn.example/logo.png');

    const blank = await parseM3U(streamOf(m3uOf('tvg-logo="   "')));
    expect(blank.entries[0]?.tvgLogo).toBeNull();
  });

  it('属性缺失或空值 → tvgLogo=null(缺失等同无 Logo)', async () => {
    const missing = await parseM3U(streamOf(m3uOf('tvg-id="a"')));
    expect(missing.entries[0]?.tvgLogo).toBeNull();

    const empty = await parseM3U(streamOf(m3uOf('tvg-logo=""')));
    expect(empty.entries[0]?.tvgLogo).toBeNull();
  });

  it('trim 后超 2048 → 丢弃为 null(FR-010:丢弃不拒绝,解析不失败)', async () => {
    const over = `https://${'a'.repeat(2048 - 'https://'.length + 1)}`; // 2049 字符
    expect(over.length).toBe(M3U_LOGO_MAX_LENGTH + 1);
    const result = await parseM3U(streamOf(m3uOf(`tvg-logo="${over}"`)));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.tvgLogo).toBeNull();
  });

  it('边界:trim 后恰 2048 字符 → 捕获(存储值域上界)', async () => {
    const exact = `https://${'a'.repeat(2048 - 'https://'.length)}`;
    expect(exact.length).toBe(M3U_LOGO_MAX_LENGTH);
    const result = await parseM3U(streamOf(m3uOf(`tvg-logo="${exact}"`)));
    expect(result.entries[0]?.tvgLogo).toBe(exact);
  });

  it('非 http(s) scheme → 丢弃为 null(ftp/相对路径/伪 scheme 均<不做兜底猜测)', async () => {
    for (const invalid of [
      'ftp://cdn.example/logo.png',
      '/static/logo.png',
      'javascript:alert(1)',
      'httpsx://cdn.example/logo.png',
      'httpx://cdn.example/logo.png',
    ]) {
      const result = await parseM3U(streamOf(m3uOf(`tvg-logo="${invalid}"`)));
      expect(result.entries[0]?.tvgLogo, `非法地址应归 null:${invalid}`).toBeNull();
    }
  });

  it('scheme 大小写不敏感(HTTP:// 捕获;与 0009 LIKE 口径一致,原文保留不转小写)', async () => {
    const result = await parseM3U(streamOf(m3uOf('tvg-logo="HTTP://cdn.example/logo.PNG"')));
    expect(result.entries[0]?.tvgLogo).toBe('HTTP://cdn.example/logo.PNG');
  });

  it('值域下界 9 字符:http://x(8 字符)丢弃为 null;https://x(9 字符)捕获', async () => {
    // 与 0009 source_entry.logo_url CHECK(length BETWEEN 9 AND 2048)一致:
    // 解析层丢弃越界值,发布层永不写入会撞 CHECK 的地址(FR-010:绝不阻塞导入)
    const result = await parseM3U(
      streamOf(
        [
          '#EXTM3U',
          '#EXTINF:-1 tvg-logo="http://x",下界之下',
          'http://stream.example/a',
          '#EXTINF:-1 tvg-logo="https://x",下界之上',
          'http://stream.example/b',
        ].join('\n') + '\n',
      ),
    );
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]?.tvgLogo).toBeNull();
    expect(result.entries[1]?.tvgLogo).toBe('https://x');
  });

  it('解析含坏 logo 的整份文件不失败:合法/缺失/超长/非法 scheme 混合,各条目其余字段完整', async () => {
    const over = `https://${'a'.repeat(2048 - 'https://'.length + 1)}`;
    const content = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="ok" tvg-logo="http://cdn.example/ok.png",完好频道',
      'http://stream.example/ok',
      '#EXTINF:-1 tvg-id="none",无Logo频道',
      'http://stream.example/none',
      `#EXTINF:-1 tvg-id="over" tvg-logo="${over}",超长频道`,
      'http://stream.example/over',
      '#EXTINF:-1 tvg-id="bad" tvg-logo="ftp://cdn.example/bad.png",非法频道',
      'http://stream.example/bad',
      '#EXTINF:-1 tvg-id="empty" tvg-logo="",空值频道',
      'http://stream.example/empty',
    ].join('\n');
    const { entries } = await parseM3U(streamOf(content));
    expect(entries.map((entry) => entry.tvgId)).toEqual(['ok', 'none', 'over', 'bad', 'empty']);
    expect(entries.map((entry) => entry.tvgLogo)).toEqual([
      'http://cdn.example/ok.png',
      null,
      null,
      null,
      null,
    ]);
    expect(entries.map((entry) => entry.title)).toEqual([
      '完好频道',
      '无Logo频道',
      '超长频道',
      '非法频道',
      '空值频道',
    ]);
    expect(entries.every((entry) => entry.url.startsWith('http://stream.example/'))).toBe(true);
  });
});
