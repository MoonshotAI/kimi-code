import { FILE_ID_REGEX } from '@moonshot-ai/agent-core-v2/app/file/fileService';
import { deviceIdSchema } from '@moonshot-ai/agent-core-v2/app/devicesConfig/configSection';
import { z } from 'zod';
import { feedbackReasonIdSchema } from './feedback-reasons';

const identifier = z.string().trim().min(1).max(200);
const content = z.string().trim().min(1).max(2000);
const client = z.enum(['desktop', 'web']);

export const createFeedbackSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('global'),
    source: z.enum(['sidebar', 'command']),
    category: z.enum(['bug', 'suggestion', 'other']),
    content,
    session_id: identifier.optional(),
    client: client.optional(),
    upload_session: z.boolean().optional(),
    upload_logs: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('turn'),
    session_id: identifier,
    turn_id: identifier,
    reply_id: identifier.optional(),
    rating: z.enum(['up', 'down']),
    client: client.optional(),
  }),
]);

export const updateFeedbackSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('details'),
    reasons: z.array(feedbackReasonIdSchema).max(12),
    content: content.optional(),
    upload_session: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('cancel') }),
]);

export const feedbackParamsSchema = z.object({ feedback_id: z.coerce.number().int().positive() });
export const feedbackResponseSchema = z.object({ feedback_id: z.number().int().positive() });
export const feedbackAttachmentQuerySchema = z.object({ kind: z.enum(['media', 'diagnostics']) });
export const feedbackSessionArchiveSchema = z.object({ session_id: identifier });
export const feedbackSessionAttachmentSchema = feedbackSessionArchiveSchema.extend({ device_id: deviceIdSchema.optional() });
export const feedbackSessionArchiveResponseSchema = z.object({
  file_id: z.string().regex(FILE_ID_REGEX),
  size: z.number().int().positive(),
});
export const feedbackAttachmentResponseSchema = z.object({ upload_id: z.number().int().positive() });
