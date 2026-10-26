/**
 * 来源新增/编辑表单(T030;T045 增强)。
 *
 * - kind 仅新增可选;编辑时按 kind 展示字段:IPTV=名称/remoteUrl(password 型)/
 *   privateAccessApproved/epgSourceId 下拉;EPG=仅名称/remoteUrl/启用三个可编辑项
 *   并提示「首次保存后使用刷新完成导入」(无单独导入或连通性检查入口,FR-018);
 *   NAS=名称/rootKey 下拉(仅创建)/relativeDirectory(仅创建);
 * - IPTV 编辑的 EPG 下拉:选项=同家庭 kind=epg 来源(含「不关联」);选择已停用的
 *   EPG 显示提示但不阻止保存(契约允许关联禁用 EPG,观看时显示「暂无节目」);
 * - remoteUrl 为 writeOnly:编辑时不回填,留空=保留现值;掩码「***」前端拦截,
 *   后端校验兜底(契约:remoteUrl=null/空串/掩码拒绝);
 * - 编辑时换远程地址会清除原访问许可(契约:不能继承旧目标的许可),表单给出文字提示;
 * - 表单只做格式校验与 payload 组装;提交经家长验证弹窗由页面执行。
 */
import { useMemo, useState, type FormEvent } from 'react';
import {
  Button,
  Checkbox,
  Chip,
  FieldError,
  Form,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextField,
} from '@heroui/react';
import type { CreateSourceRequest, PatchSourceRequest, RootDto, SourceDto } from '@hmp/shared';
import {
  EPG_DISABLED_ASSOCIATION_HINT,
  EPG_IMPORT_HINT,
  SOURCE_KIND_LABELS,
  type SourceKind,
} from './messages';

/** 表单提交载荷:页面据此发起 create/patch(再经家长验证) */
export type SourceFormPayload =
  | { mode: 'create'; body: CreateSourceRequest }
  | { mode: 'edit'; sourceId: string; body: PatchSourceRequest };

export interface SourceFormCardProps {
  /** create=新增;edit=编辑目标来源(kind 与 NAS 根域不可改) */
  mode: { type: 'create' } | { type: 'edit'; source: SourceDto };
  /** 同家庭 kind=epg 的候选(GET /sources 过滤;用于 IPTV 编辑的 epgSourceId 下拉) */
  epgOptions: SourceDto[];
  /** NAS 根候选(GET /source-roots;用于 NAS 创建的 rootKey 下拉) */
  rootOptions: RootDto[];
  /** 家长验证进行中:禁用提交按钮 */
  submitting: boolean;
  /** 校验通过后上交载荷(页面打开家长验证弹窗) */
  onSubmit: (payload: SourceFormPayload) => void;
  /** 编辑模式下放弃编辑,回到新增(可缺省) */
  onCancelEdit?: () => void;
}

/** EPG 下拉的「不关联」哨兵值(PATCH 时映射为 null=解除关联) */
const EPG_NONE = '';

/** 名称长度边界(契约:name 1~100 字符) */
const NAME_MAX = 100;

/** 掩码输入(契约:掩码「***」不允许作为新地址提交) */
const MASK_PATTERN = /^[*＊]{3,}$/;

function isSourceKind(key: unknown): key is SourceKind {
  return key === 'iptv' || key === 'epg' || key === 'nas';
}

interface FormErrors {
  name?: string;
  remoteUrl?: string;
  rootKey?: string;
  relativeDirectory?: string;
}

export function SourceFormCard({
  mode,
  epgOptions,
  rootOptions,
  submitting,
  onSubmit,
  onCancelEdit,
}: SourceFormCardProps) {
  const isEdit = mode.type === 'edit';
  const source = isEdit ? mode.source : null;
  const kind: SourceKind = source?.kind ?? 'iptv';

  // 草稿状态:组件以 key={来源id|'create'} 由页面重挂载,初值直接取自 props
  const [kindDraft, setKindDraft] = useState<SourceKind>(kind);
  const [nameDraft, setNameDraft] = useState(source?.name ?? '');
  const [urlDraft, setUrlDraft] = useState('');
  const [approvedDraft, setApprovedDraft] = useState(false);
  const [enabledDraft, setEnabledDraft] = useState(source?.enabled ?? true);
  const [rootKeyDraft, setRootKeyDraft] = useState<string | null>(null);
  const [directoryDraft, setDirectoryDraft] = useState('');
  /** IPTV 编辑:epgSourceId 草稿(''=不关联) */
  const [epgIdDraft, setEpgIdDraft] = useState<string>(source?.epgSourceId ?? EPG_NONE);
  const [errors, setErrors] = useState<FormErrors>({});

  const activeKind: SourceKind = isEdit ? kind : kindDraft;
  const isRemoteKind = activeKind === 'iptv' || activeKind === 'epg';

  /** IPTV 编辑的 EPG 候选项:「不关联」+ 同家庭 epg 来源 */
  const epgItems = useMemo(() => {
    const items = epgOptions.map((option) => ({
      id: option.id,
      label: `${option.name}${option.enabled ? '' : '(已停用)'}`,
    }));
    // 当前关联值不在候选中时(异常场景)保留原值可选,避免静默丢失关联
    if (
      source?.epgSourceId !== null &&
      source?.epgSourceId !== undefined &&
      !items.some((item) => item.id === source.epgSourceId)
    ) {
      items.push({ id: source.epgSourceId, label: '当前关联(列表中不可见)' });
    }
    return items;
  }, [epgOptions, source]);

  /** 当前选中的 EPG 是否已停用(提示「观看时将显示暂无节目」,不阻止保存) */
  const selectedEpgDisabled = useMemo(() => {
    if (epgIdDraft === EPG_NONE) {
      return false;
    }
    const selected = epgOptions.find((option) => option.id === epgIdDraft);
    return selected !== undefined && !selected.enabled;
  }, [epgIdDraft, epgOptions]);

  const clearError = (key: keyof FormErrors): void => {
    setErrors((prev) => (prev[key] === undefined ? prev : { ...prev, [key]: undefined }));
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const name = nameDraft.trim();
    const url = urlDraft.trim();
    const nextErrors: FormErrors = {};

    if (name.length < 1 || name.length > NAME_MAX) {
      nextErrors.name = `名称须为 1～${NAME_MAX} 个字符`;
    }
    if (MASK_PATTERN.test(url)) {
      // 前端拦截掩码;后端对掩码同样拒绝(兜底)
      nextErrors.remoteUrl = '不能使用掩码「***」作为地址；编辑时留空表示保持现值不变';
    } else if (!isEdit && isRemoteKind && url === '') {
      nextErrors.remoteUrl = '请输入远程地址';
    }

    let body: CreateSourceRequest | PatchSourceRequest;
    if (!isEdit) {
      const createBody: CreateSourceRequest = {
        kind: activeKind,
        name,
        // IPTV/NAS 本期创建固定启用(契约默认 true);EPG 提供开关
        enabled: activeKind === 'epg' ? enabledDraft : true,
        privateAccessApproved: activeKind === 'iptv' ? approvedDraft : false,
      };
      if (isRemoteKind) {
        createBody.remoteUrl = url;
      }
      if (activeKind === 'iptv' && epgIdDraft !== EPG_NONE) {
        createBody.epgSourceId = epgIdDraft;
      }
      if (activeKind === 'nas') {
        if (rootKeyDraft === null || rootKeyDraft === '') {
          nextErrors.rootKey = '请选择 NAS 根目录';
        }
        if (directoryDraft.trim() === '') {
          nextErrors.relativeDirectory = '请输入相对目录';
        }
        createBody.rootKey = rootKeyDraft ?? undefined;
        createBody.relativeDirectory = directoryDraft.trim();
      }
      body = createBody;
    } else {
      if (source === null) {
        return;
      }
      const patchBody: PatchSourceRequest = { expectedVersion: source.version, name };
      // remoteUrl 省略=保留现值(契约);空串/掩码已在上方拦截
      if (isRemoteKind && url !== '') {
        patchBody.remoteUrl = url;
      }
      // 勾选=明确重新许可;不勾选=省略字段保留现值
      if (activeKind === 'iptv' && approvedDraft) {
        patchBody.privateAccessApproved = true;
      }
      if (activeKind === 'iptv') {
        const current = source.epgSourceId ?? EPG_NONE;
        if (epgIdDraft !== current) {
          patchBody.epgSourceId = epgIdDraft === EPG_NONE ? null : epgIdDraft;
        }
      }
      if (activeKind === 'epg' && enabledDraft !== source.enabled) {
        patchBody.enabled = enabledDraft;
      }
      body = patchBody;
    }

    setErrors(nextErrors);
    if (Object.values(nextErrors).some((message) => message !== undefined)) {
      return;
    }
    if (isEdit && source !== null) {
      onSubmit({ mode: 'edit', sourceId: source.id, body: body as PatchSourceRequest });
    } else {
      onSubmit({ mode: 'create', body: body as CreateSourceRequest });
    }
  };

  return (
    <Form
      className="flex flex-col gap-4"
      validationBehavior="aria"
      onSubmit={(event) => handleSubmit(event)}
    >
      {/* kind:仅新增可选;编辑只读展示(契约:kind 不可变) */}
      {isEdit ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted">类型</span>
          <Chip size="sm" variant="soft" color="default" aria-label={`类型 ${SOURCE_KIND_LABELS[kind]}`}>
            {SOURCE_KIND_LABELS[kind]}
          </Chip>
          <span className="text-xs text-muted">(创建后不可修改)</span>
        </div>
      ) : (
        <Select
          className="max-w-sm"
          value={kindDraft}
          onChange={(key) => {
            if (isSourceKind(key)) {
              setKindDraft(key);
            }
          }}
          placeholder="请选择来源类型"
          aria-label="来源类型"
          isDisabled={submitting}
        >
          <Label>类型</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              <ListBox.Item id="iptv" textValue="IPTV 播放列表">
                IPTV 播放列表
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="epg" textValue="EPG 节目指南">
                EPG 节目指南
                <ListBox.ItemIndicator />
              </ListBox.Item>
              <ListBox.Item id="nas" textValue="NAS 媒体目录">
                NAS 媒体目录
                <ListBox.ItemIndicator />
              </ListBox.Item>
            </ListBox>
          </Select.Popover>
        </Select>
      )}

      <TextField
        value={nameDraft}
        onChange={(value) => {
          setNameDraft(value);
          clearError('name');
        }}
        isInvalid={errors.name !== undefined}
        isRequired
        validationBehavior="aria"
        fullWidth
        isDisabled={submitting}
      >
        <Label>名称</Label>
        <Input type="text" placeholder={`例如:客厅 IPTV(1～${NAME_MAX} 字符)`} />
        <FieldError>{errors.name}</FieldError>
      </TextField>

      {isRemoteKind && (
        <>
          <TextField
            value={urlDraft}
            onChange={(value) => {
              setUrlDraft(value);
              clearError('remoteUrl');
            }}
            isInvalid={errors.remoteUrl !== undefined}
            isRequired={!isEdit}
            validationBehavior="aria"
            fullWidth
            isDisabled={submitting}
          >
            <Label>远程地址</Label>
            <Input
              type="password"
              autoComplete="off"
              placeholder={isEdit ? '已保存，留空保持不变' : 'https://…'}
            />
            <FieldError>{errors.remoteUrl}</FieldError>
          </TextField>
          {isEdit && urlDraft.trim() !== '' && (
            <p className="text-xs text-warning">
              ⚠ 填写新地址会清除原访问许可;如新地址位于内网/私有网络,需重新勾选下方确认。
            </p>
          )}
        </>
      )}

      {activeKind === 'iptv' && (
        <>
          <Checkbox
            isSelected={approvedDraft}
            onChange={(selected) => setApprovedDraft(selected)}
            isDisabled={submitting}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              我确认允许访问该远程地址(privateAccessApproved)
            </Checkbox.Content>
          </Checkbox>

          {/* IPTV 编辑:可选 EPG 关联(US4;选项=同家庭 kind=epg 来源,含「不关联」) */}
          {isEdit && (
            <>
              <Select
                className="max-w-sm"
                value={epgIdDraft}
                onChange={(key) => {
                  if (typeof key === 'string') {
                    setEpgIdDraft(key);
                  }
                }}
                placeholder="请选择 EPG 来源"
                aria-label="关联 EPG 来源"
                isDisabled={submitting}
              >
                <Label>关联 EPG 来源(可选)</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id={EPG_NONE} textValue="不关联">
                      不关联
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                    {epgItems.map((item) => (
                      <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
                        {item.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
              {/* 关联已停用 EPG:契约允许保存,观看时频道显示「暂无节目」 */}
              {selectedEpgDisabled && <p className="text-xs text-warning">⚠ {EPG_DISABLED_ASSOCIATION_HINT}</p>}
            </>
          )}
        </>
      )}

      {/* EPG 来源:仅名称/远程地址/启用三个可编辑项(FR-018);导入由首次刷新完成 */}
      {activeKind === 'epg' && (
        <>
          <Switch isSelected={enabledDraft} onChange={setEnabledDraft} isDisabled={submitting}>
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              启用该来源
            </Switch.Content>
          </Switch>
          <p className="text-xs text-muted">{EPG_IMPORT_HINT}</p>
        </>
      )}

      {activeKind === 'nas' &&
        (isEdit ? (
          <div className="space-y-1 rounded-lg border border-border bg-surface p-3 text-sm">
            <p>
              <span className="text-muted">根域:</span>
              {source?.locationLabel ?? '—'}
              <span className="text-xs text-muted">(不可修改)</span>
            </p>
            <p className="text-xs text-muted">相对目录已保存且不可修改。</p>
          </div>
        ) : (
          <>
            <Select
              className="max-w-sm"
              value={rootKeyDraft}
              onChange={(key) => {
                setRootKeyDraft(typeof key === 'string' ? key : null);
                clearError('rootKey');
              }}
              placeholder={rootOptions.length === 0 ? '暂无可用根目录' : '请选择根目录'}
              aria-label="NAS 根目录"
              isDisabled={submitting || rootOptions.length === 0}
            >
              <Label>根目录</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {rootOptions.map((root) => (
                    <ListBox.Item key={root.rootKey} id={root.rootKey} textValue={root.label}>
                      {root.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <FieldError>{errors.rootKey}</FieldError>

            <TextField
              value={directoryDraft}
              onChange={(value) => {
                setDirectoryDraft(value);
                clearError('relativeDirectory');
              }}
              isInvalid={errors.relativeDirectory !== undefined}
              isRequired
              validationBehavior="aria"
              fullWidth
              isDisabled={submitting}
            >
              <Label>相对目录</Label>
              <Input type="text" placeholder="例如:movies(根目录下的相对路径)" />
              <FieldError>{errors.relativeDirectory}</FieldError>
            </TextField>
          </>
        ))}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" isPending={submitting}>
          {isEdit ? '保存修改(需家长验证)' : '创建来源(需家长验证)'}
        </Button>
        {isEdit && (
          <Button type="button" variant="ghost" isDisabled={submitting} onPress={onCancelEdit}>
            取消编辑
          </Button>
        )}
        <span className="text-xs text-muted">保存失败时输入会被保留。</span>
      </div>
    </Form>
  );
}
