import { desc, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
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
    // 0006 增补(005 data-model §2):通用设置变更用 version CAS;
    // main_profile_version 仅主档案转移递增,不因普通页面读取递增(应用层语义)
    version: integer('version').notNull().default(1),
    mainProfileVersion: integer('main_profile_version').notNull().default(1),
  },
  (t) => [
    check('household_version_check', sql`${t.version} >= 1`),
    check('household_main_profile_version_check', sql`${t.mainProfileVersion} >= 1`),
  ],
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
    // 0006 增补(005 data-model §2):密码改动递增,同事务撤销该账号全部 device_session 与设置授予
    credentialVersion: integer('credential_version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('account_username_normalized_key').on(t.usernameNormalized),
    uniqueIndex('account_household_id_key').on(t.householdId),
    // 复合外键目标:profile(household_id, account_id) → account(household_id, id)
    uniqueIndex('account_household_id_id_key').on(t.householdId, t.id),
    check('account_role_check', sql`${t.role} IN ('owner', 'admin')`),
    check('account_credential_version_check', sql`${t.credentialVersion} >= 1`),
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
    // 0006 增补(005 data-model §2):主档案标记与乐观并发版本;is_default 保留为默认观看
    // 偏好,与 is_main 无权限等价关系
    isMain: integer('is_main').notNull().default(0),
    pinVersion: integer('pin_version').notNull().default(1),
    version: integer('version').notNull().default(1),
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
    // 0006 增补:每 household 至多一个主档案 —— 唯一索引 (household_id) WHERE is_main=1
    uniqueIndex('one_main_profile')
      .on(t.householdId)
      .where(sql`${t.isMain} = 1`),
    check('profile_type_check', sql`${t.type} IN ('adult', 'child')`),
    check('profile_status_check', sql`${t.status} IN ('active', 'disabled')`),
    check('profile_is_default_check', sql`${t.isDefault} IN (0, 1)`),
    check('profile_is_main_check', sql`${t.isMain} IN (0, 1)`),
    // 主档案必须 type=adult,status=active,pin_hash IS NOT NULL
    check(
      'profile_main_profile_check',
      sql`${t.isMain} = 0 OR (${t.type} = 'adult' AND ${t.status} = 'active' AND ${t.pinHash} IS NOT NULL)`,
    ),
    check('profile_pin_version_check', sql`${t.pinVersion} >= 1`),
    check('profile_version_check', sql`${t.version} >= 1`),
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
    // 0006 增补(005 data-model §2):实际 activeProfile 改变/清空/失效回落时递增;
    // A→B→A 至少递增两次(应用层语义);同一事务改变身份/撤销设置授予/终态化活动播放
    profileContextVersion: integer('profile_context_version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('device_session_token_hash_key').on(t.tokenHash),
    check(
      'device_session_profile_context_version_check',
      sql`${t.profileContextVersion} >= 1`,
    ),
  ],
);

/** 查询层类型(读取) */
export type Household = typeof household.$inferSelect;
export type Account = typeof account.$inferSelect;
export type Profile = typeof profile.$inferSelect;
export type Device = typeof device.$inferSelect;
export type DeviceSession = typeof deviceSession.$inferSelect;

/**
 * ProfilePolicy(阶段 2,002 data-model.md):一档案一策略,复合主键 + UNIQUE(profile_id),
 * (household_id, profile_id) 复合外键 → profile(household_id, id)(依赖 0002 的唯一索引)。
 * 三名单为 JSON 数组文本(CHECK json_valid + array),version 乐观并发。
 */
export const profilePolicy = sqliteTable(
  'profile_policy',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    profileId: text('profile_id').notNull(),
    maxContentLevel: integer('max_content_level').notNull(),
    allowUnrated: integer('allow_unrated').notNull(),
    allowedMediaIds: text('allowed_media_ids').notNull().default('[]'),
    blockedMediaIds: text('blocked_media_ids').notNull().default('[]'),
    allowedChannelIds: text('allowed_channel_ids').notNull().default('[]'),
    version: integer('version').notNull().default(1),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'profile_policy_pk', columns: [t.householdId, t.profileId] }),
    uniqueIndex('profile_policy_unique_profile').on(t.profileId),
    foreignKey({
      name: 'profile_policy_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
    check('profile_policy_level_check', sql`${t.maxContentLevel} BETWEEN 0 AND 18`),
    check('profile_policy_unrated_check', sql`${t.allowUnrated} IN (0, 1)`),
    check('profile_policy_version_check', sql`${t.version} >= 1`),
    check(
      'profile_policy_allowed_json_check',
      sql`json_valid(${t.allowedMediaIds}) AND json_type(${t.allowedMediaIds}) = 'array'`,
    ),
    check(
      'profile_policy_blocked_json_check',
      sql`json_valid(${t.blockedMediaIds}) AND json_type(${t.blockedMediaIds}) = 'array'`,
    ),
    check(
      'profile_policy_channel_json_check',
      sql`json_valid(${t.allowedChannelIds}) AND json_type(${t.allowedChannelIds}) = 'array'`,
    ),
  ],
);

/** 家长验证状态:账号范围失败计数与锁定(不存密码;密码经 account.password_hash 校验) */
export const parentVerificationState = sqliteTable(
  'parent_verification_state',
  {
    householdId: text('household_id').notNull(),
    accountId: text('account_id').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: text('locked_until'),
  },
  (t) => [
    primaryKey({ name: 'parent_verification_state_pk', columns: [t.householdId, t.accountId] }),
    foreignKey({
      name: 'parent_verification_account_composite_fk',
      columns: [t.householdId, t.accountId],
      foreignColumns: [account.householdId, account.id],
    }),
    check('parent_verification_attempts_check', sql`${t.failedAttempts} >= 0`),
  ],
);

export type ProfilePolicy = typeof profilePolicy.$inferSelect;
export type NewProfilePolicy = typeof profilePolicy.$inferInsert;
export type ParentVerificationState = typeof parentVerificationState.$inferSelect;
export type NewParentVerificationState = typeof parentVerificationState.$inferInsert;

/** 写入新行时的必填类型 */
export type NewHousehold = typeof household.$inferInsert;
export type NewAccount = typeof account.$inferInsert;
export type NewProfile = typeof profile.$inferInsert;
export type NewDevice = typeof device.$inferInsert;
export type NewDeviceSession = typeof deviceSession.$inferInsert;

/**
 * 阶段 3(003-media-catalog):媒体目录与来源,逐列对照
 * migrations/0003_media_catalog/up.sql 与 docs/specs/003-media-catalog/data-model.md。
 * 硬约束:全部新表显式 household_id;复合外键以 (household_id, id) 或既有唯一键为目标,
 * 禁止跨家庭 source/entry/media/job/EPG 关联;文件大小/mtimeNs 为十进制文本。
 */

/** 家庭目录修订:主键即 household_id(一家庭一行),发布/来源配置/人工元数据修改加一 */
export const catalogState = sqliteTable(
  'catalog_state',
  {
    householdId: text('household_id')
      .primaryKey()
      .references(() => household.id),
    revision: integer('revision').notNull().default(1),
  },
  (t) => [check('catalog_state_revision_check', sql`${t.revision} >= 1`)],
);

/** 媒体来源(iptv/epg/nas):无硬删除,禁用保留引用;remote_url 为私有字段 */
export const mediaSource = sqliteTable(
  'media_source',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    remoteUrl: text('remote_url'),
    rootKey: text('root_key'),
    relativeDirectory: text('relative_directory'),
    privateAccessApproved: integer('private_access_approved').notNull().default(0),
    // DDL 复合自引用外键 → media_source(household_id, id):Drizzle 不支持同表复合外键
    // 声明,约束以 up.sql 为权威(kind=epg/非自引用另由应用事务校验)
    epgSourceId: text('epg_source_id'),
    enabled: integer('enabled').notNull().default(1),
    version: integer('version').notNull().default(1),
    lastSuccessAt: text('last_success_at'),
    // DDL 复合外键 → source_refresh(household_id, id)(前向引用,查询层不镜像)
    lastJobId: text('last_job_id'),
    // 0004 增补(ADR-0008):每次成功发布 EPG 窗口 +1(与节目替换同事务),失败/中断不加;
    // ALTER TABLE ADD COLUMN 追加,既有已成功来源迁移后为 0(DDL 约束以 up.sql 为权威)
    epgGeneration: integer('epg_generation').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('media_source_household_id_id_key').on(t.householdId, t.id),
    check('media_source_kind_check', sql`${t.kind} IN ('iptv', 'epg', 'nas')`),
    check('media_source_name_check', sql`length(${t.name}) BETWEEN 1 AND 100`),
    // remote_url:iptv/epg 必填,nas 必为 null
    check(
      'media_source_remote_url_check',
      sql`(${t.kind} IN ('iptv', 'epg') AND ${t.remoteUrl} IS NOT NULL) OR (${t.kind} = 'nas' AND ${t.remoteUrl} IS NULL)`,
    ),
    // root_key/relative_directory:仅 nas 必填,其他类型必为 null
    check(
      'media_source_nas_root_check',
      sql`(${t.kind} = 'nas' AND ${t.rootKey} IS NOT NULL AND ${t.relativeDirectory} IS NOT NULL) OR (${t.kind} IN ('iptv', 'epg') AND ${t.rootKey} IS NULL AND ${t.relativeDirectory} IS NULL)`,
    ),
    check('media_source_private_access_check', sql`${t.privateAccessApproved} IN (0, 1)`),
    check('media_source_epg_source_kind_check', sql`${t.epgSourceId} IS NULL OR ${t.kind} = 'iptv'`),
    check('media_source_enabled_check', sql`${t.enabled} IN (0, 1)`),
    check('media_source_version_check', sql`${t.version} >= 1`),
    check('media_source_epg_generation_check', sql`${t.epgGeneration} >= 0`),
  ],
);

/** 媒体条目:人工标题/类型不被普通刷新覆盖;channel 与非 channel 禁止互转(应用层保证) */
export const mediaItem = sqliteTable(
  'media_item',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    posterRef: text('poster_ref'),
    contentLevel: integer('content_level'),
    titleOverridden: integer('title_overridden').notNull().default(0),
    typeOverridden: integer('type_overridden').notNull().default(0),
    version: integer('version').notNull(),
    // 0006 增补(005 data-model §2):同一 NAS 身份文件可信 size/mtime 变化时导入发布事务递增;
    // 普通标题/分级修改只改既有 version;老内容修订的进度不能用于新输入续播
    contentRevision: integer('content_revision').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('media_item_household_id_id_key').on(t.householdId, t.id),
    check('media_item_type_check', sql`${t.type} IN ('channel', 'movie', 'series', 'episode', 'video')`),
    check('media_item_title_check', sql`length(${t.title}) BETWEEN 1 AND 255`),
    check('media_item_description_check', sql`${t.description} IS NULL OR length(${t.description}) <= 4096`),
    check('media_item_content_level_check', sql`${t.contentLevel} IS NULL OR ${t.contentLevel} BETWEEN 0 AND 18`),
    check('media_item_title_overridden_check', sql`${t.titleOverridden} IN (0, 1)`),
    check('media_item_type_overridden_check', sql`${t.typeOverridden} IN (0, 1)`),
    check('media_item_version_check', sql`${t.version} >= 1`),
    check('media_item_content_revision_check', sql`${t.contentRevision} >= 1`),
  ],
);

/** 持久刷新任务:只存 initiator 账号/会话 ID,不存密码/token;终态 immutable(应用层保证) */
export const sourceRefresh = sqliteTable(
  'source_refresh',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    sourceId: text('source_id').notNull(),
    initiatorAccountId: text('initiator_account_id').notNull(),
    initiatorSessionId: text('initiator_session_id').notNull(),
    operationKey: text('operation_key').notNull(),
    status: text('status').notNull(),
    version: integer('version').notNull(),
    sourceVersion: integer('source_version').notNull(),
    baselineRevision: integer('baseline_revision').notNull(),
    snapshotDigest: text('snapshot_digest'),
    itemCount: integer('item_count'),
    summaryJson: text('summary_json'),
    errorCode: text('error_code'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    expiresAt: text('expires_at'),
  },
  (t) => [
    uniqueIndex('source_refresh_household_id_id_key').on(t.householdId, t.id),
    uniqueIndex('source_refresh_operation_key').on(t.householdId, t.operationKey),
    // 运行锁:同来源 queued/running/awaiting_confirmation 至多一个(部分唯一索引)
    uniqueIndex('one_active_refresh_per_source')
      .on(t.householdId, t.sourceId)
      .where(sql`${t.status} IN ('queued', 'running', 'awaiting_confirmation')`),
    check(
      'source_refresh_status_check',
      sql`${t.status} IN ('queued', 'running', 'succeeded', 'failed', 'awaiting_confirmation', 'interrupted', 'discarded', 'expired', 'stale')`,
    ),
    check('source_refresh_version_check', sql`${t.version} >= 1`),
    check('source_refresh_source_version_check', sql`${t.sourceVersion} >= 1`),
    check('source_refresh_baseline_revision_check', sql`${t.baselineRevision} >= 1`),
    check('source_refresh_item_count_check', sql`${t.itemCount} IS NULL OR ${t.itemCount} >= 0`),
    check('source_refresh_summary_json_check', sql`${t.summaryJson} IS NULL OR json_valid(${t.summaryJson})`),
    foreignKey({
      name: 'source_refresh_source_composite_fk',
      columns: [t.householdId, t.sourceId],
      foreignColumns: [mediaSource.householdId, mediaSource.id],
    }),
    foreignKey({
      name: 'source_refresh_initiator_account_composite_fk',
      columns: [t.householdId, t.initiatorAccountId],
      foreignColumns: [account.householdId, account.id],
    }),
    foreignKey({
      name: 'source_refresh_initiator_session_composite_fk',
      columns: [t.householdId, t.initiatorSessionId],
      foreignColumns: [deviceSession.householdId, deviceSession.id],
    }),
  ],
);

/** 来源条目(身份稳定键):条目消失仅改 present,重现复用 media_id;摘要为 SHA-256 十六进制 */
export const sourceEntry = sqliteTable(
  'source_entry',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    sourceId: text('source_id').notNull(),
    identityKind: text('identity_kind').notNull(),
    identityDigest: text('identity_digest').notNull(),
    mediaId: text('media_id'),
    upstreamChannelId: text('upstream_channel_id'),
    present: integer('present').notNull().default(1),
    lastSeenJobId: text('last_seen_job_id'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    missingSince: text('missing_since'),
    fileSizeText: text('file_size_text'),
    fileMtimeNs: text('file_mtime_ns'),
    // 0006 增补(005 data-model §2):M3U 发布分组,TEXT NULL,存储值域为已归一化
    // (trim 后 1~100 字符,空白为 NULL;归一化由导入发布写入路径执行)
    groupTitle: text('group_title'),
  },
  (t) => [
    uniqueIndex('source_entry_household_id_id_key').on(t.householdId, t.id),
    uniqueIndex('source_entry_identity_key').on(t.householdId, t.sourceId, t.identityKind, t.identityDigest),
    check('source_entry_identity_kind_check', sql`${t.identityKind} IN ('tvg_id', 'url', 'path')`),
    check(
      'source_entry_identity_digest_check',
      sql`length(${t.identityDigest}) = 64 AND ${t.identityDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check('source_entry_present_check', sql`${t.present} IN (0, 1)`),
    // 十进制文本(仅 NAS 来源写入;空串非法),避免 JS 整数精度截断
    check(
      'source_entry_file_size_check',
      sql`${t.fileSizeText} IS NULL OR (length(${t.fileSizeText}) >= 1 AND ${t.fileSizeText} NOT GLOB '*[^0-9]*')`,
    ),
    check(
      'source_entry_file_mtime_check',
      sql`${t.fileMtimeNs} IS NULL OR (length(${t.fileMtimeNs}) >= 1 AND ${t.fileMtimeNs} NOT GLOB '*[^0-9]*')`,
    ),
    // 存储值域:已 trim(与自身 trim 相等)且 1~100 字符,或 NULL
    check(
      'source_entry_group_title_check',
      sql`${t.groupTitle} IS NULL OR (${t.groupTitle} = trim(${t.groupTitle}) AND length(${t.groupTitle}) BETWEEN 1 AND 100)`,
    ),
    foreignKey({
      name: 'source_entry_source_composite_fk',
      columns: [t.householdId, t.sourceId],
      foreignColumns: [mediaSource.householdId, mediaSource.id],
    }),
    foreignKey({
      name: 'source_entry_media_composite_fk',
      columns: [t.householdId, t.mediaId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
    foreignKey({
      name: 'source_entry_last_job_composite_fk',
      columns: [t.householdId, t.lastSeenJobId],
      foreignColumns: [sourceRefresh.householdId, sourceRefresh.id],
    }),
  ],
);

/** 播放资源记录:私有 location,不下发播放 URL;首期每条目至多一个资源 */
export const playbackSource = sqliteTable(
  'playback_source',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    sourceId: text('source_id').notNull(),
    sourceEntryId: text('source_entry_id').notNull(),
    mediaItemId: text('media_item_id').notNull(),
    protocol: text('protocol').notNull(),
    location: text('location').notNull(),
    mimeType: text('mime_type'),
    priority: integer('priority').notNull().default(100),
    requiresProxy: integer('requires_proxy').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('playback_source_household_id_id_key').on(t.householdId, t.id),
    uniqueIndex('playback_source_entry_key').on(t.householdId, t.sourceEntryId),
    check('playback_source_protocol_check', sql`${t.protocol} IN ('hls', 'dash', 'file', 'flv', 'http')`),
    check('playback_source_priority_check', sql`${t.priority} >= 0`),
    check('playback_source_proxy_check', sql`${t.requiresProxy} IN (0, 1)`),
    foreignKey({
      name: 'playback_source_source_composite_fk',
      columns: [t.householdId, t.sourceId],
      foreignColumns: [mediaSource.householdId, mediaSource.id],
    }),
    foreignKey({
      name: 'playback_source_entry_composite_fk',
      columns: [t.householdId, t.sourceEntryId],
      foreignColumns: [sourceEntry.householdId, sourceEntry.id],
    }),
    foreignKey({
      name: 'playback_source_media_composite_fk',
      columns: [t.householdId, t.mediaItemId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
  ],
);

/**
 * XMLTV 频道:唯一键即 (household_id, source_id, xmltv_channel_id)(复合主键),
 * 同时作为 epg_programme 复合外键目标;XMLTV 频道 ID 不与平台 media_id 混用。
 */
export const epgChannel = sqliteTable(
  'epg_channel',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    sourceId: text('source_id').notNull(),
    xmltvChannelId: text('xmltv_channel_id').notNull(),
    displayName: text('display_name').notNull(),
    conflicted: integer('conflicted').notNull().default(0),
  },
  (t) => [
    primaryKey({ name: 'epg_channel_pk', columns: [t.householdId, t.sourceId, t.xmltvChannelId] }),
    check('epg_channel_conflicted_check', sql`${t.conflicted} IN (0, 1)`),
    foreignKey({
      name: 'epg_channel_source_composite_fk',
      columns: [t.householdId, t.sourceId],
      foreignColumns: [mediaSource.householdId, mediaSource.id],
    }),
  ],
);

/** XMLTV 节目:UTC ISO-8601 文本存储,结束严格大于开始;完全相同节目按唯一键去重 */
export const epgProgramme = sqliteTable(
  'epg_programme',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    sourceId: text('source_id').notNull(),
    xmltvChannelId: text('xmltv_channel_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at').notNull(),
  },
  (t) => [
    uniqueIndex('epg_programme_household_id_id_key').on(t.householdId, t.id),
    uniqueIndex('epg_programme_slot_key').on(t.householdId, t.sourceId, t.xmltvChannelId, t.startsAt, t.endsAt),
    check('epg_programme_title_check', sql`length(${t.title}) BETWEEN 1 AND 255`),
    check('epg_programme_description_check', sql`${t.description} IS NULL OR length(${t.description}) <= 4096`),
    check('epg_programme_window_check', sql`${t.endsAt} > ${t.startsAt}`),
    foreignKey({
      name: 'epg_programme_channel_composite_fk',
      columns: [t.householdId, t.sourceId, t.xmltvChannelId],
      foreignColumns: [epgChannel.householdId, epgChannel.sourceId, epgChannel.xmltvChannelId],
    }),
  ],
);

/** 解析结果私有暂存:分批写入,不进入浏览查询;kind 由各导入适配器定义(规格未固定枚举) */
export const refreshStageEntry = sqliteTable(
  'refresh_stage_entry',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    refreshId: text('refresh_id').notNull(),
    entryKey: text('entry_key').notNull(),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (t) => [
    primaryKey({ name: 'refresh_stage_entry_pk', columns: [t.householdId, t.refreshId, t.entryKey] }),
    check('refresh_stage_entry_payload_json_check', sql`json_valid(${t.payloadJson})`),
    foreignKey({
      name: 'refresh_stage_entry_refresh_composite_fk',
      columns: [t.householdId, t.refreshId],
      foreignColumns: [sourceRefresh.householdId, sourceRefresh.id],
    }),
  ],
);

/**
 * 0004 增补(US5/ADR-0008):单频道手动 EPG 绑定,逐列对照
 * migrations/0004_manual_epg_binding/up.sql 与 data-model.md「## 0004 增补」。
 * manual 保存即锁定(来源/频道成对);auto 为解除后的版本墓碑(不删行,防 ABA);
 * version 无行读取为 0、首写 1、其后每次保存/解除 +1;不 FK 到 epg_channel(窗口替换会删行)。
 */
export const manualEpgBinding = sqliteTable(
  'manual_epg_binding',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    mediaId: text('media_id').notNull(),
    mode: text('mode').notNull(),
    // manual 时两者非空、auto 时两者均 NULL(成对规则);DDL 复合外键 → media_source(household_id, id)
    epgSourceId: text('epg_source_id'),
    // XMLTV 频道 ID 长度 1~255,大小写敏感(不加 COLLATE NOCASE)
    xmltvChannelId: text('xmltv_channel_id'),
    version: integer('version').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'manual_epg_binding_pk', columns: [t.householdId, t.mediaId] }),
    // EPG 发布失效与绑定管理按来源定位受影响绑定;按家庭读取走主键前缀
    index('manual_epg_binding_household_source_key').on(t.householdId, t.epgSourceId),
    check('manual_epg_binding_mode_check', sql`${t.mode} IN ('manual', 'auto')`),
    check(
      'manual_epg_binding_target_pair_check',
      sql`(${t.mode} = 'manual' AND ${t.epgSourceId} IS NOT NULL AND ${t.xmltvChannelId} IS NOT NULL) OR (${t.mode} = 'auto' AND ${t.epgSourceId} IS NULL AND ${t.xmltvChannelId} IS NULL)`,
    ),
    check(
      'manual_epg_binding_xmltv_channel_check',
      sql`${t.xmltvChannelId} IS NULL OR length(${t.xmltvChannelId}) BETWEEN 1 AND 255`,
    ),
    check('manual_epg_binding_version_check', sql`${t.version} >= 1`),
    foreignKey({
      name: 'manual_epg_binding_media_composite_fk',
      columns: [t.householdId, t.mediaId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
    foreignKey({
      name: 'manual_epg_binding_source_composite_fk',
      columns: [t.householdId, t.epgSourceId],
      foreignColumns: [mediaSource.householdId, mediaSource.id],
    }),
  ],
);

/** 阶段 3 查询层类型(读取) */
export type CatalogState = typeof catalogState.$inferSelect;
export type MediaSource = typeof mediaSource.$inferSelect;
export type MediaItem = typeof mediaItem.$inferSelect;
export type SourceRefresh = typeof sourceRefresh.$inferSelect;
export type SourceEntry = typeof sourceEntry.$inferSelect;
export type PlaybackSource = typeof playbackSource.$inferSelect;
export type EpgChannel = typeof epgChannel.$inferSelect;
export type EpgProgramme = typeof epgProgramme.$inferSelect;
export type RefreshStageEntry = typeof refreshStageEntry.$inferSelect;
/** 0004 增补查询层类型(读取) */
export type ManualEpgBinding = typeof manualEpgBinding.$inferSelect;

/** 阶段 3 写入新行时的必填类型 */
export type NewCatalogState = typeof catalogState.$inferInsert;
export type NewMediaSource = typeof mediaSource.$inferInsert;
export type NewMediaItem = typeof mediaItem.$inferInsert;
export type NewSourceRefresh = typeof sourceRefresh.$inferInsert;
export type NewSourceEntry = typeof sourceEntry.$inferInsert;
export type NewPlaybackSource = typeof playbackSource.$inferInsert;
export type NewEpgChannel = typeof epgChannel.$inferInsert;
export type NewEpgProgramme = typeof epgProgramme.$inferInsert;
export type NewRefreshStageEntry = typeof refreshStageEntry.$inferInsert;
/** 0004 增补写入新行时的必填类型 */
export type NewManualEpgBinding = typeof manualEpgBinding.$inferInsert;

/**
 * 阶段 4(004-playback-resolver):播放会话与派生记录,逐列对照
 * migrations/0005_playback/up.sql 与 docs/specs/004-playback-resolver/data-model.md
 * 「## playback_session」「## playback_ticket」「## playback_conversion」
 * 「## playback_failure_event」四节。
 * 硬约束:全部新表显式 household_id;复合外键以 (household_id, id) 唯一键为目标,
 * 禁止跨家庭关联;时间为 UTC ISO-8601 TEXT。状态机(preparing→ready/…、终态不可复活、
 * seek/重建输出升 generation、纯字幕切换仅升 version)由应用层执行;
 * 数据库层只落实 data-model 明示的 CHECK,不设状态转换触发器。
 */

/**
 * 播放会话:绑定 device_session/device/profile/media 后不可改变;created_at 为请求被接受,
 * started_at 为首次媒体交付(可能永不发生,之后不重置);desired_paused 保留 seek/换轨时
 * 的暂停意图。source/delivery 在 preparing 允许为空(准备失败禁止补造),活动三态必须非空。
 */
export const playbackSession = sqliteTable(
  'playback_session',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    deviceSessionId: text('device_session_id').notNull(),
    deviceId: text('device_id').notNull(),
    profileId: text('profile_id').notNull(),
    mediaId: text('media_id').notNull(),
    // preparing 允许为 NULL;ready/playing/paused 必非空(CHECK);终态保留已确定值
    playbackSourceId: text('playback_source_id'),
    state: text('state').notNull(),
    delivery: text('delivery'),
    generation: integer('generation').notNull(),
    version: integer('version').notNull(),
    // 影片逻辑时间秒(REAL:API 契约 positionSeconds 为 number,可含小数;CHECK 非负)
    positionSeconds: real('position_seconds').notNull(),
    audioTrackId: text('audio_track_id'),
    subtitleTrackId: text('subtitle_track_id'),
    // seek/重建输出的换轨保留暂停意图(NOT NULL,默认 false);heartbeat.paused 更新
    desiredPaused: integer('desired_paused').notNull().default(0),
    // 0006 增补(005 data-model §2):resolve 时从可信 DeviceSession 捕获;每次控制/renew/
    // 交付和个人进度写入必须等于当前 DeviceSession 版本(应用层重验)
    profileContextVersion: integer('profile_context_version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    lastHeartbeatAt: text('last_heartbeat_at').notNull(),
    failureCode: text('failure_code'),
  },
  (t) => [
    // 复合外键目标:playback_ticket / playback_conversion(household_id, session_id) → 本表
    uniqueIndex('playback_session_household_id_id_key').on(t.householdId, t.id),
    // 设备维度查询(data-model:索引 (household_id,device_id,created_at,id))
    index('playback_session_household_device_key').on(t.householdId, t.deviceId, t.createdAt, t.id),
    // 档案隔离查询:按 profile 过滤播放记录(前导 (household_id, profile_id))
    index('playback_session_household_profile_key').on(t.householdId, t.profileId, t.createdAt, t.id),
    check(
      'playback_session_state_check',
      sql`${t.state} IN ('preparing', 'ready', 'playing', 'paused', 'ended', 'failed', 'interrupted')`,
    ),
    // delivery 五值;preparing/终态可为 NULL(准备失败禁止补造)
    check(
      'playback_session_delivery_check',
      sql`${t.delivery} IS NULL OR ${t.delivery} IN ('direct', 'hls_proxy', 'remux', 'audio_transcode', 'video_transcode')`,
    ),
    // 准备完成方可交付:活动三态必须同时确定源与交付模式
    check(
      'playback_session_source_delivery_check',
      sql`${t.state} NOT IN ('ready', 'playing', 'paused') OR (${t.playbackSourceId} IS NOT NULL AND ${t.delivery} IS NOT NULL)`,
    ),
    check('playback_session_generation_check', sql`${t.generation} >= 1`),
    check('playback_session_version_check', sql`${t.version} >= 1`),
    check('playback_session_position_check', sql`${t.positionSeconds} >= 0`),
    check(
      'playback_session_profile_context_version_check',
      sql`${t.profileContextVersion} >= 1`,
    ),
    // 布尔:0 = 继续播放(默认),1 = 保持暂停
    check('playback_session_desired_paused_check', sql`${t.desiredPaused} IN (0, 1)`),
    // ended_at 在终态(ended/failed/interrupted)必填,活动态必空
    check(
      'playback_session_ended_at_check',
      sql`(${t.state} IN ('ended', 'failed', 'interrupted') AND ${t.endedAt} IS NOT NULL) OR (${t.state} NOT IN ('ended', 'failed', 'interrupted') AND ${t.endedAt} IS NULL)`,
    ),
    // 失败码仅 failed 非空(双向)
    check(
      'playback_session_failure_code_check',
      sql`(${t.state} = 'failed' AND ${t.failureCode} IS NOT NULL) OR (${t.state} <> 'failed' AND ${t.failureCode} IS NULL)`,
    ),
    foreignKey({
      name: 'playback_session_device_session_composite_fk',
      columns: [t.householdId, t.deviceSessionId],
      foreignColumns: [deviceSession.householdId, deviceSession.id],
    }),
    foreignKey({
      name: 'playback_session_device_composite_fk',
      columns: [t.householdId, t.deviceId],
      foreignColumns: [device.householdId, device.id],
    }),
    foreignKey({
      name: 'playback_session_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
    foreignKey({
      name: 'playback_session_media_composite_fk',
      columns: [t.householdId, t.mediaId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
    // playbackSourceId 为 NULL 时复合外键按 MATCH SIMPLE 语义不校验
    foreignKey({
      name: 'playback_session_source_composite_fk',
      columns: [t.householdId, t.playbackSourceId],
      foreignColumns: [playbackSource.householdId, playbackSource.id],
    }),
  ],
);

/**
 * 播放票据:随机 256bit ticket 只在创建/续期响应出现一次,会话侧仅存 hash;
 * 续期写新行,旧票原过期时间不变;seek/重建输出的换轨升 generation 后旧票不可用(应用层过滤)。
 */
export const playbackTicket = sqliteTable(
  'playback_ticket',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    sessionId: text('session_id').notNull(),
    // 明文 URL 不入库,仅 SHA-256 hash;全局唯一
    tokenHash: text('token_hash').notNull(),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    generation: integer('generation').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    // token_hash 全局唯一:hash 反查票据入口(device_session_token_hash_key 同规则)
    uniqueIndex('playback_ticket_token_hash_key').on(t.tokenHash),
    check('playback_ticket_generation_check', sql`${t.generation} >= 1`),
    // 票据有效期必须为正区间(相等亦拒绝)
    check('playback_ticket_expiry_check', sql`${t.expiresAt} > ${t.issuedAt}`),
    foreignKey({
      name: 'playback_ticket_session_composite_fk',
      columns: [t.householdId, t.sessionId],
      foreignColumns: [playbackSession.householdId, playbackSession.id],
    }),
  ],
);

/**
 * 播放转换:每会话每代至多一条(UNIQUE(household_id,session_id,generation))。无队列:
 * BEGIN IMMEDIATE 内计算全局额度再 reserve,spawn 失败补偿释放;唯一单实例执行器负责回收,
 * 重启先标 interrupted。output_*_codec 为非空服务器输出编码标识('none' 合法,不设枚举);
 * cleanup_state 仅 pending/complete,目录删除成功才 complete,无第三枚举。
 */
export const playbackConversion = sqliteTable(
  'playback_conversion',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    sessionId: text('session_id').notNull(),
    generation: integer('generation').notNull(),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    // 硬件加速后端标识(探测后确定,预留前可为 NULL)
    hardwareBackend: text('hardware_backend'),
    outputVideoCodec: text('output_video_codec').notNull(),
    outputAudioCodec: text('output_audio_codec').notNull(),
    // started_at 为进程成功启动;ended_at 在终态必填(CHECK);last_progress_at 首次进度前为空
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    failureCode: text('failure_code'),
    // 目录删除成功才 complete;删除失败仍为 pending,不存在 cleanup_pending 第三枚举
    cleanupState: text('cleanup_state').notNull().default('pending'),
    bytesOnDisk: integer('bytes_on_disk').notNull().default(0),
    lastProgressAt: text('last_progress_at'),
  },
  (t) => [
    // 每会话每代至多一条转换记录(单实例执行器以本键幂等回收)
    uniqueIndex('playback_conversion_session_generation_key').on(t.householdId, t.sessionId, t.generation),
    check('playback_conversion_mode_check', sql`${t.mode} IN ('remux', 'audio_transcode', 'video_transcode')`),
    check(
      'playback_conversion_state_check',
      sql`${t.state} IN ('reserved', 'probing', 'starting', 'running', 'stopping', 'ended', 'failed', 'interrupted')`,
    ),
    check('playback_conversion_generation_check', sql`${t.generation} >= 1`),
    // ended_at 在终态(ended/failed/interrupted)必填(data-model 未要求非终态为空,不加强约束)
    check(
      'playback_conversion_ended_at_check',
      sql`${t.state} NOT IN ('ended', 'failed', 'interrupted') OR ${t.endedAt} IS NOT NULL`,
    ),
    // 失败码仅 failed 必填、其余为空(双向)
    check(
      'playback_conversion_failure_code_check',
      sql`(${t.state} = 'failed' AND ${t.failureCode} IS NOT NULL) OR (${t.state} <> 'failed' AND ${t.failureCode} IS NULL)`,
    ),
    check('playback_conversion_cleanup_state_check', sql`${t.cleanupState} IN ('pending', 'complete')`),
    check('playback_conversion_bytes_check', sql`${t.bytesOnDisk} >= 0`),
    foreignKey({
      name: 'playback_conversion_session_composite_fk',
      columns: [t.householdId, t.sessionId],
      foreignColumns: [playbackSession.householdId, playbackSession.id],
    }),
  ],
);

/**
 * 播放失败事件(审计):仅有效设备会话可写;媒体不属于该家庭或不可见则 media_id 为 NULL
 * (不存客户端原始目标 ID);不关联所选资源,不产生播放 session。
 */
export const playbackFailureEvent = sqliteTable(
  'playback_failure_event',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    deviceSessionId: text('device_session_id').notNull(),
    deviceId: text('device_id').notNull(),
    profileId: text('profile_id'),
    mediaId: text('media_id'),
    occurredAt: text('occurred_at').notNull(),
    // 稳定失败码:审计聚合键,具体码表由应用层定义(CHECK 仅保证非空字符串)
    stableCode: text('stable_code').notNull(),
  },
  (t) => [
    // 审计检索:按设备时间序定位(household_id, device_id, occurred_at, id)
    index('playback_failure_event_household_device_time_key').on(t.householdId, t.deviceId, t.occurredAt, t.id),
    check('playback_failure_event_stable_code_check', sql`length(${t.stableCode}) >= 1`),
    foreignKey({
      name: 'playback_failure_event_device_session_composite_fk',
      columns: [t.householdId, t.deviceSessionId],
      foreignColumns: [deviceSession.householdId, deviceSession.id],
    }),
    foreignKey({
      name: 'playback_failure_event_device_composite_fk',
      columns: [t.householdId, t.deviceId],
      foreignColumns: [device.householdId, device.id],
    }),
    // profileId/mediaId 为 NULL 时复合外键按 MATCH SIMPLE 语义不校验
    foreignKey({
      name: 'playback_failure_event_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
    foreignKey({
      name: 'playback_failure_event_media_composite_fk',
      columns: [t.householdId, t.mediaId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
  ],
);

/** 阶段 4 查询层类型(读取) */
export type PlaybackSession = typeof playbackSession.$inferSelect;
export type PlaybackTicket = typeof playbackTicket.$inferSelect;
export type PlaybackConversion = typeof playbackConversion.$inferSelect;
export type PlaybackFailureEvent = typeof playbackFailureEvent.$inferSelect;

/** 阶段 4 写入新行时的必填类型 */
export type NewPlaybackSession = typeof playbackSession.$inferInsert;
export type NewPlaybackTicket = typeof playbackTicket.$inferInsert;
export type NewPlaybackConversion = typeof playbackConversion.$inferInsert;
export type NewPlaybackFailureEvent = typeof playbackFailureEvent.$inferInsert;

/**
 * 数据代际 2(005-pc-browsing-flow,0006_pc_experience):PC 公开浏览与个人观看体验,
 * 逐列对照 migrations/0006_pc_experience/up.sql 与 docs/specs/005-pc-browsing-flow/
 * data-model.md §1~§7。硬约束同前:全部新表显式 household_id,复合外键以既有父表
 * (household_id, id) 唯一键为目标(0002 profile / 0003 device_session、media_item /
 * 0005 playback_session,已在 0006 up.sql 注释逐一确认);时间为 UTC ISO-8601 TEXT;
 * 写入状态转换(grant 15 分钟固定有效期、epoch 分配、样本 seq/generation 重试语义等)
 * 由应用层执行,数据库层只落实 data-model 明示的列域 CHECK,禁止触发器。
 */

/** 设置访问授予(§3):联合主键 (household_id, device_session_id),每设备会话一行 */
export const settingsAccessGrant = sqliteTable(
  'settings_access_grant',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    deviceSessionId: text('device_session_id').notNull(),
    // 必须等于当前主 Profile(应用层守卫)
    profileId: text('profile_id').notNull(),
    // 创建时的设备会话身份版本
    profileContextVersion: integer('profile_context_version').notNull(),
    // 创建时当前主档案 PIN 版本
    pinVersion: integer('pin_version').notNull(),
    // 创建时家庭主档案版本
    mainProfileVersion: integer('main_profile_version').notNull(),
    issuedAt: text('issued_at').notNull(),
    // expires_at = issued_at + 15 分钟,固定不滑动(应用层保证)
    expiresAt: text('expires_at').notNull(),
    // nullable;失效后不再恢复
    revokedAt: text('revoked_at'),
  },
  (t) => [
    primaryKey({ name: 'settings_access_grant_pk', columns: [t.householdId, t.deviceSessionId] }),
    check('settings_access_grant_context_version_check', sql`${t.profileContextVersion} >= 1`),
    check('settings_access_grant_pin_version_check', sql`${t.pinVersion} >= 1`),
    check('settings_access_grant_main_profile_version_check', sql`${t.mainProfileVersion} >= 1`),
    // 正区间守护(与 playback_ticket_expiry_check 同规则)
    check('settings_access_grant_expiry_check', sql`${t.expiresAt} > ${t.issuedAt}`),
    foreignKey({
      name: 'settings_access_grant_session_composite_fk',
      columns: [t.householdId, t.deviceSessionId],
      foreignColumns: [deviceSession.householdId, deviceSession.id],
    }),
    foreignKey({
      name: 'settings_access_grant_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
  ],
);

/** 频道收藏(§4):三元联合主键;媒体必须为 channel、添加时可用(应用事务语义) */
export const profileChannelFavorite = sqliteTable(
  'profile_channel_favorite',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    profileId: text('profile_id').notNull(),
    mediaId: text('media_id').notNull(),
    // 首次收藏固定,重复 PUT 不更新;取消后重新收藏为新时间(应用层语义)
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'profile_channel_favorite_pk',
      columns: [t.householdId, t.profileId, t.mediaId],
    }),
    // 键集分页:(created_at DESC, media_id DESC),前导 (household_id, profile_id) 圈定个人范围
    index('profile_channel_favorite_profile_listed_key').on(
      t.householdId,
      t.profileId,
      desc(t.createdAt),
      desc(t.mediaId),
    ),
    foreignKey({
      name: 'profile_channel_favorite_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
    foreignKey({
      name: 'profile_channel_favorite_media_composite_fk',
      columns: [t.householdId, t.mediaId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
  ],
);

/** 点播写入权时钟(§5):每次点播 resolve 接受时短事务分配 epoch 并递增;直播不分配 */
export const profileProgressClock = sqliteTable(
  'profile_progress_clock',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    profileId: text('profile_id').notNull(),
    // 可跳号,不可重置,不接受客户端指定(应用层语义)
    nextEpoch: integer('next_epoch').notNull(),
  },
  (t) => [
    primaryKey({ name: 'profile_progress_clock_pk', columns: [t.householdId, t.profileId] }),
    check('profile_progress_clock_next_epoch_check', sql`${t.nextEpoch} >= 1`),
    foreignKey({
      name: 'profile_progress_clock_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
  ],
);

/** 活动播放进度状态(§6):联合主键随临时 session 清理;样本状态转换由应用事务执行 */
export const playbackProgressState = sqliteTable(
  'playback_progress_state',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    playbackSessionId: text('playback_session_id').notNull(),
    // 来自可信 playback 绑定,不接受 body 身份声明(应用层)
    profileId: text('profile_id').notNull(),
    mediaId: text('media_id').notNull(),
    // clock 分配值(>0)
    candidateEpoch: integer('candidate_epoch').notNull(),
    // resolve/可信输入快照的内容修订
    contentRevision: integer('content_revision').notNull(),
    // resolve 时身份上下文版本,与 playback_session 和当前 DeviceSession 一致
    profileContextVersion: integer('profile_context_version').notNull(),
    // 首次有效客户端 playing 上报后 true
    started: integer('started').notNull().default(0),
    // 会话生命周期内单调序号,换轨/seek/重渲染不重置;初始 0
    lastSampleSeq: integer('last_sample_seq').notNull().default(0),
    // 最后一个已接受样本的规范化摘要
    lastSampleDigest: text('last_sample_digest'),
    // 最后接受的 playback generation
    lastGeneration: integer('last_generation').notNull(),
    // 最后样本 applied/reason/revision,供相同序号重试稳定返回(应用层编码)
    lastResult: text('last_result'),
  },
  (t) => [
    primaryKey({
      name: 'playback_progress_state_pk',
      columns: [t.householdId, t.playbackSessionId],
    }),
    check('playback_progress_state_candidate_epoch_check', sql`${t.candidateEpoch} >= 1`),
    check('playback_progress_state_content_revision_check', sql`${t.contentRevision} >= 1`),
    check('playback_progress_state_context_version_check', sql`${t.profileContextVersion} >= 1`),
    check('playback_progress_state_started_check', sql`${t.started} IN (0, 1)`),
    check('playback_progress_state_last_sample_seq_check', sql`${t.lastSampleSeq} >= 0`),
    check('playback_progress_state_last_generation_check', sql`${t.lastGeneration} >= 1`),
    foreignKey({
      name: 'playback_progress_state_session_composite_fk',
      columns: [t.householdId, t.playbackSessionId],
      foreignColumns: [playbackSession.householdId, playbackSession.id],
    }),
    foreignKey({
      name: 'playback_progress_state_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
    foreignKey({
      name: 'playback_progress_state_media_composite_fk',
      columns: [t.householdId, t.mediaId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
  ],
);

/** 点播观看历史(§7):仅点播;writer_playback_session_id 为不透明 ID,不设 FK */
export const profileViewingHistory = sqliteTable(
  'profile_viewing_history',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => household.id),
    profileId: text('profile_id').notNull(),
    mediaId: text('media_id').notNull(),
    // 当前媒体历史写入权代次
    writerEpoch: integer('writer_epoch').notNull(),
    // 不透明 ID TEXT,无强引用临时 session 的 FK,避免审计清理影响历史
    writerPlaybackSessionId: text('writer_playback_session_id').notNull(),
    // 当前 owner 已接受序号
    lastSampleSeq: integer('last_sample_seq').notNull(),
    // 该位置对应的内容修订
    contentRevision: integer('content_revision').notNull(),
    // 影片逻辑时间秒(REAL;有限非负)
    positionSeconds: real('position_seconds').notNull(),
    // nullable;已可信探测后为有限非负
    durationSeconds: real('duration_seconds'),
    // 服务端接受有效观看活动时间;客户端不能指定排序时间(应用层语义)
    lastViewedAt: text('last_viewed_at').notNull(),
    // 实际更新递增
    revision: integer('revision').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'profile_viewing_history_pk',
      columns: [t.householdId, t.profileId, t.mediaId],
    }),
    // 历史列表索引:(household_id, profile_id, last_viewed_at DESC, media_id DESC)
    index('profile_viewing_history_profile_recent_key').on(
      t.householdId,
      t.profileId,
      desc(t.lastViewedAt),
      desc(t.mediaId),
    ),
    check('profile_viewing_history_writer_epoch_check', sql`${t.writerEpoch} >= 1`),
    check('profile_viewing_history_last_sample_seq_check', sql`${t.lastSampleSeq} >= 0`),
    check('profile_viewing_history_content_revision_check', sql`${t.contentRevision} >= 1`),
    check('profile_viewing_history_position_check', sql`${t.positionSeconds} >= 0`),
    check(
      'profile_viewing_history_duration_check',
      sql`${t.durationSeconds} IS NULL OR ${t.durationSeconds} >= 0`,
    ),
    // 位置不超过可信时长
    check(
      'profile_viewing_history_position_duration_check',
      sql`${t.durationSeconds} IS NULL OR ${t.positionSeconds} <= ${t.durationSeconds}`,
    ),
    check('profile_viewing_history_revision_check', sql`${t.revision} >= 1`),
    foreignKey({
      name: 'profile_viewing_history_profile_composite_fk',
      columns: [t.householdId, t.profileId],
      foreignColumns: [profile.householdId, profile.id],
    }),
    foreignKey({
      name: 'profile_viewing_history_media_composite_fk',
      columns: [t.householdId, t.mediaId],
      foreignColumns: [mediaItem.householdId, mediaItem.id],
    }),
  ],
);

/**
 * programme 补索引确认(data-model §8:(household_id, source_id, xmltv_channel_id,
 * starts_at, ends_at)):0003 的唯一索引 epg_programme_slot_key 恰以同五列声明,
 * EPG 窗口查询已完整覆盖(唯一约束必然携带等价索引),不重复创建同列索引;
 * 核验结论同步记录在 0006 up.sql 注释。
 */

/** 数据代际 2 查询层类型(读取) */
export type SettingsAccessGrant = typeof settingsAccessGrant.$inferSelect;
export type ProfileChannelFavorite = typeof profileChannelFavorite.$inferSelect;
export type ProfileProgressClock = typeof profileProgressClock.$inferSelect;
export type PlaybackProgressState = typeof playbackProgressState.$inferSelect;
export type ProfileViewingHistory = typeof profileViewingHistory.$inferSelect;

/** 数据代际 2 写入新行时的必填类型 */
export type NewSettingsAccessGrant = typeof settingsAccessGrant.$inferInsert;
export type NewProfileChannelFavorite = typeof profileChannelFavorite.$inferInsert;
export type NewProfileProgressClock = typeof profileProgressClock.$inferInsert;
export type NewPlaybackProgressState = typeof playbackProgressState.$inferInsert;
export type NewProfileViewingHistory = typeof profileViewingHistory.$inferInsert;
