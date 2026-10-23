import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggingInterceptor } from './common/logging.interceptor';
import { ProblemJsonFilter } from './common/problem-json.filter';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { HouseholdModule } from './modules/household/household.module';
import { ProfileModule } from './modules/profile/profile.module';
import { PolicyModule } from './modules/policy/policy.module';

@Module({
  imports: [HealthModule, AuthModule, HouseholdModule, ProfileModule, PolicyModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemJsonFilter },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
