/**
 * Local type copies from the retired TS engine package `@moonshot-ai/agent-core`
 * (v1).
 *
 * `packages/acp-adapter` used to import these from the engine's root export.
 * The engine package is being retired, so the subset used by the adapter is
 * copied here instead. The v1 shapes are frozen, so a local copy stays in sync
 * by definition.
 *
 * Sources:
 *   - `packages/agent-core/src/config/schema.ts` — `ProviderTypeSchema`,
 *     `McpServerConfigSchema` (only the inferred TYPES are reproduced; the zod
 *     schemas themselves live in `migration-legacy`'s local copy).
 */

/** Copied from `config/schema.ts` (`ProviderType = z.infer<typeof ProviderTypeSchema>`). */
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'kimi'
  | 'google-genai'
  | 'openai_responses'
  | 'vertexai'
  | 'astron';

/** Copied from `config/schema.ts` (`McpServerConfig = z.infer<typeof McpServerConfigSchema>`). */
export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig | McpServerSseConfig;

/** Copied from `config/schema.ts` (`McpServerStdioConfig`). */
export interface McpServerStdioConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  executor?: 'local' | 'kaos';
  enabled?: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
}

/** Copied from `config/schema.ts` (`McpServerHttpConfig`). */
export interface McpServerHttpConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
  auth?: 'oauth';
  bearerTokenEnvVar?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
}

/** Copied from `config/schema.ts` (`McpServerSseConfig`). */
export interface McpServerSseConfig {
  transport: 'sse';
  url: string;
  headers?: Record<string, string>;
  auth?: 'oauth';
  bearerTokenEnvVar?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabledTools?: string[];
  disabledTools?: string[];
}
