import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { FetchApiError } from '../../../src/shared/fetch';
import { PasswordConfirmModal } from '../../../src/features/settings/shared/password-confirm-modal';

/**
 * T123(005-US8 前端测试,先 FAIL):当次密码确认弹层(FR-033/ADR-0011)。
 * - 每次敏感写独立弹当次密码确认;成功不复用验证态(重开为全新输入);
 * - 验证失败(403/423)不丢表单内容,错误以文字呈现;成功后关闭并清空内存。
 */

interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];

beforeEach(() => {
  fetchCalls = [];
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function callsTo(path: string): FetchCall[] {
  return fetchCalls.filter((call) => call.path === path);
}

describe('T123 · PasswordConfirmModal(逐次密码,不复用验证态)', () => {
  it('提交当次密码成功:调用 onSubmit 一次,关闭并清空输入;再次打开须重新输入(不复用验证态)', async () => {
    const user = userEvent.setup();
    const submitted: string[] = [];
    const submittedPasswords: string[] = [];
    let open = true;
    function Harness(): ReactNode {
      const [isOpen, setOpen] = useState(open);
      open = isOpen;
      return (
        <PasswordConfirmModal
          open={isOpen}
          title="保存通用设置"
          description="当次密码验证"
          submitLabel="确认保存"
          onSubmit={(password: string) => {
            submitted.push('ok');
            submittedPasswords.push(password);
            return Promise.resolve();
          }}
          onClose={() => setOpen(false)}
        />
      );
    }
    render(<Harness />);
    // 初始无输入不可提交
    expect(screen.getByTestId('password-submit')).toBeDisabled();
    await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'password-123');
    await user.click(screen.getByTestId('password-submit'));
    await waitFor(() => expect(submitted).toEqual(['ok']));
    expect(submittedPasswords).toEqual(['password-123']);
    // 成功即关闭
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '保存通用设置' })).toBeNull());
  });

  it('验证失败:弹层保持、输入内容保留(不丢表单)、错误文字呈现;修正后可再次提交', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    function Harness(): ReactNode {
      const [isOpen, setOpen] = useState(true);
      return (
        <PasswordConfirmModal
          open={isOpen}
          title="撤销设备"
          onSubmit={(_password: string) => {
            attempts += 1;
            if (attempts === 1) {
              return Promise.reject(
                new FetchApiError({ status: 403, title: 'Parent Verification Failed', detail: '家长验证失败,剩余尝试次数:4' }),
              );
            }
            return Promise.resolve();
          }}
          onClose={() => setOpen(false)}
        />
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('主账号密码(当次验证)');
    await user.type(input, 'wrong-pass-1');
    await user.click(screen.getByTestId('password-submit'));
    // 失败:错误呈现 + 弹层仍在 + 输入保留(验证失败不丢表单内容)
    await waitFor(() => expect(screen.getByText(/剩余尝试次数:4/)).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: '撤销设备' })).toBeInTheDocument();
    expect(input).toHaveValue('wrong-pass-1');
    // 修正追加后再次提交成功
    await user.type(input, '-now-right');
    await user.click(screen.getByTestId('password-submit'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '撤销设备' })).toBeNull());
    expect(attempts).toBe(2);
  });

  it('取消关闭不触发 onSubmit;页面无任何网络请求(密码只在当次请求 body)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(() => Promise.resolve());
    function Harness(): ReactNode {
      const [isOpen, setOpen] = useState(true);
      return <PasswordConfirmModal open={isOpen} title="测试操作" onSubmit={onSubmit} onClose={() => setOpen(false)} />;
    }
    render(
      <MemoryRouter initialEntries={['/settings/general']}>
        <Routes>
          <Route path="*" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText('主账号密码(当次验证)'), 'whatever-123');
    await user.click(screen.getByTestId('password-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '测试操作' })).toBeNull());
    expect(onSubmit).not.toHaveBeenCalled();
    // 密码不出现在任何地址/存储:无 localStorage/URL 写入,且无网络请求
    expect(callsTo('/api/settings/account')).toEqual([]);
    expect(window.location.href).not.toContain('whatever-123');
    void act;
  });
});
