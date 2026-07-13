/**
 * `@moonshot-ai/klient` public surface — the `/api/v2` channel, the typed
 * service proxy, the scope-routed client, and the explicit service
 * implementations. Service interfaces and tokens are imported directly from
 * `agent-core-v2` leaf subpaths by consumers.
 */

export type { IChannel } from './channel.js';
export { RPCError } from './errors.js';
export { HttpChannel, type HttpChannelOptions } from './httpChannel.js';
export { makeProxy } from './proxy.js';
export {
  AgentClient,
  Klient,
  SessionClient,
  type KlientOptions,
} from './client.js';
export { SessionIndexClient } from './services/sessionIndex.js';
export {
  WsSocket,
  type WsLike,
  type WsLikeCtor,
  type WsScopeIds,
  type WsScopeKind,
  type WsSocketOptions,
  type WsSocketState,
  type WsSubscription,
} from './wsSocket.js';
export { WsChannel, type WsChannelOptions } from './wsChannel.js';
export {
  WsAgentClient,
  WsKlient,
  WsSessionClient,
  type WsKlientOptions,
} from './wsKlient.js';
