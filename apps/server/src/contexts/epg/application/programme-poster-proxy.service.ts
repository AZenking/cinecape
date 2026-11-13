/**
 * 020 节目海报同源代理用例（EPG 应用层）。
 *
 * posterRef（32 位小写 hex）→ programme_poster 按 (household_id, ref) 单查 →
 * 仅 matched 且未过期 → 拼接配置的 TMDB 图片基址 → SafeUpstream 有界读取 →
 * 仅接受 image/* 且 identity 编码 → 原字节回传。
 *
 * 安全边界与 010/014 同口径：
 * - 公共 DTO 只有不透明 ref，上游 URL/TMDB ID 不出现在响应；
 * - 伪造/跨家庭/过期/非 matched/格式非法 → 404 同形；
 * - poster_path 严格正则，禁止 // 与 ..；host 只允许配置图片基址的精确 host；
 * - 字节不落盘；浏览器缓存 1 天；独立 mediaImage 限频桶。
 */

import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import type { LanTarget } from '@platform/config/env.schema';
import type { ProgrammePosterRow } from './epg-store.port';
import { isWellFormedPosterPath } from '@contexts/epg/domain/programme-poster-match';

/** 图片读取预算：单图 ≤2MiB、总期限 8s、空闲 4s、逐跳重定向 ≤3（与 010/014 同量级） */
export const PROGRAMME_POSTER_BUDGETS = {
  maxBytes: 2 * 1024 * 1024,
  totalTimeoutMs: 8_000,
  idleTimeoutMs: 4_000,
  maxRedirects: 3,
} as const;

export interface ProgrammePosterContent {
  readonly contentType: string;
  readonly bytes: Buffer;
}

interface UpstreamReadRequest {
  url: string;
  allowedTargets: readonly LanTarget[];
  byteBudget: number;
  timeBudgets: { totalTimeoutMs: number; idleTimeoutMs: number; maxRedirects: number };
}

interface UpstreamReadResult {
  bytes: Buffer;
  contentType: string | null;
  contentEncoding: string | null;
  finalUrl: string;
  redirectsFollowed: number;
}

export interface ProgrammePosterUpstreamPort {
  read(request: UpstreamReadRequest): Promise<UpstreamReadResult>;
}

export interface ProgrammePosterProxyDeps {
  readonly resolveByRef: (householdId: string, ref: string) => ProgrammePosterRow | undefined;
  readonly safeUpstream: ProgrammePosterUpstreamPort;
  readonly imageBaseUrl: string;
  readonly allowedTargets: readonly LanTarget[];
  readonly nowMs?: () => number;
}

/** posterRef 形态：32 位小写 hex（与 programme_poster.ref CHECK 一致）。 */
export function isWellFormedProgrammePosterRef(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

function posterNotFound(): DomainError {
  return new DomainError(404, ProblemCode.NOT_FOUND);
}

function upstreamFailed(): DomainError {
  return new DomainError(502, ProblemCode.PROGRAMME_POSTER_UPSTREAM_FAILED, '节目海报读取失败,请稍后重试');
}

function upstreamTimeout(): DomainError {
  return new DomainError(504, ProblemCode.PROGRAMME_POSTER_UPSTREAM_TIMEOUT, '节目海报读取超出预算时限');
}

function upstreamErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
}

function imageUrlOf(imageBaseUrl: string, posterPath: string): string {
  const base = imageBaseUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${posterPath}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw upstreamFailed();
  }
  return url.toString();
}

export function createProgrammePosterProxyService(deps: ProgrammePosterProxyDeps): {
  fetch(command: { readonly householdId: string; readonly posterRef: string }): Promise<ProgrammePosterContent>;
} {
  const now = deps.nowMs ?? (() => Date.now());

  function resolve(command: { householdId: string; posterRef: string }): ProgrammePosterRow {
    if (!isWellFormedProgrammePosterRef(command.posterRef)) {
      throw posterNotFound();
    }
    const row = deps.resolveByRef(command.householdId, command.posterRef);
    if (row === undefined || row.state !== 'matched' || row.ref === null || row.posterPath === null) {
      throw posterNotFound();
    }
    if (Date.parse(row.expiresAt) <= now()) {
      throw posterNotFound();
    }
    if (!isWellFormedPosterPath(row.posterPath)) {
      throw posterNotFound();
    }
    return row;
  }

  async function fetch(command: {
    readonly householdId: string;
    readonly posterRef: string;
  }): Promise<ProgrammePosterContent> {
    const row = resolve(command);
    const url = imageUrlOf(deps.imageBaseUrl, row.posterPath as string);
    let read: UpstreamReadResult;
    try {
      read = await deps.safeUpstream.read({
        url,
        allowedTargets: deps.allowedTargets,
        byteBudget: PROGRAMME_POSTER_BUDGETS.maxBytes,
        timeBudgets: {
          totalTimeoutMs: PROGRAMME_POSTER_BUDGETS.totalTimeoutMs,
          idleTimeoutMs: PROGRAMME_POSTER_BUDGETS.idleTimeoutMs,
          maxRedirects: PROGRAMME_POSTER_BUDGETS.maxRedirects,
        },
      });
    } catch (error) {
      const code = upstreamErrorCode(error);
      if (code === 'SOURCE_IDLE_TIMEOUT' || code === 'SOURCE_ABORTED' || code === 'SOURCE_BUDGET_EXCEEDED') {
        throw upstreamTimeout();
      }
      throw upstreamFailed();
    }
    const contentType = read.contentType ?? '';
    const encodingAcceptable = read.contentEncoding === null || read.contentEncoding === 'identity';
    if (!contentType.startsWith('image/') || !encodingAcceptable) {
      throw upstreamFailed();
    }
    return { contentType, bytes: read.bytes };
  }

  return { fetch };
}