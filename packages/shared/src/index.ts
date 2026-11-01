export * from './constants';
export type { paths, components, operations } from './schema';
// 阶段 2 契约类型(独立生成产物 policy-schema.d.ts;001 schema.d.ts 保持不变)
import type { components as policyComponents } from './policy-schema';

/** 002 contracts/openapi.yaml components/schemas/PolicyDto */
export type PolicyDto = policyComponents['schemas']['PolicyDto'];
/** 002 contracts/openapi.yaml components/schemas/PolicyEditable(阶段 2 可编辑配置) */
export type PolicyEditable = policyComponents['schemas']['PolicyEditable'];
/** 002 contracts/openapi.yaml components/schemas/UpdatePolicyRequest */
export type UpdatePolicyRequest = policyComponents['schemas']['UpdatePolicyRequest'];
// 阶段 3 契约类型(独立生成产物 catalog-schema.d.ts;001/002 schema.d.ts 保持不变)
import type { components as catalogComponents } from './catalog-schema';

/** 003 contracts/openapi.yaml components/schemas/Source */
export type SourceDto = catalogComponents['schemas']['Source'];
/** 003 contracts/openapi.yaml components/schemas/SourcePage */
export type SourcePageDto = catalogComponents['schemas']['SourcePage'];
/** 003 contracts/openapi.yaml components/schemas/CreateSource */
export type CreateSourceRequest = catalogComponents['schemas']['CreateSource'];
/** 003 contracts/openapi.yaml components/schemas/PatchSource */
export type PatchSourceRequest = catalogComponents['schemas']['PatchSource'];
/** 003 contracts/openapi.yaml components/schemas/Refresh */
export type RefreshDto = catalogComponents['schemas']['Refresh'];
/** 003 contracts/openapi.yaml components/schemas/Media */
export type MediaDto = catalogComponents['schemas']['Media'];
/** 003 contracts/openapi.yaml components/schemas/MediaPage */
export type MediaPageDto = catalogComponents['schemas']['MediaPage'];
/** 003 contracts/openapi.yaml components/schemas/Programmes */
export type ProgrammesDto = catalogComponents['schemas']['Programmes'];
/** 003 contracts/openapi.yaml components/schemas/Candidate */
export type CandidateDto = catalogComponents['schemas']['Candidate'];
/** 003 contracts/openapi.yaml components/schemas/CandidatePage */
export type CandidatePageDto = catalogComponents['schemas']['CandidatePage'];
/** 003 contracts/openapi.yaml components/schemas/CandidateQuery */
export type CandidateQueryRequest = catalogComponents['schemas']['CandidateQuery'];
/** 003 contracts/openapi.yaml components/schemas/PatchMedia */
export type PatchMediaRequest = catalogComponents['schemas']['PatchMedia'];
/** 003 contracts/openapi.yaml components/schemas/UpdateLists */
export type UpdateListsRequest = catalogComponents['schemas']['UpdateLists'];
/** 003 contracts/openapi.yaml components/schemas/RefreshRequest */
export type RefreshRequest = catalogComponents['schemas']['RefreshRequest'];
/** 003 contracts/openapi.yaml components/schemas/JobAction */
export type JobAction = catalogComponents['schemas']['JobAction'];
/** 003 contracts/openapi.yaml components/schemas/Programme */
export type ProgrammeDto = catalogComponents['schemas']['Programme'];
/** 003 contracts/openapi.yaml components/schemas/Root */
export type RootDto = catalogComponents['schemas']['Root'];
// US5 手动 EPG 绑定增补(T071;ADR-0008,2026-10-24 契约节)
/** 003 contracts/openapi.yaml components/schemas/EpgBinding(manual 绑定管理读取/写入响应) */
export type EpgBindingDto = catalogComponents['schemas']['EpgBinding'];
/** 003 contracts/openapi.yaml components/schemas/BindingQuery */
export type EpgBindingQueryRequest = catalogComponents['schemas']['BindingQuery'];
/** 003 contracts/openapi.yaml components/schemas/EpgCandidate */
export type EpgCandidateDto = catalogComponents['schemas']['EpgCandidate'];
/** 003 contracts/openapi.yaml components/schemas/EpgCandidatePage */
export type EpgCandidatePageDto = catalogComponents['schemas']['EpgCandidatePage'];
/** 003 contracts/openapi.yaml components/schemas/EpgCandidateQuery */
export type EpgCandidateQueryRequest = catalogComponents['schemas']['EpgCandidateQuery'];
/** 003 contracts/openapi.yaml components/schemas/UpdateEpgBinding */
export type UpdateEpgBindingRequest = catalogComponents['schemas']['UpdateEpgBinding'];
// 阶段 4 契约类型(独立生成产物 playback-schema.d.ts;001/002/003 schema 保持不变)
// paths/operations 聚合导出仍以 001 schema.d.ts 为准(既有模式);此处仅按需暴露 components 别名
import type { components as playbackComponents } from './playback-schema';

/** 004 contracts/openapi.yaml components/schemas/PlaybackDto */
export type PlaybackDto = playbackComponents['schemas']['PlaybackDto'];
/** 004 contracts/openapi.yaml components/schemas/TicketReply */
export type TicketReply = playbackComponents['schemas']['TicketReply'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackTracks */
export type PlaybackTracks = playbackComponents['schemas']['PlaybackTracks'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackTrackAudio */
export type TrackAudio = playbackComponents['schemas']['PlaybackTrackAudio'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackTrackSubtitle */
export type TrackSubtitle = playbackComponents['schemas']['PlaybackTrackSubtitle'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackSessionState */
export type PlaybackSessionState = playbackComponents['schemas']['PlaybackSessionState'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackDelivery */
export type PlaybackDelivery = playbackComponents['schemas']['PlaybackDelivery'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackRecordPage */
export type PlaybackRecordPage = playbackComponents['schemas']['PlaybackRecordPage'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackRecordItem */
export type PlaybackRecordItem = playbackComponents['schemas']['PlaybackRecordItem'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackSessionRecord */
export type PlaybackSessionRecord = playbackComponents['schemas']['PlaybackSessionRecord'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackFailureRecord */
export type PlaybackFailureRecord = playbackComponents['schemas']['PlaybackFailureRecord'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackResolveRequest */
export type ResolvePlaybackRequest = playbackComponents['schemas']['PlaybackResolveRequest'];
/** 004 contracts/openapi.yaml components/schemas/RenewTicketRequest */
export type RenewPlaybackRequest = playbackComponents['schemas']['RenewTicketRequest'];
/** 004 contracts/openapi.yaml components/schemas/HeartbeatRequest */
export type HeartbeatPlaybackRequest = playbackComponents['schemas']['HeartbeatRequest'];
/** 004 contracts/openapi.yaml components/schemas/SelectionRequest */
export type SelectionPlaybackRequest = playbackComponents['schemas']['SelectionRequest'];
/** 004 contracts/openapi.yaml components/schemas/SeekRequest */
export type SeekPlaybackRequest = playbackComponents['schemas']['SeekRequest'];
/** 004 contracts/openapi.yaml components/schemas/PlaybackRecordQueryRequest */
export type RecordQueryRequest = playbackComponents['schemas']['PlaybackRecordQueryRequest'];
// 阶段 5 契约类型(独立生成产物 experience-schema.d.ts;001~004 schema 保持不变)
// paths/operations 聚合导出仍以 001 schema.d.ts 为准(既有模式);此处仅按需暴露 components 别名
import type { components as experienceComponents } from './experience-schema';

/** 005 contracts/openapi.yaml components/schemas/Problem(统一错误 envelope,api.md §7) */
export type ProblemDto = experienceComponents['schemas']['Problem'];
/** 005 contracts/openapi.yaml components/schemas/Initialized */
export type InitializedDto = experienceComponents['schemas']['Initialized'];
/** 005 contracts/openapi.yaml components/schemas/PublicContext(公共上下文白名单投影) */
export type PublicContextDto = experienceComponents['schemas']['PublicContext'];
/** 005 contracts/openapi.yaml components/schemas/PublicMedia(公共媒体白名单投影) */
export type PublicMediaDto = experienceComponents['schemas']['PublicMedia'];
/** 005 contracts/openapi.yaml components/schemas/PublicMediaPage */
export type PublicMediaPageDto = experienceComponents['schemas']['PublicMediaPage'];
/** 005 contracts/openapi.yaml components/schemas/Programme(005 直播节目,区别于 003 ProgrammeDto) */
export type ExperienceProgrammeDto = experienceComponents['schemas']['Programme'];
/** 005 contracts/openapi.yaml components/schemas/Programmes(005 频道节目快照,区别于 003 ProgrammesDto) */
export type ExperienceProgrammesDto = experienceComponents['schemas']['Programmes'];
/** 005 contracts/openapi.yaml components/schemas/Group(来源主分组,不透明 groupKey) */
export type GroupDto = experienceComponents['schemas']['Group'];
/** 005 contracts/openapi.yaml components/schemas/GroupPage */
export type GroupPageDto = experienceComponents['schemas']['GroupPage'];
/** 005 contracts/openapi.yaml components/schemas/ChannelRow */
export type ChannelRowDto = experienceComponents['schemas']['ChannelRow'];
/** 005 contracts/openapi.yaml components/schemas/ChannelPage */
export type ChannelPageDto = experienceComponents['schemas']['ChannelPage'];
/** 005 contracts/openapi.yaml components/schemas/GuideChannel(EPG 墙频道行) */
export type GuideChannelDto = experienceComponents['schemas']['GuideChannel'];
/** 005 contracts/openapi.yaml components/schemas/GuideWindow(EPG 墙节目窗口) */
export type GuideWindowDto = experienceComponents['schemas']['GuideWindow'];
/** 005 contracts/openapi.yaml components/schemas/BootstrapProfileRequest(零档案首建) */
export type BootstrapProfileRequest = experienceComponents['schemas']['BootstrapProfileRequest'];
/** 005 contracts/openapi.yaml components/schemas/PinRecoveryRequest(主档案 PIN 窄用途恢复) */
export type PinRecoveryRequest = experienceComponents['schemas']['PinRecoveryRequest'];
/** 005 contracts/openapi.yaml components/schemas/SettingsUnlockRequest */
export type SettingsUnlockRequest = experienceComponents['schemas']['SettingsUnlockRequest'];
/** 005 contracts/openapi.yaml components/schemas/SettingsAccess */
export type SettingsAccessDto = experienceComponents['schemas']['SettingsAccess'];
/** 005 contracts/openapi.yaml components/schemas/AccountSummary(账号最小摘要,无 PIN hash/设置主体) */
export type AccountSummaryDto = experienceComponents['schemas']['AccountSummary'];
/** 005 contracts/openapi.yaml components/schemas/PasswordChangeRequest */
export type PasswordChangeRequest = experienceComponents['schemas']['PasswordChangeRequest'];
/** 005 contracts/openapi.yaml components/schemas/HouseholdSettings */
export type HouseholdSettingsDto = experienceComponents['schemas']['HouseholdSettings'];
/** 005 contracts/openapi.yaml components/schemas/PatchHouseholdRequest */
export type PatchHouseholdRequest = experienceComponents['schemas']['PatchHouseholdRequest'];
/** 005 contracts/openapi.yaml components/schemas/MainProfileRequest */
export type MainProfileRequest = experienceComponents['schemas']['MainProfileRequest'];
/** 005 contracts/openapi.yaml components/schemas/MainProfileReply */
export type MainProfileReplyDto = experienceComponents['schemas']['MainProfileReply'];
/** 005 contracts/openapi.yaml components/schemas/OwnerPasswordRequest */
export type OwnerPasswordRequest = experienceComponents['schemas']['OwnerPasswordRequest'];
/** 005 contracts/openapi.yaml components/schemas/FavoriteItem */
export type FavoriteItemDto = experienceComponents['schemas']['FavoriteItem'];
/** 005 contracts/openapi.yaml components/schemas/HistoryItem */
export type HistoryItemDto = experienceComponents['schemas']['HistoryItem'];
/** 005 contracts/openapi.yaml components/schemas/FavoritePage */
export type FavoritePageDto = experienceComponents['schemas']['FavoritePage'];
/** 005 contracts/openapi.yaml components/schemas/HistoryPage */
export type HistoryPageDto = experienceComponents['schemas']['HistoryPage'];
/** 005 contracts/openapi.yaml components/schemas/ProgressSample(个人进度采样上报) */
export type ProgressSampleRequest = experienceComponents['schemas']['ProgressSample'];
/** 005 contracts/openapi.yaml components/schemas/FinalProgress(终态进度上报) */
export type FinalProgressRequest = experienceComponents['schemas']['FinalProgress'];
/** 005 contracts/openapi.yaml components/schemas/ProgressResult(进度写入结果) */
export type ProgressResultDto = experienceComponents['schemas']['ProgressResult'];
/** 005 contracts/openapi.yaml components/schemas/ResolveRequest(统一受控播放解析,区别于 004 ResolvePlaybackRequest) */
export type ResolveRequest = experienceComponents['schemas']['ResolveRequest'];
/** 005 contracts/openapi.yaml components/schemas/StopRequest(含 finalProgress 的停止请求) */
export type StopRequest = experienceComponents['schemas']['StopRequest'];
/** 005 contracts/openapi.yaml components/schemas/Empty */
export type EmptyDto = experienceComponents['schemas']['Empty'];
// 010 在线点播契约类型(独立生成产物 vod-schema.d.ts;001~005 schema 保持不变)
// paths/operations 聚合导出仍以 001 schema.d.ts 为准(既有模式);010 多个 schema 与
// 003/004/005 同名(PlaybackDto/Source/HistoryItem/PublicMedia/StopRequest 等),
// 不逐个别名倒出以免冲突,统一以 Vod 命名空间入口暴露,
// 下游经 `Vod.components['schemas']['Xxx']` / `Vod.paths['/public/vod/...']` 取用
export type * as Vod from './vod-schema';
