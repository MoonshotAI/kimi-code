import {
  SECONDARY_DERIVED_MODEL_ALIAS,
  SECONDARY_MODEL_ENV,
  secondaryModelPatch,
  type KimiConfig,
  type SecondaryModelConfig,
} from '../config';
import { ErrorCodes, KimiError } from '../errors';
import type { ExperimentalFlagResolver } from '../flags';
import type { AgentModelPreference } from '../profile';

/**
 * Subagent model binding — the model half of the spawn decision.
 *
 * The requested choice (the `Agent` / `AgentSwarm` tool `model` parameter,
 * or the spawned profile's `model_preference` when the tool call omits it)
 * is interpreted as:
 *   - `primary`   → the caller's own model, inherited as before;
 *   - `secondary` → the `[secondary_model]` recipe (see below);
 *   - any other string → a concrete `[models]` alias, validated up front:
 *     an unknown alias fails the spawn with an error listing the valid
 *     choices rather than silently falling back to the caller's model.
 *
 * When the `secondary-model` experiment is enabled (the default) and
 * `[secondary_model]` is configured, newly spawned subagents bind to it by
 * default instead of inheriting the caller's model. A recipe with patch
 * fields binds the synthesized derived entry
 * ({@link SECONDARY_DERIVED_MODEL_ALIAS}, materialized by
 * `applySecondaryModelConfig`); a pointer-only recipe binds the pointed
 * entry directly. `default_effort` is passed as the explicit subagent
 * thinking effort; without it the child resolves thinking naturally (global
 * thinking config → the bound model's default effort) rather than inheriting
 * the caller's level. When unset, spawning behavior is unchanged: subagents
 * inherit the caller's model and effort.
 */

export type SubagentModelChoice = AgentModelPreference;

export interface SubagentModelBinding {
  readonly modelAlias: string | undefined;
  readonly thinkingEffort?: string;
}

export function resolveSecondaryModel(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
): SecondaryModelConfig | undefined {
  if (!flags.enabled('secondary-model')) return undefined;
  return config?.secondaryModel;
}

/**
 * The concrete model aliases a subagent may be bound to explicitly: every
 * configured `[models]` entry except the synthesized secondary derived entry
 * (an internal runtime artifact bound through the `secondary` choice).
 */
function explicitModelAliases(config: KimiConfig | undefined): string[] {
  return Object.keys(config?.models ?? {}).filter(
    (alias) => alias !== SECONDARY_DERIVED_MODEL_ALIAS,
  );
}

function unknownSubagentModelMessage(requested: string, aliases: readonly string[]): string {
  const choices = ['primary', 'secondary', ...aliases].map((choice) => `"${choice}"`).join(', ');
  return `Unknown subagent model "${requested}". Pass one of: ${choices}.`;
}

/**
 * Resolve which model a newly spawned subagent binds to. `requested` is the
 * explicit per-spawn choice (tool argument or profile preference); `own` is
 * the caller's current model state, used when inheriting.
 */
export function resolveSubagentBinding(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
  own: { readonly modelAlias: string | undefined; readonly thinkingEffort: string },
  requested?: SubagentModelChoice,
): SubagentModelBinding {
  if (requested !== undefined && requested !== 'primary' && requested !== 'secondary') {
    // A concrete [models] alias: honor it directly (flag-independent — an
    // explicit choice is never silently ignored) and fail loudly on typos.
    const aliases = explicitModelAliases(config);
    if (!aliases.includes(requested)) {
      throw new Error(unknownSubagentModelMessage(requested, aliases));
    }
    return {
      modelAlias: requested,
      thinkingEffort: config?.models?.[requested]?.defaultEffort ?? own.thinkingEffort,
    };
  }
  const secondary = resolveSecondaryModel(config, flags);
  if (requested !== 'primary' && secondary?.model !== undefined) {
    return {
      modelAlias:
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ALIAS,
      thinkingEffort: secondary.defaultEffort,
    };
  }
  return { modelAlias: own.modelAlias, thinkingEffort: own.thinkingEffort };
}

/**
 * The "Available models" block appended to the `Agent` / `AgentSwarm` tool
 * descriptions so the parent model knows it can pick. Lists `secondary` when
 * the recipe is configured, `primary`, and every other configured `[models]`
 * alias. `undefined` when the caller's model is not bound yet or there is
 * nothing beyond the caller's own model to choose.
 */
export function buildSubagentModelDescriptions(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
  callerModelAlias: string | undefined,
): string | undefined {
  if (callerModelAlias === undefined) return undefined;
  const secondaryModel = resolveSecondaryModel(config, flags)?.model;
  const aliases = explicitModelAliases(config).filter(
    (alias) => alias !== callerModelAlias && alias !== secondaryModel,
  );
  if (secondaryModel === undefined && aliases.length === 0) return undefined;
  const lines = ['Available models (pass via model):'];
  if (secondaryModel !== undefined) {
    lines.push(
      `- secondary: ${secondaryModel} (default) — the configured secondary model; prefer it for routine subagent tasks`,
    );
  }
  lines.push(
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
  );
  if (aliases.length > 0) {
    lines.push(
      `- ${aliases.join(', ')} — configured [models] aliases; pass one to run the subagent on that specific model`,
    );
  }
  return lines.join('\n');
}

/**
 * Point a spawn-time model resolution failure at the secondary-model
 * configuration when the bound model is not the caller's own — otherwise the
 * parent model sees a bare "model not configured" error with no hint that it
 * comes from `[secondary_model]`.
 */
export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!(error instanceof KimiError) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  // ProviderManager tags only the missing-alias failure with details.model;
  // malformed aliases and providers must keep their own actionable errors.
  if (error.details?.['model'] !== boundModel) return error;
  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ALIAS
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ALIAS}"`
      : `"${boundModel}"`;
  return new KimiError(
    error.code,
    `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      details: {
        ...error.details,
        secondaryModel: boundModel,
      },
    },
  );
}
