import { Body, Controller, Get, Inject, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { UNIT_OF_WORK } from '@platform/database/unit-of-work';
import { CurrentProfile, type ProfileContext } from '@platform/http-common/profile-context/current-profile.decorator';
import { CurrentSession, type SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { CurrentProfileGuard } from '@platform/http-common/profile-context/current-profile.guard';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import {
  getVodPreferences,
  patchVodPreferences,
  systemVodPreferencesDeps,
  type PreferenceUnitOfWork,
} from '@contexts/personal-data/application/vod-preferences.service';
import type { VodPreferencesSnapshot } from '@contexts/personal-data/application/preference-work-set.port';
import {
  getVodTitleProgress,
  type VodTitleProgressDto,
} from '@contexts/personal-data/application/vod-history.service';

/**
 * /me/vod 在线点播个人边界路由(010 T046/T056;api.md §3 个人接口表):
 *
 * - GET /me/vod/titles/:parentId/progress → 200 TitleProgress
 *   {latest,resumeCandidate,nextEpisodeAction};父级不存在 404 MEDIA_NOT_FOUND 同形
 *   (不泄露跨家庭存在性);自己的不可用历史仍作为 latest 摘要;不泄露其他 Profile。
 * - GET /me/vod/preferences → 200 Preferences;未有行返回默认 true/true/version=0
 *   (传输初值,不偷偷写公共状态;T056)。
 * - PATCH /me/vod/preferences → 200 Preferences(写入后新快照,持久 version>=1);
 *   {expectedVersion>=0,autoplayNext?,switchCarryPosition?,operationKey:UUID} 至少一偏好
 *   (严格 zod,未知字段/混形/缺偏好字段一律 400);CAS 409 VERSION_CONFLICT;同成功 key
 *   24h 内原样重放不更新版本,异摘要 409 IDEMPOTENCY_CONFLICT;偏好 CAS 与幂等 operation
 *   同一事务(T056,api.md §3 / data-model §10 U1)。
 *
 * - 授权次序与既有 /me 面完全一致(api.md §0/§7「me 要求 Session→activeProfile 归属/
 *   状态→严格入参→数据归属」):SessionGuard(游客/伪造 token 401)→ CurrentProfileGuard
 *   (未选档/停用 403 ACTIVE_PROFILE_REQUIRED)→ 数据归属(服务层恒按服务端推导
 *   household+profile 查询/写入;:parentId 仅是资源定位符,不携带身份声明);
 * - 个人查询键明确:householdId/profileId/deviceSessionId 只从服务端当前 Session/激活
 *   Profile 推导,路径/查询/body 不接受任何 profileId/householdId 身份声明(严格 schema
 *   未知字段 400);个人数据不进共享缓存(no-store 由全局拦截器统一注入,与 /me/history
 *   同边界);
 * - PATCH 叠 SameOriginGuard(同源/JSON 体,与 MeController 写操作同款;幂等 scope 内的
 *   contextVersion 为服务端会话现值,事务内重验,客户端声明一律不接受)。
 */

/** PATCH 偏好请求体契约(strict:未知字段拒绝;至少一偏好字段;operationKey 必须 UUID) */
const preferencesPatchBodySchema = strictObject({
  expectedVersion: z.number().int().min(0),
  autoplayNext: z.boolean().optional(),
  switchCarryPosition: z.boolean().optional(),
  operationKey: z.string().uuid(),
}).refine((body) => body.autoplayNext !== undefined || body.switchCarryPosition !== undefined, {
  message: '至少提交一项偏好字段(autoplayNext/switchCarryPosition)',
});

@Controller('me/vod')
@UseGuards(SessionGuard, CurrentProfileGuard)
export class VodPersonalController {
  // @Inject 显式声明(esbuild/tsx 运行时不发射 design:paramtypes;仓库既有惯例);
  // UNIT_OF_WORK 由组合根 @Global PlatformPortsModule 提供(PersonalDataModule 零装配增量;
  // 服务以结构镜像类型消费,相容性由测试 rig 真实 createUnitOfWork 编译期保证)。
  constructor(@Inject(UNIT_OF_WORK) private readonly uow: PreferenceUnitOfWork) {}

  /** GET /me/vod/titles/:parentId/progress:父级标题进度(latest/候选续播/下一集 action) */
  @Get('titles/:parentId/progress')
  getTitleProgress(
    @Param('parentId') parentId: string,
    @CurrentProfile() profile: ProfileContext,
  ): VodTitleProgressDto {
    return getVodTitleProgress({
      householdId: profile.householdId,
      profileId: profile.id,
      parentMediaId: parentId,
    });
  }

  /** GET /me/vod/preferences:连播偏好(未有行返回默认 true/true/version=0,零写入) */
  @Get('preferences')
  getPreferences(@CurrentProfile() profile: ProfileContext): VodPreferencesSnapshot {
    return getVodPreferences(this.uow, { householdId: profile.householdId, profileId: profile.id });
  }

  /** PATCH /me/vod/preferences:CAS 更新 + 成功 key 24h 幂等重放(同事务;T056) */
  @Patch('preferences')
  @UseGuards(SameOriginGuard)
  patchPreferences(
    @Body(new StrictBodyPipe(preferencesPatchBodySchema))
    body: z.infer<typeof preferencesPatchBodySchema>,
    @CurrentSession() session: SessionContext,
    @CurrentProfile() profile: ProfileContext,
  ): VodPreferencesSnapshot {
    return patchVodPreferences(
      systemVodPreferencesDeps(this.uow),
      {
        expectedVersion: body.expectedVersion,
        autoplayNext: body.autoplayNext ?? null,
        switchCarryPosition: body.switchCarryPosition ?? null,
        operationKey: body.operationKey,
      },
      {
        householdId: profile.householdId,
        deviceSessionId: session.session.id,
        profileId: profile.id,
      },
    );
  }
}
