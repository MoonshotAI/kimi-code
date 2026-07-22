/**
 * `mcp` domain (L5) — `mcp` config-section schema and env bindings.
 *
 * Owns the `[mcp]` configuration section (`startup_timeout_ms` /
 * `tool_timeout_ms` on disk) together with the `KIMI_MCP_STARTUP_TIMEOUT_MS`
 * / `KIMI_MCP_TOOL_TIMEOUT_MS` env overrides, resolved as
 * `env > config.toml > unset`. The values are the *global default* MCP server
 * startup (connect + tool discovery) and single tool-call timeouts: the
 * per-server `startupTimeoutMs` / `toolTimeoutMs` in `mcp.json` always win,
 * and when neither is set the connection manager falls back to its built-in
 * defaults. While an env var is set, `stripEnvBoundFields` restores the
 * env-free raw value before persistence, so the override never leaks into
 * `config.toml`. Self-registered at module load via `registerConfigSection`,
 * so the `config` domain never imports this domain's types.
 */

import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const MCP_SECTION = 'mcp';

export const McpSectionSchema = z.object({
  startupTimeoutMs: z.number().int().min(1).optional(),
  toolTimeoutMs: z.number().int().min(1).optional(),
});

export type McpSection = z.infer<typeof McpSectionSchema>;

export const MCP_STARTUP_TIMEOUT_ENV = 'KIMI_MCP_STARTUP_TIMEOUT_MS';
export const MCP_TOOL_TIMEOUT_ENV = 'KIMI_MCP_TOOL_TIMEOUT_MS';

/** Parse an env override; anything but a positive integer is ignored. */
function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const mcpEnvBindings: EnvBindings<McpSection> = envBindings(McpSectionSchema, {
  startupTimeoutMs: { env: MCP_STARTUP_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  toolTimeoutMs: { env: MCP_TOOL_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
});

export const stripMcpEnv = stripEnvBoundFields(mcpEnvBindings);

registerConfigSection(MCP_SECTION, McpSectionSchema, {
  env: mcpEnvBindings,
  stripEnv: stripMcpEnv,
});
