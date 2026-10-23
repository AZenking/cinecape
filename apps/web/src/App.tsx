/**
 * 路由骨架(T014;T029-T031/T037 接入真实页面):
 * - /setup 初始化向导(pages/SetupWizard,已初始化自动转登录)
 * - /login 登录页(pages/Login,已登录自动回主页)
 * - / 档案选择页(pages/ProfilePicker,Netflix 式;受保护,T029)
 * - /profiles/manage 档案管理页(pages/ProfileManage;会话 + owner 路由守卫,T031)
 * - /devices 设备管理页(pages/Devices;受保护,T037)
 * - RequireSession:恢复中显示 loading(防闪烁),未登录重定向 /login
 */
import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { Spinner } from '@heroui/react';
import { AppShell } from './components/AppShell';
import { Login } from './pages/Login';
import { SetupWizard } from './pages/SetupWizard';
import { ProfilePicker } from './pages/ProfilePicker';
import { ProfileManage } from './pages/ProfileManage';
import { ProfilePolicy } from './pages/ProfilePolicy';
import { Devices } from './pages/Devices';
import { SessionProvider, useSession } from './lib/session';

/** 会话守卫:启动恢复期不跳转(防闪烁);未登录 → /login */
function RequireSession({ children }: { children: ReactNode }) {
  const { status } = useSession();

  if (status === 'restoring') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <Spinner size="lg" />
        <p className="text-sm text-muted">正在恢复会话…</p>
      </div>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }
  return children;
}

/** 受保护页面统一壳:守卫 + AppShell(导航/观看者/回落轻条) */
function ProtectedPage({ children }: { children: ReactNode }) {
  return (
    <RequireSession>
      <AppShell>{children}</AppShell>
    </RequireSession>
  );
}

function OwnerPage({ children }: { children: ReactNode }) {
  const { session } = useSession();
  return session?.account?.role === 'owner' ? children : <Navigate to="/" replace />;
}

export function App() {
  return (
    <SessionProvider>
      <Routes>
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedPage>
              <ProfilePicker />
            </ProtectedPage>
          }
        />
        <Route
          path="/profiles/manage"
          element={
            <ProtectedPage>
              <OwnerPage><ProfileManage /></OwnerPage>
            </ProtectedPage>
          }
        />
        <Route
          path="/profiles/:profileId/policy"
          element={
            <ProtectedPage>
              <OwnerPage><ProfilePolicy /></OwnerPage>
            </ProtectedPage>
          }
        />
        <Route
          path="/devices"
          element={
            <ProtectedPage>
              <Devices />
            </ProtectedPage>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </SessionProvider>
  );
}
