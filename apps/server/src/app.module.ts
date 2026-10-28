import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { ApiSecurityHeadersInterceptor } from './common/response-headers/api-security-headers.interceptor';
import { LoggingInterceptor } from './common/logging.interceptor';
import { ProblemJsonFilter } from './common/problem-json.filter';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { HouseholdModule } from './modules/household/household.module';
import { ProfileModule } from '@contexts/profile/profile.module';
import { PolicyModule } from '@contexts/policy/policy.module';
import { SourcesModule } from './modules/sources/sources.module';
import { RefreshModule } from './modules/imports/refresh.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { EpgModule } from '@contexts/epg/epg.module';
import { PlaybackModule } from './modules/playback/playback.module';
import { PublicCatalogModule } from './modules/public-catalog/public-catalog.module';
import { LiveTvModule } from '@contexts/live-tv/live-tv.module';
import { SettingsModule } from './modules/settings/settings.module';
import { PersonalDataModule } from '@contexts/personal-data/personal-data.module';

@Module({
  imports: [CommonModule, HealthModule, AuthModule, HouseholdModule, ProfileModule, PolicyModule, SourcesModule, RefreshModule, CatalogModule, EpgModule, PlaybackModule, PersonalDataModule, PublicCatalogModule, LiveTvModule, SettingsModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemJsonFilter },
    // T009:所有 API 响应统一 Cache-Control: no-store + Referrer-Policy: no-referrer
    // (先于 LoggingInterceptor 注册;静态资源不在拦截器管线内,保持可缓存)
    { provide: APP_INTERCEPTOR, useClass: ApiSecurityHeadersInterceptor },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
