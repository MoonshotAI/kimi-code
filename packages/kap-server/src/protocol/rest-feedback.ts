import { z } from 'zod';

const feedbackAttachmentSchema = z.object({
  kind: z.enum(['media', 'session', 'diagnostics']),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  media_type: z.string().min(1).optional(),
});

const feedbackInfoBase = {
  schema_version: z.literal(1),
  client: z.literal('desktop'),
  upload_session: z.boolean(),
  attachments: z.array(feedbackAttachmentSchema),
};

export const feedbackReplyInfoSchema = z.object({
  ...feedbackInfoBase,
  kind: z.literal('reply'),
  source: z.literal('reply_button'),
  rating: z.enum(['positive', 'negative']),
  turn_id: z.string().min(1),
  reasons: z.array(z.string()),
  upload_logs: z.literal(false),
  cancel: z.boolean(),
});

export const feedbackGlobalInfoSchema = z.object({
  ...feedbackInfoBase,
  kind: z.literal('global'),
  source: z.enum(['sidebar', 'slash_command']),
  category: z.enum(['bug', 'suggestion', 'other']),
  upload_logs: z.boolean(),
});

export const createFeedbackRequestSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    content: z.string(),
    version: z.string().min(1),
    os: z.string().min(1),
    info: z.discriminatedUnion('kind', [feedbackReplyInfoSchema, feedbackGlobalInfoSchema]),
  })
  .superRefine((input, ctx) => {
    if (input.info.kind === 'reply' && input.session_id === undefined) {
      ctx.addIssue({ code: 'custom', message: 'reply feedback requires session_id' });
    }
    if (input.info.kind === 'global' && input.info.upload_session && input.session_id === undefined) {
      ctx.addIssue({ code: 'custom', message: 'session upload requires session_id' });
    }
  });

export const updateFeedbackRequestSchema = z.object({
  feedback_id: z.number().int().positive(),
  content: z.string().optional(),
  info: z.record(z.string(), z.unknown()).optional(),
});

export const feedbackIdParamsSchema = z.object({
  feedback_id: z.coerce.number().int().positive(),
});

export const feedbackCreatedSchema = z.object({
  feedback_id: z.number().int().positive(),
});

export type CreateFeedbackRequest = z.infer<typeof createFeedbackRequestSchema>;
export type UpdateFeedbackRequest = z.infer<typeof updateFeedbackRequestSchema>;
