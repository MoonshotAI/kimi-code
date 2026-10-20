import type {
  KimiConfig,
  ModelAlias,
  ModelAliasOverrides,
  SecondaryModelConfig,
} from './schema';

export const SECONDARY_DERIVED_MODEL_ALIAS = '__secondary__';
export const SECONDARY_MODEL_ENV = 'KIMI_SECONDARY_MODEL';
export const SECONDARY_MODEL_EFFORT_ENV = 'KIMI_SECONDARY_EFFORT';

type Env = Readonly<Record<string, string | undefined>>;

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t.length === 0 ? undefined : t;
}

export function secondaryModelPatch(
  secondary: SecondaryModelConfig | undefined,
): ModelAliasOverrides | undefined {
  if (secondary === undefined) return undefined;
  const {
    model: _model,
    defaultModel: _defaultModel,
    models: _models,
    force: _force,
    ...rawPatch
  } = secondary;
  const patch = Object.fromEntries(
    Object.entries(rawPatch).filter(([, value]) => value !== undefined),
  ) as ModelAliasOverrides;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

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
