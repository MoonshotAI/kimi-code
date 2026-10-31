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

export const promptDeliverySchema = z.enum(['queue', 'steer']);
export type PromptDelivery = z.infer<typeof promptDeliverySchema>;

export const promptLaunchModeSchema = z.enum(['plan', 'swarm', 'goal']);
export type PromptLaunchModeWire = z.infer<typeof promptLaunchModeSchema>;

export const promptCompactionSchema = z
  .object({
    instruction: z.string().optional(),
  })
  .strict();

export const promptSubmissionSchema = z
  .object({
    content: z.array(messageContentSchema).min(1).optional(),
    compact: promptCompactionSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    agent_id: z.string().min(1).optional(),
    prompt_id: z.string().min(1).optional(),
    skills: z.array(promptSkillActivationSchema).min(1).optional(),
    delivery: promptDeliverySchema.optional(),
    mode: promptLaunchModeSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.content === undefined) === (value.compact === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'provide exactly one of content or compact' });
    }
    if (
      value.compact !== undefined &&
      (value.skills !== undefined ||
        value.metadata !== undefined ||
        value.delivery !== undefined ||
        value.mode !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['compact'],
        message: 'compact cannot be combined with skills, metadata, delivery or mode',
      });
    }
    if (value.mode !== undefined && value.delivery === 'steer') {
      ctx.addIssue({ code: 'custom', path: ['mode'], message: 'a prompt with a mode cannot be steered' });
    }
  });
export type PromptSubmission = z.infer<typeof promptSubmissionSchema>;

export const promptStatusSchema = z.enum(['running', 'queued', 'blocked']);
export type PromptStatus = z.infer<typeof promptStatusSchema>;

export const promptAcceptanceSchema = z.enum(['turn', 'steer', 'queue', 'compact']);
export type PromptAcceptanceWire = z.infer<typeof promptAcceptanceSchema>;

export const promptItemSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  status: promptStatusSchema,
  content: z.array(messageContentSchema).min(1),
  created_at: isoDateTimeSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type PromptItem = z.infer<typeof promptItemSchema>;

export const promptSubmitResultSchema = z.union([
  promptItemSchema.extend({ accepted_as: promptAcceptanceSchema }),
  z.object({
    prompt_id: z.string().min(1),
    accepted_as: z.enum(['compact', 'queue']),
  }),
]);
export type PromptSubmitResult = z.infer<typeof promptSubmitResultSchema>;

export const promptAbortResponseSchema = z.object({
  aborted: z.boolean(),
});
export type PromptAbortResponse = z.infer<typeof promptAbortResponseSchema>;

export const queuedInputSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  kind: z.enum(['input', 'compact']),
  delivery: promptDeliverySchema,
  content: z.array(messageContentSchema),
  skills: z.array(promptSkillActivationSchema).optional(),
  mode: promptLaunchModeSchema.optional(),
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
