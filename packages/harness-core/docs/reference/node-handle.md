# NodeRef、UnitNode 与 UnitHandle

Reference：在 setup 外通过显式实例管理运行中的 Unit，不重建隐式 hook 上下文。

## 选择对象

| 对象 | 能力与取得方式 |
|---|---|
| `NodeRef` | 节点能力接口；`ctx.node`、`handle.node` 使用该类型 |
| `UnitNode` | NodeRef 的实现，另有 scope、children、状态等内部数据；由 `useNode()`、`mountRoot().node` 取得 |
| `UnitHandle` | `name`、`state`、`node`、`resolve`、`update`、`ready`、`unmount`；由根挂载或 `node.mount()` 取得 |

NodeRef 不是 Vue Ref，也不会复制或隔离底层 UnitNode。避免仅为访问底层数据把每个业务接口扩大为 UnitNode。

## 显式节点 API

| 操作 | 返回与归属 |
|---|---|
| `node.mount(recipe, props?)` | 子节点的 UnitHandle；父节点负责递归卸载 |
| `node.provide(token, value)` | 返回撤销函数，也自动加入提供节点的 cleanup |
| `handle.resolve(token)` / `node.resolve(token)` | 立即解析自己和祖先，缺失时抛错。宿主用 Handle 这一层；`node` 是节点内部面 |
| `node.providerRef(token)` | 整棵根树的响应式 provider 目录；不同于 resolve |
| `app.on` / `session.on` / `node.on(type, handler, opts?)` | 返回取消订阅。`on(feature, type, handler)` 按 Feature 事件联合收窄；`on(feature, '*')` 只收 `featureName.` 前缀。开放字符串 overload 仍是 `RuntimeEvent`。`AgentHandle.on` 仍是机器事件 |
| `app.wait` / `session.wait` / `node.wait(type, opts?)` | `on` 的 Promise 对偶，只等之后发生的事件。`opts.match` 不满足则继续等；`opts.signal` 取消；节点卸载按 `ready()` 同一句拒绝。不解释 `outcome`。`UnitHandle` 没有 `on` / `wait` |
| `node.fire(event)` | 同步发送到自己和祖先路径 |
| `node.contribute(collection, value, priority)` | 返回撤销函数，不像 `useContribute` 那样自动压 cleanup 栈 |
| `node.fold(collection)` | 一次性的聚合数组，不是 computed |
| `node.ready()`、`node.unmount()` | 就绪等待与幂等卸载；handle 也暴露这两个操作 |

对另一个节点注册监听或贡献时，把撤销函数绑定到真正的所有者；见 [清理指南](../how-to-guides/16-cleanup-resources.md)。

## props 更新不是重新 setup

`handle.update(props)` 不重跑 setup。对象初始 props 有稳定的浅响应式 `propsView`，后续对象更新会删除缺失键并赋入新值。setup 内的 watcher 或 getter 可以观察顶层属性变化。

props 更新的可观察面就是这个浅响应式视图：非对象 props 的 setup 入参不会随 update 替换，深层属性变化也不会被自动追踪。`failed` 或 `unmounted` 节点的 update 会被忽略。

## 生命周期边界

- `pending` / `active` / `failed` / `unmounted` 是同步生命周期状态，不是 ready 的成功标志。
- `ready()` 等待自身登记操作和子节点；已卸载节点的 ready 会拒绝。
- `unmount()` 返回缓存的同一次卸载 Promise，收集子节点和 cleanup 的错误后以 AggregateError 报告。
- 资源注册与事件发送安排在节点存活期内完成；并非所有低层方法都主动拒绝卸载后的调用。
- `pushCleanup(node, fn)` 返回清理项；`removeCleanup(node, entry)` 只移除登记，不执行 fn。

产品树上的 `AppHandle` / `SessionHandle` / `AgentHandle` 是 `UnitHandle` 加命令面。按 id 取这些句柄用 `useApp().get`，见 [命名](naming.md)。`setConfig` / `setCredentialProvider` / `setRequester` 是命令面上的方法，直接调用即生效。

源码：见 [代码定位](source-map.md)，`kernel/runtime.ts` 的 `NodeRef`、`UnitNode`、`handleFor`、`pushCleanup`、`removeCleanup`。
