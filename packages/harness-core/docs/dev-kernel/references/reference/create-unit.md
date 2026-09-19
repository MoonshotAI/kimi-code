# createUnit

Reference：需要定义可重复挂载的 Unit 配方时使用 `createUnit`；它只保存名称和 setup，不立即创建节点。

## 使用场景

- 把一段初始化、依赖注册和资源清理组织成可挂载的生命周期单元。
- 同一配方可挂载多次，每次得到独立节点；需要实例时继续使用 [mountRoot](mount-root.md) 或节点的 `mount()`。
- 不适合把它当成每次 props 变化都会重新执行的渲染函数。

## 调用契约

```ts
createUnit<P = void>(name: string, setup: UnitSetup<P>): UnitRecipe<P>
```

- `name` 是节点名称，不是唯一标识；函数不检查重名。
- `setup` 的形状是 `(props: P, ctx: UnitContext) => unknown`；返回的配方就是 `{ name, setup }`。
- 创建配方无需处于 setup；挂载时运行时才同步调用 `setup`。
- `ctx.name` 是配方名称，`ctx.node` 的声明类型是 `NodeRef`，不是 `UnitHandle`。
- 初始 props 是非 null 对象时，setup 收到对象展开后的浅响应式副本；其他值直接传入。对象展开不保留数组或类实例的原型语义。
- setup 直接返回函数时，该函数加入节点清理栈；卸载按后进先出顺序调用，并等待其返回的 Promise。
- 其他返回值只存入 `UnitNode.setupResult`，不会成为 `UnitHandle` 的服务接口。

## 边界

- 当前 Unit 由同步调用栈维护，setup 调用结束即弹栈；`await` 后不再保留该 Unit 上下文，见 [setup 上下文](setup-context.md)。
- 类型虽允许 async setup 返回 Promise，运行时并不自动等待它，也不会把它解析出的函数当作 cleanup；显式登记异步工作用 [useReady](use-ready.md)。
- 同步 setup 完成后节点通常进入 `active`，不表示异步工作已 ready。
- `handle.update()` 不重跑 setup；初始和新 props 都是对象时，只更新原有浅响应式视图。原始值 props 的 setup 入参不会被替换。
- 清理函数仅在卸载时自动执行；需要主动提前释放的资源，应自行提供释放入口，并避免后续重复释放，见 [资源清理](../how-to-guides/cleanup-resources.md)。
- `useChildren` 以配方对象 identity 判断是否替换，不比较 `name`；不要在每次 source 求值时重新创建等名配方。
- 此函数由源码 `kernel/index.ts` 重导出；这不代表 code-app 现有 submodule 或已发布包已经提供相同入口，接入位置以 [代码定位](source-map.md) 为准。

源码：见 [代码定位](source-map.md)，`kernel/runtime.ts` 的 `createUnit`。
