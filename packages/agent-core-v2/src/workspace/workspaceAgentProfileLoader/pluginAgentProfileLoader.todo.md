# IPluginAgentProfileLoader（pluginAgentProfileLoader）

- v2: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader.ts`（约 10 行，读 interface 与 pluginAgentProfileLoaderService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/profiles/discovery/finder.ts`（useProfileFinder 贡献点）+ `packages/harness-core/src/features/plugin/face.ts`（pluginAgentRoots）

## 能力对照

- [x] 插件 agent 根目录来源 → `packages/harness-core/src/features/plugin/face.ts` 的 `PluginRef.pluginAgentRoots()`（state/manager.ts 从启用插件 manifest 的 agents 字段解析）
- [x] finder 贡献机制与优先级位 → `packages/harness-core/src/features/profiles/discovery/finder.ts` 的 `useProfileFinder` 贡献点，`PRIORITY.plugin = 5` 已在 `packages/harness-core/src/features/spawn/profile.ts` 预留
- [ ] 插件 agent profile 实际进入目录 — 缺失（未接线）：harness-core 内没有任何单元把 pluginAgentRoots 包装成 ProfileFinder 注册（plugin feature 只贡献 skill/mcp/hook 源），插件声明的 agent 文件当前不会出现在 ProfileCatalog 中
- [ ] 插件 reload 联动 profile 重载（v2 订阅 IPluginService.onDidReload 触发 reload）— 随上项一并缺失

## 结论

未对齐 2 项——根目录来源与贡献机制都在，但插件 agent profile 的 finder 接线（含 reload 联动）尚未做，能力当前缺失。
