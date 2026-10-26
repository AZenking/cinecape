/**
 * 账号与安全空架(T086;US7 唯一可导航空架模块,ui.md §7「七模块均有实际业务
 * 读取」的 US7 子集)。
 *
 * - 经 GET /api/settings/account 读取只读 AccountSummary(白名单投影:username/role);
 *   该端点完整内容属 US8 —— 本阶段若 404(服务端 SettingsModule 尚未注册)或
 *   读取失败,显示「模块内容由 US8 填充」的读取失败态并注明,不造假数据;
 * - 管理主体请求得到 403 SETTINGS_ACCESS_* 时经 handleAccessLost 立即回到解锁门
 *   (隐藏主体 + 编辑未保存提示),绝不本地保留已失效数据;
 * - 重新解锁后以 reloadEpoch 为依赖重读最新现值(FR-041)。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { privateFetch } from '../../shared/fetch';
import { LoadingSpinner, RetryableAlert } from '../../shared/ui';
import { isSettingsAccessLostError, useSettingsAccess } from './settings-access-provider';
import { useSettingsPageMeta } from './settings-modules';

/** 契约 AccountSummary(openapi:只读白名单投影) */
interface AccountSummary {
  id: string;
  username: string;
  role: 'owner' | 'admin';
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ok'; summary: AccountSummary }
  | { phase: 'error'; message: string; notImplemented: boolean };

export function SettingsAccountPage(): ReactNode {
  const access = useSettingsAccess();
  const { title } = useSettingsPageMeta();
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback((): void => {
    setState({ phase: 'loading' });
    void (async () => {
      try {
        const summary = await privateFetch<AccountSummary>('/settings/account');
        setState({ phase: 'ok', summary });
      } catch (error) {
        if (isSettingsAccessLostError(error)) {
          access.handleAccessLost(); // 服务端判定授权失效:立即隐藏主体
          return;
        }
        // US8 端点尚未交付(404)与其他读取失败:显示失败态并注明,不造假数据
        setState({
          phase: 'error',
          message:
            '无法读取账号信息(服务端 /api/settings/account 尚未交付或暂不可用)。模块内容由 US8 填充。',
          notImplemented: true,
        });
      }
    })();
    // reloadEpoch:重新解锁后重读最新现值(FR-041)
  }, [access, attempt]);

  useEffect(() => {
    load();
  }, [load, access.reloadEpoch]);

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-1 flex-col gap-4 py-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      {state.phase === 'loading' ? <LoadingSpinner label="正在读取账号信息…" /> : null}
      {state.phase === 'error' ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="max-w-prose text-sm text-danger">
            {state.message}
          </p>
          {!state.notImplemented ? (
            <RetryableAlert title="读取失败" description="请稍后重试" onRetry={() => setAttempt((n) => n + 1)} />
          ) : null}
        </div>
      ) : null}
      {state.phase === 'ok' ? (
        <dl className="flex max-w-md flex-col gap-2 text-sm" data-testid="account-summary">
          <div className="flex justify-between gap-6 border-b border-border pb-2">
            <dt className="text-muted">用户名</dt>
            <dd className="font-medium text-foreground">{state.summary.username}</dd>
          </div>
          <div className="flex justify-between gap-6 border-b border-border pb-2">
            <dt className="text-muted">角色</dt>
            <dd className="font-medium text-foreground">{state.summary.role === 'owner' ? '所有者' : '管理员'}</dd>
          </div>
          <p className="text-xs text-muted">只读摘要;账号与安全模块的完整管理内容由 US8 填充。</p>
        </dl>
      ) : null}
    </section>
  );
}
