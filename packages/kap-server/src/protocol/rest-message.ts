/**
 *   GET /v1/sessions/{session_id}/messages
 *   GET /v1/sessions/{session_id}/messages/{message_id}
 */

import { z } from 'zod';

import { messageRoleSchema, messageSchema } from '@moonshot-ai/agent-core-v2/agent/contextMemory/protocolMessage';

import { cursorQuerySchema } from './pagination';

export const listMessagesQuerySchema = cursorQuerySchema.and(
  z.object({
    role: messageRoleSchema.optional(),
  }),
);
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const listMessagesResponseSchema = z.object({
  items: z.array(messageSchema),
  has_more: z.boolean(),
});
export type ListMessagesResponse = z.infer<typeof listMessagesResponseSchema>;

export const getMessageResponseSchema = messageSchema;
export type GetMessageResponse = z.infer<typeof getMessageResponseSchema>;
