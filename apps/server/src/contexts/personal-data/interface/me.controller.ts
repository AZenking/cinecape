import { Body, Controller, Delete, Get, HttpCode, Param, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentProfile, type ProfileContext } from '../../common/profile-context/current-profile.decorator';
import { SessionGuard } from '../../common/session.guard';
import { CurrentProfileGuard } from '../../common/profile-context/current-profile.guard';
import { SameOriginGuard } from '../../common/same-origin/same-origin.guard';
import { StrictBodyPipe, StrictQueryPipe } from '../../common/strict-input/strict-pipes';
import { strictObject } from '../../common/strict-input/strict-schema';
import {
  addFavoriteChannel,
  listFavoriteChannels,
  removeFavoriteChannel,
  type FavoriteChannelPage,
} from './favorites.service';
import {
  getHistoryItem,
  listHistory,
  type HistoryItemDto,
  type HistoryPage,
} from './history.service';

/**
 * /me 个人边界路由(T098/T101,005 contracts/api.md §4):
 *
 * - 授权次序(§7「me 要求 Session→activeProfile 归属/状态→严格入参→数据归属」):
 *   SessionGuard(401)→ CurrentProfileGuard(未选档/停用 403 ACTIVE_PROFILE_REQUIRED)
 *   → strictObject/parseParam(未知字段一律 400)→ 数据归属(服务层仅按当前 Profile 查询);
 * - 身份只从服务端当前 Profile 推导:body/query 携带 profileId/householdId 等身份声明
 *   由 strict schema 400 拒绝,绝不据此切换身份;
 * - 写操作挂 SameOriginGuard(同源/JSON 体);响应 no-store 由全局拦截器统一注入,
 *   个人数据不嵌入公共详情、不进共享缓存;
 * - GET /me/history/{mediaId}:无个人记录 → 200 null(不是 404:不泄露存在性)。
 */

/** 分页查询契约(strict:未知字段拒绝;limit 1~100 默认 20) */
const meListQuerySchema = strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** PUT 收藏请求体契约:必须为空对象 `{}`(api.md §4「PUT `{}`」) */
const favoritePutBodySchema = strictObject({});

@Controller('me')
@UseGuards(SessionGuard, CurrentProfileGuard)
export class MeController {
  /** GET /me/favorites/channels:收藏频道(键集分页 + unavailable 摘要 + current/next) */
  @Get('favorites/channels')
  listFavorites(
    @Query(new StrictQueryPipe(meListQuerySchema))
    query: z.infer<typeof meListQuerySchema>,
    @CurrentProfile() profile: ProfileContext,
  ): FavoriteChannelPage {
    return listFavoriteChannels({
      householdId: profile.householdId,
      profileId: profile.id,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
  }

  /** PUT /me/favorites/channels/{mediaId}:幂等收藏(重复不更新 created_at)→ 204 */
  @Put('favorites/channels/:mediaId')
  @HttpCode(204)
  @UseGuards(SameOriginGuard)
  addFavorite(
    @Param('mediaId') mediaId: string,
    @Body(new StrictBodyPipe(favoritePutBodySchema)) _body: Record<string, never>,
    @CurrentProfile() profile: ProfileContext,
  ): void {
    addFavoriteChannel({ householdId: profile.householdId, profileId: profile.id, mediaId });
  }

  /** DELETE /me/favorites/channels/{mediaId}:幂等取消(已不存在仍 204;允许取消失效频道) */
  @Delete('favorites/channels/:mediaId')
  @HttpCode(204)
  @UseGuards(SameOriginGuard)
  removeFavorite(
    @Param('mediaId') mediaId: string,
    @CurrentProfile() profile: ProfileContext,
  ): void {
    removeFavoriteChannel({ householdId: profile.householdId, profileId: profile.id, mediaId });
  }

  /** GET /me/history:观看历史(服务端 last_viewed_at 倒序 + 游标分页) */
  @Get('history')
  listHistoryPage(
    @Query(new StrictQueryPipe(meListQuerySchema))
    query: z.infer<typeof meListQuerySchema>,
    @CurrentProfile() profile: ProfileContext,
  ): HistoryPage {
    return listHistory({
      householdId: profile.householdId,
      profileId: profile.id,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
  }

  /** GET /me/history/{mediaId}:HistoryItem 或 200 null(无个人记录;显式 JSON null) */
  @Get('history/:mediaId')
  getOneHistory(
    @Param('mediaId') mediaId: string,
    @CurrentProfile() profile: ProfileContext,
    @Res({ passthrough: true }) res: Response,
  ): HistoryItemDto | null {
    const item = getHistoryItem({
      householdId: profile.householdId,
      profileId: profile.id,
      mediaId,
    });
    // Nest 对 return null 落空体;契约要求 200 + JSON null(不 404,不泄露存在性)
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (item === null) {
      res.send('null');
      return null;
    }
    return item;
  }
}
