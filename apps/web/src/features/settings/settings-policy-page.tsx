/**
 * 内容权限页(T133,US8;FR-036):
 * - 选择目标档案 → 读取策略(等级/未评级/媒体允许禁止名单/频道白名单,002/003 继承);
 * - 等级与未评级保存(PUT policy,当次密码 + CAS);名单整体替换(PUT lists,
 *   当次密码 + CAS);
 * - 409 VERSION_CONFLICT 提示冲突并重读现值,不静默覆盖用户编辑;
 * - 授权失效立即隐藏主体,重新解锁后重读最新版本。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { classifySettingsWriteError } from './shared/access-expiry';
import { errorTextOf, settingsApi, type PolicyDto, type ProfileSummary } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

const LEVELS: Array<{ value: number; label: string }> = [
  { value: 0, label: '全年龄(0)' },
  { value: 6, label: '6+(0~6)' },
  { value: 12, label: '12+(0~12)' },
  { value: 15, label: '15+(0~15)' },
  { value: 18, label: '18+(0~18,全部)' },
];

function splitIds(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function SettingsPolicyPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [policy, setPolicy] = useState<PolicyDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'policy' | 'lists' | null>(null);

  const loadProfiles = useCallback((): void => {
    void (async () => {
      try {
        const list = await settingsApi.listProfiles();
        setProfiles(list);
        setTargetId((current) => current ?? list.find((profile) => profile.status === 'active')?.id ?? null);
        setLoadError(null);
      } catch (error) {
        if (classifySettingsWriteError(error) === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        setLoadError(errorTextOf(error));
      }
    })();
  }, [access]);

  const loadPolicy = useCallback((profileId: string): void => {
    void (async () => {
      try {
        setPolicy(await settingsApi.getPolicy(profileId));
        setConflict(null);
      } catch (error) {
        if (classifySettingsWriteError(error) === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        setLoadError(errorTextOf(error));
      }
    })();
  }, [access]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles, access.reloadEpoch, attempt]);

  useEffect(() => {
    if (targetId !== null) {
      loadPolicy(targetId);
    }
  }, [targetId, loadPolicy, access.reloadEpoch]);

  const save = (ownerPassword: string): Promise<void> => {
    if (targetId === null || policy === null) {
      return Promise.reject(new Error('no target'));
    }
    const request =
      confirmAction === 'policy'
        ? settingsApi.updatePolicy(targetId, {
            ownerPassword,
            expectedVersion: policy.version,
            policy: { maxContentLevel: policy.maxContentLevel, allowUnrated: policy.allowUnrated },
          })
        : settingsApi.replacePolicyLists(targetId, {
            ownerPassword,
            expectedVersion: policy.version,
            allowedMediaIds: policy.allowedMediaIds,
            blockedMediaIds: policy.blockedMediaIds,
            allowedChannelIds: policy.allowedChannelIds,
          });
    return request.then(
      (saved) => {
        setPolicy(saved);
        setNotice(confirmAction === 'policy' ? '等级与未评级设置已保存' : '名单已整体替换保存');
      },
      (cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        if (kind === 'conflict') {
          // 409:提示冲突并重读现值;用户编辑以草稿形式保留在界面上方名单输入区
          setConflict('策略已被其他操作修改(版本冲突):已重新读取服务端现值,请基于现值显式重试。');
          if (targetId !== null) {
            loadPolicy(targetId);
          }
          return;
        }
        throw cause; // 密码错误:弹层保持
      },
    );
  };

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {profiles === null && loadError === null ? <LoadingSpinner label="正在读取档案…" /> : null}
      {loadError !== null ? (
        <RetryableAlert title="读取失败" description={loadError} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {profiles !== null ? (
        <div className="flex max-w-md flex-col gap-1">
          <label htmlFor="policy-profile-select" className="text-sm text-muted">目标档案</label>
          <select
            id="policy-profile-select"
            className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            value={targetId ?? ''}
            onChange={(event) => setTargetId(event.target.value)}
            data-testid="policy-profile-select"
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.isMain ? '(主档案)' : ''}
                {profile.status === 'active' ? '' : '(已停用)'}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {policy !== null && targetId !== null ? (
        <div className="flex max-w-xl flex-col gap-4" data-testid="policy-editor">
          {conflict !== null ? (
            <p role="alert" className="rounded border border-warning p-3 text-sm text-warning">{conflict}</p>
          ) : null}
          {notice !== null ? (
            <p role="status" className="text-sm text-success" data-testid="policy-notice">{notice}</p>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="policy-level" className="text-sm text-muted">最高内容等级</label>
              <select
                id="policy-level"
                className="rounded border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                value={policy.maxContentLevel}
                onChange={(event) =>
                  setPolicy({ ...policy, maxContentLevel: Number(event.target.value) })
                }
                data-testid="policy-level"
              >
                {LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>{level.label}</option>
                ))}
                {!LEVELS.some((level) => level.value === policy.maxContentLevel) ? (
                  <option value={policy.maxContentLevel}>{`自定义(${policy.maxContentLevel})`}</option>
                ) : null}
              </select>
            </div>
            <label className="flex items-center gap-2 pb-1.5 text-sm">
              <input
                type="checkbox"
                checked={policy.allowUnrated}
                onChange={(event) => setPolicy({ ...policy, allowUnrated: event.target.checked })}
              />
              允许未评级内容
            </label>
            <Button
              variant="primary"
              size="sm"
              onPress={() => {
                setNotice(null);
                setConfirmAction('policy');
              }}
              data-testid="policy-save-level"
            >
              保存等级设置
            </Button>
          </div>

          <ListEditor
            label="媒体允许名单(每行一个媒体 ID)"
            ids={policy.allowedMediaIds}
            onChange={(ids) => setPolicy({ ...policy, allowedMediaIds: ids })}
          />
          <ListEditor
            label="媒体禁止名单(每行一个媒体 ID)"
            ids={policy.blockedMediaIds}
            onChange={(ids) => setPolicy({ ...policy, blockedMediaIds: ids })}
          />
          <ListEditor
            label="频道白名单(每行一个频道 ID)"
            ids={policy.allowedChannelIds}
            onChange={(ids) => setPolicy({ ...policy, allowedChannelIds: ids })}
          />
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted">名单整体替换保存;当次密码 + 版本 {policy.version}。</p>
            <Button
              variant="primary"
              size="sm"
              onPress={() => {
                setNotice(null);
                setConfirmAction('lists');
              }}
              data-testid="policy-save-lists"
            >
              保存名单
            </Button>
          </div>
        </div>
      ) : null}

      <PasswordConfirmModal
        open={confirmAction !== null}
        title={confirmAction === 'lists' ? '保存内容名单' : '保存等级设置'}
        description="名单/等级将整体保存到目标档案(当次密码验证)。"
        submitLabel="确认保存"
        onSubmit={save}
        onClose={() => setConfirmAction(null)}
      />
    </section>
  );
}

function ListEditor({ label, ids, onChange }: { label: string; ids: string[]; onChange: (ids: string[]) => void }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-muted">{label}</label>
      <textarea
        className="min-h-20 rounded border border-border bg-surface p-2 font-mono text-xs text-foreground"
        value={ids.join('\n')}
        onChange={(event) => onChange(splitIds(event.target.value))}
        spellCheck={false}
      />
    </div>
  );
}
