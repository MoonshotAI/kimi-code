/**
 * `llmProtocol.thinkingEffort` — thinking budget knob for reasoning-capable
 * models.
 *
 * `ThinkingEffort` is the per-turn effort level the caller wants the model to
 * spend on reasoning (concrete values are kosong-defined; v2 code passes it
 * through to `Model.withThinking(...)`).
 */

export type { ThinkingEffort } from './provider';
