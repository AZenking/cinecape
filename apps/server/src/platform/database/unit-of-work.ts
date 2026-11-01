import { randomUUID } from 'node:crypto';
import type DatabaseConstructor from 'better-sqlite3';

/**
 * 010-online-vod T016:平台 UnitOfWork(BEGIN IMMEDIATE 同步事务工作集机制)。
 *
 * API 契约由 T008 冻结(apps/server/test/unit/online-vod/unit-of-work.spec.ts,
 * 契约来源 docs/specs/010-online-vod/contracts/internal-ports.md §2/§5):
 * - `createUnitOfWork({ resolveDatabase, txStores })`:resolveDatabase 每次 run 重新
 *   解析一次(不缓存于创建期,兼容 Database 单例 close/重开);txStores 为各上下文
 *   TxStore 工厂注册表(键名即上下文名,由各上下文 infrastructure 装配期提供);
 * - `uow.run(workSetFactory, callback, { behavior: 'immediate', busyBudgetMs? })`:
 *   每次运行 解析连接 → BEGIN IMMEDIATE(busy 预算内有界重试/放弃)→ 构造
 *   TransactionBinding(仅 exec/get/all + credential,不暴露连接/ORM 句柄)→ 经
 *   注册表把同一连接事务绑定到各上下文 TxStore → workSetFactory → 同步 callback →
 *   COMMIT / ROLLBACK;run 全同步,事务边界即调用栈边界;
 * - callback 返回 thenable → 同步抛 UnitOfWorkContractError('async-callback')
 *   并整体回滚(类型层由 SyncResult 把 async 形态压成 never 双重复证);
 * - 绑定出 run 作用域即失效:exec/get/all 一律抛
 *   UnitOfWorkContractError('inactive-binding')(经工厂产出的 TxStore 随绑定一并失效);
 * - 不经 AsyncLocalStorage 隐式全局替换,不临时修改模块 seam,无全局状态 ——
 *   全部事务定位经显式参数传递(T008 用例 3:跨连接连续 run 互不串扰)。
 *
 * application 只消费本文件类型与 UnitOfWork 值;TransactionBinding 仅由各上下文
 * infrastructure 的 TxStore 工厂(基础设施角色)在 run 内消费。
 */

/** callback 结果的同步契约:thenable 形态(TResult extends PromiseLike)压成 never,
 * 使 async callback 在编译期被「not assignable to type 'never'」拒绝(T008 用例 4/5) */
export type SyncResult<T> = [T] extends [PromiseLike<unknown>] ? never : T;

/** 契约违约原因:'async-callback'(callback 返回 Promise)| 'inactive-binding'(绑定出作用域) */
export type UnitOfWorkContractReason = 'async-callback' | 'inactive-binding';

/** UnitOfWork 机制契约违约(区别于领域错误:纯机制层编程错误) */
export class UnitOfWorkContractError extends Error {
  readonly reason: UnitOfWorkContractReason;

  constructor(reason: UnitOfWorkContractReason, message?: string) {
    super(message ?? `unitOfWork contract violation: ${reason}`);
    this.name = 'UnitOfWorkContractError';
    this.reason = reason;
  }
}

/** 事务凭证:每次 run 唯一、跨 run 独立(T008 用例 3 断言 transactionId 互异);
 * 不暴露连接/ORM 句柄 —— application 只能以凭证做同事务归属比对 */
export interface TransactionCredential {
  readonly transactionId: string;
  readonly behavior: 'immediate';
}

/**
 * 事务绑定面:仅供 TxStore 工厂(基础设施角色)消费的同步执行器,
 * 绑定本次事务连接;run 作用域外立即失效('inactive-binding')。
 */
export interface TransactionBinding {
  readonly credential: TransactionCredential;
  /** 同步执行写语句(INSERT/UPDATE/DELETE/DDL;多语句以分号分隔时不带参数) */
  exec(sql: string, params?: readonly unknown[]): void;
  /** 同步取单行(无行返回 undefined) */
  get<Row>(sql: string, params?: readonly unknown[]): Row | undefined;
  /** 同步取全部行 */
  all<Row>(sql: string, params?: readonly unknown[]): Row[];
}

/** 各上下文 TxStore 工厂:(binding) => 该上下文绑定后的 TxStore(基础设施角色) */
export type TxStoreFactory = (binding: TransactionBinding) => unknown;

/** TxStore 工厂注册表(键名即上下文名,由装配期提供) */
export type TxStoresRegistry = Record<string, TxStoreFactory>;

/** 注册表经同一连接事务绑定后的 TxStores:credential + 各键产出类型 */
export type BoundTxStores<F extends TxStoresRegistry> = {
  readonly credential: TransactionCredential;
} & {
  readonly [K in keyof F]: ReturnType<F[K]>;
};

/** run 选项:T008 仅钉 'immediate'(BEGIN IMMEDIATE);busyBudgetMs 为 BEGIN/COMMIT
 * 遇 SQLITE_BUSY 的有界重试预算(毫秒,超出即放弃并原样上抛末次错误) */
export interface UnitOfWorkRunOptions {
  readonly behavior: 'immediate';
  readonly busyBudgetMs?: number;
}

/** UnitOfWork:泛型于注册表类型,workSetFactory 经 BoundTxStores<F> 拿到
 * 各已注册上下文绑定后的 TxStore(键名产出与工作集形状失配即编译失败) */
export interface UnitOfWork<F extends TxStoresRegistry = TxStoresRegistry> {
  /**
   * 同步运行一个事务工作集:全部写一个 commit,任何失败(含 callback 返回
   * Promise)整体回滚;run 返回即已提交,返回值即 callback 同步结果。
   * 签名说明:callback 返回纯 TResult,run 返回 SyncResult<TResult> ——
   * 同步形态原样透传,thenable 形态在类型层压成 never(T008 冻结用法)。
   */
  run<TWorkSet, TResult>(
    workSetFactory: (txStores: BoundTxStores<F>) => TWorkSet,
    callback: (workSet: TWorkSet) => TResult,
    options: UnitOfWorkRunOptions,
  ): SyncResult<TResult>;
}

/* ---------------------------------------------- 内部机制(全同步,无全局状态) ---------------------------------------------- */

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function';
}

function isSqliteBusyError(err: unknown): boolean {
  return (err as { code?: string } | null | undefined)?.code === 'SQLITE_BUSY';
}

/** 同步小睡(SQLITE_BUSY 重试间隔;平台不允许同步等待时退化为无间隔有界自旋) */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
  } catch {
    // Atomics.wait 不可用(非常宿):预算由循环条件封顶,自旋不失控
  }
}

/** BEGIN IMMEDIATE / COMMIT 的 busy 有界重试:预算内 SQLITE_BUSY 重试,超出放弃 */
function execBeginOrCommitWithBudget(
  connection: DatabaseConstructor.Database,
  statement: 'BEGIN IMMEDIATE' | 'COMMIT',
  busyBudgetMs: number | undefined,
): void {
  if (busyBudgetMs === undefined) {
    connection.exec(statement);
    return;
  }
  const deadline = Date.now() + busyBudgetMs;
  for (;;) {
    try {
      connection.exec(statement);
      return;
    } catch (err) {
      if (!isSqliteBusyError(err) || Date.now() >= deadline) {
        throw err;
      }
      sleepSync(1);
    }
  }
}

/** 回滚尽力而为:事务已不存在(BEGIN 前置失败等)时静默,不掩盖原始错误 */
function rollbackQuietly(connection: DatabaseConstructor.Database): void {
  try {
    connection.exec('ROLLBACK');
  } catch {
    // 无活动事务可回滚 —— 忽略,保持原始异常传播
  }
}

/**
 * UnitOfWork 工厂(T016)。resolveDatabase 每次 run 重新调用一次;txStores 注册表
 * 在创建期只保存工厂引用,绑定发生在每次 run 内(同一连接事务)。
 */
export function createUnitOfWork<F extends TxStoresRegistry>(config: {
  resolveDatabase: () => DatabaseConstructor.Database;
  txStores: F;
}): UnitOfWork<F> {
  // 创建期预热解析一次(结果即弃、不缓存句柄):T008 用例 4 以 resolveCallsA 计数
  // 钉住「创建 1 次 + 每 run 1 次」的解析节奏;任何 run 的连接句柄永远以当次
  // 解析为准,兼容 Database 单例 close/重开(创建期解析值不得被 run 复用)。
  config.resolveDatabase();

  const run = <TWorkSet, TResult>(
    workSetFactory: (txStores: BoundTxStores<F>) => TWorkSet,
    callback: (workSet: TWorkSet) => TResult,
    options: UnitOfWorkRunOptions,
  ): SyncResult<TResult> => {
    // 每次 run 重新解析一次连接(不缓存于创建期;T008 用例 3 断言 resolve 次数=run 次数)
    const connection = config.resolveDatabase();
    const credential: TransactionCredential = {
      transactionId: randomUUID(),
      behavior: 'immediate',
    };
    // 绑定活性由本 run 作用域内局部 flag 承载:无 AsyncLocalStorage/全局槽,
    // 出作用域即失效(T008 用例 3:过期绑定/工作集立即失效且不跨 run 复活)
    let active = true;
    const assertActive = (): void => {
      if (!active) {
        throw new UnitOfWorkContractError(
          'inactive-binding',
          `事务绑定已随 run ${credential.transactionId} 出作用域失效(inactive-binding)`,
        );
      }
    };
    const binding: TransactionBinding = {
      credential,
      exec(sql: string, params: readonly unknown[] = []) {
        assertActive();
        connection.prepare(sql).run(...params);
      },
      get<Row>(sql: string, params: readonly unknown[] = []) {
        assertActive();
        return connection.prepare(sql).get(...params) as Row | undefined;
      },
      all<Row>(sql: string, params: readonly unknown[] = []) {
        assertActive();
        return connection.prepare(sql).all(...params) as Row[];
      },
    };

    // BEGIN IMMEDIATE:callback 期间即持写锁(T008 用例 2),busy 预算内有界重试
    execBeginOrCommitWithBudget(connection, 'BEGIN IMMEDIATE', options.busyBudgetMs);

    // 经注册表把绑定传给各上下文工厂产出 TxStores(含 credential)
    const stores = {
      credential,
      ...Object.fromEntries(
        Object.entries(config.txStores).map(([key, factory]) => [key, factory(binding)]),
      ),
    } as BoundTxStores<F>;

    try {
      const workSet = workSetFactory(stores);
      const result = callback(workSet);
      if (isThenable(result)) {
        // 异步 callback:同步段写入一并回滚,契约违约同步抛出(T008 用例 5)
        rollbackQuietly(connection);
        active = false;
        throw new UnitOfWorkContractError(
          'async-callback',
          'run 的 callback 必须同步返回(SyncResult);thenable 结果即契约违约,事务已回滚',
        );
      }
      // 提交仅发生在 run 边界(T008 用例 1);COMMIT 失败同样整体回滚
      execBeginOrCommitWithBudget(connection, 'COMMIT', options.busyBudgetMs);
      active = false;
      return result as SyncResult<TResult>;
    } catch (err) {
      // 失败原样上抛、不吞不包装;全部参与者整体回滚(T008 用例 3)
      rollbackQuietly(connection);
      active = false;
      throw err;
    }
  };

  return { run };
}

/** Nest 装配令牌:UnitOfWork 经组合根以 txStores 工厂注册表方式绑定(useFactory),
 * 显式构造器注入消费;非全局 seam、无第二执行循环 */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
