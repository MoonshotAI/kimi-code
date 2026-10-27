# IWorkspaceTrust（workspaceTrust）

- v2: `packages/agent-core-v2/src/workspace/workspaceTrust/workspaceTrust.ts`（约 24 行，读 interface 与 workspaceTrustService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/workspaces/`（trust 投影 + WorkspacesFace）

## 能力对照

- [x] 按 workspace root 持久化的信任状态（get/isTrusted）→ `packages/harness-core/src/features/workspaces/projection.ts` 的 WORKSPACE_TRUST_SET 记录与 trust 映射，`WorkspacesFace.getTrust/isTrusted`
- [x] trust()/untrust() 写回并持久化 → `WorkspacesFace.trust/untrust`（提交 workspace.trust.set 事件入 JSONL journal）
- [x] 变更事件（onDidChange）→ `workspace.trust.changed` 运行时事件（feature.ts fire）
- [x] HTTP 暴露 → `packages/harness-core/src/feature-http/route-features/workspaces.ts` 的 trust get/set/untrust 路由
- [x] 项目层 MCP 的信任门控消费 → `packages/harness-core/src/features/mcp/config/loader.ts` 的 trusted 入参（createMcp props.trusted，宿主注入）
- [ ] KIMI_CODE_TRUST_WORKSPACE 环境变量直通信任 — 未迁：新栈两包内无该 env 读取（仅 v2 与旧 CLI 文案中存在）
- [ ] trust 变更联动重载 project 层 MCP 与指令来源（v2 由 mcp 配置服务订阅 onDidChange）— 降级：新栈 createMcp 的 trusted 为创建期静态 prop，trust/untrust 后不会动态补载或卸载项目层配置

## 结论

未对齐 2 项——信任状态的记录、查询、改写、事件与 HTTP 面全部对齐；env 直通与「信任变化 → 门控内容动态生效」的联动未迁（trusted 静态注入）。
