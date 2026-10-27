import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { useSession } from '../../app/session-provider';
import { useAuthAction } from '../../app/action-coordinator';
import { deleteFavoriteChannel, putFavoriteChannel } from './favorites-api';

/**
 * 独立星标收藏/取消按钮(T102,005 US4、ui.md §4):
 *
 * - 独立控件:星标点击只做收藏/取消,不冒泡触发播放(外层卡片可整体进入详情/播放);
 * - 游客/未选档:先经统一意图协调器走登录选档(复用 US3),选档前不发任何 /me 请求;
 * - 幂等乐观更新:点击即翻转本地状态,PUT/DELETE 成功即保持;失败回滚并可重试
 *   (不声称未确认操作已保存);
 * - 不可用频道:显示不可用状态仍可取消收藏(不能重新收藏,服务端拒绝 → 回滚提示);
 * - aria-pressed 语义 + 文字标签(错误不只靠颜色,ui.md §8)。
 */

export interface FavoriteStarButtonProps {
  readonly mediaId: string;
  readonly title: string;
  /** 当前是否已收藏(受控;列表场景由数据驱动) */
  readonly favorited: boolean;
  /** 媒体不可用(FR-020:不可用收藏仍可取消,但不能重新收藏) */
  readonly unavailable?: boolean;
  /** 收藏状态变化回调(乐观更新通知列表/父层) */
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
  const [optimisticFavorited, setOptimisticFavorited] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const shown = optimisticFavorited ?? favorited;

  const toggle = useCallback((): void => {
    if (inFlightRef.current) {
      return; // 在途请求收敛:不叠加并发写
    }
    setError(null);
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
      setError('该频道当前不可用,暂不能收藏');
      return;
    }
    const next = !shown;
    inFlightRef.current = true;
    setOptimisticFavorited(next); // 乐观更新
    const request = next ? putFavoriteChannel(mediaId) : deleteFavoriteChannel(mediaId);
    void request
      .then(() => {
        setOptimisticFavorited(null);
        onChanged?.(mediaId, next);
      })
      .catch(() => {
        // 失败回滚(可重试):不声称已保存
        setOptimisticFavorited(null);
        setError(next ? '收藏失败,请重试' : '取消收藏失败,请重试');
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [session, auth, shown, unavailable, mediaId, onChanged]);

  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size={size === 'sm' ? 'sm' : 'sm'}
        variant="ghost"
        aria-pressed={shown}
        aria-label={`${shown ? '取消收藏' : '收藏'} ${title}`}
        onPress={toggle}
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
      {error !== null ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}
