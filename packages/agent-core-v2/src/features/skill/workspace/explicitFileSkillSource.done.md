# IExplicitFileSkillSource（explicitFileSkillSource）

- v2: `packages/agent-core-v2/src/features/skill/workspace/explicitFileSkillSource.ts`（约 41 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/skill/sources/files.ts`

## 能力对照

- [x] 显式技能目录源（id=explicit、user 优先级）：扫描 --skill-dir 传入的目录 → `packages/harness-core/src/features/skill/sources/files.ts`（createExplicitSkillSource；explicitDirs 由 CreateSkillProps 注入，取代 IBootstrapService.args）
- [x] 无显式目录时返回空贡献 → 同文件（explicitDirs 为空返回 { skills: [] }）
- [x] 目录解析语义（相对工作目录解析、~ 展开、source 标记为 user） → `packages/harness-core/src/features/skill/catalog/roots.ts`（configuredRoots）

## 结论

全部对齐。
