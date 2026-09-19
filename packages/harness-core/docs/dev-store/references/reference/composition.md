# combine / withHistory / replay

源码：`doing/refact-237-09-16-human-domain-features/packages/agent-core-v2/src/store-v2/store.ts`、`history.ts`

## replay：统一的重建入口

```ts
replay(projection, entries): S
```

有 `restore` 用 `restore`，否则 `initial()` 后逐条 `reduce`。打开 store、`project`、`refresh`、`withHistory` 内部都走它。手写一次性重放也用它，不要自己写 reduce 循环。

## combine：多投影组合

```ts
const projection = combine({
  context: conversation<Cursor>(),
  todo: todos<Cursor>(),
  usage: usage<Cursor>(),
  turns: turns<Cursor>(),
});
```

- 每个 key 是独立 projection，共享同一份事件流；不需要各自再存一份事件。
- `reduce` 时逐 key 计算；**所有 key 都 `Object.is` 不变时父状态保留原引用**（订阅者不被打扰）。
- `restore` 时把同一批 entries 分别交给每个子投影 replay——子投影各自的历史视图（`withHistory` 与否）在此生效。
- 增加一个 projection 不改变事件历史，也不改变其他 projection 的结果。

## withHistory：按 projection 选择历史视图

```ts
withHistory(projection, select): Projection
```

只包一层 `restore`：`replay` 时先 `select(entries)` 再折叠；`reduce`（live 增量）完全不动——新 append 的事件一定属于活跃历史，只有重建时才需要筛选。

```ts
const wireProjection = (journal: WireJournal) => combine({
  context: withHistory(conversation<Cursor>(), journal.activeHistory),
  todo: withHistory(todos<Cursor>(), journal.activeHistory),
  usage: usage<Cursor>(),
  turns: turns<Cursor>(),
});
```

## 历史视图的选择原则（实验结论）

| 投影 | 历史视图 | 理由 |
|---|---|---|
| conversation / todo | `activeHistory`（当前可恢复链） | undo/fork 后应回退到当前分支状态 |
| usage / 审计类 | 完整历史 | 已发生的消耗是物理事实，不随 undo 撤销 |
| turn index | 完整历史 | 记录的是物理提交位置 |

反例（实验里的 negative control）：`replay(withHistory(usage(), journal.activeHistory), all)` 会把被 undo 那轮的 usage 也回滚掉，少算消耗。**不要把一个全局 active history 当成所有 projection 的唯一输入。**

class 风格的 projection（方法依赖 `this`）经 `withHistory` 包装后 receiver 保留——`reduce` 是原样转发的。

## wire 与 tree 的「完整历史」不一样

- wire `read()`：完整物理记录（含 metadata 和 undo triple），`activeHistory` 用真实 `parseTree`/`restorableChain` 选可恢复链。
- tree `read()`：**当前 branch 的 parent chain**，不是整个 tree 的物理文件。所以 tree 下「usage 读完整历史」= 当前 branch lineage 的完整历史。要跨 branch 的累计事实，用独立 audit journal，不要拼接多分支文件（互斥历史不是连续事实）。
