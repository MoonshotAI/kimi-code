# IRestGateway（restGateway）

- v2: `packages/agent-core-v2/src/app/gateway/gateway.ts`（约 33 行 interface，实现 gatewayService.ts 约 111 行，一并读过；全接口当前仅测试引用）
- 新架构: `packages/harness-core/src/feature-http/`（REST 路由群）

## 能力对照

- [x] prompt（提交用户输入并等待 turn 启动返回 turn_id）→ `packages/harness-core/src/feature-http/route-builtin/prompts.ts` 的 prompts.submit 路由
- [x] steer（运行中插入用户输入）→ 同文件 prompts.steerMany / prompts.action（steer）路由
- [x] cancel（取消当前 turn）→ 同文件 prompts.action（abort）路由
- [x] getStatus（会话存活状态）→ `packages/harness-core/src/feature-http/route-features/status.ts` 的 sessions.status 路由
- [ ] flushLogs/flushGlobalLogs（按需冲刷会话/全局文本日志）— 归属宿主层未迁：新栈两包无文本日志服务，仅 sessionExport 路径在导出前 flush agent journal（`packages/harness-core/src/features/sessionExport/feature.ts` 约 45 行）；且 v2 侧这两方法在当前仓库无消费方

## 结论

未对齐 1 项——prompt/steer/cancel/status 已由 feature-http 路由承载；日志 flush 面归属宿主层。
