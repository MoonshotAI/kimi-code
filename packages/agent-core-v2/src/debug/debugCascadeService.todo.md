# IDebugCascadeService（debugCascadeService）

- v2: `packages/agent-core-v2/src/debug/debugCascade.ts`（约 63 行，读 interface 得出）
- 新架构: 无对应

## 能力对照

- [ ] 级联重建历史查询（history()：scope 内 unit 的 tornDown/rebuilt/failed 与耗时）— agent-core 与 harness-core 内无对应（已 Grep 核实无 DebugCascade 等承载），能力缺失
- [ ] 待决/失败 unit 分组查询（pending()：waiting 与 missing 依赖）— 无对应
- [ ] 调试态强制操作（unprovide / update / dispose 单个 unit）— 无对应
- [ ] DI unit 状态变更事件（DiUnitChanged / event.di.unit_changed）— 无对应；debugEvents feature 亦决策先不做

## 结论

未对齐 1 类：调试基建整体决策不迁（DI 调试面板随 v2 DI 框架一并废弃，新栈无等价观测面）。
