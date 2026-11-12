/**
 * 家庭设置页(013 T018, US2; 角色差异化设置体系;原「通用设置」随侧栏分组语义化更名;
 * 013/ADR-0017 演进:常规运维免当次密码):
 * - 免临时 Ticket: 直接通过会话凭据读取家庭设置 (household: name, language, timezone);
 * - 家庭名称/语言/时区草稿以「服务端现值 + 覆盖层」承载(渲染期派生,零同步副作用);
 * - 保存为 confirmed 变更(expectedVersion CAS,免当次密码直接提交):成功后失效键以
 *   服务端真值回填并清空覆盖层(等价原 setValues(saved));timezone 须为运行环境
 *   认可的 IANA 时区(提交前本地预检 + 服务端权威);
 * - 未保存编辑离开/切换子模块经 useUnsavedGuard 拦截,不自动提交;
 * - 409 VERSION_CONFLICT 提示冲突并失效重读服务端现值,草稿覆盖层保留,不静默覆盖
 *   用户编辑;「读取现值并放弃我的编辑」清空覆盖层 + refetch;
 * - 移除对临时 Ticket 的强制读取与失效回退锁逻辑，主管理员畅行无阻;
 * - 请求体不携带 ownerPassword(服务端 strict 契约拒绝未知字段);单次密码交互仅
 *   保留于高危面(撤销设备/档案 PIN/主档案转移,见对应页面)。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Form, Input, Label, TextField } from '@heroui/react';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError } from './shared/access-expiry';
import type { HouseholdSettings } from './shared/settings-api';
import { useUnsavedGuard } from './shared/unsaved-guard';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';
import { SettingsSection } from './shared/settings-section';

interface FormValues {
  name: string;
  language: string;
  timezone: string;
}

export function SettingsGeneralPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const toast = useAppToast();
  const [overrides, setOverrides] = useState<Partial<FormValues>>({});

  const householdQuery = useAppQuery<HouseholdSettings>({
    domain: 'settings',
    queryKey: queryKeys.settings.household(),
    queryFn: ({ signal }) => privateFetch<HouseholdSettings>('/settings/household', { signal }),
  });

  const server = householdQuery.data ?? null;
  // 草稿 = 服务端现值 + 覆盖层(渲染期派生;保存成功后覆盖层清空 → 草稿回到现值)
  const values: FormValues | null =
    server === null ? null : { name: server.name, language: server.language, timezone: server.timezone, ...overrides };

  const isDirty =
    server !== null &&
    values !== null &&
    (values.name !== server.name || values.language !== server.language || values.timezone !== server.timezone);
  const guard = useUnsavedGuard(isDirty);

  // 保存家庭设置:confirmed 变更 + CAS(免当次密码直接提交);成功后失效键以服务端
  // 真值回填并清空覆盖层
  const saveHousehold = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: () => {
      if (server === null || values === null) {
        return Promise.reject(new Error('no values'));
      }
      return privateFetch<HouseholdSettings>('/settings/household', {
        method: 'PATCH',
        body: {
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
        <SettingsPageHeader description={null} />
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
        <SettingsPageHeader description={null} />
        <LoadingSpinner label="正在读取家庭设置…" />
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
      toast.error('家庭名称不能为空');
      return;
    }
    if (!timezoneUsable) {
      toast.error('时区必须是 IANA 时区名称(例如 Asia/Shanghai)');
      return;
    }
    save(); // 013/ADR-0017:常规操作免当次密码,直接提交
  };

  const save = (): void =>
    void saveHousehold
      .mutateAsync(undefined)
      .then(() => {
        setOverrides({}); // 草稿收敛为服务端现值(等价原 setValues(saved))
        toast.success('家庭设置已保存');
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        if (kind === 'conflict') {
          // 409:提示冲突;失效已触发服务端现值重读,草稿覆盖层保留,不静默覆盖用户编辑。
          // 提示走 toast(带服务端现值说明 + 「读取现值并放弃我的编辑」动作;
          // 关闭/自动消失即「保留我的编辑」)
          toast.warning('设置已被其他操作修改,保存未生效;当前编辑已保留,可对比后重试。', {
            description: `服务端现值:名称「${server.name}」/ 语言 ${server.language} / 时区 ${server.timezone} / 版本 ${server.version}`,
            actionLabel: '读取现值并放弃我的编辑',
            onAction: () => {
              setOverrides({});
              void householdQuery.refetch();
            },
          });
          return;
        }
        // 其余拒绝(校验等)由 useAppMutation onError 统一经 toast 呈现
      });

  return (
    <section aria-label={`设置 · ${title}`} data-testid="settings-general-page" className="flex flex-1 flex-col gap-6 py-2">
      <SettingsPageHeader description="管理整个家庭的基础信息" />
      <div className="w-full">
        <Form onSubmit={handleSubmit} className="flex flex-col gap-4" aria-label="家庭设置">
          <SettingsSection
            title="家庭基础信息"
            description="这些设置适用于整个家庭"
          >
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">家庭名称</span>
                  <span className="text-xs text-muted">显示在家庭空间中的名称</span>
                </div>
                <TextField className="w-full shrink-0 sm:w-64" value={values.name} onChange={(name: string) => setOverrides({ ...overrides, name })}>
                  <Label className="sr-only">家庭名称</Label>
                  <Input name="name" maxLength={100} variant="secondary" />
                </TextField>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">语言</span>
                  <span className="text-xs text-muted">家庭默认使用的语言</span>
                </div>
                <TextField className="w-full shrink-0 sm:w-64" value={values.language} onChange={(language: string) => setOverrides({ ...overrides, language })}>
                  <Label className="sr-only">语言(如 zh-CN)</Label>
                  <Input name="language" maxLength={35} variant="secondary" />
                </TextField>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium text-foreground">时区</span>
                  <span className="text-xs text-muted">用于节目时间和活动记录</span>
                </div>
                <TextField
                  className="w-full shrink-0 sm:w-64"
                  value={values.timezone}
                  onChange={(timezone: string) => setOverrides({ ...overrides, timezone })}
                  isInvalid={!timezoneUsable}
                >
                  <Label className="sr-only">时区(IANA,如 Asia/Shanghai)</Label>
                  <Input name="timezone" maxLength={100} variant="secondary" />
                </TextField>
              </div>
            </div>
            {!timezoneUsable ? (
              <p role="alert" className="text-sm text-danger">时区必须是运行环境认可的 IANA 时区名称。</p>
            ) : null}
            <Button type="submit" variant="primary" size="sm" className="self-start" isDisabled={!isDirty} data-testid="general-save">
              保存修改
            </Button>
          </SettingsSection>
        </Form>
      </div>
      {guard.dialog}
    </section>
  );
}
