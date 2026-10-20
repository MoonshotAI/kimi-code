import { z } from 'zod';

export const sessionRatingResultSchema = z.object({
  appearance: z.object({
    id: z.string(),
    survey: z.enum(['session', 'long_context']),
  }).nullable(),
});
export type SessionRatingResult = z.infer<typeof sessionRatingResultSchema>;

export const sessionRatingRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('evaluate'), turn_id: z.string().min(1) }),
  z.object({ op: z.literal('shown'), appearance_id: z.string().min(1) }),
  z.object({
    op: z.literal('respond'),
    appearance_id: z.string().min(1),
    response: z.enum(['bad', 'fine', 'good', 'dismissed']),
  }),
  z.object({ op: z.literal('abandon'), appearance_id: z.string().min(1) }),
]);
export type SessionRatingRequest = z.infer<typeof sessionRatingRequestSchema>;
