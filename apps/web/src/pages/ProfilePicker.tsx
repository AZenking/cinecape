/**
 * 档案选择页(T029,User Story 2 / FR-014/015)。
 *
 * - 挂载时 GET /profiles 拉取当前 Household 档案列表,Netflix 式横排大卡
 *   (components/ProfileCard):类型角标、默认标记、PIN 锁角标,停用档案置灰不可点。
 * - 点击行为:pinProtected → 打开 PinPad 解锁,成功后 POST /profiles/{id}/select;
 *   无 PIN → 直接 select。select 成功 → await refresh()(SessionProvider 上下文
 *   更新,AppShell 观看者同步)→ 留在本页并显示顶部轻条「当前观看:{name}」。
 * - 404/403(档案不存在/跨家庭/已停用)→ Alert 轻条提示并 refresh() 修正上下文;
 *   其余错误展示服务端 detail。
 * - 视觉(research D6):暗色优先、卡片横排居中、onPress 统一交互。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Spinner } from '@heroui/react';
import { ApiError, api } from '../lib/api';
import { useSession } from '../lib/session';
import { ProfileCard } from '../components/ProfileCard';
import { PinPad } from '../components/PinPad';
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

  /** POST /profiles/{id}/select → 刷新会话上下文 → 顶部轻条 */
  const selectProfile = useCallback(
    async (profile: ProfileDto): Promise<void> => {
      setSelectingId(profile.id);
      setBanner(null);
      try {
        await api.post(`/profiles/${profile.id}/select` as '/profiles/{profileId}/select');
        await refresh();
        setBanner({ tone: 'success', message: `当前观看:${profile.name}` });
      } catch (error) {
        if (error instanceof ApiError) {
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
    </section>
  );
}
