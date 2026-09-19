# mountRoot

Reference：需要从宿主启动一棵没有 Unit 父节点的树，并取得生命周期控制入口时使用 `mountRoot`。

## 使用场景

- 在应用或会话的组合入口挂载根配方，随后显式等待 ready、更新 props 或卸载。
- 已有 Unit 父节点时优先使用 `node.mount()` 或 [useChildren](use-children.md)，不要用另一个根冒充子节点。
- 根节点没有 Unit 父节点，不代表其响应式 scope 一定与外部隔离。

## 调用契约

```ts
mountRoot(
  recipe: KernelRecipe,
  props?: unknown,
  opts?: MountRootOptions,
): { node: UnitNode; handle: UnitHandle }
```

- 不要求处于同步 setup；调用本身同步执行配方 setup 并返回，不返回 Promise。
- `recipe` 是 Unit 配方，可带 `onMount(recipe, node)` 扩展；`props` 作为初始输入，`opts.scope` 可提供外部 `EffectScope`。
- 返回的 `node` 是具体 `UnitNode`；`handle` 是控制句柄，其 `node` 属性声明为 `NodeRef`，实际指向同一节点。
- `handle.ready()` 等待本节点登记的工作及子树 ready；`active` 只表示同步初始化已完成，不能替代这个等待。
- `handle.update(props)` 不重跑 setup；对象 props 更新浅响应式视图，详见 [createUnit](create-unit.md)。
- `await handle.unmount()` 才是完整卸载：先标记 `unmounted`、abort signal、停止 scope，再逆序卸载子节点、后进先出运行清理栈，最后等待登记工作并清空事件处理器。
- 同一节点重复或并发卸载复用底层卸载过程；子节点和清理栈中的错误会被收集为 `AggregateError`。

## 边界

- 节点使用 `effectScope()`，不是 detached scope。提供 `opts.scope` 时在该 scope 内创建；不提供时也可能隐式归属调用点当前激活的 scope。
- 外部 `scope.stop()` 只停止所属响应式 effect，不等同于 `unmount()`：它不改变 Unit 状态、不 abort 节点 signal，也不执行 Unit 清理栈。
- 已停止的显式 scope 无法挂载根；父 scope 停止后，即使句柄仍显示 `active`，也不能据此认为后续子挂载可用。
- setup 或 post-setup 队列同步抛错时，挂载会启动异步回滚卸载并重抛，不等待清理结束。
- `onMount` 在上述回滚的 catch 之外执行；它抛错时没有同样的自动回滚保证。
- async setup 的 Promise 不会自动成为 ready 条件；使用 [useReady](use-ready.md)，接入顺序见 [启动根节点](../how-to-guides/bootstrap.md)。
- 源码 `kernel/index.ts` 导出本函数及相关公开类型；底层 `mountChild`、`handleFor`、`runUnit` 虽从 `runtime.ts` 导出，却没有经该公共入口重导出，不能混作入口 API。

源码：见 [代码定位](source-map.md)，`kernel/runtime.ts` 的 `mountRoot`。
