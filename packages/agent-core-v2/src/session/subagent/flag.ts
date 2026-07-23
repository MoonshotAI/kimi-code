/**
 * `subagent` domain (L6) — registers the `subagent-model-selection`
 * experimental flag into `flag`.
 *
 * Gates per-workspace subagent model bindings: `[subagent.<type>]` and
 * `[subagent-slot.<name>]` entries in `.kimi-code/local.toml` override the
 * inherit-parent-model behavior at spawn time, and the `Agent` tool grows a
 * `binding_slot` parameter addressing a named slot. Off by default; enable
 * via `KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect (registers the definition) from the package
 * barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SUBAGENT_MODEL_SELECTION_FLAG_ID = 'subagent-model-selection';
export const SUBAGENT_MODEL_SELECTION_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SUBAGENT_MODEL_SELECTION';

export const subagentModelSelectionFlag: FlagDefinitionInput = {
  id: SUBAGENT_MODEL_SELECTION_FLAG_ID,
  title: 'Subagent model selection (workspace bindings)',
  description:
    'Resolve per-workspace subagent model bindings ([subagent.<type>] and [subagent-slot.<name>] in .kimi-code/local.toml) at spawn time instead of always inheriting the caller model. The Agent tool gains a binding_slot parameter that addresses a named slot; slots and type bindings fall back to parent inheritance when missing or stale.',
  env: SUBAGENT_MODEL_SELECTION_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(subagentModelSelectionFlag);
