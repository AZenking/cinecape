import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import { Database } from '@platform/database/database';
import { INITIALIZE_BODY, cleanupRigs, cookiePairOf, expectProblemContentType, login } from '../helpers';
import { startRoleRig, type RoleRig } from '../helpers-settings-013';

/**
 * T022(016-multi-source-live-epg · US4 契约 e2e,TDD 红):EPG 源优先级读写与越权负向矩阵,
 * 对照 docs/specs/016-multi-source-live-epg/contracts/api.md §3.1/§3.2 与 spec.md US4:
 * - GET /api/settings/sources/epg-priorities:主管理员 200,返回家庭内 kind='epg' 且启用的
 *   来源视图(EpgSourcePriority:sourceId/name/priority/channelCount/lastSyncAt|null),
 *   priority ASC 排序;channelCount = 该源 epg_channel 行数;停用源/IPTV 源/跨家庭源不入列表;
 *   no-store;remote_url 不出契约(脱敏);
 * - PUT /api/settings/sources/epg-priorities:zod strictObject {priorities:[{sourceId,priority}]}
 *   (priority 整数 1~999);逐条校验归属+kind(不存在/跨家庭/非 epg 一律 404 同形,不泄漏形态);
 *   单事务更新 priority + catalog_state.revision 原子递增(部分条目非法 → 整体回滚零写入);
 *   保存后经既有刷新执行器入队启用 EPG 源的全量刷新(016 §3.2「保存后后台自动触发一次
 *   全量级联匹配刷新」;关联裁决为投影读时计算,revision 递增即令新权重对读路径生效,
 *   刷新任务复用 sources 域既有管线重验指南窗口);返回 {success:true,updatedCount};
 * - ADR-0017:非主档案(普通成人/儿童)GET/PUT 一律 403 FORBIDDEN 同形(守卫先于入参校验,
 *   零业务副作用);匿名 401;非法 body 400 VALIDATION_FAILED(strictObject 不回显载荷)。
 *
 * TDD 红(照 manual-epg-binding.e2e-spec.ts T069 先例):端点未实现时 setup 探针统一失败
 * 并给出「T024 未实现」分类信息,T024 接线后本文件转绿。
 *
 * 夹具惯例(全部照既有契约先例,零新 helpers):
 * - startRoleRig(013 零 grant 主管理员 + 普通成员 + 儿童三会话)承担 403 负向编排;
 * - 目录种子经 Database.db 直改(无 HTTP 语义的工厂事实,manual-epg-binding seedCatalog
 *   同款;priority/last_success_at/catalog_state 基准由种子精确控制)。
 */

const API = '/api/settings/sources/epg-priorities';
const NOW_ISO = '2026-01-01T00:00:00.000Z';
const LAST_SYNC_A = '2026-01-01T08:00:00.000Z';

interface PrioritiesFixture {
  householdId: string;
  adminCookie: string;
  memberCookie?: string;
  childCookie?: string;
}

/** 目录种子:启用 EPG×2(priority 10/20;A 有 last_sync 与 2 频道,B 无同步 1 频道)+ 停用 EPG + IPTV + 邻居家 */
function seedEpgCatalog(householdId: string): void {
  const conn = Database.db;
  const insertSource = conn.prepare(
    'INSERT INTO media_source (id, household_id, kind, name, remote_url, root_key, relative_directory, private_access_approved, epg_source_id, enabled, version, last_success_at, last_job_id, epg_generation, locator_revision, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, 1, ?, NULL, 0, 1, ?, ?, ?)',
  );
  insertSource.run('src-epg-a', householdId, 'epg', '指南来源A', 'http://epg-seed.example/guide-a.xml', 1, LAST_SYNC_A, 10, NOW_ISO, NOW_ISO);
  insertSource.run('src-epg-b', householdId, 'epg', '指南来源B', 'http://epg-seed.example/guide-b.xml', 1, null, 20, NOW_ISO, NOW_ISO);
  // 停用 EPG(GET 不入列表;PUT 权重仍可配——归属+kind 校验,启停属来源管理语义)
  insertSource.run('src-epg-off', householdId, 'epg', '停用指南', 'http://epg-seed.example/off.xml', 0, null, 30, NOW_ISO, NOW_ISO);
  insertSource.run('src-iptv', householdId, 'iptv', '受控IPTV', 'http://iptv-seed.example/list.m3u8', 1, null, 40, NOW_ISO, NOW_ISO);

  const insertChannel = conn.prepare('INSERT INTO epg_channel (household_id, source_id, xmltv_channel_id, display_name, conflicted) VALUES (?, ?, ?, ?, ?)');
  insertChannel.run(householdId, 'src-epg-a', 'cctv-1', '央视一套', 0);
  insertChannel.run(householdId, 'src-epg-a', 'cctv-2', '央视二套', 0);
  insertChannel.run(householdId, 'src-epg-b', 'b-1', 'B套', 0);
  // 停用源的频道行不因源停用而消失(权重视图不展示该源,行数断言不依赖)
  insertChannel.run(householdId, 'src-epg-off', 'off-1', '停用源频道', 0);

  // 邻居家:跨家庭 404 同形断言用(不入列表)
  conn.prepare("INSERT INTO household (id, name, default_language, timezone, created_at) VALUES ('hh-foreign', '邻居家', 'zh-CN', 'Asia/Shanghai', ?)").run(NOW_ISO);
  insertSource.run('src-foreign-epg', 'hh-foreign', 'epg', '他家指南', 'http://foreign-seed.example/guide.xml', 1, null, 5, NOW_ISO, NOW_ISO);

  // 目录修订基准(原子 +1 断言的精确锚点;DB 直改注明:无 HTTP 语义的工厂事实)
  conn.prepare('INSERT INTO catalog_state (household_id, revision) VALUES (?, 7)').run(householdId);
}

function revisionOf(householdId: string): number {
  const row = Database.db.prepare('SELECT revision FROM catalog_state WHERE household_id = ?').get(householdId) as { revision: number } | undefined;
  expect(row, 'catalog_state 行应存在(种子基准)').toBeDefined();
  return (row as { revision: number }).revision;
}

function priorityOf(sourceId: string): number {
  return (Database.db.prepare('SELECT priority FROM media_source WHERE id = ?').get(sourceId) as { priority: number }).priority;
}

function refreshJobCount(householdId: string, sourceIds: string[]): number {
  const placeholders = sourceIds.map(() => '?').join(', ');
  return (Database.db
    .prepare(`SELECT COUNT(*) AS n FROM source_refresh WHERE household_id = ? AND source_id IN (${placeholders})`)
    .get(...[householdId, ...sourceIds]) as { n: number }).n;
}

function activeRefreshJobCount(): number {
  return (Database.db.prepare("SELECT COUNT(*) AS n FROM source_refresh WHERE status IN ('queued', 'running')").get() as { n: number }).n;
}

/**
 * 等待触发的刷新任务全部离开 queued/running(种子源默认无 LAN 许可 → 目标立即拒绝,
 * 任务秒级落 failed;上限 30s 仅为环境兜底)。保证 afterEach 清理不与后台执行器竞态。
 */
async function waitForRefreshQuiescence(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeRefreshJobCount() > 0) {
    if (Date.now() > deadline) {
      throw new Error(`触发的刷新任务未在 ${timeoutMs}ms 内脱离 queued/running`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 主管理员 rig:startRoleRig(013 零 grant)+ 种子 + T024 探针(未实现 → 统一红,注明分类) */
async function startPrioritiesRoleRig(prefix: string): Promise<RoleRig & PrioritiesFixture> {
  const rig = await startRoleRig(prefix);
  const household = await request(rig.app.getHttpServer()).get('/api/household').set('Cookie', rig.adminCookie);
  expect(household.status, JSON.stringify(household.body)).toBe(200);
  const householdId = (household.body as { id: string }).id;
  seedEpgCatalog(householdId);

  // TDD 红探针:端点未实现时全部用例在此统一失败(失败原因分类:端点未实现)
  const probe = await request(rig.app.getHttpServer()).get(API).set('Cookie', rig.adminCookie);
  if (probe.status !== 200) {
    await cleanupRigs();
    throw new Error(
      `T024 未实现:GET ${API} 返回 ${probe.status}(期望 200);` +
        '本契约文件按 T022 预期保持红,T024 接线后应转绿',
    );
  }
  return { ...rig, householdId };
}

/* ------------------------------------------------------------------ */
/* 请求包装                                                            */
/* ------------------------------------------------------------------ */

function getPriorities(app: RoleRig['app'], cookie: string): request.Test {
  return request(app.getHttpServer()).get(API).set('Cookie', cookie);
}

function putPriorities(app: RoleRig['app'], cookie: string, body: Record<string, unknown>): request.Test {
  return request(app.getHttpServer()).put(API).set('Cookie', cookie).send(body);
}

afterEach(async () => {
  await cleanupRigs();
});

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

describe('T022 EPG 源优先级读写契约(016 US4,ADR-0017 主管理员门禁)', () => {
  it('管理页可包含停用源并保存其排序，默认查询与家庭隔离保持不变', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-disabled-');
    const view = await request(s.app.getHttpServer()).get(`${API}?includeDisabled=true`).set('Cookie', s.adminCookie);
    expect(view.status).toBe(200);
    expect(view.body.sources.map((source: { sourceId: string }) => source.sourceId)).toEqual(['src-epg-a', 'src-epg-b', 'src-epg-off']);
    expect(view.body.sources[2]).toMatchObject({ sourceId: 'src-epg-off', priority: 30, channelCount: 1 });

    const saved = await putPriorities(s.app, s.adminCookie, {
      priorities: [{ sourceId: 'src-epg-off', priority: 1 }, { sourceId: 'src-epg-a', priority: 2 }, { sourceId: 'src-epg-b', priority: 3 }],
    });
    expect(saved.status).toBe(200);
    await waitForRefreshQuiescence();
    const reloaded = await request(s.app.getHttpServer()).get(`${API}?includeDisabled=true`).set('Cookie', s.adminCookie);
    expect(reloaded.body.sources.map((source: { sourceId: string }) => source.sourceId)).toEqual(['src-epg-off', 'src-epg-a', 'src-epg-b']);
    const defaultView = await getPriorities(s.app, s.adminCookie);
    expect(defaultView.body.sources.map((source: { sourceId: string }) => source.sourceId)).toEqual(['src-epg-a', 'src-epg-b']);
    const invalid = await request(s.app.getHttpServer()).get(`${API}?includeDisabled=invalid`).set('Cookie', s.adminCookie);
    expect(invalid.status).toBe(400);
    const forbidden = await request(s.app.getHttpServer()).get(`${API}?includeDisabled=true`).set('Cookie', s.memberCookie as string);
    expect(forbidden.status).toBe(403);
  });

  it('主管理员 GET:200 仅含启用 EPG 源,priority ASC 排序,channelCount=epg_channel 计数,lastSyncAt 映射(null 亦在场),remote_url 脱敏,no-store', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-get-');

    const res = await getPriorities(s.app, s.adminCookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['sources']);
    const sources = body.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);
    for (const item of sources) {
      expect(Object.keys(item).sort()).toEqual(['channelCount', 'lastSyncAt', 'name', 'priority', 'sourceId']);
    }
    expect(sources).toEqual([
      { sourceId: 'src-epg-a', name: '指南来源A', priority: 10, channelCount: 2, lastSyncAt: LAST_SYNC_A },
      { sourceId: 'src-epg-b', name: '指南来源B', priority: 20, channelCount: 1, lastSyncAt: null },
    ]);
    // 脱敏:停用源/IPTV 源/邻居家源不入列表;remote_url 不出契约
    expect(JSON.stringify(body)).not.toContain('epg-seed.example');
    expect(JSON.stringify(body)).not.toContain('guide.xml');
    expect(JSON.stringify(body)).not.toContain('iptv-seed.example');
    expect(JSON.stringify(body)).not.toContain('src-epg-off');
    expect(JSON.stringify(body)).not.toContain('src-foreign-epg');
  });

  it('主管理员 PUT:200 {success,updatedCount} → GET 复核生效;catalog revision 逐次原子 +1;media_source.version 不变(来源管理 CAS 不受扰)', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-put-');
    expect(revisionOf(s.householdId)).toBe(7);

    // 换权重:A 10→20,B 20→10(整体互换)
    const res = await putPriorities(s.app, s.adminCookie, {
      priorities: [
        { sourceId: 'src-epg-a', priority: 20 },
        { sourceId: 'src-epg-b', priority: 10 },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ success: true, updatedCount: 2 });

    // GET 复核:新权重生效,排序随动
    const seen = await getPriorities(s.app, s.adminCookie);
    expect(seen.status).toBe(200);
    expect((seen.body.sources as Array<Record<string, unknown>>).map((item) => [item.sourceId, item.priority])).toEqual([
      ['src-epg-b', 10],
      ['src-epg-a', 20],
    ]);
    // 库态:priority 落库;version 不动(PATCH expectedVersion CAS 语义不受本端点干扰)
    expect(priorityOf('src-epg-a')).toBe(20);
    expect(priorityOf('src-epg-b')).toBe(10);
    const versions = Database.db
      .prepare("SELECT id, version FROM media_source WHERE id IN ('src-epg-a', 'src-epg-b') ORDER BY id")
      .all() as Array<{ id: string; version: number }>;
    expect(versions).toEqual([
      { id: 'src-epg-a', version: 1 },
      { id: 'src-epg-b', version: 1 },
    ]);
    expect(revisionOf(s.householdId)).toBe(8);

    // 部分列表保存(未列出的源保持现值):契约未要求全量,批量语义最小化
    const partial = await putPriorities(s.app, s.adminCookie, { priorities: [{ sourceId: 'src-epg-b', priority: 5 }] });
    expect(partial.status).toBe(200);
    expect(partial.body).toEqual({ success: true, updatedCount: 1 });
    expect(priorityOf('src-epg-a')).toBe(20);
    expect(priorityOf('src-epg-b')).toBe(5);
    expect(revisionOf(s.householdId)).toBe(9);

    await waitForRefreshQuiescence();
  });

  it('保存触发全量级联匹配刷新:PUT 后既有刷新执行器已为启用 EPG 源入队(停用源不触发);目标默认拒绝 → 任务秒级终态,零网络', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-refresh-');
    expect(refreshJobCount(s.householdId, ['src-epg-a', 'src-epg-b', 'src-epg-off'])).toBe(0);

    const res = await putPriorities(s.app, s.adminCookie, {
      priorities: [{ sourceId: 'src-epg-a', priority: 15 }],
    });
    expect(res.status).toBe(200);

    // 入队为请求路径内的轻量 INSERT(导入本体由既有后台串行执行器异步承担)
    expect(refreshJobCount(s.householdId, ['src-epg-a', 'src-epg-b'])).toBe(2);
    // 停用源不触发(禁用源刷新为执行器 422 语义,不产生任务行)
    expect(refreshJobCount(s.householdId, ['src-epg-off'])).toBe(0);
    // IPTV 源不在级联触发范围(016 §3.2 全量指 EPG 源)
    expect(refreshJobCount(s.householdId, ['src-iptv'])).toBe(0);

    // 任务归属家庭与来源;随后全部脱离 queued/running(默认无 LAN 许可 → 秒级 failed)
    const jobs = Database.db
      .prepare('SELECT source_id, household_id, status FROM source_refresh WHERE household_id = ? ORDER BY source_id')
      .all(s.householdId) as Array<{ source_id: string; household_id: string; status: string }>;
    expect(jobs.map((job) => job.source_id).sort()).toEqual(['src-epg-a', 'src-epg-b']);
    for (const job of jobs) {
      expect(job.household_id).toBe(s.householdId);
    }
    await waitForRefreshQuiescence();
    const settled = Database.db
      .prepare('SELECT status FROM source_refresh WHERE household_id = ? ORDER BY source_id')
      .all(s.householdId) as Array<{ status: string }>;
    for (const job of settled) {
      expect(['queued', 'running']).not.toContain(job.status);
    }
  });

  it('ADR-0017 越权矩阵:普通成员/儿童 GET 与 PUT 均 403 FORBIDDEN 同形,零业务副作用;匿名 401 先行;主管理员对照 200', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-403-');

    const memberGet = await getPriorities(s.app, s.memberCookie as string);
    expect(memberGet.status).toBe(403);
    expectProblemContentType(memberGet);
    expect(memberGet.body.code).toBe(ProblemCode.FORBIDDEN);
    const memberPut = await putPriorities(s.app, s.memberCookie as string, {
      priorities: [{ sourceId: 'src-epg-a', priority: 1 }],
    });
    expect(memberPut.status).toBe(403);
    expectProblemContentType(memberPut);
    expect(memberPut.body.code).toBe(ProblemCode.FORBIDDEN);
    const childGet = await getPriorities(s.app, s.childCookie as string);
    expect(childGet.status).toBe(403);
    const childPut = await putPriorities(s.app, s.childCookie as string, {
      priorities: [{ sourceId: 'src-epg-a', priority: 1 }],
    });
    expect(childPut.status).toBe(403);

    // 同形:四个拒绝体逐字段一致(无差别拒绝,不泄露档案类型差异)
    expect(childGet.body).toEqual(memberGet.body);
    expect(childPut.body).toEqual(memberPut.body);
    expect(memberPut.body).toEqual(memberGet.body);

    // 零业务副作用:revision 不动、权重不动、零刷新任务(守卫先于入参校验与触发)
    expect(revisionOf(s.householdId)).toBe(7);
    expect(priorityOf('src-epg-a')).toBe(10);
    expect(refreshJobCount(s.householdId, ['src-epg-a', 'src-epg-b'])).toBe(0);

    // 匿名(SessionGuard 先行)401
    const anonymousGet = await getPriorities(s.app, '');
    expect(anonymousGet.status).toBe(401);
    expect(anonymousGet.body.code).toBe(ProblemCode.SESSION_INVALID);
    const anonymousPut = await putPriorities(s.app, '', { priorities: [] });
    expect(anonymousPut.status).toBe(401);

    // 主管理员零 grant 直达(013 正控对照)
    const adminOk = await getPriorities(s.app, s.adminCookie);
    expect(adminOk.status).toBe(200);
  });

  it('404 同形:不存在 / 跨家庭 / kind 非 epg 的 sourceId 一律 404 NOT_FOUND 同体;单事务原子性(混合非法 → 零写入)', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-404-');

    const missing = await putPriorities(s.app, s.adminCookie, { priorities: [{ sourceId: randomUUID(), priority: 10 }] });
    expect(missing.status).toBe(404);
    expectProblemContentType(missing);
    expect(missing.body.code).toBe(ProblemCode.NOT_FOUND);

    const cross = await putPriorities(s.app, s.adminCookie, { priorities: [{ sourceId: 'src-foreign-epg', priority: 10 }] });
    expect(cross.status).toBe(404);
    expect(cross.body).toEqual(missing.body);

    // kind=iptv:形态不泄漏,与不存在同形
    const wrongKind = await putPriorities(s.app, s.adminCookie, { priorities: [{ sourceId: 'src-iptv', priority: 10 }] });
    expect(wrongKind.status).toBe(404);
    expect(wrongKind.body).toEqual(missing.body);

    // 原子性:合法条目与非法条目混提 → 整体 404,合法条目零写入,revision 不动
    const mixed = await putPriorities(s.app, s.adminCookie, {
      priorities: [
        { sourceId: 'src-epg-a', priority: 50 },
        { sourceId: randomUUID(), priority: 10 },
      ],
    });
    expect(mixed.status).toBe(404);
    expect(mixed.body).toEqual(missing.body);
    expect(priorityOf('src-epg-a')).toBe(10);
    expect(revisionOf(s.householdId)).toBe(7);
    expect(refreshJobCount(s.householdId, ['src-epg-a', 'src-epg-b'])).toBe(0);
  });

  it('非法 body 一律 400 VALIDATION_FAILED:priority 越界/非整数、strictObject 未知字段、空/缺/非数组列表、重复 sourceId;载荷不回显;零副作用', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-400-');
    const invalidBodies: Array<Record<string, unknown>> = [
      { priorities: [{ sourceId: 'src-epg-a', priority: 0 }] },
      { priorities: [{ sourceId: 'src-epg-a', priority: 1000 }] },
      { priorities: [{ sourceId: 'src-epg-a', priority: 1.5 }] },
      { priorities: [{ sourceId: 'src-epg-a', priority: '10' }] },
      { priorities: [{ sourceId: '', priority: 10 }] },
      { priorities: [{ sourceId: 'src-epg-a', priority: 10 }, { sourceId: 'src-epg-a', priority: 20 }] },
      { priorities: [] },
      { priorities: 'nope' },
      {},
      { priorities: [{ sourceId: 'src-epg-a', priority: 10 }], unexpected: true },
      // strictObject:旧时代当次密码字段一律拒绝,且错误响应不回显载荷
      { priorities: [{ sourceId: 'src-epg-a', priority: 10 }], ownerPassword: 'topsecret-owner-pwd' },
    ];

    for (const body of invalidBodies) {
      const res = await putPriorities(s.app, s.adminCookie, body);
      expect(res.status, `非法 body 应 400: ${JSON.stringify(body)}`).toBe(400);
      expectProblemContentType(res);
      expect(res.body.code).toBe(ProblemCode.VALIDATION_FAILED);
    }

    // 载荷不回显(严格入参错误面)
    const passwordBody = invalidBodies[invalidBodies.length - 1] as Record<string, unknown>;
    expect(JSON.stringify(passwordBody)).toContain('topsecret-owner-pwd');
    const echoed = await putPriorities(s.app, s.adminCookie, passwordBody);
    expect(JSON.stringify(echoed.body)).not.toContain('topsecret-owner-pwd');

    // 零副作用
    expect(revisionOf(s.householdId)).toBe(7);
    expect(priorityOf('src-epg-a')).toBe(10);
    expect(refreshJobCount(s.householdId, ['src-epg-a', 'src-epg-b'])).toBe(0);
  });

  it('同端点 GET/PUT 的 zod 面对儿童/成员同样先过守卫:垃圾 body 也 403(不泄露 schema 信息)', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-403guard-');
    const garbage = await putPriorities(s.app, s.memberCookie as string, { totally: 'garbage' });
    expect(garbage.status, '守卫先于入参校验:垃圾 body 同样 403').toBe(403);
    expect(garbage.body.code).toBe(ProblemCode.FORBIDDEN);
    expect(revisionOf(s.householdId)).toBe(7);
  });

  it('同账号新会话未选档即 403:activeProfile 逐请求判定,零缓存零放行窗口', async () => {
    const s = await startPrioritiesRoleRig('hmp-epg-prio-live-');
    // 同账号新登录(未选档):SessionGuard 放行,SettingsGuard 按 activeProfileId 拒绝
    const freshLogin = await login(s.app, INITIALIZE_BODY.username, INITIALIZE_BODY.password);
    expect(freshLogin.status).toBe(200);
    const res = await putPriorities(s.app, cookiePairOf(freshLogin), {
      priorities: [{ sourceId: 'src-epg-a', priority: 99 }],
    });
    expect(res.status, '未选档会话即使同账号也 403(activeProfileId 判定)').toBe(403);
    expect(res.body.code).toBe(ProblemCode.FORBIDDEN);
    expect(revisionOf(s.householdId)).toBe(7);
  });
});
