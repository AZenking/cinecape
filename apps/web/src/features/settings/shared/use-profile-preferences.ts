/**
 * 013 个人偏好数据层(T011/T012 共用;统一 useAppQuery/useAppMutation 通道)。
 *
 * - 键 = queryKeys.profile(profileId).preferences()(键工厂唯一来源;键内嵌
 *   profileId,切档即换键,purgePersonalData 按域清缓存);
 * - GET 仅对 404(服务端尚未初始化偏好行)回落传输默认值;其余错误原样上抛,
 *   由页面以 RetryableAlert 呈现(禁止静默吞错后回落默认值 —— 会掩盖会话失效
 *   并在保存时用默认值覆盖真实偏好);
 * - PUT 为合并语义(服务端 settings-contracts.md §2.1:部分字段提交合法,
 *   未提交字段保留现值),播放页/外观页各自提交子集互不覆盖;
 * - 身份:真实应用中未认证/未选档不发请求;无 SessionProvider 上下文
 *   (独立测试/孤页渲染)按 standalone 直达,键以 'self' 占位。
 */
import { useCallback } from 'react';
import { isFetchApiError, privateFetch } from '../../../shared/fetch';
import { useAppMutation, useAppQuery } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { useOptionalSession } from '../../../app/session-provider';
import type { ProfilePreferences } from '@hmp/shared';

/** 服务端未有偏好行时的传输默认值(与 013 契约默认一致) */
export const PROFILE_PREFERENCES_DEFAULTS: ProfilePreferences = {
  defaultAudioLanguage: 'zh',
  defaultSubtitleLanguage: 'zh',
  autoPlayNext: true,
  themeMode: 'system',
  posterDensity: 'comfortable',
};

/** GET /api/profile/preferences:仅 404 回落默认值,其余错误上抛 */
export async function fetchProfilePreferencesOrDefaults(signal: AbortSignal): Promise<ProfilePreferences> {
  try {
    return await privateFetch<ProfilePreferences>('/profile/preferences', { signal });
  } catch (error) {
    if (isFetchApiError(error) && error.status === 404) {
      return { ...PROFILE_PREFERENCES_DEFAULTS };
    }
    throw error;
  }
}

export interface ProfilePreferencesView {
  /** 查询结果;null = 仍在读取或读取失败 */
  preferences: ProfilePreferences | null;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /** 合并保存(只提交变更字段);提交中为 true */
  save: (patch: Partial<ProfilePreferences>) => Promise<void>;
  saving: boolean;
}

/** 个人偏好读写 Hook:身份键隔离 + 404 默认值回落 + 保存后失效回读服务端真值 */
export function useProfilePreferences(): ProfilePreferencesView {
  const session = useOptionalSession();
  const standalone = session === null;
  const profileId = session?.session?.activeProfile?.id ?? null;
  const enabled = standalone || (profileId !== null && session?.status === 'authenticated');

  // 键工厂要求携带 profileId;无身份上下文(独立测试环境)以 'self' 占位
  const preferencesKey = queryKeys.profile(profileId ?? 'self').preferences();

  const query = useAppQuery<ProfilePreferences>({
    domain: 'profile',
    queryKey: preferencesKey,
    queryFn: ({ signal }) => fetchProfilePreferencesOrDefaults(signal),
    enabled,
  });

  const saveMutation = useAppMutation<Partial<ProfilePreferences>, ProfilePreferences>({
    domain: 'profile',
    feedback: 'confirmed',
    invalidate: [preferencesKey],
    mutationFn: (patch) =>
      privateFetch<ProfilePreferences>('/profile/preferences', { method: 'PUT', body: patch }),
  });

  const save = useCallback(
    async (patch: Partial<ProfilePreferences>): Promise<void> => {
      await saveMutation.mutateAsync(patch);
    },
    [saveMutation],
  );

  return {
    preferences: query.data ?? null,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    save,
    saving: saveMutation.isPending,
  };
}
