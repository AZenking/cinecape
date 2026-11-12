/**
 * 014 T009 — 频道 Logo 同源代理用例(internal-ports.md §3「解析端口」/api.md §1):
 *
 * GET /public/media/logos/:logoRef 的服务面 —— logoRef(频道级不透明引用)→
 * channel_logo 注册表按 (household_id, ref) 单查 → active 行的私有 upstream_url →
 * SafeUpstream 有界读取 → 仅接受 image/* 且 identity 编码 → 原字节回传。
 *
 * 设计约束(与 010 海报代理同口径,research R7):
 * - 上游地址只在注册表私有列可见,公共面仅见不透明引用(internal-ports §5 禁止事项);
 * - ref 可逆性只在注册表:未签发/伪造/格式非法/跨家庭/GC 后 → 404 同形(与目录
 *   资源不存在完全同形,不透露「曾存在」);墓碑窗口内 → 410 MEDIA_LOGO_REVOKED
 *   (「已失效,请刷新列表」);频道媒体删除(CASCADE)→ 404 同形;
 * - 传输经 SafeUpstream:协议/DNS/每跳重定向/许可列表/字节与时长预算全量复用,
 *   失败按稳定码映射 502/504(脱敏,不回显上游地址与细节);
 *   (application 层 R1 白名单不含 platform/upstream(仅 http-common/config),
 *   故传输以本文件结构端口表达、装配直传 SAFE_UPSTREAM_PORT —— 与 sources
 *   application sources.service.ts 010-T026 同款处置,见 LogoUpstreamPort);
 * - 纯读:不落盘、不写服务端缓存;响应字节即弃。
 *
 * 预算数值沿用 010 VOD_POSTER_BUDGETS(≤2MiB/8s/4s/≤3 跳;R7「数值常量复用」)——
 * 跨上下文深导入被 R2 禁止,故此处等值复制并以本注释声明唯一事实源为
 * contexts/online-vod/application/poster.service.ts 的 VOD_POSTER_BUDGETS。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import { env } from '@platform/config/env';
import type { LanTarget } from '@platform/config/env.schema';
import type { ChannelLogoResolveRow } from '@contexts/media-catalog/infrastructure/channel-logo.repository';
import { isWellFormedLogoRef } from '@contexts/media-catalog/domain/logo-ref';

/* ------------------------------------------------------------------ */
/* 预算(数值沿用 010 VOD_POSTER_BUDGETS;见文件头声明)                    */
/* ------------------------------------------------------------------ */

/** 频道 Logo 读取预算:单图 ≤2MiB、总期限 8s、空闲 4s、逐跳重定向 ≤3(数值沿用 010 VOD_POSTER_BUDGETS) */
export const MEDIA_LOGO_BUDGETS = {
  maxBytes: 2 * 1024 * 1024,
  totalTimeoutMs: 8_000,
  idleTimeoutMs: 4_000,
  maxRedirects: 3,
} as const;

/* ------------------------------------------------------------------ */
/* 问题码与错误构造(T005 shared 注册;vodUpstreamError 同风格)            */
/* ------------------------------------------------------------------ */

/** 014 契约载荷码(shared ProblemCode 已注册;此处聚合供映射与测试对照) */
export const MEDIA_LOGO_PROBLEM_CODES = {
  /** 命中墓碑(revoked_at 窗口内)→ 410 */
  MEDIA_LOGO_REVOKED: ProblemCode.MEDIA_LOGO_REVOKED,
  /** 上游读取失败/非图片/非 identity 编码 → 502 */
  MEDIA_LOGO_UPSTREAM_FAILED: ProblemCode.MEDIA_LOGO_UPSTREAM_FAILED,
  /** 上游超预算(总时限/空闲超时/中断)→ 504 */
  MEDIA_LOGO_UPSTREAM_TIMEOUT: ProblemCode.MEDIA_LOGO_UPSTREAM_TIMEOUT,
} as const;

export type MediaLogoProblemCode = (typeof MEDIA_LOGO_PROBLEM_CODES)[keyof typeof MEDIA_LOGO_PROBLEM_CODES];

/** 静态脱敏文案的错误构造(不含上游地址/注册表内部形态;status 按 api.md §1 错误表) */
export function mediaLogoUpstreamError(code: MediaLogoProblemCode, detail: string): DomainError {
  const status =
    code === MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED
      ? 502
      : code === MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_TIMEOUT
        ? 504
        : 410;
  return new DomainError(status, code, detail);
}

/**
 * 404 同形构造(未签发/伪造/格式非法/跨家庭/GC 后/未初始化;api.md §4.1「与目录
 * 资源不存在完全同形」——与 public-catalog.service 的 404 同码同缺省 detail 形态,
 * 不携带任何 detail 以保证逐字同形,不透露「曾存在」)。
 */
function logoNotFound(): DomainError {
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

/* ------------------------------------------------------------------ */
/* 注入面与返回值                                                       */
/* ------------------------------------------------------------------ */

/** 注册表解析读面(channel_logo 仓储按 (household_id, ref) 单查;T008) */
export type ChannelLogoResolveFn = (householdId: string, ref: string) => ChannelLogoResolveRow | undefined;

/**
 * SafeUpstream 有界读取的 service 消费子面(结构端口,本文件内不导出):
 * application 层 R1 白名单不含 platform/upstream(仅 http-common/config,见
 * .dependency-cruiser.cjs R1b),故按 sources.application sources.service.ts 010-T026
 * 同款处置镜像请求/结果子面 —— 装配侧(media-catalog.module)直传 SAFE_UPSTREAM_PORT
 * 绑定实现,结构兼容无需适配器;失败以 RemoteReadFailure 形态(稳定 code,事实源
 * platform/upstream/safe-upstream-reader)抛出,映射按 code 结构判定(见下)。
 */
interface LogoUpstreamReadRequest {
  url: string;
  allowedTargets: readonly LanTarget[];
  byteBudget: number;
  timeBudgets: { totalTimeoutMs: number; idleTimeoutMs: number; maxRedirects: number };
}

/** 有界全量读取结果(platform SafeUpstreamReadResult 逐字段同形镜像) */
interface LogoUpstreamReadResult {
  bytes: Buffer;
  contentType: string | null;
  contentEncoding: string | null;
  finalUrl: string;
  redirectsFollowed: number;
}

interface LogoUpstreamPort {
  /** 流式子面:本用例仅消费 read、不调用 open;可选声明以结构兼容平台绑定直传与测试替身形态 */
  open?(request: LogoUpstreamReadRequest): Promise<unknown>;
  read(request: LogoUpstreamReadRequest): Promise<LogoUpstreamReadResult>;
}

/** 频道 Logo 代理内容(字节与已校验的 image/* content-type;调用方原样回传) */
export interface MediaLogoContent {
  readonly contentType: string;
  readonly bytes: Buffer;
}

/** 解析端口返回形状(internal-ports §3):undefined → 404 同形;'revoked' → 410 */
export type LogoResolution = { readonly upstreamUrl: string; readonly mediaId: string } | 'revoked' | undefined;

export interface LogoProxyServiceDeps {
  readonly resolveByRef: ChannelLogoResolveFn;
  readonly safeUpstream: LogoUpstreamPort;
  /** 部署许可列表(与搜索/详情/海报同一 getConfig().LAN_ALLOWED_TARGETS 口径) */
  readonly allowedTargets: readonly LanTarget[];
}

/* ------------------------------------------------------------------ */
/* 服务工厂                                                             */
/* ------------------------------------------------------------------ */

export function createLogoProxyService(deps: LogoProxyServiceDeps): {
  resolveForHousehold(householdId: string, logoRef: string): LogoResolution;
  fetchLogoBytes(upstreamUrl: string): Promise<MediaLogoContent>;
  fetch(command: { readonly householdId: string; readonly logoRef: string }): Promise<MediaLogoContent>;
} {
  /** RemoteReadFailure 形态的稳定码读取(结构判定,不 import platform/upstream 类值;sources.service 同形) */
  function upstreamErrorCode(error: unknown): string {
    return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  }

  /** 上游传输失败 → 稳定码映射(502/504 可区分但不泄漏是哪项预算;稳定码表与 010 海报/搜索同源) */
  function mapUpstreamFailure(error: unknown): DomainError {
    const code = upstreamErrorCode(error);
    if (code === 'SOURCE_IDLE_TIMEOUT' || code === 'SOURCE_ABORTED' || code === 'SOURCE_BUDGET_EXCEEDED') {
      return mediaLogoUpstreamError(MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_TIMEOUT, '频道 Logo 读取超出预算时限');
    }
    return mediaLogoUpstreamError(MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED, '频道 Logo 读取失败,请稍后重试');
  }

  /**
   * 解析端口(internal-ports §3):按请求作用域家庭单查注册表——
   * - ref 形态门:非 32 字符小写 hex 与未签发同形 undefined(404,不透露注册表形态);
   * - 未命中(未签发/伪造/跨家庭/GC 后/CASCADE)→ undefined;
   * - 命中墓碑(revoked_at 窗口内)→ 'revoked'(410 由 fetch 面构造);
   * - 命中 active → { upstreamUrl, mediaId }(active 行 url 为空属退化数据,防御同形 404)。
   */
  function resolveForHousehold(householdId: string, logoRef: string): LogoResolution {
    if (!isWellFormedLogoRef(logoRef)) {
      return undefined;
    }
    const row = deps.resolveByRef(householdId, logoRef);
    if (row === undefined) {
      return undefined;
    }
    if (row.revokedAt !== null) {
      return 'revoked';
    }
    if (row.upstreamUrl === null) {
      // active 行无地址属退化/防御面(伪造与退化同形 404,不泄露内部形态)
      return undefined;
    }
    return { upstreamUrl: row.upstreamUrl, mediaId: row.mediaId };
  }

  /** 私有地址 → 有界读取 → 仅接受 image/* 且 identity 编码;字节原样,即用即弃 */
  async function fetchLogoBytes(upstreamUrl: string): Promise<MediaLogoContent> {
    if (upstreamUrl.includes('/custom-logos/')) {
      const safeName = path.basename(upstreamUrl);
      const filePath = path.resolve(env.DATA_DIR, 'uploads', 'logos', safeName);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(safeName).toLowerCase();
        const contentType =
          ext === '.svg'
            ? 'image/svg+xml'
            : ext === '.webp'
            ? 'image/webp'
            : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : 'image/png';
        const bytes = await fs.promises.readFile(filePath);
        return { contentType, bytes };
      }
    }

    let read;
    try {
      read = await deps.safeUpstream.read({
        url: upstreamUrl,
        allowedTargets: deps.allowedTargets,
        byteBudget: MEDIA_LOGO_BUDGETS.maxBytes,
        timeBudgets: {
          totalTimeoutMs: MEDIA_LOGO_BUDGETS.totalTimeoutMs,
          idleTimeoutMs: MEDIA_LOGO_BUDGETS.idleTimeoutMs,
          maxRedirects: MEDIA_LOGO_BUDGETS.maxRedirects,
        },
      });
    } catch (error) {
      throw mapUpstreamFailure(error);
    }
    // 仅接受 image/* 且未编码响应:编码体(非 identity)不透传(避免双重编码歧义),
    // 归为上游不可用(502,脱敏不回显上游细节)
    const contentType = read.contentType ?? '';
    const encodingAcceptable = read.contentEncoding === null || read.contentEncoding === 'identity';
    if (!contentType.startsWith('image/') || !encodingAcceptable) {
      throw mediaLogoUpstreamError(MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_UPSTREAM_FAILED, '频道 Logo 读取失败,请稍后重试');
    }
    return { contentType, bytes: read.bytes };
  }

  /** 代理用例组合:解析门(404/410)→ 有界读取(502/504);错误映射在应用层完成,接口层只透传 */
  async function fetch(command: { readonly householdId: string; readonly logoRef: string }): Promise<MediaLogoContent> {
    const resolved = resolveForHousehold(command.householdId, command.logoRef);
    if (resolved === 'revoked') {
      throw mediaLogoUpstreamError(MEDIA_LOGO_PROBLEM_CODES.MEDIA_LOGO_REVOKED, '频道 Logo 引用已失效,请刷新列表');
    }
    if (resolved === undefined) {
      throw logoNotFound();
    }
    return fetchLogoBytes(resolved.upstreamUrl);
  }

  return { resolveForHousehold, fetchLogoBytes, fetch };
}
