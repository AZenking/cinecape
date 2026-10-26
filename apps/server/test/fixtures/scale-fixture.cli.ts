import fs from 'node:fs';
import { createScaleFixtureDatabase, SCALE_FIXTURE_FIXED_NOW_MS } from './scale-fixture';

/**
 * 规模夹具 CLI(005 T012):迁移 + 种子一步到独立 SQLite 临时库,打印行数统计。
 * 供 Playwright e2e 等外部流程预生成库后以 DATA_DIR 启动服务消费。
 *
 * 用法(以 apps/server 为工作目录):
 *   pnpm --filter @hmp/server exec tsx test/fixtures/scale-fixture.cli.ts \
 *     [--dir <输出目录,缺省 mktemp>] [--db-filename <文件名,缺省 scale-fixture.hmp.db>] [--json]
 */

interface CliArgs {
  dir?: string;
  dbFilename?: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { json: false };
  const valueOf = (index: number, flag: string): string => {
    const value = argv[index];
    if (value === undefined) throw new Error(`${flag} 需要一个参数`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      args.dir = valueOf((i += 1), '--dir');
    } else if (arg === '--db-filename') {
      args.dbFilename = valueOf((i += 1), '--db-filename');
    } else if (arg === '--json') {
      args.json = true;
    } else {
      throw new Error(`未知参数:${arg ?? ''}(支持 --dir/--db-filename/--json)`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dir !== undefined && fs.existsSync(args.dir) && !fs.statSync(args.dir).isDirectory()) {
    throw new Error(`--dir 不是目录:${args.dir}`);
  }
  const library = await createScaleFixtureDatabase({ dir: args.dir, dbFilename: args.dbFilename });
  if (args.json) {
    console.log(JSON.stringify({ ...library, fixedNowMs: SCALE_FIXTURE_FIXED_NOW_MS }, null, 2));
    return;
  }
  const s = library.stats;
  const lines = [
    '== 005 规模夹具生成完成 ==',
    `库文件:      ${library.dbPath}`,
    `固定 nowMs:  ${SCALE_FIXTURE_FIXED_NOW_MS}`,
    `排期窗口:    ${s.facts.scheduleWindowStartUtc} ~ ${s.facts.scheduleWindowEndUtc} (UTC)`,
    `固定 now:    ${s.facts.fixedNowIso}(直播档 d${s.facts.liveSlot.dayIndex}/s${s.facts.liveSlot.slotIndex} ${s.facts.liveSlot.startsAtUtc}~${s.facts.liveSlot.endsAtUtc})`,
    '',
    '身份行:',
    `  household=${s.household}  account=${s.account}  profile=${s.profile}  device=${s.device}  device_session=${s.deviceSession}`,
    '目录与来源:',
    `  media_source=${s.mediaSource}(iptv×2 + epg×1 + nas×1)  source_refresh=${s.sourceRefresh}  catalog_state=${s.catalogState}`,
    `  media_item=${s.mediaItemChannel + s.mediaItemVod}(频道 ${s.mediaItemChannel} + 点播 ${s.mediaItemVod})`,
    `  source_entry=${s.sourceEntryIptvMain + s.sourceEntryIptvAlt + s.sourceEntryNas}(主源 ${s.sourceEntryIptvMain} + 备源 ${s.sourceEntryIptvAlt} + NAS ${s.sourceEntryNas})`,
    `  playback_source=${s.playbackSource}  profile_policy=${s.profilePolicy}`,
    'EPG:',
    `  epg_channel=${s.epgChannel}(无 EPG 频道 ${s.facts.channelsWithoutEpg})`,
    `  epg_programme=${s.epgProgrammeTotal}(栅格 ${s.epgProgrammeGrid} + 重叠/跨日样本 ${s.epgProgrammeExtra};目标 67200)`,
    '',
    '覆盖事实:',
    `  可用点播=${s.facts.vodAvailable}  失效点播=${s.facts.vodUnavailable}  孤立点播=${s.facts.vodOrphan}  不可用频道=${s.facts.unavailableChannels}`,
    `  跨日节目=${s.facts.crossDayProgrammes}(每天一条)  直播重叠样本=${s.facts.liveOverlapProgrammes}(每天一条)`,
    `  代际2列写入: profile.is_main=${s.generation2Columns.profileIsMain}  source_entry.group_title=${s.generation2Columns.sourceEntryGroupTitle}  media_item.content_revision=${s.generation2Columns.mediaItemContentRevision}`,
    '',
    '消费方式:',
    `  DATA_DIR='${library.dataDir}' DB_FILENAME='${library.dbFilename}' 启动服务;`,
    '  明文凭据与固定时钟常量见 test/fixtures/scale-fixture.ts(SCALE_FIXTURE_CREDENTIALS / SCALE_FIXTURE_FIXED_NOW_MS)。',
  ];
  console.log(lines.join('\n'));
}

main().catch((error: unknown) => {
  console.error('[scale-fixture.cli] 生成失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
