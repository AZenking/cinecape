/**
 * 内容策略管理页(阶段 2,T013/US1,FR-010;阶段 3 T052/US3 扩展媒体名单编辑)。
 *
 * - 读取 GET /profiles/{id}/policy,编辑最高内容等级(内部年龄阈值 0～18)与
 *   未评级开关;PUT 为可编辑配置整体保存(版本检查,相同值也递增版本);
 * - T052 媒体名单:三名单(媒体允许/媒体禁止/儿童频道允许)本地草稿可编辑 ——
 *   添加经 ParentCandidatePicker 逐次家长验证查询候选,移除仅改草稿;
 *   「保存名单」经 PUT /profiles/{id}/policy/lists 整体替换三名单,保存时
 *   再次家长验证(ParentVerificationModal 当次密码);与等级入口共享同一策略
 *   版本,保存成功同步版本显示;
 * - 家长密码不缓存:验证弹窗与选择器均在提交后/失败/取消时清空(逐次验证,
 *   无长期令牌);失败保留非敏感表单(等级输入/搜索词/筛选/已选名单);
 * - 保存失败保留表单输入;409 POLICY_VERSION_CONFLICT 提示「策略已更新,
 *   请重新加载」并提供重载按钮(重新加载会以服务端最新值覆盖本地未保存修改);
 * - 服务端为唯一信任源:本页不依据客户端状态放宽任何校验。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  FieldError,
  Input,
  Label,
  Spinner,
  TextField,
} from '@heroui/react';
import { ApiError, api } from '../lib/api';
import { ParentVerificationModal } from '../components/ParentVerificationModal';
import { ParentCandidatePicker } from '../components/policy/ParentCandidatePicker';
import { PolicyListEditor } from '../components/policy/PolicyListEditor';
import { replacePolicyLists } from '../components/policy/policyListsApi';
import { friendlyPolicyErrorMessage } from '../components/policy/messages';
import type { components, PolicyDto } from '@hmp/shared';
import type { CandidateDto } from '@hmp/shared';

type ProfileDto = components['schemas']['ProfileDto'];

const LEVEL_MIN = 0;
const LEVEL_MAX = 18;

/** 三名单草稿的键(与契约 UpdateLists 字段一一对应) */
type PolicyListKey = 'allowedMediaIds' | 'blockedMediaIds' | 'allowedChannelIds';

interface PolicyListsDraft {
  allowedMediaIds: string[];
  blockedMediaIds: string[];
  allowedChannelIds: string[];
}

/** 由 PolicyDto 拷贝出本地草稿(重载时以服务端最新值覆盖) */
function toListsDraft(policy: PolicyDto): PolicyListsDraft {
  return {
    allowedMediaIds: [...policy.allowedMediaIds],
    blockedMediaIds: [...policy.blockedMediaIds],
    allowedChannelIds: [...policy.allowedChannelIds],
  };
}

/** 草稿与服务端名单是否一致(数量 + 成员;顺序不参与比较) */
function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(b);
  return a.every((id) => set.has(id));
}

/** 家长验证弹窗的用途:等级配置保存 or 媒体名单保存(同一弹窗实例复用) */
type VerifyPurpose = 'config' | 'lists';

export function ProfilePolicy() {
  const { profileId = '' } = useParams<{ profileId: string }>();

  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [policy, setPolicy] = useState<PolicyDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 表单(FR-010:保存失败保留输入;仅在主动重新加载时覆盖)
  const [levelDraft, setLevelDraft] = useState('');
  const [unratedDraft, setUnratedDraft] = useState(false);
  const [levelError, setLevelError] = useState<string | null>(null);

  // 三名单草稿(T052):添加/移除仅改本地,「保存名单」整体提交
  const [listsDraft, setListsDraft] = useState<PolicyListsDraft>({
    allowedMediaIds: [],
    blockedMediaIds: [],
    allowedChannelIds: [],
  });

  const [saving, setSaving] = useState(false);
  const [savingLists, setSavingLists] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyPurpose, setVerifyPurpose] = useState<VerifyPurpose>('config');
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 名单保存的非 409/非验证失败错误(稳定 code 文案;与成功 notice 分开展示) */
  const [saveProblem, setSaveProblem] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const dirty = useMemo(() => {
    if (policy === null) {
      return false;
    }
    return policy.maxContentLevel !== Number(levelDraft) || policy.allowUnrated !== unratedDraft;
  }, [policy, levelDraft, unratedDraft]);

  /** 名单草稿是否与服务端策略一致(决定「保存名单」可用性) */
  const listsDirty = useMemo(() => {
    if (policy === null) {
      return false;
    }
    return (
      !sameIdList(listsDraft.allowedMediaIds, policy.allowedMediaIds) ||
      !sameIdList(listsDraft.blockedMediaIds, policy.blockedMediaIds) ||
      !sameIdList(listsDraft.allowedChannelIds, policy.allowedChannelIds)
    );
  }, [policy, listsDraft]);

  const applyPolicy = useCallback((next: PolicyDto): void => {
    setPolicy(next);
    setLevelDraft(String(next.maxContentLevel));
    setUnratedDraft(next.allowUnrated);
    setLevelError(null);
    setListsDraft(toListsDraft(next));
    setConflict(false);
  }, []);

  /** 名单保存成功后的策略应用:同步版本与名单,保留未保存的等级配置输入(FR-010) */
  const applyListsPolicy = useCallback((next: PolicyDto): void => {
    setPolicy(next);
    setListsDraft(toListsDraft(next));
    setConflict(false);
  }, []);

  const addToListDraft = useCallback((key: PolicyListKey, id: string): void => {
    setListsDraft((prev) => {
      if (prev[key].includes(id)) {
        return prev;
      }
      return { ...prev, [key]: [...prev[key], id] };
    });
  }, []);

  const removeFromListDraft = useCallback((key: PolicyListKey, id: string): void => {
    setListsDraft((prev) => ({ ...prev, [key]: prev[key].filter((item) => item !== id) }));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    setNotice(null);
    setSaveProblem(null);
    try {
      const [profiles, loaded] = await Promise.all([
        api.get('/profiles'),
        api.getProfilePolicy(profileId),
      ]);
      setProfile(profiles.find((candidate) => candidate.id === profileId) ?? null);
      applyPolicy(loaded);
    } catch (error) {
      setLoadError(
        error instanceof ApiError
          ? (error.detail ?? '策略加载失败,请稍后重试。')
          : '策略加载失败,请检查网络后重试。',
      );
    } finally {
      setLoading(false);
    }
  }, [profileId, applyPolicy]);

  useEffect(() => {
    void load();
  }, [load]);

  const openVerify = (purpose: VerifyPurpose): void => {
    if (purpose === 'config') {
      const level = Number(levelDraft);
      if (!Number.isInteger(level) || level < LEVEL_MIN || level > LEVEL_MAX) {
        setLevelError(`等级须为 ${LEVEL_MIN}～${LEVEL_MAX} 的整数(内部年龄阈值)`);
        return;
      }
    }
    setNotice(null);
    setSaveProblem(null);
    setVerifyError(null);
    setVerifyPurpose(purpose);
    setVerifyOpen(true);
  };

  const handleSave = async (password: string): Promise<void> => {
    if (policy === null || saving) {
      return;
    }
    setSaving(true);
    setVerifyError(null);
    try {
      const updated = await api.updateProfilePolicy(profileId, {
        ownerPassword: password,
        expectedVersion: policy.version,
        policy: { maxContentLevel: Number(levelDraft), allowUnrated: unratedDraft },
      });
      applyPolicy(updated);
      setVerifyOpen(false);
      setNotice(`已保存(版本 ${updated.version})`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // 版本冲突:保留本地输入,提示用户主动重新加载(FR-010)
        setConflict(true);
        setVerifyOpen(false);
      } else if (
        error instanceof ApiError &&
        (error.status === 403 || error.status === 423)
      ) {
        // 验证失败/锁定:弹窗保持打开,允许稍后重试(服务端计数与锁定限流)
        setVerifyError(error.detail ?? '密码验证未通过,请重试。');
      } else {
        setNotice(null);
        setLoadError(null);
        setVerifyError(null);
        setVerifyOpen(false);
        setConflict(false);
        setNotice(error instanceof ApiError ? (error.detail ?? '保存失败,请稍后重试。') : '保存失败,请检查网络后重试。');
      }
    } finally {
      setSaving(false);
    }
  };

  /**
   * 保存三名单(T052):PUT /profiles/{id}/policy/lists 整体替换;
   * expectedVersion=当前策略 version(与等级入口共享同一版本);再次家长验证。
   */
  const handleSaveLists = async (password: string): Promise<void> => {
    if (policy === null || savingLists) {
      return;
    }
    setSavingLists(true);
    setVerifyError(null);
    try {
      const updated = await replacePolicyLists(profileId, {
        ownerPassword: password,
        expectedVersion: policy.version,
        allowedMediaIds: listsDraft.allowedMediaIds,
        blockedMediaIds: listsDraft.blockedMediaIds,
        allowedChannelIds: listsDraft.allowedChannelIds,
      });
      applyListsPolicy(updated);
      setVerifyOpen(false);
      setNotice(`媒体名单已保存(版本 ${updated.version})`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // POLICY_VERSION_CONFLICT:保留本地草稿,提示用户主动重新加载
        setConflict(true);
        setVerifyOpen(false);
      } else if (
        error instanceof ApiError &&
        (error.status === 403 || error.status === 423)
      ) {
        // 验证失败/锁定:弹窗保持打开,密码已随提交清空,可重输重试
        setVerifyError(friendlyPolicyErrorMessage(error, '密码验证未通过，请重试。'));
      } else {
        setNotice(null);
        setSaveProblem(friendlyPolicyErrorMessage(error, '名单保存失败，请检查网络后重试。'));
        setVerifyError(null);
        setVerifyOpen(false);
      }
    } finally {
      setSavingLists(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <Spinner size="lg" />
        <p className="text-sm text-muted">正在加载策略…</p>
      </div>
    );
  }

  if (loadError !== null || policy === null) {
    return (
      <div className="space-y-4">
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>策略加载失败</Alert.Title>
            <Alert.Description>{loadError ?? '目标档案不存在或不属于当前家庭。'}</Alert.Description>
          </Alert.Content>
        </Alert>
        <div className="flex gap-2">
          <Button variant="outline" onPress={() => void load()}>
            重试
          </Button>
          <Link to="/profiles/manage" className="text-sm text-muted underline-offset-4 hover:underline">
            返回档案管理
          </Link>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">内容策略</h1>
        <p className="mt-1 text-sm text-muted">
          {profile ? `档案「${profile.name}」(${profile.type === 'child' ? '儿童' : '成人'})` : `档案 ${profileId}`}
          · 当前版本 {policy.version}
        </p>
      </div>

      {notice && !conflict && (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>已保存</Alert.Title>
            <Alert.Description>{notice}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {conflict && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>保存冲突(版本过期)</Alert.Title>
            <Alert.Description>
              策略已更新，请重新加载。你的输入已保留(含等级配置与三名单);点击「重新加载」会以服务端最新值覆盖本地未保存的修改。
            </Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="outline" onPress={() => void load()}>
            重新加载
          </Button>
        </Alert>
      )}

      {saveProblem !== null && !conflict && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>名单保存失败</Alert.Title>
            <Alert.Description>{saveProblem}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      <Card>
        <Card.Header>
          <Card.Title>可编辑配置</Card.Title>
          <Card.Description>
            等级为内部年龄阈值(0～18,非法定或地区分级);保存需家长验证,版本每次保存递增。
          </Card.Description>
        </Card.Header>
        <Card.Content className="space-y-5">
          <TextField
            value={levelDraft}
            onChange={(value) => {
              setLevelDraft(value);
              setLevelError(null);
            }}
            isInvalid={levelError !== null}
            validationBehavior="aria"
            fullWidth
          >
            <Label>最高内容等级(内部年龄阈值)</Label>
            <Input type="number" inputMode="numeric" min={LEVEL_MIN} max={LEVEL_MAX} placeholder={`${LEVEL_MIN}～${LEVEL_MAX}`} />
            <FieldError>{levelError ?? undefined}</FieldError>
          </TextField>

          <Checkbox isSelected={unratedDraft} onChange={(selected) => setUnratedDraft(selected)}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              允许未评级内容(allowUnrated)
            </Checkbox.Content>
          </Checkbox>
          <p className="text-xs text-muted">
            未评级与无法识别的外部分级等价。儿童默认关闭:即使频道/媒体已加入允许名单,未评级内容仍会被拒绝,
            需在此显式开启;开启后仍受禁止名单与(儿童)频道允许名单约束。
          </p>

          <div className="flex items-center gap-3">
            <Button variant="primary" isDisabled={!dirty} onPress={() => openVerify('config')}>
              保存(需家长验证)
            </Button>
            <span className="text-xs text-muted">保存失败时输入会被保留。</span>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>媒体名单</Card.Title>
          <Card.Description>
            经资源选择器添加同家庭媒体(可含被当前策略隐藏或不可用的项),移除仅改草稿;
            「保存名单」整体替换三名单并再次家长验证。禁止优先:同时允许与禁止判定为禁止;
            允许名单不覆盖未评级开关与儿童频道门槛。
          </Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <PolicyListEditor
              title="媒体允许名单"
              description="已评级的允许媒体可覆盖普通等级上限;不覆盖未评级开关与儿童频道门槛。"
              ids={listsDraft.allowedMediaIds}
              onRemove={(id) => removeFromListDraft('allowedMediaIds', id)}
              isDisabled={savingLists}
            />
            <PolicyListEditor
              title="媒体禁止名单"
              description="禁止优先:同一媒体同时允许与禁止时判定为禁止。"
              ids={listsDraft.blockedMediaIds}
              onRemove={(id) => removeFromListDraft('blockedMediaIds', id)}
              isDisabled={savingLists}
            />
            <PolicyListEditor
              title="儿童频道允许名单"
              description="儿童仅可观看名单内频道(必要条件,非节目级安全承诺);空名单表示全部频道不可访问;成人不受此名单限制。"
              ids={listsDraft.allowedChannelIds}
              onRemove={(id) => removeFromListDraft('allowedChannelIds', id)}
              isDisabled={savingLists}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              isDisabled={!listsDirty}
              onPress={() => openVerify('lists')}
            >
              保存名单(需家长验证)
            </Button>
            <span className="text-xs text-muted">
              整体替换三名单;保存失败时已选列表与搜索条件保留。
            </span>
          </div>

          <ParentCandidatePicker
            allowedMediaIds={listsDraft.allowedMediaIds}
            blockedMediaIds={listsDraft.blockedMediaIds}
            allowedChannelIds={listsDraft.allowedChannelIds}
            isAddDisabled={savingLists}
            onAddToAllowedMedia={(candidate: CandidateDto) =>
              addToListDraft('allowedMediaIds', candidate.id)
            }
            onAddToBlockedMedia={(candidate: CandidateDto) =>
              addToListDraft('blockedMediaIds', candidate.id)
            }
            onAddToAllowedChannel={(candidate: CandidateDto) =>
              addToListDraft('allowedChannelIds', candidate.id)
            }
          />
        </Card.Content>
      </Card>

      <div className="flex gap-3 text-sm">
        <Link to="/profiles/manage" className="text-muted underline-offset-4 hover:underline">
          返回档案管理
        </Link>
      </div>

      <ParentVerificationModal
        isOpen={verifyOpen}
        title={verifyPurpose === 'lists' ? '家长验证 · 保存媒体名单' : '家长验证 · 保存内容策略'}
        description={
          verifyPurpose === 'lists'
            ? `保存「${profile?.name ?? '该档案'}」的媒体名单(整体替换三名单,当前版本 ${policy.version})`
            : `保存「${profile?.name ?? '该档案'}」的内容策略(当前版本 ${policy.version})`
        }
        isPending={saving || savingLists}
        error={verifyError}
        onCancel={() => {
          if (!saving && !savingLists) {
            setVerifyOpen(false);
            setVerifyError(null);
          }
        }}
        onConfirm={(password) => {
          if (verifyPurpose === 'lists') {
            void handleSaveLists(password);
          } else {
            void handleSave(password);
          }
        }}
      />
    </section>
  );
}
