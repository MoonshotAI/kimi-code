/**
 * GET /v1/connections
 *   Reply: ConnectionsListResponse {
 *     connections: Connection[]
 *   }
 *
 * A `Connection` is a live WebSocket client attached to `/v1/ws`. It is the
 * server's only stateful client concept — REST is stateless, and agent sessions
 * are a separate resource (`/sessions`).
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '../time';

export const connectionSchema = z.object({
  /** Server-assigned connection id (`conn_<ulid>`). */
  id: z.string().min(1),
  /** ISO 8601 UTC timestamp the socket was accepted at. */
  connected_at: isoDateTimeSchema,
  /** Peer address as seen by the server socket. Null when unavailable. */
  remote_address: z.string().nullable(),
  /** `User-Agent` header from the upgrade request. Null when absent. */
  user_agent: z.string().nullable(),
  /** Whether the client has completed the `client_hello` handshake. */
  has_client_hello: z.boolean(),
  /** Session ids this connection is currently subscribed to. */
  subscriptions: z.array(z.string()),
});

export type Connection = z.infer<typeof connectionSchema>;

export const connectionsListResponseSchema = z.object({
  connections: z.array(connectionSchema),
});

export type ConnectionsListResponse = z.infer<typeof connectionsListResponseSchema>;
