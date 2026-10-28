import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createDomainError, DomainError } from '../../../common/domain-error';
import { ProblemCode } from '@hmp/shared';
import type { PlaybackBudgets } from '../../../config/playback-budgets';
import type { MediaRoots } from '../../../config/env.schema';
import type { SessionContext } from '../../../common/current-session.decorator';
import type { PlaybackAuthorizationService } from '@contexts/playback/application/playback-authorization.service';
import { resolveNasMediaLocation } from '@contexts/playback/infrastructure/media-probe.service';
import type { NasReaderService } from '@contexts/playback/infrastructure/nas-reader';
import type { PlaybackProbeFacts } from '@contexts/playback/application/playback-resolver.service';
import type { PlaybackTrackFactsPort } from '@contexts/playback/application/playback-selection.service';

/**
 * 播放字幕服务(T030,spec 004)—— 内嵌/旁车字幕的目录、安全读取与 SRT→VTT 文本交付。
 *
 * 权威依据(先读后写):
 * - tasks.md T030:内嵌 SubRip/WebVTT 与同 stem .srt/.vtt 旁车 ≤5MiB、只读根内无符号链接、
 *   SRT→VTT 文本安全显示;默认音轨/字幕关闭,允许合法音轨选择,无 ASS/图片/烧录,
 *   字幕逐请求授权;
 * - research.md R6:内嵌 SRT/SubRip/WebVTT 及影片同 stem 的 .srt/.vtt 旁车,只读且 ≤5MiB;
 *   最多 32 条音轨/字幕轨;SRT 转换 WebVTT,文本仅作为字幕显示,禁 HTML 脚本;默认音轨,
 *   字幕默认关闭;无 ASS 特效/图片字幕/烧录;
 * - budgets.subtitles(T010,research R6 数值唯一入口):maxSidecarBytes=5MiB、maxTrackCount=32;
 * - contracts/api.md:字幕 MIME text/vtt,只含文字,播放器不以 HTML 执行;媒体端点每次
 *   SessionGuard→凭据→授权→generation/asset 归属校验,asset 枚举不存在统一 404 同形;
 * - data-model.md「验证与恢复」:音轨/字幕必须属于同一输入;旁车沿用 NAS 只读边界
 *   (root 授权/路径形态/逐段符号链接拒绝/realpath 不越根,research R3)。
 *
 * 安全机制:
 * - 旁车定位 = 会话选定源 location(rootKey/relativePath)经 resolveNasMediaLocation
 *   (nas-reader.resolveSource 同语义:rootKey 授权 + findNasTargetDenial 路径形态 +
 *   逐段 lstat 拒符号链接 + 末段普通文件 + 逐段 realpath 不越授权根)解析媒体绝对路径,
 *   同目录仅收 `同 stem(大小写不敏感) + .srt/.vtt` 两个扩展名候选 —— 不存在任何
 *   接受客户端路径/文件名参数的入口;每个候选再经 NasReaderService.statSource 全量
 *   重验(符号链接/越根/缺失一律剔除,与不存在同形)并核对 size ≤ 5MiB;
 * - 内容读取经 NasReaderService.openRange(只读描述符 + 位置化流),流式累计硬上限
 *   maxSidecarBytes(stat 与读取窗口之间的竞态不放大内存面),超限按 404 同形拒绝;
 * - 内容安全(注释策略,保守转义而非丢弃):逐行剥离 C0 控制字符(保留 \t)后转义
 *   & < > —— 播放器将字幕作为纯文本渲染,任何 HTML/脚本标记都以字面量显示,不存在
 *   可执行面;识别为 ASS/SSA 家族([Script Info]/[V4+ Styles]/Dialogue:)或含 NUL 的
 *   内容直接拒绝(PLAYBACK_FORMAT_UNSUPPORTED)——「识别即拒绝」,不做部分转换;
 * - 逐请求授权:loadSubtitleContent 每次经 authorization.authorizeControl 完整重链
 *   (会话归属→绑定档案=当前档案→最新策略→家庭资源),授权拒绝以其稳定码抛出,
 *   字幕内容不返回(api.md:逐请求授权拒绝后不再交付新响应);
 * - 默认关闭:所有字幕轨 default 恒 false(不自动开启,R6/FR-017;default:true 语义
 *   仅属于音轨,由 probe 事实承载)。
 */

/* ------------------------------------------------------------------ */
/* 纯文本工具(SRT→VTT 与逐行安全化;导出供单测/复用)                        */
/* ------------------------------------------------------------------ */

/** 需剥离的控制字符:C0(除 \t 水平制表)与 DEL;\\n 由行切分承载,不在单行内出现 */
// eslint-disable-next-line no-control-regex -- 控制字符剥离正是本正则的唯一目的(字符类显式枚举,排除 \t)
const SUBTITLE_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 单行字幕文本安全化(策略:保守转义,不丢弃内容):
 * 1. 剥离控制字符(保留 \t)—— 排除不可见注入/解析干扰;
 * 2. 转义 & < > —— 播放器(WebVTT 渲染层)将实体后文本按纯文本显示,
 *    `<script>` 等标记永不构成可执行标签(contracts:字幕只含文字,播放器不以 HTML 执行)。
 */
export function escapeSubtitleTextLine(line: string): string {
  return line
    .replace(SUBTITLE_CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** SubRip 时间行:HH:MM:SS[,或.]毫秒(1~3 位) --> 同形;(小数点后)定位设置原样保留 */
const SRT_TIMING_LINE = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*(.*)$/;

/** 毫秒归一:1~3 位 → 恰 3 位(',5'→'500','25'→'250') */
function normalizeMillis(raw: string | undefined): string {
  return (raw ?? '0').padEnd(3, '0');
}

/** 单条 SRT 时间行 → WebVTT 时间行(逗号 → 点;序号/文本行不适用) */
function convertTimingLine(line: string): string {
  const match = SRT_TIMING_LINE.exec(line);
  if (match === null) {
    return line;
  }
  const trailing = match[9] !== undefined && match[9] !== '' ? ` ${match[9]}` : '';
  return `${match[1]}:${match[2]}:${match[3]}.${normalizeMillis(match[4])} --> ${match[5]}:${match[6]}:${match[7]}.${normalizeMillis(match[8])}${trailing}`;
}

/**
 * SubRip → WebVTT(纯文本格式转换,不做内容安全化 —— 安全化由调用方逐行统一执行):
 * - CRLF/CR 归一为 LF,剥离 BOM;
 * - 以空行分块;块内首个时间行之前的行(序号行)整体丢弃(R6:序号非 WebVTT 语义);
 * - 无时间行的块(空块/尾随空白)跳过;时间行 `,` → `.`(毫秒补齐 3 位);
 * - 输出 'WEBVTT' 头 + 空行分块 cue,结尾单换行。
 */
export function subRipToWebVtt(subRipText: string): string {
  const normalized = subRipText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const cues: string[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => SRT_TIMING_LINE.test(line));
    if (timingIndex === -1) {
      continue;
    }
    const cueLines = lines.slice(timingIndex).map((line, index) => (index === 0 ? convertTimingLine(line) : line));
    cues.push(cueLines.join('\n'));
  }
  return ['WEBVTT', '', ...cues].join('\n\n') + '\n';
}

/** ASS/SSA 家族识别:节头([Script Info]/[V4+ Styles] 等)与 Dialogue: 行 */
const ASS_SECTION_LINE = /^\s*\[(?:script info|v4\+? styles|v4\+\+ styles)\]\s*$/i;
const ASS_DIALOGUE_LINE = /^\s*dialogue\s*:/i;

/**
 * 内容闸(识别即拒绝,不做部分转换):
 * - 含 NUL → 非纯文本(二进制/图片字幕载荷不入文本通道);
 * - ASS/SSA 家族标记 → 特效字幕不在本期(R6:无 ASS 特效,识别即拒绝)。
 */
function assertPlainSubtitleText(text: string): void {
  if (text.includes('\u0000')) {
    throw new DomainError(422, ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED, '字幕内容不是纯文本');
  }
  for (const line of text.split(/\r?\n/)) {
    if (ASS_SECTION_LINE.test(line) || ASS_DIALOGUE_LINE.test(line)) {
      throw new DomainError(422, ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED, 'ASS/特效字幕不受支持');
    }
  }
}

/** WebVTT 时间行(转换产物或合法旁车):[HH:]MM:SS.mmm --> ;此类行不做转义(无标记字符面) */
const VTT_TIMING_LINE = /^(?:\d{2,}:)?\d{2}:\d{2}\.\d{1,3}\s*-->/;

/** 全文安全化:除 WEBVTT 头行与时间行外逐行转义(时间行与头行无 & < > 词法面) */
function escapeVttRenderableLines(vtt: string): string {
  return vtt
    .split('\n')
    .map((line, index) => {
      if (index === 0 && line.trim().toUpperCase().startsWith('WEBVTT')) {
        return line;
      }
      if (VTT_TIMING_LINE.test(line)) {
        return line;
      }
      return escapeSubtitleTextLine(line);
    })
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* 端口与描述符                                                          */
/* ------------------------------------------------------------------ */

/** 旁车定位端口:会话选定源的私有 location(rootKey/relativePath);未解析源/直播 → null */
export interface SubtitleSourceLocator {
  locate(sessionId: string): Promise<{ readonly location: string } | null>;
}

/** 内嵌字幕提取端口:T031 装配真实 demux 实现;单测用 fake。失败/不存在 → null */
export interface EmbeddedSubtitlePort {
  extract(request: { readonly location: string; readonly trackId: string }): Promise<{ readonly text: string; readonly format: 'srt' | 'vtt' } | null>;
}

/** 字幕轨描述符(列表/资产端点形态;不含任何路径成分) */
export interface SubtitleTrackDescriptor {
  readonly id: string;
  readonly label: string;
  readonly language: string | null;
  readonly origin: 'embedded' | 'sidecar';
  /** 恒 false:字幕默认关闭,不自动开启(R6/FR-017) */
  readonly default: false;
  /** 旁车文件名(仅文件名);内嵌为 null */
  readonly sidecarFilename: string | null;
}

/** 字幕内容载荷(text/vtt;播放器不以 HTML 执行) */
export interface SubtitleContent {
  readonly vtt: string;
  readonly contentType: 'text/vtt';
}

export interface PlaybackSubtitlesServiceDeps {
  readonly authorization: PlaybackAuthorizationService;
  /** 当前代 probe 事实(内嵌字幕词表 + 代内失效判定) */
  readonly facts: PlaybackTrackFactsPort;
  readonly locator: SubtitleSourceLocator;
  /** NAS 只读安全读取器(候选重验 statSource + 内容 openRange) */
  readonly nasReader: NasReaderService;
  /** 授权根映射(与 nasReader 同一授权事实) */
  readonly mediaRoots: MediaRoots;
  readonly budgets: PlaybackBudgets;
  /** 内嵌字幕提取端口;缺省 = 内嵌轨不可加载(仅旁车可用) */
  readonly embedded?: EmbeddedSubtitlePort;
}

/* ------------------------------------------------------------------ */
/* 旁车扫描(模块级:安全边界复用 resolveNasMediaLocation + statSource)      */
/* ------------------------------------------------------------------ */

interface SidecarCandidate {
  readonly id: string;
  readonly filename: string;
  readonly location: string;
}

/**
 * 同 stem 旁车候选扫描(确定性:按文件名字节序编号 sub-sidecar-N):
 * 1. resolveNasMediaLocation:媒体自身必须可安全解析(rootKey 授权/路径形态/无符号链接/
 *    realpath 不越根/普通文件);失败 → 无旁车(404 同形面);
 * 2. 同目录 readdir,仅收 `同 stem(大小写不敏感) + .srt/.vtt`(严格同 stem ——
 *    `movie.eng.srt` 的 stem 是 `movie.eng`,不匹配,R6「同 stem」);
 * 3. 每个候选经 statSource 全量重验:任一环节符号链接(含「根内链接」「根外目标」)、
 *    越授权根、缺失、非普通文件 → 剔除(与不存在同形,不泄漏原因);
 * 4. size ≤ maxSidecarBytes(5MiB)否则剔除。
 */
async function scanSidecarCandidates(input: {
  readonly location: string;
  readonly mediaRoots: MediaRoots;
  readonly nasReader: NasReaderService;
  readonly maxSidecarBytes: number;
}): Promise<readonly SidecarCandidate[]> {
  const slashIndex = input.location.indexOf('/');
  if (slashIndex <= 0) {
    return [];
  }
  const rootKey = input.location.slice(0, slashIndex);
  const relativePath = input.location.slice(slashIndex + 1);
  const resolved = await resolveNasMediaLocation(input.location, input.mediaRoots);
  if (!resolved.ok) {
    return [];
  }
  const directory = path.dirname(resolved.absPath);
  const base = path.basename(resolved.absPath);
  const extension = path.extname(base).toLowerCase();
  const stem = (extension === '' ? base : base.slice(0, base.length - path.extname(base).length)).toLowerCase();
  let names: string[];
  try {
    names = (await fsPromises.readdir(directory)).filter((name) => {
      if (name === base) {
        return false;
      }
      const lower = name.toLowerCase();
      return lower === `${stem}.srt` || lower === `${stem}.vtt`;
    });
  } catch {
    return [];
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const relativeDir = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
  const candidates: SidecarCandidate[] = [];
  for (const name of names) {
    const candidateLocation = relativeDir === '' ? `${rootKey}/${name}` : `${rootKey}/${relativeDir}/${name}`;
    const stat = await input.nasReader.statSource(candidateLocation);
    if (!stat.ok || stat.value.size > input.maxSidecarBytes) {
      continue;
    }
    candidates.push({ id: `sub-sidecar-${candidates.length + 1}`, filename: name, location: candidateLocation });
  }
  return candidates;
}

/* ------------------------------------------------------------------ */
/* 服务                                                                  */
/* ------------------------------------------------------------------ */

export class PlaybackSubtitlesService {
  constructor(private readonly deps: PlaybackSubtitlesServiceDeps) {}

  /**
   * 字幕轨列表(内嵌 + 合法旁车;不鉴权 —— 列表属会话状态视图,鉴权由控制器会话守卫
   * 与内容端点的逐请求授权承担):
   * - 内嵌 = probe 事实 sub-N 轨(服务器轨道 ID,label/language 来自 probe);
   * - 旁车 = 同 stem .srt/.vtt 候选(scanSidecarCandidates;id 确定性按文件名序);
   * - maxTrackCount(32)预算:内嵌优先,旁车让位(确定性截断)—— probe 层已拒绝
   *   内嵌超限,此处约束「内嵌+旁车」总列数;音轨不占字幕列表预算(音轨预算由 probe 把关);
   * - 所有描述符 default=false(默认无字幕,不自动开启)。
   */
  async listSubtitleTracks(sessionId: string, facts: PlaybackProbeFacts | undefined): Promise<SubtitleTrackDescriptor[]> {
    const embedded: SubtitleTrackDescriptor[] = (facts?.subtitleTracks ?? []).map((track) => ({
      id: track.id,
      label: track.label,
      language: track.language,
      origin: 'embedded',
      default: false,
      sidecarFilename: null,
    }));
    const sidecars = await this.scanSidecars(sessionId);
    const budget = this.deps.budgets.subtitles.maxTrackCount;
    const room = Math.max(0, budget - embedded.length);
    const accepted: SubtitleTrackDescriptor[] = sidecars
      .slice(0, room)
      .map((candidate) => ({
        id: candidate.id,
        label: candidate.filename,
        language: null,
        origin: 'sidecar',
        default: false as const,
        sidecarFilename: candidate.filename,
      }));
    return [...embedded, ...accepted];
  }

  /**
   * 可选字幕词表(PlaybackSubtitleCatalogPort 实现,供 T029 selection 校验与 T031 装配):
   * 内嵌词表 + 旁车词表;当前代事实缺失时旁车词表仍有效(旁车可用性独立于 probe 代)。
   */
  async subtitleTrackIds(sessionId: string, generation: number): Promise<readonly string[]> {
    const facts = this.deps.facts.factsFor(sessionId, generation);
    const list = await this.listSubtitleTracks(sessionId, facts);
    return list.map((track) => track.id);
  }

  /**
   * 字幕内容(逐请求授权 + 文本安全交付):授权 → 当前代事实(旧代/未知代 404 同形)→
   * 内嵌(extract 端口)或旁车(同 stem 定位 + 只读读取)→ 内容闸 → SRT 转 VTT /
   * VTT 原样 → 逐行安全化 → {vtt, contentType:'text/vtt'}。
   * 轨道不存在/旁车缺失/超限/越根 → 统一 404 MEDIA_NOT_FOUND 同形(不泄漏存在性与原因)。
   */
  async loadSubtitleContent(
    sessionId: string,
    generation: number,
    trackId: string,
    context: SessionContext,
  ): Promise<SubtitleContent> {
    // 1. 逐请求授权(完整链;拒绝以其稳定码抛出,字幕内容不返回 —— api.md)
    await this.deps.authorization.authorizeControl(context, sessionId);
    // 2. 当前代事实:事实按代失效(旧代/未知代与「轨道不存在」同形 404)
    const facts = this.deps.facts.factsFor(sessionId, generation);
    if (facts === undefined) {
      throw createDomainError('MEDIA_NOT_FOUND');
    }
    // 3. 轨道分流:内嵌 sub-N → 提取端口;其余 → 同 stem 旁车词表
    const isEmbedded = facts.subtitleTracks.some((track) => track.id === trackId);
    const raw = isEmbedded ? await this.loadEmbedded(sessionId, trackId) : await this.loadSidecar(sessionId, trackId);
    if (raw === null) {
      throw createDomainError('MEDIA_NOT_FOUND');
    }
    // 4. 内容闸 → 格式转换 → 逐行安全化
    assertPlainSubtitleText(raw.text);
    const withoutBom = raw.text.replace(/^\uFEFF/, '');
    const vtt = raw.format === 'srt' ? subRipToWebVtt(withoutBom) : withoutBom;
    return { vtt: escapeVttRenderableLines(vtt), contentType: 'text/vtt' };
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                                */
  /* ---------------------------------------------------------------- */

  /** 会话选定源的同 stem 旁车候选(定位失败/未解析源 → 空表 = 无旁车,不抛错) */
  private async scanSidecars(sessionId: string): Promise<readonly SidecarCandidate[]> {
    const located = await this.deps.locator.locate(sessionId);
    if (located === null) {
      return [];
    }
    return scanSidecarCandidates({
      location: located.location,
      mediaRoots: this.deps.mediaRoots,
      nasReader: this.deps.nasReader,
      maxSidecarBytes: this.deps.budgets.subtitles.maxSidecarBytes,
    });
  }

  /** 内嵌轨原始文本(提取端口;端口缺失/定位失败/提取失败 → null → 404 同形) */
  private async loadEmbedded(
    sessionId: string,
    trackId: string,
  ): Promise<{ readonly text: string; readonly format: 'srt' | 'vtt' } | null> {
    const port = this.deps.embedded;
    if (port === undefined) {
      return null;
    }
    const located = await this.deps.locator.locate(sessionId);
    if (located === null) {
      return null;
    }
    return port.extract({ location: located.location, trackId });
  }

  /** 旁车原始文本:重新扫描定位(与列表同一次序,id 稳定)→ 只读流式读取(硬上限内) */
  private async loadSidecar(
    sessionId: string,
    trackId: string,
  ): Promise<{ readonly text: string; readonly format: 'srt' | 'vtt' } | null> {
    const located = await this.deps.locator.locate(sessionId);
    if (located === null) {
      return null;
    }
    const candidates = await scanSidecarCandidates({
      location: located.location,
      mediaRoots: this.deps.mediaRoots,
      nasReader: this.deps.nasReader,
      maxSidecarBytes: this.deps.budgets.subtitles.maxSidecarBytes,
    });
    const hit = candidates.find((candidate) => candidate.id === trackId);
    if (hit === undefined) {
      return null;
    }
    const text = await this.readSidecarText(hit.location);
    if (text === null) {
      return null;
    }
    return { text, format: hit.filename.toLowerCase().endsWith('.vtt') ? 'vtt' : 'srt' };
  }

  /**
   * 只读全量读取(openRange 无 Range = 200 全量):流式累计硬上限 maxSidecarBytes
   * (stat 与打开窗口之间的竞态不放大内存面);超限/流故障 → null(404 同形)。
   */
  private async readSidecarText(location: string): Promise<string | null> {
    const opened = await this.deps.nasReader.openRange(location);
    if (!opened.ok) {
      return null;
    }
    const cap = this.deps.budgets.subtitles.maxSidecarBytes;
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of opened.stream) {
        const buffer = Buffer.from(chunk as Buffer);
        total += buffer.length;
        if (total > cap) {
          opened.stream.destroy();
          return null;
        }
        chunks.push(buffer);
      }
    } catch {
      return null;
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}
