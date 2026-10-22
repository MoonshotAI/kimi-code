# ITowerFindingTool（towerFindingTool）

- v2: `packages/agent-core-v2/src/features/tower/tools/finding/finding.ts`（23 行，实现见同目录 findingTool.ts，50 行）
- 新架构: `packages/harness-core/src/features/tower/tools/finding.ts`（createTowerFindingTool）

## 能力对照

- [x] 输入 schema 逐字段一致（type/title/severity/summary/location/details/suggested_fix，strict）→ `packages/harness-core/src/features/tower/tools/finding.ts`（TowerFindingToolInputSchema）
- [x] 以 roster 名归档 finding 并返回文件路径，输出同一提示文案 → 同文件 execute + `packages/harness-core/src/features/tower/protocol/store.ts`（fileFinding）
- [x] 工具描述 md 逐字相同 → `packages/harness-core/src/features/tower/tools/finding.md`（与 v2 finding.md diff 为空）
- [x] 协议错误兜底（TowerProtocolError/GitError → isError 文本）→ `packages/harness-core/src/features/tower/tools/support.ts`（runTowerTool）

## 结论

全部对齐——schema、实现行为、描述文本与错误兜底逐一相同。
