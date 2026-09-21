# Tree journal 与物理容器

源码：`packages/agent-core/src/store/tree.ts`、`store/journal.ts`、`store/node.ts`、`stores/session.ts`。产品入口是 `Trees` + `treeJournal` + `openSessionStores`。

## 物理层

`Trees.open(backend, { fsync? })` 只收 `TreeBackend`，不持有 blobs。

| 实现 | 用途 |
|---|---|
| `NodeBackend(dir)` | 目录便利袋：`trees` + `blobs` 两个 backend |
| `MemoryBackend()` | 测试 |
| `NodeTreeBackend` / `NodeBlobBackend` | 拆开用 |

`openTrees(dir)` 只开 tree 目录。磁盘上一个 session 的产品入口是 `openSessionTree(dir)`：`Trees` + `openBlobs` + `openSessionStores`。harness 不直接调它，而是 `SessionSpace.open/create/copy` 给出 `{ trees, blobs }`，再 `openSessionContainer`。

逻辑布局：`trees/session/_session`（session journal）+ `trees/session/<agentId>`（agent journal）+ `blobs/<sha>`。

## `treeJournal(tree, branch)`

实现 `Journal<RecordEvent, BranchRef>`，并扩展：

- `branch`：当前分支名
- `create(name, from?)`：从 `from`（或空）建分支并切过去
- `checkout(name)`
- `settled()`

`read()` 返回**当前 branch 的 parent chain**（自身 entries + 父链截断点之前），不是整棵 tree 的物理合并。cursor 是 `{ branch, seq }`，内核当 opaque `C` 保存和传递，结构只属于 tree 自己。

行内 payload 永远是 `{ kind, size, data }`。大字段由领域 `blobs.put`，事件只带 `ref`。`tree/codec.ts` 只编解码 jsonl 行。

undo / 切分支不是 journal 的 `undo` 方法。产品侧：

```ts
await store.refresh(() => journal.create(freshName, from));
```

`SessionStores.undo` / `switchBranch` 就是这条路径，再写 `agent.switched`。

## SessionStores

`openSessionStores(tree, blobs)`：

- `session`：已打开的 session store
- `open(agentId)` / `fork` / `close` / `get` / `branch`
- `undo(agentId, turns)` / `switchBranch({ reason, seed })`
- `flush` / `dispose`

live agent 在 undo / 切分支后**不**自动跟随机器，由外层重挂。

## 相关文档

- 协议 → [protocol](protocol.md)
- Blobs → [blobs](blobs.md)
- 产品投影 → [domain](domain.md)
- 配方 → [17](../how-to-guides/17-recipes.md)
