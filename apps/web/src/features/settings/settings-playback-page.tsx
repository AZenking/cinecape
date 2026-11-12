/**
 * 013 个人播放体验设置页 (T011, US1;自动保存演进):
 *
 * 三项偏好(默认音轨/默认字幕/自动播放下一集)修改即自动保存,无保存按钮:
 * - 串行队列:保存期间的新修改并入 pendingPatch(按字段保留最新值),当前请求
 *   结束后自动继续提交,连续快速修改只会产生按序的部分字段 PUT;
 * - 服务端回读仅同步非脏字段,绝不覆盖尚未保存的本地修改;
 * - 切换档案:递增 generation 丢弃旧档案待提交状态(含在途结果的落地),
 *   不把旧偏好写入新档案;
 * - 状态反馈(aria-live):保存中 / 已保存 / 保存失败+重试;失败保留用户选择;
 * - 文案不承诺播放器即时生效:保存成功仅表示偏好已保存至当前档案;
 * - 沿用 PUT /profile/preferences 部分字段合并语义,外观字段互不覆盖。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Label, ListBox, Select, Spinner, Switch } from '@heroui/react';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { formatApiError } from '../../shared/query/error';
import { useOptionalSession } from '../../app/session-provider';
import { useProfilePreferences } from './shared/use-profile-preferences';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';
import { SettingsSection } from './shared/settings-section';
import type { ProfilePreferences } from '@hmp/shared';

type PlaybackPrefs = Pick<
  ProfilePreferences,
  'defaultAudioLanguage' | 'defaultSubtitleLanguage' | 'autoPlayNext'
>;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const AUDIO_LANGUAGES = [
  { id: 'zh', label: '中文 (Chinese)' },
  { id: 'en', label: '英语 (English)' },
  { id: 'ja', label: '日语 (Japanese)' },
  { id: 'ko', label: '韩语 (Korean)' },
  { id: 'original', label: '原始音频 (Original Audio)' },
] as const;

const SUBTITLE_LANGUAGES = [
  { id: 'zh', label: '中文字幕 (Chinese)' },
  { id: 'en', label: '英文字幕 (English)' },
  { id: 'none', label: '关闭字幕 (Off)' },
] as const;

export function SettingsPlaybackPage(): ReactNode {
  const session = useOptionalSession();
  const { title } = useSettingsPageMeta();
  const { preferences, isPending, isError, error, refetch, save } = useProfilePreferences();
  const profileId = session?.session?.activeProfile?.id ?? null;

  /** UI 真值(含未保存修改);null = 尚未初始化(读取中/已切档待新数据) */
  const [values, setValues] = useState<PlaybackPrefs | null>(null);
  const [status, setStatus] = useState<SaveStatus>('idle');

  /** 脏字段:用户已改但尚未成功保存;服务端回读不得覆盖 */
  const dirtyKeysRef = useRef<Set<keyof PlaybackPrefs>>(new Set());
  /** 待提交补丁(按字段保留最新值;串行队列的唯一来源) */
  const pendingPatchRef = useRef<Partial<PlaybackPrefs>>({});
  const savingRef = useRef(false);
  /** 最近一次冲刷是否失败(失败不自动重试) */
  const failedRef = useRef(false);
  /** 切档代次:作废在途保存对本页状态的影响 */
  const generationRef = useRef(0);
  const profileRef = useRef<string | null>(profileId);
  const flushRef = useRef<() => void>(() => undefined);

  // 服务端真值同步:仅写入非脏字段(不覆盖未保存修改)
  useEffect(() => {
    if (preferences === null) {
      return;
    }
    setValues((prev) => {
      if (prev === null) {
        return {
          defaultAudioLanguage: preferences.defaultAudioLanguage,
          defaultSubtitleLanguage: preferences.defaultSubtitleLanguage,
          autoPlayNext: preferences.autoPlayNext,
        };
      }
      const next = { ...prev };
      // 仅同步非脏字段(显式逐字段,保证键与值类型关联)
      if (!dirtyKeysRef.current.has('defaultAudioLanguage')) {
        next.defaultAudioLanguage = preferences.defaultAudioLanguage;
      }
      if (!dirtyKeysRef.current.has('defaultSubtitleLanguage')) {
        next.defaultSubtitleLanguage = preferences.defaultSubtitleLanguage;
      }
      if (!dirtyKeysRef.current.has('autoPlayNext')) {
        next.autoPlayNext = preferences.autoPlayNext;
      }
      return next;
    });
  }, [preferences]);

  // 切换档案(含登出):丢弃旧档案待提交状态与在途结果,等待新档案数据
  useEffect(() => {
    if (profileRef.current === profileId) {
      return;
    }
    profileRef.current = profileId;
    generationRef.current += 1;
    dirtyKeysRef.current.clear();
    pendingPatchRef.current = {};
    savingRef.current = false;
    setValues(null);
    setStatus('idle');
  }, [profileId]);

  // 串行冲刷:取当前待提交补丁提交;保存期间的新修改在完成后继续(finally drain)
  flushRef.current = (): void => {
    if (savingRef.current) {
      return;
    }
    const patch = { ...pendingPatchRef.current };
    if (Object.keys(patch).length === 0) {
      return;
    }
    const generation = generationRef.current;
    savingRef.current = true;
    failedRef.current = false;
    pendingPatchRef.current = {};
    setStatus('saving');
    void save(patch)
      .then(() => {
        if (generationRef.current !== generation) {
          return;
        }
        for (const key of Object.keys(patch) as (keyof PlaybackPrefs)[]) {
          if (!(key in pendingPatchRef.current)) {
            dirtyKeysRef.current.delete(key);
          }
        }
        failedRef.current = false;
        setStatus('saved');
      })
      .catch(() => {
        if (generationRef.current !== generation) {
          return;
        }
        // 失败:未送达的修改放回待提交队列(保留用户选择);不自动重试
        pendingPatchRef.current = { ...patch, ...pendingPatchRef.current };
        failedRef.current = true;
        setStatus('error');
      })
      .finally(() => {
        savingRef.current = false;
        if (generationRef.current !== generation) {
          return;
        }
        // 仅成功后继续冲刷保存期间的新修改;失败等待重试入口或下一次修改
        if (!failedRef.current && Object.keys(pendingPatchRef.current).length > 0) {
          flushRef.current();
        }
      });
  };

  const updateField = <K extends keyof PlaybackPrefs>(key: K, value: PlaybackPrefs[K]): void => {
    setValues((prev) => (prev === null ? prev : { ...prev, [key]: value }));
    dirtyKeysRef.current.add(key);
    pendingPatchRef.current = { ...pendingPatchRef.current, [key]: value };
    flushRef.current();
  };

  if (session !== null && session.status !== 'authenticated') {
    return (
      <section aria-label={`设置 · ${title}`} className="flex flex-col gap-4 py-8 text-center" data-testid="settings-playback-page">
        <p className="text-sm text-muted">登录并选择档案后,即可修改个人播放偏好。</p>
      </section>
    );
  }

  if (isPending || values === null) {
    return (
      <section aria-label={`设置 · ${title}`} className="flex flex-col gap-4 py-2" data-testid="settings-playback-page">
        <SettingsPageHeader description={null} />
        <LoadingSpinner label="正在读取个人偏好设置…" />
        <div data-testid="playback-save-status" aria-live="polite" className="sr-only" />
      </section>
    );
  }

  if (isError) {
    return (
      <section aria-label={`设置 · ${title}`} className="flex flex-col gap-4 py-2" data-testid="settings-playback-page">
        <SettingsPageHeader description={null} />
        <RetryableAlert title="读取失败" description={formatApiError(error)} onRetry={refetch} />
        <div data-testid="playback-save-status" aria-live="polite" className="sr-only" />
      </section>
    );
  }

  const saveStatus: ReactNode = (() => {
    switch (status) {
      case 'saving':
        return (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <Spinner size="sm" /> 保存中…
          </span>
        );
      case 'saved':
        return <span className="text-xs text-success">已保存</span>;
      case 'error':
        return (
          <span className="flex items-center gap-2 text-xs text-danger">
            保存失败
            <Button variant="outline" size="sm" onPress={() => flushRef.current()} data-testid="playback-save-retry">
              重试
            </Button>
          </span>
        );
      default:
        return null;
    }
  })();

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-col gap-6" data-testid="settings-playback-page">
      <SettingsPageHeader
        description="设置当前档案的默认播放偏好"
        actions={<span className="text-xs leading-5 text-muted">自动保存</span>}
      />

      <div className="flex w-full flex-col gap-6">
        {/* Section: 音轨与字幕偏好 */}
        <SettingsSection title="音轨与字幕">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <Label>默认音频语言</Label>
                <span className="text-xs text-muted">优先匹配片源中的指定音轨语言。</span>
              </div>
              <div className="w-full shrink-0 sm:w-64">
                <Select
                  aria-label="默认音频语言"
                  variant="secondary"
                  selectedKey={values.defaultAudioLanguage}
                  onSelectionChange={(key) => {
                    if (key !== null) {
                      updateField('defaultAudioLanguage', String(key));
                    }
                  }}
                >
                  <Select.Trigger data-testid="select-audio-language" className="w-full">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {AUDIO_LANGUAGES.map((lang) => (
                        <ListBox.Item key={lang.id} id={lang.id} textValue={lang.label}>
                          {lang.label}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <Label>默认字幕语言</Label>
                <span className="text-xs text-muted">播放影视剧时自动选择的字幕流。</span>
              </div>
              <div className="w-full shrink-0 sm:w-64">
                <Select
                  aria-label="默认字幕语言"
                  variant="secondary"
                  selectedKey={values.defaultSubtitleLanguage}
                  onSelectionChange={(key) => {
                    if (key !== null) {
                      updateField('defaultSubtitleLanguage', String(key));
                    }
                  }}
                >
                  <Select.Trigger data-testid="select-subtitle-language" className="w-full">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {SUBTITLE_LANGUAGES.map((lang) => (
                        <ListBox.Item key={lang.id} id={lang.id} textValue={lang.label}>
                          {lang.label}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            </div>
        </SettingsSection>

        {/* Section: 连播行为(自动保存;footer 为保存状态反馈区) */}
        <SettingsSection
          title="连续播放"
          footer={
            <>
              <span className="text-xs text-muted">修改后自动保存至当前档案</span>
              <div aria-live="polite" data-testid="playback-save-status" className="flex min-h-5 items-center justify-end">
                {saveStatus}
              </div>
            </>
          }
        >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-1">
                <Label>自动播放下一集</Label>
                <span className="text-xs text-muted">在当前剧集播放结束后自动衔接下一集。</span>
              </div>
              <div className="w-full shrink-0 sm:flex sm:w-64 sm:justify-end">
                <Switch
                  data-testid="switch-autoplay-next"
                  isSelected={values.autoPlayNext}
                  onChange={(selected) => updateField('autoPlayNext', selected)}
                >
                  {/* Switch 根(react-aria SwitchField)是无交互 div,唯一可点击区域是
                      Switch.Content(SwitchButton,label 元素):Control 必须位于其内,
                      否则可见轨道在 label 外,点击轨道不触发 onChange */}
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    {/* 无可见文字时的无障碍名称(HeroUI 规范:Label 关联开关控件;sr-only 不渲染视觉文本) */}
                    <Label className="sr-only">自动播放下一集</Label>
                  </Switch.Content>
                </Switch>
              </div>
            </div>
        </SettingsSection>
      </div>
    </section>
  );
}
