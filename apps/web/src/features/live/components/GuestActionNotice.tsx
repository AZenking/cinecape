import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button } from '@heroui/react';
import { useAuthAction } from '../../../app/action-coordinator';

/**
 * 游客私有动作提示(T069;012 T008 接线完成;FR-009、ui.md §1.5):
 * - 播放不经本组件:全部播放入口走共享 PlayButton/usePlayAction(005 T054);
 *   游客点播放由协调器直接进入登录选档意图并保存播放意图(012 FR-006);
 * - 本组件现用于**收藏**等私有操作的游客引导:显示「需先登录选档」提示与显式
 *   登录入口按钮,绝不发起任何播放/媒体请求(零部分写入,ui.md §1.5);
 * - 登录按钮经 useAuthAction().startLogin() 进入统一登录选档意图:协调器缺省
 *   以当前路径为 returnTo(005 T043),登录选档完成后回到原页面(012 FR-006)。
 */

export interface GuestActionNoticeProps {
  /** 动作语境(如「收藏 频道名」) */
  readonly actionLabel: string;
  readonly onClose: () => void;
}

export function GuestActionNotice({ actionLabel, onClose }: GuestActionNoticeProps): ReactNode {
  const [dismissed, setDismissed] = useState(false);
  const { startLogin } = useAuthAction();
  if (dismissed) {
    return null;
  }
  return (
    <Alert status="accent" role="status" className="mt-2">
      <Alert.Title>{`${actionLabel}需要先登录并选择档案`}</Alert.Title>
      <Alert.Description>游客观看与收藏均不发起任何播放;登录选档后由服务端授权。</Alert.Description>
      <Alert.Content>
        <div className="flex items-center gap-2">
          {/* 统一意图协调器:登录选档完成后回到当前页(returnTo 缺省取当前路径) */}
          <Button
            size="sm"
            variant="primary"
            onPress={() => {
              startLogin();
              onClose();
            }}
          >
            登录
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              setDismissed(true);
              onClose();
            }}
          >
            知道了
          </Button>
        </div>
      </Alert.Content>
    </Alert>
  );
}
