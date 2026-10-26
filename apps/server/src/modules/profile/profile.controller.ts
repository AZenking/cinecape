import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { DomainError } from '../../common/domain-error';
import { CurrentSession, type SessionContext } from '../../common/current-session.decorator';
import { SessionGuard } from '../../common/session.guard';
import { SameOriginGuard } from '../../common/same-origin/same-origin.guard';
import { StrictBodyPipe } from '../../common/strict-input/strict-pipes';
import { strictObject } from '../../common/strict-input/strict-schema';
import { hashPassword } from '../auth/password.service';
import { verifyParentPassword } from '../auth/parent-verification.service';
import { parseBody } from '../auth/validation';
import {
  createProfile,
  updateProfile,
  type ProfileDtoBody,
} from './profile.service';
import { listSelectableProfiles, selectActiveProfile, unlockSelectionPin } from './profile-selection.service';
import type { AccountSessionBody, ProfileSummaryBody } from '../auth/account-session.dto';

/**
 * Profile 契约路由(T038 最小选档 + 既有管理路由,005 contracts/api.md §3):
 * - 选档三端点(list/unlock/select)走 ProfileSummary/AccountSession 白名单投影,
 *   请求体 strictObject —— householdId/profileId/isAdmin 等未知字段一律 400(§1);
 *   身份只从服务端会话推导;:profileId 归属校验单一实现点 requireOwnedProfile:
 *   不存在或不属于当前家庭+账号 → 404 NOT_FOUND(不泄露跨家庭存在性);
 * - 创建/编辑(PATCH/POST)为管理写操作,维持既有契约(US8 迁移 /settings/profiles,
 *   本任务不动);角色(owner)→ 格式 → 家长验证 → 目标 → 写入。
 */

/** 契约 CreateProfileRequest(components/schemas/CreateProfileRequest;管理接口维持既有剥离语义) */
const createProfileRequestSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['adult', 'child']),
  avatar: z.string().optional(),
  isDefault: z.boolean().default(false),
  pin: z.string().min(4).max(12).optional(),
  /** 阶段 2:主账号密码(必填语义由服务层 403 PARENT_VERIFICATION_REQUIRED 表达) */
  ownerPassword: z.string().optional(),
});

/** 契约 UpdateProfileRequest(components/schemas/UpdateProfileRequest) */
const updateProfileRequestSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  avatar: z.string().optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  pin: z.string().min(4).max(12).optional(),
  clearPin: z.boolean().default(false),
  ownerPassword: z.string().optional(),
});

/** 契约 UnlockRequest;strictObject:未知字段(身份声明等)一律 400(005 §1) */
const unlockRequestSchema = strictObject({
  pin: z.string(),
});

/** select 可选请求体;strictObject:householdId/profileId/isAdmin 等未知字段一律 400(005 §1) */
const selectProfileRequestSchema = strictObject({
  ownerPassword: z.string().optional(),
});

function requireOwner(context: SessionContext): void {
  if (context.account.role !== 'owner') throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以管理档案');
}

/** 家长验证前置:缺失 → 403 PARENT_VERIFICATION_REQUIRED;随后交由服务计数/锁定 */
async function requireParentVerification(context: SessionContext, ownerPassword: string | undefined): Promise<void> {
  if (ownerPassword === undefined || ownerPassword === '') {
    throw new DomainError(403, ProblemCode.PARENT_VERIFICATION_REQUIRED, '需要主账号密码完成家长验证');
  }
  await verifyParentPassword(context, ownerPassword);
}

@Controller('profiles')
@UseGuards(SessionGuard)
export class ProfileController {
  /**
   * GET /profiles(T038 最小选档接口):登录会话的选档摘要 —— ProfileSummary 白名单
   * (id,name,avatar,type,isDefault,isMain,pinProtected,status,createdAt,version);
   * 禁用档案可见但 select 拒绝;不返回策略/锁定计数/失败日志等设置主体。
   */
  @Get()
  list(@CurrentSession() context: SessionContext): ProfileSummaryBody[] {
    return listSelectableProfiles(context.session.householdId);
  }

  /** POST /profiles:创建 Profile,归属当前会话家庭与账号(FR-013/场景1;阶段 2 须家长验证) */
  @Post()
  async create(
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<ProfileDtoBody> {
    requireOwner(context);
    const input = parseBody(createProfileRequestSchema, body);
    await requireParentVerification(context, input.ownerPassword);
    // argon2 哈希在事务外完成(短事务,对齐 setup.controller 惯例)
    const pinHash = input.pin !== undefined ? await hashPassword(input.pin) : undefined;
    return createProfile({
      householdId: context.session.householdId,
      accountId: context.session.accountId,
      name: input.name,
      type: input.type,
      avatar: input.avatar,
      isDefault: input.isDefault,
      pinHash,
    });
  }

  /**
   * PATCH /profiles/:profileId:编辑/停用/设默认/设或清 PIN(FR-013;阶段 2 须家长验证)。
   * 停用最后一个可用 Profile → 409;停用级联清空引用会话的当前观看者(FR-016/T028)。
   */
  @Patch(':profileId')
  async update(
    @Param('profileId') profileId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<ProfileDtoBody> {
    requireOwner(context);
    const input = parseBody(updateProfileRequestSchema, body);
    await requireParentVerification(context, input.ownerPassword);
    const pinHash = input.pin !== undefined ? await hashPassword(input.pin) : undefined;
    return updateProfile({
      profileId,
      householdId: context.session.householdId,
      accountId: context.session.accountId,
      name: input.name,
      avatar: input.avatar,
      isDefault: input.isDefault,
      status: input.status,
      clearPin: input.clearPin,
      pinHash,
    });
  }

  /**
   * POST /profiles/:profileId/select(T038):选择当前观看者,200 → AccountSession
   * (SessionDto 形,无 sessionToken)。受 PIN 保护须先 unlock;实际换档同事务递增
   * device_session.profile_context_version、撤销设置授予、终态化旧上下文活动播放;
   * 同一有效档案重选 200 但不递增。身份声明字段由 strictObject 400 拒绝。
   */
  @Post(':profileId/select')
  @HttpCode(200)
  @UseGuards(SessionGuard, SameOriginGuard)
  async select(
    @Param('profileId') profileId: string,
    @Body(new StrictBodyPipe(selectProfileRequestSchema))
    input: z.infer<typeof selectProfileRequestSchema>,
    @CurrentSession() context: SessionContext,
  ): Promise<AccountSessionBody> {
    return selectActiveProfile(context, profileId, input.ownerPassword);
  }

  /**
   * POST /profiles/:profileId/unlock(T038):PIN 解锁,签一次性选档授予。
   * 与设置验证共享原 profile 持久失败计数:未设 PIN 403 → 锁定窗口内 423
   * PROFILE_PIN_LOCKED(即使 PIN 正确,跨刷新/新会话保留)→ 错误 403 FORBIDDEN
   * (detail 仅含剩余次数)→ 成功 200 {unlocked:true}。
   */
  @Post(':profileId/unlock')
  @HttpCode(200)
  @UseGuards(SessionGuard, SameOriginGuard)
  async unlock(
    @Param('profileId') profileId: string,
    @Body(new StrictBodyPipe(unlockRequestSchema))
    input: z.infer<typeof unlockRequestSchema>,
    @CurrentSession() context: SessionContext,
  ): Promise<{ unlocked: true }> {
    return unlockSelectionPin(context, profileId, input.pin);
  }
}
