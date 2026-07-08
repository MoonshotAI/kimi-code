/**
 * `profile` domain — thinking-effort resolution helpers.
 *
 * Resolves the effective `ThinkingEffort` from a requested effort and the
 * `thinking` config section (`ThinkingConfig`, owned here in `profile`).
 * Pure functions; own no scoped state.
 */

import type { ThinkingEffort } from '#/app/llmProtocol/thinkingEffort';
import { type ModelThinkingMetadata, resolveThinkingEffortForModel } from '#/app/model/thinking';

import type { ThinkingConfig } from './configSection';

export function resolveThinkingEffort(
  requested: string | undefined,
  defaults: ThinkingConfig | undefined,
  model?: ModelThinkingMetadata,
): ThinkingEffort {
  return resolveThinkingEffortForModel(requested, defaults, model);
}
