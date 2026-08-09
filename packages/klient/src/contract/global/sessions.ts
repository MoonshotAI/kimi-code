/**
 * `sessionIndex` — the persisted session read model. Mirrors
 * `agent-core-v2/app/sessionIndex/sessionIndex.ts`.
 */

import { z } from 'zod';

import { maybe, pageOf } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const sessionSummarySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cwd: z.string().optional(),
  title: z.string().optional(),
  lastPrompt: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archived: z.boolean(),
  custom: z.record(z.string(), z.unknown()).optional(),
});

export const sessionListQuerySchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().optional(),
  childOf: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
});

export const sessionCountQuerySchema = z.object({
  workspaceIds: z.array(z.string()).optional(),
  includeArchived: z.boolean().optional(),
});

export const sessionsContract = {
  listRecent: { input: z.tuple([sessionListQuerySchema]), output: pageOf(sessionSummarySchema) },
  get: { input: z.tuple([z.string()]), output: maybe(sessionSummarySchema) },
  count: { input: z.tuple([sessionCountQuerySchema]), output: z.number() },
} satisfies ServiceContract;
