import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { IMPORT_BUDGETS } from '../../config/import-budgets';

/**
 * NAS 只读扫描器(T023;FR-014/research R4,满足 T015):
 * - 部署者经 MEDIA_ROOTS(rootKey→只读挂载绝对路径)授权根,来源只持 rootKey + 根内 relativeDirectory;
 * - 逐层 lstat + realpath 校验根边界:任何符号链接(文件/目录)拒绝且不跟随,任何一步 realpath
 *   越出根真实路径即失败(纵深防御:即便未来只做字符串前缀判断也无法经链接逃逸);
 * - 仅记录相对路径 + 十进制文本 size/mtimeNs(BigInt 精度),不打开媒体内容、不计算内容哈希;
 * - 文件数/目录深度/总时长预算超限整体失败;扫描分批让出事件循环,错误消息不含部署绝对路径。
 */

/** 受支持媒体扩展名(小写、不含点;匹配大小写不敏感,供解析与 NAS 扫描复用) */
export const SUPPORTED_MEDIA_EXTENSIONS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'ts'] as const;

export type SupportedMediaExtension = (typeof SUPPORTED_MEDIA_EXTENSIONS)[number];

/** NAS 扫描稳定错误码(日志与 DTO 仅透出 code,不透出部署路径) */
export const NAS_SCAN_ERROR_CODES = {
  /** rootKey 不在传入 roots 映射,或授权根不可解析/不是目录 */
  ROOT_UNAUTHORIZED: 'ROOT_UNAUTHORIZED',
  /** 逐层 realpath 校验发现越出授权根 */
  PATH_ESCAPED: 'PATH_ESCAPED',
  /** 出现符号链接(文件或目录),拒绝且不跟随 */
  SYMLINK_DENIED: 'SYMLINK_DENIED',
  /** relativeDirectory 形态非法(绝对路径/..段/空字节/反斜杠)或未指向根内既有目录 */
  INVALID_RELATIVE_PATH: 'INVALID_RELATIVE_PATH',
  /** 扫描总时长超过 NAS_SCAN_BUDGET_MS */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  /** 受支持文件数超过 NAS_MAX_FILES */
  TOO_MANY_FILES: 'TOO_MANY_FILES',
  /** 目录深度超过 NAS_MAX_DEPTH */
  TOO_DEEP: 'TOO_DEEP',
} as const;

export type NasScanErrorCode = (typeof NAS_SCAN_ERROR_CODES)[keyof typeof NAS_SCAN_ERROR_CODES];

/** NAS 扫描失败:携带稳定 code,消息只含 rootKey 与相对路径片段,绝不含部署绝对路径 */
export class NasScanFailure extends Error {
  readonly code: NasScanErrorCode;

  constructor(code: NasScanErrorCode, message: string) {
    super(message);
    this.name = 'NasScanFailure';
    this.code = code;
  }
}

/** 单个受支持媒体文件的扫描记录 */
export interface NasFileEntry {
  /** 来源根内相对路径,POSIX 风格「/」分隔,大小写敏感 */
  relativePath: string;
  /** 文件字节数的十进制文本(stat.size) */
  sizeText: string;
  /** mtime 纳秒的十进制文本(BigInt(stat.mtimeNs).toString(),不丢精度) */
  mtimeNsText: string;
}

export interface NasScanResult {
  entries: NasFileEntry[];
}

/** 可注入时钟(毫秒);缺省 Date.now */
export interface NasScanClock {
  now(): number;
}

export interface NasRootScanOptions {
  /** 授权根映射(MEDIA_ROOTS 形态:rootKey→绝对路径) */
  roots: Readonly<Record<string, string>>;
  rootKey: string;
  /** 根内相对目录(空串 = 根本本身) */
  relativeDirectory: string;
  /** 注入时钟,缺省真实时间 */
  clock?: NasScanClock;
  /** 每收录一个文件回调一次,参数为当前累计条数 */
  onProgress?: (n: number) => void;
}

/** 扫描预算(yieldEveryEntries 为每 N 条让出一次事件循环的实现参数) */
export interface NasScanBudgets {
  maxFiles: number;
  maxDepth: number;
  scanBudgetMs: number;
  yieldEveryEntries: number;
}

/** 缺省让出批大小:大目录扫描时事件循环间隙约在百条粒度 */
export const DEFAULT_NAS_YIELD_EVERY_ENTRIES = 256;

function defaultBudgets(): NasScanBudgets {
  return {
    maxFiles: IMPORT_BUDGETS.NAS_MAX_FILES,
    maxDepth: IMPORT_BUDGETS.NAS_MAX_DEPTH,
    scanBudgetMs: IMPORT_BUDGETS.NAS_SCAN_BUDGET_MS,
    yieldEveryEntries: DEFAULT_NAS_YIELD_EVERY_ENTRIES,
  };
}

/** 构造失败:消息 = 稳定 code + rootKey + 相对路径片段,绝不拼接绝对路径 */
function fail(code: NasScanErrorCode, rootKey: string, relDetail: string, reason: string): NasScanFailure {
  return new NasScanFailure(code, `NAS 扫描失败[${code}] root=${rootKey} ${relDetail}${reason}`);
}

/** realpath 结果是否仍在授权根内(等于根或以根+分隔符为前缀) */
function withinRoot(candidate: string, rootRealPath: string): boolean {
  return candidate === rootRealPath || candidate.startsWith(rootRealPath + path.sep);
}

/** 文件名扩展匹配(大小写不敏感;无扩展名/点开头隐藏文件不匹配) */
export function isSupportedMediaFileName(fileName: string): boolean {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  if (extension === '') {
    return false;
  }
  return (SUPPORTED_MEDIA_EXTENSIONS as readonly string[]).includes(extension);
}

/** relativeDirectory 形态校验:必须为规范的根内相对路径(空串合法 = 根本本身) */
function validateRelativeDirectory(relativeDirectory: string): string[] {
  if (relativeDirectory.includes('\0')) {
    throw new NasScanFailure(
      NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
      'NAS 扫描失败[INVALID_RELATIVE_PATH] 相对目录含空字节',
    );
  }
  if (relativeDirectory.includes('\\')) {
    throw new NasScanFailure(
      NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
      'NAS 扫描失败[INVALID_RELATIVE_PATH] 相对目录含反斜杠分隔符(仅接受「/」)',
    );
  }
  if (relativeDirectory.startsWith('/') || /^[A-Za-z]:/.test(relativeDirectory)) {
    throw new NasScanFailure(
      NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
      'NAS 扫描失败[INVALID_RELATIVE_PATH] 相对目录必须是根内相对路径,不能是绝对路径',
    );
  }
  if (relativeDirectory === '') {
    return [];
  }
  const segments = relativeDirectory.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new NasScanFailure(
        NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
        `NAS 扫描失败[INVALID_RELATIVE_PATH] 相对目录含非法路径段「${segment}」`,
      );
    }
  }
  return segments;
}

/** 让出事件循环:setImmediate 使 macrotask 队列(含定时器心跳)得以执行 */
async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * 扫描 NAS 授权根(任务签名入口,默认预算绑定 IMPORT_BUDGETS.NAS_*)。
 * 失败抛 NasScanFailure(稳定 code);成功时根目录树未被修改,未打开任何媒体内容。
 */
export async function scanNasRoot(opts: NasRootScanOptions): Promise<NasScanResult> {
  return scanNasRootWithBudgets(opts);
}

/**
 * 与 scanNasRoot 相同,但允许注入预算覆盖。
 * 用途:100000 文件/10 分钟预算无法在单测中真实构造,测试注入小预算验证超限分支;
 * 生产代码一律使用 scanNasRoot(IMPORT_BUDGETS.NAS_*)。
 */
export async function scanNasRootWithBudgets(
  opts: NasRootScanOptions & { budgets?: Partial<NasScanBudgets> },
): Promise<NasScanResult> {
  const budgets: NasScanBudgets = { ...defaultBudgets(), ...opts.budgets };
  for (const [key, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`NAS 扫描预算 ${key} 必须为非负整数`);
    }
  }
  const clock = opts.clock ?? { now: () => Date.now() };

  // 1. rootKey 必须存在于授权映射
  const rootPath = opts.roots[opts.rootKey];
  if (rootPath === undefined || rootPath === '') {
    throw fail(
      NAS_SCAN_ERROR_CODES.ROOT_UNAUTHORIZED,
      opts.rootKey,
      '',
      ' 未出现在 MEDIA_ROOTS 授权映射中',
    );
  }

  // 2. relativeDirectory 形态校验(空字节/反斜杠/绝对路径/../规范段)
  const startSegments = validateRelativeDirectory(opts.relativeDirectory);

  // 3. 解析授权根真实路径作为边界基准(根路径由部署层授权,此处仅归一化)
  let rootRealPath: string;
  try {
    rootRealPath = await fsPromises.realpath(rootPath);
  } catch {
    throw fail(NAS_SCAN_ERROR_CODES.ROOT_UNAUTHORIZED, opts.rootKey, '', ' 授权根路径不可解析');
  }
  const rootStat = await fsPromises.lstat(rootRealPath);
  if (!rootStat.isDirectory()) {
    throw fail(NAS_SCAN_ERROR_CODES.ROOT_UNAUTHORIZED, opts.rootKey, '', ' 授权根不是目录');
  }

  // 4. 起点目录逐层 lstat + realpath:任何一段是符号链接即拒绝,任一步 realpath 越界即失败
  let currentRealPath = rootRealPath;
  let startDepth = 0;
  for (const segment of startSegments) {
    if (startDepth + 1 > budgets.maxDepth) {
      throw fail(
        NAS_SCAN_ERROR_CODES.TOO_DEEP,
        opts.rootKey,
        opts.relativeDirectory,
        ` 目录深度超过 ${budgets.maxDepth}`,
      );
    }
    const candidate = path.join(currentRealPath, segment);
    const stat = await fsPromises
      .lstat(candidate)
      .catch(() => undefined);
    if (stat === undefined) {
      throw fail(
        NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
        opts.rootKey,
        opts.relativeDirectory,
        ` 未指向根内既有目录(段「${segment}」不存在)`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw fail(
        NAS_SCAN_ERROR_CODES.SYMLINK_DENIED,
        opts.rootKey,
        `${startSegments.slice(0, startDepth).join('/')}/${segment}`,
        ' 是符号链接,拒绝且不跟随',
      );
    }
    if (!stat.isDirectory()) {
      throw fail(
        NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
        opts.rootKey,
        opts.relativeDirectory,
        ` 未指向根内既有目录(段「${segment}」不是目录)`,
      );
    }
    const candidateRealPath = await fsPromises.realpath(candidate);
    if (!withinRoot(candidateRealPath, rootRealPath)) {
      throw fail(
        NAS_SCAN_ERROR_CODES.PATH_ESCAPED,
        opts.rootKey,
        startSegments.slice(0, startDepth + 1).join('/'),
        ' realpath 越出授权根',
      );
    }
    currentRealPath = candidateRealPath;
    startDepth += 1;
  }

  // 5. 迭代式深度优先扫描(显式栈避免深递归);目录入栈前已完成 realpath 边界确认
  interface DirectoryTask {
    absPath: string;
    relativePath: string;
    depth: number;
  }
  const stack: DirectoryTask[] = [{ absPath: currentRealPath, relativePath: opts.relativeDirectory, depth: startDepth }];
  const entries: NasFileEntry[] = [];
  const startedAtMs = clock.now();
  let sinceLastYield = 0;

  const checkBudget = (): void => {
    if (clock.now() - startedAtMs > budgets.scanBudgetMs) {
      throw fail(
        NAS_SCAN_ERROR_CODES.BUDGET_EXCEEDED,
        opts.rootKey,
        opts.relativeDirectory,
        ` 扫描总时长超过 ${budgets.scanBudgetMs}ms 预算`,
      );
    }
  };

  while (stack.length > 0) {
    const directory = stack.pop() as DirectoryTask;
    let dirents;
    try {
      dirents = await fsPromises.readdir(directory.absPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw fail(
          NAS_SCAN_ERROR_CODES.INVALID_RELATIVE_PATH,
          opts.rootKey,
          directory.relativePath,
          ' 目录在扫描期间消失',
        );
      }
      throw error;
    }
    checkBudget();

    for (const dirent of dirents) {
      const childRelativePath =
        directory.relativePath === '' ? dirent.name : `${directory.relativePath}/${dirent.name}`;

      // 符号链接(文件或目录)一律拒绝且不跟随;readdir 的 Dirent 不解析链接,可先行拦截
      if (dirent.isSymbolicLink()) {
        throw fail(
          NAS_SCAN_ERROR_CODES.SYMLINK_DENIED,
          opts.rootKey,
          childRelativePath,
          ' 是符号链接,拒绝且不跟随',
        );
      }

      if (dirent.isDirectory()) {
        const childDepth = directory.depth + 1;
        if (childDepth > budgets.maxDepth) {
          throw fail(
            NAS_SCAN_ERROR_CODES.TOO_DEEP,
            opts.rootKey,
            childRelativePath,
            ` 目录深度超过 ${budgets.maxDepth}`,
          );
        }
        const childRealPath = await fsPromises.realpath(path.join(directory.absPath, dirent.name));
        if (!withinRoot(childRealPath, rootRealPath)) {
          throw fail(
            NAS_SCAN_ERROR_CODES.PATH_ESCAPED,
            opts.rootKey,
            childRelativePath,
            ' realpath 越出授权根',
          );
        }
        stack.push({ absPath: childRealPath, relativePath: childRelativePath, depth: childDepth });
        continue;
      }

      // 非常规条目(fifo/socket/设备等)不收录也不触碰
      if (!dirent.isFile()) {
        continue;
      }
      if (!isSupportedMediaFileName(dirent.name)) {
        continue;
      }
      if (entries.length >= budgets.maxFiles) {
        throw fail(
          NAS_SCAN_ERROR_CODES.TOO_MANY_FILES,
          opts.rootKey,
          opts.relativeDirectory,
          ` 受支持文件数超过 ${budgets.maxFiles}`,
        );
      }

      const childAbsPath = path.join(directory.absPath, dirent.name);
      // lstat(bigint) 双重确认类型并取纳秒精度 size/mtime(防 readdir 与 stat 之间竞态)
      const fileStat = await fsPromises.lstat(childAbsPath, { bigint: true });
      if (fileStat.isSymbolicLink()) {
        throw fail(
          NAS_SCAN_ERROR_CODES.SYMLINK_DENIED,
          opts.rootKey,
          childRelativePath,
          ' 是符号链接,拒绝且不跟随',
        );
      }
      if (!fileStat.isFile()) {
        continue;
      }
      // 逐条 realpath 边界复核:任何收录条目越出授权根即整体失败
      const fileRealPath = await fsPromises.realpath(childAbsPath);
      if (!withinRoot(fileRealPath, rootRealPath)) {
        throw fail(
          NAS_SCAN_ERROR_CODES.PATH_ESCAPED,
          opts.rootKey,
          childRelativePath,
          ' realpath 越出授权根',
        );
      }

      entries.push({
        relativePath: childRelativePath,
        sizeText: fileStat.size.toString(),
        mtimeNsText: fileStat.mtimeNs.toString(),
      });
      opts.onProgress?.(entries.length);
      sinceLastYield += 1;
      if (sinceLastYield >= budgets.yieldEveryEntries) {
        sinceLastYield = 0;
        checkBudget();
        await yieldToEventLoop();
      }
    }
  }
  checkBudget();

  return { entries };
}
