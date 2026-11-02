import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { parseDate } from '@internationalized/date';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { Alert, Button, ListBox, Select } from '@heroui/react';
import { RetryableAlert } from '../../shared/ui';
import { useGuideWindow } from './useGuideWindow';
import { GuideDateTabs } from './GuideDateTabs';
import { GuideScrollContainer } from './GuideScrollContainer';
import { GuideWall, type GuideProgrammeRef } from './GuideWall';
import { GuideChannelList } from './GuideChannelList';
import { formatZoneLabel, utcToPx, windowSpanPx } from './guide-time';
import { consumeGuideSessionSnapshot, GUIDE_WALL_SESSION_KEY, saveGuideSessionSnapshot } from './guide-session-state';
import { usePlayAction } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { useAuthAction } from '../../app/action-coordinator';
import { useFavoriteToggleMutation } from '../favorites/use-favorites';
import { ProgrammeDetailPanel, type ProgrammeStatus } from '../shared-programme/ProgrammeDetailPanel';

/**
 * EPG 节目单页(T116/T117/T118/T119/T120;FR-025~027、FR-042~045、A-008、ui.md §6;
 * 012 T022/T023/T025:FR-013/FR-015/FR-016/FR-018):
 * - /live/guide 公共路由(直播页「所有节目单」入口;US6 接入 routes.tsx);
 * - date/from/channelPage/pageSize/view 写 URL 查询参数作为公共浏览状态(012 url-state
 *   §1 冻结契约):详情返回或登录取消后恢复原日期、频道与时间位置(FR-045/FR-018);
 *   date 缺省今天(非法格式/非法日历日静默回落);from/to 缺省 = 服务端「该日完整
 *   24 小时」默认窗口(真实日界;旧链接里的日内子窗口 from/to 仍受支持并原样透传);
 * - 公共取数经统一数据层 useAppQuery(public 域;键取自 queryKeys.public.guide
 *   工厂;staleTime 60s EPG 慢变;signal 透传/缓存/后台刷新由数据层承担;
 *   placeholderData keepPreviousData:切日期/频道页时旧窗口保持可见):
 *   409 回今天的旧窗口响应不回写;失败保留旧窗口续显;
 * - T023(FR-015):首次进入把横向滚动锚定位到当前时刻附近(当前节目与后续排期
 *   同屏),时区说明恒显于页头;同一窗口身份重复渲染(自动刷新)不重定位——
 *   手动浏览过去/未来不被拉回(FR-016);
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

/** 首次定位时把当前时刻锚在视口左侧附近的前置留白(px;FR-015 当前节目+后续同屏) */
const NOW_ANCHOR_MARGIN_PX = 48;

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
 * 节目时段含 serverNow → now;未开始 → upcoming;已结束 → ended;无节目 → none。
 * serverNow 无效时不猜(不用浏览器时钟):按 none 呈现(墙内打开时 data.now 恒在,
 * 实际不可达;共享面板 none 态保留频道身份与播放主操作,§2.5)。
 */
function deriveProgrammeStatus(programme: ExperienceProgrammeDto | null, serverNowIso: string | null): ProgrammeStatus {
  if (programme === null) {
    return 'none';
  }
  const nowMs = serverNowIso === null ? Number.NaN : Date.parse(serverNowIso);
  const startMs = Date.parse(programme.startsAt);
  const endMs = Date.parse(programme.endsAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
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
  }, [updateParams]);

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

  // T023(FR-015):窗口身份(from|to)变化(首次进入/切日/回到现在)才重定位到
  // 当前时刻附近;自动刷新产生同窗口数据,key 不变 → 容器不重定位(FR-016 不拉回)
  const autoPosition = useMemo(() => {
    if (data === null) {
      return undefined;
    }
    const fromMs = Date.parse(data.from);
    const nowMs = Date.parse(data.now);
    if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) {
      return undefined;
    }
    const targetPx = Math.max(0, utcToPx(nowMs, fromMs) - NOW_ANCHOR_MARGIN_PX);
    return {
      key: `${data.from}|${data.to}`,
      left: Math.min(targetPx, windowSpanPx(fromMs, Date.parse(data.to))),
    };
  }, [data]);

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
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-foreground">节目单</h1>
        <p className="text-xs text-muted">
          {data !== null
            ? `时间按家庭时区(${formatZoneLabel(data.timezone, data.now)})显示 · 今天起 7 天`
            : '正在加载家庭时区…'}
        </p>
      </header>

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

      {/* 日期 Tab + 工具栏(收拢换行,768 窄窗可用) */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        <Button size="sm" variant="outline" onPress={goNow}>
          回到现在
        </Button>
        {/* T014:视图/每页频道数原生 select 元素 → HeroUI Select,筛选行为不变
            (view 写/删 URL 参数;pageSize 变更同时清 channelPage)。
            外层由 <label> 改为 <span> 说明文字:触发器是按钮,label 包裹会二次触发按压。 */}
        <div className="flex items-center gap-1 text-xs text-muted">
          <span>视图</span>
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
            <Select.Trigger className="text-xs" data-testid="guide-view-select">
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
        <div className="flex items-center gap-1 text-xs text-muted">
          <span>每页频道数</span>
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
            <Select.Trigger className="text-xs" data-testid="guide-page-size-select">
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
        <span className="hmp-tabular-nums text-xs text-muted">
          {data !== null ? `频道 ${channelRangeStart}–${channelRangeEnd},共 ${data.totalChannels}` : `第 ${url.channelPage} 页`}
        </span>
        <Button size="sm" variant="ghost" isDisabled={url.channelPage === 1} onPress={() => changePage(-1)} aria-label="上一页">
          ‹ 上一页
        </Button>
        <Button size="sm" variant="ghost" isDisabled={!hasMoreChannels} onPress={() => changePage(1)} aria-label="下一页">
          下一页 ›
        </Button>
      </div>

      {/* 墙/列表(同一 GuideWindow 响应) + 详情 */}
      <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          {resource.isLoading ? (
            <div role="status" className="py-10 text-center text-sm text-muted">
              正在加载节目单…
            </div>
          ) : data !== null ? (
            <GuideScrollContainer
              ariaLabel="节目墙"
              describedById="guide-window-title"
              containerRef={scrollRef}
              autoPosition={autoPosition}
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
          status={deriveProgrammeStatus(detail?.programme ?? null, data?.now ?? null)}
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
      </div>

      {selectedDate !== undefined ? <span className="hmp-sr-only">{`当前日期 ${selectedDate}`}</span> : null}
    </div>
  );
}
