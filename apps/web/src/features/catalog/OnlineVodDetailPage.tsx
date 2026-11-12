import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button } from '@heroui/react';
import type { Vod } from '@hmp/shared';
import { useAppMutation, useAppQuery } from '../../shared/query/hooks';
import { queryKeys } from '../../shared/query/keys';
import { formatApiError } from '../../shared/query/error';
import { isFetchApiError, privateFetch, publicFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { useSession } from '../../app/session-provider';
import { aggregateLines } from './aggregate-lines';

type VodPreviewDto = Vod.components['schemas']['VodPreview'];
type VodPreviewEpisodeDto = Vod.components['schemas']['VodPreviewEpisode'];
type MaterializedDto = Vod.components['schemas']['Materialized'];

/**
 * 在线点播临时详情页(010 T033,US1;/vod/titles/:titleRef;contracts/api.md
 * §1 VodPreview/Materialized、§3 物化严格 oneOf、§6 恢复动作;ui.md §1)。
 *
 * - 预览为公共投影:游客可看,取数全经 publicFetch(omit 档),零个人请求;
 * - 线路按 lineRef 聚合(消费端规则,api.md §2;与稳定父详情 MediaDetailPage
 *   同一规则):同 lineRef 重复出现合并为一个线路组,组内集按 episodeRef 去重,
 *   不重复渲染;
 * - 选集(仅 candidate):游客→「登录」提示,**不发物化**;已选档→
 *   POST /vod/materializations,载荷恰为 {titleRef,episodeRef,previewRevision,
 *   operationKey:UUID}(revision 取自当前预览;operationKey 客户端 UUID);
 *   幂等:同一选择在途期间忽略重复提交(等价「复用同一 operationKey」,
 *   T032 D2 允许至多重发同 key);
 * - 201 → navigate /media/:parentMediaId(物化成功才进稳定详情;预览页永不
 *   永久入库、不写历史,ui.md §1);
 * - 409 VOD_DETAIL_CHANGED / 410 VOD_PREVIEW_EXPIRED:role=alert 明确呈现,
 *   清预览缓存重读,**不自动重试旧 ref**——预览刷新后由用户明确重选(api.md §6);
 * - unsupported 集:aria-disabled="true"(RAC 惯例)呈现不可选,按 reason 显示
 *   (format_unsupported→「格式不支持」),点击不触发物化。
 *
 * 查询键(T034 已收编公共键工厂 keys.ts):`['public','vod','preview', titleRef]`。
 */
/** 键取自公共键工厂(T034);409/410 失效仍经 Provider 注入的 useQueryClient 实例 */
const previewQueryKey = (titleRef: string): readonly unknown[] => queryKeys.public.vodPreview(titleRef);

/** 详情页主题海报占位(DESIGN.md 媒体 token;无海报/代理失败共用) */
function DetailPosterPlaceholder(): ReactNode {
  return (
    <div
      className="flex w-full max-w-md items-center justify-center text-sm text-muted"
      style={{
        aspectRatio: 'var(--hmp-media-ratio-poster)',
        backgroundColor: 'var(--hmp-media-poster-placeholder)',
        borderRadius: 'var(--hmp-media-card-radius)',
      }}
    >
      无海报
    </div>
  );
}

/**
 * 详情页同源代理海报(010:posterRef → GET /api/public/vod/posters/:posterRef)。
 * onError 回落占位(ref 过期/代理失败不显示裂图);失败态按次挂载记忆,
 * 重放重挂时重试一次(预览快照刷新由用户侧驱动)。
 */
function DetailPosterImage({ posterRef }: { posterRef: string }): ReactNode {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <DetailPosterPlaceholder />;
  }
  return (
    <img
      src={`/api/public/vod/posters/${encodeURIComponent(posterRef)}`}
      alt=""
      onError={() => setFailed(true)}
      style={{
        aspectRatio: 'var(--hmp-media-ratio-poster)',
        width: '100%',
        maxWidth: '28rem',
        objectFit: 'cover',
        borderRadius: 'var(--hmp-media-card-radius)',
        backgroundColor: 'var(--hmp-media-poster-placeholder)',
      }}
    />
  );
}

/** unsupported reason → 面向观看者的文字(不裸暴露机器码) */
const UNSUPPORTED_REASON_LABELS: Record<'identity_ambiguous' | 'format_unsupported', string> = {  format_unsupported: '格式不支持',
  identity_ambiguous: '同一名称多个候选版本，暂不支持直接选集',
};

/** 物化 operationKey:客户端 UUID(api.md §3 format:uuid;settings 同款惯例) */
function newOperationKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 「内容不存在或已下架」视图:404(跨家庭/伪造/下架同形)不泄露存在性 */
function NotFoundView(): ReactNode {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold text-foreground">内容不存在或已下架</h1>
      <p className="max-w-prose text-sm text-muted">该内容当前不可浏览，可返回在线搜索查看其他内容。</p>
      <Link
        to="/vod?mode=online"
        className="rounded px-1 text-sm font-medium text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        返回在线搜索
      </Link>
    </section>
  );
}

interface MaterializeVars {
  titleRef: string;
  episodeRef: string;
  previewRevision: number;
  operationKey: string;
}

export function OnlineVodDetailPage(): ReactNode {
  const { titleRef } = useParams<{ titleRef: string }>();
  const navigate = useNavigate();
  const session = useSession();
  // Provider 注入的 QueryClient(与页面查询同实例;缓存失效必须落在同一 client,
  // 测试/应用经 wrapper 注入各自的 client,不可用模块级单例)
  const queryClient = useQueryClient();

  const hasTitleRef = titleRef !== undefined && titleRef !== '';
  const previewKey = previewQueryKey(titleRef ?? '');
  const {
    data: preview,
    isPending,
    isError,
    error,
    refetch,
  } = useAppQuery<VodPreviewDto>({
    domain: 'public',
    queryKey: previewKey,
    queryFn: ({ signal }) =>
      publicFetch<VodPreviewDto>(`/public/vod/titles/${encodeURIComponent(titleRef ?? '')}`, { signal }),
    enabled: hasTitleRef,
  });

  // 物化(Profile 档,privateFetch):页内 role=alert 呈现失败并给出恢复动作,
  // 不再叠加全局 Toast(单一反馈源;onToast 注入 no-op 抑制)
  const materialize = useAppMutation<MaterializeVars, MaterializedDto>({
    domain: 'profile',
    feedback: 'confirmed',
    mutationFn: (vars) =>
      privateFetch<MaterializedDto>('/vod/materializations', { method: 'POST', body: vars }),
    onToast: () => undefined,
  });

  // 幂等:同一选择在途期间忽略重复提交(D2:至多一次调用/重发同 key);
  // onSettled 复位,失败后的下一次明确点击换新 operationKey(E1 断言)
  const inFlightRef = useRef(false);
  // 游客选集:进入已有登录/选档流程提示,不发物化、不跳稳定详情(F1)
  const [loginHint, setLoginHint] = useState(false);

  const hasActiveProfile = session.status === 'authenticated' && session.session?.activeProfile != null;

  function selectEpisode(episode: VodPreviewEpisodeDto): void {
    if (preview === undefined) {
      return;
    }
    if (episode.status !== 'candidate') {
      return; // unsupported:aria-disabled 呈现,点击不产生物化(C2)
    }
    if (!hasActiveProfile) {
      setLoginHint(true); // 游客:登录提示,不发物化、不跳转(F1)
      return;
    }
    if (inFlightRef.current) {
      return; // 在途重复提交:忽略(等价复用同一 operationKey,D2)
    }
    setLoginHint(false);
    inFlightRef.current = true;
    materialize.mutate(
      {
        titleRef: preview.titleRef,
        episodeRef: episode.episodeRef,
        previewRevision: preview.previewRevision,
        operationKey: newOperationKey(),
      },
      {
        onSuccess: (data) => {
          // 物化成功才跳稳定详情;预览页不入库、不写历史(ui.md §1)
          void navigate(`/media/${data.parentMediaId}`);
        },
        onError: (mutationError) => {
          // 409 VOD_DETAIL_CHANGED / 410 VOD_PREVIEW_EXPIRED:清预览缓存重读;
          // 不自动重试旧 ref,预览刷新后由用户明确重选(api.md §6)
          if (isFetchApiError(mutationError) && (mutationError.status === 409 || mutationError.status === 410)) {
            void queryClient.invalidateQueries({ queryKey: previewKey, refetchType: 'all' });
          }
        },
        onSettled: () => {
          inFlightRef.current = false;
        },
      },
    );
  }

  if (!hasTitleRef) {
    return <NotFoundView />;
  }

  if (isPending) {
    return <LoadingSpinner label="加载预览…" />;
  }

  if (isError) {
    if (isFetchApiError(error) && error.status === 404) {
      return <NotFoundView />;
    }
    return (
      <RetryableAlert
        title="预览加载失败"
        description={formatApiError(error)}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  if (preview === undefined) {
    return null; // 不可达:成功态必有 data
  }

  // 线路聚合(消费端规则,与 StableEpisodes 同一规则):同 lineRef 合并、组内去重
  const lines = aggregateLines(preview.lines, (episode) => episode.episodeRef);
  const materializeError = materialize.isError ? materialize.error : null;

  return (
    <section className="flex flex-col gap-6">
      {/* 返回入口:不重复渲染标题文本(标题唯一出现在下方 h1,供精确文本定位) */}
      <nav aria-label="路径" className="text-sm text-muted">
        <Link
          to="/vod?mode=online"
          className="rounded text-accent underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          返回在线搜索
        </Link>
      </nav>

      <div className="flex flex-col gap-5 sm:flex-row">
        {/* 海报:有 posterRef 走同源代理(失败回落占位);无则主题占位 */}
        {preview.posterRef !== null ? <DetailPosterImage posterRef={preview.posterRef} /> : <DetailPosterPlaceholder />}
        <div className="flex min-w-0 flex-col gap-3">
          <h1 className="text-2xl font-semibold text-foreground">{preview.title}</h1>
          <p className="text-sm text-muted">
            {preview.year ?? '年份未知'} · {preview.sourceLabel}
          </p>
          {preview.description !== null ? (
            <p className="max-w-prose text-sm leading-6 text-foreground">{preview.description}</p>
          ) : null}

          {/* 物化失败(409/410/其他):明确呈现,不自动重试;恢复动作按 api.md §6 */}
          {materializeError !== null && isFetchApiError(materializeError) ? (
            <div role="alert">
              <Alert status="danger" className="w-full">
                <Alert.Content>
                  <Alert.Title>
                    {materializeError.code === 'VOD_DETAIL_CHANGED'
                      ? '内容已更新，请重新选择'
                      : materializeError.code === 'VOD_PREVIEW_EXPIRED'
                        ? '预览已过期，已重新预览'
                        : formatApiError(materializeError)}
                  </Alert.Title>
                  <Alert.Description>
                    预览已刷新为最新内容，请重新选择集数；不会自动重试先前的选择。
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            </div>
          ) : null}

          {/* 游客选集引导:进入已有登录/选档流程,不发物化(F1) */}
          {loginHint ? (
            <p role="note" className="text-sm text-foreground">
              选集播放前需要先登录并选择观看档案。
            </p>
          ) : null}

          <div aria-busy={materialize.isPending} className="flex flex-col gap-4">
            {lines.map((line) => (
              <div key={line.lineRef} className="flex flex-col gap-2">
                <h2 className="text-sm font-medium text-foreground">{line.name}</h2>
                <ul className="flex flex-wrap gap-2">
                  {line.episodes.map((episode) => (
                    <li key={episode.episodeRef} className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant={episode.status === 'candidate' ? 'secondary' : 'ghost'}
                        aria-disabled={episode.status === 'unsupported' ? true : undefined}
                        onPress={() => {
                          selectEpisode(episode);
                        }}
                      >
                        {episode.label}
                      </Button>
                      {episode.status === 'unsupported' && episode.reason !== null ? (
                        <span className="text-xs text-muted">
                          {UNSUPPORTED_REASON_LABELS[episode.reason]}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
