/**
 * `sessionLifecycleService` — creates and tracks sessions at the process
 * root. Mirrors `agent-core-v2/app/sessionLifecycle/sessionLifecycle.ts`.
 * The engine returns `ISessionScopeHandle`s; over JSON only the plain data
 * fields survive, so the wire keeps `{ id, kind }` (loose — extra fields may
 * appear in-process).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';

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
