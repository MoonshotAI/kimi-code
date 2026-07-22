/**
 * `mcp` domain (L5) — `mcp` config-section schema and env binding.
 *
 * Owns the `[mcp]` configuration section (`startup_timeout_ms` on disk)
 * together with the `KIMI_MCP_STARTUP_TIMEOUT_MS` env override, resolved as
 * `env > config.toml > unset`. The value is the *global default* MCP server
 * startup (connect + tool discovery) timeout: a per-server `startupTimeoutMs`
 * in `mcp.json` always wins, and when neither is set the connection manager
 * falls back to its built-in 30s default. While the env var is set,
 * `stripEnvBoundFields` restores the env-free raw value before persistence,
 * so the override never leaks into `config.toml`. Self-registered at module
 * load via `registerConfigSection`, so the `config` domain never imports this
 * domain's types.
 */

import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const MCP_SECTION = 'mcp';

export const McpSectionSchema = z.object({
  startupTimeoutMs: z.number().int().min(1).optional(),
});

export type McpSection = z.infer<typeof McpSectionSchema>;

export const MCP_STARTUP_TIMEOUT_ENV = 'KIMI_MCP_STARTUP_TIMEOUT_MS';

/** Parse the env override; anything but a positive integer is ignored. */
function parseStartupTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const mcpEnvBindings: EnvBindings<McpSection> = envBindings(McpSectionSchema, {
  startupTimeoutMs: { env: MCP_STARTUP_TIMEOUT_ENV, parse: parseStartupTimeoutMsEnv },
});

export const stripMcpEnv = stripEnvBoundFields(mcpEnvBindings);

registerConfigSection(MCP_SECTION, McpSectionSchema, {
  env: mcpEnvBindings,
  stripEnv: stripMcpEnv,
});
