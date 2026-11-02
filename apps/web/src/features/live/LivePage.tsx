import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { ChannelRowDto, ExperienceProgrammeDto } from '@hmp/shared';
import { Alert, Button, Input, Label, TextField } from '@heroui/react';
import { keepPreviousData } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { fetchLiveChannels, fetchLiveGroups, type LiveChannelQuery, type LiveSection } from './live-api';
import { usePlayAction } from '../playback/use-play-action';
import { useSession } from '../../app/session-provider';
import { useFavoriteToggleMutation } from '../favorites/use-favorites';
import { ProgrammeDetailPanel, type ProgrammeStatus } from '../shared-programme/ProgrammeDetailPanel';
import { useLiveRefresh } from './hooks/use-live-refresh';
import { useLiveSection } from './hooks/use-live-sections';
import { NowSection } from './components/NowSection';
import { NextSection } from './components/NextSection';
import { GroupSections } from './components/GroupSections';
import { FocusedSection, sectionTitleOf } from './components/FocusedSection';
import { NowHero } from './components/NowHero';
import { GuestActionNotice } from './components/GuestActionNotice';

/**
 * 直播首页(T067/T068/T069/T070/T071;FR-021/022/023/024/045、ui.md §5/§8;
 * 012 T016:三区详情面板统一挂载共享 shared-programme/ProgrammeDetailPanel):
 * - Netflix 式布局演进:固定分区顺序不变 —— 所有节目单入口 → 此刻直播精选横幅(非分区,
 *   仅取 now 区服务端稳定排序首频道)→ 正在直播 → 即将播放 → 各分组正在直播;
 *   后三区为横向滚动瓦片行(溢出限于行内,整页无横向溢出,ui.md §8);
 * - section/group/q/page 写入 URL 查询参数作为公共浏览状态:概览(无参数)与聚焦视图
 *   (section 必配)互转;详情返回或登录取消后经 URL 恢复原浏览状态(FR-045);
 * - 公共请求一律 publicFetch(credentials:'omit');每区独立资源,失败仅重试本区;
 * - 30 秒周期刷新 + 回前台立即刷新(useLiveRefresh);刷新失败保留旧数据并提示可重试;
 * - 播放统一经 US3 受控入口(PlayButton/usePlayAction;无节目频道仍可发起);
 * - 详情面板:旧 live 弹层已删除,同一共享面板承载 now/upcoming/ended/none 四状态
 *   (FR-013、ui.md §2;status 由宿主闭包 panelStatusOf 裁决);
 * - 收藏:游客/未选档仅登录引导零请求(GuestActionNotice);已选档走既有 favorites
 *   变更(乐观写+对账;卡片收藏的行内反馈收口归 012 T011)。
 */

const PREVIEW_PAGE_SIZE = 20;
const FOCUSED_PAGE_SIZE = 20;
/** 概览分组集合请求条数(分区展示为前端切片,完整列表经查看更多) */
const OVERVIEW_GROUP_FETCH_SIZE = 50;

const VALID_SECTIONS: readonly string[] = ['now', 'next', 'group', 'all'];

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
  const [searchParams, setSearchParams] = useSearchParams();
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

  const rawSection = searchParams.get('section');
  const section: LiveSection | null =
    rawSection !== null && VALID_SECTIONS.includes(rawSection) ? (rawSection as LiveSection) : null;
  const groupKeyParam = searchParams.get('group') ?? undefined;
  const qParam = searchParams.get('q') ?? '';
  const pageParam = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);

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
        params.delete('page'); // 新搜索回到第一页
      });
    },
    [updateParams],
  );

  /* ---------------- 资源:概览(全部区独立)+ 聚焦视图 ----------------
   * T023 迁移:取数状态机已收口到 shared/query(useAppQuery;signal 透传、
   * 缓存与后台刷新由数据层承担),键一律取自 queryKeys.public 工厂——
   * live 分组/频道为工厂 live() 前缀的派生键(工厂暂无分组/频道子资源条目,
   * 扩工厂属 query-keys 契约变更,归数据层任务):首段仍为 'public' 身份域,
   * 参数对象置于末位、可序列化,同参同键、异参异键。频道列表在 section/q/page
   * 变键时以 keepPreviousData 保留上一份内容(旧「代次」行为:换键不吞旧数据)。 */

  const focused = section !== null;

  const groupsResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveGroups(),
      queryFn: ({ signal }) => fetchLiveGroups(signal),
    },
    refreshKey,
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
    !focused,
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
    !focused,
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
    !focused,
  );

  const focusedQuery: LiveChannelQuery = {
    section: section ?? 'all',
    groupKey: section === 'group' ? groupKeyParam : undefined,
    page: pageParam,
    pageSize: FOCUSED_PAGE_SIZE,
    q: qParam || undefined,
  };
  const focusedResource = useLiveSection(
    {
      domain: 'public',
      queryKey: queryKeys.public.liveChannels(focusedQuery),
      queryFn: ({ signal }) => fetchLiveChannels(focusedQuery, signal),
      placeholderData: keepPreviousData,
    },
    refreshKey,
    focused,
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

  const timezone = groupsResource.data?.timezone ?? focusedResource.data?.timezone ?? 'UTC';
  const serverNowIso = groupsResource.data?.now ?? focusedResource.data?.now ?? null;
  /** 此刻直播精选横幅对象:now 区服务端稳定排序首频道(数据未就绪为 null,横幅不渲染) */
  const firstNowRow: ChannelRowDto | null = nowResource.data?.items[0] ?? null;

  const groupLabelOf = useMemo((): string | undefined => {
    if (section !== 'group' || groupKeyParam === undefined) {
      return undefined;
    }
    return groupsResource.data?.items.find((group) => group.key === groupKeyParam)?.label;
  }, [section, groupKeyParam, groupsResource.data]);

  const retryAll = useCallback((): void => {
    groupsResource.retry();
    focusedResource.retry();
    groupsChannelsResource.retry();
  }, [groupsResource, focusedResource, groupsChannelsResource]);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold text-foreground">直播</h1>
        <p className="text-xs text-muted">
          {serverNowIso !== null
            ? `时间按家庭时区显示 · 每 30 秒自动更新`
            : '正在加载家庭时区…'}
        </p>
      </header>

      {/* 所有节目单入口(FR-021 第一区):本阶段指向 /live/guide 占位路由,US6 交付 EPG 墙 */}
      <section aria-label="所有节目单入口" className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-lg font-semibold text-foreground">所有节目单</h2>
        <p className="mt-1 text-sm text-muted">按频道和时间浏览全部频道排期(节目墙由 US6 交付)。</p>
        <div className="mt-3">
          <Link
            to="/live/guide"
            className="inline-flex items-center rounded border border-border px-3 py-1.5 text-sm text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            进入节目单
          </Link>
        </div>
      </section>

      {/* 搜索(q 写 URL;详情返回或登录取消后恢复) */}
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <TextField
          className="min-w-0"
          value={qParam}
          onChange={(value) => {
            setQuery(value);
          }}
          aria-label="搜索频道"
        >
          <Label>搜索频道</Label>
          <Input placeholder="按频道名称搜索" />
        </TextField>
        {qParam !== '' ? (
          <Button size="sm" variant="ghost" onPress={() => setQuery('')}>
            清除搜索
          </Button>
        ) : null}
      </div>

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
            <Button size="sm" variant="outline" onPress={groupsResource.retry}>
              重试
            </Button>
          </Alert.Content>
        </Alert>
      ) : null}

      {section === null ? (
        <>
          {/* 此刻直播精选(Netflix 式横幅;非 FR-021 分区,位于所有节目单入口之后,
              取 now 区服务端稳定排序首频道,数据未就绪时不渲染) */}
          {firstNowRow !== null && nowResource.data !== null ? (
            <NowHero
              row={firstNowRow}
              timezone={nowResource.data.timezone}
              nowIso={nowResource.data.now}
              onOpenProgramme={setSlotDialog}
            />
          ) : null}
          <NowSection
            resource={nowResource}
            onRetry={nowResource.retry}
            onViewMore={() => {
              updateParams((params) => {
                params.set('section', 'now');
                params.delete('page');
              });
            }}
            onOpenProgramme={setSlotDialog}
            onRequireAuth={requireAuth}
          />
          <NextSection
            resource={nextResource}
            onRetry={nextResource.retry}
            onViewMore={() => {
              updateParams((params) => {
                params.set('section', 'next');
                params.delete('page');
              });
            }}
            onOpenProgramme={setSlotDialog}
            onRequireAuth={requireAuth}
          />
          <GroupSections
            groupsResource={groupsResource}
            channelsResource={groupsChannelsResource}
            focusedGroupKey={null}
            onRetry={retryAll}
            onViewMore={(key) => {
              updateParams((params) => {
                params.set('section', 'group');
                params.set('group', key);
                params.delete('page');
              });
            }}
            onOpenProgramme={setSlotDialog}
            onRequireAuth={requireAuth}
          />
        </>
      ) : (
        <FocusedSection
          sectionTitle={sectionTitleOf(section, groupLabelOf)}
          resource={focusedResource}
          page={pageParam}
          onPageChange={(nextPage) => {
            updateParams((params) => {
              params.set('page', String(nextPage));
            });
          }}
          onExit={() => {
            updateParams((params) => {
              params.delete('section');
              params.delete('group');
              params.delete('page');
            });
          }}
          onRetry={focusedResource.retry}
          onOpenProgramme={setSlotDialog}
          onRequireAuth={requireAuth}
        />
      )}

      {/* 节目详情面板(012 T016;FR-013、ui.md §2):三区共用同一共享面板宿主
          (shared-programme/ProgrammeDetailPanel,T005 落点;旧 live 弹层已删除)。
          status 由宿主闭包 panelStatusOf 按 kind+programme+serverNowIso 裁决;
          动作回调均无参:频道身份(mediaId)由本闭包持有(ui.md §1.4 频道语义)。 */}
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
          // 游客/未选档:零请求,仅登录引导(FR-009;与卡片收藏同语义,行内反馈收口归 T011)
          if (activeProfileId === null) {
            requireAuth(`收藏 ${slotDialog.channelTitle}`);
            return;
          }
          // 已选档:既有 favorites 变更(乐观写 + onSettled 服务端对账;失败回滚与
          // 提示由数据层收口;已收藏态回显与行内成功反馈归 T011,本期最小接线)
          void favoriteToggle.mutateAsync(true).catch(() => undefined);
        }}
        onGuide={() => {
          // 次操作「查看节目单」:导航节目单页(ui.md §2.3;公共路由 /live/guide)
          void navigate('/live/guide');
        }}
      />
    </div>
  );
}
