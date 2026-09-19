# 计数器完整程序

最小端到端流程：内存 journal → 开 store → dispatch → 断言 → 重放校验 → 关闭。与 `.tmp/event-store-prototype/check-core.mts` 等价（该脚本每次 CI 式运行都真实执行）。

```ts
import assert from 'node:assert/strict';
import { openStore, replay } from '#/store-v2/store';
import type { Entry, Event, Journal } from '#/store-v2/store';

function memoryJournal<E extends Event>(): Journal<E, { readonly offset: number }> {
  const entries: Entry<E, { readonly offset: number }>[] = [];
  let closed = false;
  return {
    read: async () => structuredClone(entries),
    append: async (event) => {
      if (closed) throw new Error('Journal is closed');
      const entry = { event: structuredClone(event), cursor: { offset: entries.length } };
      entries.push(entry);
      return structuredClone(entry);
    },
    close: async () => { closed = true; },
  };
}

const event = { type: 'core.check', value: 1 };
const journal = memoryJournal<typeof event>();
const projection = {
  initial: () => 0,
  reduce: (state: number, input: typeof event) => state + input.value,
};

const store = await openStore({ journal, projection });
await store.dispatch(event);
assert.equal(store.getState(), 1);
assert.equal(replay(projection, await journal.read()), 1);
await store.close();
```

读法：

- `openStore` 时 journal 为空，根视图状态是 `initial()`。
- `dispatch` 确认后 `getState()` 立即反映新状态（串行队列内 append → 投影 → 通知）。
- `replay` 用同一份 projection 独立重放 journal，结果与 live 状态一致——状态确实只是事件的投影。
- `close` drain 后关闭 journal；此后 dispatch 拒绝。

下一步：把 `memoryJournal` 换成 `treeJournal(tree, branch)`（见 [drivers](../reference/drivers.md)），给 projection 加 `restore` 或套 `withHistory`（见 [composition](../reference/composition.md)），大字段用 `stores.blobs.put` 只把 `ref` 写进事件（见 [Blobs](../reference/blobs.md)）。
