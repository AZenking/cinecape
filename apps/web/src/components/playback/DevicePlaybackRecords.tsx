/**
 * 设备播放记录查询(T046,US2b / FR-007)。
 *
 * - 家长在设备页输入主账号密码 → POST /devices/{deviceId}/playback-records/query
 *   → 渲染脱敏记录列表(session:时间/媒体标识/状态/开始结束/失败码;failure:时间/稳定码);
 *   绝不渲染 playbackSourceId/location/路径等源信息(契约保证响应不含,组件亦不透传展示)。
 * - 复用家长验证交互惯例(对齐 ParentVerificationModal/ParentCandidatePicker):
 *   密码 type=password、仅存本组件内存(不持久化、不写 URL/日志),每次查询随 body 独立校验;
 *   查询失败(含 403/423)立即清空密码;成功保留于内存以支持「加载更多」翻页,组件卸载即释放。
 * - 错误分流:403(家长验证 REQUIRED/FAILED)→ 提示并清密码;423(PARENT_VERIFICATION_LOCKED)
 *   → 锁定提示并禁用输入至服务端锁定窗口结束(用户收起面板重开即重置);401 → 交给现有
 *   会话处理(refresh → 匿名 → 路由守卫转登录);404 → 固定文案「无法查询该设备记录」,
 *   不泄漏设备存在性;其余 → 通用错误提示。
 * - 分页:nextCursor 非 null 时显示「加载更多」,携带 cursor 原样回传;键盘可达
 *   (form Enter 提交、按钮可聚焦,对齐项目现有 HeroUI 表单惯例)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Chip, FieldError, Input, Label, Spinner, TextField } from '@heroui/react';
import { ApiError, api } from '../../lib/api';
import { useSession } from '../../lib/session';
import type {
  PlaybackRecordItem,
  PlaybackRecordPage,
  PlaybackSessionRecord,
} from '@hmp/shared';

/** 单页条数(契约 limit 默认 20、最大 100;组件固定按默认值请求) */
const RECORD_PAGE_SIZE = 20;

/** 播放会话状态中文标签(契约 PlaybackSessionState) */
const SESSION_STATE_LABELS: Record<PlaybackSessionRecord['state'], string> = {
  preparing: '准备中',
  ready: '待播放',
  playing: '播放中',
  paused: '已暂停',
  ended: '已结束',
  failed: '失败',
  interrupted: '已中断',
};

/** 会话状态 → Chip 语义色(仅展示,不影响逻辑) */
function sessionStateTone(state: PlaybackSessionRecord['state']): 'success' | 'warning' | 'danger' | 'default' {
  switch (state) {
    case 'playing':
      return 'success';
    case 'preparing':
    case 'ready':
    case 'paused':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'default';
  }
}

/** date-time → 本地化展示;空/非法值显示「—」(对齐 Devices.tsx 同名工具语义) */
function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** kind 判别守卫:session(13 键) / failure(6 键) */
function isSessionRecord(item: PlaybackRecordItem): item is PlaybackSessionRecord {
  return item.kind === 'session';
}

interface RecordNotice {
  tone: 'danger' | 'warning';
  text: string;
}

/** 单条记录行(session / failure 双形态渲染;只输出稳定脱敏字段) */
function RecordItemRow({ item }: { item: PlaybackRecordItem }) {
  return (
    <li className="space-y-1.5 rounded-md border border-default-200 p-3">
      {isSessionRecord(item) ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip size="sm" variant="soft" color={sessionStateTone(item.state)}>
              {SESSION_STATE_LABELS[item.state]}
            </Chip>
            <span className="text-sm">{formatDateTime(item.createdAt)}</span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted sm:grid-cols-[auto_auto_1fr]">
            <dt>媒体标识</dt>
            <dd className="break-all font-mono">{item.mediaId}</dd>
            <dt>开始</dt>
            <dd>{formatDateTime(item.startedAt)}</dd>
            <dt>结束</dt>
            <dd>
              {formatDateTime(item.endedAt)}
              {item.failureCode !== null && (
                <>
                  {' '}
                  <span className="break-all">
                    失败码 <code>{item.failureCode}</code>
                  </span>
                </>
              )}
            </dd>
          </dl>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft" color="danger">
            解析失败
          </Chip>
          <span className="text-sm">{formatDateTime(item.occurredAt)}</span>
          <span className="break-all text-xs text-muted">
            稳定码 <code>{item.stableCode}</code>
          </span>
        </div>
      )}
    </li>
  );
}

export function DevicePlaybackRecords({ deviceId }: { deviceId: string }) {
  const { refresh: refreshSession } = useSession();

  const [password, setPassword] = useState('');
  const [page, setPage] = useState<PlaybackRecordPage | null>(null);
  const [querying, setQuerying] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notice, setNotice] = useState<RecordNotice | null>(null);
  /** 423 锁定:输入与按钮整体禁用,等待服务端锁定窗口结束(收起面板重开即重置) */
  const [locked, setLocked] = useState(false);

  /** 在途请求控制器:重新查询/组件卸载时 abort,旧响应以 AbortError 静默结束 */
  const controllerRef = useRef<AbortController | null>(null);

  // 卸载时中止在途请求(避免离开面板后仍回写状态)
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const pending = querying || loadingMore;

  /**
   * 查询/翻页统一入口。cursor=null 为首页查询,cursor 非 null 携带上一响应
   * nextCursor 原样回传。密码随每次请求独立提交,由服务端逐次校验。
   */
  const runQuery = useCallback(
    async (cursor: string | null): Promise<void> => {
      if (pending || password === '') {
        return;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const isMore = cursor !== null;
      if (isMore) {
        setLoadingMore(true);
      } else {
        setQuerying(true);
        setPage(null);
      }
      setNotice(null);
      try {
        const result = await api.queryDevicePlaybackRecords(
          deviceId,
          {
            ownerPassword: password,
            cursor: cursor ?? undefined,
            limit: RECORD_PAGE_SIZE,
          },
          controller.signal,
        );
        if (controller.signal.aborted) {
          return; // 已被新查询/卸载取代:丢弃旧响应
        }
        setPage((prev) =>
          isMore && prev !== null
            ? { items: [...prev.items, ...result.items], nextCursor: result.nextCursor }
            : result,
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        // 查询失败一律清空密码(US2b:失败清密码)
        setPassword('');
        if (error instanceof ApiError && error.status === 401) {
          // 401 交给现有会话处理:refresh → SessionProvider 置匿名 → 路由守卫转登录
          void refreshSession();
          setNotice({ tone: 'danger', text: '登录状态已失效,请重新登录后再试。' });
        } else if (error instanceof ApiError && error.status === 423) {
          setLocked(true);
          setNotice({
            tone: 'warning',
            text:
              error.detail ??
              '验证失败次数过多,已临时锁定;请稍后收起本面板并重新打开再试。',
          });
        } else if (error instanceof ApiError && error.status === 403) {
          setNotice({
            tone: 'danger',
            text: error.detail ?? '家长验证未通过,请重新输入密码。',
          });
        } else if (error instanceof ApiError && error.status === 404) {
          // 设备不存在/跨家庭统一同形 404:固定文案,不泄漏设备存在性
          setNotice({ tone: 'danger', text: '无法查询该设备记录' });
        } else {
          setNotice({
            tone: 'danger',
            text:
              error instanceof ApiError
                ? (error.detail ?? '查询失败,请稍后重试。')
                : '查询失败,请检查网络后重试。',
          });
        }
      } finally {
        if (!controller.signal.aborted) {
          if (isMore) {
            setLoadingMore(false);
          } else {
            setQuerying(false);
          }
        }
      }
    },
    [deviceId, password, pending, refreshSession],
  );

  return (
    <div className="space-y-4">
      {/* 查询表单:锁定期间整体禁用,等待服务端锁定窗口结束 */}
      <form
        className="space-y-3"
        aria-label="查询设备播放记录"
        onSubmit={(event) => {
          event.preventDefault();
          void runQuery(null);
        }}
      >
        <TextField
          value={password}
          onChange={(value) => setPassword(value)}
          isDisabled={pending || locked}
          isRequired
          validationBehavior="aria"
          fullWidth
        >
          <Label>主账号密码</Label>
          <Input type="password" autoComplete="current-password" placeholder="主账号登录密码" />
          <FieldError>{password === '' ? '请输入密码' : undefined}</FieldError>
        </TextField>
        {notice && (
          <Alert status={notice.tone}>
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>{notice.tone === 'warning' ? '已临时锁定' : '查询失败'}</Alert.Title>
              <Alert.Description>{notice.text}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <Button
          type="submit"
          variant="primary"
          isPending={querying}
          isDisabled={pending || locked || password === ''}
        >
          查询播放记录
        </Button>
      </form>

      {/* 结果区:查询中 / 错误后空态 / 空记录 / 列表 + 加载更多 */}
      {querying ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <Spinner size="lg" />
          <p className="text-sm text-muted">正在查询播放记录…</p>
        </div>
      ) : page !== null && page.items.length > 0 ? (
        <div className="space-y-3">
          <ul className="space-y-2" aria-label="播放记录列表">
            {page.items.map((item) => (
              <RecordItemRow key={item.id} item={item} />
            ))}
          </ul>
          {page.nextCursor !== null && (
            <Button
              variant="outline"
              isPending={loadingMore}
              isDisabled={pending || locked || password === ''}
              onPress={() => void runQuery(page.nextCursor)}
            >
              加载更多
            </Button>
          )}
        </div>
      ) : page !== null ? (
        <p className="py-4 text-sm text-muted">暂无播放记录。</p>
      ) : (
        !notice && <p className="py-4 text-sm text-muted">输入主账号密码后即可查询该设备的播放记录。</p>
      )}
    </div>
  );
}
