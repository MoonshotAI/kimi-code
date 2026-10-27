# IPluginService（pluginService）

- v2: `packages/agent-core-v2/src/app/plugin/plugin.ts`（约 70 行 interface）
- 新架构: `packages/harness-core/src/features/plugin/`

## 能力对照

- [x] listPlugins/installPlugin（git/URL/本地三源 + marketplace 目录浏览）→ `packages/harness-core/src/features/plugin/face.ts` 的 PluginFace + acquire/（archive/github/marketplace/source）+ `packages/harness-core/src/feature-http/route-features/plugin.ts`（plugins.marketplace 路由）
- [x] setPluginEnabled/removePlugin/reloadPlugins/getPluginInfo → PluginFace 同名方法 + plugins.action 路由
- [x] setPluginMcpServerEnabled/checkUpdates → PluginFace 同名方法
- [x] 贡献面：pluginSkillRoots/pluginAgentRoots/enabledSessionStarts/enabledSystemPrompts/enabledMcpServers/mcpServerEntries/enabledHooks/listPluginCommands → PluginFace 同名方法 + contribute/（mcp、skills）
- [x] onDidReload/onDidMutate 事件 → face.ts 的 plugin.changed/plugin.mutated 运行时事件 + lastMutation/lastReload ref
- [x] hasLoadedSnapshot → PluginFace.hasLoadedSnapshot
- [ ] enabledPluginIds（启用插件 id 列表，v2 供遥测 enabled_plugins 上下文）— 未迁：新栈 PluginFace 无该访问器；属遥测上下文缺口，随 telemetry 域记录在案

## 结论

未对齐 1 项——插件安装/启停/贡献/事件主能力全部对齐；仅遥测用的 enabledPluginIds 访问器未迁。
