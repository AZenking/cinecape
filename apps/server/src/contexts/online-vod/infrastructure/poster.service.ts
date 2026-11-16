/**
 * 010 海报代理用例(T031 顺延;api.md §2「海报代理」):
 *
 * GET /public/vod/posters/:posterRef 的服务面 —— posterRef(p 级 opaque ref)→
 * 注册表反查标题绑定条目 → 私有 posterUrl → SafeUpstream 有界读取 → 仅接受
 * image/* 明文响应 → 原字节回传。
 *
 * 设计约束(与 010 公共面同口径):
 * - 上游地址只在私有载荷(posterUrl)可见,公共 DTO 仅见不透明 posterRef;
 * - ref 可逆性只在注册表:伪造/未签发/非 poster 级(含 titleRef 冒用)→ 404 同形;
 *   过期未淘汰 → 410(与预览 ref 失效语义一致);跨家庭 → 404 同形;
 * - 传输经 SafeUpstream:协议/DNS/每跳重定向/许可列表/字节与时长预算全量复用,
 *   失败按稳定码映射 502/504(与搜索/详情同形脱敏,不回显上游细节);
 * - 纯读:不写缓存/媒体/个人记录;响应字节不落盘。
 */

import { DomainError } from '@platform/http-common/domain-error';
import { ProblemCode } from '@hmp/shared';
import type { SafeUpstreamPort } from '@platform/upstream/safe-upstream.port';
import { RemoteReadFailure } from '@platform/upstream/safe-upstream-reader';
import type { LanTarget } from '@platform/config/env.schema';
import { VOD_UPSTREAM_PROBLEM_CODES, vodUpstreamError } from '../application/search.service';
import type { VodCache } from './vod-cache';
import type { VodTitlePayload } from '../application/preview.service';

/* ------------------------------------------------------------------ */
/* 预算(海报探测固定值;传输层预算语义与搜索/详情一致)                    */
/* ------------------------------------------------------------------ */

/** 海报读取预算:单图 ≤2MiB、总期限 8s、空闲 4s、逐跳重定向 ≤3(与预览预算同量级) */
export const VOD_POSTER_BUDGETS = {
  maxBytes: 2 * 1024 * 1024,
  totalTimeoutMs: 8_000,
  idleTimeoutMs: 4_000,
  maxRedirects: 3,
} as const;

/* ------------------------------------------------------------------ */
/* 注入面与返回值                                                       */
/* ------------------------------------------------------------------ */

/** 海报代理内容(字节与已校验的 image/* content-type;调用方原样回传) */
export interface VodPosterContent {
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface VodPosterServiceDeps {
  readonly cache: VodCache;
  readonly safeUpstream: SafeUpstreamPort;
  /** 部署许可列表(与搜索/详情/测试同一口径) */
  readonly allowedTargets: readonly LanTarget[];
  readonly nowMs?: () => number;
}

/* ------------------------------------------------------------------ */
/* 服务工厂                                                             */
/* ------------------------------------------------------------------ */

export function createVodPosterService(deps: VodPosterServiceDeps): {
  fetch(command: { readonly householdId: string; readonly posterRef: string }): Promise<VodPosterContent>;
} {
  const now = deps.nowMs ?? (() => Date.now());

  function mapUpstreamFailure(error: unknown): DomainError {
    if (error instanceof RemoteReadFailure) {
      if (
        error.code === 'SOURCE_IDLE_TIMEOUT' ||
        error.code === 'SOURCE_ABORTED' ||
        error.code === 'SOURCE_BUDGET_EXCEEDED'
      ) {
        return vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_TIMEOUT, '上游海报读取超出预算时限');
      }
    }
    return vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED, '上游海报读取失败,请稍后重试');
  }

  /** ref 解析 + 条目门:伪造/非 poster 级/跨家庭 404 同形;过期未淘汰 410 */
  function resolvePosterUrl(householdId: string, posterRef: string): { readonly entryId: string; readonly posterUrl: string } {
    const resolved = deps.cache.resolveRef(posterRef);
    // 非 poster 级 ref(含 titleRef 冒用,其 local 为 title:*)与未签发同形 404:
    // 注册表 local 前缀即类别证据(签发面 local 形态 = poster:<dedupeKey>)
    if (resolved === undefined || !resolved.local.startsWith('poster:')) {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '媒体不存在或当前不可见');
    }
    const view = deps.cache.get<VodTitlePayload>(resolved.entryId);
    if (view === undefined || view.householdId !== householdId || view.kind !== 'preview') {
      throw new DomainError(404, ProblemCode.NOT_FOUND, '媒体不存在或当前不可见');
    }
    if (view.expiresAtMs <= now()) {
      throw new DomainError(410, ProblemCode.VOD_PREVIEW_EXPIRED, '预览引用已过期,请重新获取预览');
    }
    const payload = view.payload;
    if (payload.posterUrl === null) {
      // 无海报条目不签发 ref;此分支为防御面(伪造与退化同形 404,不泄露内部形态)
      throw new DomainError(404, ProblemCode.NOT_FOUND, '媒体不存在或当前不可见');
    }
    return { entryId: resolved.entryId, posterUrl: payload.posterUrl };
  }

  async function fetch(command: { readonly householdId: string; readonly posterRef: string }): Promise<VodPosterContent> {
    const { posterUrl } = resolvePosterUrl(command.householdId, command.posterRef);
    let read;
    try {
      read = await deps.safeUpstream.read({
        url: posterUrl,
        allowedTargets: deps.allowedTargets,
        byteBudget: VOD_POSTER_BUDGETS.maxBytes,
        timeBudgets: {
          totalTimeoutMs: VOD_POSTER_BUDGETS.totalTimeoutMs,
          idleTimeoutMs: VOD_POSTER_BUDGETS.idleTimeoutMs,
          maxRedirects: VOD_POSTER_BUDGETS.maxRedirects,
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
      throw vodUpstreamError(VOD_UPSTREAM_PROBLEM_CODES.VOD_UPSTREAM_FAILED, '上游海报读取失败,请稍后重试');
    }
    return { contentType, bytes: read.bytes };
  }

  return { fetch };
}
