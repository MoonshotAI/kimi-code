# useReady

Reference：需要让宿主的 ready 等待包含某项异步初始化，同时保留同步 setup 时使用 `useReady`。

## 使用场景

- setup 中启动异步加载或准备工作，并把其完成条件加入本节点 readiness。
- 它不是阻塞子挂载的屏障，也不是底层异步任务的取消器。
- 需要等结果再创建子节点时，应另行控制挂载条件，见 [异步初始化](../how-to-guides/async-initialization.md)。

## 调用契约

```ts
useReady(operation: Promise<unknown>): void
```

- 必须在同步 setup 中登记；参数是已经取得的 Promise，不是供运行时调用的启动函数。
- 返回 `void`，不会返回任务句柄；宿主通过 `handle.ready()` 或 `node.ready()` 等待整个节点及其子树。
- setup 结束后仍可进入 `active`；没有单独的 `ready` 状态值。
- 等待逻辑会检查登记工作和子节点，直到本轮等待结束时没有未完成工作且子节点快照稳定；这不是对未来工作的永久保证。
- 若登记的竞速 Promise 拒绝，ready 随之拒绝，但节点状态不会变成 `failed`；失败的登记保留在待等待集合中，后续 ready 也不会自动重试或恢复。

输入：`initialize` 是接收 `AbortSignal`、返回 `Promise<void>` 的初始化函数。

```ts
const Feature = createUnit('feature', () => {
  const node = useNode();
  useReady(initialize(node.signal));
});
```

## 边界

- 不自动等待 async setup 的返回值；只登记显式传给本函数的 Promise，且 `await` 后调用 hook 不保留原 setup 上下文。
- 不暂停 setup，不阻止 `node.mount()` 或 [useChildren](use-children.md) 挂载；子节点可能在父节点初始化完成前执行。
- 登记的是原 Promise 与节点 abort 通知的竞速；abort 可以解除这项等待，但不会取消原 Promise、停止其副作用或撤回已写入的数据。
- 真正停止底层操作，需要操作自行响应 `node.signal` 或另行安排取消机制；卸载期间不应继续发布初始化结果。
- abort 监听器在登记的竞速结束后移除；节点卸载后，节点的 `ready()` 会拒绝，而非把卸载视为成功就绪。
- `NodeRef` 没有等价的登记方法；具体 `UnitNode.trackReady()` 只是直接跟踪 Promise，没有本 hook 的 abort 竞速包装，不应混同。

源码：见 [代码定位](source-map.md)，v3 `kernel/hooks.ts` 的 `useReady`。
