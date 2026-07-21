/**
 * `agentRPCService` — the per-agent RPC surface. Mirrors the `AgentAPI`
 * subset of `agent-core-v2/agent/rpc/core-api.ts`; every method takes one
 * payload object. `PromptPayload.input` mirrors the `PromptPart` subset of
 * `ContentPart` (text / image_url / video_url) from
 * `agent-core-v2/kosong/contract/message.ts`. Task wire shapes mirror the
 * `TaskInfo` union in `protocol/src/events.ts`.
 */

import { z } from 'zod';

import { maybe, noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

// ── prompt parts ────────────────────────────────────────────────────────────

const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageUrlPartSchema = z.object({
  type: z.literal('image_url'),
  imageUrl: z.object({ url: z.string(), id: z.string().optional() }),
});

const videoUrlPartSchema = z.object({
  type: z.literal('video_url'),
  videoUrl: z.object({ url: z.string(), id: z.string().optional() }),
});

/** `PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>`. */
export const promptPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imageUrlPartSchema,
  videoUrlPartSchema,
]);

// ── payloads / results ──────────────────────────────────────────────────────

export const emptyPayloadSchema = z.object({});

export const promptPayloadSchema = z.object({
  input: z.array(promptPartSchema),
  // Mirrors `PromptPayload.disabledTools` in the engine (client-managed
  // session denylist, full-replace).
  disabledTools: z.array(z.string()).optional(),
});

/** Same shape as `SteerPayload` in the engine. */
export const steerPayloadSchema = z.object({
  input: z.array(promptPartSchema),
});

export const promptLaunchResultSchema = z.object({
  turn_id: z.number(),
});

export const cancelPayloadSchema = z.object({
  turnId: z.number().optional(),
});

export const runShellCommandPayloadSchema = z.object({
  command: z.string(),
  commandId: z.string().optional(),
});

export const shellCommandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  isError: z.boolean().optional(),
  backgrounded: z.boolean().optional(),
});

export const cancelShellCommandPayloadSchema = z.object({
  commandId: z.string(),
});

export const setModelPayloadSchema = z.object({
  model: z.string(),
});

export const setModelResultSchema = z.object({
  model: z.string(),
  providerName: z.string().optional(),
});

export const permissionModeSchema = z.enum(['manual', 'yolo', 'auto']);

export const setPermissionPayloadSchema = z.object({
  mode: permissionModeSchema,
});

export const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
});

export const usageStatusSchema = z.object({
  byModel: z.record(z.string(), tokenUsageSchema).optional(),
  currentTurn: tokenUsageSchema.optional(),
  total: tokenUsageSchema.optional(),
});

/**
 * `AgentContextData` — `history` items are full `ContextMessage`s (deep
 * `Message` / `Tool` / `PromptOrigin` unions); mirrored as `unknown` entries.
 */
export const agentContextDataSchema = z.object({
  history: z.array(z.unknown()),
  tokenCount: z.number(),
});

/** `PlanData = null | { id, content, path }` — null is JSON-representable. */
export const planDataSchema = z.union([
  z.null(),
  z.object({
    id: z.string(),
    content: z.string(),
    path: z.string(),
  }),
]);

export const cancelPlanPayloadSchema = z.object({
  id: z.string().optional(),
});

export const getTasksPayloadSchema = z.object({
  activeOnly: z.boolean().optional(),
  limit: z.number().optional(),
});

const taskLifecycleStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

const taskInfoBaseFields = {
  taskId: z.string(),
  description: z.string(),
  status: taskLifecycleStatusSchema,
  detached: z.boolean().optional(),
  startedAt: z.number(),
  endedAt: z.union([z.number(), z.null()]),
  stopReason: z.string().optional(),
  terminalNotificationSuppressed: z.boolean().optional(),
  timeoutMs: z.number().optional(),
} as const;

/** Protocol `TaskInfo` union (`protocol/src/events.ts`). */
export const agentTaskInfoSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('process'),
    command: z.string(),
    pid: z.number(),
    exitCode: z.union([z.number(), z.null()]),
    ...taskInfoBaseFields,
  }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.string().optional(),
    subagentType: z.string().optional(),
    ...taskInfoBaseFields,
  }),
  z.object({
    kind: z.literal('question'),
    questionCount: z.number(),
    toolCallId: z.string().optional(),
    ...taskInfoBaseFields,
  }),
]);

export const stopTaskPayloadSchema = z.object({
  taskId: z.string(),
  reason: z.string().optional(),
});

export const getTaskOutputPayloadSchema = z.object({
  taskId: z.string(),
  tail: z.number().optional(),
});

// ── contract ────────────────────────────────────────────────────────────────

export const agentRpcContract = {
  prompt: { input: z.tuple([promptPayloadSchema]), output: maybe(promptLaunchResultSchema) },
  steer: { input: z.tuple([steerPayloadSchema]), output: maybe(promptLaunchResultSchema) },
  cancel: { input: z.tuple([cancelPayloadSchema]), output: noResult },
  runShellCommand: {
    input: z.tuple([runShellCommandPayloadSchema]),
    output: shellCommandResultSchema,
  },
  cancelShellCommand: {
    input: z.tuple([cancelShellCommandPayloadSchema]),
    output: noResult,
  },
  getModel: { input: z.tuple([emptyPayloadSchema]), output: z.string() },
  setModel: { input: z.tuple([setModelPayloadSchema]), output: setModelResultSchema },
  setPermission: { input: z.tuple([setPermissionPayloadSchema]), output: noResult },
  getUsage: { input: z.tuple([emptyPayloadSchema]), output: usageStatusSchema },
  getContext: { input: z.tuple([emptyPayloadSchema]), output: agentContextDataSchema },
  getPlan: { input: z.tuple([emptyPayloadSchema]), output: planDataSchema },
  enterPlan: { input: z.tuple([emptyPayloadSchema]), output: noResult },
  clearPlan: { input: z.tuple([emptyPayloadSchema]), output: noResult },
  cancelPlan: { input: z.tuple([cancelPlanPayloadSchema]), output: noResult },
  getTasks: {
    input: z.tuple([getTasksPayloadSchema]),
    output: z.array(agentTaskInfoSchema),
  },
  stopTask: { input: z.tuple([stopTaskPayloadSchema]), output: noResult },
  getTaskOutput: { input: z.tuple([getTaskOutputPayloadSchema]), output: z.string() },
} satisfies ServiceContract;
