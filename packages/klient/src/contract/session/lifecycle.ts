/**
 * `sessionLifecycleService` — creates and tracks sessions at the process
 * root. Mirrors `agent-core-v2/app/sessionLifecycle/sessionLifecycle.ts`.
 * The engine returns `ISessionScopeHandle`s; over JSON only the plain data
 * fields survive, so the wire keeps `{ id, kind }` (loose — extra fields may
 * appear in-process).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

/**
 * Mirror of `mcpServerConfigSchema` in `../global/plugins.js` — kept local
 * because that fragment does not export its copy; keep the two in sync.
 * Mirrors `agent-core-v2/agent/mcp/config-schema.ts`.
 */
const stringRecordSchema = z.record(z.string(), z.string());

const mcpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1).optional(),
  toolTimeoutMs: z.number().int().min(1).optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

const mcpServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringRecordSchema.optional(),
    cwd: z.string().optional(),
    executor: z.enum(['local', 'kaos']).optional(),
    ...mcpServerCommonFields,
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: stringRecordSchema.optional(),
    bearerTokenEnvVar: z.string().min(1).optional(),
    ...mcpServerCommonFields,
  }),
  z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
    headers: stringRecordSchema.optional(),
    bearerTokenEnvVar: z.string().min(1).optional(),
    ...mcpServerCommonFields,
  }),
]);

export const createSessionOptionsSchema = z.object({
  sessionId: z.string().optional(),
  workDir: z.string(),
  additionalDirs: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

export const forkSessionOptionsSchema = z.object({
  sourceSessionId: z.string(),
  newSessionId: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Same fields as `ForkSessionOptions` in the engine — keep in sync. */
export const createChildSessionOptionsSchema = forkSessionOptionsSchema;

/** `ISessionScopeHandle` as it survives JSON — `{ id, kind }` plus extras. */
export const handleWireSchema = z.looseObject({
  id: z.string(),
  kind: z.number(),
});

export const sessionLifecycleContract = {
  create: { input: z.tuple([createSessionOptionsSchema]), output: handleWireSchema },
  resume: { input: z.tuple([z.string()]), output: maybe(handleWireSchema) },
  close: { input: z.tuple([z.string()]), output: noResult },
  archive: { input: z.tuple([z.string()]), output: noResult },
  restore: { input: z.tuple([z.string()]), output: maybe(handleWireSchema) },
  fork: { input: z.tuple([forkSessionOptionsSchema]), output: handleWireSchema },
  createChild: { input: z.tuple([createChildSessionOptionsSchema]), output: handleWireSchema },
} satisfies ServiceContract;
