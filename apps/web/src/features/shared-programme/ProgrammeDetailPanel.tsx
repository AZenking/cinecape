import type { ReactNode } from 'react';
import { Button, Drawer } from '@heroui/react';
import { formatRangeInZone, formatTimeInZone, formatZoneLabel } from '../live/live-format';

/**
 * 共享节目详情面板(012 T005;FR-013、contracts/ui.md §2):
 * 直播首页三区(Now/Next/Groups)与 EPG 节目单挂载的**同一**详情面板组件
 * (research R2:live 侧旧弹层(012 T016 已删除)与 epg 面板的统一内核)。
 *
 * 行为契约(docs/specs/012-live-settings-experience/contracts/ui.md §2,T003 单测钉面):
 * - 受控 `open`/`onClose`:关闭态不渲染 dialog;Escape/关闭按钮经 onOpenChange(false)
 *   回调 onClose,焦点恢复由 HeroUI(React Aria)overlay 语义负责(回到触发元素);
 * - 六要素:频道名称+标识、节目标题+简介、起止时间(家庭时区 HH:mm–HH:mm)+时长、
 *   状态文案、主操作、次操作(收藏频道、查看节目单);
 * - 四状态由宿主裁决(`status`,取代旧组件内 serverNowIso 推导):
 *   now=正在直播(主操作可用);upcoming=即将开始(显示开播时间,无播放主操作,
 *   §1.6);ended=已结束(无播放主操作);none=暂无节目数据+暂无节目单
 *   (保留频道身份;频道可用时主操作仍可为播放当前频道——§2.5,对齐旧 live 弹层
 *   programme=null 仍渲染播放按钮的语义);
 * - 动作回调均无参:频道身份(mediaId)由宿主闭包持有(ui.md §1.4「频道语义,
 *   不锁定具体节目」);`source` 仅记录入口(data-model §2),不影响面板结构;
 * - 面板打开期间数据刷新(props 更新)不关闭面板、焦点不跳出(§2.4,SC-003)。
 *
 * 视觉:HeroUI 语义 token(css 类引用主题变量),不引入裸值(宪章第 5/8 条)。
 */

export type ProgrammeStatus = 'now' | 'upcoming' | 'ended' | 'none';
export type ProgrammePanelSource = 'now' | 'next' | 'guide';

export interface ProgrammeDetailChannel {
  readonly name: string;
  readonly logo?: string | null;
}

export interface ProgrammeDetailProgramme {
  readonly title: string;
  readonly description: string | null;
  /** ISO 起始时刻(现状 DTO startsAt 的归一命名,宿主映射) */
  readonly start: string;
  /** ISO 结束时刻(现状 DTO endsAt) */
  readonly end: string;
}

export interface ProgrammeDetailPanelProps {
  readonly open: boolean;
  readonly channel: ProgrammeDetailChannel;
  readonly programme: ProgrammeDetailProgramme | null;
  readonly status: ProgrammeStatus;
  readonly timezone: string;
  readonly source?: ProgrammePanelSource;
  /** 播放该频道当前直播(频道语义,无参;宿主闭包持有 mediaId) */
  readonly onPlay: () => void;
  readonly onFavorite: () => void;
  readonly onGuide: () => void;
  readonly onClose: () => void;
}

const STATUS_LABEL: Record<ProgrammeStatus, string> = {
  now: '正在直播',
  upcoming: '即将开始',
  ended: '已结束',
  none: '暂无节目数据',
} as const;

export function ProgrammeDetailPanel(props: ProgrammeDetailPanelProps): ReactNode {
  const { open, onClose, channel, programme, status, timezone, onPlay, onFavorite, onGuide } = props;

  // 主操作:now 恒可用;none=无节目单但频道可用,沿用现状仍可播当前直播的语义(§2.5)。
  const canPlay = status === 'now' || status === 'none';
  const durationMinutes =
    programme === null
      ? null
      : Math.max(1, Math.round((Date.parse(programme.end) - Date.parse(programme.start)) / 60_000));
  return (
    <Drawer.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      {/* 节目详情 = 右侧抽屉(产品评审:详情属"就地查看上下文",抽屉比居中弹窗更贴合
          时间轴浏览,不遮住节目墙其余部分) */}
      <Drawer.Content placement="right">
        {/* 宽度加在 Dialog(面板)上:加在 Content(定位容器)上会把整层压窄并贴左 */}
        <Drawer.Dialog aria-label={`节目详情:${channel.name}`} className="w-[420px] max-w-[92vw]">
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading className="text-base font-semibold">
              {programme?.title ?? `节目时段:${channel.name}`}
            </Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>
              <div className="flex items-center gap-2">
                {channel.logo ? (
                  <img src={channel.logo} alt={`${channel.name} 频道标识`} className="h-6 w-6 rounded-sm object-contain" />
                ) : null}
                <span className="text-sm font-medium text-foreground">{channel.name}</span>
              </div>
              {programme !== null ? (
                <p className="text-sm text-muted">{programme.description}</p>
              ) : null}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {programme !== null ? (
                  <>
                    <dt className="text-muted">时段</dt>
                    <dd className="hmp-tabular-nums text-foreground">
                      {formatRangeInZone(programme.start, programme.end, timezone)}
                      <span className="text-muted">{` · 时长 ${durationMinutes} 分钟`}</span>
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted">状态</dt>
                <dd className="text-foreground">{STATUS_LABEL[status]}</dd>
                {status === 'upcoming' && programme !== null ? (
                  <>
                    <dt className="text-muted">开播</dt>
                    <dd className="hmp-tabular-nums text-foreground">
                      {formatTimeInZone(programme.start, timezone)}
                    </dd>
                  </>
                ) : null}
              </dl>
              {status === 'none' ? <p className="text-sm text-muted">暂无节目单</p> : null}
              <p className="text-xs text-muted">
                时间按家庭时区({formatZoneLabel(timezone, programme?.start ?? '')})显示。
                {status === 'upcoming'
                  ? '该节目尚未开播;此页仅展示节目时段,不提供未来内容播放。'
                  : '播放入口指向该频道的当前直播。'}
              </p>
          </Drawer.Body>
          <Drawer.Footer>
              <Button size="sm" variant="ghost" onPress={() => onClose()}>
                关闭
              </Button>
              <Button size="sm" variant="ghost" onPress={onFavorite}>
                收藏频道
              </Button>
              <Button size="sm" variant="ghost" onPress={onGuide}>
                查看节目单
              </Button>
              {canPlay ? (
                <Button size="sm" variant="primary" onPress={onPlay}>
                  播放当前频道
                </Button>
              ) : null}
          </Drawer.Footer>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
