# Blobs：领域选择的外置

源码：`packages/agent-core/src/store/blob.ts`

`Blobs` 与 Journal 平级：领域在 `dispatch` 之前把字节外置，事件字段只留 `ref`。外置发生在这里，是因为只有领域知道哪个字段大、何时需要全文——Store / Journal / Tree 保持格式无关，不按阈值自动卸内容。

`tree/codec.ts` 只负责 jsonl 的 header / 行；事件词汇与字段形状由领域自己决定。

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
- 产品入口：`stores.blobs`（`openSessionStores(tree, blobs)`）或 Feature 的 `useBlobs()`。blob 目录由 `openSessionTree` 在会话目录统一组装（`NodeBackend` 的 trees/blobs）；`Trees` 不持有 blobs。
- 没有按类型的注册表。领域在组事件时调用 `put`，就是选择。

jsonl 行永远是 `{ kind, size, data }`：行保持小而同构，大块字节走 `Blobs`。

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

mime / filename 由 `MediaSource` 解释；`createMediaRefResolver` 在组 provider 请求时 `get` 再变成 data URL。事件里始终只有 `media://` ref，展开只发生在组请求这一步。

**工具大输出**同理：事件带截断文本 + `outputRef`，需要全文的调用方再 `get`。

## 边界

- 外置只发生在 `dispatch` 之前、由领域显式 `put`：Tree / Journal 始终面对同构的小事件，重放路径上没有还原逻辑。
- 投影里只存 `ref`（reducer 保持纯函数）；物化发生在读侧的组请求 / 展示一步。
- 策略就是事件字段形状（`content` / `media://` / `outputRef`）：每种形状在领域事件里写一次，读路径按形状分支，没有按类型的转译层。
- undo / checkout 之后物理 blob 不删除；历史视图决定哪些 `ref` 还可见，磁盘回收是独立话题。
