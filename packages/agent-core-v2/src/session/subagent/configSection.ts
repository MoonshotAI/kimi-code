import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import {
  type ConfigDiagnostic,
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import type { IModelCatalog, Model } from '#/llm-adapter/model/catalog';
import {
  declaredDefaultEffortForModel,
  modelSupportsThinking,
  modelSupportsThinkingEffort,
  normalizeRequestedThinkingEffort,
  type ThinkingConfig,
} from '#/llm-adapter/model/thinking';

export const SUBAGENT_SECTION = 'subagent';
export const SECONDARY_MODEL_SECTION = 'secondaryModel';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const SecondaryModelConfigSchema = z.object({
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), z.string()).optional(),
  model: z.string().min(1).optional(),
  defaultEffort: z.string().optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

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

registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema, {
  collectDiagnostics: collectRemovedSecondaryModelKeys,
});

export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, string>;
}

export function resolveSubagentModelPool(config: IConfigService): SubagentModelPool | undefined {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  if (section?.models !== undefined) {
    return { defaultModel: section.defaultModel, models: section.models };
  }
  if (section?.defaultModel !== undefined) {
    return { defaultModel: section.defaultModel, models: { [section.defaultModel]: '' } };
  }
  if (section?.model !== undefined) {
    return { defaultModel: section.model, models: { [section.model]: '' } };
  }
  return undefined;
}

export function exposesSubagentModelChoice(config: IConfigService): boolean {
  const pool = resolveSubagentModelPool(config);
  return pool !== undefined && Object.keys(pool.models).length > 1;
}

export const SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[secondary_model].default_model is required when [secondary_model.models] is configured';

export const SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE = `[secondary_model.models] key "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved. Rename the pool entry.`;

export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const aliases = Object.keys(pool.models);
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

export function assertValidSubagentModelConfig(
  config: IConfigService,
  modelCatalog: IModelCatalog,
): void {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  const pool = resolveSubagentModelPool(config);
  if (pool !== undefined) assertValidSubagentModelPool(pool, modelCatalog);
  assertValidSubagentDefaultEffort(section, pool, modelCatalog);
}

function assertValidSubagentDefaultEffort(
  section: SecondaryModelConfig | undefined,
  pool: SubagentModelPool | undefined,
  modelCatalog: IModelCatalog,
): void {
  const effort =
    section?.defaultEffort === undefined
      ? undefined
      : normalizeRequestedThinkingEffort(section.defaultEffort);
  if (effort === undefined || pool === undefined) return;
  for (const alias of Object.keys(pool.models)) {
    const model = modelCatalog.get(alias);
    if (effort === 'off' && model.alwaysThinking === true) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[secondary_model].default_effort "off" cannot disable thinking for model "${alias}", which always reasons. Choose a concrete thinking effort instead of "off".`,
        {
          details: {
            section: SECONDARY_MODEL_SECTION,
            field: 'defaultEffort',
            model: alias,
            effort,
          },
        },
      );
    }
    if (modelSupportsThinkingEffort(effort, model, true)) continue;
    if (!modelSupportsThinking(model)) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[secondary_model].default_effort "${effort}" is set but model "${alias}" does not support thinking.`,
        {
          details: {
            section: SECONDARY_MODEL_SECTION,
            field: 'defaultEffort',
            model: alias,
            effort,
          },
        },
      );
    }
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[secondary_model].default_effort "${effort}" is not supported by model "${alias}". Supported efforts: ${model.supportEfforts?.join(', ')}.`,
      {
        details: {
          section: SECONDARY_MODEL_SECTION,
          field: 'defaultEffort',
          model: alias,
          effort,
        },
      },
    );
  }
}

export type SubagentModelSource = 'primary_override' | 'inherited' | 'secondary_pool';

type SubagentBinding = { model: string; thinking?: string; modelSource: SubagentModelSource };

export function resolveSubagentBinding(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: string,
): SubagentBinding {
  return bindSubagentModel(config, own, requested, []);
}

export function resolveSubagentBindingWithPrimary(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: string,
): SubagentBinding {
  if (requested === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    return { model: own.modelAlias, thinking: own.thinkingLevel, modelSource: 'primary_override' };
  }
  return bindSubagentModel(config, own, requested, [PRIMARY_SUBAGENT_MODEL_CHOICE]);
}

function bindSubagentModel(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested: string | undefined,
  extraChoices: readonly string[],
): SubagentBinding {
  const section = config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
  const pool = resolveSubagentModelPool(config);
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
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SECONDARY_MODEL_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
  const choice = requested ?? pool.defaultModel;
  if (choice === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SECONDARY_MODEL_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SECONDARY_MODEL_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, choice)) {
    const available = [...Object.keys(pool.models), ...extraChoices];
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid model "${choice}". Available models: ${available.join(', ')}.`,
      { details: { model: choice, availableModels: available } },
    );
  }
  return { model: choice, thinking: section?.defaultEffort, modelSource: 'secondary_pool' };
}

export function resolveSubagentThinking(
  config: IConfigService,
  model: Model | undefined,
  explicit: string | undefined,
): string | undefined {
  if (explicit !== undefined) return explicit;
  if (config.get<ThinkingConfig>(THINKING_SECTION)?.enabled === false) return undefined;
  return declaredDefaultEffortForModel(model);
}

export function buildSubagentModelDescriptions(config: IConfigService): string | undefined {
  if (!exposesSubagentModelChoice(config)) return undefined;
  return poolDescriptionLines(resolveSubagentModelPool(config)!).join('\n');
}

export function buildSubagentModelDescriptionsWithPrimary(
  config: IConfigService,
  callerModelAlias: string | undefined,
): string | undefined {
  const pool = resolveSubagentModelPool(config);
  if (pool === undefined) return undefined;
  const primaryLabel =
    callerModelAlias === undefined
      ? PRIMARY_SUBAGENT_MODEL_CHOICE
      : `${PRIMARY_SUBAGENT_MODEL_CHOICE} (= ${callerModelAlias})`;
  return [
    ...poolDescriptionLines(pool),
    `- ${primaryLabel}: your current model and thinking level`,
    "Pool entries don't inherit your thinking level.",
  ].join('\n');
}

export function buildSubagentModelSummary(config: IConfigService): string | undefined {
  if (!exposesSubagentModelChoice(config)) return undefined;
  const pool = resolveSubagentModelPool(config)!;
  const labels = orderedPoolAliases(pool).map((alias) =>
    alias === pool.defaultModel ? `${alias} [default]` : alias,
  );
  return `Available models (pass via model): ${labels.join(', ')}.`;
}

function poolDescriptionLines(pool: SubagentModelPool): string[] {
  const lines = ['Available models (pass via model):'];
  for (const alias of orderedPoolAliases(pool)) {
    const marker = alias === pool.defaultModel ? ' [default]' : '';
    lines.push(formatPoolLine(`${alias}${marker}`, pool.models[alias]!));
  }
  return lines;
}

function orderedPoolAliases(pool: SubagentModelPool): string[] {
  const aliases = Object.keys(pool.models);
  const defaultModel = pool.defaultModel;
  if (defaultModel === undefined || !Object.hasOwn(pool.models, defaultModel)) return aliases;
  return [defaultModel, ...aliases.filter((alias) => alias !== defaultModel)];
}

function formatPoolLine(label: string, description: string): string {
  return description === '' ? `- ${label}` : `- ${label}: ${description}`;
}

export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

export function stripSubagentForkParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('fork' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['fork'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('fork')) {
    next['required'] = required.filter((entry) => entry !== 'fork');
  }
  return next;
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
