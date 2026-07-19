/**
 * `kosong/model` domain (L2) — per-request override knobs.
 *
 * `KimiModelOverrides` is the resolved value of the `modelOverrides` effective
 * config section (populated by the `KIMI_MODEL_*` env overlay). Consumers fold
 * these into `LLMCallParams` — `temperature`/`topP` into `sampling`,
 * `thinkingKeep` into the thinking intent, `maxCompletionTokens` into the
 * completion budget. Each wire dialect encodes (or drops) the resulting
 * intent in its own hooks.
 *
 * Kept in a small standalone file (instead of `model.ts`) so it can be
 * imported by both the profile that reads it and the requester path that
 * applies the completion cap, without dragging in the full model schema.
 */

export interface KimiModelOverrides {
  readonly temperature?: number;
  readonly topP?: number;
  readonly thinkingKeep?: string;
  readonly maxCompletionTokens?: number;
}
