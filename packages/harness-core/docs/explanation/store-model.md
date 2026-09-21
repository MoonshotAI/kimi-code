# 模型：事件是事实，状态是投影，Journal 是持久化边界

## 要区分的三个对象

Store 把三种对象分开定义，各自只担一件事：

- **命令（command）**：普通函数，可以校验、读状态、做异步操作，然后提交事实。恢复时**重放事实，不重新执行命令**。
- **事件（event）**：已经发生的事实，是唯一事实来源。`dispatch(event)` 是唯一权威写入口。
- **状态（state）**：事件历史的可重建投影，可以随时从 journal 重放出来。

键值覆盖只是其中一种领域形状：当领域本来就是键值覆盖时（如用户设置），用 patch 事件作语法糖即可；其余领域写自己的事件词汇。

## 内核只有五个概念

```text
Event        已发生的事实，内核只要求 { type: string }
Entry        event + cursor（一次提交的物理落点）
Journal      事件的有序读写协议（持久化边界）
Projection   事件历史的一种解释（initial/reduce/restore?）
Store        串行提交 + 发布 + 订阅的运行时
```

五个概念足够，是因为每少一种机制都有一条对应的理由：写入只有 `dispatch(event)` 一个入口，没有写路径要拦截，内核因此没有 middleware 链；状态必须能从 journal 重放，绕过事件的 setter 会让状态与 journal 漂移，因此没有任意 setter；扩展发生在 L3 领域适配（新事件词汇 + 新投影），内核保持封闭，因此没有 plugin 机制；投影组合只有 `combine` / `withHistory` 两条显式路径，重放保持确定性，因此没有依赖图；持久化在 Journal 协议内且先于发布确认，事后监听的 persist 插件赶不上这个边界，因此持久化只做在 adapter 里。

## 三层结构

代码的依赖方向固定为三层；L2 与 L3 是兄弟（都只依赖 L1），真正的组合发生在应用侧组装点：

- **L1 原语**（`store.ts` + `blob.ts`）：五个概念 + `replay`/`combine`/`openStore`，以及内容寻址的 `Blobs`。Store 不知道格式；Blobs 不知道事件类型。
- **L2 包装**（`history.ts`）：Projection 的装饰器（`withHistory`），可用可不用，内核不感知。
- **L3 领域适配**（`packages/agent-core/src/stores/` + `treeJournal`）：把真实事件词汇和 tree 文件格式接进 L1。`tree/codec.ts` 只编解码 jsonl 行。

每多一个领域，L3 多一份投影；大字段策略写在该领域的事件形状里（`content` / `media://` / `outputRef`），不进 L1/L2。L1 不变。

## 关键设计决策（实验验证过的）

1. **唯一权威写入口是 `dispatch(event)`**。多写者并发不在内核职责内。
2. **持久化做在 Journal adapter 里**。发布点不能越过 journal 确认边界：先 `journal.append` 确认，再发布投影状态，再通知。「进入后台队列」不等于「持久化成功」；确认级别（内存接受/写盘/fsync）由具体 journal 明说。
3. **历史视图按 projection 选择**。undo 后 conversation/todo 回退、累计 usage 保留——不能给所有 projection 喂同一份裁剪流。实验反例：给 usage 套 `activeHistory` 会少算被 undo 那轮的消耗。
4. **Cursor 对内核 opaque**。tree 是 `{ branch, seq }`，内核只保存和传递 `C`，不做 `cursor + 1`。
5. **状态订阅和事实订阅分开**。`subscribe` 只在状态变化时通知；`onCommit` 覆盖每个已提交事件，即使状态没变。
6. **append 成功后投影失败必须显式区分**。事件已落盘，不能当没写过重试——`CommittedProjectionError` 携带已提交 entry。
7. **journal 记录就是领域事件**。读路径把记录原样交给 projection，中间没有转译层。agent 与 session 用不同 type 集；`decodeAgent` 见到带 `agentId` 的记录会抛错。
8. **外置内容是领域选择，因为只有领域知道哪个字段大**。领域在 `dispatch` 前 `blobs.put`，事件只带 `ref`；投影保持引用，按需 `get`。Journal / Tree 保持格式无关，不按阈值卸包。
9. **产品入口在 `packages/agent-core/src/store/`**。`treeJournal` + 独立 `Blobs` + `openSessionStores(tree, blobs)`。`Trees.open` 只收 `TreeBackend`。

## reducer 约束

- 同步、确定性：不做 I/O、不读当前时间、不产生随机值，重放才能逐字节重建同一份状态。
- 跨 store 的联动放在命令里编排，reducer 只归约本 store 的事件。
- immer 风格只是书写便利（`produce`），不改变语义。

## 命令与事件的关系

命令可以复杂（校验、异步、读状态），但它产出的是事实事件。恢复时只重放事实。`onCommit` 不保证恰好一次；需要可靠执行的外部 effect 走幂等 / outbox 协议，在应用侧另行安排。

## 历史视图与 undo/fork 的关系

- 分支切换/undo 改变的是**历史视图**，用 `store.refresh()` 重新投影；它和普通 append 走不同路径。
- `treeJournal.read()` 返回**当前 branch 的 parent chain**，不是所有 branch 的合并。跨 branch 的累计事实用独立 journal：多分支物理文件互斥，拼起来不是一条连续事实。

## Feature 怎么写一份投影

产品 Feature 的自有状态落在节点已有的那份 journal 上：`useAgentStore()` / `useSessionStore()` 拿到的就是它，事件与产品事实同流持久化、同流重放。自有状态 = 一个 `Projection` + `dispatch` 自有 `type`：

1. 定事件名（建议 `featureName.*`）和 `initial` / `reduce`。
2. setup 里 `const state = store.fold(projection)`。
3. 命令（工具 `execute`、宿主 facade）里校验、读 `state.value`、再 `await store.dispatch(event)`。
4. 大字段先 `useBlobs().put`，事件只带 `ref`。

`fold` 从日志起点重放，中途安装也能看到历史。只认自己的 type，其它事件原样跳过——也可以听 `turn.started` 这类已有事实（Todo 用它数轮次）。对照 [2. Todo Feature](../how-to-guides/02-add-todo-feature.md)。

## 内核的职责边界

内核保证的是「单进程内、一份 journal 的重放一致性」。以下能力在这条边界之外，需要时在应用侧另行安排：多进程并发写、外部 writer 实时改文件、repair、wire 历史迁移链与协议版本、任意快照格式、wire 媒体内容 dehydration/rehydrate、compaction 完整领域语义、checkpoint 持久化、outbox/exactly-once effect、断电 crash durability（tree 开了 `fsync`，保证的是 clean close 后可恢复）、多 agent partition。
