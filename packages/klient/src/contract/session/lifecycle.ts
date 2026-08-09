/**
 * `sessionLifecycleService` / `workspaceLifecycleService` — session
 * lifecycle after the Workspace-domain split. The App-scope
 * `workspaceLifecycleService` materializes one handler per workspace
 * (`handlerFor`); the Workspace-scope `sessionLifecycleService` owns that
 * workspace's sessions (create/resume/close/archive/restore/delete/fork/
 * createChild). Mirrors `agent-core-v2/app/workspaceLifecycle/*` and
 * `agent-core-v2/workspace/sessionLifecycle/*`. The engine returns scope
 * handles; over JSON only the plain data fields survive, so the wire keeps
 * `{ id, kind }` (loose — extra fields may appear in-process).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';

export const createSessionOptionsSchema = z.object({
  sessionId: z.string().optional(),
  workDir: z.string(),
  additionalDirs: z.array(z.string()).optional(),
  /**
   * Ephemeral per-session MCP servers (engine `CreateSessionOptions.mcpServers`):
   * connected only for the created session, never persisted.
   */
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

/** Same fields as `ResumeSessionOptions` in the engine — keep in sync. */
export const resumeSessionOptionsSchema = z.object({
  additionalDirs: z.array(z.string()).optional(),
  /**
   * Ephemeral per-session MCP servers, applied when resume re-materializes a
   * cold session (ignored when the session is already live).
   */
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

/** `IScopeHandle` as it survives JSON — `{ id, kind }` plus extras. */
export const handleWireSchema = z.looseObject({
  id: z.string(),
  kind: z.number(),
});

/** `WorkspaceRef` — a `workspaceId` (optional `root` hint) or a bare `root`. */
export const workspaceRefSchema = z.union([
  z.object({ workspaceId: z.string(), root: z.string().optional() }),
  z.object({ root: z.string() }),
]);

export const workspaceLifecycleContract = {
  handlerFor: { input: z.tuple([workspaceRefSchema]), output: handleWireSchema },
} satisfies ServiceContract;

export const sessionLifecycleContract = {
  create: { input: z.tuple([createSessionOptionsSchema]), output: handleWireSchema },
  resume: {
    input: z.tuple([z.string(), resumeSessionOptionsSchema.optional()]),
    output: maybe(handleWireSchema),
  },
  close: { input: z.tuple([z.string()]), output: noResult },
  archive: { input: z.tuple([z.string()]), output: noResult },
  restore: {
    input: z.tuple([z.string(), resumeSessionOptionsSchema.optional()]),
    output: maybe(handleWireSchema),
  },
  delete: { input: z.tuple([z.string()]), output: noResult },
  fork: { input: z.tuple([forkSessionOptionsSchema]), output: handleWireSchema },
  createChild: { input: z.tuple([createChildSessionOptionsSchema]), output: handleWireSchema },
} satisfies ServiceContract;
