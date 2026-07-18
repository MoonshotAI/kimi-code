/**
 * `model` domain — per-request override knobs.
 *
 * `KimiModelOverrides` is the resolved value of the `modelOverrides` effective
 * config section (populated by the `KIMI_MODEL_*` env overlay). Consumers
 * apply these to a Model via `.withGenerationKwargs(...)` and
 * `.withMaxCompletionTokens(...)`. `thinkingKeep` maps to Kimi-specific
 * `thinking.keep` extra-body; other protocols ignore it.
 *
 * Kept in a small standalone file (instead of `model.ts`) so it can be
 * imported by both the profile that reads it and the llmRequester that
 * applies the completion cap, without dragging in the full model schema.
 */

export interface KimiModelOverrides {
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
}
