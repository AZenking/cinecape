/**
 * US8 设置模块的 typed API 层(全部经统一 privateFetch;凭据档位 same-origin)。
 * DTO 形状与 contracts/api.md §6 / openapi components 一致(仅本特性使用,
 * 不替换 @hmp/shared 契约类型 —— 共享包未收录的 005 管理投影在此就地声明)。
 */
import { privateFetch } from '../../../shared/fetch';
import type { FetchApiError } from '../../../shared/fetch';

/** 契约 AccountSummary */
export interface AccountSummary {
  id: string;
  username: string;
  role: 'owner' | 'admin';
}

/** 契约 HouseholdSettings */
export interface HouseholdSettings {
  name: string;
  language: string;
  timezone: string;
  version: number;
  mainProfileVersion: number;
}

/** 契约 B001ProfileDto(ProfileSummary) */
export interface ProfileSummary {
  id: string;
  name: string;
  avatar: string | null;
  type: 'adult' | 'child';
  isDefault: boolean;
  isMain: boolean;
  pinProtected: boolean;
  status: 'active' | 'disabled';
  createdAt: string;
  version: number;
}

/** 契约 PolicyDto(002 继承) */
export interface PolicyDto {
  profileId: string;
  maxContentLevel: number;
  allowUnrated: boolean;
  allowedMediaIds: string[];
  blockedMediaIds: string[];
  allowedChannelIds: string[];
  version: number;
  updatedAt: string;
}

/** 契约 SourceDto(003 继承;locationLabel 为脱敏主机/rootKey) */
export interface SourceDto {
  id: string;
  kind: 'iptv' | 'epg' | 'nas';
  name: string;
  enabled: boolean;
  version: number;
  epgSourceId: string | null;
  locationLabel: string;
  lastSuccessAt: string | null;
  lastJobId: string | null;
}

export interface SourcePageDto {
  items: SourceDto[];
  page: number;
  pageSize: number;
  total: number;
}

/** 契约 RefreshDto */
export interface RefreshDto {
  id: string;
  sourceId: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'succeeded'
    | 'failed'
    | 'interrupted'
    | 'discarded'
    | 'expired'
    | 'stale';
  version: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  counts: { added: number; updated: number; missing: number; failed: number; channels: number; programmes: number };
  confirmationReason: string | null;
  errorCode: string | null;
}

/** 契约 RootDto */
export interface RootDto {
  rootKey: string;
  label: string;
}

/** 契约 CandidateDto / CandidatePageDto */
export interface CandidateDto {
  id: string;
  type: 'channel' | 'movie' | 'series' | 'episode' | 'video';
  title: string;
  description: string | null;
  contentLevel: number | null;
  poster: string | null;
  version: number;
  available: boolean;
}

export interface CandidatePageDto {
  items: CandidateDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** 契约 EpgBindingDto */
export interface EpgBindingDto {
  mediaId: string;
  mode: 'manual' | 'auto';
  version: number;
  epgSourceId: string | null;
  xmltvChannelId: string | null;
  status: 'valid' | 'invalid' | 'auto';
  invalidReason: string | null;
}

/** 契约 EpgCandidate */
export interface EpgCandidate {
  xmltvChannelId: string;
  displayName: string;
  current: { title: string; description: string | null; startsAt: string; endsAt: string } | null;
  next: { title: string; description: string | null; startsAt: string; endsAt: string } | null;
}

export interface EpgCandidatePageDto {
  items: EpgCandidate[];
  total: number;
  page: number;
  pageSize: number;
  epgGeneration: number;
}

/** 契约 DeviceDto */
export interface DeviceDto {
  id: string;
  name: string | null;
  type: 'web' | 'mobile' | 'tv' | 'nas' | 'other';
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const settingsApi = {
  // account
  getAccount: (): Promise<AccountSummary> => privateFetch<AccountSummary>('/settings/account'),
  changePassword: (ownerPassword: string, newPassword: string): Promise<void> =>
    privateFetch<void>('/settings/account/password', { method: 'PUT', body: { ownerPassword, newPassword } }),
  // household
  getHousehold: (): Promise<HouseholdSettings> => privateFetch<HouseholdSettings>('/settings/household'),
  patchHousehold: (input: {
    expectedVersion: number;
    ownerPassword: string;
    name?: string;
    language?: string;
    timezone?: string;
  }): Promise<HouseholdSettings> => privateFetch<HouseholdSettings>('/settings/household', { method: 'PATCH', body: input }),
  // profiles
  listProfiles: (): Promise<ProfileSummary[]> => privateFetch<ProfileSummary[]>('/settings/profiles'),
  createProfile: (input: {
    ownerPassword: string;
    name: string;
    type: 'adult' | 'child';
    avatar?: string;
    isDefault?: boolean;
    pin?: string;
  }): Promise<ProfileSummary> => privateFetch<ProfileSummary>('/settings/profiles', { method: 'POST', body: input }),
  patchProfile: (
    profileId: string,
    input: {
      expectedVersion: number;
      ownerPassword: string;
      name?: string;
      avatar?: string;
      isDefault?: boolean;
      status?: 'active' | 'disabled';
      pin?: string;
      clearPin?: boolean;
    },
  ): Promise<ProfileSummary> => privateFetch<ProfileSummary>(`/settings/profiles/${profileId}`, { method: 'PATCH', body: input }),
  transferMainProfile: (input: {
    profileId: string;
    expectedVersion: number;
    expectedCurrentProfileVersion: number;
    expectedProfileVersion: number;
    ownerPassword: string;
  }): Promise<{ mainProfileId: string; mainProfileVersion: number }> =>
    privateFetch<{ mainProfileId: string; mainProfileVersion: number }>('/settings/main-profile', { method: 'PUT', body: input }),
  // policy
  getPolicy: (profileId: string): Promise<PolicyDto> =>
    privateFetch<PolicyDto>(`/settings/profiles/${profileId}/policy`),
  updatePolicy: (
    profileId: string,
    input: { ownerPassword: string; expectedVersion: number; policy: { maxContentLevel: number; allowUnrated: boolean } },
  ): Promise<PolicyDto> => privateFetch<PolicyDto>(`/settings/profiles/${profileId}/policy`, { method: 'PUT', body: input }),
  replacePolicyLists: (
    profileId: string,
    input: {
      ownerPassword: string;
      expectedVersion: number;
      allowedMediaIds: string[];
      blockedMediaIds: string[];
      allowedChannelIds: string[];
    },
  ): Promise<PolicyDto> => privateFetch<PolicyDto>(`/settings/profiles/${profileId}/policy/lists`, { method: 'PUT', body: input }),
  // sources
  listSources: (): Promise<SourcePageDto> => privateFetch<SourcePageDto>('/settings/sources'),
  listRoots: (): Promise<RootDto[]> => privateFetch<RootDto[]>('/settings/source-roots'),
  createSource: (input: Record<string, unknown>): Promise<SourceDto> =>
    privateFetch<SourceDto>('/settings/sources', { method: 'POST', body: input }),
  patchSource: (sourceId: string, input: Record<string, unknown>): Promise<SourceDto> =>
    privateFetch<SourceDto>(`/settings/sources/${sourceId}`, { method: 'PATCH', body: input }),
  startRefresh: (sourceId: string, input: { ownerPassword: string; expectedVersion: number; operationKey: string }): Promise<RefreshDto> =>
    privateFetch<RefreshDto>(`/settings/sources/${sourceId}/refresh`, { method: 'POST', body: input }),
  getRefresh: (refreshId: string): Promise<RefreshDto> => privateFetch<RefreshDto>(`/settings/refreshes/${refreshId}`),
  confirmRefresh: (refreshId: string, ownerPassword: string, expectedVersion: number): Promise<RefreshDto> =>
    privateFetch<RefreshDto>(`/settings/refreshes/${refreshId}/confirm`, { method: 'POST', body: { ownerPassword, expectedVersion } }),
  discardRefresh: (refreshId: string, ownerPassword: string, expectedVersion: number): Promise<RefreshDto> =>
    privateFetch<RefreshDto>(`/settings/refreshes/${refreshId}/discard`, { method: 'POST', body: { ownerPassword, expectedVersion } }),
  // catalog
  queryCandidates: (input: {
    ownerPassword: string;
    q?: string;
    type?: 'channel' | 'movie' | 'series' | 'episode' | 'video';
    page?: number;
    pageSize?: number;
  }): Promise<CandidatePageDto> =>
    privateFetch<CandidatePageDto>('/settings/catalog/candidates/query', { method: 'POST', body: input }),
  patchMedia: (mediaId: string, input: { ownerPassword: string; expectedVersion: number } & Record<string, unknown>): Promise<CandidateDto> =>
    privateFetch<CandidateDto>(`/settings/catalog/media/${mediaId}`, { method: 'PATCH', body: input }),
  // epg binding
  queryBinding: (mediaId: string, ownerPassword: string): Promise<EpgBindingDto> =>
    privateFetch<EpgBindingDto>(`/settings/catalog/media/${mediaId}/epg-binding/query`, { method: 'POST', body: { ownerPassword } }),
  queryEpgCandidates: (
    mediaId: string,
    input: { ownerPassword: string; epgSourceId: string; q?: string; page?: number; pageSize?: number },
  ): Promise<EpgCandidatePageDto> =>
    privateFetch<EpgCandidatePageDto>(`/settings/catalog/media/${mediaId}/epg-candidates/query`, { method: 'POST', body: input }),
  saveBinding: (
    mediaId: string,
    input: {
      ownerPassword: string;
      expectedVersion: number;
      mode: 'manual';
      epgSourceId: string;
      xmltvChannelId: string;
      expectedEpgGeneration: number;
    },
  ): Promise<EpgBindingDto> =>
    privateFetch<EpgBindingDto>(`/settings/catalog/media/${mediaId}/epg-binding`, { method: 'PUT', body: input }),
  unbindBinding: (mediaId: string, input: { ownerPassword: string; expectedVersion: number; mode: 'auto' }): Promise<EpgBindingDto> =>
    privateFetch<EpgBindingDto>(`/settings/catalog/media/${mediaId}/epg-binding`, { method: 'PUT', body: input }),
  // devices
  listDevices: (): Promise<DeviceDto[]> => privateFetch<DeviceDto[]>('/settings/devices'),
  revokeDevice: (deviceId: string, ownerPassword: string): Promise<void> =>
    privateFetch<void>(`/settings/devices/${deviceId}/revoke`, { method: 'POST', body: { ownerPassword } }),
  queryPlaybackRecords: (
    deviceId: string,
    input: { ownerPassword: string; cursor?: string; limit?: number },
  ): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }> =>
    privateFetch<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(
      `/settings/devices/${deviceId}/playback-records/query`,
      { method: 'POST', body: input },
    ),
};

/** 从 FetchApiError 取人类可读文案(稳定 detail 优先) */
export function errorTextOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'detail' in error) {
    const fetchError = error as FetchApiError;
    return fetchError.detail ?? fetchError.title ?? '操作失败,请重试';
  }
  return '操作失败,请重试';
}
