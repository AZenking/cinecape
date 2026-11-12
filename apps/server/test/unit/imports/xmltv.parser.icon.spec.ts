import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { XMLTVParseFailure, parseXMLTV } from '@contexts/sources/infrastructure/xmltv.parser';

/**
 * XMLTV 解析捕获与归一化矩阵:channel 帧首个 `<icon src>`(014 T030;FR-001/FR-010;
 * research R1/R5):解析规则与 M3U tvg-logo 完全同族(T014 先例):
 * - 捕获:channel 帧内首个 `<icon>` 元素的 src 属性;多 icon 取首个(行业惯例首个为主图标);
 * - 归一化:trim 后 9~2048 字符且仅 http/https scheme(与 0009 epg_channel.icon_url CHECK
 *   值域一致,发布层永不写入会撞 CHECK 的地址);原文保留(大小写/query 不改写);
 * - 非法一律归 null、绝不抛错、绝不让解析失败(FR-010:Logo 数据质量绝不阻塞导入);
 * - 缺失(icon 元素缺 src 属性/无 icon 元素)→ null;
 * - icon 与 display-name/多 icon 共存时互不影响,channels 其余字段完整。
 */

/** 文本转单块 Buffer 流 */
function streamOf(content: string): Readable {
  return Readable.from([Buffer.from(content, 'utf8')]);
}

/** 构造最小合法 XMLTV:channels 支持 icon 元素原文注入(其余字段由本 helper 生成) */
function xmltvOf(channelBodies: readonly string[], programmes: readonly string[] = []): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv>'];
  for (const [index, body] of channelBodies.entries()) {
    lines.push(`  <channel id="ch-${index + 1}">${body}</channel>`);
  }
  for (const programme of programmes) {
    lines.push(`  ${programme}`);
  }
  lines.push('</tv>');
  return `${lines.join('\n')}\n`;
}

/** 单节目行(时间恒合法,icon 矩阵不关心节目面) */
function programmeLine(channelIndex = 1): string {
  return `<programme channel="ch-${channelIndex}" start="20260101000000 +0800" stop="20260101010000 +0800"><title>节目</title></programme>`;
}

describe('XMLTV 解析捕获与归一化:channel 帧首个 icon src(T030;FR-001/FR-010;research R1)', () => {
  it('正常捕获:首个 icon src 原文保留(大小写/query 不归一化),display-name 不受影响', async () => {
    const xml = xmltvOf([
      '<display-name>频道一</display-name><icon src="http://CDN.example/logos/CH-1.png?v=2"/>',
    ], [programmeLine()]);
    const { channels } = await parseXMLTV(streamOf(xml));
    expect(channels).toHaveLength(1);
    expect(channels[0]?.xmltvChannelId).toBe('ch-1');
    expect(channels[0]?.displayName).toBe('频道一');
    expect(channels[0]?.iconUrl).toBe('http://CDN.example/logos/CH-1.png?v=2');
  });

  it('多 icon 取首个:首个有效 src 捕获,后续 icon 不覆盖', async () => {
    const xml = xmltvOf([
      '<icon src="http://cdn.example/first.png"/><icon src="http://cdn.example/second.png"/>',
    ]);
    const { channels } = await parseXMLTV(streamOf(xml));
    expect(channels[0]?.iconUrl).toBe('http://cdn.example/first.png');
  });

  it('缺失:无 icon 元素 → iconUrl=null', async () => {
    const xml = xmltvOf(['<display-name>无图标频道</display-name>']);
    const { channels } = await parseXMLTV(streamOf(xml));
    expect(channels).toHaveLength(1);
    expect(channels[0]?.iconUrl).toBeNull();
  });

  it('icon 元素缺 src 属性 → iconUrl=null(缺失等同无 Logo)', async () => {
    const xml = xmltvOf(['<icon/>']);
    const { channels } = await parseXMLTV(streamOf(xml));
    expect(channels[0]?.iconUrl).toBeNull();
  });

  it('值两侧空白 trim 归一化(沿 M3U tvg-logo 先例);纯空白值归 null', async () => {
    const padded = await parseXMLTV(streamOf(xmltvOf(['<icon src="  http://cdn.example/logo.png  "/>'])));
    expect(padded.channels[0]?.iconUrl).toBe('http://cdn.example/logo.png');

    const blank = await parseXMLTV(streamOf(xmltvOf(['<icon src="   "/>'])));
    expect(blank.channels[0]?.iconUrl).toBeNull();
  });

  it('trim 后超 2048 → 丢弃为 null(FR-010:丢弃不拒绝,解析不失败)', async () => {
    const over = `https://${'a'.repeat(2048 - 'https://'.length + 1)}`; // 2049 字符
    expect(over.length).toBe(2049);
    const result = await parseXMLTV(streamOf(xmltvOf([`<icon src="${over}"/>`])));
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]?.iconUrl).toBeNull();
  });

  it('边界:trim 后恰 2048 字符 → 捕获;9 字符下界之下(8 字符 http://x)→ null', async () => {
    const exact = `https://${'a'.repeat(2048 - 'https://'.length)}`;
    expect(exact.length).toBe(2048);
    const exactResult = await parseXMLTV(streamOf(xmltvOf([`<icon src="${exact}"/>`])));
    expect(exactResult.channels[0]?.iconUrl).toBe(exact);

    const below = await parseXMLTV(streamOf(xmltvOf(['<icon src="http://x"/>'])));
    expect(below.channels[0]?.iconUrl).toBeNull();
  });

  it('非 http(s) scheme → 丢弃为 null(ftp/相对路径/伪 scheme 均不做兜底猜测)', async () => {
    for (const invalid of [
      'ftp://cdn.example/logo.png',
      '/static/logo.png',
      'javascript:alert(1)',
      'httpsx://cdn.example/logo.png',
      'data:image/png;base64,AAAA',
    ]) {
      const result = await parseXMLTV(streamOf(xmltvOf([`<icon src="${invalid}"/>`])));
      expect(result.channels[0]?.iconUrl, `非法地址应归 null:${invalid}`).toBeNull();
    }
  });

  it('scheme 大小写不敏感(HTTP:// 捕获;与 0009 LIKE 口径一致,原文保留不转小写)', async () => {
    const result = await parseXMLTV(streamOf(xmltvOf(['<icon src="HTTP://cdn.example/logo.PNG"/>'])));
    expect(result.channels[0]?.iconUrl).toBe('HTTP://cdn.example/logo.PNG');
  });

  it('解析含坏 icon 的整份文件不失败(FR-010):合法/缺失/超长/非法 scheme 混合,各频道字段完整', async () => {
    const over = `https://${'a'.repeat(2048 - 'https://'.length + 1)}`;
    const xml = xmltvOf([
      '<display-name>完好频道</display-name><icon src="http://cdn.example/ok.png"/>',
      '<display-name>无图标频道</display-name>',
      `<display-name>超长频道</display-name><icon src="${over}"/>`,
      '<display-name>非法频道</display-name><icon src="ftp://cdn.example/bad.png"/>',
      '<display-name>空值频道</display-name><icon src=""/>',
    ], [programmeLine(1), programmeLine(2)]);
    const { channels, programmes, conflictedChannelIds } = await parseXMLTV(streamOf(xml));
    expect(channels.map((channel) => channel.displayName)).toEqual([
      '完好频道',
      '无图标频道',
      '超长频道',
      '非法频道',
      '空值频道',
    ]);
    expect(channels.map((channel) => channel.iconUrl)).toEqual([
      'http://cdn.example/ok.png',
      null,
      null,
      null,
      null,
    ]);
    expect(programmes).toHaveLength(2);
    expect(conflictedChannelIds).toHaveLength(0);
  });

  it('icon 元素内嵌套内容不参与捕获、不破坏解析(src 属性是唯一取值面)', async () => {
    const xml = xmltvOf([
      '<icon src="http://cdn.example/outer.png"><内部元素>文本</内部元素></icon>',
    ]);
    const { channels } = await parseXMLTV(streamOf(xml));
    expect(channels[0]?.iconUrl).toBe('http://cdn.example/outer.png');
  });

  it('多频道各自独立捕获:互不串值、互不锁定', async () => {
    const xml = xmltvOf([
      '<icon src="http://cdn.example/a.png"/>',
      '<display-name>没有图标的频道</display-name>',
      '<icon src="https://cdn.example/c.png"/>',
    ]);
    const { channels } = await parseXMLTV(streamOf(xml));
    expect(channels.map((channel) => channel.iconUrl)).toEqual([
      'http://cdn.example/a.png',
      null,
      'https://cdn.example/c.png',
    ]);
  });

  it('坏 icon 不改变既有失败语义:真正非法的文档仍整次失败(对照既有矩阵)', async () => {
    // 未闭合标签仍是 FORMAT_INVALID;icon 捕获不放宽既有安全/格式门
    const broken = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n  <channel id="cctv1"><icon src="http://cdn.example/a.png"/>\n';
    await expect(parseXMLTV(streamOf(broken))).rejects.toBeInstanceOf(XMLTVParseFailure);
  });
});
