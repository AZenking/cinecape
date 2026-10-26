import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggingInterceptor } from './common/logging.interceptor';
import { ProblemJsonFilter } from './common/problem-json.filter';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { HouseholdModule } from './modules/household/household.module';
import { ProfileModule } from './modules/profile/profile.module';
import { PolicyModule } from './modules/policy/policy.module';
import { SourcesModule } from './modules/sources/sources.module';
import { RefreshModule } from './modules/imports/refresh.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { EpgModule } from './modules/epg/epg.module';
import { PlaybackModule } from './modules/playback/playback.module';

@Module({
  imports: [HealthModule, AuthModule, HouseholdModule, ProfileModule, PolicyModule, SourcesModule, RefreshModule, CatalogModule, EpgModule, PlaybackModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemJsonFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
