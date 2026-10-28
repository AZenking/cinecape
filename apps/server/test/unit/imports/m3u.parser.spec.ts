import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { IMPORT_BUDGETS } from '@platform/config/import-budgets';
import {
  M3U_BUDGET_EXCEEDED,
  M3U_DECODE_FAILED,
  M3U_ENTRY_MISSING_URL,
  M3U_FORMAT_INVALID,
  M3U_NOT_CHANNEL_LIST,
  M3UParseFailure,
  parseM3U,
  type M3UErrorCode,
} from '@contexts/sources/infrastructure/m3u.parser';
import { buildLargeM3u, buildM3u, malformedPayloads } from '../../fixtures';

/**
 * M3U 流式解析器测试(T013;FR-004/research R2/R6):
 * - 身份材料:解析层只输出原始材料(tvgId 原文或 null + 完整 url),
 *   摘要(SHA-256)与重复身份冲突判定由后续 staging/catalog-diff 任务负责;
 * - 大小写敏感与 query 保留:URL/tvg-id 原样输出,不做任何归一化;
 * - 预算:总字节/条目数/单行字节任一超限整次失败(边界恰等预算值必须通过);
 * - 失败语义:任一条目非法整次失败并携带稳定 code,绝不跳过坏行;
 * - 脱敏边界:错误信息只含行号与语义,不携带 URL/凭据原文(脱敏是展示层责任,
 *   解析层不丢信息,凭据 URL 原样保留在解析结果中)。
 */

/** 文本转单块 Buffer 流 */
function streamOf(content: string): Readable {
  return Readable.from([Buffer.from(content, 'utf8')]);
}

/** Buffer 转单块流 */
function streamOfBuffer(buffer: Buffer): Readable {
  return Readable.from([buffer]);
}

/** 运行解析并返回失败;断言失败为 M3UParseFailure 且携带期望稳定 code */
async function failureCodeOf(run: () => Promise<unknown>, expectedCode: M3UErrorCode): Promise<M3UParseFailure> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望解析失败(${expectedCode})但成功返回`).toBeInstanceOf(M3UParseFailure);
  const failure = caught as M3UParseFailure;
  expect(failure.code).toBe(expectedCode);
  return failure;
}

/** 将文本按给定字节数切成 Buffer 流(默认 3 字节,刻意打散多字节字符与 \r\n 序列) */
function chunkedStream(text: string, chunkBytes = 3): Readable {
  const source = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < source.length; offset += chunkBytes) {
    chunks.push(source.subarray(offset, offset + chunkBytes));
  }
  return Readable.from(chunks);
}

/**
 * 构造总字节数恰为 targetBytes 的 M3U 载荷:
 * 首部为 1 条合法条目,其余用注释行填充;每行内容 ≤ 单行预算,不触碰单行预算。
 */
function buildExactBytesM3u(targetBytes: number): Buffer {
  const entry = Buffer.from('#EXTM3U\n#EXTINF:-1 tvg-id="exact",Exact\nhttp://stream.example/exact\n', 'utf8');
  if (targetBytes < entry.length + 2) {
    throw new Error('目标字节数过小,无法构造');
  }
  const parts: Buffer[] = [entry];
  let remaining = targetBytes - entry.length;
  while (remaining >= 2) {
    // 每行占 contentBytes 内容 + 1 字节换行;'#' 计入内容
    const contentBytes = Math.min(IMPORT_BUDGETS.M3U_MAX_LINE_BYTES, remaining - 1);
    parts.push(Buffer.from(`#${'p'.repeat(contentBytes - 1)}\n`, 'utf8'));
    remaining -= contentBytes + 1;
  }
  if (remaining !== 0) {
    throw new Error(`无法构造恰为 ${targetBytes} 字节的载荷(余 ${remaining})`);
  }
  return Buffer.concat(parts);
}

describe('M3U 流式解析器(T013/T022;research R2/R6)', () => {
  describe('Extended M3U 字段解析(FR-004)', () => {
    it('解析 #EXTINF 的 tvg-id/tvg-name 属性与逗号后标题,后随 URL 行收口为条目', async () => {
      // 标题含逗号:标题取「属性区之后第一个不在引号内的逗号」之后的全部文本
      const content = buildM3u([
        { name: 'CCTV-1 综合', url: 'http://stream.example/cctv1', tvgId: 'cctv1', tvgName: 'CCTV-1', groupTitle: '央视' },
        { name: 'News, Headlines', url: 'http://stream.example/news' },
      ]);
      const result = await parseM3U(streamOf(content));
      expect(result.entries).toEqual([
        // T146:group-title 进入条目(存储值域归一化);无属性条目不带该字段
        { tvgId: 'cctv1', title: 'CCTV-1 综合', url: 'http://stream.example/cctv1', groupTitle: '央视' },
        { tvgId: null, title: 'News, Headlines', url: 'http://stream.example/news' },
      ]);
    });

    it('标题缺失回退 tvg-name;标题与 tvg-name 皆缺失报非法,不用 URL 兜底名称', async () => {
      const noTitle = '#EXTM3U\n#EXTINF:-1 tvg-name="备用名",\nhttp://stream.example/a\n';
      const fallback = await parseM3U(streamOf(noTitle));
      expect(fallback.entries).toHaveLength(1);
      expect(fallback.entries[0]?.title).toBe('备用名');

      const noName = '#EXTM3U\n#EXTINF:-1,\nhttp://user:pass@stream.example/secret\n';
      const failure = await failureCodeOf(() => parseM3U(streamOf(noName)), M3U_FORMAT_INVALID);
      // 错误信息不携带地址原文(该地址含凭据)
      expect(failure.message).not.toContain('user:pass');
      expect(failure.message).not.toContain('stream.example');
    });

    it('未知 #EXT 指令行与普通注释行忽略,不算非法', async () => {
      const content = [
        '#EXTM3U',
        '#EXTVLCOPT:http-user-agent=home-media',
        '#EXTGRP:默认分组',
        '#EXTINF:-1 tvg-id="a",频道A',
        'http://stream.example/a',
        '# 普通注释行',
        '#EXTINF:-1,频道B',
        'http://stream.example/b',
        '',
      ].join('\n');
      const result = await parseM3U(streamOf(content));
      expect(result.entries.map((entry) => entry.title)).toEqual(['频道A', '频道B']);
    });
  });

  describe('身份材料(research R6;摘要与重复身份冲突归 staging/catalog-diff)', () => {
    it('同来源身份材料:tvg-id 优先保留原文;缺失时 tvgId=null 且完整播放地址原样保留', async () => {
      const content = buildM3u([
        { name: '有ID', url: 'http://stream.example/with-id', tvgId: 'CCTV-1' },
        { name: '无ID', url: 'http://stream.example:8000/No-Id?token=abc' },
      ]);
      const { entries } = await parseM3U(streamOf(content));
      expect(entries[0]).toEqual({ tvgId: 'CCTV-1', title: '有ID', url: 'http://stream.example/with-id' });
      // tvg-id 缺失 → tvgId 为 null,由下游以完整播放地址派生身份;解析层不做归一化
      expect(entries[1]?.tvgId).toBeNull();
      expect(entries[1]?.url).toBe('http://stream.example:8000/No-Id?token=abc');
    });

    it('大小写敏感:仅大小写不同的两个地址是不同条目;URL 不删 query', async () => {
      const content = buildM3u([
        { name: '大写路径', url: 'http://stream.example/LIVE' },
        { name: '小写路径', url: 'http://stream.example/live?ch=1&t=2' },
      ]);
      const { entries } = await parseM3U(streamOf(content));
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.url)).toEqual([
        'http://stream.example/LIVE',
        'http://stream.example/live?ch=1&t=2',
      ]);
    });

    it('凭据 URL 原样保留在解析结果中(脱敏是展示层责任,解析层不丢信息)', async () => {
      const credentialUrl = 'http://user:pass@stream.example:8000/live?key=1&t=2';
      const { entries } = await parseM3U(streamOf(buildM3u([{ name: '凭据频道', url: credentialUrl }])));
      expect(entries[0]?.url).toBe(credentialUrl);
    });
  });

  describe('非法输入整次失败(不跳过坏行;stable code 可区分)', () => {
    it('#EXTINF 后缺播放地址行(malformedPayloads.malformedM3u)→ M3U_ENTRY_MISSING_URL', async () => {
      const failure = await failureCodeOf(
        () => parseM3U(streamOf(malformedPayloads.malformedM3u())),
        M3U_ENTRY_MISSING_URL,
      );
      // 错误信息不携带任何地址原文
      expect(failure.message).not.toContain('http');
    });

    it('文件在 #EXTINF 之后直接结束 → M3U_ENTRY_MISSING_URL', async () => {
      await failureCodeOf(() => parseM3U(streamOf('#EXTM3U\n#EXTINF:-1 tvg-id="x",截断\n')), M3U_ENTRY_MISSING_URL);
    });

    it('连续两个 #EXTINF(前一 EXTINF 缺地址)→ M3U_ENTRY_MISSING_URL', async () => {
      const content = '#EXTM3U\n#EXTINF:-1 tvg-id="a",A\n#EXTINF:-1 tvg-id="b",B\nhttp://stream.example/b\n';
      await failureCodeOf(() => parseM3U(streamOf(content)), M3U_ENTRY_MISSING_URL);
    });

    it('裸播放地址行缺少前置 #EXTINF → M3U_FORMAT_INVALID,错误信息不含凭据', async () => {
      const failure = await failureCodeOf(
        () => parseM3U(streamOf('#EXTM3U\nhttp://user:pass@secret.example/live\n')),
        M3U_FORMAT_INVALID,
      );
      expect(failure.message).not.toContain('user:pass');
      expect(failure.message).not.toContain('secret.example');
    });

    it('部分条目非法 → 整次失败,不输出部分结果(malformedM3u 第 1 条合法也不返回)', async () => {
      await expect(parseM3U(streamOf(malformedPayloads.malformedM3u()))).rejects.toBeInstanceOf(M3UParseFailure);
    });

    it('无任何 EXTINF 频道记录的 M3U8(HLS 分片清单)拒绝作为频道列表 → M3U_NOT_CHANNEL_LIST', async () => {
      // research R2:HLS 分片清单不是频道目录
      const hls = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-MEDIA-SEQUENCE:0',
        'segment-000.ts',
        'segment-001.ts',
        '#EXT-X-ENDLIST',
      ].join('\n');
      await failureCodeOf(() => parseM3U(streamOf(hls)), M3U_NOT_CHANNEL_LIST);
    });

    it('空内容与仅注释的无条目内容 → M3U_NOT_CHANNEL_LIST', async () => {
      await failureCodeOf(() => parseM3U(streamOf('')), M3U_NOT_CHANNEL_LIST);
      await failureCodeOf(() => parseM3U(streamOf('#EXTM3U\n#仅注释\n')), M3U_NOT_CHANNEL_LIST);
    });

    it('非 UTF-8 字节 → M3U_DECODE_FAILED 整次失败', async () => {
      // 0xFF 不是任何合法 UTF-8 序列的起始/续字节
      await failureCodeOf(
        () => parseM3U(Readable.from([Buffer.from([0x23, 0xef, 0xff, 0x0a])])),
        M3U_DECODE_FAILED,
      );
    });

    it('多字节字符在流末尾被截断 → M3U_DECODE_FAILED', async () => {
      // '频' 的 UTF-8 为 E9 A2 91,截去末字节后整个序列非法
      await failureCodeOf(
        () => parseM3U(Readable.from([Buffer.from([0x23, 0xe9, 0xa2])])),
        M3U_DECODE_FAILED,
      );
    });

    it('各失败类别稳定 code 互不相同(可区分)', async () => {
      const codes: M3UErrorCode[] = [
        (
          await failureCodeOf(() => parseM3U(streamOf(malformedPayloads.malformedM3u())), M3U_ENTRY_MISSING_URL)
        ).code,
        (await failureCodeOf(() => parseM3U(streamOf('#EXTINF:-1,\nhttp://stream.example/a\n')), M3U_FORMAT_INVALID))
          .code,
        (
          await failureCodeOf(
            () => parseM3U(streamOf('#EXTM3U\n#EXT-X-ENDLIST\nsegment-0.ts\n')),
            M3U_NOT_CHANNEL_LIST,
          )
        ).code,
        (
          await failureCodeOf(() => parseM3U(Readable.from([Buffer.from([0xff])])), M3U_DECODE_FAILED)
        ).code,
        (
          await failureCodeOf(
            () => parseM3U(streamOfBuffer(buildLargeM3u({ bytes: 0, entries: IMPORT_BUDGETS.M3U_MAX_ENTRIES + 1 }))),
            M3U_BUDGET_EXCEEDED,
          )
        ).code,
      ];
      expect(new Set(codes).size).toBe(codes.length);
    });
  });

  describe('预算(research R2;任一超限整次失败,边界恰等预算值通过)', () => {
    it(`总字节 > ${IMPORT_BUDGETS.M3U_MAX_BYTES} 失败;恰为预算值通过`, async () => {
      // 每行恰为单行预算值(64 KiB),确保失败归因于总字节预算而非单行预算
      const paddedLine = `#${'p'.repeat(IMPORT_BUDGETS.M3U_MAX_LINE_BYTES - 1)}`;
      const head = ['#EXTM3U', '#EXTINF:-1 tvg-id="x",预算', 'http://stream.example/x'];
      const over = Buffer.from([...head, ...Array.from({ length: 170 }, () => paddedLine)].join('\n'), 'utf8');
      expect(over.length).toBeGreaterThan(IMPORT_BUDGETS.M3U_MAX_BYTES);
      await failureCodeOf(() => parseM3U(streamOfBuffer(over)), M3U_BUDGET_EXCEEDED);

      const exact = await parseM3U(streamOfBuffer(buildExactBytesM3u(IMPORT_BUDGETS.M3U_MAX_BYTES)));
      expect(exact.entries).toHaveLength(1);
    });

    it(`条目 > ${IMPORT_BUDGETS.M3U_MAX_ENTRIES} 失败;恰为预算值通过`, async () => {
      const over = buildLargeM3u({ bytes: 0, entries: IMPORT_BUDGETS.M3U_MAX_ENTRIES + 1 });
      await failureCodeOf(() => parseM3U(streamOfBuffer(over)), M3U_BUDGET_EXCEEDED);

      const exact = await parseM3U(streamOfBuffer(buildLargeM3u({ bytes: 0, entries: IMPORT_BUDGETS.M3U_MAX_ENTRIES })));
      expect(exact.entries).toHaveLength(IMPORT_BUDGETS.M3U_MAX_ENTRIES);
    });

    it(`单行 > ${IMPORT_BUDGETS.M3U_MAX_LINE_BYTES} 字节失败;恰为预算值通过`, async () => {
      const base = '#EXTM3U\n#EXTINF:-1 tvg-id="x",超长行\nhttp://stream.example/x\n';
      const exactLine = `#${'p'.repeat(IMPORT_BUDGETS.M3U_MAX_LINE_BYTES - 1)}`; // 恰 64 KiB 内容(注释行)
      const ok = await parseM3U(streamOf(`${base}${exactLine}\n`));
      expect(ok.entries).toHaveLength(1);

      const overLine = `#${'p'.repeat(IMPORT_BUDGETS.M3U_MAX_LINE_BYTES)}`; // 64 KiB + 1
      await failureCodeOf(() => parseM3U(streamOf(`${base}${overLine}\n`)), M3U_BUDGET_EXCEEDED);
    });
  });

  describe('流式与内存有界(research R2:逐块解码,不整文件拼接)', () => {
    it('按 3 字节小块喂入:多字节字符与 \\r\\n 跨块边界解析正确', async () => {
      const content =
        '#EXTM3U\r\n#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV",央视综合\r\nhttp://stream.example/cctv1\r\n';
      const result = await parseM3U(chunkedStream(content, 3));
      expect(result.entries).toEqual([{ tvgId: 'cctv1', title: '央视综合', url: 'http://stream.example/cctv1' }]);
    });

    it('接受 AsyncIterable<Buffer> 输入(不要求 Readable)', async () => {
      async function* chunks(): AsyncGenerator<Buffer> {
        yield Buffer.from('#EXTM3U\n#EXTINF:-1,频道\n', 'utf8');
        yield Buffer.from('http://stream.example/x\n', 'utf8');
      }
      const result = await parseM3U(chunks());
      expect(result.entries.map((entry) => entry.title)).toEqual(['频道']);
    });

    it('无换行符结尾的最后一行作为完整行处理', async () => {
      const result = await parseM3U(streamOf('#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nhttp://stream.example/a'));
      expect(result.entries).toEqual([{ tvgId: 'a', title: 'A', url: 'http://stream.example/a' }]);
    });
  });
});
