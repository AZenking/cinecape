import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ProblemCode } from '@hmp/shared';
import { CurrentSession } from '@platform/http-common/current-session.decorator';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { DomainError } from '@platform/http-common/domain-error';
import { SameOriginGuard } from '@platform/http-common/same-origin/same-origin.guard';
import { SessionGuard } from '@platform/http-common/session.guard';
import { SettingsGuard } from '@contexts/settings/infrastructure/settings.guard';
import { StrictBodyPipe } from '@platform/http-common/strict-input/strict-pipes';
import { parseBody } from '@contexts/identity-access';
import {
  DEFAULT_RETENTION_DAYS,
  purgeArchivedSource,
  readGovernanceOverview,
  runCleanup,
} from '@contexts/settings/infrastructure/governance-store';

/**
 * 数据治理路由(021-source-governance,contracts/api.md §3)。
 *
 * - 概览与清理均按家庭隔离;retentionDays 1..3650,缺省 30;
 * - dry-run 只返回预计数量,不写库;真实清理写 governance_cleanup_run 审计;
 * - 永久清理归档来源使用 expectedVersion CAS;非归档/跨家庭 404 同形;
 * - 清理是显式管理员动作,不存在后台静默删除。
 */

const cleanupSchema = z.strictObject({
  target: z.enum(['expired-programmes', 'stale-entries', 'snapshots', 'refresh-jobs', 'archived-sources']),
  retentionDays: z.number().int().min(1).max(3650).default(DEFAULT_RETENTION_DAYS),
  dryRun: z.boolean().default(true),
});

const purgeSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});

@Controller('settings/governance')
@UseGuards(SessionGuard, SettingsGuard)
export class SettingsGovernanceController {
  /** GET /settings/governance/overview:归档来源清单 + 各清理目标计数。 */
  @Get('overview')
  overview(
    @CurrentSession() context: SessionContext,
  ): ReturnType<typeof readGovernanceOverview> {
    return readGovernanceOverview(context.session.householdId);
  }

  /** POST /settings/governance/cleanup:dry-run 预览或真实清理。 */
  @Post('cleanup')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  cleanup(
    @Body(new StrictBodyPipe(cleanupSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): ReturnType<typeof runCleanup> {
    const input = parseBody(cleanupSchema, body);
    return runCleanup(
      context.session.householdId,
      context.session.accountId,
      input.target,
      input.retentionDays,
      input.dryRun,
    );
  }

  /** POST /settings/governance/archived-sources/:sourceId/purge:单条永久清理。 */
  @Post('archived-sources/:sourceId/purge')
  @HttpCode(200)
  @UseGuards(SameOriginGuard)
  purge(
    @Param('sourceId') sourceId: string,
    @Body(new StrictBodyPipe(purgeSchema)) body: unknown,
    @CurrentSession() context: SessionContext,
  ): { deleted: number; bytesFreed: number } {
    const input = parseBody(purgeSchema, body);
    try {
      const result = purgeArchivedSource(
        context.session.householdId,
        sourceId,
        input.expectedVersion,
      );
      if (result === null) {
        throw new DomainError(404, ProblemCode.NOT_FOUND);
      }
      return result;
    } catch (error) {
      if (error instanceof DomainError) {
        throw error;
      }
      if (
        error !== null &&
        typeof error === 'object' &&
        (error as { code?: unknown }).code === 'SOURCE_VERSION_CONFLICT'
      ) {
        throw new DomainError(409, ProblemCode.SOURCE_VERSION_CONFLICT);
      }
      throw error;
    }
  }
}