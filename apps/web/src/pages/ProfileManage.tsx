/**
 * 档案管理页(T031,User Story 2 / FR-013/016)。
 *
 * - 列表(GET /profiles,含 status)+ 创建表单(名称 / 类型 adult|child /
 *   可选 PIN 4-12 位 / 设为默认)。
 * - 每行操作:编辑名称(PATCH name)、设为默认(PATCH isDefault:true)、
 *   停用/启用(PATCH status;409 LAST_ACTIVE_PROFILE → 「至少保留一个可用档案」)、
 *   设置/清除 PIN(PATCH pin / clearPin)。
 * - 所有变更成功后:await refresh()(会话上下文;若停用了当前观看档案,
 *   服务端清空 activeProfile,T036 静默回落轻条随之触发)+ 重新拉取列表。
 * - 仅 owner 可进入管理路由；POST/PATCH 同时由服务端验证 owner 权限。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  FieldError,
  Form,
  Input,
  Label,
  Modal,
  Radio,
  RadioGroup,
  Spinner,
  TextField,
} from '@heroui/react';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { ParentVerificationModal } from '../components/ParentVerificationModal';
import type { components } from '@hmp/shared';

type ProfileDto = components['schemas']['ProfileDto'];
type UpdateProfileRequest = components['schemas']['UpdateProfileRequest'];

/** 顶部通知(创建/编辑/停用结果) */
interface NoticeState {
  tone: 'success' | 'danger' | 'warning';
  message: string;
}

/** 契约字段边界(CreateProfileRequest / UpdateProfileRequest) */
const NAME_MAX = 50;
const PIN_MIN = 4;
const PIN_MAX = 12;

/** PIN 仅接受 4-12 位数字(quickstart 示例 1234) */
function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(pin);
}

export function ProfileManage() {
  const { refresh: refreshSession } = useSession();
  const navigate = useNavigate();

  // ---------------- 家长验证(阶段 2/FR-004):全部管理写操作须重验主账号密码 ----------------
  /** 待验证动作:run(password) 执行真实请求并返回错误文案(null = 成功) */
  const [verifyAction, setVerifyAction] = useState<{ description: string; run: (password: string) => Promise<string | null> } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const requestVerification = (description: string, run: (password: string) => Promise<string | null>): void => {
    setVerifyError(null);
    setVerifyAction({ description, run });
  };

  const handleVerifiedConfirm = async (password: string): Promise<void> => {
    const action = verifyAction;
    if (action === null || verifying) {
      return;
    }
    setVerifying(true);
    setVerifyError(null);
    try {
      const error = await action.run(password);
      if (error === null) {
        setVerifyAction(null);
      } else {
        setVerifyError(error);
      }
    } finally {
      setVerifying(false);
    }
  };

  // ---------------- 列表 ----------------
  const [profiles, setProfiles] = useState<ProfileDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  /** 行级操作进行中的档案 id:期间冻结该行全部按钮(单飞) */
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadProfiles = useCallback(async (): Promise<void> => {
    setLoading(true);
    setListError(null);
    try {
      const list = await api.get('/profiles');
      setProfiles(list);
    } catch (error) {
      setListError(
        error instanceof ApiError
          ? (error.detail ?? '档案列表加载失败,请稍后重试。')
          : '档案列表加载失败,请检查网络后重试。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // ---------------- 创建表单 ----------------
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'adult' | 'child'>('adult');
  const [newPin, setNewPin] = useState('');
  const [newIsDefault, setNewIsDefault] = useState(false);
  const [formErrors, setFormErrors] = useState<{ name?: string; pin?: string }>({});
  const [creating, setCreating] = useState(false);

  // ---------------- 行内弹层:编辑名称 / 设置 PIN ----------------
  const [nameTarget, setNameTarget] = useState<ProfileDto | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);

  const [pinTarget, setPinTarget] = useState<ProfileDto | null>(null);
  const [pinDraft, setPinDraft] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  /**
   * 通用 PATCH(ownerPassword 必填,阶段 2/FR-004):成功 → 刷新会话上下文 + 列表 + 成功通知;
   * 409(最后一个可用档案停用等)→ 「至少保留一个可用档案」;
   * 403 验证类错误(REQUIRED/FAILED/LOCKED)在家长验证弹窗内呈现,不弹顶部通知。
   */
  const patchProfile = useCallback(
    async (profile: ProfileDto, body: UpdateProfileRequest, successMessage: string, ownerPassword: string): Promise<string | null> => {
      setBusyId(profile.id);
      setNotice(null);
      try {
        await api.patch(
          `/profiles/${profile.id}` as '/profiles/{profileId}',
          { ...body, ownerPassword },
        );
        await refreshSession();
        await loadProfiles();
        setNotice({ tone: 'success', message: successMessage });
        return null;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'PARENT_VERIFICATION_LOCKED') {
          return error.detail ?? '家长验证已锁定,请稍后重试。';
        }
        if (error instanceof ApiError && error.code === 'PARENT_VERIFICATION_FAILED') {
          return error.detail ?? '密码验证未通过,请重试。';
        }
        if (
          error instanceof ApiError &&
          (error.status === 409 || error.code === 'LAST_ACTIVE_PROFILE')
        ) {
          setNotice({
            tone: 'warning',
            message: error.detail ?? '至少保留一个可用档案',
          });
        } else if (error instanceof ApiError) {
          setNotice({
            tone: 'danger',
            message: error.detail ?? '操作失败,请稍后重试。',
          });
        } else {
          setNotice({ tone: 'danger', message: '操作失败,请稍后重试。' });
        }
        return error instanceof ApiError ? (error.detail ?? '操作失败,请稍后重试。') : '操作失败,请稍后重试。';
      } finally {
        setBusyId(null);
      }
    },
    [loadProfiles, refreshSession],
  );

  const openNameModal = (profile: ProfileDto): void => {
    setNameTarget(profile);
    setNameDraft(profile.name);
    setNameError(null);
  };

  const openPinModal = (profile: ProfileDto): void => {
    setPinTarget(profile);
    setPinDraft('');
    setPinError(null);
  };

  /** 表单校验通过后 → 家长验证 → 携密码创建(阶段 2/FR-004) */
  const submitCreate = (): void => {
    if (verifying) return;
    const name = newName.trim();
    const errors: { name?: string; pin?: string } = {};
    if (!name) {
      errors.name = '请输入档案名称';
    } else if (name.length > NAME_MAX) {
      errors.name = `名称不能超过 ${NAME_MAX} 个字符`;
    }
    if (newPin && !isValidPin(newPin)) {
      errors.pin = `PIN 需为 ${PIN_MIN}-${PIN_MAX} 位数字`;
    }
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    requestVerification(`创建档案「${name}」`, async (ownerPassword) => {
      setCreating(true);
      setNotice(null);
      try {
        await api.post('/profiles', {
          name,
          type: newType,
          isDefault: newIsDefault,
          ownerPassword,
          ...(newPin ? { pin: newPin } : {}),
        });
        setNewName('');
        setNewPin('');
        setNewIsDefault(false);
        setNewType('adult');
        await refreshSession();
        await loadProfiles();
        setNotice({ tone: 'success', message: `已创建档案「${name}」` });
        return null;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'PARENT_VERIFICATION_LOCKED') {
          return error.detail ?? '家长验证已锁定,请稍后重试。';
        }
        if (error instanceof ApiError && error.code === 'PARENT_VERIFICATION_FAILED') {
          return error.detail ?? '密码验证未通过,请重试。';
        }
        const message =
          error instanceof ApiError
            ? (error.detail ?? '创建失败,请稍后重试。')
            : '创建失败,请稍后重试。';
        setNotice({ tone: 'danger', message });
        return message;
      } finally {
        setCreating(false);
      }
    });
  };

  /** 名称弹窗保存:校验通过 → 关闭名称弹窗 → 家长验证 → PATCH */
  const saveName = (): void => {
    const target = nameTarget;
    const name = nameDraft.trim();
    if (!target || !name || name === target.name || name.length > NAME_MAX || verifying) {
      return;
    }
    setNameTarget(null);
    requestVerification(`重命名「${target.name}」为「${name}」`, (ownerPassword) =>
      patchProfile(target, { name, clearPin: false }, `已更新名称为「${name}」`, ownerPassword),
    );
  };

  /** PIN 弹窗保存:校验通过 → 关闭 PIN 弹窗 → 家长验证 → PATCH */
  const savePin = (): void => {
    const target = pinTarget;
    if (!target || verifying) {
      return;
    }
    if (!isValidPin(pinDraft)) {
      setPinError(`PIN 需为 ${PIN_MIN}-${PIN_MAX} 位数字`);
      return;
    }
    setPinTarget(null);
    requestVerification(`为「${target.name}」设置 PIN 保护`, (ownerPassword) =>
      patchProfile(target, { pin: pinDraft, clearPin: false }, `已为「${target.name}」设置 PIN 保护`, ownerPassword),
    );
  };

  const rowDisabled = (profile: ProfileDto): boolean =>
    busyId !== null || profile.id === nameTarget?.id || profile.id === pinTarget?.id;

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">档案管理</h1>
        <p className="mt-1 text-sm text-muted">
          创建、编辑、停用档案;停用最后一个可用档案会被拒绝。
        </p>
      </div>

      {/* 操作结果通知 */}
      {notice && (
        <Alert status={notice.tone}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{notice.tone === 'success' ? '操作成功' : '操作未完成'}</Alert.Title>
            <Alert.Description>{notice.message}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {/* 创建表单 */}
      <Card>
        <Card.Header>
          <Card.Title>新建档案</Card.Title>
          <Card.Description>PIN 为可选项(4-12 位数字),设置后切换需解锁。</Card.Description>
        </Card.Header>
        <Card.Content>
          <Form className="flex flex-col gap-4" validationBehavior="aria" onSubmit={(event) => { event.preventDefault(); submitCreate(); }}>
            <TextField
              value={newName}
              onChange={(value) => {
                setNewName(value);
                setFormErrors((prev) => (prev.name === undefined ? prev : { ...prev, name: undefined }));
              }}
              isInvalid={formErrors.name !== undefined}
              isRequired
              validationBehavior="aria"
              fullWidth
            >
              <Label>档案名称</Label>
              <Input type="text" placeholder="例如:爸爸 / 妹妹" />
              <FieldError>{formErrors.name}</FieldError>
            </TextField>

            <RadioGroup name="profileType" value={newType} onChange={(value) => { if (value === 'adult' || value === 'child') setNewType(value); }} orientation="horizontal" isDisabled={creating}>
              <Label>档案类型</Label>
              <Radio value="adult"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>成人</Radio.Content></Radio>
              <Radio value="child"><Radio.Content><Radio.Control><Radio.Indicator /></Radio.Control>儿童</Radio.Content></Radio>
            </RadioGroup>

            <TextField
              value={newPin}
              onChange={(value) => {
                setNewPin(value);
                setFormErrors((prev) => (prev.pin === undefined ? prev : { ...prev, pin: undefined }));
              }}
              isInvalid={formErrors.pin !== undefined}
              validationBehavior="aria"
              fullWidth
            >
              <Label>PIN(可选)</Label>
              <Input type="password" inputMode="numeric" placeholder={`${PIN_MIN}-${PIN_MAX} 位数字,留空则不设 PIN`} />
              <FieldError>{formErrors.pin}</FieldError>
            </TextField>

            <Checkbox
              isSelected={newIsDefault}
              onChange={(selected) => setNewIsDefault(selected)}
            >
              <Checkbox.Content>
                <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                设为默认档案
              </Checkbox.Content>
            </Checkbox>

            <Button
              variant="primary"
              isPending={creating}
              type="submit"
            >
              创建档案
            </Button>
          </Form>
        </Card.Content>
      </Card>

      {/* 档案列表 */}
      {loading ? (
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size="lg" />
          <p className="text-sm text-muted">正在加载档案…</p>
        </div>
      ) : listError ? (
        <div className="space-y-4">
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>档案加载失败</Alert.Title>
              <Alert.Description>{listError}</Alert.Description>
            </Alert.Content>
          </Alert>
          <Button variant="outline" onPress={() => void loadProfiles()}>
            重试
          </Button>
        </div>
      ) : profiles.length === 0 ? (
        <p className="py-8 text-sm text-muted">还没有档案,先用上方表单创建一个吧。</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between"
            >
              <div className="flex items-center gap-3">
                <div
                  aria-hidden="true"
                  className={`flex h-11 w-11 items-center justify-center rounded-lg text-lg font-bold text-white/90 ${
                    profile.type === 'child'
                      ? 'bg-gradient-to-br from-amber-500/70 to-rose-600/70'
                      : 'bg-gradient-to-br from-zinc-600/70 to-zinc-800/70'
                  } ${profile.status === 'disabled' ? 'opacity-40 grayscale' : ''}`}
                >
                  {profile.name.trim().charAt(0).toUpperCase() || '?'}
                </div>
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    <span className="truncate">{profile.name}</span>
                    <span className="rounded-full bg-default px-2 py-0.5 text-xs text-foreground">
                      {profile.type === 'child' ? '儿童' : '成人'}
                    </span>
                    {profile.isDefault && (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-white">默认</span>
                    )}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span className={profile.status === 'disabled' ? 'text-warning' : 'text-success'}>
                      {profile.status === 'disabled' ? '已停用' : '可用'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{profile.pinProtected ? '🔒 已设 PIN' : '未设 PIN'}</span>
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={rowDisabled(profile)}
                  onPress={() => navigate(`/profiles/${profile.id}/policy`)}
                >
                  内容策略
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={rowDisabled(profile)}
                  onPress={() => openNameModal(profile)}
                >
                  编辑名称
                </Button>
                {!profile.isDefault && (
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={rowDisabled(profile)}
                    onPress={() =>
                      requestVerification(`将「${profile.name}」设为默认`, (ownerPassword) =>
                        patchProfile(profile, { isDefault: true, clearPin: false }, `已将「${profile.name}」设为默认`, ownerPassword),
                      )
                    }
                  >
                    设为默认
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  isDisabled={rowDisabled(profile)}
                  onPress={() => openPinModal(profile)}
                >
                  {profile.pinProtected ? '更换 PIN' : '设置 PIN'}
                </Button>
                {profile.pinProtected && (
                  <Button
                    size="sm"
                    variant="outline"
                    isDisabled={rowDisabled(profile)}
                    onPress={() =>
                      requestVerification(`清除「${profile.name}」的 PIN 保护`, (ownerPassword) =>
                        patchProfile(profile, { clearPin: true }, `已清除「${profile.name}」的 PIN 保护`, ownerPassword),
                      )
                    }
                  >
                    清除 PIN
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={profile.status === 'active' ? 'danger-soft' : 'secondary'}
                  isDisabled={rowDisabled(profile)}
                  onPress={() =>
                    requestVerification(
                      profile.status === 'active' ? `停用「${profile.name}」` : `启用「${profile.name}」`,
                      (ownerPassword) =>
                        patchProfile(
                          profile,
                          {
                            status: profile.status === 'active' ? 'disabled' : 'active',
                            clearPin: false,
                          },
                          profile.status === 'active'
                            ? `已停用「${profile.name}」`
                            : `已启用「${profile.name}」`,
                          ownerPassword,
                        ),
                    )
                  }
                >
                  {profile.status === 'active' ? '停用' : '启用'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 编辑名称弹层 */}
      <Modal
        isOpen={nameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNameTarget(null);
          }
        }}
      >
        <Modal.Backdrop>
          <Modal.Container placement="center">
            <Modal.Dialog aria-label="编辑档案名称">
              <Modal.Body className="pt-4">
                <TextField
                  value={nameDraft}
                  isDisabled={verifying}
                  onChange={(value) => { setNameDraft(value); setNameError(null); }}
                  isInvalid={nameDraft.trim().length > NAME_MAX}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                  autoFocus
                >
                  <Label>档案名称</Label>
                  <Input type="text" placeholder={`不超过 ${NAME_MAX} 个字符`} />
                  <FieldError>
                    {nameDraft.trim().length > NAME_MAX ? `不能超过 ${NAME_MAX} 个字符` : undefined}
                  </FieldError>
                </TextField>
                {nameError && <Alert status="danger"><Alert.Content><Alert.Title>保存失败</Alert.Title><Alert.Description>{nameError}</Alert.Description></Alert.Content></Alert>}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="ghost" isDisabled={verifying} onPress={() => setNameTarget(null)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={verifying}
                  isDisabled={
                    nameDraft.trim().length === 0 ||
                    nameDraft.trim().length > NAME_MAX ||
                    nameDraft.trim() === (nameTarget?.name ?? '')
                  }
                  onPress={() => saveName()}
                >
                  保存
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* 设置 / 更换 PIN 弹层 */}
      <Modal
        isOpen={pinTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPinTarget(null);
          }
        }}
      >
        <Modal.Backdrop>
          <Modal.Container placement="center">
            <Modal.Dialog aria-label="设置档案 PIN">
              <Modal.Body className="space-y-3 pt-4">
                <p className="text-sm text-muted">
                  为「{pinTarget?.name ?? ''}」设置 PIN(4-12 位数字),清除保护请用列表中的「清除 PIN」。
                </p>
                <TextField
                  value={pinDraft}
                  isDisabled={verifying}
                  onChange={(value) => {
                    setPinDraft(value);
                    setPinError(null);
                  }}
                  isInvalid={pinError !== null}
                  isRequired
                  validationBehavior="aria"
                  fullWidth
                >
                  <Label>PIN</Label>
                  <Input type="password" inputMode="numeric" placeholder={`${PIN_MIN}-${PIN_MAX} 位数字`} />
                  <FieldError>{pinError}</FieldError>
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button variant="ghost" isDisabled={verifying} onPress={() => setPinTarget(null)}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  isPending={verifying}
                  isDisabled={!isValidPin(pinDraft)}
                  onPress={() => savePin()}
                >
                  保存
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* 家长验证弹窗(阶段 2/FR-004):创建/编辑/设默认/停用/启停/设清 PIN 全部须重验主账号密码 */}
      <ParentVerificationModal
        isOpen={verifyAction !== null}
        title="家长验证 · 档案管理"
        description={verifyAction?.description}
        isPending={verifying}
        error={verifyError}
        onCancel={() => {
          if (!verifying) {
            setVerifyAction(null);
            setVerifyError(null);
          }
        }}
        onConfirm={(password) => void handleVerifiedConfirm(password)}
      />
    </section>
  );
}
