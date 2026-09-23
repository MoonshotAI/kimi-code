import { z } from 'zod';

import {
  envBindings,
  registerConfigSection,
  stripEnvBoundFields,
  type EnvBindings,
} from '@moonshot-ai/agent-core-v2';

export const SERVER_SECTION = 'server';

export const SERVER_MAX_LIVE_SESSIONS_ENV = 'KIMI_CODE_SERVER_MAX_LIVE_SESSIONS';
export const SERVER_SESSION_IDLE_TIMEOUT_ENV = 'KIMI_CODE_SERVER_SESSION_IDLE_TIMEOUT_MS';

export const DEFAULT_MAX_LIVE_SESSIONS = 16;
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;

export const ServerConfigSchema = z.object({
  maxLiveSessions: z.number().int().min(0).optional(),
  sessionIdleTimeoutMs: z.number().int().min(0).optional(),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export interface LiveSessionLimits {
  readonly maxLiveSessions: number;
  readonly sessionIdleTimeoutMs: number;
}

function parseNonNegativeInt(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const serverEnvBindings: EnvBindings<ServerConfig> = envBindings(ServerConfigSchema, {
  maxLiveSessions: { env: SERVER_MAX_LIVE_SESSIONS_ENV, parse: parseNonNegativeInt },
  sessionIdleTimeoutMs: { env: SERVER_SESSION_IDLE_TIMEOUT_ENV, parse: parseNonNegativeInt },
});

export const stripServerEnv = stripEnvBoundFields(serverEnvBindings);

export function resolveLiveSessionLimits(config: ServerConfig | undefined): LiveSessionLimits {
  return {
    maxLiveSessions: config?.maxLiveSessions ?? DEFAULT_MAX_LIVE_SESSIONS,
    sessionIdleTimeoutMs: config?.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  };
}

registerConfigSection(SERVER_SECTION, ServerConfigSchema, {
  env: serverEnvBindings,
  stripEnv: stripServerEnv,
});
