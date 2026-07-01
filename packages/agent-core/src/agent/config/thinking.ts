import type { ThinkingEffort } from '@moonshot-ai/kosong';

import { effectiveModelAlias } from '../../config';
import type { ModelAlias, ThinkingConfig } from '../../config/schema';

export type { ThinkingEffort };

function supportsThinking(model: ModelAlias | undefined): boolean {
  if (model === undefined) return false;
  const caps = model.capabilities ?? [];
  return (
    caps.includes('thinking') ||
    caps.includes('always_thinking') ||
    model.adaptiveThinking === true
  );
}

function middleOf(efforts: readonly string[]): string {
  return efforts[Math.floor(efforts.length / 2)]!;
}

/**
 * Resolve the default thinking effort for a model from its declared metadata:
 *   - models that do not support thinking (or an unknown model) -> `'off'`
 *   - effort-capable models -> `default_effort`, else the middle entry of
 *     `support_efforts` (so we never pick an effort the model does not support)
 *   - boolean models (thinking support without `support_efforts`) -> `'on'`
 *
 * `support_efforts` is the single source of truth for efforts; the returned
 * effort is always one the model can actually accept.
 */
export function defaultThinkingEffortFor(model: ModelAlias | undefined): ThinkingEffort {
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  if (!supportsThinking(effective)) return 'off';
  const efforts = effective?.supportEfforts;
  if (efforts !== undefined && efforts.length > 0) {
    return effective?.defaultEffort ?? middleOf(efforts);
  }
  return 'on';
}

/**
 * Resolve the effective thinking effort for a session.
 *
 * Precedence:
 *   1. an explicit `requested` effort (per-session override) wins;
 *   2. `thinking.enabled === false` forces `'off'`;
 *   3. otherwise `thinking.effort` when set, else the model's default effort.
 *
 * The `always_thinking` constraint is enforced here and only here: when a
 * model declares `always_thinking`, an `'off'` result is clamped back to the
 * model's default effort so thinking can never be disabled for it.
 */
export function resolveThinkingEffort(
  requested: ThinkingEffort | undefined,
  config: ThinkingConfig | undefined,
  model: ModelAlias | undefined,
): ThinkingEffort {
  const effectiveModel = model === undefined ? undefined : effectiveModelAlias(model);
  let effort: ThinkingEffort;
  if (requested !== undefined) {
    effort = requested;
  } else if (config?.enabled === false) {
    effort = 'off';
  } else {
    effort = config?.effort ?? defaultThinkingEffortFor(effectiveModel);
  }

  if (effort === 'off' && effectiveModel?.capabilities?.includes('always_thinking') === true) {
    // always_thinking forces thinking on, but an explicitly configured effort
    // is still honored — `enabled = false` only expresses the intent to
    // disable, it should not also discard a chosen effort. Fall back to the
    // model default only when no effort is configured.
    effort = config?.effort ?? defaultThinkingEffortFor(effectiveModel);
  }

  return effort;
}
