/**
 * `sessionManager` — App-scope session lifecycle after the Workspace-domain
 * split. It creates, resumes, closes, archives, restores, deletes, and forks
 * sessions through the App-owned manager; the engine returns scope handles and
 * the wire keeps their serializable `{ id, kind }` fields.
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

/** Same fields as `ForkSessionOptions` in the engine — keep in sync. */
export const forkSessionOptionsSchema = z.object({
  sourceSessionId: z.string(),
  newSessionId: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  turnIndex: z.number().optional(),
});

/** Same fields as `ForkSessionOptions` in the engine, minus the fork-only truncation. */
export const createChildSessionOptionsSchema = forkSessionOptionsSchema.omit({ turnIndex: true });

/** `IScopeHandle` as it survives JSON — `{ id, kind }` plus extras. */
export const handleWireSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
});

export const sessionManagerContract = {
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
