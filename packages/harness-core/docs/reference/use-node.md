# useNode（kernel 内部能力）

Reference：`useNode` 已退出公开面。它与 `inject` 留在 `packages/agent-core/src/kernel/hooks.ts` 供 agent-core 框架自身使用——不经 `kernel/index` 导出，也不从 `@moonshot-ai/agent-core` 包根导出；harness-core 侧由 lint 禁止导入（见根 `.oxlintrc.json` 的 token 分级守护）。本页说明原 `useNode()` 场景的现行去处。

## 原场景的现行 API

| 原 `useNode()` 场景 | 现行 API |
|---|---|
| 按 token 取依赖 | [useInject](inject.md)：certain 缺席抛错，facade 返回响应式可空 ref |
| 登记清理 | `useCleanup(fn)`（包根导出），或从 setup 直接返回清理函数 |
| 节点 `signal`、父引用 | setup 第二参 `ctx.node`（`NodeRef`），见 [节点与句柄](node-handle.md) |
| 监听 / 发送节点事件 | [useOn](use-on.md) / [useFire](use-fire.md)；产品层用 `useOnApp` / `useOnSession` / `useOnAgent` 家族，见 [兄弟事件](../how-to-guides/12-sibling-events.md) |
| 挂载子节点 | [useChildren](use-children.md)；句柄场景用 `handle.update` 驱动 |
| 读集合 | [useCollection](use-collection.md)，贡献用 [useContribute](use-contribute.md) |
| 宿主侧解析 | `handle.resolve(token)`，同样按 token 分级 |

## 为什么收窄

`useNode()` 返回具体 `UnitNode`，暴露整棵树的内部面（`providerRef`、`resolveEntry`、清理栈、scope 等）。token 分级改造后，依赖解析按 `CertainToken` / `FacadeToken` 分级，原始目录操作不再对产品代码开放；为一个值引入整个节点面只会放大依赖。

## 包内例外

kernel 内部能力在 agent-core 包内仍然合法：`useInject` 自身的实现、根级 contribute（`lineage(useNode())` 取根再 `contribute`）等没有公开 hook 等价物的操作就走它。harness-core 的两个包装层（`feature-http/feature.ts`、`feature-acp/feature.ts`）经 lint 豁免使用 `asUnit`，配合 `currentUnit` 恢复 setup 上下文——这不是产品代码该跟随的模式，产品 Feature 用上行表格里的 hook。

源码：`packages/agent-core/src/kernel/hooks.ts`（不导出）；公开面见 [代码定位](source-map.md)。
