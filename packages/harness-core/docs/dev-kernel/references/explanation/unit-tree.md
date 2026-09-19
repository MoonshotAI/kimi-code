# Unit 树与 EffectScope

Explanation：把 runtime 理解为以 Node 为生命周期和资源归属单位的树，而不是单个 EffectScope 包裹所有业务。

## 三种对象

- `UnitRecipe`：`createUnit` 返回的定义，保存名称与 setup，不是运行中的实例。
- `UnitNode`：配方挂载后的运行实例，实现 `NodeRef`，每次挂载都会创建新实例。
- `UnitHandle`：宿主控制实例的句柄，负责更新 props、等待就绪和卸载。

`NodeRef` 只是收窄的 TypeScript 接口，不是另一个包装对象，也不是 Vue Ref。`ctx.node`、`handle.node` 的静态类型是 `NodeRef`；`useNode()`、`mountRoot().node` 返回完整的 `UnitNode`。

## 两棵关联的树

```text
可选的外部 EffectScope
└── Root.scope
    ├── A.scope
    └── B.scope
```

每个 Node 都调用 `effectScope()`。子节点在父节点的 scope 内创建，因此 scope 的父子关系跟随 Unit 挂载关系。根 Node 的 `parent` 是 null，但根 scope 可以隶属于外部或调用时活动的 scope。

## 每个 Node 拥有什么

| 维度 | 状态或资源 |
|---|---|
| 结构与执行 | `parent`、`children`、`recipe`、`props`、`propsView`、`setupResult` |
| 生命周期 | `state`、AbortController / `signal`、幂等卸载 Promise |
| 响应式副作用 | `scope` 内创建的 effects |
| 其他资源 | 显式注册的 cleanup 栈 |
| 异步就绪 | `pendingReady`，以及子节点的 ready |
| 协作 | 本地 providers、事件监听器、集合贡献 |
| 扩展实现 | `postSetup` 队列和 `internals` Map |

provider `directory` 仅在根节点按需创建，用来观察整棵树的 provider；它不改变 `inject` 的祖先查找规则。树本身不是全量响应式对象，`state`、`children` 等是普通字段。

## 职责边界

- EffectScope 管理在其作用域内创建的响应式 effects，不自动管理任意定时器、外部订阅和句柄。
- Unit 管理显式 cleanup、取消信号、子节点以及就绪条件。
- `active` 表示同步 setup 与 postSetup 执行完成，不保证异步初始化已完成。
- `node.unmount()` 会停止 scope；单独 `scope.stop()` 不会反向调用 Unit 卸载，不会自动执行 Unit cleanup 栈。
- 父节点卸载时先设置自身状态、abort、停止 scope，再逆序卸载子节点，最后逆序执行自身 cleanup；随后等待已登记操作并断开父子关系。

## 协作不是任意节点寻址

依赖与贡献沿自己和祖先读取；事件只走发出节点的祖先路径。兄弟通信通过共同父级提供的业务契约，或在共同父级注册事件监听。runtime 不提供通用任务依赖图或整树广播。

继续阅读：[外部句柄](../reference/node-handle.md)、[资源清理](../how-to-guides/cleanup-resources.md)。

源码：见 [代码定位](../reference/source-map.md)，`kernel/runtime.ts` 的 `UnitNode`、`mountRoot`、`mountChild`、`performUnmount`。
