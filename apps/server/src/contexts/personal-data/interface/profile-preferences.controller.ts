import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentProfile, type ProfileContext } from '@platform/http-common/profile-context/current-profile.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { CurrentProfileGuard } from '@platform/http-common/profile-context/current-profile.guard';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { strictObject } from '@platform/http-common/strict-input/strict-schema';
import {
  getProfilePreferences,
  putProfilePreferences,
  type ProfilePreferencesSnapshot,
} from '@contexts/personal-data/application/profile-preferences.service';

/**
 * /profile 个人偏好路由(013-role-differentiated-settings,US1;settings-contracts.md §2.1):
 *
 * - GET /api/profile/preferences → 200 ProfilePreferences(未有行返回传输默认值,零写入);
 * - PUT /api/profile/preferences(部分字段提交合法,合并语义)→ 200 更新后完整快照;
 *
 * - 授权次序与 /me 面完全一致:SessionGuard(游客/伪造 token 401)→ CurrentProfileGuard
 *   (未选档/停用 403 ACTIVE_PROFILE_REQUIRED);个人偏好属个人边界,**零 PIN/密码/
 *   临时 Ticket 阻断**(ADR-0017:任何已选档 Profile 直达);
 * - 身份键只从服务端当前 Session/激活 Profile 推导,路径/body 不接受任何
 *   profileId/householdId 身份声明(严格 schema 未知字段 400);
 * - PUT 叠 SameOriginGuard(同源/JSON 体,与 /me 写操作同款);no-store 由全局拦截器统一注入。
 */

/** PUT 偏好请求体契约(strict:未知字段拒绝;至少一项;合并语义 —— 只提交要改的字段) */
const preferencesPutBodySchema = strictObject({
  defaultAudioLanguage: z.string().min(1).max(16).optional(),
  defaultSubtitleLanguage: z.string().min(1).max(16).optional(),
  autoPlayNext: z.boolean().optional(),
  themeMode: z.enum(['system', 'dark', 'light']).optional(),
  posterDensity: z.enum(['comfortable', 'compact']).optional(),
}).refine(
  (body) =>
    body.defaultAudioLanguage !== undefined ||
    body.defaultSubtitleLanguage !== undefined ||
    body.autoPlayNext !== undefined ||
    body.themeMode !== undefined ||
    body.posterDensity !== undefined,
  { message: '至少提交一项偏好字段' },
);

@Controller('profile')
@UseGuards(SessionGuard, CurrentProfileGuard)
export class ProfilePreferencesController {
  /** GET /profile/preferences:个人偏好快照(未有行返回默认值,零写入) */
  @Get('preferences')
  getPreferences(@CurrentProfile() profile: ProfileContext): ProfilePreferencesSnapshot {
    return getProfilePreferences(profile.householdId, profile.id);
  }

  /** PUT /profile/preferences:合并写入,返回更新后的完整快照 */
  @Put('preferences')
  @UseGuards(SameOriginGuard)
  putPreferences(
    @Body(new StrictBodyPipe(preferencesPutBodySchema))
    body: z.infer<typeof preferencesPutBodySchema>,
    @CurrentProfile() profile: ProfileContext,
  ): ProfilePreferencesSnapshot {
    return putProfilePreferences(profile.householdId, profile.id, body);
  }
}
