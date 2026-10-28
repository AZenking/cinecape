import fsNode from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IMPORT_BUDGETS,
} from '@platform/config/import-budgets';
import {
  NAS_SCAN_ERROR_CODES,
  SUPPORTED_MEDIA_EXTENSIONS,
  NasScanFailure,
  scanNasRoot,
  scanNasRootWithBudgets,
  type NasFileEntry,
  type NasScanErrorCode,
} from '@contexts/sources/infrastructure/nas-scanner';
import { createNasRootFixture, type NasRootFixture } from '../../helpers';

/**
 * NAS 只读扫描器测试(T015;FR-014/research R4):
 * - 授权边界:rootKey 必须存在于传入 roots 映射;相对目录拒绝绝对路径/../空字节/反斜杠;
 * - 符号链接与逐层 realpath:任何符号链接(文件/目录)拒绝且不跟随,根内链接指向根外即失败;
 * - 只记录相对路径+十进制文本 size/mtimeNs(BigInt 精度不丢失);
 * - 预算:文件数/目录深度/总时长超限整体失败(100000 文件与 10 分钟无法真实构造,
 *   经 scanNasRootWithBudgets 注入预算验证分支,默认值绑定 IMPORT_BUDGETS.NAS_* 由深度 64 行为佐证);
 * - 只读性:扫描前后文件树 stat 快照一致,且全程未以任何模式 open 文件;
 * - 让出事件循环:2000 文件扫描期间 setInterval 心跳不被饿死。
 */

/** 当前用例的夹具;afterEach 统一清理 */
let fixture: NasRootFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function makeFixture(): NasRootFixture {
  fixture = createNasRootFixture();
  return fixture;
}

/** 以传入 roots 映射构造扫描参数(授权根为夹具 root) */
function rootsOf(root: NasRootFixture): Record<string, string> {
  return { [root.rootKey]: root.rootPath };
}

/** 运行扫描并返回失败;断言失败为 NasScanFailure 且携带期望稳定 code */
async function failureCodeOf(run: () => Promise<unknown>, expectedCode: NasScanErrorCode): Promise<NasScanFailure> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望扫描失败(${expectedCode})但成功返回`).toBeInstanceOf(NasScanFailure);
  const failure = caught as NasScanFailure;
  expect(failure.code).toBe(expectedCode);
  return failure;
}

/** 错误信息安全:失败消息不得含部署绝对路径(根/根外/临时目录前缀),可含 rootKey 与相对片段 */
function expectNoAbsolutePathLeak(failure: NasScanFailure, root: NasRootFixture): void {
  const baseDir = path.dirname(root.rootPath);
  expect(failure.message).not.toContain(root.rootPath);
  expect(failure.message).not.toContain(root.outsidePath);
  expect(failure.message).not.toContain(baseDir);
}

/** 递归收集根内全部常规文件的 stat 快照(bigint 精度),用于只读性前后对比 */
function treeFileSnapshot(rootPath: string): Map<string, { size: bigint; mtimeNs: bigint; atimeNs: bigint }> {
  const snapshot = new Map<string, { size: bigint; mtimeNs: bigint; atimeNs: bigint }>();
  const walk = (absDir: string, relDir: string): void => {
    for (const dirent of fsNode.readdirSync(absDir, { withFileTypes: true })) {
      const childAbs = path.join(absDir, dirent.name);
      const childRel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!dirent.isFile()) {
        continue;
      }
      const st = fsNode.lstatSync(childAbs, { bigint: true });
      snapshot.set(childRel, { size: st.size, mtimeNs: st.mtimeNs, atimeNs: st.atimeNs });
    }
  };
  walk(rootPath, '');
  return snapshot;
}

describe('NAS 只读扫描器 · 正常扫描(T015/research R4)', () => {
  it('SUPPORTED_MEDIA_EXTENSIONS 覆盖 mp4/mkv/avi/mov/webm/m4v/ts 七种扩展', () => {
    expect([...SUPPORTED_MEDIA_EXTENSIONS]).toEqual(['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts']);
  });

  it('递归枚举受支持扩展文件,输出相对路径+十进制文本 size/mtimeNs(与实际 stat 一致)', async () => {
    const root = makeFixture();
    // mtimeNs 经 utimesSync 有亚毫秒误差:断言与实际 stat 一致,不与写入值绝对相等
    const absA = root.write('movies/a.MP4', 'x', { mtimeNs: 1_700_000_000_123_456_789n });
    const absB = root.write('movies/sub/b.mkv', 'yy', { mtimeNs: 1_700_000_000_000_000_000n });
    root.write('movies/sub/deep/c.WebM', 'zzz');
    root.write('movies/ignored.txt', 'not media');

    const result = await scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'movies' });

    // relativePath 相对授权根(research R4「身份=来源内精确相对路径」/data-model「rootKey+相对路径」)
    const relPaths = result.entries.map((entry) => entry.relativePath).sort();
    expect(relPaths).toEqual(['movies/a.MP4', 'movies/sub/b.mkv', 'movies/sub/deep/c.WebM']);
    // POSIX 风格斜杠分隔(显式用「/」,不接受平台分隔符)
    for (const entry of result.entries) {
      expect(entry.relativePath).not.toContain('\\');
      expect(entry.relativePath.startsWith('/')).toBe(false);
    }
    // 十进制文本与实际 stat 一致(不丢精度)
    const expected = new Map<string, NasFileEntry>();
    for (const [abs, rel] of [
      [absA, 'movies/a.MP4'],
      [absB, 'movies/sub/b.mkv'],
    ] as const) {
      const st = fsNode.statSync(abs, { bigint: true });
      expected.set(rel, {
        relativePath: rel,
        sizeText: st.size.toString(),
        mtimeNsText: st.mtimeNs.toString(),
      });
    }
    for (const entry of result.entries) {
      const want = expected.get(entry.relativePath);
      if (want === undefined) {
        continue;
      }
      expect(entry.sizeText).toBe(want.sizeText);
      expect(entry.mtimeNsText).toBe(want.mtimeNsText);
      // 十进制文本:仅数字字符
      expect(/^\d+$/.test(entry.sizeText)).toBe(true);
      expect(/^\d+$/.test(entry.mtimeNsText)).toBe(true);
    }
  });

  it('扩展过滤大小写不敏感;不受支持扩展与无扩展文件不收录;目录不因受支持扩展名被当作文件', async () => {
    const root = makeFixture();
    root.write('lib/clip.mp4', 'x');
    root.write('lib/notes.md', 'x');
    root.write('lib/backup.mp4.bak', 'x');
    root.write('lib/noext', 'x');
    root.write('lib/season.mp4/inner.mkv', 'x'); // 名字带受支持扩展的目录,应继续递归而非收录

    const result = await scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'lib' });

    expect(result.entries.map((entry) => entry.relativePath).sort()).toEqual([
      'lib/clip.mp4',
      'lib/season.mp4/inner.mkv',
    ]);
  });

  it('空 relativeDirectory 表示从根本身开始扫描', async () => {
    const root = makeFixture();
    root.write('top.mp4', 'x');
    const result = await scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: '' });
    expect(result.entries.map((entry) => entry.relativePath)).toEqual(['top.mp4']);
  });

  it('onProgress 按收录进度累计回调,最终计数等于条目数', async () => {
    const root = makeFixture();
    for (let i = 0; i < 5; i += 1) {
      root.write(`d${i}/v.mp4`, 'x');
    }
    const progress: number[] = [];
    const result = await scanNasRoot({
      roots: rootsOf(root),
      rootKey: root.rootKey,
      relativeDirectory: '',
      onProgress: (n) => progress.push(n),
    });
    expect(progress.length).toBe(result.entries.length);
    expect(progress.at(-1)).toBe(result.entries.length);
    for (let i = 0; i < progress.length; i += 1) {
      expect(progress[i]).toBe(i + 1);
    }
  });
});

describe('NAS 只读扫描器 · 授权与相对路径拒绝', () => {
  it('rootKey 不存在于传入 roots 映射 → ROOT_UNAUTHORIZED', async () => {
    const root = makeFixture();
    const failure = await failureCodeOf(
      () => scanNasRoot({ roots: {}, rootKey: root.rootKey, relativeDirectory: '' }),
      NAS_SCAN_ERROR_CODES.ROOT_UNAUTHORIZED,
    );
    expect(failure.message).toContain(root.rootKey);
    expectNoAbsolutePathLeak(failure, root);
  });

  it('relativeDirectory 为绝对路径(POSIX 斜杠/Windows 盘符)→ INVALID_RELATIVE_PATH', async () => {
    const root = makeFixture();
    root.write('keep.mp4', 'x');
    for (const bad of ['/etc/passwd', 'C:/media']) {
      const failure = await failureCodeOf(
        () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: bad }),
        NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
      );
      expectNoAbsolutePathLeak(failure, root);
    }
  });

  it('relativeDirectory 含「..」段 → INVALID_RELATIVE_PATH', async () => {
    const root = makeFixture();
    for (const bad of ['..', 'a/../b', 'a/..']) {
      await failureCodeOf(
        () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: bad }),
        NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
      );
    }
  });

  it('relativeDirectory 含空字节 → INVALID_RELATIVE_PATH', async () => {
    const root = makeFixture();
    await failureCodeOf(
      () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'a\u0000b' }),
      NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
    );
  });

  it('relativeDirectory 以反斜杠为分隔符 → INVALID_RELATIVE_PATH', async () => {
    const root = makeFixture();
    root.write('win/a.mp4', 'x');
    await failureCodeOf(
      () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'win\\a.mp4' }),
      NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
    );
  });

  it('relativeDirectory 段不存在(根内无此目录)→ INVALID_RELATIVE_PATH,不抛裸 fs 错误', async () => {
    const root = makeFixture();
    const failure = await failureCodeOf(
      () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'no/such/dir' }),
      NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
    );
    expectNoAbsolutePathLeak(failure, root);
  });
});

describe('NAS 只读扫描器 · 符号链接与逐层 realpath 根边界', () => {
  it('根内文件符号链接(带受支持扩展名)→ SYMLINK_DENIED 且不跟随、不收录', async () => {
    const root = makeFixture();
    root.write('real.mp4', 'x');
    const outside = root.writeOutside('leaked.mp4', 'secret');
    root.makeSymlink('link.mp4', outside);

    const failure = await failureCodeOf(
      () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: '' }),
      NAS_SCAN_ERROR_CODES.SYMLINK_DENIED,
    );
    expect(failure.message).toContain('link.mp4');
    expectNoAbsolutePathLeak(failure, root);
  });

  it('根内目录符号链接指向 outsidePath → SYMLINK_DENIED,越界文件不出现(逐层 realpath 拒绝)', async () => {
    const root = makeFixture();
    root.writeOutside('deep/escaped.mkv', 'outside data');
    root.write('movies/ok.mp4', 'x');
    root.makeSymlink('movies/escape', root.outsidePath);

    const failure = await failureCodeOf(
      () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'movies' }),
      NAS_SCAN_ERROR_CODES.SYMLINK_DENIED,
    );
    expectNoAbsolutePathLeak(failure, root);
  });

  it('起点 relativeDirectory 逐段校验:第一段即目录符号链接 → SYMLINK_DENIED', async () => {
    const root = makeFixture();
    const outside = root.writeOutside('a.mkv', 'x');
    root.makeSymlink('entry', path.dirname(outside));
    await failureCodeOf(
      () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'entry' }),
      NAS_SCAN_ERROR_CODES.SYMLINK_DENIED,
    );
  });
});

describe('NAS 只读扫描器 · 预算(T010 IMPORT_BUDGETS.NAS_*)', () => {
  it('受支持文件数超限 → TOO_MANY_FILES(注入 maxFiles=5,6 个文件失败/5 个成功)', async () => {
    const root = makeFixture();
    for (let i = 0; i < 6; i += 1) {
      root.write(`v${i}.mp4`, 'x');
    }
    const budgets = { maxFiles: 5 };
    await failureCodeOf(
      () => scanNasRootWithBudgets({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: '', budgets }),
      NAS_SCAN_ERROR_CODES.TOO_MANY_FILES,
    );
    root.remove('v5.mp4');
    const ok = await scanNasRootWithBudgets({
      roots: rootsOf(root),
      rootKey: root.rootKey,
      relativeDirectory: '',
      budgets,
    });
    expect(ok.entries.length).toBe(5);
  });

  it('目录深度超默认 64 层 → TOO_DEEP;64 层成功(默认预算绑定 IMPORT_BUDGETS.NAS_MAX_DEPTH=64)', async () => {
    const root = makeFixture();
    const depthOf64 = Array.from({ length: IMPORT_BUDGETS.NAS_MAX_DEPTH }, (_, i) => `d${i}`);
    root.write(`${depthOf64.join('/')}/leaf.mp4`, 'x');
    const ok = await scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: '' });
    expect(ok.entries.length).toBe(1);

    root.write(`${[...depthOf64, 'd64'].join('/')}/deep.mp4`, 'x');
    const failure = await failureCodeOf(
      () => scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: '' }),
      NAS_SCAN_ERROR_CODES.TOO_DEEP,
    );
    expectNoAbsolutePathLeak(failure, root);
  });

  it('总时长预算超限 → BUDGET_EXCEEDED(注入受控时钟与 scanBudgetMs)', async () => {
    const root = makeFixture();
    for (let i = 0; i < 8; i += 1) {
      root.write(`t${i}.mp4`, 'x');
    }
    // 受控时钟:每次取时 +3ms;预算 7ms → 让出点二次检查即超限
    let tick = 0;
    const clock = { now: () => (tick += 3) };
    await failureCodeOf(
      () =>
        scanNasRootWithBudgets({
          roots: rootsOf(root),
          rootKey: root.rootKey,
          relativeDirectory: '',
          clock,
          budgets: { scanBudgetMs: 7, yieldEveryEntries: 1 },
        }),
      NAS_SCAN_ERROR_CODES.BUDGET_EXCEEDED,
    );
  });

  it('默认总时长预算绑定 IMPORT_BUDGETS.NAS_SCAN_BUDGET_MS(不注入时钟时使用 Date.now,正常扫描不超限)', async () => {
    const root = makeFixture();
    root.write('fast.mp4', 'x');
    const result = await scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: '' });
    expect(result.entries.length).toBe(1);
    expect(IMPORT_BUDGETS.NAS_SCAN_BUDGET_MS).toBe(10 * 60 * 1000);
  });
});

describe('NAS 只读扫描器 · 只读性(FR-014)', () => {
  it('扫描前后文件树 stat 快照字节级一致,且全程未以任何模式 open 文件', async () => {
    const root = makeFixture();
    root.write('a/big.mp4', 'x', { sizeHint: 512 * 1024 });
    root.write('b/c.m4v', 'y', { sizeHint: 64 * 1024 });

    const before = treeFileSnapshot(root.rootPath);
    // node:fs 的 default 导出为 CJS module.exports 对象,可 spy;
    // fs.promises === require('node:fs/promises'),故 promises.open 的 spy 同样覆盖实现的导入
    const openSyncSpy = vi.spyOn(fsNode, 'openSync');
    const openCbSpy = vi.spyOn(fsNode, 'open');
    const openPromiseSpy = vi.spyOn(fsNode.promises, 'open');
    try {
      const result = await scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: '' });
      expect(result.entries.length).toBe(2);
    } finally {
      openSyncSpy.mockRestore();
      openCbSpy.mockRestore();
      openPromiseSpy.mockRestore();
    }
    expect(openSyncSpy).not.toHaveBeenCalled();
    expect(openCbSpy).not.toHaveBeenCalled();
    expect(openPromiseSpy).not.toHaveBeenCalled();

    const after = treeFileSnapshot(root.rootPath);
    expect(after.size).toBe(before.size);
    for (const [rel, statBefore] of before) {
      const statAfter = after.get(rel);
      expect(statAfter, `文件 ${rel} 扫描后消失`).toBeDefined();
      expect(statAfter?.size).toBe(statBefore.size);
      expect(statAfter?.mtimeNs).toBe(statBefore.mtimeNs);
      expect(statAfter?.atimeNs).toBe(statBefore.atimeNs);
    }
  });
});

describe('NAS 只读扫描器 · 让出事件循环(FR-014/research R4)', () => {
  it('2000 个文件扫描期间 setInterval 心跳不被饿死', async () => {
    const root = makeFixture();
    for (let i = 0; i < 2000; i += 1) {
      root.write(`bulk/g${i % 8}/v${i}.mp4`, 'x');
    }
    let beats = 0;
    const heartbeat = setInterval(() => {
      beats += 1;
    }, 1);
    try {
      const result = await scanNasRoot({ roots: rootsOf(root), rootKey: root.rootKey, relativeDirectory: 'bulk' });
      expect(result.entries.length).toBe(2000);
    } finally {
      clearInterval(heartbeat);
    }
    expect(beats).toBeGreaterThan(0);
  }, 30_000);
});
