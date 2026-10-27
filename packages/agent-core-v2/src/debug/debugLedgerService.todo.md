# IDebugLedgerService（debugLedgerService）

- v2: `packages/agent-core-v2/src/debug/debugLedger.ts`（约 29 行，读 interface 得出）
- 新架构: 无对应

## 能力对照

- [ ] 作用域树与生命周期台账导出（tree()：unit 状态/everActive/inFlight 及 LedgerEntryInfo）— agent-core 与 harness-core 内无对应（已 Grep 核实），能力缺失；新栈 kernel 无台账（ledger）概念
- [ ] 层级作用域路径展示（DebugLedgerNode 的 path/label/children 树形结构）— 无对应；新栈 app/session/agent 三级 Unit 树不对外导出观测结构
- [ ] 资源条目追踪（LedgerEntryInfo：unit 持有资源的获取/释放明细）— 无对应；新栈资源清理由 useCleanup/onScopeDispose 内部承担，不留可查询台账

## 结论

未对齐 1 类：调试基建决策不迁，作用域台账观测能力（树导出、层级展示、资源条目）在新栈两个包内均无承载。
v2 侧该服务同样主要供 kap-server 调试端点与 kimi-inspect 消费，随宿主面一并留在旧栈。
