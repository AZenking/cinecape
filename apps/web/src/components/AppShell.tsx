/**
 * 应用壳(T014;T029/T031/T037 接入导航;T036 静默回落轻提示)。
 *
 * - 顶栏:左「HOME MEDIA」字标 + 三个文字导航链接(档案 /、管理 /profiles/manage、
 *   设备 /devices);右当前观看者名 + 账号用户名 + 退出(HeroUI Button,统一
 *   onPress,research D6:暗色优先、焦点友好、鼠标/键盘/遥控器同一交互入口)。
 * - T036 静默回落:profileFallbackAt 非空(5 秒内)→ 顶栏下方轻条
 *   「原观看档案已停用,请重新选择」,自动消失(5s 定时 + 用户重新选档即清)。
 * - 10 英尺友好(焦点空间导航)按 tasks 说明留待后续阶段。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { Button } from '@heroui/react';
import { useSession } from '../lib/session';

/** 静默回落轻条展示时长(ms,任务约定 5 秒) */
const FALLBACK_BANNER_MS = 5000;

/** 导航项定义;`/` 用 end 避免所有路由都命中激活态 */
const NAV_ITEMS = [
  { to: '/', label: '档案', end: true },
  { to: '/profiles/manage', label: '管理', end: false },
  { to: '/devices', label: '设备', end: false },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { session, logout, profileFallbackAt, clearProfileFallback } = useSession();
  const username = session?.account?.username ?? '未登录';
  const activeProfileName = session?.activeProfile?.name ?? null;

  /** 回落轻条可见性:profileFallbackAt 变化时展示并在 5 秒后自动消失 */
  const [fallbackVisible, setFallbackVisible] = useState(false);
  useEffect(() => {
    if (profileFallbackAt === null) {
      setFallbackVisible(false);
      return;
    }
    setFallbackVisible(true);
    const timer = window.setTimeout(() => {
      setFallbackVisible(false);
      clearProfileFallback();
    }, FALLBACK_BANNER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [profileFallbackAt, clearProfileFallback]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-black/30">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-semibold tracking-widest text-accent">
              HOME MEDIA
            </Link>
            <nav aria-label="主导航" className="flex items-center gap-4">
              {NAV_ITEMS.filter((item) => item.to !== '/profiles/manage' || session?.account?.role === 'owner').map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `rounded px-1 py-1 text-sm transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      isActive ? 'font-medium text-white' : 'text-muted'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {activeProfileName && (
              <span className="hidden rounded-full bg-default px-3 py-1 text-xs text-foreground sm:inline">
                观看中:{activeProfileName}
              </span>
            )}
            <span className="text-sm text-foreground">{username}</span>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                void logout();
              }}
            >
              退出
            </Button>
          </div>
        </div>
      </header>

      {/* T036 静默回落轻条:原观看档案被停用时出现,5 秒自动消失 */}
      {fallbackVisible && profileFallbackAt !== null && (
        <div
          role="status"
          className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-sm text-warning"
        >
          原观看档案已停用,请重新选择
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
