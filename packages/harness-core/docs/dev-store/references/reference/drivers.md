# drivers：wire / tree Journal adapter

源码：`doing/refact-237-09-16-human-domain-features/packages/agent-core-v2/src/store-v2/drivers.ts`

两个 driver 都实现 `Journal<RecordEvent, Cursor>`（`RecordEvent = WireRecord`，即扁平 `{ type, time?, ... }` 记录），并把格式专属操作暴露为各自的扩展接口。`Cursor` 是 brand 过的 JSON 字符串，内容不透明，不要解析或构造。

## openWireJournal(dir, agentId = 'agent-1')

直接接入真实 `WireService` + `AppendLogStore` + 文件存储（`#/wire/*`、`#/persistence/backends/node-fs/*`）。数据文件是 `<dir>/wire.jsonl`。

```ts
const journal = await openWireJournal(directory);
await journal.append(event);
await journal.undo(1);
const raw = await journal.read();
const active = journal.activeHistory(raw);
const rawRecords = await journal.readRawRecords();
const restorable = await journal.readRestorableRecords();
await journal.close();
```

扩展接口（`WireJournal`）：

- `format: 'wire'`、`directory`、`file`、`files`。
- `undo(turns)`：真实 `WireService.switchBranch({ turns })`，写原生 `agent.switched` + `context.undo` + `context.undone` 三元组。
- `activeHistory(entries)`：用真实 `parseTree`/`restorableChain` 从完整物理记录中选出当前可恢复链；要求传入完整连续 raw ledger，否则抛错。
- `readRawRecords()` / `readRestorableRecords()`：原生 reader 视角的完整/可恢复记录，并与物理文件逐条核对。

语义要点：

- `read()` 返回**完整物理记录**（含首行 metadata 和 undo triple）；第一条领域事件的物理行号是 2。
- cursor 内含 `{ format: 'wire', file, line }`；line 从 1 起。
- `append` 拒绝 `metadata` 与 `agent.switched` 类型——它们只能由原生操作产生。
- 打开时校验 canonical 性（JSONL 逐行 canonical、metadata 版本、branch 结构），损坏即拒绝打开，不做修复。

## openTreeJournal(dir, treeName, branch = 'main')

直接接入真实 `NodeBackend` + `TreeStore`（`{ fsync: true }`）+ `journalFromBranch`（`#human/store/*`）。数据布局：`<dir>/trees/<treeName>/<branch>.jsonl` + `<dir>/blobs/`。

```ts
const journal = await openTreeJournal(directory, 'experiment', 'main');
await journal.append(event);
await journal.fork('alternative', cursor);
await journal.checkout('main');
await journal.close();
```

扩展接口（`TreeJournal`）：

- `format: 'tree'`、`directory`、`tree`、`branch`（当前分支名，随 fork/checkout 变）、`files`、`blobsDirectory`。
- `branchPath(branch?)`、`branches()`。
- `fork(branchName, cursor)`：在 cursor 处创建子分支并切换过去；子分支 header 记录 `parentBranch`/`parentSeq`，子分支本地 seq 从 0 起；父分支之后的追加不污染子分支。
- `checkout(branchName)`：切换当前分支。

语义要点：

- `read()` 返回**当前 branch 的 parent chain**（自身 entries + 父链截断点之前），不是整个 tree 的物理文件合并。
- cursor 内含 `{ format: 'tree', directory, tree, branch, seq }`；seq 是 branch 局部序号。
- v3 tree 行永远 inline `{ kind, size, data }`，**不**按阈值外置。大字段由领域经 `SessionStores.blobs` / `useBlobs()` 写入，见 [Blobs](blobs.md)。
- 打开时做物理审计（branch header、entry schema、父链）；损坏即拒绝打开。blob 完整性由 `Blobs.get` 校验，不在 `journal.read()` 里展开。

## 两个 driver 的共同约束

- 目录由 driver 创建（拒绝符号链接路径）。
- 所有操作经内部串行队列；任何失败闩锁后后续操作失败；`close()` 幂等，drain 后清理原生资源。
- 单写者：一个 journal 实例是其文件的唯一写者；多进程并发写不在支持范围。
- tree 的 `fsync: true` 证明的是「clean close 后独立进程可恢复」，不断言断电 crash durability。

## 何时用哪个

- 要兼容现有 wire 会话文件、要原生 undo 三元组语义：wire。
- 要多分支 fork/checkout、branch 级隔离：tree。字节外置用同一目录下的 `Blobs`，不是 tree 行格式的一部分。
- 同一批领域事件在两个 driver 下投影出的状态一致（实验已断言）；历史切换语义按各自原生语义验证，不强行抹平。
