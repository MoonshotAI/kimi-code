---
name: dev-kernel
description: >-
  按使用场景选择和组合 human/kernel 的 Unit runtime 原语。用于编写或解释
  createUnit、mountRoot、useNode、useReady、provide/inject/useExpose、useFire/useOn、
  useContribute/useCollection、useChildren，以及 setup 调用边界、Vue 对齐的
  命名（use* / inject / create* / 实例 get）、宿主启动、
  EffectScope 生命周期、平级节点通信、按 Features 名单挂卸载扩展和资源清理。
  也用于绑定 Provider / ProtocolHandle、runLlmRequest 与 generate 组包发流（policy 在循环层，绑定无关）。
  以目标 checkout 的实际实现为准，不将核心仓路径或别名视为 code-app 已有能力。
---

# Dev Kernel

按 [llms.txt](llms.txt) 导航，按 Diataxis 选择文档；每次只读取当前任务需要的原子条目。

## 执行流程

1. 先读 [代码定位](references/reference/source-map.md)，确认目标 checkout 与导入入口。基线是 refact-237 的 human/kernel，不假定当前 code-app submodule 已包含它。
2. 读 [setup 调用边界](references/reference/setup-context.md)，确定代码是在同步 setup、异步回调还是外部宿主中执行。
3. 按下方场景读取原语契约或操作指南；涉及实现差异时回到源码核实，不自行补造 API。
4. 明确依赖可见范围、事件路径、就绪条件和资源所有者，再组织代码。
5. 核对初始化失败、动态更新和卸载路径；不要把未执行的示例或未跑的测试说成已验证。

## Explanation：建立模型

- [Unit 树与 EffectScope](references/explanation/unit-tree.md)：解释节点、scope、状态与资源的关系。

## Reference：按原语查契约

| 要做什么 | 读取 |
|---|---|
| 定义一个可挂载单元 | [createUnit](references/reference/create-unit.md) |
| 从宿主启动一棵树 | [mountRoot](references/reference/mount-root.md) |
| 捕获当前节点，在稍后使用 | [useNode](references/reference/use-node.md) |
| 让 ready 等待异步初始化 | [useReady](references/reference/use-ready.md) |
| 提供服务或共享状态 | [provide](references/reference/provide.md) |
| 把契约挂到父节点供宿主和兄弟使用 | [useExpose](references/reference/use-expose.md) |
| 获取自己或祖先提供的能力 | [inject](references/reference/inject.md) |
| 向祖先路径发出事件 | [useFire](references/reference/use-fire.md) |
| 监听事件并绑定生命周期 | [useOn](references/reference/use-on.md) |
| 注册可组合的扩展项 | [useContribute](references/reference/use-contribute.md) |
| 观察当前可见的贡献列表 | [useCollection](references/reference/use-collection.md) |
| 根据响应式列表管理孩子 | [useChildren](references/reference/use-children.md) |
| 在 setup 外更新、等待、卸载 | [Node 与 Handle](references/reference/node-handle.md) |
| 命名 composable 与按 id 查找 | [命名：use 与实例方法](references/reference/naming.md) |

## How-to guides：完成一个操作

- [宿主启动](references/how-to-guides/bootstrap.md)：分离定义、挂载、等待与退出。
- [异步初始化门控](references/how-to-guides/async-initialization.md)：阻止依赖未就绪的孩子提前挂载。
- [兄弟共享状态](references/how-to-guides/sibling-state.md)：通过共同父级提供的业务契约协作。
- [兄弟即时事件](references/how-to-guides/sibling-events.md)：在共同父级订阅并明确取消归属。
- [按已注册 Feature 挂卸载路由](references/how-to-guides/feature-gated-routes.md)：观察 `Features` 名单或把扩展贡献到祖先。
- [安装 createMedia](references/how-to-guides/install-media.md)：登记 `AgentPorts.media`，让协议 `lower` 物化媒体 ref。
- [绑定 Provider 并发一次 LLM 请求](references/how-to-guides/run-llm-request.md)：`createRequester` 与 policy 无关；`runLlmRequest` 管重试；`generate` 只组包+发流。
- [非响应式资源清理](references/how-to-guides/cleanup-resources.md)：回收订阅、外部句柄等资源。

## Tutorials：完整练习

- [计数树完整程序](references/tutorials/counter-tree.md)：执行一个包含实际断言的启动和卸载流程。

## 交付检查

- 不在 await 后重新调用 hooks；区分当前 Unit 上下文和 Vue EffectScope 上下文。
- 不自造 `find*` / `use*Host` / `ensure*` 顶层 hook；当前上下文用 `use*`，按 id 用 `useApp().get` / `session.get`。
- 不把 active 当成 ready，不把 scope.stop 当成 unmount，不把 useReady 当成底层任务取消。
- 不假设事件横向广播或父节点自动聚合后代贡献。
- 不让跨节点注册活得比其实际所有者更久。
- 只维护与本任务有关的原子文档；契约改变时同步对应索引和示例，不复制成长篇重复说明。
