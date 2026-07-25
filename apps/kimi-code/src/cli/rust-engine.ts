/**
 * Rust agent engine integration.
 *
 * Reads the config and wires the Rust agent engine (kimi-agent) when
 * `agent.engine = "rust"` is configured. Falls back to the JS engine
 * if the Rust binary is not found or fails to start.
 *
 * MultiLLM support: when `agent.multiLlm` lists provider names, those
 * providers are extracted from the config and passed to the Rust engine
 * as concurrent LLM providers ("first past the post").
 */
import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
  type RunTurnOverride,
} from '@moonshot-ai/kimi-code-sdk';

interface LlmProviderDef {
  name: string;
  model: string;
  system_prompt: string;
}

let rustRunTurnOverride: RunTurnOverride | undefined;

/**
 * Extract MultiLLM provider definitions from the kimi config.
 * Uses `config.agent.multiLlm` to select which providers to include.
 */
function extractMultiLlmProviders(config: {
  providers?: Record<string, { defaultModel?: string; type?: string }>;
  models?: Record<string, { provider?: string; model?: string }>;
  agent?: { multiLlm?: string[] };
}): LlmProviderDef[] | undefined {
  const providerNames = config.agent?.multiLlm;
  if (!providerNames || providerNames.length === 0) return undefined;
  if (!config.providers) return undefined;

  const providers: LlmProviderDef[] = [];

  for (const name of providerNames) {
    const providerConfig = config.providers[name];
    if (!providerConfig) continue;

    // Resolve the model: use provider's defaultModel, or find the first model
    // alias that references this provider
    let model = providerConfig.defaultModel;
    if (!model && config.models) {
      const alias = Object.entries(config.models).find(
        ([, m]) => m.provider === name,
      );
      if (alias) {
        model = alias[1].model;
      }
    }
    if (!model) model = 'default';

    providers.push({
      name,
      model,
      system_prompt: '',
    });
  }

  return providers.length > 0 ? providers : undefined;
}

/**
 * Try to wire the Rust agent engine based on config.
 * Reads the config file, checks `agent.engine`, and if `"rust"`,
 * dynamically imports the Rust adapter from the kimi-agent package.
 *
 * When `agent.multiLlm` is configured, extracts matching providers
 * and passes them to the Rust engine for concurrent MultiLLM execution.
 *
 * @returns The `runTurnOverride` function, or `undefined` to use the JS engine.
 */
export async function maybeLoadRustEngine(
  homeDir?: string,
  configPath?: string,
): Promise<RunTurnOverride | undefined> {
  // Lazy-init: once loaded, cache the result
  if (rustRunTurnOverride !== undefined) return rustRunTurnOverride;

  const resolvedHome = resolveKimiHome(homeDir);
  const resolvedConfig = resolveConfigPath({ homeDir: resolvedHome, configPath });
  const loaded = loadRuntimeConfigSafe(resolvedConfig);
  if (loaded.fileError !== undefined) {
    return undefined;
  }

  const agentConfig = loaded.config.agent;
  if (agentConfig?.engine !== 'rust') {
    return undefined;
  }

  // Extract MultiLLM providers when configured
  const providers = extractMultiLlmProviders(loaded.config);

  // Dynamic import of the Rust adapter via the workspace package.
  try {
    const { createRunTurnOverride } = await import('@moonshot-ai/kimi-agent/rust-loop');
    if (typeof createRunTurnOverride !== 'function') {
      return undefined;
    }
    const override = createRunTurnOverride(providers ?? undefined, resolvedHome);
    if (override !== undefined) {
      rustRunTurnOverride = override;
    }
    return rustRunTurnOverride;
  } catch {
    // Rust adapter not available — fall back to JS engine
    return undefined;
  }
}