/**
 * Profile 管理页(T133,US8;FR-036):
 * - 档案列表(创建/编辑/停用/PIN 管理),expectedVersion CAS;主档案不允许清 PIN、
 *   不能停用最后一个可用档案、现任主档案须先转移(错误以服务端稳定文案呈现);
 * - 主档案转移:目标须为「可用 + 成人 + 已设 PIN」;三项 CAS(家庭 mainProfileVersion /
 *   现任 version / 目标 version)来自当前读取,当次密码确认;成功后关闭设置进入切档
 *   验证(不静默激活目标),不再继续读取设置主体;
 * - 409 VERSION_CONFLICT 提示冲突并重读现值,不静默覆盖。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, Form, TextField, Label, Input } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { POST_IDENTITY_CHANGE_NOTICE, classifySettingsWriteError } from './shared/access-expiry';
import { errorTextOf, settingsApi, type HouseholdSettings, type ProfileSummary } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ok'; profiles: ProfileSummary[] }
  | { phase: 'error'; message: string };

export function SettingsProfilesPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<ProfileSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [transferring, setTransferring] = useState<{ profiles: ProfileSummary[]; household: HouseholdSettings } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): void => {
    void (async () => {
      try {
        const [profiles, household] = await Promise.all([settingsApi.listProfiles(), settingsApi.getHousehold()]);
        setState({ phase: 'ok', profiles });
        setTransferring((current) => (current === null ? null : { profiles, household }));
        setPageError(null);
      } catch (error) {
        if (classifySettingsWriteError(error) === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        setState({ phase: 'error', message: errorTextOf(error) });
      }
    })();
  }, [access]);

  useEffect(() => {
    load();
  }, [load, access.reloadEpoch, attempt]);

  const refreshAfterMutation = useCallback(
    (cause: unknown): void => {
      const kind = classifySettingsWriteError(cause);
      if (kind === 'access-lost') {
        access.handleAccessLost();
        return;
      }
      setPageError(errorTextOf(cause));
    },
    [access],
  );

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {state.phase === 'loading' ? <LoadingSpinner label="正在读取档案…" /> : null}
      {state.phase === 'error' ? (
        <RetryableAlert title="读取失败" description={state.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}
      {pageError !== null ? <p role="alert" className="text-sm text-danger">{pageError}</p> : null}
      {notice !== null ? <p role="status" className="text-sm text-success" data-testid="profiles-notice">{notice}</p> : null}
      {state.phase === 'ok' ? (
        <>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              data-testid="create-profile-open"
              onPress={() => {
                setPageError(null);
                setCreating(true);
              }}
            >
              新建档案
            </Button>
          </div>
          <ul className="flex flex-col gap-2" data-testid="profile-list">
            {state.profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                onEdited={(message) => {
                  setNotice(message);
                  load();
                }}
                onError={refreshAfterMutation}
                onEdit={() => {
                  setPageError(null);
                  setEditing(profile);
                }}
                onTransferMain={() => {
                  setPageError(null);
                  void (async () => {
                    try {
                      const [profiles, household] = await Promise.all([settingsApi.listProfiles(), settingsApi.getHousehold()]);
                      setTransferring({ profiles, household });
                    } catch (error) {
                      refreshAfterMutation(error);
                    }
                  })();
                }}
              />
            ))}
          </ul>
          <p className="text-xs text-muted">
            主档案唯一且须为可用成人并已设 PIN;停用最后一个可用档案、清除主档案 PIN 都会被服务端拒绝。
          </p>
        </>
      ) : null}

      {creating ? (
        <CreateProfileForm
          onDone={(message) => {
            setCreating(false);
            setNotice(message);
            load();
          }}
          onCancel={() => setCreating(false)}
          onError={refreshAfterMutation}
        />
      ) : null}

      {editing !== null ? (
        <EditProfileForm
          profile={editing}
          onDone={(message) => {
            setEditing(null);
            setNotice(message);
            load();
          }}
          onCancel={() => setEditing(null)}
          onConflict={(latest) => {
            // 409:重读现值并提示,不静默覆盖(用户仍可基于现值显式重试)
            setEditing(null);
            setPageError('保存被拒绝(版本冲突):档案已被其他操作修改,列表已按服务端现值刷新,请基于现值重新编辑。');
            if (latest) {
              load();
            }
          }}
          onError={refreshAfterMutation}
        />
      ) : null}

      {transferring !== null ? (
        <TransferMainModal data={transferring} onClose={() => setTransferring(null)} />
      ) : null}
    </section>
  );
}

function profileTypeLabel(profile: ProfileSummary): string {
  const type = profile.type === 'adult' ? '成人' : '儿童';
  const main = profile.isMain ? ' · 主档案' : '';
  const pin = profile.pinProtected ? ' · 已设 PIN' : '';
  const status = profile.status === 'active' ? '' : ' · 已停用';
  return `${type}${main}${pin}${status}(版本 ${profile.version})`;
}

function ProfileRow({
  profile,
  onEdit,
  onEdited,
  onError,
  onTransferMain,
}: {
  profile: ProfileSummary;
  onEdit: () => void;
  onEdited: (message: string) => void;
  onError: (cause: unknown) => void;
  onTransferMain: () => void;
}): ReactNode {
  const access = useSettingsAccess();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [action, setAction] = useState<'disable' | 'clearPin' | null>(null);

  const runAction = (ownerPassword: string): Promise<void> => {
    if (action === null) {
      return Promise.reject(new Error('no action'));
    }
    const input =
      action === 'disable'
        ? { status: 'disabled' as const, clearPin: false }
        : { clearPin: true };
    return settingsApi
      .patchProfile(profile.id, {
        expectedVersion: profile.version,
        ownerPassword,
        ...input,
      })
      .then(() => {
        onEdited(action === 'disable' ? `档案「${profile.name}」已停用` : `档案「${profile.name}」已清除 PIN`);
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        if (kind === 'conflict') {
          onError(new Error('版本冲突:档案已被其他操作修改,请基于列表现值重试'));
          return;
        }
        throw cause; // 密码/校验错误:弹层保持
      });
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{profile.name}</span>
        <span className="text-xs text-muted">{profileTypeLabel(profile)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" size="sm" onPress={onEdit} data-testid={`profile-edit-${profile.id}`}>
          编辑 / PIN
        </Button>
        {profile.isMain ? (
          <Button variant="ghost" size="sm" onPress={onTransferMain} data-testid={`profile-transfer-${profile.id}`}>
            转移主档案
          </Button>
        ) : null}
        {profile.pinProtected && !profile.isMain ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              setAction('clearPin');
              setConfirmOpen(true);
            }}
            data-testid={`profile-clearpin-${profile.id}`}
          >
            清除 PIN
          </Button>
        ) : null}
        {profile.status === 'active' ? (
          <Button
            variant="danger"
            size="sm"
            onPress={() => {
              setAction('disable');
              setConfirmOpen(true);
            }}
            data-testid={`profile-disable-${profile.id}`}
          >
            停用
          </Button>
        ) : null}
      </div>
      <PasswordConfirmModal
        open={confirmOpen}
        title={action === 'disable' ? `停用档案「${profile.name}」` : `清除「${profile.name}」的 PIN`}
        description={action === 'disable' ? '停用后该档案不可再被选择;正在观看的设备将被要求重新选档。' : '清除后该档案不再需要 PIN 即可选择。'}
        submitLabel="确认执行"
        onSubmit={runAction}
        onClose={() => {
          setConfirmOpen(false);
          setAction(null);
        }}
      />
    </li>
  );
}

function CreateProfileForm({
  onDone,
  onCancel,
  onError,
}: {
  onDone: (message: string) => void;
  onCancel: () => void;
  onError: (cause: unknown) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [type, setType] = useState<'adult' | 'child'>('child');
  const [pin, setPin] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (ownerPassword: string): Promise<void> =>
    settingsApi
      .createProfile({
        name: name.trim(),
        type,
        isDefault,
        ...(pin !== '' ? { pin } : {}),
        ownerPassword,
      })
      .then(() => {
        onDone(`档案「${name.trim()}」已创建`);
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'conflict' || kind === 'validation' || kind === 'not-found') {
          onError(cause);
          return;
        }
        throw cause; // 密码错误:弹层保持
      });

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (name.trim() === '') {
      setError('请填写档案名称');
      return;
    }
    if (pin !== '' && !/^\d{6}$/.test(pin)) {
      setError('PIN 必须为 6 位数字');
      return;
    }
    setError(null);
    setPasswordOpen(true); // 下一步:独立当次密码验证
  };

  return (
    <Form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-3 rounded border border-border p-4" aria-label="新建档案">
      <h3 className="text-sm font-semibold text-foreground">新建档案</h3>
      <TextField className="w-full" value={name} onChange={setName}>
        <Label>档案名称</Label>
        <Input name="name" maxLength={50} />
      </TextField>
      <fieldset className="flex gap-4 text-sm">
        <legend className="text-muted">类型</legend>
        <label className="flex items-center gap-1">
          <input type="radio" name="profile-type" checked={type === 'child'} onChange={() => setType('child')} />
          儿童
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" name="profile-type" checked={type === 'adult'} onChange={() => setType('adult')} />
          成人
        </label>
      </fieldset>
      <TextField className="w-full" value={pin} onChange={setPin}>
        <Label>PIN(可选,6 位数字)</Label>
        <Input name="pin" inputMode="numeric" maxLength={6} placeholder="不填则选择时无需 PIN" />
      </TextField>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        设为默认观看档案
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onPress={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" size="sm" data-testid="create-profile-submit">
          创建(下一步输密码)
        </Button>
      </div>
      <PasswordConfirmModal
        open={passwordOpen}
        title="确认创建档案"
        description={`将创建${type === 'adult' ? '成人' : '儿童'}档案「${name.trim()}」${pin !== '' ? '(含 PIN)' : ''}。`}
        submitLabel="确认创建"
        onSubmit={submit}
        onClose={() => setPasswordOpen(false)}
      />
    </Form>
  );
}

function EditProfileForm({
  profile,
  onDone,
  onCancel,
  onConflict,
  onError,
}: {
  profile: ProfileSummary;
  onDone: (message: string) => void;
  onCancel: () => void;
  onConflict: (shouldReload: boolean) => void;
  onError: (cause: unknown) => void;
}): ReactNode {
  const [name, setName] = useState(profile.name);
  const [pin, setPin] = useState('');
  const [isDefault, setIsDefault] = useState(profile.isDefault);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== profile.name || pin !== '' || isDefault !== profile.isDefault;

  const submit = (ownerPassword: string): Promise<void> =>
    settingsApi
      .patchProfile(profile.id, {
        expectedVersion: profile.version,
        ownerPassword,
        ...(name !== profile.name ? { name } : {}),
        ...(isDefault !== profile.isDefault ? { isDefault } : {}),
        ...(pin !== '' ? { pin } : {}),
        clearPin: false,
      })
      .then(() => {
        onDone(`档案「${profile.name}」已保存`);
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          accessLostHandler();
          return;
        }
        if (kind === 'conflict') {
          onConflict(true);
          return;
        }
        throw cause;
      });
  const accessLostHandler = (): void => onError(new Error('__access_lost__'));

  return (
    <Form
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!dirty) {
          return;
        }
        if (name.trim() === '') {
          setError('档案名称不能为空');
          return;
        }
        if (pin !== '' && !/^\d{6}$/.test(pin)) {
          setError('PIN 必须为 6 位数字');
          return;
        }
        setError(null);
        setPasswordOpen(true);
      }}
      className="flex max-w-md flex-col gap-3 rounded border border-border p-4"
      aria-label={`编辑档案 ${profile.name}`}
    >
      <h3 className="text-sm font-semibold text-foreground">编辑档案(版本 {profile.version})</h3>
      <TextField className="w-full" value={name} onChange={setName}>
        <Label>名称</Label>
        <Input name="name" maxLength={50} />
      </TextField>
      <TextField className="w-full" value={pin} onChange={setPin}>
        <Label>{profile.pinProtected ? '重设 PIN(留空保持不变;主档案不可清除 PIN)' : '设置 PIN(可选,6 位数字)'}</Label>
        <Input name="pin" inputMode="numeric" maxLength={6} />
      </TextField>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
        设为默认观看档案
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-danger">{error}</p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onPress={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary" size="sm" isDisabled={!dirty}>
          保存(下一步输密码)
        </Button>
      </div>
      <PasswordConfirmModal
        open={passwordOpen}
        title="保存档案修改"
        submitLabel="确认保存"
        onSubmit={submit}
        onClose={() => setPasswordOpen(false)}
      />
    </Form>
  );
}

function TransferMainModal({
  data,
  onClose,
}: {
  data: { profiles: ProfileSummary[]; household: HouseholdSettings };
  onClose: () => void;
}): ReactNode {
  const access = useSettingsAccess();
  const navigate = useNavigate();
  const currentMain = data.profiles.find((profile) => profile.isMain) ?? null;
  const candidates = data.profiles.filter(
    (profile) => !profile.isMain && profile.status === 'active' && profile.type === 'adult' && profile.pinProtected,
  );
  const [targetId, setTargetId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = candidates.find((profile) => profile.id === targetId) ?? null;

  const submit = (ownerPassword: string): Promise<void> => {
    if (currentMain === null || target === null) {
      return Promise.reject(new Error('no target'));
    }
    return settingsApi
      .transferMainProfile({
        profileId: target.id,
        expectedVersion: data.household.mainProfileVersion,
        expectedCurrentProfileVersion: currentMain.version,
        expectedProfileVersion: target.version,
        ownerPassword,
      })
      .then(() => {
        // 成功:全部设置授予已撤销 —— 关闭设置进入切档验证,不静默激活目标
        onClose();
        void access.lock().finally(() => {
          window.alert(POST_IDENTITY_CHANGE_NOTICE.mainProfile);
          void navigate('/');
        });
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        if (kind === 'conflict') {
          setError('主档案已被其他操作修改(版本冲突):请关闭后重新打开本模块,以最新版本重试。');
          return;
        }
        if (kind === 'not-found') {
          setError('目标档案不存在或不属于本家庭');
          return;
        }
        throw cause; // 密码错误:弹层保持
      });
  };

  return (
    <div className="flex max-w-xl flex-col gap-3 rounded border border-border p-4" aria-label="主档案转移">
      <h3 className="text-sm font-semibold text-foreground">主档案转移(三项版本校验)</h3>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted">
          没有可转移的目标:目标必须为「可用 + 成人 + 已设 PIN」的档案。请先为某个成人档案设置 PIN。
        </p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="text-muted">选择新主档案</legend>
            {candidates.map((profile) => (
              <label key={profile.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="transfer-target"
                  checked={targetId === profile.id}
                  onChange={() => setTargetId(profile.id)}
                />
                {profile.name}(版本 {profile.version})
              </label>
            ))}
          </fieldset>
          {error !== null ? (
            <p role="alert" className="text-sm text-danger">{error}</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              isDisabled={target === null}
              onPress={() => setConfirmOpen(true)}
              data-testid="transfer-main-open"
            >
              转移(下一步输密码)
            </Button>
          </div>
          <PasswordConfirmModal
            open={confirmOpen}
            title="确认转移主档案"
            description={
              target !== null && currentMain !== null
                ? `家庭主档案版本 ${data.household.mainProfileVersion} / 现任「${currentMain.name}」版本 ${currentMain.version} / 目标「${target.name}」版本 ${target.version}。完成后所有设置解锁失效。`
                : ''
            }
            submitLabel="确认转移"
            onSubmit={submit}
            onClose={() => setConfirmOpen(false)}
          />
        </>
      )}
    </div>
  );
}
