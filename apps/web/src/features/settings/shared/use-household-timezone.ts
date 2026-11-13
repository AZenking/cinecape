import { useAppQuery } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { privateFetch } from '../../../shared/fetch';
import type { HouseholdSettings } from './settings-api';

/**
 * 家庭时区(设置域时间戳展示的基准)。
 *
 * - 与「家庭设置」页共用 `settings.household` 键与缓存,不额外发请求;
 * - 返回 null = 尚未就绪(调用方用占位符,不拿浏览器时区冒充家庭时区);
 * - 只读:写操作仍由家庭设置页经 useAppMutation + CAS 承担。
 */
export function useHouseholdTimezone(): string | null {
  const query = useAppQuery<HouseholdSettings>({
    domain: 'settings',
    queryKey: queryKeys.settings.household(),
    queryFn: ({ signal }) => privateFetch<HouseholdSettings>('/settings/household', { signal }),
  });
  return query.data?.timezone ?? null;
}