import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertDialog, Button, Chip, Input, Label, ListBox, Modal, Select, Switch, Tabs, TextField } from '@heroui/react';
import { Check, Copy, Plus, Radio, Search, Star, Trash2, Tv, Upload } from 'lucide-react';
import { useAppToast } from '../../../shared/ui';
import {
  settingsApi,
  type CandidateDto,
  type ChannelStreamDto,
  type EpgBindingDto,
  type EpgCandidate,
  type SourceDto,
} from '../shared/settings-api';

const EMPTY_EPG_SOURCES: SourceDto[] = [];

/**
 * 绑定目标显示名回退(018):绑定查询响应未带 displayName 时,查当前已加载的候选
 * 页(同源候选,零额外请求);仍无 → null(调用方呈现「名称不可用」,技术 ID 恒可见)。
 */
function bindingDisplayNameFallback(
  binding: EpgBindingDto | null,
  candidates: EpgCandidate[],
): string | null {
  if (binding === null || binding.xmltvChannelId === null) {
    return null;
  }
  return candidates.find((cand) => cand.xmltvChannelId === binding.xmltvChannelId)?.displayName ?? null;
}

export interface ChannelEditModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly channel: CandidateDto | null;
  readonly epgSources?: SourceDto[];
  readonly onSaved: () => void;
  readonly initialTab?: 'basic' | 'streams' | 'epg';
}

export function ChannelEditModal({
  isOpen,
  onClose,
  channel,
  epgSources = EMPTY_EPG_SOURCES,
  onSaved,
  initialTab = 'basic',
}: ChannelEditModalProps): ReactNode {
  const toast = useAppToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tab 状态
  const [activeTab, setActiveTab] = useState<'basic' | 'streams' | 'epg'>(initialTab);

  // 基本信息状态
  const [title, setTitle] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [visible, setVisible] = useState(true);
  const [imgError, setImgError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // 直播流线路状态
  const [streams, setStreams] = useState<ChannelStreamDto[]>([]);
  const [isLoadingStreams, setIsLoadingStreams] = useState(false);
  const [streamEditLocations, setStreamEditLocations] = useState<Record<string, string>>({});
  const [isSavingStreamId, setIsSavingStreamId] = useState<string | null>(null);
  const [newStreamUrl, setNewStreamUrl] = useState('');
  const [isAddingStream, setIsAddingStream] = useState(false);
  /** 待确认删除的最后一条线路(null = 无确认面;仅剩 1 条线路时经 AlertDialog 二次确认) */
  const [pendingDeleteStream, setPendingDeleteStream] = useState<ChannelStreamDto | null>(null);
  const [copiedStreamId, setCopiedStreamId] = useState<string | null>(null);

  // EPG 匹配状态
  const [binding, setBinding] = useState<EpgBindingDto | null>(null);
  const [selectedEpgSourceId, setSelectedEpgSourceId] = useState<string>('');
  const [candidateQuery, setCandidateQuery] = useState('');
  const [candidates, setCandidates] = useState<EpgCandidate[]>([]);
  const [candidateGeneration, setCandidateGeneration] = useState(0);
  const [isLoadingEpg, setIsLoadingEpg] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  // 拉取直播流线路列表
  const loadStreams = async (channelId: string) => {
    setIsLoadingStreams(true);
    try {
      const res = await settingsApi.listStreams(channelId);
      const items = Array.isArray(res?.items) ? res.items : [];
      setStreams(items);
      const initLocs: Record<string, string> = {};
      for (const item of items) {
        initLocs[item.id] = item.location;
      }
      setStreamEditLocations(initLocs);
    } catch {
      // 容错
      setStreams([]);
    } finally {
      setIsLoadingStreams(false);
    }
  };

  // 当 channel 改变且打开时，初始化所有字段及拉取当前 EPG 绑定与播放线路
  useEffect(() => {
    if (!isOpen || channel === null) {
      return;
    }
    setTitle(channel.title ?? '');
    setLogoUrl(channel.logoUrl ?? '');
    setVisible(channel.visible !== false);
    setImgError(false);
    setNewStreamUrl('');

    // 加载流线路
    void loadStreams(channel.id);

    const cleanTitle = channel.title.replace(/\[.*?\]|\(.*?\)|1080[Pp]|4[Kk]|HEVC|高清/g, '').trim();
    setCandidateQuery(cleanTitle);

    // 查询当前 EPG 绑定及对应候选
    let active = true;
    setIsLoadingEpg(true);
    void (async () => {
      try {
        const currentBinding = await settingsApi.queryBinding(channel.id);
        if (!active) return;
        setBinding(currentBinding);

        const preferredSourceId =
          currentBinding.epgSourceId && epgSources.some((s) => s.id === currentBinding.epgSourceId)
            ? currentBinding.epgSourceId
            : epgSources[0]?.id ?? '';
        setSelectedEpgSourceId(preferredSourceId);

        if (preferredSourceId) {
          const page = await settingsApi.queryEpgCandidates(channel.id, {
            epgSourceId: preferredSourceId,
            q: cleanTitle || undefined,
            pageSize: 30,
          });
          if (active) {
            setCandidates(page.items);
            setCandidateGeneration(page.epgGeneration);
            if (currentBinding.epgSourceId === preferredSourceId && currentBinding.displayName == null) {
              setBinding({ ...currentBinding, displayName: bindingDisplayNameFallback(currentBinding, page.items) });
            }
          }
        }
      } catch {
        // 容错处理
      } finally {
        if (active) {
          setIsLoadingEpg(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [isOpen, channel?.id, epgSources]);

  // 保存指定流线路 URL 修改
  const handleSaveStream = async (stream: ChannelStreamDto) => {
    if (channel === null) return;
    const newLoc = (streamEditLocations[stream.id] ?? '').trim();
    if (!newLoc) {
      toast.error('流地址不能为空');
      return;
    }
    if (newLoc === stream.location) {
      toast.warning('流地址未发生修改');
      return;
    }
    setIsSavingStreamId(stream.id);
    try {
      await settingsApi.updateStream(channel.id, stream.id, { location: newLoc });
      toast.success('直播流地址已保存');
      await loadStreams(channel.id);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存直播流失败');
    } finally {
      setIsSavingStreamId(null);
    }
  };

  // 设为默认首选线路:线路权重按 priority ASC(数值越小越优先,与播放解析同口径),
  // 因此「设为首选」= 取比现有最小权重再小 10 的值,而不是把数值调大。
  const handleSetPrimaryStream = async (stream: ChannelStreamDto) => {
    if (channel === null) return;
    const minPriority = streams.length > 0 ? Math.min(...streams.map((s) => s.priority)) : 100;
    const newPriority = Math.max(0, minPriority - 10);
    setIsSavingStreamId(stream.id);
    try {
      await settingsApi.updateStream(channel.id, stream.id, { priority: newPriority });
      // 撞到下限(权重已到 0)时,把同权重的其他线路顺延 +10,保证目标稳定居首
      const collided = streams.filter((line) => line.id !== stream.id && line.priority <= newPriority);
      for (const line of collided) {
        await settingsApi.updateStream(channel.id, line.id, { priority: newPriority + 10 });
      }
      toast.success('已设为首选主线路');
      await loadStreams(channel.id);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置首选线路失败');
    } finally {
      setIsSavingStreamId(null);
    }
  };

  // 复制流地址
  const handleCopyStream = async (stream: ChannelStreamDto) => {
    try {
      await navigator.clipboard.writeText(stream.location);
      setCopiedStreamId(stream.id);
      setTimeout(() => setCopiedStreamId(null), 2000);
      toast.success('直播流 URL 已复制到剪贴板');
    } catch {
      toast.error('复制失败');
    }
  };

  // 新增流线路
  const handleAddStream = async () => {
    if (channel === null) return;
    const trimmed = newStreamUrl.trim();
    if (!trimmed) {
      toast.error('请输入有效的直播流 URL');
      return;
    }
    setIsAddingStream(true);
    try {
      await settingsApi.addStream(channel.id, { location: trimmed });
      toast.success('新增直播源线路成功');
      setNewStreamUrl('');
      await loadStreams(channel.id);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加线路失败');
    } finally {
      setIsAddingStream(false);
    }
  };

  /** 删除流线路:仅剩 1 条线路时属高危(删后频道不可播),经 AlertDialog 二次确认 */
  const handleDeleteStream = async (stream: ChannelStreamDto) => {
    if (channel === null) return;
    if (streams.length <= 1) {
      setPendingDeleteStream(stream);
      return;
    }
    await performDeleteStream(stream);
  };

  const performDeleteStream = async (stream: ChannelStreamDto) => {
    if (channel === null) return;
    try {
      await settingsApi.deleteStream(channel.id, stream.id);
      toast.success('已删除该线路');
      await loadStreams(channel.id);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除线路失败');
    }
  };

  // 切换 EPG 来源拉取新候选
  const handleSwitchEpgSource = async (newSourceId: string) => {
    if (channel === null || !newSourceId) return;
    setSelectedEpgSourceId(newSourceId);
    setIsLoadingEpg(true);
    try {
      const page = await settingsApi.queryEpgCandidates(channel.id, {
        epgSourceId: newSourceId,
        q: candidateQuery.trim() || undefined,
        pageSize: 30,
      });
      setCandidates(page.items);
      setCandidateGeneration(page.epgGeneration);
    } catch {
      toast.error('切换 EPG 来源候选失败');
    } finally {
      setIsLoadingEpg(false);
    }
  };

  // 搜索 EPG 候选
  const handleSearchCandidates = async () => {
    if (channel === null || !selectedEpgSourceId) return;
    setIsLoadingEpg(true);
    try {
      const page = await settingsApi.queryEpgCandidates(channel.id, {
        epgSourceId: selectedEpgSourceId,
        q: candidateQuery.trim() || undefined,
        pageSize: 30,
      });
      setCandidates(page.items);
      setCandidateGeneration(page.epgGeneration);
    } catch {
      toast.error('查询候选节目单失败');
    } finally {
      setIsLoadingEpg(false);
    }
  };

  // 手动锁定选定的 EPG 候选
  const handleBindCandidate = async (target: EpgCandidate) => {
    if (channel === null || binding === null || !selectedEpgSourceId) return;
    try {
      const saved = await settingsApi.saveBinding(channel.id, {
        expectedVersion: binding.version,
        mode: 'manual',
        epgSourceId: selectedEpgSourceId,
        xmltvChannelId: target.xmltvChannelId,
        expectedEpgGeneration: candidateGeneration,
      });
      setBinding({ ...saved, displayName: target.displayName });
      toast.success(`已手动匹配:「${channel.title}」→ ${target.displayName}`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '手动匹配失败');
    }
  };

  // 解除当前手动绑定
  const handleUnbind = async () => {
    if (channel === null || binding === null) return;
    try {
      const saved = await settingsApi.unbindBinding(channel.id, {
        expectedVersion: binding.version,
        mode: 'auto',
      });
      setBinding(saved);
      toast.success(`已解除「${channel.title}」的手动匹配`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '解除绑定失败');
    }
  };

  // 本地图片上传处理
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('请选择有效的图片文件');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('图片大小不能超过 5MB');
      return;
    }

    setIsUploading(true);
    try {
      const reader = new FileReader();
      const base64Data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const res = await settingsApi.uploadLogo({
        filename: file.name,
        data: base64Data,
      });

      setLogoUrl(res.url);
      setImgError(false);
      toast.success('台标图片上传成功');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上传台标图片失败');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // 保存基础元数据修改 (标题、台标、显隐)
  const handleSave = async () => {
    if (channel === null) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error('频道名称不能为空');
      return;
    }
    const trimmedLogo = logoUrl.trim();
    setIsSubmitting(true);
    try {
      const patchBody: {
        expectedVersion: number;
        title: string;
        logoUrl: string | null;
        visible?: boolean;
      } = {
        expectedVersion: channel.version,
        title: trimmedTitle,
        logoUrl: trimmedLogo.length > 0 ? trimmedLogo : null,
      };
      if (visible !== (channel.visible !== false)) {
        patchBody.visible = visible;
      }
      await settingsApi.patchMedia(channel.id, patchBody);
      toast.success('频道信息已更新');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新频道信息失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  const trimmedPreviewUrl = logoUrl.trim();
  const showPreviewImage = trimmedPreviewUrl.length > 0 && !imgError;
  const primaryStream = (streams ?? [])[0] ?? null;

  return (
    <Modal.Root isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Backdrop>
        <Modal.Container placement="center" size="lg">
          <Modal.Dialog
            aria-label="编辑频道元数据"
            data-testid="channel-edit-modal"
            className="gap-4 max-h-[90vh] flex flex-col"
          >
            <div data-testid="epg-match-panel" className="contents">
              <Modal.Header className="flex items-center justify-between pb-2 border-b border-border/30">
                <Modal.Heading className="text-base font-semibold">
                  {channel !== null ? `编辑频道「${channel.title}」` : '编辑频道'}
                </Modal.Heading>
              </Modal.Header>

              {channel !== null ? (
                <Modal.Body className="flex flex-1 flex-col gap-4 overflow-y-auto pt-2">
                  <Tabs
                    selectedKey={activeTab}
                    onSelectionChange={(key) => setActiveTab(key as 'basic' | 'streams' | 'epg')}
                    className="flex flex-col gap-4"
                  >
                    <Tabs.ListContainer>
                      <Tabs.List aria-label="频道编辑分区">
                        <Tabs.Tab id="basic">
                          基本资料与台标
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="streams" data-testid="tab-streams">
                          直播源线路 {streams.length > 0 ? `(${streams.length})` : ''}
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="epg">
                          EPG 节目单匹配
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>

                    {/* 基本资料 Panel */}
                    <Tabs.Panel id="basic" className="flex flex-col gap-4">
                      <TextField
                        className="w-full"
                        name="channel-title"
                        isRequired
                      >
                        <Label>频道名称 (防覆盖保护)</Label>
                        <Input
                          id="channel-title"
                          data-testid="channel-edit-title-input"
                          variant="secondary"
                          placeholder="输入频道标准显示名称"
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                        />
                      </TextField>

                      {/* 前台显隐控制 */}
                      <div className="flex items-center justify-between rounded-xl border border-border/30 bg-surface/30 p-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium text-foreground">前台显示状态</span>
                          <span className="text-xs text-muted">
                            设为隐藏后，该频道将在前台直播列表与节目指南中不可见
                          </span>
                        </div>
                        <Switch
                          isSelected={visible}
                          onChange={setVisible}
                          aria-label="前台显隐开关"
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <span className="text-xs font-medium select-none">
                              {visible ? '显示' : '隐藏'}
                            </span>
                          </Switch.Content>
                        </Switch>
                      </div>

                      {/* 直播源快捷概览 */}
                      <div className="flex items-center justify-between rounded-xl border border-border/30 bg-surface/30 p-3">
                        <div className="flex flex-col gap-1 min-w-0 pr-3">
                          <div className="flex items-center gap-2">
                            <Radio className="size-4 text-accent shrink-0" />
                            <span className="text-sm font-medium text-foreground">直播播放线路</span>
                            <Chip size="sm" variant="soft" color="default">
                              {streams.length} 条可用线路
                            </Chip>
                          </div>
                          {primaryStream ? (
                            <span className="text-xs text-muted font-mono truncate max-w-md">
                              首选: {primaryStream.location}
                            </span>
                          ) : (
                            <span className="text-xs text-muted">
                              暂无线路或正在加载...
                            </span>
                          )}
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          className="shrink-0 text-xs"
                          onPress={() => setActiveTab('streams')}
                        >
                          管理线路配置 →
                        </Button>
                      </div>

                      {/* 台标 Logo 编辑与上传 */}
                      <div className="flex flex-col gap-2">
                        <Label className="text-xs font-medium text-foreground">频道台标 Logo</Label>
                        <div className="flex gap-4 items-start">
                          <div className="flex flex-1 flex-col gap-2">
                            <Input
                              id="channel-logo-url"
                              data-testid="channel-edit-logo-input"
                              variant="secondary"
                              placeholder="输入图片 URL (支持 http/https 或点击右侧上传)"
                              value={logoUrl}
                              onChange={(e) => {
                                setLogoUrl(e.target.value);
                                setImgError(false);
                              }}
                            />
                            <div className="flex items-center gap-2">
                              <input
                                ref={fileInputRef}
                                type="file"
                                className="hidden"
                                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                                onChange={(e) => void handleFileChange(e)}
                              />
                              <Button
                                variant="secondary"
                                size="sm"
                                onPress={() => fileInputRef.current?.click()}
                                isPending={isUploading}
                                className="gap-1.5"
                              >
                                <Upload className="size-3.5" />
                                上传本地图片
                              </Button>
                              {logoUrl && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-xs text-muted hover:text-danger"
                                  onPress={() => {
                                    setLogoUrl('');
                                    setImgError(false);
                                  }}
                                >
                                  清空台标
                                </Button>
                              )}
                            </div>
                          </div>

                          {/* 台标即时视觉预览区 */}
                          <div className="flex flex-col items-center gap-1">
                            <Label className="text-xs text-muted">预览</Label>
                            <div
                              className="flex h-16 w-16 items-center justify-center rounded-xl border border-border/60 bg-surface/40 p-1 overflow-hidden"
                              data-testid="channel-logo-preview-box"
                            >
                              {showPreviewImage ? (
                                <img
                                  src={trimmedPreviewUrl}
                                  alt="台标预览"
                                  data-testid="channel-logo-preview-img"
                                  className="h-full w-full object-contain"
                                  onError={() => setImgError(true)}
                                />
                              ) : (
                                <div
                                  className="flex flex-col items-center justify-center text-muted"
                                  data-testid="channel-logo-preview-fallback"
                                >
                                  <Tv className="h-6 w-6 stroke-[1.5]" />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-lg bg-surface/30 p-2.5 text-xs text-muted">
                        提示：自定义修改频道名称或台标后，系统将自动锁定该资产，后续 M3U 订阅源刷新时绝不会覆盖您的个性化设置。
                      </div>
                    </Tabs.Panel>

                    {/* 直播源线路配置 Panel */}
                    <Tabs.Panel id="streams" className="flex flex-col gap-4" data-testid="channel-streams-panel">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted">
                          管理当前频道的各条播放流 URL。优先级最高的线路将作为首选直播流播放。
                        </span>
                        <Chip size="sm" variant="soft" color="default">
                          共 {streams.length} 条线路
                        </Chip>
                      </div>

                      {/* 线路列表 */}
                      <div className="flex flex-col gap-3">
                        {isLoadingStreams ? (
                          <div className="py-8 text-center text-xs text-muted">正在读取线路...</div>
                        ) : streams.length === 0 ? (
                          <div className="rounded-xl border border-border/30 bg-surface/30 p-4 text-center text-xs text-muted">
                            暂无直播源线路，请在下方添加一条新线路。
                          </div>
                        ) : (
                          streams.map((stream, idx) => {
                            const isPrimary = idx === 0;
                            const currentVal = streamEditLocations[stream.id] ?? stream.location;
                            const isChanged = currentVal.trim() !== stream.location;

                            return (
                              <div
                                key={stream.id}
                                className="flex flex-col gap-2 rounded-xl border border-border/40 bg-surface/30 p-3 transition-colors hover:border-border/70"
                                data-testid={`stream-row-${stream.id}`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-semibold text-foreground">
                                      线路 #{idx + 1}
                                    </span>
                                    {isPrimary ? (
                                      <Chip size="sm" variant="soft" color="success" className="gap-1">
                                        <Star className="size-3 fill-current" />
                                        首选主线路
                                      </Chip>
                                    ) : (
                                      <Chip size="sm" variant="soft" color="default">
                                        备用线路
                                      </Chip>
                                    )}
                                    <Chip size="sm" variant="soft" color="default" className="text-2xs">
                                      {stream.protocol.toUpperCase()}
                                    </Chip>
                                    {stream.sourceName ? (
                                      <span className="text-2xs text-muted truncate max-w-[140px]">
                                        源: {stream.sourceName}
                                      </span>
                                    ) : null}
                                  </div>

                                  <div className="flex items-center gap-1.5">
                                    {!isPrimary && (
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        className="h-7 text-xs"
                                        onPress={() => void handleSetPrimaryStream(stream)}
                                        isPending={isSavingStreamId === stream.id}
                                        data-testid={`set-primary-stream-${stream.id}`}
                                      >
                                        设为主线路
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0 text-muted hover:text-foreground"
                                      onPress={() => void handleCopyStream(stream)}
                                      aria-label="复制 URL"
                                      data-testid={`copy-stream-${stream.id}`}
                                    >
                                      {copiedStreamId === stream.id ? (
                                        <Check className="size-3.5 text-success" />
                                      ) : (
                                        <Copy className="size-3.5" />
                                      )}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 p-0 text-muted hover:text-danger hover:bg-danger-soft/20"
                                      onPress={() => void handleDeleteStream(stream)}
                                      aria-label="删除线路"
                                      data-testid={`delete-stream-${stream.id}`}
                                    >
                                      <Trash2 className="size-3.5" />
                                    </Button>
                                  </div>
                                </div>

                                {/* URL 编辑框 */}
                                <div className="flex items-center gap-2">
                                  <Input
                                    variant="secondary"
                                    className="flex-1 font-mono text-xs"
                                    value={currentVal}
                                    placeholder="输入直播源流 URL"
                                    onChange={(e) =>
                                      setStreamEditLocations((prev) => ({
                                        ...prev,
                                        [stream.id]: e.target.value,
                                      }))
                                    }
                                    data-testid={`stream-input-${stream.id}`}
                                  />
                                  <Button
                                    variant={isChanged ? 'primary' : 'secondary'}
                                    size="sm"
                                    className="shrink-0 h-9 text-xs"
                                    isDisabled={!isChanged}
                                    isPending={isSavingStreamId === stream.id}
                                    onPress={() => void handleSaveStream(stream)}
                                    data-testid={`save-stream-${stream.id}`}
                                  >
                                    保存地址
                                  </Button>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>

                      {/* 添加新线路卡片 */}
                      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border/60 bg-surface/20 p-3">
                        <Label className="text-xs font-medium text-foreground">添加新直播线路</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            variant="secondary"
                            className="flex-1 font-mono text-xs"
                            placeholder="输入新直播流 URL (如 http://.../live.m3u8)"
                            value={newStreamUrl}
                            onChange={(e) => setNewStreamUrl(e.target.value)}
                            data-testid="add-stream-input"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleAddStream();
                              }
                            }}
                          />
                          <Button
                            variant="primary"
                            size="sm"
                            className="shrink-0 h-9 text-xs gap-1"
                            isPending={isAddingStream}
                            onPress={() => void handleAddStream()}
                            data-testid="add-stream-btn"
                          >
                            <Plus className="size-3.5" />
                            添加线路
                          </Button>
                        </div>
                      </div>
                    </Tabs.Panel>

                    {/* EPG 节目单匹配 Panel */}
                    <Tabs.Panel id="epg" className="flex flex-col gap-4">
                      {/* 当前绑定状态卡片 */}
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface/60 p-3 text-xs text-muted">
                        <div className="flex min-w-0 items-center gap-2">
                          <span>当前绑定状态:</span>
                          {binding?.mode === 'manual' ? (
                            <Chip
                              size="sm"
                              variant="soft"
                              color="warning"
                              title={`XMLTV ID: ${binding.xmltvChannelId ?? ''}`}
                            >
                              手动锁定: {binding.displayName ?? '名称不可用'} ({binding.status === 'invalid' ? '已失效' : '已绑定'})
                            </Chip>
                          ) : (
                            <Chip size="sm" variant="soft" color="default">
                              自动匹配模式
                            </Chip>
                          )}
                        </div>
                        {binding?.mode === 'manual' && (
                          <Button
                            variant="secondary"
                            size="sm"
                            className="text-xs text-danger hover:bg-danger-soft/20"
                            onPress={() => void handleUnbind()}
                            data-testid="epg-unbind"
                          >
                            解除手动绑定
                          </Button>
                        )}
                      </div>

                      {/* 目标 EPG 来源选择 */}
                      {epgSources.length > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          <Label className="text-xs font-medium text-foreground">目标 EPG 来源</Label>
                          <Select
                            aria-label="选择目标 EPG 来源"
                            variant="secondary"
                            selectedKey={selectedEpgSourceId}
                            onSelectionChange={(key) => {
                              if (key !== null && String(key) !== '') {
                                void handleSwitchEpgSource(String(key));
                              }
                            }}
                          >
                            <Select.Trigger data-testid="epg-source-select-trigger">
                              <Select.Value />
                              <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                              <ListBox>
                                {epgSources.map((source) => (
                                  <ListBox.Item key={source.id} id={source.id} textValue={source.name}>
                                    {source.name} {source.enabled ? '(已启用)' : '(已停用)'}
                                  </ListBox.Item>
                                ))}
                              </ListBox>
                            </Select.Popover>
                          </Select>
                        </div>
                      ) : (
                        <div className="rounded-xl border border-warning/30 bg-warning-soft/20 p-3 text-xs text-warning">
                          暂无可用 EPG 数据源，请先在「EPG 来源」标签添加并同步 XMLTV 数据源。
                        </div>
                      )}

                      {/* 候选关键词搜索 */}
                      <div className="flex items-end gap-2">
                        <TextField
                          className="flex-1"
                          name="epg-candidate-q"
                          value={candidateQuery}
                          onChange={setCandidateQuery}
                        >
                          <Label>候选节目单搜索 (名称或 XMLTV ID)</Label>
                          <Input
                            id="epg-candidate-q"
                            data-testid="epg-candidates-filter-q"
                            variant="secondary"
                            placeholder="输入节目单名称搜索…"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                void handleSearchCandidates();
                              }
                            }}
                          />
                        </TextField>
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => void handleSearchCandidates()}
                          data-testid="epg-candidates-filter-btn"
                          isPending={isLoadingEpg}
                        >
                          <Search className="size-3.5" />
                          筛选
                        </Button>
                      </div>

                      {/* 候选列表展示 */}
                      <div className="flex flex-col gap-1.5">
                        <Label className="text-xs font-medium text-foreground">匹配候选节目单</Label>
                        <div className="max-h-56 overflow-y-auto rounded-xl border border-border/30 bg-surface/30 p-2">
                          {isLoadingEpg ? (
                            <div className="py-6 text-center text-xs text-muted">正在查询候选…</div>
                          ) : candidates.length === 0 ? (
                            <div className="py-6 text-center text-xs text-muted">未找到匹配候选节目单。</div>
                          ) : (
                            <ul className="flex flex-col gap-1.5" data-testid="epg-candidates-list">
                              {candidates.map((cand) => {
                                const isCurrent = binding?.xmltvChannelId === cand.xmltvChannelId;
                                return (
                                  <li
                                    key={cand.xmltvChannelId}
                                    className={`flex items-center justify-between rounded-lg p-2 text-xs transition-colors ${
                                      isCurrent
                                        ? 'bg-accent/15 border border-accent/40 text-foreground'
                                        : 'hover:bg-surface-secondary/40 text-foreground'
                                    }`}
                                  >
                                    <div className="flex min-w-0 flex-col">
                                      <span className="font-medium truncate">{cand.displayName}</span>
                                      <span className="text-2xs text-muted truncate">ID: {cand.xmltvChannelId}</span>
                                    </div>
                                    <Button
                                      size="sm"
                                      variant={isCurrent ? 'primary' : 'secondary'}
                                      className="shrink-0 h-7 text-xs"
                                      onPress={() => void handleBindCandidate(cand)}
                                      data-testid={`epg-candidate-${cand.xmltvChannelId}`}
                                    >
                                      {isCurrent ? (
                                        <>
                                          <Check className="size-3 mr-1" />
                                          当前锁定
                                        </>
                                      ) : (
                                        '选定此节目单'
                                      )}
                                    </Button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      </div>
                    </Tabs.Panel>
                  </Tabs>
                </Modal.Body>
              ) : null}

              <Modal.Footer className="flex justify-end gap-2 pt-2 border-t border-border/30">
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={onClose}
                  isDisabled={isSubmitting}
                  data-testid="channel-edit-cancel-btn"
                >
                  取消
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onPress={() => void handleSave()}
                  isPending={isSubmitting}
                  data-testid="channel-edit-save-btn"
                >
                  保存修改
                </Button>
              </Modal.Footer>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/* 删除最后一条线路的二次确认(替代原生 window.confirm;宪章约束 5 禁原生对话框) */}
      <AlertDialog.Backdrop
        isOpen={pendingDeleteStream !== null}
        onOpenChange={(open: boolean) => {
          if (!open) {
            setPendingDeleteStream(null);
          }
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]" data-testid="channel-stream-delete-confirm">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除最后一条线路?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-foreground">
                该频道仅剩此 1 条线路,删除后该频道将无法正常播放。
              </p>
              {pendingDeleteStream !== null ? (
                <p className="mt-2 text-sm text-muted">
                  待删除:{pendingDeleteStream.sourceName} · {pendingDeleteStream.protocol} · 优先级 {pendingDeleteStream.priority}
                </p>
              ) : null}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" size="sm" onPress={() => setPendingDeleteStream(null)} data-testid="channel-stream-delete-cancel">
                取消
              </Button>
              <Button
                variant="danger"
                size="sm"
                data-testid="channel-stream-delete-confirm-btn"
                onPress={() => {
                  const target = pendingDeleteStream;
                  setPendingDeleteStream(null);
                  if (target !== null) {
                    void performDeleteStream(target);
                  }
                }}
              >
                确认删除
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </Modal.Root>
  );
}
