import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { PlatformModule } from '@platform/platform.module';
import { ApiSecurityHeadersInterceptor } from '@platform/http-common/response-headers/api-security-headers.interceptor';
import { LoggingInterceptor } from '@platform/http-common/logging.interceptor';
import { ProblemJsonFilter } from '@platform/http-common/problem-json.filter';
import { Database } from '@platform/database/database';
import { createUnitOfWork, UNIT_OF_WORK } from '@platform/database/unit-of-work';
import { getConfig } from '@platform/config/env';
import { createSafeUpstreamService, SAFE_UPSTREAM_PORT } from '@platform/upstream/safe-upstream-reader';
import {
  SESSION_VERIFIER_PORT,
  SETTINGS_GRANT_VALIDATOR_PORT,
  type SessionVerifierPort,
  type SettingsGrantValidatorPort,
} from '@platform/http-common/platform.ports';
import { hashToken } from '@contexts/identity-access';
import { createIdentityAccessTxReaders } from '@contexts/identity-access/infrastructure/transaction-participants';
import { createProfileTxReaders } from '@contexts/profile/infrastructure/transaction-participants';
import { createPolicyTxReaders } from '@contexts/policy/infrastructure/transaction-participants';
import { createSourcesTxParticipants } from '@contexts/sources/infrastructure/transaction-participants';
import { createMediaCatalogTxParticipants } from '@contexts/media-catalog/infrastructure/transaction-participants';
import { createOnlineVodTxParticipants } from '@contexts/online-vod/infrastructure/transaction-participants';
import { createPlaybackTxParticipants } from '@contexts/playback/infrastructure/transaction-participants';
import { createPersonalDataTxParticipants } from '@contexts/personal-data/infrastructure/transaction-participants';
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
import { OnlineVodModule } from '@contexts/online-vod';

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
    {
      // 010 T031:平台 SafeUpstream 有界读取端口(全仓唯一绑定;T026 vod 连通性测试
      // 探测与 T028 搜索/详情上游共用同一实现)。缺省许可 = 部署 LAN_ALLOWED_TARGETS
      // (请求侧可逐一覆盖;DI 解析期读取,per-rig env 语义与刷新面同一口径)。
      provide: SAFE_UPSTREAM_PORT,
      useFactory: () => createSafeUpstreamService({ allowedTargets: getConfig().LAN_ALLOWED_TARGETS }),
    },
    {
      // 010 T016:平台 UnitOfWork —— txStores 工厂注册表装配(键名即上下文名)。
      // 组合根同时导入 platform 与各上下文 infrastructure(合法落点);各工厂为纯函数,
      // 每次 run 由平台以同一连接 TransactionBinding 调用产出绑定实现 —— 无全局 seam
      // 重绑、无 forwardRef、无第二执行循环(事务边界即调用栈边界)。
      provide: UNIT_OF_WORK,
      useFactory: () =>
        createUnitOfWork({
          resolveDatabase: () => Database.db,
          txStores: {
            identityAccess: createIdentityAccessTxReaders,
            profile: createProfileTxReaders,
            policy: createPolicyTxReaders,
            sources: createSourcesTxParticipants,
            catalog: createMediaCatalogTxParticipants,
            vod: createOnlineVodTxParticipants,
            playback: createPlaybackTxParticipants,
            personalData: createPersonalDataTxParticipants,
          },
        }),
    },
  ],
  exports: [SESSION_VERIFIER_PORT, SETTINGS_GRANT_VALIDATOR_PORT, UNIT_OF_WORK, SAFE_UPSTREAM_PORT],
})
export class PlatformPortsModule {}

@Module({
  imports: [PlatformModule, PlatformPortsModule, IdentityAccessModule, ProfileModule, PolicyModule, SourcesModule, MediaCatalogModule, EpgModule, PlaybackModule, PersonalDataModule, LiveTvModule, SettingsModule, OnlineVodModule],
  providers: [
    { provide: APP_FILTER, useClass: ProblemJsonFilter },
    // T009:所有 API 响应统一 Cache-Control: no-store + Referrer-Policy: no-referrer
    // (先于 LoggingInterceptor 注册;静态资源不在拦截器管线内,保持可缓存)
    { provide: APP_INTERCEPTOR, useClass: ApiSecurityHeadersInterceptor },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
