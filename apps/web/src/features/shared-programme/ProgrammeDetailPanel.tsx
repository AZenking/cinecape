import type { ReactNode } from 'react';
import { Button, Drawer, ProgressBar } from '@heroui/react';
import { Play, Star } from 'lucide-react';
import { formatRangeInZone, formatTimeInZone } from '../live/live-format';
import { useServerNow } from '../../shared/time/use-server-now';
import { ProgrammePoster } from './programme-poster';

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
  /** 频道/影片标识引用(posterRef):用于顶部海报区与频道标识,缺省回退首字徽标 */
  readonly posterRef?: string | null;
}

export interface ProgrammeDetailProgramme {
  readonly title: string;
  readonly description: string | null;
  /** 020 增补:节目海报不透明引用;null/缺省=无海报,回退频道身份区 */
  readonly posterRef?: string | null;
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
  /** 当前是否已收藏该频道(受控;决定星标与文案,点击仍走 onFavorite 切换) */
  readonly favorited?: boolean;
  readonly onClose: () => void;
}

const STATUS_LABEL: Record<ProgrammeStatus, string> = {
  now: '正在直播',
  upcoming: '即将开始',
  ended: '已结束',
  none: '暂无节目数据',
} as const;

export function ProgrammeDetailPanel(props: ProgrammeDetailPanelProps): ReactNode {
  const { open, onClose, channel, programme, status, timezone, onPlay, onFavorite, favorited = false } = props;
  const { nowMs } = useServerNow();
  /** 正在直播:已播进度(服务端基准钟;无校准回落本地钟) */
  const livePercent =
    status === 'now' && programme !== null
      ? Math.min(
          100,
          Math.max(
            0,
            (((nowMs ?? Date.now()) - Date.parse(programme.start)) /
              Math.max(1, Date.parse(programme.end) - Date.parse(programme.start))) *
              100,
          ),
        )
      : 0;

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
          {/* 关闭由右上角 X 承担;可访问名「关闭」的既有键盘/测试契约不变 */}
          <Drawer.CloseTrigger aria-label="关闭" />
          <Drawer.Body className="flex flex-col gap-4">
            {/* 参考 HeroUI 促销卡样式:顶部 16:9 图像横幅(节目海报,缺省回退频道台标),
                下方标题/简介/元信息。 */}
            <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-surface-secondary via-surface-tertiary to-surface">
              {programme !== null && programme.posterRef !== undefined && programme.posterRef !== null ? (
                <ProgrammePoster
                  posterRef={programme.posterRef}
                  title={programme.title}
                  decorative={false}
                  className="absolute inset-0 h-full w-full object-cover"
                />
              ) : channel.posterRef !== undefined && channel.posterRef !== null ? (
                <img
                  src={`/api/public/media/logos/${encodeURIComponent(channel.posterRef)}`}
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 m-auto h-2/3 w-2/3 object-contain"
                />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-4xl font-black text-muted/30">
                  {channel.name.slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <h2 className="text-lg font-bold leading-snug text-foreground">
                {programme !== null ? programme.title : '暂无节目单'}
              </h2>
              {programme !== null && programme.description !== null && programme.description !== '' ? (
                <p className="text-sm leading-relaxed text-muted">{programme.description}</p>
              ) : null}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">频道</dt>
              <dd className="flex min-w-0 items-center gap-1.5 text-foreground">
                {channel.logo !== undefined && channel.logo !== null ? (
                  <img
                    src={channel.logo}
                    alt={`${channel.name} 频道标识`}
                    className="h-5 w-5 shrink-0 rounded-sm object-contain"
                  />
                ) : null}
                <span className="truncate">{channel.name}</span>
              </dd>
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
                  <dd className="hmp-tabular-nums text-foreground">{formatTimeInZone(programme.start, timezone)}</dd>
                </>
              ) : null}
            </dl>

            {status === 'now' && programme !== null ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs text-muted">
                  <span>直播进度</span>
                  <span className="hmp-tabular-nums text-accent">{Math.round(livePercent)}%</span>
                </div>
                <ProgressBar aria-label="直播进度" value={Math.round(livePercent)} className="w-full">
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
              </div>
            ) : null}
            {status === 'upcoming' ? (
              <p className="text-xs text-muted">该节目尚未开播,不提供未来内容播放。</p>
            ) : null}
          </Drawer.Body>

          <Drawer.Footer className="flex flex-col gap-2">
            {/* 主/次操作各占一行、按钮拉满宽度;关闭由右上角 X 承担 */}
            {canPlay ? (
              <Button variant="primary" className="w-full" onPress={onPlay}>
                <Play aria-hidden="true" className="size-4" />
                播放
              </Button>
            ) : null}
            <Button variant="secondary" className="w-full" aria-pressed={favorited} onPress={onFavorite}>
              <Star aria-hidden="true" className={`size-4 ${favorited ? 'fill-current text-accent' : ''}`} />
              {favorited ? '已收藏' : '收藏频道'}
            </Button>
          </Drawer.Footer>


        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}