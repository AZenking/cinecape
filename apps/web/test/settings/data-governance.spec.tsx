import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsDataGovernance } from '../../src/features/settings/settings-data-governance';
import { SettingsAccessProvider } from '../../src/features/settings/settings-access-provider';
import { queryClient as appQueryClient } from '../../src/shared/query/client';

/**
 * 021 · 数据治理页:概览渲染、dry-run 预览、确认后真实清理。
 */

let cleanupCalls: Array<Record<string, unknown>> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  cleanupCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), 'http://localhost:3000');
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.pathname === '/api/settings/access') {
        return json({ unlocked: true, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (url.pathname === '/api/settings/governance/overview') {
        return json({
          retentionDays: 30,
          archivedSources: [
            {
              id: 'src-old',
              name: '旧直播源',
              kind: 'iptv',
              archivedAt: '2026-10-01T00:00:00.000Z',
              lastSuccessAt: null,
              version: 4,
            },
          ],
          counts: {
            expiredProgrammes: 3,
            staleEntries: 2,
            snapshots: 1,
            snapshotBytes: 2048,
            refreshJobs: 5,
            archivedSources: 1,
          },
        });
      }
      if (url.pathname === '/api/settings/governance/cleanup' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        cleanupCalls.push(body);
        return json({
          target: body.target,
          dryRun: body.dryRun,
          deleted: 3,
          bytesFreed: 0,
          detail: { programmes: 3 },
        });
      }
      return json({});
    }),
  );
  appQueryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage(): void {
  render(
    <MemoryRouter>
      <QueryClientProvider client={appQueryClient}>
        <SettingsAccessProvider>
          <SettingsDataGovernance />
        </SettingsAccessProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('021 · 数据治理页', () => {
  it('展示归档来源与各清理目标计数;dry-run 预览后再真实清理', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('旧直播源')).toBeVisible();
    expect(screen.getByText('3 条节目')).toBeVisible();
    expect(screen.getByText('2 条失效条目')).toBeVisible();
    expect(screen.getByText('1 份 · 2.0 KiB')).toBeVisible();

    const buttons = screen.getAllByRole('button', { name: '预览并清理' });
    await user.click(buttons[0]!);
    expect(await screen.findByText(/预计删除/)).toBeVisible();
    expect(cleanupCalls[0]).toMatchObject({ target: 'expired-programmes', dryRun: true });

    await user.click(screen.getByRole('button', { name: '确认清理' }));
    await waitFor(() => expect(cleanupCalls).toHaveLength(2));
    expect(cleanupCalls[1]).toMatchObject({ target: 'expired-programmes', dryRun: false });
  });
});
