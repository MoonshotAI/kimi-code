/**
 * v2 config shape mapping — pure functions that project the agent-core-v2
 * engine's per-domain config view (`IConfigService.getAll()` /
 * `inspect().userValue` / `diagnostics()`) onto the v1 `KimiConfig` /
 * `ConfigDiagnostics` shapes the SDK contract returns.
 *
 * Why a mapping layer exists: v1 loads config.toml as ONE zod-validated
 * document (`KimiConfigSchema`), while v2 registers one config section per
 * owning domain and resolves each independently. The v1 top-level field
 * names line up 1:1 with the v2 camelCase domain names (both derive from
 * the same snake_case TOML keys), so the read mapping is a field pick, not
 * a reshape. Gaps that cannot be mapped faithfully (the v1-only `raw`
 * passthrough document, v2's materialized section defaults) are pinned in
 * the parity test's `KNOWN_DIFFS`, not papered over here.
 */
import type { ConfigDiagnostics, KimiConfig } from '#/types';

/**
 * Every top-level `KimiConfig` field except `raw` (a v1 write-path
 * implementation detail with no v2 counterpart). Each entry is both the v1
 * field name and the v2 config domain name.
 */
const KIMI_CONFIG_DOMAINS = [
  'providers',
  'defaultProvider',
  'defaultModel',
  'models',
  'thinking',
  'planMode',
  'yolo',
  'defaultPermissionMode',
  'defaultPlanMode',
  'permission',
  'hooks',
  'services',
  'mergeAllAvailableSkills',
  'extraSkillDirs',
  'loopControl',
  'background',
  'subagent',
  'secondaryModel',
  'mcp',
  'image',
  'modelCatalog',
  'experimental',
  'telemetry',
] as const;

/**
 * Pick the v1-shaped fields out of the v2 engine's resolved config
 * (`config.getAll()` — the effective view: file values plus env overlays
 * plus registered section defaults). Domains v2 knows but v1 does not
 * (`cron`, `tools`, `extraAgentDirs`, ...) are dropped,
 * mirroring how v1's schema strips unknown top-level keys.
 */
export function resolvedConfigToKimiConfig(resolved: Record<string, unknown>): KimiConfig {
  const config: Record<string, unknown> = {};
  for (const domain of KIMI_CONFIG_DOMAINS) {
    const value = resolved[domain];
    if (value !== undefined) {
      config[domain] = value;
    }
  }
  return config as KimiConfig;
}

/** Structural minimum of the v2 engine's `ConfigDiagnostic`. */
export interface V2ConfigDiagnostic {
  readonly domain?: string;
  readonly severity: string;
  readonly message: string;
}

/**
 * v1 reports diagnostics as flat warning strings; v2 carries structured
 * `{domain, severity, message}` entries. The SDK contract is the v1 shape,
 * so the message texts are the warnings (severity/domain stay available to
 * v2-native callers through the klient facade).
 */
export function diagnosticsToConfigDiagnostics(
  diagnostics: readonly V2ConfigDiagnostic[],
): ConfigDiagnostics {
  return { warnings: diagnostics.map((diagnostic) => diagnostic.message) };
}

/** The writes needed to reproduce v1 `removeKimiProvider` semantics. */
export interface ProviderRemovalPlan {
  readonly providers: Record<string, unknown>;
  readonly models: Record<string, unknown>;
  readonly clearDefaultModel: boolean;
  readonly clearDefaultProvider: boolean;
  /**
   * Cascade for the `[secondary_model]` subagent pool / legacy recipe:
   * `undefined` = unchanged, `null` = drop the whole section (its effective
   * default dangles, so the section can no longer validate), otherwise the
   * replacement section with pool entries pointing at removed models
   * filtered out.
   */
  readonly secondaryModel: Record<string, unknown> | null | undefined;
}

/**
 * Compute the v1 cascade for removing a provider: drop the provider entry,
 * drop every model whose `provider` points at it, and clear the default
 * pointers when they dangle. The v2 engine's own `providerService.delete`
 * only clears the default-provider pointer, so the SDK replays the full v1
 * cascade through the config facade. Inputs are the USER-layer values
 * (`inspect().userValue`), matching v1's disk-config write base.
 *
 * The `[secondary_model]` section cascades too: pool entries that name a
 * removed model alias are filtered out, and when the effective default
 * (`defaultModel`, or the legacy recipe's `model` fallback) dangles the
 * whole section is dropped — a surviving `[secondary_model.models]` table
 * without its default would fail pool validation on every session create.
 */
export function planProviderRemoval(input: {
  readonly providers: Record<string, unknown> | undefined;
  readonly models: Record<string, Record<string, unknown>> | undefined;
  readonly defaultModel: string | undefined;
  readonly defaultProvider: string | undefined;
  readonly secondaryModel?: Record<string, unknown>;
  readonly providerId: string;
}): ProviderRemovalPlan {
  const providers = { ...input.providers };
  delete providers[input.providerId];

  const models: Record<string, unknown> = {};
  let removedDefault = false;
  for (const [key, model] of Object.entries(input.models ?? {})) {
    if (model['provider'] === input.providerId) {
      if (input.defaultModel === key) removedDefault = true;
      continue;
    }
    models[key] = model;
  }

  return {
    providers,
    models,
    clearDefaultModel: removedDefault,
    clearDefaultProvider: input.defaultProvider === input.providerId,
    secondaryModel: planSecondaryModelCascade(input.secondaryModel, models),
  };
}

/**
 * Cascade the provider removal into the `[secondary_model]` section against
 * the surviving model-alias table. See `ProviderRemovalPlan.secondaryModel`
 * for the tri-state result.
 */
function planSecondaryModelCascade(
  secondaryModel: Record<string, unknown> | undefined,
  survivingModels: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  if (secondaryModel === undefined) return undefined;

  const defaultAlias = secondaryModel['defaultModel'] ?? secondaryModel['model'];
  if (typeof defaultAlias === 'string' && !(defaultAlias in survivingModels)) {
    return null;
  }

  const pool = secondaryModel['models'];
  if (pool === undefined || typeof pool !== 'object' || pool === null) {
    return undefined;
  }
  const entries = Object.entries(pool as Record<string, unknown>);
  const surviving = entries.filter(([alias]) => alias in survivingModels);
  if (surviving.length === entries.length) return undefined;
  return { ...secondaryModel, models: Object.fromEntries(surviving) };
}

/**
 * Apply the v1 remove-provider cascade to a whole `KimiConfig` in memory (no
 * persistence): drop the provider entry, every model pointing at it, and the
 * default pointers when they dangle. Hosts that stage a removal and fold it
 * into a later atomic write (instead of persisting it immediately) build on
 * this — the same role the v2 engine's `shapeWithoutProvider` plays for its
 * own refresh path.
 */
export function removeProviderFromConfig(config: KimiConfig, providerId: string): KimiConfig {
  const plan = planProviderRemoval({
    providers: config.providers as Record<string, unknown> | undefined,
    models: config.models as Record<string, Record<string, unknown>> | undefined,
    defaultModel: config.defaultModel,
    defaultProvider: config.defaultProvider,
    secondaryModel: config.secondaryModel as Record<string, unknown> | undefined,
    providerId,
  });
  return {
    ...config,
    providers: plan.providers as KimiConfig['providers'],
    models: plan.models as KimiConfig['models'],
    defaultModel: plan.clearDefaultModel ? undefined : config.defaultModel,
    defaultProvider: plan.clearDefaultProvider ? undefined : config.defaultProvider,
    secondaryModel:
      plan.secondaryModel === null
        ? undefined
        : ((plan.secondaryModel ?? config.secondaryModel) as KimiConfig['secondaryModel']),
  };
}
