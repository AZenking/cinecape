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
