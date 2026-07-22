/**
 * `subagent` domain (L6) — subagent config-section schema, env binding, and
 * timeout / model resolution.
 *
 * Owns the `[subagent]` configuration section (`timeout_ms`, `model`, `effort`
 * on disk) together with the `KIMI_SUBAGENT_TIMEOUT_MS`, `KIMI_SUBAGENT_MODEL`,
 * and `KIMI_SUBAGENT_EFFORT` env overrides, mirroring v1's
 * `resolveSubagentTimeoutMs` precedence (env > config.toml > 2h default). While
 * an env var is set, `stripEnvBoundFields` restores the env-free raw value
 * before persistence, so the override never leaks into `config.toml`. Both
 * collaboration tools — `Agent` in this domain and `AgentSwarm` in the `swarm`
 * domain — resolve their per-run timeout through `resolveSubagentTimeoutMs`,
 * and render the timeout message with `formatSubagentTimeoutDescription`.
 *
 * The optional `model`/`effort` pair configures a secondary ("subagent")
 * model: when set, newly spawned subagents bind to it by default instead of
 * inheriting the caller's model, and the `Agent`/`AgentSwarm` tools let the
 * parent model pick per spawn via their `model` parameter. When unset,
 * spawning behavior is unchanged (subagents inherit the caller's model).
 * Both tools resolve spawn bindings through `resolveSubagentBinding`,
 * advertise the pair via `buildSubagentModelDescriptions`, and wrap spawn
 * failures with `wrapSubagentModelError`. Self-registered at module load via
 * `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 */

import { z } from 'zod';

import { isError2 } from '#/_base/errors/errors';
import { ConfigErrors } from '#/app/config/errors';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SUBAGENT_SECTION = 'subagent';

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
  /**
   * Secondary ("subagent") model alias from the model catalog. When set, newly
   * spawned subagents bind to it by default instead of inheriting the caller's
   * model; the parent model can still pick per spawn via the tool's `model`
   * parameter. Any catalog alias is accepted, so the secondary model is not
   * limited to Kimi models.
   */
  model: z.string().min(1).optional(),
  /**
   * Thinking effort for the secondary model. Only takes effect together with
   * `model`. Follows the main model's thinking-effort semantics: models with
   * strict effort validation fall back to the model's own default when the
   * value is unsupported; other providers receive the value as-is.
   */
  effort: z.string().min(1).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

/** Default per-run subagent timeout: 2 hours, same as v1. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SUBAGENT_TIMEOUT_ENV = 'KIMI_SUBAGENT_TIMEOUT_MS';
export const SUBAGENT_MODEL_ENV = 'KIMI_SUBAGENT_MODEL';
export const SUBAGENT_EFFORT_ENV = 'KIMI_SUBAGENT_EFFORT';

/** Parse the env override; anything but a positive integer is ignored (v1 semantics). */
function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** Parse an env string override; blank values are ignored. */
function parseNonEmptyEnv(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const subagentEnvBindings: EnvBindings<SubagentConfig> = envBindings(
  SubagentConfigSchema,
  {
    timeoutMs: { env: SUBAGENT_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
    model: { env: SUBAGENT_MODEL_ENV, parse: parseNonEmptyEnv },
    effort: { env: SUBAGENT_EFFORT_ENV, parse: parseNonEmptyEnv },
  },
);

export const stripSubagentEnv = stripEnvBoundFields(subagentEnvBindings);

registerConfigSection(SUBAGENT_SECTION, SubagentConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS },
  env: subagentEnvBindings,
  stripEnv: stripSubagentEnv,
});

/**
 * Resolve the effective per-run subagent timeout. Governs foreground and
 * background subagents (and AgentSwarm) through the task manager's per-task
 * timeout.
 */
export function resolveSubagentTimeoutMs(config: IConfigService): number {
  return (
    config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.timeoutMs ??
    DEFAULT_SUBAGENT_TIMEOUT_MS
  );
}

/** Model choice offered to the parent model when spawning a subagent. */
export type SubagentModelChoice = 'subagent' | 'primary';

/** The secondary model configured for subagents, if any. */
export function resolveSubagentModel(config: IConfigService): string | undefined {
  return config.get<SubagentConfig | undefined>(SUBAGENT_SECTION)?.model;
}

/**
 * Resolve the model/thinking a newly spawned subagent should bind to. The
 * configured secondary model is the default whenever it is set; `requested`
 * is the parent model's per-spawn choice ('primary' opts back into the
 * caller's own model). The configured `effort` only applies together with the
 * secondary model. Without a configured secondary model, spawning is
 * unchanged: the subagent inherits the caller's model and thinking level.
 */
export function resolveSubagentBinding(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: SubagentModelChoice,
): { model: string; thinking: string } {
  const cfg = config.get<SubagentConfig | undefined>(SUBAGENT_SECTION);
  if (requested !== 'primary' && cfg?.model !== undefined) {
    return { model: cfg.model, thinking: cfg.effort ?? own.thinkingLevel };
  }
  return { model: own.modelAlias, thinking: own.thinkingLevel };
}

/**
 * Advertise the two selectable models when a secondary model is configured.
 * Returns undefined when no secondary model is configured or the caller has
 * no model bound yet, so the `model` parameter stays undocumented in setups
 * where it would have no effect. Shared by the `Agent` and `AgentSwarm` tool
 * descriptions.
 */
export function buildSubagentModelDescriptions(
  config: IConfigService,
  callerModelAlias: string | undefined,
): string | undefined {
  const subagentModel = resolveSubagentModel(config);
  if (subagentModel === undefined || callerModelAlias === undefined) return undefined;
  return [
    'Available models (pass via model):',
    `- subagent: ${subagentModel} (default) — the configured secondary model; cheaper, prefer it for routine subagent tasks`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it for hard, quality-sensitive subagent tasks`,
  ].join('\n');
}

/**
 * A spawn failure whose cause is an invalid model configuration almost always
 * means a bad `[subagent].model` alias — point at the config knob instead of
 * surfacing a bare catalog error. Other failures (MCP bootstrap, storage,
 * prompt building) pass through untouched so their real cause is not buried
 * under misleading advice.
 */
export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ConfigErrors.codes.CONFIG_INVALID) return error;
  return new Error(
    `${error.message} (subagent model "${boundModel}" comes from [subagent].model / ${SUBAGENT_MODEL_ENV} — check that it is a valid model alias)`,
    { cause: error },
  );
}

/** Human-readable duration for the subagent timeout message. */
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
