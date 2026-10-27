# IDebugEventsService（debugEventsService）

- v2: `packages/agent-core-v2/src/features/debugEvents/debugEvents.ts`（接口约 31 行；实现 `debugEventsService.ts` 约 111 行，读 interface 与实现得出）
- 新架构: 无对应

## 能力对照

- [ ] `subscriptions()`：遍历 scope 树收集事件订阅清单（scopePath/unit/uid/label/kind）— 决策先不做；新栈 kernel 无 ledger/unitBook 观测口，两个包内找不到等价物
- [ ] 事件总线快照：各 scope `IEventBus` 的监听计数（all/perType/perAgent）与全局 `IEventService` 监听数 — 同上，决策先不做
- [ ] 对外观测面：经 kap-server `/api/v1/debug` 通用 service RPC（`rpc('core', IDebugEventsService, 'subscriptions')`）供 kimi-inspect 的 DI/Service 面板消费 — 归属 kap-server/宿主层的调试反射面，随本服务一起未迁

备注：v2 由 `DebugEventsFeature` 在 App scope 注册（OnScopeCreated 激活），`agent-core-v2/src/index.ts` 导出了实现；新栈迁移观测面时建议改由 kernel 的 Unit 树直接出快照，而非恢复 DI 遍历。

## 结论

未对齐 3 项——决策先不做：运行时事件订阅与事件总线的调试观测能力整体未迁，新栈需另立 kernel 观测口后才有承载。
