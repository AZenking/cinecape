import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession, type SessionContext } from '../../common/current-session.decorator';
import { SessionGuard } from '../../common/session.guard';
import { hashPassword } from '../auth/password.service';
import { verifyParentPassword } from '../auth/parent-verification.service';
import { parseBody } from '../auth/validation';
import {
  createProfile,
  listProfiles,
  requireOwnedProfile,
  selectProfile,
  updateProfile,
  type ProfileDtoBody,
  type SelectProfileResult,
} from './profile.service';
import { unlockProfilePin } from './pin.service';
import { DomainError } from '../../common/domain-error';
import { ProblemCode } from '@hmp/shared';

/**
 * Profile 契约路由(US1 list + US2 创建/编辑/选择/PIN,FR-013~019;阶段 2 增补 FR-004/FR-012):
 * - 一切身份边界取自服务端会话(@CurrentSession),请求体中的
 *   householdId/profileId 等伪造字段被 zod 对象剥离忽略(FR-018);
 * - :profileId 归属校验单一实现点 requireOwnedProfile:不存在或
 *   不属于当前家庭+账号 → 404 NOT_FOUND(不泄露跨家庭存在性,FR-019);
 * - 创建/编辑为管理写操作:角色(owner)→ 格式 → 家长验证(403 REQUIRED/FAILED、
 *   423 LOCKED)→ 目标 → 写入;owner 会话可能被儿童共用,角色不能替代家长身份;
 * - select 沿用「归属/可用性优先」:有 PIN 走原一次性解锁授予;无 PIN 成人在
 *   含儿童家庭(含停用儿童)须家长验证(FR-012)。
 */

/** 契约 CreateProfileRequest(components/schemas/CreateProfileRequest;身份接口继续剥离未知字段) */
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

/** 契约 UnlockRequest(components/schemas/UnlockRequest) */
const unlockRequestSchema = z.object({
  pin: z.string(),
});

/** select 可选请求体:仅接受 ownerPassword,其余未知字段剥离(FR-014) */
const selectProfileRequestSchema = z.object({
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
  /** GET /profiles:列出当前 Household 的 Profile(FR-014 前置) */
  @Get()
  list(@CurrentSession() context: SessionContext): ProfileDtoBody[] {
    return listProfiles(context.session.householdId);
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
   * POST /profiles/:profileId/select:选择当前观看者(FR-014,200 → SessionDto 形;FR-012)。
   * 404 归属 → 403 PROFILE_NOT_SELECTABLE(已停用)→ 403 PROFILE_PIN_REQUIRED(未解锁)
   * → 403 PARENT_VERIFICATION_REQUIRED(无 PIN 成人 + 家庭含儿童,密码缺失/错误/锁定)。
   */
  @Post(':profileId/select')
  @HttpCode(200)
  async select(
    @Param('profileId') profileId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<SelectProfileResult> {
    const input = parseBody(selectProfileRequestSchema, body ?? {});
    return selectProfile(profileId, context, input.ownerPassword);
  }

  /**
   * POST /profiles/:profileId/unlock:PIN 解锁(FR-015)。
   * 未设 PIN 403 → 锁定窗口内 423 PROFILE_PIN_LOCKED(即使 PIN 正确)→
   * 错误 403 FORBIDDEN(detail 仅含剩余次数)→ 成功 200 {unlocked:true} 并签发解锁授予。
   */
  @Post(':profileId/unlock')
  @HttpCode(200)
  async unlock(
    @Param('profileId') profileId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<{ unlocked: true }> {
    const input = parseBody(unlockRequestSchema, body);
    const row = requireOwnedProfile(profileId, context);
    return unlockProfilePin(row, input.pin, context.session.id);
  }
}
