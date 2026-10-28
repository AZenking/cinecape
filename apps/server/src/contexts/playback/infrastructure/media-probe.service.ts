import { spawn as spawnNodeProcess } from 'node:child_process';
import type { BigIntStats } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type DatabaseConstructor from 'better-sqlite3';
import type { MediaRoots } from '@platform/config/env.schema';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import { findNasTargetDenial } from '@contexts/sources/domain/source-target.validation';
import type { PlaybackResourceCandidate } from '@contexts/playback/application/playback-authorization.service';
import { PlaybackPlanService } from '@contexts/playback/application/playback-plan.service';
import type {
  PlaybackProbeFailureKind,
  PlaybackProbeFacts,
  PlaybackProbeOutcome,
  PlaybackProbePort,
} from '@contexts/playback/application/playback-resolver.service';
import { playbackErr, playbackOk, type PlaybackErrorCode, type PlaybackResult } from '@contexts/playback/domain/playback.types';

/**
 * 媒体探测服务(T023,spec 004)—— ffprobe 受限子进程与可信事实提取。
 *
 * 权威依据(先读后写):
 * - tasks.md T023:shell=false 参数数组启动、验证受控输入、禁网络/外部引用、10 秒/1MiB 及
 *   独立信号量;最多 32 音轨/字幕轨;输出可信 codec/bitdepth/SDR/duration/服务器轨道 ID;
 *   不缓存已变化输入;
 * - research.md R3:子进程以参数数组、shell=false 启动,禁用网络协议和任意嵌套外部引用;
 *   NAS 通过验证过的只读输入(本服务按 conversion.spec 契约接收 inputPath,根/符号链接/
 *   越界校验由 resolveNasMediaLocation 以 nas-reader.resolveSource 同语义完成 —— 该逻辑
 *   未从 nas-reader.ts 导出且本任务禁止修改既有 src 文件,故按同口径落此并对齐注释);
 * - research.md R4/R6:probe 独立并发 2、队列最多 8,超额忙(与转换额度无关 —— probe 不
 *   调用 T025 的 reserveConversion,不占任何转换并发/磁盘额度);ffprobe 上限 10 秒/输出
 *   1MiB;选轨只接受服务器返回 ID;最多 32 条音轨/字幕轨,超限提示不支持;
 * - contracts/api.md 稳定错误节:失败映射 PLAYBACK_PREPARE_TIMEOUT(超时)/
 *   PLAYBACK_FORMAT_UNSUPPORTED(非零退出/不可解析/轨道超限)/
 *   PLAYBACK_RESOURCE_UNAVAILABLE(输出超限/排队满/定位失败),与 resolver 的
 *   probeFailureToCode 分类同语义;
 * - 验收规约:test/unit/playback/conversion.spec.ts(T023 组:失败矩阵 4 用例 +
 *   真实FFmpeg层事实提取 1 用例)。本文件的行为以该规约断言为准。
 *
 * 安全机制:
 * - spawn 一律经注入的 spawn 工厂,argv 为纯字符串参数数组(shell=false 语义由调用方
 *   spawn 实现落实;缺省实现 nodeSpawn(binary, [...argv], { shell:false }));文件路径只
 *   作为最后一个参数出现,不存在任何字符串拼接命令面(无数组注入面);
 * - 协议面:-protocol_whitelist file,crypto —— 只允许本地文件与加密流去封装(AES-128
 *   media 仍在 file 协议内),显式排除 http/https/tcp/udp/rtsp 等;配合 -v error、
 *   -probesize/-analyzeduration 适度上限,探测既不开网络面也不无界分析;
 * - 时间/输出预算:budgets.probe.timeoutSeconds(10s)硬超时到期即 SIGKILL 并稳定失败;
 *   stdout 累计超过 budgets.probe.maxOutputBytes(1MiB)即刻 SIGKILL 并拒绝(有界内存);
 *   stderr 仅消费防背压,内容永不入日志(T012 脱敏边界:不记录 FFmpeg 原始 stderr);
 * - 不缓存:本服务不维护任何 facts 缓存,每次调用新起 ffprobe 直读当前输入 —— 源
 *   size/mtimeNs 变化检测由 NasReaderService.statSource(T028 语义)承担,不存在
 *   「缓存了已变化输入」的面。
 */

/* ------------------------------------------------------------------ */
/* 对外事实类型(结构兼容 conversion.spec 的 ProbeFacts,附轨道富信息)      */
/* ------------------------------------------------------------------ */

/** 可信视频事实:codec/位深/像素格式/分辨率/SDR(HDR 判定见 hdr) */
export interface ProbeVideoFacts {
  readonly codec: string;
  readonly bitDepth: number;
  readonly pixFmt: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly hdr: boolean;
}

/** 服务器轨道事实:id 为服务器生成的稳定轨道 ID(选轨只接受服务器返回 ID,R4/R6) */
export interface ProbeTrackFact {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'subtitle';
  readonly codec: string;
  /** 展示标签(ffprobe tags.title);缺失为空串 */
  readonly label: string;
  /** ISO 639 语言码(ffprobe tags.language);缺失为 null */
  readonly language: string | null;
  /** 源容器 default 标记(ffprobe disposition.default === 1) */
  readonly default: boolean;
}

/** 可信 probe 事实(T023 输出;T024 输入):container 归一化 ∈ mp4/mkv/avi/mov/ts/webm/… */
export interface MediaProbeFacts {
  readonly container: string;
  readonly durationSeconds: number;
  readonly video: ProbeVideoFacts | null;
  readonly audio: { readonly codec: string } | null;
  readonly tracks: readonly ProbeTrackFact[];
}

/* ------------------------------------------------------------------ */
/* 依赖契约(与 conversion.spec 的 MediaProbeServiceDeps 结构一致)          */
/* ------------------------------------------------------------------ */

/** 结构化时钟(test/fixtures/clock ManualClock 结构兼容;缺省真实时间) */
export interface MediaProbeClock {
  now(): number;
  delay(ms: number): Promise<void>;
}

/** 受限 spawn 请求:argv 由服务构造的纯字符串数组(调用方以 shell=false 启动) */
export interface ProbeSpawnRequest {
  readonly candidateId: string;
  readonly inputPath: string;
  readonly argv: readonly string[];
}

/** probe 子进程句柄(假进程夹具与真实 ChildProcess 的公共结构面) */
export interface ProbeProcessHandle {
  readonly pid: number;
  on(event: 'stdout', listener: (chunk: string | Uint8Array) => void): ProbeProcessHandle;
  on(event: 'stderr', listener: (chunk: string) => void): ProbeProcessHandle;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): ProbeProcessHandle;
  kill(signal?: string): boolean;
}

export type MediaProbeSpawn = (request: ProbeSpawnRequest) => ProbeProcessHandle;

export interface MediaProbeServiceDeps {
  readonly budgets: PlaybackBudgets;
  /** 缺省真实时间(本文件 systemMediaProbeClock) */
  readonly clock?: MediaProbeClock;
  /** 缺省本机 ffprobe(进程内 nodeSpawn,shell=false) */
  readonly spawn?: MediaProbeSpawn;
  /** 授权根映射(端口适配层 location→absPath 安全解析用;缺省视为无授权根) */
  readonly mediaRoots?: MediaRoots;
}

/** 真实时间时钟实现(接口与 test/fixtures/clock ManualClock 结构兼容) */
export function systemMediaProbeClock(): MediaProbeClock {
  return {
    now: () => Date.now(),
    delay: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

/* ------------------------------------------------------------------ */
/* ffprobe 受限参数构造(禁网络/外部引用的最小协议面)                       */
/* ------------------------------------------------------------------ */

/**
 * 协议白名单最小面:file(本地文件/流内嵌媒体)+ crypto(AES-128 去封装所需)。
 * 显式排除 network/外链面(http/https/tcp/udp/rtsp/rtp/data/pipe 等),与 R3
 * 「禁用网络协议和任意嵌套外部引用」一致;字幕/章节等外部引用路径不在此白名单内,
 * ffprobe 将直接失败而不是发起读取。
 */
const FFPROBE_PROTOCOL_WHITELIST = 'file,crypto';

/** 输入分析有界化:probesize 5MiB(默认值显式化,防异常输入无界读取) */
const FFPROBE_PROBE_SIZE_BYTES = 5 * 1024 * 1024;
/** 输入分析有界化:analyzeduration 5 秒(微秒;远小于 10 秒硬超时,给解析留余量) */
const FFPROBE_ANALYZE_DURATION_US = 5_000_000;

/** 构造受限 ffprobe 参数数组(全部为字面量字符串,输入路径仅作末参数) */
function buildProbeArgv(inputPath: string): string[] {
  return [
    '-v',
    'error',
    '-probesize',
    String(FFPROBE_PROBE_SIZE_BYTES),
    '-analyzeduration',
    String(FFPROBE_ANALYZE_DURATION_US),
    '-protocol_whitelist',
    FFPROBE_PROTOCOL_WHITELIST,
    '-show_streams',
    '-show_format',
    '-print_format',
    'json',
    inputPath,
  ];
}

/** ffprobe 二进制解析:HMP_FFPROBE_BIN 覆盖 → PATH 解析 'ffprobe'(部署侧固定镜像版本) */
function resolveFfprobeBinary(): string {
  const fromEnv = process.env.HMP_FFPROBE_BIN;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  return 'ffprobe';
}

/** 缺省 spawn 实现:node child_process,参数数组 + shell=false(无数组注入面) */
const defaultProbeSpawn: MediaProbeSpawn = (request) => {
  const child = spawnNodeProcess(resolveFfprobeBinary(), [...request.argv], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  return child as unknown as ProbeProcessHandle;
};

/* ------------------------------------------------------------------ */
/* 单候选探测结果与稳定失败映射                                          */
/* ------------------------------------------------------------------ */

/** 单候选失败原因(timeout/exit/unparseable/overflow/track_limit/busy 见 probeFirstAvailable) */
type ProbeFailureReason = 'timeout' | 'exit' | 'unparseable' | 'overflow' | 'track_limit' | 'busy';

type SingleProbeOutcome =
  | { readonly kind: 'ok'; readonly facts: MediaProbeFacts }
  | { readonly kind: 'fail'; readonly reason: ProbeFailureReason };

/**
 * 全候选失败 → 稳定失败码(集中一处,与 resolver probeFailureToCode 的三类同语义):
 * - 任一候选超时/总期限耗尽 → PLAYBACK_PREPARE_TIMEOUT(期限类失败最具体,优先报告);
 * - 其余全部为格式类(非零退出/不可解析/轨道超限)→ PLAYBACK_FORMAT_UNSUPPORTED;
 * - 输出超限/排队忙/定位失败/空候选 → PLAYBACK_RESOURCE_UNAVAILABLE。
 */
function failureCodeForReasons(reasons: readonly ProbeFailureReason[]): PlaybackErrorCode {
  if (reasons.includes('timeout')) {
    return 'PLAYBACK_PREPARE_TIMEOUT';
  }
  const formatReasons: readonly ProbeFailureReason[] = ['exit', 'unparseable', 'track_limit'];
  if (reasons.length > 0 && reasons.every((reason) => formatReasons.includes(reason))) {
    return 'PLAYBACK_FORMAT_UNSUPPORTED';
  }
  return 'PLAYBACK_RESOURCE_UNAVAILABLE';
}

/* ------------------------------------------------------------------ */
/* ffprobe JSON 事实提取(纯函数)                                        */
/* ------------------------------------------------------------------ */

interface FfprobeStreamLike {
  codec_type?: unknown;
  codec_name?: unknown;
  pix_fmt?: unknown;
  bits_per_raw_sample?: unknown;
  width?: unknown;
  height?: unknown;
  color_transfer?: unknown;
  color_primaries?: unknown;
  duration?: unknown;
  tags?: unknown;
  disposition?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * 容器归一化:format_name 逗号列表按别名气序映射(fixtures:mov,mp4,… → mp4,
 * mp4 优先于 mov);未知容器保留原始首段(计划层按 FR-014 矩阵拒绝)。
 */
const CONTAINER_NORMALIZATION: readonly (readonly [canonical: string, aliases: readonly string[]])[] = [
  ['mp4', ['mp4', 'm4a', 'm4v', 'mj2', '3gp', '3g2']],
  ['mkv', ['mkv', 'matroska']],
  ['ts', ['mpegts', 'm2ts', 'mts']],
  ['mov', ['mov', 'quicktime']],
  ['avi', ['avi']],
  ['webm', ['webm']],
];

export function normalizeContainerName(formatName: string): string {
  const tokens = formatName
    .toLowerCase()
    .split(',')
    .map((token) => token.trim());
  for (const [canonical, aliases] of CONTAINER_NORMALIZATION) {
    if (aliases.some((alias) => tokens.includes(alias))) {
      return canonical;
    }
  }
  return tokens[0] ?? '';
}

/** 位深:bits_per_raw_sample 优先(≥8);否则像素格式名后缀数字(…10le → 10);否则 8 */
function parseBitDepth(stream: FfprobeStreamLike): number {
  const raw = asFiniteNumber(stream.bits_per_raw_sample);
  if (raw !== null && raw >= 8) {
    return Math.trunc(raw);
  }
  const pixFmt = asString(stream.pix_fmt) ?? '';
  const suffix = /(\d+)(?:le|be)?$/.exec(pixFmt);
  const fromSuffix = suffix?.[1] !== undefined ? Number.parseInt(suffix[1], 10) : Number.NaN;
  if (Number.isFinite(fromSuffix) && fromSuffix >= 8) {
    return fromSuffix;
  }
  return 8;
}

/** SDR/HDR 判定:color_transfer smpte2084(HDR10)/arib-std-b67(HLG)或 primaries bt2020 */
function isHdrStream(stream: FfprobeStreamLike): boolean {
  const transfer = asString(stream.color_transfer);
  if (transfer === 'smpte2084' || transfer === 'arib-std-b67') {
    return true;
  }
  return asString(stream.color_primaries) === 'bt2020';
}

interface TrackTags {
  label: string;
  language: string | null;
  isDefault: boolean;
}

function trackTags(stream: FfprobeStreamLike): TrackTags {
  const tags = asRecord(stream.tags);
  const disposition = asRecord(stream.disposition);
  return {
    label: asString(tags?.title) ?? '',
    language: asString(tags?.language),
    isDefault: disposition?.default === 1,
  };
}

/**
 * 解析 ffprobe stdout(-print_format json)为可信事实。
 * 解析失败/缺 format → unparseable;音轨+字幕轨合计超 budgets.subtitles.maxTrackCount
 * → track_limit(超限提示不支持,R6)。
 */
export function parseFfprobeFacts(stdout: string, budgets: PlaybackBudgets): SingleProbeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { kind: 'fail', reason: 'unparseable' };
  }
  const root = asRecord(parsed);
  if (root === null) {
    return { kind: 'fail', reason: 'unparseable' };
  }
  const format = asRecord(root.format);
  if (format === null) {
    return { kind: 'fail', reason: 'unparseable' };
  }
  const formatName = asString(format.format_name);
  if (formatName === null) {
    return { kind: 'fail', reason: 'unparseable' };
  }

  const rawStreams = Array.isArray(root.streams) ? root.streams : [];
  const streams = rawStreams
    .map((stream) => asRecord(stream))
    .filter((stream): stream is Record<string, unknown> => stream !== null);

  // 主视频 = 首个非 attached_pic 视频流(封面图不计入主视频,也不入轨道表);
  // 轨道按流顺序收录 video/audio/subtitle,服务器 ID 形如 vid-N/aud-N/sub-N(每类 1 起)
  const kindCounters = { video: 0, audio: 0, subtitle: 0 };
  const idPrefixByKind = { video: 'vid', audio: 'aud', subtitle: 'sub' } as const;
  const tracks: ProbeTrackFact[] = [];
  let audioFacts: { codec: string } | null = null;
  let videoFacts: ProbeVideoFacts | null = null;

  const isAttachedPic = (stream: FfprobeStreamLike): boolean =>
    asRecord(stream.disposition)?.attached_pic === 1;

  for (const stream of streams) {
    const kind = asString(stream.codec_type);
    if (kind !== 'video' && kind !== 'audio' && kind !== 'subtitle') {
      continue;
    }
    if (kind === 'video' && isAttachedPic(stream)) {
      continue;
    }
    const codec = (asString(stream.codec_name) ?? '').toLowerCase();
    kindCounters[kind] += 1;
    const tags = trackTags(stream);
    tracks.push({
      id: `${idPrefixByKind[kind]}-${kindCounters[kind]}`,
      kind,
      codec,
      label: tags.label,
      language: tags.language,
      default: tags.isDefault,
    });
    if (kind === 'video' && videoFacts === null) {
      videoFacts = {
        codec,
        bitDepth: parseBitDepth(stream),
        pixFmt: asString(stream.pix_fmt) ?? '',
        widthPx: Math.trunc(asFiniteNumber(stream.width) ?? 0),
        heightPx: Math.trunc(asFiniteNumber(stream.height) ?? 0),
        hdr: isHdrStream(stream),
      };
    }
    if (kind === 'audio' && audioFacts === null) {
      audioFacts = { codec };
    }
  }

  // 最多 32 条音轨/字幕轨(合计;视频轨不占该预算):超限提示不支持(R6)
  const audioSubtitleCount = kindCounters.audio + kindCounters.subtitle;
  if (audioSubtitleCount > budgets.subtitles.maxTrackCount) {
    return { kind: 'fail', reason: 'track_limit' };
  }

  const duration =
    asFiniteNumber(format.duration) ??
    streams.map((stream) => asFiniteNumber(stream.duration)).find((value) => value !== null) ??
    0;

  return {
    kind: 'ok',
    facts: {
      container: normalizeContainerName(formatName),
      durationSeconds: duration,
      video: videoFacts,
      audio: audioFacts,
      tracks,
    },
  };
}

/* ------------------------------------------------------------------ */
/* NAS location → 授权根内绝对路径(nas-reader.resolveSource 同语义)        */
/* ------------------------------------------------------------------ */

export type NasLocationResolution =
  | { readonly ok: true; readonly absPath: string }
  | { readonly ok: false };

function lstatSafe(candidate: string): Promise<BigIntStats | null> {
  return fsPromises
    .lstat(candidate, { bigint: true })
    .then((stat) => stat)
    .catch(() => null);
}

function realpathSafe(candidate: string): Promise<string | null> {
  return fsPromises
    .realpath(candidate)
    .then((resolved) => resolved)
    .catch(() => null);
}

/** realpath 结果是否仍在授权根内(等于根或以根+分隔符为前缀;与 nas-scanner withinRoot 同语义) */
function withinRoot(candidate: string, rootRealPath: string): boolean {
  return candidate === rootRealPath || candidate.startsWith(rootRealPath + path.sep);
}

/**
 * `rootKey/relativePath` → 授权根内绝对路径。校验顺序与 nas-reader.resolveSource 完全一致
 * (rootKey 授权 + findNasTargetDenial 路径形态 + 逐段 lstat 拒符号链接 + 末段普通文件 +
 * 逐段 realpath 不越界);任一失败返回 { ok:false },不泄漏存在性/原因差异。
 * 说明:nas-reader.ts 未导出该 walk 且本任务禁止修改既有 src 文件,故按同口径落此;
 * 两处语义必须保持一致(后续任务如抽公共模块应合并)。
 */
export async function resolveNasMediaLocation(location: string, mediaRoots: MediaRoots): Promise<NasLocationResolution> {
  const slashIndex = location.indexOf('/');
  if (slashIndex <= 0) {
    return { ok: false };
  }
  const rootKey = location.slice(0, slashIndex);
  const relativePath = location.slice(slashIndex + 1);
  if (findNasTargetDenial(rootKey, relativePath, mediaRoots) !== null) {
    return { ok: false };
  }
  const rootPath = mediaRoots[rootKey];
  if (rootPath === undefined || rootPath === '') {
    return { ok: false };
  }
  const rootRealPath = await realpathSafe(rootPath);
  if (rootRealPath === null) {
    return { ok: false };
  }
  const rootStat = await lstatSafe(rootRealPath);
  if (rootStat === null || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { ok: false };
  }
  const segments = relativePath === '' ? [] : relativePath.split('/');
  if (segments.length === 0) {
    return { ok: false };
  }
  let current = rootRealPath;
  let lastStat: BigIntStats | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      return { ok: false };
    }
    const candidate = path.join(current, segment);
    const stat = await lstatSafe(candidate);
    if (stat === null || stat.isSymbolicLink()) {
      return { ok: false };
    }
    const isLast = index === segments.length - 1;
    if (isLast ? !stat.isFile() : !stat.isDirectory()) {
      return { ok: false };
    }
    const candidateRealPath = await realpathSafe(candidate);
    if (candidateRealPath === null || !withinRoot(candidateRealPath, rootRealPath)) {
      return { ok: false };
    }
    current = candidateRealPath;
    lastStat = stat;
  }
  if (lastStat === null) {
    return { ok: false };
  }
  return { ok: true, absPath: current };
}

/* ------------------------------------------------------------------ */
/* 探测端口适配(resolver PlaybackProbePort 的真实实现装配面)               */
/* ------------------------------------------------------------------ */

/** 源定位端口:playbackSourceId → 私有 location(playback_source 落库形态 rootKey/relativePath) */
export interface ProbeSourceLocator {
  locate(playbackSourceId: string): Promise<{ readonly location: string } | null>;
}

/**
 * playback_source 只读定位器:惰性准备语句(应用装配早于迁移完成的顺序下不阻断启动),
 * 只投影 location 列;无行/无 location → null。
 */
export class PlaybackSourceLocationReader implements ProbeSourceLocator {
  private statement: DatabaseConstructor.Statement | null = null;

  constructor(private readonly db: DatabaseConstructor.Database) {}

  async locate(playbackSourceId: string): Promise<{ readonly location: string } | null> {
    if (this.statement === null) {
      this.statement = this.db.prepare('SELECT location FROM playback_source WHERE id = ?');
    }
    const row = this.statement.get(playbackSourceId) as { location?: unknown } | undefined;
    const location = typeof row?.location === 'string' ? row.location : '';
    if (location === '') {
      return null;
    }
    return { location };
  }
}

/** probe 稳定码 → resolver 失败分类(映射表集中一处) */
function probeCodeToFailureKind(code: PlaybackErrorCode): PlaybackProbeFailureKind {
  if (code === 'PLAYBACK_PREPARE_TIMEOUT') {
    return 'timeout';
  }
  if (code === 'PLAYBACK_FORMAT_UNSUPPORTED') {
    return 'format_unsupported';
  }
  return 'resource_unavailable';
}

function collapseFailureKinds(kinds: readonly PlaybackProbeFailureKind[]): PlaybackProbeFailureKind {
  if (kinds.includes('timeout')) {
    return 'timeout';
  }
  if (kinds.length > 0 && kinds.every((kind) => kind === 'format_unsupported')) {
    return 'format_unsupported';
  }
  return 'resource_unavailable';
}

/** MediaProbeFacts → resolver 可信事实(duration/音轨/字幕轨;轨道 ID 沿用服务器形态) */
function toPlaybackProbeFacts(facts: MediaProbeFacts): PlaybackProbeFacts {
  return {
    durationSeconds: Number.isFinite(facts.durationSeconds) ? facts.durationSeconds : null,
    audioTracks: facts.tracks
      .filter((track) => track.kind === 'audio')
      .map((track) => ({ id: track.id, label: track.label, language: track.language, default: track.default })),
    subtitleTracks: facts.tracks
      .filter((track) => track.kind === 'subtitle')
      .map((track) => ({ id: track.id, label: track.label, language: track.language })),
  };
}

/** 直播(hls_proxy)候选事实:无需 ffprobe,duration=null 且无轨道(契约:直播 duration=null) */
const LIVE_STREAM_FACTS: PlaybackProbeFacts = {
  durationSeconds: null,
  audioTracks: [],
  subtitleTracks: [],
};

export interface MediaProbePlaybackProbePortDeps {
  readonly probe: MediaProbeService;
  /** 计划器:probe 事实 → 交付方式(direct/remux/audio_transcode/video_transcode) */
  readonly plan: PlaybackPlanService;
  readonly locator: ProbeSourceLocator;
  readonly mediaRoots: MediaRoots;
}

/**
 * resolver PlaybackProbePort 适配(T019 探测端口的 T023/T024 真实实现):
 * - deadlineMs 语义与 resolver 构造一致(时长:缺省 watchdog.prepareTimeoutSeconds×1000),
 *   适配层换算为注入时钟下的绝对期限后传给 MediaProbeService;
 * - hls_proxy 候选按 resolver 语义无需 ffprobe:直接成功返回 { delivery:'hls_proxy',
 *   facts: 直播形态(duration=null、无轨道) };
 * - file 类候选:定位 → 根内安全解析 → probe → plan,交付取计划结果;probe/plan 失败
 *   试下一候选;全部失败按分类收敛(timeout 优先,其余全 format_unsupported 才归格式,
 *   否则 resource_unavailable)。
 */
export class MediaProbePlaybackProbePort implements PlaybackProbePort {
  constructor(private readonly deps: MediaProbePlaybackProbePortDeps) {}

  async probeFirstAvailable(candidates: readonly PlaybackResourceCandidate[], deadlineMs: number): Promise<PlaybackProbeOutcome> {
    const deadlineAtMs = this.deps.probe.nowMs() + deadlineMs;
    const failureKinds: PlaybackProbeFailureKind[] = [];
    for (const candidate of candidates) {
      if (candidate.delivery === 'hls_proxy') {
        return { playbackSourceId: candidate.playbackSourceId, delivery: 'hls_proxy', facts: LIVE_STREAM_FACTS };
      }
      const located = await this.deps.locator.locate(candidate.playbackSourceId);
      if (located === null) {
        failureKinds.push('resource_unavailable');
        continue;
      }
      const resolved = await resolveNasMediaLocation(located.location, this.deps.mediaRoots);
      if (!resolved.ok) {
        failureKinds.push('resource_unavailable');
        continue;
      }
      const probed = await this.deps.probe.probeFirstAvailable(
        [{ candidateId: candidate.playbackSourceId, inputPath: resolved.absPath }],
        { atMs: deadlineAtMs },
      );
      if (!probed.ok) {
        failureKinds.push(probeCodeToFailureKind(probed.code));
        continue;
      }
      const planned = this.deps.plan.plan(probed.value);
      if (!planned.ok) {
        failureKinds.push('format_unsupported');
        continue;
      }
      return {
        playbackSourceId: candidate.playbackSourceId,
        delivery: planned.value.delivery,
        facts: toPlaybackProbeFacts(probed.value),
      };
    }
    return { error: collapseFailureKinds(failureKinds) };
  }
}

/** resolver ProbePort 注入 token(T019 resolver 尚未入 module,后续接线经此取端口) */
export const PLAYBACK_PROBE_PORT: unique symbol = Symbol('PlaybackProbePort(MediaProbe)');

/* ------------------------------------------------------------------ */
/* 服务                                                                  */
/* ------------------------------------------------------------------ */

/**
 * NAS 媒体探测服务:对候选序逐个运行受限 ffprobe(独立信号量 + 共享绝对期限)。
 * 无状态除并发账本与排队队列;不缓存任何 facts(见文件头「不缓存」)。
 */
@Injectable()
export class MediaProbeService {
  private readonly clock: MediaProbeClock;

  private readonly spawn: MediaProbeSpawn;

  private readonly budgets: PlaybackBudgets;

  /** probe 独立并发账本(budgets.probe.concurrency;与转换额度无关) */
  private activeProbes = 0;

  /** probe 排队等待者 FIFO(budgets.probe.queueCapacity 上限,满载立即忙) */
  private readonly waitingQueue: Array<(granted: boolean) => void> = [];

  constructor(deps: MediaProbeServiceDeps) {
    this.budgets = deps.budgets;
    this.clock = deps.clock ?? systemMediaProbeClock();
    this.spawn = deps.spawn ?? defaultProbeSpawn;
  }

  /** 当前注入时钟毫秒值(端口适配层换算共享绝对期限用) */
  nowMs(): number {
    return this.clock.now();
  }

  /**
   * 按候选序探测,全部候选共用同一绝对期限:
   * - 每候选窗口 = min(budgets.probe.timeoutSeconds×1000, 期限余量);到期 SIGKILL 并
   *   视为失败继续下一候选(不隐藏重试;期限耗尽后不再尝试剩余候选);
   * - probe 不占转换额度:并发由本服务独立信号量(budgets.probe.concurrency/queueCapacity)
   *   控制,与 T025 的 reserveConversion 及磁盘预算完全无关;
   * - 队列满载立即返回忙(PLAYBACK_RESOURCE_UNAVAILABLE),不无限排队。
   */
  async probeFirstAvailable(
    candidates: readonly { readonly candidateId: string; readonly inputPath: string }[],
    deadline: { readonly atMs: number },
  ): Promise<PlaybackResult<MediaProbeFacts>> {
    const failureReasons: ProbeFailureReason[] = [];
    for (const candidate of candidates) {
      if (this.clock.now() >= deadline.atMs) {
        // 共享期限已耗尽:不再尝试剩余候选(data-model 资源选择,不隐藏无限重试)
        failureReasons.push('timeout');
        break;
      }
      const granted = await this.acquireSlot();
      if (!granted) {
        failureReasons.push('busy');
        break;
      }
      try {
        const windowMs = Math.min(this.budgets.probe.timeoutSeconds * 1000, deadline.atMs - this.clock.now());
        if (windowMs <= 0) {
          failureReasons.push('timeout');
          continue;
        }
        const outcome = await this.runSingleProbe(candidate.candidateId, candidate.inputPath, windowMs);
        if (outcome.kind === 'ok') {
          return playbackOk(outcome.facts);
        }
        failureReasons.push(outcome.reason);
      } finally {
        this.releaseSlot();
      }
    }
    return playbackErr(failureCodeForReasons(failureReasons), '全部媒体候选探测失败');
  }

  /* ---------------------------------------------------------------- */
  /* 独立信号量(并发 2/队列 8,满载立即忙)                                */
  /* ---------------------------------------------------------------- */

  private async acquireSlot(): Promise<boolean> {
    if (this.activeProbes < this.budgets.probe.concurrency) {
      this.activeProbes += 1;
      return true;
    }
    if (this.waitingQueue.length >= this.budgets.probe.queueCapacity) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      this.waitingQueue.push(resolve);
    });
  }

  private releaseSlot(): void {
    const next = this.waitingQueue.shift();
    if (next !== undefined) {
      // 槽位直接移交队首等待者(账本计数不变)
      next(true);
      return;
    }
    this.activeProbes -= 1;
  }

  /* ---------------------------------------------------------------- */
  /* 单候选受限子进程                                                     */
  /* ---------------------------------------------------------------- */

  private runSingleProbe(candidateId: string, inputPath: string, windowMs: number): Promise<SingleProbeOutcome> {
    return new Promise<SingleProbeOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: SingleProbeOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(outcome);
      };

      const handle = this.spawn({ candidateId, inputPath, argv: buildProbeArgv(inputPath) });
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let overflowed = false;
      let exitSeen = false;
      let exitCode: number | null = null;
      const stdoutStream = streamOf(handle, 'stdout');
      // 事件形态句柄(假进程夹具)无流概念,视作「流已完结」
      let stdoutEnded = stdoutStream === null;

      const onStdoutChunk = (chunk: string | Uint8Array): void => {
        if (settled || overflowed) {
          return;
        }
        const chunkBytes = Buffer.byteLength(chunk);
        if (stdoutBytes + chunkBytes > this.budgets.probe.maxOutputBytes) {
          // 有界输出预算:超限即刻终止并拒绝(信号必须发生在退出事件之前,有据可查)
          overflowed = true;
          handle.kill('SIGKILL');
          finish({ kind: 'fail', reason: 'overflow' });
          return;
        }
        stdoutBytes += chunkBytes;
        stdoutChunks.push(Buffer.from(chunk));
      };
      if (stdoutStream !== null) {
        stdoutStream.on('data', onStdoutChunk as (...args: unknown[]) => void);
      } else {
        handle.on('stdout', onStdoutChunk);
      }

      // stderr 仅消费防背压;内容永不入日志/结果(T012:不记录 FFmpeg 原始 stderr)
      const consumeStderr = (): void => undefined;
      const stderrStream = streamOf(handle, 'stderr');
      if (stderrStream !== null) {
        stderrStream.on('data', consumeStderr);
      } else {
        handle.on('stderr', consumeStderr);
      }

      // 10 秒硬超时:到期未退出 → SIGKILL + 稳定超时失败(不等 exit 事件:被杀进程
      // 可能永远不再发 exit;settled 守卫防与退出路径双写)
      void this.clock.delay(windowMs).then(() => {
        if (settled) {
          return;
        }
        handle.kill('SIGKILL');
        finish({ kind: 'fail', reason: 'timeout' });
      });

      const finalizeAfterExit = (): void => {
        if (settled || !exitSeen || !stdoutEnded) {
          return;
        }
        // 单次 setImmediate:让真实子进程管道中已到达的尾部字节先派发再裁决
        setImmediate(() => {
          if (settled) {
            return;
          }
          if (overflowed) {
            finish({ kind: 'fail', reason: 'overflow' });
            return;
          }
          if (exitCode !== 0) {
            finish({ kind: 'fail', reason: 'exit' });
            return;
          }
          finish(parseFfprobeFacts(Buffer.concat(stdoutChunks).toString('utf8'), this.budgets));
        });
      };

      handle.on('exit', (code) => {
        if (settled || exitSeen) {
          return;
        }
        exitSeen = true;
        exitCode = code;
        finalizeAfterExit();
      });
      if (stdoutStream !== null) {
        stdoutStream.on('end', () => {
          if (stdoutEnded) {
            return;
          }
          stdoutEnded = true;
          finalizeAfterExit();
        });
        // 真实子进程 spawn 失败(二进制缺失等)只发 'error' 不发 'exit':按资源失败收口
        (handle as unknown as { on(event: string, listener: (...args: unknown[]) => void): unknown }).on('error', () => {
          if (settled) {
            return;
          }
          handle.kill('SIGKILL');
          finish({ kind: 'fail', reason: 'exit' });
        });
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* 句柄流适配:真实 ChildProcess(stdout/stderr 流)与假句柄(事件)统一       */
/* ------------------------------------------------------------------ */

interface MiniStream {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * 事件形态假句柄经 on('stdout'|'stderr') 交付,真实 ChildProcess 以同名属性承载
 * Readable 流;按属性探测统一两种形态(接口契约见 conversion.spec ProbeProcessHandle)。
 */
function streamOf(handle: ProbeProcessHandle, name: 'stdout' | 'stderr'): MiniStream | null {
  const candidate = (handle as unknown as Record<'stdout' | 'stderr', unknown>)[name];
  if (typeof candidate === 'object' && candidate !== null && typeof (candidate as MiniStream).on === 'function') {
    return candidate as MiniStream;
  }
  return null;
}
