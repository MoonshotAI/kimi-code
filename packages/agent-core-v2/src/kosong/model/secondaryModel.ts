/**
 * `kosong/model` domain (L2) — the secondary-model config type.
 *
 * The secondary model is a consumer-neutral pointer to a second model (any
 * configured alias, typically a cheaper one) next to the primary
 * `default_model`. Features that want a non-primary model resolve it from
 * here instead of growing per-feature config keys. The first consumer is
 * subagent spawning (`session/subagent` + `agent/swarm`): when configured,
 * newly spawned subagents bind to it by default instead of inheriting the
 * caller's model, and the spawning tools let the parent model opt back into
 * the primary model per spawn.
 *
 * Kosong owns only the `SecondaryModelConfig` type; the `secondaryModel`
 * section constant (`[secondary_model]` on disk), the zod schema
 * (compile-time pinned to this type), registration, the
 * `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT` env bindings, and the
 * write-path strip all live in the persistence wrapper
 * (`app/kosongConfig/configSection`).
 */

export interface SecondaryModelConfig {
  model?: string;
  effort?: string;
}
