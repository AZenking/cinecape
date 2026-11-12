import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import type { ChannelPageDto, ChannelRowDto } from '@hmp/shared';
import { Button, ProgressBar } from '@heroui/react';
import { ArrowLeft } from 'lucide-react';
import { useAppQuery } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { useSession } from '../../../app/session-provider';
import { usePlayAction } from '../../playback/use-play-action';
import { FavoriteStarButton } from '../../favorites/favorite-star-button';
import { fetchLiveChannels, type LiveChannelQuery } from '../live-api';
import { formatRangeInZone, formatTimeInZone } from '../live-format';
import { GuestActionNotice } from '../components/GuestActionNotice';
import { SameTypeLiveStrip } from '../components/SameTypeLiveStrip';
import { useInPlaceChannelSwitch } from '../hooks/use-in-place-channel-switch';
import { useCurrentProgramme } from '../hooks/use-current-programme';

/**
 * Screen 4 播放与详情一体化页(T016/T017;015 FR-010/011/012/013、
 * contracts/ui-layout.md §4、contracts/routing-and-url-state.md §2.4、
 * research.md R4、data-model.md §2.3/§3.1、quickstart 场景 4)。
 *
 * 播放架构裁决(硬约束,实施期维护者指令):本页**零独立播放管线** —— 「左侧/上部
 * 播放器容器」= 复用 app/action-coordinator 的全局播放面浮层
 * (data-testid="playback-surface"):页面挂载经 usePlayAction().play() 自动起播
 * (进入即 resolve;游客由协调器统一拦截进登录选档意图,本页不做任何登录判断),
 * 全局播放面呈现画面,播放期间页面保持完全可交互。严禁自建第二个 PlayerView
 * 实例/第二条播放管线、严禁绕过 resolve 取流 —— 布局中的播放器容器位仅为全局
 * 播放面的落位示意(语义标注),真实画面由浮层承载。
 *
 * 频道元数据获取(最小方案,零新增端点;contracts/api-reuse.md):
 * - 复用既有 GET /api/public/live/channels(section=all,pageSize=服务端上限 50,
 *   与 LivePage 概览同键共享缓存)—— 从列表行按 :channelId 精确提取 ChannelRowDto,
 *   一次请求同时拿到频道身份(title/posterRef/groupKey/groupLabel)、current/next
 *   节目与 now/timezone 服务端快照(进度百分比按快照 now 与节目窗复算,不臆造本地
 *   时钟;同 LivePage panelStatusOf 的 serverNow 用法);
 * - 同类横条数据由 SameTypeLiveStrip 内部的 useRelatedLiveChannels(T003)按
 *   section=group&groupKey 再取一条公共请求(api-reuse.md Screen 4 行)——两组查询
 *   互不新增端点;换台不换分组时两者全部命中缓存,面板即时派生更新;
 * - 兜底:频道行不在首页(pageSize=50 上限)或元数据请求失败时,以 :channelId 兜底
 *   标识照常自动起播(FR-010「进入即起播」不依赖元数据成功;频道无 EPG 排期时
 *   节目区显示「暂无节目单」,播放不受影响 —— spec Edge Cases)。
 *
 * 就地换台(T017;research.md R4):点击同类卡片经 useInPlaceChannelSwitch().switchTo
 * —— 立即 play 新 mediaId(play() 新意图取代旧意图 = 就地换流,页面组件不卸载)+
 * navigate('/live/watch/:newId', { replace: true }) 静默同步地址栏;整页零重载,
 * 伴随面板数据随 :channelId 从缓存派生即时更新(禁用 key=channelId 一类重建子树写法)。
 * 自动起播 effect 以「已激活频道 ref」守卫:换台抵达的新 channelId 不重复起播。
 *
 * from 返回(routing-and-url-state.md §2.4):?from=live/channels/guide 映射对应
 * 返回目标,缺省/未知回落 /live;显式 navigate(target)(navigate(-1) 依赖历史栈
 * 不可靠,契约要求按 from 可预测返回)。
 *
 * 伴随面板智能时钟(016 T011;contracts/ui-experience.md §2):右侧面板接入
 * useCurrentProgramme —— 进度条 15s 本地 tick 平滑推进、到点本地翻转(当前节目标题/
 * Next 预告随推进切换,无需整页重载),onProgrammeAdvance 接既有频道元数据查询的
 * 静默 refetch(复用 useAppQuery 同键查询,零新增端点/请求通道);refetch 交付新
 * 节目单后 Hook 以 initialCurrent.key 锚重置(同 key 刷新不扰动运行中定时器)。
 * 服务器 now 偏移不在 Hook 职责:进度/翻转按本地时钟(契约 §2.2),与 015
 * panelStatusOf 的服务端快照推导刻意分工(取舍见 hook JSDoc),偏差由周期刷新收敛。
 *
 * 布局(ui-layout §4.2 / spec Edge Cases 响应式):宽屏左右分栏(播放器容器位 +
 * 右侧伴随面板),窄屏(<lg)上下堆叠(面板自然下沉到播放器位下方,同类横条随后);
 * 全部样式走语义 token + Tailwind 断点。
 */

/** 频道元数据整页查询条数(服务端 live channels pageSize 上限 50,live.controller.ts) */
const WATCH_LOOKUP_PAGE_SIZE = 50;

/** ?from= 白名单 → 显式返回目标(routing-and-url-state §2.4;仅这三个合法值) */
const FROM_TARGETS: Readonly<Record<string, string>> = {
  live: '/live',
  channels: '/live/channels',
  guide: '/live/guide',
};

/** ?from= 白名单 → 返回按钮读名(可预测返回的语义标注) */
const FROM_LABELS: Readonly<Record<string, string>> = {
  live: '直播首页',
  channels: '频道库',
  guide: '节目单',
};

export function LiveWatchPage(): ReactNode {
  const params = useParams();
  const channelId: string | undefined = params.channelId;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { play } = usePlayAction();
  const session = useSession();

  // from 返回目标与读名(白名单外/缺省回落 /live)
  const fromParam = searchParams.get('from');
  const fromTarget = fromParam !== null ? FROM_TARGETS[fromParam] : undefined;
  const backTarget = fromTarget ?? '/live';
  const backLabel = (fromParam !== null ? FROM_LABELS[fromParam] : undefined) ?? '直播首页';

  // 频道元数据查询(section=all 首页整表;键与 LivePage 概览共享,换台零重取)
  const lookupQuery: LiveChannelQuery = { section: 'all', page: 1, pageSize: WATCH_LOOKUP_PAGE_SIZE };
  const lookup = useAppQuery<ChannelPageDto>({
    domain: 'public',
    queryKey: queryKeys.public.liveChannels(lookupQuery),
    queryFn: ({ signal }) => fetchLiveChannels(lookupQuery, signal),
  });
  const row: ChannelRowDto | null =
    channelId !== undefined
      ? (lookup.data?.items.find((candidate) => candidate.media.id === channelId) ?? null)
      : null;
  const channelTitle = row?.media.title ?? channelId ?? '';
  const timezone = lookup.data?.timezone ?? 'UTC';

  // 伴随面板智能时钟(016 T011;ui-experience.md §2):15s 本地 tick 平滑推进 +
  // 到点本地翻转(标题/Next 随推进切换,无需重载);onProgrammeAdvance 接既有
  // 元数据查询的静默 refetch(复用同键查询,零新增请求通道)。
  const handleProgrammeAdvance = useCallback(() => {
    void lookup.refetch();
  }, [lookup.refetch]);
  const programme = useCurrentProgramme({
    initialCurrent: row?.current ?? null,
    initialNext: row?.next ?? null,
    onProgrammeAdvance: handleProgrammeAdvance,
  });

  // 收藏(会话内本地翻面;ChannelRowDto 不含 favorited,服务端真值归收藏页/个人区,
  // 语义与 ChannelTile 一致)。换台后按新频道重置本地翻面态。
  const [favorited, setFavorited] = useState(false);
  const [guestNotice, setGuestNotice] = useState<string | null>(null);
  useEffect(() => {
    setFavorited(false);
  }, [channelId]);

  const activeProfile =
    session.status === 'authenticated' ? (session.session?.activeProfile ?? null) : null;

  // 就地换台 + 自动起播共用「已激活频道 ref」:任何路径只发一次意图,
  // 换台(switchTo)抵达的新 channelId 不再触发自动起播(意图已在 switchTo 发起)
  const activatedChannelRef = useRef<string | null>(null);
  const handleActivate = useCallback(
    (mediaId: string, title: string | null): void => {
      activatedChannelRef.current = mediaId;
      // 直播恒从头(beginning;无续播语义);title 兜底 channelId(元数据未就绪/失败)
      play({ mediaId, title: title !== null && title !== '' ? title : mediaId, startMode: 'beginning' });
    },
    [play],
  );
  const { switchTo } = useInPlaceChannelSwitch({ activeChannelId: channelId, onActivate: handleActivate });

  // 进入即自动起播(FR-010):等元数据落地(成功或失败均会 settle)再发起,
  // 以取得真实频道名;失败/行缺失时以 :channelId 兜底,起播绝不被元数据吞掉
  const lookupReady = !lookup.isPending;
  useEffect(() => {
    if (channelId === undefined || !lookupReady) {
      return;
    }
    if (activatedChannelRef.current === channelId) {
      return; // 已由自动起播/就地换台发起(幂等守卫,含 Strict 双调用)
    }
    const found = lookup.data?.items.find((candidate) => candidate.media.id === channelId) ?? null;
    handleActivate(channelId, found?.media.title ?? null);
  }, [channelId, lookupReady, lookup.data, handleActivate]);

  if (channelId === undefined) {
    return null; // 未挂载于 :channelId 路由参数(防御;正常由 Route 提供)
  }

  // 智能时钟下的当前节目/下一档(到点本地翻转;refetch 交付后按 key 锚重置收敛)
  const current = programme.current;
  const next = programme.next;
  const progressPct = current !== null ? programme.progressPercent : null;

  return (
    <div data-testid="live-watch-page" className="flex min-w-0 flex-col gap-6">
      {/* 左上返回:按 ?from= 显式导航(契约 §2.4;不用 navigate(-1)) */}
      <header className="flex min-w-0 items-center gap-3">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`返回${backLabel}`}
          onPress={() => {
            void navigate(backTarget);
          }}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          返回
        </Button>
      </header>

      {/* 宽屏左右分栏(播放器容器位 + 右侧伴随面板);窄屏上下堆叠(面板下沉)。
          播放器容器位 = 全局播放面的落位示意(见头注裁决),不渲染任何自建播放器。 */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <section
          aria-label="播放器容器"
          data-testid="watch-player-slot"
          className="flex aspect-video w-full items-center justify-center rounded-xl border border-dashed border-border bg-surface-secondary/40 p-4 text-center lg:order-1"
        >
          <p className="text-sm text-muted">
            实时画面由全局播放面承载:进入本页已自动起播,画面见屏幕播放浮层。
          </p>
        </section>

        {/* 右侧伴随面板(FR-011;ui-layout §4.2):频道名/当前节目/进度条/简介/收藏/Next */}
        <aside
          aria-label="节目伴随信息"
          data-testid="watch-meta-panel"
          className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4 lg:order-2"
        >
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              {row !== null ? <p className="text-xs text-muted">{row.groupLabel}</p> : null}
              <h1 className="hmp-truncate min-w-0 text-xl font-semibold text-foreground">{channelTitle}</h1>
            </div>
            {/* 收藏(语义与 ChannelTile 一致):已选档 → 星标幂等变更;游客 → 登录引导零请求 */}
            {activeProfile !== null ? (
              <FavoriteStarButton
                mediaId={channelId}
                title={channelTitle}
                favorited={favorited}
                onChanged={(_mediaId, isFavorite) => {
                  setFavorited(isFavorite);
                }}
              />
            ) : (
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                aria-label={`收藏 ${channelTitle}`}
                onPress={() => {
                  setGuestNotice(`收藏 ${channelTitle}`);
                }}
              >
                ☆
              </Button>
            )}
          </div>

          <section aria-label="当前节目" className="flex min-w-0 flex-col gap-2">
            {current !== null ? (
              <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-background/75 px-1.5 py-0.5 text-xs text-foreground">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
                正在直播
              </span>
            ) : null}
            <h2 className="min-w-0 text-base font-medium text-foreground">
              {current !== null ? current.title : '暂无节目单'}
            </h2>
            {current !== null && progressPct !== null ? (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-xs text-muted">
                  <span>{formatRangeInZone(current.startsAt, current.endsAt, timezone)}</span>
                  <span>{` · 已播 ${progressPct}%`}</span>
                  <span>{` · ${programme.remainingText}`}</span>
                </p>
                <ProgressBar
                  aria-label="当前节目播出进度"
                  value={progressPct}
                  valueLabel={`已播 ${progressPct}%`}
                  size="sm"
                >
                  <ProgressBar.Track>
                    <ProgressBar.Fill />
                  </ProgressBar.Track>
                </ProgressBar>
              </div>
            ) : null}
            {current?.description != null && current.description !== '' ? (
              <p className="text-sm text-muted">{current.description}</p>
            ) : null}
          </section>

          <section aria-label="即将播放 (Next)" className="flex min-w-0 flex-col gap-1 border-t border-border pt-3">
            <h3 className="text-sm font-semibold text-foreground">即将播放 (Next)</h3>
            {next !== null ? (
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="hmp-truncate min-w-0 text-sm text-foreground">{next.title}</p>
                <p className="text-xs text-muted">
                  <span>{formatTimeInZone(next.startsAt, timezone)}</span>
                  {' 开播'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted">暂无预告</p>
            )}
          </section>
        </aside>
      </div>

      {/* 游客私有动作引导(收藏;与 LivePage 同一组件,登录后回本页) */}
      {guestNotice !== null ? (
        <div role="status">
          <GuestActionNotice actionLabel={guestNotice} onClose={() => setGuestNotice(null)} />
        </div>
      ) : null}

      {/* 同类型直播横条(sam type live):点击卡片经 switchTo 就地换流(T017) */}
      <SameTypeLiveStrip groupKey={row?.groupKey} activeChannelId={channelId} onSwitch={switchTo} />
    </div>
  );
}
