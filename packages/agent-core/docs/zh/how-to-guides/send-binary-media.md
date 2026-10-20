# 发送图片、视频和音频

这是一篇 how-to 文档：说明如何在请求中附带二进制媒体，让它按目标协议被上传或内联。

## 步骤

1. 可选：存储之前先规整图片（Node 宿主）。`compressImage(bytes, mimeType)`（`src/image/compress.ts`）会把每条边缩到最多 2000 px，并尽量压缩到 3.75 MiB 以内；`cropImage` 用于裁剪区域。浏览器宿主改用 `createImageBitmap` / `OffscreenCanvas`。
2. 存储字节，消息里只保留引用。可以把字节放进 `BlobStore`（`src/blob/`，用 `openBlobStore(backend)` 打开，后端可选 memory、Node 或 Durable Object），再传入 `createBlobRefStore(blobs)`；也可以在自己的存储上实现 `RefStore.get(ref)`（`src/llm/builtin/policy/store-ref/ports.ts`）。
3. 用 `store` 来源引用媒体：`{ type: 'image_url', source: { kind: 'store', ref } }`（`video_url`、`audio_url` 同理）。
4. 在 `policy.resolvers` 里加入 `createStoreRefResolver(...)`，并在整个会话中复用同一个实例；它保存着按会话维护的 memo 和预算状态。
5. 在 `policy.recoveries` 里加入 `createMediaDegradeRecovery()`，这样过大或无法解码的媒体会被降级，而不是让整次运行失败。
6. 确认模型 spec 开启了对应的媒体类型（`capability.image_in`、`video_in`、`audio_in`），或者协议能按模型名推断出来，并且协议的 `MediaSupport` 声明了这种类型；否则这个 part 会以占位文本发送。

```ts
import { memoryBlobBackend } from '#/blob/backend/memory';
import { openBlobCache, openBlobStore } from '#/blob/index';
import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import {
  createBlobRefStore,
  createBlobUploadCache,
  createStoreRefResolver,
} from '#/llm/builtin/policy/store-ref/index';
import { kimiRequester } from '#/llm/builtin/provider/index';
import { compressImage } from '#/image/index';

const backend = memoryBlobBackend();
const blobs = openBlobStore(backend);
const image = await compressImage(bytes, 'image/png');
const { ref } = await blobs.put({ bytes: image.data, mimeType: image.mimeType, filename: 'shot.png' });
const media = createStoreRefResolver({
  store: createBlobRefStore(blobs),
  cache: createBlobUploadCache(openBlobCache(backend, 'media-upload')),
});

const result = await kimiRequester.generate(
  {
    model: { spec: { provider: 'kimi', name: 'kimi-k2', capability: { image_in: true } } },
    content: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the screenshot.' },
            { type: 'image_url', source: { kind: 'store', ref } },
          ],
        },
      ],
    },
    policy: { resolvers: [media], recoveries: [createMediaDegradeRecovery()] },
  },
  { signal: AbortSignal.timeout(60_000) },
);
```

## Resolver 最终发送什么

对每个 `store` part，按以下顺序判断（`src/llm/builtin/policy/store-ref/materialize.ts`）。part 所在的位置（消息内容或 tool result）决定使用协议声明里的哪条规则。

| 条件 | 结果 |
|---|---|
| part 标记了 `omitted` | 对应原因的占位文本 |
| 模型能力没有开启这种类型，或协议在这个位置不接受它 | 原样保留，由 encode 渲染占位文本 |
| 同一账号已经处理过、未过期，且来源形式被接受 | 使用 memo 的来源 |
| `endpoint.files.kinds` 包含这种类型，且有未过期、形式被接受的上传缓存 | 缓存中的来源 |
| 来源里没有字节，或字节和 part 的类型对不上 | `[<kind> omitted: media unavailable]` |
| MIME 不被协议声明接受 | `stripped` 占位文本 |
| 上传成功，且协议接受返回的来源形式 | 返回的 `url` 或 `file` 来源，并写入缓存 |
| 上传返回 401/403 | 作废凭据，在 `credentials.canRecover` 允许时 resolver 重试一次 |
| 上传因其他原因失败，或返回了协议不接受的形式 | 退回内联 |
| 协议不接受这种类型的内联来源 | `[<kind> omitted: media unavailable]` |
| 其他情况 | 内联 base64 |

MIME 类型会从字节里嗅探；对图片来说，嗅探出的类型优先于声明的类型。解析出的 `url`、`file`、`inline` 来源只存在于本次请求的副本里，宿主的历史始终保留 `store` 引用。

## 上传

上传是 provider 的能力，挂在 `endpoint.files` 上；引用已上传的文件是协议的能力，写在它的 `MediaSupport` 里（`sources` 包含 `url` 或 `file`）。引用的形状由上传器决定：

- 如果 provider 接受把它的文件引用当作媒体 URL，就返回 `{ kind: 'url', url }`。Kimi 的 requester（`kimiRequester`、`kimiAnthropicRequester`、`kimiResponsesRequester`）就是这样，对图片和视频返回 `ms://<file id>`。
- DeepSeek 的 requester（`deepseekRequester`、`deepseekAnthropicRequester`）通过 DeepSeek Files API 上传图片，有效期 30 天，返回 `file` 来源；`expiresAt` 设在文件过期前一小时。
- 如果协议有原生的文件引用，就返回 `{ kind: 'file', id, mimeType }`：Anthropic 图片（`source.type: 'file'`，files beta header 会自动加上）、OpenAI Responses 图片（`input_image.file_id`）、Google GenAI（`fileData.fileUri`）。

```ts
import type { LlmFiles } from '#/llm/request';

const files: LlmFiles = {
  kinds: new Set(['image']),
  upload: async (file, { endpoint, signal }) => {
    const id = await uploadToProvider(endpoint, file.data, file.mimeType, file.filename, signal);
    return { source: { kind: 'file', id, mimeType: file.mimeType }, expiresAt: Date.now() + 47 * 3600_000 };
  },
};

await anthropicRequester.generate({ endpoint: { files }, model, content, policy: { resolvers: [media] } }, { signal });
```

- `file` 带有 `kind`、`data`、`mimeType`、`filename`。不在 `files.kinds` 里的类型不会被上传。
- `expiresAt`（毫秒时间戳）过期后，memo 和上传缓存都会忽略这条记录，文件会被重新上传。
- 上传缓存的 key 由 store ref 和账号 key（媒体类型、provider、base URL、凭据身份的哈希）组成，切换账号时不会复用别的账号的文件。`createBlobUploadCache(cache)`（`src/llm/builtin/policy/store-ref/adapters/blob.ts`）把条目存进 `BlobCache`；后端能持久化时缓存就能跨进程保留，缓存读写失败会被忽略。
- 已知缺口：文件在 `expiresAt` 之前就被 provider 删掉时，请求会以远端错误失败；目前还没有清掉缓存条目的 recovery。

## 预算

内联媒体按单次请求计量。超过 `budget.maxBytes`（默认 20 MiB）时，从最旧的内联媒体开始替换成 `budget` 占位文本，直到总量低于 `budget.lowBytes`（默认 10 MiB），并发出 `media-budget-exceeded` notice。被丢掉的媒体在之后通过同一个 resolver 的请求里会继续保持丢弃。用 `createStoreRefResolver(ports, { budget })` 可以修改这两个阈值。

## 自定义占位文本

在 resolver 的 ports 里传 `placeholder: ({ kind, reason, ref }) => string | undefined`，可以替换 `degraded`、`stripped`、`budget` 这几种省略的默认文本；返回 `undefined` 则保留默认文本。

## 排查

| 现象 | 原因 |
|---|---|
| `failed` 结果，`syntax` 错误，信息为 `Unresolved media reference` | `policy.resolvers` 里没有 store-ref resolver，或者自定义 resolver 留下了 `store` 来源 |
| 占位文本 `not supported by this model` | 模型的有效能力没有开启这种媒体类型 |
| 占位文本 `not supported by this provider` | 协议的 `MediaSupport` 没有声明这种类型，或不允许它出现在 tool result 里 |
| 占位文本 `for provider compatibility` | MIME 或来源形式不被协议声明接受 |
| 占位文本 `media unavailable` | `RefStore.get` 没有返回内容（用 `createBlobRefStore` 时也包括 blob 校验失败）、字节和类型对不上，或者协议无法内联这种类型且没有能处理它的上传器 |
| `request_too_large` 或 `image_format` 导致运行结束 | 没有注册 `createMediaDegradeRecovery()`，或者两步降级都已经用过 |
