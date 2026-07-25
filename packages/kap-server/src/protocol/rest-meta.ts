/**
 * GET /v1/meta
 *   Reply: MetaResponse { server_version, capabilities, server_id, started_at }
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

import { fsOpenInAppIdSchema } from './rest-fs';

export const metaCapabilitiesSchema = z.object({
  websocket: z.literal(true),
  file_upload: z.literal(true),
  fs_query: z.literal(true),
  mcp: z.literal(true),
  tasks: z.literal(true),
  terminal: z.literal(true),
});

export type MetaCapabilities = z.infer<typeof metaCapabilitiesSchema>;

export const metaResponseSchema = z.object({
  server_version: z.string().min(1),
  capabilities: metaCapabilitiesSchema,
  server_id: z.string().min(1),
  started_at: isoDateTimeSchema,
  open_in_apps: z.array(fsOpenInAppIdSchema),
  /**
   * True when the server was started with `--dangerous-bypass-auth`, meaning
   * the bearer-token gate is disabled on every REST and WebSocket route. The
   * web UI reads this to skip the token prompt and connect without a
   * credential. Defaults to false on hardened boots.
   */
  dangerous_bypass_auth: z.boolean(),
  /**
   * Backend engine generation serving this API. `'v2'` is the DI × Scope
   * engine (`@moonshot-ai/kap-server` / `agent-core-v2`); older servers omit
   * the field (treat absence as v1). Lets clients identify the backend without
   * probing routes.
   */
  backend: z.enum(['v1', 'v2']).optional(),
});

export type MetaResponse = z.infer<typeof metaResponseSchema>;
