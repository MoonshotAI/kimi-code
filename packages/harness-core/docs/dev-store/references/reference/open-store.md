# openStore 行为契约

源码：v3 `doing/refact-237-09-16-human-domain-features/packages/agent-core-v3/src/store/store.ts`（live）；v2 `packages/agent-core-v2/src/store-v2/store.ts` 尚无 `attach`。

```ts
const store = await openStore({
  journal,
  projection,
  onError?: (error: unknown) => unknown,
});
```

打开时立即 `journal.read()` 并用 `replay` 构建根视图；读失败会顺带 `journal.close()` 再把错误抛给调用方。

## 串行提交队列

所有写操作（`dispatch` / `project` / `refresh`）经内部 `tail` promise 链串行执行。`attach` 同步、不进队列。`Promise.all` 并发 dispatch 的顺序就是 append 顺序。close 后新操作拒绝 `'Store is closing or closed'`。

## dispatch 的顺序（确认后发布）

1. `structuredClone(event)` 并深度 freeze——调用方之后改原对象不影响已排队事件；clone 失败直接 reject，不进入队列。
2. 排队执行 `journal.append(owned)`。**确认前状态对外不可见**。
3. append 成功后：把 entry 追加到内存 `history`，对**本批开始时**已存在的视图两阶段 `advance`（stage 再 commit），再逐个 `notify`。本批 notify/`onCommit` 期间新 `attach` 的视图从完整 `history` replay，不吃这批 `advance`。
4. 最后触发 `onCommit` 监听器，参数是 `(entry, rootState)`。
5. resolve 返回 `Entry`（含 journal 分配的 cursor）。

## 错误分类（不要笼统 catch 重试）

| 失败点 | 抛出 | 后果 |
|---|---|---|
| append 失败 | 原始错误 | 事件**未提交**；store 进入 `failed`，后续写操作抛 `StoreFailedError`（携带首次失败原因） |
| append 成功、投影失败 | `CommittedProjectionError`（携带已提交 `entry`） | 事件**已落盘**；store 进入 `failed`，必须核对历史或重建，不能重试同一事件 |
| refresh 失败 | 原始错误 | store 进入 `failed`，阻止继续写 |

`StoreFailedError` 与 `CommittedProjectionError` 都从 `store.ts` 导出。

## subscribe 与 onCommit 的区别

- `subscribe(listener)`：只有该视图状态 `Object.is` 变化才通知；refresh/replay 后不变化的视图不通知。
- `onCommit(listener)`：每个已提交事件都触发，**即使状态没变**（audit/telemetry/去重/外部同步要靠它）。
- 两类监听器抛错（包括返回 rejected promise/thenable）都被隔离，上报 `onError`（默认 `console.error`），不毒化提交；`onError` 自身返回 rejected promise 也不会产生 unhandled rejection。
- 重放（打开、`refresh`、`project` 追赶历史）**不触发** `onCommit`。

## attach：同步后加载投影

打开时缓存当前 `history`。`store.attach(projection)` 用这份历史当场 replay 并加入 live slot，不读盘。`phase` 不是 `open` 或已 `failed` 时抛错。Feature setup（含中途加入）走这条路径。

`store.project(projection)` 仍返回 `Promise<View>`，在串行队列里调用同一个 `attach`（不再 `journal.read()`）。窗口外、需要与 in-flight dispatch 排好序时用它。

## refresh：历史切换后的重投影

`store.refresh(change?)`：先执行可选的外部变更（如 `journal.undo(1)`、`journal.fork(...)`、`journal.checkout(...)`），再重新 `journal.read()`，对所有视图走 `restore`（不是逐条 reduce——这正是 `withHistory` 的挂载点），然后通知变化的视图。不改变当前历史的纯 `refresh()` 不会触发任何通知（各视图状态引用不变）。

## close

幂等。等待已接受的操作全部完成（drain），关闭 journal，然后清理：清空 onCommit、dispose 所有视图、`phase = 'closed'`。已 dispose 的视图再 `subscribe` 抛错。

## 冻结语义

- dispatch 的输入事件被 clone + 深度 freeze；journal 返回的 `entry.event` 与 `entry` 本身也 freeze。
- 投影产出的状态 freeze。
- **只冻结数组和普通对象**（`Object.getPrototypeOf` 为 `Object.prototype` 或 `null`）：Event2 这类 class 实例事件、typed-array cursor 不被触碰，identity 保留。reducer 不能依赖「状态一定被冻住」来防御，自己也不要原地改状态。

## 不变式速查

- 确认前无 speculative state；append 失败不自动重试。
- 一个 dispatch 的错误 entry 不会被后续 dispatch 复用（后续操作拿到的是独立的 `StoreFailedError`）。
- 视图状态引用稳定：combine 下某个子投影 `Object.is` 不变时，父状态对应 key 保留原引用。
