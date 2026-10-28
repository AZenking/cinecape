/**
 * personal-data 发布面接口（contracts 白名单：应用服务接口 + 令牌 + 跨上下文类型）。
 * 方法签名与实现逐字一致：IProgressClockService 直接扩展既有端口接口（实现类已
 * implements 同一组端口，签名同源）；IProgressWriteService 从类公开方法逐字提取。
 * 本文件位于 application 层：实现类经同层 import 加 implements 子句（R1b 允许）。
 */
import type { PlaybackProgressBindPort, PlaybackResumePositionPort } from './progress-clock.service';
import type { ProgressSampleInput, ProgressSampleReply } from './progress-write.service';

/** ProgressClockService 发布面（消费方：playback resolver 装配桥；端口形态同源扩展。
 *  信任时长 PersonalPlaybackFactsPort 不在类上 —— 经 registerPersonalPlaybackFactsPort 注册表提供） */
export type IProgressClockService = PlaybackProgressBindPort & PlaybackResumePositionPort;

/** ProgressWriteService 发布面（消费方：playback.controller progress 面与 stop final 协作） */
export interface IProgressWriteService {
  applySample(
    context: { readonly householdId: string; readonly deviceSessionId: string; readonly sessionId: string },
    input: ProgressSampleInput,
  ): ProgressSampleReply;
  applyFinalInTransaction(input: {
    readonly householdId: string;
    readonly sessionId: string;
    readonly at: string;
    readonly final: { readonly sampleSeq: number; readonly expectedGeneration: number; readonly positionSeconds: number };
  }): ProgressSampleReply | null;
}
