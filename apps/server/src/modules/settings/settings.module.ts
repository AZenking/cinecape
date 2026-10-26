import { Module } from '@nestjs/common';
import { SettingsAccessController } from './settings-access.controller';
import { SettingsGrantStartupRevocation } from './settings-access-revocation';

/**
 * 设置模块(T080~T085,005-US7;ADR-0011):
 * - SettingsAccessController:/settings/access 三端点(独立入口,api.md §6/§7)+
 *   一般设置主体代表 GET /settings/account(SessionGuard + SettingsAccessGuard);
 * - SettingsGrantStartupRevocation:onApplicationBootstrap 执行「启动时撤销所有
 *   grants」(data-model §3;备份恢复/进程重启不继承旧授权,readiness 前生效);
 * - 服务均为纯函数模块(settings-access-grant / settings-pin-verification /
 *   settings-access-revocation),对齐 auth/profile 模块惯例,无需注入;
 * - SettingsAccessGuard 仍居 common/(T009 扩展点),经具名导入直接 @UseGuards
 *   挂载,不入本模块 providers(common 守卫底座约定,common.module.ts 注释)。
 *
 * 模块注册(硬边界:本任务不改 app.module.ts,注册行原文如下,由 lead 接入):
 *   import { SettingsModule } from './modules/settings/settings.module';
 *   // AppModule.imports 列表 LiveModule 之后追加:
 *   SettingsModule
 */
@Module({
  controllers: [SettingsAccessController],
  providers: [SettingsGrantStartupRevocation],
})
export class SettingsModule {}
