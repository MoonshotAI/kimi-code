# setup 调用边界

Reference：先区分依赖当前 Unit 的 hooks 与不依赖上下文的定义、启动和实例操作。

## 调用位置

| API | 调用位置 |
|---|---|
| `createUnit` | 任意普通代码；通常在模块顶层定义配方 |
| `mountRoot` | 宿主启动层；不需要当前 Unit |
| `useNode`、`useReady`、`useExpose` | 当前 Unit 的同步 setup 调用链 |
| `provide`、`inject` | 当前 Unit 的同步 setup 调用链；或 `asUnit(node, fn)` 里的同步回调 |
| `asUnit` | 任意持有 Node 的代码；只压栈，不重跑 setup。给 HTTP handler 这类稍后回调恢复 `inject` |
| `useFire`、`useOn` | 当前 Unit 的同步 setup 调用链 |
| `useContribute`、`useCollection` | 当前 Unit 的同步 setup 调用链 |
| `useChildren` | 当前 Unit 的同步 setup 调用链 |
| `node.*`、`handle.*` | 持有实例后显式调用；仍需遵守存续和清理约束 |

## 上下文由同步调用栈决定

`runUnit` 在调用 setup 前压入当前 Node，返回时弹出。setup 同步调用的 helper 可以使用 hooks；不要求代码字面上嵌套在 setup 中。

不要在 `await` 后、定时器、事件处理器或后续 watch 回调里重新调用 hooks。这些回调没有保留原 Node 的上下文；即使碰巧存在当前 Unit，也可能是别的节点。HTTP handler 由 `useHttpRoute` 包在 `asUnit` 里，因此可以同步 `inject` / `useApp` / `useSession` / `useAgent`；按 id 用 `useApp().get(id)`，不要 `useSession(id)`。`await` 之后栈已弹出，不要再调 hooks。`asUnit` 只恢复查找，不要在里面 `useReady` / `useOn` / `useHttpRoute`。

```ts
const Worker = createUnit('worker', () => {
  const node = useNode();
  const fire = useFire();
  useReady(initialize(node.signal).then(() => {
    if (!node.signal.aborted) fire({ type: 'worker.ready' });
  }));
});
```

片段中的 `initialize(signal)` 是调用方提供的异步初始化函数。异步阶段使用捕获的 `node`、`fire`，不要再次调用 hooks。

## 返回值与后续使用

- `useFire()` 返回的函数可以稍后调用；注意所属节点是否已卸载。
- `useCollection()` 返回的 computed 可以稍后读取；它不是重新执行 hook。
- `useChildren()` 只需注册一次，外层通过响应式数据源改变期望子节点。
- `useReady(promise)` 登记条件；`handle.ready()` 等待条件。两者不是内外版本的同一种操作。
- 当前 runtime 不等待 async setup 返回的 Promise；不要把 `async setup` 当成初始化契约。

## EffectScope 上下文不等于 Unit 上下文

`node.scope.run(...)` 能建立 Vue effect 归属，但不会压入 `unitStack`。它不能让 setup 外的 `inject()` 或 `useOn()` 合法；需要使用显式的 `node.resolve()`、`node.on()`。

继续阅读：[命名](naming.md)、[异步初始化](../how-to-guides/async-initialization.md)、[启动层](../how-to-guides/bootstrap.md)。

源码：见 [代码定位](source-map.md)，`kernel/runtime.ts` 的 `currentUnit`、`runUnit`；v3 各 hook 在 `kernel/hooks.ts`。
