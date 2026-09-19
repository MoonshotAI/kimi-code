# useCollection

Reference：需要响应式读取当前节点及其祖先提供的有序贡献列表时使用 `useCollection`。

## 使用场景

- 消费 [useContribute](use-contribute.md) 登记的可扩展项目，并随贡献加入或撤销重新求值。
- 没有贡献时仍希望获得空列表，而不是缺失依赖错误。
- 不适合收集整个根树、后代或兄弟的项目；可见范围由消费者所在路径决定。兄弟可见的扩展项见 [按已注册 Feature 挂卸载路由](../how-to-guides/feature-gated-routes.md)。

## 调用契约

```ts
useCollection<T>(collection: CollectionToken<T>): ComputedRef<readonly T[]>
```

- 必须在同步 setup 中取得 computed；之后通过 `.value` 读取，不返回普通数组。
- `collection` 按 token 对象 identity 匹配，不按 `key` 字符串查找。
- 每次求值读取自身与全部祖先的对应贡献，按 priority 升序排列；同 priority 按全局登记顺序排列。
- 贡献表与条目数组的变动可触发重新求值；没有条目时得到 `[]`。
- 不做去重，不因距离较近而覆盖同值；每一条贡献都保留自己的排序位置。
- 返回的数组元素就是提供方登记的值，不是深拷贝或自动解包的 ref。

## 边界

- `readonly` 是返回类型约束，不代表数组和元素被深冻结；消费者不应修改结果来尝试撤销贡献。
- 普通贡献对象的内部字段不会自动变成响应式；需要动态字段时由贡献者传入响应式值。
- setup 外需要单次读取时，用已保存节点的 `node.fold(collection)`；它返回当次折叠的普通数组，没有本 hook 的 computed 包装。
- 在响应式 effect 中调用 `fold()` 仍可能追踪其读取；“快照”指返回数组，不表示底层数据是非响应式的。
- 读取集合不会登记新的贡献，也没有取消订阅或清空集合的返回接口；释放读取方不等于撤销提供方条目。
- 同步 setup 中创建的消费 watcher 由节点 scope 停止；不要把仍持有的 computed 当成卸载后继续有效的服务接口。
- 贡献的自动清理由 [useContribute](use-contribute.md) 管理；直接 `node.contribute()` 的撤销需要提供方显式负责。

源码：见 [代码定位](source-map.md)，v3 `kernel/hooks.ts` 的 `useCollection`。
