/**
 * `llmProtocol.request` — request-time hooks and stream metadata.
 *
 * `ProviderRequestAuth` describes the auth material handed to a provider
 * per request (bearer token or api key with optional freshness callback).
 * `GenerateCallbacks` collects the instrumentation callbacks the loop wires
 * up (`onRequestStart | onRequestSent | onStreamEnd`). `StreamDecodeStats`
 * carries per-request decode timing statistics surfaced back to the caller.
 * `VideoUploadInput` describes the input to a provider's video-upload path
 * (kosong-side helper still used by media tooling).
 *
 * These are kept as a small explicit surface used by `Model.request(...)`;
 * they don't live in `message.ts` because they describe the request-time
 * envelope, not wire content.
 */

export type { GenerateCallbacks } from './generate';
export type { ResponseFormat } from './provider';
export type {
  MaxCompletionTokensOptions,
  ProviderRequestAuth,
  StreamDecodeStats,
  VideoUploadInput,
} from './provider';
