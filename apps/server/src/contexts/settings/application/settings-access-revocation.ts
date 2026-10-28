import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { deviceSession, settingsAccessGrant } from '@platform/database/schema';
import { Database } from '@platform/database/database';
import { getDb, type Db } from '@contexts/identity-access';

/**
 * 设置授予生命周期撤销(T085,005 data-model §3「显式撤销 + 启动撤销」、ADR-0011 决议 3/6)。
 *
 * 显式撤销与逐请求版本检查(requireValidSettingsGrant)互为双保险:前者在授权
 * 生命周期事件的事务内写 revoked_at,后者是并发窗口的竞态兜底。挂接点分两类:
 *
 * 【US2 已挂接(本任务核对,零改动)】
 * - 实际换档/失效回落/登出/PIN 恢复:contexts/profile/application/identity-transition.ts 的
 *   revokeSettingsGrantsForSessions / switchDeviceSessionProfile /
 *   clearDeviceSessionsProfile —— 调用方(auth logout、profile select、PIN 恢复)
 *   在同一 BEGIN IMMEDIATE 事务内撤销相关会话的设置授予;
 *
 * 【本文件新增(settings 侧,不改 auth 侧)】
 * - revokeSettingsGrantsForProfileTx:按主档案撤销其名下全部授予 —— PIN 变更/
 *   PIN 恢复、主档案转移、档案停用事务调用(US8 的 /settings/profiles、
 *   PUT /settings/main-profile 路由接线;当前 pin-recovery 已由 pin_version 递增
 *   + 会话清空覆盖语义,行级全量撤销自此统一收口);
 * - revokeSettingsGrantsForAccountTx:按账号撤销(密码改动同事务调用 ——
 *   US8 PUT /settings/account/password;该事务同时撤销全部 device_session);
 * - 应用启动撤销(revokeAllSettingsGrantsOnStartup):readiness 前撤销所有 grants,
 *   备份恢复/进程重启不继承不可验证的旧授权;普通浏览器刷新不触发。
 */

/** 事务内:撤销家庭全部未撤销设置授予(授权域事件统一收口) */
export function revokeAllSettingsGrantsForHouseholdTx(tx: Db, householdId: string): void {
  tx.update(settingsAccessGrant)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(settingsAccessGrant.householdId, householdId), isNull(settingsAccessGrant.revokedAt)))
    .run();
}

/**
 * 事务内:撤销指定档案名下全部设置授予(grant.profile_id 必须 = 当前主 Profile,
 * 故对主档案即「家庭全部」)。PIN 变更/恢复、主档案转移、档案停用事务调用。
 */
export function revokeSettingsGrantsForProfileTx(
  tx: Db,
  input: { householdId: string; profileId: string },
): void {
  tx.update(settingsAccessGrant)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(settingsAccessGrant.householdId, input.householdId),
        eq(settingsAccessGrant.profileId, input.profileId),
        isNull(settingsAccessGrant.revokedAt),
      ),
    )
    .run();
}

/** 事务内:撤销账号全部设置授予(经该账号的会话;密码改动同事务调用) */
export function revokeSettingsGrantsForAccountTx(tx: Db, accountId: string): void {
  const sessionIds = tx
    .select({ id: deviceSession.id })
    .from(deviceSession)
    .where(eq(deviceSession.accountId, accountId))
    .all()
    .map((row) => row.id);
  if (sessionIds.length === 0) {
    return;
  }
  tx.update(settingsAccessGrant)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(inArray(settingsAccessGrant.deviceSessionId, sessionIds), isNull(settingsAccessGrant.revokedAt)))
    .run();
}

/**
 * 启动撤销(data-model §3「启动时撤销所有 grants」+ §10「恢复备份后先撤销授予…
 * 再提供 readiness」):仅当存储就绪(user_version=2 且全部表/必需列在场,与
 * healthz 的 Database.isReady 同一门禁)时执行;撤销失败向上抛出 —— AppModule
 * 初始化失败、进程不进入监听,fail-closed(绝不带着未撤销的旧授权提供服务)。
 * 普通浏览器刷新不是服务重启,不经过此路径。
 */
export function revokeAllSettingsGrantsOnStartup(): void {
  if (!Database.isReady()) {
    // 未就绪(旧代际/迁移中断/备份恢复中):readiness 门禁本就 503,无请求被服务;
    // 此处不触碰可能不完整的库,待就绪路径(migrate 完成 + 重启)再撤销。
    return;
  }
  getDb().transaction((tx) => {
    tx.update(settingsAccessGrant)
      .set({ revokedAt: new Date().toISOString() })
      .where(isNull(settingsAccessGrant.revokedAt))
      .run();
  });
}

/**
 * 启动撤销挂载点(T085):Nest onApplicationBootstrap 在全部模块初始化后、
 * HTTP 监听前执行(生产 main.ts 为 NestFactory.create → listen 之间的初始化阶段;
 * 测试夹具为 app.init() 阶段),语义即「readiness 时撤销所有 grants」。
 * 挂在 SettingsModule providers 内,不改 app.module.ts / main.ts。
 */
@Injectable()
export class SettingsGrantStartupRevocation implements OnApplicationBootstrap {
  onApplicationBootstrap(): void {
    revokeAllSettingsGrantsOnStartup();
  }
}
