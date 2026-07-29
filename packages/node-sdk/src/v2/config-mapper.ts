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
 * (`cron`, `tools`, `secondaryModel`, `extraAgentDirs`, ...) are dropped,
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
}

/**
 * Compute the v1 cascade for removing a provider: drop the provider entry,
 * drop every model whose `provider` points at it, and clear the default
 * pointers when they dangle. The v2 engine's own `providerService.delete`
 * only clears the default-provider pointer, so the SDK replays the full v1
 * cascade through the config facade. Inputs are the USER-layer values
 * (`inspect().userValue`), matching v1's disk-config write base.
 */
export function planProviderRemoval(input: {
  readonly providers: Record<string, unknown> | undefined;
  readonly models: Record<string, Record<string, unknown>> | undefined;
  readonly defaultModel: string | undefined;
  readonly defaultProvider: string | undefined;
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
  };
}
