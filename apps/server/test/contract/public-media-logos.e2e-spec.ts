import 'reflect-metadata';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createControlledMediaServer, type ControlledMediaServer } from '../fixtures/controlled-media-server';
import { startFreshApp, cleanupRigs, expectProblemContentType } from '../helpers';
import { Database } from '@platform/database/database';
import {
  CHANNEL_LOGO_TOMBSTONE_WINDOW_MS,
  createMediaCatalogTxParticipants,
} from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createUnitOfWork } from '@platform/database/unit-of-work';
import { sharedRateLimitService, RateLimitService } from '@platform/http-common/rate-limit/rate-limit.service';

/**
 * 频道 Logo 同源代理契约测试(tasks T011/T021;api.md §1/§4.6 happy path/§4.4-4.5 上游失败族):
 * - fake 上游 image/png ≤2MiB → 200 字节一致 + Content-Type 透传
 *   + Cache-Control: public, max-age=300(R6 引用键控短缓存;显式覆盖全局 no-store);
 * - 负向同形抽样:伪造 ref(随机 32 hex)→ 404,与目录资源不存在同形
 *   (api.md §4.1;完整五类形态/泄漏面断言归 T037);
 * - 上游失败族(T021):200 text/html → 502 MEDIA_LOGO_UPSTREAM_FAILED;
 *   image/* 但非 identity 编码 → 502 同码同形;上游挂起 → 504
 *   MEDIA_LOGO_UPSTREAM_TIMEOUT(§1「超预算(总时限/空闲/中断)」族;预算常量
 *   MEDIA_LOGO_BUDGETS 无 env 注入口,真实传输下挂起先命中空闲预算 4s、早于
 *   总期限 8s——总期限/中止两分支的码映射由单元测试 logo.service.spec.ts 钉面);
 * - 每个错误响应体(含脱敏文案 detail)0 处上游 URL 片段(§4.7 抽样:T037 全量)。
 *
 * T034(api.md §4.3):发布撤销路径(同一 UnitOfWork 事务内 upsert 胜者 + poster 落值
 *   + revokeChannelLogo)→ 旧 ref 410 MEDIA_LOGO_REVOKED(application/problem+json,
 *   code 与 404 可区分);revoked_at 快进到 7 天窗口外 + gcExpiredChannelLogoTombstones
 *   (发布事务路径)→ 同 ref 404,与「目录资源不存在」响应体逐字段 toEqual 同形。
 * T036(api.md §4.1/4.2):真随机 32 hex 伪造 404 与「目录资源不存在」逐字段相等;
 *   双家庭 fixture —— 家庭 B 行满足复合 FK 完成种子后摘除家庭行(注册表/媒体行保留
 *   孤儿态,请求期维持单家庭部署判定,否则 requireScope 以 503 判部署损坏),跨家庭
 *   ref → 404,与伪造 404 响应体逐字段 toEqual(不可区分)。
 * T037(api.md §4 清单 7/8):响应体收集器入册本文件全部用例的响应体,末位总断言
 *   序列化 JSON 0 处上游 URL 片段(主机/端口/上游路由路径);429 限频沿
 *   rate-limit-evidence.e2e-spec.ts 先例 —— 清空共享限频窗口后精确计数真实打满
 *   public 桶(120 次/分钟/IP),断言 429 + Retry-After。
 *
 * fixture:注册表行经 T008 仓储/事务参与者直插(真实 UnitOfWork 事务),频道媒体
 * 行为 channel_logo 复合 FK 目标;fake 上游为受控 http 服务(127.0.0.1 随机端口,
 * LAN_ALLOWED_TARGETS='127.0.0.1' 精确许可)。channel_logo 表以迁移 0009 为权威;
 * 0009 在并行任务落地前缺失时按 data-model §2 等值 DDL 兜底(与单元 rig 同策略)。
 */

/** 标准 1x1 PNG(合法 image/png 字节;远小于 2MiB 预算) */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000200010d0a2db40000000049454e44ae426082',
  'hex',
);

/** channel_logo 等值 DDL(data-model §2;0009 迁移缺失时的契约测试兜底) */
const CHANNEL_LOGO_DDL = `
  CREATE TABLE IF NOT EXISTS channel_logo (
    household_id TEXT NOT NULL REFERENCES household(id),
    media_id     TEXT NOT NULL,
    ref          TEXT NOT NULL,
    upstream_url TEXT,
    source_kind  TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    revision     INTEGER NOT NULL,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    CONSTRAINT channel_logo_media_fk FOREIGN KEY (household_id, media_id)
      REFERENCES media_item (household_id, id) ON DELETE CASCADE,
    CONSTRAINT channel_logo_source_fk FOREIGN KEY (household_id, source_id)
      REFERENCES media_source (household_id, id),
    CONSTRAINT channel_logo_source_kind_check CHECK (source_kind IN ('iptv', 'epg')),
    CONSTRAINT channel_logo_revision_check CHECK (revision >= 1),
    CONSTRAINT channel_logo_tombstone_check CHECK (revoked_at IS NULL OR upstream_url IS NULL),
    CONSTRAINT channel_logo_household_media_key UNIQUE (household_id, media_id),
    CONSTRAINT channel_logo_household_ref_key UNIQUE (household_id, ref)
  );
`;

const NOW_ISO = '2026-01-01T00:00:00.000Z';

/* T036 双家庭 fixture 标识(家庭 B 最简行集:household/media_source/media_item/channel_logo) */
const FOREIGN_HOUSEHOLD_ID = 'hh-logo-contract-b';
const FOREIGN_SOURCE_ID = 'src-iptv-logo-b';
const FOREIGN_MEDIA_ID = 'ch-logo-foreign-b';
/** 家庭 B 注册表引用(直接 SQL 直插,须为 32 字符小写 hex 以通过解析形态门) */
const FOREIGN_REF = 'b'.repeat(32);

let app: Awaited<ReturnType<typeof startFreshApp>>['app'];
let upstream: ControlledMediaServer;
let logoUrl: string;
let issuedRef: string;
/** T021 上游失败族三行注册表引用(各指向 html / gzip / hang 路由) */
let htmlRef: string;
let gzipRef: string;
let hangRef: string;

async function seedRegistryRow(): Promise<string> {
  const conn = Database.db;
  conn.exec(CHANNEL_LOGO_DDL);
  conn
    .prepare(
      "INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-logo-contract', 'Logo之家', 'zh-CN', 'Asia/Shanghai', ?)",
    )
    .run(NOW_ISO);
  conn
    .prepare(
      `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
         title_overridden, type_overridden, version, media_role, created_at, updated_at)
       VALUES ('ch-logo-1', 'hh-logo-contract', 'channel', '契约频道', NULL, NULL, NULL, 0, 0, 1, 'standalone', ?, ?)`,
    )
    .run(NOW_ISO, NOW_ISO);
  conn
    .prepare(
      `INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, created_at, updated_at)
       VALUES ('src-iptv-logo', 'hh-logo-contract', 'iptv', 'IPTV契约源', ?, 1, 1, ?, ?)`,
    )
    .run(logoUrl, NOW_ISO, NOW_ISO);
  // 注册表行经 T008 参与者直插(真实 UnitOfWork 事务:签发 + poster_ref 同事务同域)
  const uow = createUnitOfWork({
    resolveDatabase: () => Database.db,
    txStores: { catalog: createMediaCatalogTxParticipants },
  });
  const ref = uow.run(
    (txStores) => txStores.catalog,
    (catalog) => {
      const { ref: issued } = catalog.upsertChannelLogoWinner({
        householdId: 'hh-logo-contract',
        mediaId: 'ch-logo-1',
        upstreamUrl: logoUrl,
        sourceKind: 'iptv',
        sourceId: 'src-iptv-logo',
        nowIso: NOW_ISO,
      });
      catalog.setChannelPosterRef('hh-logo-contract', 'ch-logo-1', issued);
      return issued;
    },
    { behavior: 'immediate' },
  );
  return ref;
}

/**
 * T021 上游失败族夹具:同一家庭下新增频道媒体行 + 指向指定上游地址的注册表行
 * (channel_logo UNIQUE (household_id, media_id) 要求独立频道;复用既有 iptv 源
 * 满足 (household_id, source_id) 复合 FK;签发经 T008 参与者真实事务)。
 */
function seedFailureChannelLogo(mediaId: string, upstreamUrl: string): string {
  Database.db
    .prepare(
      `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
         title_overridden, type_overridden, version, media_role, created_at, updated_at)
       VALUES (?, 'hh-logo-contract', 'channel', '契约频道', NULL, NULL, NULL, 0, 0, 1, 'standalone', ?, ?)`,
    )
    .run(mediaId, NOW_ISO, NOW_ISO);
  const uow = createUnitOfWork({
    resolveDatabase: () => Database.db,
    txStores: { catalog: createMediaCatalogTxParticipants },
  });
  return uow.run(
    (txStores) => txStores.catalog,
    (catalog) =>
      catalog
        .upsertChannelLogoWinner({
          householdId: 'hh-logo-contract',
          mediaId,
          upstreamUrl,
          sourceKind: 'iptv',
          sourceId: 'src-iptv-logo',
          nowIso: NOW_ISO,
        })
        .ref,
    { behavior: 'immediate' },
  );
}

const http = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

/**
 * T037 响应体收集器:本文件每个用例经 trackedGet 发出的 GET 响应体入册,供末位
 * 「泄漏面总断言」脚本化遍历(api.md §4 清单 7:全部响应体 0 处上游 URL 片段)。
 */
const capturedBodies: unknown[] = [];

/** 带收集的 GET(与 request(http()).get 等价,仅追加响应体入册;断言行为不变) */
function trackedGet(path: string) {
  return request(http())
    .get(path)
    .then((res) => {
      capturedBodies.push(res.body);
      return res;
    });
}

beforeAll(async () => {
  upstream = await createControlledMediaServer({
    routes: [
      { path: '/logo/channel.png', kind: 'body', body: PNG_BYTES, contentType: 'image/png' },
      // T021 上游失败族路由(api.md §4.4/4.5):非图片 200 / image/* + gzip 编码 / 永不回包
      {
        path: '/logo/not-an-image.html',
        kind: 'body',
        body: '<html><body>logo upstream served html</body></html>',
        contentType: 'text/html',
      },
      { path: '/logo/gzipped.png', kind: 'gzip', body: PNG_BYTES, contentType: 'image/png' },
      { path: '/logo/hang-forever', kind: 'hang' },
    ],
  });
  logoUrl = `${upstream.baseUrl}/logo/channel.png`;
  const rig = await startFreshApp({
    prefix: 'hmp-public-logos-',
    env: { LAN_ALLOWED_TARGETS: '127.0.0.1' },
  });
  app = rig.app;
  issuedRef = await seedRegistryRow();
  htmlRef = seedFailureChannelLogo('ch-logo-html', `${upstream.baseUrl}/logo/not-an-image.html`);
  gzipRef = seedFailureChannelLogo('ch-logo-gzip', `${upstream.baseUrl}/logo/gzipped.png`);
  hangRef = seedFailureChannelLogo('ch-logo-hang', `${upstream.baseUrl}/logo/hang-forever`);
}, 60_000);

afterAll(async () => {
  await upstream.close();
  await cleanupRigs();
});

describe('GET /api/public/media/logos/:logoRef(T011 happy path;api.md §1/§4.6)', () => {
  it('已签发 ref → 200 字节一致 + Content-Type 透传 + Cache-Control public, max-age=300', async () => {
    const res = await trackedGet(`/api/public/media/logos/${issuedRef}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual(PNG_BYTES);
    // 字节原样回传(二进制等价,不经文本转写)
    expect(Buffer.compare(Buffer.from(res.body as Buffer), PNG_BYTES)).toBe(0);
    // 响应体 0 处上游 URL 片段(api.md §4.7 抽样;私有地址不进任何公共面)
    expect(JSON.stringify(res.body).includes('127.0.0.1')).toBe(false);
  });

  it('伪造 ref(随机 32 hex)→ 404 NOT_FOUND,与目录资源不存在同形(api.md §4.1 抽样)', async () => {
    const forged = await trackedGet(`/api/public/media/logos/${'e'.repeat(32)}`);
    expect(forged.status).toBe(404);
    expectProblemContentType(forged);
    expect((forged.body as { code?: string }).code).toBe('NOT_FOUND');
    // 同形基准:目录资源不存在(媒体详情 404)逐字段一致
    const catalogMissing = await trackedGet('/api/public/media/definitely-missing');
    expect(catalogMissing.status).toBe(404);
    expect(catalogMissing.body).toEqual(forged.body);
  });

  it('GET 幂等:同 ref 重复取回逐字节一致(纯读;api.md §3)', async () => {
    const first = await trackedGet(`/api/public/media/logos/${issuedRef}`);
    const second = await trackedGet(`/api/public/media/logos/${issuedRef}`);
    expect(second.status).toBe(first.status);
    expect(Buffer.compare(Buffer.from(second.body as Buffer), Buffer.from(first.body as Buffer))).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* T021 上游失败族(api.md §1 错误表第 4/5 行;§4.4/§4.5/§4.7 抽样)      */
/* ------------------------------------------------------------------ */

/** 上游 URL 片段全集(主机/端口/各路由路径):任何公共响应体 0 处出现(api.md §4.7) */
function upstreamFragments(): string[] {
  return [
    '127.0.0.1',
    `:${upstream.port}`,
    '/logo/channel.png',
    '/logo/not-an-image.html',
    '/logo/gzipped.png',
    '/logo/hang-forever',
  ];
}

/** 单响应体无泄漏断言(§4.7 抽样;全量遍历归 T037 末位总断言) */
function expectNoUpstreamFragments(res: { body: unknown }): void {
  const serialized = JSON.stringify(res.body);
  for (const fragment of upstreamFragments()) {
    expect(serialized.includes(fragment), `响应体泄漏上游片段 ${fragment}`).toBe(false);
  }
}

/**
 * 上游失败族公共断言:状态/ProblemJson 形态/问题码/脱敏文案字段(detail 存在且
 * 非空;DomainError 经全局 ProblemJsonFilter 渲染为 type/title/status/code/detail
 * 信封,脱敏文案在 detail,无 message 键)/全响应体无上游 URL 片段。
 */
async function expectUpstreamProblem(
  ref: string,
  expectedStatus: number,
  expectedCode: string,
): Promise<Record<string, unknown>> {
  const res = await trackedGet(`/api/public/media/logos/${ref}`);
  expect(res.status).toBe(expectedStatus);
  expectProblemContentType(res);
  expect((res.body as { code?: string }).code).toBe(expectedCode);
  const detail = (res.body as { detail?: unknown }).detail;
  expect(typeof detail).toBe('string');
  expect((detail as string).length).toBeGreaterThan(0);
  expectNoUpstreamFragments(res);
  return res.body as Record<string, unknown>;
}

describe('GET /api/public/media/logos/:logoRef 上游失败族(T021;api.md §1/§4.4-4.5)', () => {
  it('上游 200 text/html(非图片)→ 502 MEDIA_LOGO_UPSTREAM_FAILED(脱敏文案)', async () => {
    await expectUpstreamProblem(htmlRef, 502, 'MEDIA_LOGO_UPSTREAM_FAILED');
  });

  it('上游 image/* 但 Content-Encoding: gzip(非 identity)→ 502 与非图片同码同形', async () => {
    const gzipBody = await expectUpstreamProblem(gzipRef, 502, 'MEDIA_LOGO_UPSTREAM_FAILED');
    // 「同码」加强:与非图片 502 逐字段同形(静态脱敏文案,不携带上游细节)
    const htmlRes = await trackedGet(`/api/public/media/logos/${htmlRef}`);
    expect(htmlRes.status).toBe(502);
    expect(gzipBody).toEqual(htmlRes.body);
  });

  it('上游挂起(永不回包)→ 504 MEDIA_LOGO_UPSTREAM_TIMEOUT,与 502 可区分(§4.5)', async () => {
    // 真实 SafeUpstream 传输:挂起下空闲预算(4s)先于总期限(8s)到期,同属 §1
    // 「超预算(总时限/空闲/中断)→ 504」族且形态不泄漏是哪项预算;总期限/中止
    // 分支的码映射由单元测试 logo.service.spec.ts 三分支钉面。真实等待 ≈4s。
    const timeoutBody = await expectUpstreamProblem(hangRef, 504, 'MEDIA_LOGO_UPSTREAM_TIMEOUT');
    const failedRes = await trackedGet(`/api/public/media/logos/${htmlRef}`);
    expect((timeoutBody as { code?: string }).code).not.toBe((failedRes.body as { code?: string }).code);
  });
});

/* ------------------------------------------------------------------ */
/* T034/T036 夹具(发布撤销事务形态 / 双家庭最简行集)                     */
/* ------------------------------------------------------------------ */

/**
 * T034 发布撤销夹具:新频道媒体行 + 同一 UnitOfWork 事务内「签发胜者 + poster 落值
 * + 撤销转墓碑」(internal-ports §2「签发 + 写 poster_ref 同事务同域」与 data-model §5
 * active → tombstone 的真实发布事务形态;revoke 仅对 active 行生效且同时清空
 * upstream_url)。revoked_at 取当前时刻(窗口内)。
 */
function seedRevokedChannelLogo(mediaId: string): string {
  Database.db
    .prepare(
      `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
         title_overridden, type_overridden, version, media_role, created_at, updated_at)
       VALUES (?, 'hh-logo-contract', 'channel', '契约频道', NULL, NULL, NULL, 0, 0, 1, 'standalone', ?, ?)`,
    )
    .run(mediaId, NOW_ISO, NOW_ISO);
  const nowIso = new Date().toISOString();
  const uow = createUnitOfWork({
    resolveDatabase: () => Database.db,
    txStores: { catalog: createMediaCatalogTxParticipants },
  });
  return uow.run(
    (txStores) => txStores.catalog,
    (catalog) => {
      const { ref } = catalog.upsertChannelLogoWinner({
        householdId: 'hh-logo-contract',
        mediaId,
        upstreamUrl: logoUrl,
        sourceKind: 'iptv',
        sourceId: 'src-iptv-logo',
        nowIso,
      });
      catalog.setChannelPosterRef('hh-logo-contract', mediaId, ref);
      catalog.revokeChannelLogo('hh-logo-contract', mediaId, nowIso);
      return ref;
    },
    { behavior: 'immediate' },
  );
}

/**
 * T036 双家庭 fixture:家庭 B 最简行集(直接 SQL 沿既有 fixture 方式)——
 * household/media_source/media_item 行先满足复合 FK(channel_logo (household_id,
 * media_id)/(household_id, source_id) 与 household 主 FK),channel_logo 行以 SQL
 * 直插(探测面即「注册表中他庭 household_id 的 ref 行」)。返回家庭 B 的注册表引用。
 */
function seedForeignHouseholdLogo(): string {
  const conn = Database.db;
  conn
    .prepare(
      "INSERT INTO household (id, name, default_language, timezone, created_at) VALUES (?, 'B之家', 'zh-CN', 'Asia/Shanghai', ?)",
    )
    .run(FOREIGN_HOUSEHOLD_ID, NOW_ISO);
  conn
    .prepare(
      `INSERT INTO media_source (id, household_id, kind, name, remote_url, enabled, version, created_at, updated_at)
       VALUES (?, ?, 'iptv', 'IPTV契约源B', ?, 1, 1, ?, ?)`,
    )
    .run(FOREIGN_SOURCE_ID, FOREIGN_HOUSEHOLD_ID, logoUrl, NOW_ISO, NOW_ISO);
  conn
    .prepare(
      `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
         title_overridden, type_overridden, version, media_role, created_at, updated_at)
       VALUES (?, ?, 'channel', 'B家庭契约频道', NULL, NULL, NULL, 0, 0, 1, 'standalone', ?, ?)`,
    )
    .run(FOREIGN_MEDIA_ID, FOREIGN_HOUSEHOLD_ID, NOW_ISO, NOW_ISO);
  conn
    .prepare(
      `INSERT INTO channel_logo (
        household_id, media_id, ref, upstream_url, source_kind, source_id,
        revision, revoked_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'iptv', ?, 1, NULL, ?, ?)`,
    )
    .run(FOREIGN_HOUSEHOLD_ID, FOREIGN_MEDIA_ID, FOREIGN_REF, logoUrl, FOREIGN_SOURCE_ID, NOW_ISO, NOW_ISO);
  return FOREIGN_REF;
}

/**
 * 摘除家庭 B 的 household 行(幂等;FK 校验临时关闭,注册表/媒体/来源行保留孤儿态):
 * 单家庭部署模型下 household 表第二行会令 PublicContextService 判定部署损坏
 * (503 STORAGE_GENERATION_UNSUPPORTED),故请求期必须维持恰一家庭;跨家庭探测面是
 * 注册表中他庭 household_id 行,孤儿态不影响 (household_id, ref) 作用域单查。
 */
function removeForeignHouseholdRow(): void {
  const conn = Database.db;
  conn.pragma('foreign_keys = OFF');
  try {
    conn.prepare('DELETE FROM household WHERE id = ?').run(FOREIGN_HOUSEHOLD_ID);
  } finally {
    conn.pragma('foreign_keys = ON');
  }
}

/**
 * 限频窗口清空(rate-limit-evidence.e2e-spec.ts 先例 + 本文件装配实况):logo 守卫
 * 经 media-catalog.module 的 PARAMTYPES_METADATA 补齐走 Nest DI —— 计数表是
 * HttpCommonModule 提供的 RateLimitService 实例,非模块级 sharedRateLimitService
 * 单例;精确计数须清应用容器解析出的那一实例(单例兜底一并清,兼容回落挂载形态)。
 */
function clearRateLimitWindows(): void {
  const diService = app.get(RateLimitService) as unknown as { windows: Map<string, number[]> };
  diService.windows.clear();
  (sharedRateLimitService() as unknown as { windows: Map<string, number[]> }).windows.clear();
}

/* ------------------------------------------------------------------ */
/* T034 墓碑生命周期(api.md §1 错误表第 3 行;§4.3)                      */
/* ------------------------------------------------------------------ */

describe('GET /api/public/media/logos/:logoRef 墓碑 410 与 GC 后 404 同形(T034;api.md §4.3)', () => {
  it('发布撤销(同事务签发+poster+revoke)→ 窗口内旧 ref 410 MEDIA_LOGO_REVOKED,code 与 404 可区分', async () => {
    const revokedRef = seedRevokedChannelLogo('ch-logo-tombstone');
    const res = await trackedGet(`/api/public/media/logos/${revokedRef}`);
    expect(res.status).toBe(410);
    expectProblemContentType(res);
    expect((res.body as { code?: string }).code).toBe('MEDIA_LOGO_REVOKED');
    // 可区分性:与伪造/未签发/GC 后的 404 NOT_FOUND 不同码、不同状态(§1 错误表第 1/3 行)
    expect((res.body as { code?: string }).code).not.toBe('NOT_FOUND');
    expect((res.body as { status?: number }).status).toBe(410);
    // 「已失效,请刷新列表」语义:脱敏文案存在(无上游信息归 T037 全量)
    expect((res.body as { detail?: unknown }).detail).toBeTruthy();
  });

  it('revoked_at 快进到 7 天窗口外 + gcExpiredChannelLogoTombstones → 同 ref 404,与目录资源不存在逐字段 toEqual 同形', async () => {
    const ref = seedRevokedChannelLogo('ch-logo-tombstone-gc');
    // 窗口内基线:同 ref 仍 410(证明 410 → 404 的唯一变化是墓碑 GC)
    const inWindow = await trackedGet(`/api/public/media/logos/${ref}`);
    expect(inWindow.status).toBe(410);
    // 快进:revoked_at 移到窗口外(7 天前再留 1 分钟裕量;ISO-8601 TEXT 字典序=时间序)
    const expiredRevokedAt = new Date(Date.now() - CHANNEL_LOGO_TOMBSTONE_WINDOW_MS - 60_000).toISOString();
    Database.db
      .prepare('UPDATE channel_logo SET revoked_at = ?, updated_at = ? WHERE household_id = ? AND media_id = ?')
      .run(expiredRevokedAt, expiredRevokedAt, 'hh-logo-contract', 'ch-logo-tombstone-gc');
    // GC 沿发布事务路径(真实 UnitOfWork;olderThanIso = now − 7d,与窗口常量同源)
    const uow = createUnitOfWork({
      resolveDatabase: () => Database.db,
      txStores: { catalog: createMediaCatalogTxParticipants },
    });
    uow.run(
      (txStores) => txStores.catalog,
      (catalog) =>
        catalog.gcExpiredChannelLogoTombstones(
          'hh-logo-contract',
          new Date(Date.now() - CHANNEL_LOGO_TOMBSTONE_WINDOW_MS).toISOString(),
        ),
      { behavior: 'immediate' },
    );
    // 集合 DELETE 证据:墓碑行已物理删除
    const remaining = Database.db
      .prepare('SELECT COUNT(*) AS n FROM channel_logo WHERE household_id = ? AND media_id = ?')
      .get('hh-logo-contract', 'ch-logo-tombstone-gc') as { n: number };
    expect(remaining.n).toBe(0);
    // 同 ref → 404,与「目录资源不存在」响应体逐字段 toEqual(§4.3;不透露「曾存在」)
    const afterGc = await trackedGet(`/api/public/media/logos/${ref}`);
    expect(afterGc.status).toBe(404);
    const catalogMissing = await trackedGet('/api/public/media/definitely-missing');
    expect(catalogMissing.status).toBe(404);
    expect(afterGc.body).toEqual(catalogMissing.body);
  });
});

/* ------------------------------------------------------------------ */
/* T036 伪造/跨家庭不可区分(api.md §4.1/§4.2;宪章原则一负向验收)         */
/* ------------------------------------------------------------------ */

describe('GET /api/public/media/logos/:logoRef 伪造与跨家庭 404 不可区分(T036;api.md §4.1/4.2)', () => {
  it('伪造 ref(真随机 32 hex)→ 404,与「目录资源不存在」响应体逐字段 toEqual 相等', async () => {
    const forged = await trackedGet(`/api/public/media/logos/${randomBytes(16).toString('hex')}`);
    expect(forged.status).toBe(404);
    expectProblemContentType(forged);
    const catalogMissing = await trackedGet('/api/public/media/definitely-missing');
    expect(catalogMissing.status).toBe(404);
    expect(forged.body).toEqual(catalogMissing.body);
  });

  it('跨家庭 ref(双家庭 fixture,部署家庭作用域请求他庭注册行)→ 404,与伪造 404 响应体逐字段 toEqual(不可区分)', async () => {
    try {
      const foreignRef = seedForeignHouseholdLogo();
      removeForeignHouseholdRow(); // 请求期恢复单家庭部署判定(否则 requireScope 503 判部署损坏)
      // 部署作用域守卫:恰一家庭(家庭 B 的注册表/媒体行保留孤儿态,不在判定面)
      const householdCount = Database.db.prepare('SELECT COUNT(*) AS n FROM household').get() as { n: number };
      expect(householdCount.n).toBe(1);
      const cross = await trackedGet(`/api/public/media/logos/${foreignRef}`);
      expect(cross.status).toBe(404);
      expectProblemContentType(cross);
      const forged = await trackedGet(`/api/public/media/logos/${randomBytes(16).toString('hex')}`);
      expect(forged.status).toBe(404);
      // 不可区分:与伪造 404 响应体逐字段 toEqual 相等(§4.2 负向验收)
      expect(cross.body).toEqual(forged.body);
      // 与「目录资源不存在」基线同样逐字段同形(§4.1)
      const catalogMissing = await trackedGet('/api/public/media/definitely-missing');
      expect(catalogMissing.status).toBe(404);
      expect(cross.body).toEqual(catalogMissing.body);
    } finally {
      removeForeignHouseholdRow(); // 幂等兜底:断言失败也不把 503 部署损坏态留给后续用例
    }
  });
});

/* ------------------------------------------------------------------ */
/* T037 泄漏面总断言 + 限频(api.md §4 清单 7/8)                         */
/* ------------------------------------------------------------------ */

describe('GET /api/public/media/logos/:logoRef 泄漏面与限频(T037;api.md §4 清单 7/8)', () => {
  it('限频:public 桶 120 次/分钟/IP 打满后第 121 次 → 429 + Retry-After(§4.8;rate-limit-evidence 先例:清空共享窗口后真实触发)', async () => {
    clearRateLimitWindows();
    // 以伪造 ref 打满:404 廉价(不触上游/注册表)且计入限频窗口(guard 先于控制器)
    const forgedRef = randomBytes(16).toString('hex');
    for (let index = 0; index < 120; index += 1) {
      const res = await request(http()).get(`/api/public/media/logos/${forgedRef}`);
      // 未达窗口前不允许任何 429(出现即为本用例失败证据);窗口内 404 响应体与
      // 已捕获伪造 404 同形,不重复入册
      expect(res.status, `第 ${index + 1} 次请求不应被限频`).not.toBe(429);
    }
    const overflow = await trackedGet(`/api/public/media/logos/${forgedRef}`);
    expect(overflow.status).toBe(429);
    expectProblemContentType(overflow);
    expect((overflow.body as { code?: string }).code).toBe('PLAYBACK_RATE_LIMITED');
    expect(overflow.headers['cache-control']).toBe('no-store');
    const retryAfter = Number(overflow.headers['retry-after']);
    expect(Number.isFinite(retryAfter), `Retry-After 应为秒数,实际 ${overflow.headers['retry-after']}`).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('泄漏面总断言:本文件全部用例响应体(序列化 JSON)0 处上游 URL 片段(§4 清单 7)', () => {
    // 收集器覆盖:旧 6 用例 + T034 两用例 + T036 两用例 + 429 溢出响应
    expect(capturedBodies.length, '响应体收集器应已入册本文件用例响应体').toBeGreaterThanOrEqual(14);
    const fragments = upstreamFragments();
    for (const [index, body] of capturedBodies.entries()) {
      const serialized = JSON.stringify(body);
      for (const fragment of fragments) {
        expect(serialized.includes(fragment), `第 ${index} 个响应体泄漏上游片段 ${fragment}`).toBe(false);
      }
    }
  });
});
