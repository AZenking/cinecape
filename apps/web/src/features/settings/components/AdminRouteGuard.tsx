/**
 * AdminRouteGuard (013 T007 / FR-006)
 *
 * 受限路由前端权限守卫(纵深防御;安全底线由服务端 SettingsGuard 承担):
 * - 未认证(anonymous)→ 平滑回首页并提示登录,不误报「需要管理员权限」;
 * - 会话恢复中(restoring / checking)时阻止错误判定,呈现轻量加载提示;
 * - 检查当前 Profile 是否为主管理员(isMainProfile);非管理员阻止受限子路由渲染,
 *   通过 useNavigate 平滑重定向至 '/settings/playback' 并提示;
 * - 调用 Toast 提示「该页面需要管理员权限」。
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useNavigate, Outlet } from 'react-router';
import { useOptionalSession } from '../../../app/session-provider';
import { useOptionalSettingsAccess } from '../settings-access-provider';
import { useAppToast, LoadingSpinner } from '../../../shared/ui';

export interface AdminRouteGuardProps {
  children?: ReactNode;
  /** 重定向目的地，默认 '/settings/playback' */
  redirectTo?: string;
  /** 权限不足时的 Toast 提示，默认 '该页面需要管理员权限' */
  deniedMessage?: string;
}

export function AdminRouteGuard({
  children,
  redirectTo = '/settings/playback',
  deniedMessage = '该页面需要管理员权限',
}: AdminRouteGuardProps): ReactNode {
  const navigate = useNavigate();
  const toast = useAppToast();
  const settingsAccess = useOptionalSettingsAccess();
  const sessionContext = useOptionalSession();

  const isChecking = settingsAccess
    ? settingsAccess.status === 'checking'
    : sessionContext?.status === 'restoring';

  const isAuthenticated = (sessionContext?.status ?? 'anonymous') === 'authenticated';
  const isMainProfile = settingsAccess
    ? settingsAccess.isMainProfile
    : isAuthenticated && Boolean(sessionContext?.session?.activeProfile?.isMain);

  const hasRedirectedRef = useRef(false);

  useEffect(() => {
    if (isChecking) {
      return;
    }
    if (isMainProfile) {
      hasRedirectedRef.current = false;
      return;
    }
    if (hasRedirectedRef.current) {
      return;
    }
    hasRedirectedRef.current = true;
    if (!isAuthenticated) {
      // 未认证深链:不误报管理员权限,回首页由登录/选档流承接
      toast.error('请先登录后再访问设置');
      void navigate('/', { replace: true });
      return;
    }
    toast.error(deniedMessage);
    void navigate(redirectTo, { replace: true });
  }, [isChecking, isAuthenticated, isMainProfile, navigate, toast, redirectTo, deniedMessage]);

  if (isChecking) {
    return <LoadingSpinner label="正在核验管理员权限…" />;
  }

  if (!isMainProfile) {
    return null;
  }

  return <>{children ?? <Outlet />}</>;
}
