import 'reflect-metadata';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ProblemCode } from '@hmp/shared';
import type { INestApplication } from '@nestjs/common';
import {
  PLAYBACK_FIXTURE_NOW,
  seedPlaybackSession,
  seedPlaybackWorld,
  type PlaybackWorld,
} from '../../fixtures/playback';
import { Database } from '../../../src/database/database';
import { setEnvOverride } from '../../../src/config/env';
import { loadEnv } from '../../../src/config/env.schema';
import { createPlaybackBudgets, type PlaybackBudgets } from '../../../src/config/playback-budgets';
import { getDb } from '../../../src/modules/auth/db';
import { account, device, deviceSession, profilePolicy } from '../../../src/database/schema';
import { DomainError } from '../../../src/common/domain-error';
import type { SessionContext } from '../../../src/common/current-session.decorator';
import { PlaybackRepository } from '../../../src/modules/playback/playback.repository';
import { PlaybackAuthorizationService } from '../../../src/modules/playback/playback-authorization.service';
import { NasReaderService } from '../../../src/modules/playback/nas-reader';
import type { PlaybackProbeFacts } from '../../../src/modules/playback/playback-resolver.service';
import type { PlaybackTrackFactsPort } from '../../../src/modules/playback/playback-selection.service';
import {
  escapeSubtitleTextLine,
  PlaybackSubtitlesService,
  subRipToWebVtt,
  type EmbeddedSubtitlePort,
  type SubtitleSourceLocator,
} from '../../../src/modules/playback/playback-subtitles.service';
import type { MediaRoots } from '../../../src/config/env.schema';

/**
 * 播放字幕服务单元测试(T030,spec 004;playback-subtitles.service.ts 的被测底层)。
 *
 * 权威依据(docs/specs/004-playback-resolver):
 * - tasks.md T030:内嵌 SubRip/WebVTT 与同 stem .srt/.vtt 旁车 ≤5MiB、只读根内无符号链接、
 *   SRT→VTT 文本安全显示;默认音轨/字幕关闭,允许合法音轨选择,无 ASS/图片/烧录,字幕逐请求授权;
 * - research.md R6:内嵌 SRT/SubRip/WebVTT 及影片同 stem 旁车,只读 ≤5MiB;最多 32 条音轨/字幕轨;
 *   SRT 转 WebVTT,文本仅作为字幕显示,禁 HTML 脚本;默认字幕关闭;
 * - budgets.subtitles:maxSidecarBytes 5MiB / maxTrackCount 32;
 * - contracts/api.md:字幕 text/vtt,只含文字,播放器不以 HTML 执行;媒体端点逐请求授权,
 *   asset 枚举不存在统一 404 同形。
 *
 * 文件 IO 经真实 NasReaderService(注入临时授权根)验证 root/符号链接/越界;
 * 旁车定位经 SubtitleSourceLocator 端口(测试 fake 返回 rootKey/relativePath 形态);
 * 内嵌提取经 EmbeddedSubtitlePort(测试 fake),SRT→VTT 转换另以导出纯函数直接断言。
 */

/** 注入 120s 票据 TTL 的预算(字幕预算 5MiB/32 与默认一致,断言取自 budgets 字段而非字面量) */
function budgetsForTest(): PlaybackBudgets {
  return createPlaybackBudgets(loadEnv({ NODE_ENV: 'test', PLAYBACK_TICKET_TTL_SECONDS: '120' }));
}

const VOD_FACTS: PlaybackProbeFacts = {
  durationSeconds: 5400,
  audioTracks: [{ id: 'aud-1', label: '普通话', language: 'zh', default: true }],
  subtitleTracks: [
    { id: 'sub-1', label: '简体中文', language: 'zh-CN' },
    { id: 'sub-2', label: 'English', language: 'en' },
  ],
};

const SAMPLE_SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Hello world',
  '',
  '2',
  '00:01:05,250 --> 00:01:07,000',
  '第二行字幕',
  '',
].join('\n');

/** 静态 fake 事实端口 */
class StaticFactsPort implements PlaybackTrackFactsPort {
  private readonly byKey = new Map<string, PlaybackProbeFacts>();

  seed(sessionId: string, generation: number, facts: PlaybackProbeFacts): void {
    this.byKey.set(`${sessionId}|${generation}`, facts);
  }

  factsFor(sessionId: string, generation: number): PlaybackProbeFacts | undefined {
    return this.byKey.get(`${sessionId}|${generation}`);
  }
}

/** fake 旁车定位器:返回会话选定源的 rootKey/relativePath 形态(与 playback_source 落库一致) */
class FixedLocator implements SubtitleSourceLocator {
  constructor(private readonly location: string | null) {}
  async locate(sessionId: string): Promise<{ readonly location: string } | null> {
    void sessionId;
    return this.location === null ? null : { location: this.location };
  }
}

/** fake 内嵌提取端口:trackId → 原始文本 + 声明格式 */
class FakeEmbeddedPort implements EmbeddedSubtitlePort {
  private readonly byTrack = new Map<string, { text: string; format: 'srt' | 'vtt' }>();

  seed(trackId: string, text: string, format: 'srt' | 'vtt'): void {
    this.byTrack.set(trackId, { text, format });
  }

  async extract(request: { location: string; trackId: string }): Promise<{ text: string; format: 'srt' | 'vtt' } | null> {
    void request.location;
    return this.byTrack.get(request.trackId) ?? null;
  }
}

interface SubtitlesRig {
  dataDir: string;
  rootDir: string;
  mediaDir: string;
  world: PlaybackWorld;
  budgets: PlaybackBudgets;
  context: SessionContext;
  facts: StaticFactsPort;
  embedded: FakeEmbeddedPort;
  service: PlaybackSubtitlesService;
  sessionId: string;
}

const rigs: SubtitlesRig[] = [];

function migrationSql(name: string): string {
  const migrationPath = path.join(process.cwd(), 'src/database/migrations', name, 'up.sql');
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`未找到迁移文件 ${migrationPath} —— 本测试须以 apps/server 为工作目录运行`);
  }
  return fs.readFileSync(migrationPath, 'utf8');
}

interface RigFileOptions {
  /** 额外文件(名字 → 内容字节;名字支持 'link:movie.srt' 形态创建符号链接,目标为 target 值) */
  readonly files?: Readonly<Record<string, string | Buffer>>;
}

/**
 * 构造字幕 rig:临时 DATA_DIR(DB)+ 临时授权根 subroot(rootDir)。
 * 默认种入 media/movie.mp4(占位媒体)并注册 (ready, generation=1) 会话 + VOD 事实。
 */
async function bootstrapSubtitlesRig(prefix: string, options: RigFileOptions = {}): Promise<SubtitlesRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const rootDir = path.join(dataDir, 'root');
  const mediaDir = path.join(rootDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, 'movie.mp4'), Buffer.from('fake-media-bytes'));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    if (name.startsWith('link:')) {
      const target = typeof content === 'string' ? content : name;
      fs.symlinkSync(path.resolve(mediaDir, target), path.join(mediaDir, name.slice('link:'.length)));
      continue;
    }
    fs.writeFileSync(path.join(mediaDir, name), content);
  }

  setEnvOverride(loadEnv({ NODE_ENV: 'test', DATA_DIR: dataDir, DB_FILENAME: `${randomUUID()}.hmp.db` }));
  Database.close();
  Database.db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)');
  for (const name of [
    '0001_init',
    '0002_profile_policy',
    '0003_media_catalog',
    '0004_manual_epg_binding',
    '0005_playback',
    '0006_pc_experience',
  ]) {
    Database.db.transaction(() => {
      Database.db.exec(migrationSql(name));
      Database.db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    })();
  }
  const fakeRig = { app: {} as INestApplication, dataDir, dbFilename: `${randomUUID()}.hmp.db` };
  const world = await seedPlaybackWorld(fakeRig, { nasEnabled: true });
  getDb()
    .insert(profilePolicy)
    .values({
      householdId: world.householdId,
      profileId: world.profileId,
      maxContentLevel: 18,
      allowUnrated: 1,
      allowedMediaIds: '[]',
      blockedMediaIds: '[]',
      allowedChannelIds: '[]',
      version: 1,
      updatedAt: PLAYBACK_FIXTURE_NOW,
    })
    .run();
  const budgets = budgetsForTest();
  const repo = new PlaybackRepository(Database.db, budgets);
  const authorization = new PlaybackAuthorizationService(repo);
  const session = getDb().select().from(deviceSession).where(eq(deviceSession.id, world.deviceSessionId)).get();
  if (session === undefined) {
    throw new Error('夹具错误:device_session 不存在');
  }
  const acc = getDb().select().from(account).where(eq(account.id, world.accountId)).get();
  if (acc === undefined) {
    throw new Error('夹具错误:account 不存在');
  }
  const context: SessionContext = {
    session: {
      id: session.id,
      householdId: session.householdId,
      accountId: session.accountId,
      deviceId: session.deviceId,
      activeProfileId: session.activeProfileId,
      expiresAt: session.expiresAt,
    },
    account: {
      id: acc.id,
      householdId: acc.householdId,
      username: acc.username,
      role: acc.role as SessionContext['account']['role'],
    },
  };

  const facts = new StaticFactsPort();
  const embedded = new FakeEmbeddedPort();
  const mediaRoots: MediaRoots = { subroot: rootDir };
  const service = new PlaybackSubtitlesService({
    authorization,
    facts,
    locator: new FixedLocator('subroot/media/movie.mp4'),
    nasReader: new NasReaderService({ mediaRoots }),
    mediaRoots,
    embedded,
    budgets,
  });

  const seeded = seedPlaybackSession(world, { state: 'ready', at: PLAYBACK_FIXTURE_NOW });
  facts.seed(seeded.sessionId, 1, VOD_FACTS);

  const rig: SubtitlesRig = {
    dataDir,
    rootDir,
    mediaDir,
    world,
    budgets,
    context,
    facts,
    embedded,
    service,
    sessionId: seeded.sessionId,
  };
  rigs.push(rig);
  return rig;
}

async function cleanupSubtitlesRigs(): Promise<void> {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig === undefined) {
      break;
    }
    Database.close();
    fs.rmSync(rig.dataDir, { recursive: true, force: true });
  }
}

/** 预期 DomainError:断言 status + 稳定码 */
async function expectDomainError(promise: Promise<unknown>, status: number, code: ProblemCode): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `预期 DomainError(${status} ${code})`).toBeInstanceOf(DomainError);
  const domain = thrown as DomainError;
  expect(domain.status, code).toBe(status);
  expect(domain.code, code).toBe(code);
}

afterEach(async () => {
  await cleanupSubtitlesRigs();
});

/* ------------------------------------------------------------------ */
/* 1. 旁车扫描(同 stem、.srt/.vtt、预算、符号链接、越根)                  */
/* ------------------------------------------------------------------ */

describe('T030 旁车扫描(listSubtitleTracks)', () => {
  it('同 stem .srt/.vtt 入列(文件名序确定 id),异 stem/非字幕扩展不入列;路径不泄漏', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-scan-', {
      files: {
        'movie.srt': SAMPLE_SRT,
        'movie.vtt': 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nvtt 旁车\n',
        'movie.eng.srt': SAMPLE_SRT, // 不同 stem:不入列
        'other.srt': SAMPLE_SRT, // 不同 stem:不入列
        'notes.txt': 'plain text', // 非字幕扩展:不入列
      },
    });

    const list = await t.service.listSubtitleTracks(t.sessionId, VOD_FACTS);

    const sidecars = list.filter((track) => track.origin === 'sidecar');
    expect(sidecars.map((track) => track.sidecarFilename)).toEqual(['movie.srt', 'movie.vtt']);
    expect(sidecars.map((track) => track.id)).toEqual(['sub-sidecar-1', 'sub-sidecar-2']);
    // 内嵌轨同列(origin=embedded)
    expect(list.filter((track) => track.origin === 'embedded').map((track) => track.id)).toEqual(['sub-1', 'sub-2']);
    // 全列表不泄漏绝对路径/授权根
    expect(JSON.stringify(list)).not.toContain(t.dataDir);
    expect(JSON.stringify(list)).not.toContain('subroot');
  });

  it('默认关闭语义:任何字幕轨不得标记 default:true(不自动开启,R6/FR-017)', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-def-', { files: { 'movie.srt': SAMPLE_SRT } });
    const list = await t.service.listSubtitleTracks(t.sessionId, VOD_FACTS);
    expect(list.length).toBeGreaterThan(0);
    for (const track of list) {
      expect(track.default, track.id).toBe(false);
    }
  });

  it('旁车 >5MiB(maxSidecarBytes)→ 不入列;其余旁车照常', async () => {
    const oversizedBytes = budgetsForTest().subtitles.maxSidecarBytes + 1;
    const t = await bootstrapSubtitlesRig('hmp-subs-big-', {
      files: {
        'movie.srt': SAMPLE_SRT,
        'movie.vtt': Buffer.alloc(oversizedBytes, 0x61),
      },
    });

    const list = await t.service.listSubtitleTracks(t.sessionId, VOD_FACTS);
    const names = list.filter((track) => track.origin === 'sidecar').map((track) => track.sidecarFilename);
    expect(names).toEqual(['movie.srt']);
  });

  it('旁车为符号链接(无论指向根外或根内)→ 不入列(只读根内无符号链接)', async () => {
    // (a) 根外目标
    const outside = await bootstrapSubtitlesRig('hmp-subs-link-out-', {
      files: { 'link:movie.srt': path.join('..', '..', 'outside.srt') },
    });
    fs.mkdirSync(path.join(outside.dataDir, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(outside.dataDir, 'outside', 'outside.srt'), SAMPLE_SRT);
    const outsideList = await outside.service.listSubtitleTracks(outside.sessionId, VOD_FACTS);
    expect(outsideList.filter((track) => track.origin === 'sidecar')).toHaveLength(0);

    // (b) 根内目标(仍是符号链接,一律拒绝)
    const inside = await bootstrapSubtitlesRig('hmp-subs-link-in-', {
      files: {
        'target.srt': SAMPLE_SRT,
        'link:movie.srt': 'target.srt',
      },
    });
    const insideList = await inside.service.listSubtitleTracks(inside.sessionId, VOD_FACTS);
    expect(insideList.filter((track) => track.origin === 'sidecar')).toHaveLength(0);
  });

  it('音轨+字幕合计超 maxTrackCount 时旁车让位(确定性丢弃,内嵌优先)', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-cap-', { files: { 'movie.srt': SAMPLE_SRT } });
    // 32 条内嵌字幕(达上限):旁车被丢弃,总数不超预算
    const many = [...Array(t.budgets.subtitles.maxTrackCount).keys()].map((i) => ({
      id: `sub-${i + 1}`,
      label: `轨${i + 1}`,
      language: null,
    }));
    const crowded: PlaybackProbeFacts = { durationSeconds: 5400, audioTracks: [], subtitleTracks: many };
    t.facts.seed(t.sessionId, 1, crowded);

    const list = await t.service.listSubtitleTracks(t.sessionId, crowded);
    expect(list.length).toBe(t.budgets.subtitles.maxTrackCount);
    expect(list.filter((track) => track.origin === 'sidecar')).toHaveLength(0);
  });

  it('源定位失败(null)→ 仅返回内嵌轨(旁车面静默为空,不抛错)', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-noloc-');
    const noLocator = new PlaybackSubtitlesService({
      authorization: new PlaybackAuthorizationService(new PlaybackRepository(Database.db, t.budgets)),
      facts: t.facts,
      locator: new FixedLocator(null),
      nasReader: new NasReaderService({ mediaRoots: { subroot: t.rootDir } }),
      mediaRoots: { subroot: t.rootDir },
      embedded: t.embedded,
      budgets: t.budgets,
    });
    const list = await noLocator.listSubtitleTracks(t.sessionId, VOD_FACTS);
    expect(list.map((track) => track.id)).toEqual(['sub-1', 'sub-2']);
  });
});

/* ------------------------------------------------------------------ */
/* 2. SRT→VTT 纯函数转换                                                 */
/* ------------------------------------------------------------------ */

describe('T030 subRipToWebVtt(时间格式/序号/文本)', () => {
  it('时间行 00:00:01,000 → 00:00:01.000;序号行去除;文本保留;WEBVTT 头', () => {
    const vtt = subRipToWebVtt(SAMPLE_SRT);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:03.500');
    expect(vtt).toContain('00:01:05.250 --> 00:01:07.000');
    expect(vtt).not.toContain('00:00:01,000');
    expect(vtt).not.toMatch(/^\d+\s*$/m); // 无独立序号行
    expect(vtt).toContain('Hello world');
    expect(vtt).toContain('第二行字幕');
  });

  it('小数毫秒与缺位毫秒兼容(,5 → .500;.5 → .500)', () => {
    const vtt = subRipToWebVtt(
      ['1', '00:00:01,5 --> 00:00:02.500', 'x'].join('\n'),
    );
    expect(vtt).toContain('00:00:01.500 --> 00:00:02.500');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 内容安全(逐行转义/控制字符/ASS 拒绝)                                */
/* ------------------------------------------------------------------ */

describe('T030 内容安全', () => {
  it('escapeSubtitleTextLine:转义 < > &,剥离控制字符(保留 \\t)', () => {
    expect(escapeSubtitleTextLine('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeSubtitleTextLine('A & B')).toBe('A &amp; B');
    expect(escapeSubtitleTextLine(`x\u0007y\u0000z\tw`)).toBe('xyz\tw');
  });

  it('含 <script> 的 SRT 文本:输出为纯文本转义形态,不含可执行标签', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-script-', {
      files: {
        'movie.srt': ['1', '00:00:01,000 --> 00:00:02,000', '<script>alert(1)</script>', ''].join('\n'),
      },
    });
    const content = await t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', t.context);
    expect(content.contentType).toBe('text/vtt');
    expect(/<script/i.test(content.vtt)).toBe(false);
    expect(content.vtt).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('ASS 家族([Script Info]/Dialogue:)→ 422 PLAYBACK_FORMAT_UNSUPPORTED(识别即拒绝,不返回内容)', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-ass-', {
      files: {
        'movie.vtt': ['[Script Info]', 'ScriptType: v4.00+', '', 'Dialogue: 0,0:00:01.00,0:00:02.00,x,,0,0,0,,hi'].join('\n'),
      },
    });
    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', t.context),
      422,
      ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED,
    );
  });

  it('内嵌轨同样过内容闸:fake 提取返回 ASS 文本 → 拒绝', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-ass-emb-', { files: {} });
    t.embedded.seed('sub-2', '[V4+ Styles]\nFormat: Name\n', 'srt');
    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-2', t.context),
      422,
      ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED,
    );
  });

  it('含 NUL 字节的旁车 → 拒绝(非纯文本)', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-nul-', {
      files: { 'movie.srt': Buffer.from([0x31, 0x00, 0x0a, 0x41]) }, // "1\0\nA"
    });
    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', t.context),
      422,
      ProblemCode.PLAYBACK_FORMAT_UNSUPPORTED,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. 旁车/内嵌内容加载(SRT 转换与 VTT 原样)                              */
/* ------------------------------------------------------------------ */

describe('T030 loadSubtitleContent(逐请求授权 + 文本交付)', () => {
  it('旁车 .srt:逐请求授权通过后返回 text/vtt,时间已转换、文本保留', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-load-srt-', { files: { 'movie.srt': SAMPLE_SRT } });

    const content = await t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', t.context);

    expect(content.contentType).toBe('text/vtt');
    expect(content.vtt.startsWith('WEBVTT')).toBe(true);
    expect(content.vtt).toContain('00:00:01.000 --> 00:00:03.500');
    expect(content.vtt).toContain('第二行字幕');
    expect(content.vtt).not.toContain('00:00:01,000');
  });

  it('旁车 .vtt:原样交付(时间已合法,不再转换),文本仍逐行转义', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-load-vtt-', {
      files: {
        'movie.vtt': ['WEBVTT', '', '00:00:09.000 --> 00:00:10.000', 'Plain & <b>bold</b>'].join('\n'),
      },
    });
    const content = await t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', t.context);
    expect(content.vtt).toContain('00:00:09.000 --> 00:00:10.000');
    expect(content.vtt).toContain('Plain &amp; &lt;b&gt;bold&lt;/b&gt;');
  });

  it('内嵌 SubRip(fake 提取端口):SRT 文本被转换为 VTT', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-emb-');
    t.embedded.seed('sub-1', SAMPLE_SRT, 'srt');

    const content = await t.service.loadSubtitleContent(t.sessionId, 1, 'sub-1', t.context);

    expect(content.contentType).toBe('text/vtt');
    expect(content.vtt).toContain('00:00:01.000 --> 00:00:03.500');
    expect(content.vtt).toContain('Hello world');
  });

  it('内嵌 WebVTT(fake 提取端口):不再二次转换,原样(转义后)交付', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-emb-vtt-');
    t.embedded.seed('sub-1', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n内嵌 vtt\n', 'vtt');

    const content = await t.service.loadSubtitleContent(t.sessionId, 1, 'sub-1', t.context);
    expect(content.vtt).toContain('内嵌 vtt');
    expect(content.vtt.match(/WEBVTT/g)).toHaveLength(1);
  });

  it('逐请求授权拒绝(策略收紧黑名单)→ 404 MEDIA_NOT_FOUND 且不返回字幕内容', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-authz-', { files: { 'movie.srt': SAMPLE_SRT } });
    // 基线:可加载
    const baseline = await t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', t.context);
    expect(baseline.vtt).toContain('Hello world');

    const { writePolicyLists } = await import('@contexts/policy/application/policy.service');
    writePolicyLists(t.world.householdId, t.world.profileId, { blockedMediaIds: [t.world.iptv.mediaId] });

    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', t.context),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('未知轨/旧代 generation → 与缺失同形 404 MEDIA_NOT_FOUND(不泄漏存在性)', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-404-', { files: { 'movie.srt': SAMPLE_SRT } });

    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-404', t.context),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 2, 'sub-1', t.context), // 事实按代失效
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-9', t.context),
      404,
      ProblemCode.MEDIA_NOT_FOUND,
    );
  });

  it('跨设备字幕请求 → 404 PLAYBACK_NOT_FOUND 同形;伪造会话 → 401;均不返回内容', async () => {
    const t = await bootstrapSubtitlesRig('hmp-subs-xdev-', { files: { 'movie.srt': SAMPLE_SRT } });
    // 同家庭第二台设备 + 真实有效设备会话(与 ticket.spec 跨设备用例同款)
    const deviceId2 = randomUUID();
    const sessionId2 = randomUUID();
    getDb()
      .insert(device)
      .values({ id: deviceId2, householdId: t.world.householdId, name: '卧室电视', type: 'tv', createdAt: PLAYBACK_FIXTURE_NOW })
      .run();
    getDb()
      .insert(deviceSession)
      .values({
        id: sessionId2,
        householdId: t.world.householdId,
        accountId: t.world.accountId,
        deviceId: deviceId2,
        tokenHash: `hash-${sessionId2}`,
        activeProfileId: t.world.profileId,
        expiresAt: '2027-01-01T00:00:00.000Z',
        revokedAt: null,
        lastActiveAt: PLAYBACK_FIXTURE_NOW,
        createdAt: PLAYBACK_FIXTURE_NOW,
      })
      .run();
    const acc = getDb().select().from(account).where(eq(account.id, t.world.accountId)).get();
    if (acc === undefined) {
      throw new Error('夹具错误:account 不存在');
    }
    const secondDeviceContext: SessionContext = {
      session: {
        id: sessionId2,
        householdId: t.world.householdId,
        accountId: t.world.accountId,
        deviceId: deviceId2,
        activeProfileId: t.world.profileId,
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      account: {
        id: acc.id,
        householdId: acc.householdId,
        username: acc.username,
        role: acc.role as SessionContext['account']['role'],
      },
    };
    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', secondDeviceContext),
      404,
      ProblemCode.PLAYBACK_NOT_FOUND,
    );
    // 设备会话行不存在:授权管线可信会话链先行 401 SESSION_INVALID
    const forged: SessionContext = {
      ...t.context,
      session: { ...t.context.session, id: randomUUID() },
    };
    await expectDomainError(
      t.service.loadSubtitleContent(t.sessionId, 1, 'sub-sidecar-1', forged),
      401,
      ProblemCode.SESSION_INVALID,
    );
  });
});
