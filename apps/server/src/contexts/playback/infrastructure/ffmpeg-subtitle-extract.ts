import { spawn as spawnNodeProcess } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { PlaybackBudgets } from '@platform/config/playback-budgets';
import type { MediaRoots } from '@platform/config/env.schema';
import { resolveNasMediaLocation } from '@contexts/playback/infrastructure/media-probe.service';
import type { EmbeddedSubtitlePort } from '@contexts/playback/infrastructure/playback-subtitles.service';

/**
 * 内嵌字幕受限 demux 提取(T031 装配,spec 004)—— EmbeddedSubtitlePort 的真实实现:
 *
 * 权威依据:
 * - tasks.md T030/R6:内嵌 SubRip/WebVTT 交付为文本字幕;SRT→VTT 文本安全显示由
 *   PlaybackSubtitlesService 承担,本文件只负责「从容器中提取字幕轨原始文本」;
 * - research.md R3(子进程纪律,对齐 media-probe.service):argv 纯字符串参数数组 +
 *   shell=false(无字符串拼接命令面,无数组注入面);协议面不开放网络;硬超时到期
 *   SIGKILL;输出有界(≤ budgets.subtitles.maxSidecarBytes,超限即杀);stderr 仅消费
 *   防背压,内容永不入日志/结果(T012 脱敏边界);
 * - 提取命令:`ffmpeg -v error -i <file> -map 0:s:<n> -f webvtt pipe:1`(stdout),
 *   ffmpeg 自带 SRT→WebVTT 转换;服务器轨道 ID 'sub-N'(probe 词表,1 起)映射为
 *   0 基字幕流序号 n=N-1 —— 与 probe 建立服务器轨道 ID 的顺序规则一致
 *   (media-probe parseFfprobeFacts:subtitle 流按出现顺序编号)。
 *
 * 失败面:文件定位失败/ffmpeg 缺失/非零退出/超时/输出超限/未知轨道 ID → null
 * (调用方 PlaybackSubtitlesService 统一 404 同形,不泄漏原因差异)。
 */

/** 服务器字幕轨 ID → 0 基流序号('sub-3' → 2);非法形态 → null */
export function subtitleOrdinalOf(trackId: string): number | null {
  const match = /^sub-(\d+)$/.exec(trackId);
  if (match === null) {
    return null;
  }
  const ordinal = Number(match[1]) - 1;
  return ordinal >= 0 ? ordinal : null;
}

/** 构造受限 ffmpeg 参数数组(全部字面量;输入路径仅作 -i 值) */
export function buildExtractArgv(inputPath: string, ordinal: number): string[] {
  return ['-v', 'error', '-i', inputPath, '-map', `0:s:${ordinal}`, '-f', 'webvtt', 'pipe:1'];
}

/** ffmpeg 二进制解析:HMP_FFMPEG_BIN 覆盖 → PATH 'ffmpeg'(与 ffprobe 解析同惯例) */
function resolveFfmpegBinary(): string {
  const fromEnv = process.env.HMP_FFMPEG_BIN;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  return 'ffmpeg';
}

export interface FfmpegSubtitleExtractDeps {
  readonly budgets: PlaybackBudgets;
  readonly mediaRoots: MediaRoots;
}

/** 受限子进程最小结构面(真实 ChildProcess 满足;测试可注入 fake) */
export interface SubtitleExtractProcess {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown; on(event: 'end', listener: () => void): unknown } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): boolean;
}

export type SubtitleExtractSpawn = (argv: readonly string[]) => SubtitleExtractProcess;

/** 缺省 spawn:参数数组 + shell=false(无数组注入面) */
const defaultExtractSpawn: SubtitleExtractSpawn = (argv) =>
  spawnNodeProcess(resolveFfmpegBinary(), [...argv], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  }) as unknown as ChildProcess as SubtitleExtractProcess;

export class FfmpegSubtitleExtractService implements EmbeddedSubtitlePort {
  private readonly spawn: SubtitleExtractSpawn;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly deps: FfmpegSubtitleExtractDeps,
    spawn?: SubtitleExtractSpawn,
  ) {
    this.spawn = spawn ?? defaultExtractSpawn;
    this.timeoutMs = deps.budgets.probe.timeoutSeconds * 1000;
    this.maxBytes = deps.budgets.subtitles.maxSidecarBytes;
  }

  /**
   * 提取内嵌字幕轨文本(EmbeddedSubtitlePort):location 为会话选定源私有 location
   * (rootKey/relativePath),经 resolveNasMediaLocation 根内安全解析后作为受限 ffmpeg
   * 输入;输出 webvtt 文本,失败一律 null(不抛错,与端口契约一致)。
   */
  async extract(request: { readonly location: string; readonly trackId: string }): Promise<{ readonly text: string; readonly format: 'srt' | 'vtt' } | null> {
    const ordinal = subtitleOrdinalOf(request.trackId);
    if (ordinal === null) {
      return null;
    }
    const resolved = await resolveNasMediaLocation(request.location, this.deps.mediaRoots);
    if (!resolved.ok) {
      return null;
    }
    return await this.runExtract(buildExtractArgv(resolved.absPath, ordinal));
  }

  /** 单次受限提取:输出硬上限 + 硬超时;任一越界即 SIGKILL 并稳定失败(null) */
  private runExtract(argv: readonly string[]): Promise<{ readonly text: string; readonly format: 'srt' | 'vtt' } | null> {
    return new Promise((resolve) => {
      let settled = false;
      let text: string | null = null;
      let bytes = 0;
      let exited = false;
      let stdoutEnded = true;
      const finish = (outcome: { readonly text: string; readonly format: 'srt' | 'vtt' } | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      let child: SubtitleExtractProcess;
      try {
        child = this.spawn(argv);
      } catch {
        finish(null);
        return;
      }
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        child.kill('SIGKILL');
        finish(null);
      }, this.timeoutMs);
      child.on('error', () => {
        // spawn 失败(二进制缺失等)只发 'error' 不发 'exit':按失败收口
        child.kill('SIGKILL');
        finish(null);
      });
      child.on('exit', (code) => {
        exited = true;
        if (code !== 0 || !stdoutEnded) {
          // 非零退出(轨道不存在/不可解码)或输出未完结:等待 stdout 尾字节或超时收口
          if (code !== 0) {
            finish(null);
          }
          return;
        }
        finish(text === null ? null : { text, format: 'vtt' });
      });
      if (child.stdout !== null) {
        stdoutEnded = false;
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.maxBytes) {
            child.kill('SIGKILL');
            finish(null);
            return;
          }
          text = (text ?? '') + chunk.toString('utf8');
        });
        child.stdout.on('end', () => {
          stdoutEnded = true;
          if (exited && !settled) {
            finish(text === null || bytes > this.maxBytes ? null : { text, format: 'vtt' });
          }
        });
      }
      // stderr 仅消费防背压;内容永不入日志/结果(T012)
      child.stderr?.on('data', () => undefined);
    });
  }
}
