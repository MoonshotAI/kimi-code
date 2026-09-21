# 12. 让兄弟节点接收即时事件

How-to：让接收者在共同父节点注册监听，接收发送者冒泡上来的事件，并把取消订阅归接收者所有。

## 路径

```text
Sender.fire(event) → Parent 的监听器 → Receiver 注册的业务回调
```

事件只沿「发送节点 → 根」的祖先路径传播，所以监听登记在 Parent：Receiver 自己的 useOn 只覆盖发到 Receiver 路径上的事件，兄弟的事件不在其中；Parent 收到事件后也不再向下广播。

## 实现接收者

```ts
interface ReceiverProps {
  receive(event: RuntimeEvent): void;
}

const Receiver = createUnit<ReceiverProps>('receiver', (props) => {
  const node = useNode();
  const parent = node.parent;
  if (parent === null) throw new Error('receiver requires a parent');

  const unsubscribe = parent.on('sender.message', (event) => {
    if (!node.signal.aborted) props.receive(event);
  });
  pushCleanup(node, unsubscribe);
});
```

1. 先挂载 Receiver，确保监听存在。
2. Sender 在 setup 中取得 `useFire()`，在后续业务中调用捕获的 fire，发送 `{ type: 'sender.message', ...payload }`。
3. 有多个来源时，用事件类型和显式上下文字段筛选；来源通过 EventContext 显式提供。
4. Receiver 卸载时取消 Parent 上的监听，不必卸载仍在工作的 Parent。

## 边界

- 事件是同步通知，不缓存、不重放；不能补发订阅前发生的事件。
- handler 里使用 setup 提前捕获的依赖（回调执行时不恢复 setup 上下文）。
- Parent handler 里重新 `parent.fire` 同一事件要带条件，无条件转发会递归触发自己。
- handler 抛错会中断当前 fire 调用；异步 handler 的 Promise 不由 fire 等待。
- Parent 是更广的订阅范围，包含其其他后代的事件；监听类型与 payload 需要业务约束。

验收：发送后收到一次；Receiver 卸载后再次发送不回调；未订阅期间的事件不会补发。

源码：见 [代码定位](../reference/source-map.md)，`kernel/runtime.ts` 的 `fire`、`on`、`pushCleanup`。
