import { z } from 'zod';

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

export const promptPartSchema = z.discriminatedUnion('type', [
  textPartSchema,
  imageUrlPartSchema,
  videoUrlPartSchema,
]);

export const emptyPayloadSchema = z.object({});

export const promptPayloadSchema = z.object({
  input: z.array(promptPartSchema),
  promptId: z.string().min(1).optional(),
});

export const promptSkillActivationSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

export const promptWithSkillsPayloadSchema = promptPayloadSchema.extend({
  skills: z.array(promptSkillActivationSchema).min(1),
  steerIfActive: z.boolean().optional(),
});

export const promptWithSkillsResultSchema = z.object({
  turn_id: z.number().optional(),
  prompt_id: z.string(),
  created_at: z.string(),
  state: z.enum(['running', 'queued', 'blocked']),
});

export const steerPayloadSchema = z.object({
  input: z.array(promptPartSchema),
});

export const activateSkillPayloadSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
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

export const runtimeBindingSchema = z.object({
  workspaceId: z.string(),
  runtimeId: z.string(),
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

export const agentContextDataSchema = z.object({
  history: z.array(z.unknown()),
  tokenCount: z.number(),
});

export const agentCommandInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
});

export const runCommandPayloadSchema = z.object({
  name: z.string(),
  args: z.string().optional(),
});

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
    model: z.string().optional(),
    thinkingEffort: z.string().optional(),
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
