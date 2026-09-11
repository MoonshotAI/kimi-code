/**
 * `sessionManager` — App-scope session lifecycle after the Workspace-domain
 * split. It creates, resumes, closes, archives, restores, deletes, and forks
 * sessions through the App-owned manager; create/resume/restore return scope
 * handles on the wire (`{ id, kind }`), fork/createChild return the forked
 * session's metadata directly.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema, type McpServerConfig } from '../mcp.js';
import type { ServiceContract } from '../types.js';
import { sessionMetaSchema } from './metadata.js';

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const mcpServerConfigRecordSchema = z
  .custom<Readonly<Record<string, McpServerConfig>>>(isPlainRecord)
  .transform((servers, ctx): Record<string, McpServerConfig> => {
    const out: Record<string, McpServerConfig> = Object.create(null);
    let valid = true;
    for (const name of Reflect.ownKeys(servers)) {
      const parsedName = z.string().safeParse(name);
      if (!parsedName.success) {
        valid = false;
        ctx.addIssue({
          code: 'invalid_key',
          origin: 'record',
          issues: parsedName.error.issues,
          path: [name],
        });
        continue;
      }
      const config = servers[parsedName.data];
      const parsed = mcpServerConfigSchema.safeParse(config);
      if (!parsed.success) {
        valid = false;
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: [parsedName.data, ...issue.path] });
        }
        continue;
      }
      out[parsedName.data] = parsed.data;
    }
    return valid ? out : z.NEVER;
  });

export const createSessionOptionsSchema = z.object({
  sessionId: z.string().optional(),
  workDir: z.string(),
  additionalDirs: z.array(z.string()).optional(),
  /**
   * Ephemeral per-session MCP servers (engine `CreateSessionOptions.mcpServers`):
   * connected only for the created session, never persisted.
   */
  mcpServers: mcpServerConfigRecordSchema.optional(),
});

/** Same fields as `ResumeSessionOptions` in the engine — keep in sync. */
export const resumeSessionOptionsSchema = z.object({
  additionalDirs: z.array(z.string()).optional(),
  /**
   * Ephemeral per-session MCP servers, applied when resume re-materializes a
   * cold session (ignored when the session is already live).
   */
  mcpServers: mcpServerConfigRecordSchema.optional(),
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
  fork: { input: z.tuple([forkSessionOptionsSchema]), output: sessionMetaSchema },
  createChild: { input: z.tuple([createChildSessionOptionsSchema]), output: sessionMetaSchema },
} satisfies ServiceContract;
