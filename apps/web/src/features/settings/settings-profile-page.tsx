/**
 * 013 个人档案偏好设置页 (T010/US1).
 *
 * 我的档案 (profile) - 对应路由 /settings/profile:
 * 展示当前登录 Profile 的基本信息（昵称、头像标识、类型等），就地呈现。
 * 页内分区使用 SettingsSection(扁平分区,替代嵌套 Card,DESIGN.md)。
 * 入口在顶栏身份菜单(头像 → 我的档案),不进设置侧栏导航(settings-modules inNav=false)。
 */
import { type ReactNode } from 'react';
import { Avatar, Chip } from '@heroui/react';
import { useOptionalSession } from '../../app/session-provider';
import { useSettingsPageMeta } from './settings-modules';
import { SettingsPageHeader } from './shared/settings-page-header';
import { SettingsSection } from './shared/settings-section';

export function SettingsProfilePage(): ReactNode {
  const { title } = useSettingsPageMeta();
  const session = useOptionalSession();
  const profile = session?.session?.activeProfile;

  const roleLabel = profile?.isMain
    ? '家庭主管理员'
    : profile?.type === 'child'
      ? '儿童档案'
      : '标准家庭成员';

  const roleColor: 'accent' | 'warning' | 'default' = profile?.isMain
    ? 'accent'
    : profile?.type === 'child'
      ? 'warning'
      : 'default';

  return (
    <section aria-label={`设置 · ${title}`} className="flex flex-col gap-4" data-testid="settings-profile-page">
      <SettingsPageHeader description="查看当前激活的个人档案信息与偏好。" />

      <div className="w-full">
        <SettingsSection
          title={profile?.name ?? '个人档案'}
          description="当前正在使用的个人身份档案，拥有独立的播放历史、视听偏好及界面定制。"
          actions={
            <Chip color={roleColor} variant="soft" size="sm">
              {roleLabel}
            </Chip>
          }
          footer={
            <p className="text-xs text-muted">如需切换到其他家庭成员档案，请点击右上角头像菜单并选择目标档案。</p>
          }
        >
          <div className="flex items-center">
            <Avatar className="size-20 shrink-0 rounded-full border-2 border-border/40 text-2xl font-semibold">
              {profile?.avatar ? (
                <Avatar.Image src={profile.avatar} alt={profile.name} className="object-cover" />
              ) : null}
              <Avatar.Fallback color={roleColor}>
                {profile?.name?.slice(0, 1) ?? 'P'}
              </Avatar.Fallback>
            </Avatar>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm font-medium text-muted">档案标识</span>
            <span className="text-sm font-mono text-foreground">{profile?.id ?? '—'}</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm font-medium text-muted">档案类型</span>
            <span className="text-sm text-foreground">
              {profile?.isMain ? '主管理员档案' : profile?.type === 'child' ? '受限儿童模式' : '普通家庭成员'}
            </span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm font-medium text-muted">内容分级过滤</span>
            <span className="text-sm text-foreground">
              {profile?.type === 'child' ? '已启用（仅呈现儿童与适龄内容）' : '未限制（全年龄向内容）'}
            </span>
          </div>
        </SettingsSection>
      </div>
    </section>
  );
}
