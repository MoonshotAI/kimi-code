import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import { messageContentSchema } from './message';
import {
  promptPermissionModeSchema,
  promptThinkingSchema,
} from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

export { promptPermissionModeSchema, promptThinkingSchema };
export type { PromptPermissionMode, PromptThinking } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

export const promptSkillActivationSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});
export type PromptSkillActivation = z.infer<typeof promptSkillActivationSchema>;

export const promptSubmissionSchema = z.object({
  content: z.array(messageContentSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agent_id: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
  disabled_tools: z.array(z.string()).optional(),
  prompt_id: z.string().min(1).optional(),
  skills: z.array(promptSkillActivationSchema).min(1).optional(),
});
export type PromptSubmission = z.infer<typeof promptSubmissionSchema>;

export const promptStatusSchema = z.enum(['running', 'queued', 'blocked']);
export type PromptStatus = z.infer<typeof promptStatusSchema>;

export const promptItemSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  status: promptStatusSchema,
  content: z.array(messageContentSchema).min(1),
  created_at: isoDateTimeSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PromptItem = z.infer<typeof promptItemSchema>;

export const promptListResponseSchema = z.object({
  active: promptItemSchema.nullable(),
  queued: z.array(promptItemSchema),
});
export type PromptListResponse = z.infer<typeof promptListResponseSchema>;

export const promptSubmitResultSchema = promptItemSchema;
export type PromptSubmitResult = z.infer<typeof promptSubmitResultSchema>;

export const promptSteerRequestSchema = z.object({
  prompt_ids: z.array(z.string().min(1)).min(1),
});
export type PromptSteerRequest = z.infer<typeof promptSteerRequestSchema>;

export const promptSteerResultSchema = z.object({
  steered: z.literal(true),
  prompt_ids: z.array(z.string().min(1)).min(1),
});
export type PromptSteerResult = z.infer<typeof promptSteerResultSchema>;

export const promptAbortResponseSchema = z.object({
  aborted: z.boolean(),
});
export type PromptAbortResponse = z.infer<typeof promptAbortResponseSchema>;

export const promptDeliverySchema = z.enum(['queue', 'steer']);
export type PromptDelivery = z.infer<typeof promptDeliverySchema>;

export const queuedInputSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  kind: z.enum(['input', 'compact']),
  delivery: promptDeliverySchema,
  content: z.array(messageContentSchema),
  skills: z.array(promptSkillActivationSchema).optional(),
  instruction: z.string().optional(),
  client_metadata: z.record(z.string(), z.unknown()).optional(),
  created_at: isoDateTimeSchema,
});
export type QueuedInputWire = z.infer<typeof queuedInputSchema>;

export const queueStateSchema = z.object({
  paused: z.boolean(),
  inputs: z.array(queuedInputSchema),
});
export type QueueStateWire = z.infer<typeof queueStateSchema>;

export const queueEventMessageSchema = queueStateSchema.extend({
  type: z.literal('queue'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  event_created_at: isoDateTimeSchema,
});
export type QueueEventMessage = z.infer<typeof queueEventMessageSchema>;

export const queueMoveRequestSchema = z
  .object({
    before_prompt_id: z.string().min(1).optional(),
  })
  .strict();
export type QueueMoveRequest = z.infer<typeof queueMoveRequestSchema>;

export const queuePauseResponseSchema = z.object({
  paused: z.boolean(),
});
export type QueuePauseResponse = z.infer<typeof queuePauseResponseSchema>;
