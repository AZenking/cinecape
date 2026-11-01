/**
 * Profile 管理页(T133,US8;FR-036;T025 数据层迁移):
 * - 档案列表 + 家庭设置经 useAppQuery(settings.profiles 键,合并读取,硬请求 +
 *   isPending 门控 / isError RetryableAlert(formatApiError + 重试)/ 成功出主体);
 * - 创建/编辑/停用/清 PIN/主档案转移均为 confirmed 变更:等待服务端确认,成功后
 *   失效 settings.profiles 键以服务端真值回填(替代原手工 load());expectedVersion
 *   CAS;主档案不允许清 PIN、不能停用最后一个可用档案、现任主档案须先转移
 *   (错误以服务端稳定文案呈现);
 * - 主档案转移:目标须为「可用 + 成人 + 已设 PIN」;三项 CAS 来自打开模块时的
 *   服务端现值(refetch 取新),当次密码确认;成功后关闭设置进入切档验证(不静默
 *   激活目标),该变更声明零失效集合 —— 全部设置授予已在服务端撤销,不再读取设置主体;
 * - 409 VERSION_CONFLICT 提示冲突并按失效重读现值,不静默覆盖;
 * - 403 SETTINGS_ACCESS_* 经 handleAccessLost 立即隐藏;重新解锁后解锁门卸载本页、
 *   重挂硬请求,等价原 reloadEpoch 重读(FR-041)。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { AlertDialog, Button, Checkbox, Form, Input, Label, Radio, RadioGroup, TextField } from '@heroui/react';
import { LoadingSpinner, PinField, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { POST_IDENTITY_CHANGE_NOTICE, classifySettingsWriteError } from './shared/access-expiry';
import type { HouseholdSettings, ProfileSummary } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

/** 档案管理域合并读取:列表 + 家庭设置(mainProfileVersion 供转移 CAS) */
interface ProfilesPageData {
  profiles: ProfileSummary[];
  household: HouseholdSettings;
}

export function SettingsProfilesPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const navigate = useNavigate();
  const toast = useAppToast();
  const [editing, setEditing] = useState<ProfileSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [transferring, setTransferring] = useState<{ profiles: ProfileSummary[]; household: HouseholdSettings } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** T015:主档案转移完成提示(替代原 window.alert)以组件状态承载 */
  const [identityNoticeOpen, setIdentityNoticeOpen] = useState(false);

  const profilesQuery = useAppQuery<ProfilesPageData>({
    domain: 'settings',
    queryKey: queryKeys.settings.profiles(),
    queryFn: ({ signal }) =>
      Promise.all([
        privateFetch<ProfileSummary[]>('/settings/profiles', { signal }),
        privateFetch<HouseholdSettings>('/settings/household', { signal }),
      ]).then(([profiles, household]) => ({ profiles, household })),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (profilesQuery.isError && classifySettingsWriteError(profilesQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [profilesQuery.isError, profilesQuery.error, access]);

  /**
   * T015 UX 选择说明:原 window.alert 弹窗(POST_IDENTITY_CHANGE_NOTICE.mainProfile)是
   * 纯信息提示(浏览器 alert 仅一个「好」按钮,无确认/取消语义),故等价改为
   * 单一「知道了」确认动作的 AlertDialog(阻断式:Backdrop 默认不可点外关闭、
   * Esc 关闭禁用,必须显式确认)。结果反馈改经 Toast(轻反馈,文案与弹层一致,
   * AppToastRegion 挂应用根部,页面卸载后仍可见);确认后仍先 access.lock() 同步
   * 客户端失效态再回首页(原为 alert 关闭后 navigate('/'))。
   * 顺序调整原因:lock() 会翻转解锁门(unlocked→locked)并卸载本页,弹层必须
   * 在 lock 之前存续,故把 lock 从「转移成功即触发」移到「确认后触发」。
   */
  const confirmIdentityNotice = (): void => {
    setIdentityNoticeOpen(false);
    toast.success(POST_IDENTITY_CHANGE_NOTICE.mainProfile);
    void access.lock().finally(() => {
      void navigate('/');
    });
  };

  /** 变更后服务端错误 → 页面级处置(403 授权丢失立即隐藏;其余呈现稳定文案) */
  const refreshAfterMutation = (cause: unknown): void => {
    const kind = classifySettingsWriteError(cause);
    if (kind === 'access-lost') {
      access.handleAccessLost();
      return;
    }
    setPageError(formatApiError(cause));
  };

  const profiles = profilesQuery.data?.profiles ?? null;

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {profilesQuery.isPending ? <LoadingSpinner label="正在读取档案…" /> : null}
      {profilesQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(profilesQuery.error)}
          onRetry={() => void profilesQuery.refetch()}
        />
      ) : null}
      {pageError !== null ? <p role="alert" className="text-sm text-danger">{pageError}</p> : null}
      {notice !== null ? <p role="status" className="text-sm text-success" data-testid="profiles-notice">{notice}</p> : null}
      {profiles !== null ? (
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
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                onEdited={(message) => {
                  setNotice(message);
                  // 列表回填由变更的 invalidate(settings.profiles)统一驱动
                }}
                onError={refreshAfterMutation}
                onEdit={() => {
                  setPageError(null);
                  setEditing(profile);
                }}
                onTransferMain={() => {
                  setPageError(null);
                  // 转移 CAS 三版本必须来自打开模块时的服务端现值:显式 refetch 取新后入模
                  void profilesQuery.refetch().then((fresh) => {
                    if (fresh.data) {
                      setTransferring({ profiles: fresh.data.profiles, household: fresh.data.household });
                    }
                  });
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
          }}
          onCancel={() => setEditing(null)}
          onConflict={() => {
            // 409:提示冲突;失效已触发按服务端现值重读,不静默覆盖(用户可基于现值显式重试)
            setEditing(null);
            setPageError('保存被拒绝(版本冲突):档案已被其他操作修改,列表已按服务端现值刷新,请基于现值重新编辑。');
          }}
          onError={refreshAfterMutation}
        />
      ) : null}

      {transferring !== null ? (
        <TransferMainModal
          data={transferring}
          onClose={() => setTransferring(null)}
          onTransferred={() => setIdentityNoticeOpen(true)}
        />
      ) : null}

      {/* T015:主档案转移完成提示(替代原 window.alert)——文案不变,单一确认动作 */}
      <AlertDialog.Root isOpen={identityNoticeOpen}>
        <AlertDialog.Backdrop>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog aria-label="主档案转移完成">
              <AlertDialog.Header>
                <AlertDialog.Heading className="text-base font-semibold">主档案转移已完成</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <p data-testid="identity-notice-text">{POST_IDENTITY_CHANGE_NOTICE.mainProfile}</p>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="primary" size="sm" onPress={confirmIdentityNotice} data-testid="identity-notice-confirm">
                  知道了
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog.Root>
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

  // 停用/清 PIN:confirmed 变更 + CAS;成功后失效档案列表以服务端真值回填
  const patchProfile = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { expectedVersion: number; ownerPassword: string; status?: 'disabled'; clearPin: boolean }) =>
      privateFetch<ProfileSummary>(`/settings/profiles/${profile.id}`, {
        method: 'PATCH',
        body: vars,
      }),
    invalidate: [queryKeys.settings.profiles()],
  });

  const runAction = (ownerPassword: string): Promise<void> => {
    if (action === null) {
      return Promise.reject(new Error('no action'));
    }
    const input =
      action === 'disable'
        ? { status: 'disabled' as const, clearPin: false }
        : { clearPin: true };
    return patchProfile
      .mutateAsync({ expectedVersion: profile.version, ownerPassword, ...input })
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

  // 创建档案:confirmed 变更(当次密码);成功后失效档案列表回填
  const createProfile = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { ownerPassword: string }) =>
      privateFetch<ProfileSummary>('/settings/profiles', {
        method: 'POST',
        body: {
          ownerPassword: vars.ownerPassword,
          name: name.trim(),
          type,
          isDefault,
          ...(pin !== '' ? { pin } : {}),
        },
      }),
    invalidate: [queryKeys.settings.profiles()],
  });

  const submit = (ownerPassword: string): Promise<void> =>
    createProfile
      .mutateAsync({ ownerPassword })
      .then((created) => {
        onDone(`档案「${created.name}」已创建`);
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

  const pinError = error === 'PIN 必须为 6 位数字' ? error : undefined;

  return (
    <Form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-3 rounded border border-border p-4" aria-label="新建档案">
      <h3 className="text-sm font-semibold text-foreground">新建档案</h3>
      <TextField className="w-full" value={name} onChange={setName}>
        <Label>档案名称</Label>
        <Input name="name" maxLength={50} />
      </TextField>
      <RadioGroup
        className="flex gap-4 text-sm"
        name="profile-type"
        value={type}
        onChange={(value) => setType(value as 'adult' | 'child')}
      >
        <Label>类型</Label>
        <Radio value="child">
          <Radio.Content>
            <Radio.Control><Radio.Indicator /></Radio.Control>
            儿童
          </Radio.Content>
        </Radio>
        <Radio value="adult">
          <Radio.Content>
            <Radio.Control><Radio.Indicator /></Radio.Control>
            成人
          </Radio.Content>
        </Radio>
      </RadioGroup>
      <PinField
        name="pin"
        label="PIN(可选,6 位数字)"
        value={pin}
        onValueChange={setPin}
        isRequired={false}
        errorMessage={pinError}
        isInvalid={pinError !== undefined}
        description="不填则选择时无需 PIN"
      />
      <Checkbox isSelected={isDefault} onChange={setIsDefault}>
        <Checkbox.Content>
          <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
          设为默认观看档案
        </Checkbox.Content>
      </Checkbox>
      {error !== null && pinError === undefined ? (
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
  onError: _onError,
}: {
  profile: ProfileSummary;
  onDone: (message: string) => void;
  onCancel: () => void;
  onConflict: () => void;
  onError: (cause: unknown) => void;
}): ReactNode {
  const access = useSettingsAccess();
  const [name, setName] = useState(profile.name);
  const [pin, setPin] = useState('');
  const [isDefault, setIsDefault] = useState(profile.isDefault);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== profile.name || pin !== '' || isDefault !== profile.isDefault;
  const pinError = error === 'PIN 必须为 6 位数字' ? error : undefined;

  // 保存档案修改:confirmed 变更 + CAS;成功后失效档案列表回填
  const patchProfile = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { ownerPassword: string }) =>
      privateFetch<ProfileSummary>(`/settings/profiles/${profile.id}`, {
        method: 'PATCH',
        body: {
          ownerPassword: vars.ownerPassword,
          expectedVersion: profile.version,
          ...(name !== profile.name ? { name } : {}),
          ...(isDefault !== profile.isDefault ? { isDefault } : {}),
          ...(pin !== '' ? { pin } : {}),
          clearPin: false,
        },
      }),
    invalidate: [queryKeys.settings.profiles()],
  });

  const submit = (ownerPassword: string): Promise<void> =>
    patchProfile
      .mutateAsync({ ownerPassword })
      .then(() => {
        onDone(`档案「${profile.name}」已保存`);
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost(); // 授权失效:立即隐藏主体(草稿不自动提交)
          return;
        }
        if (kind === 'conflict') {
          onConflict();
          return;
        }
        throw cause; // 密码错误:弹层保持
      });

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
      <PinField
        name="pin"
        label={profile.pinProtected ? '重设 PIN(留空保持不变;主档案不可清除 PIN)' : '设置 PIN(可选,6 位数字)'}
        value={pin}
        onValueChange={setPin}
        isRequired={false}
        errorMessage={pinError}
        isInvalid={pinError !== undefined}
        description={profile.pinProtected ? '留空保持不变' : '留空则选择时无需 PIN'}
      />
      <Checkbox isSelected={isDefault} onChange={setIsDefault}>
        <Checkbox.Content>
          <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
          设为默认观看档案
        </Checkbox.Content>
      </Checkbox>
      {error !== null && pinError === undefined ? (
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
  onTransferred,
}: {
  data: { profiles: ProfileSummary[]; household: HouseholdSettings };
  onClose: () => void;
  /** T015:转移成功 → 通知页面挂载完成提示弹层(替代原 window.alert 副作用) */
  onTransferred: () => void;
}): ReactNode {
  const access = useSettingsAccess();
  const currentMain = data.profiles.find((profile) => profile.isMain) ?? null;
  const candidates = data.profiles.filter(
    (profile) => !profile.isMain && profile.status === 'active' && profile.type === 'adult' && profile.pinProtected,
  );
  const [targetId, setTargetId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = candidates.find((profile) => profile.id === targetId) ?? null;

  // 主档案转移:confirmed 变更 + 三项 CAS。invalidate 刻意为空:
  // 成功后全部设置授予已在服务端撤销,客户端不得再读取任何设置主体。
  const transferMain = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { profileId: string; ownerPassword: string }) =>
      privateFetch<{ mainProfileId: string; mainProfileVersion: number }>('/settings/main-profile', {
        method: 'PUT',
        body: {
          profileId: vars.profileId,
          expectedVersion: data.household.mainProfileVersion,
          expectedCurrentProfileVersion: currentMain?.version ?? 0,
          expectedProfileVersion: data.profiles.find((profile) => profile.id === vars.profileId)?.version ?? 0,
          ownerPassword: vars.ownerPassword,
        },
      }),
  });

  const submit = (ownerPassword: string): Promise<void> => {
    if (currentMain === null || target === null) {
      return Promise.reject(new Error('no target'));
    }
    return transferMain
      .mutateAsync({ profileId: target.id, ownerPassword })
      .then(() => {
        // 成功:全部设置授予已在服务端撤销 —— 关闭转移模块并展示完成提示弹层
        // (T015:原 window.alert 改为页面级 AlertDialog + Toast;客户端 lock()
        // 延后到确认动作,避免解锁门先卸载本页导致弹层无法存活)
        onClose();
        onTransferred();
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
          <RadioGroup
            className="flex flex-col gap-2 text-sm"
            name="transfer-target"
            value={targetId ?? ''}
            onChange={setTargetId}
          >
            <Label>选择新主档案</Label>
            {candidates.map((profile) => (
              <Radio key={profile.id} value={profile.id}>
                <Radio.Content>
                  <Radio.Control><Radio.Indicator /></Radio.Control>
                  {profile.name}(版本 {profile.version})
                </Radio.Content>
              </Radio>
            ))}
          </RadioGroup>
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
