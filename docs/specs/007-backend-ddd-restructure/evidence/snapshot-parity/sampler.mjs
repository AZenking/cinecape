// T025-C behavior parity sampler — runs the identical request scenario against one tree.
// Usage: node sampler.mjs <baseUrl> <outJsonPath>
// Read-only w.r.t. both repos; writes only the outJsonPath. Each tree runs against its own
// fresh DATA_DIR initialized by its own migrations, so state evolution is identical.
import fs from 'node:fs';

const [, , base, outPath] = process.argv;
if (!base || !outPath) { console.error('usage: node sampler.mjs <baseUrl> <outJsonPath>'); process.exit(2); }

const BOGUS = '00000000-0000-4000-8000-00000000000a';
const PASSWORD = 'Parity-passw0rd!';
const PIN = '135790';
const USERNAME = 'parityqa';

const state = { token: null, mainId: null };
const results = [];

async function step(name, method, path, body, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.token && !opts.noAuth) headers.authorization = `Bearer ${state.token}`;
  let entry = { name, method, path, status: null, contentType: null, body: null, error: null };
  try {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    entry.status = res.status;
    entry.contentType = res.headers.get('content-type');
    const text = await res.text();
    try { entry.body = text === '' ? null : JSON.parse(text); } catch { entry.body = text; }
  } catch (e) {
    entry.error = String(e && e.message || e);
  }
  results.push(entry);

  // state capture (identical keys both trees)
  if (name === 'login-ok' && entry.status === 200 && entry.body?.sessionToken) state.token = entry.body.sessionToken;
  if (name === 'bootstrap' && entry.status === 201 && entry.body?.id) state.mainId = entry.body.id;
  return entry;
}

/* ---------- Phase PRE: anonymous/guest surface ---------- */
await step('status-pre', 'GET', '/setup/status');
await step('healthz', 'GET', '/healthz');
await step('public-context', 'GET', '/public/context');
await step('live-groups', 'GET', '/public/live/groups');
await step('live-channels', 'GET', '/public/live/channels');
await step('public-guide', 'GET', '/public/guide');
await step('public-media', 'GET', '/public/media');
await step('public-media-bogus', 'GET', `/public/media/${BOGUS}`);
await step('public-media-bogus-programmes', 'GET', `/public/media/${BOGUS}/programmes`);
await step('media-guest', 'GET', '/media', undefined, { noAuth: true });
await step('me-favorites-guest', 'GET', '/me/favorites/channels', undefined, { noAuth: true }); // N1 游客访问受保护路由
await step('me-history-guest', 'GET', '/me/history', undefined, { noAuth: true });
await step('resolve-anon', 'POST', '/playback/resolve', { mediaId: BOGUS }, { noAuth: true }); // N2 匿名播放解析
await step('playback-session-guest', 'GET', `/playback/sessions/${BOGUS}`, undefined, { noAuth: true });
await step('playback-renew-guest', 'POST', `/playback/sessions/${BOGUS}/renew`, {}, { noAuth: true });
await step('playback-stream-guest', 'GET', `/playback/stream/${BOGUS}/1/asset-x`, undefined, { noAuth: true });
await step('household-guest', 'GET', '/household', undefined, { noAuth: true });
await step('profiles-guest', 'GET', '/profiles', undefined, { noAuth: true });
await step('settings-access-guest', 'GET', '/settings/access', undefined, { noAuth: true });
await step('settings-profiles-guest', 'GET', '/settings/profiles', undefined, { noAuth: true });

/* ---------- negative: wrong password ---------- */
await step('login-wrong', 'POST', '/auth/login', { username: USERNAME, password: 'wrong-pass' });

/* ---------- init + auth ---------- */
await step('initialize', 'POST', '/setup/initialize', { householdName: 'Parity QA', username: USERNAME, password: PASSWORD });
await step('initialize-again-409', 'POST', '/setup/initialize', { householdName: 'Parity QA', username: USERNAME, password: PASSWORD });
await step('login-ok', 'POST', '/auth/login', { username: USERNAME, password: PASSWORD });
await step('session', 'GET', '/auth/session');
await step('household-auth', 'GET', '/household');
await step('bootstrap', 'POST', '/auth/bootstrap-profile', { name: 'Owner', pin: PIN, ownerPassword: PASSWORD });
await step('profiles-list', 'GET', '/profiles');
await step('profile-unlock', 'POST', `/profiles/${state.mainId}/unlock`, { pin: PIN });
await step('profile-select', 'POST', `/profiles/${state.mainId}/select`, {});
await step('profiles-list-after-select', 'GET', '/profiles');

/* ---------- N3 未解锁设置访问(session 有效、无设置授予) ---------- */
await step('settings-access-no-grant', 'GET', '/settings/access');
await step('settings-household-no-grant', 'GET', '/settings/household');
await step('settings-profiles-no-grant', 'GET', '/settings/profiles');
await step('settings-account-no-grant', 'GET', '/settings/account');
await step('settings-devices-no-grant', 'GET', '/settings/devices');
await step('settings-sources-no-grant', 'GET', '/settings/sources');
await step('settings-source-roots-no-grant', 'GET', '/settings/source-roots');
await step('settings-policy-no-grant', 'GET', `/settings/profiles/${state.mainId}/policy`);
await step('settings-candidates-no-grant', 'POST', '/settings/catalog/candidates/query', { ownerPassword: PASSWORD });
await step('settings-household-patch-no-grant', 'PATCH', '/settings/household', {});

/* ---------- grant then settings reads ---------- */
await step('settings-unlock', 'POST', '/settings/access', { pin: PIN });
await step('settings-access-granted', 'GET', '/settings/access');
await step('settings-household', 'GET', '/settings/household');
await step('settings-profiles', 'GET', '/settings/profiles');
await step('settings-account', 'GET', '/settings/account');
await step('settings-devices', 'GET', '/settings/devices');
await step('settings-sources', 'GET', '/settings/sources');
await step('settings-source-roots', 'GET', '/settings/source-roots');
await step('settings-refresh-bogus', 'GET', `/settings/refreshes/${BOGUS}`);
await step('settings-policy', 'GET', `/settings/profiles/${state.mainId}/policy`);
await step('settings-candidates-query', 'POST', '/settings/catalog/candidates/query', { ownerPassword: PASSWORD });
await step('settings-epg-binding-query', 'POST', `/settings/catalog/media/${BOGUS}/epg-binding/query`, { ownerPassword: PASSWORD });
await step('settings-epg-candidates-query', 'POST', `/settings/catalog/media/${BOGUS}/epg-candidates/query`, { ownerPassword: PASSWORD });
await step('settings-records-query', 'POST', `/settings/devices/${BOGUS}/playback-records/query`, { ownerPassword: PASSWORD });
await step('settings-device-revoke-bogus', 'POST', `/settings/devices/${BOGUS}/revoke`, {});

/* ---------- authenticated user surface ---------- */
await step('media-list', 'GET', '/media');
await step('media-bogus', 'GET', `/media/${BOGUS}`);
await step('media-bogus-programmes', 'GET', `/media/${BOGUS}/programmes`);
await step('me-favorites', 'GET', '/me/favorites/channels');
await step('me-history', 'GET', '/me/history');
await step('me-history-bogus', 'GET', `/me/history/${BOGUS}`);
await step('playback-session-bogus', 'GET', `/playback/sessions/${BOGUS}`);
await step('logout', 'POST', '/auth/logout', {});
await step('session-after-logout', 'GET', '/auth/session');

fs.writeFileSync(outPath, JSON.stringify({ base, sampledAt: new Date().toISOString(), steps: results }, null, 1));
const fails = results.filter((r) => r.error);
console.log(`steps=${results.length} networkErrors=${fails.length} -> ${outPath}`);
if (fails.length) fails.forEach((f) => console.log(`  ERR ${f.name}: ${f.error}`));
