# Send Images, Video and Audio

This is a how-to guide: it shows how to attach binary media to a request so it is uploaded or inlined for the target protocol.

## Steps

1. Optionally normalize images before storing them (Node hosts): `compressImage(bytes, mimeType)` (`src/image/compress.ts`) resizes to at most 2000 px per edge and recompresses toward 3.75 MiB; `cropImage` crops a region. Browser hosts use `createImageBitmap` / `OffscreenCanvas` instead.
2. Store the bytes and keep only a reference in the message. Put them into a `BlobStore` (`src/blob/`, `openBlobStore(backend)` over a memory, Node or Durable Object backend) and pass `createBlobRefStore(blobs)`, or implement `RefStore.get(ref)` (`src/llm/builtin/policy/store-ref/ports.ts`) over your own storage.
3. Reference the media with a `store` source: `{ type: 'image_url', source: { kind: 'store', ref } }` (`video_url`, `audio_url` likewise).
4. Add `createStoreRefResolver(...)` to `policy.resolvers` and keep the same instance for the whole conversation; it holds the per-conversation memo and budget state.
5. Add `createMediaDegradeRecovery()` to `policy.recoveries` so oversized or undecodable media is degraded instead of failing the run.
6. Make sure the model spec enables the media kind (`capability.image_in`, `video_in`, `audio_in`), or that the protocol infers it from the model name, and that the protocol's `MediaSupport` declares the kind; otherwise the part is sent as a placeholder.

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

## What the resolver sends

For each `store` part, in order (`src/llm/builtin/policy/store-ref/materialize.ts`). The part's position (message content or tool result) selects the protocol declaration.

| Condition | Result |
|---|---|
| Part is marked `omitted` | Placeholder text for the reason |
| Model capability does not enable the kind, or the protocol does not accept it at this position | Left as is; encode renders the placeholder |
| Already materialized for the same account, not expired, and the source form is accepted | Memoized source |
| `endpoint.files.kinds` includes the kind and a fresh cached upload exists in an accepted form | Cached source |
| Source has no bytes, or the bytes do not match the part's kind | `[<kind> omitted: media unavailable]` |
| MIME type not accepted by the protocol declaration | `stripped` placeholder |
| Upload succeeds and the protocol accepts the returned source form | Returned `url` or `file` source, cached |
| Upload fails with 401/403 | Credentials invalidated and the resolver retries once when `credentials.canRecover` allows |
| Upload fails otherwise, or returns a form the protocol does not accept | Falls back to inline |
| Protocol does not accept inline sources for the kind | `[<kind> omitted: media unavailable]` |
| Otherwise | Inline base64 |

MIME types are sniffed from the bytes; for images the sniffed type wins over the declared one. The resolved `url`, `file` and `inline` sources exist only in the per-request copy; the host's history keeps the `store` ref.

## Upload

Uploading is a provider capability on `endpoint.files`; referencing an uploaded file is a protocol capability in its `MediaSupport` (`sources` includes `url` or `file`). The uploader decides the reference shape:

- Return `{ kind: 'url', url }` when the provider accepts its file reference as a media URL. Kimi requesters (`kimiRequester`, `kimiAnthropicRequester`, `kimiResponsesRequester`) do this with `ms://<file id>` for images and videos.
- DeepSeek requesters (`deepseekRequester`, `deepseekAnthropicRequester`) upload images through the DeepSeek Files API with a 30-day lifetime and return `file` sources; `expiresAt` is set one hour before the file expires.
- Return `{ kind: 'file', id, mimeType }` when the protocol has native file references: Anthropic images (`source.type: 'file'`, with the files beta header added automatically), OpenAI Responses images (`input_image.file_id`), Google GenAI (`fileData.fileUri`).

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

- `file` carries `kind`, `data`, `mimeType` and `filename`. Kinds outside `files.kinds` are never uploaded.
- `expiresAt` (epoch ms) makes the memo and the upload cache ignore the entry once it passes, so the file is uploaded again.
- Upload cache keys combine the store ref with an account key (media kind, provider, base URL, hashed credential identity), so switching accounts never reuses another account's file. `createBlobUploadCache(cache)` (`src/llm/builtin/policy/store-ref/adapters/blob.ts`) stores entries in a `BlobCache`; it persists across processes when the backend does, and cache read or write failures are ignored.
- Known gap: a file deleted on the provider before `expiresAt` fails the request with a remote error; there is no recovery that evicts the cache entry yet.

## Budget

Inline media is counted per request. Above `budget.maxBytes` (default 20 MiB) the oldest inline items are replaced by `budget` placeholders until the total is below `budget.lowBytes` (default 10 MiB), and a `media-budget-exceeded` notice is emitted. Dropped items stay dropped for later requests through the same resolver. Pass `createStoreRefResolver(ports, { budget })` to change the limits.

## Custom placeholder text

Pass `placeholder: ({ kind, reason, ref }) => string | undefined` in the resolver ports to replace the default text for `degraded`, `stripped` and `budget` omissions; return `undefined` to keep the default.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `failed` outcome with a `syntax` error `Unresolved media reference` | No store-ref resolver in `policy.resolvers`, or a custom resolver left `store` sources |
| Placeholder `not supported by this model` | Effective model capability does not enable the media kind |
| Placeholder `not supported by this provider` | The protocol's `MediaSupport` does not declare the kind, or forbids it inside tool results |
| Placeholder `for provider compatibility` | The MIME type or source form is not accepted by the protocol declaration |
| Placeholder `media unavailable` | `RefStore.get` returned nothing (with `createBlobRefStore`, also a blob that fails its integrity check), the bytes do not match the kind, or the protocol cannot inline the kind and no uploader handles it |
| `request_too_large` or `image_format` ends the run | `createMediaDegradeRecovery()` is not registered, or both degrade steps were already applied |
