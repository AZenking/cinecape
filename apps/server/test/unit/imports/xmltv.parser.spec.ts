import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPORT_BUDGETS } from '../../../src/config/import-budgets';
import {
  parseXMLTV,
  XMLTV_ERROR,
  XMLTVParseFailure,
} from '../../../src/modules/imports/xmltv.parser';
import { buildXmltv, malformedPayloads } from '../../fixtures/controlled-media-server';

/**
 * T016:XMLTV 流式解析器单测(research R2/R6、data-model epg_channel/epg_programme)。
 * 覆盖:正常解析与时区归一、窗口过滤、严格安全(sax strict)、预算(压缩前后独立计数)、
 * 时间语义、冲突标记、缺必要字段整次失败、gzip 与分块输入。
 */

/** 把 XML 文本包成单块 Readable 流。 */
function streamOf(xml: string): Readable {
  return Readable.from([Buffer.from(xml, 'utf8')]);
}

/** 把 XML 文本切成极小的块,以异步生成器(非 Readable)形态输出,验证流式与多字节跨块解码。 */
async function* tinyChunkIter(xml: string, size = 3): AsyncIterable<Buffer> {
  const buf = Buffer.from(xml, 'utf8');
  for (let i = 0; i < buf.length; i += size) {
    yield buf.subarray(i, i + size);
  }
}

/** 取解析失败的稳定 code;不失败则显式断言失败。 */
async function failureOf(
  input: Readable | AsyncIterable<Buffer>,
  opts: Parameters<typeof parseXMLTV>[1] = {},
): Promise<XMLTVParseFailure> {
  try {
    await parseXMLTV(input, opts);
  } catch (error) {
    expect(error).toBeInstanceOf(XMLTVParseFailure);
    return error as XMLTVParseFailure;
  }
  throw new Error('应当解析失败,却得到成功结果');
}

/** 预算覆写表:测试内临时缩小 IMPORT_BUDGETS 的某项,afterEach 还原(不改动配置文件)。 */
const savedBudgetDescriptors = new Map<string, PropertyDescriptor | undefined>();

type XmltvBudgetKey =
  | 'XMLTV_MAX_TRANSFER_BYTES'
  | 'XMLTV_MAX_DECOMPRESSED_BYTES'
  | 'XMLTV_MAX_PROGRAMMES'
  | 'XMLTV_MAX_FIELD_BYTES'
  | 'XMLTV_MAX_DEPTH';

function patchBudget(key: XmltvBudgetKey, value: number): void {
  if (!savedBudgetDescriptors.has(key)) {
    savedBudgetDescriptors.set(key, Object.getOwnPropertyDescriptor(IMPORT_BUDGETS, key));
  }
  Object.defineProperty(IMPORT_BUDGETS, key, { value, configurable: true, writable: true });
}

afterEach(() => {
  for (const [key, descriptor] of savedBudgetDescriptors) {
    if (descriptor !== undefined) {
      Object.defineProperty(IMPORT_BUDGETS, key, descriptor);
    }
  }
  savedBudgetDescriptors.clear();
});

/** 刷新窗口:2026-01-01T00:00:00Z ~ 2026-01-02T00:00:00Z(对应 T026 刷新时计算后传入)。 */
const WINDOW = {
  windowStartUtc: new Date('2026-01-01T00:00:00.000Z'),
  windowEndUtc: new Date('2026-01-02T00:00:00.000Z'),
} as const;

describe('parseXMLTV 正常解析(T016/research R2/R6)', () => {
  it('解析 channels(id/display-name)与 programmes,并把 +0800 时间统一转 UTC', async () => {
    const xml = buildXmltv(
      [
        { id: 'cctv1', displayName: 'CCTV-1 综合' },
        { id: 'cctv2', displayName: 'CCTV-2 财经' },
      ],
      [
        {
          channel: 'cctv1',
          start: '20260101080000 +0800',
          stop: '20260101090000 +0800',
          title: '新闻联播',
        },
        {
          channel: 'cctv2',
          start: '20260101230000 +0800',
          stop: '20260101233000 +0800',
          title: '深夜档',
        },
      ],
    );

    const result = await parseXMLTV(streamOf(xml));

    expect(result.channels).toEqual([
      { xmltvChannelId: 'cctv1', displayName: 'CCTV-1 综合' },
      { xmltvChannelId: 'cctv2', displayName: 'CCTV-2 财经' },
    ]);
    expect(result.programmes).toHaveLength(2);
    expect(result.programmes[0]).toMatchObject({
      xmltvChannelId: 'cctv1',
      title: '新闻联播',
      description: null,
    });
    expect(result.programmes[0]?.startsAtUtc.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(result.programmes[0]?.endsAtUtc.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    expect(result.programmes[1]?.startsAtUtc.toISOString()).toBe('2026-01-01T15:00:00.000Z');
    expect(result.conflictedChannelIds).toHaveLength(0);
  });

  it('desc 为可选字段:提供时输出,缺省为 null;Z 后缀时间同样归一 UTC', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel id="ch1"><display-name>频道一</display-name></channel>',
      '  <programme channel="ch1" start="20260101000000 Z" stop="20260101003000 +0000">',
      '    <title>带简介节目</title>',
      '    <desc>剧情简介</desc>',
      '  </programme>',
      '  <programme channel="ch1" start="20260101010000 +0000" stop="20260101013000 +0000">',
      '    <title>无简介节目</title>',
      '  </programme>',
      '</tv>',
    ].join('\n');

    const result = await parseXMLTV(streamOf(xml));

    expect(result.programmes).toHaveLength(2);
    expect(result.programmes[0]).toMatchObject({
      title: '带简介节目',
      description: '剧情简介',
    });
    expect(result.programmes[0]?.startsAtUtc.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(result.programmes[1]?.description).toBeNull();
  });

  it('极小分块异步生成器输入:中文多字节跨块解码正确', async () => {
    const xml = buildXmltv(
      [{ id: 'cctv1', displayName: '中文频道·新闻' }],
      [
        {
          channel: 'cctv1',
          start: '20260101080000 +0800',
          stop: '20260101090000 +0800',
          title: '新闻联播·特别报道',
        },
      ],
    );

    const result = await parseXMLTV(tinyChunkIter(xml));

    expect(result.channels).toEqual([{ xmltvChannelId: 'cctv1', displayName: '中文频道·新闻' }]);
    expect(result.programmes[0]?.title).toBe('新闻联播·特别报道');
  });

  it('完全相同的重复节目去重,不算冲突', async () => {
    const programme = {
      channel: 'cctv1',
      start: '20260101080000 +0800',
      stop: '20260101090000 +0800',
      title: '新闻联播',
    };
    const xml = buildXmltv([{ id: 'cctv1' }], [programme, programme]);

    const result = await parseXMLTV(streamOf(xml));

    expect(result.programmes).toHaveLength(1);
    expect(result.conflictedChannelIds).toHaveLength(0);
  });
});

describe('窗口过滤(仅保留与刷新窗口相交的节目)', () => {
  it('早于/晚于窗口的节目丢弃且不报错,相交节目保留', async () => {
    const xml = buildXmltv(
      [{ id: 'cctv1' }],
      [
        {
          channel: 'cctv1',
          start: '20251231080000 +0800',
          stop: '20251231090000 +0800',
          title: '窗口前节目',
        },
        {
          channel: 'cctv1',
          start: '20260101080000 +0800',
          stop: '20260101090000 +0800',
          title: '窗口内节目',
        },
        {
          channel: 'cctv1',
          start: '20260102100000 +0800',
          stop: '20260102110000 +0800',
          title: '窗口后节目',
        },
      ],
    );

    const result = await parseXMLTV(streamOf(xml), WINDOW);

    expect(result.programmes.map((p) => p.title)).toEqual(['窗口内节目']);
  });

  it('窗口边界相触按闭区间相交保留(stop==windowStart、start==windowEnd)', async () => {
    const xml = buildXmltv(
      [{ id: 'cctv1' }],
      [
        {
          channel: 'cctv1',
          start: '20251231220000 +0800',
          stop: '20260101080000 +0800',
          title: '跨入窗口(结束恰在起点)',
        },
        {
          channel: 'cctv1',
          start: '20260102080000 +0800',
          stop: '20260102090000 +0800',
          title: '恰在终点开始',
        },
      ],
    );

    const result = await parseXMLTV(streamOf(xml), WINDOW);

    expect(result.programmes).toHaveLength(2);
  });

  it('被窗口丢弃的节目不参与冲突标记(保留集合内单独存在 → 不冲突)', async () => {
    // 窗口 [2025-12-31T14:00Z, 2026-01-02T00:00Z]:
    // P_out [12:00Z, 13:30Z] 与 P_keep [13:00Z, 次日 01:00Z] 时间重叠,
    // 但 P_out 整体早于窗口被丢弃;冲突判定只针对保留集合 → cctv1 不标 conflicted。
    const xml = buildXmltv(
      [{ id: 'cctv1' }],
      [
        {
          channel: 'cctv1',
          start: '20251231200000 +0800',
          stop: '20251231213000 +0800',
          title: '窗口外重叠节目',
        },
        {
          channel: 'cctv1',
          start: '20251231210000 +0800',
          stop: '20260101090000 +0800',
          title: '跨窗口重叠节目',
        },
        {
          channel: 'cctv1',
          start: '20260102100000 +0800',
          stop: '20260102110000 +0800',
          title: '窗口后节目',
        },
      ],
    );

    const result = await parseXMLTV(streamOf(xml), {
      windowStartUtc: new Date('2025-12-31T14:00:00.000Z'),
      windowEndUtc: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(result.programmes.map((p) => p.title)).toEqual(['跨窗口重叠节目']);
    expect(result.conflictedChannelIds).toHaveLength(0);
  });
});

describe('严格安全(sax strict,research R2)', () => {
  it('DOCTYPE(内部子集 + 实体声明)拒绝', async () => {
    const failure = await failureOf(streamOf(malformedPayloads.xmlWithDoctype()));
    expect(failure.code).toBe(XMLTV_ERROR.DOCTYPE_DENIED);
  });

  it('外部 SYSTEM DTD 拒绝,且错误信息不含 URL 与 XML 片段', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE tv SYSTEM "http://evil.example/xxe.dtd">',
      '<tv><channel id="cctv1"><display-name>CCTV-1</display-name></channel></tv>',
    ].join('\n');

    const failure = await failureOf(streamOf(xml));

    expect(failure.code).toBe(XMLTV_ERROR.DOCTYPE_DENIED);
    expect(failure.message).not.toMatch(/http|</);
  });

  it('未声明的自定义实体拒绝', async () => {
    const failure = await failureOf(streamOf(malformedPayloads.xmlWithUnknownEntity()));
    expect(failure.code).toBe(XMLTV_ERROR.UNKNOWN_ENTITY);
  });

  it('非 xml 声明的处理指令拒绝', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?render mode="fast"?>',
      '<tv><channel id="cctv1"><display-name>CCTV-1</display-name></channel></tv>',
    ].join('\n');

    const failure = await failureOf(streamOf(xml));

    expect(failure.code).toBe(XMLTV_ERROR.DOCTYPE_DENIED);
  });

  it('畸形 XML(未闭合根标签)拒绝', async () => {
    const failure = await failureOf(streamOf(malformedPayloads.brokenXml()));
    expect(failure.code).toBe(XMLTV_ERROR.FORMAT_INVALID);
  });

  it('空输入(无根元素)拒绝', async () => {
    const failure = await failureOf(streamOf(''));
    expect(failure.code).toBe(XMLTV_ERROR.FORMAT_INVALID);
  });

  it('嵌套超过 32 层拒绝', async () => {
    const failure = await failureOf(streamOf(malformedPayloads.deeplyNestedXml()));
    expect(failure.code).toBe(XMLTV_ERROR.DEPTH_EXCEEDED);
  });

  it('恰好 32 层嵌套允许(tv + 30 层 layer + 内层 title);再深一层即拒绝', async () => {
    // fixture: <tv> + depth 层 <layer> + 最内层 <title>,总深度 = depth + 2。
    const ok = await parseXMLTV(streamOf(malformedPayloads.deeplyNestedXml(30)));
    expect(ok.channels).toEqual([]);
    expect(ok.programmes).toEqual([]);

    const failure = await failureOf(streamOf(malformedPayloads.deeplyNestedXml(31)));
    expect(failure.code).toBe(XMLTV_ERROR.DEPTH_EXCEEDED);
  });
});

describe('预算(压缩前后独立计数,IMPORT_BUDGETS 不变)', () => {
  it('传输字节超限失败(明文计数)', async () => {
    patchBudget('XMLTV_MAX_TRANSFER_BYTES', 16);
    const xml = buildXmltv([{ id: 'cctv1' }]);

    const failure = await failureOf(streamOf(xml));

    expect(failure.code).toBe(XMLTV_ERROR.BUDGET_TRANSFER);
  });

  it('gzip 输入按压缩后字节计传输预算:压缩体积可过而明文体积不可过', async () => {
    const xml = buildXmltv(
      [{ id: 'cctv1', displayName: 'CCTV-1' }],
      [
        {
          channel: 'cctv1',
          start: '20260101080000 +0800',
          stop: '20260101090000 +0800',
          title: '节目标题',
        },
      ],
    );
    const raw = Buffer.from(xml, 'utf8');
    const gz = gzipSync(raw);
    expect(gz.length).toBeLessThan(raw.length);

    // 压缩后字节 < 传输预算 < 明文字节 → 正常解析,证明传输侧按压缩字节计数。
    patchBudget('XMLTV_MAX_TRANSFER_BYTES', gz.length + 16);
    const ok = await parseXMLTV(Readable.from([gz]));
    expect(ok.programmes).toHaveLength(1);

    // 传输预算压到压缩体积之下 → BUDGET_TRANSFER(gzip 原始字节计数)。
    patchBudget('XMLTV_MAX_TRANSFER_BYTES', 8);
    const failure = await failureOf(Readable.from([gz]));
    expect(failure.code).toBe(XMLTV_ERROR.BUDGET_TRANSFER);
  });

  it('解压后字节超限失败(gzip 炸弹,与传输计数相互独立)', async () => {
    const xml = buildXmltv(
      [{ id: 'cctv1' }],
      Array.from({ length: 64 }, (_, i) => ({
        channel: 'cctv1',
        start: `2026010100${String(i * 30).padStart(4, '0')}00 +0800`,
        stop: `2026010100${String(i * 30 + 29).padStart(4, '0')}00 +0800`,
        title: `填充节目${'内容'.repeat(200)}${i}`,
      })),
    );
    const gz = gzipSync(Buffer.from(xml, 'utf8'));
    patchBudget('XMLTV_MAX_TRANSFER_BYTES', 4 * 1024 * 1024);
    patchBudget('XMLTV_MAX_DECOMPRESSED_BYTES', 2 * 1024);

    const failure = await failureOf(Readable.from([gz]));

    expect(failure.code).toBe(XMLTV_ERROR.BUDGET_DECOMPRESSED);
  });

  it('节目数超过上限失败', async () => {
    patchBudget('XMLTV_MAX_PROGRAMMES', 2);
    const xml = buildXmltv(
      [{ id: 'cctv1' }],
      [1, 2, 3].map((i) => ({
        channel: 'cctv1',
        start: `202601010${i}0000 +0800`,
        stop: `202601010${i}1000 +0800`,
        title: `节目${i}`,
      })),
    );

    const failure = await failureOf(streamOf(xml));

    expect(failure.code).toBe(XMLTV_ERROR.BUDGET_ENTRIES);
  });

  it('title 超过 64 KiB 失败(真实预算,不覆写)', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel id="cctv1"><display-name>CCTV-1</display-name></channel>',
      `  <programme channel="cctv1" start="20260101080000 +0800" stop="20260101090000 +0800">`,
      `    <title>${'长'.repeat(40000)}</title>`,
      '  </programme>',
      '</tv>',
    ].join('\n');

    const failure = await failureOf(streamOf(xml));

    expect(failure.code).toBe(XMLTV_ERROR.FIELD_TOO_LONG);
  });

  it('title 恰好 64 KiB 允许(边界)', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel id="cctv1"><display-name>CCTV-1</display-name></channel>',
      `  <programme channel="cctv1" start="20260101080000 +0800" stop="20260101090000 +0800">`,
      `    <title>${'a'.repeat(IMPORT_BUDGETS.XMLTV_MAX_FIELD_BYTES)}</title>`,
      '  </programme>',
      '</tv>',
    ].join('\n');

    const result = await parseXMLTV(streamOf(xml));

    expect(result.programmes).toHaveLength(1);
  });

  it('desc 与 display-name 超限同样 FIELD_TOO_LONG', async () => {
    const longDesc = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel id="cctv1"><display-name>CCTV-1</display-name></channel>',
      `  <programme channel="cctv1" start="20260101080000 +0800" stop="20260101090000 +0800">`,
      '    <title>标题</title>',
      `    <desc>${'a'.repeat(IMPORT_BUDGETS.XMLTV_MAX_FIELD_BYTES + 1)}</desc>`,
      '  </programme>',
      '</tv>',
    ].join('\n');
    expect((await failureOf(streamOf(longDesc))).code).toBe(XMLTV_ERROR.FIELD_TOO_LONG);

    const longName = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      `  <channel id="cctv1"><display-name>${'a'.repeat(IMPORT_BUDGETS.XMLTV_MAX_FIELD_BYTES + 1)}</display-name></channel>`,
      '</tv>',
    ].join('\n');
    expect((await failureOf(streamOf(longName))).code).toBe(XMLTV_ERROR.FIELD_TOO_LONG);
  });
});

describe('时间语义(必须带合法时区,统一 UTC)', () => {
  it('缺时区的时间戳非法(TIMEZONE_MISSING)', async () => {
    const xml = buildXmltv([{ id: 'cctv1' }], [
      { channel: 'cctv1', start: '20260101080000', stop: '20260101090000 +0800', title: 'x' },
    ]);

    expect((await failureOf(streamOf(xml))).code).toBe(XMLTV_ERROR.TIMEZONE_MISSING);
  });

  it('stop 等于或早于 start 均非法(TIME_INVALID)', async () => {
    const equal = buildXmltv([{ id: 'cctv1' }], [
      { channel: 'cctv1', start: '20260101080000 +0800', stop: '20260101080000 +0800', title: 'x' },
    ]);
    expect((await failureOf(streamOf(equal))).code).toBe(XMLTV_ERROR.TIME_INVALID);

    const inverted = buildXmltv([{ id: 'cctv1' }], [
      { channel: 'cctv1', start: '20260101090000 +0800', stop: '20260101080000 +0800', title: 'x' },
    ]);
    expect((await failureOf(streamOf(inverted))).code).toBe(XMLTV_ERROR.TIME_INVALID);
  });

  it('时间格式非法整次失败(TIME_INVALID)', async () => {
    for (const bad of ['2026-01-01T08:00:00+08:00', '2026010108', '20260101080000 +08']) {
      const xml = buildXmltv([{ id: 'cctv1' }], [
        { channel: 'cctv1', start: bad, stop: '20260101100000 +0800', title: 'x' },
      ]);
      expect(await failureOf(streamOf(xml)), `非法时间应拒绝:${bad}`).toBeDefined();
    }
  });

  it('日历不存在的时间非法(TIME_INVALID)', async () => {
    const xml = buildXmltv([{ id: 'cctv1' }], [
      {
        channel: 'cctv1',
        start: '20260230080000 +0800',
        stop: '20260230090000 +0800',
        title: 'x',
      },
    ]);

    expect((await failureOf(streamOf(xml))).code).toBe(XMLTV_ERROR.TIME_INVALID);
  });

  it('负偏移时区换算正确(-0500 → 加 5 小时)', async () => {
    const xml = buildXmltv([{ id: 'cctv1' }], [
      {
        channel: 'cctv1',
        start: '20260101120000 -0500',
        stop: '20260101130000 -0500',
        title: 'x',
      },
    ]);

    const result = await parseXMLTV(streamOf(xml));

    expect(result.programmes[0]?.startsAtUtc.toISOString()).toBe('2026-01-01T17:00:00.000Z');
  });
});

describe('冲突检测(channel id 重复 / 同频道节目时间重叠)', () => {
  it('重复 xmltv channel id(相同 display-name)→ 该 channel 标 conflicted 且去重为一条', async () => {
    const xml = buildXmltv([{ id: 'cctv1', displayName: 'CCTV-1' }, { id: 'cctv1', displayName: 'CCTV-1' }]);

    const result = await parseXMLTV(streamOf(xml));

    expect(result.channels).toHaveLength(1);
    expect(result.conflictedChannelIds as string[]).toContain('cctv1');
  });

  it('channel 结构性重复声明且 display-name 不同 → 拒绝(DUPLICATE_DECLINED)', async () => {
    const xml = buildXmltv([{ id: 'cctv1', displayName: 'CCTV-1' }, { id: 'cctv1', displayName: '另一个名字' }]);

    expect((await failureOf(streamOf(xml))).code).toBe(XMLTV_ERROR.DUPLICATE_DECLINED);
  });

  it('同频道节目时间重叠 → 该频道 conflicted;首尾相接不算;其他频道不受影响', async () => {
    const xml = buildXmltv(
      [{ id: 'cctv1' }, { id: 'cctv2' }],
      [
        // cctv1:重叠对
        { channel: 'cctv1', start: '20260101080000 +0800', stop: '20260101100000 +0800', title: 'A' },
        { channel: 'cctv1', start: '20260101090000 +0800', stop: '20260101110000 +0800', title: 'B' },
        // cctv1:首尾相接对(相邻,合法)
        { channel: 'cctv1', start: '20260101110000 +0800', stop: '20260101120000 +0800', title: 'C' },
        { channel: 'cctv1', start: '20260101120000 +0800', stop: '20260101130000 +0800', title: 'D' },
        // cctv2:自身重叠对 → 只有 cctv1/cctv2 各自标记
        { channel: 'cctv2', start: '20260101080000 +0800', stop: '20260101090000 +0800', title: 'E' },
        { channel: 'cctv2', start: '20260101083000 +0800', stop: '20260101093000 +0800', title: 'F' },
      ],
    );

    const result = await parseXMLTV(streamOf(xml));

    expect(result.conflictedChannelIds as string[]).toEqual(['cctv1', 'cctv2']);
  });

  it('同一时间键但 title 不同的两条节目视为不同记录重叠 → conflicted', async () => {
    const xml = buildXmltv([{ id: 'cctv1' }], [
      { channel: 'cctv1', start: '20260101080000 +0800', stop: '20260101090000 +0800', title: '原标题' },
      { channel: 'cctv1', start: '20260101080000 +0800', stop: '20260101090000 +0800', title: '另一个标题' },
    ]);

    const result = await parseXMLTV(streamOf(xml));

    expect(result.programmes).toHaveLength(1);
    expect(result.programmes[0]?.title).toBe('原标题');
    expect(result.conflictedChannelIds as string[]).toContain('cctv1');
  });
});

describe('缺必要字段 → 整次失败(REQUIRED_FIELD_MISSING,不是跳过)', () => {
  it('channel 缺 id 属性', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel><display-name>无名频道</display-name></channel>',
      '</tv>',
    ].join('\n');

    expect((await failureOf(streamOf(xml))).code).toBe(XMLTV_ERROR.REQUIRED_FIELD_MISSING);
  });

  it('programme 缺 channel/start/stop 属性', async () => {
    for (const [label, attrs] of [
      ['缺 channel', ''],
      ['缺 start', ' channel="cctv1" stop="20260101090000 +0800"'],
      ['缺 stop', ' channel="cctv1" start="20260101080000 +0800"'],
    ] as const) {
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<tv>',
        '  <channel id="cctv1"><display-name>CCTV-1</display-name></channel>',
        `  <programme${attrs}>`,
        '    <title>x</title>',
        '  </programme>',
        '</tv>',
      ].join('\n');
      expect((await failureOf(streamOf(xml))).code, label).toBe(XMLTV_ERROR.REQUIRED_FIELD_MISSING);
    }
  });

  it('programme 无 title 子元素', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv>',
      '  <channel id="cctv1"><display-name>CCTV-1</display-name></channel>',
      '  <programme channel="cctv1" start="20260101080000 +0800" stop="20260101090000 +0800">',
      '    <desc>没有标题</desc>',
      '  </programme>',
      '</tv>',
    ].join('\n');

    expect((await failureOf(streamOf(xml))).code).toBe(XMLTV_ERROR.REQUIRED_FIELD_MISSING);
  });
});

describe('gzip 与输入形态', () => {
  it('gzip 输入自动解压解析,结果与明文一致(压缩前后计数独立不互相挤占)', async () => {
    const xml = buildXmltv(
      [{ id: 'cctv1', displayName: 'CCTV-1' }],
      [
        {
          channel: 'cctv1',
          start: '20260101080000 +0800',
          stop: '20260101090000 +0800',
          title: '新闻联播',
        },
      ],
    );
    const plain = await parseXMLTV(streamOf(xml));
    const gzipped = await parseXMLTV(Readable.from([gzipSync(Buffer.from(xml, 'utf8'))]));

    expect(gzipped.channels).toEqual(plain.channels);
    expect(gzipped.programmes.map((p) => [p.title, p.startsAtUtc.toISOString()])).toEqual(
      plain.programmes.map((p) => [p.title, p.startsAtUtc.toISOString()]),
    );
    expect(gzipped.conflictedChannelIds).toHaveLength(0);
  });

  it('解压后再遇 gzip 魔数不再递归解压(按畸形 XML 拒绝)', async () => {
    const inner = gzipSync(Buffer.from(buildXmltv([{ id: 'cctv1' }]), 'utf8'));
    const outer = gzipSync(inner);

    const failure = await failureOf(Readable.from([outer]));

    expect(failure.code).toBe(XMLTV_ERROR.FORMAT_INVALID);
  });
});

describe('裸 Buffer 输入(逐字节迭代防护;Buffer 是同步可迭代,禁止被拆成单字节)', () => {
  it('直接传入 Buffer(非流)完整解析出频道与节目', async () => {
    const xml = buildXmltv([{ id: 'c1', displayName: 'C1' }], [
      { channel: 'c1', title: 'T', start: '20261024100000 +0800', stop: '20261024110000 +0800' },
    ]);
    const result = await parseXMLTV(Buffer.from(xml, 'utf8'));
    expect(result.channels.length).toBe(1);
    expect(result.programmes.length).toBe(1);
    expect(result.programmes[0]?.title).toBe('T');
  });
});
