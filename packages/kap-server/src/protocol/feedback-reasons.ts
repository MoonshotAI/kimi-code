import { z } from 'zod';

export const FEEDBACK_REASONS_CONFIG = 'desktop_feedback_reasons';
export const feedbackReasonIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const feedbackReasonsSchema = z.object({
  reasons: z.array(z.object({ id: feedbackReasonIdSchema, zh: z.string().trim().min(1), en: z.string().trim().min(1) })).max(12),
}).refine(({ reasons }) => new Set(reasons.map((reason) => reason.id)).size === reasons.length);
