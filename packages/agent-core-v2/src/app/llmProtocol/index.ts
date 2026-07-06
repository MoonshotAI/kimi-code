/**
 * `llmProtocol` domain barrel — v2's public wire-type namespace for LLM
 * requests.
 *
 * Downstream v2 code and its consumers import wire types from here. The
 * implementation is the kosong wire source, kept flat in this directory so
 * field shapes remain bit-identical (wireRecord's on-disk format stays
 * readable, no data migration needed). Phase 8 (native adapters) will replace
 * the implementation without changing this path.
 *
 * The domain owns:
 *   - message wire types + helpers (Message / ContentPart / ToolCall / ...)
 *   - Tool descriptor (name / description / JSON-Schema parameters)
 *   - TokenUsage + accumulator helpers
 *   - FinishReason discriminator
 *   - ModelCapability matrix + UNKNOWN sentinel
 *   - ThinkingEffort knob
 *   - Error surface (ChatProviderError family) + retry predicates
 *   - Per-request envelope types (ProviderRequestAuth, GenerateCallbacks, ...)
 *   - Kimi-protocol-specific option types
 *
 * The domain does NOT own:
 *   - ProviderConfig / ProviderType (kosong's older bundled model — v2's
 *     Platform/Provider/Protocol domains replace these).
 *   - ChatProvider interface (replaced by v2's Model god object).
 *   - `createProvider` / `generate` (kosong runtime, invoked internally by
 *     `Model.request()` — not exported here).
 */

export * from './capability';
export * from './errors';
export * from './finishReason';
export * from './kimiOptions';
export * from './message';
export * from './messageHelpers';
export * from './request';
export * from './thinkingEffort';
export * from './tool';
export * from './usage';
