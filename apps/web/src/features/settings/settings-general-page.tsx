/**
 * 通用设置页(T132,US8;FR-039 + FR-041):
 * - 家庭名称/语言/时区表单,expectedVersion CAS 保存(当次密码弹层);
 * - timezone 须为运行环境认可的 IANA 时区(提交前本地预检 + 服务端权威);
 * - 未保存编辑离开/切换子模块经 useUnsavedGuard 拦截,不自动提交;
 * - 409 VERSION_CONFLICT 提示冲突并提供「重新读取现值」,不静默覆盖用户编辑;
 * - 授权失效(403 SETTINGS_ACCESS_*)立即隐藏主体并终止后续动作,重新解锁后以
 *   reloadEpoch 重读最新版本。
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Form, TextField, Label, Input } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { classifySettingsWriteError } from './shared/access-expiry';
import { errorTextOf, settingsApi, type HouseholdSettings } from './shared/settings-api';
import { PasswordConfirmModal } from './shared/password-confirm-modal';
import { useUnsavedGuard } from './shared/unsaved-guard';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

interface FormValues {
  name: string;
  language: string;
  timezone: string;
}

export function SettingsGeneralPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [server, setServer] = useState<HouseholdSettings | null>(null);
  const [values, setValues] = useState<FormValues | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ message: string; latest: HouseholdSettings | null } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback((): void => {
    void (async () => {
      try {
        const current = await settingsApi.getHousehold();
        setServer(current);
        setValues({ name: current.name, language: current.language, timezone: current.timezone });
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

  useEffect(() => {
    load();
  }, [load, access.reloadEpoch, attempt]);

  const isDirty =
    server !== null &&
    values !== null &&
    (values.name !== server.name || values.language !== server.language || values.timezone !== server.timezone);
  const guard = useUnsavedGuard(isDirty);

  if (loadError !== null) {
    return (
      <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <RetryableAlert title="读取失败" description={loadError} onRetry={() => setAttempt((n) => n + 1)} />
        {guard.dialog}
      </section>
    );
  }

  if (server === null || values === null) {
    return (
      <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <LoadingSpinner label="正在读取通用设置…" />
      </section>
    );
  }

  const timezoneUsable = (() => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: values.timezone });
      return true;
    } catch {
      return false;
    }
  })();

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!isDirty) {
      return;
    }
    if (values.name.trim() === '') {
      setSaveError('家庭名称不能为空');
      return;
    }
    if (!timezoneUsable) {
      setSaveError('时区必须是 IANA 时区名称(例如 Asia/Shanghai)');
      return;
    }
    setSaveError(null);
    setNotice(null);
    setConfirmOpen(true);
  };

  const save = (ownerPassword: string): Promise<void> =>
    settingsApi
      .patchHousehold({
        expectedVersion: server.version,
        ownerPassword,
        ...(values.name !== server.name ? { name: values.name } : {}),
        ...(values.language !== server.language ? { language: values.language } : {}),
        ...(values.timezone !== server.timezone ? { timezone: values.timezone } : {}),
      })
      .then((saved) => {
        setServer(saved);
        setValues({ name: saved.name, language: saved.language, timezone: saved.timezone });
        setNotice('通用设置已保存');
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost(); // 立即隐藏主体;草稿不自动提交
          return;
        }
        if (kind === 'conflict') {
          // 409:提示冲突,提供重新读取;不静默覆盖用户编辑
          void settingsApi
            .getHousehold()
            .then((latest) => setConflict({ message: '设置已被其他操作修改,保存未生效;当前编辑已保留,可对比后重试。', latest }))
            .catch(() => setConflict({ message: '设置已被其他操作修改,保存未生效;请重新打开本模块读取现值。', latest: null }));
          return;
        }
        throw cause; // 密码错误等:弹层保持并呈现
      });

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <Form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-3" aria-label="家庭通用设置">
        <TextField className="w-full" value={values.name} onChange={(name: string) => setValues({ ...values, name })}>
          <Label>家庭名称</Label>
          <Input name="name" maxLength={100} />
        </TextField>
        <TextField className="w-full" value={values.language} onChange={(language: string) => setValues({ ...values, language })}>
          <Label>语言(如 zh-CN)</Label>
          <Input name="language" maxLength={35} />
        </TextField>
        <TextField
          className="w-full"
          value={values.timezone}
          onChange={(timezone: string) => setValues({ ...values, timezone })}
          isInvalid={!timezoneUsable}
        >
          <Label>时区(IANA,如 Asia/Shanghai)</Label>
          <Input name="timezone" maxLength={100} />
        </TextField>
        {!timezoneUsable ? (
          <p role="alert" className="text-sm text-danger">时区必须是运行环境认可的 IANA 时区名称。</p>
        ) : null}
        {saveError !== null ? (
          <p role="alert" className="text-sm text-danger">{saveError}</p>
        ) : null}
        {notice !== null ? (
          <p role="status" className="text-sm text-success" data-testid="general-save-notice">{notice}</p>
        ) : null}
        {conflict !== null ? (
          <div role="alert" className="flex flex-col gap-2 rounded border border-warning p-3 text-sm" data-testid="general-conflict">
            <p className="text-warning">{conflict.message}</p>
            {conflict.latest !== null ? (
              <p className="text-muted">
                服务端现值:名称「{conflict.latest.name}」/ 语言 {conflict.latest.language} / 时区 {conflict.latest.timezone} / 版本{' '}
                {conflict.latest.version}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  // 显式重读:丢弃本地草稿,以服务端现值继续(用户主动,不静默)
                  load();
                  setConflict(null);
                }}
              >
                读取现值并放弃我的编辑
              </Button>
              <Button variant="ghost" size="sm" onPress={() => setConflict(null)}>
                保留我的编辑
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted">保存需当次账号密码;版本 {server.version}(CAS 并发保护)。</p>
          <Button type="submit" variant="primary" size="sm" isDisabled={!isDirty} data-testid="general-save">
            保存修改
          </Button>
        </div>
      </Form>
      <PasswordConfirmModal
        open={confirmOpen}
        title="保存通用设置"
        description={`将按版本 ${server.version} 保存家庭设置(当次密码验证)。`}
        submitLabel="确认保存"
        onSubmit={save}
        onClose={() => setConfirmOpen(false)}
      />
      {guard.dialog}
    </section>
  );
}
