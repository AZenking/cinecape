#!/usr/bin/env node
// 播放样本生成器(T032,spec 004)—— 可复现自制媒体/受控 HLS 夹具,不做任何网络下载:
// - 矩阵单一事实源 = 同目录 manifest.json(样本 id/文件名/交付路径标签/ffmpeg 参数/预期
//   ffprobe 形态);本脚本是纯执行引擎,读取 manifest 逐样本 lavfi 合成并复核;
// - 全部样本短时长(2~3 秒)、小分辨率(128×96,4K 样本除外)、真实编码参数(libx264/
//   libx265/mpeg4 + aac/ac3/eac3/dca);产物只写 outDir(默认 os.tmpdir 随机子目录),
//   绝不落入仓库;
// - hash 策略:lavfi+固定参数在同版本 ffmpeg 下字节确定,跨 ffmpeg 版本不保证 hash 相等
//   (manifest.json 记录「参数确定性 + 预期 probe 形态」;逐样本 bytes/sha256 落在生成时
//   写入 outDir 的 manifest.instance.json,不入库);
// - 幂等:fingerprint(manifest 生成参数)一致且文件 sha256 一致 → 跳过;文件存在但 hash
//   不同(ffmpeg 版本差异)→ 回退 ffprobe 形态比对,形态一致同样跳过;
// - 生成后自动复核(可用 --no-verify 关闭):ffprobe 逐样本比对 manifest 预期;非法/损坏
//   样本预期为 probe 失败;HLS 校验 master/media 清单结构与分片内容(mpegts+h264+aac)。
//
// 用法:
//   node generate-media.mjs                     # 默认 tmpdir 随机目录,生成+复核
//   node generate-media.mjs --out <目录>        # 指定输出目录(自动创建)
//   node generate-media.mjs --verify-only --out <目录>  # 只复核已生成样本
//   node generate-media.mjs --no-verify         # 只生成不复核
//
// 程序化调用(T033 runtime-smoke / T055 证据脚本):
//   import { generateAll } from '.../test/fixtures/playback/generate-media.mjs';
//   const { outDir, entries, verification } = generateAll({ outDir: someTmpDir });
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(SCRIPT_DIR, 'manifest.json');
/** 生成时实例清单(落 outDir,不入库):逐样本 bytes/sha256/ffprobe 摘要/ffmpeg 版本 */
const INSTANCE_MANIFEST_NAME = 'manifest.instance.json';
/** 引擎版本:变更生成/校验逻辑时 +1,使旧实例清单 fingerprint 失效触发重生成 */
const ENGINE_VERSION = 1;
const FIXED_FFMPEG_FLAGS = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error'];
const PROBE_ARGS = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];

/* ------------------------------------------------------------------ */
/* 基础工具(全部同步;spawnSync/流式 sha256)                              */
/* ------------------------------------------------------------------ */

function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim();
}

function toolVersion(tool) {
  const run = spawnSync(tool, ['-version'], { encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) {
    throw new Error(`本机需要可用的 ${tool}(已验证 ffmpeg/ffprobe 8.x):${String(run.stderr ?? run.error ?? '').trim()}`);
  }
  return firstLine(run.stdout);
}

function runFfmpeg(args, cwd) {
  const run = spawnSync('ffmpeg', [...FIXED_FFMPEG_FLAGS, ...args], { encoding: 'utf8', cwd });
  if (run.error !== undefined) {
    throw new Error(`ffmpeg 启动失败(本机需安装 ffmpeg):${String(run.error)}`);
  }
  if (run.status !== 0) {
    throw new Error(`ffmpeg 生成失败(exit ${String(run.status)}):ffmpeg ${args.join(' ')}\n${String(run.stderr ?? '').trim()}`);
  }
}

/** ffprobe JSON;probe 失败(损坏/伪装样本预期行为)返回 { ok:false, stderr } */
function ffprobeJson(filePath) {
  const run = spawnSync('ffprobe', [...PROBE_ARGS, filePath], { encoding: 'utf8' });
  if (run.error !== undefined) {
    throw new Error(`ffprobe 启动失败(本机需安装 ffprobe):${String(run.error)}`);
  }
  if (run.status !== 0) {
    return { ok: false, stderr: String(run.stderr ?? '').trim() };
  }
  try {
    return { ok: true, parsed: JSON.parse(String(run.stdout)) };
  } catch {
    return { ok: false, stderr: `ffprobe 输出非 JSON:${firstLine(run.stdout)}` };
  }
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asString(value) {
  return typeof value === 'string' ? value : null;
}

/** 与 media-probe.service.ts parseBitDepth 同义:bits_per_raw_sample ≥8 优先,否则像素格式后缀,否则 8 */
function probeBitDepth(videoStream) {
  const raw = asNumber(videoStream.bits_per_raw_sample);
  if (raw !== null && raw >= 8) {
    return Math.trunc(raw);
  }
  const pixFmt = asString(videoStream.pix_fmt) ?? '';
  const match = /(\d+)(?:le|be)?$/.exec(pixFmt);
  const fromSuffix = match !== null ? Number.parseInt(match[1], 10) : Number.NaN;
  if (Number.isFinite(fromSuffix) && fromSuffix >= 8) {
    return fromSuffix;
  }
  return 8;
}

/** 与 media-probe.service.ts isHdrStream 同义:transfer smpte2084/arib-std-b67 或 primaries bt2020 */
function probeIsHdr(videoStream) {
  const transfer = asString(videoStream.color_transfer);
  if (transfer === 'smpte2084' || transfer === 'arib-std-b67') {
    return true;
  }
  return asString(videoStream.color_primaries) === 'bt2020';
}

/** ffprobe JSON → 紧凑形态摘要(容器/时长/视频/音频) */
function probeSummary(parsed) {
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === 'video') ?? null;
  const audioStream = streams.find((stream) => stream.codec_type === 'audio') ?? null;
  return {
    formatName: asString(parsed.format?.format_name),
    durationSeconds: asNumber(parsed.format?.duration),
    video:
      videoStream === null
        ? null
        : {
            codec: asString(videoStream.codec_name),
            profile: asString(videoStream.profile),
            pixFmt: asString(videoStream.pix_fmt),
            bitDepth: probeBitDepth(videoStream),
            width: asNumber(videoStream.width),
            height: asNumber(videoStream.height),
            colorTransfer: asString(videoStream.color_transfer),
            colorPrimaries: asString(videoStream.color_primaries),
            hdr: probeIsHdr(videoStream),
          },
    audio:
      audioStream === null
        ? null
        : {
            codec: asString(audioStream.codec_name),
            profile: asString(audioStream.profile),
            channels: asNumber(audioStream.channels),
            sampleRate: asNumber(audioStream.sample_rate),
          },
  };
}

function probeFile(filePath) {
  const result = ffprobeJson(filePath);
  return result.ok ? { ok: true, summary: probeSummary(result.parsed) } : { ok: false, stderr: result.stderr };
}

function compactProbeLine(summary) {
  if (summary === null || summary === undefined || summary.ok === false) {
    return 'probe 失败(预期)';
  }
  const parts = [summary.formatName ?? '?'];
  if (summary.video !== null && summary.video !== undefined) {
    parts.push(
      `${summary.video.codec}(${summary.video.pixFmt},${String(summary.video.bitDepth)}bit,` +
        `${String(summary.video.width)}x${String(summary.video.height)}${summary.video.hdr ? ',HDR' : ''})`,
    );
  }
  parts.push(summary.audio !== null && summary.audio !== undefined ? `audio:${summary.audio.codec}` : '无音轨');
  parts.push(`dur=${(summary.durationSeconds ?? 0).toFixed(2)}s`);
  return parts.join(' + ');
}

/* ------------------------------------------------------------------ */
/* manifest 读取与轻量校验                                                */
/* ------------------------------------------------------------------ */

export function loadManifest() {
  const parsed = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.samples)) {
    throw new Error(`manifest.json 结构非法(缺少 samples 数组):${MANIFEST_PATH}`);
  }
  const ids = new Set();
  for (const sample of parsed.samples) {
    if (typeof sample?.id !== 'string' || typeof sample?.file !== 'string' || typeof sample?.kind !== 'string') {
      throw new Error('manifest.samples[].{id,file,kind} 必填');
    }
    if (ids.has(sample.id)) {
      throw new Error(`manifest.samples id 重复:${sample.id}`);
    }
    ids.add(sample.id);
    if (sample.kind === 'derived') {
      const from = sample.derive?.from;
      if (typeof from !== 'string' || !ids.has(from)) {
        throw new Error(`derived 样本 ${sample.id} 的 derive.from 必须指向先出现的样本 id,收到:${String(from)}`);
      }
    }
  }
  return parsed;
}

/** 生成输入指纹:引擎版本 + 样本完整生成声明(参数/派生/非法内容/HLS 参数) */
function fingerprintOf(sample, extra) {
  return createHash('sha256')
    .update(JSON.stringify({ engine: ENGINE_VERSION, sample, extra: extra ?? null }))
    .digest('hex');
}

function readPreviousInstance(outDir) {
  const instancePath = path.join(outDir, INSTANCE_MANIFEST_NAME);
  if (!fs.existsSync(instancePath)) {
    return { path: instancePath, byId: new Map() };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(instancePath, 'utf8'));
    const byId = new Map();
    for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
      if (typeof entry?.id === 'string') {
        byId.set(entry.id, entry);
      }
    }
    return { path: instancePath, byId };
  } catch {
    return { path: instancePath, byId: new Map() };
  }
}

/* ------------------------------------------------------------------ */
/* 样本生成(kind: media / illegal / derived / hls)                       */
/* ------------------------------------------------------------------ */

function generateMediaSample(sample, outPath) {
  runFfmpeg([...sample.args, outPath]);
}

function generateIllegalSample(sample, outPath) {
  if (typeof sample.content !== 'string' || sample.content.length === 0) {
    throw new Error(`非法样本 ${sample.id} 缺少 content 文本`);
  }
  fs.writeFileSync(outPath, Buffer.from(sample.content, 'utf8'));
}

function generateDerivedSample(sample, outPath, outDir, entriesById) {
  const parent = entriesById.get(sample.derive.from);
  if (parent === undefined || !fs.existsSync(path.join(outDir, parent.file))) {
    throw new Error(`派生样本 ${sample.id} 的父样本 ${sample.derive.from} 尚未生成`);
  }
  const parentBytes = fs.readFileSync(path.join(outDir, parent.file));
  const drop = asNumber(sample.derive.bytes);
  if (drop === null || drop <= 0 || drop >= parentBytes.length) {
    throw new Error(`派生样本 ${sample.id} 的 derive.bytes 非法:${String(sample.derive.bytes)}`);
  }
  fs.writeFileSync(outPath, parentBytes.subarray(drop));
}

function generateHlsSample(sample, hlsDir) {
  fs.rmSync(hlsDir, { recursive: true, force: true });
  fs.mkdirSync(hlsDir, { recursive: true });
  // cwd=hlsDir:分片相对路径写入播放清单 URI,清单/分片同目录,代理可直接作为上游
  runFfmpeg(sample.args, hlsDir);
}

function listHlsFiles(hlsDir) {
  return fs
    .readdirSync(hlsDir)
    .filter((name) => name !== INSTANCE_MANIFEST_NAME)
    .sort()
    .map((name) => {
      const filePath = path.join(hlsDir, name);
      const stats = fs.statSync(filePath);
      return { name, filePath, bytes: stats.size };
    });
}

/* ------------------------------------------------------------------ */
/* 复核(manifest 预期 vs ffprobe 实测)                                    */
/* ------------------------------------------------------------------ */

function checkOne(checks, name, pass, detail) {
  checks.push({ name, pass: pass === true, detail: detail ?? '' });
}

/** 校验单个 media/illegal/derived 样本;返回 checks 数组 */
function verifyFileSample(sample, outPath, expectFail) {
  const checks = [];
  const probed = probeFile(outPath);
  if (expectFail) {
    checkOne(checks, 'ffprobe 稳定失败(非法/损坏预期)', !probed.ok, probed.ok ? 'probe 意外成功' : (probed.stderr ?? '').slice(0, 120));
    return checks;
  }
  checkOne(checks, 'ffprobe 可解析', probed.ok, probed.ok ? 'ok' : (probed.stderr ?? '').slice(0, 120));
  if (!probed.ok) {
    return checks;
  }
  const summary = probed.summary;
  const container = summary.formatName ?? '';
  for (const token of sample.containerFormatNameIncludes ?? []) {
    checkOne(checks, `容器 format_name 含 ${token}`, container.split(',').includes(token), container);
  }
  const video = summary.video;
  if (sample.video === null || sample.video === undefined) {
    checkOne(checks, '无视频轨(预期)', video === null, video === null ? 'ok' : `实测 ${String(video?.codec)}`);
  } else {
    checkOne(checks, '视频 codec', video !== null && video.codec === sample.video.codec, `实测 ${String(video?.codec)}`);
    checkOne(checks, '视频 pix_fmt', video !== null && video.pixFmt === sample.video.pixFmt, `实测 ${String(video?.pixFmt)}`);
    checkOne(
      checks,
      '视频位深',
      video !== null && video.bitDepth === sample.video.bitDepth,
      `实测 ${String(video?.bitDepth)}bit`,
    );
    checkOne(
      checks,
      '分辨率',
      video !== null && video.width === sample.video.width && video.height === sample.video.height,
      `实测 ${String(video?.width)}x${String(video?.height)}`,
    );
  }
  if (sample.audio === null || sample.audio === undefined) {
    checkOne(checks, '无音轨(预期)', summary.audio === null, summary.audio === null ? 'ok' : `实测 ${String(summary.audio?.codec)}`);
  } else {
    checkOne(
      checks,
      '音频 codec',
      summary.audio !== null && summary.audio.codec === sample.audio.codec,
      `实测 ${String(summary.audio?.codec)}`,
    );
  }
  const range = sample.expect?.durationRange;
  const duration = summary.durationSeconds ?? -1;
  if (Array.isArray(range) && range.length === 2) {
    checkOne(checks, `时长 ∈ [${String(range[0])},${String(range[1])}]s`, duration >= range[0] && duration <= range[1], `实测 ${duration.toFixed(2)}s`);
  }
  if (typeof sample.expect?.colorTransfer === 'string') {
    checkOne(
      checks,
      `color_transfer=${sample.expect.colorTransfer}`,
      video !== null && video.colorTransfer === sample.expect.colorTransfer,
      `实测 ${String(video?.colorTransfer)}`,
    );
  }
  if (typeof sample.expect?.colorPrimaries === 'string') {
    checkOne(
      checks,
      `color_primaries=${sample.expect.colorPrimaries}`,
      video !== null && video.colorPrimaries === sample.expect.colorPrimaries,
      `实测 ${String(video?.colorPrimaries)}`,
    );
  }
  if (typeof sample.expect?.hdr === 'boolean') {
    checkOne(checks, `HDR 判定=${String(sample.expect.hdr)}`, video !== null && video.hdr === sample.expect.hdr, `实测 ${String(video?.hdr)}`);
  }
  return checks;
}

/** 校验 HLS 目录:master/media 清单结构 + 分片存在且各分片 mpegts+h264+aac */
function verifyHlsSample(sample, hlsDir) {
  const checks = [];
  const masterName = sample.expect?.masterPlaylist ?? 'master.m3u8';
  const mediaName = sample.expect?.mediaPlaylist ?? 'media.m3u8';
  const masterPath = path.join(hlsDir, masterName);
  const mediaPath = path.join(hlsDir, mediaName);
  const masterText = fs.existsSync(masterPath) ? fs.readFileSync(masterPath, 'utf8') : null;
  const mediaText = fs.existsSync(mediaPath) ? fs.readFileSync(mediaPath, 'utf8') : null;
  checkOne(checks, `存在 ${masterName}`, masterText !== null, masterPath);
  if (masterText !== null) {
    checkOne(checks, 'master 含 EXT-X-STREAM-INF 变体', masterText.includes('#EXT-X-STREAM-INF'), '');
    checkOne(checks, `master 引用 ${mediaName}`, masterText.includes(mediaName), masterText.trim().split('\n').pop() ?? '');
  }
  checkOne(checks, `存在 ${mediaName}`, mediaText !== null, mediaPath);
  let segmentNames = [];
  if (mediaText !== null) {
    checkOne(checks, 'media 为 VOD 完整清单(EXT-X-ENDLIST)', mediaText.includes('#EXT-X-ENDLIST'), '');
    if (sample.expect?.independentSegments === true) {
      checkOne(checks, 'media 含 EXT-X-INDEPENDENT-SEGMENTS(可 seek)', mediaText.includes('#EXT-X-INDEPENDENT-SEGMENTS'), '');
    }
    segmentNames = mediaText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    const range = sample.expect?.segmentCountRange ?? [2, 8];
    checkOne(
      checks,
      `分片数 ∈ [${String(range[0])},${String(range[1])}]`,
      segmentNames.length >= range[0] && segmentNames.length <= range[1],
      `实测 ${String(segmentNames.length)}`,
    );
    for (const name of segmentNames) {
      const segmentPath = path.join(hlsDir, name);
      const exists = fs.existsSync(segmentPath) && fs.statSync(segmentPath).size > 0;
      checkOne(checks, `分片 ${name} 存在且非空`, exists, segmentPath);
      if (!exists) {
        continue;
      }
      const probed = probeFile(segmentPath);
      checkOne(checks, `分片 ${name} 可 probe`, probed.ok, probed.ok ? 'ok' : (probed.stderr ?? '').slice(0, 120));
      if (!probed.ok) {
        continue;
      }
      checkOne(
        checks,
        `分片 ${name} 为 mpegts+h264+aac`,
        (probed.summary.formatName ?? '').includes('mpegts') &&
          probed.summary.video?.codec === (sample.video?.codec ?? 'h264') &&
          probed.summary.audio?.codec === (sample.audio?.codec ?? 'aac'),
        compactProbeLine(probed.summary),
      );
    }
  }
  return checks;
}

function sampleChecks(sample, outDir) {
  const expectFail = sample.expect?.probe === 'fail';
  const outPath = path.join(outDir, sample.file);
  if (sample.kind === 'hls') {
    return verifyHlsSample(sample, path.join(outDir, sample.dir ?? 'hls'));
  }
  if (!fs.existsSync(outPath)) {
    return [{ name: '文件存在', pass: false, detail: outPath }];
  }
  return verifyFileSample(sample, outPath, expectFail);
}

/** 复核全部样本(manifest 顺序);返回逐样本结果与汇总 */
export function verifyAll(outDir, manifest) {
  const rows = manifest.samples.map((sample) => {
    const checks = sampleChecks(sample, outDir);
    return { id: sample.id, pass: checks.every((check) => check.pass), checks };
  });
  return {
    rows,
    pass: rows.filter((row) => row.pass).length,
    fail: rows.filter((row) => !row.pass).length,
    totalChecks: rows.reduce((sum, row) => sum + row.checks.length, 0),
  };
}

/* ------------------------------------------------------------------ */
/* generateAll:生成(幂等)+ 复核 + 实例清单落盘                            */
/* ------------------------------------------------------------------ */

/**
 * 生成全部样本到 outDir(默认 os.tmpdir 随机子目录)并自动复核。
 * 同步返回;T033/T055 可直接 import 调用。
 */
export function generateAll(options = {}) {
  const manifest = options.manifest ?? loadManifest();
  const outDir = options.outDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'hmp-playback-media-'));
  fs.mkdirSync(outDir, { recursive: true });
  const hlsDirName = manifest.samples.find((sample) => sample.kind === 'hls')?.dir ?? 'hls';
  const hlsDir = path.join(outDir, hlsDirName);
  const ffmpegVersion = toolVersion('ffmpeg');
  const ffprobeVersion = toolVersion('ffprobe');
  const previous = readPreviousInstance(outDir);
  const entries = [];
  const entriesById = new Map();

  for (const sample of manifest.samples) {
    const isHls = sample.kind === 'hls';
    const outPath = isHls ? hlsDir : path.join(outDir, sample.file);
    // 派生样本指纹携带父样本当前 hash:父样本重生成 → 派生样本必然重生成
    let extra = null;
    if (sample.kind === 'derived') {
      const parentPath = path.join(outDir, entriesById.get(sample.derive.from)?.file ?? '');
      extra = { parentSha256: fs.existsSync(parentPath) ? sha256File(parentPath) : 'missing' };
    }
    const fingerprint = fingerprintOf(sample, extra);
    const previousEntry = previous.byId.get(sample.id);

    let entry = null;
    let reusable =
      previousEntry !== undefined && previousEntry.fingerprint === fingerprint;
    if (reusable && isHls) {
      const recorded = Array.isArray(previousEntry.files) ? previousEntry.files : [];
      reusable =
        fs.existsSync(path.join(hlsDir, sample.expect?.masterPlaylist ?? 'master.m3u8')) &&
        recorded.every((file) => {
          const filePath = path.join(hlsDir, file.name);
          return fs.existsSync(filePath) && sha256File(filePath) === file.sha256;
        });
    } else if (reusable && !isHls) {
      reusable = fs.existsSync(outPath) && sha256File(outPath) === previousEntry.sha256;
    }
    // 快路径失配(如 ffmpeg 版本变化导致 hash 不同)→ 回退 ffprobe 形态比对,一致仍跳过;
    // 派生样本除外:指纹含父样本 hash,父样本已重生成则派生内容必须同步重生成
    if (!reusable && sample.kind !== 'derived' && fs.existsSync(outPath)) {
      const checks = sampleChecks(sample, outDir);
      reusable = checks.length > 0 && checks.every((check) => check.pass);
    }

    let status = 'skipped';
    if (reusable) {
      entry = {
        ...(previousEntry ?? {}),
        id: sample.id,
        file: sample.file,
        kind: sample.kind,
        status,
        fingerprint,
      };
    } else {
      status = 'generated';
      if (isHls) {
        generateHlsSample(sample, hlsDir);
      } else if (sample.kind === 'illegal') {
        generateIllegalSample(sample, outPath);
      } else if (sample.kind === 'derived') {
        generateDerivedSample(sample, outPath, outDir, entriesById);
      } else {
        generateMediaSample(sample, outPath);
      }
      entry = { id: sample.id, file: sample.file, kind: sample.kind, status, fingerprint };
    }

    if (isHls) {
      const files = listHlsFiles(hlsDir);
      const segments = files.filter((file) => /\.ts$/.test(file.name));
      const firstSegmentProbe = segments.length > 0 ? probeFile(segments[0].filePath) : { ok: false, stderr: '无分片' };
      entry.files = files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: sha256File(file.filePath) }));
      entry.bytes = files.reduce((sum, file) => sum + file.bytes, 0);
      entry.segmentCount = segments.length;
      entry.segmentProbe = firstSegmentProbe.ok ? firstSegmentProbe.summary : null;
    } else {
      entry.bytes = fs.statSync(outPath).size;
      entry.sha256 = sha256File(outPath);
      const probed = probeFile(outPath);
      entry.probe = probed.ok ? probed.summary : { ok: false, stderr: probed.stderr };
    }
    entries.push(entry);
    entriesById.set(sample.id, entry);
  }

  const runVerification = options.verify !== false;
  const verification = runVerification
    ? verifyAll(outDir, manifest)
    : { rows: [], pass: 0, fail: 0, totalChecks: 0 };
  const instanceManifest = {
    schemaVersion: ENGINE_VERSION,
    generator: 'generate-media.mjs',
    sourceManifestSha256: sha256File(MANIFEST_PATH),
    ffmpegVersion,
    ffprobeVersion,
    outDir,
    generatedAt: new Date().toISOString(),
    entries,
    verification: { pass: verification.pass, fail: verification.fail, totalChecks: verification.totalChecks },
  };
  const instancePath = path.join(outDir, INSTANCE_MANIFEST_NAME);
  fs.writeFileSync(instancePath, `${JSON.stringify(instanceManifest, null, 2)}\n`);
  return { outDir, manifest, entries, verification, instancePath, ffmpegVersion };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                   */
/* ------------------------------------------------------------------ */

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function printUsage() {
  console.log(`用法: node generate-media.mjs [--out <目录>] [--verify-only] [--no-verify]
  --out <目录>     输出目录(默认 os.tmpdir 下随机子目录;不提交生成产物)
  --verify-only    只复核已生成样本(不生成;文件缺失记 FAIL)
  --no-verify      只生成不复核
  -h/--help        本说明
矩阵与预期形态: ${path.relative(process.cwd(), MANIFEST_PATH)}`);
}

function main() {
  const argv = process.argv.slice(2);
  let outDir = null;
  let verifyOnly = false;
  let verify = true;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--out') {
      index += 1;
      outDir = argv[index];
      if (outDir === undefined || outDir.length === 0) {
        console.error('错误: --out 需要目录参数');
        process.exitCode = 2;
        return;
      }
    } else if (flag === '--verify-only') {
      verifyOnly = true;
    } else if (flag === '--no-verify') {
      verify = false;
    } else if (flag === '-h' || flag === '--help') {
      printUsage();
      return;
    } else {
      console.error(`错误: 未知参数 ${flag}`);
      printUsage();
      process.exitCode = 2;
      return;
    }
  }

  const manifest = loadManifest();
  if (verifyOnly) {
    if (outDir === null) {
      console.error('错误: --verify-only 需配合 --out <目录> 指定已生成样本位置');
      process.exitCode = 2;
      return;
    }
    const verification = verifyAll(outDir, manifest);
    reportVerification(verification);
    process.exitCode = verification.fail === 0 ? 0 : 1;
    return;
  }

  const startedAtMs = Date.now();
  const result = generateAll({ outDir: outDir ?? undefined, manifest, verify });
  for (const entry of result.entries) {
    const probeText = entry.kind === 'hls'
      ? `HLS ${String(entry.segmentCount)} 分片 + 首片 ${compactProbeLine(entry.segmentProbe)}`
      : compactProbeLine(entry.probe ?? null);
    console.log(
      `[${entry.status === 'generated' ? '生成' : '跳过'}] ${String(entry.file).padEnd(34)} ` +
        `${formatKiB(entry.bytes ?? 0).padStart(10)} sha256:${String(entry.sha256 ?? '').slice(0, 12)} ${probeText}`,
    );
  }
  console.log(
    `生成目录: ${result.outDir}(ffmpeg: ${result.ffmpegVersion};耗时 ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s)`,
  );
  console.log(`实例清单(不入库): ${result.instancePath}`);
  if (verify) {
    reportVerification(result.verification);
    process.exitCode = result.verification.fail === 0 ? 0 : 1;
  }
}

function reportVerification(verification) {
  for (const row of verification.rows) {
    if (row.pass) {
      continue;
    }
    console.error(`[FAIL] ${row.id}`);
    for (const check of row.checks.filter((item) => !item.pass)) {
      console.error(`  - ${check.name}: ${check.detail}`);
    }
  }
  console.log(`复核: ${String(verification.pass)}/${String(verification.rows.length)} 样本通过(共 ${String(verification.totalChecks)} 项检查)`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}
