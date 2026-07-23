import { z } from 'zod';

/**
 * A pending sudo password request. SECURITY: this wire shape never carries
 * the password — the request side only describes the prompt; the submitted
 * password arrives once on the resolve body and is never echoed back.
 */
export const passwordRequestSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  prompt: z.string(),
  command: z.string().optional(),
});
export type PasswordRequest = z.infer<typeof passwordRequestSchema>;
