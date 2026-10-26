import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button } from '@heroui/react';

/**
 * 游客动作占位提示(T069;FR-011、ui.md §5「收藏按钮和播放分开,游客收藏先登录选档但不播放」):
 * - US5 阶段播放入口为占位:播放统一接入 US3 的 usePlayAction(本阶段未接线);
 * - 游客点播放/收藏 → 本组件显示「需先登录选档」提示与显式登录入口按钮,
 *   绝不发起任何播放/媒体请求(登录流程本体属 US2/US3);
 * - 登录按钮 onPress 为 US3 统一意图协调器插槽(当前为空实现占位)。
 */

export interface GuestActionNoticeProps {
  /** 动作语境(如「播放 夹具频道 001」「收藏」) */
  readonly actionLabel: string;
  readonly onClose: () => void;
}

export function GuestActionNotice({ actionLabel, onClose }: GuestActionNoticeProps): ReactNode {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) {
    return null;
  }
  return (
    <Alert status="accent" role="status" className="mt-2">
      <Alert.Title>{`${actionLabel}需要先登录并选择档案`}</Alert.Title>
      <Alert.Description>游客观看与收藏均不发起任何播放;登录选档后由服务端授权。</Alert.Description>
      <Alert.Content>
        <div className="flex items-center gap-2">
          {/* US3/T043 接管:经统一意图协调器打开登录选档;本阶段占位,不产生导航 */}
          <Button size="sm" variant="primary" onPress={() => undefined}>
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
