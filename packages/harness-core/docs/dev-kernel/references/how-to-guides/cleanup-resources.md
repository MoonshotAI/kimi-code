# 绑定非响应式资源的清理

How-to：为每项订阅、计时器和外部句柄指定所有者，把释放动作登记到该 Node，而不是只依赖 EffectScope。

## 选择清理方式

| 资源 | 释放方式 |
|---|---|
| setup 中创建的 Vue watcher | 由节点 scope 停止 |
| 单个 setup 资源 | 从 setup 返回清理函数 |
| 多个资源或可异步关闭的资源 | `pushCleanup(node, cleanup)` |
| 外部节点上的监听 | 将 `node.on()` 返回的 unsubscribe 登记到真正的订阅者 |
| 支持取消的异步 I/O | 传入 `node.signal`，必要时再登记关闭动作 |

## 按获取顺序登记

下面的 `openResource()`、`onChange` 由调用方提供；资源的 subscribe 返回取消函数，close 可以返回 Promise。

```ts
const Consumer = createUnit('consumer', () => {
  const node = useNode();
  const resource = openResource();
  pushCleanup(node, () => resource.close());
  pushCleanup(node, resource.subscribe(onChange));
});
```

cleanup 后进先出：先取消订阅，再关闭资源。注册完资源就立即登记清理，避免后续 setup 抛错时丢失释放动作。

## 跨节点注册的所有权

`parent.on(...)` 的监听存放在 Parent，不代表应活到 Parent 卸载。若订阅者是 Child，应把取消函数压入 Child 的栈。向 Parent 发布 provider 也一样：`parent.provide(...)` 自带 Parent 清理，但子提供者还应登记返回的 withdraw。

`useOn`、`useContribute` 已把撤销绑定到当前节点；低层 `node.on`、`node.contribute` 不提供相同的调用者归属封装。

## 退出与提前释放

- 宿主等待 `handle.unmount()`；不要只调用外部 scope.stop。
- 父节点先递归卸载孩子，再执行自己的 cleanup，因此孩子释放时父资源尚未进入显式 cleanup 阶段。
- cleanup 可以异步；收集到的清理错误以 AggregateError 报告。
- 提前释放资源时注意避免卸载时重复释放；可使用幂等释放函数，或用 `removeCleanup` 移除对应登记。removeCleanup 本身不执行释放。
- setup 返回函数会被当成 cleanup；不要为“导出业务 action”而直接返回一个函数。
- `signal.aborted` 只表示取消已发出，不表示外部工作已经全部退出。

验收：每项非响应式资源都有明确清理路径；子卸载不会留下父级订阅；宿主确实等待卸载完成。

源码：见 [代码定位](../reference/source-map.md)，`kernel/runtime.ts` 的 `pushCleanup`、`removeCleanup`、`runUnit`、`performUnmount`。
