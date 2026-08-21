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

function effortsFor(model: ModelAlias | undefined): readonly string[] {
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.supportEfforts?.filter((effort) => effort.length > 0) ?? [];
}

/**
 * Pick the fallback effort straight from the declared list: the declared
 * `default_effort` when it is listed, else the middle entry. Unlike
 * {@link defaultThinkingEffortFor} this skips the thinking-capability gate —
 * a model that declares `support_efforts` without declaring the `thinking`
 * capability still has a meaningful declared default to fall back to.
 */
function declaredDefaultEffortFor(
  model: ModelAlias | undefined,
  efforts: readonly string[],
): ThinkingEffort {
  const declaredDefault = model?.defaultEffort;
  return declaredDefault !== undefined && efforts.includes(declaredDefault)
    ? declaredDefault
    : middleOf(efforts);
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
  const efforts = effortsFor(effective);
  if (efforts.length > 0) return declaredDefaultEffortFor(effective, efforts);
  return 'on';
}

export function supportsThinkingEffort(
  effort: ThinkingEffort,
  model: ModelAlias | undefined,
  kimiProtocol: boolean,
): boolean {
  if (!kimiProtocol || effort === 'off') return true;
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  const efforts = effortsFor(effective);
  // A declared effort list is itself a declaration of thinking support: list
  // membership decides, even when the thinking capability was omitted.
  if (efforts.length > 0) return effort === 'on' || efforts.includes(effort);
  return supportsThinking(effective);
}

function normalizeThinkingEffortForModel(
  effort: ThinkingEffort,
  model: ModelAlias | undefined,
  kimiProtocol: boolean,
): ThinkingEffort {
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  if (effort === 'off' && effective?.capabilities?.includes('always_thinking') !== true) {
    return 'off';
  }

  const efforts = effortsFor(effective);
  if (!kimiProtocol) {
    // Compatible protocols pass values through only while the model declares
    // no effort list — with a declared list, an unlisted effort is a config
    // mistake the backend would reject, so fall back like the Kimi wire does.
    if (efforts.length === 0) return effort;
    if (effort === 'on' || !efforts.includes(effort)) {
      return declaredDefaultEffortFor(effective, efforts);
    }
    return effort;
  }
  if (efforts.length > 0) {
    if (effort === 'on' || !efforts.includes(effort)) {
      return declaredDefaultEffortFor(effective, efforts);
    }
    return effort;
  }
  if (!supportsThinking(effective)) return 'off';
  return 'on';
}

/**
 * A thinking-effort fallback: the configured value is not in the model's
 * declared `support_efforts` list, so `resolved` (the model's default effort)
 * is applied instead.
 */
export interface ThinkingEffortFallback {
  readonly configured: ThinkingEffort;
  readonly resolved: ThinkingEffort;
}

/**
 * Resolve the effective thinking effort for a session, and report whether the
 * resolution had to fall back to the model's default effort because the
 * configured value is not in the model's declared `support_efforts` list.
 * `'on'`/`'off'` are protocol encodings, not list members, so they never
 * count as a fallback.
 */
export function resolveThinkingEffortWithFallback(
  requested: ThinkingEffort | undefined,
  config: ThinkingConfig | undefined,
  model: ModelAlias | undefined,
  kimiProtocol = false,
): { readonly effort: ThinkingEffort; readonly fallback: ThinkingEffortFallback | undefined } {
  const effectiveModel = model === undefined ? undefined : effectiveModelAlias(model);
  // Normalize the configured value once: 'OFF' / ' off ' must be read as off
  // on every path, not passed upstream as a concrete effort; whitespace-only
  // reads as absent.
  const configuredRaw = config?.effort?.trim().toLowerCase();
  const configured = configuredRaw === undefined || configuredRaw === '' ? undefined : configuredRaw;
  const requestedRaw = requested?.trim().toLowerCase();
  const requestedNormalized =
    requestedRaw === undefined || requestedRaw === '' ? undefined : (requestedRaw as ThinkingEffort);
  let effort: ThinkingEffort;
  if (requestedNormalized !== undefined) {
    effort = requestedNormalized;
  } else if (config?.enabled === false) {
    effort = 'off';
  } else {
    effort = configured ?? defaultThinkingEffortFor(effectiveModel);
  }

  if (effort === 'off' && effectiveModel?.capabilities?.includes('always_thinking') === true) {
    // always_thinking forces thinking on, but an explicitly configured effort
    // is still honored — `enabled = false` only expresses the intent to
    // disable, it should not also discard a chosen effort. A configured
    // 'off' is treated as absent: the model default applies instead.
    effort =
      configured !== undefined && configured !== 'off'
        ? configured
        : defaultThinkingEffortFor(effectiveModel);
  }

  const resolved = normalizeThinkingEffortForModel(effort, effectiveModel, kimiProtocol);
  const efforts = effortsFor(effectiveModel);
  const fallback: ThinkingEffortFallback | undefined =
    effort !== 'on' && effort !== 'off' && efforts.length > 0 && !efforts.includes(effort)
      ? { configured: effort, resolved }
      : undefined;
  return { effort: resolved, fallback };
}

/**
 * Resolve the effective thinking effort for a session.
 *
 * Precedence:
 *   1. an explicit `requested` effort (per-session override) wins;
 *   2. `thinking.enabled === false` forces `'off'`;
 *   3. otherwise `thinking.effort` when set, else the model's default effort.
 *
 * A model that declares `always_thinking` can never resolve to `'off'`, on
 * any wire — a claimed off state would be a lie, since upstream keeps
 * reasoning at its default when no off encoding exists.
 */
export function resolveThinkingEffort(
  requested: ThinkingEffort | undefined,
  config: ThinkingConfig | undefined,
  model: ModelAlias | undefined,
  kimiProtocol = false,
): ThinkingEffort {
  return resolveThinkingEffortWithFallback(requested, config, model, kimiProtocol).effort;
}
