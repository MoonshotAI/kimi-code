/**
 * Agent-scope domain service contracts. These mirror the positional-arg
 * signatures of the engine's domain Services (shellCommand / profile / usage /
 * plan / task) that the agent facade calls directly; payload and result
 * schemas are shared with `agent/rpc.ts` (they mirror the same wire shapes).
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';
import {
  agentTaskInfoSchema,
  planDataSchema,
  runShellCommandPayloadSchema,
  setModelResultSchema,
  shellCommandResultSchema,
  usageStatusSchema,
} from './rpc.js';

export const agentShellCommandContract = {
  run: {
    input: z.tuple([runShellCommandPayloadSchema]),
    output: shellCommandResultSchema,
  },
  cancel: { input: z.tuple([z.string()]), output: noResult },
} satisfies ServiceContract;

export const agentProfileContract = {
  getModel: { input: z.tuple([]), output: z.string() },
  setModel: { input: z.tuple([z.string()]), output: setModelResultSchema },
  setThinking: { input: z.tuple([z.string()]), output: noResult },
  getEffectiveThinkingLevel: { input: z.tuple([]), output: z.string() },
} satisfies ServiceContract;

export const agentUsageContract = {
  status: { input: z.tuple([]), output: usageStatusSchema },
} satisfies ServiceContract;

export const agentPlanContract = {
  status: { input: z.tuple([]), output: planDataSchema },
  enter: { input: z.tuple([]), output: noResult },
  clear: { input: z.tuple([]), output: noResult },
  cancel: { input: z.tuple([z.string().optional()]), output: noResult },
} satisfies ServiceContract;

/** `McpServerEntry` from the engine's `mcpCore/connection-manager`. */
export const mcpServerEntrySchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http', 'sse']),
  status: z.enum(['pending', 'connected', 'failed', 'disabled', 'needs-auth', 'removed']),
  toolCount: z.number(),
  error: z.string().optional(),
});

export const agentMcpContract = {
  list: { input: z.tuple([]), output: z.array(mcpServerEntrySchema) },
} satisfies ServiceContract;

/** `FullCompactionInput` from the engine's `agent/fullCompaction`. */
export const fullCompactionInputSchema = z.object({
  source: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
});

export const agentFullCompactionContract = {
  begin: { input: z.tuple([fullCompactionInputSchema]), output: z.boolean() },
} satisfies ServiceContract;

export const agentTaskContract = {
  list: {
    input: z.tuple([z.boolean().optional(), z.number().optional()]),
    output: z.array(agentTaskInfoSchema),
  },
  stopByUser: { input: z.tuple([z.string()]), output: maybe(agentTaskInfoSchema) },
  stop: {
    input: z.tuple([z.string(), z.string().optional()]),
    output: maybe(agentTaskInfoSchema),
  },
  readOutput: {
    input: z.tuple([z.string(), z.number().optional()]),
    output: z.string(),
  },
} satisfies ServiceContract;
