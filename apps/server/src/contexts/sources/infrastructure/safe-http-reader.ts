/**
 * 010 T018 — 兼容门面:本模块的 SSRF 安全受控远程 HTTP 读取器实现已原样提取至
 * platform 层(`@platform/upstream/safe-upstream-reader`),供 sources/online-vod/
 * playback 复用(internal-ports.md §1 SafeUpstreamPort 行)。
 *
 * 本文件保留原路径与全部既有导出(TARGET_DENIED…REMOTE_UNREACHABLE、
 * RemoteReadFailure、RemoteDnsResolver/RemoteReadClock、RemoteSourceStream、
 * OpenRemoteSourceOptions、openRemoteSource),经 `export *` 薄委托到新位置:
 * - 旧消费方(refresh-executor 等)与既有测试(imports/safe-http-reader.spec.ts)
 *   的导入路径与行为零变化(默认时间预算仍 = IMPORT_BUDGETS.NET_*);
 * - 新增可选项(timeBudgets/maxBytes 等已存在的注入面)向后兼容;
 * - 行为回归对照见 test/unit/online-vod/safe-upstream.spec.ts「旧 sources 行为回归」。
 * 禁止在本上下文重新实现传输/校验逻辑;后续修改一律落 platform 层。
 */
export * from '@platform/upstream/safe-upstream-reader';
