/**
 * 012 T004 · Network 断言工具:fetch 包装计数器。
 *
 * 统计经 global fetch 发出的两类前缀请求次数,供「零请求负向断言」复用
 * (T006/T007:游客授权前零 `playback/*`、零 `/me/*`;安装后读 counts 即可断言):
 * - counts.playback:路径前缀为 `/playback/*`(含 `/api/playback/*`)的请求次数;
 * - counts.personal:路径前缀为 `/me/*`(含 `/api/me/*`,个人/设置边界)的请求次数;
 *   其余路径(`/public/*`、`/setup/*`、`/auth/*` 等)不计数。
 *
 * 安装方式(跟随现有测试惯例:query-test-utils 的 vi.spyOn(globalThis,'fetch') 与
 * vod-autoplay 系的 vi.stubGlobal('fetch') 路由式 mock 均经同一 global 出口):
 * - installNetworkCounter() 无参:包装「安装那一刻」的 globalThis.fetch 并原样委托
 *   ——因此**先装测试自身的 fetch 路由 mock、再装本计数器**,两层包装叠加,路由
 *   应答与计数同时生效;vi.spyOn 与 vi.stubGlobal 两种既有风格均可被包装;
 * - installNetworkCounter({ fetch }) 注入实现:以注入函数为委托(计数器仍占位
 *   globalThis.fetch,方便对未显式持引用的调用方生效)。
 * restore() 以属性描述符还原安装前的 fetch,不动 vi.stubGlobal 的记账
 * (测试 afterEach 的 vi.unstubAllGlobals 仍按原样生效)。
 *
 * 计数在 wrapper 同步段完成:请求发出即 +1(不等到响应),在途/失败/被中止的
 * 请求同样计入——「零请求」断言语义即「从未发起」。
 */

/** 计数器快照:两类前缀请求次数(live 引用,随请求递增,直接读断言) */
export interface NetworkCounts {
  playback: number;
  personal: number;
}

export interface NetworkCounter {
  /** 实时计数对象(安装后由 fetch 包装器递增;测试直接读它断言) */
  readonly counts: NetworkCounts;
  /** 还原安装前的 globalThis.fetch(描述符级;不影响 vi.stubGlobal 记账) */
  restore(): void;
}

export interface InstallNetworkCounterOptions {
  /** 注入委托实现;缺省 = 安装那一刻的 globalThis.fetch */
  fetch?: typeof globalThis.fetch;
}

/**
 * 从请求 URL 提取分类:playback / personal / 其他(null)。
 * 兼容相对路径(`/api/me/...`)与绝对 URL(`http://host/api/playback/...`);
 * 按路径段精确匹配首段(剥掉可选 `api` 段后为 `playback` 或 `me`),避免子串误报。
 */
function classifyRequest(url: string): 'playback' | 'personal' | null {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://redroad.invalid').pathname;
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments[0] === 'api') {
    segments.shift();
  }
  const head = segments[0];
  if (head === 'playback') {
    return 'playback';
  }
  if (head === 'me') {
    return 'personal';
  }
  return null;
}

/**
 * 以描述符级保存/还原方式替换 globalThis.fetch(不用 vi.stubGlobal,避免
 * unstubAllGlobals 连带清掉测试自身的 stub)。注意:本工具在本文件内就地实现,
 * 保持夹具自包含;与 live-world.tsx 的同名内部工具互不依赖。
 */
function stubGlobalFetch(replacement: typeof globalThis.fetch): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    value: replacement,
    writable: true,
    configurable: true,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, 'fetch', descriptor);
    } else {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  };
}

/**
 * 安装 fetch 包装计数器并返回 { counts, restore }。
 * - 无参:委托 = 安装时的 globalThis.fetch(请先装测试自身的路由 mock);
 * - { fetch }:委托 = 注入实现;注入 undefined 之外无效值由调用方负责。
 *   两者皆无可用委托时,请求以显式 TypeError 拒绝(暴露意外请求,不出网)。
 */
export function installNetworkCounter(
  options: InstallNetworkCounterOptions = {},
): NetworkCounter {
  const delegate =
    options.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined);
  const counts: NetworkCounts = { playback: 0, personal: 0 };
  const wrapper: typeof globalThis.fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const kind = classifyRequest(url);
    if (kind === 'playback') {
      counts.playback += 1;
    } else if (kind === 'personal') {
      counts.personal += 1;
    }
    if (delegate === undefined) {
      return Promise.reject(
        new TypeError(`installNetworkCounter:无可用委托 fetch,拒绝意外请求: ${url}`),
      );
    }
    return delegate(input, init);
  };
  const restore = stubGlobalFetch(wrapper);
  return { counts, restore };
}
