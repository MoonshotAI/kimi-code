/**
 * GET /v1/meta
 *   Reply: MetaResponse {
 *     server_version,
 *     capabilities,
 *     server_id,
 *     started_at
 *   }
 */
import { z } from 'zod';

import { fsOpenInAppIdSchema } from '../rest/fs';
import { isoDateTimeSchema } from '../time';

export const metaCapabilitiesSchema = z.object({
  websocket: z.literal(true),
  file_upload: z.literal(true),
  fs_query: z.literal(true),
  mcp: z.literal(true),
  background_tasks: z.literal(true),
  terminal: z.literal(true),
});

export type MetaCapabilities = z.infer<typeof metaCapabilitiesSchema>;

export const metaResponseSchema = z.object({
  server_version: z.string().min(1),
  capabilities: metaCapabilitiesSchema,
  server_id: z.string().min(1),
  started_at: isoDateTimeSchema,
  open_in_apps: z.array(fsOpenInAppIdSchema),
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
