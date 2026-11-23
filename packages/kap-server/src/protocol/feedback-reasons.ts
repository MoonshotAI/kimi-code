import { z } from 'zod';

export const FEEDBACK_FORM_CONFIG_NAME = 'feedback_form';
export const feedbackReasonIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

const feedbackReasonSchema = z.object({
  id: feedbackReasonIdSchema,
  label: z.object({ zh: z.string().trim().min(1), en: z.string().trim().min(1) }),
});
const replyReasons = z.array(feedbackReasonSchema).max(12)
  .refine(reasons => new Set(reasons.map(reason => reason.id)).size === reasons.length);
const guideUrl = z.url({ protocol: /^https$/, normalize: true }).optional().catch(undefined);

export const feedbackFormSchema = z.object({
  version: z.literal(1),
  reply_reasons: z.object({ negative: replyReasons, positive: replyReasons }),
  learn_more_url: z.object({ en: guideUrl, zh: guideUrl }).optional().catch(undefined),
});
export type FeedbackForm = z.infer<typeof feedbackFormSchema>;
