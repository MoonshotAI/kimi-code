# 14. 安装 createMedia 物化 store ref 媒体

How-to：给产品树装一个 `createMedia`，让 agent 在每次 LLM 请求前把 `{ kind: 'store', ref }` 的媒体 part 物化成内联 base64 或上传后的 url / file-id。

## 选择边界

适用于会话里只存 store ref（harness 约定 `media://<sha256>` 字符串，`buildMediaRefUrl` / `parseMediaRefUrl` 从 `@moonshot-ai/harness-core` 导出），真正编进协议报文发生在组包前的 resolver 一步。上传通道写在 endpoint 的 `files` 字段上（kimi / deepseek 的预制 requester 已携带），不再按 provider 查表。

不装时 `{ kind: 'url' }` / `{ kind: 'inline' }` 仍会进请求（协议按 capability 与自己的 media 支持表决定收或换成占位文本）；`{ kind: 'store' }` 没有 resolver 会在 encode 时抛 syntax 错误（unresolved ref），也不会登记 degrade recovery。

```text
App：features: [media]
└── Agent：useFeatureSlot('agent')
    └── media:agent
        ├── useMessageResolver(createStoreRefResolver({ store, cache }))
        └── useLlmRecovery(createMediaDegradeRecovery())
```

## 安装

harness 的 `createMedia({ workDir, store, cache, host?, originalsDir? })` 占 app + agent 两层（app 层注册 `image` config 节与 `MediaLibraryRef`；agent 层装 resolver / degrade / ReadMediaFile 工具 / prompt gate）。写在 App / Session / Agent 的 `features` 都会传到 Agent；子层继承父层名单。Feature 名固定是 `media`，装两份会撞 slot key；与 agent-core builtin `createMedia` 同挂则同 id `store-ref` 的 resolver 重复登记，挂载期抛 `duplicate message resolver: 'store-ref'`。

```ts
import { createMemoryRefStore, createMemoryUploadCache } from '@moonshot-ai/agent-core';
import { createMedia } from '@moonshot-ai/harness-core';

const store = createMemoryRefStore();
const cache = createMemoryUploadCache();
const media = createMedia({ workDir: process.cwd(), store, cache });

const app = createHarness({ features: [media] });
```

`store` 是 `MediaStore`（`RefStore` + `put`）：存原始字节。`cache` 是 `UploadCache`：存 `(ref, account) → { source, expiresAt? }` 上传映射。两者都是内存实现时，重启后映射和字节都没了。磁盘会话要把上传映射留下来时，cache 用 `createBlobUploadCache`，传入会话目录的 **`BlobBackend`**（`read` / `write`），不是 `Blobs` / `useBlobs()` 的内容寻址 `put` / `get`。

agent-core builtin `createMedia({ store, cache })`（`@moonshot-ai/agent-core`）只有 resolver + degrade 两个贡献，没有工具 / prompt gate / library facade；harness 版是它的产品超集。

## 往消息里放媒体

媒体 part 是 `{ type: 'image_url' | 'audio_url' | 'video_url', source, name?, omitted? }`；file-id / url 留在 upload cache 或 part 的 `source` 上，不由调用方预先展开。

```ts
const ref = await store.put({
  bytes,
  mimeType: 'image/png',
  filename: 'shot.png',
});

await agent.submit({
  role: 'user',
  content: [
    { type: 'text', text: '看看这张图' },
    { type: 'image_url', source: { kind: 'store', ref: buildMediaRefUrl(ref) }, name: 'shot.png' },
  ],
});
```

`source.ref` 会原样传给 `RefStore.get`——part 上带的 ref 必须就是 store 的键（harness 约定 `media://<sha256>`，HTTP / WS 面用 `parseMediaRefUrl` 剥 scheme 后再服务字节）。直接放 `{ kind: 'inline', mimeType, data: '<base64>' }` 或 `{ kind: 'url', url }` 也可以，不装 `createMedia` 不会单独挡掉它们。

## 物化发生在哪一步

`runLlmRequest` 每次 attempt 先跑 `policy.resolvers`（store-ref resolver 是其中一个 `MessageResolver`），然后才 settle / encode——物化收在 policy 循环里，协议与 requester 保持薄传输。请求寿命见 [绑定 Provider 并发一次 LLM 请求](15-run-llm-request.md)。

`store` ref 的物化顺序（per kind、per 上传账号有 memo）：

- 端点为该 kind 声明了 `endpoint.files` 上传通道：先查 `cache.get(ref, account)`，未命中则 `store.get` 读出字节、解析 mime（sniff + 声明 + 文件名），调 `files.upload`，把结果写进 cache；上传返回的 source 协议不接受时回落内联。
- 没有上传通道：`store.get` 后内联 base64。
- store 里找不到或 mime 解析不出：换成「media unavailable」占位文本。
- mime 不被协议接受：换成 `stripped` 占位文本。
- 模型 `capability.*_in !== true`（capability 可选，缺省按 false 处理）或协议不支持该 kind：part 原样留给 encode 前的协议规则 `legalizeMedia`，由它换成占位文本。

inline 媒体另有每请求预算（resolver 内建，不是独立政策）：去重总量超 `DEFAULT_MEDIA_BUDGET`（20MB）时从最旧起换成 `budget` 占位文本直至 ≤10MB，并经 `llm.notice` 报 `media-budget-exceeded`；被丢的 key 在同一会话内保持丢弃。

请求失败 `request_too_large` / `image_format` 时，degrade recovery 不给替换文本，而是给媒体 part 打 `omitted` 标记（`request_too_large` 先 `degraded`、保留最近 2 个，再 `stripped`；`image_format` 直接 `stripped`），下一次 attempt 由 resolver 把打了标记的 part 物化成占位文本。重试以 `llm.retrying { reason: 'recovery', strategy: 'media-degrade', action }` 外发。

## 边界

- 一个 `createMedia` 够用。各家上传 API 写在 `endpoint.files`（`LlmFiles`：声明 `kinds` + `upload`），不是 Feature 参数，也不按 provider 查表。
- store-ref resolver 是 `AgentPorts` 上的 `MessageResolver`（id `store-ref`），和 recovery 一样经贡献 hook 注册；卸载 Feature 会撤掉两者。
- 上传遇 401 / 403 且凭证声明 `canRecover`：resolver 内 `invalidate` 后用新凭证重试一次。
- 降级媒体是在 part 上打 `omitted` 标记（保留原 source），不是当场替换成占位文本——替换发生在下一次物化。

源码：见 [代码定位](../reference/source-map.md)，`packages/agent-core/src/llm/builtin/policy/store-ref/`（resolver / materialize / session / adapters）、`llm/builtin/policy/media-degrade.ts`、`llm/policy/policy.ts` 的 `runLlmRequest`、`llm/protocol/rules/media.ts`；builtin `createMedia` 在 `packages/agent-core/src/builtin/media/feature.ts`，harness 产品域在 `packages/harness-core/src/features/media/`。
