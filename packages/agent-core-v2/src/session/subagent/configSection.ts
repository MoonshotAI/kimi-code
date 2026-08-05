/**
 * `subagent` domain — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms`, `default_model`,
 * and the `[subagent.models]` table on disk) together with the
 * `KIMI_SUBAGENT_TIMEOUT_MS` env override (precedence: env > config.toml > 2h
 * default). While the env var is set, `stripEnvBoundFields` restores the
 * env-free raw value before persistence, so the override never leaks into
 * `config.toml`. Per-run timeouts resolve through `resolveSubagentTimeoutMs`,
 * and the timeout message renders with `formatSubagentTimeoutDescription`.
 *
 * The model half of the spawn binding is the subagent model pool
 * (`[subagent.models]`: alias → description, with `[subagent].default_model`
 * naming the fallback): when a pool is configured, newly spawned subagents
 * bind to the pool's default model unless the parent model picks a pool alias
 * (or `primary`, the caller's own model) per spawn via the `Agent` /
 * `AgentSwarm` tool `model` parameter. Pool bindings carry no explicit
 * thinking level, so the subagent resolves thinking naturally (global thinking
 * config → the bound model's default effort) rather than inheriting the
 * caller's level. Without a pool, spawning behavior is unchanged (subagents
 * inherit the caller's model) and the tools strip the no-op `model` parameter
 * from their advertised schemas via `stripSubagentModelParameter`. Both tools
 * resolve spawn bindings through `resolveSubagentBinding`, advertise the pool
 * via `buildSubagentModelDescriptions`, and wrap spawn failures with
 * `wrapSubagentModelError`. Cross-field pool validation (default_model
 * present / in-pool / every key resolvable) is NOT part of the schema — it is
 * enforced at session creation by the Session-scope validation service (see
 * `subagentModelsValidationService.ts`) via `assertValidSubagentModelPool`.
 * Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { IModelCatalog } from '#/kosong/model/catalog';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), z.string()).optional(),
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

/**
 * The always-available tool `model` choice: bind the subagent to the caller's
 * own model instead of a pool alias.
 */
export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

/**
 * The configured subagent model pool: the `[subagent.models]` alias →
 * description record plus the `[subagent].default_model` fallback. Cross-field
 * validity (default present, in-pool, resolvable keys) is enforced at session
 * creation by the validation service, so consumers may see a malformed pool
 * only when that service did not run (defensive paths throw below).
 */
export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, string>;
}

/**
 * Read the configured pool, or `undefined` when `[subagent.models]` is absent
 * (subagents then inherit the caller's model and the tools drop their `model`
 * parameter).
 */
export function resolveSubagentModelPool(config: IConfigService): SubagentModelPool | undefined {
  const section = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
  if (section?.models === undefined) return undefined;
  return { defaultModel: section.defaultModel, models: section.models };
}

export const SUBAGENT_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[subagent].default_model is required when [subagent.models] is configured';

/**
 * Cross-field pool validation, run at session creation by the validation
 * service: the default must be present and name a pool key, and every pool
 * key must resolve through the model catalog. Throws `Error2(CONFIG_INVALID)`
 * — a broken pool fails session creation instead of degrading silently.
 */
export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  const aliases = Object.keys(pool.models);
  if (pool.defaultModel === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SUBAGENT_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SUBAGENT_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, pool.defaultModel)) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[subagent].default_model "${pool.defaultModel}" is not a [subagent.models] key. Available models: ${aliases.join(', ')}.`,
      { details: { model: pool.defaultModel, availableModels: aliases } },
    );
  }
  for (const alias of aliases) {
    try {
      modelCatalog.get(alias);
    } catch (error) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `[subagent.models] entry "${alias}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error, details: { model: alias } },
      );
    }
  }
}

/**
 * Resolve the model/thinking binding for a spawned subagent.
 *
 * - `requested === 'primary'` always binds the caller's own model.
 * - Without a configured pool the caller binding is inherited; a stray
 *   non-`primary` request (the tools strip the parameter when no pool exists,
 *   so this is defensive) throws `CONFIG_INVALID`.
 * - With a pool, `requested` must be a pool alias, and an omitted request
 *   falls back to `default_model`. Pool bindings carry no explicit thinking
 *   level. Anything else throws `CONFIG_INVALID` listing the available
 *   choices, so the parent model can retry with a valid alias.
 */
export function resolveSubagentBinding(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: string,
): { model: string; thinking?: string } {
  if (requested === PRIMARY_SUBAGENT_MODEL_CHOICE) {
    return { model: own.modelAlias, thinking: own.thinkingLevel };
  }
  const pool = resolveSubagentModelPool(config);
  if (pool === undefined) {
    if (requested !== undefined) {
      throw new Error2(
        ErrorCodes.CONFIG_INVALID,
        `Invalid model "${requested}": no [subagent.models] pool is configured, so subagents inherit the caller's model (pass "primary" or omit the model parameter).`,
        { details: { model: requested } },
      );
    }
    return { model: own.modelAlias, thinking: own.thinkingLevel };
  }
  const choice = requested ?? pool.defaultModel;
  if (choice === undefined) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SUBAGENT_DEFAULT_MODEL_REQUIRED_MESSAGE, {
      details: { section: SUBAGENT_SECTION, field: 'defaultModel' },
    });
  }
  if (!Object.hasOwn(pool.models, choice)) {
    const available = [...Object.keys(pool.models), PRIMARY_SUBAGENT_MODEL_CHOICE];
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `Invalid model "${choice}". Available models: ${available.join(', ')}.`,
      { details: { model: choice, availableModels: available } },
    );
  }
  return { model: choice };
}

/**
 * Render the pool as the tools' "Available models" description block, or
 * `undefined` when no pool is configured. The default model leads with a
 * `[default]` marker; the remaining pool aliases follow in config order; the
 * caller's own alias is never listed on its own — it renders through the
 * trailing `primary` line, which carries the pool description when the caller
 * is in the pool (`- primary (alias) [main model]: …`) and a generic hint
 * otherwise. An empty-string description renders a bare `- alias` line.
 */
export function buildSubagentModelDescriptions(
  config: IConfigService,
  callerModelAlias: string | undefined,
): string | undefined {
  const pool = resolveSubagentModelPool(config);
  if (pool === undefined) return undefined;
  const lines = ['Available models (pass via model):'];
  const defaultModel = pool.defaultModel;
  if (
    defaultModel !== undefined &&
    defaultModel !== callerModelAlias &&
    Object.hasOwn(pool.models, defaultModel)
  ) {
    lines.push(formatPoolLine(`${defaultModel} [default]`, pool.models[defaultModel]!));
  }
  for (const [alias, description] of Object.entries(pool.models)) {
    if (alias === defaultModel || alias === callerModelAlias) continue;
    lines.push(formatPoolLine(alias, description));
  }
  if (callerModelAlias !== undefined && Object.hasOwn(pool.models, callerModelAlias)) {
    lines.push(
      formatPoolLine(
        `${PRIMARY_SUBAGENT_MODEL_CHOICE} (${callerModelAlias}) [main model]`,
        pool.models[callerModelAlias]!,
      ),
    );
  } else {
    lines.push(
      `- ${PRIMARY_SUBAGENT_MODEL_CHOICE}: the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
    );
  }
  return lines.join('\n');
}

function formatPoolLine(label: string, description: string): string {
  return description === '' ? `- ${label}` : `- ${label}: ${description}`;
}

/**
 * Strip the `model` property from a subagent collaboration tool's advertised
 * JSON schema. When no `[subagent.models]` pool is configured the parameter is
 * a silent no-op, so the schema the model sees (and the args validator
 * compiled from the same advertised schema) drops it entirely — the model-pool
 * concept never enters the prompt, and a stray `model` argument is rejected
 * instead of silently inheriting the caller's model. Returns the input
 * unchanged when there is no `model` property; otherwise a shallow copy — the
 * input is never mutated, so callers can keep both variants as shared
 * constants.
 */
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

/**
 * Point a spawn-time "model not configured" failure at the pool config: when
 * the bound model is not the caller's own and the catalog failed on exactly
 * that alias, the parent model gets guidance toward `[subagent.models]`
 * instead of a bare resolution error. Anything else passes through unchanged.
 */
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
    `${error.message} (subagent model "${boundModel}" comes from [subagent.models] — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        subagentModel: boundModel,
        subagentModelConfig: {
          section: 'subagent.models',
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
