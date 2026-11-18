/**
 * SettingsLayout
 *
 * 设置中心的布局基准与 Figma HeroUI Kit 保持一致：
 * - 桌面端为 256px 侧栏 + 自适应内容区；侧栏使用 HeroUI Surface/ListBox；
 * - 页面主体使用统一 864px 内容轨道，页头与 Card 的间距遵循 4px rhythm；
 * - 窄屏折叠为菜单按钮，所有导航仍由当前 URL 派生；
 * - 顶栏常驻公共导航(首页/点播/直播,shared/ui PublicNav 同源)，从设置直达观看页；
 * - 管理授权事实仍来自 SettingsAccessProvider，未保存提示与登出确认保留。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Header, Label, ListBox, Modal, Surface } from '@heroui/react';
import { useOptionalSession } from '../app/session-provider';
import { IdentityMenu } from '../features/profiles/identity-menu';
import { SettingsAccessProvider, useSettingsAccess } from '../features/settings/settings-access-provider';
import { UnsavedGuardProvider } from '../features/settings/shared/unsaved-guard';
import {
  getVisibleSettingsGroups,
  settingsModulePath,
  useSettingsPageMeta,
  type SettingsModuleGroupView,
  type SettingsModuleKey,
} from '../features/settings/settings-modules';
import { useMediaQuery } from '../shared/hooks';
import { PublicNav } from '../shared/ui';
import { BrandLogo } from '../shared/ui/brand-logo';

export interface SettingsLayoutProps {
  /** 可选注入 isMainProfile 覆盖 (用于测试或显式指定) */
  readonly isMainProfile?: boolean;
}

function SettingsSubmenu({
  isMainProfile,
  onNavigate,
  mobile = false,
}: {
  isMainProfile: boolean;
  onNavigate?: () => void;
  mobile?: boolean;
}): ReactNode {
  const session = useOptionalSession();
  const navigate = useNavigate();
  const current = useSettingsPageMeta();
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const groups = getVisibleSettingsGroups(isMainProfile);
  const mainGroups = groups.filter((group) => group.key !== 'system');
  const footerGroups = groups.filter((group) => group.key === 'system');

  const handleLogout = (): void => {
    setLogoutConfirmOpen(false);
    void session?.logout?.();
  };

  const activeProfile = session?.session?.activeProfile;
  const profileName = activeProfile?.name || (isMainProfile ? '主管理员' : '家庭成员');

  const renderSection = (group: SettingsModuleGroupView): ReactNode => (
    <ListBox.Section
      key={group.key}
      aria-label={group.label}
      data-testid={`settings-group-${group.key}`}
    >
      <Header className="flex w-full flex-col gap-1 px-3 pb-1.5 pt-2.5">
        <span className="text-2xs font-normal leading-4 text-muted">{group.label}</span>
      </Header>
      {group.modules.map((module) => (
        <ListBox.Item
          key={module.key}
          id={module.key}
          textValue={module.title}
          aria-label={module.title}
          className="flex min-h-10 items-center rounded-full px-3 py-2 text-sm text-muted outline-none transition-colors hover:bg-surface-secondary/60 data-[selected=true]:bg-surface-secondary data-[selected=true]:font-medium data-[selected=true]:text-foreground"
        >
          <Label className="text-sm leading-6">{module.title}</Label>
        </ListBox.Item>
      ))}
    </ListBox.Section>
  );

  const navigateOnSelection = (keys: 'all' | Set<SettingsModuleKey | string | number>): void => {
    if (keys === 'all') {
      return;
    }
    const key = keys.values().next().value;
    if (key === undefined) {
      return;
    }
    void navigate(settingsModulePath(String(key) as SettingsModuleKey));
    onNavigate?.();
  };

  return (
    <Surface
      variant="default"
      className={`flex h-full flex-col rounded-none p-6 shadow-none ${mobile ? 'min-h-0' : 'min-h-screen'}`}
    >
      <nav aria-label="设置子菜单" className="flex min-h-0 flex-1 flex-col">
        <div className="mb-6 flex min-w-0 flex-col gap-1">
          <span className="text-base font-semibold leading-9 text-foreground"><BrandLogo withText /></span>
          <span className="truncate text-xs leading-5 text-muted" title={profileName}>
            {profileName} · {isMainProfile ? '家庭主管理员' : '家庭成员'}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {mainGroups.length > 0 ? (
            <ListBox
              aria-label="设置模块"
              className="w-full"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[current.key]}
              onSelectionChange={navigateOnSelection}
            >
              {mainGroups.map(renderSection)}
            </ListBox>
          ) : null}
        </div>

        <div className="mt-4 flex flex-col border-t border-border/20 pb-1 pt-4">
          {footerGroups.length > 0 ? (
            <ListBox
              aria-label="设置模块 · 账号"
              className="w-full"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[current.key]}
              onSelectionChange={navigateOnSelection}
            >
              {footerGroups.map(renderSection)}
            </ListBox>
          ) : null}
          <Button
            variant="secondary"
            className="mt-1 w-fit min-w-24 justify-start rounded-full px-3 text-sm"
            onPress={() => setLogoutConfirmOpen(true)}
            data-testid="sidebar-logout"
          >
            退出登录
          </Button>
        </div>
      </nav>

      {logoutConfirmOpen ? (
        <Modal.Backdrop
          isOpen
          onOpenChange={(open) => {
            if (!open) {
              setLogoutConfirmOpen(false);
            }
          }}
          data-testid="logout-confirm-overlay"
        >
          <Modal.Container placement="center" size="xs">
            <Modal.Dialog role="alertdialog" aria-label="退出登录" className="gap-3">
              <h2 className="text-base font-semibold text-foreground">退出登录</h2>
              <p role="alert" className="text-sm text-muted">
                确认退出当前账号？退出后需重新登录才能继续观看。
              </p>
              <div className="mt-1 flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setLogoutConfirmOpen(false)}
                  data-testid="logout-cancel"
                  autoFocus
                >
                  取消
                </Button>
                <Button variant="danger" size="sm" onPress={handleLogout} data-testid="logout-confirm">
                  退出登录
                </Button>
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      ) : null}
    </Surface>
  );
}

function SettingsShell({ isMainProfile: propIsMainProfile }: SettingsLayoutProps): ReactNode {
  const access = useSettingsAccess();
  const { pathname } = useLocation();
  const isWideLayout =
    pathname === '/settings/epg' ||
    pathname === '/settings/iptv';
  const useSession = useOptionalSession();
  const wide = useMediaQuery('(min-width: 900px)');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  const isMainProfile =
    propIsMainProfile !== undefined ? propIsMainProfile : useSession === null ? true : access.isMainProfile;

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {wide ? (
        <aside
          className="sticky top-0 h-screen w-[220px] shrink-0 self-start min-[900px]:w-[256px]"
          data-testid="settings-sidebar"
        >
          <SettingsSubmenu isMainProfile={isMainProfile} />
        </aside>
      ) : null}

      <div className="min-w-0 flex-1">
        {/* 顶栏常驻(013 FR-003):身份切换唯一收敛于右上角头像菜单,各视口均可达;
            左区窄屏附菜单按钮与「设置」标题,两种视口均常驻公共导航(首页/点播/直播,
            与观看页顶栏同源)—— 从设置可直达观看页面;面包屑仍在页面内容区。 */}
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border/30 bg-background/90 px-4 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-3">
            {wide ? null : (
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={menuOpen}
                aria-controls="settings-submenu"
                onPress={() => setMenuOpen((open) => !open)}
              >
                菜单
              </Button>
            )}
            {wide ? null : <span className="text-sm font-semibold text-foreground">设置</span>}
            <PublicNav className="min-w-0" />
          </div>
          <IdentityMenu />
        </header>

        {access.unsavedNotice ? (
          <div className="mx-auto w-full max-w-[960px] px-6 pt-6 sm:px-8 lg:px-12">
            <Alert status="warning" data-testid="settings-access-lost-notice">
              <Alert.Content>
                <Alert.Title>检测到管理授权变化,编辑未保存</Alert.Title>
                <Alert.Description>请通过右上角头像菜单重新选择主管理员档案后再核对最新配置。</Alert.Description>
              </Alert.Content>
            </Alert>
          </div>
        ) : null}

        {!wide && menuOpen ? (
          <div
            id="settings-submenu"
            className="fixed inset-x-0 top-14 z-30 max-h-[calc(100vh-3.5rem)] overflow-y-auto border-b border-border/30 bg-background/95 shadow-xl backdrop-blur-md"
          >
            <SettingsSubmenu isMainProfile={isMainProfile} mobile onNavigate={() => setMenuOpen(false)} />
          </div>
        ) : null}

        <main className="min-w-0">
          <UnsavedGuardProvider>
            <div className={`w-full ${isWideLayout ? 'max-w-[1216px]' : 'max-w-[960px]'} px-6 py-8 sm:px-8 sm:py-10 lg:px-12 lg:py-12`}>
              <Outlet />
            </div>
          </UnsavedGuardProvider>
        </main>
      </div>
    </div>
  );
}

export function SettingsLayout(props: SettingsLayoutProps): ReactNode {
  return (
    <SettingsAccessProvider>
      <SettingsShell {...props} />
    </SettingsAccessProvider>
  );
}
