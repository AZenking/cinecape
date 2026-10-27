import type { ReactNode } from 'react';
import { Button, Modal } from '@heroui/react';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { formatRangeInZone, formatZoneLabel } from '../live-format';

/**
 * 节目时段详情(T069;FR-024、ui.md §5):
 * - 点击即将播放(或当前)节目打开:仅展示节目时段事实 —— 频道、节目标题、起止时间
 *   (家庭时区标注);不出现「立即播放本节目/预约/回看」类可执行承诺;
 * - 唯一播放动作是「播放该频道当前直播」:文案明确指向频道当前直播而非该节目本身;
 *   游客按下后经 GuestActionNotice 先登录选档,不发起任何播放;
 * - 关闭返回触发处(受控 isOpen/onOpenChange)。
 */

export interface ProgrammeSlotDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly channelTitle: string;
  readonly groupLabel?: string;
  readonly programme: ExperienceProgrammeDto | null;
  readonly kind: 'current' | 'upcoming';
  readonly timezone: string;
  readonly serverNowIso: string | null;
  /** 播放该频道当前直播(统一播放入口插槽) */
  readonly onPlayChannel: (mediaId: string) => void;
  readonly mediaId: string;
}

const KIND_LABEL = {
  current: '正在直播',
  upcoming: '即将播放',
} as const;

export function ProgrammeSlotDialog(props: ProgrammeSlotDialogProps): ReactNode {
  const { open, onOpenChange, channelTitle, groupLabel, programme, kind, timezone, serverNowIso, onPlayChannel, mediaId } =
    props;
  return (
    <Modal.Root isOpen={open} onOpenChange={onOpenChange}>
      {/* T137 修复:同 password-confirm-modal —— 缺 Backdrop 时 Overlay 无 fixed 定位,弹窗脱离视口 */}
      <Modal.Backdrop>
        <Modal.Container placement="center" size="md">
        <Modal.Dialog aria-label={`节目时段:${channelTitle}`}>
          <Modal.Header>
            <Modal.Heading className="text-base font-semibold">
              {programme?.title ?? '节目时段'}
            </Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">频道</dt>
              <dd className="text-foreground">{channelTitle}</dd>
              {groupLabel !== undefined ? (
                <>
                  <dt className="text-muted">分组</dt>
                  <dd className="text-foreground">{groupLabel}</dd>
                </>
              ) : null}
              <dt className="text-muted">时段</dt>
              <dd className="hmp-tabular-nums text-foreground">
                {programme !== null ? formatRangeInZone(programme.startsAt, programme.endsAt, timezone) : '—'}
              </dd>
              <dt className="text-muted">状态</dt>
              <dd className="text-foreground">{KIND_LABEL[kind]}</dd>
            </dl>
            {programme?.description ? (
              <p className="mt-2 text-sm text-muted">{programme.description}</p>
            ) : null}
            <p className="mt-2 text-xs text-muted">
              时间按家庭时区({formatZoneLabel(timezone, serverNowIso ?? programme?.startsAt ?? '')})显示。
              {kind === 'upcoming'
                ? '该节目尚未开播;此页仅展示节目时段,播放入口始终指向该频道的当前直播。'
                : '播放入口指向该频道的当前直播。'}
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button size="sm" variant="ghost" onPress={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button
              size="sm"
              variant="primary"
              onPress={() => {
                onPlayChannel(mediaId);
              }}
            >
              {`播放 ${channelTitle} 当前直播`}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
