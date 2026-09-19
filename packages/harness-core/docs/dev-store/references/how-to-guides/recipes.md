# 常见操作配方

所有路径相对于仓库根；`PKG` 指 `doing/refact-237-09-16-human-domain-features/packages/agent-core-v2`。包内引用用 `#/store-v2/...`（v2 侧）或相对路径。

## 开一个 store 并提交

```ts
import { openStore, combine } from '#/store-v2/store';
import { withHistory } from '#/store-v2/history';
import { openWireJournal } from '#/store-v2/drivers';
import { conversation, todos, usage, turns } from '#/store-v2/domain';

const journal = await openWireJournal(directory);
const store = await openStore({
  journal,
  projection: combine({
    context: withHistory(conversation<Cursor>(), journal.activeHistory),
    todo: withHistory(todos<Cursor>(), journal.activeHistory),
    usage: usage<Cursor>(),
    turns: turns<Cursor>(),
  }),
});

const entry = await store.dispatch({ type: 'my.event', time: Date.now() });
store.getState();
store.subscribe((state) => { /* 仅状态变化时 */ });
store.onCommit((entry, state) => { /* 每个已提交事件，重放不触发 */ });
```

## 后加载一个投影

v3 live：同步 `attach`（内存 history）；Feature 用 `useAgentStore().fold(projection)` 得到 `ref`。

```ts
const view = store.attach(todos);
view.getState();
const unsubscribe = view.subscribe((todo) => { /* ... */ });
unsubscribe();
view.dispose();
```

`project(projection)` 把同一次 attach 放进串行队列，适合窗口外。v2 侧仍是 `await store.project(...)` 再 `journal.read()`。

## undo / fork 之后：refresh，不是 dispatch

```ts
await store.refresh(() => journal.undo(1));                    // wire 原生 undo
await store.refresh(() => journal.fork('alternative', cursor)); // tree fork 并切换
await store.refresh(() => journal.checkout('main'));            // tree 切回
```

refresh 先执行外部变更，再重读 journal、对所有视图走 `restore`。带 `withHistory` 的视图回退到活跃历史；usage 等未包装的视图保留完整累计。历史切换失败会使 store 进入 `failed`。

## 领域外置大字段（Blobs）

不要包 `withOffload`，不要设 tree 阈值。在组事件时 `put`，事件只带 `ref`。

```ts
import { openSessionTree } from '#/stores/session';

const { stores } = await openSessionTree(directory);
const { ref } = await stores.blobs.put(new TextEncoder().encode(markdown));
await store.dispatch({ type: 'plan.revision', planId: 'p1', title: 'Auth', content: ref });

const text = new TextDecoder().decode(await stores.blobs.get(ref));
```

Feature 里用同一份仓：`const blobs = useBlobs()`，再 `put` 后 `dispatch`。

图走同一 `Blobs`，事件里写 `media://${ref}`，发模型时由 `MediaSource` + resolver 展开。`get` 失败是 `BlobMissingError` / `BlobIntegrityError`，与 `CommittedProjectionError` 无关——blob 不是 journal 记录。

投影只存 `ref`。`reduce` 里禁止 `blobs.get`。

## 写自定义 Projection

```ts
const count: Projection<number, MyEvent, MyCursor> = {
  initial: () => 0,
  reduce: (state, event) => state + 1,
};
```

约束：同步、确定、无 I/O、无时间/随机、不调别的 store。需要光标位置时用 `reduce(state, event, cursor)` 的第三个参数（如 turn 索引）。需要自定义重建时加 `restore(entries)`，或用 `withHistory` 包装。

## 写自定义 Journal

实现 `read/append/close` 三个方法即可（见 [protocol](../reference/protocol.md)）。要点：`append` 返回的 `Entry` 必须携带你分配的 cursor；`read` 返回完整已提交历史；确认级别（内存/写盘/fsync）由你明说，不要把排队当持久化。journal 记录就是领域事件。大字段外置用 `Blobs`。

## 错误处理

```ts
import { CommittedProjectionError, StoreFailedError } from '#/store-v2/store';

try {
  await store.dispatch(event);
} catch (error) {
  if (error instanceof CommittedProjectionError) {
    // 事件已落盘（error.entry），不能重试同一事件；核对历史或重建
  } else if (error instanceof StoreFailedError) {
    // store 已进入 failed，后续写都会失败；需要重建 store
  } else {
    // append 本身失败：事件未提交，按 driver 语义处理
  }
}
```

## 运行验证（实验脚本，非产品测试）

```bash
cd /Users/moonshot/Projects/kimi-code-workspace
node .tmp/event-store-prototype/run.mjs   # 严格 tsc + 语义 + 端到端 + 独立进程恢复
```

三个冒烟（在 237 workspace 下跑）：

```bash
cd doing/refact-237-09-16-human-domain-features
pnpm exec tsx --tsconfig packages/agent-core-v2/tsconfig.json ../../.tmp/event-store-prototype/check-core.mts
pnpm exec tsx --tsconfig packages/agent-core-v2/tsconfig.json ../../.tmp/event-store-prototype/driver-smoke.mts
```

`semantics.mts`（内核语义 17 场景）、`main.mts`（真实事件 + 两种格式端到端 13 场景）是最权威的可执行用法示例，写新用法前先读它们。
