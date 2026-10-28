import { Module } from '@nestjs/common';
import { SourcesModule } from '@contexts/sources/sources.module';
import { SettingsAccessController } from './settings-access.controller';
import { SettingsAccountController } from './settings-account.controller';
import { SettingsHouseholdController } from './settings-household.controller';
import { SettingsProfilesController } from './settings-profiles.controller';
import { SettingsPolicyController } from './settings-policy.controller';
import { SettingsSourcesController, SettingsCatalogController } from './settings-sources.controller';
import { SettingsEpgBindingController } from './settings-epg.controller';
import { SettingsDevicesController } from './settings-devices.controller';
import { SettingsGrantStartupRevocation } from './settings-access-revocation';

/**
 * 设置模块(T080~T085,US7;T125~T130,US8;ADR-0011):
 *
 * - SettingsAccessController:/settings/access 三端点(独立入口,api.md §6/§7);
 * - US8 管理子域控制器(T125~T130,全部 /api/settings/* 前缀,领域核心留在原模块
 *   仅加守卫):
 *   · SettingsAccountController     account / account/password(T126)
 *   · SettingsHouseholdController   household GET/PATCH(T130)
 *   · SettingsProfilesController    profiles + main-profile(T127)
 *   · SettingsPolicyController      profiles/{id}/policy(+lists)(T127)
 *   · SettingsSourcesController     sources/source-roots/refreshes/catalog(T128)
 *   · SettingsCatalogController     catalog candidates/media patch(T128)
 *   · SettingsEpgBindingController  catalog/media/{id}/epg-binding 三组(T129)
 *   · SettingsDevicesController     devices 三组(T130)
 * - 守卫链统一 SessionGuard + SettingsAccessGuard(Session→角色/当前主 Profile→grant);
 *   写路由再挂 SameOriginGuard;严格入参管道 + 当次密码 + 事务内权限/版本重验由
 *   各服务层承担(api.md §7 次序);
 * - RefreshModule 提供唯一 RefreshExecutorService(与旧 SourcesModule 同一实例,
 *   Nest 模块缓存);SettingsGrantStartupRevocation:onApplicationBootstrap 执行
 *   「启动时撤销所有 grants」(data-model §3);
 * - SettingsAccessGuard 居 common/(T009 扩展点),经具名导入直接 @UseGuards 挂载。
 */
@Module({
  imports: [SourcesModule],
  controllers: [
    SettingsAccessController,
    SettingsAccountController,
    SettingsHouseholdController,
    SettingsProfilesController,
    SettingsPolicyController,
    SettingsSourcesController,
    SettingsCatalogController,
    SettingsEpgBindingController,
    SettingsDevicesController,
  ],
  providers: [SettingsGrantStartupRevocation],
})
export class SettingsModule {}
