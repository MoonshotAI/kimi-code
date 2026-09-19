# useChildren

Reference：需要根据响应式列表保留、更新或替换子 Unit 时，在父节点 setup 中使用 `useChildren`。

## 使用场景

- 用稳定 key 表达一组动态子节点，让列表变化驱动挂载与卸载。
- 只做一次命令式挂载、且需要直接保存子句柄时，可用 `node.mount()`；它没有列表协调规则。
- 不适合依赖列表重排来改变已挂载节点顺序，或依赖 props 更新重跑 setup。

## 调用契约

```ts
useChildren(
  source: MaybeRefOrGetter<Array<ChildEntry | null>>,
): { ready(): Promise<void> }
```

- 必须在同步 setup 中调用；`source` 可是数组、ref 或 getter。内部 `watchEffect` 首次即求值，之后根据读到的响应式依赖重新协调。
- `ChildEntry` 含字符串 `key`、`KernelRecipe` 类型的 `recipe`，以及可选的 `props: unknown`；`null` 项被忽略。
- 同一次调用的一轮列表中 key 不得重复，否则抛错；没有按 recipe 名称自动生成 key 的行为。
- 子节点身份由 key 与配方对象 identity 共同决定；key 相同且 `recipe` 是同一对象才保留实例，等名新配方也会替换。
- 保留实例时，仅在 `Object.is(旧 props, 新 props)` 为 false 时调用 `handle.update()`；这不重跑 setup。
- 返回值只有 `ready()`，没有子句柄列表、停止函数或逐项撤销函数。
- 返回的 `ready()` 等待该管理器的待处理卸载及所管理子节点 ready，并检查集合稳定；父节点自己的 `handle.ready()` 还覆盖父节点登记工作和其他子节点。

输入：`Child` 是预先创建、identity 稳定且不需要 props 的配方，`enabled` 是 `Ref<boolean>`；下列调用位于父节点同步 setup 内。

```ts
useChildren(() => enabled.value
  ? [{ key: 'child', recipe: Child }]
  : []);
```

## 边界

- 首轮协调可以在父 setup 尚未返回时挂载子节点；[useReady](use-ready.md) 不会自动阻止这一过程，异步条件须显式体现在 source 中。
- 每轮先找出消失或配方变化的旧项，并等待所有这些节点完成卸载，再进行新挂载或 props 更新；不只是单个替换项等待自己的旧节点。
- 等待卸载期间，source 仍可更新期望列表；卸载完成后按最新期望协调，不逐个回放中间版本。
- 如果某次卸载拒绝，协调停留在失败的 pending 状态，没有自动重试；该管理器和父节点的 ready 都会观察到失败。
- 同 key、同配方项只改变排列时不会重排现有 `children`；实际树顺序仍受挂载顺序影响，见 [Unit 树](../explanation/unit-tree.md)。
- 复用同一个 props 引用不会触发 `update()`；初始和新 props 都为对象时，update 修改既有浅响应式视图。原始值 props 的 setup 入参不会更新。
- 普通数组或普通对象变化不一定触发 watch；应让 source 读取所需的响应式依赖，并以新 props 对象表达需要同步的输入变化。
- 父节点卸载会停止内部 watcher 并卸载子树，无需额外 stop；仅停止外部 scope 不等于卸载 Unit，仍需显式 `unmount()`。
- 源码 `kernel/index.ts` 重导出 `useChildren` 与 `ChildEntry`；签名中的 `MaybeRefOrGetter` 来自 `@vue/reactivity`，没有由该入口直接重导出。

按 Feature 名单开关孩子见 [按已注册 Feature 挂卸载路由](../how-to-guides/feature-gated-routes.md)。

源码：见 [代码定位](source-map.md)，v3 `kernel/hooks.ts` 的 `useChildren`。
