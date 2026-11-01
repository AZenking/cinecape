import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createUnitOfWork,
  UnitOfWorkContractError,
  type SyncResult,
  type TransactionBinding,
  type TransactionCredential,
} from '@platform/database/unit-of-work';

/**
 * 010-online-vod T008(测试先行,TDD 红阶段):平台 UnitOfWork 契约测试。
 * 本文件即 T016 实现前冻结的 API 契约,用例清单逐条对应 tasks.md T008:
 * 1) 事务参与者同连接可见性(同一工作集先写后读,提交仅发生在 run 边界);
 * 2) 每步注入失败 → 全部参与者整体回滚,连接恢复可用;
 * 3) 无全局 seam 重绑(跨连接连续 run 互不串扰,无 AsyncLocalStorage/全局槽泄漏);
 * 4) 禁止事务内 await/独立提交(callback 同步签名,类型层 + 行为层各一定义)。
 *
 * ⚠️ 红阶段预期(TDD,计划内):被测模块 `@platform/database/unit-of-work`
 * (apps/server/src/platform/database/unit-of-work.ts)由 T016 实现,当前不存在 ——
 * - `pnpm --filter @hmp/server typecheck`:本文件必然出现且仅出现一条 TS2307(下方唯一 import);
 * - `pnpm --filter @hmp/server exec vitest run test/unit/online-vod/unit-of-work.spec.ts`:
 *   收集期即失败(模块解析失败)。除该计划内红外,本文件自身零类型/lint 错误。
 *
 * 契约来源:docs/specs/010-online-vod/contracts/internal-ports.md §2/§5:
 * - 平台基础设施提供同步 run(workSetFactory, callback, {behavior:'immediate'});
 * - 基础设施工厂把同一连接事务绑定到每上下文自有 TxStore,事务凭证不暴露 ORM 句柄;
 * - 不经 AsyncLocalStorage 隐式全局替换,不临时修改模块 seam,不在 callback 内 await;
 * - §5 新增工作集(PreferenceWrite/PlayingObservation/TransitionCleanup 等)复用同一 run
 *   机制;其工作集端口形状归 T015 定义,本文件以最小内联 TxStore 只钉机制契约,
 *   不 import 尚不存在的上下文端口。
 *
 * 给 T016 的最终签名(@platform/database/unit-of-work 导出面,详见任务报告):
 * - createUnitOfWork({ resolveDatabase, txStores }): UnitOfWork
 *   - resolveDatabase: () => DatabaseConstructor.Database —— 每次 run 重新解析一次
 *     (不缓存于创建期,兼容 Database 单例 close/重开);
 *   - txStores: 各上下文 TxStore 工厂注册表(catalog/source/vod/playback/personalData 等,
 *     键名即上下文名,由各上下文 infrastructure 装配期提供);
 * - uow.run<TWorkSet, TResult>(workSetFactory, callback, options): TResult
 *   - workSetFactory: (txStores: TxStores) => TWorkSet,TxStores = { credential: TransactionCredential }
 *     & 各已注册上下文经「同一连接事务」绑定后的 TxStore;
 *   - callback: (workSet: TWorkSet) => SyncResult<TResult> —— 同步签名;
 *   - options: { behavior: 'immediate'(BEGIN IMMEDIATE); busyBudgetMs?: number };
 * - TransactionBinding:仅供 TxStore 工厂(基础设施角色)消费的绑定面 = { credential } +
 *   exec/get/all 同步执行器,绑定本次事务连接,run 作用域外立即失效;
 * - busy 预算的 SQLITE_BUSY 重试上限行为需要真实双连接写竞争与计时,归 T016 集成验证
 *   (本文件以选项形状与全同步断言钉住契约,不以 it.skip 掩盖)。
 */

type SqliteConnection = DatabaseConstructor.Database;

/**
 * 最小自建探针表(不依赖迁移 DDL,保持本契约测试与 schema 演化解耦);
 * household_id 列沿用仓库「每表显式 household_id」惯例(ADR-0003)。
 */
const PROBE_DDL = `
  CREATE TABLE uow_probe (
    household_id TEXT NOT NULL,
    k TEXT NOT NULL,
    v TEXT NOT NULL,
    PRIMARY KEY (household_id, k)
  );
`;

const HH_A = 'hh-uow-a';
const HH_B = 'hh-uow-b';

/**
 * 测试内联最小 TxStore(模拟 T015 每上下文事务仓储;不 import 不存在的上下文端口)。
 * 工厂签名即平台约定:平台仅把 TransactionBinding(非 ORM 句柄的绑定面)交给
 * TxStore 工厂;workSetFactory/callback(application 角色)只见绑定后的 store
 * 与不透明凭证 TransactionCredential。
 */
interface ProbeTxStore {
  upsert(householdId: string, key: string, value: string): void;
  valueOf(householdId: string, key: string): string | undefined;
}

/**
 * 消费侧内联契约标注(run 各 callback 的显式参数类型):
 * - 红阶段(模块缺失)阻断隐式 any 连锁错误,保证本文件除 TS2307 外零类型错误;
 * - T016 落地后转为结构校验 —— TxStores<F> 的注册键产出与工作集形状须与之匹配,
 *   不一致即编译失败(契约双向强制)。
 */
interface CatalogVodTxStores {
  readonly credential: TransactionCredential;
  readonly catalog: ProbeTxStore;
  readonly vod: ProbeTxStore;
}

interface CatalogOnlyTxStores {
  readonly credential: TransactionCredential;
  readonly catalog: ProbeTxStore;
}

interface CatalogVodWorkSet {
  readonly catalog: ProbeTxStore;
  readonly vod: ProbeTxStore;
}

interface CatalogOnlyWorkSet {
  readonly catalog: ProbeTxStore;
}

function makeProbeStoreFactory(tag: string): (binding: TransactionBinding) => ProbeTxStore {
  return (binding) => ({
    upsert(householdId, key, value) {
      binding.exec(
        'INSERT INTO uow_probe (household_id, k, v) VALUES (?, ?, ?) ' +
          'ON CONFLICT(household_id, k) DO UPDATE SET v = excluded.v',
        [householdId, key, `${tag}:${value}`],
      );
    },
    valueOf(householdId, key) {
      const row = binding.get<{ v: string }>(
        'SELECT v FROM uow_probe WHERE household_id = ? AND k = ?',
        [householdId, key],
      );
      return row?.v;
    },
  });
}

/* ---------------- 夹具:独立连接(不经 Database 全局单例/getDb) ---------------- */

const openConnections: SqliteConnection[] = [];
const createdDirs: string[] = [];

afterEach(() => {
  while (openConnections.length > 0) {
    openConnections.pop()?.close();
  }
  while (createdDirs.length > 0) {
    fs.rmSync(createdDirs.pop() as string, { recursive: true, force: true });
  }
});

/** 临时文件库 + 观察连接:验证跨连接提交边界/WAL 可见性(内存库无法开第二连接) */
function openFileDbPair(): { conn: SqliteConnection; observer: SqliteConnection } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uow-spec-'));
  createdDirs.push(dataDir);
  const dbFile = path.join(dataDir, 'uow.db');
  const conn = new DatabaseConstructor(dbFile);
  conn.pragma('journal_mode = WAL');
  conn.exec(PROBE_DDL);
  const observer = new DatabaseConstructor(dbFile);
  // BUSY 探测需快速失败,不用 better-sqlite3 默认 5s 等待
  observer.pragma('busy_timeout = 50');
  openConnections.push(conn, observer);
  return { conn, observer };
}

function openMemoryDb(): SqliteConnection {
  const conn = new DatabaseConstructor(':memory:');
  conn.exec(PROBE_DDL);
  openConnections.push(conn);
  return conn;
}

/* ---------------- 断言辅助(全部同步,无 await 缝隙) ---------------- */

function rawValue(conn: SqliteConnection, householdId: string, key: string): string | undefined {
  const row = conn.prepare('SELECT v FROM uow_probe WHERE household_id = ? AND k = ?').get(householdId, key) as
    | { v: string }
    | undefined;
  return row?.v;
}

function rawCount(conn: SqliteConnection): number {
  const row = conn.prepare('SELECT COUNT(*) AS n FROM uow_probe').get() as { n: number };
  return row.n;
}

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

/**
 * 类型层契约 witness(惯用法,不使用 @ts-expect-error):
 * run 的 callback 返回类型被模块导出的 SyncResult<TResult> 约束 ——
 * `[T] extends [PromiseLike<unknown>]` 命中即推入 never,任何 async callback 形态
 * 在编译期被「Type 'Promise<...>' is not assignable to type 'never'」拒绝;
 * 行为层由「callback 返回 Promise → 同步抛 UnitOfWorkContractError('async-callback')」
 * 复证(见下)。此处仅以合法同步形态通过编译,证明 SyncResult 可正常消费。
 */
type SyncProbeCallback = (workSet: { probe: ProbeTxStore }) => SyncResult<string>;
const _syncCallbackWitness: SyncProbeCallback = ({ probe }) => probe.valueOf('hh-witness', 'k') ?? '';

/* ---------------- 契约用例 ---------------- */

describe('010 T008 UnitOfWork 平台契约(红阶段:被测模块由 T016 实现)', () => {
  it('同一工作集内先写后读:跨参与者经同一未提交事务可见,提交仅发生在 run 返回之后', () => {
    const { conn, observer } = openFileDbPair();
    const uow = createUnitOfWork({
      resolveDatabase: () => conn,
      txStores: { catalog: makeProbeStoreFactory('catalog'), vod: makeProbeStoreFactory('vod') },
    });

    const inTxRead = uow.run(
      // workSetFactory(application 角色):从注册工厂取回绑定同一事务的各上下文 TxStore
      (tx: CatalogVodTxStores) => ({ catalog: tx.catalog, vod: tx.vod }),
      ({ catalog, vod }: CatalogVodWorkSet) => {
        catalog.upsert(HH_A, 'media-1', '标题A');
        // 另一参与者(独立工厂/独立 TxStore 实例)读到本事务未提交写入 → 同连接绑定
        expect(vod.valueOf(HH_A, 'media-1')).toBe('catalog:标题A');
        // 提交前外部连接(WAL 读快照)不可见 → callback 期间既不能被外部读到,也不可能被外部提交
        expect(rawValue(observer, HH_A, 'media-1')).toBeUndefined();
        return vod.valueOf(HH_A, 'media-1');
      },
      { behavior: 'immediate' },
    );

    expect(inTxRead).toBe('catalog:标题A');
    // run 返回即已提交:观察连接可见
    expect(rawValue(observer, HH_A, 'media-1')).toBe('catalog:标题A');
  });

  it("options.behavior:'immediate' 即 BEGIN IMMEDIATE:callback 期间其他连接取不到写锁,提交后释放", () => {
    const { conn, observer } = openFileDbPair();
    const uow = createUnitOfWork({
      resolveDatabase: () => conn,
      txStores: { catalog: makeProbeStoreFactory('catalog') },
    });

    let busyDuringCallback = false;
    uow.run(
      (tx: CatalogOnlyTxStores) => ({ catalog: tx.catalog }),
      ({ catalog }: CatalogOnlyWorkSet) => {
        catalog.upsert(HH_A, 'lock-probe', 'x');
        // BEGIN IMMEDIATE 在事务开启时即持有写锁(若是 DEFERRED,此刻观察连接仍能取得写锁)
        try {
          observer.exec('BEGIN IMMEDIATE');
        } catch (err) {
          busyDuringCallback = (err as { code?: string }).code === 'SQLITE_BUSY';
        }
        return true;
      },
      { behavior: 'immediate', busyBudgetMs: 250 },
    );

    expect(busyDuringCallback).toBe(true);
    // 提交后写锁释放:观察连接可立即取得写锁
    expect(() => observer.exec('BEGIN IMMEDIATE')).not.toThrow();
    observer.exec('ROLLBACK');
  });

  it('多步写入中途注入失败:全部参与者整体回滚、原样上抛、连接恢复可用', () => {
    const { conn, observer } = openFileDbPair();
    const uow = createUnitOfWork({
      resolveDatabase: () => conn,
      txStores: { catalog: makeProbeStoreFactory('catalog'), vod: makeProbeStoreFactory('vod') },
    });
    const injected = new Error('injected-step-failure');

    let surfaced: unknown;
    try {
      uow.run(
        (tx: CatalogVodTxStores) => ({ catalog: tx.catalog, vod: tx.vod }),
        ({ catalog, vod }: CatalogVodWorkSet) => {
          catalog.upsert(HH_A, 'm1', 'step-1');
          vod.upsert(HH_A, 'm2', 'step-2');
          throw injected; // 中间步注入失败:前两步(两个参与者)必须整体回滚
        },
        { behavior: 'immediate', busyBudgetMs: 250 },
      );
    } catch (err) {
      surfaced = err;
    }

    expect(surfaced).toBe(injected); // 失败原样上抛,不吞不包装
    expect(rawCount(conn)).toBe(0); // 同连接视角:已回滚
    expect(rawCount(observer)).toBe(0); // 提交侧视角:提交从未发生
    // 连接恢复可用:写锁已随 ROLLBACK 释放
    expect(() => observer.exec('BEGIN IMMEDIATE')).not.toThrow();
    observer.exec('ROLLBACK');
    // 同一连接上的后续 run 正常提交(回滚不留死事务)
    const recovered = uow.run(
      (tx: CatalogOnlyTxStores) => ({ catalog: tx.catalog }),
      ({ catalog }: CatalogOnlyWorkSet) => {
        catalog.upsert(HH_A, 'm3', 'after-rollback');
        return catalog.valueOf(HH_A, 'm3');
      },
      { behavior: 'immediate' },
    );
    expect(recovered).toBe('catalog:after-rollback');
    expect(rawCount(observer)).toBe(1);
  });

  it('无全局 seam 重绑:跨连接连续 run 凭证独立、写入各归各库,过期绑定/工作集立即失效', () => {
    // 两个独立内存连接(不经 Database 全局单例/getDb):实现若依赖全局定位器,此处即失败。
    // run 全同步、无 await 间隙,真正的事务边界即调用栈边界;若实现引入 AsyncLocalStorage
    // 或全局槽绑定「当前事务」,连续两次不同连接的 run 必然互相污染 —— 以下断言即回归探针。
    const connA = openMemoryDb();
    const connB = openMemoryDb();
    let resolveCallsA = 0;
    const uowA = createUnitOfWork({
      resolveDatabase: () => {
        resolveCallsA += 1;
        return connA;
      },
      txStores: { catalog: makeProbeStoreFactory('A') },
    });
    const uowB = createUnitOfWork({
      resolveDatabase: () => connB,
      txStores: { catalog: makeProbeStoreFactory('B') },
    });

    const credentials: TransactionCredential[] = [];
    const collectCredential = (tx: { credential: TransactionCredential }): void => {
      credentials.push(tx.credential);
    };

    // run1(A 连接):带出工作集与绑定面,供跨 run 泄漏探针
    let workSetA: { catalog: ProbeTxStore } | undefined;
    let bindingA: TransactionBinding | undefined;
    const captureBindingFactory = (binding: TransactionBinding): ProbeTxStore => {
      bindingA = binding;
      return makeProbeStoreFactory('A')(binding);
    };
    const uowCapture = createUnitOfWork({
      resolveDatabase: () => connA,
      txStores: { catalog: captureBindingFactory },
    });
    uowCapture.run(
      (tx: CatalogOnlyTxStores) => {
        collectCredential(tx);
        return { catalog: tx.catalog };
      },
      (ws: CatalogOnlyWorkSet) => {
        workSetA = ws;
        ws.catalog.upsert(HH_A, 'm', 'from-A');
        return ws.catalog.valueOf(HH_A, 'm');
      },
      { behavior: 'immediate' },
    );
    const staleWorkSet = workSetA as { catalog: ProbeTxStore };
    const staleBinding = bindingA as TransactionBinding;

    // run1 作用域外:绑定面/工作集立即失效 —— 外部另开提交不可能,亦无跨 run 遗留句柄
    expect(() => staleBinding.exec('SELECT 1')).toThrow(UnitOfWorkContractError);
    expect(() => staleWorkSet.catalog.upsert(HH_A, 'stale', 'x')).toThrow(UnitOfWorkContractError);

    // run2(B 连接):期间旧工作集若因全局残留「复活」必须仍然失效
    uowB.run(
      (tx: CatalogOnlyTxStores) => {
        collectCredential(tx);
        return { catalog: tx.catalog };
      },
      (ws: CatalogOnlyWorkSet) => {
        ws.catalog.upsert(HH_B, 'm', 'from-B');
        expect(() => staleWorkSet.catalog.upsert(HH_B, 'leak', 'x')).toThrow(UnitOfWorkContractError);
        return ws.catalog.valueOf(HH_B, 'm');
      },
      { behavior: 'immediate' },
    );

    // 事务凭证独立:两次 run 不是全局单例槽
    expect(credentials).toHaveLength(2);
    const [firstCredential, secondCredential] = credentials;
    expect(firstCredential).toBeDefined();
    expect(secondCredential).toBeDefined();
    expect(firstCredential?.transactionId).not.toBe(secondCredential?.transactionId);

    // 写入各归各库:连接绑定未串(全局槽实现会把 B 的写送进 A 的事务)
    expect(rawValue(connA, HH_A, 'm')).toBe('A:from-A');
    expect(rawValue(connB, HH_B, 'm')).toBe('B:from-B');
    expect(rawValue(connB, HH_B, 'leak')).toBeUndefined();
    expect(rawValue(connA, HH_B, 'm')).toBeUndefined();

    // resolveDatabase 每次 run 重新解析(不缓存于创建期,兼容 Database 单例 close/重开)
    expect(resolveCallsA).toBe(1);

    // 交错回放 A→B→A:第三次 run 仍绑定 A 连接,且能看到自己首次 run 的已提交数据
    uowA.run(
      (tx: CatalogOnlyTxStores) => {
        collectCredential(tx);
        return { catalog: tx.catalog };
      },
      (ws: CatalogOnlyWorkSet) => {
        expect(ws.catalog.valueOf(HH_A, 'm')).toBe('A:from-A');
        ws.catalog.upsert(HH_A, 'm2', 'second-round');
        return true;
      },
      { behavior: 'immediate' },
    );
    expect(resolveCallsA).toBe(2);
    expect(credentials).toHaveLength(3);
    expect(rawValue(connA, HH_A, 'm2')).toBe('A:second-round');
    expect(rawCount(connB)).toBe(1);
  });

  it('callback 返回 Promise:契约违约 —— run 同步抛 UnitOfWorkContractError(async-callback)并整体回滚', () => {
    const { conn, observer } = openFileDbPair();
    const uow = createUnitOfWork({
      resolveDatabase: () => conn,
      txStores: { catalog: makeProbeStoreFactory('catalog') },
    });

    let violation: unknown;
    try {
      // 同步抛错契约:本调用点永远不会拿到 Promise(类型层 SyncResult 已拒绝该形态,此处行为层复证)
      violation = uow.run(
        (tx: CatalogOnlyTxStores) => ({ catalog: tx.catalog }),
        ({ catalog }: CatalogOnlyWorkSet) => {
          catalog.upsert(HH_A, 'half', 'written-before-await'); // async 同步段已执行的写入必须一并回滚
          return Promise.resolve('不得发生的异步续体');
        },
        { behavior: 'immediate' },
      );
    } catch (err) {
      violation = err;
    }

    expect(violation).toBeInstanceOf(UnitOfWorkContractError);
    expect((violation as UnitOfWorkContractError).reason).toBe('async-callback');
    expect(rawCount(conn)).toBe(0);
    expect(rawCount(observer)).toBe(0);
    // 连接恢复可用
    expect(() => observer.exec('BEGIN IMMEDIATE')).not.toThrow();
    observer.exec('ROLLBACK');
  });

  it('run 同步返回 callback 结果且非 thenable:事务边界即调用栈边界,无 await 缝隙', () => {
    const { conn } = openFileDbPair();
    const uow = createUnitOfWork({
      resolveDatabase: () => conn,
      txStores: { catalog: makeProbeStoreFactory('catalog') },
    });

    const result: { ok: boolean } = uow.run(
      (tx: CatalogOnlyTxStores) => ({ catalog: tx.catalog }),
      ({ catalog }: CatalogOnlyWorkSet) => {
        catalog.upsert(HH_A, 'sync', 'value');
        return { ok: true };
      },
      { behavior: 'immediate' },
    );

    expect(isThenable(result)).toBe(false);
    expect(result).toEqual({ ok: true });
    expect(rawValue(conn, HH_A, 'sync')).toBe('catalog:value');
  });
});
