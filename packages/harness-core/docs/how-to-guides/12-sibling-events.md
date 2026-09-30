# 12. 让兄弟节点接收即时事件

How-to：让接收者在共同父节点注册监听，接收发送者冒泡上来的事件，并把取消订阅归接收者所有。

## 路径

```text
Sender.fire(event) → Parent 的监听器 → Receiver 注册的业务回调
```

事件只沿「发送节点 → 根」的祖先路径传播，所以监听登记在 Parent：Receiver 自己的 useOn 只覆盖发到 Receiver 路径上的事件，兄弟的事件不在其中；Parent 收到事件后也不再向下广播。

## Feature slot：用 tier hook

Feature slot 的共同父节点就是所在 tier 的产品节点（app / session / agent），直接用对应 hook，一行完成「父节点订阅 + 取消归自己」：

```ts
const receiver = createFeature('receiver', {
  agent() {
    useOnAgent(sender, 'sender.message', (event) => {
      props.receive(event);
    });
  },
});
```

- `useOnApp` / `useOnSession` / `useOnAgent` 分别订阅 app / session / agent 节点；签名与 handle 的 `on` 相同——`useOnAgent(spec, 'type', handler)` 按 `FeatureSpec<E>` 推导事件类型，`useOnAgent(spec, '*', handler)` 按 `featureName.` 前缀过滤，也接受裸字符串。
- 各 hook 订阅的是「该 tier 节点能听到的一切」：本 tier slot 的事件加上更深 tier 冒泡上来的事件。`useOnSession` 因此能收到本 session 内所有 agent 的事件，payload 经 EventContext 自带 `sessionId` / `agentId`，按字段区分来源。
- 取消自动跟随当前 feature 卸载；越层调用（如 app slot 里调 `useOnAgent`）没有对应祖先 provider，直接抛错。
- 宿主在树外用 handle 的同一契约：`session.on(spec, 'type', handler)` / `session.wait(spec, 'type')`；agent handle（`session.get(id)` 的返回值）的 `on`/`wait` 首参分流——字符串是 actor 事件（`agent.on('turn.done')` 原语义不变），FeatureSpec 是 feature 事件：`session.get(id).on(spec, 'type', handler)`，不需要再碰 `.node`。

## 通用 Unit：在父节点登记

非 feature 的普通 Unit 没有 tier 保证，仍在共同父节点手动登记（`currentUnit` 取当前节点），并把取消订阅归接收者所有。Feature slot 不要手写这层，用上面的 tier hook：

```ts
interface ReceiverProps {
  receive(event: RuntimeEvent): void;
}

const Receiver = createUnit<ReceiverProps>('receiver', (props) => {
  const node = currentUnit();
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
