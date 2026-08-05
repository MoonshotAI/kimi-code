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
 * naming the fallback). When a pool is configured, newly spawned subagents
 * bind to the pool's default model unless the parent model picks a pool alias
 * — or `primary` (`PRIMARY_SUBAGENT_MODEL_CHOICE`), the always-available
 * symbolic choice binding the caller's own model and thinking level — per
 * spawn via the `Agent` / `AgentSwarm` tool `model` parameter. Pool bindings
 * carry no explicit thinking level, so the subagent resolves thinking
 * naturally (global thinking config → the bound model's default effort)
 * rather than inheriting the caller's level. Without a pool, spawning
 * behavior is unchanged (subagents inherit the caller's model) and the tools
 * strip the no-op `model` parameter from their advertised schemas via
 * `stripSubagentModelParameter`, so the concept never enters the prompt and a
 * stray `model` argument is rejected instead of silently inheriting; the
 * strip returns a shallow copy and never mutates the input, so callers can
 * keep both schema variants as shared constants.
 *
 * Spawn bindings resolve through `resolveSubagentBinding`: `primary`
 * short-circuits to the caller's own model+thinking; with no pool a stray
 * non-`primary` request throws (defensive — the tools strip the parameter);
 * with a pool the request must be a pool alias, an omitted request falls back
 * to `default_model`, and anything else throws `CONFIG_INVALID` listing the
 * available choices so the parent model can retry. The tools advertise the
 * pool via `buildSubagentModelDescriptions`: the default model leads with a
 * `[default]` marker, the remaining aliases follow in config order, and the
 * caller's own alias is never listed on its own — it folds into the trailing
 * `primary (alias) [main model]` line (which carries the pool description,
 * plus a `[default]` marker when the caller IS the default) or, when the
 * caller is outside the pool, a generic `primary` hint line; an empty-string
 * description renders a bare `- alias` line. Spawn failures are wrapped by
 * `wrapSubagentModelError`: when the bound model is not the caller's own and
 * the catalog failed on exactly that alias, the parent model gets guidance
 * toward `[subagent.models]` instead of a bare resolution error.
 *
 * Cross-field pool validation is NOT part of the schema — it is enforced as
 * `Error2(CONFIG_INVALID)` by `assertValidSubagentModelPool` (run before
 * session materialization by the session lifecycle, with the Session-scope
 * validation service in `subagentModelsValidationService.ts` as backstop):
 * the default must be present and name a pool key, every pool key must
 * resolve through the model catalog, and the reserved `primary` alias is
 * rejected outright — as a pool key it would be unreachable (explicit
 * requests short-circuit to the caller's model) and would render a
 * self-contradictory description. `resolveSubagentBinding` repeats the
 * reserved-key check so a pool broken by a runtime config edit fails loudly
 * at spawn instead of binding the wrong model; any other malformation the
 * startup checks missed surfaces as the spawn-time errors above.
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

export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

export interface SubagentModelPool {
  readonly defaultModel?: string;
  readonly models: Record<string, string>;
}

export function resolveSubagentModelPool(config: IConfigService): SubagentModelPool | undefined {
  const section = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
  if (section?.models === undefined) return undefined;
  return { defaultModel: section.defaultModel, models: section.models };
}

export const SUBAGENT_DEFAULT_MODEL_REQUIRED_MESSAGE =
  '[subagent].default_model is required when [subagent.models] is configured';

export const SUBAGENT_PRIMARY_MODEL_RESERVED_MESSAGE = `[subagent.models] key "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the caller's own model. Rename the pool entry.`;

export function assertValidSubagentModelPool(
  pool: SubagentModelPool,
  modelCatalog: IModelCatalog,
): void {
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SUBAGENT_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SUBAGENT_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
  }
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
  if (Object.hasOwn(pool.models, PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw new Error2(ErrorCodes.CONFIG_INVALID, SUBAGENT_PRIMARY_MODEL_RESERVED_MESSAGE, {
      details: {
        section: SUBAGENT_SECTION,
        field: 'models',
        model: PRIMARY_SUBAGENT_MODEL_CHOICE,
      },
    });
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
    const markers =
      callerModelAlias === defaultModel ? '[main model] [default]' : '[main model]';
    lines.push(
      formatPoolLine(
        `${PRIMARY_SUBAGENT_MODEL_CHOICE} (${callerModelAlias}) ${markers}`,
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
