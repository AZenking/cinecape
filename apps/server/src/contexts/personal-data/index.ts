/**
 * personal-data 发布面（R2：跨上下文 import 的唯一合法落点）。
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型；实现类禁止导出
 * （ProgressClockService / ProgressWriteService 实例经模块令牌 exports 提供）。
 */
export type { IProgressClockService, IProgressWriteService } from './application/ports';
export { PROGRESS_CLOCK_PORT, PROGRESS_WRITE_PORT } from './personal-data.tokens';

// —— 跨上下文消费的类型与装配注册函数（T020 grep 实测消费清单）——
export type {
  PlaybackProgressBindPort,
  PlaybackResumePositionPort,
} from './application/progress-clock.service';
export { registerPersonalPlaybackFactsPort } from './application/progress-clock.service';
export type { ProgressSampleReply } from './application/progress-write.service';
