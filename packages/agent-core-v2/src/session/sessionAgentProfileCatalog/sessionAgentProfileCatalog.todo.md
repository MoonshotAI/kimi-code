# ISessionAgentProfileCatalog（sessionAgentProfileCatalog）

- v2: `packages/agent-core-v2/src/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog.ts`（约 33 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/profiles/feature.ts`（`ProfileCatalogRef`）

## 能力对照

- [x] ready / get / getDefault / list → `packages/harness-core/src/features/profiles/feature.ts`（`ProfileCatalogFace` 同名方法）
- [x] inspect（含 suppressed 候选与原因）→ `packages/harness-core/src/features/profiles/catalog/catalog.ts`（`buildCatalogView` 生成 `AgentProfileInspection`，含 priority/builtin-override-required 抑制原因）
- [x] load/reload（多来源目录加载：builtin/user/workspace/extra/explicit）→ `packages/harness-core/src/features/profiles/feature.ts`（finder 编排 + `reload: () => queueRebuild()`）
- [ ] 变更通知与热加载（onDidChange；文件变更后消费方自动刷新）— 部分对齐：`ProfileCatalogFace.onDidChange` 已补（每次目录重建后通知；spawn 的子代理目录变化提醒经此订阅，见 `packages/agent-core-v2/src/agent/changeNotifier/agentChangeNotifierService.done.md`）；finder 文件监听仍无，`reload` 仅按需触发，agent 文件编辑后仍不会自动生效

## 结论

未对齐 1 项——finder 无文件监听，profile 热加载降级为手动 reload；facade 变更事件已对齐（onDidChange）。
