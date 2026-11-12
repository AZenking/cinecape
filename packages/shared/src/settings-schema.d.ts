/**
 * 013-role-differentiated-settings: 设置模块与个人偏好共享数据契约
 */

export type SettingsScope = 'personal' | 'household_admin' | 'system_admin';

export interface SettingsNavModule {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly scope: SettingsScope;
  readonly iconName?: string;
  readonly description?: string;
}

export interface SettingsNavGroup {
  readonly key: string;
  readonly label: string;
  readonly scope: SettingsScope;
  readonly modules: readonly SettingsNavModule[];
}

export interface ProfilePreferences {
  readonly defaultAudioLanguage: string;
  readonly defaultSubtitleLanguage: string;
  readonly autoPlayNext: boolean;
  readonly themeMode: 'system' | 'dark' | 'light';
  readonly posterDensity: 'comfortable' | 'compact';
}

/**
 * 017-channel-centric-architecture: 管理后台频道资产工作台 DTO (contracts/admin-workbench-api.md)
 */

export interface ChannelWorkbenchLine {
  readonly lineId: string;
  readonly label: string;
  readonly sourceName: string;
  readonly priority: number;
}

export interface ChannelWorkbenchEpgBinding {
  readonly mode: 'auto' | 'manual';
  readonly isLocked?: boolean;
  readonly epgSourceId?: string | null;
  readonly epgSourceName?: string | null;
  readonly xmltvChannelId?: string | null;
  readonly epgChannelDisplayName?: string | null;
  readonly effectiveMatchMode?: string;
  readonly version?: number;
  readonly status?: 'auto' | 'valid' | 'invalid';
  readonly invalidReason?: string | null;
}

export interface ChannelWorkbenchItem {
  readonly id: string;
  readonly title: string;
  readonly type: 'channel';
  readonly logoUrl?: string | null;
  readonly category?: string | null;
  readonly lineCount: number;
  readonly lines?: readonly ChannelWorkbenchLine[];
  readonly epgBinding?: ChannelWorkbenchEpgBinding | null;
  readonly available?: boolean;
  readonly version?: number;
}

export interface ChannelWorkbenchPage {
  readonly items: readonly ChannelWorkbenchItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface SaveManualBindingRequest {
  readonly expectedVersion: number;
  readonly epgSourceId: string;
  readonly xmltvChannelId: string;
}

export interface ClearManualBindingRequest {
  readonly expectedVersion: number;
}

export interface ManualBindingMutationReply {
  readonly mediaId: string;
  readonly mode: 'manual' | 'auto';
  readonly epgSourceId: string | null;
  readonly xmltvChannelId: string | null;
  readonly version: number;
  readonly updatedAt: string;
}
