import { useCallback, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { useSession } from '../../app/session-provider';
import { useAuthAction } from '../../app/action-coordinator';
import { useFavoriteToggleMutation } from './use-favorites';

/**
 * 独立星标收藏/取消按钮(T102/T024,005 US4、006 data-access.md、ui.md §4):
 *
 * - 独立控件:星标点击只做收藏/取消,不冒泡触发播放(外层卡片可整体进入详情/播放);
 * - 游客/未选档:先经统一意图协调器走登录选档(复用 US3),选档前不发任何 /me 请求;
 * - 乐观更新(T024,Q1):列表级乐观写由数据层 useFavoriteToggleMutation 承担
 *   (optimistic.apply 改写 queryKeys.profile(pid).favorites() 共享缓存 →
 *   收藏列表立即增减;失败自动回滚 + formatApiError toast;onSettled 失效对账);
 *   星标自身的即时翻面走「UI variables + isPending」变体(单表面积简单变更,
 *   contracts/data-access.md 优先推荐),两者在 onSettled 后一并收敛到服务端真值;
 * - 去重:pending 期间重复触发直接忽略(isPending + 本地翻面态双门控,FR-014);
 * - 不可用频道:显示不可用状态仍可取消收藏(不能重新收藏,客户端先行拦截,
 *   服务端拒绝 → 回滚提示);
 * - aria-pressed 语义 + 文字标签(错误不只靠颜色,ui.md §8)。
 */

export interface FavoriteStarButtonProps {
  readonly mediaId: string;
  readonly title: string;
  /** 当前是否已收藏(受控;列表场景由数据驱动) */
  readonly favorited: boolean;
  /** 媒体不可用(FR-020:不可用收藏仍可取消,但不能重新收藏) */
  readonly unavailable?: boolean;
  /** 收藏状态变化回调(成功后通知父层;列表场景可省略——共享缓存已驱动) */
  onChanged?: (mediaId: string, favorited: boolean) => void;
  /** 紧凑形态(卡片角标) */
  size?: 'sm' | 'md';
}

export function FavoriteStarButton({
  mediaId,
  title,
  favorited,
  unavailable = false,
  onChanged,
  size = 'md',
}: FavoriteStarButtonProps): ReactNode {
  const session = useSession();
  const auth = useAuthAction();
  // 单表面积乐观翻面(UI variables):服务端未决期间星标先 行翻转,失败随回滚复位
  const [pendingFavorited, setPendingFavorited] = useState<boolean | null>(null);
  // 客户端拦截类错误(不可用重新收藏):非服务端失败,不走数据层回滚/Toast 通道
  const [guardError, setGuardError] = useState<string | null>(null);

  // 当前档案 id:个人键必须内嵌 profileId(FR-021);未选档/未登录为 null(无乐观写目标)
  const activeProfileId =
    session.status === 'authenticated' ? (session.session?.activeProfile?.id ?? null) : null;
  const toggle = useFavoriteToggleMutation(activeProfileId, { id: mediaId, title, unavailable });

  const shown = pendingFavorited ?? favorited;

  const onPress = useCallback((): void => {
    // pending 去重:数据层在途或本地翻面未决时忽略重复触发(FR-014)
    if (toggle.isPending || pendingFavorited !== null) {
      return;
    }
    setGuardError(null);
    // 游客/未选档:零个人请求,先进登录/选档意图(FR-016/ui.md §4)
    if (session.status !== 'authenticated' || session.session === null || session.session.activeProfile === null) {
      if (session.status === 'authenticated') {
        auth.startProfileSelection();
      } else {
        auth.startLogin();
      }
      return;
    }
    if (shown && unavailable) {
      // 不可用频道可取消收藏(FR-020)
    } else if (!shown && unavailable) {
      setGuardError('该频道当前不可用,暂不能收藏');
      return;
    }
    const next = !shown;
    setPendingFavorited(next); // 星标即时翻面(列表级乐观写由数据层收口)
    toggle
      .mutateAsync(next)
      .then(() => {
        onChanged?.(mediaId, next);
      })
      .catch(() => {
        // 失败回滚 + 提示已由数据层统一收口;此处仅吞掉 rejection 避免未处理告警
      })
      .finally(() => {
        setPendingFavorited(null); // 成功/失败后收敛:成功=服务端真值已对账,失败=快照已恢复
      });
  }, [toggle, pendingFavorited, session, auth, shown, unavailable, mediaId, onChanged]);

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size={size === 'sm' ? 'sm' : 'sm'}
        variant="ghost"
        aria-pressed={shown}
        aria-label={`${shown ? '取消收藏' : '收藏'} ${title}`}
        onPress={onPress}
        className="shrink-0"
      >
        {/* 星标独立于播放:点击不冒泡(onPress 不向卡片传播) */}
        <span aria-hidden={true}>{shown ? '★' : '☆'}</span>
        <span className="sr-only">{shown ? '取消收藏' : '收藏'}</span>
        <span aria-hidden={true} className="text-xs">
          {shown ? '已收藏' : '收藏'}
        </span>
      </Button>
      {unavailable && shown ? <span className="text-xs text-muted">不可用</span> : null}
      {guardError !== null ? (
        <span role="alert" className="text-xs text-danger">
          {guardError}
        </span>
      ) : null}
    </span>
  );
}
