import { Controller, Get, Head, Inject, Param, Query, Res, UseGuards } from '@nestjs/common';
import { PlaybackReadinessGuard } from '@contexts/playback/interface/playback-readiness.guard';
import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { ProblemCode } from '@hmp/shared';
import { CurrentSession, type SessionContext } from '../../../common/current-session.decorator';
import { SessionGuard } from '../../../common/session.guard';
import { createDomainError, DomainError } from '../../../common/domain-error';
import { getDb } from '@contexts/identity-access/infrastructure/db';
import { playbackSession } from '../../../database/schema';
import { getConfig } from '../../../config/env';
import { createPlaybackBudgets } from '../../../config/playback-budgets';
import { PlaybackRepository } from '@contexts/playback/infrastructure/playback.repository';
import { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import { PlaybackTicketService } from '@contexts/playback/application/playback-ticket.service';
import { PlaybackAssetsService, ENTRY_ASSET_ID, type LocalAssetKind } from '@contexts/playback/application/playback-assets.service';
import { HlsProxyService, type HlsAssetKind } from '@contexts/playback/infrastructure/hls-proxy.service';
import { NasReaderService, parseByteRange, type NasReadFailure } from '@contexts/playback/infrastructure/nas-reader';
import { PlaybackSourceLocationReader } from '@contexts/playback/infrastructure/media-probe.service';
import { PlaybackSubtitlesService } from '@contexts/playback/infrastructure/playback-subtitles.service';
import { PlaybackLifecycleService } from '@contexts/playback/infrastructure/playback-lifecycle.service';
import { PlaybackResolverService } from '@contexts/playback/application/playback-resolver.service';
import { isPlaybackStableErrorCode, type PlaybackErrorCode, type PlaybackSessionView } from '@contexts/playback/domain/playback.types';

/**
 * 播放媒体流网关(T031/T015,spec 004)—— GET/HEAD
 * /playback/stream/{sessionId}/{generation}/{assetId}?ticket=…。
 *
 * 权威依据(先读后写):
 * - docs/specs/004-playback-resolver/contracts/api.md「媒体端点」:
 *   仅接受资产 ID(不接受 URL/路径参数);每次 SessionGuard → ticket hash/TTL → 绑定
 *   session/generation → 最新策略与源事实 → generation/asset 归属 → 交付;ticket 不能用于
 *   其他 session/generation,asset 枚举不存在统一 404 同形;HLS MIME
 *   application/vnd.apple.mpegurl、key application/octet-stream、字幕 text/vtt;
 *   NAS direct 支持 GET/HEAD/单 Range(200/206、Accept-Ranges/Content-Length/Content-Range
 *   一致;越界 416;多个 Range 400);HEAD 与 GET 同鉴权且不发送字节;源故障未发 headers
 *   时 problem,已发字节则关闭流且不能在字节流内注入 JSON,session 失败码可被轮询;
 *   所有响应 Cache-Control:no-store、Referrer-Policy:no-referrer;
 * - research.md R3:redirect 不返回浏览器(内部跟随在 hls-proxy);Range 单区间;
 *   客户端断开必须取消读取(AbortSignal 贯通上游)。
 *
 * 鉴权链(顺序固定,勿调换):
 * 1. SessionGuard(令牌入口唯一权威,无会话 401 SESSION_INVALID);
 * 2. ticket(票据服务 validateStreamTicket,T037 裁决 ②):sha256(token) 查 playback_ticket
 *    → revoked → TTL(恰好过期=已过期,过期先行 401 TICKET_EXPIRED);
 * 3. 票绑定(sessionId + generation 与路径一致;家庭边界先于设备绑定 —— 跨家庭 404
 *    PLAYBACK_NOT_FOUND 同形;设备会话绑定 —— 该 session 归属 device_session_id === 当前
 *    请求设备会话;实时 generation 绑定 —— 票代 === 会话当前代,旧代票立即失效;
 *    跨代/跨 session/同家庭跨设备 → 401 TICKET_INVALID,api.md「绑定
 *    session/device/profile」+ seek 行「旧票立即失效」);
 * 4. authorization.authorizeControl(最新策略/源事实;非本设备 404 不泄漏存在性);
 * 5. asset 归属:assets.resolve 五元组;direct 模式入口资产按当前代源 location 直读;
 *    resolve 未命中且 assetId 属会话字幕目录 → 字幕文本交付;其余统一 404 MEDIA_NOT_FOUND。
 *
 * 交付分派:
 * - direct(源为 NAS 文件且计划 direct):入口资产 'index' 直接 openRange 全量/单 Range 流,
 *   不走清单重写(R2:playbackUrl 指向的入口即媒体文件);Range 经 headInfo.size +
 *   parseByteRange 判定 200/206/416/400;首次成功交付 resolver.markPlaying(started_at 一次);
 * - hls_proxy/转换族:'index' 未注册时先按当前代源 location 注册(registerEntry)→
 *   hls-proxy.readPlaylist → assets.rewritePlaylist(同源重写,禁透传原文);分片/MAP/key
 *   经 readAsset 流式(key 恒 octet-stream);字幕资产 text/vtt;
 * - 换代清理:检测 generation 变化即 assets.releaseGeneration(旧代)+ 本网关深度登记清理;
 * - 断开取消:res 'close' → AbortSignal → readPlaylist/readAsset 取消;流错误已发字节
 *   毁连不注入 JSON 并经 lifecycle.markFailure 落稳定 failure_code(可轮询);源变化
 *   (openRange sourceChanged)同路径停止该 session。
 */

/** 媒体端点响应公共安全头(契约:所有响应 no-store/no-referrer,字节不公开缓存) */
function applyMediaHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/** 控制器路径段 → 数值代(非法形态交由票绑定校验统一拒绝) */
function parseGenerationSegment(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    return Number.NaN;
  }
  return Number(raw);
}

/** 分片/MAP 兜底 MIME(上游未声明时按扩展名;其余 octet-stream) */
function fallbackSegmentMime(upstreamUrl: string): string {
  const path = upstreamUrl.split(/[?#]/)[0] ?? '';
  if (path.toLowerCase().endsWith('.ts')) {
    return 'video/mp2t';
  }
  if (path.toLowerCase().endsWith('.m4s') || path.toLowerCase().endsWith('.mp4')) {
    return 'video/mp4';
  }
  return 'application/octet-stream';
}

/** 注册表资产类别 → hls-proxy readAsset 预算类别(MAP 按分片预算) */
function assetKindToHlsKind(kind: 'segment' | 'key' | 'map' | 'subtitle'): HlsAssetKind {
  return kind === 'map' ? 'segment' : kind;
}

/** 本地产物 MIME(缺口1 fs 直读;与 fallbackSegmentMime 同族按扩展名判定) */
function localAssetContentType(kind: LocalAssetKind, filePath: string): string {
  if (kind === 'subtitle') {
    return 'text/vtt';
  }
  if (kind === 'manifest') {
    return 'application/vnd.apple.mpegurl';
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ts')) {
    return 'video/mp2t';
  }
  if (lower.endsWith('.m4s') || lower.endsWith('.mp4')) {
    return 'video/mp4';
  }
  return 'application/octet-stream';
}

@Controller('playback/stream')
@UseGuards(PlaybackReadinessGuard, SessionGuard)
export class PlaybackStreamController {
  /** 会话最近一次请求代(换代检测:变化即清理旧代资产映射) */
  private readonly generationBySession = new Map<string, number>();

  /** 清单资产深度登记(key=household␀session␀generation␀assetId;入口=0,子清单逐层 +1) */
  private readonly depthByAsset = new Map<string, number>();

  /**
   * 构造注入显式 token:契约测试管线(vitest/esbuild)不产出 design:paramtypes 元数据,
   * 依赖解析必须逐参数 @Inject(与模块工厂 inject 数组同一语义)。
   */
  constructor(
    @Inject(PlaybackRepository) private readonly repository: PlaybackRepository,
    @Inject(PlaybackAuthorizationService) private readonly authorization: PlaybackAuthorizationService,
    @Inject(PlaybackTicketService) private readonly ticket: PlaybackTicketService,
    @Inject(PlaybackAssetsService) private readonly assets: PlaybackAssetsService,
    @Inject(HlsProxyService) private readonly hls: HlsProxyService,
    @Inject(NasReaderService) private readonly nasReader: NasReaderService,
    @Inject(PlaybackSubtitlesService) private readonly subtitles: PlaybackSubtitlesService,
    @Inject(PlaybackLifecycleService) private readonly lifecycle: PlaybackLifecycleService,
    @Inject(PlaybackResolverService) private readonly resolver: PlaybackResolverService,
    @Inject(PlaybackSourceLocationReader) private readonly sourceLocator: PlaybackSourceLocationReader,
  ) {}

  @Get(':sessionId/:generation/:assetId')
  async deliverByGet(
    @Param('sessionId') sessionId: string,
    @Param('generation') generation: string,
    @Param('assetId') assetId: string,
    @Query('ticket') ticket: unknown,
    @CurrentSession() context: SessionContext,
    @Res() res: Response,
  ): Promise<void> {
    // 异常不吞:未发 headers 的错误交由全局 ProblemJsonFilter 渲染 problem+json;
    // 已发字节后的迟到错误由过滤器「流后边界」守卫丢弃(不注入 JSON)
    await this.deliver(context, res.req, res, sessionId, generation, assetId, ticket, false);
  }

  @Head(':sessionId/:generation/:assetId')
  async deliverByHead(
    @Param('sessionId') sessionId: string,
    @Param('generation') generation: string,
    @Param('assetId') assetId: string,
    @Query('ticket') ticket: unknown,
    @CurrentSession() context: SessionContext,
    @Res() res: Response,
  ): Promise<void> {
    await this.deliver(context, res.req, res, sessionId, generation, assetId, ticket, true);
  }

  /* ---------------------------------------------------------------- */
  /* 鉴权链与分派                                                         */
  /* ---------------------------------------------------------------- */

  private async deliver(
    context: SessionContext,
    request: Request,
    res: Response,
    sessionId: string,
    generationSegment: string,
    assetId: string,
    ticket: unknown,
    isHead: boolean,
  ): Promise<void> {
    // 2. ticket hash/撤销/TTL 校验 + 3. 票绑定 session/device/generation —— T037 裁决 ②:
    //    集中委托票据服务 validateStreamTicket(与签发同源 hashToken 算法与库内实时事实;
    //    设备会话绑定 → 401 TICKET_INVALID,实时 generation 绑定 → 旧代票立即失效;
    //    过期先行 → TICKET_EXPIRED)。SessionGuard 先于票校验(守卫链,顺序不变)。
    const token = typeof ticket === 'string' ? ticket : undefined;
    if (token === undefined || token === '') {
      throw createDomainError('PLAYBACK_TICKET_INVALID');
    }
    const generation = parseGenerationSegment(generationSegment);
    this.ticket.validateStreamTicket(token, {
      sessionId,
      generation,
      deviceSessionId: context.session.id,
    });
    // 4. 最新授权(策略/源事实;非本设备/跨家庭/不存在统一 404,不泄漏存在性)
    await this.authorization.authorizeControl(context, sessionId);
    const loaded = this.repository.getSession(context.session.householdId, sessionId);
    if (!loaded.ok) {
      throw createDomainError('PLAYBACK_NOT_FOUND', loaded.detail);
    }
    const session = loaded.value;
    // 会话选定源(playback_source_id 不在对外视图内,刻意不外泄;网关内经只读投影取用)
    const playbackSourceId = await this.sourceIdOf(sessionId);
    // 换代清理:generation 变化即丢弃旧代资产映射(TTL 不超 session)
    this.releaseSupersededGeneration(context.session.householdId, sessionId, generation);
    // 客户端断开取消(AbortSignal 贯通上游读取;正常结束后触发为无害 no-op)
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    if (session.delivery === 'direct' && playbackSourceId !== null) {
      await this.deliverDirect(request, res, isHead, session, playbackSourceId, assetId, context);
      return;
    }
    // 转换族本地产物窗口(缺口1):本会话本代已登记产物目录 → fs 流直读交付,
    // 不经 hls-proxy(产物为本机受控 ffmpeg 输出,不存在上游 URL 面)
    const localDirectory = this.assets.localWindowOf(context.session.householdId, session.id, generation);
    if (localDirectory !== undefined) {
      await this.deliverLocalWindow(context.session.householdId, res, isHead, context, session, generation, assetId, token, localDirectory);
      return;
    }
    await this.deliverManaged(res, isHead, context, session, playbackSourceId, generation, assetId, token, abort.signal);
  }

  /* ---------------------------------------------------------------- */
  /* NAS direct 直读交付(GET/HEAD/单 Range;入口资产 = 媒体文件)          */
  /* ---------------------------------------------------------------- */

  private async deliverDirect(
    request: Request,
    res: Response,
    isHead: boolean,
    session: PlaybackSessionView,
    playbackSourceId: string,
    assetId: string,
    context: SessionContext,
  ): Promise<void> {
    if (assetId !== ENTRY_ASSET_ID) {
      // 直读模式唯一注册资产是入口 'index';字幕轨词表内的资产按字幕文本交付,
      // 其余枚举不存在统一 404(loadSubtitleContent 内部同形拒绝)
      await this.deliverSubtitleAsset(res, isHead, session.id, session.generation, assetId, context);
      return;
    }
    const located = await this.sourceLocator.locate(playbackSourceId);
    if (located === null) {
      throw createDomainError('PLAYBACK_RESOURCE_UNAVAILABLE');
    }
    // Range 元信息:headInfo.size + parseByteRange(200/206/416/400)
    const head = await this.nasReader.headInfo(located.location);
    if (!head.ok) {
      this.throwSourceFailure(session.id, head);
    }
    const parsed = parseByteRange(readRangeHeader(request), head.value.size);
    if (parsed.kind === 'invalid') {
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, 'Range 仅允许单区间 bytes 语法');
    }
    if (parsed.kind === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${parsed.size}`);
      throw new DomainError(416, ProblemCode.VALIDATION_FAILED, 'Range 起始位置超出媒体长度');
    }
    const opened =
      parsed.kind === 'single'
        ? await this.nasReader.openRange(located.location, { start: parsed.start, end: parsed.endInclusive })
        : await this.nasReader.openRange(located.location);
    if (!opened.ok) {
      this.throwSourceFailure(session.id, opened);
    }
    const payload = opened;
    res.status(payload.status);
    res.setHeader('Content-Type', payload.contentType ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', payload.acceptRanges);
    res.setHeader('Content-Length', String(payload.contentLength));
    if (payload.contentRange !== null) {
      res.setHeader('Content-Range', payload.contentRange);
    }
    applyMediaHeaders(res);
    // 首次交付 playing(started_at 一次;CAS 失败=换代/终态竞态,不阻断交付)
    this.markPlayingOnce(session);
    if (isHead) {
      payload.stream.destroy();
      res.end();
      return;
    }
    this.pipeToResponse(res, payload.stream, session.id);
  }

  /* ---------------------------------------------------------------- */
  /* 转换族本地产物交付(fs 流直读;缺口1)                                 */
  /* ---------------------------------------------------------------- */

  /**
   * 本地产物窗口交付:资产定位经 assets.resolveLocalAsset(五元组 + 文件名词法白名单,
   * 无任何 URL/路径参数入口);manifest 读取后经 rewriteLocalManifest 同源重写(相对分片名
   * → 带票同源 URI,与上游重写同构);segment/subtitle 经 createReadStream 流式交付
   * (Content-Length 取 stat;不存在 404 同形;源读错误已发字节毁连不注入 JSON)。
   */
  private async deliverLocalWindow(
    householdId: string,
    res: Response,
    isHead: boolean,
    context: SessionContext,
    session: PlaybackSessionView,
    generation: number,
    assetId: string,
    ticket: string,
    directory: string,
  ): Promise<void> {
    void directory;
    const resolved = this.assets.resolveLocalAsset(householdId, session.id, generation, assetId);
    if (resolved === undefined) {
      // 窗口内资产词法/扩展名非法:字幕轨词表兜底后统一 404 同形(与上游枚举语义一致)
      await this.deliverSubtitleAsset(res, isHead, session.id, generation, assetId, context);
      return;
    }
    if (resolved.kind === 'manifest') {
      let text: string;
      try {
        text = await fsp.readFile(resolved.path, 'utf8');
      } catch {
        // 产物清单缺失(转换刚启动/窗口已释放):统一 503 稳定码,不含路径细节
        throw createDomainError('PLAYBACK_RESOURCE_UNAVAILABLE');
      }
      if (Buffer.byteLength(text, 'utf8') > createPlaybackBudgets(getConfig()).hlsUpstream.maxPlaylistBytes) {
        throw createDomainError('PLAYBACK_RESOURCE_UNAVAILABLE');
      }
      const body = this.assets.rewriteLocalManifest(householdId, session.id, generation, text, ticket);
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
      applyMediaHeaders(res);
      this.markPlayingOnce(session);
      if (isHead) {
        res.end();
        return;
      }
      res.end(body);
      return;
    }
    let size: number;
    try {
      size = (await fsp.stat(resolved.path)).size;
    } catch {
      throw createDomainError('PLAYBACK_NOT_FOUND');
    }
    res.status(200);
    res.setHeader('Content-Type', localAssetContentType(resolved.kind, resolved.path));
    res.setHeader('Content-Length', String(size));
    applyMediaHeaders(res);
    this.markPlayingOnce(session);
    if (isHead) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(resolved.path);
    this.pipeToResponse(res, stream as unknown as Readable, session.id);
  }

  /* ---------------------------------------------------------------- */
  /* HLS 代理 / 转换族交付(清单重写 + 资产流)                            */
  /* ---------------------------------------------------------------- */

  private async deliverManaged(
    res: Response,
    isHead: boolean,
    context: SessionContext,
    session: PlaybackSessionView,
    playbackSourceId: string | null,
    generation: number,
    assetId: string,
    ticket: string,
    signal: AbortSignal,
  ): Promise<void> {
    const householdId = context.session.householdId;
    let resolved = this.assets.resolve(householdId, session.id, generation, assetId);
    if (resolved === undefined && assetId === ENTRY_ASSET_ID && playbackSourceId !== null) {
      // 入口清单未注册:按当前代源 location 注册(桥接 playback_source 私有 location)
      const located = await this.sourceLocator.locate(playbackSourceId);
      if (located !== null) {
        this.assets.registerEntry(householdId, session.id, generation, located.location);
        this.setPlaylistDepth(householdId, session.id, generation, ENTRY_ASSET_ID, 0);
        resolved = { upstreamUrl: located.location, kind: 'manifest' };
      }
    }
    if (resolved === undefined) {
      // asset 枚举不存在:字幕轨词表兜底,其余统一 404 MEDIA_NOT_FOUND 同形
      await this.deliverSubtitleAsset(res, isHead, session.id, generation, assetId, context);
      return;
    }

    if (resolved.kind === 'manifest' || resolved.kind === 'playlist') {
      const depth = this.playlistDepthOf(householdId, session.id, generation, assetId);
      const read = await this.hls.readPlaylist(resolved.upstreamUrl, {
        allowedTargets: getConfig().LAN_ALLOWED_TARGETS,
        signal,
      });
      if (!read.ok) {
        throw createDomainError(read.code);
      }
      const rewritten = await this.assets.rewritePlaylist({
        householdId,
        sessionId: session.id,
        generation,
        upstreamUrl: read.value.finalUrl,
        text: read.value.text,
        ticket,
        depth,
      });
      if (!rewritten.ok) {
        throw createDomainError(rewritten.code);
      }
      // 本清单引用的子清单按 depth+1 登记(嵌套预算由 rewritePlaylist 按深度把关)
      for (const entry of rewritten.value.assets) {
        if (entry.kind === 'playlist') {
          this.setPlaylistDepth(householdId, session.id, generation, entry.assetId, depth + 1);
        }
      }
      const body = rewritten.value.playlist;
      res.status(200);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')));
      applyMediaHeaders(res);
      this.markPlayingOnce(session);
      if (isHead) {
        res.end();
        return;
      }
      res.end(body);
      return;
    }

    // segment/map/key/字幕资产:流式交付(key 恒 octet-stream;字幕恒 text/vtt)
    const read = await this.hls.readAsset(resolved.upstreamUrl, {
      allowedTargets: getConfig().LAN_ALLOWED_TARGETS,
      signal,
      kind: assetKindToHlsKind(resolved.kind),
    });
    if (!read.ok) {
      throw createDomainError(read.code);
    }
    const contentType =
      resolved.kind === 'key'
        ? 'application/octet-stream'
        : resolved.kind === 'subtitle'
          ? 'text/vtt'
          : (read.value.contentType ?? fallbackSegmentMime(resolved.upstreamUrl));
    res.status(200);
    res.setHeader('Content-Type', contentType);
    applyMediaHeaders(res);
    this.markPlayingOnce(session);
    if (isHead) {
      read.value.stream.destroy();
      res.end();
      return;
    }
    this.pipeToResponse(res, read.value.stream, session.id);
  }

  /* ---------------------------------------------------------------- */
  /* 字幕资产(内嵌/旁车;loadSubtitleContent 逐请求授权 + 404 同形)        */
  /* ---------------------------------------------------------------- */

  private async deliverSubtitleAsset(
    res: Response,
    isHead: boolean,
    sessionId: string,
    generation: number,
    assetId: string,
    context: SessionContext,
  ): Promise<void> {
    const content = await this.subtitles.loadSubtitleContent(sessionId, generation, assetId, context);
    res.status(200);
    res.setHeader('Content-Type', content.contentType);
    res.setHeader('Content-Length', String(Buffer.byteLength(content.vtt, 'utf8')));
    applyMediaHeaders(res);
    if (isHead) {
      res.end();
      return;
    }
    res.end(content.vtt);
  }

  /* ---------------------------------------------------------------- */
  /* 流管道与失败收口                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * 流式管道:源错误已发字节 → 毁连不注入 JSON(契约:字节流内不得出现 problem JSON),
   * 并经 lifecycle.markFailure 落稳定 failure_code(轮询可见);客户端已断开/响应已收尾
   * 的迟到错误只取消读取,不入失败码。
   */
  private pipeToResponse(res: Response, stream: Readable, sessionId: string): void {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (res.writableEnded || res.destroyed) {
        stream.destroy();
        return;
      }
      const code = typeof error?.code === 'string' && isPlaybackStableErrorCode(error.code)
        ? (error.code as PlaybackErrorCode)
        : 'PLAYBACK_RESOURCE_UNAVAILABLE';
      void this.lifecycle.markFailure(sessionId, code).catch(() => undefined);
      res.destroy();
    });
    stream.pipe(res);
  }

  /**
   * 源故障(未发 headers):direct 网关已过授权面,源解析/打开失败属源故障 —— 统一
   * 503 PLAYBACK_RESOURCE_UNAVAILABLE(稳定码,不含源路径细节);sourceChanged 时按
   * 「源变化停止旧 session」语义经 lifecycle.markFailure 停止会话。
   */
  private throwSourceFailure(sessionId: string, failure: NasReadFailure): never {
    if (failure.sourceChanged === true) {
      void this.lifecycle.markFailure(sessionId, 'PLAYBACK_RESOURCE_UNAVAILABLE').catch(() => undefined);
    }
    if (failure.code === 'MEDIA_NOT_FOUND' || failure.code === 'PLAYBACK_RESOURCE_UNAVAILABLE') {
      throw createDomainError('PLAYBACK_RESOURCE_UNAVAILABLE');
    }
    if (failure.code === 'VALIDATION_FAILED') {
      // 400 Range 非法(注册表无该码,直构 DomainError 携带既有码)
      throw new DomainError(400, ProblemCode.VALIDATION_FAILED, failure.detail);
    }
    throw createDomainError(failure.code, failure.detail);
  }

  /** 首次交付 playing:ready → playing(started_at 一次);失败(CAS/终态)静默放行 */
  private markPlayingOnce(session: PlaybackSessionView): void {
    if (session.state !== 'ready') {
      return;
    }
    void this.resolver.markPlaying(session.id, { cas: { expectedVersion: session.version } });
  }

  /* ---------------------------------------------------------------- */
  /* 网关内存登记(换代清理;单进程内有效)                                 */
  /* ---------------------------------------------------------------- */

  /** 会话选定源只读投影(playback_source_id;对外 DTO 刻意不含,网关内部定位用) */
  private async sourceIdOf(sessionId: string): Promise<string | null> {
    const row = getDb()
      .select({ playbackSourceId: playbackSession.playbackSourceId })
      .from(playbackSession)
      .where(eq(playbackSession.id, sessionId))
      .get();
    return typeof row?.playbackSourceId === 'string' ? row.playbackSourceId : null;
  }

  /** 检测 generation 变化:清理旧代资产映射与本网关深度登记 */
  private releaseSupersededGeneration(householdId: string, sessionId: string, generation: number): void {
    const previous = this.generationBySession.get(sessionId);
    if (previous !== undefined && previous !== generation) {
      this.assets.releaseGeneration(householdId, sessionId, previous);
      const prefix = `${householdId}\u0000${sessionId}\u0000${previous}\u0000`;
      for (const key of [...this.depthByAsset.keys()]) {
        if (key.startsWith(prefix)) {
          this.depthByAsset.delete(key);
        }
      }
    }
    this.generationBySession.set(sessionId, generation);
  }

  private assetDepthKey(householdId: string, sessionId: string, generation: number, assetId: string): string {
    return `${householdId}\u0000${sessionId}\u0000${generation}\u0000${assetId}`;
  }

  private playlistDepthOf(householdId: string, sessionId: string, generation: number, assetId: string): number {
    return this.depthByAsset.get(this.assetDepthKey(householdId, sessionId, generation, assetId)) ?? 0;
  }

  private setPlaylistDepth(householdId: string, sessionId: string, generation: number, assetId: string, depth: number): void {
    this.depthByAsset.set(this.assetDepthKey(householdId, sessionId, generation, assetId), depth);
  }
}

/* ------------------------------------------------------------------ */
/* 模块级工具                                                            */
/* ------------------------------------------------------------------ */

/** 读取 Range 请求头(缺省/空值归一 null → 全量语义) */
function readRangeHeader(request: Request): string | null {
  const header = request.headers.range;
  return typeof header === 'string' && header !== '' ? header : null;
}
