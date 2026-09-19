# 在宿主启动 Unit 树

How-to：在普通启动代码中挂载、等待和释放根 Unit，不把启动层本身伪装成 setup。

## 前提

先按 [代码定位](../reference/source-map.md) 确认实际导入入口。`RootUnit` 是预先定义的配方，`props` 是其输入，`runApplication(node)` 是宿主的运行过程。

## 步骤

1. 在模块顶层用 `createUnit` 定义 Root 和子配方，不在定义时执行 setup。
2. 把基础服务作为 props 传给 Root；在 Root setup 中先 provide，再挂载依赖这些服务的子节点。
3. 在宿主调用 `mountRoot(RootUnit, props)`，取得显式 node 和 handle。
4. 等待 `handle.ready()` 后开始要求初始化完成的业务。
5. 无论运行成功还是失败，退出时等待 `handle.unmount()`。

```ts
const { node, handle } = mountRoot(RootUnit, props);

try {
  await handle.ready();
  await runApplication(node);
} finally {
  await handle.unmount();
}
```

setup 或 postSetup 同步失败时，mountRoot 会发起异步清理并重抛，不会返回 handle；自定义 onMount 抛错不在这段回滚保护内，见 [mountRoot 契约](../reference/mount-root.md)。上述 finally 负责已成功挂载后的就绪失败和运行退出。

## 运行中的装配

- 动态列表：setup 内调用一次 `useChildren`；宿主持有 Ref 并替换其列表，随后调用 `handle.ready()` 等待协调完成。
- 手动装配：在宿主调用 `node.mount(Child, props)`，保存子 handle，使用 `update` / `unmount` 控制它。
- 不在 `mountRoot` 返回后才 provide 子 setup 立即需要的依赖；同步子 setup 已可能执行完或因缺依赖抛错。
- 不把 `handle.update` 当成重新运行 setup；更新必须由 setup 中的响应式 getter / watcher 消费。

## scope 的选择

无外部生命周期容器时直接省略第三个参数。需要把响应式 effects 归入已有 scope 时传 `{ scope }`；Root 仍会新建自己的 scope。

即使外部 scope 已 stop，仍需 unmount Unit。不要以 `scope.stop()` 替代资源关闭。

## 当前代码中的入口

`app/appUnit.ts` 分离了 `AppUnit` 和 `mountApp`：前者在产品节点上 `useFeatureSlot('app')` 并提供命令，后者调用 mountRoot 并返回 host。Session / Agent 由 `create()` 挂到产品树上，不再另起 FeatureUnit。

验收：初始化失败能进入释放路径；动态增删后 ready 可等待；退出后子节点 cleanup 已完成。完整可运行例子见 [计数树教程](../tutorials/counter-tree.md)。
