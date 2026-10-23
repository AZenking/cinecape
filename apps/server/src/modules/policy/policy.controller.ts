import { Body, Controller, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentSession, type SessionContext } from '../../common/current-session.decorator';
import { SessionGuard } from '../../common/session.guard';
import { DomainError } from '../../common/domain-error';
import { ProblemCode } from '@hmp/shared';
import { parseBody } from '../auth/validation';
import { getPolicy, updatePolicy, type PolicyDtoBody } from './policy.service';

/**
 * ProfilePolicy 管理契约路由(T011,002 contracts/openapi.yaml):
 * - 身份边界取自服务端会话;目标 :profileId 经归属校验(404 同形,不泄露跨家庭存在性);
 * - 判定次序:SessionGuard(401)→ owner(403)→ 严格 zod(400,未知字段拒绝)→
 *   家长验证(403/423)→ 目标(404)→ 版本(409)→ 事务保存;
 * - 不提供接受客户端媒体事实的公开 evaluate 端点(授权入口仅供服务端调用,FR-006/FR-015)。
 */

/** 契约 UpdatePolicyRequest(components/schemas/UpdatePolicyRequest;strictObject 拒绝未知字段) */
const updatePolicyRequestSchema = z.strictObject({
  ownerPassword: z.string().optional(),
  expectedVersion: z.number().int().positive(),
  policy: z.strictObject({
    maxContentLevel: z.number().int().min(0).max(18),
    allowUnrated: z.boolean(),
  }),
});

function requireOwner(context: SessionContext): void {
  if (context.account.role !== 'owner') {
    throw new DomainError(403, ProblemCode.FORBIDDEN, '仅主账号可以管理策略');
  }
}

@Controller('profiles/:profileId/policy')
@UseGuards(SessionGuard)
export class PolicyController {
  /** GET /profiles/{id}/policy:读取策略全文(owner) */
  @Get()
  get(@Param('profileId') profileId: string, @CurrentSession() context: SessionContext): PolicyDtoBody {
    requireOwner(context);
    return getPolicy(profileId, context);
  }

  /** PUT /profiles/{id}/policy:整体保存可编辑配置(owner + 家长验证 + 版本检查;名单服务端保留) */
  @Put()
  @HttpCode(200)
  async update(
    @Param('profileId') profileId: string,
    @Body() body: unknown,
    @CurrentSession() context: SessionContext,
  ): Promise<PolicyDtoBody> {
    requireOwner(context);
    const input = parseBody(updatePolicyRequestSchema, body);
    return updatePolicy(profileId, context, input);
  }
}
