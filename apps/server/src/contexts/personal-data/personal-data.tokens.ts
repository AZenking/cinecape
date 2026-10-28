/**
 * personal-data 注入令牌集中地（contracts §5）。
 *
 * 令牌面 = 跨上下文被消费的应用服务（T020 grep 实测消费清单）：
 * - ProgressClockService（类，playback.module 经 PersonalDataModule exports 注入 resolver
 *   装配桥；其端口形态 PlaybackProgressBindPort / PlaybackResumePositionPort 亦被
 *   playback-resolver.service 类型消费）；
 * - ProgressWriteService（类，playback.module lifecycle 装配 + playback.controller 注入；
 *   ProgressSampleReply 类型被 lifecycle / controller 消费）。
 *
 * 两服务为有状态 @Injectable 类（epoch 短事务分配 / 写入状态机），令牌绑定必须
 * useExisting 别名到既有类 provider（同一实例；useClass/useFactory 会产生第二实例，
 * 违反行为零变化）。
 */
export const PROGRESS_CLOCK_PORT = Symbol('PROGRESS_CLOCK_PORT');
export const PROGRESS_WRITE_PORT = Symbol('PROGRESS_WRITE_PORT');
