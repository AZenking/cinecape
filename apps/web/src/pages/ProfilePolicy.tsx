/**
 * 内容策略管理页(阶段 2,T013/US1,FR-010)。
 *
 * - 读取 GET /profiles/{id}/policy,编辑最高内容等级(内部年龄阈值 0～18)与
 *   未评级开关;PUT 为可编辑配置整体保存(版本检查,相同值也递增版本);
 * - 保存前必须家长验证(主账号密码,弹窗当次提交后清空,不缓存);
 * - 三类名单只读:阶段 2 无媒体目录,不开放任意 ID 编辑(FR-013),
 *   显示「媒体目录接入后可配置」;界面须说明未评级与儿童频道允许名单的局限;
 * - 保存失败保留表单输入;409 版本冲突提示重新加载(由用户主动选择,
 *   重新加载会以服务端最新值覆盖本地未保存修改);
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
import type { components, PolicyDto } from '@hmp/shared';

type ProfileDto = components['schemas']['ProfileDto'];

const LEVEL_MIN = 0;
const LEVEL_MAX = 18;

interface ListSectionProps {
  title: string;
  description: string;
  ids: string[];
}

function ListSection({ title, description, ids }: ListSectionProps) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-0.5 text-xs text-muted">{description}</p>
      <p className="mt-2 text-sm text-foreground">
        {ids.length === 0 ? (
          <span className="text-muted">空(未配置)</span>
        ) : (
          <span>
            {ids.length} 项<span className="text-muted">(只读)</span>
          </span>
        )}
      </p>
    </div>
  );
}

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

  const [saving, setSaving] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const dirty = useMemo(() => {
    if (policy === null) {
      return false;
    }
    return policy.maxContentLevel !== Number(levelDraft) || policy.allowUnrated !== unratedDraft;
  }, [policy, levelDraft, unratedDraft]);

  const applyPolicy = useCallback((next: PolicyDto): void => {
    setPolicy(next);
    setLevelDraft(String(next.maxContentLevel));
    setUnratedDraft(next.allowUnrated);
    setLevelError(null);
    setConflict(false);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    setNotice(null);
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

  const openVerify = (): void => {
    const level = Number(levelDraft);
    if (!Number.isInteger(level) || level < LEVEL_MIN || level > LEVEL_MAX) {
      setLevelError(`等级须为 ${LEVEL_MIN}～${LEVEL_MAX} 的整数(内部年龄阈值)`);
      return;
    }
    setNotice(null);
    setVerifyError(null);
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
              策略已被其他设备修改并保存。你的输入已保留;点击「重新加载」会以服务端最新值覆盖本地未保存的修改。
            </Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="outline" onPress={() => void load()}>
            重新加载
          </Button>
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
            <Button variant="primary" isDisabled={!dirty} onPress={openVerify}>
              保存(需家长验证)
            </Button>
            <span className="text-xs text-muted">保存失败时输入会被保留。</span>
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>允许 / 禁止名单(只读)</Card.Title>
          <Card.Description>
            名单编辑将在媒体目录接入后开放(阶段 3,需资源归属校验);当前由服务端管理,不接受手动输入任意 ID。
          </Card.Description>
        </Card.Header>
        <Card.Content className="grid gap-3 md:grid-cols-3">
          <ListSection
            title="媒体允许名单"
            description="已评级的允许媒体可覆盖普通等级上限;不覆盖未评级开关与儿童频道门槛。"
            ids={policy.allowedMediaIds}
          />
          <ListSection
            title="媒体禁止名单"
            description="禁止优先:同一媒体同时允许与禁止时判定为禁止。"
            ids={policy.blockedMediaIds}
          />
          <ListSection
            title="儿童频道允许名单"
            description="儿童仅可观看名单内频道(必要条件,非节目级安全承诺);空名单表示全部频道不可访问;成人不受此名单限制。"
            ids={policy.allowedChannelIds}
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
        title="家长验证 · 保存内容策略"
        description={`保存「${profile?.name ?? '该档案'}」的内容策略(当前版本 ${policy.version})`}
        isPending={saving}
        error={verifyError}
        onCancel={() => {
          if (!saving) {
            setVerifyOpen(false);
            setVerifyError(null);
          }
        }}
        onConfirm={(password) => void handleSave(password)}
      />
    </section>
  );
}
