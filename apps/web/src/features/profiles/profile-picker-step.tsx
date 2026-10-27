/**
 * 选档列表步骤(T042,FR-008):登录会话的 ProfileSummary 投影;禁用档案置灰
 * 不可选(带禁用理由);加载/失败/空三态自足实现(不依赖 shared/ui,US1 并行在建)。
 * 选择受 PIN 保护的档案交由父层进入 selectionPin 步骤;选择无 PIN 档案直接选档。
 * 数据访问(T026):经 profiles-api(privateFetch 档,会话作用域)挂载即取;
 * 列表不入共享查询缓存(跨身份残留风险),失败重试为本地状态机。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, AlertContent, AlertDescription, AlertTitle, Button, Spinner } from '@heroui/react';
import { isAbortError, isFetchApiError } from '../../shared/fetch';
import { fetchSelectableProfiles } from './profiles-api';
import type { ProfileSummary } from '../../app/session-types';

export interface ProfilePickerStepProps {
  /** 选中档案(无论是否 PIN 保护;受保护档案由协调器进入 selectionPin) */
  onPick: (profile: ProfileSummary) => void;
  onCancel: () => void;
}

export function ProfilePickerStep({ onPick, onCancel }: ProfilePickerStepProps): ReactNode {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // T026:经 profiles-api 统一选档列表端点(privateFetch 档,会话作用域)
      const items = await fetchSelectableProfiles();
      setProfiles(items);
    } catch (err) {
      if (isAbortError(err)) return;
      setError(isFetchApiError(err) && err.status === 401 ? '登录状态已失效,请重新登录' : '选档列表加载失败,请重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      {loading && profiles === null ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
          <Spinner size="sm" />
          正在加载档案…
        </div>
      ) : null}

      {error !== null ? (
        <div className="flex flex-col gap-2">
          <Alert status="danger">
            <AlertContent>
              <AlertTitle>无法加载选档列表</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </AlertContent>
          </Alert>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={onCancel}>
              取消
            </Button>
            <Button variant="primary" size="sm" onPress={() => void load()}>
              重试
            </Button>
          </div>
        </div>
      ) : null}

      {profiles !== null && profiles.length === 0 ? (
        <p className="py-6 text-sm text-muted">家庭内还没有档案。</p>
      ) : null}

      {profiles !== null && profiles.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="档案列表">
          {profiles.map((profile) => {
            const disabled = profile.status !== 'active';
            return (
              <li key={profile.id}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-disabled={disabled}
                  title={disabled ? '该档案已停用,不可选择' : undefined}
                  onClick={() => {
                    if (!disabled) onPick(profile);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                    disabled ? 'cursor-not-allowed opacity-50' : 'hover:border-accent'
                  }`}
                >
                  <span className="flex flex-col">
                    <span className="font-medium text-foreground">{profile.name}</span>
                    <span className="text-xs text-muted">
                      {profile.type === 'child' ? '儿童' : '成人'}
                      {profile.isMain ? ' · 主档案' : ''}
                      {profile.pinProtected ? ' · 需要 PIN' : ''}
                    </span>
                  </span>
                  {disabled ? (
                    <span className="text-xs text-muted">已停用</span>
                  ) : (
                    <span className="text-xs text-accent">选择</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {profiles !== null ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onPress={onCancel}>
            取消
          </Button>
        </div>
      ) : null}
    </div>
  );
}
