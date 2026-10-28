import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { MediaDto } from '@hmp/shared';
import { redactForLog } from '@platform/http-common/log-redaction.util';
import { LoggingInterceptor } from '@platform/http-common/logging.interceptor';
import {
  M3U_ENTRY_MISSING_URL,
  M3U_FORMAT_INVALID,
  parseM3U,
} from '@contexts/sources/infrastructure/m3u.parser';
import { DOCTYPE_DENIED, parseXMLTV } from '@contexts/sources/infrastructure/xmltv.parser';
import type { XMLTVParseFailure } from '@contexts/sources/infrastructure/xmltv.parser';
import type { M3UParseFailure } from '@contexts/sources/infrastructure/m3u.parser';
import type { RemoteReadFailure } from '@contexts/sources/infrastructure/safe-http-reader';
import { scanNasRoot } from '@contexts/sources/infrastructure/nas-scanner';
import type { NasScanFailure } from '@contexts/sources/infrastructure/nas-scanner';
import {

  TARGET_DENIED,
  openRemoteSource,
} from '@contexts/sources/infrastructure/safe-http-reader';
import type { RefreshJobView } from '@contexts/sources/application/refresh-executor.service';
import { toRefreshDto } from '@contexts/sources/application/sources.service';

describe('log redaction(T041/FR-007)', () => {
  it('命中敏感键(password/pin/token/secret/authorization/cookie)一律替换', () => {
    const input = {
      username: 'admin',
      password: 'plain-text-password',
      passwordHash: 'aaa',
      pin: '1234',
      pinHash: 'bbb',
      sessionToken: 'tok',
      deviceToken: 'tok2',
      clientSecret: 's',
      authorization: 'Bearer x',
      cookie: 'hmp_session=y',
    };
    const out = redactForLog(input) as Record<string, unknown>;
    for (const key of Object.keys(input)) {
      if (key === 'username') continue;
      expect(out[key], key).toBe('[REDACTED]');
    }
    expect(out['username']).toBe('admin');
  });

  it('深嵌套与数组同样生效,普通数据原样保留', () => {
    const out = redactForLog({
      level: 'info',
      rows: [{ id: '1', name: 'a', pin_hash: 'x' }],
      nested: { deep: { refresh_token: 't', ok: true } },
    }) as {
      level: string;
      rows: Array<{ id: string; name: string; pin_hash: string }>;
      nested: { deep: { refresh_token: string; ok: boolean } };
    };
    expect(out.level).toBe('info');
    expect(out.rows[0]?.id).toBe('1');
    expect(out.rows[0]?.pin_hash).toBe('[REDACTED]');
    expect(out.nested.deep.refresh_token).toBe('[REDACTED]');
    expect(out.nested.deep.ok).toBe(true);
  });

  it('循环引用不爆炸,超深截断', () => {
    const a: Record<string, unknown> = { password: 'x' };
    a['self'] = a;
    const out = redactForLog(a) as Record<string, unknown>;
    expect(out['password']).toBe('[REDACTED]');
    expect(out['self']).toBe('[TRUNCATED]');
  });

  it('原始对象不被修改(纯函数)', () => {
    const input = { password: 'secret', keep: 1 };
    redactForLog(input);
    expect(input['password']).toBe('secret');
    expect(input['keep']).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* T054/FR-015:新模块日志与错误脱敏回归锁定(003-media-catalog)         */
/* ------------------------------------------------------------------ */

/**
 * T054 共享断言口径:错误 message 不得携带 http(s)://、user:pass 形态凭据、
 * 以绝对路径分隔符开头的路径(Unix「/」或 Windows 盘符)与指定敏感原文。
 * NasScanFailure 按 research R4 允许携带相对路径片段 —— 本组用例选取的输入
 * 均不产生相对路径回显,该口径对全部被断言 message 都应成立。
 */
function expectRedactedMessage(message: string, secrets: readonly string[]): void {
  expect(message).not.toMatch(/https?:\/\//i);
  // 「/」类字面斜杠说明是合法静态文案:绝对路径口径限定为「/ 后跟 ASCII 字母或点」
  expect(message).not.toMatch(/(?:^|[\s(（[「"'])\/[A-Za-z.]/);
  expect(message).not.toMatch(/[A-Za-z]:\\/);
  for (const secret of secrets) {
    expect(message).not.toContain(secret);
  }
}

/** 执行并返回失败;断言确有失败后由用例检查 code 与 message */
async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('预期失败的操作成功了(测试装配错误)');
}

describe('LoggingInterceptor 只记 method/url,不采集请求体(T054/FR-015)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const REFRESH_URL = '/api/sources/11111111-1111-4111-8111-111111111111/refresh';

  function refreshContext(body: Record<string, unknown>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: REFRESH_URL, originalUrl: REFRESH_URL, body }),
        getResponse: () => ({ statusCode: 202 }),
      }),
    } as unknown as ExecutionContext;
  }

  function loggedText(
    logSpy: ReturnType<typeof vi.spyOn>,
    warnSpy: ReturnType<typeof vi.spyOn>,
  ): string {
    return [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map((call) => call.map(String).join(' '))
      .join('\n');
  }

  it('带 ownerPassword 的 POST body 不进日志:成功分支只记 method/url/status/耗时', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await firstValueFrom(
      new LoggingInterceptor().intercept(refreshContext({ ownerPassword: 'owner-password-SECRET', expectedVersion: 3, operationKey: 'op-key-1' }), {
        handle: () => of(null),
      }),
    );

    const logged = loggedText(logSpy, warnSpy);
    expect(logged).toMatch(
      /^POST \/api\/sources\/11111111-1111-4111-8111-111111111111\/refresh 202 \+\d+ms$/m,
    );
    expect(logged).not.toContain('ownerPassword');
    expect(logged).not.toContain('owner-password-SECRET');
    expect(logged).not.toContain('operationKey');
    expect(logged).not.toContain('expectedVersion');
  });

  it('失败分支同样只记 method/url + failed + 耗时,不落请求上下文数据', async () => {
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(
      firstValueFrom(
        new LoggingInterceptor().intercept(refreshContext({ ownerPassword: 'owner-password-SECRET' }), {
          handle: () => throwError(() => new Error('upstream-detail-SHOULD-NOT-LOG')),
        }),
      ),
    ).rejects.toThrow('upstream-detail-SHOULD-NOT-LOG');

    const logged = loggedText(logSpy, warnSpy);
    expect(logged).toMatch(
      /^POST \/api\/sources\/11111111-1111-4111-8111-111111111111\/refresh failed \+\d+ms$/m,
    );
    expect(logged).not.toContain('owner-password-SECRET');
    expect(logged).not.toContain('SHOULD-NOT-LOG');
  });
});

describe('解析/扫描/远程读取失败 message 脱敏(T054/FR-015/research R3)', () => {
  /** 带凭据与 query 的样例地址:任何失败 message 都不得回显其中任何片段 */
  const credentialedUrl = 'http://user:pass@nas.local:8080/live/playlist.m3u8?token=SECRET-TOKEN';

  it('M3UParseFailure 只含行号与语义,不回显播放地址/凭据/行原文', async () => {
    // 播放地址行缺前置 #EXTINF:错误发生地离地址最近,也不得携带原文
    const noExtinf = await failureOf(() => parseM3U(Readable.from([Buffer.from(`${credentialedUrl}\n`, 'utf8')])));
    expect((noExtinf as M3UParseFailure).code).toBe(M3U_FORMAT_INVALID);
    expectRedactedMessage(noExtinf.message, ['user:pass', 'SECRET-TOKEN', 'playlist.m3u8', 'nas.local']);

    // 文件在 #EXTINF 后结束:仅含行号,不携带 tvg-id/标题等行内材料
    const missingUrl = await failureOf(() =>
      parseM3U(Readable.from([Buffer.from('#EXTINF:-1 tvg-id="cctv1" tvg-name="c",CCTV-1 综合\n', 'utf8')])),
    );
    expect((missingUrl as M3UParseFailure).code).toBe(M3U_ENTRY_MISSING_URL);
    expectRedactedMessage(missingUrl.message, ['cctv1', 'CCTV-1']);
  });

  it('XMLTVParseFailure 拒绝 DOCTYPE 为静态文案,不回显 DTD 的 URL 与凭据', async () => {
    const doc = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE tv SYSTEM "http://user:pass@evil.example:8080/x.dtd">',
      '<tv><programme start="20260101000000 +0800" stop="20260101010000 +0800"/></tv>',
    ].join('\n');
    const failure = await failureOf(() => parseXMLTV(Readable.from([Buffer.from(doc, 'utf8')])));
    expect((failure as XMLTVParseFailure).code).toBe(DOCTYPE_DENIED);
    expectRedactedMessage(failure.message, ['user:pass', 'evil.example', 'x.dtd']);
  });

  it('NasScanFailure 只含稳定 code/rootKey,不回显部署绝对路径与非法输入原文', async () => {
    const unauthorized = await failureOf(() =>
      scanNasRoot({ roots: {}, rootKey: 'nas-home', relativeDirectory: 'movies' }),
    );
    expect((unauthorized as NasScanFailure).code).toBe('ROOT_UNAUTHORIZED');
    expect(unauthorized.message).toContain('root=nas-home'); // rootKey 是允许的稳定定位信息
    expectRedactedMessage(unauthorized.message, []);

    // 绝对路径输入:拒绝文案静态,不回显输入绝对路径,也不回显部署 roots 值
    const absolute = await failureOf(() =>
      scanNasRoot({
        roots: { 'nas-home': '/nonexistent-deployment-root' },
        rootKey: 'nas-home',
        relativeDirectory: '/Volumes/secret/private-media',
      }),
    );
    expect((absolute as NasScanFailure).code).toBe('INVALID_RELATIVE_PATH');
    expectRedactedMessage(absolute.message, [
      '/Volumes/secret/private-media',
      'secret',
      '/nonexistent-deployment-root',
    ]);

    // 盘符/反斜杠输入:同样静态文案
    const backslash = await failureOf(() =>
      scanNasRoot({
        roots: { 'nas-home': '/nonexistent-deployment-root' },
        rootKey: 'nas-home',
        relativeDirectory: 'C:\\Users\\secret\\videos',
      }),
    );
    expect((backslash as NasScanFailure).code).toBe('INVALID_RELATIVE_PATH');
    expectRedactedMessage(backslash.message, ['Users', 'secret', 'videos']);
  });

  it('RemoteReadFailure 只含脱敏 host[:port],不含 userinfo/query/path 与完整 URL', async () => {
    // 空许可列表默认拒绝:在 DNS/建连前失败(无网络);message 仅 hostname:port
    const denied = await failureOf(() => openRemoteSource(credentialedUrl, { allowedTargets: [] }));
    expect((denied as RemoteReadFailure).code).toBe(TARGET_DENIED);
    expect(denied.message).toContain('nas.local:8080'); // 稳定 host 标签是允许的定位信息
    expectRedactedMessage(denied.message, ['user:pass', 'SECRET-TOKEN', 'live', 'playlist']);

    // 非法 URL:解析失败不回显原文(原文可能含凭据)
    const invalid = await failureOf(() =>
      openRemoteSource('http://user:pass@:not-a-valid-target', { allowedTargets: [] }),
    );
    expect(invalid.message).toBe('远程地址不是合法 URL');
    expectRedactedMessage(invalid.message, ['user:pass', 'not-a-valid-target']);
  });
});

describe('DTO 映射脱敏(T054/FR-015)', () => {
  it('toRefreshDto 输出不含 snapshotDigest/baselineRevision/sourceVersion 与地址字段', () => {
    const view: RefreshJobView = {
      id: '2b0f4a39-6c1d-4a1e-9e21-0f5a6b7c8d90',
      householdId: '1e2f3a4b-5c6d-4e8f-9a0b-1c2d3e4f5a6b',
      sourceId: '3d4c5b6a-7f8e-4d9c-8b7a-6f5e4d3c2b1a',
      status: 'awaiting_confirmation',
      version: 4,
      sourceVersion: 3,
      baselineRevision: 41,
      snapshotDigest: 'MARKER-snapshot-digest-do-not-export',
      itemCount: 12,
      counts: { added: 1, updated: 2, missing: 3 },
      confirmationReason: 'deletion_ratio_exceeded',
      errorCode: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: null,
      expiresAt: '2026-01-02T00:00:00.000Z',
    };

    const dto = toRefreshDto(view);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('snapshotDigest');
    expect(serialized).not.toContain('baselineRevision');
    expect(serialized).not.toContain('sourceVersion');
    expect(serialized).not.toContain('householdId');
    expect(serialized).not.toContain('MARKER-snapshot-digest-do-not-export');
    expect(serialized).not.toMatch(/https?:\/\//i);
    expect(Object.keys(dto).sort()).toEqual([
      'confirmationReason',
      'counts',
      'createdAt',
      'errorCode',
      'expiresAt',
      'finishedAt',
      'id',
      'sourceId',
      'startedAt',
      'status',
      'version',
    ]);
  });

  it('CatalogDto(MediaDto)序列化样本不含 url/path/tvg/playback 字样', () => {
    const sample: MediaDto = {
      id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      type: 'channel',
      title: 'CCTV-1 综合',
      description: null,
      contentLevel: 0,
      poster: null,
      version: 7,
    };
    const serialized = JSON.stringify(sample);
    expect(serialized).not.toMatch(/url|path|tvg|playback|https?:\/\//i);
    expect(Object.keys(sample).sort()).toEqual([
      'contentLevel',
      'description',
      'id',
      'poster',
      'title',
      'type',
      'version',
    ]);
  });
});
