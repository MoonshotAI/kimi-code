# IDebugGraphService（debugGraphService）

- v2: `packages/agent-core-v2/src/debug/debugGraph.ts`（约 30 行，读 interface 得出）
- 新架构: 无对应

## 能力对照

- [ ] DI 依赖图导出（graph()：节点 token/scopePath/uid/state 与依赖边 kind）— agent-core 与 harness-core 内无对应（已 Grep 核实），能力缺失；新栈 kernel 的 Unit 依赖由 token 注入静态声明，无运行时图导出服务
- [ ] 依赖边分类（DependencyEdgeKind：instance/collection/ref 三类边）— 无对应；新栈贡献集合与 facade 注入为 kernel 原语，不暴露图结构
- [ ] 节点运行态标注（UnitState/uid 随图输出）— 无对应，随调试基建整体不迁

## 结论

未对齐 1 类：调试基建决策不迁，DI 依赖图观测能力（图导出、边分类、节点态标注）在新栈两个包内均无承载。
v2 侧该服务的主要消费方为 kap-server 调试端点与 kimi-inspect 的 DI 视图，随宿主面一并留在旧栈。
