/**
 * 档案选择页(T029,User Story 2 / FR-014/015;阶段 2 增补 FR-012)。
 *
 * - 挂载时 GET /profiles 拉取当前 Household 档案列表,Netflix 式横排大卡
 *   (components/ProfileCard):类型角标、默认标记、PIN 锁角标,停用档案置灰不可点。
 * - 点击行为:pinProtected → 打开 PinPad 解锁,成功后 POST /profiles/{id}/select;
 *   无 PIN → 直接 select。
 * - 阶段 2:家庭存在儿童档案时,选择未设 PIN 的成人会被服务端要求家长验证
 *   (403 PARENT_VERIFICATION_REQUIRED)→ 弹出家长验证(主账号密码,当次提交后清空),
 *   通过后携带 ownerPassword 重试 select;ownerPassword 不替代 PIN 解锁。
 * - 404/403(档案不存在/跨家庭/已停用)→ Alert 轻条提示并 refresh() 修正上下文;
 *   其余错误展示服务端 detail。服务端为唯一信任源,前端仅呈现其决定。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Spinner } from '@heroui/react';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { ProfileCard } from '../components/ProfileCard';
import { PinPad } from '../components/PinPad';
import { ParentVerificationModal } from '../components/ParentVerificationModal';
import type { components } from '@hmp/shared';

type ProfileDto = components['schemas']['ProfileDto'];

/** 顶部轻条(成功/失败共用,选中档案后留在页内展示) */
interface BannerState {
  tone: 'success' | 'danger';
  message: string;
}

export function ProfilePicker() {
  const { refresh } = useSession();

  const [profiles, setProfiles] = useState<ProfileDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerState | null>(null);
  /** 正在 select 的档案 id:期间冻结全部卡片,防重复提交 */
  const [selectingId, setSelectingId] = useState<string | null>(null);
  /** PIN 弹层目标;ref 保证解锁成功回调拿到的是发起时的档案 */
  const [pinTarget, setPinTarget] = useState<ProfileDto | null>(null);
  const pinTargetRef = useRef<ProfileDto | null>(null);
  /** 家长验证弹层目标(无 PIN 成人 + 家庭含儿童;FR-012) */
  const [verifyTarget, setVerifyTarget] = useState<ProfileDto | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const verifyTargetRef = useRef<ProfileDto | null>(null);

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

  /** POST /profiles/{id}/select → 刷新会话上下文 → 顶部轻条;403 REQUIRED → 家长验证 */
  const selectProfile = useCallback(
    async (profile: ProfileDto, ownerPassword?: string): Promise<void> => {
      setSelectingId(profile.id);
      setBanner(null);
      try {
        await api.post(
          `/profiles/${profile.id}/select` as '/profiles/{profileId}/select',
          ownerPassword === undefined ? {} : { ownerPassword },
        );
        await refresh();
        setBanner({ tone: 'success', message: `当前观看:${profile.name}` });
        // 验证后成功:关闭验证弹窗
        verifyTargetRef.current = null;
        setVerifyTarget(null);
        setVerifyError(null);
      } catch (error) {
        if (error instanceof ApiError) {
          // 家庭含儿童档案:选择未设 PIN 成人须家长验证(FR-012)→ 弹验证后带密码重试
          if (error.code === 'PARENT_VERIFICATION_REQUIRED') {
            verifyTargetRef.current = profile;
            setVerifyTarget(profile);
            setVerifyError(null);
            return;
          }
          // 验证失败/锁定(重试路径):保持弹窗展示错误,计数与锁定由服务端管理
          if (error.code === 'PARENT_VERIFICATION_FAILED' || error.code === 'PARENT_VERIFICATION_LOCKED') {
            setVerifyError(error.detail ?? '密码验证未通过,请稍后重试。');
            return;
          }
          const isUnavailable = error.status === 404 || error.status === 403;
          setBanner({
            tone: 'danger',
            message: isUnavailable
              ? `无法选择「${profile.name}」:${error.detail ?? '档案不可用'}`
              : (error.detail ?? '切换档案失败,请稍后重试。'),
          });
          // 档案可能已被停用/删除:刷新会话与列表修正展示
          await refresh();
          await loadProfiles();
        } else {
          setBanner({ tone: 'danger', message: '切换档案失败,请稍后重试。' });
        }
      } finally {
        setSelectingId(null);
      }
    },
    [loadProfiles, refresh],
  );

  const handleCardPress = useCallback(
    (profile: ProfileDto): void => {
      if (profile.status === 'disabled' || selectingId !== null) {
        return;
      }
      setBanner(null);
      if (profile.pinProtected) {
        pinTargetRef.current = profile;
        setPinTarget(profile);
        return;
      }
      void selectProfile(profile);
    },
    [selectingId, selectProfile],
  );

  /** PinPad 解锁成功 → 关闭弹层 → 继续 select */
  const handlePinSuccess = useCallback((): void => {
    const target = pinTargetRef.current;
    pinTargetRef.current = null;
    setPinTarget(null);
    if (target) {
      void selectProfile(target);
    }
  }, [selectProfile]);

  const closePinPad = useCallback((open: boolean): void => {
    if (!open) {
      pinTargetRef.current = null;
      setPinTarget(null);
    }
  }, []);

  const busy = selectingId !== null;

  return (
    <section className="space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">谁在看?</h1>
        <p className="mt-1 text-sm text-muted">选择档案继续,受 PIN 保护的档案需先解锁。</p>
      </div>

      {/* 顶部轻条:选择结果 / 错误提示 */}
      {banner && (
        <div
          role="status"
          className={`mx-auto max-w-2xl rounded-lg border px-4 py-3 text-sm ${
            banner.tone === 'success'
              ? 'border-success/40 bg-success/10 text-success'
              : 'border-danger/40 bg-danger/10 text-danger'
          }`}
        >
          {banner.message}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center gap-3 py-16">
          <Spinner size="lg" />
          <p className="text-sm text-muted">正在加载档案…</p>
        </div>
      ) : listError ? (
        <div className="mx-auto max-w-md space-y-4">
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>档案加载失败</Alert.Title>
              <Alert.Description>{listError}</Alert.Description>
            </Alert.Content>
          </Alert>
          <Button variant="outline" fullWidth onPress={() => void loadProfiles()}>
            重试
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-start justify-center gap-6 py-4">
          {profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              name={profile.name}
              type={profile.type}
              isDefault={profile.isDefault}
              pinProtected={profile.pinProtected ?? false}
              disabled={profile.status === 'disabled' || busy}
              onPress={() => handleCardPress(profile)}
            />
          ))}
          {profiles.length === 0 && (
            <p className="py-10 text-sm text-muted">
              还没有档案,请先到「管理」页创建。
            </p>
          )}
        </div>
      )}

      {busy && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted">
          <Spinner size="sm" color="current" />
          正在切换档案…
        </div>
      )}

      {/* PIN 解锁浮层(T030):成功回调里继续 select */}
      {pinTarget && (
        <PinPad
          isOpen
          onOpenChange={closePinPad}
          profileId={pinTarget.id}
          title={`解锁「${pinTarget.name}」`}
          onSuccess={handlePinSuccess}
        />
      )}

      {/* 家长验证弹窗(阶段 2/FR-012):无 PIN 成人 + 家庭含儿童;通过后带密码重试 select */}
      <ParentVerificationModal
        isOpen={verifyTarget !== null}
        title={`家长验证 · 切换到「${verifyTarget?.name ?? ''}」`}
        description="家庭存在儿童档案,选择未设 PIN 的成人需验证主账号密码。"
        isPending={selectingId !== null}
        error={verifyError}
        onCancel={() => {
          verifyTargetRef.current = null;
          setVerifyTarget(null);
          setVerifyError(null);
        }}
        onConfirm={(password) => {
          const target = verifyTargetRef.current ?? verifyTarget;
          if (target) {
            void selectProfile(target, password);
          }
        }}
      />
    </section>
  );
}
