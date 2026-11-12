import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import * as sessionModule from '../../src/app/session-provider';
import type { AccountSession } from '../../src/app/session-types';
import { SettingsLayout } from '../../src/layouts/SettingsLayout';
import { SettingsNasVodSourcesPage } from '../../src/features/settings/settings-sources-page';
import { SettingsIptvPage } from '../../src/features/settings/settings-iptv-page';
import { SettingsGeneralPage } from '../../src/features/settings/settings-general-page';
import { AppToastRegion } from '../../src/shared/ui';

/**
 * T014: 管理员免二次验 PIN 畅行设置测试 (013 US2;013/ADR-0017 契约矩阵同步)
 *
 * 断言：
 * 1. 当当前 Profile 为管理员 (isMain === true) 时，进入 NAS/点播 (/settings/sources)、
 *    IPTV 管理 (/settings/iptv)、通用设置 (/settings/general) 等页面时不再被全屏遮罩
 *    门禁 (SettingsUnlockGate) 拦截。
 *    设置菜单拆分背景:原「来源管理/EPG 管理」两页已重组为「IPTV 管理」(直播源/EPG 来源/
 *    频道匹配三标签)与「NAS/点播」(NAS/在线点播过滤),本套件按新菜单面验证零门禁;
 * 2. 管理员直接看到配置表单与操作入口；
 * 3. 进行常规管理操作（如编辑通用设置）零二次 PIN/密码弹窗阻断:保存直接生效,
 *    PATCH /settings/household 请求体不携带 ownerPassword(服务端 strict 契约拒绝
 *    未知字段);013/ADR-0017 起常规运维免当次密码;
 * 4. 全屏门禁组件已随 ADR-0017 删除:管理路由由 AdminRouteGuard 声明式守卫(体验层) +
 *    服务端 SettingsGuard 403 FORBIDDEN(安全底线)承担,不再存在任何 PIN 遮罩组件。
 */

function createSession(isMain: boolean): AccountSession {
  return {
    sessionId: 'session-test-id',
    account: { id: 'acc-1', username: 'admin-user', role: 'owner' },
    activeProfile: {
      id: isMain ? 'profile-admin-main' : 'profile-normal-member',
      name: isMain ? '主管理员' : '普通家庭成员',
      avatar: null,
      type: 'adult',
      isDefault: isMain,
      isMain,
      pinProtected: false,
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    expiresAt: '2026-12-31T23:59:59Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
  };
}

function mockSessionValue(isMain: boolean) {
  return {
    status: 'authenticated' as const,
    session: createSession(isMain),
    needsReselection: false,
    personalCacheKey: isMain ? 'admin-cache' : 'member-cache',
    refresh: vi.fn(),
    applySession: vi.fn(),
    logout: vi.fn(),
  };
}

let mockHousehold = {
  id: 'hh-1',
  name: '我的家庭',
  language: 'zh-CN',
  timezone: 'Asia/Shanghai',
  version: 1,
};

const mockSources = {
  items: [
    {
      id: 'src-1',
      name: '中央广播电视',
      kind: 'iptv' as const,
      enabled: true,
      remoteUrl: 'http://iptv.example/live.m3u',
      locationLabel: 'http://iptv.example/live.m3u',
      version: 1,
      lastSuccessAt: null,
      lastJobId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      // NAS/点播页(kinds=['nas','vod'])过滤后应直接可见的 NAS 来源
      id: 'src-nas-1',
      name: '家庭 NAS 影库',
      kind: 'nas' as const,
      enabled: true,
      locationLabel: 'nas://media/movies',
      version: 1,
      lastSuccessAt: null,
      lastJobId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  total: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/settings/household')) {
        if (method === 'GET') {
          return jsonResponse(mockHousehold);
        }
        if (method === 'PATCH') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          mockHousehold = { ...mockHousehold, ...body, version: mockHousehold.version + 1 };
          return jsonResponse(mockHousehold);
        }
      }

      if (url.includes('/settings/sources')) {
        if (method === 'GET') {
          return jsonResponse(mockSources);
        }
      }

      if (url.includes('/settings/profiles')) {
        return jsonResponse([
          {
            id: 'profile-admin-main',
            name: '主管理员',
            isMain: true,
            status: 'active',
            type: 'adult',
            version: 1,
            pinProtected: false,
          },
        ]);
      }

      return jsonResponse({ error: 'not found' }, 404);
    }),
  );
}

describe('T014 · 管理员免二次验 PIN 畅行设置测试 (013 US2)', () => {
  beforeEach(() => {
    appQueryClient.clear();
    mockHousehold = {
      id: 'hh-1',
      name: '我的家庭',
      language: 'zh-CN',
      timezone: 'Asia/Shanghai',
      version: 1,
    };
    installFetchMock();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('管理员访问 NAS/点播与 IPTV 管理页面零门禁阻断', () => {
    it('当前 Profile 为管理员时，进入 NAS/点播页面 (/settings/sources) 不被全屏遮罩门禁拦截，直接看到来源内容', async () => {
      vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue(mockSessionValue(true));

      render(
        <QueryClientProvider client={appQueryClient}>
          <MemoryRouter initialEntries={['/settings/sources']}>
            <Routes>
              <Route path="/settings" element={<SettingsLayout />}>
                {/* 菜单拆分:sources 键挂 NAS/点播过滤页(仅 NAS/在线点播两类) */}
                <Route path="sources" element={<SettingsNasVodSourcesPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // 断言：全屏遮罩门禁与 PIN 输入框完全不出现
      expect(screen.queryByText('设置已锁定')).toBeNull();
      expect(screen.queryByText(/输入主档案 PIN/i)).toBeNull();
      expect(screen.queryByLabelText(/设置 PIN/i)).toBeNull();
      expect(screen.queryByTestId('settings-locked-placeholder')).toBeNull();

      // 断言：直接看到 NAS/点播页面的标题(原「来源管理」收窄后的新菜单名)和新建来源按钮
      expect(await screen.findByRole('heading', { name: 'NAS/点播' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '新建来源' })).toBeInTheDocument();

      // 验证已直接加载并显示了现有来源(过滤后仅 NAS/点播:IPTV 来源不在本页列表)
      expect(await screen.findByText('家庭 NAS 影库')).toBeInTheDocument();
      expect(screen.queryByText('中央广播电视')).toBeNull();
    });

    it('当前 Profile 为管理员时，进入 IPTV 管理页面 (/settings/iptv) 的频道管理标签不被全屏遮罩门禁拦截，直接看到频道管理表格', async () => {
      vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue(mockSessionValue(true));

      render(
        <QueryClientProvider client={appQueryClient}>
          {/* 菜单拆分:原「EPG 管理」(/settings/epg) 并入 IPTV 管理的「频道资产」标签(?tab=matching 深链) */}
          <MemoryRouter initialEntries={['/settings/iptv?tab=matching']}>
            <Routes>
              <Route path="/settings" element={<SettingsLayout />}>
                <Route path="iptv" element={<SettingsIptvPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // 断言：不被全屏遮罩阻断
      expect(screen.queryByText('设置已锁定')).toBeNull();
      expect(screen.queryByText(/输入主档案 PIN/i)).toBeNull();
      expect(screen.queryByTestId('settings-locked-placeholder')).toBeNull();

      // 断言：直接渲染 IPTV 管理页面(频道管理标签:018 移除冗余工作台标题,
      // 以工具栏 + 频道表格呈现)
      expect(await screen.findByRole('heading', { name: 'IPTV 管理' })).toBeInTheDocument();
      expect(await screen.findByTestId('channel-toolbar')).toBeInTheDocument();
    });
  });

  describe('管理员访问通用设置与常规操作零二次 PIN 弹窗', () => {
    it('管理员进入通用设置页面 (/settings/general)，直接看到配置表单并可就地编辑保存，操作过程零 PIN/密码弹窗', async () => {
      const user = userEvent.setup();
      vi.spyOn(sessionModule, 'useOptionalSession').mockReturnValue(mockSessionValue(true));

      render(
        <QueryClientProvider client={appQueryClient}>
          {/* 013:操作提示统一走 Toast(SettingsLayout 已内挂 SettingsAccessProvider) */}
          <AppToastRegion />
          <MemoryRouter initialEntries={['/settings/general']}>
            <Routes>
              <Route path="/settings" element={<SettingsLayout />}>
                <Route path="general" element={<SettingsGeneralPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // 断言：页面未被门禁阻断，直接加载表单
      expect(screen.queryByText('设置已锁定')).toBeNull();
      expect(screen.queryByLabelText(/设置 PIN/i)).toBeNull();

      // 等待通用设置数据加载完成并渲染输入字段
      expect(await screen.findByDisplayValue('我的家庭')).toBeInTheDocument();
      expect(screen.getByDisplayValue('zh-CN')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Asia/Shanghai')).toBeInTheDocument();

      // 用户就地修改家庭名称
      const nameInput = screen.getByDisplayValue('我的家庭');
      fireEvent.change(nameInput, { target: { value: '爱家影视空间' } });

      // 验证保存按钮激活且期间无任何 PIN 弹窗索要
      const saveButton = screen.getByTestId('general-save');
      expect(saveButton).toBeEnabled();
      expect(screen.queryByText(/输入主档案 PIN/i)).toBeNull();
      expect(screen.queryByLabelText(/设置 PIN/i)).toBeNull();

      // 013/ADR-0017:常规运维免当次密码——点击保存直接生效,零密码弹层
      await user.click(saveButton);
      expect(await screen.findByTestId('app-toast-region')).toHaveTextContent('家庭设置已保存');
      const patchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/settings/household') && String(init?.method ?? 'GET').toUpperCase() === 'PATCH',
      );
      expect(patchCalls).toHaveLength(1);
      const patchBody = JSON.parse(String(patchCalls[0]?.[1]?.body ?? '{}')) as Record<string, unknown>;
      expect(patchBody.name).toBe('爱家影视空间');
      // 请求体不携带 ownerPassword(服务端 strict 契约拒绝未知字段)
      expect(patchBody).not.toHaveProperty('ownerPassword');
      expect(screen.queryByLabelText('主账号密码(当次验证)')).toBeNull();
    });
  });

  // (SettingsUnlockGate 组件断言已随组件删除移除 —— 013 ADR-0017 废除全屏门禁)
});
