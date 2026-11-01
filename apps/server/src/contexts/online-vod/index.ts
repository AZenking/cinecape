/**
 * online-vod 发布面（R2：跨上下文 import 的唯一合法落点；010 T006 骨架）。
 *
 * 白名单（随各任务扩充，仅接口/令牌/纯类型，禁止导出实现类或私表模型）：
 * - Nest 装配入口 OnlineVodModule（组合根 imports 消费，对齐 SourcesModule 惯例）；
 * - 注入令牌（online-vod.tokens.ts）。
 *
 * 端口接口文件由后续任务各自创建并在此再导出：
 * T015 publication-work-set.port / T019 vod-budgets / T025 provider-model /
 * T042 location.port / T055 episode-sequence / T070 source-match.rules。
 * 骨架阶段不预创建，避免与任务文件所有权冲突（T027 online-vod-store.port 已落地）。
 */
export { OnlineVodModule } from './online-vod.module';
export {
  ONLINE_VOD_LOCATION_PORT,
  ONLINE_VOD_PROVIDER_PORT,
  ONLINE_VOD_PUBLICATION_PARTICIPANT,
  ONLINE_VOD_STORE,
  // 010 T072(US4):VodCache 有界缓存单例令牌跨上下文发布(playback.module 装配
  // transition 换源候选匹配结论读面;同模块 exports 面同步放开 —— 模块装配 seam,
  // 仅令牌,非实现类)
  VOD_CACHE,
} from './online-vod.tokens';
// T027:非事务读面仓储端口类型（type-only；实现类/语句面不出发布面）
export type { OnlineVodStore } from './application/online-vod-store.port';
// T042:定位端口类型（type-only；ResolvedVodInput 为 playback 私有值对象，
// 入口 URL 字段仅经受控交付面消费，绝不进入公共 DTO/日志；实现类不出发布面）
export type {
  OnlineVodLocationPort,
  ResolvedVodInput,
  VodInputBindingSink,
  VodLocationCommand,
  VodLocationExpectedRevisions,
  VodPrivateLocator,
  VodResolvedInputFacts,
  VodStartBasis,
} from './application/location.port';
// T043:起点裁决纯函数(「唯一权威起点语义」;T041 StartPointAdjudicatorPort 结构
// 相容 —— playback 组合根经本发布面注入绑定,R2 跨上下文唯一合法落点;纯函数无 I/O,
// 实现类仍不出发布面)
export { resolveStartPoint } from './application/continuity.service';
// 010 T046:候选续播判定纯函数(personal-data vod-history.service 消费;T039 probe 前
// 候选形态 —— canAttemptResume 仅为候选资格,最终资格在本次 resolve/probe 后判定;
// 'unavailable' 由接口层投影,本函数不产出;同 resolveStartPoint 先例,纯函数无 I/O,
// 实现类仍不出发布面)
export { canAttemptResumeCandidate } from './application/continuity.service';
export type {
  ResumeCandidateFacts,
  ResumeCandidateReason,
  ResumeCandidateVerdict,
} from './application/continuity.service';
// T055:独立导航序列(纯规则面 + 发布/导航查询;playback T059/T060 创建 next 计划时
// 固定 sequenceRevision/detailRevision 两者消费 —— data-model §3;序列事实判定在
// domain 规则层,本发布面只导出纯函数与纯类型,store/participant 实现类不出发布面)
export {
  buildSequence,
  computeLineNext,
  computeNextEpisode,
  sameNavigationSnapshot,
} from './domain/episode-sequence.rules';
export type {
  NextEpisodeBlockReason,
  NextEpisodeOutcome,
  SequenceEpisodeInput,
  SequenceEpisodeRow,
  SequenceFacts,
  SequenceLineFacts,
  SequenceLineInput,
  SequenceLineUnsupportedReason,
  SequenceSnapshotMember,
  SequenceStatus,
} from './domain/episode-sequence.rules';
export { nextEpisodeFor, publishSequence } from './application/episode-sequence.service';
export type {
  EpisodeSequenceRowWithKey,
  NextEpisodeForInput,
  PublishSequenceEpisodeFacts,
  PublishSequenceInput,
  PublishSequenceLineFacts,
  PublishSequenceOutcome,
  SequenceNavigationStore,
  SequencePublicationStore,
} from './application/episode-sequence.service';
// T070:换源候选匹配规则(纯领域;匹配面/授权面分离——结论恒钉版,确认只经
// carryPositionEligibility 解锁 intent 提交,不改写匹配等级;US4 候选/测速与 T072
// intent 消费;纯函数无 I/O,实现类不出发布面)
export {
  MATCH_RULE_VERSION,
  SWITCH_CANDIDATE_TTL_MS,
  candidateIdentityKey,
  carryPositionEligibility,
  isMatchConclusionCurrent,
  isSwitchCandidateFresh,
  matchCandidate,
} from './domain/source-match.rules';
export type {
  CandidateFacts,
  CarryPositionEligibility,
  MatchConclusion,
  MatchConfidence,
  MatchFacts,
  MatchReason,
  SourceTitleFacts,
} from './domain/source-match.rules';
