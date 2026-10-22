# IEventDispatcher（eventDispatcher）

- v2: `packages/agent-core-v2/src/state/eventDispatcher.ts`（约 41 行，读 interface 得出）
- 新架构: `packages/harness-core/src/composition-api/hooks.ts`（useFire/useOn）+ `packages/harness-core/src/runtime/stores.ts`（useFeatureStore/onCommit）

## 能力对照

- [x] 事件分发（dispatch(event) 投递给各参与者）→ `packages/harness-core/src/composition-api/hooks.ts` 的 useFire/useOn（Unit 节点 fire + 冒泡订阅）
- [x] 持久参与者挂载与折叠（attach/attachLate + DurableAgentRuntimeParticipant.transition/commit）→ `packages/agent-core/src/store/replica.ts` 的 Projection/View + `packages/harness-core/src/runtime/stores.ts` 的 useFeatureStore（dispatch → writer.commit → 投影折叠）
- [x] 恢复（restore / restorePhase / onDidRestore 钩子）→ `packages/agent-core/src/store/writer.ts` 的 openWriter 懒加载重放（jsonl 逐行 decodeCommit 折叠 replica），session 域再经 loopProjection 水合
- [x] 冲刷（flush）→ writer.ts 的 commit 可 await / writer.close 等待挂起写
- [x] 提交后事件桥（v2 dispatch 同步落日志）→ stores.ts 的 onCommit 监听桥（commit 发布后通知 listener）

## 结论

全部对齐：事件溯源分发器被「kernel 事件冒泡 + agent-core store 提交/投影 + runtime onCommit 桥」的机制组合取代，分发/持久化/恢复/冲刷语义均有承载。
