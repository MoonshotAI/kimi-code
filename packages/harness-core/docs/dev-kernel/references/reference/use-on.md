# useOn

Reference：需要让事件订阅跟随当前 Unit 生命周期释放时，在 setup 中使用 `useOn`。

## 使用场景

- 在当前节点处理自身或后代发送、且传播路径经过本节点的事件。
- 不适合直接监听兄弟节点发出的事件；共同祖先订阅的所有权安排见 [兄弟事件](../how-to-guides/sibling-events.md)。

## 调用契约

```ts
useOn<E extends RuntimeEvent>(
  type: E['type'],
  handler: EventHandler<E>,
  opts?: { once?: boolean; capture?: boolean },
): void
```

- 必须在同步 setup 中登记；`type` 是具体事件类型字符串，`'*'` 表示匹配所有事件类型。
- `handler` 接收合并 `EventContext` 后的事件；运行时不做业务 payload 校验。
- `capture` 默认 `false`：默认参与从发送节点到根的 bubble 阶段，设为 `true` 则参与从根到发送节点的 capture 阶段。
- `once` 默认 `false`；设为 `true` 时，在处理器正常返回后移除该条订阅。
- 返回 `void`；hook 将取消订阅函数压入当前节点清理栈，卸载时自动取消。
- 同节点同阶段先派发具体类型，再派发通配符，各组按登记顺序调用。

## 边界

- 监听回调执行时不会恢复登记时的 setup 上下文；不要在回调里重新调用依赖当前 Unit 的 hook。
- 派发是同步的；抛错会传回发送者并打断后续派发，返回的 Promise 不被等待，详见 [useFire](use-fire.md)。
- `once` 在调用后才移除：处理器抛错时订阅仍在，同步重入发送也可能再次调用它；它不是重入锁。
- 避免将 `'*'` 用作发送的业务事件 type；当前派发同时查询具体类型表和通配表，会使未被移除的同组处理器重复执行。
- 提前取消或 setup 外登记时使用 `node.on(type, handler, opts)`；它返回可重复调用的 `Unsubscribe`。
- 直接 `node.on()` 不自动登记清理栈；目标节点完整卸载时仍会清空其处理器，但不能据此保证某个子所有者退出时就取消订阅。
- 在父节点上代为订阅时，把返回的取消函数登记到真正所有者的清理栈，否则可能持续到父节点卸载。
- 派发按处理器列表的快照遍历；派发中撤销某项订阅，不保证跳过本轮已进入快照的调用。
- 自动取消只移除订阅，不取消处理器已经启动的异步任务；相关资源仍需单独清理。

源码：见 [代码定位](source-map.md)，v3 `kernel/hooks.ts` 的 `useOn`。
