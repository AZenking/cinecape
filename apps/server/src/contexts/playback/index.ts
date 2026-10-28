/**
 * playback 发布面（R2：跨上下文 import 的唯一合法落点）。
 *
 * T020 grep 实测跨上下文消费面 = domain/playback.types 类型（settings 消费）；
 * 白名单：应用服务接口 + 注入令牌 + 跨上下文必需类型；实现类禁止导出。
 * 播放服务装配面（PlaybackModule providers/exports）为上下文内部 DI 图 +
 * 测试装配（app.get），不经本文件发布（T022/T023 再收口）。
 */
export type { PlaybackDelivery, PlaybackSessionState } from './domain/playback.types';
