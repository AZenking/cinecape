/**
 * 个人偏好仓储 Drizzle 实现(013-role-differentiated-settings)。
 *
 * - 查询/写入仅本上下文 profile_preferences 表;句柄经 getDb() 惰性解析
 *   (Database 单例 close/重开自动重建包装,与 personal-data-store.drizzle 同口径);
 * - GET 未有行返回 undefined(应用层映射传输默认值,零写入);
 * - PUT 为「现值 + 覆盖层」合并 upsert(onConflictDoUpdate,仅更新提交字段),
 *   updated_at 每次写入刷新;个人偏好非资产,后写覆盖前写属可接受语义(无 CAS)。
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '@platform/database/drizzle';
import { profilePreferences, type ProfilePreferencesRow } from '@platform/database/schema';

export interface ProfilePreferencesPatch {
  readonly defaultAudioLanguage?: string;
  readonly defaultSubtitleLanguage?: string;
  readonly autoPlayNext?: boolean;
  readonly themeMode?: 'system' | 'dark' | 'light';
  readonly posterDensity?: 'comfortable' | 'compact';
}

export function findProfilePreferencesRow(
  householdId: string,
  profileId: string,
): ProfilePreferencesRow | undefined {
  return getDb()
    .select()
    .from(profilePreferences)
    .where(and(eq(profilePreferences.householdId, householdId), eq(profilePreferences.profileId, profileId)))
    .get();
}

export function upsertProfilePreferencesRow(
  householdId: string,
  profileId: string,
  patch: ProfilePreferencesPatch,
  updatedAt: string,
): ProfilePreferencesRow {
  return getDb()
    .insert(profilePreferences)
    .values({
      householdId,
      profileId,
      defaultAudioLanguage: patch.defaultAudioLanguage ?? 'zh',
      defaultSubtitleLanguage: patch.defaultSubtitleLanguage ?? 'zh',
      autoPlayNext: patch.autoPlayNext === undefined ? 1 : patch.autoPlayNext ? 1 : 0,
      themeMode: patch.themeMode ?? 'system',
      posterDensity: patch.posterDensity ?? 'comfortable',
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [profilePreferences.householdId, profilePreferences.profileId],
      set: {
        ...(patch.defaultAudioLanguage !== undefined ? { defaultAudioLanguage: patch.defaultAudioLanguage } : {}),
        ...(patch.defaultSubtitleLanguage !== undefined
          ? { defaultSubtitleLanguage: patch.defaultSubtitleLanguage }
          : {}),
        ...(patch.autoPlayNext !== undefined ? { autoPlayNext: patch.autoPlayNext ? 1 : 0 } : {}),
        ...(patch.themeMode !== undefined ? { themeMode: patch.themeMode } : {}),
        ...(patch.posterDensity !== undefined ? { posterDensity: patch.posterDensity } : {}),
        updatedAt,
      },
    })
    .returning()
    .get();
}
