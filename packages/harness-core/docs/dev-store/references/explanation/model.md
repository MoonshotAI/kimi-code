# 模型：事件是事实，状态是投影，Journal 是持久化边界

## 要区分的三个对象

237 旧实现把三种模型叠在一起：响应式 face（`createStore`/`recipe.ts`）、持久化 KV（`useDurable` 的 `store.patched`）、领域事件投影（EventStore）。store-v2 反过来定义：

- **命令（command）**：普通函数，可以校验、读状态、做异步操作，然后提交事实。恢复时**重放事实，不重新执行命令**。
- **事件（event）**：已经发生的事实，是唯一事实来源。`dispatch(event)` 是唯一权威写入口。
- **状态（state）**：事件历史的可重建投影，可以随时从 journal 重放出来。

不是「一个 KV Store 再挂 persist middleware」。当领域本来就是键值覆盖时（如用户设置），可以用 patch 事件作为语法糖，但不要把所有领域降成 KV patch。

## 内核只有五个概念

```text
Event        已发生的事实，内核只要求 { type: string }
Entry        event + cursor（一次提交的物理落点）
Journal      事件的有序读写协议（持久化边界）
Projection   事件历史的一种解释（initial/reduce/restore?）
Store        串行提交 + 发布 + 订阅的运行时
```

刻意不要：Redux 风格 middleware 链、Zustand 风格任意 setter、Pinia 风格 plugin、Jotai 风格依赖图、事后监听的 persist 插件。

## 三层结构

代码的依赖方向固定为三层；L2 与 L3 是兄弟（都只依赖 L1），真正的组合发生在应用侧组装点：

- **L1 原语**（`store.ts` + `blob.ts`）：五个概念 + `replay`/`combine`/`openStore`，以及内容寻址的 `Blobs`。Store 不知道格式；Blobs 不知道事件类型。
- **L2 包装**（`history.ts`）：Projection 的装饰器（`withHistory`），可用可不用，内核不感知。
- **L3 领域适配**（`stores/` + `treeJournal`）：把真实事件词汇和 tree 文件格式接进 L1。`tree/codec.ts` 只编解码 jsonl 行。

每多一个领域，L3 多一份投影；大字段策略写在该领域的事件形状里（`content` / `media://` / `outputRef`），不进 L1/L2。L1 不变。

## 关键设计决策（实验验证过的）

1. **唯一权威写入口是 `dispatch(event)`**。多写者并发不在内核职责内。
2. **持久化是 Journal adapter，不是事后 persist 插件**。发布点不能越过 journal 确认边界：先 `journal.append` 确认，再发布投影状态，再通知。「进入后台队列」不等于「持久化成功」；确认级别（内存接受/写盘/fsync）由具体 journal 明说。
3. **历史视图按 projection 选择**。undo 后 conversation/todo 回退、累计 usage 保留——不能给所有 projection 喂同一份裁剪流。实验反例：给 usage 套 `activeHistory` 会少算被 undo 那轮的消耗。
4. **Cursor 对内核 opaque**。wire 是「文件+物理行号」，tree 是「tree+branch+局部 seq」，内核只保存和传递 `C`，不做 `cursor + 1`。
5. **状态订阅和事实订阅分开**。`subscribe` 只在状态变化时通知；`onCommit` 覆盖每个已提交事件，即使状态没变。
6. **append 成功后投影失败必须显式区分**。事件已落盘，不能当没写过重试——`CommittedProjectionError` 携带已提交 entry。
7. **不强行统一事件生产格式**。v2 Event2（class 实例）、human plain event（factory + zod）、wire record 共存；同名事件（如两边的 `turn.started`）语义不同，拒绝交叉解码。
8. **不同文件格式通过 adapter 直接接入**，不要求先转换成统一格式。兼容分三个承诺：能读旧文件 / 能按旧格式追加 / 能无损来回转换——三者不能画等号，默认非破坏性读取。
9. **外置内容是领域选择，不是存储兜底**。领域在 `dispatch` 前 `blobs.put`，事件只带 `ref`；投影保持引用，按需 `get`。Journal / Tree 不按阈值卸包，也不把整事件换成 `store.offloaded`。
10. **v3 产品入口在 `agent-core-v3/src/store/`**。`treeJournal` + 独立 `Blobs` + `openSessionStores(tree, blobs)`。`Trees.open` 只收 `TreeBackend`。不要再用 `mapJournal` / `withOffload` / `openTreeJournal` / tree `offloadThreshold` / `StorageBackend` / `Trees.blobs`。

## reducer 约束

- 同步、确定性；不做 I/O、不读当前时间、不产生随机值。
- 不直接调其他 store 的 setter。
- immer 风格只是书写便利（`produce`），不改变语义。

## 命令与事件的关系

命令可以复杂（校验、异步、读状态），但它产出的是事实事件。恢复时只重放事实。需要可靠执行的外部 effect 不能用 `onCommit` 保证恰好一次——那需要幂等/outbox 协议，不在内核内。

## 历史视图与 undo/fork 的关系

- 分支切换/undo 改变的是**历史视图**，需要 `store.refresh()` 重新投影，不是普通 append。
- wire 的 `read()` 返回完整物理记录（含 undo triple）；`activeHistory` 选出当前可恢复链。
- tree 的 `read()` 返回**当前 branch 的 parent chain**，不是所有 branch 的合并。跨 branch 的累计事实（如全局 usage 审计）应该用独立 audit journal，不要把多分支物理文件拼成一条线性流。

## 当前明确不覆盖

多进程并发写、外部 writer 实时改文件、repair、wire 历史迁移链与老协议版本、任意快照格式、wire 媒体内容 dehydration/rehydrate、compaction 完整领域语义、checkpoint 持久化、outbox/exactly-once effect、断电 crash durability（tree 开了 `fsync`，只能证明 clean close 后可恢复）、多 agent partition。
