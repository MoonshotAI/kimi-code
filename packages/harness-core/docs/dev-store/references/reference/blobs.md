# Blobs：领域选择的外置

源码：`doing/refact-237-09-16-human-domain-features/packages/agent-core-v3/src/store/blob.ts`

`Blobs` 与 Journal 平级：领域在 `dispatch` 之前把字节外置，事件字段只留 `ref`。Store / Journal / Tree **不会**按阈值自动卸内容。没有 `mapJournal`、`withOffload`、`store.offloaded`、tree `offloadThreshold`、行内 payload `{ref}`。

`tree/codec.ts` 只负责 jsonl 的 header / 行，不是事件转译层。

```ts
interface BlobRef { readonly ref: string; readonly size: number }

interface Blobs {
  put(bytes: Uint8Array): Promise<BlobRef>;
  get(ref: string): Promise<Uint8Array>;
  has(ref: string): Promise<boolean>;
}

openBlobs(backend): Blobs
memoryBlobs(): Blobs
```

- `ref` 是内容的 SHA-256；相同字节去重。`get` 校验 hash，缺失抛 `BlobMissingError`，损坏抛 `BlobIntegrityError`。
- `BlobRef` **不含** mime / 文件名 / 编码。那些写在事件字段或领域自己的 source 里。
- 不进 `dispatch`，不改事件 `type`。reducer 禁止 I/O，投影里只存 `ref`。
- 产品入口：`stores.blobs`（`openSessionStores(tree, blobs)`）或 Feature 的 `useBlobs()`。`openSessionTree` 在会话目录组装 `NodeBackend` 的 trees/blobs，不要另起一套 blob 目录。`Trees` 不持有 blobs。
- 没有按类型的注册表。领域在组事件时调用 `put`，就是选择。

jsonl 行永远是 `{ kind, size, data }`。大块不该出现在 `data` 里。

## 领域用法

**plan 正文**——列表只要标题，打开某一份再取正文：

```ts
const { ref } = await stores.blobs.put(new TextEncoder().encode(markdown));
await store.dispatch({ type: 'plan.revision', planId, title, content: ref });

const text = new TextDecoder().decode(await stores.blobs.get(ref));
```

**base64 图**——事件里只留 `media://`，发模型时再展开：

```ts
const { ref } = await stores.blobs.put(bytes);
const part = { type: 'image_url', imageUrl: { url: `media://${ref}` } };
await store.dispatch({ type: 'message.appended', message: { role: 'user', content: [part] } });
```

mime / filename 由 `MediaSource` 解释；`createMediaRefResolver` 在组 provider 请求时 `get` 再变成 data URL。不要把 data URL 写进事件指望 Journal 卸走。

**工具大输出**同理：事件带截断文本 + `outputRef`，需要全文的调用方再 `get`。

## 不要做的

- 不要整事件换成 `store.offloaded`，再在 `read` 时还原给所有投影。
- 不要按 JSON 字节阈值在 Tree / Journal 里自动外置。
- 不要在 `reduce` 里 `blobs.get`。
- 不要为「不同类型不同策略」做事件转译层；策略就是事件字段形状（`content` / `media://` / `outputRef`）。
- undo / checkout 之后物理 blob 不删除；历史视图决定哪些 `ref` 还可见，不决定磁盘回收。
