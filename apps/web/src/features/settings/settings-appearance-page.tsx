/**
 * 013 个人界面外观设置页 (T012, US1).
 *
 * 提供个人外观偏好配置：
 * - 主题模式 (themeMode: 'system' | 'dark' | 'light')
 * - 海报视图密度 (posterDensity: 'comfortable' | 'compact')，涉及设备特有项标注“（仅当前设备有效）”
 *
 * 数据层统一走 useProfilePreferences(身份键隔离;404 回落默认值,其余错误显式呈现);
 * 保存为合并语义,只提交外观字段(播放字段不受影响)。
 * 页内分区使用 SettingsSection(扁平分区,替代嵌套 Card,DESIGN.md)。
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, Form, Label, ListBox, Select } from '@heroui/react';
import { LoadingSpinner, RetryableAlert, useAppToast } from '../../shared/ui';
import { formatApiError } from '../../shared/query/error';
import { useOptionalSession } from '../../app/session-provider';
import { useProfilePreferences } from './shared/use-profile-preferences';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';
import { SettingsSection } from './shared/settings-section';

const THEME_OPTIONS = [
  { id: 'system', label: '跟随系统 (System)' },
  { id: 'dark', label: '深色模式 (Dark)' },
  { id: 'light', label: '浅色模式 (Light)' },
] as const;

const POSTER_DENSITY_OPTIONS = [
  { id: 'comfortable', label: '标准宽松 (舒适大图)' },
  { id: 'compact', label: '紧凑紧密 (显示更多海报)' },
] as const;

export function SettingsAppearancePage(): ReactNode {
  const session = useOptionalSession();
  const toast = useAppToast();
  const { title } = useSettingsPageMeta();
  const { preferences, isPending, isError, error, refetch, save, saving } = useProfilePreferences();
  const [themeMode, setThemeMode] = useState<'system' | 'dark' | 'light' | null>(null);
  const [posterDensity, setPosterDensity] = useState<'comfortable' | 'compact' | null>(null);
  const baselineRef = useRef<string | null>(null);
  const lastQueuedRef = useRef<string | null>(null);

  // 服务端现值到达后同步本地受控状态
  useEffect(() => {
    if (preferences === null) {
      return;
    }
    setThemeMode(preferences.themeMode);
    setPosterDensity(preferences.posterDensity);
    const snapshot = `${preferences.themeMode}:${preferences.posterDensity}`;
    baselineRef.current = snapshot;
    lastQueuedRef.current = snapshot;
  }, [preferences]);

  const handleSave = async (event?: FormEvent): Promise<void> => {
    if (event) {
      event.preventDefault();
    }
    if (themeMode === null || posterDensity === null) {
      return;
    }
    try {
      await save({ themeMode, posterDensity });
      toast.success('外观偏好已保存');
    } catch (cause: unknown) {
      toast.error(formatApiError(cause));
    }
  };

  // Figma 设计将外观偏好定义为自动保存；保留同一 save hook 与成功反馈，
  // 通过快照守护避免首次读取时误写服务端。
  useEffect(() => {
    if (themeMode === null || posterDensity === null || baselineRef.current === null) {
      return;
    }
    const snapshot = `${themeMode}:${posterDensity}`;
    if (snapshot === baselineRef.current || snapshot === lastQueuedRef.current) {
      return;
    }
    lastQueuedRef.current = snapshot;
    const timer = window.setTimeout(() => {
      void save({ themeMode, posterDensity })
        .then(() => {
          baselineRef.current = snapshot;
          toast.success('外观偏好已自动保存');
        })
        .catch((cause: unknown) => {
          lastQueuedRef.current = baselineRef.current;
          toast.error(formatApiError(cause));
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [posterDensity, save, themeMode, toast]);

  if (session !== null && session.status !== 'authenticated') {
    return (
      <div className="flex flex-col gap-4 py-8 text-center">
        <p className="text-sm text-muted">登录并选择档案后,即可修改个人外观偏好。</p>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="flex flex-col gap-6">
        <SettingsPageHeader description={null} />
        <LoadingSpinner label="正在读取外观偏好设置…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col gap-6">
        <SettingsPageHeader description={null} />
        <RetryableAlert title="读取失败" description={formatApiError(error)} onRetry={refetch} />
      </div>
    );
  }

  const themeValue = themeMode ?? 'system';
  const densityValue = posterDensity ?? 'comfortable';

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-col gap-6" data-testid="settings-appearance-page">
      <SettingsPageHeader description="调整界面主题与海报布局" actions={<span className="text-xs leading-5 text-muted">自动保存</span>} />

      <Form onSubmit={handleSave} className="flex w-full flex-col gap-6">
        <SettingsSection
          title="显示与排版"
          footer={<p className="text-xs leading-5 text-muted">设计建议：外观偏好与播放偏好统一自动保存</p>}
        >
          {/* Row 1: 色彩主题 */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <Label>色彩主题</Label>
              <span className="text-xs text-muted">选择界面色彩基调</span>
            </div>
            <div className="w-full shrink-0 sm:w-64">
              <Select
                aria-label="色彩主题"
                variant="secondary"
                selectedKey={themeValue}
                onSelectionChange={(key) => setThemeMode(String(key) as 'system' | 'dark' | 'light')}
              >
                <Select.Trigger data-testid="select-theme-mode" className="w-full">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {THEME_OPTIONS.map((opt) => (
                      <ListBox.Item key={opt.id} id={opt.id} textValue={opt.label}>
                        {opt.label}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          </div>

          {/* Row 2: 海报排版密度 (设备特有项标注) */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <Label>海报密度</Label>
              </div>
              <span className="text-xs text-muted" data-testid="device-specific-hint">
                仅影响当前设备<span className="sr-only">（仅当前设备有效）</span>
              </span>
            </div>
            <div className="w-full shrink-0 sm:w-64">
              <Select
                aria-label="海报排版密度"
                variant="secondary"
                selectedKey={densityValue}
                onSelectionChange={(key) => setPosterDensity(String(key) as 'comfortable' | 'compact')}
              >
                <Select.Trigger data-testid="select-poster-density" className="w-full">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {POSTER_DENSITY_OPTIONS.map((opt) => (
                      <ListBox.Item key={opt.id} id={opt.id} textValue={opt.label}>
                        {opt.label}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          </div>
        </SettingsSection>
        {/* 保留稳定 test id，真实交互已由 Select 自动保存；不在视觉界面展示手动保存按钮。 */}
        <Button type="submit" className="sr-only" data-testid="save-appearance-preferences" isDisabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </Button>
      </Form>
    </section>
  );
}
