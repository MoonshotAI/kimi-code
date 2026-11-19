import { hostIdSchema } from '@moonshot-ai/agent-core-v2';
import { FILE_ID_REGEX } from '@moonshot-ai/agent-core-v2/app/file/fileService';
import { z } from 'zod';

const identifier = z.string().trim().min(1).max(200);
const content = z.string().trim().min(1).max(2000);
const reasonId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const client = z.enum(['desktop', 'web']);

export const FEEDBACK_REASONS_CONFIG = 'desktop_feedback_reasons';
export const feedbackReasonsSchema = z.object({
  reasons: z.array(z.object({ id: reasonId, zh: z.string().trim().min(1), en: z.string().trim().min(1) })).max(12),
}).refine(({ reasons }) => new Set(reasons.map((reason) => reason.id)).size === reasons.length);

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
    reasons: z.array(reasonId).max(12),
    content: content.optional(),
    upload_session: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('cancel') }),
]);

export const feedbackParamsSchema = z.object({ feedback_id: z.coerce.number().int().positive() });
export const feedbackResponseSchema = z.object({ feedback_id: z.number().int().positive() });
export const feedbackAttachmentQuerySchema = z.object({ kind: z.enum(['media', 'diagnostics']) });
export const feedbackSessionArchiveSchema = z.object({ session_id: identifier });
export const feedbackSessionAttachmentSchema = feedbackSessionArchiveSchema.extend({ host_id: hostIdSchema.optional() });
export const feedbackSessionArchiveResponseSchema = z.object({
  file_id: z.string().regex(FILE_ID_REGEX),
  size: z.number().int().positive(),
});
export const feedbackAttachmentResponseSchema = z.object({ upload_id: z.number().int().positive() });
