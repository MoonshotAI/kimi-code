# 计数器完整程序

最小端到端：内存 journal → 开 store → dispatch → 断言 → 重放 → 关闭。

```ts
import assert from 'node:assert/strict';
import { openStore, replay, type Entry, type Journal } from '@moonshot-ai/agent-core';

function memoryJournal<E extends { type: string }>(): Journal<E, { readonly offset: number }> {
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
    close: async () => {
      closed = true;
    },
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

下一步：把内存 journal 换成 `treeJournal`（见 [drivers](../reference/drivers.md)），给 projection 加 `restore` 或套 `withHistory`（见 [composition](../reference/composition.md)），大字段用 `stores.blobs.put`（见 [blobs](../reference/blobs.md)）。
