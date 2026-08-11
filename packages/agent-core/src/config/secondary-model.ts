import type {
  KimiConfig,
  ModelAlias,
  ModelAliasOverrides,
  SecondaryModelConfig,
} from './schema';

/**
 * Secondary-model runtime overlay.
 *
 * `[secondary_model]` is a recipe: `model` points at a `[models]` entry and
 * every remaining field is a subagent-only patch. When patch fields exist,
 * {@link applySecondaryModelConfig} synthesizes the derived model entry
 * ({@link SECONDARY_DERIVED_MODEL_ALIAS}) into the in-memory `models` view — a
 * copy of the pointed entry with the patch merged into its `overrides` block
 * (patch wins conflicts) — so subagent binding resolves it through the
 * standard alias path, riding the same `effectiveModelAlias` merge as any
 * `models.*.overrides`. With no patch fields, subagents bind the pointed
 * entry directly and nothing is synthesized.
 *
 * The `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT` env vars override
 * `model` / `default_effort` in memory only: like the `KIMI_MODEL_*`
 * synthesized entries, the derived entry and the env-injected fields must
 * never reach `config.toml`. {@link stripSecondaryModelConfig} is the write
 * path mirror, wired next to `stripEnvModelConfig`.
 */

export const SECONDARY_DERIVED_MODEL_ALIAS = '__secondary__';
export const SECONDARY_MODEL_ENV = 'KIMI_SECONDARY_MODEL';
export const SECONDARY_MODEL_EFFORT_ENV = 'KIMI_SECONDARY_EFFORT';

type Env = Readonly<Record<string, string | undefined>>;

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

/**
 * The patch half of the recipe: every field except `model`. Returns
 * `undefined` when no patch field is set — the signal that subagents bind the
 * pointed entry directly and no derived entry is synthesized.
 */
export function secondaryModelPatch(
  secondary: SecondaryModelConfig | undefined,
): ModelAliasOverrides | undefined {
  if (secondary === undefined) return undefined;
  const { model: _model, ...rawPatch } = secondary;
  const patch = Object.fromEntries(
    Object.entries(rawPatch).filter(([, value]) => value !== undefined),
  ) as ModelAliasOverrides;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/**
 * Apply the secondary-model runtime view: env overrides for the recipe, then
 * the derived-entry synthesis. Returns the config unchanged when neither
 * applies. Nothing is synthesized when `secondary.model` is unset or the
 * pointed entry does not exist (the session warning reports the dangling
 * pointer; spawn fails with the wrapped error).
 */
export function applySecondaryModelConfig(config: KimiConfig, env: Env = process.env): KimiConfig {
  let secondary = config.secondaryModel;
  const envModel = trimmed(env[SECONDARY_MODEL_ENV]);
  const envEffort = trimmed(env[SECONDARY_MODEL_EFFORT_ENV]);
  if (envModel !== undefined || envEffort !== undefined) {
    secondary = {
      ...secondary,
      model: envModel ?? secondary?.model,
      defaultEffort: envEffort ?? secondary?.defaultEffort,
    };
  }

  let next = secondary === config.secondaryModel ? config : { ...config, secondaryModel: secondary };

  const patch = secondaryModelPatch(secondary);
  const baseId = secondary?.model;
  if (patch === undefined || baseId === undefined || baseId === SECONDARY_DERIVED_MODEL_ALIAS) {
    return next;
  }
  const base = next.models?.[baseId];
  if (base === undefined) return next;

  const { overrides: baseOverrides, ...baseFields } = base;
  const derived: ModelAlias = {
    ...baseFields,
    overrides: { ...baseOverrides, ...patch },
  };
  return {
    ...next,
    models: { ...next.models, [SECONDARY_DERIVED_MODEL_ALIAS]: derived },
  };
}

/**
 * Remove the runtime-only secondary-model state before a config is persisted
 * to disk: the synthesized derived entry (never a legitimate on-disk entry,
 * mirroring the v2 overlay which strips a user-configured entry under the
 * reserved id all the same), a `default_model` pointer at the derived entry
 * (restored from raw so it cannot dangle after the recipe is removed), and
 * the env-injected recipe fields (restored from raw when the value being
 * written still equals the env value, so a `getConfig` -> `setConfig`
 * round-trip cannot persist shell overrides, while a genuinely new selection
 * — e.g. a `/secondary_model` pick made under `KIMI_SECONDARY_MODEL` — does
 * reach the disk, mirroring the pointer check in `stripEnvModelConfig`).
 */
export function stripSecondaryModelConfig(
  config: KimiConfig,
  env: Env = process.env,
): KimiConfig {
  let next = config;

  if (next.models !== undefined && SECONDARY_DERIVED_MODEL_ALIAS in next.models) {
    const models = { ...next.models };
    delete models[SECONDARY_DERIVED_MODEL_ALIAS];
    next = { ...next, models };
  }

  if (next.defaultModel === SECONDARY_DERIVED_MODEL_ALIAS) {
    const rawDefault = config.raw?.['default_model'];
    next = {
      ...next,
      defaultModel: typeof rawDefault === 'string' ? rawDefault : undefined,
    };
  }

  const envModel = trimmed(env[SECONDARY_MODEL_ENV]);
  const envEffort = trimmed(env[SECONDARY_MODEL_EFFORT_ENV]);
  if ((envModel !== undefined || envEffort !== undefined) && next.secondaryModel !== undefined) {
    const raw = isPlainObject(config.raw?.['secondary_model']) ? config.raw['secondary_model'] : {};
    const restored = { ...next.secondaryModel };
    // Restore from raw only when the value being written still IS the env
    // value (a round-trip of the overlaid runtime view). A different value is
    // a deliberate new selection and must persist.
    if (envModel !== undefined && restored.model === envModel) {
      if (typeof raw['model'] === 'string') restored.model = raw['model'];
      else delete restored.model;
    }
    if (envEffort !== undefined && restored.defaultEffort === envEffort) {
      if (typeof raw['default_effort'] === 'string') restored.defaultEffort = raw['default_effort'];
      else delete restored.defaultEffort;
    }
    next = {
      ...next,
      secondaryModel: Object.keys(restored).length > 0 ? restored : undefined,
    };
  }

  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
