# useContribute

Reference：需要向当前节点的集合贡献一个值，并在节点卸载时自动撤销时使用 `useContribute`。

## 使用场景

- 向可扩展列表登记项目，让当前节点及其后代通过 [useCollection](use-collection.md) 读取。
- 需要一项退出后不影响其他项的生命周期登记，而非单值服务覆盖。
- 不适合把子节点贡献汇总到祖先，或默认收集兄弟贡献；集合只读取自身与祖先路径。

## 调用契约

```ts
useContribute<T>(collection: CollectionToken<T>, value: T, priority = 0): void
```

- 必须在同步 setup 中调用；`collection` 是共享的集合 token，按对象 identity 匹配。
- `createCollection()` 的 `key` 不是全局注册名；相同名称的新 token 仍是另一个集合。
- `value` 原样存入一条贡献，不做值去重或深层响应式转换；同值重复贡献会保留多条。
- `priority` 是数值，默认 `0`；读取时数值小的在前。
- 相同 priority 按贡献的全局登记先后排序，不按节点深度优先，也不按子节点列表顺序排序。
- 返回 `void`；撤销函数被压入当前节点清理栈，卸载时自动移除这一条贡献。

## 边界

- 节点只能折叠自己的贡献与祖先贡献；祖先看不到子贡献，兄弟看不到彼此局部贡献。
- 要让兄弟共同读取，应把贡献放在共同祖先，并明确由哪个节点负责撤销，而不是依赖整树扫描。例子见 [按已注册 Feature 挂卸载路由](../how-to-guides/feature-gated-routes.md)。
- 需要提前撤销或 setup 外登记时，用已保存节点的 `node.contribute(collection, value, priority)`；此方法的 priority 参数没有 hook 的默认值。
- 节点方法返回可重复调用的 `Unsubscribe`，但不自动登记清理栈；节点卸载也不清空底层贡献表，必须显式管理撤销。
- 对祖先节点直接贡献时，若希望随当前子节点退出，需把撤销函数登记到当前子节点；所有权不会自动从调用关系推断。
- 自动或显式撤销只删除贡献条目，不释放 `value` 持有的外部资源，见 [资源清理](../how-to-guides/cleanup-resources.md)。
- 本 hook 不返回修改 value 或 priority 的句柄；动态内容由值自身的响应式状态承载，替换登记则需要显式撤销并重新贡献。

源码：见 [代码定位](source-map.md)，v3 `kernel/hooks.ts` 的 `useContribute`。
