import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';

export const connectionSchema = z.object({
  id: z.string().min(1),
  connected_at: isoDateTimeSchema,
  remote_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  has_client_hello: z.boolean(),
  subscriptions: z.array(z.string()),
});

export type Connection = z.infer<typeof connectionSchema>;

export const connectionsListResponseSchema = z.object({
  connections: z.array(connectionSchema),
});

export type ConnectionsListResponse = z.infer<typeof connectionsListResponseSchema>;
