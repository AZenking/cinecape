import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import {
  Label,
  SearchField,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
} from '@heroui/react';
import { LayoutGrid, List } from 'lucide-react';
import { keepPreviousData } from '../../../shared/query/hooks';
import { queryKeys } from '../../../shared/query/keys';
import { fetchLiveChannels, fetchLiveGroups, type LiveChannelQuery } from '../live-api';
import { PlayButton, usePlayAction } from '../../playback/use-play-action';
import { useSession } from '../../../app/session-provider';
import { useFavoriteToggleMutation } from '../../favorites/use-favorites';
import { ProgrammeDetailPanel } from '../../shared-programme/ProgrammeDetailPanel';
import { panelStatusOf } from '../LivePage';
import { useLiveRefresh } from '../hooks/use-live-refresh';
import { useLiveSection } from '../hooks/use-live-sections';
import { SectionFrame } from '../components/SectionFrame';
import { ChannelTile, type ProgrammeOpenDetail } from '../components/ChannelTile';
import { GuestActionNotice } from '../components/GuestActionNotice';
import { serverNowMs } from '../../../shared/time/server-clock';

/**
 * 分类平铺网格页(015 T019;Screen 2、FR-004 分类深入检索,ui-layout.md §2 线框、
 * routing-and-url-state.md §2.2 URL 参数契约、api-reuse.md §1/§2.3):
 * - 顶部「Live 频道库」+ 横向分类 Tabs:首 Tab 固定「全部」(前端伪分组 key='all',
 *   服务端不提供「全部」组) + fetchLiveGroups 的 {key,label} 清单;URL ?group= 缺省/非法
 *   回退 'all'(分组清单就绪后裁决;就绪前按 URL 原值取数——Screen 1 行尾入口只携带合法键);
 * - 搜索框(HeroUI SearchField)300ms 客户端防抖(api-reuse §2.3)后写 URL ?q= 并触发查询,
 *   SearchField 内置清除按钮提供一键清空(US3 验收 3);
 * - ?view 轻量视图切换('grid' 缺省多列网格 | 'list' 紧凑列表;lucide LayoutGrid/List 图标
 *   ToggleButtonGroup,契约允许,routing §2.2 view 参数):缺省态不带参数(地址整洁,
 *   settings-iptv-page ?tab= 同款约定);
 * - 数据:'all' → fetchLiveChannels({section:'all',page:1,pageSize:50,q});具体分类 →
 *   {section:'group',groupKey,page:1,pageSize:50,q};useLiveSection + queryKeys 工厂键 +
 *   keepPreviousData(与 LivePage 同款;Tab 切换不吞旧数据);30 秒周期刷新 + 回前台
 *   立即刷新(useLiveRefresh);公共请求一律 publicFetch(credentials:'omit');
 * - 主体:响应式多列网格(ui-layout §2.2:768~1023 两列、1024~1439 三列、≥1440 四~五列),
 *   Tailwind 断点映射:md=768(2 列)→ lg=1024(3 列)→ min-[1440px](4 列)→
 *   2xl=1536(5 列);<768 移动端线框未定义,取单列;卡片复用 ChannelTile
 *   (slot='current',nowIso 取响应快照;双层交互:中央 ▶ 直接起播,文字区导
 *   /live/watch/:channelId);
 * - 面板与提示:宿主 ProgrammeDetailPanel(复用 LivePage 导出的 panelStatusOf 与面板
 *   接线模式,不复制再造状态推导)+ GuestActionNotice 宿主(游客收藏登录引导);
 * - 空组/加载/失败:SectionFrame 四态骨架(grid variant,失败仅重试本区)。
 */

/** 「全部」分类 Tab 的前端伪分组键(服务端 GroupPageDto 不提供「全部」组) */
const ALL_GROUP_KEY = 'all';

/** 搜索输入 → URL ?q= 的客户端防抖(api-reuse.md §2.3 明文 300ms) */
export const SEARCH_DEBOUNCE_MS = 300;

/** 分类网格页取数条数(单页平铺;服务端分页,本页固定第 1 页) */
const GRID_PAGE_SIZE = 50;

/** 频道网格视图('grid' 缺省多列网格;'list' 紧凑列表) */
type GridView = 'grid' | 'list';

export function ChannelGridPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const { refreshKey } = useLiveRefresh();
  const [slotDialog, setSlotDialog] = useState<ProgrammeOpenDetail | null>(null);
  const [guestNotice, setGuestNotice] = useState<string | null>(null);
  const { play } = usePlayAction();

  // 收藏(与 LivePage 同款最小接线):profile 域 favorites 变更键内嵌当前档案 id;
  // 游客/未选档为 null(无乐观写与 /me 目标,onFavorite 走登录引导,零请求)。
  const session = useSession();
  const activeProfileId =
    session.status === 'authenticated' ? (session.session?.activeProfile?.id ?? null) : null;
  const favoriteToggle = useFavoriteToggleMutation(activeProfileId, {
    id: slotDialog?.mediaId ?? '',
    title: slotDialog?.channelTitle ?? '',
    unavailable: false,
  });

  /* ---------------- URL 状态:?group / ?q / ?view(routing §2.2) ---------------- */

  const qParam = searchParams.get('q') ?? '';
  const groupParam = searchParams.get('group');
  const viewParam = searchParams.get('view');
  /** 视图:'grid' 缺省(缺省态不带参数);非法值一律回退 grid */
  const activeView: GridView = viewParam === 'list' ? 'list' : 'grid';

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void): void => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  const setQuery = useCallback(
    (q: string): void => {
      updateParams((params) => {
        if (q === '') {
          params.delete('q');
        } else {
          params.set('q', q);
        }
      });
    },
    [updateParams],
  );

  const selectGroup = useCallback(
    (groupKey: string): void => {
      updateParams((params) => {
        // 缺省「全部」不带参数(地址整洁);具体分类写 ?group= 供刷新/分享深链(FR-004)
        if (groupKey === ALL_GROUP_KEY) {
          params.delete('group');
        } else {
          params.set('group', groupKey);
        }
      });
    },
    [updateParams],
  );

  const selectView = useCallback(
    (view: GridView): void => {
      updateParams((params) => {
        if (view === 'grid') {
          params.delete('view');
        } else {
          params.set('view', view);
        }
      });
    },
    [updateParams],
  );

  /* ---------------- 搜索草稿:受控输入 + 300ms 防抖写 URL ---------------- */

  const [searchDraft, setSearchDraft] = useState(qParam);
  // URL q 外部变化(返回/前进/清除)时草稿跟随,避免输入框与 URL 脱节
  useEffect(() => {
    setSearchDraft(qParam);
  }, [qParam]);
  // 防抖:草稿与 URL 不一致期间,停笔 300ms 后写入 URL(每键重置计时,只在最终值发起查询)
  useEffect(() => {
    if (searchDraft === qParam) {
      return;
    }
    const timer = window.setTimeout(() => {
      setQuery(searchDraft);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [searchDraft, qParam, setQuery]);

  /* ---------------- 资源:分组清单 + 当前分类频道(useLiveSection,与 LivePage 同款) ---------------- */

  const groupsResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveGroups(),
      queryFn: ({ signal }) => fetchLiveGroups(signal),
    },
    refreshKey,
    true,
  );

  /** 激活分类键:缺省/空值/'all' → 伪分组 all;分组清单就绪后仍不匹配 → 回退 all(§2.2);
   *  清单未就绪时按 URL 原值取数(Screen 1 行尾入口只携带合法键,避免深链闪切) */
  const activeGroup = useMemo((): string => {
    if (groupParam === null || groupParam === '' || groupParam === ALL_GROUP_KEY) {
      return ALL_GROUP_KEY;
    }
    const items = groupsResource.data?.items;
    if (items === undefined) {
      return groupParam;
    }
    return items.some((group) => group.key === groupParam) ? groupParam : ALL_GROUP_KEY;
  }, [groupParam, groupsResource.data]);

  const channelsQuery: LiveChannelQuery =
    activeGroup === ALL_GROUP_KEY
      ? { section: 'all', page: 1, pageSize: GRID_PAGE_SIZE, q: qParam || undefined }
      : { section: 'group', groupKey: activeGroup, page: 1, pageSize: GRID_PAGE_SIZE, q: qParam || undefined };
  const channelsResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveChannels(channelsQuery),
      queryFn: ({ signal }) => fetchLiveChannels(channelsQuery, signal),
      placeholderData: keepPreviousData,
    },
    refreshKey,
    true,
  );

  // 016 基准时间条款:serverNow 优先取服务端基准钟(响应携带 now 即校准;未校准
  // 回落响应快照,不臆造本地钟)
  const calibratedNowMs = serverNowMs();
  const serverNowIso =
    calibratedNowMs !== null
      ? new Date(calibratedNowMs).toISOString()
      : (channelsResource.data?.now ?? groupsResource.data?.now ?? null);
  const timezone = channelsResource.data?.timezone ?? groupsResource.data?.timezone ?? 'UTC';
  const items = channelsResource.data?.items ?? [];
  const activeGroupLabel =
    activeGroup === ALL_GROUP_KEY
      ? '全部频道'
      : (groupsResource.data?.items.find((group) => group.key === activeGroup)?.label ?? activeGroup);

  /* ---------------- 动作回调 ---------------- */

  const requireAuth = useCallback((actionLabel: string): void => {
    // 游客/未选档私有动作(收藏):登录引导提示,零请求(播放不经此,走共享 usePlayAction)
    setGuestNotice(actionLabel);
  }, []);

  const playChannel = useCallback(
    (mediaId: string, channelTitle: string): void => {
      // 面板播放主操作:指向该频道当前直播,经 US3 统一受控入口(游客拦截归协调器)
      play({ mediaId, title: channelTitle });
    },
    [play],
  );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-foreground">Live 频道库</h1>
        <p className="text-xs text-muted">
          {channelsResource.data !== null
            ? `${String(channelsResource.data.total)} 个频道 · 时间按家庭时区显示`
            : '正在加载频道库…'}
        </p>
      </header>

      {/* 工具条(§2.1 线框):左侧横向分类 Tabs;右侧搜索 + 网格/列表视图切换 */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <Tabs
          selectedKey={activeGroup}
          onSelectionChange={(key) => {
            selectGroup(String(key));
          }}
          className="min-w-0 flex-1"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="频道分类">
              <Tabs.Tab id={ALL_GROUP_KEY}>
                全部
                <Tabs.Indicator />
              </Tabs.Tab>
              {groupsResource.data?.items.map((group) => (
                <Tabs.Tab id={group.key} key={group.key}>
                  {group.label}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <div className="flex shrink-0 items-center gap-3">
          <SearchField
            className="min-w-0"
            value={searchDraft}
            onChange={(value) => {
              setSearchDraft(value);
            }}
            aria-label="搜索频道"
          >
            <Label>搜索频道</Label>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="按频道名称搜索" />
              {/* 一键清空(US3 验收 3):内置清除按钮,中文化可读名 */}
              <SearchField.ClearButton aria-label="清空搜索" />
            </SearchField.Group>
          </SearchField>
          <ToggleButtonGroup
            selectionMode="single"
            disallowEmptySelection
            aria-label="视图切换"
            selectedKeys={new Set([activeView])}
            onSelectionChange={(keys) => {
              const key = [...keys][0];
              if (key === 'list' || key === 'grid') {
                selectView(key);
              }
            }}
          >
            <ToggleButton id="grid" isIconOnly size="sm" aria-label="网格视图">
              <LayoutGrid aria-hidden="true" className="size-4" />
            </ToggleButton>
            <ToggleButton id="list" isIconOnly size="sm" aria-label="列表视图">
              <List aria-hidden="true" className="size-4" />
            </ToggleButton>
          </ToggleButtonGroup>
        </div>
      </div>

      {guestNotice !== null ? (
        <div role="status">
          <GuestActionNotice actionLabel={guestNotice} onClose={() => setGuestNotice(null)} />
        </div>
      ) : null}

      {/* 主体(§2.1 线框多列平铺;SectionFrame 四态骨架,失败仅重试本区) */}
      <SectionFrame
        title={activeGroup === ALL_GROUP_KEY ? '全部频道' : `${activeGroupLabel} · 频道`}
        subtitle={
          channelsResource.data !== null
            ? `时间按家庭时区 ${timezone} 显示`
            : undefined
        }
        status={channelsResource.status}
        hasStaleContent={channelsResource.data !== null}
        isEmpty={channelsResource.data !== null && items.length === 0}
        emptyText={qParam !== '' ? '没有匹配的频道,换个关键词试试' : '该分类暂无频道'}
        skeletonVariant="grid"
        skeletonCount={8}
        onRetry={channelsResource.retry}
      >
        {items.length > 0 && activeView === 'grid' ? (
          /* 响应式多列网格(ui-layout §2.2 断点映射,见文件头注释):
              md(768~1023)两列 → lg(1024~1439)三列 → min-[1440px] 四列 → 2xl(≥1536)五列 */
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 min-[1440px]:grid-cols-4 2xl:grid-cols-5">
            {items.map((row) => (
              <ChannelTile
                key={row.media.id}
                row={row}
                slot="current"
                nowIso={channelsResource.data?.now ?? null}
                onOpenProgramme={setSlotDialog}
                onRequireAuth={requireAuth}
              />
            ))}
          </div>
        ) : null}
        {items.length > 0 && activeView === 'list' ? (
          /* 紧凑列表视图(view=list;routing §2.2 轻量切换,实现保持最小):
              行 = 频道名 + 分组/当前节目,行尾共享 PlayButton(唯一播放管线) */
          <ul className="flex min-w-0 flex-col divide-y divide-border">
            {items.map((row) => (
              <li key={row.media.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{row.media.title}</p>
                  <p className="truncate text-xs text-muted">
                    {row.groupLabel}
                    {row.current !== null ? ` · 正在播 ${row.current.title}` : ''}
                  </p>
                </div>
                <PlayButton
                  mediaId={row.media.id}
                  title={row.media.title}
                  size="sm"
                  variant="outline"
                  label="播放"
                  ariaLabel={`播放 ${row.media.title} 当前直播`}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </SectionFrame>

      {/* 节目详情面板(与 LivePage 同一共享面板宿主;status 由宿主闭包 panelStatusOf
          裁决,复用 LivePage 导出的推导,勿再造;动作回调均无参) */}
      <ProgrammeDetailPanel
        open={slotDialog !== null}
        onClose={() => {
          setSlotDialog(null);
        }}
        channel={{ name: slotDialog?.channelTitle ?? '', logo: null }}
        programme={
          slotDialog?.programme == null
            ? null
            : {
                title: slotDialog.programme.title,
                description: slotDialog.programme.description,
                start: slotDialog.programme.startsAt,
                end: slotDialog.programme.endsAt,
              }
        }
        status={panelStatusOf(
          slotDialog?.kind ?? 'current',
          slotDialog?.programme ?? null,
          serverNowIso,
        )}
        timezone={timezone}
        onPlay={() => {
          if (slotDialog !== null) {
            playChannel(slotDialog.mediaId, slotDialog.channelTitle);
          }
        }}
        onFavorite={() => {
          if (slotDialog === null) {
            return;
          }
          // 游客/未选档:零请求,仅登录引导(与 LivePage 面板收藏同语义)
          if (activeProfileId === null) {
            requireAuth(`收藏 ${slotDialog.channelTitle}`);
            return;
          }
          // 已选档:既有 favorites 变更(乐观写 + onSettled 服务端对账,数据层收口)
          void favoriteToggle.mutateAsync(true).catch(() => undefined);
        }}
      />
    </div>
  );
}
