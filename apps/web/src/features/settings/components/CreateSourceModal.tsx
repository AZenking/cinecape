/**
 * 新建来源弹层(自 settings-sources-page 抽出;018 IPTV 管理优化):
 * 页头级「新建来源」主操作由聚合页(IPTV 管理)与来源管理页共用,避免为承载
 * 创建表单而重复挂载来源列表(EPG 标签的列表已由合并看板承载)。
 *
 * 交互与语义与原实现逐字一致:Modal + Tabs 切换来源类型、按 allowedKinds 暴露
 * 子集、NAS 根目录一次性读取、创建成功回调 onCreated(列表回填由调用方 invalidate
 * 驱动)、013/ADR-0017 常规运维免当次密码、010 vod 分支契约体不变。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Form, Input, Label, ListBox, Modal, Select, Tabs, TextField } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import { useAppMutation } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { formatApiError } from '../../../shared/query/error';
import { isFetchApiError, privateFetch } from '../../../shared/fetch';
import { classifySettingsWriteError } from '../shared/access-expiry';
import type { RootDto, SourceDto } from '../shared/settings-api';
import { useSettingsAccess } from '../settings-access-provider';

/** 来源类型(与 SettingsSourcesPage 同一词汇;菜单拆分用) */
export type SettingsSourceKind = 'iptv' | 'epg' | 'nas' | 'vod';

/** 010 来源 DTO 视图(005 SourceDto 的兼容扩展;kind 增加 'vod' + capabilities) */
export type SettingsSourceDto = Omit<SourceDto, 'kind'> & {
  kind: SourceDto['kind'] | 'vod';
  capabilities?: Vod.components['schemas']['VodSourceCapabilities'];
};

export interface CreateSourceModalProps {
  /** 允许的来源类型(各菜单页仅暴露自己的子集;缺省全量) */
  readonly allowedKinds?: readonly SettingsSourceKind[];
  /** 初始选中的来源类型(缺省取允许子集首项) */
  readonly defaultKind?: SettingsSourceKind;
  readonly onCreated: (source: SettingsSourceDto) => void;
  readonly onCancel: () => void;
}

export function CreateSourceModal({
  allowedKinds,
  defaultKind,
  onCreated,
  onCancel,
}: CreateSourceModalProps): ReactNode {
  const access = useSettingsAccess();
  const [kind, setKind] = useState<SettingsSourceKind>(defaultKind ?? allowedKinds?.[0] ?? 'iptv');
  const [name, setName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [rootKey, setRootKey] = useState('');
  const [relativeDirectory, setRelativeDirectory] = useState('');
  const [roots, setRoots] = useState<RootDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // NAS 根目录读取:键工厂无对应键(shared/query/keys.ts 本任务只读),保留表单级
  // 一次性命令式读取(NAS 表单打开时一次;偏差已记录 —— 见 T025 报告「迁移映射」)
  useEffect(() => {
    if (kind === 'nas' && roots === null) {
      void privateFetch<RootDto[]>('/settings/source-roots')
        .then(setRoots)
        .catch((cause: unknown) => {
          if (classifySettingsWriteError(cause) === 'access-lost') {
            access.handleAccessLost();
            return;
          }
          setRoots([]);
        });
    }
  }, [kind, roots, access]);

  // 创建来源:常规操作免当次密码(013/ADR-0017);成功后失效来源列表回填。
  // 010 vod 分支:创建体严格按契约 VodCreateSourceRequest(kind/name/
  // remoteUrl/adapter),不携带 enabled/privateAccessApproved(未知字段服务端拒绝;
  // NAS/EPG 绑定字段在 vod 下同理禁带);iptv/epg/nas 分支保持 005 面不变(除密码)。
  const createSource = useAppMutation({
    domain: 'settings',
    feedback: 'confirmed',
    mutationFn: () =>
      privateFetch<SettingsSourceDto>('/settings/sources', {
        method: 'POST',
        body:
          kind === 'vod'
            ? {
                kind,
                name: name.trim(),
                remoteUrl: remoteUrl.trim(),
                adapter: 'apple-cms-json' as const,
              }
            : {
                kind,
                name: name.trim(),
                enabled: true,
                privateAccessApproved: true,
                ...(kind !== 'nas' ? { remoteUrl: remoteUrl.trim() } : { rootKey, relativeDirectory }),
              },
      }),
    invalidate: [queryKeys.settings.sources()],
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (name.trim() === '') {
      setError('请填写来源名称');
      return;
    }
    if (kind !== 'nas' && remoteUrl.trim() === '') {
      setError(
        kind === 'epg'
          ? 'EPG 来源必须提供 XMLTV remoteUrl'
          : kind === 'vod'
            ? '在线点播来源必须提供 remoteUrl(根地址)'
            : 'IPTV 来源必须提供 remoteUrl',
      );
      return;
    }
    if (kind === 'nas' && (rootKey === '' || relativeDirectory === '')) {
      setError('NAS 来源必须选择根目录与相对目录');
      return;
    }
    setError(null);
    submitCreate(); // 013/ADR-0017:创建来源为常规操作,免当次密码直接提交
  };

  const submitCreate = (): void => {
    void createSource
      .mutateAsync(undefined)
      .then((created) => {
        onCreated(created);
      })
      .catch((cause: unknown) => {
        const kindOf = classifySettingsWriteError(cause);
        if (kindOf === 'access-lost') {
          access.handleAccessLost();
          return;
        }
        // 010 T034:其余拒绝在表单内 alert 呈现服务端稳定文案——422
        // SOURCE_TARGET_DENIED 显示服务端拒绝原因(detail 为稳定脱敏短语,无 URL 回显);
        // 409 VOD_QUOTA_EXCEEDED 显示「已达上限,请管理来源」;数据层另经 toast 轻提示。
        setError(isFetchApiError(cause) ? (cause.detail ?? cause.title) : formatApiError(cause));
      });
  };

  return (
    /* 新建来源交互:Modal 弹层承载 + Tabs 切换来源类型(替代 RadioGroup)。
       本组件挂载即开弹层(creating=true 驱动,isDirty 语义不变);取消/创建成功
       经 onCancel/onCreated 卸载。Tabs 只切换类型专属字段,表单状态留在本组件,
       面板卸载不丢输入;创建为常规操作,免当次密码直接提交(013/ADR-0017)。 */
    <Modal.Root
      isOpen
      onOpenChange={(next: boolean) => {
        if (!next) {
          onCancel();
        }
      }}
    >
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md">
          <Modal.Dialog aria-label="新建来源" data-testid="create-source-modal">
            <Modal.Header>
              <Modal.Heading className="text-base font-semibold">新建来源</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <Form onSubmit={handleSubmit} className="flex flex-col gap-5" aria-label="新建来源">
                <TextField className="w-full" value={name} onChange={setName}>
                  <Label>来源名称</Label>
                  <Input name="name" maxLength={100} />
                </TextField>
                <Tabs
                  selectedKey={kind}
                  onSelectionChange={(key) => setKind(key as SettingsSourceKind)}
                >
                  <Tabs.ListContainer>
                    <Tabs.List aria-label="来源类型">
                      {allowedKinds === undefined || allowedKinds.includes('iptv') ? (
                        <Tabs.Tab id="iptv">
                          IPTV
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      ) : null}
                      {allowedKinds === undefined || allowedKinds.includes('epg') ? (
                        <Tabs.Tab id="epg">
                          EPG(XMLTV)
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      ) : null}
                      {allowedKinds === undefined || allowedKinds.includes('nas') ? (
                        <Tabs.Tab id="nas">
                          NAS
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      ) : null}
                      {/* 010 T034:kind=vod(在线点播;Apple CMS JSON 适配器) */}
                      {allowedKinds === undefined || allowedKinds.includes('vod') ? (
                        <Tabs.Tab id="vod">
                          在线点播(VOD)
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      ) : null}
                    </Tabs.List>
                  </Tabs.ListContainer>
                  {allowedKinds === undefined || allowedKinds.includes('iptv') ? (
                    <Tabs.Panel id="iptv" className="pt-4">
                      <TextField className="w-full" value={remoteUrl} onChange={setRemoteUrl}>
                        <Label>播放列表地址(M3U URL)</Label>
                        <Input name="remoteUrl" placeholder="http://…" />
                      </TextField>
                    </Tabs.Panel>
                  ) : null}
                  {allowedKinds === undefined || allowedKinds.includes('epg') ? (
                    <Tabs.Panel id="epg" className="pt-4">
                      <TextField className="w-full" value={remoteUrl} onChange={setRemoteUrl}>
                        <Label>节目单地址(XMLTV URL)</Label>
                        <Input name="remoteUrl" placeholder="https://…/epg.xml" />
                      </TextField>
                    </Tabs.Panel>
                  ) : null}
                  {allowedKinds === undefined || allowedKinds.includes('nas') ? (
                    <Tabs.Panel id="nas" className="flex flex-col gap-5 pt-4">
                      <div className="flex flex-col gap-1">
                        {/* T013:NAS 根目录原生 select 元素 → HeroUI Select。选项(请选择… '' + roots)、
                            当前值(rootKey)与 onChange(setRootKey)语义等价;aria-label 替代 htmlFor。 */}
                        <span id="source-root-label" className="text-sm text-muted">
                          NAS 根目录
                        </span>
                        <Select
                          aria-labelledby="source-root-label"
                          selectedKey={rootKey}
                          onSelectionChange={(key) => {
                            if (key !== null) {
                              setRootKey(String(key));
                            }
                          }}
                        >
                          <Select.Trigger data-testid="source-root">
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              <ListBox.Item id="" textValue="请选择…">
                                请选择…
                              </ListBox.Item>
                              {(roots ?? []).map((root) => (
                                <ListBox.Item key={root.rootKey} id={root.rootKey} textValue={root.label}>
                                  {root.label}
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      </div>
                      <TextField className="w-full" value={relativeDirectory} onChange={setRelativeDirectory}>
                        <Label>相对目录</Label>
                        <Input name="relativeDirectory" placeholder="movies" />
                      </TextField>
                    </Tabs.Panel>
                  ) : null}
                  {allowedKinds === undefined || allowedKinds.includes('vod') ? (
                    <Tabs.Panel id="vod" className="flex flex-col gap-5 pt-4">
                      <TextField className="w-full" value={remoteUrl} onChange={setRemoteUrl}>
                        <Label>在线点播根地址(Apple CMS URL)</Label>
                        <Input name="remoteUrl" placeholder="http://…" />
                      </TextField>
                      {/* 010 T034:adapter 固定 apple-cms-json 展示(内置唯一适配器,不提供选择) */}
                      <div className="flex flex-col gap-1">
                        <span className="text-sm text-muted">适配器(内置,不可更改)</span>
                        <span className="rounded bg-surface px-2 py-1 text-sm text-foreground" data-testid="create-vod-adapter">
                          apple-cms-json
                        </span>
                      </div>
                    </Tabs.Panel>
                  ) : null}
                </Tabs>
                {error !== null ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" size="sm" onPress={onCancel}>
                    取消
                  </Button>
                  <Button type="submit" variant="primary" size="sm" data-testid="create-source-submit">
                    {kind === 'vod' ? '创建(下一步测试连通性)' : '创建(下一步开始导入)'}
                  </Button>
                </div>
              </Form>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
