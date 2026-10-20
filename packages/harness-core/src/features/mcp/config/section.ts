import { z } from 'zod';

import {
  isEnvBinding,
  isPlainObject,
  type ConfigSectionContribution,
  type EnvBinding,
  type EnvBindings,
  type GetEnv,
} from '#/features/config/index';

import { MAX_MCP_TIMEOUT_MS, McpTimeoutMsSchema } from '../core/config-schema';

export const MCP_CONFIG_SECTION = 'mcp';

export const McpSectionSchema = z.object({
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
});

export type McpSection = z.infer<typeof McpSectionSchema>;

export const MCP_STARTUP_TIMEOUT_ENV = 'KIMI_MCP_STARTUP_TIMEOUT_MS';
export const MCP_TOOL_TIMEOUT_ENV = 'KIMI_MCP_TOOL_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_MCP_TIMEOUT_MS
    ? parsed
    : undefined;
}

const mcpEnvBindings: EnvBindings<McpSection> = {
  startupTimeoutMs: { env: MCP_STARTUP_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  toolTimeoutMs: { env: MCP_TOOL_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
};

export const mcpConfigSection: ConfigSectionContribution<McpSection> = {
  name: MCP_CONFIG_SECTION,
  schema: McpSectionSchema,
  defaultValue: {},
  envBindings: mcpEnvBindings,
  stripEnv: stripEnvBoundFields<McpSection>(mcpEnvBindings),
};

function stripEnvBoundFields<T>(
  bindings: EnvBindings<T>,
): (value: T, raw: unknown, getEnv: GetEnv) => T | undefined {
  return (value, raw, getEnv) => {
    if (value === null || typeof value !== 'object') return value;
    if (!isPlainObject(bindings) || isEnvBinding(bindings)) return value;
    const base = isPlainObject(raw) ? raw : {};
    let out: Record<string, unknown> | undefined;
    for (const [field, binding] of Object.entries(bindings)) {
      if (binding === undefined || !isEnvBinding(binding)) continue;
      if (!resolvesFromEnv(binding, getEnv)) continue;
      out ??= { ...(value as Record<string, unknown>) };
      if (base[field] !== undefined) {
        out[field] = base[field];
      } else {
        delete out[field];
      }
    }
    if (out === undefined) return value;
    if (Object.keys(out).length > 0) return out as T;
    return (Object.keys(base).length > 0 ? base : undefined) as T | undefined;
  };
}

function resolvesFromEnv(binding: EnvBinding, getEnv: GetEnv): boolean {
  const parse = typeof binding === 'string' ? undefined : binding.parse;
  const names =
    typeof binding === 'string'
      ? [binding]
      : binding.deprecatedEnv === undefined
        ? [binding.env]
        : [binding.env, binding.deprecatedEnv];
  return names.some((name) => {
    const raw = getEnv(name);
    return raw !== undefined && (parse === undefined || parse(raw) !== undefined);
  });
}
