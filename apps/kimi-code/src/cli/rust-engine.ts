/**
 * Rust agent engine integration.
 *
 * Reads the config and wires the Rust agent engine (kimi-agent). The Rust
 * engine is the only engine since the v1/v2 migration — the engine defaults
 * to Rust even when the `[agent]` section is absent, and a load failure
 * throws instead of degrading to the deprecated JS loop. Falls back to the JS engine (with a
 * diagnostic log) if the Rust addon/binary is not found or fails to start.
 *
 * MultiLLM support: when `agent.multiLlm` lists provider names, those
 * providers are extracted from the config and passed to the Rust engine
 * as concurrent LLM providers ("first past the post").
 */
import {
  loadRuntimeConfigSafe,
  resolveConfigPath,
  resolveKimiHome,
} from '#/cli/runtime-config';
import { LocalKaos } from './kaos-local';
import { coderSystemPrompt } from './coder-profile-local';
import type { McpServerConfigEntry } from './mcp-local';
import { loadUserMcpServers } from './mcp-local';
import type { HookDefInput, McpServerInput } from './native-server-client';
import { PluginManager } from './plugin-local';
import { prepareSystemPromptContext } from './system-prompt-local';

interface NativeLlmDef {
  protocol: 'openai' | 'anthropic' | 'google';
  base_url: string;
  api_key: string;
  model: string;
  max_tokens?: number;
}

interface RustEngineConfig {
  defaultModel?: string;
  providers?: Record<
    string,
    {
      defaultModel?: string;
      type?: string;
      apiKey?: string;
      baseUrl?: string;
      env?: Record<string, string>;
    }
  >;
  models?: Record<string, { provider?: string; model?: string; systemPrompt?: string }>;
  agent?: {
    multiLlm?: string[];
    nativeLlmProvider?: string;
    nativeTools?: boolean;
  };
}

/**
 * Extract the native HTTP LLM transport config from the kimi config.
 * `agent.nativeLlmProvider` names a provider whose endpoint the Rust
 * engine should call directly (SSE streaming). Static-key
 * `openai`/`kimi` (Chat Completions), `anthropic` (Messages), and
 * `google-genai` (Gemini streamGenerateContent) providers are supported;
 * anything else falls back to the host proxy.
 */
function extractNativeLlm(config: RustEngineConfig): NativeLlmDef | undefined {
  const explicit = config.agent?.nativeLlmProvider;
  if (explicit !== undefined && explicit.length > 0) {
    return resolveNativeLlm(config, explicit, /* announce */ true);
  }
  // Full-replacement default: when no provider is named, derive it from the
  // session's default model. A provider that does not qualify (dynamic
  // credentials, unsupported type) falls back to the host proxy silently —
  // the Rust engine still drives the turn either way.
  const alias =
    config.defaultModel !== undefined ? config.models?.[config.defaultModel] : undefined;
  const derived = alias?.provider;
  if (alias === undefined || derived === undefined) return undefined;
  // A provider carrying an `env` block (proxies, runtime environment) relies
  // on host-side request semantics the native transport does not replicate;
  // auto-derivation skips it. Naming it explicitly still opts in.
  if (config.providers?.[derived]?.env !== undefined) return undefined;
  return resolveNativeLlm(config, derived, /* announce */ false, alias.model);
}

/**
 * Load just the native-LLM transport definition from the config on disk.
 * Used by the session-engine pilot (`KIMI_SESSION_ENGINE=1`), where the
 * engine talks to the provider directly and no turn override is created.
 */
export function loadNativeLlmDef(
  homeDir?: string,
  configPath?: string,
): NativeLlmDef | undefined {
  const resolvedHome = resolveKimiHome(homeDir);
  const resolvedConfig = resolveConfigPath({ homeDir: resolvedHome, configPath });
  const loaded = loadRuntimeConfigSafe(resolvedConfig);
  if (loaded.fileError !== undefined) return undefined;
  return extractNativeLlm(loaded.config);
}

/**
 * Map one config MCP-server entry onto the engine's session wire spec. Stdio
 * carries command/args/env/cwd; remote (http/sse) carries the url, the header
 * marker, and the bearer token resolved from its env var (never committed).
 * Pure — no I/O — so it is unit-testable.
 */
export function mapMcpServerConfig(
  name: string,
  config: McpServerConfigEntry,
  env: Record<string, string | undefined> = process.env,
): McpServerInput {
  const common = {
    name,
    enabled: config.enabled,
    enabledTools: config.enabledTools,
    disabledTools: config.disabledTools,
    startupTimeoutMs: config.startupTimeoutMs,
    toolTimeoutMs: config.toolTimeoutMs,
  };
  if (config.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    };
  }
  // http | sse — a remote server. Resolve the bearer token from its env var.
  const bearerToken =
    config.bearerTokenEnvVar !== undefined ? env[config.bearerTokenEnvVar] : undefined;
  return {
    ...common,
    transport: config.transport,
    url: config.url,
    bearerTokenEnvVar: config.bearerTokenEnvVar,
    bearerToken,
    hasHeaders: config.headers !== undefined,
  };
}

/**
 * Load MCP servers for the session engine (print-mode pilot) from two trusted
 * sources: the user-global `mcp.json` (`trustProjectMcpConfig: false` — a
 * headless run never auto-starts untrusted project stdio) and enabled
 * plugin-contributed servers (already namespaced + cwd-resolved by the plugin
 * manager). Each source is fault-isolated; a bad source is skipped, not fatal.
 */
export async function loadSessionMcpServers(
  homeDir?: string,
  _cwd?: string,
): Promise<McpServerInput[]> {
  // Keyed by name so plugin runtime names (namespaced) and user names coexist;
  // on an unexpected collision the later source wins deterministically.
  const merged = new Map<string, McpServerInput>();

  try {
    const servers = await loadUserMcpServers(homeDir);
    for (const [name, config] of Object.entries(servers)) {
      merged.set(name, mapMcpServerConfig(name, config));
    }
  } catch {
    // A malformed mcp.json must not sink the whole session; run without it.
  }

  try {
    const plugins = new PluginManager({ kimiHomeDir: resolveKimiHome(homeDir) });
    await plugins.load();
    for (const [name, config] of Object.entries(plugins.enabledMcpServers())) {
      merged.set(name, mapMcpServerConfig(name, config));
    }
  } catch {
    // Plugin discovery failures are non-fatal — run with whatever loaded.
  }

  return [...merged.values()];
}

/**
 * Load external lifecycle hooks for the session engine from the two trusted
 * sources the harness uses: the user config's `[[hooks]]` section and enabled
 * plugin-contributed hooks. The engine executes them natively (PreToolUse /
 * PostToolUse / UserPromptSubmit / Stop); each source is fault-isolated so a
 * broken config never sinks the session.
 */
export async function loadSessionHooks(
  homeDir?: string,
  configPath?: string,
): Promise<HookDefInput[]> {
  const hooks: HookDefInput[] = [];

  try {
    const resolvedHome = resolveKimiHome(homeDir);
    const resolvedConfig = resolveConfigPath({ homeDir: resolvedHome, configPath });
    const loaded = loadRuntimeConfigSafe(resolvedConfig);
    if (loaded.fileError === undefined) {
      for (const hook of loaded.config.hooks ?? []) {
        // The engine validates the wire shape; the host passes entries through.
        hooks.push({ ...hook } as unknown as HookDefInput);
      }
    }
  } catch {
    // A malformed config must not sink the whole session; run without hooks.
  }

  try {
    const plugins = new PluginManager({ kimiHomeDir: resolveKimiHome(homeDir) });
    await plugins.load();
    for (const hook of plugins.enabledHooks()) {
      hooks.push({ ...hook, env: hook.env === undefined ? undefined : { ...hook.env } });
    }
  } catch {
    // Plugin discovery failures are non-fatal — run with whatever loaded.
  }

  return hooks;
}

/**
 * Build the session system prompt with production parity: the default `coder`
 * profile's base identity/rules (`profile/default/system.md`) plus freshly
 * gathered runtime context (merged AGENTS.md, cwd listing) via the profile
 * subsystem — the same assembly `Agent.updateSystemPromptFromProfile` performs
 * on the harness path. Returns `undefined` on any failure so the caller keeps
 * its fallback prompt rather than crashing the session.
 */
export async function loadSessionSystemPrompt(
  homeDir?: string,
  cwd?: string,
): Promise<string | undefined> {
  try {
    const base = await LocalKaos.create();
    const kaos = cwd !== undefined ? base.withCwd(cwd) : base;
    const context = await prepareSystemPromptContext(kaos, homeDir);
    return coderSystemPrompt({
      osEnv: kaos.osEnv,
      cwd: kaos.getcwd(),
      cwdListing: context.cwdListing,
      agentsMd: context.agentsMd,
      additionalDirsInfo: context.additionalDirsInfo,
    });
  } catch {
    return undefined;
  }
}

function resolveNativeLlm(
  config: RustEngineConfig,
  name: string,
  announce: boolean,
  aliasModel?: string,
): NativeLlmDef | undefined {
  const warn = (message: string): void => {
    if (announce) console.warn(message);
  };
  const provider = config.providers?.[name];
  if (!provider) {
    warn(`[kimi-agent] agent.nativeLlmProvider "${name}" not found in providers.`);
    return undefined;
  }

  const protocol =
    provider.type === 'anthropic'
      ? 'anthropic'
      : provider.type === 'openai' || provider.type === 'kimi'
        ? 'openai'
        : provider.type === 'google-genai'
          ? 'google'
          : undefined;
  if (protocol === undefined) {
    warn(
      `[kimi-agent] provider "${name}" type "${provider.type ?? 'unknown'}" is not supported by the native transport — falling back to host proxy.`,
    );
    return undefined;
  }
  // Gemini has a well-known public endpoint; a missing baseUrl means "the
  // official API", unlike the other protocols where it must be explicit.
  // The native transport needs the version segment in the URL.
  const baseUrl =
    provider.baseUrl ??
    (protocol === 'google' ? 'https://generativelanguage.googleapis.com/v1beta' : undefined);
  if (!baseUrl || !provider.apiKey) {
    warn(
      `[kimi-agent] provider "${name}" needs a static baseUrl + apiKey for the native transport — falling back to host proxy.`,
    );
    return undefined;
  }

  // Resolve the model: the invoking alias first (auto-derivation), then the
  // provider default, then any alias pointing at this provider.
  let model = aliasModel ?? provider.defaultModel;
  if (!model && config.models) {
    const alias = Object.entries(config.models).find(([, m]) => m.provider === name);
    if (alias) model = alias[1].model;
  }
  if (!model) {
    warn(`[kimi-agent] provider "${name}" has no resolvable model — falling back to host proxy.`);
    return undefined;
  }

  return {
    protocol,
    base_url: baseUrl,
    api_key: provider.apiKey,
    model,
  };
}
