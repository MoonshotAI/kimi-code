# @moonshot-ai/kosong

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
