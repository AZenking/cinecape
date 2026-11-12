/**
 * 013 个人偏好 GET/PUT 应用用例(纯函数模块)。
 *
 * 契约来源(settings-contracts.md §2.1;ADR-0017 个人偏好零门禁):
 * - GET /api/profile/preferences → 200 ProfilePreferences;未有行返回传输默认值
 *   (zh/zh/true/system/comfortable,零写入);
 * - PUT /api/profile/preferences(部分字段提交合法,合并语义)→ 200 更新后的完整快照;
 *   身份键全部由控制器守卫链(SessionGuard→CurrentProfileGuard)推导后传入,
 *   本文件不接触任何请求原始载荷;严格绑定当前 profile_id,零 PIN/密码/Ticket 阻断。
 */
import type { ProfilePreferencesPatch } from '@contexts/personal-data/infrastructure/profile-preferences.store';
import {
  findProfilePreferencesRow,
  upsertProfilePreferencesRow,
} from '@contexts/personal-data/infrastructure/profile-preferences.store';

/** 契约 ProfilePreferences(与 @hmp/shared settings-schema.d.ts 同形;camelCase 投影) */
export interface ProfilePreferencesSnapshot {
  defaultAudioLanguage: string;
  defaultSubtitleLanguage: string;
  autoPlayNext: boolean;
  themeMode: 'system' | 'dark' | 'light';
  posterDensity: 'comfortable' | 'compact';
}

export const PROFILE_PREFERENCES_DEFAULTS: ProfilePreferencesSnapshot = {
  defaultAudioLanguage: 'zh',
  defaultSubtitleLanguage: 'zh',
  autoPlayNext: true,
  themeMode: 'system',
  posterDensity: 'comfortable',
};

function rowToSnapshot(row: {
  defaultAudioLanguage: string;
  defaultSubtitleLanguage: string;
  autoPlayNext: number;
  themeMode: string;
  posterDensity: string;
}): ProfilePreferencesSnapshot {
  return {
    defaultAudioLanguage: row.defaultAudioLanguage,
    defaultSubtitleLanguage: row.defaultSubtitleLanguage,
    autoPlayNext: row.autoPlayNext === 1,
    themeMode: row.themeMode as ProfilePreferencesSnapshot['themeMode'],
    posterDensity: row.posterDensity as ProfilePreferencesSnapshot['posterDensity'],
  };
}

/** GET:未有行返回传输默认值(零写入) */
export function getProfilePreferences(householdId: string, profileId: string): ProfilePreferencesSnapshot {
  const row = findProfilePreferencesRow(householdId, profileId);
  return row === undefined ? { ...PROFILE_PREFERENCES_DEFAULTS } : rowToSnapshot(row);
}

/** PUT:现值 + 覆盖层合并写入,返回更新后的完整快照 */
export function putProfilePreferences(
  householdId: string,
  profileId: string,
  patch: ProfilePreferencesPatch,
): ProfilePreferencesSnapshot {
  const row = upsertProfilePreferencesRow(householdId, profileId, patch, new Date().toISOString());
  return rowToSnapshot(row);
}
