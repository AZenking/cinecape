import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { ExperienceProgrammeDto } from '@hmp/shared';
import { Alert, Button } from '@heroui/react';
import { useGuideWindow } from './useGuideWindow';
import { GuideDateTabs } from './GuideDateTabs';
import { GuideScrollContainer } from './GuideScrollContainer';
import { GuideWall, type GuideProgrammeRef } from './GuideWall';
import { GuideChannelList } from './GuideChannelList';
import { ProgrammeDetailPanel, type GuideDetailTarget } from './ProgrammeDetailPanel';
import { formatZoneLabel, guideDayBoundsMs } from './guide-time';
import { usePlayAction } from '../playback/use-play-action';

/**
 * EPG 节目单页(T116/T117/T118/T119/T120;FR-025~027、FR-042~045、A-008、ui.md §6):
 * - /live/guide 公共路由(直播页「所有节目单」入口;US6 接入 routes.tsx);
 * - date/from/channelPage/pageSize/view 写 URL 查询参数作为公共浏览状态:
 *   详情返回或登录取消后恢复原日期、频道与时间位置(FR-045);date 缺省今天;
 *   from/to 缺省 = 服务端「现在前 30 分钟起 6 小时」默认窗口(裁剪日界);
 * - 公共请求 credentials omit(useGuideWindow/publicFetch);AbortController 取消
 *   过期请求(409 回今天的旧窗口响应不回写);
 * - 「回到现在」清空 date/from/to/channelPage 回今天及当前窗口;
 * - 409 GUIDE_DATE_EXPIRED:回今天(按 problem.allowedDates 首日)并提示「日期已更新」,
 *   丢弃旧窗口响应;422 GUIDE_WINDOW_TOO_LARGE:提示缩短窗口、保留频道页;
 * - 时间轴浏览:前/后一窗口(≤6h)按当前窗口平移并夹取到该日真实日界
 *   (guideDayBoundsMs,与服务端同源 @internationalized/date,不加 24h);
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

/** URL 查询参数 → 视图状态(非法值回落缺省;不因伪造参数崩溃) */
function readUrlState(params: URLSearchParams): GuideUrlState {
  const rawDate = params.get('date');
  const date = rawDate !== null && DATE_PATTERN.test(rawDate) ? rawDate : undefined;
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

export function GuidePage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const url = useMemo(() => readUrlState(searchParams), [searchParams]);
  const { play } = usePlayAction();
  const [detail, setDetail] = useState<GuideDetailTarget | null>(null);
  const [navSeq, setNavSeq] = useState(0);
  const /** 409 自动回今天只执行一次的守卫 */
    expiredHandledRef = useRef<string | null>(null);

  const resource = useGuideWindow(
    {
      date: url.date,
      fromMs: url.fromMs,
      toMs: url.toMs,
      page: url.channelPage,
      pageSize: url.pageSize,
    },
    0,
  );

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

  /** 前/后一窗口:按当前窗口跨度平移,夹取该日真实日界(23/25 小时日按真实日长) */
  const shiftWindow = useCallback(
    (direction: 1 | -1): void => {
      const fromMs = url.fromMs ?? (data !== null ? Date.parse(data.from) : Number.NaN);
      const toMs = url.toMs ?? (data !== null ? Date.parse(data.to) : Number.NaN);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
        return;
      }
      const date = url.date ?? data?.date;
      if (date === undefined) {
        return;
      }
      const bounds = guideDayBoundsMs(date, timezone);
      const span = toMs - fromMs;
      let nextFrom = fromMs + direction * span;
      let nextTo = toMs + direction * span;
      if (nextFrom < bounds.fromMs) {
        nextFrom = bounds.fromMs;
        nextTo = Math.min(nextFrom + span, bounds.toMs);
      }
      if (nextTo > bounds.toMs) {
        nextTo = bounds.toMs;
        nextFrom = Math.max(nextTo - span, bounds.fromMs);
      }
      if (nextTo <= nextFrom) {
        return;
      }
      updateParams((params) => {
        params.set('from', new Date(nextFrom).toISOString());
        params.set('to', new Date(nextTo).toISOString());
      });
    },
    [url.fromMs, url.toMs, url.date, data, timezone, updateParams],
  );

  const goNow = useCallback((): void => {
    setDetail(null);
    setExpiredNotice(false);
    updateParams((params) => {
      params.delete('date');
      params.delete('from');
      params.delete('to');
      params.delete('channelPage');
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

  const onOpenProgramme = useCallback((ref: GuideProgrammeRef): void => {
    // 详情选择写入组件状态(滚动锚点/URL 浏览位置保持不动,返回即恢复原位置)
    setDetail({ mediaId: ref.mediaId, channelTitle: ref.channelTitle, programme: ref.programme as ExperienceProgrammeDto });
  }, []);

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

      {/* 422:窗口过长提示(保留频道页) */}
      {resource.windowTooLarge ? (
        <div role="alert">
          <Alert status="warning" className="w-full">
            <Alert.Title>窗口内节目过多</Alert.Title>
            <Alert.Description>请缩短时间范围后重试(单次最多 6 小时);当前频道页已保留。</Alert.Description>
          </Alert>
        </div>
      ) : null}

      {/* 加载失败(非 409/422):可重试,不提示重新登录(FR-004) */}
      {resource.status === 'error' && !resource.dateExpired && !resource.windowTooLarge ? (
        <div role="alert">
          <Alert status="danger" className="w-full">
            <Alert.Content className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Alert.Title>节目单加载失败</Alert.Title>
                <Alert.Description>服务暂时不可用,可以重试。</Alert.Description>
              </div>
              <Button size="sm" variant="outline" onPress={resource.retry}>
                重试
              </Button>
            </Alert.Content>
          </Alert>
        </div>
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
        <Button size="sm" variant="ghost" onPress={() => shiftWindow(-1)} aria-label="前一窗口">
          ‹ 前一窗口
        </Button>
        <Button size="sm" variant="ghost" onPress={() => shiftWindow(1)} aria-label="后一窗口">
          后一窗口 ›
        </Button>
        <label className="flex items-center gap-1 text-xs text-muted">
          视图
          <select
            aria-label="视图模式"
            value={url.view}
            onChange={(event) => {
              updateParams((params) => {
                if (event.target.value === 'list') {
                  params.set('view', 'list');
                } else {
                  params.delete('view');
                }
              });
            }}
            className="rounded border border-border bg-surface px-1 py-0.5 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {VIEWS.map((view) => (
              <option key={view} value={view}>
                {view === 'wall' ? '节目墙' : '按频道列表'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-muted">
          每页频道数
          <select
            aria-label="每页频道数"
            value={String(url.pageSize)}
            onChange={(event) => {
              updateParams((params) => {
                if (event.target.value === '20') {
                  params.delete('pageSize');
                } else {
                  params.set('pageSize', event.target.value);
                }
                params.delete('channelPage');
              });
            }}
            className="rounded border border-border bg-surface px-1 py-0.5 text-xs text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={String(size)}>
                {size}
              </option>
            ))}
          </select>
        </label>
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
            <GuideScrollContainer ariaLabel="节目墙" describedById="guide-window-title">
              {url.view === 'wall' ? (
                <GuideWall
                  data={data}
                  focusSignal={navSeq}
                  selectedKey={detail?.programme.key ?? null}
                  onSelectProgramme={onOpenProgramme}
                  onPlayChannel={onPlayChannel}
                />
              ) : (
                <GuideChannelList
                  data={data}
                  selectedKey={detail?.programme.key ?? null}
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
        <ProgrammeDetailPanel
          target={detail}
          timezone={timezone}
          serverNowIso={data?.now ?? null}
          onClose={() => {
            setDetail(null);
          }}
          onPlayChannel={onPlayChannel}
        />
      </div>

      {selectedDate !== undefined ? <span className="hmp-sr-only">{`当前日期 ${selectedDate}`}</span> : null}
    </div>
  );
}
