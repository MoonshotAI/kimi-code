# provide

Reference：需要让当前节点及其后代按 token 获取服务或状态时使用 `provide`。

## 使用场景

- 在挂载消费者之前，在它的祖先或自身节点登记依赖。
- 用较近节点的提供值覆盖祖先默认值，或在同一节点临时叠加提供值。
- 不适合把兄弟节点的局部提供值当作天然共享状态；应选择共同祖先作为所有者，见 [兄弟状态共享](../how-to-guides/11-sibling-state.md)。

## 调用契约

```ts
provide<T>(token: Token<T>, value: T): void
```

- 必须在同步 setup 中调用，目标是当前 Unit；返回 `void`，不暴露撤销函数。
- `token` 按对象 identity 匹配；两次创建同 `key` 的 token 并不指向同一个槽，`key` 只是说明性名称。
- `value` 原样保存，不自动解包 ref、复制对象或将普通对象变成响应式对象。
- 同节点、同 token 的多次提供形成栈；解析时取最近节点的栈顶，即该节点尚未撤销的最后一次提供。
- 查找从消费者自身逐级走向祖先，不访问兄弟或后代；certain token 的提供必须早于对应的 [useInject](inject.md)（缺席即抛错），facade token 的可空 ref 容忍任意顺序。
- 每项登记都加入目标节点清理栈，卸载时自动撤销；撤销一个条目不会删除同 token 的其他条目。

## 边界

- 提前撤销或 setup 外登记时，使用已保存节点的 `node.provide(token, value)`；它返回 `Unsubscribe`，且仍自动登记目标节点卸载清理。
- 显式撤销可重复调用；提前撤销后，随后发生的卸载不会再次移除其他提供值。
- 对 `parent.provide()` 的登记归父节点，而不归发起调用的子节点；若需随子节点撤销，使用 [useExpose](use-expose.md)，或把返回的撤销函数另行登记到子节点清理栈。
- 撤销只注销提供条目，不调用 `value` 的关闭方法；资源释放仍由提供方安排，见 [资源清理](../how-to-guides/16-cleanup-resources.md)。
- 新增或撤销提供值只影响之后的解析：certain token 已取得的 `useInject` 快照不会重新绑定，动态状态应由提供值本身承载响应性；facade token 的可空 ref 则随提供 / 撤销自动更新。
- facade ref 的响应性由根节点的响应式提供者目录驱动（kernel 内部的 `node.providerRef(token)`，不是祖先解析结果）；目录里能看到兄弟条目不表示 `useInject` 可解析它。
- `EventContext` 用相同方式登记，但事件发送会合并路径上的所有此类条目，而非仅取栈顶，详见 [useFire](use-fire.md)。

源码：见 [代码定位](source-map.md)，`packages/agent-core/src/kernel/hooks.ts` 的 `provide`。
