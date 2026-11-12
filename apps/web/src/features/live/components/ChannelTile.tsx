import { useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, ProgressBar, Tooltip } from '@heroui/react';
import { Play } from 'lucide-react';
import type { ChannelRowDto, ExperienceProgrammeDto } from '@hmp/shared';
import { PlayButton, usePlayAction } from '../../playback/use-play-action';
import { useSession } from '../../../app/session-provider';
import { FavoriteStarButton } from '../../favorites/favorite-star-button';
import { useCurrentProgramme } from '../hooks/use-current-programme';
import { ChannelIdentityBadge } from './channel-identity-badge';

/**
 * 直播频道瓦片卡(Netflix 式 16:9 瓦片;T069/T070/T071 演进,FR-021/023/024、ui.md §5/§8):
 * - 16:9 频道标识底板:频道无海报是常态,底板为 token 渐变 + 稳定散列光斑
 *   (frontend-home-live-epg-design.md §4.3;渐变角度/光斑位置由稳定 media.id 散列决定,
 *   同一频道跨刷新不闪变,颜色只用语义 token);
 * - 瓦片承载状态:左上「正在直播/即将播放/暂无排期」标注(红点 + 文字,状态不只靠
 *   颜色),与卡面承载档位对齐(upcoming 卡恒标「即将播放」,详见 statusBadge);
 *   current 档正在直播时底板底部附当前节目进度线(红色 = 直播/时间线语义,见 §2 视觉约定);
 * - 信息区只展示一个节目名(档位由分区决定:正在直播类分区=当前节目,
 *   即将播放分区=下一档节目);频道身份保留在 article 可读名与播放/收藏按钮语义中;
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
 * - 播放按钮与收藏按钮分离:播放经共享 PlayButton 走 US3 统一受控播放
 *   (usePlayAction;游客点击进入登录选档意图,选档完成前零 /playback/ 请求);
 *   收藏按会话分流(012 T011、ui.md §1.5):已选档 → 共享 FavoriteStarButton 仅执行
 *   收藏变更(PUT/DELETE /me/favorites/channels,幂等;乐观行内翻面,成功不触发播放);
 *   游客/未选档 → onRequireAuth 登录引导(GuestActionNotice),零请求零部分写入。
 * - 悬停/键盘聚焦(cards focus-within)轻微抬升;动效仅悬停反馈,尊重 reduced-motion
 *   (全局基线见 shared/theme/a11y.css);
 * - 长节目名 .hmp-truncate 截断,HeroUI Tooltip 提供完整可读名称。
 * - 频道身份角标(014 T018;实施期呈现修订 2026-11-08 维护者指令,ui.md §1 修订记录):
 *   右上角 ChannelIdentityBadge —— posterRef 非空 → Logo(加载中/失败回退频道名 chip),
 *   posterRef null → 频道名 chip;长名截断 + HeroUI Tooltip 全名。大首字主视觉取消,
 *   角标与左上状态签/底部进度线/右下操作入口互不重叠(channel-identity-badge.tsx)。
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
  /** 节目时段详情回调(即将播放/当前节目共用;打开频道/节目信息) */
  readonly onOpenProgramme: OpenProgrammeHandler;
  /** 游客收藏:进入登录选档提示(收藏属 US4;播放不经此,走共享 PlayButton) */
  readonly onRequireAuth: (actionLabel: string) => void;
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

export function ChannelTile({ row, slot = 'current', onOpenProgramme, onRequireAuth }: ChannelTileProps): ReactNode {
  const channelTitle = row.media.title;
  // 路由导航(015 T004):current 档文字信息区 → /live/watch/:channelId
  const navigate = useNavigate();
  // 统一播放入口(US3):Hover 中央 ▶ 与右下 PlayButton 同源消费,本组件不旁路第二状态机
  const { play } = usePlayAction();
  // 智能事件定时器(016 T010;ui-experience.md §1/§2):每卡一个 Hook 实例 ——
  // 15s 本地 tick 平滑推进进度、到点本地翻转(无需等 30s 刷新),墙面上 20 卡
  // × 15s 定时器为契约接受成本(零网络;Hook 不发请求,数据真值仍归周期刷新)。
  // 瓦片无 onProgrammeAdvance(卡片不做静默拉取,翻转后由分区 30s 刷新收敛)。
  const programme = useCurrentProgramme({ initialCurrent: row.current, initialNext: row.next });
  /** 智能时钟下的当前节目(到点本地翻转;空档 → null,信息区「暂无节目单」降级) */
  const liveCurrent = programme.current;
  const hasCurrent = liveCurrent !== null;
  const hasNext = row.next !== null;
  /** 本卡承载的节目(档位决定:current=智能时钟当前节目,upcoming=下一档;双缺时走「暂无节目单」占位) */
  const slotProgramme: ExperienceProgrammeDto | null = slot === 'upcoming' ? row.next : liveCurrent;
  const hash = hashOf(row.media.id);
  const plateAngle = 100 + (hash % 140);
  const glowOnRight = hash % 2 === 1;
  /** 状态签与卡面承载档位对齐(DESIGN.md「状态只作语义」;FR-024):
   *  upcoming 卡展示下一档节目名 → 签标「即将播放」,避免「正在直播」签 + 未来节目名
   *  的误读;current 卡:有当前节目 → 正在直播(红点),降级 即将播放,双缺 暂无排期。 */
  const statusBadge: { live: boolean; label: string } =
    slot === 'upcoming'
      ? hasNext
        ? { live: false, label: '即将播放' }
        : { live: false, label: '暂无排期' }
      : hasCurrent
        ? { live: true, label: '正在直播' }
        : hasNext
          ? { live: false, label: '即将播放' }
          : { live: false, label: '暂无排期' };

  // 收藏会话分流(012 T011):仅「已登录且已选档」直接执行收藏;游客/未选档走登录引导
  const session = useSession();
  const activeProfile = session.status === 'authenticated' ? (session.session?.activeProfile ?? null) : null;
  // 墙面无收藏态数据源(ChannelRowDto 不含 favorited):会话内本地翻面,
  // 服务端真值以收藏页/个人区列表为准(成功经 onChanged 收敛,失败由数据层回滚)
  const [wallFavorited, setWallFavorited] = useState(false);

  return (
    <article
      className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg hover:shadow-background/60 focus-within:-translate-y-0.5 focus-within:border-accent/40"
      aria-label={`频道 ${channelTitle}`}
    >
      {/* 16:9 频道标识底板(无海报常态降级;装饰节点一律 aria-hidden,可读名由 article 承担) */}
      <div
        className="relative aspect-video w-full overflow-hidden bg-surface-secondary"
        style={{ background: `linear-gradient(${plateAngle}deg, var(--surface-secondary) 0%, var(--surface-tertiary) 55%, var(--surface) 100%)` }}
      >
        <span
          aria-hidden="true"
          className={`absolute -bottom-12 h-36 w-36 rounded-full bg-accent/15 blur-3xl transition duration-300 group-hover:bg-accent/25 ${
            glowOnRight ? '-right-8' : '-left-8'
          }`}
        />
        {/* 频道身份角标(014 实施期呈现修订 2026-11-08,维护者指令,ui.md §1 修订记录):
            右上角 Logo 或频道名(长名截断 + HeroUI Tooltip 全名),取代原「底板大首字」
            主视觉;加载中/失败名称不缺位(无裂图/无空白)。定位与左上状态签对称,
            与进度线/右下播放收藏三区互不重叠;名称 chip 可 hover(Tooltip 需要)。 */}
        <ChannelIdentityBadge
          key={row.media.posterRef ?? 'no-logo'}
          posterRef={row.media.posterRef}
          channelTitle={channelTitle}
          className="absolute right-2 top-2"
        />

        {/* 状态标注:红点 + 文字(状态不只靠颜色);上左角,随档位对齐(见 statusBadge)。
            无节目频道状态签用「暂无排期」而非「暂无节目单」:信息区已有「暂无节目单」
            明确占位(016 §1.2 降级标题;FR-023),措辞不得构成其子串,避免文本查询歧义。 */}
        <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-sm bg-background/75 px-1.5 py-0.5 text-xs text-foreground backdrop-blur-sm">
          {statusBadge.live ? (
            <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
          ) : null}
          {statusBadge.label}
        </span>

        {/* Hover 快捷起播(015 T004;research.md R5、ui-layout.md §1.2 第 3 条):
            悬停/键盘聚焦瓦片(group-hover / group-focus-within)时,底板正中央平滑淡入
            bg-accent/80 text-accent-foreground 的 ▶ 按钮,点击直接起播(见组件头注)。
            - 按钮恒在 DOM:键盘 Tab 可达,聚焦即浮现且焦点环可见(HeroUI Button
              data-focus-visible + a11y.css 全局基线双通道);隐藏态 pointer-events-none
              防止透明热区误触,浮现态恢复可点;
            - 图标为装饰节点 aria-hidden,可读名由 aria-label「播放 <频道名>」承担,
              与右下 PlayButton(播放 <频道名> 当前直播)语义互补不冲突;
            - 动效仅 opacity 过渡(reduced-motion 由 a11y.css 全局基线收敛);
              半透明 = bg-accent/80 语义 token,不硬编码颜色。 */}
        <Button
          isIconOnly
          size="lg"
          variant="primary"
          aria-label={`播放 ${channelTitle}`}
          className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/80 text-accent-foreground opacity-100 shadow-lg backdrop-blur-sm transition-opacity duration-200 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:pointer-events-auto [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:pointer-events-auto [@media(hover:hover)]:group-focus-within:opacity-100"
          onPress={() => {
            play({ mediaId: row.media.id, title: channelTitle, startMode: 'beginning', posterRef: row.media.posterRef });
          }}
        >
          <Play aria-hidden="true" className="size-5 fill-current" />
        </Button>

        {/* 播放/收藏恒驻底板右下(可见性不随悬停变化,避免触控/键盘丢失入口) */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          {activeProfile !== null ? (
            /* 已选档:收藏即收藏——共享星标组件幂等 PUT/DELETE + 乐观行内翻面,
               与播放零关联(§1.5「收藏成功为行内反馈,不得触发播放」) */
            <span className="inline-flex items-center rounded bg-background/70 backdrop-blur-sm">
              <FavoriteStarButton
                mediaId={row.media.id}
                title={channelTitle}
                favorited={wallFavorited}
                size="sm"
                onChanged={(_mediaId, next) => {
                  setWallFavorited(next);
                }}
              />
            </span>
          ) : (
            /* 游客/未选档:登录引导(GuestActionNotice),零请求零部分写入 */
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label={`收藏 ${channelTitle}`}
              className="bg-background/70 backdrop-blur-sm"
              onPress={() => {
                onRequireAuth(`收藏 ${channelTitle}`);
              }}
            >
              ☆
            </Button>
          )}
          <PlayButton
            mediaId={row.media.id}
            title={channelTitle}
            size="sm"
            label="播放"
            ariaLabel={`播放 ${channelTitle} 当前直播`}
          />
        </div>

        {/* 当前节目进度微条(016 T010;ui-experience.md §1:HeroUI v3 ProgressBar,
            严禁原生 <progress>;值经 useCurrentProgramme 平滑推进,到点本地翻转):
            - 契约伪码 <Progress color="primary"> 按 HeroUI v3 实际 API 映射为
              ProgressBar + color="accent"(v3 色板为 default/accent/success/
              warning/danger,accent 即品牌主色,与瓦片直播语义 token 同源);
            - current == null(空档/降级,§1.2)→ 整条隐藏,禁用态不扩散到卡片,
              播放/悬停行为不受影响(Hover ▶ 契约保持); */}
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

      {/* 信息区:仅节目名(档位见 slot);长名截断 + Tooltip 完整名;
          点击节目名按档位分流(015 T004;ui-layout.md §1.2 第 3 条):
          current 档 → 导航 /live/watch/:channelId 观看详情页;
          upcoming 档 → 打开共享详情面板(节目时段信息,FR-024)。
          Trigger 直接用 HeroUI Button(消费 react-aria Focusable 上下文,悬停即可达
          Tooltip;原生 button 不消费该上下文,Tooltip.Trigger 又是 div[role=button]
          包装器,内嵌原生按钮会产生重复同名 role=button)。
          样式只用对齐/宽度/字重覆盖(DESIGN.md:用既有变体,不重造按钮);
          尺寸/内边距/悬停/焦点环走 ghost sm 变体原生状态。 */}
      <div className="min-w-0 p-3">
        {slotProgramme !== null ? (
          <h3 className="min-w-0">
            <Tooltip>
              <Button
                variant="ghost"
                size="sm"
                className="w-full min-w-0 justify-start font-semibold"
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
                <span className="hmp-truncate min-w-0">{slotProgramme.title}</span>
              </Button>
              <Tooltip.Content>{slotProgramme.title}</Tooltip.Content>
            </Tooltip>
          </h3>
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
      </div>
    </article>
  );
}
