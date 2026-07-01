# @moonshot-ai/kosong

## 0.5.1

### Patch Changes

- [#1269](https://github.com/MoonshotAI/kimi-code/pull/1269) [`bf35f63`](https://github.com/MoonshotAI/kimi-code/commit/bf35f63c5d9b53625f3bf04f50b9a0bb49ced2c9) - Honor `base_url` for the `google-genai` and `vertexai` providers. A configured base URL was previously ignored and requests always went to `generativelanguage.googleapis.com`; it is now forwarded to the Google GenAI SDK (with `GOOGLE_GEMINI_BASE_URL` / `GOOGLE_VERTEX_BASE_URL` env fallbacks), so Gemini-compatible proxies and gateways can be used. Give the host root only — the SDK appends the API version segment itself.

- [#1274](https://github.com/MoonshotAI/kimi-code/pull/1274) [`074bb9b`](https://github.com/MoonshotAI/kimi-code/commit/074bb9ba1359dd3ea2a55eff81986f2bb4772793) - Retry a dropped provider stream instead of failing the turn. A raw undici `terminated` error (an SSE/HTTP response body cut mid-flight, common on long streaming responses) is now classified as a retryable `APIConnectionError` on the Anthropic path — matching the OpenAI path, which already recognized it — so a transient stream drop is retried rather than surfaced as a fatal error.

## 0.5.0

### Minor Changes

- [#1131](https://github.com/MoonshotAI/kimi-code/pull/1131) [`76c643b`](https://github.com/MoonshotAI/kimi-code/commit/76c643bcb6da447c8c47728b4f58512a7a11cfa6) - Cap completion tokens to the remaining context window for chat-completions providers, avoiding context-overflow and invalid max_tokens errors.

## 0.4.6

### Patch Changes

- [#790](https://github.com/MoonshotAI/kimi-code/pull/790) [`d0d5821`](https://github.com/MoonshotAI/kimi-code/commit/d0d58219007cd9d7355f1ea8900e9777b66abda2) - Stop Anthropic-compatible providers from reading ambient Anthropic shell credentials and custom headers.

## 0.4.5

### Patch Changes

- [#343](https://github.com/MoonshotAI/kimi-code/pull/343) [`73be7ba`](https://github.com/MoonshotAI/kimi-code/commit/73be7ba17d41df7999d4c1fba410994e7024eb7b) - Repair mismatched JSON Schema types emitted by Xcode 26.5 MCP server for Moonshot compatibility.

- [#776](https://github.com/MoonshotAI/kimi-code/pull/776) [`ecd7a0a`](https://github.com/MoonshotAI/kimi-code/commit/ecd7a0afb646d14a14c780a4088fd8a59da134ad) - Resolve model capabilities through a static lookup instead of instantiating a temporary provider.

## 0.4.4

### Patch Changes

- [#632](https://github.com/MoonshotAI/kimi-code/pull/632) [`d8cdebf`](https://github.com/MoonshotAI/kimi-code/commit/d8cdebf3c03efa3a3dfa4f1deb3186a8f8f7f5ef) - Degrade unsupported audio/video to placeholder text and reattach tool result media instead of silently dropping them.

- [#658](https://github.com/MoonshotAI/kimi-code/pull/658) [`0381329`](https://github.com/MoonshotAI/kimi-code/commit/0381329570d3dca9fd861761c843968cc1c5e927) - Send OpenAI Responses system prompts as request instructions.

- [#649](https://github.com/MoonshotAI/kimi-code/pull/649) [`a2c5e1b`](https://github.com/MoonshotAI/kimi-code/commit/a2c5e1be25484f7c52f729e333196c485f83b84c) - Add runtime support for dynamic MCP server updates, reference skills, replay timestamps, and Node file uploads.

## 0.4.3

### Patch Changes

- [#626](https://github.com/MoonshotAI/kimi-code/pull/626) [`856ec00`](https://github.com/MoonshotAI/kimi-code/commit/856ec002906f4964086915ceb9aa616b89ab6594) - Preserve image outputs from tools when using OpenAI-compatible chat completions.

## 0.4.2

### Patch Changes

- [#610](https://github.com/MoonshotAI/kimi-code/pull/610) [`b747c6a`](https://github.com/MoonshotAI/kimi-code/commit/b747c6a9501e208250d09cf9a2810c885c6ce91b) - Add Claude Fable 5 support to the Anthropic provider.

## 0.4.1

### Patch Changes

- [#581](https://github.com/MoonshotAI/kimi-code/pull/581) [`aa3471f`](https://github.com/MoonshotAI/kimi-code/commit/aa3471f5d3d2960834ba3239c0b8459144bc79fa) - Pass through xhigh reasoning effort for OpenAI-compatible chat completions requests.

## 0.4.0

### Minor Changes

- [#424](https://github.com/MoonshotAI/kimi-code/pull/424) [`72c4b0a`](https://github.com/MoonshotAI/kimi-code/commit/72c4b0adaa6ae0466875cd8e4066c42456195f21) - Add the `/swarm` command for running agent swarms with live progress and rate-limit-aware retries.

## 0.3.4

### Patch Changes

- [#456](https://github.com/MoonshotAI/kimi-code/pull/456) [`3a98713`](https://github.com/MoonshotAI/kimi-code/commit/3a987130500fe5b403b696850165735c7d0ee076) - Show concise provider filtering errors when responses are blocked before visible output.

- [#458](https://github.com/MoonshotAI/kimi-code/pull/458) [`93eb70a`](https://github.com/MoonshotAI/kimi-code/commit/93eb70a727c9724e19a31b0d2fbebb78b7390c78) - Migrate still-relevant environment variables from kimi-cli:

  - `KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P` — sampling parameters applied globally to any `kimi` provider (not tied to `KIMI_MODEL_NAME`).
  - `KIMI_MODEL_THINKING_KEEP` — Moonshot preserved-thinking passthrough (`thinking.keep`), injected only while Thinking is on.
  - `KIMI_CODE_NO_AUTO_UPDATE` (legacy alias `KIMI_CLI_NO_AUTO_UPDATE`) — fully disables the update preflight (no check, background install, or prompt).

## 0.3.3

### Patch Changes

- [#411](https://github.com/MoonshotAI/kimi-code/pull/411) [`4598262`](https://github.com/MoonshotAI/kimi-code/commit/459826292f855592288bcfddaa1c72529a6d8c64) - Normalize malformed Responses stream rate limit errors as provider rate limit failures.

## 0.3.2

### Patch Changes

- [#365](https://github.com/MoonshotAI/kimi-code/pull/365) [`6a22523`](https://github.com/MoonshotAI/kimi-code/commit/6a2252343a0d624b326b2d369ec908bc8d60092d) - Use the OpenAI completion token field required by newer Chat Completions models.

## 0.3.1

### Patch Changes

- [#327](https://github.com/MoonshotAI/kimi-code/pull/327) [`8809f3e`](https://github.com/MoonshotAI/kimi-code/commit/8809f3eb114172ac64cefe43bbf9b9257c5245c0) - Fix cross-provider replay failures from incompatible tool call IDs and unsigned Claude thinking history.

## 0.3.0

### Minor Changes

- [#232](https://github.com/MoonshotAI/kimi-code/pull/232) [`a24bfb1`](https://github.com/MoonshotAI/kimi-code/commit/a24bfb1df38e58120827a1d8ed881724af2e7b23) - Add `KIMI_MODEL_ADAPTIVE_THINKING` (and a matching `adaptive_thinking` model-alias field) to force adaptive thinking (`thinking: { type: 'adaptive' }`) on or off, overriding the Anthropic model-name version inference. This lets custom-named compatible endpoints that back an adaptive-capable model opt in even when the model name does not encode a parseable Claude version.

### Patch Changes

- [#267](https://github.com/MoonshotAI/kimi-code/pull/267) [`e2e1728`](https://github.com/MoonshotAI/kimi-code/commit/e2e17289fca9bcb23f05cd77f7bcb9cba5db0325) - Report truncated compaction summaries clearly and apply valid completion token budgets across supported providers.

## 0.2.3

### Patch Changes

- [#213](https://github.com/MoonshotAI/kimi-code/pull/213) [`2388f20`](https://github.com/MoonshotAI/kimi-code/commit/2388f20bb3d039e89caefca159801059b90dc64a) - Handle context overflow errors consistently across provider responses.

- [#222](https://github.com/MoonshotAI/kimi-code/pull/222) [`13e0fff`](https://github.com/MoonshotAI/kimi-code/commit/13e0fff462e2ddbec5fb4c9de8ed8e6068db09f1) - Preserve unsigned assistant thinking when serializing history for the Anthropic provider, instead of dropping it. Anthropic-compatible backends (e.g. Kimi) stream thinking without a signature yet reject a tool-call turn whose thinking is missing ("thinking is enabled but reasoning_content is missing"). api.anthropic.com always supplies a signature, so its behavior is unchanged.

- [#207](https://github.com/MoonshotAI/kimi-code/pull/207) [`e280f33`](https://github.com/MoonshotAI/kimi-code/commit/e280f33daf7fbf1271c872dcb224737ec9518f73) - Recover from provider model token limit errors during long conversations.

- [#201](https://github.com/MoonshotAI/kimi-code/pull/201) [`3da4dae`](https://github.com/MoonshotAI/kimi-code/commit/3da4daeadee39573c7eeede30fa9465b411be3e2) - Automatically retry when a model response stream is dropped mid-flight (a `terminated` error) instead of failing the turn.

## 0.2.2

### Patch Changes

- [#92](https://github.com/MoonshotAI/kimi-code/pull/92) [`4e458d6`](https://github.com/MoonshotAI/kimi-code/commit/4e458d63643a56a2fb1ba9f908c774e56eef1c75) - Use one retry classification for transient LLM failures across regular turns and compaction.

## 0.2.1

### Patch Changes

- [#70](https://github.com/MoonshotAI/kimi-code/pull/70) [`d95b013`](https://github.com/MoonshotAI/kimi-code/commit/d95b01342a7921f0863ceb37abad7984d0245509) - Preserve catalog-declared interleaved reasoning fields for OpenAI-compatible models configured through `/connect`.

- [#78](https://github.com/MoonshotAI/kimi-code/pull/78) [`61f7d0e`](https://github.com/MoonshotAI/kimi-code/commit/61f7d0e7a2b9933bdbe7eef9177e67e7386154a2) - Make OpenAI-compatible reasoner models work out of the box for hand-written provider configs. The `openai` provider now auto-detects thinking on incoming responses by scanning the de facto field set (`reasoning_content`, `reasoning_details`, `reasoning`), serializes thinking back as `reasoning_content` by default, and auto-injects `reasoning_effort` whenever the conversation history contains prior thinking — so DeepSeek, Qwen, One API and other gateway-fronted services no longer require a hand-set `reasoning_key`. The `reasoning_key` model-alias field remains available as an explicit override for non-standard gateways.

## 0.2.0

### Minor Changes

- [#30](https://github.com/MoonshotAI/kimi-code/pull/30) [`a200a29`](https://github.com/MoonshotAI/kimi-code/commit/a200a297ac8986ec4baa8d2cdc881ef71bc3abfc) - Add a `/connect` command that configures a provider and model from a model catalog.

- [#25](https://github.com/MoonshotAI/kimi-code/pull/25) [`c4dd1c7`](https://github.com/MoonshotAI/kimi-code/commit/c4dd1c7ff298290ee17d4a6676f93284621f32e8) - Flatten tool call data by inlining tool names and arguments at the top level, and limit legacy record migration so it only rewrites matching tool call payloads.

### Patch Changes

- [#29](https://github.com/MoonshotAI/kimi-code/pull/29) [`df7a9ca`](https://github.com/MoonshotAI/kimi-code/commit/df7a9cab606e0f152bc45b1d1645d76210b1e0c4) - Avoid CPU spikes from large streamed tool arguments and coalesce high-frequency streaming UI updates.
