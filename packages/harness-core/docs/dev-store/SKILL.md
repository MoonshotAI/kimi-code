---
name: dev-store
description: >-
  按使用场景选择和组合事件驱动 Store 原语。用于编写或解释
  Event/Entry/Journal/Projection/Store 协议、openStore 的提交与发布语义、combine/withHistory
  组合、领域 Blobs 外置、tree Journal driver、以及 undo/fork 历史切换、
  后加载投影、错误分类和资源清理。以目标 checkout 的实际实现为准（基线是 refact-237
  的 agent-core-v3 src/store），不要把实验原型 .tmp 路径或已删除的 mapJournal /
  withOffload / tree 阈值 offload 当成产品入口。
---

# Dev Store

按 [llms.txt](llms.txt) 导航，按 Diataxis 选择文档；每次只读取当前任务需要的原子条目。

## 执行流程

1. 先读 [模型](references/explanation/model.md)，建立「事件是事实、状态是投影、Journal 是持久化边界」的模型；不了解模型时写的代码几乎必然用错 `onCommit`、`refresh` 或 `withHistory`。
2. 按下方场景读取契约；涉及行为差异时回到 `doing/refact-237-09-16-human-domain-features/packages/agent-core-v3/src/store/` 源码核实，不自行补造 API。
3. 明确谁是写者（`dispatch` 唯一入口）、哪个 projection 选哪份历史视图、错误属于哪一类，再组织代码。
4. 核对失败、卸载和重放路径；不要把未执行的示例说成已验证。可运行验证入口见 [操作指南](references/how-to-guides/recipes.md)。

## Explanation：建立模型

- [事件、投影与历史视图](references/explanation/model.md)：为什么内核只有五个概念；关键设计决策与明确不覆盖的范围。

## Reference：按模块查契约

| 要做什么 | 读取 |
|---|---|
| 理解五个核心类型 | [protocol](references/reference/protocol.md) |
| 开 store、提交、订阅、关闭 | [openStore 行为契约](references/reference/open-store.md) |
| 组合投影、选择历史视图 | [combine / withHistory / replay](references/reference/composition.md) |
| 领域外置大字段 | [Blobs](references/reference/blobs.md) |
| 接 wire / tree 持久化文件 | [drivers](references/reference/drivers.md) |
| 用现成领域投影与 fixture | [domain](references/reference/domain.md) |

## How-to guides：完成一个操作

- [常见操作配方](references/how-to-guides/recipes.md)：开 store、dispatch、订阅、后加载投影、undo/fork 后 refresh、领域 Blobs、写自定义 Journal/Projection、跑验证。

## Tutorials：完整练习

- [计数器完整程序](references/tutorials/counter-store.md)：一个包含断言的最小启动-提交-恢复流程。

## 交付检查

- 不把 `subscribe` 当事实流用：状态没变 ≠ 事件没提交；要事实用 `onCommit`。
- 不在 reducer 里做 I/O、读时间、产生随机值或调别的 store；reducer 必须同步、确定、可重放。
- 不越过 Journal 确认边界发布状态；不把「进入队列」说成「已持久化」。
- 不把 undo 后的 active history 强套给所有 projection；usage 这类累计事实默认读完整历史。
- 不把 `CommittedProjectionError` 当普通失败重试同一事件——它已经落盘。
- 不让 cursor 透出内核约定的结构；对内核它只是 `C`。
- 不靠 Journal / Tree 按阈值自动卸内容；大字段由领域 `blobs.put`，事件只带 `ref`；`reduce` 里不 `get`。`Trees.open` 只收 `TreeBackend`，不持有 blobs。
- 不恢复 `mapJournal` / `EventCodec`；journal 记录就是领域事件。
- 引用代码以 checkout 内 `packages/agent-core-v3/src/store/` 为准；契约改变时同步对应索引和示例。
