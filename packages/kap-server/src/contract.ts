/**
 * `@moonshot-ai/kap-server/contract` — the public RPC wire contract.
 *
 * Re-exports the channel descriptor types. The exposed surface itself is the
 * ENTIRE scoped DI registry (there is no whitelist): a registered Service is
 * the public contract, and all of its methods are reachable by reflection.
 * Clients load the live surface from `GET {rpcBasePath}/channels` instead of
 * importing a static list.
 *
 * Note: this module intentionally pulls in `@moonshot-ai/agent-core-v2` types.
 * It is meant for tooling and tests, not for runtime import by a wire-only
 * client.
 */
export type { ChannelDescriptor, ChannelMethodDescriptor } from './transport/channelRegistry';
export type { IChannel, ScopeKind } from './transport/channel';
