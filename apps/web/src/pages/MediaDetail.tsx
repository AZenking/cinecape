/**
 * 媒体详情页(T038;T046 完善节目区,User Story 2/4;T052 接入播放,User Story 3)。
 *
 * - GET /media/{id}:标题/类型/分级/描述 + 海报占位(契约 poster 恒 null);
 *   不可用、不可见、不存在、跨家庭统一同形 404 → 「内容不存在或不存在同形文案,
 *   不区分原因」;403 ACTIVE_PROFILE_REQUIRED 显示「请先选择观看档案」引导;
 * - 硬性边界:无下载按钮、无任何第三方跳转;节目区不显示任何频道地址或
 *   EPG 来源信息(契约「UI 路由」);
 * - 播放接入(T052,US3,FR-009/010):可见性事实即页面已有媒体数据——GET
 *   /media/{id} 对被禁/不可见/不存在/跨家庭/无可用资源统一 404 同形,故详情
 *   加载成功(media 非 null)即代表当前档案可见可用,错误分支不渲染任何播放
 *   入口,前端不再另设门控字段;对加载成功的媒体渲染「播放」按钮,点击后在本
 *   页内嵌挂载 MediaPlayer + PlaybackControls(showFailureAlert=false 与播放器
 *   覆盖层 Alert 去重)。T053 起 seek/selection 意图接线经 usePlaybackSession
 *   的 mediaApi(播放器经 onMediaApi 交出):发送前递增 operationEpoch、
 *   expectedVersion CAS、受理 preparing 挂起与轮询接回、409 竞态族
 *   (GENERATION_STALE/VERSION_CONFLICT/ENDED/NOT_READY)丢弃旧意图——全部由
 *   hook 内部守卫,页面不再自行调 api.seekPlayback/api.selectTracks/记账
 *   version,也不因意图写任何状态;展示以 MediaPlayer 自身轮询/续期带回的状态
 *   为唯一来源;resolve 404
 *   MEDIA_NOT_FOUND 由 MediaPlayer 经 PLAYBACK_ERROR_LABELS 呈现「内容不存在
 *   或暂不可观看」,不显示策略细节;
 * - 播放代次守卫(页面层,T052/US3-05):档案(activeProfile.id)或媒体 id 变化
 *   即关闭播放面板——卸载 MediaPlayer(hook 卸载清理补发 stop、中止在途请求、
 *   销毁 hls)并丢弃已捕获的 state/controller/mediaApi,旧代次意图无从发出;
 *   播放器另以 key={profileId+mediaId} 强制重挂载兜底,hook 内部 runId 守卫
 *   再兜一层,旧代次响应不可能覆盖新语境或复活播放;
 * - 节目区(T046):仅 type=channel 请求 GET /media/{id}/programmes,按
 *   ProgrammesDto.status 渲染——available 且 current/next 有值时展示「当前节目/
 *   下一节目」标题与起止时间(formatProgrammeRange;家庭时区=浏览器本地时区,
 *   时间一律「按家庭时区展示」);status=unavailable、槽位为 null,以及
 *   404/403/网络失败等一切加载失败,统一静默降级为「暂无节目」,不区分原因、
 *   不显示技术细节;非频道类型不请求、不渲染节目区块;
 * - 会话代次废弃:详情与节目各持独立 guard,每次请求前 begin(),回写前
 *   isCurrent(gen) 校验;当前档案变化(activeProfile.id 进入依赖)即重开代次
 *   重查,旧档案响应一律丢弃(契约「UI 路由」:Profile 切换立即废弃原详情与节目结果);
 * - 返回列表:固定 /media 链接;全部交互为原生可聚焦元素;
 * - 手动 EPG 匹配(T072,FR-023～026):仅 owner + type=channel 渲染「EPG 匹配」
 *   按钮,打开 EpgBindingDialog 对话框;对话框为覆盖层,开合不干扰节目单展示,
 *   保存/解除成功(onBindingChanged)后仅重查节目单反映最新绑定。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Alert, Button, Chip, Spinner } from '@heroui/react';
import { ApiError, api, createGenerationGuard } from '../lib/api';
import { useSession } from '../lib/session';
import { MediaPosterPlaceholder } from '../components/catalog/PosterPlaceholder';
import { EpgBindingDialog } from '../components/epg/EpgBindingDialog';
import { MediaPlayer } from '../components/playback/MediaPlayer';
import type { MediaPlayerController, MediaPlayerState } from '../components/playback/MediaPlayer';
import type { PlaybackMediaApi } from '../components/playback/usePlaybackSession';
import { PlaybackControls } from '../components/playback/PlaybackControls';
import {
  CODE_ACTIVE_PROFILE_REQUIRED,
  MEDIA_TYPE_LABELS,
  contentLevelChipColor,
  contentLevelLabel,
  formatProgrammeRange,
  friendlyCatalogErrorMessage,
} from '../components/catalog/messages';
import type { MediaDto, ProgrammeDto, ProgrammesDto } from '@hmp/shared';

/** 详情加载失败态(404 与 403 分流展示;其余按通用失败处理) */
interface DetailErrorState {
  status: number | null;
  code: string | null;
  text: string;
}

/**
 * PlaybackControls 首拍占位状态(MediaPlayer 首次 onStateChange 前的准备中快照):
 * 不含任何会话事实(sessionId/version 均 null),控件层据此全量禁用,不发起意图。
 */
const INITIAL_PLAYER_STATE: MediaPlayerState = {
  phase: 'preparing',
  sessionId: null,
  version: null,
  generation: null,
  delivery: null,
  engine: null,
  durationSeconds: null,
  positionSeconds: 0,
  presentationStartSeconds: 0,
  desiredPaused: false,
  tracks: { audio: [], subtitles: [] },
  failureCode: null,
  failureMessage: null,
};

/** 单条节目行:标题 + 起止时间;null 槽位显示「暂无节目」 */
function ProgrammeRow({ label, slot }: { label: string; slot: ProgrammeDto | null }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">
        {slot === null ? (
          <span className="text-muted">暂无节目</span>
        ) : (
          `${slot.title}（${formatProgrammeRange(slot.startsAt, slot.endsAt)}）`
        )}
      </dd>
    </div>
  );
}

export function MediaDetail() {
  const params = useParams();
  /** 契约路径参数 :id;缺失按 404 语义处理 */
  const mediaId = params.id ?? '';
  const { session, refresh: refreshSession } = useSession();
  const navigate = useNavigate();

  /** 当前观看档案(会话语境;变化即作废旧响应并重查) */
  const activeProfileId = session?.activeProfile?.id ?? null;
  /** 是否 owner(手动 EPG 匹配管理入口仅 owner 可见,FR-023) */
  const isOwner = session?.account?.role === 'owner';

  /** 详情与节目各自独立代次守卫(互不误伤,可多实例并存) */
  const mediaGuard = useMemo(createGenerationGuard, []);
  const programmesGuard = useMemo(createGenerationGuard, []);

  /* ------------------------------ 详情数据 ------------------------------ */
  const [media, setMedia] = useState<MediaDto | null>(null);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState<DetailErrorState | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  /* ----------------------- 节目区状态(仅 channel;T046) ----------------------- */

  const [programmes, setProgrammes] = useState<ProgrammesDto | null>(null);
  const [programmesLoading, setProgrammesLoading] = useState(false);

  /* ------------------ 手动 EPG 匹配对话框(owner;T072) ------------------ */

  const [epgDialogOpen, setEpgDialogOpen] = useState(false);
  /** 保存/解除成功后递增,驱动节目单按最新绑定重查(对话框开合本身不触发) */
  const [programmesReloadToken, setProgrammesReloadToken] = useState(0);

  /* -------------- 播放接入(T052;T053 意图接线经 usePlaybackSession.mediaApi) -------------- */

  /** 播放面板开合;档案/媒体 id 变化由下方代次守卫 effect 强制关闭 */
  const [playbackOpen, setPlaybackOpen] = useState(false);
  /** MediaPlayer 状态快照(onStateChange 回填;null=首拍未到,控件用准备中占位) */
  const [playerState, setPlayerState] = useState<MediaPlayerState | null>(null);
  /** MediaPlayer 命令句柄(onController 回填;null=未挂载,控件命令全禁用) */
  const [playerController, setPlayerController] = useState<MediaPlayerController | null>(null);
  /** MediaPlayer 播放操作面(onMediaApi 回填;seek/selection 竞态守卫在 hook 内部) */
  const mediaApiRef = useRef<PlaybackMediaApi | null>(null);
  /** controller/mediaApi 句柄镜像(供 closePlayer/意图回调读取最新值) */
  const playerControllerRef = useRef<MediaPlayerController | null>(null);

  useEffect(() => {
    // 页面层代次守卫(US3-05):档案(activeProfile.id 进入依赖)或媒体 id 变化即
    // 销毁播放器并丢弃旧代次——关闭面板卸载 MediaPlayer(hook 卸载清理补发 stop、
    // 中止在途请求、销毁 hls),同时丢弃已捕获的 state/controller/mediaApi,
    // 旧代次的 seek/selection 意图因此无从发出;下方 key={profileId+mediaId}
    // 强制重挂载与 hook 内部 runId 守卫再各兜一层。
    setPlaybackOpen(false);
    setPlayerState(null);
    setPlayerController(null);
    playerControllerRef.current = null;
    mediaApiRef.current = null;
  }, [activeProfileId, mediaId]);

  useEffect(() => {
    const gen = mediaGuard.begin();
    let discarded = false;
    const load = async (): Promise<void> => {
      // 清空旧数据:档案切换/换 id 时旧内容不滞留
      setMedia(null);
      setMediaError(null);
      setProgrammes(null);
      setProgrammesLoading(false);
      setMediaLoading(true);
      try {
        const dto = await api.getMedia(mediaId);
        if (discarded || !mediaGuard.isCurrent(gen)) {
          return; // 旧代次响应:一律丢弃
        }
        setMedia(dto);
      } catch (error) {
        if (discarded || !mediaGuard.isCurrent(gen)) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          // 401 交给现有会话处理:refresh → SessionProvider 置匿名 → 路由守卫转登录
          void refreshSession();
        }
        setMediaError({
          status: error instanceof ApiError ? error.status : null,
          code:
            error instanceof ApiError && typeof error.code === 'string' ? error.code : null,
          text: friendlyCatalogErrorMessage(error, '内容加载失败，请稍后重试。'),
        });
      } finally {
        if (!discarded && mediaGuard.isCurrent(gen)) {
          setMediaLoading(false);
        }
      }
    };
    void load();
    return () => {
      discarded = true;
    };
  }, [activeProfileId, mediaGuard, mediaId, refreshSession, retryToken]);

  /* ----------------------- 节目区加载(仅 channel;T046) ----------------------- */

  useEffect(() => {
    if (media === null || media.type !== 'channel') {
      return;
    }
    const gen = programmesGuard.begin();
    let discarded = false;
    const load = async (): Promise<void> => {
      setProgrammes(null);
      setProgrammesLoading(true);
      try {
        const dto = await api.getMediaProgrammes(media.id);
        if (discarded || !programmesGuard.isCurrent(gen)) {
          return;
        }
        setProgrammes(dto);
      } catch (error) {
        if (discarded || !programmesGuard.isCurrent(gen)) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          // 401 与详情本体一致交给现有会话处理;其余(404/403/网络失败等)
          // 一律静默降级为「暂无节目」,不区分原因、不显示技术细节
          void refreshSession();
        }
        setProgrammes(null);
      } finally {
        if (!discarded && programmesGuard.isCurrent(gen)) {
          setProgrammesLoading(false);
        }
      }
    };
    void load();
    return () => {
      discarded = true;
    };
  }, [media, programmesGuard, programmesReloadToken, refreshSession]);

  /* ------------------------------ 交互回调 ------------------------------ */

  const retry = useCallback((): void => {
    setRetryToken((token) => token + 1);
  }, []);

  const goPickProfile = useCallback((): void => {
    void navigate('/');
  }, []);

  /* -------------- 播放交互(T052;T053 意图接线迁移 mediaApi) -------------- */

  const openPlayer = useCallback((): void => {
    setPlaybackOpen(true);
  }, []);

  const closePlayer = useCallback((): void => {
    // 先经句柄主动补发 stop(fire-and-forget、幂等),再卸载面板;卸载清理仍会兜底
    playerControllerRef.current?.stop();
    setPlaybackOpen(false);
    setPlayerState(null);
    setPlayerController(null);
    mediaApiRef.current = null;
  }, []);

  const handlePlayerStateChange = useCallback((state: MediaPlayerState): void => {
    // 展示以播放器自身轮询/续期带回的状态为唯一来源;页面不因意图写任何状态。
    // 新会话的换轨意图作废由 hook 内部处理(新会话即重置最近意图)。
    setPlayerState(state);
  }, []);

  const handlePlayerController = useCallback((controller: MediaPlayerController | null): void => {
    playerControllerRef.current = controller;
    setPlayerController(controller);
  }, []);

  const handlePlayerMediaApi = useCallback((mediaApi: PlaybackMediaApi | null): void => {
    mediaApiRef.current = mediaApi;
  }, []);

  /**
   * seek 意图接线(T053):转发 hook 的 mediaApi.seek——发送前递增 operationEpoch、
   * expectedVersion CAS、受理 preparing 挂起 → 轮询接回 ready → 新代 renew 全部在
   * hook 内部;409 竞态族与网络失败由 hook 丢弃意图,不破坏当前播放,页面无感知。
   */
  const handleSeekIntent = useCallback((positionSeconds: number): void => {
    mediaApiRef.current?.seek(positionSeconds);
  }, []);

  /**
   * 换轨/字幕意图接线(T053):转发 mediaApi.selectTracks;双轴回落(最近意图 →
   * default → 首个已探测/字幕关闭)与纯字幕切换不换代连续播均由 hook 处理。
   */
  const handleSelectTracks = useCallback(
    (audioTrackId?: string, subtitleTrackId?: string | null): void => {
      mediaApiRef.current?.selectTracks(audioTrackId, subtitleTrackId);
    },
    [],
  );

  /* ------------------------------- 渲染 ------------------------------- */

  if (mediaLoading) {
    return (
      <section className="space-y-6">
        <Link
          to="/media"
          className="inline-flex rounded text-sm text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          ← 返回目录
        </Link>
        <div className="flex flex-col items-center gap-3 py-12">
          <Spinner size="lg" />
          <p className="text-sm text-muted">正在加载内容…</p>
        </div>
      </section>
    );
  }

  if (media === null) {
    // mediaError 必然非空(加载结束既无数据也无错误只发生在旧代次被丢弃后重查)
    const error = mediaError;
    if (error !== null && error.status === 404) {
      // 不可用/不可见/不存在/跨家庭统一同形,不区分原因(契约 GET /media/{id})
      return (
        <section className="space-y-6">
          <Link
            to="/media"
            className="inline-flex rounded text-sm text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            ← 返回目录
          </Link>
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>内容不存在或不可见</Alert.Title>
              <Alert.Description>该内容不存在，或对当前观看档案不可见。</Alert.Description>
            </Alert.Content>
          </Alert>
        </section>
      );
    }
    if (error !== null && error.code === CODE_ACTIVE_PROFILE_REQUIRED) {
      return (
        <section className="space-y-6">
          <Link
            to="/media"
            className="inline-flex rounded text-sm text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            ← 返回目录
          </Link>
          <div className="space-y-4">
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>请先选择观看档案</Alert.Title>
                <Alert.Description>{error.text}</Alert.Description>
              </Alert.Content>
            </Alert>
            <Button variant="outline" onPress={goPickProfile}>
              去选择档案
            </Button>
          </div>
        </section>
      );
    }
    return (
      <section className="space-y-6">
        <Link
          to="/media"
          className="inline-flex rounded text-sm text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          ← 返回目录
        </Link>
        <div className="space-y-4">
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>内容加载失败</Alert.Title>
              <Alert.Description>{error?.text ?? '内容加载失败，请稍后重试。'}</Alert.Description>
            </Alert.Content>
          </Alert>
          <Button variant="outline" onPress={retry}>
            重试
          </Button>
        </div>
      </section>
    );
  }

  // 契约语义(T046):仅 status=available 且槽位有值才展示节目;
  // unavailable / null(未关联、禁用、冲突、无匹配、加载失败)统一「暂无节目」
  const programmesAvailable = programmes?.status === 'available';
  const current = programmesAvailable ? (programmes?.current ?? null) : null;
  const next = programmesAvailable ? (programmes?.next ?? null) : null;

  /** 播放器重挂载键:档案或媒体 id 变化即销毁旧播放器并丢弃旧代次(T052/US3-05) */
  const playerKey = `${activeProfileId ?? 'no-profile'}:${mediaId}`;
  /** 控件状态:首拍前以准备中占位(sessionId/version 为 null,控件全禁用) */
  const controlsState = playerState ?? INITIAL_PLAYER_STATE;

  return (
    <section className="space-y-6">
      <Link
        to="/media"
        className="inline-flex rounded text-sm text-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        ← 返回目录
      </Link>

      {/* 基本信息区:无下载按钮、无第三方跳转;播放入口(T052)仅对当前档案可见可用媒体开放 */}
      <div className="flex flex-col gap-6 sm:flex-row">
        <MediaPosterPlaceholder title={media.title} className="h-40 w-28 text-4xl" />
        <div className="min-w-0 space-y-3">
          <h1 className="text-xl font-semibold text-foreground">{media.title}</h1>
          <p className="flex flex-wrap items-center gap-2">
            <Chip
              size="sm"
              variant="soft"
              color="default"
              aria-label={`类型 ${MEDIA_TYPE_LABELS[media.type]}`}
            >
              {MEDIA_TYPE_LABELS[media.type]}
            </Chip>
            <Chip
              size="sm"
              variant="soft"
              color={contentLevelChipColor(media.contentLevel)}
              aria-label={`分级 ${contentLevelLabel(media.contentLevel)}`}
            >
              {contentLevelLabel(media.contentLevel)}
            </Chip>
          </p>
          <p className="max-w-2xl whitespace-pre-line text-sm text-muted">
            {media.description ?? '暂无描述。'}
          </p>
          {/* 播放入口(T052,FR-009):media 非 null 即当前档案可见可用——GET /media/{id}
              对被禁/不可见/不存在/跨家庭统一 404 同形(错误分支到不了这里),页面按
              已有可见性事实开放入口,不另设门控;面板打开后隐藏入口避免重复起播 */}
          {!playbackOpen && (
            <div>
              <Button variant="primary" onPress={openPlayer} aria-label={`播放 ${media.title}`}>
                播放
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* 播放面板(T052):内嵌于基本信息与节目区之间,开合不影响目录/EPG 区块。
          key=档案+媒体 id:档案或 id 变化即销毁旧播放器实例(卸载清理补发 stop、
          中止在途、销毁 hls)并重开新会话,MediaPlayer 内部 runId 守卫兜底。
          resolve 404 MEDIA_NOT_FOUND 等稳定失败由 MediaPlayer 以 PLAYBACK_ERROR_LABELS
          文案呈现(「内容不存在或暂不可观看」),不显示任何策略细节;控件层失败
          Alert 与播放器覆盖层同文案,showFailureAlert=false 去重。 */}
      {playbackOpen && (
        <div className="space-y-3 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-medium text-foreground">播放</h2>
            <Button
              size="sm"
              variant="outline"
              onPress={closePlayer}
              aria-label="关闭播放器并停止播放"
            >
              关闭播放器
            </Button>
          </div>
          <MediaPlayer
            key={playerKey}
            mediaId={mediaId}
            className="aspect-video"
            onStateChange={handlePlayerStateChange}
            onController={handlePlayerController}
            onMediaApi={handlePlayerMediaApi}
          />
          <PlaybackControls
            state={controlsState}
            controller={playerController}
            onSeekIntent={handleSeekIntent}
            onSelectTracks={handleSelectTracks}
            showFailureAlert={false}
          />
        </div>
      )}

      {/* 节目区(T046):仅频道类型请求与渲染;unavailable/加载失败统一「暂无节目」,
          不区分原因、不显示技术细节,也不出现任何频道地址/EPG 来源信息。
          起止时间按家庭时区展示(单家庭局域网部署,家庭时区=浏览器本地时区)。
          节目区本身不展示 EPG 来源;手动匹配入口(T072)仅 owner 可见,
          目标来源等信息只在 owner 主动打开的 EpgBindingDialog 内出现。 */}
      {media.type === 'channel' && (
        <div className="rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-medium text-foreground">节目单</h2>
              <p className="mt-1 text-xs text-muted">当前与下一节目(起止时间按家庭时区展示)。</p>
            </div>
            {isOwner && (
              <Button
                size="sm"
                variant="outline"
                onPress={() => setEpgDialogOpen(true)}
                aria-label="手动 EPG 匹配"
              >
                EPG 匹配
              </Button>
            )}
          </div>
          {programmesLoading ? (
            <div className="flex items-center gap-3 py-6">
              <Spinner size="sm" aria-label="加载节目" />
              <p className="text-sm text-muted">正在获取节目单…</p>
            </div>
          ) : current === null && next === null ? (
            <p className="py-6 text-sm text-muted">暂无节目。</p>
          ) : (
            <dl className="mt-3 space-y-3">
              <ProgrammeRow label="当前节目" slot={current} />
              <ProgrammeRow label="下一节目" slot={next} />
            </dl>
          )}
        </div>
      )}

      {/* 手动 EPG 匹配对话框(T072):仅 owner + 频道渲染;覆盖层开合不干扰节目单,
          保存/解除成功后经 onBindingChanged 重查节目单反映最新绑定 */}
      {isOwner && media.type === 'channel' && (
        <EpgBindingDialog
          isOpen={epgDialogOpen}
          mediaId={media.id}
          mediaTitle={media.title}
          onClose={() => setEpgDialogOpen(false)}
          onBindingChanged={() => setProgrammesReloadToken((token) => token + 1)}
        />
      )}
    </section>
  );
}
