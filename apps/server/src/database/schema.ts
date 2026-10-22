import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * ⚠️ DDL 的权威是 migrations/*.sql,本文件为查询层类型,两处需同步修改。
 *
 * 逐列对照:docs/specs/001-scaffold-identity-foundation/data-model.md
 * 硬约束(宪章 FR-006 / ADR-0003):每张表显式保留 household_id;
 * 所有 id 为应用侧 crypto.randomUUID() 生成的 TEXT 主键。
 */

export const household = sqliteTable(
  'household',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    defaultLanguage: text('default_language').notNull().default('zh-CN'),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    createdAt: text('created_at').notNull(),
  },
);

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    username: text('username').notNull(),
    usernameNormalized: text('username_normalized').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('account_username_normalized_key').on(t.usernameNormalized),
    uniqueIndex('account_household_id_key').on(t.householdId),
    // 复合外键目标:profile(household_id, account_id) → account(household_id, id)
    uniqueIndex('account_household_id_id_key').on(t.householdId, t.id),
    check('account_role_check', sql`${t.role} IN ('owner', 'admin')`),
  ],
);

export const profile = sqliteTable(
  'profile',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    name: text('name').notNull(),
    avatar: text('avatar'),
    type: text('type').notNull(),
    isDefault: integer('is_default').notNull().default(0),
    pinHash: text('pin_hash'),
    status: text('status').notNull(),
    failedPinCount: integer('failed_pin_count').notNull().default(0),
    pinLockedUntil: text('pin_locked_until'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    // 归属一致性(实现评审修正):复合 FK (household_id, account_id) → account(household_id, id)。
    // 严禁 UNIQUE(household_id, account_id):那会在 account UNIQUE(household_id) 之上
    // 把 profile 压缩到每家庭 1 行,与 "account 1───N profile" 矛盾(data-model.md 已同步修正)。
    foreignKey({
      name: 'profile_account_composite_fk',
      columns: [t.householdId, t.accountId],
      foreignColumns: [account.householdId, account.id],
    }),
    // FR-013:每 household 至多一个"可用默认"—— 部分唯一索引
    uniqueIndex('one_default_profile')
      .on(t.householdId)
      .where(sql`${t.isDefault} = 1 AND ${t.status} = 'active'`),
    check('profile_type_check', sql`${t.type} IN ('adult', 'child')`),
    check('profile_status_check', sql`${t.status} IN ('active', 'disabled')`),
    check('profile_is_default_check', sql`${t.isDefault} IN (0, 1)`),
  ],
);

export const device = sqliteTable(
  'device',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    name: text('name'),
    type: text('type').notNull(),
    lastSeenAt: text('last_seen_at'),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [check('device_type_check', sql`${t.type} IN ('web', 'mobile', 'tv', 'nas', 'other')`)],
);

export const deviceSession = sqliteTable(
  'device_session',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id),
    deviceId: text('device_id')
      .notNull()
      .references(() => device.id),
    tokenHash: text('token_hash').notNull(),
    // 服务端维护的当前观看者;Profile 停用时同事务清空引用(FR-016)
    activeProfileId: text('active_profile_id').references(() => profile.id),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    lastActiveAt: text('last_active_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('device_session_token_hash_key').on(t.tokenHash)],
);

/** 查询层类型(读取) */
export type Household = typeof household.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Profile = typeof profile.$inferSelect;
export type Device = typeof device.$inferSelect;
export type DeviceSession = typeof deviceSession.$inferSelect;

/** 写入新行时的必填类型 */
export type NewHousehold = typeof household.$inferInsert;
export type NewAccount = typeof account.$inferInsert;
export type NewProfile = typeof profile.$inferInsert;
export type NewDevice = typeof device.$inferInsert;
export type NewDeviceSession = typeof deviceSession.$inferInsert;
