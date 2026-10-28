import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentSession, type SessionContext } from '@platform/http-common/current-session.decorator';
import { SessionGuard } from '@platform/http-common/session.guard';
import { getHousehold, toHouseholdDto, type HouseholdDtoBody } from '@contexts/identity-access/application/household.service';

/**
 * GET /household(T020):家庭信息边界只从服务端会话解析(FR-018)。
 * 方法不接受任何查询参数 —— 客户端伪造 householdId 一律无效。
 */
@Controller('household')
@UseGuards(SessionGuard)
export class HouseholdController {
  @Get()
  getHousehold(@CurrentSession() context: SessionContext): HouseholdDtoBody {
    return toHouseholdDto(getHousehold(context.session.householdId));
  }
}
