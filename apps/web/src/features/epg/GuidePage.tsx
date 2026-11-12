import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { parseDate } from '@internationalized/date';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { Alert, Button, Drawer, ListBox, Select, Skeleton } from '@heroui/react';
import { ChevronsLeft, ChevronsRight, Clock, SlidersHorizontal } from 'lucide-react';
import { RetryableAlert } from '../../shared/ui';
import { useGuideWindow } from './useGuideWindow';
import { GuideDateTabs } from './GuideDateTabs';
import { GuideScrollContainer } from './GuideScrollContainer';
import { GuideWall, CHANNEL_COL_PX, type GuideProgrammeRef } from './GuideWall';
import { GuideChannelList } from './GuideChannelList';
import { utcToPx, windowSpanPx } from './guide-time';
import { serverNowMs } from '../../shared/time/server-clock';
import { consumeGuideSessionSnapshot, GUIDE_WALL_SESSION_KEY, saveGuideSessionSnapshot } from './guide-session-state';
import { usePlayAction } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { useAuthAction } from '../../app/action-coordinator';
import { useFavoriteToggleMutation } from '../favorites/use-favorites';
import { ProgrammeDetailPanel, type ProgrammeStatus } from '../shared-programme/ProgrammeDetailPanel';

/**
 * EPG 节目单页(T116/T117/T118/T119/T120;FR-025~027、FR-042~045、A-008、ui.md §6;
 * 012 T022/T023/T025:FR-013/FR-015/FR-016/FR-018):
 * - /live/guide 公共路由(US6 接入 routes.tsx;可经详情面板「查看节目单」等直达);
 * - date/from/channelPage/pageSize/view 写 URL 查询参数作为公共浏览状态(012 url-state
 *   §1 冻结契约):详情返回或登录取消后恢复原日期、频道与时间位置(FR-045/FR-018);
 *   date 缺省今天(非法格式/非法日历日静默回落);from/to 缺省 = 服务端「该日完整
 *   24 小时」默认窗口(真实日界;旧链接里的日内子窗口 from/to 仍受支持并原样透传);
 * - 公共取数经统一数据层 useAppQuery(public 域;键取自 queryKeys.public.guide
 *   工厂;staleTime 60s EPG 慢变;signal 透传/缓存/后台刷新由数据层承担;
 *   placeholderData keepPreviousData:切日期/频道页时旧窗口保持可见):
 *   409 回今天的旧窗口响应不回写;失败保留旧窗口续显;
 * - T023(FR-015;015 ui-layout §3.2.1):首次进入把当前时刻线(NOW Line)水平
 *   居中(当前节目与后续排期同屏),非今天日期锚定窗口起点(真实 now 在历史/
 *   未来窗口会被 clamp 到边缘,语义失真);时区说明恒显于页头;同一窗口身份重复
 *   渲染(自动刷新)不重定位——手动浏览过去/未来不被拉回(FR-016);
 * - 服务端基准时钟(016 spec 基准时间条款):所有时间展示与 EPG 进度以
 *   shared/time/server-clock 校准时刻为准(响应携带 now 即校准;未校准回落
 *   响应快照,不臆造浏览器本地时钟);墙/列表内部经 useServerNow tick 平滑推进;
 * - T023(FR-016、url-state §1 规则4):「回到现在」仅恢复今天+当前窗口
 *   (删 date/from/to),频道分页/页大小/视图与既有筛选参数一律保留;
 * - T022(FR-013、ui.md §2):节目详情挂载共享面板 shared-programme/ProgrammeDetailPanel
 *   (与直播首页三区同一组件);节目块点击只开面板不播放(§3.4);status 由宿主按
 *   serverNow 推导(时段含 now→now;未开始→upcoming;已结束→ended;无节目→none);
 *   主操作=播放该频道当前直播(频道语义,经 usePlayAction 统一入口);收藏=Profile 级
 *   收藏频道(游客/未选档走统一登录引导,零请求;§1.5);「查看节目单」在本页语义为
 *   关闭面板回到节目单并聚焦窗口标题;
 * - T025(FR-018、url-state §1 规则3):详情面板打开前把节目单滚动与焦点锚写入
 *   模块级会话快照(guide-session-state,不进 URL/浏览器存储),面板返回时恢复;
 *   页面刷新回缺省定位可接受;
 * - 「回到现在」清空 date/from/to(保留分页/视图/筛选)回今天;
 * - 409 GUIDE_DATE_EXPIRED:回今天(按 problem.allowedDates 首日)并提示「日期已更新」,
 *   丢弃旧窗口响应;422 GUIDE_WINDOW_TOO_LARGE:提示减少每页频道数、保留频道页;
 * - 时间轴浏览:一次展示所选日期完整 24 小时(真实日界,与服务端同源
 *   @internationalized/date,不加 24h;DST 23/25 小时日按真实日长);
 * - 播放统一经 US3 usePlayAction(游客先登录选档,登录前不请求媒体流)。
 */

const PAGE_SIZES = [20, 30, 50] as const;
const VIEWS = ['wall', 'list'] as const;

interface GuideUrlState {
  readonly date?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly channelPage: number;
  readonly pageSize: number;
  readonly view: (typeof VIEWS)[number];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' 是否为真实日历日(012 url-state §1 规则2:非法值静默回落缺省) */
function isValidCalendarDate(value: string): boolean {
  try {
    parseDate(value);
    return true;
  } catch {
    return false;
  }
}

/** URL 查询参数 → 视图状态(非法值回落缺省;不因伪造参数崩溃) */
function readUrlState(params: URLSearchParams): GuideUrlState {
  const rawDate = params.get('date');
  const date =
    rawDate !== null && DATE_PATTERN.test(rawDate) && isValidCalendarDate(rawDate) ? rawDate : undefined;
  const fromMs = parseIsoParam(params.get('from'));
  const toMs = parseIsoParam(params.get('to'));
  const channelPageRaw = Number.parseInt(params.get('channelPage') ?? '1', 10);
  const channelPage = Number.isInteger(channelPageRaw) && channelPageRaw >= 1 ? channelPageRaw : 1;
  const pageSizeRaw = Number.parseInt(params.get('pageSize') ?? '20', 10);
  const pageSize = PAGE_SIZES.includes(pageSizeRaw as (typeof PAGE_SIZES)[number]) ? pageSizeRaw : 20;
  const viewRaw = params.get('view');
  const view = viewRaw === 'list' ? 'list' : 'wall';
  return { date, fromMs, toMs, channelPage, pageSize, view };
}

function parseIsoParam(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 详情面板目标(节目块点击;programme=null 语义为「无节目数据」,墙/列表不产生) */
interface GuideDetailTarget {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly programme: ExperienceProgrammeDto | null;
}

/**
 * 面板四状态宿主裁决(T022;取代旧组件内 serverNow 推导):
 * 节目时段含 now → now;未开始 → upcoming;已结束 → ended;无节目 → none。
 * now 取服务端基准钟(016 spec 基准时间条款;未校准回落响应快照 data.now),
 * 不用浏览器本地时钟;无效时不猜,按 none 呈现(墙内打开时 data.now 恒在,
 * 实际不可达;共享面板 none 态保留频道身份与播放主操作,§2.5)。
 */
function deriveProgrammeStatus(programme: ExperienceProgrammeDto | null, nowMs: number | null): ProgrammeStatus {
  if (programme === null || nowMs === null || !Number.isFinite(nowMs)) {
    return 'none';
  }
  const startMs = Date.parse(programme.startsAt);
  const endMs = Date.parse(programme.endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 'none';
  }
  if (startMs <= nowMs && nowMs < endMs) {
    return 'now';
  }
  return nowMs < startMs ? 'upcoming' : 'ended';
}

export function GuidePage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const url = useMemo(() => readUrlState(searchParams), [searchParams]);
  const { play } = usePlayAction();
  const { startLogin } = useAuthAction();
  const session = useSession();
  const [detail, setDetail] = useState<GuideDetailTarget | null>(null);
  const [navSeq, setNavSeq] = useState(0);
  const /** 节目单滚动容器(T025 快照读写) */
    scrollRef = useRef<HTMLDivElement | null>(null);
  const /** 详情关闭方式:restore=恢复触发节目块焦点;guide=已锚到窗口标题 */
    detailCloseModeRef = useRef<'restore' | 'guide'>('restore');
  const /** 上一渲染的详情目标(检测「开→关」沿触发恢复) */
    prevDetailRef = useRef<GuideDetailTarget | null>(null);
  const /** 409 自动回今天只执行一次的守卫 */
    expiredHandledRef = useRef<string | null>(null);

  const resource = useGuideWindow({
    date: url.date,
    fromMs: url.fromMs,
    toMs: url.toMs,
    page: url.channelPage,
    pageSize: url.pageSize,
  });

  // 收藏频道(T022 最小接线):身份未定(null)时无乐观写/无失效目标;
  // 仅在已选档的 onFavorite 内 mutate —— 游客/未选档不产生任何 /me 请求(ui.md §1.5)
  const activeProfileId = session.session?.activeProfile?.id ?? null;
  const favoriteToggle = useFavoriteToggleMutation(activeProfileId, {
    id: detail?.mediaId ?? '',
    title: detail?.channelTitle ?? '',
    unavailable: false,
  });

  /** URL 更新(公共浏览状态;详情返回/登录取消后经 URL 恢复) */
  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void, focus = true): void => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      setSearchParams(next, { replace: false });
      if (focus) {
        setNavSeq((value) => value + 1);
      }
    },
    [searchParams, setSearchParams],
  );

  const data = resource.data;

  // 409 GUIDE_DATE_EXPIRED:回今天(allowedDates 首日)、清窗口、提示日期已更新;旧响应已被 hook 丢弃
  const [expiredNotice, setExpiredNotice] = useState(false);
  const /** 显示与筛选抽屉(视图/每页频道数/频道分页收拢于此;参照参考页筛选抽屉) */
    [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => {
    if (!resource.dateExpired) {
      return;
    }
    const stamp = `${resource.expiredAllowedDates?.[0] ?? ''}`;
    if (expiredHandledRef.current === stamp) {
      return;
    }
    expiredHandledRef.current = stamp;
    setExpiredNotice(true);
    const next = new URLSearchParams(searchParams);
    next.delete('from');
    next.delete('to');
    next.delete('channelPage');
    const fallback = resource.expiredAllowedDates?.[0];
    if (fallback === undefined || next.get('date') === fallback) {
      next.delete('date');
    } else {
      next.set('date', fallback);
    }
    setSearchParams(next, { replace: true });
  }, [resource.dateExpired, resource.expiredAllowedDates, searchParams, setSearchParams]);

  const timezone = data?.timezone ?? 'UTC';

  // T023(FR-015;015 ui-layout §3.2.1):窗口身份(from|to)变化(首次进入/切日/
  // 回到现在)才重新定位;自动刷新产生同窗口数据,key 不变 → 容器不重定位
  // (FR-016 不拉回)。定位锚:
  // - 今天:当前时刻线(NOW Line)水平居中(015 §3.2.1「页面初始化自动水平居中
  //   当前时刻线」;当前节目与后续排期同屏可见,FR-015);
  // - 非今天(历史/未来日期):锚定窗口起点,不用真实 now(其会被 clamp 到窗口
  //   边缘,「当前时刻附近」语义失真);
  // - now 取服务端基准钟(016 spec 基准时间条款),未校准回落响应快照 data.now
  const autoPosition = useMemo(() => {
    if (data === null) {
      return undefined;
    }
    const fromMs = Date.parse(data.from);
    const toMs = Date.parse(data.to);
    const spanPx = windowSpanPx(fromMs, toMs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      return undefined;
    }
    const key = `${data.from}|${data.to}`;
    const isToday = data.date === data.allowedDates[0];
    if (!isToday) {
      return { key, anchorX: 0, align: 'start' as const };
    }
    const snapshotNowMs = Date.parse(data.now);
    const nowMs = serverNowMs() ?? (Number.isFinite(snapshotNowMs) ? snapshotNowMs : null);
    if (nowMs === null) {
      return undefined;
    }
    const nowX = Math.min(Math.max(utcToPx(nowMs, fromMs), 0), spanPx);
    return { key, anchorX: CHANNEL_COL_PX + nowX, align: 'center' as const };
  }, [data]);

  const selectDate = useCallback(
    (date: string): void => {
      setDetail(null);
      setExpiredNotice(false);
      updateParams((params) => {
        if (date === (data?.allowedDates[0] ?? '')) {
          params.delete('date');
        } else {
          params.set('date', date);
        }
        params.delete('from');
        params.delete('to');
        params.delete('channelPage');
      });
    },
    [data?.allowedDates, updateParams],
  );

  const goNow = useCallback((): void => {
    setDetail(null);
    setExpiredNotice(false);
    // T023(FR-016、url-state §1 规则4):仅恢复今天 + 当前窗口(删 date/from/to);
    // 其余参数(频道分页/页大小/视图与既有筛选)一律保留,不清筛选。
    updateParams((params) => {
      params.delete('date');
      params.delete('from');
      params.delete('to');
    });
    // 已在今天(窗口不变,key 不变 → 容器不会重定位):平滑把 NOW 线带回视口
    // 居中(015 §3.2.1 同一对齐语义);非今天:跳过即时滚动——新窗口数据到达后
    // 由 autoPosition(align='start',窗口起点)定位,避免先滚到旧窗口 clamp
    // 位置再跳转的抖动
    if (autoPosition !== undefined && autoPosition.align === 'center' && scrollRef.current) {
      const left = Math.max(0, autoPosition.anchorX - scrollRef.current.clientWidth / 2);
      if (typeof scrollRef.current.scrollTo === 'function') {
        scrollRef.current.scrollTo({ left, behavior: 'smooth' });
      } else {
        scrollRef.current.scrollLeft = left;
      }
    }
  }, [autoPosition, updateParams]);

  /** Planby 时间轴水平滚动辅助 (快速前后跨时段浏览) */
  const scrollTimeline = useCallback((deltaPx: number): void => {
    if (scrollRef.current) {
      if (typeof scrollRef.current.scrollBy === 'function') {
        scrollRef.current.scrollBy({ left: deltaPx, behavior: 'smooth' });
      } else {
        scrollRef.current.scrollLeft += deltaPx;
      }
    }
  }, []);

  const changePage = useCallback(
    (delta: 1 | -1): void => {
      updateParams((params) => {
        const nextPage = Math.max(1, url.channelPage + delta);
        if (nextPage === 1) {
          params.delete('channelPage');
        } else {
          params.set('channelPage', String(nextPage));
        }
      });
    },
    [url.channelPage, updateParams],
  );

  /** 关闭详情(mode=restore 恢复触发块焦点;mode=guide 已锚到窗口标题,免重复恢复) */
  const closeDetail = useCallback((mode: 'restore' | 'guide' = 'restore'): void => {
    detailCloseModeRef.current = mode;
    setDetail(null);
  }, []);

  const onOpenProgramme = useCallback((ref: GuideProgrammeRef): void => {
    // T025:打开详情前把节目单滚动与焦点锚写入会话快照(模块级内存;不进 URL/storage),
    // 返回(面板关闭)时恢复——恢复由构造保证,不依赖面板期间 DOM 恰好没动。
    const container = scrollRef.current;
    saveGuideSessionSnapshot(GUIDE_WALL_SESSION_KEY, {
      scrollLeft: container?.scrollLeft ?? 0,
      scrollTop: container?.scrollTop ?? 0,
      focusKey: ref.programme.key,
    });
    // 详情选择写入组件状态(URL 浏览位置不动,返回即恢复原位置)
    setDetail({ mediaId: ref.mediaId, channelTitle: ref.channelTitle, programme: ref.programme });
  }, []);

  // T025:详情「开→关」沿触发恢复(滚动 + 触发节目块焦点;SPA 回访场景由
  // GuideScrollContainer 首次定位消费同一快照兜底)
  useEffect(() => {
    const wasOpen = prevDetailRef.current !== null;
    prevDetailRef.current = detail;
    if (detail !== null || !wasOpen) {
      return;
    }
    const snapshot = consumeGuideSessionSnapshot(GUIDE_WALL_SESSION_KEY);
    if (snapshot === null) {
      return;
    }
    const container = scrollRef.current;
    if (container !== null) {
      container.scrollLeft = snapshot.scrollLeft;
      container.scrollTop = snapshot.scrollTop;
    }
    if (detailCloseModeRef.current === 'restore' && snapshot.focusKey !== null) {
      let block: HTMLElement | null = null;
      for (const candidate of container?.querySelectorAll<HTMLElement>('[data-programme-key]') ?? []) {
        if (candidate.getAttribute('data-programme-key') === snapshot.focusKey) {
          block = candidate;
          break;
        }
      }
      // preventScroll:先恢复滚动锚,焦点移动不二次改写滚动位置
      block?.focus({ preventScroll: true });
    }
  }, [detail]);

  const onPlayChannel = useCallback(
    (mediaId: string, channelTitle: string): void => {
      // US3 统一受控播放(游客先登录选档,登录前不请求媒体流);详情面已先关闭
      play({ mediaId, title: channelTitle });
    },
    [play],
  );

  const channelRangeStart = (url.channelPage - 1) * url.pageSize + 1;
  const channelRangeEnd = data !== null ? Math.min(url.channelPage * url.pageSize, data.totalChannels) : url.channelPage * url.pageSize;
  const hasMoreChannels = data === null || url.channelPage * url.pageSize < data.totalChannels;
  const selectedDate = url.date ?? data?.allowedDates[0];
  const windowLabel =
    data !== null
      ? `${new Date(data.from).toISOString().slice(11, 16)}–${new Date(data.to).toISOString().slice(11, 16)} UTC`
      : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* 页头:标题行(标题 + 时区说明)+ 日期条独占一行。
          参照页把日期放在顶部导航层而非工具栏内——7 日胶囊条约 520px,与工具栏控件
          同排必然换行并把工具栏撑成两行(实测 90px);并入页头后工具栏恒为单行。
          日期条占满整行宽度(不与标题/时区争宽,390 窄窗下才不会被挤成一条缝),
          内部单行横滑;加载态占位文案与 role 不变。 */}
      {/* 顶部控制区(产品要求:日期条与工具条合成一个整体,不再分成两块卡片):
          第一行 = 日期胶囊条,第二行 = 回到现在 / 显示与筛选 / ±2h;同一圆角容器,
          行间用分隔线区分层级。页面标题保留 h1 语义但不呈现可见文案。 */}
      {/* 顶部控制区(单行):左侧日期胶囊条,右侧动作(回到现在 / 显示与筛选 / ±2h)。
          窄窗自动换行(flex-wrap);页面标题保留 h1 语义但不呈现可见文案。 */}
      {/* 409:日期已更新提示(回今天;旧窗口响应已丢弃) */}
      {expiredNotice ? (
        <div role="status">
          <Alert status="warning" className="w-full">
            <Alert.Title>日期已更新,已回到今天</Alert.Title>
            <Alert.Description>原日期已不在可浏览范围(家庭日期跨日),已为您回到今天并丢弃旧窗口。</Alert.Description>
          </Alert>
        </div>
      ) : null}

      {/* 422:窗口内节目过多提示(保留频道页;全天窗口下的对策是减少每页频道数) */}
      {resource.windowTooLarge ? (
        <div role="alert">
          <Alert status="warning" className="w-full">
            <Alert.Title>窗口内节目过多</Alert.Title>
            <Alert.Description>该日期全天节目数量超出单次上限,请把「每页频道数」调小后重试;当前日期与频道页已保留。</Alert.Description>
          </Alert>
        </div>
      ) : null}

      {/* 加载失败(非 409/422):可重试,不提示重新登录(FR-004;shared/ui 三态封装) */}
      {resource.status === 'error' && !resource.dateExpired && !resource.windowTooLarge ? (
        <RetryableAlert
          title="节目单加载失败"
          description="服务暂时不可用,可以重试。"
          onRetry={resource.retry}
        />
      ) : null}

      {/* 顶部控制区 + 节目墙 = 同一张卡片(产品要求:日期条与时间轴是一个整体) */}
      <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-surface shadow-xs">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-3 py-2">
        <h1 className="sr-only">节目单</h1>
        <div className="min-w-0 flex-1">
          {data !== null ? (
            <GuideDateTabs
              allowedDates={data.allowedDates}
              timezone={timezone}
              selected={url.date ?? undefined}
              onSelect={selectDate}
            />
          ) : (
            <span className="text-sm text-muted" role="status">
              正在加载日期…
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-x-1.5">
        <Button size="sm" variant="outline" onPress={goNow}>
          <Clock aria-hidden="true" className="size-3.5" />
          回到现在
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          aria-label="显示与筛选"
          data-testid="guide-filter-button"
          onPress={() => {
            setFilterOpen(true);
          }}
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
        </Button>
        {url.view === 'wall' ? (
          <div className="flex items-center gap-0.5">
            <Button size="sm" variant="ghost" isIconOnly onPress={() => scrollTimeline(-240)} aria-label="向左滚动2小时">
              <ChevronsLeft aria-hidden="true" className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" isIconOnly onPress={() => scrollTimeline(240)} aria-label="向右滚动2小时">
              <ChevronsRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : null}
        </div>
        </header>

        {/* 节目墙(同一 GuideWindow 响应);详情为右侧抽屉(portal,不影响排版) */}
        <div className="flex min-w-0 flex-col">
          {resource.isLoading ? (
            <div role="status" className="flex flex-col gap-3 py-8">
              <p className="text-center text-sm text-muted">正在加载节目单…</p>
              <div className="flex flex-col gap-2" aria-hidden="true">
                {Array.from({ length: 4 }, (_, row) => (
                  <div key={row} className="flex items-center gap-3">
                    <Skeleton className="size-8 shrink-0 rounded-md" />
                    <Skeleton className="h-8 min-w-0 flex-1 rounded-md" />
                  </div>
                ))}
              </div>
            </div>
          ) : data !== null ? (
            <GuideScrollContainer
              ariaLabel="节目墙"
              describedById="guide-window-title"
              containerRef={scrollRef}
              autoPosition={autoPosition}
              flush
            >
              {url.view === 'wall' ? (
                <GuideWall
                  data={data}
                  focusSignal={navSeq}
                  selectedKey={detail?.programme?.key ?? null}
                  onSelectProgramme={onOpenProgramme}
                  onPlayChannel={onPlayChannel}
                />
              ) : (
                <GuideChannelList
                  data={data}
                  selectedKey={detail?.programme?.key ?? null}
                  onSelectProgramme={onOpenProgramme}
                  onPlayChannel={onPlayChannel}
                />
              )}
            </GuideScrollContainer>
          ) : resource.status === 'ready' ? (
            <p className="py-10 text-center text-sm text-muted" role="status">
              暂无节目数据
            </p>
          ) : null}
          {windowLabel !== undefined ? <span className="hmp-sr-only">{`当前窗口 ${windowLabel}`}</span> : null}
        </div>
      </div>

      {/* 显示与筛选抽屉(参照参考页右侧筛选抽屉):视图/每页频道数/频道分页收拢于此。
          交互逻辑与既有测试契约(aria-label/可访问名/testid/选项文案)零改动,仅换容器。
          频道分页仅在「频道数 > 每页频道数」(存在第 2 页)时出现——单页时自动隐藏,
          避免恒置灰的死控件;URL 契约(channelPage/pageSize)不受影响,旧链接仍恢复。 */}
      <Drawer.Backdrop
        isOpen={filterOpen}
        onOpenChange={(next) => {
          setFilterOpen(next);
        }}
      >
        <Drawer.Content placement="right">
          <Drawer.Dialog aria-label="显示与筛选" className="w-80">
            <Drawer.CloseTrigger />
            <Drawer.Header>
              <Drawer.Heading className="text-base font-semibold">显示与筛选</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>
              <div className="flex flex-col gap-5">
                {/* T014:视图 Select(view 写/删 URL 参数)。
                    外层说明文字用 <span>:触发器是按钮,label 包裹会二次触发按压。 */}
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted">视图</span>
                  <Select
                    aria-label="视图模式"
                    selectedKey={url.view}
                    onSelectionChange={(key) => {
                      if (key === null) {
                        return;
                      }
                      const next = String(key);
                      updateParams((params) => {
                        if (next === 'list') {
                          params.set('view', 'list');
                        } else {
                          params.delete('view');
                        }
                      });
                    }}
                  >
                    <Select.Trigger data-testid="guide-view-select">
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {VIEWS.map((view) => (
                          <ListBox.Item key={view} id={view} textValue={view === 'wall' ? '节目墙' : '按频道列表'}>
                            {view === 'wall' ? '节目墙' : '按频道列表'}
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted">每页频道数</span>
                  <Select
                    aria-label="每页频道数"
                    selectedKey={String(url.pageSize)}
                    onSelectionChange={(key) => {
                      if (key === null) {
                        return;
                      }
                      const next = String(key);
                      updateParams((params) => {
                        if (next === '20') {
                          params.delete('pageSize');
                        } else {
                          params.set('pageSize', next);
                        }
                        params.delete('channelPage');
                      });
                    }}
                  >
                    <Select.Trigger data-testid="guide-page-size-select">
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {PAGE_SIZES.map((size) => (
                          <ListBox.Item key={size} id={String(size)} textValue={String(size)}>
                            {size}
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>
                {data !== null && data.totalChannels > url.pageSize ? (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted">频道分页</span>
                    <div className="flex items-center gap-1">
                      {/* 翻页后自动关抽屉:墙内容重新可聚焦,FR-044 焦点锚
                          (#guide-window-title)才能落位(抽屉打开期间墙是 inert)。 */}
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={url.channelPage === 1}
                        onPress={() => {
                          changePage(-1);
                          setFilterOpen(false);
                        }}
                        aria-label="上一页"
                      >
                        ‹ 上一页
                      </Button>
                      <span className="hmp-tabular-nums text-xs text-muted">
                        {`频道 ${channelRangeStart}–${channelRangeEnd},共 ${data.totalChannels}`}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        isDisabled={!hasMoreChannels}
                        onPress={() => {
                          changePage(1);
                          setFilterOpen(false);
                        }}
                        aria-label="下一页"
                      >
                        下一页 ›
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

        {/* T022:共享详情面板(与直播首页三区同一组件,FR-013);宿主按 serverNow 裁决
            四状态;动作回调无参,频道身份(mediaId)由宿主闭包持有(§1.4 频道语义) */}
        <ProgrammeDetailPanel
          open={detail !== null}
          channel={{ name: detail?.channelTitle ?? '', logo: null }}
          programme={
            detail === null
              ? null
              : {
                  title: detail.programme?.title ?? '',
                  description: detail.programme?.description ?? null,
                  start: detail.programme?.startsAt ?? '',
                  end: detail.programme?.endsAt ?? '',
                }
          }
          status={deriveProgrammeStatus(detail?.programme ?? null, serverNowMs() ?? (data !== null ? Date.parse(data.now) : null))}
          timezone={timezone}
          source="guide"
          onPlay={() => {
            const target = detail;
            if (target === null) {
              return;
            }
            // 「播放当前频道」= 该频道当前直播(频道语义,FR-017 后半);
            // 先撤详情面板再经 usePlayAction 统一发起(登录模态不与本面板并行,§6.3)
            closeDetail('restore');
            onPlayChannel(target.mediaId, target.channelTitle);
          }}
          onFavorite={() => {
            const target = detail;
            if (target === null) {
              return;
            }
            if (activeProfileId === null) {
              // 游客/未选档:收藏语义 = 登录引导(ui.md §1.5),零 /me 请求;
              // 先撤面板再开统一登录面(returnTo 原地,完成/取消都回节目单)
              closeDetail('restore');
              startLogin(`${location.pathname}${location.search}`);
              return;
            }
            // 已选档:仅收藏频道(PUT favorites),不触发播放(§1.5)。面板暂无
            // 收藏态/行内反馈属性,收藏状态呈现随 T011 收藏行为任务统一补(最小接线)。
            favoriteToggle.mutate(true);
          }}
          onGuide={() => {
            // 「查看节目单」:已在节目单页 → 关闭面板回到节目单,并把键盘锚定位到
            // 窗口标题(复用翻页焦点机制;mode=guide 免去节目块焦点重复恢复)
            closeDetail('guide');
            setNavSeq((value) => value + 1);
          }}
          onClose={() => {
            closeDetail('restore');
          }}
        />

      {selectedDate !== undefined ? <span className="hmp-sr-only">{`当前日期 ${selectedDate}`}</span> : null}
    </div>
  );
}
