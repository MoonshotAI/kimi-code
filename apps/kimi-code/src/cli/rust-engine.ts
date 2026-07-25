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

interface NativeLlmDef {
  protocol: 'openai' | 'anthropic';
  base_url: string;
  api_key: string;
  model: string;
  max_tokens?: number;
}

interface RustEngineConfig {
  providers?: Record<
    string,
    { defaultModel?: string; type?: string; apiKey?: string; baseUrl?: string }
  >;
  models?: Record<string, { provider?: string; model?: string; systemPrompt?: string }>;
  agent?: {
    multiLlm?: string[];
    nativeLlmProvider?: string;
    nativeTools?: boolean;
  };
}

let rustRunTurnOverride: RunTurnOverride | undefined;

/**
 * Extract MultiLLM provider definitions from the kimi config.
 * Uses `config.agent.multiLlm` to select which providers to include.
 */
function extractMultiLlmProviders(
  config: RustEngineConfig,
  defaultSystemPrompt?: string,
): LlmProviderDef[] | undefined {
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
    let systemPrompt = defaultSystemPrompt ?? '';
    if (config.models) {
      const alias = Object.entries(config.models).find(([, m]) => m.provider === name);
      if (alias) {
        model ??= alias[1].model;
        // Per-model system prompt wins over the default when present.
        if (alias[1].systemPrompt) systemPrompt = alias[1].systemPrompt;
      }
    }
    model ??= 'default';

    providers.push({
      name,
      model,
      system_prompt: systemPrompt,
    });
  }

  return providers.length > 0 ? providers : undefined;
}

/**
 * Extract the native HTTP LLM transport config from the kimi config.
 * `agent.nativeLlmProvider` names a provider whose endpoint the Rust
 * engine should call directly (SSE streaming). Only static-key
 * `openai`/`kimi` (Chat Completions) and `anthropic` (Messages) providers
 * are supported; anything else falls back to the host proxy.
 */
function extractNativeLlm(config: RustEngineConfig): NativeLlmDef | undefined {
  const name = config.agent?.nativeLlmProvider;
  if (!name) return undefined;
  const provider = config.providers?.[name];
  if (!provider) {
    console.warn(`[kimi-agent] agent.nativeLlmProvider "${name}" not found in providers.`);
    return undefined;
  }

  const protocol =
    provider.type === 'anthropic'
      ? 'anthropic'
      : provider.type === 'openai' || provider.type === 'kimi'
        ? 'openai'
        : undefined;
  if (protocol === undefined) {
    console.warn(
      `[kimi-agent] provider "${name}" type "${provider.type ?? 'unknown'}" is not supported by the native transport — falling back to host proxy.`,
    );
    return undefined;
  }
  if (!provider.baseUrl || !provider.apiKey) {
    console.warn(
      `[kimi-agent] provider "${name}" needs a static baseUrl + apiKey for the native transport — falling back to host proxy.`,
    );
    return undefined;
  }

  // Resolve the model the same way MultiLLM extraction does.
  let model = provider.defaultModel;
  if (!model && config.models) {
    const alias = Object.entries(config.models).find(([, m]) => m.provider === name);
    if (alias) model = alias[1].model;
  }
  if (!model) {
    console.warn(
      `[kimi-agent] provider "${name}" has no resolvable model — falling back to host proxy.`,
    );
    return undefined;
  }

  return {
    protocol,
    base_url: provider.baseUrl,
    api_key: provider.apiKey,
    model,
  };
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
    // Warn if multiLlm is set but engine isn't rust — it's a no-op in this case.
    if (agentConfig?.multiLlm && agentConfig.multiLlm.length > 0) {
      console.warn(
        '[kimi-agent] agent.multiLlm is set but agent.engine is not "rust" — MultiLLM ignored.',
      );
    }
    return undefined;
  }

  // Extract MultiLLM providers and native execution options when configured
  const providers = extractMultiLlmProviders(loaded.config);
  const nativeLlm = extractNativeLlm(loaded.config);
  const nativeTools = agentConfig.nativeTools === true;

  // Dynamic import of the Rust adapter via the workspace package.
  try {
    const { createRunTurnOverride } = await import('@moonshot-ai/kimi-agent/rust-loop');
    if (typeof createRunTurnOverride !== 'function') {
      return undefined;
    }
    // The workspace root anchors the Read-prediction fast-path and the
    // native tool sandbox; the session working directory is the workspace.
    const override = createRunTurnOverride(providers ?? undefined, process.cwd(), {
      nativeLlm,
      nativeTools,
    });
    if (override !== undefined) {
      rustRunTurnOverride = override;
    }
    return rustRunTurnOverride;
  } catch {
    // Rust adapter not available — fall back to JS engine
    return undefined;
  }
}
