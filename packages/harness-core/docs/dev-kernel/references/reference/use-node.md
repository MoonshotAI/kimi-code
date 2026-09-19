# useNode

Reference：需要在 setup 中取得当前具体节点，并保存显式操作入口供后续回调使用时使用 `useNode`。

## 使用场景

- 在同步 setup 中取得节点的 `signal`，或挂载子节点、注册清理、访问显式节点方法。
- 只需服务、集合或事件时，优先使用相应 hook；不要为取一个值而依赖所有节点内部状态。
- 它不是在任意异步回调里查找“所属 Unit”的全局定位器。

## 调用契约

```ts
useNode(): UnitNode
```

- 必须在当前 Unit 的同步 setup 调用链内执行；没有当前 Unit 时抛出 `hook called outside of a unit setup`。
- 返回当前栈顶的具体 `UnitNode`，没有创建新节点，也没有创建句柄。
- `ctx.node` 与 `handle.node` 的声明类型是 `NodeRef`：包含 `signal`、父引用和节点操作，不暴露完整实现字段。
- `UnitNode` 实现 `NodeRef`，另有 `children`、`state`、`scope`、清理栈等具体实现成员。
- `UnitHandle` 是另一种控制接口，包含 `update()`、`ready()`、`unmount()`；`useNode()` 返回值没有 `update()`，详见 [节点与句柄](node-handle.md)。
- 在 setup 中保存的节点可以在后续回调中调用显式方法；这不会恢复当前 Unit 栈，也不会自动把回调中的新 watcher 纳入该节点 scope。

## 边界

- 当前 Unit 不跨 `await`、计时器或事件回调传播；异步代码先同步取得节点，再使用其方法，见 [setup 上下文](setup-context.md)。
- `node.provide()` 返回撤销函数，并自动将撤销登记到目标节点；直接调用也会在目标节点卸载时撤销。
- `node.on()` 返回取消订阅函数，但不登记清理栈；目标节点完整卸载时会清空处理器。需要更早或随其他所有者释放时，显式登记取消函数。
- `node.contribute()` 返回撤销函数，却不自动登记清理，也不在卸载时清空贡献表；不要把它与 [useContribute](use-contribute.md) 的所有权保证混同。
- `node.resolve()` 是调用时解析，`node.fold()` 是调用时集合快照；它们分别不是动态注入绑定和 computed 包装。
- `node.mount()` 会建立子节点 scope 和 setup 上下文；父节点已卸载或 scope 已停止时不能挂载。
- 不要把 `scope.stop()` 当作节点卸载，也不要依赖卸载后的节点方法普遍拒绝调用；并非所有方法都检查生命周期状态。
- 取得节点本身无需清理；资源仍须由其所属 API 或清理栈管理，见 [资源清理](../how-to-guides/cleanup-resources.md)。
- 源码 `kernel/index.ts` 重导出 `UnitNode`、`useNode`、`pushCleanup`、`removeCleanup`；`removeCleanup` 只移除登记，不执行 cleanup。`StackEntry` 类型仅由底层 `runtime.ts` 导出。

源码：见 [代码定位](source-map.md)，v3 `kernel/hooks.ts` 的 `useNode`。
