/**
 * T025(006 · US4 settings 数据层迁移)· 三态行为回归(settings-devices 页为代表):
 * - isPending 硬请求门控:即便缓存被外部注入旧值,挂载也先移除同键缓存并以加载态
 *   起始,绝不渲染缓存旧值(settings 域「进入必硬请求」契约的回归守卫;
 *   若 shared/query/hooks 的挂载清缓存保证回退,本用例将以重复取数/永不落定先红);
 * - isError → RetryableAlert(formatApiError 链式文案 + 显式重试 → refetch 成功);
 * - 成功 → 设备列表主体;撤销设备为 confirmed 变更:当次密码弹层提交、等待服务端
 *   确认、成功后失效 settings.devices 键以服务端真值回填(撤销标注出现)。
 *
 * 渲染基座与 favorites-optimistic 同构:真实 QueryClient(模块级单例,乐观写/失效
 * 固定经单例)+ AppToastRegion + SettingsAccessProvider;fetch 以 vi.stubGlobal 打桩。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppToastRegion } from '../../src/shared/ui';
import { queryKeys } from '../../src/shared/query/keys';
import { queryClient as appQueryClient } from '../../src/shared/query/client';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { SettingsDevicesPage } from '../../src/features/settings/settings-devices-page';

interface DeviceFixture {
  id: string;
  name: string | null;
  type: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function deviceOf(id: string, name: string, overrides: Partial<DeviceFixture> = {}): DeviceFixture {
  return {
    id,
    name,
    type: 'web',
    lastSeenAt: '2026-01-05T08:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 初次清单:两台活跃设备(标记 FRESH 便于与注入的陈旧值区分) */
const FRESH_DEVICES: DeviceFixture[] = [deviceOf('d-1', '客厅 FRESH'), deviceOf('d-2', '书房')];
/** 撤销回填:书房已撤销(服务端真值) */
const REVISED_DEVICES: DeviceFixture[] = [
  FRESH_DEVICES[0]!,
  deviceOf('d-2', '书房', { revokedAt: '2026-01-06T09:30:00.000Z' }),
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/** 手动决议控制器:稳定捕捉 pending 窗口(在途 → 断言中间态 → 决议 → 断言终态) */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type DevicesReply = () => Response | Promise<Response>;
let devicesReply: DevicesReply;
let devicesGetCalls = 0;
let revokeCalls = 0;
const revokeGate = deferred<void>();

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const path = url.pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path === '/api/settings/access') {
        return jsonResponse({ unlocked: true, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      }
      if (path === '/api/settings/devices' && method === 'GET') {
        devicesGetCalls += 1;
        return await devicesReply();
      }
      if (path === '/api/settings/devices/d-2/revoke' && method === 'POST') {
        revokeCalls += 1;
        await revokeGate.promise;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({}, 404);
    }),
  );
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/settings/devices']}>
      <QueryClientProvider client={appQueryClient}>
        <AppToastRegion />
        <SettingsAccessProvider>
          <SettingsDevicesPage />
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  installFetch();
  devicesGetCalls = 0;
  revokeCalls = 0;
  // 撤销确认后服务端真值:书房已撤销(经失效重取回填)
  devicesReply = () => jsonResponse(revokeCalls > 0 ? REVISED_DEVICES : FRESH_DEVICES);
  // 乐观写/失效固定经模块级单例(T004):每例先清空防止跨例泄漏
  appQueryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  appQueryClient.clear();
});

describe('T025 · settings-devices 三态行为(settings 域数据层回归)', () => {
  it('挂载即硬请求:外部注入的缓存旧值被清除,先加载态后现值(旧值无处可显)', async () => {
    const pendingDevices = deferred<Response>();
    devicesReply = () => pendingDevices.promise;
    // 模拟外部向同键注入旧值(persist/prefetch 防御场景):挂载后必须清缓存重取
    appQueryClient.setQueryData(queryKeys.settings.devices(), [deviceOf('d-stale', '陈旧缓存设备')]);

    renderPage();

    // isPending 门控:缓存旧值不渲染,加载态可见
    expect(screen.queryByTestId('device-list')).toBeNull();
    expect(screen.getByText('正在读取设备列表…')).toBeInTheDocument();
    expect(screen.queryByText('陈旧缓存设备')).toBeNull();

    // 服务端现值落定 → 列表呈现且仅含现值
    pendingDevices.resolve(jsonResponse(FRESH_DEVICES));
    const list = await screen.findByTestId('device-list');
    await waitFor(() => {
      expect(list.textContent).toContain('客厅 FRESH');
      expect(list.textContent).toContain('书房');
      expect(list.textContent).not.toContain('陈旧缓存设备');
    });
    // 挂载期恰好一次硬请求(若层退化为本页回归前的「每渲染重取」循环,此断言先红)
    await waitFor(() => expect(devicesGetCalls).toBe(1));
  });

  it('isError → RetryableAlert:formatApiError 链式文案 + 显式重试成功回数据态', async () => {
    devicesReply = () => jsonResponse({ status: 500, code: 'INTERNAL', title: 'INTERNAL' }, 500);

    renderPage();

    // isError → RetryableAlert:5xx 客户端重试 1 次(默认退避约 1s)后落错误态;
    // 文案经 formatApiError 映射(错误不只靠颜色)
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent('读取失败');
    expect(alert).toHaveTextContent('服务暂时不可用，请稍后重试');
    expect(screen.queryByTestId('device-list')).toBeNull();

    // 显式重试:服务端恢复 → refetch 成功回数据态
    devicesReply = () => jsonResponse(FRESH_DEVICES);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByTestId('device-list')).toBeInTheDocument());
    expect(screen.getByTestId('device-list').textContent).toContain('客厅 FRESH');
  });

  it('撤销设备:confirmed 变更等待服务端确认,成功后失效重取(撤销标注回填)', async () => {
    renderPage();
    const list = await screen.findByTestId('device-list');
    // 撤销标注形如「已于 {revokedAt} 撤销」:初态无「已于」(按钮文案「撤销设备」除外)
    expect(list.textContent).not.toContain('已于');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('device-revoke-d-2'));
    await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'password-123');
    await user.click(screen.getByTestId('password-submit'));

    // 撤销 POST 恰好一次;等待态期间列表保持原样(等待服务端确认,无乐观改动)
    await waitFor(() => expect(revokeCalls).toBe(1));
    expect(screen.getByTestId('device-list').textContent).not.toContain('已于');

    // 服务端确认(204)→ onSettled 失效 settings.devices → 重取回填撤销标注
    revokeGate.resolve(undefined);
    await waitFor(() => expect(screen.getByTestId('app-toast-region')).toHaveTextContent('设备已撤销'));
    await waitFor(() => {
      // 撤销标注渲染为「已于 {revokedAt} 撤销」:以服务端新真值的时间戳断言回填
      const revised = screen.getByTestId('device-list');
      expect(revised.textContent).toContain('已于 2026-01-06 09:30:00 撤销');
    });
    // 失效对账:设备列表被重取(初始 1 次 + 撤销后 1 次)
    await waitFor(() => expect(devicesGetCalls).toBe(2));
  });
});
