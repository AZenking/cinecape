/**
 * 频道管理页(T134,US8;FR-038;018 IPTV 管理优化;作为「IPTV 管理」页的
 * 「频道管理」标签挂载,亦可独立渲染):
 * - HeroUI Table(v3 项目文档口径)呈现频道资产:列 = 多选 / 台标+名称 / 播放线路 /
 *   节目单绑定 / 前台显隐 / 操作;表格在壳内最宽约 1120px,横向滚动兜底;
 * - 工具栏:搜索(SearchField,回车/按钮应用)、可见性切片(ToggleButtonGroup,
 *   三档计数 = 服务端 counts,家庭+关键词+类型过滤后、可见性过滤前真值)、
 *   结果计数(当前切片 total)与更多菜单(Dropdown:全库设为显示/隐藏);
 * - 全量可见性过滤修复(018):可见性切片与排序全部由服务端承担 —— 请求带
 *   visibility 枚举,前端不再本地过滤当页/重排;total 为过滤后总数(分页依据);
 *   变更后重取 counts;结果收缩导致越界页时钳制到最后一个有效页;
 * - 请求竞态:每次查询自增序号,晚到响应不覆盖新结果;失败以可重试错误面呈现
 *   (RetryableAlert),不再静默吞掉;
 * - 批量栏仅在有勾选时出现;「全选」语义 = 当前页(表格仅承载当前页数据);
 *   翻页/搜索/切片变更清空勾选;
 * - 全库显隐经确认弹层(AlertDialog)二次确认,文案明确「忽略当前搜索与筛选条件」;
 * - 节目单绑定呈现(018):manual 显示 EPG 频道名(displayName,缺失回退
 *   「名称不可用」),技术 ID(xmltvChannelId)在次要明细行;auto 恒称
 *   「自动匹配模式」—— 候选查询未验证实际命中前不声称「已匹配」;
 * - 编辑弹窗:整合频道名称修改、台标 URL 修改与本地图片上传、前台显隐开关、
 *   直播源线路管理与 EPG 节目单多源匹配/解除绑定(行为保持)。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  Button,
  Checkbox,
  Chip,
  Dropdown,
  Label,
  Pagination,
  ProgressBar,
  SearchField,
  Switch,
  Table,
  ToggleButton,
  ToggleButtonGroup,
} from '@heroui/react';
import { Ellipsis, Eye, EyeOff, SlidersHorizontal, Tv } from 'lucide-react';
import { ChannelEditModal } from './components/ChannelEditModal';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { classifySettingsWriteError } from './shared/access-expiry';
import {
  settingsApi,
  fetchAllSettingsSources,
  type CandidateDto,
  type CandidatePageDto,
  type SourcePageDto,
} from './shared/settings-api';
import { useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';

type VisibilityFilter = 'all' | 'visible' | 'hidden';

/** 分页数字省略计算 */
function getVisiblePages(current: number, total: number): (number | 'ellipsis')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, 'ellipsis', total];
  }
  if (current >= total - 3) {
    return [1, 'ellipsis', total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, 'ellipsis', current - 1, current, current + 1, 'ellipsis', total];
}

/** 查询上下文(当前生效的搜索/切片/分页;重试与变更后刷新共用) */
interface ChannelQueryContext {
  q: string;
  visibility: VisibilityFilter;
  page: number;
  pageSize: number;
}

export interface SettingsEpgPageProps {
  /** 隐藏独立页头(嵌入到带有公共页头的聚合父页时使用;同时隐藏分区冗余标题) */
  readonly hideHeader?: boolean;
}

export function SettingsEpgPage({ hideHeader }: SettingsEpgPageProps = {}): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const toast = useAppToast();

  // 搜索草稿(输入框)与已应用搜索词(服务端查询基准)分离:切页/切片沿用已应用词
  // (已应用词唯一事实源 = queryContextRef,不另存冗余状态)
  const [channelSearch, setChannelSearch] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('all');

  const [channels, setChannels] = useState<CandidateDto[] | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [counts, setCounts] = useState<CandidatePageDto['counts'] | null>(null);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  /** 可重试查询失败(晚到竞态/网络/5xx):呈现错误面而非静默吞掉 */
  const [queryError, setQueryError] = useState<{ cause: unknown; context: ChannelQueryContext } | null>(null);

  // 批量操作与编辑状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBatchOperating, setIsBatchOperating] = useState<boolean>(false);
  const [editingChannel, setEditingChannel] = useState<CandidateDto | null>(null);
  const [editInitialTab, setEditInitialTab] = useState<'basic' | 'streams' | 'epg'>('basic');
  /** 全库显隐确认弹层(true=全库显示 / false=全库隐藏 / null=关闭) */
  const [confirmAllVisible, setConfirmAllVisible] = useState<boolean | null>(null);
  const [libraryCount, setLibraryCount] = useState<number | null>(null);
  const [libraryCountError, setLibraryCountError] = useState<string | null>(null);

  useEffect(() => {
    if (confirmAllVisible === null) return;
    let active = true;
    setLibraryCount(null);
    setLibraryCountError(null);
    void settingsApi.queryCandidates({ type: 'channel', visibility: 'all', page: 1, pageSize: 1 })
      .then((result) => {
        if (active) setLibraryCount(result.total);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (classifySettingsWriteError(cause) === 'access-lost') access.handleAccessLost();
        setLibraryCountError(formatApiError(cause));
      });
    return () => { active = false; };
  }, [confirmAllVisible, access]);

  /** 请求序号:晚到的旧响应不得覆盖新结果(搜索/切片/翻页快速切换) */
  const requestIdRef = useRef(0);
  /** 当前生效查询上下文(失败重试/变更后刷新的基准) */
  const queryContextRef = useRef<ChannelQueryContext>({ q: '', visibility: 'all', page: 1, pageSize: 50 });

  // EPG 页数据 = /settings/sources(kind 全量,页面内本地过滤 epg)。
  const sourcesQuery = useAppQuery<SourcePageDto>({
    domain: 'settings',
    queryKey: queryKeys.settings.epg(),
    queryFn: ({ signal }) => fetchAllSettingsSources(signal),
  });

  // 管理主体读取得到 403 SETTINGS_ACCESS_*:立即回到锁定态
  useEffect(() => {
    if (sourcesQuery.isError && classifySettingsWriteError(sourcesQuery.error) === 'access-lost') {
      access.handleAccessLost();
    }
  }, [sourcesQuery.isError, sourcesQuery.error, access]);

  const sources = sourcesQuery.data?.items ?? null;
  const epgSources = (sources ?? []).filter((source) => source.kind === 'epg');

  /** 变更失败分流 */
  const handleMutationFailure = (cause: unknown, conflictMessage?: string): void => {
    const kind = classifySettingsWriteError(cause);
    if (kind === 'access-lost') {
      access.handleAccessLost();
      return;
    }
    if (kind === 'conflict') {
      toast.error(conflictMessage ?? '版本冲突:数据已被其他操作修改,界面已按服务端现值刷新,请重新操作。');
      void sourcesQuery.refetch();
      return;
    }
    toast.error(formatApiError(cause));
  };

  /**
   * 频道候选查询(服务端可见性过滤 + counts):
   * - 每次调用自增请求序号;响应落地前序号已前进 → 丢弃(防晚到覆盖);
   * - 成功后清空勾选(翻页/搜索/切片变更不保留旧页勾选;变更后刷新保留与
   *   当页仍存在条目的交集,被过滤移出的条目自动出选);
   * - 越界钳制:结果收缩导致当前页超出最后有效页时,自动改查最后一个有效页
   *   (total=0 时停在第 1 页语义,呈现空态)。
   */
  const runQuery = async (
    target: ChannelQueryContext,
    options: { keepSelection?: boolean } = {},
  ): Promise<void> => {
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    queryContextRef.current = target;
    setIsLoading(true);
    setQueryError(null);
    if (!options.keepSelection) setSelectedIds(new Set());
    try {
      const pageData = await settingsApi.queryCandidates({
        q: target.q.trim() === '' ? undefined : target.q.trim(),
        type: 'channel',
        visibility: target.visibility,
        page: target.page,
        pageSize: target.pageSize,
      });
      if (requestId !== requestIdRef.current) {
        return; // 晚到响应:已有更新请求在途/落地,丢弃
      }
      const items = pageData?.items ?? [];
      const landedTotal = pageData?.total ?? 0;
      const landedPage = pageData?.page ?? target.page;
      setChannels(items);
      setTotal(landedTotal);
      setCounts(pageData?.counts ?? null);
      setPage(landedTotal === 0 ? 1 : landedPage);
      setPageSize(pageData?.pageSize ?? target.pageSize);
      setSelectedIds((prev) => {
        if (!options.keepSelection) {
          return new Set();
        }
        const onPage = new Set(items.map((item) => item.id));
        return new Set([...prev].filter((id) => onPage.has(id)));
      });

      // 越界钳制:空页但仍有结果 → 改查最后一个有效页(结果收缩场景)
      const lastPage = Math.max(1, Math.ceil(landedTotal / (pageData?.pageSize ?? target.pageSize)));
      if (items.length === 0 && landedTotal > 0 && landedPage > lastPage) {
        await runQuery({ ...target, page: lastPage }, options);
      } else if (landedTotal === 0) {
        queryContextRef.current = { ...target, page: 1 };
      }
    } catch (cause) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      if (classifySettingsWriteError(cause) === 'access-lost') {
        access.handleAccessLost();
      }
      setQueryError({ cause, context: target });
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  };

  // 页面首次挂载时自动执行一次频道列表加载
  useEffect(() => {
    void runQuery({ q: '', visibility: 'all', page: 1, pageSize: 50 });
  }, []);

  /** 变更后刷新:沿用当前生效上下文重取(counts 随响应回填;保留当页仍存在条目的勾选) */
  const refreshAfterMutation = (): void => {
    void runQuery(queryContextRef.current, { keepSelection: true });
  };

  /** 切换单频道前台显隐开关 */
  const toggleVisibility = async (channel: CandidateDto, isSelected: boolean): Promise<void> => {
    try {
      await settingsApi.patchMedia(channel.id, {
        expectedVersion: channel.version,
        visible: isSelected,
      });
      toast.success(`频道已${isSelected ? '设为显示' : '设为隐藏'}`);
      refreshAfterMutation();
    } catch (cause) {
      handleMutationFailure(cause, '更新频道显隐状态失败');
    }
  };

  /** 批量修改显隐(勾选条目;完成后清空勾选并刷新) */
  const handleBatchVisibility = async (visible: boolean): Promise<void> => {
    if (selectedIds.size === 0) return;
    setIsBatchOperating(true);
    try {
      const res = await settingsApi.batchVisibility({
        mediaIds: Array.from(selectedIds),
        visible,
      });
      toast.success(`已批量将 ${res.updatedCount} 个频道设为${visible ? '显示' : '隐藏'}`);
      setSelectedIds(new Set());
      refreshAfterMutation();
    } catch (cause) {
      handleMutationFailure(cause, '批量修改频道显隐失败');
    } finally {
      setIsBatchOperating(false);
    }
  };

  /**
   * 全库设为显示/隐藏(all=true,服务端按家庭频道全集生效;counts 随刷新回填)。
   * 入口在更多菜单,执行前经 AlertDialog 确认 —— 文案明确「忽略当前搜索与筛选」。
   */
  const handleBatchAllVisibility = async (visible: boolean): Promise<void> => {
    setIsBatchOperating(true);
    try {
      const res = await settingsApi.batchVisibility({ all: true, visible });
      toast.success(`已将全部 ${res.updatedCount} 个频道设为${visible ? '显示' : '隐藏'}`);
      setSelectedIds(new Set());
      refreshAfterMutation();
    } catch (cause) {
      handleMutationFailure(cause, '全库设置频道显隐失败');
    } finally {
      setIsBatchOperating(false);
    }
  };

  /** 应用搜索词:回到第 1 页按新词查询(勾选清空由 runQuery 承担) */
  const runSearch = (): void => {
    void runQuery({ ...queryContextRef.current, q: channelSearch, page: 1 });
  };

  /** 一键清空搜索:立即按空词回到第 1 页 */
  const clearSearch = (): void => {
    setChannelSearch('');
    void runQuery({ ...queryContextRef.current, q: '', page: 1 });
  };

  /** 切换可见性切片:回到第 1 页(三档计数恒为服务端 counts,不随切片改写) */
  const changeVisibilityFilter = (next: VisibilityFilter): void => {
    if (next === visibilityFilter) return;
    setVisibilityFilter(next);
    void runQuery({ ...queryContextRef.current, visibility: next, page: 1 });
  };

  /** 切换页码(勾选清空:全选语义仅限当前页) */
  const handlePageChange = (newPage: number): void => {
    if (newPage === page || newPage < 1) return;
    void runQuery({ ...queryContextRef.current, page: newPage });
  };

  /** 切换每页容量(回到第 1 页) */
  const handlePageSizeChange = (newSize: number): void => {
    if (newSize === pageSize) return;
    void runQuery({ ...queryContextRef.current, pageSize: newSize, page: 1 });
  };

  /** 打开编辑弹窗 */
  const handleOpenEdit = (channel: CandidateDto, tab: 'basic' | 'streams' | 'epg' = 'basic'): void => {
    setEditingChannel(channel);
    setEditInitialTab(tab);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 全选 = 当前页(表格仅承载当前页数据);勾选状态由 Table 受控集合表达
  const pageIds = (channels ?? []).map((channel) => channel.id);

  const countOf = (filter: VisibilityFilter): number | null => {
    if (counts === null) return null;
    return counts[filter];
  };

  return (
    <section aria-label={`设置 · ${title} · 频道管理`} className="flex flex-1 flex-col gap-4">
      {!hideHeader ? <SettingsPageHeader description="管理家庭频道资产、聚合线路与 EPG 节目单绑定" /> : null}

      {/* 工具栏:搜索 / 可见性切片(计数 = 服务端全量 counts) / 结果计数 / 更多菜单 */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between" data-testid="channel-toolbar">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
          <SearchField
            className="min-w-0 max-w-xs flex-1 basis-48"
            value={channelSearch}
            onChange={setChannelSearch}
            aria-label="搜索频道"
            onSubmit={runSearch}
          >
            <Label className="sr-only">频道名称</Label>
            <SearchField.Group className="h-8">
              <SearchField.Input
                placeholder="输入频道名称搜索…"
                data-testid="epg-channel-q"
                className="py-1 text-xs"
                onKeyDown={(e: React.KeyboardEvent) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runSearch();
                  }
                }}
              />
              <SearchField.ClearButton aria-label="清空搜索" onPress={clearSearch} />
            </SearchField.Group>
          </SearchField>
          <Button
            variant="secondary"
            size="sm"
            className="h-8 shrink-0 text-xs text-foreground"
            onPress={runSearch}
            isDisabled={isLoading}
            data-testid="epg-channel-search"
          >
            {isLoading ? '查询中…' : '查询'}
          </Button>

          <ToggleButtonGroup
            selectionMode="single"
            disallowEmptySelection
            aria-label="可见性切片"
            size="sm"
            selectedKeys={new Set([visibilityFilter])}
            onSelectionChange={(keys) => {
              const key = [...keys][0];
              if (key === 'all' || key === 'visible' || key === 'hidden') {
                changeVisibilityFilter(key);
              }
            }}
          >
            <ToggleButton id="all" data-testid="visibility-filter-all">
              全部{countOf('all') !== null ? ` (${countOf('all')})` : ''}
            </ToggleButton>
            <ToggleButton id="visible" data-testid="visibility-filter-visible">
              前台显示{countOf('visible') !== null ? ` (${countOf('visible')})` : ''}
            </ToggleButton>
            <ToggleButton id="hidden" data-testid="visibility-filter-hidden">
              已隐藏{countOf('hidden') !== null ? ` (${countOf('hidden')})` : ''}
            </ToggleButton>
          </ToggleButtonGroup>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {total > 0 ? (
            <Chip size="sm" variant="soft" color="default" className="text-xs" data-testid="channel-result-count">
              共 {total} 个频道{totalPages > 1 ? ` · 第 ${page}/${totalPages} 页` : ''}
            </Chip>
          ) : null}
          <Dropdown>
            <Dropdown.Trigger
              className="inline-flex size-8 items-center justify-center rounded-lg bg-surface-secondary text-foreground"
              aria-label="更多操作"
              data-testid="channel-more-menu"
              isDisabled={isBatchOperating}
            >
              <Ellipsis className="size-4" aria-hidden="true" />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                onAction={(key) => {
                  if (key === 'all-show') {
                    setConfirmAllVisible(true);
                  } else if (key === 'all-hide') {
                    setConfirmAllVisible(false);
                  }
                }}
              >
                <Dropdown.Item id="all-show" textValue="全库设为显示">
                  <Label>全库设为显示</Label>
                </Dropdown.Item>
                <Dropdown.Item id="all-hide" textValue="全库设为隐藏" variant="danger">
                  <Label>全库设为隐藏</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </div>

      {/* 批量栏:仅在存在勾选时出现(直接操纵反馈;全选语义 = 当前页) */}
      {selectedIds.size > 0 ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-surface-secondary/30 px-3 py-2"
          data-testid="channel-batch-bar"
        >
          <Chip size="sm" variant="soft" color="accent" className="text-xs">
            已选 {selectedIds.size} 项(当前页)
          </Chip>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted"
            onPress={() => setSelectedIds(new Set())}
            data-testid="batch-clear"
          >
            取消选择
          </Button>
          <div className="flex-1" />
          <Button
            variant="primary"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            isDisabled={isBatchOperating}
            onPress={() => void handleBatchVisibility(true)}
            data-testid="batch-visible-btn"
          >
            <Eye className="size-3.5" aria-hidden="true" />
            批量设为显示
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            isDisabled={isBatchOperating}
            onPress={() => void handleBatchVisibility(false)}
            data-testid="batch-hide-btn"
          >
            <EyeOff className="size-3.5" aria-hidden="true" />
            批量设为隐藏
          </Button>
        </div>
      ) : null}

      {/* 查询失败:可重试错误面(不静默吞掉;重试按失败时的查询上下文) */}
      {queryError !== null ? (
        <RetryableAlert
          title="频道列表读取失败"
          description={formatApiError(queryError.cause)}
          onRetry={() => void runQuery(queryError.context)}
        />
      ) : null}

      {/* 频道表格与列表(服务端排序:显示优先 → 标题 UTF-8 字节序 → id;前端不再重排) */}
      {channels !== null && queryError === null ? (
        <p className="text-xs text-muted md:hidden">左右滑动查看线路、节目单及更多操作</p>
      ) : null}
      {channels !== null && queryError === null ? (
        <div className="w-full max-w-[1120px] overflow-hidden rounded-xl border border-border/40 bg-surface/30 shadow-xs" data-testid="channel-table">
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[calc(100vh-410px)] min-h-[320px] overflow-auto">
              <Table.Content
                aria-label="频道资产列表"
                className="min-w-[880px]"
                selectionMode="multiple"
                selectedKeys={selectedIds}
                onSelectionChange={(keys) => {
                  setSelectedIds(keys === 'all' ? new Set(pageIds) : new Set([...keys].map(String)));
                }}
              >
                <Table.Header className="sticky top-0 z-10 bg-background">
                  <Table.Column className="w-12 pe-0" isRowHeader={false}>
                    <Checkbox
                      slot="selection"
                      aria-label="全选当前页频道"
                      data-testid="select-all-checkbox"
                    >
                      <Checkbox.Content>
                        <Checkbox.Control className="border-border/60 bg-surface-secondary/80">
                          <Checkbox.Indicator />
                        </Checkbox.Control>
                      </Checkbox.Content>
                    </Checkbox>
                  </Table.Column>
                  <Table.Column isRowHeader>频道</Table.Column>
                  <Table.Column className="w-28">播放线路</Table.Column>
                  <Table.Column className="w-56">节目单绑定</Table.Column>
                  <Table.Column className="w-32 text-center">前台显隐</Table.Column>
                  <Table.Column className="w-24 text-right">操作</Table.Column>
                </Table.Header>
                <Table.Body
                  items={channels}
                  data-testid="epg-channel-list"
                  renderEmptyState={() => (
                    <div className="py-12 text-center text-sm text-muted" data-testid="epg-channel-empty">
                      {channelSearch.trim() !== '' || visibilityFilter !== 'all'
                        ? '当前搜索与筛选条件下没有频道。'
                        : '尚无频道;请先在「直播源」标签添加 M3U 来源并完成同步。'}
                    </div>
                  )}
                >
                  {(channel) => (
                    <Table.Row key={channel.id} id={channel.id} data-testid={`channel-row-${channel.id}`}>
                      {/* 选择复选框 */}
                      <Table.Cell className="pe-0">
                        <Checkbox
                          slot="selection"
                          aria-label={`选择频道 ${channel.title}`}
                          data-testid={`select-channel-${channel.id}`}
                        >
                          <Checkbox.Content>
                            <Checkbox.Control className="border-border/60 bg-surface-secondary/80">
                              <Checkbox.Indicator />
                            </Checkbox.Control>
                          </Checkbox.Content>
                        </Checkbox>
                      </Table.Cell>

                      {/* 频道主体: 台标 + 名称(隐藏态保持可读,用次要色文字而非整行透明度) */}
                      <Table.Cell>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <div className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-surface/70 p-1 shadow-xs">
                            {channel.logoUrl ? (
                              <img
                                src={channel.logoUrl}
                                alt=""
                                className="size-full object-contain"
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                }}
                              />
                            ) : (
                              <Tv className="size-4 text-muted/60" aria-hidden="true" />
                            )}
                          </div>
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium text-foreground">{channel.title}</span>
                            {channel.visible === false ? (
                              <span className="text-xs text-muted">前台隐藏</span>
                            ) : null}
                          </div>
                        </div>
                      </Table.Cell>

                      {/* 线路数(直达线路管理) */}
                      <Table.Cell>
                        <button
                          type="button"
                          onClick={() => handleOpenEdit(channel, 'streams')}
                          className="inline-flex cursor-pointer items-center rounded-full transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-accent active:scale-95"
                          title="点击查看并管理直播源线路"
                        >
                          <Chip
                            size="sm"
                            variant="soft"
                            color="default"
                            className="gap-1 transition-colors hover:bg-surface-secondary/80"
                            data-testid={`channel-lines-${channel.id}`}
                          >
                            {channel.lineCount != null ? `${channel.lineCount} 条线路` : '1 条线路'}
                          </Chip>
                        </button>
                      </Table.Cell>

                      {/* EPG 绑定:manual = 频道名 + 技术明细;auto = 自动匹配模式(不虚报已匹配) */}
                      <Table.Cell>
                        <div className="min-w-0" data-testid={`channel-binding-${channel.id}`}>
                          {channel.epgBinding?.mode === 'manual' ? (
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span
                                className="truncate text-sm text-foreground"
                                title={`节目单 ID: ${channel.epgBinding.xmltvChannelId ?? '—'}`}
                              >
                                {channel.epgBinding.displayName ?? '名称不可用'}
                              </span>
                              <span className="text-xs text-muted">手动绑定</span>
                              {channel.epgBinding.status === 'invalid' ? (
                                <Chip size="sm" variant="soft" color="warning" className="w-fit text-2xs">
                                  绑定失效，请重新选择节目单
                                </Chip>
                              ) : null}
                            </div>
                          ) : (
                            <Chip size="sm" variant="soft" color="default">
                              自动匹配模式
                            </Chip>
                          )}
                        </div>
                      </Table.Cell>

                      {/* 可见性 Switch(直接操纵;状态以开关+文字表达) */}
                      <Table.Cell className="text-center">
                        <Switch
                          isSelected={channel.visible !== false}
                          onChange={(isSelected) => void toggleVisibility(channel, isSelected)}
                          aria-label={`切换频道 ${channel.title} 显示状态`}
                          data-testid={`channel-visibility-switch-${channel.id}`}
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span className="select-none text-xs text-muted">
                              {channel.visible !== false ? '显示' : '隐藏'}
                            </span>
                          </Switch.Content>
                        </Switch>
                      </Table.Cell>

                      {/* 操作 */}
                      <Table.Cell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            className="h-7 gap-1 px-2.5 text-xs text-foreground"
                            onPress={() => handleOpenEdit(channel, 'basic')}
                            data-testid={`channel-edit-${channel.id}`}
                          >
                            <SlidersHorizontal className="size-3" aria-hidden="true" />
                            编辑
                          </Button>
                          {/* 隐藏的匹配按钮供辅助功能与契约测试触发,功能由编辑弹窗 EPG 匹配页签承载 */}
                          <Button
                            className="sr-only"
                            onPress={() => handleOpenEdit(channel, 'epg')}
                            data-testid={`epg-match-${channel.id}`}
                          >
                            匹配 EPG
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>

            {/* 表底:结果区间 / 每页容量 / 分页 */}
            {total > 0 ? (
              <Table.Footer className="flex flex-col items-center justify-between gap-3 border-t border-border/40 bg-surface/70 px-4 py-2.5 backdrop-blur-sm sm:flex-row">
                <div className="flex items-center gap-3 text-xs text-muted">
                  <span data-testid="channel-range" className="whitespace-nowrap">
                    显示第 {(page - 1) * pageSize + 1} - {Math.min(page * pageSize, total)} 条 · 共 {total} 条
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5 border-l border-border/30 pl-3">
                    <span className="whitespace-nowrap">每页</span>
                    <div className="flex items-center gap-1">
                      {[20, 50, 100].map((size) => (
                        <Button
                          key={size}
                          size="sm"
                          variant={pageSize === size ? 'primary' : 'secondary'}
                          className="h-6 min-w-6 px-1.5 text-xs"
                          onPress={() => handlePageSizeChange(size)}
                        >
                          {size}
                        </Button>
                      ))}
                    </div>
                    <span className="whitespace-nowrap">条</span>
                  </div>
                </div>

                {totalPages > 1 ? (
                  <Pagination.Root aria-label="频道分页" size="sm">
                    <Pagination.Content>
                      <Pagination.Item>
                        <Pagination.Previous isDisabled={page <= 1 || isLoading} onPress={() => handlePageChange(page - 1)}>
                          上一页
                        </Pagination.Previous>
                      </Pagination.Item>
                      {getVisiblePages(page, totalPages).map((p, idx) =>
                        p === 'ellipsis' ? (
                          <Pagination.Item key={`ellipsis-${idx}`}>
                            <Pagination.Ellipsis />
                          </Pagination.Item>
                        ) : (
                          <Pagination.Item key={p}>
                            <Pagination.Link isActive={p === page} isDisabled={isLoading} onPress={() => handlePageChange(p)}>
                              {p}
                            </Pagination.Link>
                          </Pagination.Item>
                        ),
                      )}
                      <Pagination.Item>
                        <Pagination.Next isDisabled={page >= totalPages || isLoading} onPress={() => handlePageChange(page + 1)}>
                          下一页
                        </Pagination.Next>
                      </Pagination.Item>
                    </Pagination.Content>
                  </Pagination.Root>
                ) : null}
              </Table.Footer>
            ) : null}
          </Table>
        </div>
      ) : channels === null && queryError === null && isLoading ? (
        <div className="flex flex-col gap-3 py-10" data-testid="channel-loading">
          <LoadingSpinner label="正在读取频道…" />
          <ProgressBar isIndeterminate aria-label="频道列表加载中" className="w-full">
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        </div>
      ) : null}

      {/* 全库显隐确认:文案明确忽略当前搜索与筛选(all 语义 = 全库频道) */}
      <AlertDialog.Backdrop
        isOpen={confirmAllVisible !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setConfirmAllVisible(null);
          }
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]" data-testid="all-visibility-confirm">
            <AlertDialog.Header>
              <AlertDialog.Icon status={confirmAllVisible === false ? 'danger' : 'accent'} />
              <AlertDialog.Heading>
                {confirmAllVisible === false ? '将全部频道设为隐藏?' : '将全部频道设为显示?'}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-foreground">
                此操作将作用于家庭内的{' '}
                <strong>全部频道(忽略当前搜索与筛选条件)</strong>
                ,共 {libraryCount ?? '…'} 个频道。
              </p>
              {libraryCountError !== null ? <p role="alert" className="mt-2 text-sm text-danger">无法读取全库数量：{libraryCountError}。请取消后重试。</p> : null}
              <p className="mt-2 text-sm text-muted">
                {confirmAllVisible === false
                  ? '隐藏后频道将从前台直播列表与节目指南中消失,可随时再次设为显示。'
                  : '全部频道将恢复在前台直播列表与节目指南中呈现。'}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" size="sm" onPress={() => setConfirmAllVisible(null)} data-testid="all-visibility-cancel">
                取消
              </Button>
              <Button
                variant={confirmAllVisible === false ? 'danger' : 'primary'}
                size="sm"
                isDisabled={isBatchOperating || libraryCount === null || libraryCount === 0}
                onPress={() => {
                  const target = confirmAllVisible;
                  setConfirmAllVisible(null);
                  if (target !== null) {
                    void handleBatchAllVisibility(target);
                  }
                }}
                data-testid="all-visibility-confirm-btn"
              >
                {confirmAllVisible === false ? '全库设为隐藏' : '全库设为显示'}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      {/* 编辑频道元数据弹窗 (自定义名称、台标 Logo 上传与预览、直播源线路管理、EPG 节目单匹配) */}
      <ChannelEditModal
        isOpen={editingChannel !== null}
        onClose={() => setEditingChannel(null)}
        channel={editingChannel}
        epgSources={epgSources}
        initialTab={editInitialTab}
        onSaved={refreshAfterMutation}
      />
    </section>
  );
}
