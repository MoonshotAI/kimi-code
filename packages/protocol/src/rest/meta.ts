/**
 * GET /v1/meta
 *   Reply: MetaResponse {
 *     daemon_version,
 *     capabilities,
 *     daemon_id,
 *     started_at
 *   }
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '../time';

export const metaCapabilitiesSchema = z.object({
  websocket: z.literal(true),
  file_upload: z.literal(true),
  fs_query: z.literal(true),
  mcp: z.literal(true),
  background_tasks: z.literal(true),
});

export type MetaCapabilities = z.infer<typeof metaCapabilitiesSchema>;

export const metaResponseSchema = z.object({
  daemon_version: z.string().min(1),
  capabilities: metaCapabilitiesSchema,
  daemon_id: z.string().min(1),
  started_at: isoDateTimeSchema,
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
