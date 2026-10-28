import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PlatformModule } from '@platform/platform.module';
import { ApiSecurityHeadersInterceptor } from '@platform/http-common/response-headers/api-security-headers.interceptor';
import { LoggingInterceptor } from '@platform/http-common/logging.interceptor';
import { ProblemJsonFilter } from '@platform/http-common/problem-json.filter';
import {
  SESSION_VERIFIER_PORT,
  SETTINGS_GRANT_VALIDATOR_PORT,
  type SessionVerifierPort,
  type SettingsGrantValidatorPort,
} from '@platform/http-common/platform.ports';
import { hashToken } from '@contexts/identity-access';
import { requireValidSettingsGrant } from '@contexts/settings';
import { IdentityAccessModule } from '@contexts/identity-access/identity-access.module';
import { ProfileModule } from '@contexts/profile/profile.module';
import { PolicyModule } from '@contexts/policy/policy.module';
import { SourcesModule } from '@contexts/sources/sources.module';
import { MediaCatalogModule } from '@contexts/media-catalog/media-catalog.module';
import { EpgModule } from '@contexts/epg/epg.module';
import { PlaybackModule } from '@contexts/playback/playback.module';
import { LiveTvModule } from '@contexts/live-tv/live-tv.module';
import { SettingsModule } from '@contexts/settings/settings.module';
import { PersonalDataModule } from '@contexts/personal-data/personal-data.module';

/**
 * 组合根端口绑定(T022b 治理裁决,ADR-0014 修正案:R4 platform→contexts 端口反转)。
 *
 * platform 守卫(SessionGuard / SettingsAccessGuard)消费 platform.ports.ts 的
 * 端口令牌,真实实现(上下文发布面纯函数)只在此绑定 —— 组合根同时导入 platform
 * 与 contexts,落点合法;platform/** 内零 contexts 依赖。
 *
 * @Global 使令牌导出对所有模块注入器可见:守卫经 @UseGuards(类) 由路由所在
 * 模块的注入器在请求期延迟实例化(APP_GUARD 同理),全局导出保证两种挂法均可解析;
 * 端口值为发布面纯函数(无 this 依赖),行为与原深导入完全等价。
 */
@Global()
@Module({
  providers: [
    {
      provide: SESSION_VERIFIER_PORT,
      useValue: { hashToken } satisfies SessionVerifierPort,
    },
    {
      provide: SETTINGS_GRANT_VALIDATOR_PORT,
      useValue: { requireValidSettingsGrant } satisfies SettingsGrantValidatorPort,
    },
  ],
  exports: [SESSION_VERIFIER_PORT, SETTINGS_GRANT_VALIDATOR_PORT],
})
export class PlatformPortsModule {}

@Module({
  imports: [PlatformModule, PlatformPortsModule, IdentityAccessModule, ProfileModule, PolicyModule, SourcesModule, MediaCatalogModule, EpgModule, PlaybackModule, PersonalDataModule, LiveTvModule, SettingsModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemJsonFilter },
    // T009:所有 API 响应统一 Cache-Control: no-store + Referrer-Policy: no-referrer
    // (先于 LoggingInterceptor 注册;静态资源不在拦截器管线内,保持可缓存)
    { provide: APP_INTERCEPTOR, useClass: ApiSecurityHeadersInterceptor },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
