/**
 * `llmProtocol.kimiOptions` — Kimi-specific request-shape knobs.
 *
 * `GenerationKwargs` (temperature / top_p / etc.) and the `thinking.keep`
 * extra-body flag surface here so v2's Model override methods
 * (`withGenerationKwargs`, thinking config) can type-check without reaching
 * into the vendored Kimi provider directly.
 *
 * These are Kimi-protocol-specific knobs — kept in llmProtocol because Model
 * is the god object that applies them, not because they are cross-protocol.
 */

export type {
  ExtraBody,
  GenerationKwargs,
  KimiOptions,
  ThinkingConfig,
} from './providers/kimi';
