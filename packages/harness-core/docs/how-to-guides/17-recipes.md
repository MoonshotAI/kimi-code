# 17. Store 操作配方

导入从 `@moonshot-ai/agent-core` 取。包内用 `#/store/store`、`#/stores/session`。

## 开一个产品 session store

```ts
import { MemoryBackend, openSessionContainer } from '@moonshot-ai/agent-core';

const { stores } = await openSessionContainer(new MemoryBackend());
await stores.session.dispatch({ type: 'session.meta_updated', meta: { title: 'demo' } });
const agentStore = await stores.open('main');
await agentStore.dispatch({ type: 'message.appended', message });
stores.session.subscribe((state) => { /* 仅状态变化 */ });
agentStore.onCommit((entry) => { /* 每个已提交事件，重放不触发 */ });
```

磁盘：`openSessionTree(dir)` 或 harness 的 `fsSessionSpace` + `app.open`。

## 开一个裸 store

```ts
import { openStore, treeJournal } from '@moonshot-ai/agent-core';

const journal = treeJournal(tree, branch);
const store = await openStore({ journal, projection: agent() });
const entry = await store.dispatch({ type: 'my.event', time: Date.now() });
store.getState();
```

Feature 里用 `useAgentStore()` / `useSessionStore()`：拿到节点上那份已打开的 journal，自有投影随它持久化、随它重放。

## 后加载一个投影

```ts
const view = store.attach(todos);
view.getState();
const unsubscribe = view.subscribe((state) => { /* ... */ });
unsubscribe();
view.dispose();
```

Feature：`useAgentStore().fold(todos)` 得到 `ShallowRef`，随节点清理。

## undo / 切分支之后：refresh 重投影

```ts
await store.refresh(() => journal.create(freshName, from));
```

产品侧用 `stores.undo(agentId, turns)` / `stores.switchBranch(agentId, { reason, seed })`。带 `withHistory` 的视图回退到新链；未包装的累计投影保留完整历史。`refresh` 失败会使 store 进入 `failed`。

## 领域外置大字段（Blobs）

```ts
const { ref } = await stores.blobs.put(new TextEncoder().encode(markdown));
await store.dispatch({ type: 'plan.revision', planId: 'p1', content: ref });
const text = new TextDecoder().decode(await stores.blobs.get(ref));
```

Feature 里 `const blobs = useBlobs()`。`reduce` 保持纯函数（不 `get`）；图写 `media://${ref}`，物化在 protocol `lower`。

## 写自定义 Projection / Journal

Projection：同步、确定、无 I/O。需要 cursor 时用 `reduce(state, event, cursor)`。Journal：实现 `read` / `append` / `close`；`append` 的 `Entry` 必须带你分配的 cursor。产品路径用 `treeJournal`。

## 错误

`CommittedProjectionError`：事件已落盘（`error.entry`），不能重试同一事件。`StoreFailedError`：store 已 failed，需要重建。其它：append 本身失败，事件未提交。

## 相关文档

- 模型 → [store-model](../explanation/store-model.md)
- 协议 → [protocol](../reference/protocol.md)
- drivers → [drivers](../reference/drivers.md)
