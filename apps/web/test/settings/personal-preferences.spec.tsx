/**
 * T009 / T011 / T012 · 个人偏好设置契约与组件交互(自动保存演进):
 *
 * 播放页改为修改即自动保存(无保存按钮),覆盖规格验证矩阵:
 * - 读取现值;单字段自动保存成功反馈;失败保留选择并提供重试;刷新后数据保持;
 * - 快速连续修改:串行 PUT、按字段保留最新值;保存期间回读不覆盖未保存修改;
 * - 切换档案:丢弃旧档案待提交状态,不把旧偏好写入新档案;外观字段零改写;
 * - 可访问性:Select/Switch 可访问名称、状态 aria-live、键盘与指针操作。
 * 外观页仍为就地保存按钮流程(T012 保持原契约)。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppToastRegion } from '../../src/shared/ui';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { SettingsPlaybackPage } from '../../src/features/settings/settings-playback-page';
import { SettingsAppearancePage } from '../../src/features/settings/settings-appearance-page';
import * as sessionModule from '../../src/app/session-provider';
import type { SessionContextValue } from '../../src/app/session-provider';

interface RecordedFetch {
  method: string;
  url: string;
  body: unknown;
}

interface HeldPut {
  patch: Record<string, unknown>;
  resolve: () => void;
}

let recordedFetches: RecordedFetch[] = [];
let mockPreferences: Record<string, unknown> = {};
/** 挂起 PUT(测试手动放行;放行时才合并进 mockPreferences 并响应) */
let holdPut = false;
let heldPuts: HeldPut[] = [];
/** 下一次 PUT 直接失败一次(模拟网络/服务端错误) */
let failNextPut = false;

let activeSession: SessionContextValue;

function makeSession(profileId: string): SessionContextValue {
  return {
    status: 'authenticated',
    session: {
      sessionId: 'session-test',
      account: { id: 'acc-1', username: 'admin', role: 'owner' },
      activeProfile: {
        id: profileId,
        name: profileId === 'p1' ? '主档案' : '另一档案',
        avatar: null,
        type: 'adult',
        isDefault: profileId === 'p1',
        isMain: profileId === 'p1',
        pinProtected: false,
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      householdId: 'hh-1',
      expiresAt: '2026-12-31T23:59:59.000Z',
      bootstrapRequired: false,
      profileContextVersion: 1,
    },
    needsReselection: false,
    personalCacheKey: `k-${profileId}`,
    refresh: vi.fn(),
    applySession: vi.fn(),
    logout: vi.fn(),
  } as unknown as SessionContextValue;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock(): void {
  recordedFetches = [];
  holdPut = false;
  heldPuts = [];
  failNextPut = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: unknown = init?.body;
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body);
        } catch {
          // ignore
        }
      }
      recordedFetches.push({ method, url, body });

      if (url.includes('/api/profile/preferences')) {
        if (method === 'GET') {
          return jsonResponse(mockPreferences);
        }
        if (method === 'PUT') {
          const patch = (body ?? {}) as Record<string, unknown>;
          if (failNextPut) {
            failNextPut = false;
            return jsonResponse({ title: '服务器错误', status: 500, code: 'INTERNAL' }, 500);
          }
          if (holdPut) {
            // 放行时才合并(可模拟「回读早于保存完成」的过期真值)
            return new Promise<Response>((resolve) => {
              heldPuts.push({
                patch,
                resolve: () => {
                  mockPreferences = { ...mockPreferences, ...patch };
                  resolve(jsonResponse(mockPreferences));
                },
              });
            });
          }
          mockPreferences = { ...mockPreferences, ...patch };
          return jsonResponse(mockPreferences);
        }
      }

      return jsonResponse({ error: 'not found' }, 404);
    }),
  );
}

function releaseHeldPuts(): void {
  const pending = [...heldPuts];
  heldPuts = [];
  pending.forEach((held) => held.resolve());
}

/** 只放行最早挂起的一个 PUT(其余保持挂起) */
function releaseFirstHeldPut(): void {
  const held = heldPuts.shift();
  held?.resolve();
}

function putBodies(): Record<string, unknown>[] {
  return recordedFetches
    .filter((f) => f.method === 'PUT' && f.url.includes('/api/profile/preferences'))
    .map((f) => (f.body ?? {}) as Record<string, unknown>);
}

/** 真实指针交互:点击 Select.Trigger → 点击弹层选项(HeroUI Select 无隐藏原生 select) */
async function chooseOption(triggerTestId: string, optionLabel: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(triggerTestId));
  await user.click(await screen.findByRole('option', { name: optionLabel }));
}

/** 页面经 useAppQuery/useAppMutation 触达数据层,须挂应用同一 QueryClient */
function renderWithClient(ui: React.ReactElement): ReturnType<typeof render> {
  appQueryClient.clear();
  return render(
    // 页面标题经 useSettingsPageMeta 派生(路由上下文必需);操作提示走 Toast 区域
    <MemoryRouter initialEntries={['/settings/playback']}>
      <QueryClientProvider client={appQueryClient}>
        <AppToastRegion />
        {ui}
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** 渲染播放页并等待偏好数据就绪(控件可交互) */
async function renderPlaybackReady(): Promise<void> {
  renderWithClient(<SettingsPlaybackPage />);
  await screen.findByTestId('settings-playback-page');
  await screen.findByTestId('select-audio-language');
}

describe('T009 / T011 / T012 · 个人偏好设置契约与组件交互(自动保存)', () => {
  beforeEach(() => {
    mockPreferences = {
      defaultAudioLanguage: 'zh',
      defaultSubtitleLanguage: 'zh',
      autoPlayNext: true,
      themeMode: 'system',
      posterDensity: 'comfortable',
    };
    activeSession = makeSession('p1');
    vi.spyOn(sessionModule, 'useOptionalSession').mockImplementation(() => activeSession);
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('T011: 读取现值并自动保存音频语言(部分字段 PUT,不含外观字段)', async () => {
    await renderPlaybackReady();
    expect(recordedFetches.some((f) => f.method === 'GET' && f.url.includes('/api/profile/preferences'))).toBe(true);

    await chooseOption('select-audio-language', '英语 (English)');
    await waitFor(() => {
      expect(screen.getByTestId('playback-save-status')).toHaveTextContent('已保存');
    });

    const puts = putBodies();
    expect(puts).toHaveLength(1);
    // 部分字段合并语义:只提交变更字段,外观字段零出现
    expect(Object.keys(puts[0]!).sort()).toEqual(['defaultAudioLanguage']);
    expect(puts[0]).toEqual({ defaultAudioLanguage: 'en' });
    // 刷新后数据保持(服务端真值已更新)
    expect(mockPreferences.defaultAudioLanguage).toBe('en');
    expect(mockPreferences.themeMode).toBe('system');
    expect(mockPreferences.posterDensity).toBe('comfortable');
  });

  it('T011: 字幕语言自动保存,且保留「关闭字幕」选项', async () => {
    await renderPlaybackReady();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('select-subtitle-language'));
    const offOption = await screen.findByRole('option', { name: '关闭字幕 (Off)' });
    expect(offOption).toBeInTheDocument();
    await user.click(offOption);

    await waitFor(() => {
      expect(screen.getByTestId('playback-save-status')).toHaveTextContent('已保存');
    });
    expect(screen.getByTestId('select-subtitle-language')).toHaveTextContent('关闭字幕 (Off)');

    const puts = putBodies();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ defaultSubtitleLanguage: 'none' });
    expect(mockPreferences.defaultSubtitleLanguage).toBe('none');
  });

  it('T011: 自动播放下一集开关(可访问名称保留;指针与键盘均可切换)', async () => {
    await renderPlaybackReady();

    // 可访问名称 = 「自动播放下一集」(sr-only Label 关联开关控件,无旁路重复文字)
    const control = screen.getByRole('switch', { name: '自动播放下一集' });
    const user = userEvent.setup();

    // 真实指针路径:点击可见轨道(switch-control,须位于可点击 Switch.Content label 内;
    // 回归钉——Control 在 Content 外时点击轨道无效,getByRole 直点 input 探不到)
    const track = screen
      .getByTestId('switch-autoplay-next')
      .querySelector('[data-slot="switch-control"]') as HTMLElement | null;
    expect(track).not.toBeNull();
    expect(track?.closest('label')?.contains(control)).toBe(true);
    await user.click(track as HTMLElement);
    await waitFor(() => {
      expect(screen.getByTestId('playback-save-status')).toHaveTextContent('已保存');
    });
    expect(putBodies()).toEqual([{ autoPlayNext: false }]);

    // 键盘路径:焦点在控件上按空格同样切换并自动保存
    await user.click(control);
    control.focus();
    await user.keyboard('{Space}');
    await waitFor(() => {
      expect(mockPreferences.autoPlayNext).toBe(true);
    });
    expect(putBodies().map((b) => b.autoPlayNext)).toEqual([false, true]);
  });

  it('T011: 快速连续修改串行提交,按字段保留最新值', async () => {
    await renderPlaybackReady();

    await chooseOption('select-audio-language', '英语 (English)');
    await chooseOption('select-audio-language', '日语 (Japanese)');
    await waitFor(() => {
      expect(screen.getByTestId('playback-save-status')).toHaveTextContent('已保存');
    });
    await waitFor(() => {
      expect(mockPreferences.defaultAudioLanguage).toBe('ja');
    });

    const audioValues = putBodies().map((b) => b.defaultAudioLanguage);
    // 串行按序:首拍 en、续拍保留最新值 ja
    expect(audioValues).toEqual(['en', 'ja']);
  });

  it('T011: 保存期间回读不覆盖未保存修改(脏字段守护)', async () => {
    await renderPlaybackReady();

    holdPut = true;
    await chooseOption('select-audio-language', '英语 (English)'); // PUT1 挂起(服务端真值仍是 subtitle=zh)
    await chooseOption('select-subtitle-language', '关闭字幕 (Off)'); // 并入待提交队列
    holdPut = false; // 后续续拍正常响应
    releaseFirstHeldPut(); // 仅放行 PUT1 → 失效回读返回「subtitle 仍为 zh」的过期真值
    await waitFor(() => {
      expect(putBodies().some((b) => b.defaultSubtitleLanguage === 'none')).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId('playback-save-status')).toHaveTextContent('已保存');
    });

    // 回读没有覆盖用户尚未保存的字幕选择,且最终已提交
    expect(screen.getByTestId('select-subtitle-language')).toHaveTextContent('关闭字幕 (Off)');
    expect(mockPreferences.defaultSubtitleLanguage).toBe('none');
    expect(mockPreferences.defaultAudioLanguage).toBe('en');
  });

  it('T011: 保存失败保留用户选择,重试成功', async () => {
    await renderPlaybackReady();

    failNextPut = true;
    await chooseOption('select-audio-language', '英语 (English)');
    await waitFor(() => {
      expect(screen.getByTestId('playback-save-status')).toHaveTextContent('保存失败');
    });
    // 失败不丢用户选择
    expect(screen.getByTestId('select-audio-language')).toHaveTextContent('英语 (English)');

    // 提供重试入口;点击后成功
    const retry = screen.getByTestId('playback-save-retry');
    await userEvent.click(retry);
    await waitFor(() => {
      expect(screen.getByTestId('playback-save-status')).toHaveTextContent('已保存');
    });
    expect(mockPreferences.defaultAudioLanguage).toBe('en');
    const puts = putBodies();
    expect(puts).toHaveLength(2);
    expect(puts[1]).toEqual({ defaultAudioLanguage: 'en' });
  });

  it('T011: 切换档案丢弃旧档案待提交状态,不串档', async () => {
    await renderPlaybackReady();

    holdPut = true;
    await chooseOption('select-audio-language', '英语 (English)'); // PUT1 挂起(p1 在途)

    // 切换到另一档案:generation 递增,丢弃待提交状态,等待新档案数据
    activeSession = makeSession('p2');

    releaseHeldPuts(); // p1 的在途保存完成 → 结果不得驱动本页状态
    await waitFor(() => {
      // 新档案键触发重新读取
      expect(recordedFetches.filter((f) => f.method === 'GET').length).toBeGreaterThanOrEqual(2);
    });

    // 在途 PUT 放行后没有派生新 PUT(待提交补丁已随切档丢弃;旧值不写入新档案)
    expect(putBodies()).toHaveLength(1);
    expect(screen.getByTestId('playback-save-status').textContent).not.toContain('保存失败');
  });

  it('T012: 外观偏好页提供深浅模式，并标注设备特有项', async () => {
    renderWithClient(<SettingsAppearancePage />);
    expect(await screen.findByTestId('settings-appearance-page')).toBeInTheDocument();

    const hint = screen.getByTestId('device-specific-hint');
    expect(hint).toHaveTextContent('（仅当前设备有效）');

    const saveButton = screen.getByTestId('save-appearance-preferences');
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(screen.getByTestId('app-toast-region')).toHaveTextContent('外观偏好已保存');
    });

    const putCall = recordedFetches.find((f) => f.method === 'PUT' && f.url.includes('/api/profile/preferences'));
    expect(putCall).toBeDefined();
    expect(putCall?.body).toMatchObject({
      themeMode: 'system',
      posterDensity: 'comfortable',
    });
  });
});
