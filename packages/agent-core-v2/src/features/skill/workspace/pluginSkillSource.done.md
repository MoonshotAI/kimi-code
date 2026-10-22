# IPluginSkillSource（pluginSkillSource）

- v2: `packages/agent-core-v2/src/features/skill/workspace/pluginSkillSource.ts`（约 42 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/plugin/contribute/skills.ts`

## 能力对照

- [x] 插件技能源（id=plugin、优先级 plugin）：扫描插件提供的技能根 → `packages/harness-core/src/features/plugin/contribute/skills.ts`（createPluginSkillSource；roots 由 plugin service 提供）
- [x] 插件重载后源失效并刷新（v2 为 IPluginService.onDidReload → onDidChange） → `packages/harness-core/src/features/plugin/feature.ts`（onReload 触发 refreshSkillIndex + changeListeners）与同文件 onDidChange 透传
- [x] 插件技能命名空间去重（plugin id + 规范化技能名） → `packages/harness-core/src/features/plugin/contribute/skills.ts`（pluginSkillKey）
- [x] 源接入技能目录 → `packages/harness-core/src/features/plugin/feature.ts`（useSkillSource(skillSource.source) 贡献接通）

## 结论

全部对齐；已由 plugin feature 的 useSkillSource 贡献接通。
