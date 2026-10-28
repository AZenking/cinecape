import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '@platform/database/database';
import type { SessionContext } from '@platform/http-common/current-session.decorator';
import { bootstrapMainProfile } from '@contexts/identity-access/application/bootstrap.service';
import { unlockSelectionPin, selectActiveProfile } from '@contexts/profile/application/profile-selection.service';
import { restoreAccountSession } from '@contexts/identity-access/interface/account-session.dto';
import {
  INITIALIZE_BODY,
  cleanupRigs,
  initialize,
  login,
  startFreshApp,
} from '../helpers';

/**
 * T033(005 US2 单元测试,先 FAIL):device_session.profile_context_version 语义。
 * 权威:docs/specs/005-pc-browsing-flow/data-model.md §2 device_session:
 * 「实际 activeProfile 改变、清空或失效回落时递增;A→B→A 至少递增两次」+ §2 playback_session
 * (旧上下文活动播放终态化并撤票)。
 *
 * 负向设计:断言每一步的**精确版本值**且 A→B→A 后 activeProfileId 回到初始值 ——
 * 「仅比较最终 activeProfileId」的实现看不到任何变化,必然在此失败。
 */

const NOW = new Date().toISOString();

interface Rig {
  context(): SessionContext;
  sessionId: string;
  householdId: string;
  deviceId: string;
  mainProfileId: string;
}

async function bootSelectionRig(): Promise<Rig> {
  const { app } = await startFreshApp({ prefix: 'hmp-t033-ctx-' });
  const initialized = await initialize(app);
  expect(initialized.status).toBe(201);
  const loggedIn = await login(app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
  expect(loggedIn.status).toBe(200);
  const sessionId = (loggedIn.body as { sessionId: string }).sessionId;

  const summary = await bootstrapMainProfile(sessionContextOf(sessionId), {
    name: '妈妈',
    pin: '111111',
    ownerPassword: INITIALIZE_BODY.password,
  });

  // 直接夹具:第二个成人档案 P2(无 PIN,选档无需解锁)
  Database.db
    .prepare(
      `INSERT INTO profile (id, household_id, account_id, name, avatar, type, is_default, pin_hash, status,
        failed_pin_count, pin_locked_until, is_main, pin_version, version, created_at)
       VALUES ('p2', ?, (SELECT account_id FROM device_session WHERE id = ?), '爸爸', NULL, 'adult', 0, NULL, 'active', 0, NULL, 0, 1, 1, ?)`,
    )
    .run((sessionRowOf(sessionId) as { household_id: string }).household_id, sessionId, NOW);

  const sessionRow = sessionRowOf(sessionId) as {
    household_id: string;
    device_id: string;
    account_id: string;
  };
  // 夹具:一个可用频道媒体 + 绑定 (本会话, 主档案) 的活动播放(preparing)与未撤销票据
  Database.db
    .prepare(
      `INSERT INTO media_item (id, household_id, type, title, description, poster_ref, content_level,
        title_overridden, type_overridden, version, content_revision, created_at, updated_at)
       VALUES ('media-1', ?, 'channel', '新闻频道', NULL, NULL, NULL, 0, 0, 1, 1, ?, ?)`,
    )
    .run(sessionRow.household_id, NOW, NOW);
  Database.db
    .prepare(
      `INSERT INTO playback_session (id, household_id, device_session_id, device_id, profile_id, media_id,
        state, playback_source_id, delivery, generation, version, position_seconds, profile_context_version,
        created_at, last_heartbeat_at)
       VALUES ('pb-old', ?, ?, ?, ?, 'media-1', 'preparing', NULL, NULL, 1, 1, 0, 1, ?, ?)`,
    )
    .run(sessionRow.household_id, sessionId, sessionRow.device_id, summary.id, NOW, NOW);
  Database.db
    .prepare(
      `INSERT INTO playback_ticket (id, household_id, session_id, token_hash, issued_at, expires_at, generation, revoked_at)
       VALUES ('ticket-old', ?, 'pb-old', 'deadbeef-hash', ?, ?, 1, NULL)`,
    )
    .run(sessionRow.household_id, NOW, new Date(Date.now() + 60_000).toISOString());
  // 夹具:当前设备会话的一行有效设置授予(换档须同事务撤销)
  Database.db
    .prepare(
      `INSERT INTO settings_access_grant (household_id, device_session_id, profile_id, profile_context_version,
        pin_version, main_profile_version, issued_at, expires_at, revoked_at)
       VALUES (?, ?, ?, 1, 1, 1, ?, ?, NULL)`,
    )
    .run(sessionRow.household_id, sessionId, summary.id, NOW, new Date(Date.now() + 60_000).toISOString());

  return {
    sessionId,
    householdId: sessionRow.household_id,
    deviceId: sessionRow.device_id,
    mainProfileId: summary.id,
    context: () => sessionContextOf(sessionId),
  };
}

function sessionRowOf(sessionId: string): Record<string, unknown> {
  return Database.db.prepare('SELECT * FROM device_session WHERE id = ?').get(sessionId) as Record<string, unknown>;
}

function sessionContextOf(sessionId: string): SessionContext {
  const row = sessionRowOf(sessionId) as {
    id: string;
    household_id: string;
    account_id: string;
    device_id: string;
    active_profile_id: string | null;
    expires_at: string;
  };
  const accountRow = Database.db.prepare('SELECT * FROM account WHERE id = ?').get(row.account_id) as {
    id: string;
    household_id: string;
    username: string;
    role: string;
  };
  return {
    session: {
      id: row.id,
      householdId: row.household_id,
      accountId: row.account_id,
      deviceId: row.device_id,
      activeProfileId: row.active_profile_id,
      expiresAt: row.expires_at,
    },
    account: {
      id: accountRow.id,
      householdId: accountRow.household_id,
      username: accountRow.username,
      role: accountRow.role as 'owner' | 'admin',
    },
  };
}

function contextVersionOf(sessionId: string): number {
  return (sessionRowOf(sessionId) as { profile_context_version: number }).profile_context_version;
}

describe('T033 · device_session.profile_context_version(data-model §2)', () => {
  afterEach(async () => {
    await cleanupRigs();
    Database.close();
  });

  it('实际换档递增、同一有效档案重选不递增、A→B→A 至少递增两次;旧上下文播放终态化撤票、设置授予撤销', async () => {
    const rig = await bootSelectionRig();
    const p2 = 'p2';
    expect(contextVersionOf(rig.sessionId)).toBe(1);

    // 空档 → 主档案 M:实际换档 1→2;旧上下文(preparing, profile=M 本身无更旧播放)无回收目标
    expect((await unlockSelectionPin(rig.context(), rig.mainProfileId, '111111')).unlocked).toBe(true);
    const toMain = await selectActiveProfile(rig.context(), rig.mainProfileId);
    expect(toMain.activeProfile?.id).toBe(rig.mainProfileId);
    expect(contextVersionOf(rig.sessionId)).toBe(2);

    // M → P2:实际换档 2→3;同事务终态化 M 上下文活动播放 + 撤票 + 撤设置授予
    const toP2 = await selectActiveProfile(rig.context(), p2);
    expect(toP2.activeProfile?.id).toBe(p2);
    expect(contextVersionOf(rig.sessionId)).toBe(3);
    expect((sessionRowOf(rig.sessionId) as { active_profile_id: string | null }).active_profile_id).toBe(p2);

    const playbackRow = Database.db.prepare('SELECT * FROM playback_session WHERE id = ?').get('pb-old') as {
      state: string;
      ended_at: string | null;
    };
    expect(playbackRow.state).toBe('interrupted'); // 失权回收(非用户主动 stop)
    expect(playbackRow.ended_at).not.toBeNull();
    const ticketRow = Database.db.prepare('SELECT * FROM playback_ticket WHERE id = ?').get('ticket-old') as {
      revoked_at: string | null;
    };
    expect(ticketRow.revoked_at).not.toBeNull();

    const grantRow = Database.db
      .prepare('SELECT * FROM settings_access_grant WHERE device_session_id = ?')
      .get(rig.sessionId) as { revoked_at: string | null };
    expect(grantRow.revoked_at).not.toBeNull();

    // 同一有效档案重选(P2→P2):200 但不递增、不恢复任何授予
    const reSelect = await selectActiveProfile(rig.context(), p2);
    expect(reSelect.activeProfile?.id).toBe(p2);
    expect(contextVersionOf(rig.sessionId)).toBe(3);

    // P2 → M(A→B→A):实际换档 3→4 —— 最终 activeProfileId 回到 M,
    // 「仅比较最终 activeProfileId」的实现看不到变化,必然在本断言失败
    expect((await unlockSelectionPin(rig.context(), rig.mainProfileId, '111111')).unlocked).toBe(true);
    const backToMain = await selectActiveProfile(rig.context(), rig.mainProfileId);
    expect(backToMain.activeProfile?.id).toBe(rig.mainProfileId);
    expect(contextVersionOf(rig.sessionId)).toBe(4);
  });

  it('失效回落:当前档案停用后会话回落到无档案并递增 contextVersion(不再指向失效档案)', async () => {
    const rig = await bootSelectionRig();
    expect((await unlockSelectionPin(rig.context(), rig.mainProfileId, '111111')).unlocked).toBe(true);
    await selectActiveProfile(rig.context(), rig.mainProfileId);
    expect(contextVersionOf(rig.sessionId)).toBe(2);

    // 切到非主档案 P2(成人无 PIN)后停用之:主档案受 CHECK 保护不可停用,
    // 失效回落针对「当前选用档案」—— P2 为非主档案,可停用
    await selectActiveProfile(rig.context(), 'p2');
    expect(contextVersionOf(rig.sessionId)).toBe(3);
    Database.db.prepare('UPDATE profile SET status = ? WHERE id = ?').run('disabled', 'p2');

    const restored = restoreAccountSession(rig.context(), rig.context().session.expiresAt);

    expect(restored.activeProfile).toBeNull();
    const row = sessionRowOf(rig.sessionId) as { active_profile_id: string | null; profile_context_version: number };
    expect(row.active_profile_id).toBeNull();
    // 失效回落同样递增(3 → 4)
    expect(row.profile_context_version).toBe(4);
    expect(restored.bootstrapRequired).toBe(false); // 档案行仍存在,只是失效
  });
});
