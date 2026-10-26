import type { ArgumentsHost } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PLAYBACK_STABLE_ERROR_CODES as SHARED_PLAYBACK_CODES,
  ProblemCode,
} from '@hmp/shared';
import { PLAYBACK_STABLE_ERROR_CODES as T011_PLAYBACK_CODES } from '../../../src/modules/playback/playback.types';
import {
  createDomainError,
  DOMAIN_PROBLEM_REGISTRY,
  DomainError,
  type DomainProblemSpec,
  resolveDomainProblem,
} from '../../../src/common/domain-error';
import { ProblemJsonFilter } from '../../../src/common/problem-json.filter';
import {
  redactForLog,
  redactQueryTicket,
  redactSourcePaths,
  summarizeFfmpegStderr,
  summarizeSourcePath,
} from '../../../src/common/log-redaction.util';

/**
 * T012(004 播放解析):契约稳定错误接入 + 流前/流后错误边界 + 日志脱敏。
 *
 * 权威依据:
 * - docs/specs/004-playback-resolver/contracts/api.md 开头:所有响应
 *   Cache-Control:no-store、Referrer-Policy:no-referrer;「媒体端点」:已发字节后
 *   不能在字节流内注入 JSON;「稳定错误」节:逐码 status;「异步失败与兼容」:日志过滤 query ticket;
 * - docs/specs/004-playback-resolver/research.md R6:日志不记录原路径、URL、query ticket
 *   或 FFmpeg 原始 stderr,只保留稳定码/脱敏技术摘要;
 * - T011 词表:apps/server/src/modules/playback/playback.types.ts 的 17 个 PLAYBACK_* 码。
 *
 * 脱敏设计口径(本文件即契约):失败分类与脱敏分离 —— summarizeFfmpegStderr 不推断稳定码,
 * 稳定码由调用方(转换监管 T016+)按失败矩阵判定后传入,本函数只做"脱敏 + 单行压缩"。
 */

/* ------------------------------------------------------------------ */
/* 记录式 Response 桩(与 domain-error.spec.ts 同款)                    */
/* ------------------------------------------------------------------ */

interface RecordingResponse {
  res: Response;
  headers: Map<string, string>;
  statuses: number[];
  bodies: unknown[];
}

function mockResponse(overrides: Partial<Record<string, unknown>> = {}): RecordingResponse {
  const headers = new Map<string, string>();
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  const res = {
    status(code: number) {
      statuses.push(code);
      return res;
    },
    setHeader(name: string, value: string) {
      headers.set(name, value);
      return res;
    },
    json(body: unknown) {
      bodies.push(body);
      return res;
    },
    ...overrides,
  } as unknown as Response;
  return { res, headers, statuses, bodies };
}

function mockHost(res: Response): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => undefined,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

function render(exception: unknown, overrides: Partial<Record<string, unknown>> = {}): RecordingResponse {
  const recording = mockResponse(overrides);
  expect(() => new ProblemJsonFilter().catch(exception, mockHost(recording.res))).not.toThrow();
  return recording;
}

/* ------------------------------------------------------------------ */
/* 1. 稳定码接入 —— shared 词表与 T011 逐一对照                        */
/* ------------------------------------------------------------------ */

describe('shared 播放稳定码 —— 与 T011 词表/契约一一对应', () => {
  it('shared 导出 PLAYBACK_STABLE_ERROR_CODES:17 码、全大写 PLAYBACK_ 前缀、无重复', () => {
    expect(SHARED_PLAYBACK_CODES).toBeDefined();
    expect(SHARED_PLAYBACK_CODES).toHaveLength(17);
    expect(new Set(SHARED_PLAYBACK_CODES).size).toBe(17);
    for (const code of SHARED_PLAYBACK_CODES) {
      expect(code).toMatch(/^PLAYBACK_[A-Z_]+$/);
    }
  });

  it('与 T011 playback.types.ts 词表逐一对照:成员与顺序完全一致,不新增不改名', () => {
    expect([...SHARED_PLAYBACK_CODES]).toEqual([...T011_PLAYBACK_CODES]);
  });

  it('每个播放稳定码都在 shared ProblemCode 常量表中注册', () => {
    const registered = Object.values(ProblemCode);
    for (const code of SHARED_PLAYBACK_CODES) {
      expect(registered, code).toContain(code);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. 稳定码接入 —— api.md「稳定错误」节逐码 status 断言               */
/* ------------------------------------------------------------------ */

/**
 * api.md「稳定错误」节逐码表(权威顺序):
 *   401 SESSION_INVALID(既有,复用);401 PLAYBACK_TICKET_INVALID / PLAYBACK_TICKET_EXPIRED;
 *   403 ACTIVE_PROFILE_REQUIRED(既有,复用)或 PIN 既有错误(PROFILE_PIN_REQUIRED/LOCKED,均已存在);
 *   404 MEDIA_NOT_FOUND(新增);404 PLAYBACK_NOT_FOUND;409 PLAYBACK_NOT_READY /
 *   PLAYBACK_VERSION_CONFLICT / PLAYBACK_GENERATION_STALE / PLAYBACK_ENDED;
 *   400 PLAYBACK_SELECTION_INVALID / PLAYBACK_SEEK_UNSUPPORTED;422 PLAYBACK_FORMAT_UNSUPPORTED;
 *   503 PLAYBACK_CONVERSION_BUSY / PLAYBACK_STORAGE_LIMIT / PLAYBACK_PERFORMANCE_INSUFFICIENT /
 *   PLAYBACK_RESOURCE_UNAVAILABLE;504 PLAYBACK_PREPARE_TIMEOUT / PLAYBACK_SEEK_TIMEOUT;
 *   429 PLAYBACK_RATE_LIMITED。
 * 计数口径:具名稳定码 20(17 PLAYBACK_* + SESSION_INVALID + ACTIVE_PROFILE_REQUIRED +
 * MEDIA_NOT_FOUND),任务书"21"含「PIN 既有错误」槽位 —— PIN 两码既有存在性单独断言。
 * inRegistry=false 的复用码不进注册表(渲染沿用既有推导,canonical status 见行注释)。
 */
const API_STABLE_ERRORS: ReadonlyArray<readonly [code: string, status: number, inRegistry: boolean]> = [
  ['SESSION_INVALID', 401, false],
  ['PLAYBACK_TICKET_INVALID', 401, true],
  ['PLAYBACK_TICKET_EXPIRED', 401, true],
  ['ACTIVE_PROFILE_REQUIRED', 403, false],
  ['MEDIA_NOT_FOUND', 404, true],
  ['PLAYBACK_NOT_FOUND', 404, true],
  ['PLAYBACK_NOT_READY', 409, true],
  ['PLAYBACK_VERSION_CONFLICT', 409, true],
  ['PLAYBACK_GENERATION_STALE', 409, true],
  ['PLAYBACK_ENDED', 409, true],
  ['PLAYBACK_SELECTION_INVALID', 400, true],
  ['PLAYBACK_SEEK_UNSUPPORTED', 400, true],
  ['PLAYBACK_FORMAT_UNSUPPORTED', 422, true],
  ['PLAYBACK_CONVERSION_BUSY', 503, true],
  ['PLAYBACK_STORAGE_LIMIT', 503, true],
  ['PLAYBACK_PERFORMANCE_INSUFFICIENT', 503, true],
  ['PLAYBACK_RESOURCE_UNAVAILABLE', 503, true],
  ['PLAYBACK_PREPARE_TIMEOUT', 504, true],
  ['PLAYBACK_SEEK_TIMEOUT', 504, true],
  ['PLAYBACK_RATE_LIMITED', 429, true],
];

describe('api.md「稳定错误」节逐码接入(20 具名码 + PIN 既有错误)', () => {
  it.each(API_STABLE_ERRORS)('%s → %i', (code, status, inRegistry) => {
    // 逐码断言存在:shared ProblemCode 可查
    expect(Object.values(ProblemCode), code).toContain(code);

    const spec = resolveDomainProblem(code as ProblemCode);
    if (inRegistry) {
      expect(spec, code).toBeDefined();
      expect(spec?.status, code).toBe(status);
      expect(createDomainError(code as keyof typeof DOMAIN_PROBLEM_REGISTRY).status, code).toBe(status);
    } else {
      // 复用既有码:不进注册表,渲染行为保持不变(canonical 401/403 由既有守卫直接构造)
      expect(spec, code).toBeUndefined();
    }
  });

  it('PIN 既有错误码继续存在(「403 ACTIVE_PROFILE_REQUIRED 或 PIN 既有错误」槽位)', () => {
    const registered = Object.values(ProblemCode);
    expect(registered).toContain(ProblemCode.PROFILE_PIN_REQUIRED);
    expect(registered).toContain(ProblemCode.PROFILE_PIN_LOCKED);
  });

  it('注册表 detail 均为静态脱敏文案:无 URL/路径分隔符/反斜杠(research R6)', () => {
    for (const [code] of API_STABLE_ERRORS) {
      const spec = resolveDomainProblem(code as ProblemCode);
      if (!spec?.detail) continue;
      expect(spec.detail, code).not.toMatch(/https?:\/\/|\\|\//);
    }
  });

  it('PLAYBACK_RATE_LIMITED 不携带静态 Retry-After(由 T031 限流接线按窗口余量动态计算)', () => {
    expect(resolveDomainProblem(ProblemCode.PLAYBACK_RATE_LIMITED)?.headers).toBeUndefined();
    // 既有不变量:全注册表仅 IMPORT_QUEUE_FULL 携带附加响应头
    const entries = Object.entries(DOMAIN_PROBLEM_REGISTRY) as [string, DomainProblemSpec][];
    for (const [code, spec] of entries) {
      if (code === 'IMPORT_QUEUE_FULL') continue;
      expect(spec.headers, code).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. 响应头 —— 错误响应统一 no-store / no-referrer                    */
/* ------------------------------------------------------------------ */

describe('problem+json 响应头 —— Cache-Control: no-store 与 Referrer-Policy: no-referrer', () => {
  // 用例工厂延迟到测试体内求值:实现前(RED)不在收集期抛错,让每个用例独立呈现失败
  const CASES: ReadonlyArray<readonly [label: string, make: () => unknown]> = [
    ['既有 DomainError', () => new DomainError(404, ProblemCode.NOT_FOUND)],
    ['播放稳定码', () => createDomainError(ProblemCode.PLAYBACK_STORAGE_LIMIT)],
    ['ZodError', () => z.object({ mediaId: z.string() }).safeParse({}).error],
    ['HttpException 透传', () => new HttpException({ status: 503, code: 'NOT_READY' }, 503)],
    ['未知错误', () => new Error('boom')],
  ];
  it.each(CASES)('%s 也携带两个安全响应头', (_label, make) => {
    const { headers } = render(make());
    expect(headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

/* ------------------------------------------------------------------ */
/* 4. 流后边界 —— headersSent 后不写响应体、不抛二次异常               */
/* ------------------------------------------------------------------ */

describe('流后边界(已发 headers → 关闭写入,不注入 JSON 到字节流)', () => {
  it('headersSent=true 时不写 status/任何响应头/JSON 体', () => {
    const { headers, statuses, bodies } = render(new DomainError(503, ProblemCode.PLAYBACK_CONVERSION_BUSY), {
      headersSent: true,
    });
    expect(statuses).toHaveLength(0);
    expect(headers.size).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  it('未知错误同样只终止(不写体、不抛二次异常)', () => {
    const { bodies } = render(new Error('late-failure-SHOULD-NOT-LOG'), { headersSent: true });
    expect(bodies).toHaveLength(0);
  });

  it('headersSent=false(缺省)照常渲染 —— 流前边界行为不变', () => {
    const { statuses, bodies } = render(createDomainError(ProblemCode.PLAYBACK_NOT_READY));
    expect(statuses).toEqual([409]);
    expect(bodies).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5. 原错误不影响 —— 脱敏/接入是附加映射,不篡改既有 code/status      */
/* ------------------------------------------------------------------ */

describe('既有非播放错误经 DomainError/filter 行为与脱敏前一致', () => {
  it('NOT_FOUND:code/status/title 不变,无缺省 detail(仅新增两个安全响应头)', () => {
    const { statuses, bodies, headers } = render(new DomainError(404, ProblemCode.NOT_FOUND));
    const body = bodies[0] as Record<string, unknown>;
    expect(statuses).toEqual([404]);
    expect(body).toMatchObject({
      type: 'https://homemedia.local/problems/not-found',
      title: 'Not Found',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(body.detail).toBeUndefined();
    expect(headers.get('Cache-Control')).toBe('no-store');
  });

  it('ZodError:仍映射 400 VALIDATION_FAILED,detail 含 issue 摘要', () => {
    const error = z.object({ mediaId: z.string() }).safeParse({ mediaId: 5 }).error;
    const { statuses, bodies } = render(error);
    const body = bodies[0] as Record<string, unknown>;
    expect(statuses).toEqual([400]);
    expect(body).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(String(body.detail)).toContain('mediaId');
  });

  it('HttpException 携带 problem 结构对象时原样透传,不篡改字段', () => {
    const payload = {
      type: 'https://homemedia.local/problems/not-ready',
      title: 'Not Ready',
      status: 503,
      code: 'NOT_READY',
    };
    const { statuses, bodies } = render(new HttpException(payload, 503));
    expect(statuses).toEqual([503]);
    expect(bodies[0]).toEqual(payload);
  });

  it('播放码显式 detail 优先且逐字保留;注册表缺省模板不含上游数据', () => {
    const custom = render(new DomainError(409, ProblemCode.PLAYBACK_ENDED, '自定义稳定说明'));
    expect(custom.statuses).toEqual([409]);
    expect(custom.bodies[0]).toMatchObject({ code: 'PLAYBACK_ENDED', detail: '自定义稳定说明' });

    const fallback = render(createDomainError(ProblemCode.PLAYBACK_VERSION_CONFLICT));
    expect(fallback.statuses).toEqual([409]);
    expect(fallback.bodies[0]).toMatchObject({ code: 'PLAYBACK_VERSION_CONFLICT' });
    expect(String((fallback.bodies[0] as { detail?: string }).detail)).not.toMatch(/https?:\/\/|\//);
  });
});

/* ------------------------------------------------------------------ */
/* 6. query ticket 脱敏(R6/「异步失败与兼容」:日志过滤 query ticket)  */
/* ------------------------------------------------------------------ */

describe('redactQueryTicket —— query 参数 ticket 值不落日志/消息', () => {
  it('ticket 位于末位/中间/首位均脱敏,其余参数原样保留', () => {
    expect(redactQueryTicket('/playback/stream/s1/2/a0?ticket=TICKET-SECRET-9')).toBe(
      '/playback/stream/s1/2/a0?ticket=[REDACTED]',
    );
    expect(redactQueryTicket('/playback/stream/s1/2/a0?tok=x&ticket=TICKET-SECRET-8&v=3')).toBe(
      '/playback/stream/s1/2/a0?tok=x&ticket=[REDACTED]&v=3',
    );
    expect(redactQueryTicket('/playback/stream/s1/2/a0?ticket=TICKET-SECRET-7&v=3')).toBe(
      '/playback/stream/s1/2/a0?ticket=[REDACTED]&v=3',
    );
  });

  it('无 ticket 的 URL 原样返回', () => {
    const url = 'https://media.local/api/playback/sessions/abc?expectedGeneration=2&other=v';
    expect(redactQueryTicket(url)).toBe(url);
  });

  it('ticket 值含特殊字符(编码/点/等号/斜杠)整段脱敏,fragment 保留', () => {
    const out = redactQueryTicket('https://m/s/1/1/k?ticket=a.b%2Bc=d/e#frag');
    expect(out).toBe('https://m/s/1/1/k?ticket=[REDACTED]#frag');
    expect(out).not.toContain('a.b%2Bc');
  });

  it('同一段文本里多个 URL 的 ticket 全部脱敏;参数名大小写不敏感', () => {
    const out = redactQueryTicket(
      '入口 ?ticket=T1&x=1 与子清单 /seg?a=1&TICKET=T2 及 /idx?ticket=T3 结尾',
    );
    expect(out).not.toContain('T1');
    expect(out).not.toContain('T2');
    expect(out).not.toContain('T3');
    expect(out.match(/ticket=\[REDACTED\]/gi)).toHaveLength(3);
  });

  it('redactForLog 对字符串值统一过滤 query ticket(嵌套/数组同样生效),纯函数不改输入', () => {
    const input = {
      url: 'https://m/playback/stream/s/1/k?ticket=SECT-1&v=2',
      nested: { list: ['/seg?ticket=SECT-2'] },
      password: 'plain',
      keep: 'admin',
    };
    const out = redactForLog(input);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('SECT-1');
    expect(serialized).not.toContain('SECT-2');
    expect(serialized).toContain('ticket=[REDACTED]');
    expect((out as Record<string, unknown>)['password']).toBe('[REDACTED]');
    expect((out as Record<string, unknown>)['keep']).toBe('admin');
    // 原对象不被修改
    expect(input.url).toContain('SECT-1');
    expect(input.nested.list[0]).toContain('SECT-2');
  });
});

/* ------------------------------------------------------------------ */
/* 7. 源路径脱敏(R6:日志不记录原路径;父目录层级必须去除)            */
/* ------------------------------------------------------------------ */

describe('源文件绝对路径/目录路径脱敏 —— 只留稳定技术特征(扩展名)', () => {
  it('summarizeSourcePath:绝对路径不出现在摘要中,保留容器提示', () => {
    const out = summarizeSourcePath('/Volumes/nas/private-movies/secret-film.mp4');
    expect(out).not.toContain('/Volumes');
    expect(out).not.toContain('private-movies');
    expect(out).not.toContain('secret-film');
    expect(out).not.toContain('/');
    expect(out).toContain('mp4');
  });

  it('目录路径(无扩展名):层级去除,返回通用脱敏摘要', () => {
    const out = summarizeSourcePath('/Volumes/nas/family-media/');
    expect(out).not.toContain('family-media');
    expect(out).not.toContain('/Volumes');
    expect(out).not.toContain('/');
  });

  it('Windows 盘符路径同样脱敏', () => {
    const out = summarizeSourcePath('D:\\Media\\Private\\holiday.mkv');
    expect(out).not.toContain('D:');
    expect(out).not.toContain('Private');
    expect(out).not.toContain('holiday');
    expect(out).not.toContain('\\');
    expect(out).toContain('mkv');
  });

  it('redactSourcePaths:文本内多路径/file:/http URL 全部替换,扩展名提示保留', () => {
    const out = redactSourcePaths(
      '转换失败: 输入 /Volumes/nas/in/secret-a.mp4 输出 /tmp/hls-cache/s1/2/index.m3u8 (see file:///Volumes/nas/in/secret-a.mp4 与 http://nas.local:8080/live/seg-0.ts?ticket=TK9)',
    );
    expect(out).not.toContain('/Volumes');
    expect(out).not.toContain('/tmp');
    expect(out).not.toContain('nas.local');
    expect(out).not.toContain('TK9');
    expect(out).not.toMatch(/https?:\/\//i);
    expect(out).not.toContain('file:');
    expect(out).toContain('[REDACTED-PATH:mp4]');
    expect(out).toContain('[REDACTED-PATH:m3u8]');
    expect(out).toContain('[REDACTED-URL]');
  });

  it('非路径文本原样保留(不做过度脱敏)', () => {
    const text = '码率 8123kbits/s,帧率 24fps,分辨率 1920x1080';
    expect(redactSourcePaths(text)).toBe(text);
  });
});

/* ------------------------------------------------------------------ */
/* 8. FFmpeg stderr 脱敏(R6:不留原始 stderr,只留稳定码/技术摘要)     */
/* ------------------------------------------------------------------ */

/** 典型 stderr:输入/输出路径、file: URL、带票 URL、多行探测输出与失败行 */
const FFMPEG_STDERR = [
  "ffmpeg version 5.1.9 Copyright (c) 2000-2026 the FFmpeg developers",
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/Volumes/nas/private-movies/secret-film.mp4':",
  '  Duration: 00:42:05.11, start: 0.000000, bitrate: 8123 kb/s',
  '  Stream #0:0[0x1](und): Video: hevc (Main 10), yuv420p10le(tv), 3840x2160 [SAR 1:1 DAR 16:9], 24 fps',
  '  Stream #0:1[0x2](und): Audio: dts (DTS-HD MA), 48000 Hz, 7.1, s32 (24 bit)',
  "Opening '/tmp/hls-cache/hh/s1/2/index.m3u8' for writing",
  'file:/Volumes/nas/private-movies/secret-film.mp4: Invalid data found when processing input',
  '[hls @ 0x7f8] Failed to open segment http://nas.local:8080/live/seg-0.ts?ticket=TK-STREAM-9',
  '[out#0/hls @ 0x7fa] Could not write header: Permission denied',
  'Conversion failed!',
  '    at process (ffmpeg.c:703)',
].join('\n');

describe('summarizeFfmpegStderr —— 稳定码 + 单行技术摘要,原文路径/URL 不出现', () => {
  // 延迟求值(RED 期函数尚不存在,避免收集期抛错)
  let summaryCache = '';
  const summaryOf = (): string => {
    if (!summaryCache) summaryCache = summarizeFfmpegStderr(FFMPEG_STDERR, 'PLAYBACK_FORMAT_UNSUPPORTED');
    return summaryCache;
  };

  it('绑定调用方判定的稳定码(本函数不做失败分类)', () => {
    expect(summaryOf()).toContain('PLAYBACK_FORMAT_UNSUPPORTED');
  });

  it('多行压缩为单行', () => {
    expect(summaryOf()).not.toContain('\n');
  });

  it('原文任何路径/URL/票据/主机不出现', () => {
    const summary = summaryOf();
    for (const secret of [
      '/Volumes',
      'secret-film',
      'private-movies',
      '/tmp/hls-cache',
      'index.m3u8',
      'file:',
      'http://',
      'nas.local',
      '8080',
      'TK-STREAM-9',
      'ffmpeg.c',
    ]) {
      expect(summary, secret).not.toContain(secret);
    }
  });

  it('保留 codec/分辨率/duration/fps 等技术关键字', () => {
    const summary = summaryOf();
    expect(summary).toContain('hevc');
    expect(summary).toContain('3840x2160');
    expect(summary.toLowerCase()).toContain('duration');
    expect(summary).toContain('fps');
  });

  it('摘要长度有上限(缺省 200 字符)', () => {
    expect(summaryOf().length).toBeLessThanOrEqual(200);
    expect(summarizeFfmpegStderr(FFMPEG_STDERR, 'PLAYBACK_PREPARE_TIMEOUT', 80).length).toBeLessThanOrEqual(80);
  });

  it('无可识别关键字的输入仍返回稳定码单行摘要(不抛错)', () => {
    const out = summarizeFfmpegStderr('', 'PLAYBACK_PREPARE_TIMEOUT');
    expect(out).toContain('PLAYBACK_PREPARE_TIMEOUT');
    expect(out).not.toContain('\n');
  });

  it('同码同输入输出确定(可断言)', () => {
    expect(summarizeFfmpegStderr(FFMPEG_STDERR, 'PLAYBACK_FORMAT_UNSUPPORTED')).toBe(summaryOf());
  });
});
