# 等初始化完成后再挂载孩子

How-to：用 `useReady` 登记异步条件，用显式响应式门控阻止依赖尚未就绪的子节点提前 setup。

## 前提

`initialize(signal)` 返回初始化 Promise，并尽可能支持取消；`child` 是依赖初始化结果的子配方。所有 hooks 都在同步 setup 中调用。

## 实现

```ts
interface ParentProps {
  initialize(signal: AbortSignal): Promise<void>;
  child: KernelRecipe;
}

const Parent = createUnit<ParentProps>('parent', (props) => {
  const node = useNode();
  const initialized = ref(false);

  useReady(props.initialize(node.signal).then(() => {
    if (!node.signal.aborted) initialized.value = true;
  }));

  useChildren(() => initialized.value
    ? [{ key: 'child', recipe: props.child }]
    : []);
});
```

1. 在 await 之前捕获 node、服务和需要的回调。
2. 初始化成功后再打开子节点列表。
3. 在成功回调检查 `signal.aborted`，避免卸载后的迟到结果继续挂载。
4. 宿主等待 `handle.ready()`；失败后由宿主关闭整棵树。

## 不要混淆三个动作

| 动作 | 负责什么 | 不负责什么 |
|---|---|---|
| `useReady(operation)` | 把操作登记到就绪条件 | 不暂停 setup，不自动推迟子挂载 |
| `handle.ready()` | 等待自身和子节点的已登记条件 | 不发现任意未登记的后台 Promise |
| `node.signal` | 通知协作式取消 | 不强制终止底层异步工作 |

useReady 通过取消竞速避免卸载一直等待原操作，但原操作本身可能继续运行。需要真实停止时，将 signal 传到支持取消的 I/O，并在必要时显式登记资源清理。

## 避免等待环

不要让孩子的 ready 等待包含它自己的 `parent.ready()`。父 ready 本来就等孩子，会形成环。等自己那组 `useChildren()` 返回的 `ready()`，而不是整棵父树。

当前产品节点自己挂 feature slot：`SessionUnit.create()` 先 `await node.ready()`（此时还没有 agent 孩子，等于 session slot 就绪），再打开 journal 并挂 `AgentUnit`；`AgentUnit` 用自己的 `useFeatureSlot('agent').ready()` 门控 `actor.start()`。见 [代码定位](../reference/source-map.md)。

验收：初始化未完成时 child 不存在；失败时 ready 拒绝；卸载后初始化完成也不重新挂载孩子。
