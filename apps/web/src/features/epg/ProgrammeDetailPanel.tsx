import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { Button, Modal } from '@heroui/react';
import { formatRangeInZone, formatZoneLabel, formatTimeInZone } from './guide-time';

/**
 * 节目详情面板(T119;FR-045、ui.md §6):
 * - 宽窗口(≥1024px)侧栏 aside,窄窗口 HeroUI Modal;媒体查询监听断点切换;
 * - 不与登录模态并行:任何播放入口按下后立即回调 onClose(父级先关详情再进 US3 统一
 *   登录/播放面),同一时刻至多一个模态;
 * - 未来节目仅显示节目时段与频道信息:不提供预约、回看或未来内容播放(FR-024);
 *   提供「观看该频道当前直播」明确按钮,经 US3 统一受控播放(游客先登录选档,
 *   登录前不请求媒体流 —— PlayButton/usePlayAction 保证);
 * - 正在直播节目提供当前频道播放(同一按钮语义,文案指向频道当前直播);
 * - 关闭(返回/取消)后由父级恢复原日期、频道与时间位置(URL 状态 + 滚动锚点
 *   保存在当前导航状态,本组件不触碰浏览位置)。
 */

export interface GuideDetailTarget {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly programme: ExperienceProgrammeDto;
}

export interface ProgrammeDetailPanelProps {
  readonly target: GuideDetailTarget | null;
  readonly timezone: string;
  readonly serverNowIso: string | null;
  readonly onClose: () => void;
  /** 观看该频道当前直播(US3 统一入口;父级负责先关闭详情) */
  readonly onPlayChannel: (mediaId: string, channelTitle: string) => void;
}

function useIsWide(): boolean {
  const [isWide, setIsWide] = useState((): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return true;
    }
    return window.matchMedia('(min-width: 1024px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = (event: MediaQueryListEvent): void => {
      setIsWide(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, []);
  return isWide;
}

function DetailBody({ target, timezone, serverNowIso, onPlayChannel, onClose }: Omit<ProgrammeDetailPanelProps, 'target'> & { target: GuideDetailTarget }): ReactNode {
  const nowMs = serverNowIso === null ? Number.NaN : Date.parse(serverNowIso);
  const startsMs = Date.parse(target.programme.startsAt);
  const endsMs = Date.parse(target.programme.endsAt);
  const isCurrent = Number.isFinite(nowMs) && startsMs <= nowMs && nowMs < endsMs;
  const isFuture = Number.isFinite(nowMs) && startsMs > nowMs;
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <h2 className="hmp-truncate text-base font-semibold text-foreground" title={target.programme.title}>
        {target.programme.title}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">频道</dt>
        <dd className="text-foreground">{target.channelTitle}</dd>
        <dt className="text-muted">时段</dt>
        <dd className="hmp-tabular-nums text-foreground">
          {formatRangeInZone(target.programme.startsAt, target.programme.endsAt, timezone)}
        </dd>
        <dt className="text-muted">状态</dt>
        <dd className="text-foreground">{isCurrent ? '正在直播' : isFuture ? '尚未开播' : '已结束'}</dd>
      </dl>
      {target.programme.description ? (
        <p className="text-sm text-muted">{target.programme.description}</p>
      ) : null}
      <p className="text-xs text-muted">
        时间按家庭时区({formatZoneLabel(timezone, serverNowIso ?? target.programme.startsAt)})显示。
        {isFuture ? '该节目尚未开播;此处仅展示节目信息,不提供预约、回看或未来内容播放。' : ''}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {/* 唯一播放动作:观看该频道当前直播(明确指向频道,不伪装播放该节目本身)。
            按下即先回调 onPlayChannel(父级经 usePlayAction 发起 US3 统一受控播放:
            游客先登录选档、登录前零媒体请求)并立即 onClose —— 详情面先撤,登录模态
            不与本面板并行。 */}
        <Button
          size="sm"
          variant="primary"
          onPress={() => {
            onPlayChannel(target.mediaId, target.channelTitle);
            onClose();
          }}
        >
          {isCurrent ? `播放 ${target.channelTitle} 当前直播` : `观看 ${target.channelTitle} 当前直播`}
        </Button>
        <Button size="sm" variant="ghost" onPress={onClose}>
          {isCurrent ? '返回' : '取消'}
        </Button>
      </div>
      {isCurrent ? (
        <p className="hmp-sr-only">{`当前时间 ${formatTimeInZone(serverNowIso ?? target.programme.startsAt, timezone)}`}</p>
      ) : null}
    </div>
  );
}

export function ProgrammeDetailPanel(props: ProgrammeDetailPanelProps): ReactNode {
  const { target, onClose } = props;
  const isWide = useIsWide();
  if (target === null) {
    return null;
  }
  if (isWide) {
    // 宽窗口侧栏(非模态;返回/取消恢复原浏览位置)
    return (
      <aside aria-label="节目详情" className="w-80 shrink-0 rounded border border-border bg-surface">
        <DetailBody {...props} target={target} />
      </aside>
    );
  }
  // 窄窗口 Modal(不与登录模态并行:播放入口按下即 onClose)
  return (
    <Modal.Root isOpen onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}>
      {/* T137 修复:同 password-confirm-modal —— 缺 Backdrop 时 Overlay 无 fixed 定位,弹窗脱离视口 */}
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md">
          <Modal.Dialog aria-label={`节目详情:${target.programme.title}`}>
            <Modal.Header>
              <Modal.Heading className="text-base font-semibold">节目详情</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <DetailBody {...props} target={target} />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
