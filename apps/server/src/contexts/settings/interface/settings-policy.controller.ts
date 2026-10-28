import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsAccessGuard } from '@platform/http-common/settings-access/settings-access.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import {
  getPolicy,
  replacePolicyLists,
  updatePolicy,
  type PolicyDtoBody,
} from '@contexts/policy/application/policy.service';
/**
 * 内容权限契约路由(T127,005 contracts/api.md §6「GET/PUT /settings/profiles/{profileId}/policy
 * 与 policy/lists」;继承 002 字段):
 * - 判定次序:SessionGuard+SettingsAccessGuard(Session→角色/当前主 Profile→grant)→
 *   严格入参(管道,未知字段 400)→ 当次密码(服务层,既有计数/锁定)→ 目标归属(404 同形)
 *   → 版本 CAS(409)→ 事务(域核心 policy.service,语义零改动);
 * - PUT 整体保存等级/未评级(名单服务端保留);PUT lists 三名单整体替换。
 */

/** 契约 UpdatePolicyRequest(002;strictObject 拒绝未知字段) */
const updatePolicyRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
  policy: z.strictObject({
    maxContentLevel: z.number().int().min(0).max(18),
    allowUnrated: z.boolean(),
  }),
});

/** 契约 UpdateLists(003;三名单必填;去重/归属/类型校验在服务层) */
const updateListsRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().min(1),
  allowedMediaIds: z.array(z.string().min(1).max(128)),
  blockedMediaIds: z.array(z.string().min(1).max(128)),
  allowedChannelIds: z.array(z.string().min(1).max(128)),
});

@Controller('settings/profiles/:profileId/policy')
@UseGuards(SessionGuard, SettingsAccessGuard)
export class SettingsPolicyController {
  /** GET /settings/profiles/{profileId}/policy:策略全文(Settings 边界) */
  @Get()
  get(@Param('profileId') profileId: string, @CurrentSession() context: SessionContext): PolicyDtoBody {
    return getPolicy(profileId, context);
  }

  /** PUT /settings/profiles/{profileId}/policy:等级/未评级(当次密码 + expectedVersion CAS) */
  @Put()
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async update(
    @Param('profileId') profileId: string,
    @Body(new StrictBodyPipe(updatePolicyRequestSchema))
    input: z.infer<typeof updatePolicyRequestSchema>,
    @CurrentSession() context: SessionContext,
  ): Promise<PolicyDtoBody> {
    return updatePolicy(profileId, context, input);
  }

  /** PUT /settings/profiles/{profileId}/policy/lists:三名单整体替换(当次密码 + CAS) */
  @Put('lists')
  @UseGuards(SameOriginGuard, SessionGuard, SettingsAccessGuard)
  async replaceLists(
    @Param('profileId') profileId: string,
    @Body(new StrictBodyPipe(updateListsRequestSchema))
    input: z.infer<typeof updateListsRequestSchema>,
    @CurrentSession() context: SessionContext,
  ): Promise<PolicyDtoBody> {
    return replacePolicyLists(profileId, context, input);
  }
}
