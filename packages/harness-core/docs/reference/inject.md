# useInject

Reference：需要在 setup（或 `asUnit` 上下文）中取得已经由当前节点或祖先提供的依赖时使用 `useInject`，从 `@moonshot-ai/agent-core` 包根导入。

## Token 分级

- 框架 token 是 `CertainToken<T>`：unit 树自带、一定存在，缺席即装配错误。`createToken` 只在 agent-core 框架内部使用，不从包根导出。
- Feature 门面 token 是 `FacadeToken<T>`：一切经 `useExpose` 登记的 facade，由 `createFacadeToken` 创建；天然 optional——对应 Feature 可以不装，`useExpose` 也只接受 facade token。

## 调用契约

```ts
useInject<T>(token: CertainToken<T>): T
useInject<T>(token: FacadeToken<T>): Readonly<ShallowRef<T | undefined>>
```

- 必须在同步 setup 或 `asUnit` 上下文中调用。
- certain：直接返回提供值；缺席同步抛错，语义同旧 `inject`。
- facade：返回响应式只读 ref。`.value` 是当前命中值或 `undefined`；按 lineage 取最近提供者（自身、父节点、继续向上，每个节点只取尚未撤销的栈顶条目），随提供者挂载 / 卸载驱动。读 `.value` 的时机就是取值时机：setup 里读一次是快照，放进 computed / watch / 闭包才保持响应。
- token 以对象 identity 匹配；相同 `key` 的另一个 token 不等价。

## facade 缺席的三种合法处理

1. 领域降级：没有它就缩水，例如 telemetry 缺席静默不上报。
2. 自身停用：不注册贡献（工具、路由），或门面方法被调用时抛带领域语境的错误——对齐旧 `inject` 缺席抛错的 fail-fast 意图。
3. 显式上报：诊断或事件。

禁止无声 `?.` 全部吞掉。

## 边界

- 依赖必须已经存在；不适合用它等待未来出现的服务。兄弟共享先把依赖放到共同祖先，见 [兄弟状态共享](../how-to-guides/11-sibling-state.md)。
- 树外取 facade 用 `handle.resolve(token)`，同样分级：`resolve(CertainToken): T` 缺席抛错；`resolve(FacadeToken): T | undefined` 不抛错。
- 没有专属的取消订阅 API；消费方自己创建的 watcher 或资源应依各自 scope 与清理契约释放，见 [资源清理](../how-to-guides/16-cleanup-resources.md)。

源码：见 [代码定位](source-map.md)，`packages/agent-core/src/kernel/hooks.ts` 的 `useInject`。
