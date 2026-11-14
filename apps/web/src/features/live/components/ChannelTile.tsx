import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, Card, ProgressBar, Tooltip } from '@heroui/react';
import type { ChannelRowDto, ExperienceProgrammeDto } from '@hmp/shared';
import { usePlayAction } from '../../playback/use-play-action';
import { useCurrentProgramme } from '../hooks/use-current-programme';
import { ChannelLogo } from './channel-logo';
import { formatRangeInZone, formatTimeInZone } from '../live-format';

/**
 * 直播频道瓦片卡(Netflix 式 16:9 瓦片;T069/T070/T071 演进,FR-021/023/024、ui.md §5/§8):
 * - 容器 = HeroUI v3 `Card`(唯一外壳;**不覆盖** Card 原生 padding/圆角/阴影/gap,
 *   保持 heroUI 默认样式);`render={<article />}` 保留 role=article 的可访问语义,
 *   信息区用 `Card.Content`;16:9 媒体底板按「With Images」惯例作为 Card 子内容
 *   (内嵌圆角缩略图)。
 * - 16:9 频道标识底板:频道无海报是常态,底板为 token 渐变 + 稳定散列光斑
 *   (frontend-home-live-epg-design.md §4.3;渐变角度/光斑位置由稳定 media.id 散列决定,
 *   同一频道跨刷新不闪变,颜色只用语义 token);
 * - 2026-11-14 呈现精简:去掉状态签、收藏/播放按钮与悬停中央 ▶ —— 卡片视觉上
 *   只承载「台标 + 台/时段/节目」(参考 HeroUI 图片卡);播放入口改为整块 16:9
 *   底板的透明热区(可点击/可 Tab,无图标),信息区节目名仍负责导航/详情;
 * - 信息区(2026-11-13 呈现修订):第一行频道名 + 家庭时区时段,第二行节目名
 *   (最多两行);档位由分区决定(正在直播类分区=当前节目,即将播放分区=下一档
 *   节目)。频道身份不再只依赖可读名,横向扫读即可确认「台 + 节目 + 时间」;
 * - 无节目频道显示「暂无节目」明确占位,占位可点开详情面板(共享面板 none 态,
 *   保留频道身份 +「暂无节目单」,012 T018);播放入口保留(可用性不由 EPG 决定,FR-023);
 * - 双层交互(015 T004;research.md R5、contracts/ui-layout.md §1.2 第 3 条):
 *   悬停/键盘聚焦瓦片时,底板正中央平滑淡入 bg-accent/80 text-accent-foreground 的
 *   ▶ 按钮,点击直接经 usePlayAction 起播(消灭二级详情阻断;不弹静态二级详情、
 *   不先跳路由详情页——游客由 ActionCoordinator 统一拦截进登录选档意图,本组件
 *   不做任何登录判断);点击文字信息区分流:current 档 → 导航 /live/watch/:channelId
 *   (观看详情页,路由由 015 后续任务注册,当前暂 404 属预期中间态),
 *   upcoming 档 → 打开节目时段详情面板(频道与起止时间;不伪装可播放未来节目,FR-024);
 * - 触屏/无 hover 设备降级(R5 简单方案):(hover: none) 媒体下中央 ▶ 恒显可点,
 *   触屏点击即等价播放;不引入 JS 媒体查询探测与新依赖;
 * - 播放入口统一经 usePlayAction(US3 统一受控播放;游客拦截进登录选档意图,
 *   选档完成前零 /playback/ 请求);收藏入口从瓦片移除,改由详情/收藏页承担。
 * - 悬停/键盘聚焦(cards focus-within)轻微抬升;动效仅悬停反馈,尊重 reduced-motion
 *   (全局基线见 shared/theme/a11y.css);
 * - 长节目名 .hmp-truncate 截断,HeroUI Tooltip 提供完整可读名称。
 * - 频道身份(2026-11-14 修订;原右上角角标/居中主视觉均退场):
 *   台标铺满 16:9 底板上半部分(左右留边、约 38% 高,contain 居中),posterRef 非空 →
 *   ChannelLogo(加载中/失败回退首字),posterRef null → 频道名文本;悬停/聚焦 ▶
 *   下移到 64% 处,与台标、底部进度线互不重叠(channel-logo.tsx)。
 * - 当前节目进度微条(016 T010;contracts/ui-experience.md §1/§2):015 的红色
 *   快照进度线升级为 HeroUI v3 ProgressBar(size="sm" color="accent",
 *   aria-label「节目播放进度」,严禁原生 <progress>),值经 useCurrentProgramme
 *   智能时钟 15s 本地 tick 平滑推进、到点本地翻转(无需整页重载,数据真值由
 *   分区 30s 刷新收敛);current == null 降级:标题「暂无节目单」+ 进度条隐藏,
 *   禁用态不扩散到卡片(播放/悬停行为不受影响,FR-023/015 Hover ▶ 契约保持)。
 */

/**
 * 节目时段详情回调载荷(即将播放/当前节目共用;打开频道/节目信息):
 * programme 为 null 表示无节目单频道(current/next 双 null,FR-012/T018)——
 * 宿主按 none 态打开共享详情面板。
 */
export interface ProgrammeOpenDetail {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly groupLabel: string;
  readonly programme: ExperienceProgrammeDto | null;
  readonly kind: 'current' | 'upcoming';
}

export type OpenProgrammeHandler = (input: ProgrammeOpenDetail) => void;

/** 卡片承载的节目档位:current=当前节目(正在直播类分区);upcoming=下一档节目(即将播放分区) */
export type TileSlot = 'current' | 'upcoming';

export interface ChannelTileProps {
  readonly row: ChannelRowDto;
  /** 卡片承载的节目档位(缺省 current):决定信息区节目名与详情面板 kind */
  readonly slot?: TileSlot;
  /**
   * 服务端快照 now(016 T010 起仅作入参兼容保留,分区宿主仍传)。
   * 卡面进度已升级为 useCurrentProgramme 智能时钟(契约 ui-experience.md §1/§2):
   * 进度与到点翻转按本地时钟推进(服务器 now 偏移取舍见 hook JSDoc),
   * 服务端快照真值由 30s 周期刷新收敛;服务端快照进度语义仍由 progressOf
   * 承担(LiveHeroPlayer 大屏消费)。
   */
  readonly nowIso: string | null;
  /**
   * 家庭时区(分区响应携带):信息区展示该节目时段/开播时刻。
   * 缺省(单元测试直接挂载/无时区数据)时不渲染时间标签,只保留频道名与节目名。
   */
  readonly timezone?: string;
  /** 节目时段详情回调(即将播放/当前节目共用;打开频道/节目信息) */
  readonly onOpenProgramme: OpenProgrammeHandler;
  /** @deprecated 2026-11-14 瓦片不再提供收藏入口;保留仅为宿主兼容,将被移除 */
  readonly onRequireAuth?: (actionLabel: string) => void;
}

/** djb2 散列:底板渐变角度与光斑位置由稳定 id 派生(伪随机但跨刷新不变) */
function hashOf(key: string): number {
  let hash = 5381;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/**
 * 当前节目进度 0..1(以服务端快照 now 计;无 now/区间无效/时刻解析失败返回 null)。
 * 导出供 LiveHeroPlayer 大屏复用(012 T017:FR-010 六信息之「进度」,同一快照语义)。
 * 016 T010 起瓦片卡卡面进度不再走本函数(改经 useCurrentProgramme 本地智能时钟),
 * 本函数保留服务端快照消费方(大屏)语义不变。
 */
export function progressOf(startsAt: string, endsAt: string, nowIso: string | null): number | null {
  if (nowIso === null) {
    return null;
  }
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now) || end <= start) {
    return null;
  }
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

export function ChannelTile({ row, slot = 'current', timezone, onOpenProgramme }: ChannelTileProps): ReactNode {
  const channelTitle = row.media.title;
  // 统一播放入口(US3):整块底板即播放热区,不渲染可见按钮
  const { play } = usePlayAction();
  // 路由导航(015 T004):current 档文字信息区 → /live/watch/:channelId
  const navigate = useNavigate();
  // 智能事件定时器(016 T010;ui-experience.md §1/§2):每卡一个 Hook 实例 ——
  // 15s 本地 tick 平滑推进进度、到点本地翻转(无需等 30s 刷新),墙面上 20 卡
  // × 15s 定时器为契约接受成本(零网络;Hook 不发请求,数据真值仍归周期刷新)。
  // 瓦片无 onProgrammeAdvance(卡片不做静默拉取,翻转后由分区 30s 刷新收敛)。
  const programme = useCurrentProgramme({ initialCurrent: row.current, initialNext: row.next });
  /** 智能时钟下的当前节目(到点本地翻转;空档 → null,信息区「暂无节目单」降级) */
  const liveCurrent = programme.current;
  /** 本卡承载的节目(档位决定:current=智能时钟当前节目,upcoming=下一档;双缺时走「暂无节目单」占位) */
  const slotProgramme: ExperienceProgrammeDto | null = slot === 'upcoming' ? row.next : liveCurrent;
  /**
   * 信息区时段标签(家庭时区):current 档 = 起止区间,upcoming 档 = 开播时刻。
   * 无时区数据/无节目时省略,不臆造本地时间(与 Hero/分区时间语义一致)。
   */
  const timeLabel =
    slotProgramme === null || timezone === undefined
      ? null
      : slot === 'upcoming'
        ? `${formatTimeInZone(slotProgramme.startsAt, timezone)} 开始`
        : formatRangeInZone(slotProgramme.startsAt, slotProgramme.endsAt, timezone);
  const hash = hashOf(row.media.id);
  const plateAngle = 100 + (hash % 140);
  const glowOnRight = hash % 2 === 1;
  return (
    // HeroUI v3 Card 作为唯一容器;不覆盖 Card 自身的 padding/圆角/背景/阴影/
    // gap(保持 heroUI 原样式),只追加布局所需的 min-w-0 与 group(hover 揭示播放键)。
    // render 成 <article> 保留可访问语义(role=article)与既有查询契约。
    <Card<"article">
      render={(props) => <article {...props} />}
      className="group min-w-0"
      aria-label={`频道 ${channelTitle}`}
    >
      {/* 16:9 频道标识底板(无海报常态降级;装饰节点一律 aria-hidden,可读名由 article 承担) */}
      <div
        className="relative aspect-video w-full overflow-hidden rounded-2xl bg-surface-secondary"
        style={{ background: `linear-gradient(${plateAngle}deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)` }}
      >
        <span
          aria-hidden="true"
          className={`absolute -bottom-12 h-36 w-36 rounded-full bg-accent/15 blur-3xl transition duration-300 group-hover:bg-accent/25 ${
            glowOnRight ? '-right-8' : '-left-8'
          }`}
        />
        {/* 频道身份(2026-11-14 修订):台标铺满 16:9 底板上半部分(左右留边、
            约 38% 高),contain 居中;播放键下移到 64% 处,与台标/进度线互不重叠。
            ChannelLogo 自带加载中/失败首字回退;无台标频道显示频道名。 */}
        <div
          data-testid="tile-logo"
          className="pointer-events-none absolute inset-x-3 top-3 z-[1] flex h-[38%] items-center justify-center"
        >
          {row.media.posterRef !== null ? (
            <div className="relative h-full w-full">
              <ChannelLogo
                key={row.media.posterRef}
                posterRef={row.media.posterRef}
                channelTitle={channelTitle}
                fallbackClassName="text-2xl font-semibold text-muted"
              />
            </div>
          ) : (
            <span
              data-testid="tile-logo-fallback"
              className="line-clamp-2 text-center text-xl font-semibold leading-tight text-muted"
            >
              {channelTitle}
            </span>
          )}
        </div>



        {/* 当前节目进度微条(016 T010;ui-experience.md §1:HeroUI v3 ProgressBar,
            严禁原生 <progress>;值经 useCurrentProgramme 平滑推进,到点本地翻转):
            - 契约伪码 <Progress color="primary"> 按 HeroUI v3 实际 API 映射为
              ProgressBar + color="accent"(v3 色板为 default/accent/success/
              warning/danger,accent 即品牌主色,与瓦片直播语义 token 同源);
            - current == null(空档/降级,§1.2)→ 整条隐藏,禁用态不扩散到卡片,
              播放/悬停行为不受影响(Hover ▶ 契约保持); */}
        {/* 整块 16:9 底板即播放入口:不渲染可见按钮/图标,点击或键盘回车播放该频道
            当前直播(aria-label 保留「播放 <频道名>」,焦点环落在底板上)。 */}
        <button
          type="button"
          aria-label={`播放 ${channelTitle}`}
          className="absolute inset-0 z-10 cursor-pointer rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => {
            play({ mediaId: row.media.id, title: channelTitle, startMode: 'beginning', posterRef: row.media.posterRef });
          }}
        />
        {liveCurrent !== null ? (
          <ProgressBar
            aria-label="节目播放进度"
            value={programme.progressPercent}
            size="sm"
            color="accent"
            className="absolute inset-x-0 bottom-0"
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        ) : null}
      </div>

      {/* 信息区(按 HeroUI Card「With Images」示例的解剖):Card.Header 承载
          「频道身份 + 时段 + 节目名」,节目名用 Card.Title(渲染 h3)包可交互按钮。
          原卡面只有一行节目名,频道身份仅靠右上角台标角标,扫读时难以确认「哪个台」;
          现将频道名/时段显性放入信息区,节目名放宽到两行(line-clamp-2),卡片横向
          扫读时「台 + 节目 + 时间」一眼可得。长名截断 + Tooltip 完整名;
          点击节目名按档位分流(015 T004;ui-layout.md §1.2 第 3 条):
          current 档 → 导航 /live/watch/:channelId 观看详情页;
          upcoming 档 → 打开共享详情面板(节目时段信息,FR-024)。
          Trigger 直接用 HeroUI Button(消费 react-aria Focusable 上下文,悬停即可达
          Tooltip;原生 button 不消费该上下文,Tooltip.Trigger 又是 div[role=button]
          包装器,内嵌原生按钮会产生重复同名 role=button)。
          样式只用对齐/宽度/字重覆盖(DESIGN.md:用既有变体,不重造按钮);
          尺寸/内边距/悬停/焦点环走 ghost sm 变体原生状态。 */}
      <Card.Header className="min-w-0">
        <div className="mb-1 flex min-w-0 items-baseline justify-between gap-2">
          <span className="hmp-truncate text-xs font-medium text-foreground/80">{channelTitle}</span>
          {timeLabel !== null ? (
            <span className="hmp-tabular-nums shrink-0 text-xs text-muted">{timeLabel}</span>
          ) : null}
        </div>
        {slotProgramme !== null ? (
          <Card.Title className="min-w-0 text-sm font-semibold leading-snug">
            <Tooltip>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto min-h-8 w-full min-w-0 justify-start whitespace-normal px-0 py-0.5 text-left text-sm font-semibold leading-snug"
                onPress={() => {
                  if (slot === 'upcoming') {
                    // 即将播放档:节目名仍是「查看详情」控件——打开节目时段详情面板
                    // (未来节目不伪装可播放,FR-024;§1.2 双层交互仅改 current 档)
                    onOpenProgramme({
                      mediaId: row.media.id,
                      channelTitle,
                      groupLabel: row.groupLabel,
                      programme: slotProgramme,
                      kind: 'upcoming',
                    });
                    return;
                  }
                   // 正在直播档:导航观看详情页(015 T004;id = 频道 media.id,即 :channelId)
                   void navigate(`/live/watch/${row.media.id}`);
                }}
              >
                <span className="line-clamp-2">{slotProgramme.title}</span>
              </Button>
              <Tooltip.Content>{slotProgramme.title}</Tooltip.Content>
            </Tooltip>
          </Card.Title>
        ) : (
          /* 无节目占位可点开共享详情面板(none 态:保留频道身份 +「暂无节目单」,
             主操作仍可播放当前直播,FR-012/012 T018;焦点环同相邻节目按钮;
             016 §1.2 降级标题 =「暂无节目单」,状态签仍用「暂无排期」——
             后者不是前者子串,文本查询互不吞并) */
          <button
            type="button"
            data-testid="no-programme"
            className="block w-full min-w-0 rounded-sm p-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            onClick={(event) => {
              event.preventDefault();
              onOpenProgramme({
                mediaId: row.media.id,
                channelTitle,
                groupLabel: row.groupLabel,
                programme: null,
                kind: 'current',
              });
            }}
          >
            <span className="block text-sm text-muted">暂无节目单</span>
          </button>
        )}
      </Card.Header>
    </Card>
  );
}
