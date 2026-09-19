# 安装 createMedia 让 lower 物化媒体

How-to：给产品树装一个 `createMedia`，让 Agent 在协议 `lower` 里把 ContentPart 上的媒体 ref 收成内联 base64 或上传后的 file-id。

## 选择边界

适用于会话里只存 `media://` / `data:`，真正编进协议报文发生在组包。上传通道写在各 Provider 的 `media` 字段上，不要为每个 requester 再装一份 `createMedia`。

不装时 `data:` / `https:` 仍会 lower；`media://` 没有 source 会变成 unavailable 文本，也不会登记 degrade。

```text
App：features: [providerCatalog, media]
└── Agent：useFeatureSlot('agent')
    └── media:agent
        ├── useMediaLower({ source, cache, providers })
        └── useLlmRecovery(degrade)
```

## 安装

`createMedia` 只有 agent 槽。写在 App / Session / Agent 的 `features` 都会传到 Agent；子层继承父层名单。Feature 名固定是 `media`，装两份会撞 slot key，且 `registerMedia` 拒绝重复登记。

```ts
const store = createMemoryMediaStore();
const cache = createMemoryMediaUploadCache();
const media = createMedia({ source: store, cache });

const app = mountApp({ features: [providerCatalog, media] });
```

磁盘会话要把 file-id 映射留下来时，cache 用 `createBlobMediaUploadCache`，传入会话目录的 **`BlobBackend`**（`NodeBlobBackend` 的 `read` / `write`），不是 `Blobs` / `useBlobs()` 的内容寻址 `put` / `get`。

`source` 存原始字节；`cache` 存 `(本地 ref, providerId) → { url, id }`。两者都是内存实现时，重启后映射和字节都没了。

## 往消息里放媒体

ContentPart 的 `image_url` / `audio_url` / `video_url` 只表达 ref，不要把 file-id 写回去。

```ts
const ref = await store.put({
  bytes,
  mimeType: 'image/png',
  filename: 'shot.png',
});

agent.submit({
  role: 'user',
  content: [
    { type: 'text', text: '看看这张图' },
    { type: 'image_url', imageUrl: { url: buildMediaRefUrl(ref) } },
  ],
});
```

直接放 `data:image/png;base64,…` 也可以。不装 `createMedia` 不会单独挡掉 base64；会变成占位的是模型 `capability.*_in !== true`、mime 和 part 对不上，或协议自己的规则（Anthropic 丢音频，openai-responses 丢视频）。

## 物化发生在哪一步

`runLlmRequest` 把 `ports.media` 写入 `content.media` → `composeProtocolRequest` → **`await ports.lower`**。四个 codec 对媒体 part 调用 `materializeMediaPart`，然后才 `assemble` / `encode` / `send`。不要包一层 `LlmRequester`。请求寿命见 [绑定 Provider 并发一次 LLM 请求](run-llm-request.md)。

- `data:`：内联 base64，不读 source / cache。
- `media://` 图 / 音频：`source.get` 后内联，不上传。
- `media://` 视频：先 `cache.get`；未命中则 `source.get`，再调当前模型 Provider 的 `media.uploadVideo`，把 `{ url, id }` 写入 cache；没有 uploader 再试 `inlineVideo`。

`providers` 来自 [useCollection](../reference/use-collection.md) 折叠的 `Providers`。要视频上传，同时装 `providerCatalog`，并用 `useProvider` 贡献带 `media` 的 Provider。查找键是 `ctx.model.provider`。

`createMedia` 用 `useMediaLower` 登记 `AgentPorts.media`，再用 `useLlmRecovery` 装 degrade。卸载 Feature 会撤 ports 和 degrade。不要再为媒体登记 `useMessageResolver`。

请求过大或 `image_format` 时，degrade 改的是未 lower 的 ContentPart ref，下一轮再物化。

## 边界

- 一个 `createMedia` 够用。各家上传 API 写在 `Provider.media.uploadVideo` / `inlineVideo`，不是 Feature 参数。
- media ports 挂在 Agent 的 `AgentPort` 上，和 recovery 一样；协议测试可以直接给 `content.media`，不必经过 Feature。
- `UNKNOWN_CAPABILITY` 的 `image_in` / `video_in` / `audio_in` 都是 false，base64 也会被 omit。
- 现在只有视频走 file-id cache；图和音频不上传。

源码：见 [代码定位](../reference/source-map.md)，v3 `builtin/media/feature.ts`、`llm/media/materialize.ts`、`llm/builtin/media/degrade.ts`、`llm/requester/policy.ts` 的 `runLlmRequest`、`llm/protocol/runner.ts` 的 `composeProtocolRequest`。`createMemoryMediaStore` / `createMemoryMediaUploadCache` 在 `llm/builtin/media`。
