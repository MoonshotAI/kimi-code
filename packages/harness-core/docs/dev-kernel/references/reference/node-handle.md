# NodeRef、UnitNode 与 UnitHandle

Reference：在 setup 外通过显式实例管理运行中的 Unit，不重建隐式 hook 上下文。

## 选择对象

| 对象 | 能力与取得方式 |
|---|---|
| `NodeRef` | 节点能力接口；`ctx.node`、`handle.node` 使用该类型 |
| `UnitNode` | NodeRef 的实现，另有 scope、children、状态等内部数据；由 `useNode()`、`mountRoot().node` 取得 |
| `UnitHandle` | `name`、`state`、`node`、`update`、`ready`、`unmount`；由根挂载或 `node.mount()` 取得 |

NodeRef 不是 Vue Ref，也不会复制或隔离底层 UnitNode。避免仅为访问底层数据把每个业务接口扩大为 UnitNode。

## 显式节点 API

| 操作 | 返回与归属 |
|---|---|
| `node.mount(recipe, props?)` | 子节点的 UnitHandle；父节点负责递归卸载 |
| `node.provide(token, value)` | 返回撤销函数，也自动加入提供节点的 cleanup |
| `node.resolve(token)` | 立即解析自己和祖先，缺失时抛错 |
| `node.providerRef(token)` | 整棵根树的响应式 provider 目录；不同于 resolve |
| `node.on(type, handler, opts?)` | 返回取消订阅；不自动绑定到调用者的生命周期，监听节点最终卸载时清空监听表 |
| `node.fire(event)` | 同步发送到自己和祖先路径 |
| `node.contribute(collection, value, priority)` | 返回撤销函数，不像 `useContribute` 那样自动压 cleanup 栈 |
| `node.fold(collection)` | 一次性的聚合数组，不是 computed |
| `node.ready()`、`node.unmount()` | 就绪等待与幂等卸载；handle 也暴露这两个操作 |

对另一个节点注册监听或贡献时，把撤销函数绑定到真正的所有者；见 [清理指南](../how-to-guides/cleanup-resources.md)。

## props 更新不是重新 setup

`handle.update(props)` 不重跑 setup。对象初始 props 有稳定的浅响应式 `propsView`，后续对象更新会删除缺失键并赋入新值。setup 内的 watcher 或 getter 可以观察顶层属性变化。

不要依赖非对象 props 的替换来更新 setup 已收到的值，也不要把浅响应式误当成深层属性自动追踪。`failed` 或 `unmounted` 节点的 update 会被忽略。

## 生命周期边界

- `pending` / `active` / `failed` / `unmounted` 是同步生命周期状态，不是 ready 的成功标志。
- `ready()` 等待自身登记操作和子节点；已卸载节点的 ready 会拒绝。
- `unmount()` 返回缓存的同一次卸载 Promise，收集子节点和 cleanup 的错误后以 AggregateError 报告。
- 不在卸载后继续注册资源或发送事件；并非所有低层方法都主动拒绝这些调用。
- `pushCleanup(node, fn)` 返回清理项；`removeCleanup(node, entry)` 只移除登记，不执行 fn。

产品树上的 `AppHandle` / `SessionHandle` / `AgentHandle` 是 `UnitHandle` 加命令面；不要叫 Host。按 id 取这些句柄用 `useApp().get`，见 [命名](naming.md)。

源码：见 [代码定位](source-map.md)，`kernel/runtime.ts` 的 `NodeRef`、`UnitNode`、`handleFor`、`pushCleanup`、`removeCleanup`。
