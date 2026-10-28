/**
 * playback 注入令牌集中地。
 *
 * 本上下文服务装配面（PlaybackModule providers/exports）以类 token 为主
 * （PlaybackRepository / 各服务类，见 playback.module.ts 头注释的 DI 选择说明）；
 * 上下文根历史上面向跨上下文消费的令牌均为类 token，无独立符号令牌文件，
 * 008-T013 起本文件承载新增符号令牌。
 */

/** 008 仓储端口装配令牌（ADR-0015 D1）：playback.module 装配期绑定 Drizzle 实现到 seam。 */
export const PLAYBACK_STORE = Symbol('PLAYBACK_STORE');
