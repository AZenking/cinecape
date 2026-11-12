import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateFetch } from '../../src/shared/fetch';
import { fetchAllSettingsSources } from '../../src/features/settings/shared/settings-api';

vi.mock('../../src/shared/fetch', () => ({ privateFetch: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe('来源管理跨页读取', () => {
  it('首屏被其他类型占满时，仍读取后续页的停用节目单来源', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) => ({ id: `nas-${i}`, kind: 'nas', enabled: true }));
    const laterSource = { id: 'epg-disabled', kind: 'epg', enabled: false };
    vi.mocked(privateFetch)
      .mockResolvedValueOnce({ items: firstPage, page: 1, pageSize: 20, total: 21 })
      .mockResolvedValueOnce({ items: [laterSource], page: 2, pageSize: 20, total: 21 });
    const signal = new AbortController().signal;
    const result = await fetchAllSettingsSources(signal);
    expect(result.items).toHaveLength(21);
    expect(result.items).toContainEqual(laterSource);
    expect(privateFetch).toHaveBeenNthCalledWith(2, '/settings/sources?page=2&pageSize=20', { signal });
  });

  it('后续页读取失败时上抛错误，不把不完整来源列表当作成功', async () => {
    const error = new Error('第二页读取失败');
    vi.mocked(privateFetch)
      .mockResolvedValueOnce({ items: [{ id: 'first' }], page: 1, pageSize: 1, total: 2 })
      .mockRejectedValueOnce(error);
    await expect(fetchAllSettingsSources()).rejects.toBe(error);
  });
});
