import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSourcesPage } from '../src/features/settings/settings-sources-page';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SettingsAccessProvider } from '../src/features/settings/settings-access-provider';
import { AppToastRegion } from '../src/shared/ui';
import { Toast } from '@heroui/react';
import { SettingsLayout } from '../src/layouts/SettingsLayout';
import { queryClient as appQueryClient } from '../src/shared/query/client';
import type { Vod } from '@hmp/shared';

/**
 * T034(010 US1 web 侧,新增;013/ADR-0017 契约矩阵同步):来源管理页 vod 增量契约钉。
 *
 * 对照 docs/specs/010-online-vod/contracts/api.md §2(Settings 行)与冻结 openapi
 * (packages/shared vod-schema:Source/SourceTestResult/VodCreateSourceRequest/
 *  VodPatchSourceRequest):
 * - V1 kind=vod 创建:创建体严格 = VodCreateSourceRequest(kind/name/remoteUrl/adapter),
 *   免当次密码、不携带 ownerPassword/enabled/privateAccessApproved/NAS 字段(未知字段
 *   服务端拒绝);adapter=apple-cms-json 固定展示;NAS 专属字段隐藏;
 * - V2 测试:POST /settings/sources/:id/test 免当次密码(无请求体);200 结果行内
 *   展示 reachable/compatible/reason 中文文案/capabilities(契约字段逐字);
 * - V3 vod 启停:PATCH 载荷恰 {enabled,expectedVersion}(免当次密码;启停使活动
 *   定位失效「定位版本递增」由服务端契约保证,013 起不再经弹层提示);
 * - V4 409 VOD_QUOTA_EXCEEDED(启用超净配额):页面按 problem detail 呈现
 *   (提示管理来源),不冒充版本冲突文案;
 * - V5 422 SOURCE_TARGET_DENIED:创建表单内呈现服务端拒绝原因(detail 稳定脱敏,
 *   无 URL 回显),表单保持不关闭;
 * - V6 403 SETTINGS_ACCESS_EXPIRED(测试路径后台失效):走既有 handleAccessLost
 *   重验证流——布局级弱提示告知授权变化与未保存编辑;
 * - V7 vod 无导入入口:行内不渲染「手动导入」(服务端对 vod refresh 稳定 400,
 *   隐藏属体验优化)、查看内容常驻可达;创建后下一步为「测试连通性」而非「开始导入」。
 *
 * rig 惯例(既有 settings 页面测试同款,apps/web/test/features/settings/
 * sources-flow.spec.tsx):stub 全局 fetch 走真实 privateFetch 底座,观察端挂
 * 应用单例 QueryClient(变更失效固定经 hooks.ts 单例);DTO 载荷按
 * @hmp/shared 生成的 Vod.components 形状手写最小合法对象,零真实网络。
 * 服务端拒绝优先:任何按钮隐藏/禁用只作体验优化,断言均钉在请求与响应呈现上。
 */

type SourceDto = Vod.components['schemas']['Source'];
type SourceTestResultDto = Vod.components['schemas']['SourceTestResult'];

interface FetchCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

let fetchCalls: FetchCall[] = [];
let unlocked = true;
/** 可按用例覆盖的动态应答(返回值直接作为响应体;抛出 problem 由 helper 构造) */
let postTestResponse: (() => SourceTestResultDto | { problem: unknown; status: number }) | null = null;
let patchSourceResponse: (() => { problem: unknown; status: number } | null) | null = null;
let postSourceResponse: (() => { problem: unknown; status: number } | null) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function problem(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } });
}

/** kind=vod 来源(010 契约 Source:kind=vod 附 capabilities;locationLabel 脱敏主机) */
const VOD_SOURCE: SourceDto = {
  id: 's-vod',
  kind: 'vod',
  name: '在线片源',
  enabled: true,
  version: 3,
  epgSourceId: null,
  locationLabel: 'vod.example.com',
  lastSuccessAt: null,
  lastJobId: null,
  capabilities: { resume: 'operational', requiresCurrentProbe: true },
};

function testResult(overrides: Partial<SourceTestResultDto> = {}): SourceTestResultDto {
  return {
    reachable: true,
    compatible: true,
    capabilities: { resume: 'operational', requiresCurrentProbe: true },
    reason: null,
    ...overrides,
  };
}

/** 仅挂 vod 来源的最小 rig;列表按已创建来源回填 */
function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === 'string' && init.body !== '') {
        body = JSON.parse(init.body) as Record<string, unknown>;
      }
      const call: FetchCall = { method, path: url.pathname, body };
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
        if (postSourceResponse !== null) {
          const outcome = postSourceResponse();
          if (outcome !== null) {
            return problem(outcome.problem, outcome.status);
          }
        }
        return jsonResponse({ ...VOD_SOURCE, name: String(call.body?.name ?? '在线片源') }, 201);
      }
      if (call.path === '/api/settings/sources' && call.method === 'GET') {
        return jsonResponse({ items: [VOD_SOURCE], page: 1, pageSize: 20, total: 1 });
      }
      if (call.path === '/api/settings/sources/s-vod' && call.method === 'PATCH') {
        if (patchSourceResponse !== null) {
          const outcome = patchSourceResponse();
          if (outcome !== null) {
            return problem(outcome.problem, outcome.status);
          }
        }
        return jsonResponse({ ...VOD_SOURCE, enabled: call.body?.enabled === false ? false : true, version: 4 });
      }
      if (call.path === '/api/settings/sources/s-vod/test' && call.method === 'POST') {
        if (postTestResponse !== null) {
          const outcome = postTestResponse();
          if ('problem' in outcome) {
            return problem(outcome.problem, outcome.status);
          }
          return jsonResponse(outcome);
        }
        return jsonResponse(testResult());
      }
      return jsonResponse({});
    }),
  );
}

beforeEach(() => {
    // Toast 队列为模块级共享:清空避免上一用例遗留文案污染本用例断言
    Toast.toast.clear();
  fetchCalls = [];
  unlocked = true;
  postTestResponse = null;
  patchSourceResponse = null;
  postSourceResponse = null;
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function calls(method: string, path: string): FetchCall[] {
  return fetchCalls.filter((call) => call.method === method && call.path === path);
}

function Page(): ReactNode {
  return (
    <SettingsSourcesPage />
  );
}

function renderPage(): void {
  appQueryClient.clear();
  render(
    <MemoryRouter initialEntries={['/settings/sources']}>
      <QueryClientProvider client={appQueryClient}>
        {/* 设置页操作提示统一走 Toast:挂区域消费模块级队列 */}
        <AppToastRegion />
        <SettingsAccessProvider>
          <Routes>
            <Route path="/settings" element={<SettingsLayout />}>
              <Route path="sources" element={<Page />} />
            </Route>
          </Routes>
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('T034 · 来源管理页 vod 增量(010 api.md §2)', () => {
  vi.setConfig({ testTimeout: 20000 });

  it('V1 kind=vod 创建:POST 体严格 = VodCreateSourceRequest(无 enabled/privateAccessApproved/NAS 字段);adapter 固定展示;行内 capabilities 徽标', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());
    // 既有行:kind=vod 徽标(契约字段逐字)与 locationLabel
    expect(screen.getByTestId('source-capabilities-s-vod')).toHaveTextContent(
      'resume:operational · requiresCurrentProbe:true',
    );
    expect(screen.getByText(/vod\.example\.com/)).toBeInTheDocument();

    await user.click(screen.getByTestId('create-source-open'));
    await user.click(screen.getByRole('tab', { name: '在线点播(VOD)' }));
    // adapter 固定 apple-cms-json 展示(内置唯一适配器)
    expect(screen.getByTestId('create-vod-adapter')).toHaveTextContent('apple-cms-json');
    // NAS/EPG 专属字段在 vod 下隐藏
    expect(screen.queryByLabelText('NAS 根目录')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('相对目录')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('来源名称'), '我的片源');
    await user.type(screen.getByLabelText('在线点播根地址(Apple CMS URL)'), 'https://vod.example.com/api.php');
    // 013/ADR-0017:创建来源免当次密码,提交即直接创建(无密码弹层)
    await user.click(screen.getByTestId('create-source-submit'));

    await waitFor(() => expect(calls('POST', '/api/settings/sources')).toHaveLength(1));
    const body = calls('POST', '/api/settings/sources')[0]?.body ?? {};
    // 严格契约形状:恰四键(免当次密码不带 ownerPassword;未知字段服务端拒绝,
    // 不携带 enabled/privateAccessApproved/NAS/EPG 字段)
    expect(Object.keys(body).sort()).toEqual(['adapter', 'kind', 'name', 'remoteUrl']);
    expect(body.kind).toBe('vod');
    expect(body.adapter).toBe('apple-cms-json');
    expect(body.name).toBe('我的片源');
    expect(body.remoteUrl).toBe('https://vod.example.com/api.php');
    // 创建成功明确「开始导入」下一步
    await waitFor(() => expect(screen.getByTestId('source-created-next-step')).toBeVisible());
  });

  it('V2 测试:POST :id/test 免当次密码(无请求体);结果行内展示 reachable/compatible/reason 中文文案/capabilities', async () => {
    postTestResponse = () =>
      testResult({ reachable: false, compatible: false, reason: 'timeout' });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());

    await user.click(screen.getByTestId('source-test-s-vod'));

    await waitFor(() => expect(calls('POST', '/api/settings/sources/s-vod/test')).toHaveLength(1));
    // 免当次密码:请求体不携带 ownerPassword(013/ADR-0017;探测为纯读,无请求体)
    const testCall = calls('POST', '/api/settings/sources/s-vod/test')[0];
    expect(testCall?.body).toBeNull();
    // 行内结果:不可达/不兼容/reason 中文文案/能力逐字(测试不写媒体:无任何失效翻新请求)
    const result = await screen.findByTestId('source-test-result-s-vod');
    expect(result).toHaveTextContent('不可达');
    expect(result).toHaveTextContent('格式不兼容');
    expect(result).toHaveTextContent('原因:探测超时');
    expect(result).toHaveTextContent('resume:operational · requiresCurrentProbe:true');
    expect(calls('POST', '/api/settings/sources')).toHaveLength(0);
  });

  it('V3 vod 启停:PATCH 载荷恰 {enabled,expectedVersion}(免当次密码,直接保存)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());

    // 013/ADR-0017:启停免当次密码,点击即直接 PATCH(无任何密码弹层)
    await user.click(screen.getByTestId('source-toggle-s-vod'));

    await waitFor(() => expect(calls('PATCH', '/api/settings/sources/s-vod')).toHaveLength(1));
    const body = calls('PATCH', '/api/settings/sources/s-vod')[0]?.body ?? {};
    // 契约 VodPatchSourceRequest 免密码面:恰 {enabled,expectedVersion}(无根地址字段入口)
    expect(Object.keys(body).sort()).toEqual(['enabled', 'expectedVersion']);
    expect(body.enabled).toBe(false);
    expect(body.expectedVersion).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(body, 'remoteUrl')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('V4 409 VOD_QUOTA_EXCEEDED:页面按 problem detail 呈现(提示管理来源),不冒充版本冲突文案', async () => {
    patchSourceResponse = () => ({
      problem: { title: 'Vod Quota Exceeded', status: 409, code: 'VOD_QUOTA_EXCEEDED', detail: '来源或配额已达上限,请管理来源与配额' },
      status: 409,
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());

    await user.click(screen.getByTestId('source-toggle-s-vod'));

    await waitFor(() => expect(calls('PATCH', '/api/settings/sources/s-vod')).toHaveLength(1));
    const region = await screen.findByTestId('app-toast-region');
    expect(region).toHaveTextContent('来源或配额已达上限,请管理来源与配额');
    // 不与版本冲突文案混淆
    expect(region).not.toHaveTextContent('版本冲突');
  });

  it('V5 422 SOURCE_TARGET_DENIED:创建表单内呈现服务端拒绝原因(稳定脱敏,无 URL 回显),表单保持', async () => {
    postSourceResponse = () => ({
      problem: { title: 'Source Target Denied', status: 422, code: 'SOURCE_TARGET_DENIED', detail: '远程目标仅允许 http/https 协议' },
      status: 422,
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());

    await user.click(screen.getByTestId('create-source-open'));
    await user.click(screen.getByRole('tab', { name: '在线点播(VOD)' }));
    await user.type(screen.getByLabelText('来源名称'), '被拒片源');
    await user.type(screen.getByLabelText('在线点播根地址(Apple CMS URL)'), 'ftp://vod.example.com/api.php');
    await user.click(screen.getByTestId('create-source-submit'));

    await waitFor(() => expect(calls('POST', '/api/settings/sources')).toHaveLength(1));
    // 拒绝原因 = 服务端 detail(稳定脱敏短语);不回显用户输入的 URL 原文。
    // 断言收窄到创建弹层内(同一失败同时经数据层 toast 轻提示,region 亦为 role=alert 形态)
    const dialog = await screen.findByRole('dialog');
    const alert = within(dialog).getByRole('alert');
    expect(alert).toHaveTextContent('远程目标仅允许 http/https 协议');
    expect(alert).not.toHaveTextContent('ftp://vod.example.com');
    // 013/ADR-0017:无当次密码弹层,表单保持可修改重试
    expect(screen.queryByLabelText('主账号密码(当次验证)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('来源名称')).toBeInTheDocument();
  });

  it('V6 403 SETTINGS_ACCESS_EXPIRED(测试路径后台失效):呈现服务端 detail 并终止轮询,无门禁/弹层接管(013)', async () => {
    postTestResponse = () => ({
      problem: { title: 'Settings Access Expired', status: 403, code: 'SETTINGS_ACCESS_EXPIRED', detail: '设置授权已过期,请重新验证后再试' },
      status: 403,
    });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());

    await user.click(screen.getByTestId('source-test-s-vod'));

    await waitFor(() => expect(calls('POST', '/api/settings/sources/s-vod/test')).toHaveLength(1));
    // 013:解锁门已废除 —— 主体保留;布局级 FR-041 弱提示告知授权变化与未保存编辑
    const notice = await screen.findByTestId('settings-access-lost-notice');
    expect(notice).toHaveTextContent('检测到管理授权变化,编辑未保存');
    // 无 PIN 门禁/遮罩接管(全屏解锁门组件已随 ADR-0017 删除)
    expect(screen.queryByText('设置已锁定')).toBeNull();
    expect(screen.queryByLabelText(/设置 PIN/i)).toBeNull();
    expect(screen.getByTestId('source-list')).toBeVisible();
  });

  it('V7 vod 无导入入口:行内无「手动导入」、查看内容常驻;创建后下一步为测试而非导入', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('source-list')).toBeVisible());
    // 行内:服务端对 vod refresh 稳定 400(在线点播无导入面),入口隐藏属体验优化,
    // 服务端拒绝仍为准绳;查看内容不依赖「上次成功导入」(vod 无导入语义)
    expect(screen.queryByTestId('source-import-s-vod')).not.toBeInTheDocument();
    expect(screen.getByTestId('source-view-s-vod')).toBeVisible();

    // 创建成功:引导「测试连通性」并说明无需导入;「开始导入」不再出现
    await user.click(screen.getByTestId('create-source-open'));
    await user.click(screen.getByRole('tab', { name: '在线点播(VOD)' }));
    await user.type(screen.getByLabelText('来源名称'), '再建片源');
    await user.type(screen.getByLabelText('在线点播根地址(Apple CMS URL)'), 'https://vod.example.com/api.php/provide/vod');
    await user.click(screen.getByTestId('create-source-submit'));
    await waitFor(() => expect(screen.getByTestId('source-created-next-step')).toBeVisible());
    expect(screen.getByTestId('source-created-next-step')).toHaveTextContent('无需导入');
    expect(screen.queryByTestId('source-start-import')).not.toBeInTheDocument();
    // 下一步按钮接通既有测试流(013 起免当次密码直接探测):POST :id/test 即发
    await user.click(screen.getByTestId('source-start-test'));
    await waitFor(() => expect(calls('POST', '/api/settings/sources/s-vod/test')).toHaveLength(1));
  });
});
