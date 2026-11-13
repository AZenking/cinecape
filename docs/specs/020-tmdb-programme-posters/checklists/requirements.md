# Requirements Checklist: 020-tmdb-programme-posters

- [x] 规格含用户场景、独立测试、验收场景、边界情况。
- [x] 每条功能需求可客观判定（FR-001~FR-018）。
- [x] 成功标准可度量（SC-001~SC-010）。
- [x] Household 边界显式：`programme_poster.household_id`、代理按请求家庭解析。
- [x] 公开浏览/受控播放分离：海报不授予播放权限，不携带个人数据。
- [x] 隐私披露：标题外发、留空 Key 关闭、不发送个人数据。
- [x] TMDB 条款：缓存 ≤180 天、署名、非商业说明。
- [x] 迁移可逆：0012 up/down/drill + readiness/precheck 同步。
- [x] 安全负向：伪造/跨家庭/过期 ref 404；上游失败 502/504；未知字段 400；限频 429。
- [x] 读取路径零 TMDB API 调用。
- [x] 节流/预算/熔断明确（1 并发、150ms、300 次、90s）。
- [x] 失败不阻塞 EPG 刷新。
- [x] UI 回退链、懒加载、可访问性、语义 token。
- [x] CLI 回填与 dry-run。
- [x] 测试覆盖 domain/client/service/contract/migration/web。
- [x] 真实 TMDB 运行时证据需维护者提供 Key 后执行；未在自动化中伪造为已通过。