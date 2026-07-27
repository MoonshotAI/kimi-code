/**
 * `subagent` domain (L6) — subagent config-section schemas, env binding,
 * timeout / model resolution, and model-list descriptions.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import {
  type ConfigEffectiveOverlay,
  type EnvBindings,
  type IConfigService,
  envBindings,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigOverlay } from '#/app/config/configOverlayContributions';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { deepEqual } from '#/app/config/configPure';
import {
  camelToSnake,
  cloneRecord,
  isPlainObject,
  transformPlainObject,
} from '#/app/config/toml';
import type { IFlagService } from '#/app/flag/flag';
import {
  DEFAULT_MODEL_SECTION,
  MODELS_SECTION,
  ModelOverrideSchema,
  SECONDARY_MODEL_ENV,
  SECONDARY_MODEL_SECTION,
  type SecondaryModelConfig,
} from '#/app/kosongConfig/configSection';
import {
  SECONDARY_DERIVED_MODEL_ID,
  secondaryModelPatch,
} from '#/app/kosongConfig/secondaryModelOverlay';
import {
  markRuntimeOnlyModelRecord,
  withoutRuntimeOnlyModels,
} from '#/app/kosongConfig/runtimeOnlyModels';
import {
  type ModelOverride,
  type ModelsSection,
} from '#/kosong/model/model';

import { SECONDARY_MODEL_FLAG_ID } from './flag';

export const DERIVED_MODEL_PREFIX = '__sm__';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export const SUBAGENT_MODELS_SECTION = 'subagentModels';

export const SUBAGENT_MODELS_TOML_KEY = 'subagent_models';

const VALID_SLOT_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const RESERVED_SLOT_NAMES = new Set(['primary']);
const DERIVED_SLOT_PREFIX = '__';

export const SubagentModelEntrySchema = ModelOverrideSchema.extend({
  model: z.string().trim().min(1),
  description: z.string().trim().min(1),
  recommendedFor: z.array(z.string().trim().min(1)).optional(),
  default: z.boolean().optional(),
});

export const SubagentModelsConfigSchema = z
  .record(z.string(), SubagentModelEntrySchema)
  .refine(
    (map) => {
      let defaults = 0;
      for (const key of Object.keys(map)) {
        if (!VALID_SLOT_NAME.test(key)) return false;
        if (RESERVED_SLOT_NAMES.has(key)) return false;
        if (key.startsWith(DERIVED_SLOT_PREFIX)) return false;
        if (map[key]?.default === true) defaults++;
      }
      return defaults <= 1;
    },
    {
      message:
        'Slot names must match /^[a-zA-Z][a-zA-Z0-9_]*$/, must not be "primary" or start with "__", and at most one slot may have default=true',
    },
  );

export type SubagentModelEntry = z.infer<typeof SubagentModelEntrySchema>;
export type SubagentModelsConfig = z.infer<typeof SubagentModelsConfigSchema>;

function subagentModelsFromToml(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [slotKey, entry] of Object.entries(value)) {
    out[slotKey] = isPlainObject(entry) ? transformPlainObject(entry) : entry;
  }
  return out;
}

function subagentModelsToToml(
  value: unknown,
  raw: unknown,
): unknown {
  if (!isPlainObject(value)) return value;
  const rawSnake = isPlainObject(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const [slotKey, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      out[slotKey] = entry;
      continue;
    }
    const converted = cloneRecord(rawSnake[slotKey]);
    for (const key of Object.keys(SubagentModelEntrySchema.shape)) {
      const tomlKey = camelToSnake(key);
      const field = entry[key];
      if (field === undefined) {
        delete converted[tomlKey];
      } else {
        converted[tomlKey] = field;
      }
    }
    out[slotKey] = converted;
  }
  return out;
}

registerConfigSection(SUBAGENT_MODELS_SECTION, SubagentModelsConfigSchema, {
  fromToml: subagentModelsFromToml,
  toToml: subagentModelsToToml,
});

export interface SubagentModelSlot {
  name: string;
  model: string;
  baseModel: string;
  source: 'legacy-secondary' | 'named-slot';
  thinking?: string;
  description: string;
  recommendedFor: readonly string[];
  isDefault: boolean;
  patchedSupportEfforts?: readonly string[];
}

export type ResolvedSubagentModelList = readonly SubagentModelSlot[] | null;

export type SubagentModelChoice = string;

export interface SubagentBinding {
  model: string;
  thinking?: string;
  source: 'primary' | 'legacy-secondary' | 'named-slot';
  slotName?: string;
}

function subagentDerivedId(slotName: string): string {
  return `${DERIVED_MODEL_PREFIX}${slotName}`;
}

function subagentModelCollisionError(slotName: string, derivedId: string): Error2 {
  return new Error2(
    ErrorCodes.CONFIG_INVALID,
    `[subagent_models.${slotName}] would overwrite user-defined model "${derivedId}" — rename or remove the [models.${derivedId}] entry`,
    { details: { derivedId, slotName } },
  );
}

function findSubagentModelCollision(
  config: IConfigService,
  entries: SubagentModelsConfig,
): { derivedId: string; slotName: string } | undefined {
  const inspection = config.inspect<ModelsSection>(MODELS_SECTION);
  const userModels = asRecord(inspection.userValue);
  const memoryModels = asRecord(inspection.memoryValue);
  for (const [slotName, entry] of Object.entries(entries)) {
    if (namedSubagentModelPatch(entry) === undefined) continue;
    const derivedId = subagentDerivedId(slotName);
    if (
      Object.hasOwn(userModels, derivedId) ||
      Object.hasOwn(memoryModels, derivedId)
    ) {
      return { derivedId, slotName };
    }
  }
  return undefined;
}

export function resolveSecondaryModel(
  config: IConfigService,
  flags: IFlagService,
): SecondaryModelConfig | undefined {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return undefined;
  return config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
}

export function resolveSubagentModelList(
  config: IConfigService,
  flags: IFlagService,
): ResolvedSubagentModelList {
  if (!flags.enabled(SECONDARY_MODEL_FLAG_ID)) return null;

  const inspection = config.inspect<SubagentModelsConfig>(
    SUBAGENT_MODELS_SECTION,
  );
  const map = inspection.value;
  if (map === undefined && inspection.userValue !== undefined) {
    const diagnostic = config
      .diagnostics()
      .find((entry) => entry.domain === SUBAGENT_MODELS_SECTION);
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      diagnostic?.message ??
        'Invalid [subagent_models] configuration — review the config diagnostics',
      { details: { section: SUBAGENT_MODELS_TOML_KEY } },
    );
  }
  if (map !== undefined && Object.keys(map).length > 0) {
    const collision = findSubagentModelCollision(config, map);
    if (collision !== undefined) {
      throw subagentModelCollisionError(
        collision.slotName,
        collision.derivedId,
      );
    }
    const slots: SubagentModelSlot[] = [];
    for (const [name, entry] of Object.entries(map)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const hasPatch = namedSubagentModelPatch(entry) !== undefined;
      slots.push({
        name,
        model: hasPatch ? subagentDerivedId(name) : entry.model,
        baseModel: entry.model,
        source: 'named-slot',
        thinking: entry.defaultEffort,
        description: entry.description,
        recommendedFor: entry.recommendedFor ?? [],
        isDefault: false,
        patchedSupportEfforts: entry.supportEfforts,
      });
    }
    const explicitDefault = slots.findIndex((s) => map[s.name]?.default === true);
    if (explicitDefault >= 0 && explicitDefault < slots.length) {
      slots[explicitDefault]!.isDefault = true;
    } else if (slots.length > 0) {
      slots[0]!.isDefault = true;
    }
    return slots;
  }

  const secondary = resolveSecondaryModel(config, flags);
  if (secondary?.model !== undefined) {
    return [
      {
        name: 'secondary',
        model: secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ID,
        baseModel: secondary.model,
        source: 'legacy-secondary',
        thinking: secondary.defaultEffort,
        description: 'The configured secondary model; prefer it for routine subagent tasks.',
        recommendedFor: [],
        isDefault: true,
        patchedSupportEfforts: secondary.supportEfforts,
      },
    ];
  }

  return null;
}

export function resolveSubagentModelListForPresentation(
  config: IConfigService,
  flags: IFlagService,
): ResolvedSubagentModelList | undefined {
  try {
    return resolveSubagentModelList(config, flags);
  } catch (error) {
    if (isError2(error) && error.code === ErrorCodes.CONFIG_INVALID) {
      return undefined;
    }
    throw error;
  }
}

export function resolveSubagentBinding(
  config: IConfigService,
  flags: IFlagService,
  own: { modelAlias: string; thinkingLevel: string },
  requestedModelName?: SubagentModelChoice,
): SubagentBinding {
  const slots = resolveSubagentModelList(config, flags);
  if (slots !== null) {
    if (requestedModelName === undefined) {
      const def = slots.find((s) => s.isDefault);
      if (def !== undefined) {
        return {
          model: def.model,
          thinking: def.thinking,
          source: def.source,
          slotName: def.name,
        };
      }
      return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'primary' };
    }
    if (requestedModelName === 'primary') {
      return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'primary' };
    }
    const slot = slots.find((s) => s.name === requestedModelName);
    if (slot !== undefined) {
      return {
        model: slot.model,
        thinking: slot.thinking,
        source: slot.source,
        slotName: slot.name,
      };
    }
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Unknown subagent model slot "${requestedModelName}" — available: ${slots.map((s) => s.name).join(', ')}, primary`,
      {
        details: {
          requestedSlot: requestedModelName,
          availableSlots: slots.map((s) => s.name),
        },
      },
    );
  }
  return { model: own.modelAlias, thinking: own.thinkingLevel, source: 'primary' };
}

export function buildSubagentModelDescriptions(
  config: IConfigService,
  flags: IFlagService,
  callerModelAlias: string | undefined,
): string | undefined {
  const slots = resolveSubagentModelListForPresentation(config, flags);
  if (
    slots === null ||
    slots === undefined ||
    callerModelAlias === undefined
  ) {
    return undefined;
  }

  const lines: string[] = ['Available models (pass via model):'];
  for (const slot of slots) {
    const tags =
      slot.recommendedFor.length > 0
        ? ` | Recommended for: ${slot.recommendedFor.join(', ')}`
        : '';
    const defaultMark = slot.isDefault ? ' (default)' : '';
    lines.push(
      `- ${slot.name}${defaultMark}: ${slot.baseModel}${tags} | ${slot.description}`,
    );
  }
  lines.push(
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
  );
  return lines.join('\n');
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string,
  source?: SubagentBinding['source'],
  slotName?: string,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;

  let subagentModelConfig: { section: string; environment?: string };
  let secondaryModelConfig: { section: string; environment?: string } | undefined;

  if (source === 'legacy-secondary') {
    secondaryModelConfig = {
      section: 'secondaryModel.model',
      environment: SECONDARY_MODEL_ENV,
    };
    subagentModelConfig = secondaryModelConfig;
  } else if (source === 'named-slot' && slotName !== undefined) {
    subagentModelConfig = {
      section: `[${SUBAGENT_MODELS_TOML_KEY}.${slotName}]`,
    };
  } else {
    subagentModelConfig = {
      section: `[${SUBAGENT_MODELS_TOML_KEY}]`,
    };
  }

  const displayModel =
    boundModel === SECONDARY_DERIVED_MODEL_ID
      ? `the derived entry "${SECONDARY_DERIVED_MODEL_ID}"`
      : boundModel.startsWith(DERIVED_MODEL_PREFIX)
        ? `the derived entry for slot "${boundModel.slice(DERIVED_MODEL_PREFIX.length)}"`
        : `"${boundModel}"`;

  const details: Record<string, unknown> = {
    ...error.details,
    subagentModel: boundModel,
    subagentModelConfig,
    ...(secondaryModelConfig !== undefined
      ? { secondaryModel: boundModel, secondaryModelConfig }
      : {}),
  };

  return new Error2(
    error.code,
    `${error.message} (subagent model ${displayModel} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details,
    },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function namedSubagentModelPatch(
  entry: SubagentModelEntry,
): ModelOverride | undefined {
  const {
    model: _model,
    description: _description,
    recommendedFor: _recommendedFor,
    default: _default,
    ...rawPatch
  } = entry;
  const patch = Object.fromEntries(
    Object.entries(rawPatch).filter(([, value]) => value !== undefined),
  ) as ModelOverride;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function persistedSubagentDerivedRecipes(
  rawSnake: Record<string, unknown>,
): ReadonlyMap<string, { baseId: string; patch: ModelOverride }> {
  const result = new Map<string, { baseId: string; patch: ModelOverride }>();
  const parsed = SubagentModelsConfigSchema.safeParse(
    subagentModelsFromToml(rawSnake[SUBAGENT_MODELS_TOML_KEY]),
  );
  if (!parsed.success) return result;
  for (const [name, entry] of Object.entries(parsed.data)) {
    const patch = namedSubagentModelPatch(entry);
    if (patch === undefined) continue;
    result.set(subagentDerivedId(name), { baseId: entry.model, patch });
  }
  return result;
}

function persistedSubagentDerivedIds(
  rawSnake: Record<string, unknown>,
): ReadonlySet<string> {
  return new Set(persistedSubagentDerivedRecipes(rawSnake).keys());
}

function synthesizeDerivedRecord(
  base: Record<string, unknown>,
  patch: ModelOverride,
): Record<string, unknown> {
  const { overrides: baseOverrides, aliases: _aliases, ...baseFields } = base;
  return { ...baseFields, overrides: { ...asRecord(baseOverrides), ...patch } };
}

export const subagentModelsOverlay: ConfigEffectiveOverlay = {
  phase: 'derived',
  apply(effective, _getEnv, validate) {
    const entries = effective[SUBAGENT_MODELS_SECTION] as
      | SubagentModelsConfig
      | undefined;
    if (!entries) return [];

    let models = asRecord(effective[MODELS_SECTION]);
    let synthesized: Record<string, unknown> | undefined;

    for (const [name, entry] of Object.entries(entries)) {
      const patch = namedSubagentModelPatch(entry);
      if (patch === undefined) continue;
      const baseId = entry.model;
      if (!baseId) continue;
      const base = models[baseId];
      if (!isPlainObject(base)) continue;
      const derivedId = subagentDerivedId(name);
      if (Object.hasOwn(models, derivedId)) {
        throw subagentModelCollisionError(name, derivedId);
      }
      synthesized ??= { ...models };
      models = synthesized;
      models[derivedId] = synthesizeDerivedRecord(base, patch);
    }

    if (synthesized === undefined) return [];
    const next = validate(MODELS_SECTION, models) as ModelsSection;
    for (const [name, entry] of Object.entries(entries)) {
      if (namedSubagentModelPatch(entry) === undefined) continue;
      markRuntimeOnlyModelRecord(next[subagentDerivedId(name)]);
    }
    effective[MODELS_SECTION] = next;
    return [MODELS_SECTION];
  },

  strip(domain, value, rawSnake) {
    switch (domain) {
      case MODELS_SECTION: {
        if (!isPlainObject(value)) return value;
        const identityStripped = withoutRuntimeOnlyModels(value as ModelsSection);
        const recipes = persistedSubagentDerivedRecipes(rawSnake);
        if (recipes.size === 0) return identityStripped;
        const rawModels = asRecord(rawSnake['models']);
        let result: ModelsSection | undefined;
        for (const [derivedId, recipe] of recipes) {
          if (
            !Object.hasOwn(identityStripped, derivedId) ||
            Object.hasOwn(rawModels, derivedId)
          ) {
            continue;
          }
          const base = identityStripped[recipe.baseId];
          if (!isPlainObject(base)) continue;
          const echoed = deepEqual(
            identityStripped[derivedId],
            synthesizeDerivedRecord(base, recipe.patch),
          );
          if (!echoed) continue;
          result ??= { ...identityStripped };
          delete result[derivedId];
        }
        return result ?? identityStripped;
      }
      case DEFAULT_MODEL_SECTION:
        if (
          typeof value === 'string' &&
          persistedSubagentDerivedIds(rawSnake).has(value)
        ) {
          return typeof rawSnake['default_model'] === 'string'
            ? rawSnake['default_model']
            : undefined;
        }
        return value;
      default:
        return value;
    }
  },
};

registerConfigOverlay(subagentModelsOverlay);

export function formatSubagentTimeoutDescription(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    const h = ms / (60 * 60 * 1000);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (ms % (60 * 1000) === 0) {
    const m = ms / (60 * 1000);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  if (ms % 1000 === 0) {
    const s = ms / 1000;
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return `${ms} ms`;
}
