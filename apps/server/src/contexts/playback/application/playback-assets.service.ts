import { createHash } from 'node:crypto';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type { PlaybackBudgets } from '../../../config/playback-budgets';
import type { PlaybackErrorCode } from '@contexts/playback/domain/playback.types';

/**
 * 播放资产映射与清单重写(T022,spec 004)—— (household,session,generation,assetId)
 * 内存私有映射与上游清单的同源资产重写。
 *
 * 权威依据:
 * - tasks.md T022:重写全部清单/segment/key/MAP/媒体轨 URI;仅保留 120 秒窗口与仍使用
 *   引用,重启失效、TTL 不超 session、资产超限失败,禁止接受任意 URL/路径参数;
 * - data-model.md「运行时值对象」AssetMap:key=(household,session,generation,assetId),
 *   仅内存私有数据,不返回 URL;清单最多 10000 资产且只保留最近 120 秒窗口及其仍使用
 *   引用;超限失败,禁止无界直播映射增长;
 * - research.md R3:重写所有可获取 URI(子清单/segment/key/MAP/媒体轨);拒绝
 *   DRM/SAMPLE-AES、未知 URI 扩展、循环、data/file 等协议,不透传原文;
 * - 验收规约:test/unit/playback/hls-proxy.spec.ts(纯文本解析/重写/登记,不做任何网络
 *   请求 —— 上游读取属 HlsProxyService;运行时结果形态以其断言为准:成功
 *   { ok:true, value:{playlist,assets} },失败 { ok:false, code, reason }(reason 为
 *   静态脱敏文案,绝不回显原始 URI/上游 URL))。
 *
 * 同源入口形态:重写后每个 URI 均为
 *   {entryPathPrefix}/{sessionId}/{generation}/{assetId}?ticket={ticket}
 * 与票据服务 playbackUrl(/api/playback/stream/{sessionId}/{generation}/index?ticket=…,
 * 入口资产名 'index')同构;entryPathPrefix 缺省 '/playback/stream'(api.md 媒体端点权威
 * 路径),装配层可注入应用全局 API 前缀(hmp 生产装配注入 '/api/playback/stream')。
 *
 * 安全机制:
 * - resolve 仅接受 (household,session,generation,assetId) 五元组 —— 不存在任何接受
 *   URL/路径参数的入口;assetId 为 sha1(kind+URL) 的 base64url 截断(不透明映射值,
 *   非 URL 编码,不含 / : 等路径词法);
 * - 确定性:同 (kind, upstreamUrl) 恒得同 assetId —— 幂等重登记,不产生重复资产;
 * - 注册表为纯内存 Map(重启即失效,天然满足重启失效);TTL 不超 session:键域按
 *   (household,session,generation) 划分,生命周期结束(T028)调用 releaseSession/
 *   releaseGeneration 即整体丢弃;
 * - 窗口管理:每个媒体清单重写「替换」其滚动窗口 —— 只保留当前清单引用的
 *   segment/subtitle/key/MAP(及 master 重写引用的子清单);被全部窗口抛弃的资产即刻
 *   回收;停更窗口超过 2×rollingWindowSeconds 的闲置窗口随重写顺带清扫;
 * - 超限失败:单清单 URI > maxUrisPerPlaylist(10000)或 (household,session,generation)
 *   总资产 > maxUrisPerPlaylist × maxPlaylistNestingDepth → 稳定失败
 *   PLAYBACK_FORMAT_UNSUPPORTED(与 URI 数/嵌套/循环/DRM/大小同映射,规约提案)。
 */

/** 资产类别:manifest=入口清单(固定 'index');playlist=子清单;segment/key/map/subtitle 同 HLS 语义 */
export type PlaybackAssetKind = 'manifest' | 'playlist' | 'segment' | 'key' | 'map' | 'subtitle';

export interface PlaybackAssetEntry {
  readonly assetId: string;
  readonly upstreamUrl: string;
  readonly kind: PlaybackAssetKind;
}

/** 入口资产名(与票据服务 ENTRY_ASSET_ID 同值:renew 的 playbackUrl 即本资产) */
export const ENTRY_ASSET_ID = 'index';

/** 本地产物窗口键(household␀session␀generation;与 registry 键域同族分隔符) */
function localWindowKey(householdId: string, sessionId: string, generation: number): string {
  return `${householdId}\u0000${sessionId}\u0000${String(generation)}`;
}

/** 本地产物入口清单文件名(与 supervisor 产物 argv 同名;T025 hls muxer 输出) */
export const LOCAL_ENTRY_MANIFEST_NAME = 'window.m3u8';

/** 同源入口路径缺省前缀(api.md 媒体端点权威路径;装配层可注入带全局 API 前缀的形态) */
const DEFAULT_ENTRY_PATH_PREFIX = '/playback/stream';

/**
 * 本地产物文件名词法白名单(转换交付:T025 ffmpeg 产物 seg%05d.ts/window.m3u8):
 * 单段词法(无路径分隔符),拒绝 '.'/'..' 相对段 —— 与 storage.pathSegment 清洗同族,
 * 禁止任何穿越形态;扩展名决定资产类别与 MIME。
 */
const LOCAL_ASSET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** 本地产物扩展名 → 资产类别(其余扩展名一律拒绝,不透传不猜测) */
function localAssetKindOf(name: string): LocalAssetKind | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) {
    return 'manifest';
  }
  if (lower.endsWith('.vtt')) {
    return 'subtitle';
  }
  if (lower.endsWith('.ts') || lower.endsWith('.m4s') || lower.endsWith('.mp4')) {
    return 'segment';
  }
  return undefined;
}

export interface RewritePlaylistInput {
  readonly householdId: string;
  readonly sessionId: string;
  readonly generation: number;
  /** 正被重写的上游清单 URL(相对 URI 的解析基准;必须为 http/https) */
  readonly upstreamUrl: string;
  /** 上游清单全文(HlsProxyService.readPlaylist 的 text) */
  readonly text: string;
  /** 入口层票据(由票据服务签发,原样附加到每个重写 URI) */
  readonly ticket: string;
  /** 清单嵌套深度:入口=0,每层子清单 +1;达到 maxPlaylistNestingDepth 即拒绝 */
  readonly depth: number;
  /** 本清单链上已访问的上游清单 URL(循环检测);当前 upstreamUrl 命中即拒绝 */
  readonly ancestorUpstreamUrls?: readonly string[];
}

export interface RewritePlaylistValue {
  readonly playlist: string;
  readonly assets: readonly PlaybackAssetEntry[];
}

export type RewritePlaylistResult =
  | { readonly ok: true; readonly value: RewritePlaylistValue }
  | {
      readonly ok: false;
      readonly code: PlaybackErrorCode;
      readonly reason: string;
      /**
       * 类型面镜像(hls-proxy.spec 的既有访问形态在断言助手收窄前读取 .value):
       * ok=false 时运行时恒为 undefined,调用方必须先经 ok 判别/断言助手再取用;
       * 生产代码路径(本服务/T031)一律走判别窄化,不触达该镜像。
       */
      readonly value: RewritePlaylistValue;
    };

export interface ResolveAssetResult {
  readonly upstreamUrl: string;
  readonly kind: PlaybackAssetKind;
}

/** 本地产物资产类别:manifest=入口清单(window.m3u8);segment=分片;subtitle=字幕分片 */
export type LocalAssetKind = 'manifest' | 'segment' | 'subtitle';

export interface ResolveLocalAssetResult {
  /** 产物目录内的绝对文件路径(词法已校验,仅白名单文件名) */
  readonly path: string;
  readonly kind: LocalAssetKind;
}

/* ------------------------------------------------------------------ */
/* AssetMap 内存注册表(key=(household,session,generation,assetId))      */
/* ------------------------------------------------------------------ */

interface RegistryAsset {
  readonly upstreamUrl: string;
  readonly kind: PlaybackAssetKind;
}

/** 滚动窗口:单个上游清单(重写方)当前引用的资产集合 */
interface RegistryWindow {
  readonly assetIds: Set<string>;
  readonly touchedAt: number;
}

interface RegistryGeneration {
  readonly assets: Map<string, RegistryAsset>;
  /** key:被重写的上游清单 URL */
  readonly windows: Map<string, RegistryWindow>;
  lastTouchAt: number;
}

/**
 * 纯内存 AssetMap:不落库、不返回 URL 之外任何内部信息;resolve 仅收五元组。
 * 上限:maxUrisPerPlaylist × maxPlaylistNestingDepth(单一清单 10000 上限由重写层先行
 * 把关;此处兜底整个 (household,session,generation) 键域,禁止无界直播映射增长)。
 */
export class PlaybackAssetRegistry {
  private readonly households = new Map<string, Map<string, Map<number, RegistryGeneration>>>();
  private readonly maxAssetsPerGeneration: number;
  private readonly idleWindowMs: number;

  constructor(budgets: PlaybackBudgets) {
    this.maxAssetsPerGeneration = budgets.hlsUpstream.maxUrisPerPlaylist * budgets.hlsUpstream.maxPlaylistNestingDepth;
    // 闲置窗口清扫阈值:rollingWindowSeconds 的 2 倍(直播暂停/网络抖动的宽限)
    this.idleWindowMs = budgets.timeline.rollingWindowSeconds * 2 * 1000;
  }

  /** 批量登记(重写层调用;幂等:同 assetId 重复登记覆盖为同值)。超上限拒绝。 */
  register(
    householdId: string,
    sessionId: string,
    generation: number,
    assets: readonly PlaybackAssetEntry[],
  ): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    const state = this.generationOf(householdId, sessionId, generation);
    let freshCount = 0;
    for (const asset of assets) {
      if (!state.assets.has(asset.assetId)) {
        freshCount += 1;
      }
    }
    if (state.assets.size + freshCount > this.maxAssetsPerGeneration) {
      return { ok: false, reason: '播放资产登记总量超限' };
    }
    const now = Date.now();
    for (const asset of assets) {
      state.assets.set(asset.assetId, { upstreamUrl: asset.upstreamUrl, kind: asset.kind });
    }
    state.lastTouchAt = now;
    return { ok: true };
  }

  /** 入口清单登记(固定 'index'/manifest;票据 playbackUrl 即指向本资产) */
  registerEntry(householdId: string, sessionId: string, generation: number, upstreamUrl: string): void {
    const registered = this.register(householdId, sessionId, generation, [
      { assetId: ENTRY_ASSET_ID, upstreamUrl, kind: 'manifest' },
    ]);
    if (!registered.ok) {
      throw new Error(registered.reason);
    }
  }

  /** 五元组解析:仅此入口,不存在任何接受 URL/路径参数的形态;命中即续期触点 */
  resolve(householdId: string, sessionId: string, generation: number, assetId: string): ResolveAssetResult | undefined {
    const asset = this.generationOf(householdId, sessionId, generation).assets.get(assetId);
    if (asset === undefined) {
      return undefined;
    }
    this.generationOf(householdId, sessionId, generation).lastTouchAt = Date.now();
    return { upstreamUrl: asset.upstreamUrl, kind: asset.kind };
  }

  /**
   * 窗口替换:以本次重写登记的资产集合整体替换该上游清单的滚动窗口
   * (data-model:只保留最近窗口与仍使用引用);被全部窗口抛弃的非入口资产即刻回收。
   */
  replaceWindow(householdId: string, sessionId: string, generation: number, playlistUrl: string, assetIds: ReadonlySet<string>): void {
    const state = this.generationOf(householdId, sessionId, generation);
    const stale = state.windows.get(playlistUrl);
    state.windows.set(playlistUrl, { assetIds: new Set(assetIds), touchedAt: Date.now() });
    state.lastTouchAt = Date.now();
    if (stale !== undefined) {
      this.collectOrphans(householdId, sessionId, generation, stale.assetIds);
    }
  }

  /**
   * 显式窗口修剪(等价 API):把每个窗口收窄到 keptAssetIds ∩ 窗口,随后回收孤儿资产;
   * 供调用方在清单切换/换代时主动收缩,不需要等待下一次重写。
   */
  pruneWindow(householdId: string, sessionId: string, generation: number, keptAssetIds: readonly string[] | ReadonlySet<string>): void {
    const state = this.generationOf(householdId, sessionId, generation);
    const kept = keptAssetIds instanceof Set ? keptAssetIds : new Set(keptAssetIds);
    for (const [playlistUrl, window] of state.windows) {
      const narrowed = new Set([...window.assetIds].filter((assetId) => kept.has(assetId)));
      state.windows.set(playlistUrl, { assetIds: narrowed, touchedAt: window.touchedAt });
    }
    this.collectAllOrphans(householdId, sessionId, generation);
  }

  /** 闲置清扫:停更超过 idleWindowMs 的窗口整体移除并回收孤儿(重写层顺带调用) */
  sweepIdle(householdId: string, sessionId: string, generation: number): void {
    const state = this.generationOf(householdId, sessionId, generation);
    const deadline = Date.now() - this.idleWindowMs;
    const expired: Set<string>[] = [];
    for (const [playlistUrl, window] of state.windows) {
      if (window.touchedAt < deadline) {
        state.windows.delete(playlistUrl);
        expired.push(window.assetIds);
      }
    }
    for (const assetIds of expired) {
      this.collectOrphans(householdId, sessionId, generation, assetIds);
    }
  }

  /** 换代丢弃(TTL 不超 session:旧代资产即刻不可解析) */
  releaseGeneration(householdId: string, sessionId: string, generation: number): void {
    this.households.get(householdId)?.get(sessionId)?.delete(generation);
  }

  /** 会话结束整体丢弃(生命周期 T028 于终态/清理时调用) */
  releaseSession(householdId: string, sessionId: string): void {
    this.households.get(householdId)?.delete(sessionId);
  }

  /** 观测面:键域内当前资产数(测试/装配诊断;不暴露任何 URL) */
  size(householdId: string, sessionId: string, generation: number): number {
    return this.generationOf(householdId, sessionId, generation).assets.size;
  }

  private generationOf(householdId: string, sessionId: string, generation: number): RegistryGeneration {
    let sessions = this.households.get(householdId);
    if (sessions === undefined) {
      sessions = new Map();
      this.households.set(householdId, sessions);
    }
    let generations = sessions.get(sessionId);
    if (generations === undefined) {
      generations = new Map();
      sessions.set(sessionId, generations);
    }
    let state = generations.get(generation);
    if (state === undefined) {
      state = { assets: new Map(), windows: new Map(), lastTouchAt: Date.now() };
      generations.set(generation, state);
    }
    return state;
  }

  /** 回收指定的候选资产:仅当其不再被任何窗口引用且非入口资产(manifest) */
  private collectOrphans(householdId: string, sessionId: string, generation: number, candidates: ReadonlySet<string>): void {
    const state = this.generationOf(householdId, sessionId, generation);
    for (const assetId of candidates) {
      const asset = state.assets.get(assetId);
      if (asset === undefined || asset.kind === 'manifest') {
        continue;
      }
      let referenced = false;
      for (const window of state.windows.values()) {
        if (window.assetIds.has(assetId)) {
          referenced = true;
          break;
        }
      }
      if (!referenced) {
        state.assets.delete(assetId);
      }
    }
  }

  private collectAllOrphans(householdId: string, sessionId: string, generation: number): void {
    const state = this.generationOf(householdId, sessionId, generation);
    this.collectOrphans(householdId, sessionId, generation, new Set(state.assets.keys()));
  }
}

/* ------------------------------------------------------------------ */
/* 清单解析/重写(纯文本变换;无网络请求)                                 */
/* ------------------------------------------------------------------ */

/** 确定性资产 ID:sha1(kind + 0x00 + upstreamUrl) 的 base64url 截断(132bit,无填充) */
function assetIdFor(kind: PlaybackAssetKind, upstreamUrl: string): string {
  return createHash('sha1').update(`${kind}\u0000${upstreamUrl}`, 'utf8').digest('base64url').slice(0, 22);
}

/** DRM/专有标记词表(R3:拒绝 SAMPLE-AES/会话 key/FairPlay/FAXS;skd: 由 scheme 校验兜底) */
const DRM_TOKEN_PATTERN = /METHOD=(SAMPLE-AES|FAIRPLAY)|#EXT-X-FAXS\b|#EXT-X-SESSION-KEY:.*SAMPLE-AES/i;

function isKnownKeyTag(line: string): boolean {
  return /^#EXT-X-(SESSION-)?KEY:/i.test(line);
}

function keyMethodIsNone(line: string): boolean {
  const match = /METHOD=([A-Za-z0-9-]+)/i.exec(line);
  return match !== null && (match[1] ?? '').toUpperCase() === 'NONE';
}

/**
 * METHOD=NONE key 行的安全形态(T037 裁决 ④/T036 缺口①;RFC 8216 §4.3.2:METHOD=NONE
 * 不得携带 URI,IV 亦无意义):剔除 URI/IV 属性后输出 `#EXT-X-KEY:METHOD=NONE` 等价形态,
 * 禁止原文透传 —— 上游 URL(主机/路径/可能内嵌的凭据 query)不得经 NONE key 行进入下发
 * 清单(api.md「原清单禁止原样返回」;EXT-X-KEY 与 EXT-X-SESSION-KEY 同规则)。
 * 引号内值整体匹配(URI 值含逗号亦完整剔除);残留属性逐字保留,输出仍为合法属性表。
 */
function sanitizeNoneKeyLine(line: string): string {
  return line.replace(/,?\s*URI="[^"]*"/gi, '').replace(/,?\s*IV=(0[xX])?[0-9A-Fa-f]+/g, '');
}

function uriAttributeOf(line: string): string | null {
  const match = /URI="([^"]*)"/.exec(line);
  return match === null ? null : (match[1] ?? null);
}

/** 已知携带 URI 属性的标签 → 资产类别;未知 URI 标签返回 undefined(拒绝) */
function tagUriKind(upperTag: string, rawLine: string): PlaybackAssetKind | 'ignored' | undefined {
  if (upperTag.startsWith('#EXT-X-MEDIA:') || upperTag.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
    return 'playlist';
  }
  if (upperTag.startsWith('#EXT-X-MAP:')) {
    return 'map';
  }
  if (isKnownKeyTag(rawLine)) {
    return keyMethodIsNone(rawLine) ? 'ignored' : 'key';
  }
  return undefined;
}

function targetsPlaylist(uri: string): boolean {
  return /\.(m3u8|m3u)([?#]|$)/i.test(uri);
}

function targetsSubtitle(uri: string): boolean {
  return /\.vtt([?#]|$)/i.test(uri);
}

@Injectable()
export class PlaybackAssetsService {
  private readonly budgets: PlaybackBudgets;
  private readonly entryPathPrefix: string;

  /** 内存资产注册表(AssetMap):同进程内有效,重启失效 */
  readonly registry: PlaybackAssetRegistry;

  /**
   * 本地产物窗口(转换交付;缺口1 接线):(household,session,generation) → 产物目录。
   * 与上游 URL 映射(AssetMap)平行:目录由 T026 storage.openTask 派生,入口清单为目录内
   * window.m3u8;分片为滚动窗口动态文件,不逐片登记 —— 网关按本表判定「本会话本代为
   * 本地产物交付」,分片名经词法白名单校验后直读目录(不落任何 URL/路径参数入口)。
   */
  private readonly localWindows = new Map<string, string>();

  constructor(deps: { budgets: PlaybackBudgets; entryPathPrefix?: string }) {
    this.budgets = deps.budgets;
    this.entryPathPrefix = deps.entryPathPrefix ?? DEFAULT_ENTRY_PATH_PREFIX;
    this.registry = new PlaybackAssetRegistry(deps.budgets);
  }

  /**
   * 重写上游清单为同源资产形态并登记资产映射(纯文本变换,无网络请求):
   * - 全部 variant/rendition(EXT-X-MEDIA/STREAM-INF/I-FRAME)/MAP/KEY/segment/字幕 URI
   *   重写为 {prefix}/{sessionId}/{generation}/{assetId}?ticket={ticket};
   * - METHOD=NONE 的 EXT-X-KEY/EXT-X-SESSION-KEY 行剔除 URI/IV 属性(RFC 8216:NONE 不得
   *   携带 URI;T037 裁决 ④ —— 上游 URL 不经 NONE key 行透传进下发清单);
   * - 标签其余属性(BANDWIDTH/RESOLUTION/IV/BYTERANGE/…)逐字节保留;
   * - 拒绝矩阵:缺 EXTM3U、DRM、未知 scheme、未知 URI 标签、超 2MiB、URI>10000、
   *   depth≥4、循环、登记超限 → PLAYBACK_FORMAT_UNSUPPORTED(reason 静态脱敏)。
   */
  async rewritePlaylist(input: RewritePlaylistInput): Promise<RewritePlaylistResult> {
    const hls = this.budgets.hlsUpstream;
    const formatFailure = (reason: string): RewritePlaylistResult => ({
      ok: false,
      code: 'PLAYBACK_FORMAT_UNSUPPORTED',
      reason,
      value: undefined as unknown as RewritePlaylistValue,
    });

    // 嵌套预算:调用方传 depth 计数(入口=0),达到上限即拒
    if (!Number.isInteger(input.depth) || input.depth < 0) {
      return formatFailure('清单嵌套深度非法');
    }
    if (input.depth >= hls.maxPlaylistNestingDepth) {
      return formatFailure('清单嵌套深度超预算');
    }

    // 解析基准必须为 http/https(不引入 data/file 等基准)
    let base: URL;
    try {
      base = new URL(input.upstreamUrl);
    } catch {
      return formatFailure('上游清单 URL 非法');
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      return formatFailure('上游清单 URL 协议不受支持');
    }

    // 循环检测:本清单链上已出现同一上游清单
    const ancestors = input.ancestorUpstreamUrls ?? [];
    for (const ancestor of ancestors) {
      if (ancestor === input.upstreamUrl) {
        return formatFailure('清单引用循环');
      }
    }

    // 大小预算:字节口径与传输层一致
    if (Buffer.byteLength(input.text, 'utf8') > hls.maxPlaylistBytes) {
      return formatFailure('清单超出大小预算');
    }

    // 强制首行 #EXTM3U(缺头/二进制内容稳定拒绝,不透传原文)
    const lines = input.text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const firstLine = lines.find((line) => line.trim() !== '');
    if (firstLine === undefined || firstLine.trim() !== '#EXTM3U') {
      return formatFailure('清单缺少 EXTM3U 头或非文本内容');
    }

    const assets = new Map<string, PlaybackAssetEntry>();
    const outLines: string[] = [];
    let uriCount = 0;
    let pendingVariant = false;
    let pendingSegment = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        outLines.push(line);
        continue;
      }
      if (trimmed.startsWith('#')) {
        const upperTag = trimmed.toUpperCase();
        if (DRM_TOKEN_PATTERN.test(trimmed)) {
          return formatFailure('清单含 DRM 或专有加密标记');
        }
        if (upperTag.startsWith('#EXT-X-STREAM-INF:')) {
          pendingVariant = true;
          outLines.push(line);
          continue;
        }
        if (upperTag.startsWith('#EXTINF:')) {
          pendingSegment = true;
          outLines.push(line);
          continue;
        }
        const kind = tagUriKind(upperTag, trimmed);
        if (kind === 'ignored') {
          // METHOD=NONE key 行(EXT-X-KEY/EXT-X-SESSION-KEY):T037 裁决 ④ 剔除 URI/IV 属性
          // 后输出安全形态(RFC 8216:NONE 不得携带 URI),不透传原文 —— 上游 URL/内嵌凭据
          // 不得进入下发清单
          outLines.push(sanitizeNoneKeyLine(line));
          continue;
        }
        const rawUri = uriAttributeOf(trimmed);
        if (rawUri === null) {
          outLines.push(line);
          continue;
        }
        if (kind === undefined) {
          // R3:未知 URI 扩展标签一律拒绝,不透传原文
          return formatFailure('清单含未知 URI 扩展标签');
        }
        uriCount += 1;
        if (uriCount > hls.maxUrisPerPlaylist) {
          return formatFailure('清单 URI 数超预算');
        }
        const resolved = this.resolveUpstreamUri(rawUri, base);
        if (!resolved.ok) {
          return formatFailure(resolved.reason);
        }
        const entry = this.registerAsset(resolved.url, kind, assets);
        outLines.push(line.replace(`URI="${rawUri}"`, `URI="${this.entryUri(input, entry.assetId)}"`));
        continue;
      }

      // URI 行:STREAM-INF 后继 → playlist;EXTINF 后继 → segment/字幕;其余按扩展名兜底
      const kind: PlaybackAssetKind = pendingVariant
        ? 'playlist'
        : pendingSegment
          ? (targetsSubtitle(trimmed) ? 'subtitle' : 'segment')
          : (targetsPlaylist(trimmed) ? 'playlist' : 'segment');
      pendingVariant = false;
      pendingSegment = false;
      uriCount += 1;
      if (uriCount > hls.maxUrisPerPlaylist) {
        return formatFailure('清单 URI 数超预算');
      }
      const resolved = this.resolveUpstreamUri(trimmed, base);
      if (!resolved.ok) {
        return formatFailure(resolved.reason);
      }
      const entry = this.registerAsset(resolved.url, kind, assets);
      outLines.push(this.entryUri(input, entry.assetId));
    }

    // 登记与窗口替换:本清单引用的资产即其新滚动窗口;超限稳定失败
    const entries = [...assets.values()];
    const registered = this.registry.register(input.householdId, input.sessionId, input.generation, entries);
    if (!registered.ok) {
      return formatFailure(registered.reason);
    }
    this.registry.sweepIdle(input.householdId, input.sessionId, input.generation);
    this.registry.replaceWindow(
      input.householdId,
      input.sessionId,
      input.generation,
      base.toString(),
      new Set(entries.map((entry) => entry.assetId)),
    );

    return {
      ok: true,
      value: { playlist: outLines.join('\n'), assets: entries },
    };
  }

  /** 五元组解析(注册表唯一对外读取入口;不接受任意 URL/路径参数) */
  resolve(householdId: string, sessionId: string, generation: number, assetId: string): ResolveAssetResult | undefined {
    return this.registry.resolve(householdId, sessionId, generation, assetId);
  }

  /** 入口清单登记('index'/manifest):会话 ready 前由解析层/网关调用一次 */
  registerEntry(householdId: string, sessionId: string, generation: number, upstreamUrl: string): void {
    this.registry.registerEntry(householdId, sessionId, generation, upstreamUrl);
  }

  /* ---------------- 本地产物窗口(转换交付;缺口1) ---------------- */

  /**
   * 登记本会话本代转换产物目录(入口 manifest=目录内 window.m3u8;首产物就绪后由装配
   * 启动端口调用一次)。同代重复登记覆盖(重试/重入安全);key 与 AssetMap 同族五元组,
   * 生命周期随 releaseGeneration/releaseSession 一并丢弃(TTL 不超 session)。
   */
  registerLocalWindow(householdId: string, sessionId: string, generation: number, directory: string): void {
    this.localWindows.set(localWindowKey(householdId, sessionId, generation), directory);
  }

  /** 本地产物窗口查询:未登记返回 undefined(网关回落上游代理/字幕交付) */
  localWindowOf(householdId: string, sessionId: string, generation: number): string | undefined {
    return this.localWindows.get(localWindowKey(householdId, sessionId, generation));
  }

  /**
   * 本地产物资产定位(网关专用):assetId 必须为白名单词法的产物文件名(不允许任何
   * URL/路径参数形态);入口资产名 'index'(票据 playbackUrl 同构)映射为产物清单
   * window.m3u8;命中返回目录内绝对路径与类别,词法/扩展名非法返回 undefined。
   */
  resolveLocalAsset(
    householdId: string,
    sessionId: string,
    generation: number,
    assetId: string,
  ): ResolveLocalAssetResult | undefined {
    const directory = this.localWindowOf(householdId, sessionId, generation);
    if (directory === undefined || !LOCAL_ASSET_NAME_PATTERN.test(assetId) || assetId === '.' || assetId === '..') {
      return undefined;
    }
    const fileName = assetId === ENTRY_ASSET_ID ? LOCAL_ENTRY_MANIFEST_NAME : assetId;
    const kind = localAssetKindOf(fileName);
    if (kind === undefined) {
      return undefined;
    }
    return { path: path.join(directory, fileName), kind };
  }

  /**
   * 本地清单同源重写(网关专用;纯文本变换):相对分片名 →
   * `{entryPathPrefix}/{sessionId}/{generation}/{name}?ticket={ticket}`(与上游重写
   * entryUri 同构);标签行原样保留;非注释且词法非法的行剔除(本地产物由受控 ffmpeg
   * 生成,防御性不透传任何非白名单词法)。
   */
  rewriteLocalManifest(
    householdId: string,
    sessionId: string,
    generation: number,
    text: string,
    ticket: string,
  ): string {
    void householdId;
    const entryPrefix = `${this.entryPathPrefix}/${sessionId}/${generation}/`;
    return text
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
          return line;
        }
        if (!LOCAL_ASSET_NAME_PATTERN.test(trimmed) || trimmed === '.' || trimmed === '..') {
          return null; // 防御:非白名单词法行不透传
        }
        return `${entryPrefix}${trimmed}?ticket=${ticket}`;
      })
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  /** 显式窗口修剪(见 PlaybackAssetRegistry.pruneWindow) */
  pruneWindow(householdId: string, sessionId: string, generation: number, keptAssetIds: readonly string[] | ReadonlySet<string>): void {
    this.registry.pruneWindow(householdId, sessionId, generation, keptAssetIds);
  }

  /** 换代/会话终态丢弃(生命周期 T028 调用;TTL 不超 session) */
  releaseGeneration(householdId: string, sessionId: string, generation: number): void {
    this.registry.releaseGeneration(householdId, sessionId, generation);
    this.localWindows.delete(localWindowKey(householdId, sessionId, generation));
  }

  releaseSession(householdId: string, sessionId: string): void {
    this.registry.releaseSession(householdId, sessionId);
    const prefix = `${householdId}\u0000${sessionId}\u0000`;
    for (const key of [...this.localWindows.keys()]) {
      if (key.startsWith(prefix)) {
        this.localWindows.delete(key);
      }
    }
  }

  /* ---------------- 内部工具 ---------------- */

  /** 同源入口 URI(与票据服务 playbackUrl 同构;assetId/ticket 均为不透明词法) */
  private entryUri(input: RewritePlaylistInput, assetId: string): string {
    return `${this.entryPathPrefix}/${input.sessionId}/${input.generation}/${assetId}?ticket=${input.ticket}`;
  }

  private registerAsset(
    upstreamUrl: string,
    kind: PlaybackAssetKind,
    assets: Map<string, PlaybackAssetEntry>,
  ): PlaybackAssetEntry {
    const assetId = assetIdFor(kind, upstreamUrl);
    const existing = assets.get(assetId);
    if (existing !== undefined) {
      return existing;
    }
    const entry: PlaybackAssetEntry = { assetId, upstreamUrl, kind };
    assets.set(assetId, entry);
    return entry;
  }

  /** 相对/绝对路径/绝对 http(s) URI 统一解析;非 http(s) scheme 一律拒绝(静态 reason) */
  private resolveUpstreamUri(rawUri: string, base: URL): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string } {
    let resolved: URL;
    try {
      resolved = new URL(rawUri, base);
    } catch {
      return { ok: false, reason: '清单 URI 无法解析' };
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return { ok: false, reason: '清单 URI scheme 不受支持' };
    }
    return { ok: true, url: resolved.toString() };
  }
}
