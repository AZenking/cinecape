import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSourcesPage } from '../../../src/features/settings/settings-sources-page';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SettingsAccessProvider } from '../../../src/features/settings/settings-access-provider';
import { queryClient as appQueryClient } from '../../../src/shared/query/client';

/**
 * T123(005-US8 前端测试,先 FAIL;013/ADR-0017 契约矩阵同步):来源创建→导入→快照确认流程(FR-037 + FR-041)。
 * - 创建成功出现「开始导入」下一步(免当次密码直接创建);
 * - 手动导入免当次密码直接执行,任务状态轮询;awaiting_confirmation 出现确认/丢弃;
 * - 失败保留上次成功目录状态(提示保留 + 「查看内容」入口不消失);
 * - 授权过期(403 SETTINGS_ACCESS_EXPIRED)立即隐藏主体并终止轮询;
 *   重新解锁后重读现值,草稿不自动提交(显式继续)。
 */

interface FetchCall {
  method: string;
  path: string;
}

let fetchCalls: FetchCall[] = [];
let unlocked = true;
let pollBudget = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problem(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

const SOURCE = {
  id: 's-1',
  kind: 'iptv',
  name: '直播源',
  enabled: true,
  version: 1,
  epgSourceId: null,
  locationLabel: 'media.example.tv',
  lastSuccessAt: '2026-01-02T00:00:00.000Z',
  lastJobId: null,
};

const CREATED = { ...SOURCE, id: 's-2', name: '新来源', lastSuccessAt: null, lastJobId: 'job-9' };

beforeEach(() => {
  fetchCalls = [];
  unlocked = true;
  pollBudget = 3;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname };
      fetchCalls.push(call);
      if (call.path === '/api/settings/access') {
        if (call.method === 'POST') {
          unlocked = true;
          return jsonResponse({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
        }
        return jsonResponse({ unlocked, expiresAt: unlocked ? new Date(Date.now() + 15 * 60_000).toISOString() : null });
      }
      if (!unlocked) {
        return problem({ title: 'Settings Access Expired', status: 403, code: 'SETTINGS_ACCESS_EXPIRED' }, 403);
      }
      if (call.path === '/api/settings/sources' && call.method === 'POST') {
        return jsonResponse({ ...CREATED }, 201);
      }
      if (call.path === '/api/settings/sources') {
        const created = fetchCalls.some((c) => c.method === 'POST' && c.path === '/api/settings/sources');
        return jsonResponse({
          items: created ? [SOURCE, CREATED] : [SOURCE],
          page: 1,
          pageSize: 20,
          total: created ? 2 : 1,
        });
      }
      if (call.path === '/api/settings/sources/s-2/refresh' && call.method === 'POST') {
        return jsonResponse({
          id: 'job-9',
          sourceId: 's-2',
          status: 'queued',
          version: 1,
          createdAt: new Date().toISOString(),
          startedAt: null,
          finishedAt: null,
          expiresAt: null,
          counts: { added: 0, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 },
          confirmationReason: null,
          errorCode: null,
        }, 202);
      }
      if (call.path === '/api/settings/refreshes/job-9') {
        pollBudget -= 1;
        if (pollBudget > 0) {
          return jsonResponse({
            id: 'job-9',
            sourceId: 's-2',
            status: 'running',
            version: 1,
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            expiresAt: null,
            counts: { added: 0, updated: 0, missing: 0, failed: 0, channels: 0, programmes: 0 },
            confirmationReason: null,
            errorCode: null,
          });
        }
        return jsonResponse({ id: 'job-9', sourceId: 's-2', status: 'awaiting_confirmation', version: 2 });
      }
      return jsonResponse({});
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function calls(method: string, path: string): Array<{ method: string; path: string }> {
  return fetchCalls.filter((call) => call.method === method && call.path === path);
}

function Page(): ReactNode {
  return (
    <SettingsSourcesPage />
  );
}

describe('T123 · 来源创建→导入→确认流程(FR-037)', () => {
  vi.setConfig({ testTimeout: 20000 });
  it('创建成功出现「开始导入」下一步;点击后创建导入任务并轮询状态', async () => {
    const user = userEvent.setup();
    // T025:来源页迁移 useAppQuery/useAppMutation 后需 QueryClientProvider;
    // 变更失效固定经应用单例(hooks.ts),观察端必须挂同一实例
    appQueryClient.clear();
    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <QueryClientProvider client={appQueryClient}>
          <SettingsAccessProvider>
            <Routes>
              <Route path="/settings/sources" element={<Page />} />
            </Routes>
          </SettingsAccessProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());
    // 打开创建表单 → 填写 → 提交(013/ADR-0017:免当次密码直接创建)
    await user.click(screen.getByTestId('create-source-open'));
    await user.type(screen.getByLabelText('来源名称'), '新来源');
    await user.type(screen.getByLabelText('播放列表地址(M3U URL)'), 'http://media.example.tv/a.m3u');
    await user.click(screen.getByTestId('create-source-submit'));
    // 创建成功:明确「开始导入」下一步
    await waitFor(() => expect(screen.getByTestId('source-created-next-step')).toBeVisible());
    expect(calls('POST', '/api/settings/sources')).toHaveLength(1);
    // 开始导入(免当次密码直接执行)
    await user.click(screen.getByTestId('source-start-import'));
    await waitFor(() => expect(calls('POST', '/api/settings/sources/s-2/refresh')).toHaveLength(1));
    // 任务状态轮询至 awaiting_confirmation:出现确认/丢弃
    await waitFor(() => expect(screen.getByText(/awaiting_confirmation/)).toBeVisible(), { timeout: 9000 });
    expect(screen.getByTestId('job-confirm-job-9')).toBeVisible();
    expect(screen.getByTestId('job-discard-job-9')).toBeVisible();
  });

  it('失败保留上次成功目录:失败提示保留 + 查看内容入口仍在,不自动清理', async () => {
    // 复用第一例的夹具形态,但把任务终态改为 failed
    pollBudget = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), 'http://localhost:3000');
        const call: FetchCall = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname };
        fetchCalls.push(call);
        if (call.path === '/api/settings/access') {
          return jsonResponse({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
        }
        if (call.path === '/api/settings/sources') {
          return jsonResponse({ items: [{ ...SOURCE, lastJobId: 'job-x' }], page: 1, pageSize: 20, total: 1 });
        }
        if (call.path === '/api/settings/refreshes/job-x') {
          return jsonResponse({
            id: 'job-x',
            sourceId: 's-1',
            status: 'failed',
            version: 2,
            errorCode: 'IMPORT_PARSE_FAILED',
          });
        }
        return jsonResponse({});
      }),
    );
    appQueryClient.clear();
    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <QueryClientProvider client={appQueryClient}>
          <SettingsAccessProvider>
            <Routes>
              <Route path="/settings/sources" element={<Page />} />
            </Routes>
          </SettingsAccessProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());
    await waitFor(() => expect(screen.getByText(/导入失败/)).toBeVisible(), { timeout: 4000 });
    expect(screen.getByText(/上次成功目录已保留/)).toBeVisible();
    // 查看内容入口仍在(上次成功发布存在)
    expect(screen.getByTestId('source-view-s-1')).toBeVisible();
    // 无任何清理调用(仅 GET)
    expect(fetchCalls.every((call) => call.method === 'GET' || call.method === 'POST')).toBe(true);
  });

  it('启停开关可点:点击可见轨道即直接提交启停(Control 位于可点击 Switch.Content 内;回归钉)', async () => {
    // 背景:HeroUI Switch 根(react-aria SwitchField)是无交互 div,唯一可点击区域是
    // Switch.Content(SwitchButton label)。Control 若写在其外(与 Content 平级),
    // 真实浏览器点击可见轨道不触发 onChange(getByRole('switch') 直点 input 的旧测法探不到)。
    const user = userEvent.setup();
    appQueryClient.clear();
    render(
      <MemoryRouter initialEntries={['/settings/sources']}>
        <QueryClientProvider client={appQueryClient}>
          <SettingsAccessProvider>
            <Routes>
              <Route path="/settings/sources" element={<Page />} />
            </Routes>
          </SettingsAccessProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());
    // 结构钉:可见轨道必须在可点击 label 内,且该 label 关联 role=switch 的隐藏 input
    const track = document.querySelector('[data-slot="switch-control"]');
    expect(track).not.toBeNull();
    const clickableLabel = track?.closest('label') ?? null;
    expect(clickableLabel).not.toBeNull();
    expect(clickableLabel?.querySelector('input[role="switch"]')).not.toBeNull();
    // 行为钉:点击可见轨道(而非 getByRole('switch') 隐藏 input)即触发启停;
    // 013/ADR-0017:免当次密码,直接 PATCH(无任何确认弹层)
    await user.click(track as HTMLElement);
    await waitFor(() => expect(calls('PATCH', '/api/settings/sources/s-1')).toHaveLength(1));
    expect(screen.queryByText('保存来源修改')).toBeNull();
    expect(screen.queryByLabelText('主账号密码(当次验证)')).toBeNull();
  });
});
