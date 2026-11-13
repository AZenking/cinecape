import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { ChannelRowDto, ExperienceProgrammeDto } from '@hmp/shared';
import { Alert, Button } from '@heroui/react';
import { keepPreviousData } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { fetchLiveChannels, fetchLiveGroups, type LiveChannelQuery } from './live-api';
import { usePlayAction } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { useFavoriteState, useFavoriteToggleMutation } from '../favorites/use-favorites';
import { ProgrammeDetailPanel, type ProgrammeStatus } from '../shared-programme/ProgrammeDetailPanel';
import { serverNowMs } from '../../shared/time/server-clock';
import { useLiveRefresh } from './hooks/use-live-refresh';
import { useLiveSection } from './hooks/use-live-sections';
import { NowSection } from './components/NowSection';
import { NextSection } from './components/NextSection';
import { CategorySwimlanes } from './components/CategorySwimlanes';
import { LiveHeroPlayer } from './components/LiveHeroPlayer';
import { GuestActionNotice } from './components/GuestActionNotice';

/**
 * 直播首页(015 T010 装配;FR-001~FR-006、ui-layout.md §1 Screen 1 线框、
 * routing-and-url-state.md §2.1;替代 012 T067/T068/T069/T070/T071 装配):
 * - Screen 1 自上而下固定顺序(LiveHeroPlayer 直接播放大屏 → NowSection 正在直播 →
 *   NextSection 即将播放 → CategorySwimlanes 各分类逐行平铺泳道;后三区为横向
 *   滚动瓦片行,溢出限于行内,整页无横向溢出);
 * - 015 智能分流:正在直播行尾入口经 navigate('/live/guide') 直达 EPG 节目单
 *   时间墙(FR-003,禁止导向无排期静态列表),各分类行尾入口 navigate
 *   (`/live/channels?group=${key}`) 直达分类平铺网格并携带 Tab 高亮参数(FR-004,
 *   该路由由 Wave 3 注册,注册前跳转暂 404 属预期中间态)——012 聚焦视图
 *   (?section= 分页)被新规格取代,本页不再承载聚焦视图;
 * - q 写入 URL 查询参数作为公共浏览状态(FR-045 语义延续;搜索筛选首页泳道,
 *   routing-and-url-state.md §2.1);详情返回或登录取消后经 URL 恢复;
 * - 公共请求一律 publicFetch(credentials:'omit');每区独立资源,失败仅重试本区;
 * - 30 秒周期刷新 + 回前台立即刷新(useLiveRefresh);刷新失败保留旧数据并提示可重试;
 * - 播放统一经 US3 受控入口(usePlayAction;无节目频道仍可发起;Hero 主操作同样
 *   只发起 play(),游客拦截归 ActionCoordinator);
 * - 详情面板:同一共享面板承载 now/upcoming/ended/none 四状态(FR-013、ui.md §2;
 *   status 由宿主闭包 panelStatusOf 裁决);
 * - 收藏:游客/未选档仅登录引导零请求(GuestActionNotice);已选档走既有 favorites
 *   变更(乐观写+对账;卡片收藏的行内反馈收口归 012 T011)。
 */

const PREVIEW_PAGE_SIZE = 20;
/** 概览分组集合请求条数(分区展示为前端切片,完整列表经行尾入口去分类网格/EPG) */
const OVERVIEW_GROUP_FETCH_SIZE = 50;

interface SlotDialogState {
  readonly mediaId: string;
  readonly channelTitle: string;
  readonly groupLabel: string;
  /** 节目数据;无节目单频道(current/next 双 null)为 null → 面板 none 态(FR-012) */
  readonly programme: ExperienceProgrammeDto | null;
  readonly kind: 'current' | 'upcoming';
}

/**
 * 详情面板状态映射(012 T016/T018;FR-013、ui.md §2.3/§2.5):宿主闭包裁决,
 * 共享面板不做时间推导(T005 契约——四状态由宿主传入):
 * - programme=null(无节目单频道,current/next 双 null)→ 'none':面板保留频道身份
 *   +「暂无节目单」,主操作仍可播放当前直播(ui.md §2.5);
 * - kind='upcoming'(未来节目)→ 'upcoming'(无播放主操作,ui.md §1.6);
 * - kind='current' 且服务端快照 now 落在节目时段内 → 'now';
 * - 其余(current 但时段不含 now,含 serverNow 缺失/无效——不臆造本地时钟)→ 'ended'。
 */
export function panelStatusOf(
  kind: SlotDialogState['kind'],
  programme: ExperienceProgrammeDto | null,
  serverNowIso: string | null,
): ProgrammeStatus {
  if (programme === null) {
    return 'none';
  }
  if (kind === 'upcoming') {
    return 'upcoming';
  }
  if (serverNowIso !== null) {
    const nowMs = Date.parse(serverNowIso);
    if (
      Number.isFinite(nowMs) &&
      Date.parse(programme.startsAt) <= nowMs &&
      nowMs <= Date.parse(programme.endsAt)
    ) {
      return 'now';
    }
  }
  return 'ended';
}

export function LivePage(): ReactNode {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refreshKey } = useLiveRefresh();
  const [slotDialog, setSlotDialog] = useState<SlotDialogState | null>(null);
  const [guestNotice, setGuestNotice] = useState<string | null>(null);
  const { play } = usePlayAction();

  // 收藏(012 T016 最小接线):profile 域 favorites 变更键内嵌当前档案 id(FR-021);
  // 游客/未选档为 null(无乐观写与 /me 目标,onFavorite 走登录引导,零请求)。
  const session = useSession();
  const activeProfileId =
    session.status === 'authenticated' ? (session.session?.activeProfile?.id ?? null) : null;
  const favoriteToggle = useFavoriteToggleMutation(activeProfileId, {
    id: slotDialog?.mediaId ?? '',
    title: slotDialog?.channelTitle ?? '',
    unavailable: false,
  });
  /** 详情面板收藏态(打开且已选档时才取数;切换后按同一 query key 对账) */
  const detailFavorited = useFavoriteState(
    activeProfileId,
    slotDialog?.mediaId ?? null,
    slotDialog !== null,
  );

  const qParam = searchParams.get('q') ?? '';

  /* ---------------- 资源:概览全部区(独立取数,失败仅重试本区) ----------------
   * T023 迁移:取数状态机已收口到 shared/query(useAppQuery;signal 透传、
   * 缓存与后台刷新由数据层承担),键一律取自 queryKeys.public 工厂——
   * live 分组/频道为工厂 live() 前缀的派生键(工厂暂无分组/频道子资源条目,
   * 扩工厂属 query-keys 契约变更,归数据层任务):首段仍为 'public' 身份域,
   * 参数对象置于末位、可序列化,同参同键、异参异键。频道列表在 q 变键时以
   * keepPreviousData 保留上一份内容(旧「代次」行为:换键不吞旧数据)。 */

  const groupsResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveGroups(),
      queryFn: ({ signal }) => fetchLiveGroups(signal),
    },
    refreshKey,
    true,
  );

  const nowQuery: LiveChannelQuery = {
    section: 'now',
    page: 1,
    pageSize: PREVIEW_PAGE_SIZE,
    q: qParam || undefined,
  };
  const nowResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveChannels(nowQuery),
      queryFn: ({ signal }) => fetchLiveChannels(nowQuery, signal),
      placeholderData: keepPreviousData,
    },
    refreshKey,
    true,
  );

  const nextQuery: LiveChannelQuery = {
    section: 'next',
    page: 1,
    pageSize: PREVIEW_PAGE_SIZE,
    q: qParam || undefined,
  };
  const nextResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveChannels(nextQuery),
      queryFn: ({ signal }) => fetchLiveChannels(nextQuery, signal),
      placeholderData: keepPreviousData,
    },
    refreshKey,
    true,
  );

  const overviewAllQuery: LiveChannelQuery = {
    section: 'all',
    page: 1,
    pageSize: OVERVIEW_GROUP_FETCH_SIZE,
    q: qParam || undefined,
  };
  const groupsChannelsResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveChannels(overviewAllQuery),
      queryFn: ({ signal }) => fetchLiveChannels(overviewAllQuery, signal),
      placeholderData: keepPreviousData,
    },
    refreshKey,
    true,
  );

  /* ---------------- 游客播放入口占位(US3 统一入口接管前的占位) ---------------- */

  const requireAuth = useCallback((actionLabel: string): void => {
    // 游客:进入登录选档意图(US2/US3);US5 阶段仅显示提示与登录入口,不触发播放
    setGuestNotice(actionLabel);
  }, []);

  const playChannel = useCallback(
    (mediaId: string, channelTitle: string): void => {
      // 节目详情弹层的播放:指向该频道当前直播,经 US3 统一受控入口
      play({ mediaId, title: channelTitle });
    },
    [play],
  );

  const timezone = groupsResource.data?.timezone ?? nowResource.data?.timezone ?? 'UTC';
  // 016 基准时间条款:serverNow 优先取服务端基准钟(响应携带 now 即校准,本地平滑
  // 推进;设备时钟漂移不影响状态裁决/时间标签);未校准回落响应快照,不臆造本地钟
  const calibratedNowMs = serverNowMs();
  const serverNowIso =
    calibratedNowMs !== null
      ? new Date(calibratedNowMs).toISOString()
      : (groupsResource.data?.now ?? nowResource.data?.now ?? null);
  /** 直接播放大屏对象:now 区服务端稳定排序首频道(数据未就绪为 null,大屏隐藏降级) */
  const firstNowRow: ChannelRowDto | null = nowResource.data?.items[0] ?? null;

  const retryGroups = useCallback((): void => {
    groupsResource.retry();
    groupsChannelsResource.retry();
  }, [groupsResource, groupsChannelsResource]);

  /** 015 智能分流(R3;routing-and-url-state.md §2.2/§2.3):行尾入口统一 navigate */
  const openLiveGuide = useCallback((): void => {
    void navigate('/live/guide');
  }, [navigate]);
  const openCategoryGrid = useCallback(
    (groupKey: string): void => {
      void navigate(`/live/channels?group=${encodeURIComponent(groupKey)}`);
    },
    [navigate],
  );

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {/* 页面标题保留 h1 语义(读屏/文档大纲/测试锚),按产品要求不呈现可见标题与
          时区说明行;频道搜索框已移除——`?q=` 仍作为深链过滤参数被读取(下方 query
          对象继续透传),恢复搜索 UI 时接回 updateParams 即可。 */}
      <h1 className="sr-only">直播</h1>

      {guestNotice !== null ? (
        <div role="status">
          <GuestActionNotice actionLabel={guestNotice} onClose={() => setGuestNotice(null)} />
        </div>
      ) : null}

      {groupsResource.status === 'error' && groupsResource.data === null ? (
        <Alert status="danger" role="alert">
          <Alert.Title>直播分组加载失败</Alert.Title>
          <Alert.Description>服务暂时不可用,可以重试;不影响其他分区。</Alert.Description>
          <Alert.Content>
            <Button size="sm" variant="outline" onPress={retryGroups}>
              重试
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {/* Screen 1 装配顺序(015 T010;ui-layout.md §1.1 线框):
          直接播放大屏 → 正在直播 → 即将播放 → 各分类逐行平铺泳道 */}
      {/* 直接播放大屏(015 T008;FR-002):now 区服务端稳定排序首频道,
          数据未就绪时隐藏降级(不白屏),主操作只经 usePlayAction 发起 */}
      {firstNowRow !== null && nowResource.data !== null ? (
        <LiveHeroPlayer
          row={firstNowRow}
          timezone={nowResource.data.timezone}
          nowIso={nowResource.data.now}
          onOpenProgramme={setSlotDialog}
        />
      ) : null}
      <NowSection
        resource={nowResource}
        onRetry={nowResource.retry}
        /* 015 FR-003(R3):行尾入口直达 EPG 节目单时间墙(取代 012 聚焦视图分流;
           行尾文案由 015 T012 归属任务演进) */
        onViewMore={openLiveGuide}
        onOpenProgramme={setSlotDialog}
        onRequireAuth={requireAuth}
      />
      <NextSection
        resource={nextResource}
        onRetry={nextResource.retry}
        /* 聚焦视图移除后,即将播放行尾入口同样导向 EPG 时间墙(未来排期事实源) */
        onViewMore={openLiveGuide}
        onOpenProgramme={setSlotDialog}
        onRequireAuth={requireAuth}
      />
      <CategorySwimlanes
        groupsResource={groupsResource}
        channelsResource={groupsChannelsResource}
        onRetry={retryGroups}
        /* 015 FR-004(R3):行尾「全部XX频道」直达分类平铺网格(携带 Tab 高亮参数) */
        onViewAll={openCategoryGrid}
        onOpenProgramme={setSlotDialog}
        onRequireAuth={requireAuth}
      />

      {/* 节目详情面板(012 T016;FR-013、ui.md §2):各区共用同一共享面板宿主
          (shared-programme/ProgrammeDetailPanel,T005 落点)。
          status 由宿主闭包 panelStatusOf 按 kind+programme+serverNowIso 裁决;
          动作回调均无参:频道身份(mediaId)由本闭包持有(ui.md §1.4 频道语义)。 */}
      <ProgrammeDetailPanel
        open={slotDialog !== null}
        onClose={() => {
          setSlotDialog(null);
        }}
        channel={{ name: slotDialog?.channelTitle ?? '', logo: null }}
        favorited={detailFavorited}
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
          // 游客/未选档:零请求,仅登录引导(FR-009;与卡片收藏同语义,行内反馈收口归 T011)
          if (activeProfileId === null) {
            requireAuth(`收藏 ${slotDialog.channelTitle}`);
            return;
          }
          // 已选档:既有 favorites 变更(乐观写 + onSettled 服务端对账;失败回滚与
          // 提示由数据层收口;已收藏态回显与行内成功反馈归 T011,本期最小接线)
          if (favoriteToggle.isPending) {
            return;
          }
          void favoriteToggle
            .mutateAsync(!detailFavorited)
            .catch(() => undefined);
        }}
      />
    </div>
  );
}
