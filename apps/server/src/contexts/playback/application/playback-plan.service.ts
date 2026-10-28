import { Injectable } from '@nestjs/common';
import type { PlaybackBudgets } from '../../../config/playback-budgets';
import { playbackErr, playbackOk, type PlaybackConversionMode, type PlaybackResult } from '@contexts/playback/domain/playback.types';

/**
 * 播放格式计划服务(T024,spec 004)—— direct→remux→audio_transcode→video_transcode。
 *
 * 权威依据(先读后写):
 * - tasks.md T024:实现 direct→remux→audio_transcode→video_transcode;FR-014 全部合法
 *   容器/编码组合选必要转换,H.264 8bit yuv420p/AAC 输出、无 4K/HDR 转换或自动降分辨率,
 *   全部不可用稳定失败;
 * - spec.md FR-012:优先直接播放;仅容器不兼容时优先转封装(保留原始音视频编码);编码
 *   不兼容时仅转换必要的音频或视频轨道;
 * - spec.md FR-014:必验兼容范围为最高 1080p SDR 的 MP4/MKV/AVI/MOV/TS,及其中有效且可
 *   组合的 H.264、8/10 位 HEVC、MPEG-4 视频与 AAC/AC-3/E-AC-3/DTS 音频;不要求容器与编码
 *   的非法组合可播放;4K/HDR 仅尽力直接播放,本期不保证其转换;
 * - research.md R1:输出统一保守能力集 H.264 8-bit yuv420p/AAC HLS;4K/HDR 仅尽力直放,
 *   不能误当 SDR 转码处理;
 * - research.md R4:视频目标 8Mbps(上限 12Mbps)、固定最高 1080p 不自动降分辨率、音频
 *   AAC 192kbps、转封装不重编码;direct 不占转换额度;
 * - 验收规约:test/unit/playback/conversion.spec.ts(T024 组 7 用例)。行为以该规约断言为准。
 *
 * 决策树(plan 为纯函数,同步返回;不占/不检查任何额度 —— direct mode=null 不建转换行,
 * 转换路径的 reserve 属 T025):
 * 1. 输入无视频轨(纯音频)→ PLAYBACK_FORMAT_UNSUPPORTED(超出本期影片语义);
 * 2. 容器 ∉ {mp4,mkv,avi,mov,ts}(FR-014 五容器,如 WMV/WebM)→ 不支持;
 * 3. 非法编码-容器组合(编码 ∉ {h264,hevc,mpeg4};hevc×avi;音频 ∉ {aac,ac3,eac3,dts})
 *    → 不支持(FR-014 不承诺非法组合);
 * 4. 视频兼容 = h264 且 8bit 且 yuv420p;音频兼容 = 无音轨或 aac;容器兼容 = mp4
 *    (HLS/浏览器渐进直放唯一容器);
 *    全兼容 → direct(mode=null,output h264/aac,不占额度);
 * 5. 4K/HDR 边界(高度 > budgets.conversion.targetHeightPx 或 hdr):仅尽力直放 ——
 *    需要重编码(视频或音频)即 PLAYBACK_FORMAT_UNSUPPORTED,绝不降分辨率转码;
 *    编码全兼容时容器不兼容仍可 remux(转封装保留原始编码,不是重编码);
 * 6. 仅音频不兼容(ac3/eac3/dts)→ audio_transcode(视频 copy,音频 aac;隐含容器重封装);
 * 7. 视频不兼容(hevc 8/10bit、mpeg4、非 yuv420p 等合法组合)→ video_transcode
 *    (h264 8bit yuv420p + aac/none;≤1080p 原分辨率保持,不自动降级)。
 */

/** 计划输入视频事实(与 conversion.spec ProbeVideoFacts 结构一致) */
export interface PlaybackPlanVideoFacts {
  readonly codec: string;
  readonly bitDepth: number;
  readonly pixFmt: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly hdr: boolean;
}

/** 计划输入轨道事实(与 conversion.spec tracks 元素结构一致) */
export interface PlaybackPlanTrackFact {
  readonly id: string;
  readonly kind: 'video' | 'audio' | 'subtitle';
  readonly codec: string;
}

/** 计划输入事实(与 conversion.spec ProbeFacts 结构一致;MediaProbeFacts 结构兼容) */
export interface PlaybackPlanInputFacts {
  readonly container: string;
  readonly durationSeconds: number;
  readonly video: PlaybackPlanVideoFacts | null;
  readonly audio: { readonly codec: string } | null;
  readonly tracks: readonly PlaybackPlanTrackFact[];
}

/** 计划结果:direct 时 mode=null(不建转换行、不占额度);remux 直通轨道 copy;静音 'none' */
export interface ConversionPlan {
  readonly delivery: 'direct' | 'remux' | 'audio_transcode' | 'video_transcode';
  readonly mode: PlaybackConversionMode | null;
  readonly outputVideoCodec: string;
  readonly outputAudioCodec: string;
  readonly reason: string;
}

export interface PlaybackPlanServiceDeps {
  readonly budgets: PlaybackBudgets;
}

/* ------------------------------------------------------------------ */
/* FR-014 合法矩阵(容器 × 编码)与输出目标常量                              */
/* ------------------------------------------------------------------ */

/** FR-014 五容器(范围外容器如 WMV/WebM 一律不支持) */
const SUPPORTED_CONTAINERS: readonly string[] = ['mp4', 'mkv', 'avi', 'mov', 'ts'];

/** 视频编码合法集(位深/像素格式的兼容判定另见视频兼容规则) */
const SUPPORTED_VIDEO_CODECS: readonly string[] = ['h264', 'hevc', 'mpeg4'];

/** 音频编码合法集 */
const SUPPORTED_AUDIO_CODECS: readonly string[] = ['aac', 'ac3', 'eac3', 'dts'];

/** 浏览器渐进直放唯一容器:MP4(HLS fMP4/TS 的直放语义由其余交付路径承载) */
const DIRECT_CONTAINER = 'mp4';

/** 统一保守输出目标(R1/FR-014;数值权威为 spec,预算文件只承载码率/分辨率目标) */
const OUTPUT_VIDEO_CODEC = 'h264';
const OUTPUT_AUDIO_CODEC = 'aac';
const COPY_CODEC = 'copy';
const NONE_CODEC = 'none';

/** 视频兼容判定:H.264 且 8bit 且 yuv420p(8-bit 4:2:0,浏览器可解码) */
function isVideoCompatible(video: PlaybackPlanVideoFacts): boolean {
  return video.codec === OUTPUT_VIDEO_CODEC && video.bitDepth === 8 && video.pixFmt === 'yuv420p';
}

/** 音频兼容判定:无音轨(静音合法)或 AAC */
function isAudioCompatible(audio: { readonly codec: string } | null): boolean {
  return audio === null || audio.codec === OUTPUT_AUDIO_CODEC;
}

/** FR-014 合法编码-容器组合:编码在集合内,且 hevc×avi 非法组合拒绝 */
function isLegalVideoContainerCombo(container: string, videoCodec: string): boolean {
  if (!SUPPORTED_VIDEO_CODECS.includes(videoCodec)) {
    return false;
  }
  if (videoCodec === 'hevc' && container === 'avi') {
    return false;
  }
  return true;
}

/**
 * 播放格式计划服务:probe 事实 → 交付方式与输出编码(纯函数 plan,无副作用)。
 */
@Injectable()
export class PlaybackPlanService {
  private readonly budgets: PlaybackBudgets;

  constructor(deps: PlaybackPlanServiceDeps) {
    this.budgets = deps.budgets;
  }

  plan(facts: PlaybackPlanInputFacts): PlaybackResult<ConversionPlan> {
    // 1. 无视频轨(纯音频输入)→ 超出本期影片播放语义,稳定失败
    const video = facts.video;
    if (video === null) {
      return planUnsupported('输入无视频轨,纯音频不在本期影片播放范围');
    }
    // 2. 容器矩阵(FR-014 五容器之外不支持)
    if (!SUPPORTED_CONTAINERS.includes(facts.container)) {
      return planUnsupported(`容器 ${facts.container} 不在 FR-014 支持矩阵内`);
    }
    // 3. 合法编码-容器组合(FR-014:非法组合不承诺可播放)
    const videoLegal = isLegalVideoContainerCombo(facts.container, video.codec);
    const audioLegal = facts.audio === null || SUPPORTED_AUDIO_CODECS.includes(facts.audio.codec);
    if (!videoLegal || !audioLegal) {
      return planUnsupported('视频/音频编码与容器的组合不在 FR-014 支持矩阵内');
    }

    const videoCompatible = isVideoCompatible(video);
    const audioCompatible = isAudioCompatible(facts.audio);
    const containerCompatible = facts.container === DIRECT_CONTAINER;
    const audioOutput = facts.audio === null ? NONE_CODEC : OUTPUT_AUDIO_CODEC;

    // 4. 全兼容(含容器)→ direct:mode=null 不建转换行、不占转换额度(FR-012/R4)
    if (videoCompatible && audioCompatible && containerCompatible) {
      return playbackOk({
        delivery: 'direct',
        mode: null,
        outputVideoCodec: OUTPUT_VIDEO_CODEC,
        outputAudioCodec: audioOutput,
        reason: '容器/视频/音频全部兼容,直接播放(不建转换任务、不占转换额度)',
      });
    }

    // 5. 4K/HDR 仅尽力直放:超过目标高度(不自动降分辨率)或 HDR 输入需要重编码的
    //    任何路径都稳定失败(R1:不能误当 SDR 转码处理;宁可失败也不降分辨率)
    const beyondBestEffort = video.hdr || video.heightPx > this.budgets.conversion.targetHeightPx;
    if (beyondBestEffort && (!videoCompatible || !audioCompatible)) {
      return planUnsupported('4K/HDR 仅尽力直接播放,本期不提供转换且不自动降分辨率');
    }

    // 6. 编码全兼容、仅容器不兼容 → remux:转封装保留原始编码(非重编码,4K/HDR 亦允许)
    if (videoCompatible && audioCompatible) {
      return playbackOk({
        delivery: 'remux',
        mode: 'remux',
        outputVideoCodec: COPY_CODEC,
        outputAudioCodec: facts.audio === null ? NONE_CODEC : COPY_CODEC,
        reason: '编码全兼容且容器不兼容,转封装保留原始音视频编码',
      });
    }

    // 7. 仅音频不兼容(AC-3/E-AC-3/DTS)→ audio_transcode:视频 copy 不重编码(FR-012
    //    仅转换必要轨道;隐含容器重封装,故 MKV+DTS 亦归此路径)
    if (videoCompatible && !audioCompatible) {
      return playbackOk({
        delivery: 'audio_transcode',
        mode: 'audio_transcode',
        outputVideoCodec: COPY_CODEC,
        outputAudioCodec: OUTPUT_AUDIO_CODEC,
        reason: '视频兼容且音频编码浏览器不兼容,仅转码音频为 AAC,视频直通复制',
      });
    }

    // 8. 视频不兼容(HEVC 8/10bit、MPEG-4、非 4:2:0 采样等合法组合)→ video_transcode:
    //    输出 H.264 8bit yuv420p + AAC;≤1080p 保持原分辨率,不自动降级(R4)
    return playbackOk({
      delivery: 'video_transcode',
      mode: 'video_transcode',
      outputVideoCodec: OUTPUT_VIDEO_CODEC,
      outputAudioCodec: audioOutput,
      reason: '视频编码/位深/像素格式浏览器不兼容,转换为 H.264 8bit yuv420p(保持原分辨率,不降级)',
    });
  }
}

/** 不支持稳定失败(码固定 PLAYBACK_FORMAT_UNSUPPORTED;detail 携带兼容原因) */
function planUnsupported(reason: string): PlaybackResult<never> {
  return playbackErr('PLAYBACK_FORMAT_UNSUPPORTED', reason);
}
