import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import { mcpServerConfigSchema } from '../mcp.js';
import type { ServiceContract } from '../types.js';
import { sessionMetaSchema } from './metadata.js';

export const createSessionOptionsSchema = z.object({
  sessionId: z.string().optional(),
  workDir: z.string(),
  additionalDirs: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

export const resumeSessionOptionsSchema = z.object({
  additionalDirs: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

export const forkSessionOptionsSchema = z.object({
  sourceSessionId: z.string(),
  newSessionId: z.string().optional(),
  title: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  turnIndex: z.number().optional(),
});

export const createChildSessionOptionsSchema = forkSessionOptionsSchema.omit({ turnIndex: true });

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
