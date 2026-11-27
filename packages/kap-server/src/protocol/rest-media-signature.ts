import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import { z } from 'zod';

export const mediaSignatureSchema = z.object({
  signature: z.string(),
  expires_at: isoDateTimeSchema,
});

export type MediaSignature = z.infer<typeof mediaSignatureSchema>;