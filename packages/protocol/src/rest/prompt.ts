/**
 *   POST /v1/sessions/{sid}/prompts
 *     Body:  PromptSubmission {
 *              content: MessageContent[],
 *              metadata?: ...,
 *              model?: string,
 *              thinking?: 'off'|'low'|'medium'|'high'|'xhigh'|'max',
 *              permission_mode?: 'manual'|'yolo'|'auto',
 *              plan_mode?: boolean,
 *            }
 *     Reply: PromptSubmitResult { prompt_id, user_message_id, status, content, created_at }
 *            status='running' when sent immediately, status='queued' when
 *            another prompt is already active.
 *
 *   GET /v1/sessions/{sid}/prompts
 *     Reply: { active: PromptItem | null, queued: PromptItem[] }
 *
 *   POST /v1/sessions/{sid}/prompts/{pid}:steer
 *   POST /v1/sessions/{sid}/prompts:steer
 *     Body:  { prompt_ids: string[] } for the collection route
 *     Reply: { steered: true, prompt_ids: string[] }
 *
 *   POST /v1/sessions/{sid}/prompts/{pid}:abort
 *     Body:  empty
 *     Reply: { aborted: true, at_seq: number }   (envelope code 0)
 *            { aborted: false, at_seq: number }  (envelope code 40903, idempotent)
 */

import { z } from 'zod';

import { messageContentSchema } from '../message';
import { isoDateTimeSchema } from '../time';

// Accept any non-empty, model-declared effort string. Providers normalize
// unrecognized efforts on the wire, so the REST layer must not reject a value
// the catalog advertises via `support_efforts`.
export const promptThinkingSchema = z.string().min(1);
export type PromptThinking = z.infer<typeof promptThinkingSchema>;

export const promptPermissionModeSchema = z.enum(['manual', 'yolo', 'auto']);
export type PromptPermissionMode = z.infer<typeof promptPermissionModeSchema>;

export const promptSubmissionSchema = z.object({
  content: z.array(messageContentSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  agent_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinking: promptThinkingSchema.optional(),
  permission_mode: promptPermissionModeSchema.optional(),
  plan_mode: z.boolean().optional(),
  swarm_mode: z.boolean().optional(),
  goal_objective: z.string().optional(),
  goal_control: z.enum(['pause', 'resume', 'cancel']).optional(),
});
export type PromptSubmission = z.infer<typeof promptSubmissionSchema>;

export const promptStatusSchema = z.enum(['running', 'queued']);
export type PromptStatus = z.infer<typeof promptStatusSchema>;

export const promptItemSchema = z.object({
  prompt_id: z.string().min(1),
  user_message_id: z.string().min(1),
  status: promptStatusSchema,
  content: z.array(messageContentSchema).min(1),
  created_at: isoDateTimeSchema,
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
  at_seq: z.number().int().nonnegative().optional(),
});
export type PromptAbortResponse = z.infer<typeof promptAbortResponseSchema>;

export interface PromptCompletedEventPayload {
  readonly type: 'prompt.completed';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly finishedAt: string;
}

export interface PromptAbortedEventPayload {
  readonly type: 'prompt.aborted';
  readonly agentId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly abortedAt: string;
}

export interface PromptSteeredEventPayload {
  readonly type: 'prompt.steered';
  readonly agentId: string;
  readonly sessionId: string;
  readonly activePromptId: string;
  readonly promptIds: readonly string[];
  readonly content: PromptSubmission['content'];
  readonly steeredAt: string;
}
