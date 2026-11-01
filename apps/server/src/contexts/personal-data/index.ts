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
export type { ProgressSampleReply, ProgressSampleOutcome } from './application/progress-write.service';

// 010 T041:目标历史读取面(start-position / next-plan 共用;只读,不改静态写路径)。
// 函数为纯读实现(组合根直接绑定 TargetHistoryReaderPort);快照/事实/变更信号类型随
// 端口面发布,实现类不出发布面。
export type {
  TargetHistorySnapshot,
  TargetMediaFacts,
  TargetHistoryChangeSignal,
  TargetHistoryReaderPort,
} from './application/history.service';
export {
  readTargetHistory,
  readTargetMediaFacts,
  compareTargetHistoryRevision,
} from './application/history.service';

// 010 T056:连播偏好 GET/PATCH 应用用例(纯函数 + UnitOfWork 结构镜像;控制器消费)。
// 函数为纯实现(依赖经 VodPreferencesServiceDeps 注入,测试可换真实 uow + FakeClock);
// 幂等 scope/contextVersion 为服务端事实,发布面不暴露任何请求原始载荷类型。
export type {
  PreferenceUnitOfWork,
  VodPreferencesContext,
  VodPreferencesPatchCommand,
} from './application/vod-preferences.service';
export {
  getVodPreferences,
  patchVodPreferences,
  systemVodPreferencesDeps,
} from './application/vod-preferences.service';

// T022a 补面：Nest 装配入口（playback.module `imports:` 消费；contracts 允许经
// 「Nest module 的 exports 提供者」装配；属装配面而非 application/infrastructure 实现类）
export { PersonalDataModule } from './personal-data.module';
