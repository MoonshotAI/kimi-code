import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { cloneRecord, isPlainObject, setDefined } from '#/app/config/toml';
import {
  type ConfigDiagnostic,
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { MODELS_SECTION, THINKING_SECTION } from '#/app/kosongConfig/configSection';
import type { IModelCatalog, Model } from '#/llm-adapter/model/catalog';
import {
  declaredDefaultEffortForModel,
  modelSupportsThinking,
  modelSupportsThinkingEffort,
  normalizeRequestedThinkingEffort,
} from '@moonshot-ai/core/llm/thinking';
import type { ThinkingConfig } from '#/llm-adapter/model/thinking';

import {
  SecondaryModelConfigSchema,
  SecondaryModelEntryObjectSchema,
  SecondaryModelEntrySchema,
  type SecondaryModelConfig,
  type SecondaryModelEntry,
  type SecondaryModelEntryObject,
} from './secondaryModelSchema';

export {
  SecondaryModelConfigSchema,
  SecondaryModelEntryObjectSchema,
  SecondaryModelEntrySchema,
  type SecondaryModelConfig,
  type SecondaryModelEntry,
  type SecondaryModelEntryObject,
};

export const SUBAGENT_SECTION = 'subagent';
export const SECONDARY_MODEL_SECTION = 'secondaryModel';

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

export const SECONDARY_MODEL_FORCE_REMOVED_MESSAGE =
  "[secondary_model] 'force' is no longer supported and is ignored: a lone default_model already pins every Agent and AgentSwarm subagent to that model, and a [secondary_model.models] table only offers its own entries. Remove the key; run /update-config to fix it.";

const REMOVED_SECONDARY_MODEL_TUNING_KEYS = [
  'max_context_size',
  'max_input_size',
  'max_output_size',
  'capabilities',
  'display_name',
  'reasoning_key',
  'adaptive_thinking',
  'support_efforts',
  'off_effort',
] as const;

export function secondaryModelRemovedKeysMessage(keys: readonly string[]): string {
  return `[secondary_model] ${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} ignored: subagents bind the [models] entry as configured. Set model tuning on the [models.<alias>] entry instead and remove ${keys.length === 1 ? 'this key' : 'these keys'} from [secondary_model].`;
}

function collectRemovedSecondaryModelKeys(rawSection: unknown): ConfigDiagnostic[] {
  if (!isPlainObject(rawSection)) return [];
  const messages: string[] = [];
  if (rawSection['force'] !== undefined) messages.push(SECONDARY_MODEL_FORCE_REMOVED_MESSAGE);
  const tuningKeys = REMOVED_SECONDARY_MODEL_TUNING_KEYS.filter(
    (key) => rawSection[key] !== undefined,
  );
  if (tuningKeys.length > 0) messages.push(secondaryModelRemovedKeysMessage(tuningKeys));
  return messages.map((message) => ({
    domain: SECONDARY_MODEL_SECTION,
    severity: 'warning',
    message,
  }));
}

function serializeSecondaryModelEntry(entry: SecondaryModelEntry): SecondaryModelEntry {
  if (typeof entry === 'string') return entry;
  const description = entry.description ?? '';
  const effort = entry.effort !== undefined && entry.effort.length > 0 ? entry.effort : undefined;
  if (effort === undefined) return description;
  return description.length > 0 ? { description, effort } : { effort };
}

const KNOWN_SECONDARY_MODEL_TOML_KEYS = [
  'default_model',
  'model',
  'default_effort',
  'all_models',
  'rule',
  'models',
] as const;

export function secondaryModelToToml(value: unknown, rawSnake: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const section = value as SecondaryModelConfig;
  const out = cloneRecord(rawSnake);
  for (const key of KNOWN_SECONDARY_MODEL_TOML_KEYS) {
    delete out[key];
  }
  setDefined(out, 'default_model', section.defaultModel);
  setDefined(out, 'model', section.model);
  setDefined(out, 'default_effort', section.defaultEffort);
  if (section.allModels === true) out['all_models'] = true;
  if (section.rule !== undefined && section.rule.trim().length > 0) out['rule'] = section.rule;
  if (section.models !== undefined) {
    const models: Record<string, SecondaryModelEntry> = {};
    for (const [alias, entry] of Object.entries(section.models)) {
      models[alias] = serializeSecondaryModelEntry(entry);
    }
    out['models'] = models;
  }
  return out;
}

registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema, {
  collectDiagnostics: collectRemovedSecondaryModelKeys,
  toToml: secondaryModelToToml,
});

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export interface NormalizedSubagentModelEntry {
  readonly description: string;
  readonly effort?: string;
}

export function normalizeSecondaryModelEntry(
  entry: SecondaryModelEntry,
): NormalizedSubagentModelEntry {
  if (typeof entry === 'string') return { description: entry };
  const effort = entry.effort !== undefined && entry.effort.length > 0 ? entry.effort : undefined;
  return {
    description: entry.description ?? '',
    ...(effort !== undefined ? { effort } : {}),
  };
}

export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, NormalizedSubagentModelEntry>;
  readonly allModels?: boolean;
  readonly rule?: string;
}

export const SECONDARY_MODEL_ALL_MODELS_CONFLICT_MESSAGE =
  '[secondary_model].all_models cannot be combined with [secondary_model.models]';

function normalizedRule(rule: string | undefined): string | undefined {
  if (rule === undefined) return undefined;
  const trimmed = rule.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function listCatalogAliases(
  modelCatalog: IModelCatalog | undefined,
  config: IConfigService,
): readonly string[] {
  if (typeof modelCatalog?.listAliases === 'function') {
    return modelCatalog.listAliases();
  }
  const configured = config.get<Record<string, unknown> | undefined>(MODELS_SECTION);
  return configured === undefined ? [] : Object.keys(configured);
}

export function resolveSubagentModelPool(
  config: IConfigService,
  modelCatalog?: IModelCatalog,
): SubagentModelPool | undefined {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  const rule = normalizedRule(section?.rule);
  if (section?.allModels === true) {
    const models: Record<string, NormalizedSubagentModelEntry> = {};
    for (const alias of listCatalogAliases(modelCatalog, config)) {
      models[alias] = { description: '' };
    }
    return {
      defaultModel: section.defaultModel,
      models,
      allModels: true,
      ...(rule !== undefined ? { rule } : {}),
    };
  }
  if (section?.models !== undefined) {
    const models: Record<string, NormalizedSubagentModelEntry> = {};
    for (const [alias, entry] of Object.entries(section.models)) {
      models[alias] = normalizeSecondaryModelEntry(entry);
    }
    return {
      defaultModel: section.defaultModel,
      models,
      ...(rule !== undefined ? { rule } : {}),
    };
  }
  if (section?.defaultModel !== undefined) {
    return {
      defaultModel: section.defaultModel,
      models: { [section.defaultModel]: { description: '' } },
      ...(rule !== undefined ? { rule } : {}),
    };
  }
  if (section?.model !== undefined) {
    return {
      defaultModel: section.model,
      models: { [section.model]: { description: '' } },
      ...(rule !== undefined ? { rule } : {}),
    };
  }
  return undefined;
}

export const SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model.models] is configured';

export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  const aliases = Object.keys(pool.models);
  if (pool.allModels === true) {
    if (pool.defaultModel !== undefined) {
      try {
        modelCatalog.get(pool.defaultModel);
      } catch (error) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `[secondary_model].default_model "${pool.defaultModel}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error, details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel', model: pool.defaultModel } },
        );
      }
    }
    return;
  }
  if (pool.defaultModel === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, pool.defaultModel)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[secondary_model].default_model "${pool.defaultModel}" is not a [secondary_model.models] key. Available models: ${aliases.join(', ')}.`,
      { details: { model: pool.defaultModel, availableModels: aliases } },
    );
  }
  for (const alias of aliases) {
    try {
      modelCatalog.get(alias);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[secondary_model.models] entry "${alias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { model: alias } },
      );
    }
  }
}

function assertNoAllModelsConflict(section: SecondaryModelConfig | undefined): void {
  if (section?.allModels === true && section.models !== undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_ALL_MODELS_CONFLICT_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'allModels' },
    });
  }
}

export function assertValidSubagentModelConfig(
  config: IConfigService,
  modelCatalog: IModelCatalog,
): void {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  assertNoAllModelsConflict(section);
  const pool = resolveSubagentModelPool(config, modelCatalog);
  if (pool !== undefined) assertValidSubagentModelPool(pool, modelCatalog);
  assertValidSubagentEfforts(section, pool, modelCatalog);
}

function assertValidSubagentEfforts(
  section: SecondaryModelConfig | undefined,
  pool: SubagentModelPool | undefined,
  modelCatalog: IModelCatalog,
): void {
  if (pool === undefined) return;
  if (pool.allModels === true) {
    if (section?.defaultEffort === undefined) return;
    const targets = pool.defaultModel !== undefined ? [pool.defaultModel] : Object.keys(pool.models);
    for (const alias of targets) {
      assertModelSupportsConfiguredEffort(
        { section: SECONDARY_MODEL_SECTION, field: 'defaultEffort', key: '[secondary_model].default_effort' },
        section.defaultEffort,
        alias,
        modelCatalog.get(alias),
      );
    }
    return;
  }
  for (const [alias, entry] of Object.entries(pool.models)) {
    if (entry.effort !== undefined) {
      assertModelSupportsConfiguredEffort(
        {
          section: SECONDARY_MODEL_SECTION,
          field: 'models',
          key: `[secondary_model.models]."${alias}".effort`,
        },
        entry.effort,
        alias,
        modelCatalog.get(alias),
      );
      continue;
    }
    if (section?.defaultEffort !== undefined) {
      assertModelSupportsConfiguredEffort(
        { section: SECONDARY_MODEL_SECTION, field: 'defaultEffort', key: '[secondary_model].default_effort' },
        section.defaultEffort,
        alias,
        modelCatalog.get(alias),
      );
    }
  }
}

export interface ConfiguredEffortSetting {
  readonly section: string;
  readonly field: string;
  readonly key: string;
}

export function assertModelSupportsConfiguredEffort(
  setting: ConfiguredEffortSetting,
  configured: string,
  alias: string,
  model: Model,
): void {
  const effort = normalizeRequestedThinkingEffort(configured);
  if (effort === undefined) return;
  const details = { section: setting.section, field: setting.field, model: alias, effort };
  if (effort === 'off' && model.spec.thinking?.alwaysThinking === true) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `${setting.key} "off" cannot disable thinking for model "${alias}", which always reasons. Choose a concrete thinking effort instead of "off".`,
      { details },
    );
  }
  if (modelSupportsThinkingEffort(effort, model.spec, true)) return;
  if (!modelSupportsThinking(model.spec)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `${setting.key} "${effort}" is set but model "${alias}" does not support thinking.`,
      { details },
    );
  }
  throw new Error2(
    ErrorCodes.CONFIG_INVALID,
    `${setting.key} "${effort}" is not supported by model "${alias}". Supported efforts: ${model.spec.thinking?.supportEfforts?.join(', ')}.`,
    { details },
  );
}

export type SubagentModelSource = 'inherited' | 'secondary_pool';

type SubagentBinding = { model: string; thinking?: string; modelSource: SubagentModelSource };

export function resolveSubagentBinding(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: string,
  modelCatalog?: IModelCatalog,
): SubagentBinding {
  return bindSubagentModel(config, own, requested, modelCatalog);
}

function bindSubagentModel(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested: string | undefined,
  modelCatalog: IModelCatalog | undefined,
): SubagentBinding {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  assertNoAllModelsConflict(section);
  const pool = resolveSubagentModelPool(config, modelCatalog);
  if (pool === undefined) {
    if (requested !== undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${requested}": no [secondary_model] pool is configured, so subagents inherit the caller's model (omit the model parameter).`,
        { details: { model: requested } },
      );
    }
    return { model: own.modelAlias, thinking: own.thinkingLevel, modelSource: 'inherited' };
  }
  if (pool.allModels === true) {
    if (requested === undefined) {
      if (pool.defaultModel !== undefined) {
        return {
          model: pool.defaultModel,
          thinking: section?.defaultEffort,
          modelSource: 'secondary_pool',
        };
      }
      return {
        model: own.modelAlias,
        thinking: section?.defaultEffort ?? own.thinkingLevel,
        modelSource: 'inherited',
      };
    }
    const available = Object.keys(pool.models);
    if (!Object.hasOwn(pool.models, requested)) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${requested}". Available models: ${available.join(', ')}.`,
        { details: { model: requested, availableModels: available } },
      );
    }
    return {
      model: requested,
      thinking: section?.defaultEffort,
      modelSource: 'secondary_pool',
    };
  }
  const choice = requested ?? pool.defaultModel;
  if (choice === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, choice)) {
    const available = Object.keys(pool.models);
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid model "${choice}". Available models: ${available.join(', ')}.`,
      { details: { model: choice, availableModels: available } },
    );
  }
  const entry = pool.models[choice];
  return {
    model: choice,
    thinking: entry?.effort ?? section?.defaultEffort,
    modelSource: 'secondary_pool',
  };
}

export function resolveSubagentThinking(
  config: IConfigService,
  model: Model | undefined,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined) return explicit;
  if (config.get<ThinkingConfig>(THINKING_SECTION)?.enabled === false) return undefined;
  return declaredDefaultEffortForModel(model?.spec);
}

export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  return new Error2(
    error.code,
    `${error.message} (subagent model "${boundModel}" comes from [secondary_model.models] — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        subagentModel: boundModel,
        subagentModelConfig: {
          section: 'secondary_model.models',
        },
      },
    },
  );
}

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
