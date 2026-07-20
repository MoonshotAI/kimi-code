/**
 * `@moonshot-ai/kap-server/contract` — the public `/api/v2` wire contract.
 *
 * Re-exports the channel registry: the set of Services exposed over the wire,
 * keyed by decorator id (the channel name). In the VS Code model there is no
 * per-method allowlist — a registered Service exposes all of its methods by
 * reflection — so the registry is the whole surface. Client SDKs import this to
 * stay in lockstep (e.g. drift tests that assert every registered channel has a
 * typed client binding).
 *
 * Note: this module intentionally pulls in `@moonshot-ai/agent-core-v2` types
 * (the registered `ServiceIdentifier`s). It is meant for tooling and tests, not
 * for runtime import by a wire-only client.
 */
export {
  describeChannels,
  hasChannel,
  registerChannel,
  registeredChannelNames,
  resolveChannel,
} from './transport/channelRegistry';
export type { ChannelDescriptor, ChannelMethodDescriptor } from './transport/channelRegistry';
export type { IChannel, ScopeKind } from './transport/channel';
