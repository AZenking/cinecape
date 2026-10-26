/**
 * 共享播放入口按钮(T054;005 US3)—— 点播详情/直播卡片/首页占位共用的唯一入口组件:
 * - 按压一律经 usePlayAction().play 发起(游客→登录选档意图;已选档→直接受控授权),
 *   本组件不自行请求 /playback/*、不预取媒体、不展示播放凭据;
 * - 不可播放目标(如失效媒体)以禁用 + 理由呈现(错误不只靠颜色,ui.md §8);
 * - label 缺省「播放」;样式沿用 HeroUI v3 Button(onPress,HEROUI-NOTES §1②)。
 */
import type { ReactNode } from 'react';
import { Button } from '@heroui/react';
import { usePlayAction, type PlayActionRequest } from './use-play-action';

export interface PlayButtonProps {
  readonly mediaId: string;
  readonly title: string;
  /** 缺省 beginning;进度数据与继续/从头按钮语义由 US4 补全 */
  readonly startMode?: PlayActionRequest['startMode'];
  readonly label?: string;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'tertiary';
  /** 不可播放时禁用并展示理由(如媒体不可用);不伪装可播放承诺 */
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly ariaLabel?: string;
}

export function PlayButton({
  mediaId,
  title,
  startMode,
  label = '播放',
  size = 'md',
  variant = 'primary',
  disabled = false,
  disabledReason,
  ariaLabel,
}: PlayButtonProps): ReactNode {
  const { play } = usePlayAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size={size}
        variant={variant}
        isDisabled={disabled}
        aria-label={ariaLabel ?? `${label} ${title}`}
        onPress={() => {
          play({ mediaId, title, startMode });
        }}
      >
        {label}
      </Button>
      {disabled && disabledReason !== undefined ? (
        <span className="text-xs text-muted">{disabledReason}</span>
      ) : null}
    </span>
  );
}
