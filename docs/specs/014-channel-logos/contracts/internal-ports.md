# Internal Ports & Boundaries: 014-channel-logos

日期：2026-11-07。Proposed 设计。原则：宪章技术约束 6（DDD 依赖向内、跨上下文只经显式发布接口/共享契约）；实施期以 tasks 冻结精确 seam，本文锁定边界方向与方法面形状。

## 1. 域所有权

| 域 | 拥有 | 说明 |
| --- | --- | --- |
| media-catalog | `channel_logo` 注册表语义、引用签发/解析、代理用例、`media_item.poster_ref` 写入 | Logo 是媒体身份属性（title/description/poster_ref 同族）；仓储与代理服务在本域 infrastructure/application |
| sources | M3U 解析捕获、`source_entry.logo_url` 写入、IPTV 发布时的胜者合并调用 | 通过 media-catalog 发布参与者（事务镜像）写注册表，不直写他域 SQL |
| epg | XMLTV 解析捕获、`epg_channel.icon_url` 写入、EPG 发布时的受限合并调用 | 同上；「受限」= 只填补/撤销 epg 来源胜者（data-model M3/M4） |
| live-tv | **零变更** | posterRef 已在其投影中透传（live-projection/live.controller）；不感知 Logo 机制 |
| platform | SafeUpstream 端口复用、迁移执行器 | 无新增平台件 |

## 2. 发布参与者（media-catalog 事务镜像扩展）

沿既有 `DrizzleMediaCatalogTxParticipants`（transaction-participants.ts，事务绑定 binding 注入、同事务执行）模式，新增镜像方法面（签名形状，实施可调参数名）：

```text
// 胜者读取（合并判定输入）
findChannelLogo(householdId, mediaId): { ref, upstreamUrl, sourceKind, sourceId, revision, revokedAt } | undefined

// 胜者写入/撤销（data-model M1–M4 的原子执行体）
upsertChannelLogoWinner(command: {
  householdId; mediaId; upstreamUrl; sourceKind; sourceId;  // url 不变且 active 同源 ⇒ 无操作不换 ref
}): { ref: string }        // 返回生效引用（新签发或既有），发布方据此写 media_item.poster_ref
revokeChannelLogo(householdId, mediaId, nowIso): void   // 转墓碑（清 upstream_url、置 revoked_at）
gcExpiredChannelLogoTombstones(householdId, olderThanIso): void  // 发布事务内集合 DELETE

// media_item.poster_ref 落值（既有 updateDerivedPresentation 同风格）
setChannelPosterRef(householdId, mediaId, ref: string | null): void
```

规则：
- 引用签发（随机 128-bit hex）在参与者内完成，保证「签发 + 写 poster_ref」同事务同域。
- 发布方（sources/epg）**不感知** ref 值语义，只接收「要写到 media_item.poster_ref 的值」。
- 墓碑 GC 在每次发布事务内顺带执行（集合 DELETE），无后台任务（plan Constraints）。

## 3. 解析端口（代理用例）

```text
// media-catalog application：LogoProxyService（暂名）
resolveForHousehold(householdId, logoRef): { upstreamUrl, mediaId } | 'revoked' | undefined
//   undefined  → 404 同形；'revoked' → 410；命中 → 交给 SafeUpstream 有界读取
fetchLogoBytes(upstreamUrl): { contentType, bytes }   // 预算常量复用 010 VOD_POSTER_BUDGETS 数值
```

- 错误映射（404/410/502/504）在应用层完成（DomainError + 新 ProblemCode），接口层只透传。
- SafeUpstream 端口原样复用（`SafeUpstreamPort.read`，byteBudget/timeBudgets 参数形状同 poster.service 用法）；许可列表沿用部署既有 `allowedTargets` 口径。
- 不新增缓存组件；字节回传即弃。

## 4. 跨上下文发布时序

**IPTV 刷新发布事务**（sources 主导，既有事务边界）：
```text
写 source_entry（含 logo_url）→ 写 media_item（新频道）→ 对受影响频道逐批：
  findChannelLogo → 按 M1/M2 合并（upsert/revoke）→ setChannelPosterRef → GC 墓碑 → bump catalog revision（既有）
```

**EPG 刷新发布事务**（epg 主导）：
```text
写 epg_channel（含 icon_url）/ epg_programme → 计算受影响且已绑定频道集合
（绑定谓词与 live-projection 的 upstream 精确匹配同源；实施期复用其判定核心，禁止复制第三份逻辑）
→ 按 M3/M4 合并（受限：绝不覆盖 iptv 胜者）→ setChannelPosterRef → GC 墓碑
```

- 两个发布路径都只触碰自己域的原始列 + 经参与者触碰注册表；不存在跨域直写他域表。
- 发布失败回滚 = 事务整体回滚，无半状态（对齐「幂等性与数据一致性」约束）。

## 5. 禁止事项（负向边界，违者视为违宪缺陷）

- 任何公共 DTO/投影/日志输出 `source_entry.logo_url`、`epg_channel.icon_url`、`channel_logo.upstream_url`。
- live-tv 或其他域直查 channel_logo 表（必须经参与者/解析端口）。
- 客户端提交的任何字段参与家庭边界判定。
- 跳过发布事务直接改 media_item.poster_ref。
