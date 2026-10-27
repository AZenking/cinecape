/**
 * 通用设置页(T132,US8;FR-039 + FR-041;T025 数据层迁移):
 * - 家庭设置(household)经 useAppQuery(settings 域硬请求):isPending 门控 /
 *   isError RetryableAlert(formatApiError + 重试)/ 成功出表单。键取工厂的
 *   settings.account:键工厂暂无 household 专键(shared/query/keys.ts 本任务只读,
 *   扩键属契约变更),家庭设置属账号级设置域故借 account 键承载;settings 域
 *   挂载即清 + 单页挂载(账号页/本页不同时挂载),两页间不存在缓存互串;
 * - 家庭名称/语言/时区草稿以「服务端现值 + 覆盖层」承载(渲染期派生,零同步副作用);
 * - 保存为 confirmed 变更(expectedVersion CAS + 当次密码弹层):成功后失效键以
 *   服务端真值回填并清空覆盖层(等价原 setValues(saved));timezone 须为运行环境
 *   认可的 IANA 时区(提交前本地预检 + 服务端权威);
 * - 未保存编辑离开/切换子模块经 useUnsavedGuard 拦截,不自动提交;
 * - 409 VERSION_CONFLICT 提示冲突并失效重读服务端现值,草稿覆盖层保留,不静默覆盖
 *   用户编辑;「读取现值并放弃我的编辑」清空覆盖层 + refetch;
 * - 授权失效(403 SETTINGS_ACCESS_*)立即隐藏主体并终止后续动作,重新解锁后
 *   重挂硬请求重读最新版本,草稿不自动提交。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Form, TextField, Label, Input } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError } from './shared/access-expiry';
import type { HouseholdSettings } from './shared/settings-api';
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
  const [overrides, setOverrides] = useState<Partial<FormValues>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const householdQuery = useAppQuery<HouseholdSettings>({
    domain: 'settings',
    // 键工厂暂无 household 专键(shared 只读):家庭设置属账号级设置域,借 account 键
    // 承载;settings 域挂载即清 + 账号页/本页不同时挂载,无缓存互串(见页首注释)
    queryKey: queryKeys.settings.household(),
    queryFn: ({ signal }) => privateFetch<HouseholdSettings>('/settings/household', { signal }),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (householdQuery.isError && classifySettingsWriteError(householdQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [householdQuery.isError, householdQuery.error, access]);

  const server = householdQuery.data ?? null;
  // 草稿 = 服务端现值 + 覆盖层(渲染期派生;保存成功后覆盖层清空 → 草稿回到现值)
  const values: FormValues | null =
    server === null ? null : { name: server.name, language: server.language, timezone: server.timezone, ...overrides };

  const isDirty =
    server !== null &&
    values !== null &&
    (values.name !== server.name || values.language !== server.language || values.timezone !== server.timezone);
  const guard = useUnsavedGuard(isDirty);

  // 保存通用设置:confirmed 变更 + CAS;成功后失效键以服务端真值回填并清空覆盖层
  const saveHousehold = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { ownerPassword: string }) => {
      if (server === null || values === null) {
        return Promise.reject(new Error('no values'));
      }
      return privateFetch<HouseholdSettings>('/settings/household', {
        method: 'PATCH',
        body: {
          ownerPassword: vars.ownerPassword,
          expectedVersion: server.version,
          ...(values.name !== server.name ? { name: values.name } : {}),
          ...(values.language !== server.language ? { language: values.language } : {}),
          ...(values.timezone !== server.timezone ? { timezone: values.timezone } : {}),
        },
      });
    },
    invalidate: [queryKeys.settings.household()],
  });

  if (householdQuery.isError) {
    return (
      <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <RetryableAlert
          title="读取失败"
          description={formatApiError(householdQuery.error)}
          onRetry={() => void householdQuery.refetch()}
        />
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
    saveHousehold
      .mutateAsync({ ownerPassword })
      .then(() => {
        setOverrides({}); // 草稿收敛为服务端现值(等价原 setValues(saved))
        setNotice('通用设置已保存');
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost(); // 立即隐藏主体;草稿不自动提交
          return;
        }
        if (kind === 'conflict') {
          // 409:提示冲突;失效已触发服务端现值重读,草稿覆盖层保留,不静默覆盖用户编辑
          setConflictMessage('设置已被其他操作修改,保存未生效;当前编辑已保留,可对比后重试。');
          return;
        }
        throw cause; // 密码错误等:弹层保持并呈现
      });

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <Form onSubmit={handleSubmit} className="flex max-w-md flex-col gap-3" aria-label="家庭通用设置">
        <TextField className="w-full" value={values.name} onChange={(name: string) => setOverrides({ ...overrides, name })}>
          <Label>家庭名称</Label>
          <Input name="name" maxLength={100} />
        </TextField>
        <TextField className="w-full" value={values.language} onChange={(language: string) => setOverrides({ ...overrides, language })}>
          <Label>语言(如 zh-CN)</Label>
          <Input name="language" maxLength={35} />
        </TextField>
        <TextField
          className="w-full"
          value={values.timezone}
          onChange={(timezone: string) => setOverrides({ ...overrides, timezone })}
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
        {conflictMessage !== null ? (
          <div role="alert" className="flex flex-col gap-2 rounded border border-warning p-3 text-sm" data-testid="general-conflict">
            <p className="text-warning">{conflictMessage}</p>
            <p className="text-muted">
              服务端现值:名称「{server.name}」/ 语言 {server.language} / 时区 {server.timezone} / 版本 {server.version}
            </p>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  // 显式重读:丢弃本地草稿,以服务端现值继续(用户主动,不静默)
                  setOverrides({});
                  void householdQuery.refetch();
                  setConflictMessage(null);
                }}
              >
                读取现值并放弃我的编辑
              </Button>
              <Button variant="ghost" size="sm" onPress={() => setConflictMessage(null)}>
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
