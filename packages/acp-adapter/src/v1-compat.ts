/**
 * Local type definitions to replace imports from `@moonshot-ai/agent-core` (v1).
 *
 * These types mirror the v1 engine's definitions so the ACP adapter can
 * operate without depending on the legacy v1 engine package.
 */

/** MCP server configuration (mirrors v1's McpServerConfig). */
export interface McpServerConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Whether to skip the MCP server's SSH verification. */
  skipSSHVerify?: boolean;
  /** @deprecated Use `transport` field instead. */
  type?: 'http' | 'sse' | 'stdio';
}

/** Provider type string (mirrors v1's ProviderType). */
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'google-genai'
  | 'openai_responses'
  | 'vertexai';

/**
 * Simplified version of v1's `effectiveModelAlias`.
 * Resolves a model alias by applying overrides to the base.
 * Does NOT include the Anthropic profile inference from v1.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function effectiveModelAlias(alias: any, _providerType?: ProviderType): any {
  const { overrides, ...base } = alias;
  if (overrides === undefined) return alias;
  return { ...base, ...(overrides as Record<string, unknown>) };
}