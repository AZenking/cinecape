/**
 * 家长候选资源选择器(T052,US3;003 contracts/api.md「家长候选与人工修正」)。
 *
 * - POST /catalog/candidates/query:逐次查询验证 —— 查询与翻页每次都随 body
 *   携带 ownerPassword,由服务端逐次校验(无长期令牌);密码仅存于本组件内存
 *   state,不写 localStorage/URL/日志;查询失败或「取消并清空密码」后立即清空,
 *   搜索词/类型筛选/查询结果等非敏感表单保留(US3:失败保留非敏感输入);
 * - 查询由显式提交触发(表单 Enter 或「查询候选」按钮),不做输入防抖自动查询,
 *   避免在密码未就绪时发出必失败请求;翻页复用上一次成功查询的 q/type 与当前密码;
 * - 候选行:标题 + 类型 + 分级 +「不可用」标记(available=false 仍可选择);
 *   「加入允许」「加入禁止」对所有类型可见(允许∩禁止契约保留,禁止优先),
 *   「加入频道允许」仅 type=channel 显示;已在目标名单的项转为禁用已加入态;
 * - 加入动作只写页面草稿,由「保存名单」再次家长验证后整体提交;
 * - 候选响应不含路径/地址等敏感字段,本组件仅渲染契约字段;错误只映射稳定 code 文案;
 * - 键盘可操作:搜索/类型/密码输入、查询与翻页按钮、行内加入按钮全部 Tab 可达,
 *   查询经 form 提交(Enter 触发);本组件为页内区块,无对话框焦点管理需求。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Chip,
  Input,
  Label,
  ListBox,
  Select,
  Spinner,
  TextField,
} from '@heroui/react';
import { api, createGenerationGuard } from '../../lib/api';
import {
  MEDIA_TYPE_LABELS,
  contentLevelChipColor,
  contentLevelLabel,
} from '../catalog/messages';
import { MediaPosterPlaceholder } from '../catalog/PosterPlaceholder';
import { friendlyPolicyErrorMessage } from './messages';
import type { CandidateDto } from '@hmp/shared';
import type { MediaType } from '../catalog/messages';

/** 候选分页大小(契约默认 20;本组件固定) */
const PAGE_SIZE = 20;

/** 搜索词长度上限(契约 q 最多 100 字符,trim 后字面包含) */
const QUERY_MAX_LENGTH = 100;

/** 类型筛选值:'all'=全部,其余为契约 Media.type */
type TypeFilter = 'all' | MediaType;

const TYPE_FILTER_OPTIONS: Array<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'channel', label: MEDIA_TYPE_LABELS.channel },
  { value: 'movie', label: MEDIA_TYPE_LABELS.movie },
  { value: 'series', label: MEDIA_TYPE_LABELS.series },
  { value: 'episode', label: MEDIA_TYPE_LABELS.episode },
  { value: 'video', label: MEDIA_TYPE_LABELS.video },
];

function isTypeFilter(key: unknown): key is TypeFilter {
  return (
    key === 'all' ||
    key === 'channel' ||
    key === 'movie' ||
    key === 'series' ||
    key === 'episode' ||
    key === 'video'
  );
}

/** 上一次成功查询的语境(翻页复用;输入框草稿变化不影响当前结果页) */
interface AppliedQuery {
  q: string;
  type: TypeFilter;
  page: number;
}

export interface ParentCandidatePickerProps {
  /** 当前草稿:媒体允许名单(用于已加入态判断) */
  allowedMediaIds: readonly string[];
  /** 当前草稿:媒体禁止名单 */
  blockedMediaIds: readonly string[];
  /** 当前草稿:儿童频道允许名单 */
  allowedChannelIds: readonly string[];
  /** 名单保存进行中禁用加入按钮(防草稿与提交内容不一致) */
  isAddDisabled?: boolean;
  onAddToAllowedMedia: (candidate: CandidateDto) => void;
  onAddToBlockedMedia: (candidate: CandidateDto) => void;
  /** 仅 type=channel 的行会出现该动作 */
  onAddToAllowedChannel: (candidate: CandidateDto) => void;
}

export function ParentCandidatePicker({
  allowedMediaIds,
  blockedMediaIds,
  allowedChannelIds,
  isAddDisabled = false,
  onAddToAllowedMedia,
  onAddToBlockedMedia,
  onAddToAllowedChannel,
}: ParentCandidatePickerProps) {
  /** 会话代次守卫:快速翻页时废弃旧在途响应(与目录页同惯例) */
  const guard = useMemo(createGenerationGuard, []);

  // 密码:逐次验证用;仅内存 state,失败/取消即清空(见组件头注释)
  const [passwordDraft, setPasswordDraft] = useState('');
  // 非敏感表单:搜索词/类型筛选草稿与上一次成功查询语境
  const [searchDraft, setSearchDraft] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [applied, setApplied] = useState<AppliedQuery>({ q: '', type: 'all', page: 1 });

  const [items, setItems] = useState<CandidateDto[]>([]);
  const [total, setTotal] = useState(0);
  const [queried, setQueried] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const allowedSet = useMemo(() => new Set(allowedMediaIds), [allowedMediaIds]);
  const blockedSet = useMemo(() => new Set(blockedMediaIds), [blockedMediaIds]);
  const channelSet = useMemo(() => new Set(allowedChannelIds), [allowedChannelIds]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  /**
   * 执行一次候选查询(每次都携带当前密码,服务端逐次验证)。
   * 请求页超出总页数(筛选后条目变少)时回退最后一页重查一次。
   */
  const executeQuery = async (targetPage: number, q: string, type: TypeFilter): Promise<void> => {
    if (passwordDraft === '') {
      return; // 双保险:无密码不发起请求(按钮已禁用)
    }
    const gen = guard.begin();
    setLoading(true);
    setErrorText(null);
    try {
      const result = await api.queryCandidates({
        ownerPassword: passwordDraft,
        q: q === '' ? undefined : q,
        type: type === 'all' ? undefined : type,
        page: targetPage,
        pageSize: PAGE_SIZE,
      });
      if (!guard.isCurrent(gen)) {
        return; // 旧代次响应:一律丢弃
      }
      if (result.total > 0 && result.items.length === 0 && targetPage > 1) {
        await executeQuery(Math.max(1, Math.ceil(result.total / PAGE_SIZE)), q, type);
        return;
      }
      setItems(result.items);
      setTotal(result.total);
      setApplied({ q, type, page: targetPage });
      setQueried(true);
    } catch (error) {
      if (!guard.isCurrent(gen)) {
        return;
      }
      // 失败即清空密码(逐次验证语义);搜索词/筛选/结果保留
      setPasswordDraft('');
      setErrorText(friendlyPolicyErrorMessage(error, '候选查询失败，请检查网络后重试。'));
    } finally {
      if (guard.isCurrent(gen)) {
        setLoading(false);
      }
    }
  };

  const submitQuery = (): void => {
    if (loading || passwordDraft === '') {
      return;
    }
    void executeQuery(1, searchDraft.trim().slice(0, QUERY_MAX_LENGTH), typeFilter);
  };

  const changePage = (next: number): void => {
    if (loading || passwordDraft === '') {
      return;
    }
    void executeQuery(next, applied.q, applied.type);
  };

  /** 取消:清空密码与错误提示;搜索词/筛选/结果等非敏感表单保留 */
  const cancelQuery = (): void => {
    setPasswordDraft('');
    setErrorText(null);
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">资源选择器</p>
          <p className="mt-0.5 text-xs text-muted">
            逐次家长验证查询同家庭候选(含被当前观看策略隐藏与不可用的内容);
            仅展示标题/类型/分级,不含任何地址或路径。
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onPress={cancelQuery}
          isDisabled={passwordDraft === '' && errorText === null}
        >
          取消并清空密码
        </Button>
      </div>

      {/* 查询表单:Enter 或按钮提交;每次提交携带当次密码 */}
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          submitQuery();
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <TextField value={searchDraft} onChange={setSearchDraft} fullWidth className="max-w-sm">
            <Label>搜索候选</Label>
            <Input type="search" placeholder="按标题搜索(最多 100 字符)" maxLength={QUERY_MAX_LENGTH} />
          </TextField>
          <Select
            className="max-w-40"
            value={typeFilter}
            onChange={(key) => {
              if (isTypeFilter(key)) {
                setTypeFilter(key);
              }
            }}
            aria-label="候选类型筛选"
          >
            <Label>类型</Label>
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {TYPE_FILTER_OPTIONS.map((option) => (
                  <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                    {option.label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <TextField
          value={passwordDraft}
          onChange={setPasswordDraft}
          isRequired
          validationBehavior="aria"
          className="max-w-sm"
        >
          <Label>主账号密码</Label>
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="每次查询都需验证;失败或取消后清空"
          />
        </TextField>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" isPending={loading} isDisabled={passwordDraft === ''}>
            查询候选
          </Button>
          <span className="text-xs text-muted">
            密码仅用于当次查询,不保存;失败或取消后立即清空。
          </span>
        </div>
      </form>

      {errorText !== null && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>候选查询失败</Alert.Title>
            <Alert.Description>{errorText}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}

      {/* 结果区:初始提示(含首查失败)/ 空结果 / 列表 + 翻页 */}
      {!queried ? (
        <p className="py-4 text-center text-sm text-muted">
          输入主账号密码后点击「查询候选」;结果可直接加入下方三名单。
        </p>
      ) : queried && items.length === 0 && !loading ? (
        <p className="py-4 text-center text-sm text-muted">没有匹配的候选，试试调整搜索或筛选。</p>
      ) : (
        <>
          <ul className="space-y-2">
            {items.map((candidate) => {
              const inAllowed = allowedSet.has(candidate.id);
              const inBlocked = blockedSet.has(candidate.id);
              const inChannel = channelSet.has(candidate.id);
              return (
                <li
                  key={candidate.id}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
                >
                  <MediaPosterPlaceholder title={candidate.title} className="h-14 w-10 text-lg" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-medium text-foreground">{candidate.title}</p>
                    <p className="flex flex-wrap items-center gap-1.5">
                      <Chip
                        size="sm"
                        variant="soft"
                        color="default"
                        aria-label={`类型 ${MEDIA_TYPE_LABELS[candidate.type]}`}
                      >
                        {MEDIA_TYPE_LABELS[candidate.type]}
                      </Chip>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={contentLevelChipColor(candidate.contentLevel)}
                        aria-label={`分级 ${contentLevelLabel(candidate.contentLevel)}`}
                      >
                        {contentLevelLabel(candidate.contentLevel)}
                      </Chip>
                      {!candidate.available && (
                        <Chip size="sm" variant="soft" color="warning" aria-label="不可用">
                          不可用
                        </Chip>
                      )}
                    </p>
                    {candidate.description !== null && (
                      <p className="truncate text-xs text-muted">{candidate.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={isAddDisabled || inAllowed}
                      onPress={() => onAddToAllowedMedia(candidate)}
                      aria-label={`将「${candidate.title}」加入媒体允许名单`}
                    >
                      {inAllowed ? '已在允许名单' : '加入允许'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      isDisabled={isAddDisabled || inBlocked}
                      onPress={() => onAddToBlockedMedia(candidate)}
                      aria-label={`将「${candidate.title}」加入媒体禁止名单`}
                    >
                      {inBlocked ? '已在禁止名单' : '加入禁止'}
                    </Button>
                    {candidate.type === 'channel' && (
                      <Button
                        size="sm"
                        variant="outline"
                        isDisabled={isAddDisabled || inChannel}
                        onPress={() => onAddToAllowedChannel(candidate)}
                        aria-label={`将频道「${candidate.title}」加入儿童频道允许名单`}
                      >
                        {inChannel ? '已在频道名单' : '加入频道允许'}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <nav aria-label="候选分页" className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-xs text-muted">
              第 {applied.page} / {totalPages} 页 · 共 {total} 个候选
              {loading && <Spinner size="sm" aria-label="加载中" />}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                isDisabled={passwordDraft === '' || loading || applied.page <= 1}
                onPress={() => changePage(applied.page - 1)}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                isDisabled={passwordDraft === '' || loading || applied.page >= totalPages}
                onPress={() => changePage(applied.page + 1)}
              >
                下一页
              </Button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
