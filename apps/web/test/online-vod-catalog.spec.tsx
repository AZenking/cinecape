import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FetchApiError } from '../src/shared/fetch';
import type * as fetchModule from '../src/shared/fetch';
import type { FetchInit } from '../src/shared/fetch';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import type { QueryClient } from '@tanstack/react-query';
import { SessionProvider, useSession } from '../src/app/session-provider';
import type { AccountSession } from '../src/app/session-types';
import { VodCatalogPage } from '../src/features/catalog/VodCatalogPage';
import { OnlineVodDetailPage } from '../src/features/catalog/OnlineVodDetailPage';
import {
  createQueryWrapper,
  createTestQueryClient,
  deferred,
  flushQueries,
} from './helpers/query-test-utils';
import type { Vod } from '@hmp/shared';

/**
 * T032(010 US1 测试先行):在线点播搜索/详情契约钉。
 *
 * 覆盖 tasks.md T032 原文五要素:搜索恢复/过期/partial、跨页线路聚合、
 * 游客不发个人请求、物化幂等、选档后候选过期重选。对照契约:
 * - docs/specs/010-online-vod/contracts/api.md §1(SearchPage/VodPreview/
 *   Materialized/StableEpisodes DTO)、§2(已生成页重放不变、partial/reasons/
 *   expiresAt、两组参数互斥、缺 cursor 重放第一页)、§3(物化严格 oneOf 载荷)、
 *   §6(VOD_SEARCH_EXPIRED/VOD_PREVIEW_EXPIRED=410 保留 q、
 *   VOD_DETAIL_CHANGED=409 重读并明确重选);
 * - contracts/ui.md §1:/vod 保留 mode/q/searchId/cursor;/vod/titles/:titleRef
 *   游客可看,物化成功跳稳定 /media/:parentId,失败不跳;public 查询不夹带
 *   Profile 历史。
 *
 * mock 层(T019/T094 既有惯例):vi.mock 替换 publicFetch/privateFetch(其余导出
 * 保留真实实现,FetchApiError 可实例化——非 2xx 与真实底座同形抛出);DTO 载荷
 * 以 packages/shared 生成的 `Vod.components['schemas'][...]` 形状手写最小合法
 * 对象,零真实网络。路由用 MemoryRouter + 地址探针;会话用 SessionProvider
 * (经 mock 的 /auth/session 注入已选档/游客 401 两种身份)。
 *
 * 契约钉边界(避免过度约束):
 * - 不断言 queryKeys 形状(keys.ts 接线归 T034);
 * - 线路聚合规则:api.md 把「线路可跨页重复,按 lineRef 聚合」钉在 StableEpisodes
 *   消费端(稳定父详情,MediaDetailPage,亦归 T033);本文件在预览线路渲染上钉
 *   同一消费端规则——lines 中同 lineRef 重复出现必须合并为一个线路组、不重复渲染;
 * - UI 文案契约(报告同步 T033):搜索框可访问名「搜索在线资源」、提交按钮「搜索」、
 *   过期重搜按钮「重新搜索」、partial 提示含「部分来源暂不可用」与 reasons 原文、
 *   unsupported reason= format_unsupported 显示「格式不支持」、游客选集给「登录」
 *   提示;unsupported 集以 aria-disabled="true"(RAC 惯例)呈现不可选。
 */

type SearchPageDto = Vod.components['schemas']['SearchPage'];
type PublicVodCardDto = Vod.components['schemas']['PublicVodCard'];
type VodPreviewDto = Vod.components['schemas']['VodPreview'];
type VodPreviewLineDto = Vod.components['schemas']['VodPreviewLine'];
type VodPreviewEpisodeDto = Vod.components['schemas']['VodPreviewEpisode'];
type MaterializedDto = Vod.components['schemas']['Materialized'];

const publicFetchMock = vi.fn();
const privateFetchMock = vi.fn();

vi.mock('../src/shared/fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof fetchModule>();
  return {
    ...actual,
    publicFetch: (...args: Parameters<typeof actual.publicFetch>) => publicFetchMock(...args),
    privateFetch: (...args: Parameters<typeof actual.privateFetch>) => privateFetchMock(...args),
  };
});

/** operationKey 必须是 UUID(api.md §3 MaterializationRequest format:uuid) */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ────────────────────────── DTO 夹具(按 Vod 生成类型手写最小合法对象) ──────────────────────────

function vodCard(overrides: Partial<PublicVodCardDto> = {}): PublicVodCardDto {
  return {
    titleRef: 'tr-1',
    title: '例牌剧集',
    year: '2024',
    sourceLabel: '资源站A',
    posterRef: null,
    ...overrides,
  };
}

function searchPage(overrides: Partial<SearchPageDto> = {}): SearchPageDto {
  return {
    searchId: 's-1',
    items: [vodCard()],
    sources: [{ sourceRef: 'src-1', status: 'ok', hasMore: false }],
    nextCursor: null,
    partial: false,
    reasons: [],
    expiresAt: '2026-10-30T12:10:00.000Z',
    ...overrides,
  };
}

function previewEpisode(overrides: Partial<VodPreviewEpisodeDto> = {}): VodPreviewEpisodeDto {
  return { episodeRef: 'ep-1', label: '第 1 集', status: 'candidate', reason: null, ...overrides };
}

function previewLine(overrides: Partial<VodPreviewLineDto> = {}): VodPreviewLineDto {
  return {
    lineRef: 'L-1',
    name: '线路甲',
    episodes: [previewEpisode()],
    ...overrides,
  };
}

function preview(overrides: Partial<VodPreviewDto> = {}): VodPreviewDto {
  return {
    titleRef: 'tr-1',
    title: '例牌剧集',
    description: null,
    year: '2024',
    sourceLabel: '资源站A',
    posterRef: null,
    previewRevision: 3,
    fetchedAt: '2026-10-30T12:00:00.000Z',
    expiresAt: '2026-10-30T12:30:00.000Z',
    lines: [previewLine()],
    ...overrides,
  };
}

function materialized(overrides: Partial<MaterializedDto> = {}): MaterializedDto {
  return {
    parentMediaId: '11111111-1111-4111-8111-111111111111',
    mediaId: '22222222-2222-4222-8222-222222222222',
    detailRevision: 7,
    catalogRevision: 2,
    replayed: false,
    candidateRef: null,
    registeredCandidateRef: null,
    ...overrides,
  };
}

/** 已选档会话夹具(形状=AccountSession,T094 同款) */
function sessionFixture(): AccountSession {
  return {
    sessionId: 'session-1',
    account: { id: 'acc-1', username: 'admin', role: 'owner' },
    activeProfile: {
      id: 'profile-a',
      name: '妈妈',
      avatar: null,
      type: 'adult',
      isDefault: true,
      isMain: true,
      pinProtected: false,
      status: 'active',
      createdAt: '2026-10-26T00:00:00.000Z',
      version: 1,
    },
    expiresAt: '2026-11-26T00:00:00.000Z',
    householdId: 'hh-1',
    bootstrapRequired: false,
    profileContextVersion: 1,
  };
}

/** 结构化 problem+json 错误(经真实 FetchApiError,与底座非 2xx 抛出同形) */
function apiProblem(status: number, code: string, title: string): FetchApiError {
  return new FetchApiError({ status, title, code, problem: { status, title, code } });
}

// ────────────────────────── mock 布线与调用清单 ──────────────────────────

interface RecordedCall {
  path: string;
  init: FetchInit;
}

type RouteHandler = (path: string, init: FetchInit) => unknown;

function recorded(mock: ReturnType<typeof vi.fn>): RecordedCall[] {
  return (mock.mock.calls as Array<[string, FetchInit | undefined]>).map(([path, init]) => ({
    path,
    init: init ?? {},
  }));
}

function searchCalls(): RecordedCall[] {
  return recorded(publicFetchMock).filter((call) => call.path === '/public/vod/search');
}

function previewCalls(): RecordedCall[] {
  return recorded(publicFetchMock).filter((call) => call.path.startsWith('/public/vod/titles/'));
}

function materializeCalls(): RecordedCall[] {
  return recorded(privateFetchMock).filter((call) => call.path === '/vod/materializations');
}

/** 全部调用(双档)零个人路径:无 /me/** 与 /api/me/**(游客纯净契约) */
function expectNoPersonalRequests(): void {
  for (const call of [...recorded(publicFetchMock), ...recorded(privateFetchMock)]) {
    expect(call.path).not.toMatch(/\/api\/me(\/|$)/);
    expect(call.path).not.toMatch(/\/me(\/|$)/);
  }
}

/** 按 path 注册公共响应:函数=动态处理器,其余=直接返回的 JSON 载荷;未注册 404 */
function installPublicRoutes(routes: Record<string, unknown>): void {
  publicFetchMock.mockImplementation(async (path: string, init?: FetchInit) => {
    const entry = routes[path];
    if (entry === undefined) {
      throw apiProblem(404, 'NOT_FOUND', '内容不存在');
    }
    if (typeof entry === 'function') {
      return await (entry as RouteHandler)(path, init ?? {});
    }
    return entry;
  });
}

/**
 * 私有档布线:/auth/session 按身份夹具应答(游客=401 problem,与真实恢复失败同形);
 * /vod/materializations 交由 materialize 处理器;其余一律 404。
 */
function installPrivateRoutes(options: {
  authenticated: boolean;
  materialize?: RouteHandler;
}): void {
  privateFetchMock.mockImplementation(async (path: string, init?: FetchInit) => {
    if (path === '/auth/session') {
      if (!options.authenticated) {
        throw apiProblem(401, 'SESSION_INVALID', '登录状态已失效');
      }
      return sessionFixture();
    }
    if (path === '/vod/materializations' && options.materialize !== undefined) {
      return await options.materialize(path, init ?? {});
    }
    throw apiProblem(404, 'NOT_FOUND', '内容不存在');
  });
}

// ────────────────────────── 渲染基座 ──────────────────────────

/** 会话身份探针:等待 SessionProvider 恢复到目标身份后再驱动用户行为 */
function SessionProbe(): ReactNode {
  const session = useSession();
  return (
    <span data-testid="session-status">
      {session.status}:{session.session?.activeProfile?.id ?? 'none'}
    </span>
  );
}

/** 地址探针:渲染当前 pathname+search,供 URL(mode/q/searchId/cursor、/media 跳转)断言 */
function LocationProbe(): ReactNode {
  const location = useLocation();
  return (
    <span data-testid="location">
      {location.pathname}
      {location.search}
    </span>
  );
}

interface RenderResult {
  client: QueryClient;
}

function renderVodRoutes(initialUrl: string): RenderResult {
  const client = createTestQueryClient();
  render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <SessionProvider>
        <SessionProbe />
        <Routes>
          <Route path="/vod" element={<VodCatalogPage />} />
          <Route path="/vod/titles/:titleRef" element={<OnlineVodDetailPage />} />
        </Routes>
        <LocationProbe />
      </SessionProvider>
    </MemoryRouter>,
    // 每例独立内存 QueryClient(retry:false):缓存不跨例泄漏,重试时序确定
    { wrapper: createQueryWrapper(client) },
  );
  return { client };
}

async function awaitSession(profileId: string | null): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('session-status')).toHaveTextContent(
      profileId === null ? 'anonymous:none' : `authenticated:${profileId}`,
    );
  });
}

beforeEach(() => {
  publicFetchMock.mockReset();
  privateFetchMock.mockReset();
});

// ────────────────────────── A. 搜索:成功 / partial / 401 边界 / 410 过期 ──────────────────────────

describe('在线搜索:提交/卡片渲染/partial/过期(ui.md §1 /vod?mode=online)', () => {
  it('A1 提交 q:GET /public/vod/search 仅带 q;卡片渲染 title/year/sourceLabel,posterRef null 占位且无 img;URL 保留 mode/q/searchId 且不触发二次拉取', async () => {
    installPublicRoutes({
      '/public/vod/search': searchPage({
        searchId: 's-1',
        nextCursor: 'c-2',
        sources: [{ sourceRef: 'src-1', status: 'ok', hasMore: true }],
        items: [vodCard({ titleRef: 'tr-1', title: '星际漂流', year: '2024', sourceLabel: '资源站A' })],
      }),
    });
    installPrivateRoutes({ authenticated: false });
    const user = userEvent.setup();
    const { client } = renderVodRoutes('/vod?mode=online');
    await awaitSession(null);

    await user.type(screen.getByRole('textbox', { name: '搜索在线资源' }), '星际');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    const card = await screen.findByRole('link', { name: /星际漂流/ });
    expect(card).toHaveAttribute('href', '/vod/titles/tr-1');
    expect(within(card).getByText('2024')).toBeInTheDocument();
    expect(within(card).getByText('资源站A')).toBeInTheDocument();
    // posterRef 恒 null:渲染占位,绝不渲染外部地址(无 img 元素)
    expect(within(card).getByText('无海报')).toBeInTheDocument();
    expect(within(card).queryByRole('img')).not.toBeInTheDocument();

    // URL 保留 mode/q/searchId(ui.md §1)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('searchId=s-1'));
    expect(screen.getByTestId('location').textContent).toContain('mode=online');
    expect(screen.getByTestId('location').textContent).toContain('q=');

    // 成功页写入 searchId 不改变取数输入:不重复拉取(重放契约的客户端面)
    await flushQueries(client);
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0]?.init.query).toEqual({ q: '星际' });
  });

  it('A2 partial=true:展示部分失败与 reasons 原文,正常来源卡片仍渲染', async () => {
    installPublicRoutes({
      '/public/vod/search': searchPage({
        searchId: 's-part',
        partial: true,
        reasons: ['资源站B 查询超时'],
        sources: [
          { sourceRef: 'src-a', status: 'ok', hasMore: false },
          { sourceRef: 'src-b', status: 'timeout', hasMore: false },
        ],
      }),
    });
    installPrivateRoutes({ authenticated: false });
    const user = userEvent.setup();
    renderVodRoutes('/vod?mode=online');
    await awaitSession(null);

    await user.type(screen.getByRole('textbox', { name: '搜索在线资源' }), '星际');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    // partial 不是整页失败:成功来源的卡片照常渲染
    expect(await screen.findByRole('link', { name: /例牌剧集/ })).toBeInTheDocument();
    expect(await screen.findByText('部分来源暂不可用')).toBeInTheDocument();
    expect(screen.getByText('资源站B 查询超时')).toBeInTheDocument();
  });

  it('A3 无会话(恢复 401)后的搜索:调用清单零 /me 个人路径,浏览请求全部走 publicFetch(omit 档)', async () => {
    installPublicRoutes({ '/public/vod/search': searchPage() });
    installPrivateRoutes({ authenticated: false });
    const user = userEvent.setup();
    renderVodRoutes('/vod?mode=online');
    await awaitSession(null);

    await user.type(screen.getByRole('textbox', { name: '搜索在线资源' }), '星际');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByRole('link', { name: /例牌剧集/ });

    expectNoPersonalRequests();
    for (const call of recorded(publicFetchMock)) {
      expect(call.path.startsWith('/public/')).toBe(true);
    }
  });

  it('A4 410 VOD_SEARCH_EXPIRED:呈现「重新搜索」态并保留 q;重搜请求只带 q 不复用旧 searchId/cursor', async () => {
    const queries: Array<Record<string, unknown>> = [];
    installPublicRoutes({
      '/public/vod/search': (_path: string, init: FetchInit) => {
        queries.push(init.query ?? {});
        if (queries.length === 1) {
          throw apiProblem(410, 'VOD_SEARCH_EXPIRED', '搜索已过期');
        }
        return searchPage({ searchId: 's-new' });
      },
    });
    installPrivateRoutes({ authenticated: false });
    const user = userEvent.setup();
    renderVodRoutes('/vod?mode=online&q=旧词&searchId=s-old');
    await awaitSession(null);

    const alert = await screen.findByRole('alert');
    const retry = within(alert).getByRole('button', { name: '重新搜索' });
    // 过期保留 q:输入框回显与 URL 均保留,不复用旧 cursor
    expect(screen.getByRole('textbox', { name: '搜索在线资源' })).toHaveValue('旧词');
    expect(screen.getByTestId('location').textContent).toContain('q=');
    expect(screen.getByTestId('location').textContent).not.toContain('cursor=');

    await user.click(retry);
    expect(await screen.findByRole('link', { name: /例牌剧集/ })).toBeInTheDocument();
    // 重搜是新搜索:查询只带 q;成功后 URL 换上新 searchId
    expect(queries).toHaveLength(2);
    expect(queries[1]).toEqual({ q: '旧词' });
    expect(screen.getByTestId('location').textContent).toContain('searchId=s-new');
    expect(searchCalls()).toHaveLength(2);
  });
});

// ────────────────────────── B. 恢复:searchId 重放与 nextCursor 翻页 ──────────────────────────

describe('搜索恢复:searchId 重放不重搜、cursor 翻页、已生成页不重复拉取(api.md §2)', () => {
  it('B1 刷新恢复:按 searchId 重放第一页——请求只带 searchId,不带 q/cursor', async () => {
    installPublicRoutes({
      '/public/vod/search': searchPage({ searchId: 's-1', nextCursor: 'c-2' }),
    });
    installPrivateRoutes({ authenticated: false });
    const { client } = renderVodRoutes('/vod?mode=online&q=星际&searchId=s-1');
    await awaitSession(null);

    expect(await screen.findByRole('link', { name: /例牌剧集/ })).toBeInTheDocument();
    await flushQueries(client);
    const calls = searchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.query).toEqual({ searchId: 's-1' });
  });

  it('B2 nextCursor 翻页:searchId+cursor(无 q);返回已生成页与再次前进均不重复拉取', async () => {
    const queries: Array<Record<string, unknown>> = [];
    installPublicRoutes({
      '/public/vod/search': (_path: string, init: FetchInit) => {
        queries.push(init.query ?? {});
        if (init.query?.cursor === undefined) {
          return searchPage({
            searchId: 's-1',
            nextCursor: 'c-2',
            sources: [{ sourceRef: 'src-1', status: 'ok', hasMore: true }],
          });
        }
        return searchPage({
          searchId: 's-1',
          nextCursor: null,
          items: [vodCard({ titleRef: 'tr-2', title: '第二页结果' })],
          sources: [{ sourceRef: 'src-1', status: 'ok', hasMore: false }],
        });
      },
    });
    installPrivateRoutes({ authenticated: false });
    const user = userEvent.setup();
    const { client } = renderVodRoutes('/vod?mode=online&q=星际&searchId=s-1');
    await awaitSession(null);
    expect(await screen.findByRole('link', { name: /例牌剧集/ })).toBeInTheDocument();

    // 翻页:请求携带 searchId+cursor(与 q 互斥),cursor 写入 URL
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('link', { name: /第二页结果/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('cursor=c-2'));
    expect(screen.getByTestId('location').textContent).toContain('searchId=s-1');
    expect(queries[1]).toEqual({ searchId: 's-1', cursor: 'c-2' });

    // 返回第一页:同 searchId 已生成页,不重复拉取
    await user.click(screen.getByRole('button', { name: '上一页' }));
    expect(await screen.findByRole('link', { name: /例牌剧集/ })).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).not.toContain('cursor=');

    // 再次前进到第二页:同 searchId+cursor 已生成页重放,仍不重复拉取
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('link', { name: /第二页结果/ })).toBeInTheDocument();

    await flushQueries(client);
    expect(searchCalls()).toHaveLength(2);
    expectNoPersonalRequests();
  });
});

// ────────────────────────── C. 详情:线路聚合与 unsupported 集 ──────────────────────────

describe('在线详情:预览线路按 lineRef 聚合,unsupported 集不可选(/vod/titles/:titleRef)', () => {
  it('C1 预览线路聚合:lines 中同 lineRef 重复出现合并为一个线路组,集全量呈现且不重复渲染', async () => {
    installPublicRoutes({
      '/public/vod/titles/tr-1': preview({
        lines: [
          previewLine({
            lineRef: 'L-1',
            name: '线路甲',
            episodes: [previewEpisode({ episodeRef: 'ep-1', label: '第 1 集' })],
          }),
          previewLine({
            lineRef: 'L-2',
            name: '线路乙',
            episodes: [previewEpisode({ episodeRef: 'ep-2', label: '第 2 集' })],
          }),
          // 同 lineRef 再次出现(跨块/跨页重复的消费端规则):必须并入「线路甲」,不得当新线
          previewLine({
            lineRef: 'L-1',
            name: '线路甲',
            episodes: [previewEpisode({ episodeRef: 'ep-3', label: '第 3 集' })],
          }),
        ],
      }),
    });
    installPrivateRoutes({ authenticated: true });
    renderVodRoutes('/vod/titles/tr-1');
    await awaitSession('profile-a');

    expect(await screen.findByText('例牌剧集')).toBeInTheDocument();
    expect(screen.getAllByText('线路甲')).toHaveLength(1);
    expect(screen.getByText('线路乙')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 1 集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 2 集' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '第 3 集' })).toBeInTheDocument();
    expect(previewCalls()).toHaveLength(1);
  });

  it('C2 unsupported 集:aria-disabled 不可选并展示 reason,点击不触发物化;候选集仍可选', async () => {
    installPublicRoutes({
      '/public/vod/titles/tr-1': preview({
        lines: [
          previewLine({
            lineRef: 'L-1',
            name: '线路甲',
            episodes: [
              previewEpisode({ episodeRef: 'ep-1', label: '第 1 集' }),
              previewEpisode({
                episodeRef: 'ep-2',
                label: '第 2 集',
                status: 'unsupported',
                reason: 'format_unsupported',
              }),
            ],
          }),
        ],
      }),
    });
    const gate = deferred<MaterializedDto>();
    installPrivateRoutes({ authenticated: true, materialize: () => gate.promise });
    const user = userEvent.setup();
    const { client } = renderVodRoutes('/vod/titles/tr-1');
    await awaitSession('profile-a');

    const unsupported = await screen.findByRole('button', { name: '第 2 集' });
    expect(unsupported).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('格式不支持')).toBeInTheDocument();

    // 不可选:点击不产生物化请求
    await user.click(unsupported);
    await flushQueries(client);
    expect(materializeCalls()).toHaveLength(0);

    // 阳性对照:候选集可触发物化(证明上一断言并非页面静止)
    await user.click(screen.getByRole('button', { name: '第 1 集' }));
    await waitFor(() => expect(materializeCalls()).toHaveLength(1));
    gate.resolve(materialized());
    await flushQueries(client);
  });
});

// ────────────────────────── D. 物化:载荷契约与幂等 ──────────────────────────

describe('物化:POST /vod/materializations 严格 oneOf 载荷、幂等重提交(api.md §3)', () => {
  it('D1 选集物化:载荷恰为 {titleRef,episodeRef,previewRevision,operationKey:UUID},revision 取自预览;201 后跳稳定 /media/:parentMediaId', async () => {
    installPublicRoutes({ '/public/vod/titles/tr-1': preview({ previewRevision: 3 }) });
    installPrivateRoutes({ authenticated: true, materialize: () => materialized() });
    const user = userEvent.setup();
    renderVodRoutes('/vod/titles/tr-1');
    await awaitSession('profile-a');

    await user.click(await screen.findByRole('button', { name: '第 1 集' }));

    await waitFor(() => expect(materializeCalls()).toHaveLength(1));
    const call = materializeCalls()[0];
    expect(call).toBeDefined();
    expect(call?.init.method).toBe('POST');
    const body = call?.init.body as {
      titleRef: string;
      episodeRef: string;
      previewRevision: number;
      operationKey: string;
    };
    // 严格 oneOf:title/episode 分支恰四键(api.md §3)
    expect(Object.keys(body).sort()).toEqual(['episodeRef', 'operationKey', 'previewRevision', 'titleRef']);
    expect(body.titleRef).toBe('tr-1');
    expect(body.episodeRef).toBe('ep-1');
    expect(body.previewRevision).toBe(3);
    expect(body.operationKey).toMatch(UUID_PATTERN);

    // 物化成功才跳稳定详情;预览页永不永久入库
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/media/11111111-1111-4111-8111-111111111111'),
    );
  });

  it('D2 幂等:同一选择在途期间重复提交不生成新 operationKey(至多重发同 key)', async () => {
    const gate = deferred<MaterializedDto>();
    installPublicRoutes({ '/public/vod/titles/tr-1': preview({ previewRevision: 3 }) });
    installPrivateRoutes({ authenticated: true, materialize: () => gate.promise });
    const user = userEvent.setup();
    const { client } = renderVodRoutes('/vod/titles/tr-1');
    await awaitSession('profile-a');

    const episode = await screen.findByRole('button', { name: '第 1 集' });
    await user.click(episode);
    await waitFor(() => expect(materializeCalls()).toHaveLength(1));
    const firstKey = (materializeCalls()[0]?.init.body as { operationKey: string }).operationKey;
    expect(firstKey).toMatch(UUID_PATTERN);

    await user.click(episode); // 在途重复提交(双击/重复回车)
    gate.resolve(materialized());
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('/media/'));
    await flushQueries(client);

    const calls = materializeCalls();
    // 契约:只调一次;即便实现选择重发,也必须复用同一 operationKey,不得换新 key
    expect(calls.length).toBeLessThanOrEqual(2);
    for (const call of calls) {
      expect((call.init.body as { operationKey: string }).operationKey).toBe(firstKey);
    }
  });
});

// ────────────────────────── E. 候选过期重选:409 重读重选 / 410 预览刷新 ──────────────────────────

describe('候选过期重选:409 VOD_DETAIL_CHANGED / 410 VOD_PREVIEW_EXPIRED(api.md §6)', () => {
  it('E1 409 VOD_DETAIL_CHANGED:清预览缓存重读;不静默重试旧 ref,用户重选后以新 revision/新 episodeRef 重发', async () => {
    const previewPages: VodPreviewDto[] = [
      preview({ previewRevision: 3 }),
      preview({
        previewRevision: 4,
        lines: [
          previewLine({ episodes: [previewEpisode({ episodeRef: 'ep-1-r4', label: '第 1 集' })] }),
        ],
      }),
    ];
    installPublicRoutes({
      '/public/vod/titles/tr-1': () => {
        const page = previewPages.shift();
        if (page === undefined) {
          throw apiProblem(500, 'INTERNAL', '意外的额外预览取数');
        }
        return page;
      },
    });
    const bodies: Array<{ operationKey: string; previewRevision: number; episodeRef: string }> = [];
    installPrivateRoutes({
      authenticated: true,
      materialize: (_path, init) => {
        const body = init.body as { operationKey: string; previewRevision: number; episodeRef: string };
        bodies.push(body);
        if (bodies.length === 1) {
          throw apiProblem(409, 'VOD_DETAIL_CHANGED', '内容已更新，请重新选择');
        }
        return materialized({ parentMediaId: '33333333-3333-4333-8333-333333333333' });
      },
    });
    const user = userEvent.setup();
    const { client } = renderVodRoutes('/vod/titles/tr-1');
    await awaitSession('profile-a');

    await user.click(await screen.findByRole('button', { name: '第 1 集' }));
    await screen.findByRole('alert');
    await flushQueries(client);

    // 失败后:明确呈现错误,不静默重试旧 ref;预览缓存已清并重读(第 2 次真实取数)
    expect(materializeCalls()).toHaveLength(1);
    expect(previewCalls()).toHaveLength(2);

    // 用户重新预览后明确重选:新 revision(4)+新 episodeRef,operationKey 换新
    await user.click(screen.getByRole('button', { name: '第 1 集' }));
    await waitFor(() => expect(materializeCalls()).toHaveLength(2));
    const first = bodies[0];
    const second = bodies[1];
    expect(second?.previewRevision).toBe(4);
    expect(second?.episodeRef).toBe('ep-1-r4');
    expect(second?.operationKey).toMatch(UUID_PATTERN);
    expect(second?.operationKey).not.toBe(first?.operationKey);
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/media/33333333-3333-4333-8333-333333333333'),
    );
  });

  it('E2 410 VOD_PREVIEW_EXPIRED:回到预览刷新态——重读预览、不自动重发物化,重选后成功', async () => {
    const previewPages: VodPreviewDto[] = [
      preview({ previewRevision: 3 }),
      preview({
        previewRevision: 5,
        lines: [
          previewLine({ episodes: [previewEpisode({ episodeRef: 'ep-1-r5', label: '第 1 集' })] }),
        ],
      }),
    ];
    installPublicRoutes({
      '/public/vod/titles/tr-1': () => {
        const page = previewPages.shift();
        if (page === undefined) {
          throw apiProblem(500, 'INTERNAL', '意外的额外预览取数');
        }
        return page;
      },
    });
    const bodies: Array<{ operationKey: string; previewRevision: number; episodeRef: string }> = [];
    installPrivateRoutes({
      authenticated: true,
      materialize: (_path, init) => {
        const body = init.body as { operationKey: string; previewRevision: number; episodeRef: string };
        bodies.push(body);
        if (bodies.length === 1) {
          throw apiProblem(410, 'VOD_PREVIEW_EXPIRED', '预览已过期，请重新预览');
        }
        return materialized({ parentMediaId: '44444444-4444-4444-8444-444444444444' });
      },
    });
    const user = userEvent.setup();
    const { client } = renderVodRoutes('/vod/titles/tr-1');
    await awaitSession('profile-a');

    await user.click(await screen.findByRole('button', { name: '第 1 集' }));
    await screen.findByRole('alert');
    await flushQueries(client);

    // 过期:回到预览刷新态(重读预览),物化不自动重发
    expect(materializeCalls()).toHaveLength(1);
    expect(previewCalls()).toHaveLength(2);

    // 预览刷新后用户可重选:以刷新后的 revision(5)/episodeRef 重发
    await user.click(screen.getByRole('button', { name: '第 1 集' }));
    await waitFor(() => expect(materializeCalls()).toHaveLength(2));
    expect(bodies[1]?.previewRevision).toBe(5);
    expect(bodies[1]?.episodeRef).toBe('ep-1-r5');
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/media/44444444-4444-4444-8444-444444444444'),
    );
  });
});

// ────────────────────────── F. 游客纯净:全流程零个人请求 ──────────────────────────

describe('游客纯净:搜索→详情→选集全流程零个人请求、零 Cookie 档越界(ui.md §1)', () => {
  it('F1 游客全流程:浏览请求全走 publicFetch(omit 档),私有档仅 /auth/session,选集进登录流程不发物化', async () => {
    installPublicRoutes({
      '/public/vod/search': searchPage({ items: [vodCard({ titleRef: 'tr-1', title: '例牌剧集' })] }),
      '/public/vod/titles/tr-1': preview(),
    });
    installPrivateRoutes({ authenticated: false });
    const user = userEvent.setup();
    const { client } = renderVodRoutes('/vod?mode=online');
    await awaitSession(null);

    await user.type(screen.getByRole('textbox', { name: '搜索在线资源' }), '例牌');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(await screen.findByRole('link', { name: /例牌剧集/ }));
    expect(await screen.findByText('例牌剧集')).toBeInTheDocument();

    // 游客选集:进入已有登录/选档流程(给登录提示),不直接物化、不跳稳定详情
    await user.click(screen.getByRole('button', { name: '第 1 集' }));
    expect(await screen.findByText(/登录/)).toBeInTheDocument();
    await flushQueries(client);

    expect(materializeCalls()).toHaveLength(0);
    expect(screen.getByTestId('location').textContent).not.toContain('/media/');
    // 全量调用清单:零 /me/** 与 /api/me/**(含 401 恢复之后的搜索路径)
    expectNoPersonalRequests();
    // 公共浏览(credentials:'omit' 档,底座已测档位,此处钉调用形态)全部经 publicFetch
    for (const call of recorded(publicFetchMock)) {
      expect(call.path.startsWith('/public/')).toBe(true);
    }
    // 私有档只允许会话恢复;任何个人数据读取(TitleProgress/历史等)都不得出现
    for (const call of recorded(privateFetchMock)) {
      expect(call.path).toBe('/auth/session');
    }
  });
});
