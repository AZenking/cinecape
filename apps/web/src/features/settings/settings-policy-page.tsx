/**
 * 内容权限页(T133,US8;FR-036;T025 数据层迁移;013/ADR-0017 演进):
 * - 档案列表与目标档案策略均经 useAppQuery(settings 域硬请求):isPending 门控 /
 *   isError RetryableAlert(formatApiError + 重试)/ 成功出主体;目标切换以
 *   key={profileId} 重挂编辑器 —— settings.policy 键无档案参数(键工厂固定),
 *   重挂保证新目标必以 isPending 硬请求起始,绝不显示上一档案的缓存策略;
 * - 等级与未评级保存(PUT policy)与名单整体替换(PUT lists)均为常规管理操作
 *   (013/ADR-0017:常规运维免当次密码;CAS 照旧);成功后失效 settings.policy 键
 *   以服务端真值回填并清空草稿覆盖层(等价原 setPolicy(saved));
 * - 409 VERSION_CONFLICT 提示冲突,失效已触发按现值重读,草稿复位,不静默覆盖;
 * - 授权失效立即隐藏主体,重新解锁后解锁门卸载重挂,硬请求重读最新版本。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Label, ListBox, Select, Switch, TextArea, TextField } from '@heroui/react';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { privateFetch } from '../../shared/fetch';
import { classifySettingsWriteError } from './shared/access-expiry';
import type { PolicyDto, ProfileSummary } from './shared/settings-api';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';

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

/** 草稿覆盖层:仅承载用户编辑过的字段,底座始终为服务端现值(渲染期派生) */
type PolicyDraftOverrides = Partial<
  Pick<PolicyDto, 'maxContentLevel' | 'allowUnrated' | 'allowedMediaIds' | 'blockedMediaIds' | 'allowedChannelIds'>
>;

export function SettingsPolicyPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [targetId, setTargetId] = useState<string | null>(null);

  const profilesQuery = useAppQuery<ProfileSummary[]>({
    domain: 'settings',
    queryKey: queryKeys.settings.profiles(),
    queryFn: ({ signal }) => privateFetch<ProfileSummary[]>('/settings/profiles', { signal }),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (profilesQuery.isError && classifySettingsWriteError(profilesQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [profilesQuery.isError, profilesQuery.error, access]);

  const profiles = profilesQuery.data ?? null;
  // 缺省目标:首个可用档案(targetId 未定时渲染期派生,等价原 current ?? first active)
  const activeId = targetId ?? profiles?.find((profile) => profile.status === 'active')?.id ?? null;

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-6">
      <SettingsPageHeader description="为每位成员设置合适的观看范围" />
      {profilesQuery.isPending ? <LoadingSpinner label="正在读取档案…" /> : null}
      {profilesQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(profilesQuery.error)}
          onRetry={() => void profilesQuery.refetch()}
        />
      ) : null}
      {profiles !== null ? (
        <Card variant="default" className="w-full rounded-2xl p-0 shadow-none">
          <Card.Header className="px-4 pb-2 pt-4">
            <Card.Title>目标成员</Card.Title>
          </Card.Header>
          <Card.Content className="px-4 pb-4 pt-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <Label>策略适用于</Label>
                <span className="text-xs text-muted">切换成员以查看其内容范围</span>
              </div>
          {/* T012:原生 select 元素 → HeroUI Select。选项文案(主档案/已停用后缀)、
              当前值(缺省首个可用档案)与 onChange(setTargetId → 编辑器重挂重读)语义等价;
              aria-label 替代原 htmlFor 关联(触发器为按钮,可聚焦可见)。 */}
          <span id="policy-profile-select-label" className="sr-only">目标档案</span>
          <Select
            aria-labelledby="policy-profile-select-label"
            variant="secondary"
            selectedKey={activeId}
            onSelectionChange={(key) => {
              if (key !== null) {
                setTargetId(String(key));
              }
            }}
          >
            <Select.Trigger data-testid="policy-profile-select">
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {profiles.map((profile) => (
                  <ListBox.Item
                    key={profile.id}
                    id={profile.id}
                    textValue={`${profile.name}${profile.isMain ? '(主档案)' : ''}${profile.status === 'active' ? '' : '(已停用)'}`}
                  >
                    {profile.name}
                    {profile.isMain ? '(主档案)' : ''}
                    {profile.status === 'active' ? '' : '(已停用)'}
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
            </div>
          </Card.Content>
        </Card>
      ) : null}
      {/* 编辑器按目标档案重挂:settings.policy 为无参键,切换目标必经重挂硬请求,
          杜绝上一档案的缓存策略闪现(契约:settings 域绝不渲染缓存旧值) */}
      {activeId !== null ? <PolicyEditor key={activeId} profileId={activeId} /> : null}
    </section>
  );
}

function PolicyEditor({ profileId }: { profileId: string }): ReactNode {
  const access = useSettingsAccess();
  const toast = useAppToast();
  const [overrides, setOverrides] = useState<PolicyDraftOverrides>({});

  const policyQuery = useAppQuery<PolicyDto>({
    domain: 'settings',
    queryKey: queryKeys.settings.policy(),
    queryFn: ({ signal }) => privateFetch<PolicyDto>(`/settings/profiles/${profileId}/policy`, { signal }),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态(解锁门随之隐藏本页)
  useEffect(() => {
    if (policyQuery.isError && classifySettingsWriteError(policyQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [policyQuery.isError, policyQuery.error, access]);

  const policy = policyQuery.data ?? null;
  const draft: PolicyDto | null = policy === null ? null : { ...policy, ...overrides };

  // 保存(等级/名单):常规操作免当次密码(013/ADR-0017)+ CAS;成功后失效策略键
  // 以服务端真值回填
  const savePolicy = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: (vars: { action: 'policy' | 'lists' }) => {
      if (policy === null || draft === null) {
        return Promise.reject(new Error('no policy'));
      }
      return vars.action === 'policy'
        ? privateFetch<PolicyDto>(`/settings/profiles/${profileId}/policy`, {
            method: 'PUT',
            body: {
              expectedVersion: policy.version,
              policy: { maxContentLevel: draft.maxContentLevel, allowUnrated: draft.allowUnrated },
            },
          })
        : privateFetch<PolicyDto>(`/settings/profiles/${profileId}/policy/lists`, {
            method: 'PUT',
            body: {
              expectedVersion: policy.version,
              allowedMediaIds: draft.allowedMediaIds,
              blockedMediaIds: draft.blockedMediaIds,
              allowedChannelIds: draft.allowedChannelIds,
            },
          });
    },
    invalidate: [queryKeys.settings.policy()],
  });

  const save = (action: 'policy' | 'lists'): void => {
    void savePolicy
      .mutateAsync({ action })
      .then(() => {
        setOverrides({}); // 草稿收敛为服务端现值(等价原 setPolicy(saved))
        toast.success(action === 'policy' ? '等级与未评级设置已保存' : '名单已整体替换保存');
      })
      .catch((cause: unknown) => {
        const kind = classifySettingsWriteError(cause);
        if (kind === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        if (kind === 'conflict') {
          // 409:提示冲突;失效已触发服务端现值重读,草稿复位(原 loadPolicy 整体替换语义)
          toast.error('策略已被其他操作修改(版本冲突):已重新读取服务端现值,请基于现值显式重试。');
          setOverrides({});
          return;
        }
        // 其余拒绝(校验等)由 useAppMutation onError 统一经 toast 呈现
      });
  };

  return (
    <>
      {policyQuery.isPending ? <LoadingSpinner label="正在读取策略…" /> : null}
      {policyQuery.isError ? (
        <RetryableAlert
          title="读取失败"
          description={formatApiError(policyQuery.error)}
          onRetry={() => void policyQuery.refetch()}
        />
      ) : null}
      {draft !== null && policy !== null ? (
        <div className="flex w-full flex-col gap-6" data-testid="policy-editor">
          <Card variant="default" className="w-full rounded-2xl p-0 shadow-none">
            <Card.Header className="px-4 pb-2 pt-4">
              <Card.Title>内容等级</Card.Title>
            </Card.Header>
            <Card.Content className="flex flex-col gap-5 px-4 pb-4 pt-2">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-col gap-1">
              {/* T012:等级选择原生 select 元素 → HeroUI Select。选项=LEVELS(服务端现值不在
                  预设档时追加「自定义(N)」);键为数值,onChange 折算 Number 与原等价。 */}
              <span id="policy-level-label" className="text-sm text-muted">最高内容等级</span>
                  <Select
                aria-labelledby="policy-level-label"
                variant="secondary"
                selectedKey={draft.maxContentLevel}
                onSelectionChange={(key) => {
                  if (key !== null) {
                    setOverrides({ ...overrides, maxContentLevel: Number(key) });
                  }
                }}
              >
                <Select.Trigger data-testid="policy-level">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {LEVELS.map((level) => (
                      <ListBox.Item key={level.value} id={level.value} textValue={level.label}>{level.label}</ListBox.Item>
                    ))}
                    {!LEVELS.some((level) => level.value === draft.maxContentLevel) ? (
                      <ListBox.Item id={draft.maxContentLevel} textValue={`自定义(${draft.maxContentLevel})`}>
                        {`自定义(${draft.maxContentLevel})`}
                      </ListBox.Item>
                    ) : null}
                  </ListBox>
                </Select.Popover>
                  </Select>
                </div>
                <Switch
                  isSelected={draft.allowUnrated}
                  onChange={(selected) => setOverrides({ ...overrides, allowUnrated: selected })}
                  aria-label="允许未评级内容"
                >
                  {/* Switch 根(react-aria SwitchField)是无交互 div,唯一可点击区域是
                      Switch.Content(SwitchButton,label 元素):Control 必须位于其内,
                      否则可见轨道在 label 外,点击轨道不触发 onChange */}
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Label className="text-sm">允许未评级内容</Label>
                  </Switch.Content>
                </Switch>
              </div>
              <Button
                variant="primary"
                size="sm"
                className="self-start"
                onPress={() => {
                  save('policy');
                }}
                data-testid="policy-save-level"
              >
                保存等级设置
              </Button>
            </Card.Content>
          </Card>

          <ListEditor
            name="allowedMediaIds"
            label="媒体允许名单(每行一个媒体 ID)"
            ids={draft.allowedMediaIds}
            onChange={(ids) => setOverrides({ ...overrides, allowedMediaIds: ids })}
          />
          <ListEditor
            name="blockedMediaIds"
            label="媒体禁止名单(每行一个媒体 ID)"
            ids={draft.blockedMediaIds}
            onChange={(ids) => setOverrides({ ...overrides, blockedMediaIds: ids })}
          />
          <ListEditor
            name="allowedChannelIds"
            label="频道白名单(每行一个频道 ID)"
            ids={draft.allowedChannelIds}
            onChange={(ids) => setOverrides({ ...overrides, allowedChannelIds: ids })}
          />
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-muted">名单整体替换保存;按版本 {policy.version} 冲突检测(CAS)。</p>
            <Button
              variant="primary"
              size="sm"
              onPress={() => {
                save('lists');
              }}
              data-testid="policy-save-lists"
            >
              保存名单
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ListEditor({
  name,
  label,
  ids,
  onChange,
}: {
  name: string;
  label: string;
  ids: string[];
  onChange: (ids: string[]) => void;
}): ReactNode {
  return (
    <Card variant="default" className="w-full rounded-2xl p-0 shadow-none">
      <Card.Header className="px-4 pb-2 pt-4">
        <Card.Title>{label.replace('(每行一个媒体 ID)', '').replace('(每行一个频道 ID)', '')}</Card.Title>
        <Card.Description>每行输入一个 ID，保存时替换现有名单</Card.Description>
      </Card.Header>
      <Card.Content className="px-4 pb-4 pt-2">
        <TextField
          className="w-full"
          name={name}
          value={ids.join('\n')}
          onChange={(value) => onChange(splitIds(value))}
        >
          <Label className="sr-only">{label}</Label>
          <TextArea variant="secondary" className="min-h-24 font-mono text-xs" spellCheck={false} />
        </TextField>
      </Card.Content>
    </Card>
  );
}
