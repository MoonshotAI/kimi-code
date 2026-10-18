import { z } from 'zod';

const sessionRatingSurveySchema = z.enum(['session', 'long_context']);

const sessionRatingResponseSchema = z.enum(['bad', 'fine', 'good']);

export const sessionRatingViewSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('closed') }),
  z.object({
    phase: z.literal('open'),
    appearance_id: z.string(),
    survey: sessionRatingSurveySchema,
  }),
  z.object({
    phase: z.literal('pending'),
    appearance_id: z.string(),
    survey: sessionRatingSurveySchema,
    response: sessionRatingResponseSchema,
    settle_in_ms: z.number().int().min(0),
  }),
  z.object({
    phase: z.literal('thanks'),
    appearance_id: z.string(),
    survey: sessionRatingSurveySchema,
    response: sessionRatingResponseSchema,
    close_in_ms: z.number().int().min(0),
  }),
]);
export type SessionRatingView = z.infer<typeof sessionRatingViewSchema>;

export const sessionRatingRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('evaluate') }),
  z.object({
    op: z.literal('select'),
    appearance_id: z.string().min(1),
    response: sessionRatingResponseSchema,
  }),
  z.object({ op: z.literal('undo'), appearance_id: z.string().min(1) }),
  z.object({ op: z.literal('dismiss'), appearance_id: z.string().min(1) }),
]);
export type SessionRatingRequest = z.infer<typeof sessionRatingRequestSchema>;
