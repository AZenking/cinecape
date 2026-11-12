import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const isDryRun = process.argv.includes('--dry-run');

const dbPath = path.resolve('data/hmp.db');
const uploadsDir = path.resolve('data/uploads/logos');
const repoLogoDir = '/tmp/tv-logos/tv-logos';

if (!fs.existsSync(repoLogoDir)) {
  console.error(`Repository directory not found: ${repoLogoDir}`);
  process.exit(1);
}

fs.mkdirSync(uploadsDir, { recursive: true });

const db = new Database(dbPath);

// 获取所有台标文件
function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of list) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(getFiles(full));
    } else if (item.name.endsWith('.png')) {
      results.push({ name: item.name, path: full, relPath: path.relative(repoLogoDir, full) });
    }
  }
  return results;
}

const logoFiles = getFiles(repoLogoDir);
console.log(`Found ${logoFiles.length} logo files in repo.`);

// 构建 logoMap
const logoMap = new Map();

for (const f of logoFiles) {
  // CCTV 1-17, 4K, 8K, 5+ 优先选 'CCTV 红白红黑/CCTV 红白/'
  if (f.relPath.startsWith('CCTV 红白红黑/CCTV 红白/')) {
    const base = f.name.replace('.png', '').toUpperCase(); // CCTV-1, CCTV-5P, etc.
    logoMap.set(base, f.path);
    logoMap.set(base.replace('-', ''), f.path);
    if (base === 'CCTV-5P') {
      logoMap.set('CCTV-5+', f.path);
      logoMap.set('CCTV5+', f.path);
    }
  } else if (f.relPath.startsWith('CCTV 风云频道 灰白渐变/')) {
    const base = f.name.replace('.png', '');
    logoMap.set(base, f.path);
    logoMap.set(base.replace('CCTV-', ''), f.path);
  } else if (!f.relPath.includes('/')) {
    const base = f.name.replace('.png', '');
    logoMap.set(base, f.path);
  }
}

// 补充 CCTV 红白目录下的作为备选
for (const f of logoFiles) {
  if (f.relPath.startsWith('CCTV 红白/')) {
    const base = f.name.replace('.png', '');
    if (!logoMap.has(base)) {
      logoMap.set(base, f.path);
    }
  }
}

// 别名规则映射
const aliasRules = [
  // 卫视
  { regex: /^(浙江卫视|Zhejiang Satellite TV)/i, key: '浙江卫视' },
  { regex: /^(江苏卫视|Jiangsu Satellite TV)/i, key: '江苏卫视' },
  { regex: /^(湖南卫视|Hunan Satellite TV|Hunan TV)/i, key: '湖南卫视' },
  { regex: /^(东方卫视|Dragon TV|Shanghai Satellite TV|Oriental Satellite TV)/i, key: '东方卫视' },
  { regex: /^(安徽卫视|Anhui Satellite TV|Anhui TV)/i, key: '安徽卫视' },
  { regex: /^(湖北卫视|Hubei Satellite TV|Hubei TV)/i, key: '湖北卫视' },

  // 港澳台
  { regex: /翡翠台|Jade/i, key: '翡翠台' },
  { regex: /明珠台|Pearl/i, key: '明珠台' },
  { regex: /無綫新聞台|无线新闻台|TVB News/i, key: '無綫新聞台' },
  { regex: /香港衛視|香港卫视/i, key: '香港衛視' },
  { regex: /鳳凰衛視中文台|凤凰卫视中文台|Phoenix Chinese/i, key: '鳳凰衛視中文台' },
  { regex: /鳳凰衛視資訊台|凤凰卫视资讯台|Phoenix InfoNews/i, key: '鳳凰衛視資訊台' },
  { regex: /鳳凰衛視香港台|凤凰卫视香港台|Phoenix Hong Kong/i, key: '鳳凰衛視香港台' },
  { regex: /中天綜合台|中天综合台/i, key: '中天綜合台' },
  { regex: /东森电影|東森電影/i, key: '东森电影' },
  { regex: /东森戏剧|東森戲劇/i, key: '东森戏剧' },
  { regex: /八大第一台/i, key: '八大第一台' },
  { regex: /纬来体育|緯來體育/i, key: '纬来体育' },
  { regex: /智林體育台|智林体育台/i, key: '智林體育台' },
  { regex: /有線新聞台|有线新闻台/i, key: '有線新聞台' },
  { regex: /HOY\s*TV/i, key: 'HOY TV' },
  { regex: /HOY\s*(资讯台|資訊台)/i, key: 'HOY 资讯台' },

  // CHC
  { regex: /CHC\s*(高清电影|HD|影迷电影)/i, key: 'CHC 高清电影' },
  { regex: /CHC\s*(动作电影|Action)/i, key: 'CHC 动作电影' },
  { regex: /CHC\s*(家庭影院|Home Theater)/i, key: 'CHC 家庭影院' },

  // 求索与特色
  { regex: /求索纪录/i, key: '求索纪录' },
  { regex: /求索生活/i, key: '求索生活' },
  { regex: /求索科学/i, key: '求索科学' },
  { regex: /求索动物/i, key: '求索动物' },
  { regex: /华数/i, key: '华数' },
  { regex: /咪咕/i, key: '咪咕' },

  // 国际与特色
  { regex: /CGTN/i, key: 'CGTN' },
  { regex: /CNN/i, key: 'CNN' },
  { regex: /CNBC/i, key: 'CNBC' },
  { regex: /CNA/i, key: 'CNA' },
  { regex: /ABC NEWS/i, key: 'ABC NEWS' },
  { regex: /BBC TWO/i, key: 'BBC TWO' },
  { regex: /NHK WORLD JAPAN/i, key: 'NHK WORLD JAPAN' },
  { regex: /NHK BS1/i, key: 'NHK BS1' },
  { regex: /NHK G/i, key: 'NHK G' },
  { regex: /KBS WORLD/i, key: 'KBS WORLD' },
  { regex: /FOX SPORTS 1/i, key: 'FOX SPORTS 1' },
  { regex: /FOX SPORTS 2/i, key: 'FOX SPORTS 2' },
  { regex: /LOVE NATURE 4K/i, key: 'LOVE NATURE 4K' },
  { regex: /LOVE NATURE/i, key: 'LOVE NATURE' },
  { regex: /DISNEY CHANNEL/i, key: 'ディズニーch DISNEY CHANNEL JAPAN' },

  // CCTV 专属定制/风云频道
  { regex: /CCTV-?(Weapon & Technology|兵器科技)/i, key: 'CCTV-兵器科技' },
  { regex: /CCTV-?(World Geography|世界地理)/i, key: 'CCTV-世界地理' },
  { regex: /CCTV-?(Storm Theater|风云剧场)/i, key: 'CCTV-风云剧场' },
  { regex: /CCTV-?(The First Theater|第一剧场)/i, key: 'CCTV-第一剧场' },
  { regex: /CCTV-?(Culture of Quality|央视文化精品)/i, key: 'CCTV-央视文化精品' },
  { regex: /CCTV-?(Billiards|央视台球)/i, key: 'CCTV-央视台球' },
  { regex: /CCTV-?(Storm Football|风云足球)/i, key: 'CCTV-风云足球' },
  { regex: /CCTV-?(Storm Music|风云音乐)/i, key: 'CCTV-风云音乐' },
  { regex: /CCTV-?(Women'?s Fashion|女性时尚)/i, key: 'CCTV-女性时尚' },
  { regex: /CCTV-?(Nostalgia Theater|怀旧剧场)/i, key: 'CCTV-怀旧剧场' },
  { regex: /CCTV-?(Discovery|发现之旅)/i, key: 'CCTV-发现之旅' },
  { regex: /CCTV-?(Health|卫生健康)/i, key: 'CCTV-卫生健康' },
  { regex: /CCTV-?(Old Stories|老故事)/i, key: 'CCTV-老故事' },
  { regex: /CCTV-?(Animation|新科动漫)/i, key: 'CCTV-新科动漫' },
  { regex: /CCTV-?(Guide|电视指南)/i, key: 'CCTV-电视指南' },
  { regex: /CCTV-?(Golf|高尔夫网球)/i, key: 'CCTV-高尔夫网球' }
];

function cleanTitle(raw) {
  let t = raw;
  const commaIdx = t.lastIndexOf(',');
  if (commaIdx !== -1 && t.includes('tvg-')) {
    t = t.slice(commaIdx + 1);
  }
  return t.replace(/\s*\(\d+p\)/gi, '')
          .replace(/\s*\[.*?\]/g, '')
          .trim();
}

function matchCctvNumber(title) {
  // 优先匹配 4K / 8K / 5+ / 5P
  const specialMatch = title.match(/CCTV-?\s*(4K|8K|5\+|5P)/i);
  if (specialMatch) {
    let tag = specialMatch[1].toUpperCase().replace('+', 'P');
    const key = `CCTV-${tag}`;
    if (logoMap.has(key)) return { logoPath: logoMap.get(key), key };
    if (logoMap.has(`CCTV${tag}`)) return { logoPath: logoMap.get(`CCTV${tag}`), key: `CCTV${tag}` };
  }

  // 再匹配 1-17 位数字
  const m = title.match(/CCTV-?\s*([0-9]{1,2})(?![0-9K])/i);
  if (m) {
    const num = m[1];
    const key = `CCTV-${num}`;
    if (logoMap.has(key)) return { logoPath: logoMap.get(key), key };
    if (logoMap.has(`CCTV${num}`)) return { logoPath: logoMap.get(`CCTV${num}`), key: `CCTV${num}` };
  }
  return null;
}

const householdRow = db.prepare('SELECT id FROM household LIMIT 1').get();
if (!householdRow) {
  console.error('No household found in database!');
  process.exit(1);
}
const householdId = householdRow.id;
console.log(`Target Household ID: ${householdId}`);

const channels = db.prepare("SELECT id, title, visible, poster_ref, version FROM media_item WHERE type = 'channel'").all();
console.log(`Loaded ${channels.length} channels from db.`);

const matchedItems = [];

for (const ch of channels) {
  const clean = cleanTitle(ch.title);
  let match = null;

  // 1. Alias rules
  for (const rule of aliasRules) {
    if (rule.regex.test(clean) || rule.regex.test(ch.title)) {
      if (logoMap.has(rule.key)) {
        match = { logoPath: logoMap.get(rule.key), key: rule.key };
        break;
      }
    }
  }

  // 2. CCTV numbers
  if (!match) {
    match = matchCctvNumber(clean) || matchCctvNumber(ch.title);
  }

  // 3. Direct match
  if (!match) {
    for (const [k, v] of logoMap.entries()) {
      if (clean === k || clean.toLowerCase() === k.toLowerCase()) {
        match = { logoPath: v, key: k };
        break;
      }
    }
  }

  if (match) {
    matchedItems.push({
      channelId: ch.id,
      title: ch.title,
      version: ch.version,
      clean,
      matchedKey: match.key,
      logoPath: match.logoPath,
      hasPoster: Boolean(ch.poster_ref),
      posterRef: ch.poster_ref,
      visible: ch.visible
    });
  }
}

console.log(`Matched ${matchedItems.length} channels.`);

if (isDryRun) {
  console.log('--- Dry Run Mode: No changes made ---');
  for (const item of matchedItems) {
    console.log(`- [${item.title}] -> [${item.matchedKey}] (${path.basename(item.logoPath)}) [hasPoster=${item.hasPoster}]`);
  }
  process.exit(0);
}

// 执行正式上传和数据库更新
console.log('--- Applying changes to filesystem and database ---');

// 缓存已写入的文件：logoPath -> uploadedFilename
const fileUploadCache = new Map();

function getUploadedCustomLogoUrl(logoPath) {
  if (fileUploadCache.has(logoPath)) {
    return fileUploadCache.get(logoPath);
  }
  const buffer = fs.readFileSync(logoPath);
  const ext = path.extname(logoPath).toLowerCase() || '.png';
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const filename = `logo-${hash}${ext}`;
  const destPath = path.join(uploadsDir, filename);

  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, buffer);
  }

  const customUrl = `/api/public/media/custom-logos/${filename}`;
  fileUploadCache.set(logoPath, customUrl);
  return customUrl;
}

const updateChannelLogoStmt = db.prepare(`
  UPDATE channel_logo
  SET ref = ?, upstream_url = ?, source_kind = 'custom', source_id = NULL,
      revision = revision + 1, revoked_at = NULL, updated_at = ?
  WHERE household_id = ? AND media_id = ?
`);

const insertChannelLogoStmt = db.prepare(`
  INSERT INTO channel_logo (
    household_id, media_id, ref, upstream_url, source_kind, source_id,
    revision, revoked_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'custom', NULL, 1, NULL, ?, ?)
`);

const findExistingLogoStmt = db.prepare(
  'SELECT ref, revision FROM channel_logo WHERE household_id = ? AND media_id = ?'
);

const updateMediaItemStmt = db.prepare(`
  UPDATE media_item
  SET poster_ref = ?, version = version + 1, updated_at = ?
  WHERE household_id = ? AND id = ?
`);

const bumpCatalogStmt = db.prepare(`
  INSERT INTO catalog_state (household_id, revision)
  VALUES (?, 2)
  ON CONFLICT(household_id) DO UPDATE SET revision = catalog_state.revision + 1
`);

const applyTransaction = db.transaction(() => {
  const nowIso = new Date().toISOString();
  let updatedCount = 0;

  for (const item of matchedItems) {
    const customUrl = getUploadedCustomLogoUrl(item.logoPath);
    const existing = findExistingLogoStmt.get(householdId, item.channelId);

    // 签发符合规格的 32 字符小写 hex ref (128-bit)
    const newRef = crypto.randomBytes(16).toString('hex');

    if (existing !== undefined) {
      updateChannelLogoStmt.run(newRef, customUrl, nowIso, householdId, item.channelId);
    } else {
      insertChannelLogoStmt.run(householdId, item.channelId, newRef, customUrl, nowIso, nowIso);
    }

    updateMediaItemStmt.run(newRef, nowIso, householdId, item.channelId);
    updatedCount++;
  }

  bumpCatalogStmt.run(householdId);
  return updatedCount;
});

const totalUpdated = applyTransaction();
console.log(`Successfully updated ${totalUpdated} channels with matching logos!`);
console.log(`Saved logo files to: ${uploadsDir}`);
